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
