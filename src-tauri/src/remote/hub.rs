//! Spojka medzi PTY čítačmi a vzdialeným serverom: história, broadcast, snímok, veľkosť.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use tokio::sync::broadcast;

use super::chat::ChatSource;
use super::history::{History, HISTORY_BYTES};
use super::size::SizeArbiter;

pub const BROADCAST_CAPACITY: usize = 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum HubEvent {
    Output { id: String, data: String },
    Snapshot(serde_json::Value),
    /// Session dostala nový proces (Spustiť znova): mobil, ktorý ju sleduje, si vezme veľkosť a začne odznova.
    Started { id: String },
    /// Párovací kód sa zmenil: server zavrie všetky sockety.
    Revoked,
}

/// Jeden beh procesu session: výstup staršieho behu (dobiehajúci čítač po reštarte)
/// sa do histórie nového nesmie dostať.
struct Run {
    generation: u64,
    history: Option<History>,
}

/// Súkromné polia môže implementácia zmeniť; verejné metódy nie.
pub struct Hub {
    enabled: AtomicBool,
    histories: Mutex<HashMap<String, Run>>,
    next_generation: AtomicU64,
    sender: broadcast::Sender<HubEvent>,
    snapshot: Mutex<Option<serde_json::Value>>,
    size: Mutex<SizeArbiter>,
    /// Odkiaľ číta chat každá session; len pre server, mobilu sa neposiela.
    chat_sources: Mutex<HashMap<String, ChatSource>>,
}

impl Default for Hub {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            histories: Mutex::default(),
            next_generation: AtomicU64::new(0),
            sender: broadcast::channel(BROADCAST_CAPACITY).0,
            snapshot: Mutex::default(),
            size: Mutex::default(),
            chat_sources: Mutex::default(),
        }
    }
}

/// Výsledok `catch_up`: čo klient zmeškal a čerstvá história.
pub struct CatchUp {
    /// Udalosti z frontu, ktoré nie sú pokryté vrátenou históriou.
    pub missed: Vec<HubEvent>,
    /// Front pretiekol aj počas vyprázdňovania.
    pub lagged: bool,
    pub history: Vec<(String, String)>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Hub {
    /// Vypnutie zmaže všetku históriu.
    pub fn set_enabled(&self, on: bool) {
        // Pod zámkom histórie, aby súbežný `output` nezapísal po vymazaní.
        let mut histories = lock(&self.histories);
        self.enabled.store(on, Ordering::SeqCst);
        if !on {
            // Značky behov ostanú: bežiace sessions po opätovnom zapnutí znova zapisujú.
            for run in histories.values_mut() {
                run.history = None;
            }
            *lock(&self.snapshot) = None;
            *lock(&self.size) = SizeArbiter::default();
            lock(&self.chat_sources).clear();
        }
    }

    /// Volá PTY čítač pred desktopovým backpressure; pri vypnutej funkcii nerobí nič.
    /// `generation` je hodnota z `started` pre tento beh; výstup iného behu sa zahodí.
    pub fn output(&self, id: &str, generation: u64, text: &str) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let mut histories = lock(&self.histories);
        if !self.enabled.load(Ordering::SeqCst) {
            return;
        }
        let Some(run) = histories.get_mut(id).filter(|run| run.generation == generation) else {
            return;
        };
        run.history.get_or_insert_with(|| History::new(HISTORY_BYTES)).push(text);
        // Broadcast nikdy neblokuje; posielame pod zámkom, aby `catch_up` videl históriu a front v zhode.
        let _ = self.sender.send(HubEvent::Output { id: id.to_owned(), data: text.to_owned() });
    }

    /// Volá PTY pred prvým výstupom nového procesu; stará história ani nárok na veľkosť neplatia.
    /// Vráti generáciu behu, ktorú čítač posiela s každým výstupom.
    pub fn started(&self, id: &str) -> u64 {
        let mut histories = lock(&self.histories);
        let generation = self.next_generation.fetch_add(1, Ordering::SeqCst) + 1;
        histories.insert(id.to_owned(), Run { generation, history: None });
        lock(&self.size).forget(id);
        if self.enabled.load(Ordering::SeqCst) {
            let _ = self.sender.send(HubEvent::Started { id: id.to_owned() });
        }
        generation
    }

    /// Zabudne beh `generation`; novší beh tej istej session ostane.
    pub fn forget(&self, id: &str, generation: u64) {
        let mut histories = lock(&self.histories);
        if histories.get(id).is_some_and(|run| run.generation == generation) {
            histories.remove(id);
            lock(&self.size).forget(id);
        }
    }

    // Server číta históriu cez `catch_up`; toto ostáva pre testy.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn history(&self, id: &str) -> Option<String> {
        lock(&self.histories).get(id).and_then(|run| run.history.as_ref()).map(History::replay)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<HubEvent> {
        self.sender.subscribe()
    }

    pub fn publish_snapshot(&self, v: serde_json::Value) {
        if !self.enabled.load(Ordering::SeqCst) {
            return;
        }
        *lock(&self.snapshot) = Some(v.clone());
        let _ = self.sender.send(HubEvent::Snapshot(v));
    }

    pub fn set_chat_sources(&self, sources: HashMap<String, ChatSource>) {
        if self.enabled.load(Ordering::SeqCst) {
            *lock(&self.chat_sources) = sources;
        }
    }

    pub fn chat_source(&self, id: &str) -> Option<ChatSource> {
        lock(&self.chat_sources).get(id).cloned()
    }

    pub fn snapshot(&self) -> Option<serde_json::Value> {
        lock(&self.snapshot).clone()
    }

    pub fn size(&self) -> MutexGuard<'_, SizeArbiter> {
        lock(&self.size)
    }

    /// Pošle `HubEvent::Revoked`.
    pub fn revoke(&self) {
        let _ = self.sender.send(HubEvent::Revoked);
    }

    /// Vyprázdni `rx` a prečíta históriu `ids` naraz pod zámkom histórie, takže výstup
    /// sa klientovi nepošle dvakrát (v histórii aj ako zmeškaná udalosť) ani nestratí.
    pub fn catch_up(&self, rx: &mut broadcast::Receiver<HubEvent>, ids: &[String]) -> CatchUp {
        let histories = lock(&self.histories);
        let mut missed = Vec::new();
        let mut lagged = false;
        loop {
            match rx.try_recv() {
                Ok(HubEvent::Output { id, .. }) if ids.contains(&id) => {}
                Ok(event) => missed.push(event),
                Err(broadcast::error::TryRecvError::Lagged(_)) => lagged = true,
                Err(_) => break,
            }
        }
        let history = ids
            .iter()
            .map(|id| {
                let history = histories.get(id).and_then(|run| run.history.as_ref());
                (id.clone(), history.map(History::replay).unwrap_or_default())
            })
            .collect();
        CatchUp { missed, lagged, history }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled() -> Hub {
        let hub = Hub::default();
        hub.set_enabled(true);
        hub
    }

    #[test]
    fn disabled_hub_records_nothing() {
        let hub = Hub::default();
        let s = hub.started("s");
        let mut rx = hub.subscribe();
        hub.output("s", s, "x");
        assert_eq!(hub.history("s"), None);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn enabled_hub_records_and_broadcasts() {
        let hub = enabled();
        let s = hub.started("s");
        let mut rx = hub.subscribe();
        hub.output("s", s, "x");
        assert_eq!(hub.history("s").as_deref(), Some("x"));
        assert_eq!(rx.try_recv().unwrap(), HubEvent::Output { id: "s".into(), data: "x".into() });
    }

    #[test]
    fn started_resets_history_and_size_and_broadcasts() {
        let hub = enabled();
        let s = hub.started("s");
        hub.output("s", s, "old");
        hub.size().remote("s", 40, 20);
        let mut rx = hub.subscribe();
        hub.started("s");
        assert_eq!(hub.history("s"), None);
        assert!(hub.size().remote("s", 40, 20));
        assert_eq!(rx.try_recv().unwrap(), HubEvent::Started { id: "s".into() });
    }

    #[test]
    fn hub_forget_drops_history() {
        let hub = enabled();
        let s = hub.started("s");
        hub.output("s", s, "x");
        hub.forget("s", s);
        assert_eq!(hub.history("s"), None);
    }

    #[test]
    fn disable_clears_history() {
        let hub = enabled();
        let s = hub.started("s");
        hub.output("s", s, "x");
        hub.set_enabled(false);
        assert_eq!(hub.history("s"), None);
        hub.set_enabled(true);
        assert_eq!(hub.history("s"), None);
    }

    #[test]
    fn catch_up_skips_output_already_in_history() {
        let hub = enabled();
        let (s, t) = (hub.started("s"), hub.started("t"));
        let mut rx = hub.subscribe();
        hub.output("s", s, "a");
        hub.output("t", t, "b");
        hub.publish_snapshot(serde_json::json!({"n": 1}));
        let c = hub.catch_up(&mut rx, &["s".to_string()]);
        assert_eq!(c.history, vec![("s".to_string(), "a".to_string())]);
        assert_eq!(c.missed, vec![
            HubEvent::Output { id: "t".into(), data: "b".into() },
            HubEvent::Snapshot(serde_json::json!({"n": 1})),
        ]);
        assert!(!c.lagged);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn output_of_an_earlier_run_never_reaches_the_new_history() {
        let hub = enabled();
        let old = hub.started("s");
        hub.output("s", old, "old");
        let new = hub.started("s");
        let mut rx = hub.subscribe();
        hub.output("s", old, "late");
        assert_eq!(hub.history("s"), None);
        assert!(rx.try_recv().is_err());
        hub.forget("s", old);
        hub.output("s", new, "new");
        assert_eq!(hub.history("s").as_deref(), Some("new"));
    }

    #[test]
    fn output_after_forget_does_not_recreate_history() {
        let hub = enabled();
        let g = hub.started("s");
        hub.forget("s", g);
        hub.output("s", g, "flushed after exit");
        assert_eq!(hub.history("s"), None);
    }

    #[test]
    fn running_sessions_record_again_after_re_enabling() {
        let hub = enabled();
        let g = hub.started("s");
        hub.set_enabled(false);
        hub.set_enabled(true);
        hub.output("s", g, "x");
        assert_eq!(hub.history("s").as_deref(), Some("x"));
        assert!(hub.started("s") > g);
    }
}
