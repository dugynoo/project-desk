use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

fn command() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_project-desk"));
    cmd.arg("--project-desk-session-start")
        .env_remove("PROJECT_DESK_HOOK_PORT")
        .env_remove("PROJECT_DESK_HOOK_TOKEN")
        .env_remove("PROJECT_DESK_SESSION_ID")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd
}

#[test]
fn executable_relays_only_metadata_without_starting_desktop() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let desk = "22222222-2222-4222-8222-222222222222";
    let agent = "11111111-1111-4111-8111-111111111111";
    let mut child = command().env("PROJECT_DESK_HOOK_PORT", port.to_string())
        .env("PROJECT_DESK_HOOK_TOKEN", "abc123")
        .env("PROJECT_DESK_SESSION_ID", desk).spawn().unwrap();
    write!(child.stdin.take().unwrap(), "{}", serde_json::json!({
        "hook_event_name":"SessionStart", "session_id":agent,
        "transcript_path":"private", "prompt":"secret", "cwd":"private"
    })).unwrap();
    let mut request = server.recv_timeout(Duration::from_secs(5)).unwrap().expect("relay request");
    assert_eq!(request.url(), "/hook");
    for (name, value) in [("X-Project-Desk-Token", "abc123"), ("X-Project-Desk-Session", desk)] {
        assert_eq!(request.headers().iter().find(|h| h.field.equiv(name)).unwrap().value.as_str(), value);
    }
    let mut body = String::new();
    request.as_reader().read_to_string(&mut body).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({"hook_event_name":"SessionStart", "session_id":agent}));
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[test]
fn executable_is_quiet_without_desk_environment() {
    let output = command().output().unwrap();
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[cfg(windows)]
#[test]
#[allow(clippy::join_absolute_paths)] // Match Codex's root-relative synthetic source on the launch volume.
fn windows_codex_override_survives_powershell_and_relays_resume() {
    use std::os::windows::process::CommandExt;
    use project_desk_lib::hooks::codex_hooks_override;
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("Desk žluť's $cash & %PATH%!.exe");
    std::fs::copy(env!("CARGO_BIN_EXE_project-desk"), &exe).unwrap();
    let config = codex_hooks_override(&exe, dir.path());
    assert!(!config.contains('"'));
    // Real legacy PowerShell -> native argv, including spaces. No Codex account needed.
    let capture = dir.path().join("capture.cjs");
    std::fs::write(&capture, "process.stdout.write(JSON.stringify(process.argv.slice(2)))").unwrap();
    let output = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            "node $env:PD_CAPTURE -c \"$env:PROJECT_DESK_CODEX_HOOKS\""])
        .env("PD_CAPTURE", &capture).env("PROJECT_DESK_CODEX_HOOKS", &config)
        .output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let args: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(args, ["-c", config.as_str()]);
    let parsed: toml::Value = toml::from_str(&args[1]).unwrap();
    let hook = &parsed["hooks"]["SessionStart"][0];
    let command = hook["hooks"][0]["command"].as_str().unwrap();
    // Verify trust hashes the decoded declaration, not its TOML spelling.
    use sha2::Digest;
    let identity = serde_json::json!({"event_name":"session_start", "matcher":"startup|resume|clear",
        "hooks":[{"type":"command", "command":command, "timeout":5, "async":false}]});
    let digest = sha2::Sha256::digest(identity.to_string().as_bytes());
    let hash = format!("sha256:{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let key = format!("{}:session_start:0:0", dir.path().join(r"\<session-flags>\config.toml").display());
    assert_eq!(parsed["hooks"]["state"][&key]["trusted_hash"].as_str(), Some(hash.as_str()));
    let other = codex_hooks_override(&exe, std::path::Path::new(r"D:\another project"));
    let other: toml::Value = toml::from_str(&other).unwrap();
    assert_eq!(other["hooks"]["state"][r"D:\<session-flags>\config.toml:session_start:0:0"]["trusted_hash"].as_str(), Some(hash.as_str()));

    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let desk = "22222222-2222-4222-8222-222222222222";
    let agent = "11111111-1111-4111-8111-111111111111";
    // Codex's default Windows hook dispatcher: cmd /C with a raw command line.
    let mut child = Command::new("cmd.exe").arg("/C").raw_arg(format!("\"{command}\""))
        .env("PROJECT_DESK_HOOK_PORT", server.server_addr().to_ip().unwrap().port().to_string())
        .env("PROJECT_DESK_HOOK_TOKEN", "abc123").env("PROJECT_DESK_SESSION_ID", desk)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    write!(child.stdin.take().unwrap(), "{}", serde_json::json!({
        "hook_event_name":"SessionStart", "session_id":agent, "source":"resume",
        "cwd":"private", "prompt":"secret", "transcript_path":"private"
    })).unwrap();
    let request = server.recv_timeout(Duration::from_secs(10)).unwrap();
    if request.is_none() { let _ = child.kill(); }
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let mut request = request.expect("Codex resume relay request");
    assert_eq!(request.headers().iter().find(|h| h.field.equiv("X-Project-Desk-Session")).unwrap().value.as_str(), desk);
    let mut body = String::new();
    request.as_reader().read_to_string(&mut body).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&body).unwrap(), serde_json::json!({
        "provider":"codex", "hook_event_name":"SessionStart", "session_id":agent, "source":"resume"
    }));
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}
