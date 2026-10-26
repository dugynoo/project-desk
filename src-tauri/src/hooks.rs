//! Lokálny HTTP endpoint pre Claude Code hooky. Claude ho volá cez `--settings`
//! súbor, ktorý aplikácia zapíše pri štarte. Prenášame iba typ udalosti,
//! nikdy obsah promptov ani odpovedí.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::thread;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

pub const TOKEN_ENV: &str = "PROJECT_DESK_HOOK_TOKEN";
pub const SESSION_ENV: &str = "PROJECT_DESK_SESSION_ID";
pub const SETTINGS_ENV: &str = "PROJECT_DESK_HOOK_SETTINGS";
pub const PORT_ENV: &str = "PROJECT_DESK_HOOK_PORT";
pub const RELAY_ARG: &str = "--project-desk-session-start";

pub const EVENTS: [&str; 9] = ["SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification", "Stop", "StopFailure", "SessionEnd"];
const MAX_BODY: u64 = 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub provider: String,
    pub tool_name: Option<String>,
    pub fully_idle: Option<bool>,
    pub desk_session_id: String,
    pub agent_session_id: Option<String>,
    pub event: String,
    pub notification_type: Option<String>,
    pub source: Option<String>,
}

pub struct HookServer {
    pub port: u16,
    pub token: String,
    pub settings_path: PathBuf,
}

/// Z tela hooku vytiahne len to, čo potrebujeme na stav relácie.
pub fn parse_event(desk_session_id: &str, body: &str) -> Option<AgentEvent> {
    let v: Value = serde_json::from_str(body).ok()?;
    let event = v.get("hook_event_name")?.as_str()?.to_owned();
    let str_field = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    let provider = v.get("provider").and_then(Value::as_str).unwrap_or("claude");
    if !matches!(provider, "claude" | "antigravity") { return None; }
    Some(AgentEvent {
        provider: provider.to_owned(),
        tool_name: str_field("tool_name"),
        fully_idle: v.get("fully_idle").and_then(Value::as_bool),
        desk_session_id: desk_session_id.to_owned(),
        agent_session_id: str_field("session_id"),
        event,
        notification_type: str_field("notification_type"),
        source: str_field("source"),
    })
}

pub fn settings_json(port: u16, executable: &Path) -> Value {
    let handler = json!({
        "type": "http",
        "url": format!("http://127.0.0.1:{port}/hook"),
        "timeout": 2,
        "headers": {
            "X-Project-Desk-Token": format!("${TOKEN_ENV}"),
            "X-Project-Desk-Session": format!("${SESSION_ENV}")
        },
        "allowedEnvVars": [TOKEN_ENV, SESSION_ENV]
    });
    let mut hooks = serde_json::Map::new();
    for e in EVENTS {
        // SessionStart does not support HTTP hooks. Exec form bypasses shell
        // parsing, including spaces and metacharacters in the executable path.
        let h = if e == "SessionStart" {
            json!({"type": "command", "command": executable, "args": [RELAY_ARG], "timeout": 2})
        } else { handler.clone() };
        hooks.insert(e.to_owned(), json!([{ "hooks": [h] }]));
    }
    json!({ "hooks": hooks })
}

fn header<'a>(req: &'a tiny_http::Request, name: &'static str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str())
}

pub fn start(app: AppHandle, dir: &Path) -> Result<HookServer, String> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("unknown hook server port")?;
    let token = uuid::Uuid::new_v4().simple().to_string();

    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let settings_path = dir.join("claude-hooks.json");
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let body = serde_json::to_string_pretty(&settings_json(port, &executable)).map_err(|e| e.to_string())?;
    std::fs::write(&settings_path, body).map_err(|e| e.to_string())?;

    // Surviving workers read fresh credentials per event; never persist a static token.
    let endpoint = dir.join("background-endpoint.json");
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let temporary = endpoint.with_extension("json.pending");
    let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut file, json!({"port": port, "token": token}).to_string().as_bytes()).map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(temporary, endpoint).map_err(|e| e.to_string())?;

    let expected = token.clone();
    thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let authorized = header(&req, "X-Project-Desk-Token") == Some(expected.as_str());
            let session = header(&req, "X-Project-Desk-Session").map(str::to_owned);
            if !authorized || req.url() != "/hook" || *req.method() != tiny_http::Method::Post {
                let _ = req.respond(tiny_http::Response::empty(403));
                continue;
            }
            let mut body = String::new();
            let _ = req.as_reader().take(MAX_BODY).read_to_string(&mut body);
            if let Some(event) = session.and_then(|s| parse_event(&s, &body)) {
                let _ = app.emit("agent-event", event);
            }
            let _ = req.respond(tiny_http::Response::from_string("{}"));
        }
    });

    Ok(HookServer { token, settings_path, port })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_notification_without_message_text() {
        let body = r#"{"session_id":"abc","hook_event_name":"Notification","message":"tajné","notification_type":"permission_prompt"}"#;
        let e = parse_event("desk-1", body).unwrap();
        assert_eq!(e.event, "Notification");
        assert_eq!(e.agent_session_id.as_deref(), Some("abc"));
        assert_eq!(e.notification_type.as_deref(), Some("permission_prompt"));
        assert!(!serde_json::to_string(&e).unwrap().contains("tajné"));
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_event("x", "nie json").is_none());
        assert!(parse_event("x", "{}").is_none());
    }

    #[test]
    fn settings_cover_all_events_and_use_env_headers() {
        let s = settings_json(4242, Path::new("/test path/desk"));
        for e in EVENTS {
            assert!(s["hooks"][e].is_array(), "chýba {e}");
        }
        let h = &s["hooks"]["Stop"][0]["hooks"][0];
        assert_eq!(h["url"], "http://127.0.0.1:4242/hook");
        assert_eq!(h["headers"]["X-Project-Desk-Token"], "$PROJECT_DESK_HOOK_TOKEN");
        let start = &s["hooks"]["SessionStart"][0]["hooks"][0];
        assert_eq!(start["type"], "command");
        assert_eq!(start["command"], "/test path/desk");
        assert_eq!(start["args"], json!([RELAY_ARG]));
    }
}
