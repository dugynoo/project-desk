//! Validated state with a last-known-good backup and older snapshots. Callers serialize writes.
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub json: Option<String>,
    pub recovered: bool,
    /// A backup chosen in Settings replaced the state on this start.
    pub restored: bool,
}

/// One snapshot in `backups/`. `.bak` alone is overwritten by the second save after a
/// bad-but-valid write, so these keep older, independent copies.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub name: String,
    /// `daily` (first save of a day) or `shrink` (before projects or sessions disappeared).
    pub kind: &'static str,
    pub saved_at: u64,
    pub projects: usize,
    pub sessions: usize,
    pub bytes: u64,
}

const KEEP_DAILY: usize = 7;
const KEEP_SHRINK: usize = 5;
const MAX_BACKUP_BYTES: u64 = 20 * 1024 * 1024;

fn valid(json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(json).is_ok_and(|v| {
        v.is_object() && v.get("projects").is_some_and(|x| x.is_array())
            && v.get("sessions").is_some_and(|x| x.is_array())
    })
}

fn read(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(json) if valid(&json) => Ok(Some(json)),
        Ok(_) => Err(format!("Invalid state: {}", path.display())),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

pub fn load(path: &Path) -> Result<Loaded, String> {
    if let Some(json) = apply_restore(path) {
        return Ok(Loaded { json: Some(json), recovered: false, restored: true });
    }
    let primary = read(path);
    if let Ok(Some(json)) = &primary {
        return Ok(Loaded { json: Some(json.clone()), recovered: false, restored: false });
    }
    match read(&path.with_extension("json.bak")) {
        Ok(Some(json)) => Ok(Loaded { json: Some(json), recovered: true, restored: false }),
        Ok(None) => primary.map(|json| Loaded { json, recovered: false, restored: false }),
        Err(e) => Err(e),
    }
}

fn backups_dir(path: &Path) -> PathBuf {
    path.with_file_name("backups")
}

fn restore_marker(path: &Path) -> PathBuf {
    path.with_extension("json.restore")
}

/// Only names this module creates, so a name from the UI cannot leave `backups/`.
fn backup_kind(name: &str) -> Option<&'static str> {
    let stem = name.strip_suffix(".json")?;
    let (kind, number) = stem.split_once('-')?;
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) { return None; }
    match kind { "daily" => Some("daily"), "shrink" => Some("shrink"), _ => None }
}

fn counts(json: &str) -> (usize, usize) {
    let v: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    let len = |key: &str| v.get(key).and_then(|x| x.as_array()).map_or(0, Vec::len);
    (len("projects"), len("sessions"))
}

/// Did projects or sessions lose at least three entries or half of them?
fn shrank(previous: &str, next: &str) -> bool {
    let ((p0, s0), (p1, s1)) = (counts(previous), counts(next));
    let lost = |old: usize, new: usize| new < old && (old - new >= 3 || new * 2 <= old);
    lost(p0, p1) || lost(s0, s1)
}

fn now() -> Duration {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default()
}

/// Keeps a copy of the state that is about to be replaced. Best effort: a failed
/// snapshot never blocks saving the current state.
fn snapshot(path: &Path, previous: &str, next: &str, at: Duration) {
    let dir = backups_dir(path);
    if fs::create_dir_all(&dir).is_err() { return; }
    let daily = dir.join(format!("daily-{}.json", at.as_secs() / 86_400));
    if !daily.exists() { let _ = crate::fsutil::atomic_write(&daily, previous.as_bytes(), false); }
    if shrank(previous, next) {
        let _ = crate::fsutil::atomic_write(&dir.join(format!("shrink-{}.json", at.as_millis())), previous.as_bytes(), false);
    }
    prune(&dir);
}

/// Newest first by the time in the name (file times can be equal within one save burst).
fn sorted(mut all: Vec<Backup>) -> Vec<Backup> {
    let stamp = |b: &Backup| {
        let n: u128 = b.name.trim_end_matches(".json").split_once('-').and_then(|(_, n)| n.parse().ok()).unwrap_or(0);
        if b.kind == "daily" { n * 86_400_000 } else { n }
    };
    all.sort_by_key(|b| std::cmp::Reverse(stamp(b)));
    all
}

fn prune(dir: &Path) {
    let (mut daily, mut shrink, mut bytes) = (0, 0, 0);
    for b in sorted(list_dir(dir)) {
        let (slot, limit) = if b.kind == "daily" { (&mut daily, KEEP_DAILY) } else { (&mut shrink, KEEP_SHRINK) };
        *slot += 1;
        bytes += b.bytes;
        if *slot > limit || bytes > MAX_BACKUP_BYTES {
            let _ = fs::remove_file(dir.join(&b.name));
        }
    }
}

fn list_dir(dir: &Path) -> Vec<Backup> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    entries.flatten().filter_map(|e| {
        let name = e.file_name().into_string().ok()?;
        let kind = backup_kind(&name)?;
        let meta = e.metadata().ok().filter(|m| m.is_file())?;
        let saved_at = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
        let (projects, sessions) = counts(&fs::read_to_string(e.path()).ok()?);
        Some(Backup { name, kind, saved_at, projects, sessions, bytes: meta.len() })
    }).collect()
}

/// Snapshots, newest first.
pub fn backups(path: &Path) -> Vec<Backup> {
    sorted(list_dir(&backups_dir(path)))
}

/// Marks a snapshot to replace the state on the next start: the running window keeps
/// saving its own state until it closes, so replacing the file now would be undone.
pub fn schedule_restore(path: &Path, name: &str) -> Result<(), String> {
    if backup_kind(name).is_none() || !matches!(read(&backups_dir(path).join(name)), Ok(Some(_))) {
        return Err("state.backupMissing".into());
    }
    crate::fsutil::atomic_write(&restore_marker(path), name.as_bytes(), false).map_err(|e| format!("state.restoreFailed: {e}"))
}

/// Applies a scheduled restore; the replaced state is kept as a snapshot first.
fn apply_restore(path: &Path) -> Option<String> {
    let marker = restore_marker(path);
    let name = fs::read_to_string(&marker).ok()?;
    let _ = fs::remove_file(&marker);
    let name = name.trim();
    backup_kind(name)?;
    let json = read(&backups_dir(path).join(name)).ok()??;
    if let Ok(Some(current)) = read(path) {
        let replaced = backups_dir(path).join(format!("shrink-{}.json", now().as_millis()));
        let _ = crate::fsutil::atomic_write(&replaced, current.as_bytes(), false);
    }
    save(path, &json).ok()?;
    Some(json)
}

fn replace(path: &Path, json: &str) -> Result<(), String> {
    crate::fsutil::atomic_write(path, json.as_bytes(), false).map_err(|e| e.to_string())
}

pub fn save(path: &Path, json: &str) -> Result<(), String> {
    if !valid(json) { return Err("Invalid state payload".into()); }
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    // Never replace a healthy backup with an unreadable or corrupt primary.
    match read(path) {
        Ok(Some(previous)) => {
            snapshot(path, &previous, json, now());
            replace(&path.with_extension("json.bak"), &previous)?
        }
        Ok(None) => {},
        Err(e) => {
            // Preserve damaged input for recovery, but do not mask I/O failures.
            let damaged = fs::read_to_string(path).map_err(|_| e)?;
            let copy = path.with_extension(format!("json.corrupt-{}", uuid::Uuid::new_v4()));
            fs::write(copy, damaged).map_err(|e| e.to_string())?;
        }
    }
    replace(path, json)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("project-desk-state-{}", uuid::Uuid::new_v4())).join("state.json"))
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(self.0.parent().unwrap()); } }
    const A: &str = r#"{"projects":[],"sessions":[],"value":1}"#;
    const B: &str = r#"{"projects":[],"sessions":[],"value":2}"#;

    #[test]
    fn missing_state_is_first_launch_but_corrupt_state_is_an_error() {
        let f = Fixture::new();
        assert!(load(&f.0).unwrap().json.is_none());
        save(&f.0, A).unwrap();
        fs::write(&f.0, "broken").unwrap();
        assert!(load(&f.0).is_err());
    }
    #[test]
    fn recovery_preserves_good_backup_and_damaged_input() {
        let f = Fixture::new();
        save(&f.0, A).unwrap();
        save(&f.0, B).unwrap();
        fs::write(&f.0, "broken").unwrap();
        let loaded = load(&f.0).unwrap();
        assert!(loaded.recovered);
        assert_eq!(loaded.json.as_deref(), Some(A));
        save(&f.0, B).unwrap();
        assert_eq!(fs::read_to_string(f.0.with_extension("json.bak")).unwrap(), A);
        assert!(fs::read_dir(f.0.parent().unwrap()).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("corrupt-")));
        assert_eq!(load(&f.0).unwrap().json.as_deref(), Some(B));
    }
    #[test]
    fn invalid_write_does_not_replace_saved_state() {
        let f = Fixture::new();
        save(&f.0, A).unwrap();
        assert!(save(&f.0, "{}").is_err());
        assert_eq!(load(&f.0).unwrap().json.as_deref(), Some(A));
    }
    #[test]
    fn missing_primary_recovers_backup_and_read_error_is_not_empty_state() {
        let f = Fixture::new();
        save(&f.0, A).unwrap();
        save(&f.0, B).unwrap();
        fs::remove_file(&f.0).unwrap();
        assert!(load(&f.0).unwrap().recovered);
        fs::remove_file(f.0.with_extension("json.bak")).unwrap();
        fs::create_dir(&f.0).unwrap();
        assert!(load(&f.0).is_err());
    }

    fn state(projects: usize, sessions: usize) -> String {
        let ids = |n: usize, p: &str| (0..n).map(|i| format!(r#"{{"id":"{p}{i}"}}"#)).collect::<Vec<_>>().join(",");
        format!(r#"{{"projects":[{}],"sessions":[{}]}}"#, ids(projects, "p"), ids(sessions, "s"))
    }

    #[test]
    fn a_bad_but_valid_write_cannot_destroy_every_copy() {
        let f = Fixture::new();
        save(&f.0, &state(4, 6)).unwrap();
        save(&f.0, &state(4, 7)).unwrap();
        // A bug drops all projects; two more saves overwrite both state.json and .bak.
        save(&f.0, &state(0, 0)).unwrap();
        save(&f.0, &state(0, 0)).unwrap();
        let all = backups(&f.0);
        assert!(all.iter().any(|b| b.kind == "daily" && (b.projects, b.sessions) == (4, 6)));
        assert!(all.iter().any(|b| b.kind == "shrink" && (b.projects, b.sessions) == (4, 7)));
        assert_eq!(all.iter().filter(|b| b.kind == "daily").count(), 1, "one daily snapshot per day");
    }

    #[test]
    fn shrink_needs_three_lost_entries_or_half() {
        assert!(!shrank(&state(5, 10), &state(5, 9)));
        assert!(shrank(&state(5, 10), &state(5, 7)));
        assert!(shrank(&state(2, 0), &state(1, 0)));
        assert!(!shrank(&state(1, 1), &state(2, 2)));
    }

    #[test]
    fn snapshots_are_pruned_per_kind() {
        let f = Fixture::new();
        fs::create_dir_all(f.0.parent().unwrap()).unwrap();
        for day in 0..10u64 {
            snapshot(&f.0, &state(1, 1), &state(1, 1), Duration::from_secs(day * 86_400));
        }
        for i in 0..8u64 {
            snapshot(&f.0, &state(9, 9), &state(0, 0), Duration::from_secs(20 * 86_400) + Duration::from_millis(i));
        }
        let all = backups(&f.0);
        assert_eq!(all.iter().filter(|b| b.kind == "daily").count(), KEEP_DAILY);
        assert_eq!(all.iter().filter(|b| b.kind == "shrink").count(), KEEP_SHRINK);
        assert!(all.iter().any(|b| b.name == "daily-20.json"), "the newest daily snapshot stays");
        assert!(!all.iter().any(|b| b.name == "daily-0.json"), "the oldest goes");
    }

    #[test]
    fn restore_applies_on_next_load_and_keeps_the_replaced_state() {
        let f = Fixture::new();
        save(&f.0, &state(3, 3)).unwrap();
        save(&f.0, &state(0, 0)).unwrap();
        let name = backups(&f.0).into_iter().find(|b| b.projects == 3).unwrap().name;
        for bad in ["../state.json", "daily-x.json", "other-1.json", "daily-1.json"] {
            assert!(schedule_restore(&f.0, bad).is_err(), "{bad}");
        }
        schedule_restore(&f.0, &name).unwrap();
        // The window keeps saving until it closes; the restore still wins on the next start.
        save(&f.0, &state(0, 1)).unwrap();
        let loaded = load(&f.0).unwrap();
        assert!(loaded.restored);
        assert_eq!(counts(loaded.json.as_deref().unwrap()), (3, 3));
        assert!(!restore_marker(&f.0).exists());
        assert!(backups(&f.0).iter().any(|b| (b.projects, b.sessions) == (0, 1)), "the replaced state is kept");
        assert!(!load(&f.0).unwrap().restored);
    }
}
