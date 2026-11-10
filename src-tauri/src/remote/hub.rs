//! Spojka medzi PTY čítačmi a vzdialeným serverom: história, broadcast, snímok, veľkosť.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, MutexGuard};

use tokio::sync::broadcast;

use super::history::History;
use super::size::SizeArbiter;

pub const BROADCAST_CAPACITY: usize = 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum HubEvent {
    Output { id: String, data: String },
    Snapshot(serde_json::Value),
    /// Párovací kód sa zmenil: server zavrie všetky sockety.
    Revoked,
}

/// Súkromné polia môže implementácia zmeniť; verejné metódy nie.
pub struct Hub {
    enabled: AtomicBool,
    histories: Mutex<HashMap<String, History>>,
    sender: broadcast::Sender<HubEvent>,
    snapshot: Mutex<Option<serde_json::Value>>,
    size: Mutex<SizeArbiter>,
}

impl Default for Hub {
    fn default() -> Self {
        todo!()
    }
}

impl Hub {
    /// Vypnutie zmaže všetku históriu.
    pub fn set_enabled(&self, on: bool) {
        todo!()
    }

    /// Volá PTY čítač pred desktopovým backpressure; pri vypnutej funkcii nerobí nič.
    pub fn output(&self, id: &str, text: &str) {
        todo!()
    }

    pub fn forget(&self, id: &str) {
        todo!()
    }

    pub fn history(&self, id: &str) -> Option<String> {
        todo!()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HubEvent> {
        todo!()
    }

    pub fn publish_snapshot(&self, v: serde_json::Value) {
        todo!()
    }

    pub fn snapshot(&self) -> Option<serde_json::Value> {
        todo!()
    }

    pub fn size(&self) -> MutexGuard<'_, SizeArbiter> {
        todo!()
    }

    /// Pošle `HubEvent::Revoked`.
    pub fn revoke(&self) {
        todo!()
    }
}
