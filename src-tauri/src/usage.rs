//! Priebežné čítanie session súborov agentov: tokeny, kontext a pri Codexe aj stav.
//! Súbor sa číta od miesta, kde sme naposledy skončili. Z riadkov berieme iba typ
//! udalosti, model a čísla; text konverzácie sa neukladá ani neposiela do UI.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
const SCAN_BUDGET: u64 = 8 * 1024 * 1024;
const READ_BUFFER: usize = 64 * 1024;

#[derive(Clone, Default, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub model: Option<String>,
    /// Vstup, ktorý nešiel z cache.
    pub input_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub output_tokens: u64,
    /// Veľkosť kontextu pri poslednej odpovedi.
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
    /// Codex: koľko percent limitu je minuté a za aké obdobie.
    pub limit_used_percent: Option<f64>,
    pub limit_window_minutes: Option<u64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Poll {
    pub stats: Stats,
    /// Latest known state, separate from new events so history does not notify.
    pub status: Option<String>,
    /// Nové stavové udalosti Codexu od posledného čítania (`task_started`, `task_complete`, `turn_aborted`).
    pub events: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Provider {
    Claude,
    Codex,
}

struct Watch {
    path: PathBuf,
    offset: u64,
    line_start: u64,
    history_end: Option<u64>,
    stats: Stats,
    /// Claude zapisuje jednu odpoveď do viacerých riadkov s rovnakým `message.id`.
    claude_msgs: HashMap<String, [u64; 4]>,
    /// Prvé čítanie prejde históriu kvôli súčtom, ale staré udalosti nehlási.
    primed: bool,
    status: Option<String>,
}

#[derive(Default)]
pub struct Watcher {
    watches: Mutex<HashMap<String, Watch>>,
    missing: Mutex<HashMap<String, Missing>>,
}

// Negative discovery results only: parsing/history catch-up never backs off.
struct Missing {
    provider: Provider,
    generation: u64,
    retry_at: Instant,
    delay: Duration,
}

fn locate(
    missing: &mut HashMap<String, Missing>, id: &str, provider: Provider,
    generation: u64, now: Instant, find: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    if missing.get(id).is_some_and(|m| m.provider != provider || m.generation != generation) {
        missing.remove(id);
    }
    if missing.get(id).is_some_and(|m| now < m.retry_at) { return None; }
    if let Some(path) = find() {
        missing.remove(id);
        return Some(path);
    }
    let delay = missing.get(id).map_or(Duration::from_secs(3), |m| (m.delay * 2).min(Duration::from_secs(30)));
    missing.insert(id.to_owned(), Missing { provider, generation, retry_at: now + delay, delay });
    None
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn claude_projects() -> Option<PathBuf> {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).or_else(|| home().map(|h| h.join(".claude")))?;
    Some(dir.join("projects"))
}

fn sorted_dirs_desc(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|it| it.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default();
    out.sort();
    out.reverse();
    out
}

/// Claude: `projects/<priečinok projektu>/<id>.jsonl`.
fn find_claude(root: &Path, id: &str) -> Option<PathBuf> {
    let name = format!("{id}.jsonl");
    sorted_dirs_desc(root).into_iter().map(|d| d.join(&name)).find(|p| p.is_file())
}

/// Codex: `sessions/RRRR/MM/DD/rollout-<čas>-<id>.jsonl`, najnovšie dni najprv.
fn find_codex(root: &Path, id: &str) -> Option<PathBuf> {
    let suffix = format!("-{id}.jsonl");
    for year in sorted_dirs_desc(root) {
        for month in sorted_dirs_desc(&year) {
            for day in sorted_dirs_desc(&month) {
                let Ok(entries) = std::fs::read_dir(&day) else { continue };
                let found = entries.flatten().map(|e| e.path()).find(|p| {
                    p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(&suffix))
                });
                if found.is_some() {
                    return found;
                }
            }
        }
    }
    None
}

fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

#[derive(Deserialize)]
struct ClaudeLine {
    #[serde(rename = "type")]
    kind: String,
    message: Option<ClaudeMessage>,
}

#[derive(Deserialize)]
struct ClaudeMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<ClaudeUsage>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ClaudeUsage {
    input_tokens: u64,
    cache_read_input_tokens: u64,
    cache_creation_input_tokens: u64,
    output_tokens: u64,
}

// Only metadata fields are deserialized. Unknown content is streamed past.
#[derive(Deserialize)]
struct CodexLine {
    #[serde(rename = "type")] kind: String,
    payload: Option<CodexPayload>,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct CodexPayload {
    #[serde(rename = "type")] kind: String,
    model: Option<String>,
    info: Option<TokenInfo>,
    rate_limits: Option<RateLimits>,
}
#[derive(Deserialize)]
struct TokenInfo {
    total_token_usage: Option<TokenUsage>,
    last_token_usage: Option<TokenUsage>,
    model_context_window: Option<u64>,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct TokenUsage {
    input_tokens: u64,
    cached_input_tokens: u64,
    cache_write_input_tokens: u64,
    output_tokens: u64,
    total_tokens: Option<u64>,
}
#[derive(Deserialize)]
struct RateLimits { primary: Option<RateLimit> }
#[derive(Deserialize)]
struct RateLimit { used_percent: Option<f64>, window_minutes: Option<u64> }

impl Watch {
    fn claude_line(&mut self, reader: impl Read) {
        let Ok(l) = serde_json::from_reader::<_, ClaudeLine>(reader) else { return };
        let Some(msg) = l.message.filter(|_| l.kind == "assistant") else { return };
        let (Some(id), Some(u)) = (msg.id, msg.usage) else { return };
        if msg.model.as_deref().is_some_and(|m| !m.starts_with('<')) {
            self.stats.model = msg.model;
        }
        let new = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens];
        let old = self.claude_msgs.insert(id, new).unwrap_or_default();
        let s = &mut self.stats;
        for (total, (n, o)) in
            [&mut s.input_tokens, &mut s.cache_read_tokens, &mut s.cache_write_tokens, &mut s.output_tokens].into_iter().zip(new.iter().zip(old))
        {
            *total = (*total + n).saturating_sub(o);
        }
        s.context_tokens = Some(new.iter().sum());
    }

    fn codex_line(&mut self, reader: impl Read, events: &mut Vec<String>, historical: bool) {
        let Ok(v) = serde_json::from_reader::<_, CodexLine>(reader) else { return };
        let Some(p) = v.payload else { return };
        match v.kind.as_str() {
            "turn_context" => {
                if p.model.is_some() { self.stats.model = p.model; }
            }
            "event_msg" => match p.kind.as_str() {
                "token_count" => {
                    if let Some(info) = p.info {
                        if let Some(total) = info.total_token_usage {
                            let s = &mut self.stats;
                            s.cache_read_tokens = total.cached_input_tokens;
                            s.input_tokens = total.input_tokens.saturating_sub(total.cached_input_tokens);
                            s.cache_write_tokens = total.cache_write_input_tokens;
                            s.output_tokens = total.output_tokens;
                            s.context_tokens = info.last_token_usage.and_then(|u| u.total_tokens);
                            s.context_window = info.model_context_window;
                        }
                    }
                    if let Some(limit) = p.rate_limits.and_then(|r| r.primary) {
                        if let Some(pct) = limit.used_percent {
                            self.stats.limit_used_percent = Some(pct);
                            self.stats.limit_window_minutes = limit.window_minutes;
                        }
                    }
                }
                "task_started" | "task_complete" | "turn_started" | "turn_complete" | "turn_aborted" => {
                    self.status = Some(p.kind.clone());
                    if !historical { events.push(p.kind); }
                }
                _ => {}
            },
            _ => {}
        }
    }

    // Scan with fixed memory, then deserialize each complete record directly
    // from disk. Serde skips conversation content rather than allocating a Value.
    // Keep offsets only: an unfinished giant line is not retained or rescanned.
    fn read_new(&mut self, provider: Provider) -> std::io::Result<Vec<String>> {
        let mut file = File::open(&self.path)?;
        let len = file.metadata()?.len();
        if len < self.offset || (!self.primed && self.history_end.is_some_and(|end| len < end)) {
            let path = std::mem::take(&mut self.path);
            *self = Watch::new(path);
        }
        let history_end = *self.history_end.get_or_insert(len);
        if len == self.offset {
            self.primed = self.offset >= history_end;
            return Ok(Vec::new());
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut records = BufReader::with_capacity(READ_BUFFER, File::open(&self.path)?);
        records.seek(SeekFrom::Start(self.line_start))?;
        let mut remaining = (len - self.offset).min(SCAN_BUDGET);
        let mut buf = [0u8; READ_BUFFER];
        let mut events = Vec::new();
        while remaining > 0 {
            let count = file.read(&mut buf[..remaining.min(READ_BUFFER as u64) as usize])?;
            if count == 0 { break; }
            let base = self.offset;
            for (i, byte) in buf[..count].iter().enumerate() {
                if *byte != b'\n' { continue; }
                let end = base + i as u64 + 1;
                let mut reader = (&mut records).take(end - self.line_start);
                match provider {
                    Provider::Claude => self.claude_line(&mut reader),
                    Provider::Codex => self.codex_line(&mut reader, &mut events, end <= history_end),
                }
                // Malformed JSON can return early; keep the next record aligned.
                std::io::copy(&mut reader, &mut std::io::sink())?;
                self.line_start = end;
            }
            self.offset += count as u64;
            remaining -= count as u64;
        }
        self.primed = self.offset >= history_end;
        Ok(events)
    }

    fn new(path: PathBuf) -> Self {
        Watch { path, offset: 0, line_start: 0, history_end: None, stats: Stats::default(), claude_msgs: HashMap::new(), primed: false, status: None }
    }
}

impl Watcher {
    /// Called after the serialized frontend poll; removed watches drop all
    /// message accounting metadata. Reopening rebuilds totals from disk.
    pub fn retain(&self, active_ids: &[String]) {
        if let Ok(mut watches) = self.watches.lock() {
            watches.retain(|id, _| active_ids.contains(id));
            if watches.is_empty() { *watches = HashMap::new(); }
        }
        if let Ok(mut missing) = self.missing.lock() {
            missing.retain(|id, _| active_ids.contains(id));
            if missing.is_empty() { *missing = HashMap::new(); }
        }
    }

    pub fn poll(&self, provider: Provider, agent_id: &str, generation: u64) -> Option<Poll> {
        if !valid_id(agent_id) {
            return None;
        }
        let mut watches = self.watches.lock().ok()?;
        if !watches.contains_key(agent_id) {
            let mut missing = self.missing.lock().ok()?;
            let path = locate(&mut missing, agent_id, provider, generation, Instant::now(), || match provider {
                Provider::Claude => find_claude(&claude_projects()?, agent_id),
                Provider::Codex => find_codex(&crate::codex::sessions_root()?, agent_id),
            })?;
            watches.insert(agent_id.to_owned(), Watch::new(path));
        }
        let w = watches.get_mut(agent_id)?;
        let events = w.read_new(provider).ok()?;
        if !w.primed { return None; }
        Some(Poll { stats: w.stats.clone(), status: w.status.clone(), events })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn missing_files_back_off_then_recover_and_reset_on_restart() {
        let mut missing = HashMap::new();
        let mut now = Instant::now();
        for seconds in [3, 6, 12, 24, 30, 30] {
            assert!(locate(&mut missing, "id", Provider::Codex, 1, now, || None).is_none());
            now += Duration::from_secs(seconds) - Duration::from_millis(1);
            assert!(locate(&mut missing, "id", Provider::Codex, 1, now, || panic!("scan before deadline")).is_none());
            now += Duration::from_millis(1);
        }
        let path = PathBuf::from("found.jsonl");
        assert_eq!(locate(&mut missing, "id", Provider::Codex, 1, now, || Some(path.clone())), Some(path));
        assert!(missing.is_empty());
        locate(&mut missing, "id", Provider::Codex, 1, now, || None);
        let mut scanned = false;
        locate(&mut missing, "id", Provider::Codex, 2, now, || { scanned = true; None });
        assert!(scanned, "new launch must bypass the previous deadline");
        let watcher = Watcher { missing: Mutex::new(missing), ..Watcher::default() };
        watcher.retain(&[]);
        assert!(watcher.missing.lock().unwrap().is_empty());
    }

    #[test]
    fn giant_partial_record_is_streamed_without_losing_metadata() {
        let path = temp_file("large.jsonl");
        append(&path, r#"{"type":"assistant","message":{"content":""#);
        let block = vec![b'x'; READ_BUFFER];
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        for _ in 0..160 { f.write_all(&block).unwrap(); }
        drop(f);
        let mut w = Watch::new(path.clone());
        w.read_new(Provider::Claude).unwrap();
        assert_eq!(w.offset, SCAN_BUDGET);
        assert!(!w.primed);
        assert_eq!(w.line_start, 0);
        w.read_new(Provider::Claude).unwrap();
        let end = w.offset;
        assert!(w.primed);
        w.read_new(Provider::Claude).unwrap();
        assert_eq!(w.offset, end);
        append(&path, concat!(r#"","id":"big","usage":{"output_tokens":42}}}"#, "\n"));
        w.read_new(Provider::Claude).unwrap();
        assert_eq!(w.stats.output_tokens, 42);
        assert_eq!(w.line_start, w.offset);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn truncated_file_and_malformed_record_preserve_following_events() {
        let path = temp_file("reset.jsonl");
        append(&path, concat!("invalid record\n", r#"{"type":"event_msg","payload":{"type":"task_started"}}"#, "\n"));
        let mut w = Watch::new(path.clone());
        assert!(w.read_new(Provider::Codex).unwrap().is_empty());
        assert_eq!(w.status.as_deref(), Some("task_started"));
        std::fs::write(&path, concat!(r#"{"type":"event_msg","payload":{"type":"turn_complete"}}"#, "\n")).unwrap();
        assert!(w.read_new(Provider::Codex).unwrap().is_empty());
        assert_eq!(w.status.as_deref(), Some("turn_complete"));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn retention_drops_closed_metadata_but_preserves_active_accounting() {
        let watcher = Watcher::default();
        let mut active = Watch::new(PathBuf::new());
        active.claude_msgs.insert("message".into(), [1, 2, 3, 4]);
        watcher.watches.lock().unwrap().insert("active".into(), active);
        watcher.watches.lock().unwrap().insert("closed".into(), Watch::new(PathBuf::new()));
        watcher.retain(&["active".into()]);
        {
            let watches = watcher.watches.lock().unwrap();
            assert_eq!(watches.len(), 1);
            assert_eq!(watches["active"].claude_msgs["message"], [1, 2, 3, 4]);
        }
        watcher.retain(&[]);
        assert_eq!(watcher.watches.lock().unwrap().capacity(), 0);
    }

    #[test]
    fn history_across_scan_batches_stays_silent_then_reports_live_events() {
        let path = temp_file("history.jsonl");
        // A large ignored record before historical status, split across polls.
        append(&path, r#"{"type":"ignored","content":""#);
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        let block = [b'x'; READ_BUFFER];
        for _ in 0..129 { f.write_all(&block).unwrap(); }
        drop(f);
        append(&path, concat!("\"}\n", r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#, "\n"));
        let mut w = Watch::new(path.clone());
        assert!(w.read_new(Provider::Codex).unwrap().is_empty());
        assert!(!w.primed);
        assert!(w.read_new(Provider::Codex).unwrap().is_empty());
        assert!(w.primed);
        assert_eq!(w.status.as_deref(), Some("task_complete"));
        append(&path, concat!(r#"{"type":"event_msg","payload":{"type":"task_started"}}"#, "\n"));
        assert_eq!(w.read_new(Provider::Codex).unwrap(), vec!["task_started"]);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pd-usage-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    fn append(path: &Path, text: &str) {
        std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap().write_all(text.as_bytes()).unwrap();
    }

    #[test]
    fn claude_counts_each_message_once_and_keeps_partial_line() {
        let path = temp_file("c.jsonl");
        let msg = |id: &str, out: u64| {
            format!(r#"{{"type":"assistant","message":{{"id":"{id}","model":"claude-opus-5-5","content":[{{"type":"text","text":"tajné"}}],"usage":{{"input_tokens":2,"cache_read_input_tokens":100,"cache_creation_input_tokens":10,"output_tokens":{out}}}}}}}"#)
        };
        append(&path, &format!("{}\n{}\n{{\"type\":\"user\",\"message\":{{\"content\":\"ahoj\"}}}}\n", msg("a", 5), msg("a", 7)));
        let mut w = Watch::new(path.clone());
        w.read_new(Provider::Claude).unwrap();
        assert_eq!((w.stats.input_tokens, w.stats.output_tokens, w.stats.cache_read_tokens), (2, 7, 100));

        let second = msg("b", 3);
        append(&path, &second[..20]);
        w.read_new(Provider::Claude).unwrap();
        assert_eq!(w.stats.output_tokens, 7, "rozpísaný riadok sa ešte nepočíta");
        append(&path, &format!("{}\n", &second[20..]));
        w.read_new(Provider::Claude).unwrap();
        assert_eq!(w.stats.output_tokens, 10);
        assert_eq!(w.stats.context_tokens, Some(115));
        assert_eq!(w.stats.model.as_deref(), Some("claude-opus-5-5"));
        assert!(!format!("{:?}", w.stats).contains("tajné"));
    }

    #[test]
    fn codex_restores_working_state_and_waits_for_complete_lines() {
        let path = temp_file("state.jsonl");
        append(&path, "{\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_started\"}}\n");
        let mut w = Watch::new(path.clone());
        assert!(w.read_new(Provider::Codex).unwrap().is_empty());
        assert_eq!(w.status.as_deref(), Some("turn_started"));
        append(&path, "{\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_complete\"}}");
        assert!(w.read_new(Provider::Codex).unwrap().is_empty());
        assert_eq!(w.status.as_deref(), Some("turn_started"));
        append(&path, "\n");
        assert_eq!(w.read_new(Provider::Codex).unwrap(), vec!["turn_complete"]);
        assert_eq!(w.status.as_deref(), Some("turn_complete"));
    }

    #[test]
    fn codex_reports_only_new_events_and_takes_totals() {
        let path = temp_file("x.jsonl");
        append(
            &path,
            concat!(
                r#"{"type":"turn_context","payload":{"model":"gpt-5.5"}}"#, "\n",
                r#"{"type":"event_msg","payload":{"type":"task_started"}}"#, "\n",
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":50},"last_token_usage":{"total_tokens":900},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":3.0,"window_minutes":10080}}}}"#, "\n",
                r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#, "\n",
            ),
        );
        let mut w = Watch::new(path.clone());
        assert!(w.read_new(Provider::Codex).unwrap().is_empty(), "história sa ako udalosti nehlási");
        assert_eq!(w.status.as_deref(), Some("task_complete"));
        let s = &w.stats;
        assert_eq!((s.input_tokens, s.cache_read_tokens, s.output_tokens), (200, 800, 50));
        assert_eq!((s.context_tokens, s.context_window), (Some(900), Some(258400)));
        assert_eq!((s.limit_used_percent, s.limit_window_minutes), (Some(3.0), Some(10080)));
        assert_eq!(s.model.as_deref(), Some("gpt-5.5"));

        append(&path, "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n");
        assert_eq!(w.read_new(Provider::Codex).unwrap(), vec!["task_started"]);
        assert_eq!(w.status.as_deref(), Some("task_started"));
        assert!(w.read_new(Provider::Codex).unwrap().is_empty());
        assert_eq!(w.status.as_deref(), Some("task_started"));
        append(&path, "{\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_aborted\"}}\n");
        assert_eq!(w.read_new(Provider::Codex).unwrap(), vec!["turn_aborted"]);
        assert_eq!(w.status.as_deref(), Some("turn_aborted"));
    }

    /// Ručná kontrola: `PD_CLAUDE_ID=... PD_CODEX_ID=... cargo test real_usage -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_usage() {
        let w = Watcher::default();
        for (p, var) in [(Provider::Claude, "PD_CLAUDE_ID"), (Provider::Codex, "PD_CODEX_ID")] {
            if let Ok(id) = std::env::var(var) {
                println!("{p:?}: {:?}", w.poll(p, &id, 0).map(|r| r.stats));
            }
        }
    }

    #[test]
    fn finds_codex_file_by_id() {
        let root = temp_file("unused").parent().unwrap().join("sessions");
        let day = root.join("2026").join("10").join("22");
        std::fs::create_dir_all(&day).unwrap();
        let id = "01a164e3-08bf-7b21-b0a9-6f2ef53df350";
        std::fs::write(day.join(format!("rollout-2026-10-22T20-32-42-{id}.jsonl")), "").unwrap();
        assert!(find_codex(&root, id).is_some());
        assert!(find_codex(&root, "01a164e3-0000-7b21-b0a9-6f2ef53df350").is_none());
        assert!(!valid_id("../../etc/passwd"));
    }
}
