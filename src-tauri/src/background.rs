//! Opt-in Claude background workers. Ownership is persisted before dispatch;
//! only the terminal attachment belongs to the application's process tree.
use std::{io::Read, path::{Path, PathBuf}, process::{Command, Stdio}, sync::Mutex, time::{Duration, Instant}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

static OPERATIONS: Mutex<()> = Mutex::new(());
pub const RELAY: &str = "--project-desk-background-hook";

#[derive(Deserialize, Serialize)]
struct Owned {
    program: PathBuf,
    cwd: PathBuf,
    name: String,
    session_id: Option<String>,
    #[serde(default)]
    job_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub session_id: String,
    pub status: String,
    #[serde(skip)]
    pub program: PathBuf,
    #[serde(skip)]
    pub job_id: String,
}

fn error(e: impl std::fmt::Display) -> String { format!("background.failed: {e}") }
fn save_owned(path: &Path, owned: &Owned) -> Result<(), String> {
    let temporary = path.with_extension("json.pending");
    std::fs::write(&temporary, serde_json::to_vec(owned).map_err(error)?).map_err(error)?;
    std::fs::rename(temporary, path).map_err(error)
}

fn record(dir: &Path, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(error)?;
    Ok(dir.join(format!("background-{id}.json")))
}

// Intentionally narrow initial support: never reinterpret custom shell syntax
// or silently discard command options. Existing foreground sessions keep it all.
fn launch_options(command: &str) -> Result<bool, String> {
    match command.trim() {
        "claude" => Ok(false),
        "claude --dangerously-skip-permissions" => Ok(true),
        _ => Err("background.unsupportedCommand".into()),
    }
}

fn program(home: &Path) -> PathBuf {
    let native = home.join(".local/bin").join(if cfg!(windows) { "claude.exe" } else { "claude" });
    if native.is_file() { native } else { PathBuf::from("claude") }
}

fn run(program: &Path, cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); }
    let mut child = cmd.spawn().map_err(error)?;
    // Drain both pipes without allowing unbounded output or pipe deadlocks.
    fn drain(mut pipe: impl Read + Send + 'static) -> std::sync::mpsc::Receiver<Vec<u8>> {
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut kept = Vec::new(); let mut buf = [0; 4096];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 { break; }
                kept.extend_from_slice(&buf[..n.min(1_048_576 - kept.len())]);
            }
            let _ = send.send(kept);
        });
        receive
    }
    let out = drain(child.stdout.take().unwrap());
    let err = drain(child.stderr.take().unwrap());
    let start = Instant::now();
    let status = loop {
        match child.try_wait().map_err(error)? {
            Some(status) => break status,
            None if start.elapsed() > Duration::from_secs(30) => {
                let _ = child.kill(); let _ = child.wait();
                // Never kill the supervisor tree: it may host other sessions.
                return Err(error("Claude command timed out; retry to reconnect"));
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    };
    let stdout = out.recv_timeout(Duration::from_secs(1)).map_err(error)?;
    let stderr = err.recv_timeout(Duration::from_secs(1)).map_err(error)?;
    let stdout = String::from_utf8_lossy(&stdout).into_owned();
    let stderr = String::from_utf8_lossy(&stderr).into_owned();
    if !status.success() { return Err(error(stderr.trim())); }
    Ok(stdout)
}

fn entries(owned: &Owned) -> Result<Vec<Value>, String> {
    serde_json::from_str(&run(&owned.program, &owned.cwd, &["agents", "--json", "--all"])?).map_err(error)
}

fn find<'a>(rows: &'a [Value], owned: &Owned) -> Option<&'a Value> {
    rows.iter().find(|r| r["kind"] == "background" && if let Some(id) = &owned.job_id { r["id"] == *id } else { match &owned.session_id {
        Some(id) => r["sessionId"] == *id,
        None => r["name"] == owned.name && r["cwd"].as_str().map(Path::new) == Some(owned.cwd.as_path()),
    } })
}

fn untrusted(error: &str) -> bool { error.to_ascii_lowercase().contains("not trusted") }

fn control_id(row: &Value) -> Result<&str, String> {
    row["id"].as_str().filter(|id| id.len() == 8 && id.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| error("Invalid Claude job ID"))
}

pub fn prepare(dir: &Path, home: &Path, id: &str, cwd: &Path, command: &str) -> Result<Prepared, String> {
    if !cfg!(windows) { return Err("background.platform".into()); }
    let _guard = OPERATIONS.lock().map_err(error)?;
    let path = record(dir, id)?;
    let mut owned: Owned = if path.exists() {
        serde_json::from_slice(&std::fs::read(&path).map_err(error)?).map_err(error)?
    } else {
        launch_options(command)?;
        let executable = program(home);
        let version = run(&executable, cwd, &["--version"])?;
        let version = version.split_whitespace().next().and_then(|s| semver::Version::parse(s).ok());
        if version.is_none_or(|v| v < semver::Version::new(2, 1, 310)) {
            return Err(error("Native Claude Code 2.1.310 or later is required"));
        }
        let owned = Owned { program: program(home), cwd: cwd.to_owned(),
            name: format!("project-desk-{id}"), session_id: None, job_id: None };
        save_owned(&path, &owned)?;
        owned
    };
    let mut rows = entries(&owned)?;
    if find(&rows, &owned).is_none() {
        if owned.session_id.is_some() { return Err(error("Saved Claude background session is missing; refusing to create a replacement")); }
        let bypass = launch_options(command)?;
        let executable = std::env::current_exe().map_err(error)?;
        let mut hooks = serde_json::Map::new();
        for event in crate::hooks::EVENTS {
            hooks.insert(event.into(), json!([{ "hooks": [{ "type": "command", "command": executable,
                "args": [RELAY, dir.join("background-endpoint.json"), id], "timeout": 2 }] }]));
        }
        let settings = dir.join(format!("background-{id}-hooks.json"));
        std::fs::write(&settings, json!({"hooks": hooks, "worktree": {"bgIsolation": "none"}}).to_string()).map_err(error)?;
        let settings = settings.to_string_lossy();
        let mut args = vec!["--bg", "--name", &owned.name, "--settings", &settings];
        if bypass { args.push("--dangerously-skip-permissions"); }
        if let Err(e) = run(&owned.program, &owned.cwd, &args) {
            // The trust prompt needs an interactive terminal: forget this attempt so the
            // session can start in the foreground, where Claude asks for trust itself.
            if untrusted(&e) {
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_file(dir.join(format!("background-{id}-hooks.json")));
                return Err("background.untrusted".into());
            }
            return Err(e);
        }
        rows = entries(&owned)?;
    }
    let row = find(&rows, &owned).ok_or_else(|| error("Claude did not return the new background session"))?;
    let session_id = row["sessionId"].as_str().filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .ok_or_else(|| error("Invalid background conversation ID"))?.to_owned();
    let job_id = control_id(row)?.to_owned();
    owned.job_id = Some(job_id.clone());
    owned.session_id = Some(session_id.clone());
    save_owned(&path, &owned)?;
    Ok(Prepared { session_id, job_id, status: row["state"].as_str().unwrap_or("unknown").into(), program: owned.program })
}

pub fn stop(dir: &Path, id: &str) -> Result<(), String> {
    // Legacy/synthetic foreground IDs cannot have an owned background record.
    if uuid::Uuid::parse_str(id).is_err() { return Ok(()); }
    let _guard = OPERATIONS.lock().map_err(error)?;
    let path = record(dir, id)?;
    if !path.exists() { return Ok(()); }
    let owned: Owned = serde_json::from_slice(&std::fs::read(path).map_err(error)?).map_err(error)?;
    let rows = entries(&owned)?;
    if let Some(row) = find(&rows, &owned) {
        let id = control_id(row)?;
        run(&owned.program, &owned.cwd, &["stop", id])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_id_is_not_the_conversation_uuid() {
        let row = json!({"id": "a1b2c3d4", "sessionId": "11111111-1111-4111-8111-111111111111"});
        assert_eq!(control_id(&row).unwrap(), "a1b2c3d4");
        assert!(control_id(&json!({"id":"--all"})).is_err());
        assert!(control_id(&json!({"sessionId":"11111111-1111-4111-8111-111111111111"})).is_err());
    }

    #[test]
    fn persisted_job_id_survives_conversation_changes_and_renames() {
        let owned = Owned { program: "claude".into(), cwd: "/test".into(), name: "original".into(),
            session_id: Some("old-conversation".into()), job_id: Some("a1b2c3d4".into()) };
        let rows = vec![json!({"kind":"background", "id":"a1b2c3d4", "sessionId":"new-conversation", "name":"renamed"})];
        assert!(find(&rows, &owned).is_some());
        let prepared = Prepared { session_id: "conversation".into(), status: "working".into(), program: "private-path".into(), job_id: "a1b2c3d4".into() };
        let wire = serde_json::to_value(prepared).unwrap();
        assert_eq!(wire, json!({"sessionId":"conversation","status":"working"}));
    }

    #[test]
    fn only_owned_background_rows_match() {
        let owned = Owned { program: "claude".into(), cwd: "/test".into(), name: "owned".into(), session_id: Some("id".into()), job_id: None };
        let rows = vec![json!({"kind":"interactive","sessionId":"id"}), json!({"kind":"background","sessionId":"other"})];
        assert!(find(&rows, &owned).is_none());
        assert!(find(&[json!({"kind":"background","sessionId":"id"})], &owned).is_some());
    }
    #[test]
    fn rejects_shell_syntax_and_record_traversal() {
        assert!(launch_options("claude --dangerously-skip-permissions").unwrap());
        for command in ["claude; echo hi", "claude --model sonnet", "other"] { assert!(launch_options(command).is_err()); }
        assert!(record(Path::new("/test"), "../other").is_err());
    }
    #[test]
    fn recognizes_untrusted_workspace_failures() {
        assert!(untrusted(&error("Workspace not trusted. Run `claude` in C:\\p once and accept the trust prompt, then retry.")));
        assert!(!untrusted(&error("Claude command timed out; retry to reconnect")));
    }
}
