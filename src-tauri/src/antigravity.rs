//! User-scoped plugin; credentials and session routing exist only in the child environment.
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

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    use std::io::Write;
    let temp = path.with_file_name(format!(".project-desk-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|e| e.to_string())?;
        file.write_all(serde_json::to_string_pretty(value).unwrap().as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() { let _ = std::fs::remove_file(temp); }
    result
}

/// The documented manual-plugin location, shared by the AGY surfaces.
/// The home directory is resolved by Tauri; tests pass an isolated temporary home.
pub fn install(cwd: &Path, home: &Path) -> Result<(), String> {
    let _lock = INSTALL.lock().map_err(|e| e.to_string())?;
    let legacy_path = cwd.join(".agents/hooks.json");
    let mut legacy = read_json(&legacy_path)?;
    let desired = definition();
    if let Some(config) = &legacy {
        let map = config.as_object().ok_or_else(|| format!("{}: expected JSON object", legacy_path.display()))?;
        if let Some(entry) = map.get(KEY) {
            // A custom or explicitly disabled integration must never be re-enabled by migration.
            if entry != &desired {
                return Err(format!("{}: project-desk hook has custom or disabled settings", legacy_path.display()));
            }
        }
    }

    let parent = home.join(".gemini/config/plugins");
    let dir = parent.join(KEY);
    let manifest = json!({"name": KEY, "description": "Project Desk local session status"});
    let hooks = json!({KEY: desired});
    if dir.exists() {
        if read_json(&dir.join("plugin.json"))? != Some(manifest.clone())
            || read_json(&dir.join("hooks.json"))? != Some(hooks.clone()) {
            return Err(format!("{}: existing plugin differs from Project Desk's integration", dir.display()));
        }
    } else {
        // Publish both files together. A second Desk instance may have installed it meanwhile.
        std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        let stage = parent.join(format!(".project-desk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&stage).map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            write_json(&stage.join("plugin.json"), &manifest)?;
            write_json(&stage.join("hooks.json"), &hooks)?;
            if let Err(e) = std::fs::rename(&stage, &dir) {
                if read_json(&dir.join("plugin.json"))? != Some(manifest)
                    || read_json(&dir.join("hooks.json"))? != Some(hooks) {
                    return Err(e.to_string());
                }
            }
            Ok(())
        })();
        // Only remove our uniquely named staging files, never another plugin's directory.
        let _ = std::fs::remove_file(stage.join("plugin.json"));
        let _ = std::fs::remove_file(stage.join("hooks.json"));
        let _ = std::fs::remove_dir(&stage);
        result?;
    }

    // Remove only an exact copy of our old entry after successful installation.
    if let Some(config) = legacy.as_mut() {
        let map = config.as_object_mut().unwrap();
        if map.remove(KEY).is_some() {
            // Don't overwrite an edit made while the plugin was being installed.
            let mut expected = config.clone();
            expected.as_object_mut().unwrap().insert(KEY.into(), definition());
            if read_json(&legacy_path)? != Some(expected) {
                return Err(format!("{}: hooks changed during migration; retry", legacy_path.display()));
            }
            if config.as_object().unwrap().is_empty() {
                std::fs::remove_file(&legacy_path).map_err(|e| e.to_string())?;
                // Non-recursive: keep rules, skills and any other workspace customizations.
                let _ = std::fs::remove_dir(cwd.join(".agents"));
            } else {
                write_json(&legacy_path, config)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("desk-agy-{}", uuid::Uuid::new_v4()));
        let project = root.join("project with spaces");
        std::fs::create_dir_all(&project).unwrap();
        (root, project)
    }
    #[test]
    fn plugin_is_outside_project_and_install_is_idempotent() {
        let (root, project) = fixture();
        let home = root.join("home");
        install(&project, &home).unwrap();
        assert!(!project.join(".agents").exists());
        let path = home.join(".gemini/config/plugins/project-desk/hooks.json");
        assert_eq!(read_json(&path).unwrap().unwrap()[KEY], definition());
        let first = std::fs::read(&path).unwrap();
        install(&project, &home).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), first);
        std::fs::write(&path, r#"{"project-desk":{"enabled":false}}"#).unwrap();
        assert!(install(&project, &home).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"project-desk":{"enabled":false}}"#);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn migration_preserves_other_hooks_and_workspace_files() {
        let (root, project) = fixture();
        let home = root.join("home");
        std::fs::create_dir_all(project.join(".agents/rules")).unwrap();
        let path = project.join(".agents/hooks.json");
        write_json(&path, &json!({KEY: definition(), "custom": {"enabled": false}})).unwrap();
        install(&project, &home).unwrap();
        assert_eq!(read_json(&path).unwrap(), Some(json!({"custom": {"enabled": false}})));
        write_json(&path, &json!({KEY: definition()})).unwrap();
        install(&project, &home).unwrap();
        assert!(!path.exists());
        assert!(project.join(".agents/rules").exists());
        std::fs::remove_dir(project.join(".agents/rules")).unwrap();
        write_json(&path, &json!({KEY: definition()})).unwrap();
        install(&project, &home).unwrap();
        assert!(!project.join(".agents").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn migration_refuses_custom_disabled_and_invalid_legacy_entries() {
        let (root, project) = fixture();
        let home = root.join("home");
        std::fs::create_dir(project.join(".agents")).unwrap();
        let path = project.join(".agents/hooks.json");
        for invalid in ["invalid", "[]", r#"{"project-desk":{"enabled":false}}"#] {
            std::fs::write(&path, invalid).unwrap();
            assert!(install(&project, &home).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), invalid);
            assert!(!home.exists());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_plugin_install_keeps_legacy_hooks() {
        let (root, project) = fixture();
        let home = root.join("home");
        std::fs::create_dir(project.join(".agents")).unwrap();
        let legacy_path = project.join(".agents/hooks.json");
        write_json(&legacy_path, &json!({KEY: definition()})).unwrap();
        let original = std::fs::read(&legacy_path).unwrap();
        let conflict = home.join(".gemini/config/plugins/project-desk");
        std::fs::create_dir_all(&conflict).unwrap();
        std::fs::write(conflict.join("plugin.json"), r#"{"name":"custom"}"#).unwrap();
        assert!(install(&project, &home).is_err());
        assert_eq!(std::fs::read(&legacy_path).unwrap(), original);
        assert_eq!(std::fs::read_to_string(conflict.join("plugin.json")).unwrap(), r#"{"name":"custom"}"#);
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
