//! Loopback HTTP/WebSocket server pre mobilnú stránku.

use std::collections::{BTreeSet, HashMap};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, oneshot, watch};

use super::hub::{Hub, HubEvent};
use super::protocol::{self, ClientMsg, ServerMsg};

/// Vstup do PTY má limit 1 MiB (`pty.inputTooLarge`); väčšia správa je chyba klienta.
const MAX_MESSAGE: usize = 2 * 1024 * 1024;
/// Klient, ktorý toľko nečíta, sa odpojí (po pripojení dostane čerstvú históriu).
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// Zatvárací kód pri zneplatnenom tokene.
const CLOSE_REVOKED: u16 = 4001;

/// PTY operácie, ktoré server potrebuje; `PtyManager` ich implementuje, testy podstrčia falošný.
pub trait RemotePty: Send + Sync {
    fn write(&self, id: &str, data: &str) -> Result<(), String>;
    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String>;
}

impl RemotePty for crate::pty::PtyManager {
    fn write(&self, id: &str, data: &str) -> Result<(), String> {
        crate::pty::PtyManager::write(self, id, data)
    }
    fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        crate::pty::PtyManager::resize(self, id, cols, rows)
    }
}

/// Statický súbor mobilnej stránky podľa cesty (bez úvodného `/`, s prípadným `?query`): obsah a MIME typ.
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
    shutdown: Option<oneshot::Sender<()>>,
    /// Zavrie sa, keď server pustí listener (port je voľný).
    released: Option<oneshot::Receiver<()>>,
}

impl Running {
    /// Skutočný port (aj pri `ServerOpts.port == 0`).
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Zavrie listener aj všetky sockety.
    pub fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }

    /// Ako `stop`, ale počká (najviac 2 s), kým sa port uvoľní, aby nový server na ňom hneď naštartoval.
    pub async fn stop_and_wait(mut self) {
        let released = self.released.take();
        self.stop();
        if let Some(released) = released {
            let _ = tokio::time::timeout(Duration::from_secs(2), released).await;
        }
    }
}

/// Listener, ktorého zahodenie oznámi `Running::stop_and_wait`.
struct Tracked {
    inner: TcpListener,
    _released: oneshot::Sender<()>,
}

impl axum::serve::Listener for Tracked {
    type Io = TcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (TcpStream, SocketAddr) {
        axum::serve::Listener::accept(&mut self.inner).await
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.inner.local_addr()
    }
}

#[derive(Default)]
struct Watching {
    clients: HashMap<u64, BTreeSet<String>>,
    last: BTreeSet<String>,
}

struct Shared {
    token: String,
    allowed_origins: Vec<String>,
    hub: Arc<Hub>,
    pty: Arc<dyn RemotePty>,
    assets: Assets,
    events: Events,
    watching: Mutex<Watching>,
    next_client: AtomicU64,
    closing: watch::Receiver<bool>,
}

impl Shared {
    /// Zjednotenie odberov všetkých klientov; desktop dostane `Watching` pri každej zmene.
    fn set_watching(&self, client: u64, ids: Option<&BTreeSet<String>>) {
        let mut w = self.watching.lock().unwrap_or_else(|e| e.into_inner());
        match ids {
            Some(ids) => w.clients.insert(client, ids.clone()),
            None => w.clients.remove(&client),
        };
        let union: BTreeSet<String> = w.clients.values().flatten().cloned().collect();
        if union != w.last {
            w.last = union.clone();
            // Pod zámkom, aby desktop dostal zmeny v správnom poradí.
            (self.events)(RemoteEvent::Watching { ids: union.into_iter().collect() });
        }
    }
}

/// Chyby: `remote.portInUse: <detail>`, `remote.startFailed: <detail>`.
pub async fn start(opts: ServerOpts) -> Result<Running, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, opts.port)).await.map_err(|e| match e.kind() {
        std::io::ErrorKind::AddrInUse => format!("remote.portInUse: {e}"),
        _ => format!("remote.startFailed: {e}"),
    })?;
    let port = listener.local_addr().map_err(|e| format!("remote.startFailed: {e}"))?.port();
    let (shutdown, stop) = oneshot::channel();
    let (released_tx, released) = oneshot::channel();
    let (closing_tx, closing) = watch::channel(false);
    let shared = Arc::new(Shared {
        token: opts.token,
        allowed_origins: opts.allowed_origins,
        hub: opts.hub,
        pty: opts.pty,
        assets: opts.assets,
        events: opts.events,
        watching: Mutex::default(),
        next_client: AtomicU64::new(0),
        closing,
    });
    let app = Router::new().route("/ws", get(ws)).fallback(asset).with_state(shared);
    let listener = Tracked { inner: listener, _released: released_tx };
    // Zahodený `Running` (bez `stop`) server tiež zastaví.
    let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
        let _ = stop.await;
        let _ = closing_tx.send(true);
    });
    tokio::spawn(async move {
        let _ = serve.await;
    });
    Ok(Running { port, shutdown: Some(shutdown), released: Some(released) })
}

/// Statické súbory bez tokenu (neobsahujú dáta); cesta nikdy nevedie na disk.
async fn asset(State(s): State<Arc<Shared>>, method: Method, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let lower = path.to_ascii_lowercase();
    let suspicious = path.is_empty()
        || path.contains('\\')
        || path.split('/').any(|p| p == ".." || p == ".")
        || ["%2e", "%2f", "%5c"].iter().any(|e| lower.contains(e));
    if method != Method::GET || suspicious {
        return StatusCode::NOT_FOUND.into_response();
    }
    let key = match uri.query() {
        Some(q) => format!("{path}?{q}"),
        None => path.to_owned(),
    };
    let assets = s.assets.clone();
    match tokio::task::spawn_blocking(move || assets(&key)).await {
        Ok(Some((bytes, mime))) => (
            [
                (header::CONTENT_TYPE, mime),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
                (header::CACHE_CONTROL, "no-cache".to_owned()),
            ],
            bytes,
        )
            .into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Token aj `Origin` sa overia ešte pred upgrade; odpoveď nesie subprotokol `pd.v1`.
async fn ws(
    State(s): State<Arc<Shared>>,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let protocols = headers
        .get_all(header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect::<Vec<_>>()
        .join(",");
    let versioned = protocols.split(',').any(|p| p.trim() == protocol::PROTOCOL);
    let token = protocol::token_from_protocols(&protocols);
    if !versioned || !token.is_some_and(|t| protocol::tokens_equal(t, &s.token)) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if !origin.is_some_and(|o| protocol::origin_allowed(o, &s.allowed_origins)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match upgrade {
        Ok(upgrade) => upgrade
            .protocols([protocol::PROTOCOL])
            .max_message_size(MAX_MESSAGE)
            .on_upgrade(move |socket| async move {
                let rx = s.hub.subscribe();
                let closing = s.closing.clone();
                let id = s.next_client.fetch_add(1, Ordering::Relaxed);
                let mut conn = Conn { s, id, socket, rx, closing, subs: BTreeSet::new(), sizes: HashMap::new() };
                let end = conn.run().await;
                conn.finish(end).await;
            }),
        Err(rejection) => rejection.into_response(),
    }
}

enum Next {
    Client(Option<Result<Message, axum::Error>>),
    Hub(Result<HubEvent, broadcast::error::RecvError>),
    Closing,
}

/// Prečo sa spojenie skončilo.
#[derive(PartialEq)]
enum End {
    Closed,
    Revoked,
}

struct Conn {
    s: Arc<Shared>,
    id: u64,
    socket: WebSocket,
    rx: broadcast::Receiver<HubEvent>,
    closing: watch::Receiver<bool>,
    subs: BTreeSet<String>,
    /// Posledná veľkosť terminálu klienta pre každú odoberanú session.
    sizes: HashMap<String, (u16, u16)>,
}

impl Conn {
    async fn run(&mut self) -> End {
        if let Some(snapshot) = self.s.hub.snapshot() {
            if !self.send(ServerMsg::Snapshot { snapshot }).await {
                return End::Closed;
            }
        }
        loop {
            let next = tokio::select! {
                m = self.socket.recv() => Next::Client(m),
                e = self.rx.recv() => Next::Hub(e),
                _ = self.closing.wait_for(|c| *c) => Next::Closing,
            };
            let go_on = match next {
                Next::Client(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<ClientMsg>(&text) {
                    Ok(msg) => self.on_client(msg).await,
                    // Neznáma správa (iná verzia stránky) spojenie neukončí.
                    Err(_) => true,
                },
                Next::Client(Some(Ok(Message::Close(_)) | Err(_)) | None) => false,
                Next::Client(Some(Ok(_))) => true,
                Next::Hub(Ok(HubEvent::Revoked)) => return End::Revoked,
                Next::Hub(Ok(event)) => self.forward(event).await,
                Next::Hub(Err(broadcast::error::RecvError::Lagged(_))) => {
                    let all = self.subs.iter().cloned().collect();
                    self.catch_up(all).await
                }
                Next::Hub(Err(broadcast::error::RecvError::Closed)) | Next::Closing => false,
            };
            if !go_on {
                return End::Closed;
            }
        }
    }

    async fn finish(mut self, end: End) {
        self.s.set_watching(self.id, None);
        let frame = (end == End::Revoked).then(|| CloseFrame { code: CLOSE_REVOKED, reason: "revoked".into() });
        let _ = tokio::time::timeout(Duration::from_secs(1), self.socket.send(Message::Close(frame))).await;
    }

    /// `false` = klienta odpojiť (nečíta, zavrel sa alebo server končí).
    async fn send(&mut self, msg: ServerMsg) -> bool {
        let Ok(text) = serde_json::to_string(&msg) else { return true };
        tokio::select! {
            r = self.socket.send(Message::Text(text.into())) => r.is_ok(),
            _ = self.closing.wait_for(|c| *c) => false,
            _ = tokio::time::sleep(SEND_TIMEOUT) => false,
        }
    }

    async fn forward(&mut self, event: HubEvent) -> bool {
        match event {
            HubEvent::Output { id, data } if self.subs.contains(&id) => self.send(ServerMsg::Output { id, data }).await,
            HubEvent::Output { .. } => true,
            HubEvent::Snapshot(snapshot) => self.send(ServerMsg::Snapshot { snapshot }).await,
            HubEvent::Revoked => false,
        }
    }

    /// Mobil si nárokuje veľkosť; `Err(code)`, keď PTY zmenu odmietne.
    fn claim(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let changed = self.s.hub.size().remote(id, cols, rows);
        if !changed {
            return Ok(());
        }
        if let Err(code) = self.s.pty.resize(id, cols, rows) {
            // Ďalší nárok to skúsi znova.
            self.s.hub.size().forget(id);
            return Err(code);
        }
        (self.s.events)(RemoteEvent::SizeTaken { id: id.to_owned() });
        Ok(())
    }

    async fn error(&mut self, id: &str, code: String) -> bool {
        self.send(ServerMsg::Error { id: Some(id.to_owned()), code }).await
    }

    async fn on_client(&mut self, msg: ClientMsg) -> bool {
        match msg {
            ClientMsg::Subscribe { id, cols, rows } => {
                self.sizes.insert(id.clone(), (cols, rows));
                if self.subs.insert(id.clone()) {
                    self.s.set_watching(self.id, Some(&self.subs));
                }
                if let Err(code) = self.claim(&id, cols, rows) {
                    if !self.error(&id, code).await {
                        return false;
                    }
                }
                self.catch_up(vec![id]).await
            }
            ClientMsg::Unsubscribe { id } => {
                self.sizes.remove(&id);
                if self.subs.remove(&id) {
                    self.s.set_watching(self.id, Some(&self.subs));
                }
                true
            }
            ClientMsg::Input { id, data } => {
                // Písanie je aktívne použitie: veľkosť sa vráti mobilu.
                if let Some(&(cols, rows)) = self.sizes.get(&id) {
                    if let Err(code) = self.claim(&id, cols, rows) {
                        if !self.error(&id, code).await {
                            return false;
                        }
                    }
                }
                match self.s.pty.write(&id, &data) {
                    Ok(()) => true,
                    Err(code) => self.error(&id, code).await,
                }
            }
            ClientMsg::Resize { id, cols, rows } => {
                if !self.subs.contains(&id) {
                    return true;
                }
                self.sizes.insert(id.clone(), (cols, rows));
                // Zmena okna mobilu nevezme veľkosť desktopu, len upraví tú svoju.
                let owned = self.s.hub.size().is_remote(&id);
                if owned {
                    if let Err(code) = self.claim(&id, cols, rows) {
                        return self.error(&id, code).await;
                    }
                }
                true
            }
        }
    }

    /// Pošle zmeškané udalosti a čerstvú históriu `ids`; pri pretečení frontu históriu všetkých odberov.
    async fn catch_up(&mut self, ids: Vec<String>) -> bool {
        let mut c = self.s.hub.catch_up(&mut self.rx, &ids);
        if c.lagged && ids.len() < self.subs.len() {
            // Výstup iných odberov sa stratil; ich staré udalosti nahradí história.
            let all: Vec<String> = self.subs.iter().cloned().collect();
            let again = self.s.hub.catch_up(&mut self.rx, &all);
            c.missed.retain(|e| !matches!(e, HubEvent::Output { .. }));
            c.missed.extend(again.missed);
            c.history = again.history;
        }
        for event in c.missed {
            if !self.forward(event).await {
                return false;
            }
        }
        for (id, data) in c.history {
            if !self.send(ServerMsg::History { id, data }).await {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    use futures_util::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::{self, Message as WsMessage};

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";
    const ORIGIN: &str = "https://pc.tail1.ts.net";

    type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    #[derive(Default)]
    struct FakePty {
        writes: Mutex<Vec<(String, String)>>,
        resizes: Mutex<Vec<(String, u16, u16)>>,
    }

    impl RemotePty for FakePty {
        fn write(&self, id: &str, data: &str) -> Result<(), String> {
            if id == "missing" { return Err("pty.notRunning".into()); }
            self.writes.lock().unwrap().push((id.into(), data.into()));
            Ok(())
        }
        fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
            self.resizes.lock().unwrap().push((id.into(), cols, rows));
            Ok(())
        }
    }

    struct Harness {
        running: Running,
        hub: Arc<Hub>,
        pty: Arc<FakePty>,
        events: mpsc::UnboundedReceiver<RemoteEvent>,
    }

    async fn harness() -> Harness {
        let hub = Arc::new(Hub::default());
        hub.set_enabled(true);
        let pty = Arc::new(FakePty::default());
        let (tx, events) = mpsc::unbounded_channel();
        let running = start(ServerOpts {
            port: 0,
            token: TOKEN.into(),
            allowed_origins: vec![ORIGIN.into()],
            hub: hub.clone(),
            pty: pty.clone(),
            assets: Arc::new(|path: &str| (path == "remote.html").then(|| (b"<html>".to_vec(), "text/html".into()))),
            events: Arc::new(move |e| { let _ = tx.send(e); }),
        }).await.unwrap();
        Harness { running, hub, pty, events }
    }

    fn request(port: u16, protocols: &str, origin: &str) -> tungstenite::handshake::client::Request {
        let mut req = format!("ws://127.0.0.1:{port}/ws").into_client_request().unwrap();
        req.headers_mut().insert("Sec-WebSocket-Protocol", protocols.parse().unwrap());
        req.headers_mut().insert("Origin", origin.parse().unwrap());
        req
    }

    async fn connect(h: &Harness) -> Ws {
        let (ws, resp) = tokio_tungstenite::connect_async(request(h.running.port(), &format!("pd.v1, auth.{TOKEN}"), ORIGIN)).await.unwrap();
        assert_eq!(resp.headers().get("Sec-WebSocket-Protocol").unwrap(), "pd.v1");
        ws
    }

    async fn rejected(h: &Harness, protocols: &str, origin: &str) -> u16 {
        match tokio_tungstenite::connect_async(request(h.running.port(), protocols, origin)).await {
            Err(tungstenite::Error::Http(resp)) => resp.status().as_u16(),
            other => panic!("expected HTTP rejection, got {:?}", other.map(|_| ())),
        }
    }

    async fn send(ws: &mut Ws, msg: Value) {
        ws.send(WsMessage::Text(msg.to_string().into())).await.unwrap();
    }

    /// Ďalšia JSON správa; `None` = socket sa zavrel.
    async fn next(ws: &mut Ws) -> Option<Value> {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("timeout") {
                Some(Ok(WsMessage::Text(t))) => return Some(serde_json::from_str(&t).unwrap()),
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => return None,
                Some(Ok(_)) => {}
            }
        }
    }

    async fn event(h: &mut Harness, wanted: impl Fn(&RemoteEvent) -> bool) -> RemoteEvent {
        loop {
            let e = tokio::time::timeout(Duration::from_secs(5), h.events.recv()).await.expect("timeout").unwrap();
            if wanted(&e) { return e; }
        }
    }

    async fn http_get(port: u16, path: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn ws_without_token_is_rejected() {
        let h = harness().await;
        assert_eq!(rejected(&h, "pd.v1", ORIGIN).await, 401);
        assert_eq!(rejected(&h, "pd.v1, auth.wrong", ORIGIN).await, 401);
        assert_eq!(rejected(&h, &format!("auth.{TOKEN}"), ORIGIN).await, 401);
    }

    #[tokio::test]
    async fn ws_with_foreign_origin_is_rejected() {
        let h = harness().await;
        assert_eq!(rejected(&h, &format!("pd.v1, auth.{TOKEN}"), "https://evil.example").await, 403);
    }

    #[tokio::test]
    async fn subscribe_sends_history_then_live_output() {
        let h = harness().await;
        h.hub.publish_snapshot(json!({"projects": []}));
        h.hub.output("s", "old");
        let mut ws = connect(&h).await;
        assert_eq!(next(&mut ws).await.unwrap(), json!({"type": "snapshot", "snapshot": {"projects": []}}));
        send(&mut ws, json!({"type": "subscribe", "id": "s", "cols": 40, "rows": 20})).await;
        assert_eq!(next(&mut ws).await.unwrap(), json!({"type": "history", "id": "s", "data": "old"}));
        h.hub.output("t", "other");
        h.hub.output("s", "new");
        assert_eq!(next(&mut ws).await.unwrap(), json!({"type": "output", "id": "s", "data": "new"}));
    }

    #[tokio::test]
    async fn subscribe_claims_size_and_emits_size_taken() {
        let mut h = harness().await;
        let mut ws = connect(&h).await;
        send(&mut ws, json!({"type": "subscribe", "id": "s", "cols": 40, "rows": 20})).await;
        assert_eq!(next(&mut ws).await.unwrap()["type"], "history");
        assert_eq!(event(&mut h, |e| matches!(e, RemoteEvent::SizeTaken { .. })).await, RemoteEvent::SizeTaken { id: "s".into() });
        assert_eq!(*h.pty.resizes.lock().unwrap(), vec![("s".to_string(), 40, 20)]);
        // Desktop si veľkosť vzal späť; písanie z mobilu ju získa znova.
        h.hub.size().desktop("s");
        send(&mut ws, json!({"type": "input", "id": "s", "data": "x"})).await;
        assert_eq!(event(&mut h, |e| matches!(e, RemoteEvent::SizeTaken { .. })).await, RemoteEvent::SizeTaken { id: "s".into() });
        assert_eq!(h.pty.resizes.lock().unwrap().len(), 2);
        assert_eq!(*h.pty.writes.lock().unwrap(), vec![("s".to_string(), "x".to_string())]);
    }

    #[tokio::test]
    async fn input_to_missing_session_returns_error() {
        let h = harness().await;
        let mut ws = connect(&h).await;
        send(&mut ws, json!({"type": "input", "id": "missing", "data": "x"})).await;
        assert_eq!(next(&mut ws).await.unwrap(), json!({"type": "error", "id": "missing", "code": "pty.notRunning"}));
    }

    #[tokio::test]
    async fn dropped_client_releases_subscription() {
        let mut h = harness().await;
        let mut ws = connect(&h).await;
        send(&mut ws, json!({"type": "subscribe", "id": "s", "cols": 40, "rows": 20})).await;
        assert_eq!(event(&mut h, |e| matches!(e, RemoteEvent::Watching { .. })).await, RemoteEvent::Watching { ids: vec!["s".into()] });
        ws.close(None).await.unwrap();
        drop(ws);
        assert_eq!(event(&mut h, |e| matches!(e, RemoteEvent::Watching { .. })).await, RemoteEvent::Watching { ids: vec![] });
    }

    #[tokio::test]
    async fn lagged_client_gets_fresh_history() {
        let h = harness().await;
        let mut ws = connect(&h).await;
        send(&mut ws, json!({"type": "subscribe", "id": "s", "cols": 40, "rows": 20})).await;
        assert_eq!(next(&mut ws).await.unwrap()["type"], "history");
        // Jednovláknový runtime: server sa k frontu dostane až po celom cykle.
        for i in 0..crate::remote::hub::BROADCAST_CAPACITY * 2 {
            h.hub.output("s", &format!("{i}\n"));
        }
        let fresh = loop {
            let msg = next(&mut ws).await.expect("socket closed");
            if msg["type"] == "history" { break msg; }
        };
        assert_eq!(fresh["data"], h.hub.history("s").unwrap());
    }

    #[tokio::test]
    async fn new_token_closes_existing_sockets() {
        let h = harness().await;
        let mut ws = connect(&h).await;
        h.hub.revoke();
        assert_eq!(next(&mut ws).await, None);
    }

    #[tokio::test]
    async fn stop_closes_sockets_and_frees_port() {
        let h = harness().await;
        let port = h.running.port();
        let mut ws = connect(&h).await;
        h.running.stop_and_wait().await;
        assert_eq!(next(&mut ws).await, None);
        std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    }

    #[tokio::test]
    async fn configure_on_busy_port_reports_port_in_use() {
        let busy = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = busy.local_addr().unwrap().port();
        let err = start(ServerOpts {
            port,
            token: TOKEN.into(),
            allowed_origins: vec![],
            hub: Arc::default(),
            pty: Arc::new(FakePty::default()),
            assets: Arc::new(|_: &str| None),
            events: Arc::new(|_| {}),
        }).await.err().unwrap();
        assert!(err.starts_with("remote.portInUse"), "{err}");
    }

    #[tokio::test]
    async fn unknown_path_is_404() {
        let h = harness().await;
        let port = h.running.port();
        assert!(http_get(port, "/nope").await.starts_with("HTTP/1.1 404"));
        assert!(http_get(port, "/../state.json").await.starts_with("HTTP/1.1 404"));
        let page = http_get(port, "/remote.html").await;
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        assert!(page.ends_with("<html>"));
    }
}
