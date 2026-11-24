//! Správy medzi mobilom a serverom (JSON textové rámce) a overenie spojenia.

use serde::{Deserialize, Serialize};

/// Subprotokol WebSocketu; druhý záznam je `auth.<token>`.
pub const PROTOCOL: &str = "pd.v1";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMsg {
    Subscribe { id: String, cols: u16, rows: u16 },
    Unsubscribe { id: String },
    Input { id: String, data: String },
    Resize { id: String, cols: u16, rows: u16 },
    /// Ako ⏸ na desktope; potvrdenie pri pracujúcom agentovi rieši mobil.
    Pause { id: String },
    /// Ako ↻ Spustiť znova na desktope.
    Start { id: String },
    /// Chat zo session súboru (`chat.rs`); veľkosť PTY nemení.
    ChatOpen { id: String },
    ChatClose { id: String },
    /// JPEG v base64 (`upload.rs`); agentovi sa vloží cesta k nemu, bez Enteru.
    Image { id: String, data: String },
    /// Nová session v projekte. `id` vymyslí mobil, aby ju po vytvorení vedel otvoriť.
    Create { id: String, project: String, provider: NewProvider },
    /// Web Push odber tohto mobilu; uloží ho desktop (`src/remote-push.ts`).
    PushSubscribe { endpoint: String, p256dh: String, auth: String },
    PushUnsubscribe { endpoint: String },
}

/// Agenti, ktorých mobil vie spustiť v novej session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NewProvider {
    Claude,
    Codex,
}

impl NewProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            NewProvider::Claude => "claude",
            NewProvider::Codex => "codex",
        }
    }
}

/// Odber z prehliadača mobilu: https adresa push služby a kľúče v base64url.
pub fn push_subscription_valid(endpoint: &str, p256dh: &str, auth: &str) -> bool {
    let b64url = |s: &str, max: usize| !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'=');
    endpoint.starts_with("https://") && endpoint.len() <= 2048 && b64url(p256dh, 128) && b64url(auth, 64)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMsg {
    Snapshot { snapshot: serde_json::Value },
    History { id: String, data: String },
    Output { id: String, data: String },
    Error { id: Option<String>, code: String },
    /// `reset` = mobil zahodí doterajší chat a zobrazí `items`.
    Chat { id: String, reset: bool, items: Vec<super::chat::ChatItem> },
    /// Obrázok je vložený do vstupu agenta.
    ImageAttached { id: String },
}

/// Token z hlavičky `Sec-WebSocket-Protocol` (napr. `"pd.v1, auth.abc"` → `Some("abc")`).
pub fn token_from_protocols(header: &str) -> Option<&str> {
    header.split(',').find_map(|p| p.trim().strip_prefix("auth."))
}

/// Presná zhoda s jedným z povolených originov.
pub fn origin_allowed(origin: &str, allowed: &[String]) -> bool {
    allowed.iter().any(|a| a == origin)
}

/// Porovnanie v konštantnom čase.
pub fn tokens_equal(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_input_message() {
        let m: ClientMsg = serde_json::from_str(r#"{"type":"input","id":"s1","data":"x"}"#).unwrap();
        assert_eq!(m, ClientMsg::Input { id: "s1".into(), data: "x".into() });
    }

    #[test]
    fn parses_session_actions() {
        let m: ClientMsg = serde_json::from_str(r#"{"type":"pause","id":"s1"}"#).unwrap();
        assert_eq!(m, ClientMsg::Pause { id: "s1".into() });
        let m: ClientMsg = serde_json::from_str(r#"{"type":"start","id":"s1"}"#).unwrap();
        assert_eq!(m, ClientMsg::Start { id: "s1".into() });
    }

    #[test]
    fn parses_chat_messages() {
        let m: ClientMsg = serde_json::from_str(r#"{"type":"chatOpen","id":"s1"}"#).unwrap();
        assert_eq!(m, ClientMsg::ChatOpen { id: "s1".into() });
        let m: ClientMsg = serde_json::from_str(r#"{"type":"chatClose","id":"s1"}"#).unwrap();
        assert_eq!(m, ClientMsg::ChatClose { id: "s1".into() });
        let m: ClientMsg = serde_json::from_str(r#"{"type":"image","id":"s1","data":"/9j/"}"#).unwrap();
        assert_eq!(m, ClientMsg::Image { id: "s1".into(), data: "/9j/".into() });
        let json = serde_json::to_string(&ServerMsg::ImageAttached { id: "s1".into() }).unwrap();
        assert_eq!(json, r#"{"type":"imageAttached","id":"s1"}"#);
    }

    #[test]
    fn parses_create_and_push_messages() {
        let m: ClientMsg = serde_json::from_str(r#"{"type":"create","id":"n1","project":"p1","provider":"codex"}"#).unwrap();
        assert_eq!(m, ClientMsg::Create { id: "n1".into(), project: "p1".into(), provider: NewProvider::Codex });
        assert!(serde_json::from_str::<ClientMsg>(r#"{"type":"create","id":"n1","project":"p1","provider":"shell"}"#).is_err());
        let m: ClientMsg = serde_json::from_str(r#"{"type":"pushSubscribe","endpoint":"https://x","p256dh":"a","auth":"b"}"#).unwrap();
        assert_eq!(m, ClientMsg::PushSubscribe { endpoint: "https://x".into(), p256dh: "a".into(), auth: "b".into() });
        let m: ClientMsg = serde_json::from_str(r#"{"type":"pushUnsubscribe","endpoint":"https://x"}"#).unwrap();
        assert_eq!(m, ClientMsg::PushUnsubscribe { endpoint: "https://x".into() });
    }

    #[test]
    fn push_subscription_needs_https_and_base64url_keys() {
        assert!(push_subscription_valid("https://web.push.apple.com/abc", "BCVx-_", "BTBZ"));
        assert!(!push_subscription_valid("http://web.push.apple.com/abc", "BCVx", "BTBZ"));
        assert!(!push_subscription_valid("https://x", "BC Vx", "BTBZ"));
        assert!(!push_subscription_valid("https://x", "BCVx", ""));
    }

    #[test]
    fn rejects_unknown_type() {
        assert!(serde_json::from_str::<ClientMsg>(r#"{"type":"kill","id":"s1"}"#).is_err());
    }

    #[test]
    fn token_from_protocols_finds_auth_entry() {
        assert_eq!(token_from_protocols("pd.v1, auth.abc"), Some("abc"));
        assert_eq!(token_from_protocols("pd.v1"), None);
    }

    #[test]
    fn origin_allowed_exact_match_only() {
        let allowed = vec!["https://pc.tail1.ts.net".to_string()];
        assert!(origin_allowed("https://pc.tail1.ts.net", &allowed));
        assert!(!origin_allowed("https://pc.tail1.ts.net.evil.com", &allowed));
        assert!(!origin_allowed("http://pc.tail1.ts.net", &allowed));
    }

    #[test]
    fn tokens_equal_rejects_prefix() {
        assert!(!tokens_equal("abc", "ab"));
        assert!(tokens_equal("abc", "abc"));
        assert!(!tokens_equal("abc", "abd"));
    }
}
