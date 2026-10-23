//! Validated state with a last-known-good backup. Callers serialize writes.
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::Path;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub json: Option<String>,
    pub recovered: bool,
}

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
    let primary = read(path);
    if let Ok(Some(json)) = &primary {
        return Ok(Loaded { json: Some(json.clone()), recovered: false });
    }
    match read(&path.with_extension("json.bak")) {
        Ok(Some(json)) => Ok(Loaded { json: Some(json), recovered: true }),
        Ok(None) => primary.map(|json| Loaded { json, recovered: false }),
        Err(e) => Err(e),
    }
}

fn replace(path: &Path, json: &str) -> Result<(), String> {
    let tmp = path.with_extension(format!("{}.tmp", path.extension().unwrap_or_default().to_string_lossy()));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() { let _ = fs::remove_file(&tmp); }
    result.map_err(|e: std::io::Error| e.to_string())
}

pub fn save(path: &Path, json: &str) -> Result<(), String> {
    if !valid(json) { return Err("Invalid state payload".into()); }
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    // Never replace a healthy backup with an unreadable or corrupt primary.
    match read(path) {
        Ok(Some(previous)) => replace(&path.with_extension("json.bak"), &previous)?,
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
}
