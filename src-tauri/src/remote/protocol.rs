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
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMsg {
    Snapshot { snapshot: serde_json::Value },
    History { id: String, data: String },
    Output { id: String, data: String },
    Error { id: Option<String>, code: String },
}

/// Token z hlavičky `Sec-WebSocket-Protocol` (napr. `"pd.v1, auth.abc"` → `Some("abc")`).
pub fn token_from_protocols(header: &str) -> Option<&str> {
    todo!()
}

/// Presná zhoda s jedným z povolených originov.
pub fn origin_allowed(origin: &str, allowed: &[String]) -> bool {
    todo!()
}

/// Porovnanie v konštantnom čase.
pub fn tokens_equal(a: &str, b: &str) -> bool {
    todo!()
}
