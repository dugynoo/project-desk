//! A quiet, metadata-only SessionStart relay. Runs before Tauri initialization.
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;
use serde_json::{json, Value};
use crate::hooks;

fn payload(input: &str) -> Option<String> {
    let v: Value = serde_json::from_str(input).ok()?;
    if v["hook_event_name"] != "SessionStart" { return None; }
    let id = v["session_id"].as_str()?;
    uuid::Uuid::parse_str(id).ok()?;
    Some(json!({"hook_event_name": "SessionStart", "session_id": id}).to_string())
}

fn background_payload(input: &str) -> Option<String> {
    let v: Value = serde_json::from_str(input).ok()?;
    uuid::Uuid::parse_str(v["session_id"].as_str()?).ok()?;
    if !hooks::EVENTS.contains(&v["hook_event_name"].as_str()?) { return None; }
    let mut out = serde_json::Map::new();
    for key in ["session_id", "hook_event_name", "tool_name", "notification_type"] {
        if let Some(value) = v[key].as_str() { out.insert(key.into(), json!(value)); }
    }
    if let Some(value) = v["fully_idle"].as_bool() { out.insert("fully_idle".into(), json!(value)); }
    Some(Value::Object(out).to_string())
}

fn relay(background: bool) -> Option<()> {
    let (port, token, session) = if background {
        let endpoint = std::env::args_os().nth(2)?;
        let v: Value = serde_json::from_slice(&std::fs::read(endpoint).ok()?).ok()?;
        (u16::try_from(v["port"].as_u64()?).ok()?, v["token"].as_str()?.to_owned(), std::env::args().nth(3)?)
    } else {
        (std::env::var(hooks::PORT_ENV).ok()?.parse().ok()?,
         std::env::var(hooks::TOKEN_ENV).ok()?, std::env::var(hooks::SESSION_ENV).ok()?)
    };
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
    uuid::Uuid::parse_str(&session).ok()?;
    let mut input = String::new();
    std::io::stdin().take(1_048_577).read_to_string(&mut input).ok()?;
    if input.len() > 1_048_576 { return None; }
    let body = if background { background_payload(&input)? } else { payload(&input)? };
    let timeout = Duration::from_secs(1);
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    write!(stream, "POST /hook HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Project-Desk-Token: {token}\r\nX-Project-Desk-Session: {session}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).ok()?;
    Some(())
}

/// Fail quietly: tracking must never block the agent or print context to stdout.
pub fn run_if_requested() -> bool {
    let arg = std::env::args().nth(1).unwrap_or_default();
    if arg != hooks::RELAY_ARG && arg != crate::background::RELAY { return false; }
    let _ = relay(arg == crate::background::RELAY);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn background_payload_keeps_only_status_metadata() {
        let input = json!({"session_id": "11111111-1111-4111-8111-111111111111",
            "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "secret"},
            "tool_response": "private", "transcript_path": "private"});
        let out = background_payload(&input.to_string()).unwrap();
        assert!(!out.contains("secret")); assert!(!out.contains("private"));
        assert!(out.contains("Bash"));
        assert!(background_payload(r#"{"session_id":"bad","hook_event_name":"Stop"}"#).is_none());
        assert!(background_payload("{}").is_none());
    }
    #[test]
    fn forwards_only_valid_start_metadata() {
        let id = "11111111-1111-4111-8111-111111111111";
        let input = json!({"hook_event_name":"SessionStart", "session_id":id,
            "prompt":"secret", "transcript_path":"private", "cwd":"private"});
        let out: Value = serde_json::from_str(&payload(&input.to_string()).unwrap()).unwrap();
        assert_eq!(out, json!({"hook_event_name":"SessionStart", "session_id":id}));
        assert!(payload("{}").is_none());
        assert!(payload("bad json").is_none());
        assert!(payload(&json!({"hook_event_name":"Stop", "session_id":id}).to_string()).is_none());
        assert!(payload(r#"{"hook_event_name":"SessionStart","session_id":"invalid"}"#).is_none());
    }
    #[test]
    fn background_forwards_failure_and_permission_metadata_only() {
        for event in ["PermissionRequest", "PostToolUseFailure", "StopFailure"] {
            let input = json!({"hook_event_name":event,
                "session_id":"11111111-1111-4111-8111-111111111111",
                "tool_name":"Bash", "tool_input":{"command":"private"},
                "error_details":"private", "last_assistant_message":"private"});
            let output = background_payload(&input.to_string()).unwrap();
            assert!(!output.contains("private"));
            let output: Value = serde_json::from_str(&output).unwrap();
            assert_eq!(output["hook_event_name"], event);
            assert_eq!(output["tool_name"], "Bash");
        }
    }
}
