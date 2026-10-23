//! Priebežné čítanie session súborov agentov: tokeny, kontext a pri Codexe aj stav.
//! Súbor sa číta od miesta, kde sme naposledy skončili. Z riadkov berieme iba typ
//! udalosti, model a čísla; text konverzácie sa neukladá ani neposiela do UI.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

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

impl Watch {
    fn claude_line(&mut self, line: &str) {
        if !line.contains("\"usage\"") {
            return;
        }
        let Ok(l) = serde_json::from_str::<ClaudeLine>(line) else { return };
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

    fn codex_line(&mut self, line: &str, events: &mut Vec<String>) {
        if !["token_count", "task_", "turn_", "turn_context"].iter().any(|k| line.contains(k)) {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        let p = &v["payload"];
        match v["type"].as_str() {
            Some("turn_context") => {
                if let Some(m) = p["model"].as_str() {
                    self.stats.model = Some(m.to_owned());
                }
            }
            Some("event_msg") => match p["type"].as_str() {
                Some("token_count") => {
                    let u = |o: &Value, k: &str| o[k].as_u64().unwrap_or(0);
                    let total = &p["info"]["total_token_usage"];
                    if total.is_object() {
                        let s = &mut self.stats;
                        s.cache_read_tokens = u(total, "cached_input_tokens");
                        s.input_tokens = u(total, "input_tokens").saturating_sub(s.cache_read_tokens);
                        s.cache_write_tokens = u(total, "cache_write_input_tokens");
                        s.output_tokens = u(total, "output_tokens");
                        s.context_tokens = p["info"]["last_token_usage"]["total_tokens"].as_u64();
                        s.context_window = p["info"]["model_context_window"].as_u64();
                    }
                    let limit = &p["rate_limits"]["primary"];
                    if let Some(pct) = limit["used_percent"].as_f64() {
                        self.stats.limit_used_percent = Some(pct);
                        self.stats.limit_window_minutes = limit["window_minutes"].as_u64();
                    }
                }
                Some(kind @ ("task_started" | "task_complete" | "turn_started" | "turn_complete" | "turn_aborted")) => {
                    self.status = Some(kind.to_owned());
                    events.push(kind.to_owned());
                },
                _ => {}
            },
            _ => {}
        }
    }

    /// Dočíta nové celé riadky. Rozpísaný posledný riadok nechá na ďalšie čítanie.
    fn read_new(&mut self, provider: Provider) -> std::io::Result<Vec<String>> {
        let mut file = File::open(&self.path)?;
        let len = file.metadata()?.len();
        if len < self.offset {
            // Súbor bol prepísaný; začneme odznova.
            let path = std::mem::take(&mut self.path);
            *self = Watch::new(path);
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut buf = Vec::new();
        file.take(len - self.offset).read_to_end(&mut buf)?;
        let Some(end) = buf.iter().rposition(|&b| b == b'\n') else { return Ok(Vec::new()) };
        self.offset += end as u64 + 1;
        let mut events = Vec::new();
        for line in String::from_utf8_lossy(&buf[..end]).lines() {
            match provider {
                Provider::Claude => self.claude_line(line),
                Provider::Codex => self.codex_line(line, &mut events),
            }
        }
        if !self.primed {
            self.primed = true;
            events.clear();
        }
        Ok(events)
    }

    fn new(path: PathBuf) -> Self {
        Watch { path, offset: 0, stats: Stats::default(), claude_msgs: HashMap::new(), primed: false, status: None }
    }
}

impl Watcher {
    pub fn poll(&self, provider: Provider, agent_id: &str) -> Option<Poll> {
        if !valid_id(agent_id) {
            return None;
        }
        let mut watches = self.watches.lock().ok()?;
        if !watches.contains_key(agent_id) {
            let path = match provider {
                Provider::Claude => find_claude(&claude_projects()?, agent_id),
                Provider::Codex => find_codex(&crate::codex::sessions_root()?, agent_id),
            }?;
            watches.insert(agent_id.to_owned(), Watch::new(path));
        }
        let w = watches.get_mut(agent_id)?;
        let events = w.read_new(provider).ok()?;
        Some(Poll { stats: w.stats.clone(), status: w.status.clone(), events })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

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
                println!("{p:?}: {:?}", w.poll(p, &id).map(|r| r.stats));
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
