# Vzdialené ovládanie z mobilu: plán implementácie

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project Desk sprístupní bežiace sessions (zoznam, stav, živý terminál, vstup) na mobilnej webovej stránke cez loopback server, ktorý sa zvonku sprístupní cez `tailscale serve`.

**Architecture:** Desktopový webview ostáva zdrojom pravdy a publikuje do Rustu zjednodušený snímok stavu. Rust (`src-tauri/src/remote/`) drží `Hub`: kruhovú históriu výstupu na session, ktorú plní PTY čítač, broadcast živého výstupu, arbitráž veľkosti PTY a axum server (statická mobilná stránka a jeden autentifikovaný WebSocket). Mobilná stránka je druhý Vite vstup (`remote.html`, `src/remote/`) s xterm.js.

**Tech Stack:** Rust: axum 0.8 (`ws`), tokio (runtime Tauri), serde. TS: xterm.js, `qrcode-generator`. Tailscale CLI sa iba číta.

**Spec:** `docs/superpowers/specs/2026-11-07-remote-mobile-design.md`

## Global Constraints

- Vypnutá funkcia (`settings.remoteAccess === false`) znamená, že žiadny port nie je otvorený, história sa nezapisuje a správanie je rovnaké ako dnes.
- Server počúva len na `127.0.0.1`. Hook server (`hooks.rs`) sa nemení.
- Token: 32 bajtov náhodných dát (2× `uuid::Uuid::new_v4().simple()`), uložený len v `<app_config_dir>/remote.json` (`{"token": "..."}`), nikdy v `state.json` ani v logu.
- Výstup terminálu sa drží len v pamäti. Na disk sa nezapisuje a neposiela nikam inam než autentifikovanému WebSocket klientovi.
- Vstup z mobilu ide cez `PtyManager::write`, takže platia existujúce limity (`pty.inputTooLarge`, `pty.inputFull`). Text z poľa sa odosiela cez `pasteSequence` a potom `"\r"`, rovnako ako šablóny.
- Žiadna interpolácia do shellu. `tailscale` sa spúšťa cez `std::process::Command` so samostatnými argumentmi.
- Rust chyby majú tvar kódov (`remote.portInUse: <detail>`) a preklady sú v EN/SK/CS pod `err.remote.*`. Všetky nové UI reťazce (desktop aj mobil) sú v troch jazykoch.
- IPC sa na hranici zapisuje v camelCase (`#[serde(rename_all = "camelCase")]`).
- Testovacie dáta sú syntetické, nikdy nie skutočný stav používateľa ani skutočný výstup `tailscale`.
- Predvolené nastavenia: `remoteAccess: false`, `remotePort: 47615`, `remoteAddress: ""`. Povolený rozsah portu je 1024–65535.

## Review Focus

1. **Mobil zaspí alebo stratí signál uprostred streamu.** Server uvoľní odber a PTY čítač ani desktop sa nespomalia. Test: `dropped_client_releases_subscription` (Task 4).
2. **Nový párovací kód, kým je mobil pripojený.** Existujúce spojenie sa okamžite zavrie. Test: `new_token_closes_existing_sockets` (Task 4).
3. **Session sa na desktope zavrie, kým je otvorená na mobile.** Mobil ukáže stav „zastavené“, vstup vráti chybový kód, nič nespadne a história sa zmaže. Testy: `hub_forget_drops_history` (Task 2) a `input_to_missing_session_returns_error` (Task 4).
4. **Veľký výpis výstupu pri pomalom mobile.** Broadcast mobil zahltí a ten potom dostane čerstvú históriu. Desktopový ack tok sa nemení. Test: `lagged_client_gets_fresh_history` (Task 4).
5. **Obsadený port alebo chýbajúci Tailscale.** Nastavenia ukážu zrozumiteľnú chybu a appka beží ďalej. Testy: `configure_on_busy_port_reports_port_in_use` (Task 4) a `detect_without_cli_is_none` (Task 3).

---

### Task 0: Kostra a zmluvy (umožní paralelnú prácu)

Robí ju koordinátor sám pred fázou 1. Uzamkne všetky zdieľané súbory, ktoré by inak paralelní agenti menili naraz. Potom Tasky 1–7 už len dopĺňajú telá. Riadky `mod.rs`, `Cargo.toml`, `package.json`, `vite.config.ts`, `i18n.ts` a `remote.html` v ich `Files:` znamenajú „už existuje z Tasku 0“. Ak tam niečo chýba, smie sa len pridávať na koniec.

**Files:**
- Create: `src-tauri/src/remote/mod.rs` so všetkými modulmi (`history`, `size`, `protocol`, `hub`, `tailscale`, `config`, `server`) a stub súbory s verejnými signatúrami z blokov Interfaces (telá `todo!()`, typy a serde atribúty už finálne)
- Modify: `src-tauri/src/lib.rs` (`mod remote;`)
- Modify: `src-tauri/Cargo.toml` a `Cargo.lock` (závislosti z Tasku 4)
- Create: `src/remote/protocol.ts` (typy, `REMOTE_KEYS` hotové, ostatné funkcie stub s `throw`), `remote.html` (prázdna kostra), `src/remote/main.ts` (prázdny), `src/remote/remote.css`
- Modify: `vite.config.ts` (dva vstupy), `package.json` a `package-lock.json` (`qrcode-generator`)
- Modify: `src/i18n.ts`: všetky kľúče z Taskov 6 a 7 v EN/SK/CS
- Modify: `src/model.ts`: iba typy `RemoteSnapshot` a polia `Settings.remote*` s defaultmi; `remoteSnapshot` ako stub

- [ ] **Step 1:** Vytvor vetvu `feat/remote-mobile` z `master`.
- [ ] **Step 2:** Doplň kostru podľa zoznamu.
- [ ] **Step 3:** Over `npm test`, `npm run build`, `cargo clippy ... -D warnings` (pre stub moduly povoľ `#![allow(dead_code)]` v `remote/mod.rs`, Task 4 ho odstráni) a `cargo test`. Všetko musí prejsť.
- [ ] **Step 4: Commit** `chore(remote): scaffold modules, contracts and translations`

---

### Task 1: Čisté Rust jadro: história, arbitráž veľkosti, protokol

**Files:**
- Create: `src-tauri/src/remote/mod.rs` (zatiaľ len `pub mod history; pub mod size; pub mod protocol;`)
- Create: `src-tauri/src/remote/history.rs`, `src-tauri/src/remote/size.rs`, `src-tauri/src/remote/protocol.rs`
- Modify: `src-tauri/src/lib.rs` (`mod remote;`)

**Interfaces:**
- Produces:
  - `history::History::new(cap: usize) -> History`, `push(&mut self, text: &str)`, `replay(&self) -> String`. Konštanta `history::HISTORY_BYTES: usize = 1024 * 1024`.
  - `size::SizeArbiter::default()`, `remote(&mut self, id: &str, cols: u16, rows: u16) -> bool` (true = treba resize PTY a oznámiť desktopu), `desktop(&mut self, id: &str)`, `forget(&mut self, id: &str)`.
  - `protocol::ClientMsg` (serde, `#[serde(tag = "type", rename_all = "camelCase")]`): `Subscribe { id, cols: u16, rows: u16 }`, `Unsubscribe { id }`, `Input { id, data: String }`, `Resize { id, cols: u16, rows: u16 }`.
  - `protocol::ServerMsg`: `Snapshot { snapshot: serde_json::Value }`, `History { id, data }`, `Output { id, data }`, `Error { id: Option<String>, code: String }`.
  - `protocol::token_from_protocols(header: &str) -> Option<&str>` (hodnota `Sec-WebSocket-Protocol`, napr. `"pd.v1, auth.<token>"`), `protocol::origin_allowed(origin: &str, allowed: &[String]) -> bool`, `protocol::tokens_equal(a: &str, b: &str) -> bool` (porovnanie v konštantnom čase).

- [ ] **Step 1: Napíš padajúce testy**

V `history.rs`:
- `push_within_cap_replays_everything`: cap 100, push `"ab"` a `"cd"`, `replay() == "abcd"`.
- `overflow_drops_oldest_and_resets_terminal`: cap 10, push `"line1\nline2\nline3\n"`. Replay začína `"\x1bc"` (reset terminálu), za ním ide text od prvého `\n` v zachovanej časti a na konci je `"line3\n"`. Dĺžka bez prefixu je najviac 10 bajtov.
- `overflow_never_splits_utf8`: cap 5, push `"ééééé"`. `replay()` je platný UTF-8 a neobsahuje `\u{FFFD}`.

V `size.rs`:
- `first_remote_claim_resizes`: `remote("a",40,20) == true`.
- `same_remote_size_is_noop`: druhý `remote("a",40,20) == false`.
- `desktop_reclaim_then_remote_resizes_again`: `remote`, potom `desktop("a")`, potom `remote("a",40,20) == true`.
- `forget_clears_owner`: `remote`, `forget`, `remote == true`.

V `protocol.rs`:
- `parses_input_message`: `{"type":"input","id":"s1","data":"x"}` → `ClientMsg::Input`.
- `rejects_unknown_type`: `{"type":"kill","id":"s1"}` → chyba pri deserializácii.
- `token_from_protocols_finds_auth_entry`: `"pd.v1, auth.abc"` → `Some("abc")`. `"pd.v1"` → `None`.
- `origin_allowed_exact_match_only`: allowed `["https://pc.tail1.ts.net"]`. Ten istý origin → true. `"https://pc.tail1.ts.net.evil.com"` → false. `"http://pc.tail1.ts.net"` → false.
- `tokens_equal_rejects_prefix`: `tokens_equal("abc","ab") == false`.

- [ ] **Step 2: Spusti testy, musia padnúť**

Run: `cargo test --manifest-path src-tauri/Cargo.toml remote::`
Expected: FAIL (chýbajúce typy).

- [ ] **Step 3: Implementuj**

`History` drží `VecDeque<u8>` alebo `String` s orezaním na hranici znaku. Pri prvom pretečení si nastaví príznak `truncated`. Vtedy `replay()` vráti `"\x1bc"` a za ním text od prvého `\n` v buffri. `SizeArbiter` je `HashMap<String, Owner>`, kde `Owner` je `Desktop` alebo `Remote(cols, rows)`.

- [ ] **Step 4: Spusti testy, musia prejsť**

Run: `cargo test --manifest-path src-tauri/Cargo.toml remote::`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/remote src-tauri/src/lib.rs
git commit -m "feat(remote): add output history, size arbitration and protocol"
```

---

### Task 2: `Hub`: odbočka z PTY výstupu a vlastníctvo veľkosti z desktopu

**Files:**
- Create: `src-tauri/src/remote/hub.rs`
- Modify: `src-tauri/src/pty.rs` (štruktúra `PtyManager`, `spawn` okolo vlákna `pump_output`, `kill`/ukončenie session)
- Modify: `src-tauri/src/lib.rs` (`AppState.remote`, `pty_resize`)

**Interfaces:**
- Consumes: `History`, `SizeArbiter` (Task 1).
- Produces:
  - `hub::Hub` (`Default`, zdieľaný ako `Arc<Hub>`).
  - `set_enabled(&self, on: bool)`. Vypnutie zmaže všetku históriu.
  - `output(&self, id: &str, text: &str)`. Pri vypnutej funkcii nerobí nič. Inak zapíše do histórie a pošle `HubEvent::Output { id, data }` do broadcastu.
  - `forget(&self, id: &str)`: zmaže históriu aj vlastníka veľkosti.
  - `history(&self, id: &str) -> Option<String>`.
  - `subscribe(&self) -> tokio::sync::broadcast::Receiver<HubEvent>` (kapacita 1024).
  - `publish_snapshot(&self, v: serde_json::Value)` a `snapshot(&self) -> Option<serde_json::Value>`. Publikovanie pošle `HubEvent::Snapshot`.
  - `size(&self) -> MutexGuard<SizeArbiter>`.
  - `HubEvent`: `Output { id: String, data: String }`, `Snapshot(serde_json::Value)`, `Revoked`.
  - `PtyManager` dostane pole `remote: Arc<Hub>` a konštruktor `PtyManager::with_remote(hub: Arc<Hub>) -> PtyManager`. `Default` ostáva kvôli existujúcim testom.

- [ ] **Step 1: Napíš padajúce testy**

V `hub.rs`:
- `disabled_hub_records_nothing`: `output("s","x")`, potom `history("s") == None`.
- `enabled_hub_records_and_broadcasts`: zapnutý hub, `rx = subscribe()`, `output("s","x")`. Potom `history("s") == Some("x")` a `rx.try_recv()` je `Output{id:"s",data:"x"}`.
- `hub_forget_drops_history`: zapnutý hub, `output` a potom `forget("s")`. `history("s") == None`.
- `disable_clears_history`.

V `pty.rs` (vedľa existujúcich testov): `remote_tap_sees_output`. Vytvor `PtyManager::with_remote` so zapnutým hubom, spusti shell príkaz, ktorý vypíše `remote-ok` (rovnaký spôsob spawnu ako existujúci test na riadku ~545), a over, že `history(id)` obsahuje `remote-ok`.

- [ ] **Step 2: Spusti testy, musia padnúť**

Run: `cargo test --manifest-path src-tauri/Cargo.toml hub:: remote_tap`
Expected: FAIL

- [ ] **Step 3: Implementuj**

V `spawn` daj do vlákna čítača klon `remote` a `req.id`. Vo `pump_output` zavolaj `remote.output(&id, &text)` **pred** `flow.reserve`, aby mobil nečakal na desktopový ack. Pri ukončení procesu (vlákno `child.wait`) zavolaj `remote.forget(&id)` až po odoslaní `pty-exit`. `lib.rs::pty_resize` po úspešnom resize zavolá `state.remote.size().desktop(&id)`. V `setup` vytvor `Arc<Hub>`, odovzdaj ho do `PtyManager::with_remote` a ulož ho aj do `AppState.remote`.

- [ ] **Step 4: Spusti testy, musia prejsť**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (aj všetky existujúce PTY testy)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(remote): tap PTY output into an in-memory remote hub"
```

---

### Task 3: Čítanie Tailscale adresy

**Files:**
- Create: `src-tauri/src/remote/tailscale.rs`

**Interfaces:**
- Produces:
  - `pub struct Tailnet { pub host: String, pub serving: bool }`.
  - `pub fn parse_status(json: &str) -> Option<String>`: vráti `Self.DNSName` bez koncovej bodky (`"pc.tail1.ts.net."` → `"pc.tail1.ts.net"`).
  - `pub fn parse_serving(json: &str, port: u16) -> bool`: true, ak niektorý handler v `serve status --json` proxuje na `http://127.0.0.1:{port}` alebo `http://localhost:{port}`.
  - `pub fn detect(port: u16) -> Option<Tailnet>`: spúšťa `tailscale status --json` a `tailscale serve status --json`. Na Windows skúsi aj `C:\Program Files\Tailscale\tailscale.exe`. Timeout je 3 s a pri chybe vráti `None`.

- [ ] **Step 1: Napíš padajúce testy** so syntetickým JSON:
  - `parse_status_strips_trailing_dot`
  - `parse_status_missing_self_is_none`
  - `parse_serving_matches_our_port`: handler `{"Proxy":"http://127.0.0.1:47615"}` pri porte 47615 → true, pri porte 1234 → false.
  - `detect_without_cli_is_none`: zavolaj vnútornú `detect_with(program: &Path, port)` s neexistujúcou cestou → `None`.
- [ ] **Step 2: Spusti, musia padnúť.** `cargo test --manifest-path src-tauri/Cargo.toml tailscale::`
- [ ] **Step 3: Implementuj** podľa signatúr. Pre testy oddeľ `detect_with(program, port)`.
- [ ] **Step 4: Spusti, musia prejsť.**
- [ ] **Step 5: Commit** `feat(remote): read the tailnet address from the Tailscale CLI`

---

### Task 4: Server, konfigurácia a príkazy

**Files:**
- Create: `src-tauri/src/remote/server.rs`, `src-tauri/src/remote/config.rs`
- Modify: `src-tauri/Cargo.toml` (`axum = { version = "0.8", features = ["ws"] }`, `tokio = { version = "1", features = ["net", "sync", "time", "macros", "rt-multi-thread"] }`; dev: `tokio-tungstenite = "0.29"`, `futures-util = "0.3"`)
- Modify: `src-tauri/src/lib.rs` (registrácia príkazov, `AppState.remote_server: Mutex<Option<server::Running>>`)

**Interfaces:**
- Consumes: `Hub` (Task 2), `protocol` (Task 1), `tailscale::detect` (Task 3), `PtyManager::write`/`resize`.
- Produces:
  - `config::load_or_create_token(dir: &Path) -> io::Result<String>` a `config::new_token(dir: &Path) -> io::Result<String>`, oba nad `remote.json`.
  - `server::start(opts: ServerOpts) -> Result<Running, String>`, kde `ServerOpts { port: u16, token: String, allowed_origins: Vec<String>, hub: Arc<Hub>, pty: PtyManager-handle, assets: Arc<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>, events: Arc<dyn Fn(RemoteEvent) + Send + Sync> }`. `Running::stop(self)` zavrie listener aj všetky sockety. `Running::port() -> u16`.
  - `RemoteEvent` pre desktop: `Watching { ids: Vec<String> }` (emit `remote-watching`, payload `{ ids }`) a `SizeTaken { id: String }` (emit `remote-size`, payload `{ id }`).
  - Tauri príkazy:
    - `remote_configure(enabled: bool, port: u16, address: String) -> Result<RemoteStatus, String>`
    - `remote_status() -> RemoteStatus`
    - `remote_new_token() -> Result<RemoteStatus, String>` (rotácia tokenu pošle `HubEvent::Revoked`, takže sa zavrú všetky sockety)
    - `remote_publish(snapshot: serde_json::Value)`
  - `RemoteStatus { running: bool, port: u16, host: Option<String>, serving: bool, pairingUrl: Option<String>, serveCommand: String }`. `pairingUrl` = `https://{host}/remote.html#t={token}`, kde `host` je ručne zadaná adresa, inak zistená. `serveCommand` = `tailscale serve --bg {port}`.
  - Chybové kódy: `remote.portInUse: <detail>`, `remote.badPort`, `remote.startFailed: <detail>`.

Správanie servera:
- `GET /remote.html` a ďalšie statické cesty idú cez `assets`, bez tokenu, lebo neobsahujú dáta. Iné cesty vrátia 404 a server nikdy nečíta z disku.
- `GET /ws` vyžaduje `Sec-WebSocket-Protocol` s `pd.v1` a `auth.<token>` a `Origin` z `allowed_origins`. Inak vráti 401/403 ešte pred upgrade. Server odpovie protokolom `pd.v1`.
- `allowed_origins` = `https://{host}` (zistený aj ručne zadaný) a `http://127.0.0.1:{port}` + `http://localhost:{port}` (lokálny test).
- Po pripojení server pošle `Snapshot`, ak existuje. `Subscribe` zaradí id do odberov klienta, zavolá `hub.size().remote(...)` a pri `true` aj `pty.resize` a `SizeTaken`. Potom pošle `History` a ďalej len `Output` pre odoberané id. `Input` najprv urobí ten istý nárok na veľkosť s poslednou veľkosťou klienta, potom `pty.write`. Chyba vráti `Error { id, code }`. Pri `Lagged` sa každé odoberané id pošle znova ako `History`.
- Zjednotenie odberov všetkých klientov sa pri každej zmene vyšle ako `Watching`.
- Assets: v release buildoch `app.asset_resolver().get(path)`. V debug buildoch proxy cez `reqwest` na `http://localhost:1420/{path}`, aby fungoval `npm run app:dev`.

- [ ] **Step 1: Napíš padajúce integračné testy** v `server.rs` (`#[tokio::test]`, server na porte 0, klient `tokio-tungstenite`, falošný PTY handle cez trait `RemotePty { fn write(&self,id,&str)->Result<(),String>; fn resize(&self,id,u16,u16)->Result<(),String>; }`, ktorý `PtyManager` implementuje):
  - `ws_without_token_is_rejected` (HTTP 401)
  - `ws_with_foreign_origin_is_rejected` (403)
  - `subscribe_sends_history_then_live_output`
  - `subscribe_claims_size_and_emits_size_taken`
  - `input_to_missing_session_returns_error`: falošný PTY vráti `pty.notRunning`, klient dostane `Error{code:"pty.notRunning"}`
  - `dropped_client_releases_subscription`: po zavretí klienta príde `Watching{ids:[]}`
  - `lagged_client_gets_fresh_history`: pošli viac než 1024 udalostí bez čítania, potom čítaj a over, že príde `History`
  - `new_token_closes_existing_sockets`: `HubEvent::Revoked` zavrie socket
  - `configure_on_busy_port_reports_port_in_use`: obsaď port `TcpListener`om. `start` vráti chybu, ktorá začína `remote.portInUse`.
  - `unknown_path_is_404`
- [ ] **Step 2: Spusti, musia padnúť.** `cargo test --manifest-path src-tauri/Cargo.toml server::`
- [ ] **Step 3: Implementuj** `config.rs`, `server.rs` a príkazy v `lib.rs`. Server beží na `tauri::async_runtime`. `remote_configure` server zastaví a pri `enabled` ho spustí znova s novými hodnotami. Zavolá aj `hub.set_enabled(enabled)`.
- [ ] **Step 4: Spusti celú Rust sadu:** `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` a `cargo test --manifest-path src-tauri/Cargo.toml`. Predtým `npm run build`. Expected: PASS
- [ ] **Step 5: Commit** `feat(remote): serve an authenticated loopback WebSocket for the phone`

---

### Task 5: Model a protokol na strane TS

**Files:**
- Modify: `src/model.ts` (`Settings`, `DEFAULT_SETTINGS`, `parseState`, nová funkcia)
- Create: `src/remote/protocol.ts`
- Test: `src/model.test.ts`, `src/remote/protocol.test.ts`

**Interfaces:**
- Produces:
  - `Settings.remoteAccess: boolean`, `remotePort: number`, `remoteAddress: string`. Defaulty podľa Global Constraints. `parseState` pri porte mimo 1024–65535 vráti predvolený.
  - `model.ts`: `export interface RemoteSnapshot { language: string; projects: { id: string; name: string }[]; sessions: { id: string; projectId: string; title: string; provider: Provider; status: Status; running: boolean }[] }` a `export function remoteSnapshot(state: PersistedState, statusOf: (id: string) => Status, running: (id: string) => boolean): RemoteSnapshot`. Projekty idú v poradí ako v sidebare (pripnuté hore). Skryté sessions (`hidden`) sa vynechajú.
  - `src/remote/protocol.ts`: typy `ClientMsg`/`ServerMsg` zrkadlia Task 1. `export const REMOTE_KEYS: { id: "esc"|"tab"|"up"|"down"|"ctrlC"|"shiftEnter"|"enter"; seq: string }[]` = Esc `"\x1b"`, Tab `"\t"`, ↑ `"\x1b[A"`, ↓ `"\x1b[B"`, Ctrl+C `"\x03"`, Shift+Enter `"\x1b\r"`, Enter `"\r"`. Ďalej `export function parseServerMsg(raw: string): ServerMsg | null` a `export function reconnectDelay(attempt: number): number` (1000 × 2^attempt, najviac 10 000).

- [ ] **Step 1: Napíš padajúce testy**
  - `model.test.ts`: `remote settings default off`, `remote port out of range falls back` (`70000` → `47615`), `remoteSnapshot omits hidden sessions and conversation data` (výsledok nemá kľúče `agentSessionId` ani `exitCode`), `remoteSnapshot keeps pinned projects first`.
  - `protocol.test.ts`: `parseServerMsg rejects unknown type`, `parseServerMsg accepts output`, `reconnectDelay caps at 10s` (`reconnectDelay(10) === 10000`).
- [ ] **Step 2: Spusti, musia padnúť.** `npm test`
- [ ] **Step 3: Implementuj.**
- [ ] **Step 4: Spusti `npm test` a `npm run lint`.** Expected: PASS
- [ ] **Step 5: Commit** `feat(remote): add remote settings, snapshot and protocol helpers`

---

### Task 6: Napojenie desktopu: snímok, videné, veľkosť, nastavenia

**Files:**
- Modify: `src/main.ts` (publikovanie snímku, `isWatched`, udalosti)
- Modify: `src/terminal-runtime.ts` (`Runtime.remoteSized`, návrat veľkosti)
- Modify: `src/settings.ts` (sekcia „Vzdialený prístup“), `src/i18n.ts`, `src/style.css`
- Modify: `package.json` (`qrcode-generator`)
- Test: `src/i18n.test.ts` (existujúci musí prejsť), `src/terminal-lifecycle.test.ts` ak sa dotkne lifecycle

**Interfaces:**
- Consumes: `remoteSnapshot` (Task 5). Príkazy a udalosti z Task 4.
- Produces: `Runtime.remoteSized?: boolean` a `export function reclaimSize(rt: Runtime, id: string): void` v `terminal-runtime.ts`. Ak je nastavené `remoteSized`, zruší ho a zavolá `invoke("pty_resize", { id, cols: rt.term.cols, rows: rt.term.rows })`.

Správanie:
- `remote_publish` volaj z `renderStatusSoon`, len keď `state.settings.remoteAccess`, a nanajvýš raz za 250 ms.
- `remoteWatching = new Set<string>()`. `isWatched(id)` vráti `windowFocused && visibleIds().includes(id) || remoteWatching.has(id)`. Na udalosť `remote-watching` nahraď množinu. Pre každé novo pridané id urob `unread.delete(id)` a `readAttention(state, id)`, potom `save()` (ak sa niečo zmenilo) a `renderSidebar()`.
- Na `remote-size` nastav `runtimes.get(id).remoteSized = true`. `reclaimSize` volaj v `attachCustomKeyEventHandler` pri `keydown`, vo focus handleri `term.textarea` a v `fitTerminal`, ak sa rozmery zmenili.
- Po štarte appky zavolaj `remote_configure` podľa nastavení. Pri uložení nastavení ho zavolaj, len ak sa zmenilo niektoré z polí `remote*`. Chybu ukáž cez `toast(errorText(e))`.
- Sekcia nastavení obsahuje: zaškrtávacie pole, port, adresu (placeholder je zistený `host`), stavový riadok (server beží áno/nie, Tailscale zistený/nenájdený, `serve` aktívny áno/nie), príkaz `serveCommand` s tlačidlom Kopírovať, QR kód a odkaz `pairingUrl` a tlačidlo „Nový párovací kód“ (`remote_new_token`). QR sa renderuje ako SVG cez `qrcode-generator` (`createSvgTag`) a vkladá sa ako DOM, nie ako `innerHTML` z cudzích dát.
- i18n kľúče (EN/SK/CS): `settings.remote`, `settings.remoteEnable`, `settings.remotePort`, `settings.remoteAddress`, `settings.remoteRunning`, `settings.remoteStopped`, `settings.remoteTailscaleMissing`, `settings.remoteServeOff`, `settings.remoteServeOn`, `settings.remoteCopy`, `settings.remoteNewCode`, `settings.remotePairHint`, `err.remote.portInUse`, `err.remote.badPort`, `err.remote.startFailed`.

- [ ] **Step 1: Napíš padajúci test** do `model.test.ts`, ak vznikne čistý pomocník (napr. `newlyWatched(prev: Set<string>, next: string[]): string[]`). Inak sa krok preskočí. i18n test chytí chýbajúce preklady.
- [ ] **Step 2: Implementuj** podľa vyššie.
- [ ] **Step 3: Over** `npm test`, `npm run build` a Rust sadu z Task 4.
- [ ] **Step 4: Ručne v `npm run app:dev`:** zapni prístup v nastaveniach. Stav ukáže „beží“, príkaz a QR. Otvor `http://127.0.0.1:47615/remote.html#t=<token>` v prehliadači na PC (lokálny origin je povolený).
- [ ] **Step 5: Commit** `feat(remote): connect desktop state and settings to remote access`

---

### Task 7: Mobilná stránka

**Files:**
- Create: `remote.html`, `src/remote/main.ts`, `src/remote/remote.css`
- Modify: `vite.config.ts` (`build.rollupOptions.input: { main: "index.html", remote: "remote.html" }`)
- Modify: `src/i18n.ts` (mobilné kľúče `remote.*`)

**Interfaces:**
- Consumes: `REMOTE_KEYS`, `parseServerMsg`, `reconnectDelay` (Task 5). `pasteSequence` a `RemoteSnapshot` z `model.ts`. `t`/jazyk z `i18n.ts` podľa `snapshot.language`.

Správanie:
- Token sa číta z `location.hash` (`#t=`), uloží do `localStorage` (cez try/catch) a hash sa vymaže z URL. Bez tokenu stránka ukáže výzvu „Naskenuj párovací kód v nastaveniach Project Desk“.
- WebSocket `new WebSocket(\`wss://${location.host}/ws\`, ["pd.v1", \`auth.${token}\`])` (pri `http:` sa použije `ws:`). Odpojenie znamená banner „Odpojené, pripájam…“ a opakovanie podľa `reconnectDelay`. Po znovupripojení sa znova odoberá otvorená session.
- **Zoznam:** projekty a pod nimi sessions so stavom (rovnaké štítky `status.*`). Zastavené sú stlmené.
- **Session:** hlavička (späť, projekt / názov, stav), xterm s `disableStdin: true` a `FitAddon`, rovnaká téma ako desktop, `scrollback: 5000`. Pod ním riadok `REMOTE_KEYS` a textové pole s tlačidlom Odoslať (`pasteSequence(text)` a potom `"\r"`; prázdny text pošle len `"\r"`). Pri otvorení a pri zmene veľkosti okna sa posiela `subscribe`/`resize` s rozmermi z `fit.proposeDimensions()`. `History` urobí `term.reset()` a potom `write`.
- `Error` ukáže krátku hlášku cez `errorText` z `i18n.ts`.
- Mobilné i18n kľúče (EN/SK/CS): `remote.title`, `remote.pairFirst`, `remote.disconnected`, `remote.back`, `remote.send`, `remote.placeholder`, `remote.keys.esc`, `remote.keys.tab`, `remote.keys.ctrlC`, `remote.keys.shiftEnter`, `remote.keys.enter`.

- [ ] **Step 1:** Over, že `npm run build` vytvorí `dist/remote.html` a že ho `npm test` a `i18n.test.ts` neodmietnu.
- [ ] **Step 2: Implementuj** stránku.
- [ ] **Step 3: Ručne na PC:** v `app:dev` otvor párovací odkaz cez `127.0.0.1` a v Chrome DevTools prepni na mobilnú veľkosť. Zoznam ukazuje živé stavy. Otvorenie session zúži terminál na desktope. Odoslanie `echo hi` v shell session sa prejaví na oboch stranách. Klik do terminálu na desktope vráti šírku.
- [ ] **Step 4: Commit** `feat(remote): add the mobile web page`

---

### Task 8: Beh pri minimalizovanom okne, dokumentácia, end-to-end overenie

**Files:**
- Modify: `src-tauri/tauri.conf.json` a `src-tauri/tauri.dev.json` (obe definujú `windows`): `"backgroundThrottling": "disabled"` a `"additionalBrowserArgs": "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows"`. Prvá časť zachováva predvolené Tauri `--disable-features`, ktoré sa vlastnými argumentmi prepíšu.
- Modify: `README.md` (sekcia o vzdialenom prístupe: Tailscale, `tailscale serve --bg <port>`, párovanie, bezpečnosť, uspávanie PC je na používateľovi)
- Modify: `src/packaging.test.ts`, ak kontroluje tvar `tauri.conf.json`

- [ ] **Step 1:** Doplň konfiguráciu. `npm test` a `npm run build` musia prejsť.
- [ ] **Step 2: Ručne na Windows (`app:dev`):** zapni prístup a spusti `tailscale serve --bg 47615`. Na mobile cez mobilné dáta (nie Wi-Fi) naskenuj QR. Potom minimalizuj okno a zamkni obrazovku. Po 10 minútach spusti zo shell session na mobile príkaz s dlhým výstupom (`dir /s C:\Windows\System32` v cmd alebo `Get-ChildItem -Recurse $env:WINDIR\System32` v PowerShelli). Výstup musí na mobile tiecť bez zamrznutia a desktop po odomknutí musí byť aktuálny. Ak zamrzne, skontroluj, či WebView2 prevzal argumenty (`chrome://version` cez DevTools).
- [ ] **Step 3: Ručne:** v nastaveniach daj „Nový párovací kód“. Mobil sa odpojí a so starým odkazom sa už nepripojí.
- [ ] **Step 4:** Spusti celú CI sadu: `npm test`, `npm run build`, clippy a `cargo test`.
- [ ] **Step 5: Commit** `docs(remote): document remote access and keep the webview active when hidden`
- [ ] **Step 6:** Do výsledného reportu uveď, čo sa na macOS a Linuxe ručne neoverilo (najmä throttling vo WebKitGTK).

---

## Parallel Execution Strategy

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:dispatching-parallel-agents` for parallel phases. Each parallel subagent MUST use `isolation: "worktree"` to prevent file conflicts. Serialize commits back onto the main development branch after each phase.

Vývojová vetva: `feat/remote-mobile`. Worktree vetvy agentov sa po každej fáze zlúčia do nej, jedna po druhej, a po každom zlúčení prebehne `npm test` a `cargo test`. `master` sa nemení až do schválenia celej vetvy.

### Dependency graph

```
Phase 0 (koordinátor):  Task 0
Phase 1 (parallel, 4):  Task 1 | Task 3 | Task 5 | Task 7
Phase 2 (2 stopy):      [Task 2 → Task 4]  |  [Task 6]
Phase 3 (koordinátor):  Task 8 + end-to-end overenie
```

### Phase 0: Kostra
Sequential, robí ju koordinátor. Všetky zdieľané registrácie, závislosti, lockfiles a preklady vznikajú tu, aby ich paralelní agenti nemuseli meniť.
- Task 0

### Phase 1: Nezávislé moduly
Parallel-safe. Každý agent vypĺňa len vlastné súbory. Proti zmluvám z Tasku 0 sa dá kompilovať bez čakania na ostatných.

| Subagent | Task | Files |
|---|---|---|
| A | Task 1 | src-tauri/src/remote/history.rs, size.rs, protocol.rs |
| B | Task 3 | src-tauri/src/remote/tailscale.rs |
| C | Task 5 | src/model.ts, src/model.test.ts, src/remote/protocol.ts, src/remote/protocol.test.ts |
| D | Task 7 | remote.html, src/remote/main.ts, src/remote/remote.css |

Task 7 sa v tejto fáze overuje len buildom. Ručný test so serverom presúva do Phase 3, a keďže stuby z Tasku 5 by hádzali výnimky, stránku spúšťa až po zlúčení Phase 1.

**Dispatch block:**
```
Use superpowers:dispatching-parallel-agents to run Phase 1. Dispatch 4 agents in ONE message, all with isolation: worktree, base branch feat/remote-mobile:

1. Agent A: Task 1. Model: standard. Files: src-tauri/src/remote/history.rs, size.rs, protocol.rs.
2. Agent B: Task 3. Model: standard. Files: src-tauri/src/remote/tailscale.rs.
3. Agent C: Task 5. Model: standard. Files: src/model.ts, src/model.test.ts, src/remote/protocol.ts, src/remote/protocol.test.ts.
4. Agent D: Task 7. Model: standard. Files: remote.html, src/remote/main.ts, src/remote/remote.css.
Each: read the spec and this plan, keep the public signatures from Task 0 unchanged, do not touch files outside scope, run the task's checks, commit.

After all return: review diffs, merge A, B, C, D into feat/remote-mobile one by one and run npm test + cargo test after each merge.
```

### Phase 2: Backend a desktop súbežne
Dve stopy naraz. Stopa 1 (Task 2, potom Task 4) mení `pty.rs`, `lib.rs`, `hub.rs`, `server.rs` a `config.rs`. Stopa 2 (Task 6) mení `main.ts`, `terminal-runtime.ts`, `settings.ts` a `style.css`. Súbory sú disjunktné. Task 6 volá príkazy len podľa názvov a payloadov z Tasku 4, takže na kompiláciu Rustu nečaká. Task 2 a Task 4 obidva menia `lib.rs`, preto idú za sebou v jednej stope.

**Dispatch block:**
```
Dispatch 2 agents in ONE message, isolation: worktree, base feat/remote-mobile:

1. Agent E: Task 2, then Task 4 in the same worktree. Model: most capable. Files: src-tauri/src/remote/hub.rs, server.rs, config.rs, src-tauri/src/pty.rs, src-tauri/src/lib.rs.
2. Agent F: Task 6. Model: standard. Files: src/main.ts, src/terminal-runtime.ts, src/settings.ts, src/style.css. Use command names and payloads exactly as in Task 4 Interfaces.

After both return: merge E, then F; run the full CI sequence.
```

### Phase 3: Spojenie a overenie
Sequential, robí ju koordinátor. Task 8 a ručné kroky z Taskov 6 a 7 (desktop + mobil cez mobilné dáta), potom finálny review celej vetvy.

### Guardrails
- Zdieľané súbory (`lib.rs`, `remote/mod.rs`, `Cargo.toml`/`Cargo.lock`, `package.json`/`package-lock.json`, `vite.config.ts`, `i18n.ts`) mení len Task 0. Ak paralelný agent potrebuje nový i18n kľúč, pridá ho na koniec všetkých troch jazykov a koordinátor konflikt vyrieši pri zlúčení.
- Verejné signatúry z Tasku 0 sa nemenia. Ak agent zistí, že zmluva nesedí, zastaví sa a ohlási to, nemení ju sám.
- Najviac 4 agenti naraz.

### Model selection per phase
- Phase 1: standard (čistá logika a UI s jasnými testami)
- Phase 2: stopa 1 najschopnejší model (súbežnosť, PTY, bezpečnosť servera), stopa 2 standard
- Phase 0 a 3: koordinátor
