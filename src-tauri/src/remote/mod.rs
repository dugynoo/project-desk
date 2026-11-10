//! Vzdialený prístup z mobilu: história výstupu, arbitráž veľkosti, loopback server a čítanie Tailscale.
// Kostra: verejné signatúry sú zmluva medzi paralelnými taskami. Task 4 tento allow odstráni.
#![allow(dead_code, unused_variables)]

pub mod config;
pub mod history;
pub mod hub;
pub mod protocol;
pub mod server;
pub mod size;
pub mod tailscale;

use serde::Serialize;

/// Stav pre nastavenia na desktope (`remote_status`, `remote_configure`, `remote_new_token`).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub running: bool,
    pub port: u16,
    /// Ručne zadaná adresa, inak zistená z Tailscale (bez schémy).
    pub host: Option<String>,
    /// `tailscale serve` proxuje na náš port.
    pub serving: bool,
    /// `https://{host}/remote.html#t={token}`.
    pub pairing_url: Option<String>,
    /// `tailscale serve --bg {port}`.
    pub serve_command: String,
}
