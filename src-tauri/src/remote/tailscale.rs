//! Read-only zistenie adresy v tailnete. Project Desk Tailscale nikdy nekonfiguruje.

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tailnet {
    /// Napr. `pc.tail1.ts.net` (bez koncovej bodky a schémy).
    pub host: String,
    pub serving: bool,
}

/// `Self.DNSName` z `tailscale status --json`, bez koncovej bodky.
pub fn parse_status(json: &str) -> Option<String> {
    todo!()
}

/// Či niektorý handler v `tailscale serve status --json` proxuje na `127.0.0.1:{port}` / `localhost:{port}`.
pub fn parse_serving(json: &str, port: u16) -> bool {
    todo!()
}

/// `tailscale` z PATH, na Windows aj `C:\Program Files\Tailscale\tailscale.exe`. Timeout 3 s.
pub fn detect(port: u16) -> Option<Tailnet> {
    todo!()
}

pub fn detect_with(program: &Path, port: u16) -> Option<Tailnet> {
    todo!()
}
