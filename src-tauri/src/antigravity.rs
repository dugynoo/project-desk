//! Project-local hooks; credentials and session routing exist only in the child environment.
use std::path::Path;
use std::sync::Mutex;
use serde_json::{json, Value};

const KEY: &str = "project-desk";
static INSTALL: Mutex<()> = Mutex::new(());

fn definition() -> Value {
    let script = include_str!("antigravity-relay.cjs").lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>().join(" ");
    let mut hooks = serde_json::Map::new();
    for event in ["SessionStart", "PreInvocation", "PreToolUse", "PostToolUse", "Stop"] {
        let handler = json!({"type": "command", "command": format!("node -e \"{script}\" {event}"), "timeout": 2});
        let value = if event.ends_with("ToolUse") {
            json!([{"matcher": ".*", "hooks": [handler]}])
        } else { json!([handler]) };
        hooks.insert(event.into(), value);
    }
    Value::Object(hooks)
}

pub fn install(cwd: &Path) -> Result<(), String> {
    let _lock = INSTALL.lock().map_err(|e| e.to_string())?;
    let dir = cwd.join(".agents");
    let path = dir.join("hooks.json");
    let mut config: Value = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let map = config.as_object_mut().ok_or_else(|| format!("{}: expected JSON object", path.display()))?;
    let desired = definition();
    if map.get(KEY) == Some(&desired) { return Ok(()); }
    // Never overwrite a custom or explicitly disabled entry using our reserved name.
    if map.contains_key(KEY) { return Err(format!("{}: project-desk hook already exists with different settings", path.display())); }
    map.insert(KEY.into(), desired);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let temp = dir.join(format!(".project-desk-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(serde_json::to_string_pretty(&config).unwrap().as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = std::fs::remove_file(temp); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_hooks_and_refuses_invalid_or_conflicting_config() {
        let root = std::env::temp_dir().join(format!("desk-agy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".agents")).unwrap();
        let path = root.join(".agents/hooks.json");
        std::fs::write(&path, r#"{"custom":{"enabled":false}}"#).unwrap();
        install(&root).unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&first).unwrap()["custom"]["enabled"], false);
        install(&root).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
        for invalid in ["invalid", "[]", r#"{"project-desk":{"enabled":false}}"#] {
            std::fs::write(&path, invalid).unwrap();
            assert!(install(&root).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), invalid);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn relay_is_shell_constant_without_secrets_or_paths() {
        let script = include_str!("antigravity-relay.cjs");
        assert!(!script.contains(['"', '$', '`', '%']));
        let d = definition();
        assert!(d["PreToolUse"][0]["hooks"][0]["command"].as_str().unwrap().ends_with("PreToolUse"));
        assert!(d["Stop"][0]["command"].as_str().unwrap().ends_with("Stop"));
    }
}
