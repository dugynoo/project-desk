//! Import discovery returns IDs, saved titles and file dates, never message content.
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation { pub id: String, pub modified_at: u64, pub title: Option<String> }

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct TitleRecord {
    #[serde(rename = "type")] kind: String,
    session_id: String, custom_title: Option<String>, ai_title: Option<String>,
    id: String,
    #[serde(rename = "thread_name")] thread_name: Option<String>,
}

fn clean_title(title: Option<String>) -> Option<String> {
    title.map(|s| s.chars().filter(|c| !c.is_control()).take(300).collect::<String>().trim().to_owned()).filter(|s| !s.is_empty())
}

/// Titles are appended as metadata. Bound I/O even for very large transcripts.
fn titles(path: &Path, codex: bool) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    let Ok(mut file) = File::open(path) else { return out };
    let offset = file.metadata().map_or(0, |m| m.len().saturating_sub(8 * 1024 * 1024));
    if file.seek(SeekFrom::Start(offset)).is_err() { return out; }
    let mut reader = BufReader::new(file.take(8 * 1024 * 1024));
    if offset > 0 { let _ = reader.read_until(b'\n', &mut Vec::new()); }
    let mut custom = std::collections::BTreeMap::new();
    for line in reader.lines().map_while(Result::ok) {
        if !line.contains(if codex { "thread_name" } else { "Title" }) { continue; }
        let Ok(record) = serde_json::from_str::<TitleRecord>(&line) else { continue };
        if codex {
            if valid(&record.id) {
                if let Some(title) = clean_title(record.thread_name) { out.insert(record.id.to_lowercase(), title); }
            }
        } else if valid(&record.session_id) {
            let id = record.session_id.to_lowercase();
            if record.kind == "custom-title" {
                if let Some(title) = clean_title(record.custom_title) { custom.insert(id, title); }
            } else if record.kind == "ai-title" {
                if let Some(title) = clean_title(record.ai_title) { out.insert(id, title); }
            }
        }
    }
    out.extend(custom);
    out
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Metadata {
    session_id: Option<String>, cwd: Option<String>, is_sidechain: bool,
    #[serde(rename = "type")] kind: String,
    payload: Option<CodexMetadata>,
}
#[derive(Deserialize)]
struct CodexMetadata { id: String, cwd: String, source: Option<serde_json::Value> }

fn same_dir(a: &str, b: &str) -> bool {
    let normalize = |s: &str| {
        let s = s.replace('\\', "/");
        let s = s.strip_prefix("//?/").unwrap_or(&s).trim_end_matches('/');
        if cfg!(windows) { s.to_lowercase() } else { s.to_owned() }
    };
    normalize(a) == normalize(b)
}
fn valid(id: &str) -> bool { uuid::Uuid::parse_str(id).is_ok() }
fn modified(path: &Path) -> u64 {
    fs::metadata(path).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}
fn files(root: &Path, depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in fs::read_dir(root).into_iter().flatten().flatten() {
        let Ok(kind) = e.file_type() else { continue };
        if kind.is_dir() && depth > 0 { out.extend(files(&e.path(), depth - 1)); }
        if kind.is_file() && e.path().extension().is_some_and(|s| s == "jsonl") { out.push(e.path()); }
    }
    out
}

pub fn discover(root: &Path, provider: &str, cwd: &str) -> Vec<Conversation> {
    let mut found = std::collections::BTreeMap::new();
    let mut names = if provider == "codex" {
        root.parent().map(|p| titles(&p.join("session_index.jsonl"), true)).unwrap_or_default()
    } else { std::collections::BTreeMap::new() };
    if provider == "antigravity" {
        if let Ok(file) = File::open(root) {
            let map: Result<std::collections::BTreeMap<String, String>, _> = serde_json::from_reader(file.take(4 * 1024 * 1024));
            if let Ok(map) = map {
                for (path, id) in map {
                    if same_dir(&path, cwd) && valid(&id) { found.insert(id.to_lowercase(), modified(root)); }
                }
            }
        }
    } else if matches!(provider, "claude" | "codex") {
        for path in files(root, if provider == "codex" { 3 } else { 1 }) {
            // Claude subagents and indexes have different filenames and are not resumable roots.
            if provider == "claude" && !path.file_stem().and_then(|s| s.to_str()).is_some_and(valid) { continue; }
            let Ok(file) = File::open(&path) else { continue };
            for line in BufReader::new(file.take(4 * 1024 * 1024)).lines().take(if provider == "codex" { 1 } else { 512 }) {
                let Ok(line) = line else { break };
                let Ok(meta) = serde_json::from_str::<Metadata>(&line) else { continue };
                let candidate = if provider == "codex" && meta.kind == "session_meta" {
                    meta.payload.filter(|p| p.source.as_ref().is_none_or(|s| matches!(s.as_str(), Some("cli" | "vscode"))))
                        .map(|p| (p.id, p.cwd))
                } else if provider == "claude" && !meta.is_sidechain {
                    meta.session_id.zip(meta.cwd)
                } else { None };
                if let Some((id, dir)) = candidate {
                    if same_dir(&dir, cwd) && valid(&id) {
                        found.insert(id.to_lowercase(), modified(&path));
                        if provider == "claude" { names.extend(titles(&path, false)); }
                    }
                    break;
                }
            }
        }
    }
    let mut out: Vec<_> = found.into_iter().map(|(id, modified_at)| {
        let title = names.remove(&id);
        Conversation { id, modified_at, title }
    }).collect();
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at).then(a.id.cmp(&b.id)));
    out
}

pub fn list(provider: &str, cwd: &str) -> Vec<Conversation> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let root = match provider {
        "codex" => crate::codex::sessions_root(),
        "claude" => std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from)
            .or_else(|| home.clone().map(|h| h.join(".claude"))).map(|h| h.join("projects")),
        "antigravity" => home.map(|h| h.join(".gemini/antigravity-cli/cache/last_conversations.json")),
        _ => None,
    };
    root.map(|r| discover(&r, provider, cwd)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_saved_titles_without_using_message_text_and_prefers_custom_names() {
        let root = std::env::temp_dir().join(format!("desk-titles-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let id = "11111111-1111-4111-8111-111111111111";
        let file = root.join(format!("{id}.jsonl"));
        let records = [
            serde_json::json!({"sessionId":id,"cwd":"/project","message":"PRIVATE"}),
            serde_json::json!({"type":"ai-title","sessionId":id,"aiTitle":"Old name"}),
            serde_json::json!({"type":"custom-title","sessionId":id,"customTitle":"My name"}),
            serde_json::json!({"type":"ai-title","sessionId":id,"aiTitle":"New generated name"}),
            serde_json::json!({"type":"user","sessionId":id,"customTitle":"PRIVATE"}),
        ];
        fs::write(&file, records.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        assert_eq!(discover(&root,"claude","/project")[0].title.as_deref(), Some("My name"));
        fs::write(&file, records[..2].iter().map(ToString::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        assert_eq!(discover(&root,"claude","/project")[0].title.as_deref(), Some("Old name"));
        let index = root.join("session_index.jsonl");
        fs::write(&index, format!("{}\n{}", serde_json::json!({"id":id,"thread_name":"First"}), serde_json::json!({"id":id,"thread_name":"Latest"}))).unwrap();
        assert_eq!(titles(&index,true).get(id).map(String::as_str), Some("Latest"));
        assert_eq!(clean_title(Some(" \nTest\t ".into())).as_deref(), Some("Test"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn discovers_metadata_only_and_filters_project_subagents_and_invalid_ids() {
        let root = std::env::temp_dir().join(format!("desk-import-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("2026/10/23")).unwrap();
        let id = "11111111-1111-4111-8111-111111111111";
        let codex = root.join("2026/10/23/session.jsonl");
        fs::write(&codex, serde_json::json!({"type":"session_meta","payload":{"id":id,"cwd":"/project","source":"cli","text":"PRIVATE"}}).to_string()).unwrap();
        assert_eq!(discover(&root, "codex", "/project")[0].id, id);
        assert!(!serde_json::to_string(&discover(&root,"codex","/project")).unwrap().contains("PRIVATE"));
        assert!(discover(&root,"codex","/other").is_empty());
        fs::write(&codex, serde_json::json!({"type":"session_meta","payload":{"id":id,"cwd":"/project","source":{"subagent":{}}}}).to_string()).unwrap();
        assert!(discover(&root,"codex","/project").is_empty());
        let claude = root.join(format!("{id}.jsonl"));
        fs::write(&claude, format!("{{\"type\":\"snapshot\"}}\n{}", serde_json::json!({"sessionId":id,"cwd":"/project","message":"PRIVATE"}))).unwrap();
        assert_eq!(discover(&root,"claude","/project")[0].id, id);
        fs::write(&claude, serde_json::json!({"sessionId":id,"cwd":"/project","isSidechain":true}).to_string()).unwrap();
        assert!(discover(&root,"claude","/project").is_empty());
        let cache = root.join("last_conversations.json");
        fs::write(&cache, serde_json::json!({"/project":id,"/bad":"not-an-id"}).to_string()).unwrap();
        assert_eq!(discover(&cache,"antigravity","/project")[0].id, id);
        assert!(discover(&cache,"antigravity","/bad").is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
