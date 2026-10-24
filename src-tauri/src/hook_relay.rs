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

fn relay() -> Option<()> {
    let port: u16 = std::env::var(hooks::PORT_ENV).ok()?.parse().ok()?;
    let token = std::env::var(hooks::TOKEN_ENV).ok()?;
    let session = std::env::var(hooks::SESSION_ENV).ok()?;
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
    uuid::Uuid::parse_str(&session).ok()?;
    let mut input = String::new();
    std::io::stdin().take(1_048_577).read_to_string(&mut input).ok()?;
    if input.len() > 1_048_576 { return None; }
    let body = payload(&input)?;
    let timeout = Duration::from_secs(1);
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    write!(stream, "POST /hook HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Project-Desk-Token: {token}\r\nX-Project-Desk-Session: {session}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).ok()?;
    Some(())
}

/// Fail quietly: tracking must never block the agent or print context to stdout.
pub fn run_if_requested() -> bool {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(hooks::RELAY_ARG)) { return false; }
    let _ = relay();
    true
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
