//! Loopback HTTP/WebSocket server pre mobilnú stránku.

use std::sync::Arc;

use super::hub::Hub;

/// PTY operácie, ktoré server potrebuje; `PtyManager` ich implementuje, testy podstrčia falošný.
pub trait RemotePty: Send + Sync {
    fn write(&self, id: &str, data: &str) -> Result<(), String>;
    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String>;
}

/// Statický súbor mobilnej stránky podľa cesty (bez úvodného `/`): obsah a MIME typ.
pub type Assets = Arc<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>;

/// Udalosti pre desktop: `remote-watching` `{ ids }` a `remote-size` `{ id }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteEvent {
    Watching { ids: Vec<String> },
    SizeTaken { id: String },
}

pub type Events = Arc<dyn Fn(RemoteEvent) + Send + Sync>;

pub struct ServerOpts {
    /// 0 = ľubovoľný voľný port (testy).
    pub port: u16,
    pub token: String,
    pub allowed_origins: Vec<String>,
    pub hub: Arc<Hub>,
    pub pty: Arc<dyn RemotePty>,
    pub assets: Assets,
    pub events: Events,
}

/// Súkromné polia môže implementácia zmeniť; verejné metódy nie.
pub struct Running {
    port: u16,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Running {
    /// Skutočný port (aj pri `ServerOpts.port == 0`).
    pub fn port(&self) -> u16 {
        todo!()
    }

    /// Zavrie listener aj všetky sockety.
    pub fn stop(self) {
        todo!()
    }
}

/// Chyby: `remote.portInUse: <detail>`, `remote.startFailed: <detail>`.
pub async fn start(opts: ServerOpts) -> Result<Running, String> {
    todo!()
}
