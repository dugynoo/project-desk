//! Vzdialený prístup z mobilu: história výstupu, arbitráž veľkosti, loopback server a čítanie Tailscale.

pub mod chat;
pub mod config;
pub mod history;
pub mod hub;
pub mod protocol;
pub mod server;
pub mod size;
pub mod tailscale;

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use server::RemoteEvent;
use tailscale::Tailnet;

/// Predvolený port z nastavení (`remotePort`), kým ho desktop nenastaví.
pub const DEFAULT_PORT: u16 = 47615;

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

/// Nastavenie a bežiaci server; mení sa len pod async zámkom v `AppState`.
pub struct Control {
    pub server: Option<server::Running>,
    pub enabled: bool,
    pub port: u16,
    pub address: String,
    pub token: Option<String>,
    pub tailnet: Option<Tailnet>,
}

impl Default for Control {
    fn default() -> Self {
        Self { server: None, enabled: false, port: DEFAULT_PORT, address: String::new(), token: None, tailnet: None }
    }
}

impl Control {
    pub fn status(&self) -> RemoteStatus {
        let host = normalize_host(&self.address).or_else(|| self.tailnet.as_ref().map(|t| t.host.clone()));
        let running = self.server.is_some();
        let pairing_url = match (running, &host, &self.token) {
            (true, Some(host), Some(token)) => Some(format!("https://{host}/remote.html#t={token}")),
            _ => None,
        };
        RemoteStatus {
            running,
            port: self.server.as_ref().map_or(self.port, server::Running::port),
            host,
            serving: self.tailnet.as_ref().is_some_and(|t| t.serving),
            pairing_url,
            serve_command: format!("tailscale serve --bg {}", self.port),
        }
    }

    /// `https://{host}` pre ručnú aj zistenú adresu a lokálny test cez loopback.
    pub fn allowed_origins(&self) -> Vec<String> {
        let mut origins = Vec::new();
        let hosts = normalize_host(&self.address).into_iter().chain(self.tailnet.as_ref().map(|t| t.host.clone()));
        for host in hosts {
            let origin = format!("https://{host}");
            if !origins.contains(&origin) {
                origins.push(origin);
            }
        }
        origins.push(format!("http://127.0.0.1:{}", self.port));
        origins.push(format!("http://localhost:{}", self.port));
        origins
    }
}

/// Ručne zadaná adresa bez schémy a koncového `/`; prázdna = žiadna.
pub fn normalize_host(address: &str) -> Option<String> {
    let a = address.trim();
    let a = a.strip_prefix("https://").or_else(|| a.strip_prefix("http://")).unwrap_or(a);
    let a = a.trim_end_matches('/');
    (!a.is_empty()).then(|| a.to_owned())
}

/// Udalosti servera ako Tauri eventy pre desktopové okno.
pub fn events(app: AppHandle) -> server::Events {
    Arc::new(move |event| {
        let _ = match event {
            RemoteEvent::Watching { ids } => app.emit("remote-watching", serde_json::json!({ "ids": ids })),
            RemoteEvent::SizeTaken { id } => app.emit("remote-size", serde_json::json!({ "id": id })),
            RemoteEvent::SizeReleased { id } => app.emit("remote-size-released", serde_json::json!({ "id": id })),
            RemoteEvent::Action { id, action } => {
                app.emit("remote-action", serde_json::json!({ "id": id, "action": action.as_str() }))
            }
        };
    })
}

/// Súbory mobilnej stránky: vo vydanej verzii zabalené v aplikácii, v debug builde z Vite.
pub fn assets(app: AppHandle) -> server::Assets {
    Arc::new(move |path: &str| asset(&app, path))
}

#[cfg(not(debug_assertions))]
fn asset(app: &AppHandle, path: &str) -> Option<(Vec<u8>, String)> {
    let path = path.split_once('?').map_or(path, |(p, _)| p);
    if path != "remote.html" && !path.starts_with("assets/") {
        return None;
    }
    let asset = app.asset_resolver().get(path.to_owned())?;
    // Neznámu cestu resolver nahradí index.html.
    if path != "remote.html" && asset.mime_type.starts_with("text/html") {
        return None;
    }
    Some((asset.bytes, asset.mime_type))
}

/// `npm run app:dev`: stránku a moduly servuje Vite na pevnom porte.
#[cfg(debug_assertions)]
fn asset(_app: &AppHandle, path: &str) -> Option<(Vec<u8>, String)> {
    // `@fs` by sprístupnil súbory mimo projektu.
    if path.starts_with("@fs") {
        return None;
    }
    dev_fetch(format!("http://localhost:1420/{path}"))
}

#[cfg(debug_assertions)]
fn dev_fetch(url: String) -> Option<(Vec<u8>, String)> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    // Volá sa zo `spawn_blocking`, takže blokovať tu smieme.
    tauri::async_runtime::block_on(async move {
        let client = reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(10)).build().ok()?;
        let response = client.get(url).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_owned();
        let bytes = response.bytes().await.ok()?.to_vec();
        Some((bytes, mime))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_fetch_may_block_on_a_runtime_blocking_thread() {
        // Ako v aplikácii: server beží na runtime Tauri a assets volá cez `spawn_blocking`.
        let got = tauri::async_runtime::block_on(async {
            tauri::async_runtime::spawn_blocking(|| dev_fetch("http://127.0.0.1:9/remote.html".into())).await
        });
        assert_eq!(got.unwrap(), None);
    }

    #[test]
    fn normalize_host_strips_scheme_and_slash() {
        assert_eq!(normalize_host(" https://pc.tail1.ts.net/ ").as_deref(), Some("pc.tail1.ts.net"));
        assert_eq!(normalize_host("pc.tail1.ts.net").as_deref(), Some("pc.tail1.ts.net"));
        assert_eq!(normalize_host("  "), None);
    }

    #[test]
    fn status_prefers_manual_host_and_needs_running_server_for_pairing() {
        let mut c = Control {
            port: 50000,
            address: "manual.example".into(),
            token: Some("t0k".into()),
            tailnet: Some(Tailnet { host: "pc.tail1.ts.net".into(), serving: true }),
            ..Control::default()
        };
        let s = c.status();
        assert_eq!(s.host.as_deref(), Some("manual.example"));
        assert!(s.serving && !s.running);
        assert_eq!(s.pairing_url, None);
        assert_eq!(s.serve_command, "tailscale serve --bg 50000");
        c.address.clear();
        assert_eq!(c.status().host.as_deref(), Some("pc.tail1.ts.net"));
        let json = serde_json::to_value(c.status()).unwrap();
        assert!(json.get("pairingUrl").is_some() && json.get("serveCommand").is_some());
    }

    #[tokio::test]
    async fn pairing_url_uses_host_and_token() {
        let c = Control {
            server: Some(server::start(server::ServerOpts {
                port: 0,
                token: "t0k".into(),
                allowed_origins: vec![],
                hub: Arc::default(),
                pty: Arc::new(crate::pty::PtyManager::default()),
                assets: Arc::new(|_: &str| None),
                events: Arc::new(|_| {}),
                heartbeat: server::Heartbeat::default(),
            }).await.unwrap()),
            address: "pc.tail1.ts.net".into(),
            token: Some("t0k".into()),
            ..Control::default()
        };
        assert_eq!(c.status().pairing_url.as_deref(), Some("https://pc.tail1.ts.net/remote.html#t=t0k"));
    }

    #[test]
    fn allowed_origins_cover_manual_detected_and_loopback() {
        let c = Control {
            port: 47615,
            address: "https://pc.tail1.ts.net".into(),
            tailnet: Some(Tailnet { host: "pc.tail1.ts.net".into(), serving: false }),
            ..Control::default()
        };
        assert_eq!(c.allowed_origins(), vec![
            "https://pc.tail1.ts.net".to_string(),
            "http://127.0.0.1:47615".into(),
            "http://localhost:47615".into(),
        ]);
    }
}
