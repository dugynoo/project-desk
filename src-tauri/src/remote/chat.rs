//! Chat pre mobil: správy zo session súboru Claude alebo Codexu.
//!
//! Jediné miesto, ktoré číta text konverzácie (výnimka v CLAUDE.md): len na žiadosť spárovaného
//! mobilu, nič neukladá a výsledok ide iba jeho WebSocketu.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Pri otvorení chatu ide mobilu najviac toľko posledných položiek.
pub const RESET_ITEMS: usize = 400;
/// Dlhší text položky sa skráti (mobil ho aj tak len číta).
const MAX_TEXT: usize = 32 * 1024;
/// Stručný vstup nástroja.
const MAX_TOOL: usize = 200;
/// Najviac toľko nových bajtov za jedno čítanie; zvyšok príde pri ďalšom.
const READ_BUDGET: u64 = 8 * 1024 * 1024;
/// Chýbajúci súbor (agent ešte nič nenapísal) sa hľadá najviac takto často.
const LOCATE_EVERY: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
}

/// Odkiaľ sa chat číta; desktop ho posiela serveru, mobil ho nevidí.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSource {
    pub provider: Provider,
    pub agent_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatItem {
    pub role: Role,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl ChatItem {
    fn new(role: Role, text: &str) -> Self {
        ChatItem { role, text: clip(text, MAX_TEXT), name: None }
    }

    fn tool(name: &str, input: &str) -> Self {
        ChatItem { role: Role::Tool, text: clip(&one_line(input), MAX_TOOL), name: Some(name.to_owned()) }
    }
}

/// Výsledok čítania: `reset` = mobil zahodí, čo má, a zobrazí `items`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ChatUpdate {
    pub reset: bool,
    pub items: Vec<ChatItem>,
}

/// Inkrementálne čítanie jedného súboru; nič z obsahu si nepamätá.
pub struct ChatReader {
    source: ChatSource,
    path: Option<PathBuf>,
    offset: u64,
    /// Neukončený posledný riadok (agent ho ešte zapisuje).
    partial: Vec<u8>,
    next_locate: Option<Instant>,
    started: bool,
}

impl ChatReader {
    pub fn new(source: ChatSource) -> Self {
        ChatReader { source, path: None, offset: 0, partial: Vec::new(), next_locate: None, started: false }
    }

    pub fn source(&self) -> &ChatSource {
        &self.source
    }

    /// Nové položky; prvé volanie vždy vráti `reset` (aj prázdny, keď súbor ešte nie je).
    pub fn poll(&mut self) -> ChatUpdate {
        let source = self.source.clone();
        self.poll_with(|| locate(&source))
    }

    fn poll_with(&mut self, find: impl FnOnce() -> Option<PathBuf>) -> ChatUpdate {
        let first = !self.started;
        self.started = true;
        if self.path.is_none() {
            let now = Instant::now();
            if self.next_locate.is_some_and(|t| now < t) {
                return ChatUpdate { reset: first, items: Vec::new() };
            }
            self.next_locate = Some(now + LOCATE_EVERY);
            self.path = find();
            if self.path.is_none() {
                return ChatUpdate { reset: first, items: Vec::new() };
            }
            return self.read_all();
        }
        let Some(path) = self.path.clone() else { return ChatUpdate::default() };
        let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if len < self.offset {
            // Súbor sa skrátil alebo prepísal: začneme odznova.
            return self.read_all();
        }
        let mut update = self.read_new(&path, len);
        update.reset = first;
        update
    }

    /// Celý súbor, z neho posledných `RESET_ITEMS` položiek.
    fn read_all(&mut self) -> ChatUpdate {
        self.offset = 0;
        self.partial.clear();
        let Some(path) = self.path.clone() else { return ChatUpdate { reset: true, items: Vec::new() } };
        let Ok(file) = File::open(&path) else { return ChatUpdate { reset: true, items: Vec::new() } };
        let mut reader = BufReader::with_capacity(64 * 1024, file);
        let mut items = VecDeque::new();
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if line.last() != Some(&b'\n') {
                        // Neukončený riadok dočítame pri ďalšom volaní.
                        self.partial = line.clone();
                        self.offset += n as u64;
                        break;
                    }
                    self.offset += n as u64;
                    for item in parse_line(self.source.provider, &line) {
                        if items.len() == RESET_ITEMS {
                            items.pop_front();
                        }
                        items.push_back(item);
                    }
                }
            }
        }
        ChatUpdate { reset: true, items: items.into() }
    }

    fn read_new(&mut self, path: &Path, len: u64) -> ChatUpdate {
        if len == self.offset {
            return ChatUpdate::default();
        }
        let Ok(mut file) = File::open(path) else { return ChatUpdate::default() };
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return ChatUpdate::default();
        }
        let mut buf = Vec::new();
        if file.take(READ_BUDGET).read_to_end(&mut buf).is_err() {
            return ChatUpdate::default();
        }
        self.offset += buf.len() as u64;
        let mut data = std::mem::take(&mut self.partial);
        data.extend_from_slice(&buf);
        let mut items = Vec::new();
        let mut rest = data.as_slice();
        while let Some(end) = rest.iter().position(|&b| b == b'\n') {
            items.extend(parse_line(self.source.provider, &rest[..end]));
            rest = &rest[end + 1..];
        }
        self.partial = rest.to_vec();
        ChatUpdate { reset: false, items }
    }
}

fn locate(source: &ChatSource) -> Option<PathBuf> {
    if !crate::usage::valid_id(&source.agent_id) {
        return None;
    }
    match source.provider {
        Provider::Claude => crate::usage::find_claude(&crate::usage::claude_projects()?, &source.agent_id),
        Provider::Codex => crate::usage::find_codex(&crate::codex::sessions_root()?, &source.agent_id),
    }
}

pub fn parse_line(provider: Provider, line: &[u8]) -> Vec<ChatItem> {
    let Ok(v) = serde_json::from_slice::<Value>(line) else { return Vec::new() };
    match provider {
        Provider::Claude => claude_items(&v),
        Provider::Codex => codex_items(&v).into_iter().collect(),
    }
}

fn claude_items(v: &Value) -> Vec<ChatItem> {
    if v["isSidechain"].as_bool() == Some(true) || v["isMeta"].as_bool() == Some(true) {
        return Vec::new();
    }
    let content = &v["message"]["content"];
    match v["type"].as_str() {
        Some("user") => {
            let texts: Vec<&str> = match content {
                Value::String(s) => vec![s.as_str()],
                Value::Array(blocks) => blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect(),
                _ => Vec::new(),
            };
            texts.into_iter().filter_map(claude_user_text).map(|t| ChatItem::new(Role::User, &t)).collect()
        }
        Some("assistant") => content
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|b| match b["type"].as_str() {
                Some("text") => b["text"].as_str().filter(|t| !t.trim().is_empty()).map(|t| ChatItem::new(Role::Assistant, t)),
                Some("tool_use") => Some(ChatItem::tool(b["name"].as_str().unwrap_or("tool"), &tool_summary(&b["input"]))),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Text, ktorý napísal človek; `None` pre systémové vložky Claude Code.
fn claude_user_text(text: &str) -> Option<String> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    if t.contains("<command-name>") {
        let name = between(t, "<command-name>", "</command-name>")?.trim();
        let args = between(t, "<command-args>", "</command-args>").unwrap_or("").trim();
        return Some(if args.is_empty() { name.to_owned() } else { format!("{name} {args}") });
    }
    let system = ["<local-command", "<command-message>", "<system-reminder>", "<bash-", "<user-prompt-submit-hook>", "Caveat:"];
    if system.iter().any(|p| t.starts_with(p)) || t.starts_with("[Request interrupted") {
        return None;
    }
    Some(text.to_owned())
}

fn between<'a>(s: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = s.find(open)? + open.len();
    let end = s[start..].find(close)? + start;
    Some(&s[start..end])
}

fn codex_items(v: &Value) -> Option<ChatItem> {
    let p = &v["payload"];
    match (v["type"].as_str()?, p["type"].as_str()?) {
        ("event_msg", "user_message") => {
            let text = p["message"].as_str()?;
            (!text.trim().is_empty()).then(|| ChatItem::new(Role::User, text))
        }
        ("event_msg", "agent_message") => {
            let text = p["message"].as_str()?;
            (!text.trim().is_empty()).then(|| ChatItem::new(Role::Assistant, text))
        }
        ("response_item", "function_call") => {
            let name = p["name"].as_str().unwrap_or("tool");
            let args = p["arguments"].as_str().and_then(|a| serde_json::from_str::<Value>(a).ok()).unwrap_or(Value::Null);
            Some(ChatItem::tool(name, &tool_summary(&args)))
        }
        ("response_item", "custom_tool_call") => {
            let name = p["name"].as_str().unwrap_or("tool");
            let input = p["input"].as_str().unwrap_or("");
            Some(ChatItem::tool(name, &patch_summary(input)))
        }
        ("response_item", "local_shell_call") => Some(ChatItem::tool("shell", &command_text(&p["action"]["command"]))),
        _ => None,
    }
}

/// Najvýstižnejšie pole vstupu nástroja (príkaz, súbor, vzor...).
fn tool_summary(input: &Value) -> String {
    for key in ["command", "cmd"] {
        let text = command_text(&input[key]);
        if !text.is_empty() {
            return text;
        }
    }
    for key in ["file_path", "path", "notebook_path", "pattern", "url", "query", "description", "prompt", "skill"] {
        if let Some(s) = input[key].as_str() {
            return s.to_owned();
        }
    }
    String::new()
}

/// `["bash", "-lc", "npm test"]` → `npm test`; reťazec ostane.
fn command_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(parts) => {
            let parts: Vec<&str> = parts.iter().filter_map(Value::as_str).collect();
            match parts.as_slice() {
                [shell, flag, script] if flag.starts_with('-') && flag.contains('c') && !shell.is_empty() => (*script).to_owned(),
                _ => parts.join(" "),
            }
        }
        _ => String::new(),
    }
}

/// `apply_patch`: súbory, ktoré mení, nie celý diff.
fn patch_summary(input: &str) -> String {
    let files: Vec<&str> = input
        .lines()
        .filter_map(|l| ["*** Update File: ", "*** Add File: ", "*** Delete File: "].iter().find_map(|p| l.strip_prefix(p)))
        .collect();
    if files.is_empty() {
        input.lines().next().unwrap_or("").to_owned()
    } else {
        files.join(", ")
    }
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_owned();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn claude(line: &str) -> Vec<ChatItem> {
        parse_line(Provider::Claude, line.as_bytes())
    }

    fn codex(line: &str) -> Vec<ChatItem> {
        parse_line(Provider::Codex, line.as_bytes())
    }

    #[test]
    fn claude_user_and_assistant_text() {
        assert_eq!(claude(r#"{"type":"user","message":{"role":"user","content":"ahoj"}}"#), vec![ChatItem::new(Role::User, "ahoj")]);
        let a = claude(r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"**ok**"}]}}"#);
        assert_eq!(a, vec![ChatItem::new(Role::Assistant, "**ok**")]);
    }

    #[test]
    fn claude_tool_use_is_summarized() {
        let a = claude(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm\n test","description":"d"}}]}}"#);
        assert_eq!(a, vec![ChatItem { role: Role::Tool, text: "npm test".into(), name: Some("Bash".into()) }]);
        let r = claude(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/a/b.rs"}}]}}"#);
        assert_eq!(r[0].text, "/a/b.rs");
    }

    #[test]
    fn claude_skips_tool_results_meta_sidechain_and_system_inserts() {
        assert!(claude(r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"out"}]}}"#).is_empty());
        assert!(claude(r#"{"type":"user","isMeta":true,"message":{"content":"x"}}"#).is_empty());
        assert!(claude(r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"x"}]}}"#).is_empty());
        assert!(claude(r#"{"type":"user","message":{"content":"<local-command-stdout>x</local-command-stdout>"}}"#).is_empty());
        assert!(claude(r#"{"type":"user","message":{"content":"<system-reminder>x</system-reminder>"}}"#).is_empty());
        assert!(claude(r#"{"type":"summary","summary":"x"}"#).is_empty());
        assert!(claude("not json").is_empty());
    }

    #[test]
    fn claude_slash_command_shows_name_and_args() {
        let line = r#"{"type":"user","message":{"content":"<command-message>model</command-message>\n<command-name>/model</command-name>\n<command-args>opus</command-args>"}}"#;
        assert_eq!(claude(line), vec![ChatItem::new(Role::User, "/model opus")]);
    }

    #[test]
    fn codex_messages_and_tools() {
        assert_eq!(codex(r#"{"type":"event_msg","payload":{"type":"user_message","message":"fix it"}}"#), vec![ChatItem::new(Role::User, "fix it")]);
        assert_eq!(codex(r#"{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}"#), vec![ChatItem::new(Role::Assistant, "done")]);
        // Ten istý text ako response_item by bol duplikát.
        assert!(codex(r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#).is_empty());
        let shell = codex(r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"bash\",\"-lc\",\"cargo test\"]}"}}"#);
        assert_eq!(shell, vec![ChatItem { role: Role::Tool, text: "cargo test".into(), name: Some("shell".into()) }]);
        let patch = codex(r#"{"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":"*** Begin Patch\n*** Update File: src/a.rs\n@@\n-x\n+y\n*** Add File: b.md\n*** End Patch"}}"#);
        assert_eq!(patch[0].text, "src/a.rs, b.md");
        assert!(codex(r#"{"type":"event_msg","payload":{"type":"token_count"}}"#).is_empty());
    }

    #[test]
    fn long_text_is_clipped_on_char_boundary() {
        let long = "č".repeat(MAX_TEXT);
        let item = ChatItem::new(Role::Assistant, &long);
        assert!(item.text.len() <= MAX_TEXT + "…".len());
        assert!(item.text.ends_with('…'));
    }

    fn temp_file(name: &str) -> (PathBuf, File) {
        let dir = std::env::temp_dir().join(format!("pd-chat-{}-{name}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("s.jsonl");
        let file = File::create(&path).unwrap();
        (path, file)
    }

    fn user(text: &str) -> String {
        format!("{}\n", serde_json::json!({"type": "user", "message": {"content": text}}))
    }

    #[test]
    fn reader_resets_then_appends_and_waits_for_full_lines() {
        let (path, mut file) = temp_file("append");
        file.write_all(user("a").as_bytes()).unwrap();
        let line = user("b");
        let (head, tail) = line.split_at(5);
        file.write_all(head.as_bytes()).unwrap();
        let mut r = ChatReader::new(ChatSource { provider: Provider::Claude, agent_id: "x".into() });
        let p = path.clone();
        let u = r.poll_with(move || Some(p));
        assert!(u.reset);
        assert_eq!(u.items, vec![ChatItem::new(Role::User, "a")]);
        assert_eq!(r.poll_with(|| None), ChatUpdate::default());
        file.write_all(tail.as_bytes()).unwrap();
        file.write_all(user("c").as_bytes()).unwrap();
        let u = r.poll_with(|| None);
        assert!(!u.reset);
        assert_eq!(u.items, vec![ChatItem::new(Role::User, "b"), ChatItem::new(Role::User, "c")]);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn reader_keeps_last_items_on_reset_and_restarts_when_truncated() {
        let (path, mut file) = temp_file("trunc");
        for i in 0..RESET_ITEMS + 5 {
            file.write_all(user(&i.to_string()).as_bytes()).unwrap();
        }
        let mut r = ChatReader::new(ChatSource { provider: Provider::Claude, agent_id: "x".into() });
        let p = path.clone();
        let u = r.poll_with(move || Some(p));
        assert_eq!(u.items.len(), RESET_ITEMS);
        assert_eq!(u.items[0].text, "5");
        drop(file);
        std::fs::write(&path, user("new")).unwrap();
        let u = r.poll_with(|| None);
        assert!(u.reset);
        assert_eq!(u.items, vec![ChatItem::new(Role::User, "new")]);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn missing_file_gives_empty_reset_once() {
        let mut r = ChatReader::new(ChatSource { provider: Provider::Codex, agent_id: "x".into() });
        assert_eq!(r.poll_with(|| None), ChatUpdate { reset: true, items: Vec::new() });
        assert_eq!(r.poll_with(|| panic!("throttled")), ChatUpdate::default());
    }

    #[test]
    fn source_parses_camel_case() {
        let s: ChatSource = serde_json::from_str(r#"{"provider":"codex","agentId":"a"}"#).unwrap();
        assert_eq!(s, ChatSource { provider: Provider::Codex, agent_id: "a".into() });
    }
}
