//! Zistenie ID Codex konverzácie, aby sa po reštarte dala obnoviť presne tá istá.
//! Codex nemá prepínač na zadanie ID, preto čítame iba prvý riadok jeho
//! session súborov (`session_meta`) a z neho len `id`, `cwd` a `timestamp`.
//! Obsah konverzácie sa nečíta.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

/// Prvý riadok obsahuje aj systémové inštrukcie, takže býva desiatky kB.
const MAX_META_LINE: u64 = 4 * 1024 * 1024;
/// Tolerancia medzi naším časom štartu a časom zápisu Codexu.
const SLACK_MS: u64 = 5_000;

#[derive(Deserialize)]
struct MetaLine {
    #[serde(rename = "type")]
    kind: String,
    payload: Meta,
}

#[derive(Deserialize)]
struct Meta {
    id: String,
    cwd: String,
    timestamp: Option<String>,
    source: Option<serde_json::Value>,
}

/// Recover a missed ID before launching resume. Only accept one original
/// conversation created near the Desk item, never the most recently active one.
pub fn recover_session(root: &Path, cwd: &str, created_ms: u64, exclude: &[String]) -> Option<String> {
    let from = created_ms.saturating_sub(SLACK_MS);
    let until = created_ms.checked_add(60_000)?;
    let mut found = None;
    // Directory dates use local time, metadata uses UTC. Include adjacent days.
    for day in (from / DAY_MS).saturating_sub(1)..=until / DAY_MS + 1 {
        let (y, m, d) = civil(day as i64);
        let dir = root.join(format!("{y:04}")).join(format!("{m:02}")).join(format!("{d:02}"));
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for path in entries.flatten().map(|entry| entry.path()) {
            if path.extension().is_none_or(|e| e != "jsonl") { continue; }
            let Some((meta, created)) = read_meta(&path) else { continue };
            if created < from || created > until || !same_dir(&meta.cwd, cwd)
                || uuid::Uuid::parse_str(&meta.id).is_err()
                || exclude.contains(&meta.id)
                || meta.source.as_ref().is_some_and(|s| !matches!(s.as_str(), Some("cli" | "vscode"))) {
                continue;
            }
            if found.as_ref().is_some_and(|id| id != &meta.id) { return None; }
            found = Some(meta.id);
        }
    }
    found
}

pub fn sessions_root() -> Option<PathBuf> {
    let home = std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| {
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(|h| PathBuf::from(h).join(".codex"))
    })?;
    Some(home.join("sessions"))
}

fn same_dir(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let p = p.trim_end_matches(['\\', '/']).replace('\\', "/");
        if cfg!(windows) { p.to_lowercase() } else { p }
    };
    norm(a) == norm(b)
}

/// RFC 3339 v UTC (`2026-10-21T18:06:23.297Z`) na milisekundy od epochy.
pub(crate) fn parse_utc_ms(ts: &str) -> Option<u64> {
    let b = ts.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[10] != b'T' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| ts.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (h, mi, s) = (n(11..13)?, n(14..16)?, n(17..19)?);
    let ms = if b.get(19) == Some(&b'.') {
        let frac: String = ts[20..].chars().take_while(char::is_ascii_digit).take(3).collect();
        format!("{frac:0<3}").parse::<i64>().ok()?
    } else {
        0
    };
    // Dni od epochy (algoritmus H. Hinnanta).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(((days * 24 + h) * 60 + mi) * 60_000 + s * 1000 + ms).ok()
}

fn read_meta(path: &Path) -> Option<(Meta, u64)> {
    let file = File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(file.take(MAX_META_LINE)).read_line(&mut line).ok()?;
    let meta: MetaLine = serde_json::from_str(line.trim_end()).ok()?;
    if meta.kind != "session_meta" {
        return None;
    }
    let created = meta.payload.timestamp.as_deref().and_then(parse_utc_ms)?;
    Some((meta.payload, created))
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// Only one eligible conversation may match; ordering cannot establish ownership.
pub fn find_session(root: &Path, cwd: &str, since_ms: u64, exclude: &[String]) -> Option<String> {
    let from = since_ms.saturating_sub(SLACK_MS);
    let mut found = None;
    for path in recent_files(root, from) {
        let Some((meta, created)) = read_meta(&path) else { continue };
        if created < from || !same_dir(&meta.cwd, cwd) || exclude.contains(&meta.id)
            || uuid::Uuid::parse_str(&meta.id).is_err()
            || meta.source.as_ref().is_some_and(|s| !matches!(s.as_str(), Some("cli" | "vscode"))) {
            continue;
        }
        if found.as_ref().is_some_and(|id| id != &meta.id) { return None; }
        found = Some(meta.id);
    }
    found
}

const DAY_MS: u64 = 86_400_000;
/// Viac dní dozadu nehľadáme; relácia sa dohľadáva krátko po štarte.
const MAX_DAYS: u64 = 31;

/// Kalendárny dátum (r, m, d) v UTC pre počet dní od epochy.
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `.jsonl` súbory zmenené po `from_ms` v priečinkoch RRRR/MM/DD od dňa štartu po dnešok.
/// Codex pomenúva priečinky podľa lokálneho dátumu, preto berieme o deň navyše z oboch strán.
fn recent_files(root: &Path, from_ms: u64) -> Vec<PathBuf> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let first = (from_ms / DAY_MS).saturating_sub(1).max((now / DAY_MS).saturating_sub(MAX_DAYS));
    let last = now / DAY_MS + 1;
    let mut out = Vec::new();
    for day in first..=last {
        let (y, m, d) = civil(day as i64);
        let dir = root.join(format!("{y:04}")).join(format!("{m:02}")).join(format!("{d:02}"));
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "jsonl") && modified_ms(&path) >= from_ms {
                out.push(path);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_utc_timestamp() {
        assert_eq!(parse_utc_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(parse_utc_ms("2026-10-21T18:06:23.297Z"), Some(1_792_605_983_297));
        assert_eq!(parse_utc_ms("nezmysel"), None);
    }

    #[test]
    fn compares_dirs_loosely_on_windows_paths() {
        assert!(same_dir(r"C:\Users\a\proj\", r"C:\Users\a\proj"));
        if cfg!(windows) {
            assert!(same_dir(r"c:\users\a\PROJ", r"C:\Users\a\proj"));
        }
    }

    fn write_session(dir: &Path, name: &str, id: &str, cwd: &str, ts: &str) {
        let line = serde_json::json!({ "type": "session_meta", "payload": { "id": id, "cwd": cwd, "timestamp": ts, "base_instructions": "x" } });
        std::fs::write(dir.join(name), format!("{line}\n{{\"type\":\"message\",\"payload\":{{}}}}\n")).unwrap();
    }

    /// Inverzia k `parse_utc_ms`, iba pre testy.
    fn iso(ms: u64) -> String {
        let (y, m, d) = civil((ms / DAY_MS) as i64);
        let rem = ms % DAY_MS;
        format!(
            "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
            rem / 3_600_000,
            (rem / 60_000) % 60,
            (rem / 1000) % 60,
            rem % 1000
        )
    }

    /// Ručná kontrola na reálnych Codex súboroch:
    /// `PD_CODEX_CWD=... PD_SINCE=2026-10-21T18:00:00Z cargo test real_codex -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_codex_sessions() {
        let cwd = std::env::var("PD_CODEX_CWD").unwrap();
        let since = parse_utc_ms(&std::env::var("PD_SINCE").unwrap()).unwrap();
        println!("nájdené: {:?}", find_session(&sessions_root().unwrap(), &cwd, since, &[]));
    }

    #[test]
    fn iso_roundtrip() {
        let ms = parse_utc_ms("2026-10-22T10:11:12.345Z").unwrap();
        assert_eq!(iso(ms), "2026-10-22T10:11:12.345Z");
    }

    #[test]
    fn recovery_uses_original_creation_and_refuses_ambiguous_or_claimed_threads() {
        let root = std::env::temp_dir().join(format!("pd-recover-{}", uuid::Uuid::new_v4().simple()));
        // Older than the live discovery window: recovery must not depend on mtime or today.
        let created = parse_utc_ms("2025-01-01T23:59:58.000Z").unwrap();
        let day = root.join("2025/01/02");
        std::fs::create_dir_all(&day).unwrap();
        let id = "01a165d4-170c-7bd0-b97c-bcf0870d54a2";
        let other = "01a16610-5859-74d3-b102-386ed44e0c30";
        write_session(&day, "original.jsonl", id, "/project", &iso(created - 709));
        write_session(&day, "later.jsonl", other, "/project", &iso(created + 120_000));
        assert_eq!(recover_session(&root, "/project", created, &[]).as_deref(), Some(id));
        assert_eq!(recover_session(&root, "/different", created, &[]), None);
        assert_eq!(recover_session(&root, "/project", created, &[id.into()]), None);
        write_session(&day, "ambiguous.jsonl", other, "/project", &iso(created + 500));
        assert_eq!(recover_session(&root, "/project", created, &[]), None);
        let subagent = serde_json::json!({"type":"session_meta", "payload":{
            "id":other, "cwd":"/project", "timestamp":iso(created + 500),
            "source":{"subagent":{"parent_thread_id":id}}
        }});
        std::fs::write(day.join("ambiguous.jsonl"), format!("{subagent}\n")).unwrap();
        assert_eq!(recover_session(&root, "/project", created, &[]).as_deref(), Some(id));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discovery_rejects_ambiguous_threads_and_ignores_invalid_or_claimed_ids() {
        let root = std::env::temp_dir().join(format!("pd-codex-{}", uuid::Uuid::new_v4().simple()));
        // Súbory sú čerstvo zapísané, takže mtime filter ich pustí; rozhoduje timestamp v meta.
        let base = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 - 60_000;
        let (y, m, d) = civil((base / DAY_MS) as i64);
        let day = root.join(format!("{y:04}")).join(format!("{m:02}")).join(format!("{d:02}"));
        std::fs::create_dir_all(&day).unwrap();
        write_session(&day, "a.jsonl", "old", r"C:\p", &iso(base - 60_000));
        write_session(&day, "b.jsonl", "11111111-1111-4111-8111-111111111111", r"C:\p", &iso(base + 1_000));
        write_session(&day, "c.jsonl", "22222222-2222-4222-8222-222222222222", r"C:\p\", &iso(base + 2_000));
        write_session(&day, "d.jsonl", "33333333-3333-4333-8333-333333333333", r"C:\p", &iso(base + 9_000));
        write_session(&day, "e.jsonl", "other-dir", r"C:\q", &iso(base + 1_500));

        let claimed = vec!["11111111-1111-4111-8111-111111111111".to_owned()];
        assert_eq!(find_session(&root, r"C:\p", base, &claimed), None);
        std::fs::remove_file(day.join("d.jsonl")).unwrap();
        assert_eq!(find_session(&root, r"C:\p", base, &claimed).as_deref(), Some("22222222-2222-4222-8222-222222222222"));
        write_session(&day, "invalid.jsonl", "not-a-uuid", r"C:\p", &iso(base + 3_000));
        let subagent = serde_json::json!({"type":"session_meta", "payload":{
            "id":"33333333-3333-4333-8333-333333333333", "cwd":r"C:\p", "timestamp":iso(base + 500),
            "source":{"subagent":{}}
        }});
        std::fs::write(day.join("subagent.jsonl"), format!("{subagent}\n")).unwrap();
        assert_eq!(find_session(&root, r"C:\p", base, &claimed).as_deref(), Some("22222222-2222-4222-8222-222222222222"));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
