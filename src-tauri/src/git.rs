//! Git, vždy jeden proces spustený používateľom alebo začiatkom ťahu agenta; žiadny watcher ani shell.
//! HEAD vetva je len na čítanie. Prehľad zmien a ťahy sú voliteľné a nemenia index ani pracovný strom:
//! snímka sa zapíše do dočasného indexu. Worktree pridá a odstráni len na požiadanie.
use std::{io::Read, path::{Path, PathBuf}, process::{Command, Stdio}, thread::JoinHandle, time::{Duration, Instant}};
use serde::Serialize;

const SHORT: Duration = Duration::from_secs(10);
const LONG: Duration = Duration::from_secs(60);
const MAX_FILES: usize = 2000;
const DIFF_LIMIT: usize = 1 << 20;

fn command(cwd: &Path) -> Command {
    let mut command = Command::new("git");
    command.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Inherited repository overrides must not point at a different project.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") { command.env_remove(key); }
    }
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    command
}

/// Reads a pipe to the end so git never blocks on it; keeps at most `limit + 1` bytes.
fn drain(mut pipe: impl Read + Send + 'static, limit: usize) -> JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let (mut kept, mut buf) = (Vec::new(), [0u8; 8192]);
        while let Ok(n) = pipe.read(&mut buf) {
            if n == 0 { break; }
            let room = (limit + 1).saturating_sub(kept.len());
            kept.extend_from_slice(&buf[..n.min(room)]);
        }
        kept
    })
}

/// Stdout of a successful command; stderr becomes `git.failed: <detail>`.
fn run(mut command: Command, timeout: Duration, limit: usize) -> Result<Vec<u8>, String> {
    let mut child = command.spawn().map_err(|e| format!("git.failed: {e}"))?;
    let out = child.stdout.take().map(|p| drain(p, limit));
    let err = child.stderr.take().map(|p| drain(p, 4096));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => { let _ = child.kill(); let _ = child.wait(); return Err("git.timeout".into()); }
        }
    };
    let out = out.and_then(|h| h.join().ok()).unwrap_or_default();
    let err = err.and_then(|h| h.join().ok()).unwrap_or_default();
    if !status.success() { return Err(format!("git.failed: {}", String::from_utf8_lossy(&err).trim())); }
    if out.len() > limit { return Err("git.tooLarge".into()); }
    Ok(out)
}

fn git(cwd: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut c = command(cwd);
    c.args(args);
    Ok(String::from_utf8_lossy(&run(c, timeout, 1 << 16)?).trim().to_owned())
}

fn project(path: &str) -> Result<&Path, String> {
    let path = Path::new(path);
    if path.is_absolute() && path.is_dir() { Ok(path) } else { Err(format!("folder.missing: {}", path.display())) }
}

/// Git prints paths relative to the command's directory.
fn resolve(cwd: &Path, out: String) -> PathBuf {
    let path = PathBuf::from(out);
    if path.is_absolute() { path } else { cwd.join(path) }
}

fn is_object(id: &str) -> bool {
    (id.len() == 40 || id.len() == 64) && id.bytes().all(|b| b.is_ascii_hexdigit())
}

fn object(id: String) -> Result<String, String> {
    if is_object(&id) { Ok(id) } else { Err("git.failed: unexpected object id".into()) }
}

fn branch(path: &Path) -> Option<String> {
    if !path.is_absolute() || !path.is_dir() { return None; }
    // Fails for detached HEAD and non-repositories.
    let value = git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"], Duration::from_secs(2)).ok()?;
    if value.is_empty() || value.chars().any(char::is_control) { return None; }
    Some(value)
}

#[tauri::command]
pub async fn project_branch(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || branch(Path::new(&path))).await.ok().flatten()
}

/// Tree of the whole working tree, untracked files included (.gitignore applies).
/// Uses a copy of the index, so the user's staging area stays untouched.
fn snapshot(path: &Path) -> Result<String, String> {
    let index = resolve(path, git(path, &["rev-parse", "--git-path", "index"], SHORT)?);
    let temp = std::env::temp_dir().join(format!("desk-index-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        // The copied stat cache lets `add` skip unchanged files.
        if index.is_file() { std::fs::copy(&index, &temp).map_err(|e| format!("git.failed: {e}"))?; }
        let mut add = command(path);
        add.env("GIT_INDEX_FILE", &temp).args(["add", "--all", "--ignore-errors"]);
        run(add, LONG, 1 << 16)?;
        let mut tree = command(path);
        tree.env("GIT_INDEX_FILE", &temp).arg("write-tree");
        object(String::from_utf8_lossy(&run(tree, SHORT, 4096)?).trim().to_owned())
    })();
    let _ = std::fs::remove_file(&temp);
    result
}

fn head_tree(path: &Path) -> Result<String, String> {
    match git(path, &["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], SHORT) {
        Ok(tree) => object(tree),
        // No commit yet: compare with the empty tree (mktree reads nothing from stdin).
        Err(_) => object(git(path, &["mktree"], SHORT)?),
    }
}

fn top(path: &Path) -> Result<PathBuf, String> {
    Ok(resolve(path, git(path, &["rev-parse", "--show-toplevel"], SHORT)?))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change { status: String, path: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes { root: String, base: String, current: String, files: Vec<Change>, truncated: bool }

/// Files changed since `base` (a snapshot) or since HEAD, as paths relative to the repository root.
fn changes(path: &Path, base: Option<String>) -> Result<Changes, String> {
    let root = top(path)?;
    let current = snapshot(path)?;
    let base = match base {
        Some(base) if is_object(&base) => base,
        Some(_) => return Err("git.failed: invalid base".into()),
        None => head_tree(path)?,
    };
    let mut c = command(&root);
    c.args(["diff-tree", "-r", "-z", "--no-renames", "--name-status", base.as_str(), current.as_str()]);
    let out = run(c, SHORT, 4 << 20)?;
    let mut parts = out.split(|b| *b == 0).filter(|p| !p.is_empty());
    let mut files = Vec::new();
    while let (Some(status), Some(file)) = (parts.next(), parts.next()) {
        files.push(Change { status: String::from_utf8_lossy(status).into_owned(), path: String::from_utf8_lossy(file).into_owned() });
    }
    let truncated = files.len() > MAX_FILES;
    files.truncate(MAX_FILES);
    Ok(Changes { root: root.to_string_lossy().into_owned(), base, current, files, truncated })
}

fn diff(path: &Path, base: &str, current: &str, file: &str) -> Result<String, String> {
    if !is_object(base) || !is_object(current) { return Err("git.failed: invalid snapshot".into()); }
    let mut c = command(&top(path)?);
    c.args(["--literal-pathspecs", "diff-tree", "-p", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
        base, current, "--", file]);
    Ok(String::from_utf8_lossy(&run(c, SHORT, DIFF_LIMIT)?).into_owned())
}

/// New linked worktree next to the repository (`<repo>-<branch>`); an existing branch is checked out.
fn worktree_add(path: &Path, branch: &str) -> Result<String, String> {
    let branch = branch.trim();
    if branch.is_empty() || branch.starts_with('-') || git(path, &["check-ref-format", "--branch", branch], SHORT).is_err() {
        return Err("git.badBranch".into());
    }
    let root = top(path)?;
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let slug: String = branch.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '-' }).collect();
    let dir = root.parent().ok_or("git.failed: no parent folder")?.join(format!("{name}-{slug}"));
    if dir.exists() { return Err(format!("git.worktreeExists: {}", dir.display())); }
    let dir = dir.to_string_lossy().into_owned();
    let exists = git(path, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], SHORT).is_ok();
    let args = if exists { vec!["worktree", "add", "--", dir.as_str(), branch] } else { vec!["worktree", "add", "-b", branch, "--", dir.as_str()] };
    git(path, &args, LONG)?;
    Ok(dir)
}

/// Removes a linked worktree; git refuses the main one and worktrees with uncommitted or untracked files.
fn worktree_remove(path: &Path) -> Result<(), String> {
    let common = resolve(path, git(path, &["rev-parse", "--git-common-dir"], SHORT)?);
    // Run from the main repository so the folder being removed is not the current directory.
    let main = common.parent().filter(|p| p.is_dir()).ok_or("git.failed: main repository not found")?;
    git(main, &["worktree", "remove", "--", path.to_string_lossy().as_ref()], LONG).map(|_| ())
}

async fn blocking<T: Send + 'static>(job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job).await.map_err(crate::error::internal)?
}

#[tauri::command]
pub async fn git_snapshot(path: String) -> Result<String, String> {
    blocking(move || snapshot(project(&path)?)).await
}

#[tauri::command]
pub async fn git_changes(path: String, base: Option<String>) -> Result<Changes, String> {
    blocking(move || changes(project(&path)?, base)).await
}

#[tauri::command]
pub async fn git_diff(path: String, base: String, current: String, file: String) -> Result<String, String> {
    blocking(move || diff(project(&path)?, &base, &current, &file)).await
}

#[tauri::command]
pub async fn git_worktree_add(path: String, branch: String) -> Result<String, String> {
    blocking(move || worktree_add(project(&path)?, &branch)).await
}

#[tauri::command]
pub async fn git_worktree_remove(path: String) -> Result<(), String> {
    blocking(move || worktree_remove(project(&path)?)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> (PathBuf, impl Fn(&[&str])) {
        let root = std::env::temp_dir().join(format!("desk-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let dir = root.clone();
        let git = move |args: &[&str]| {
            let output = Command::new("git").current_dir(&dir)
                .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false"])
                .args(args).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        };
        (root, git)
    }

    #[test]
    fn detects_unborn_branch_nested_directory_worktree_and_detached_head() {
        let (root, git) = repo();
        assert_eq!(branch(&root), None);
        git(&["init", "-b", "test/main"]);
        assert_eq!(branch(&root).as_deref(), Some("test/main"));
        let nested = root.join("nested"); std::fs::create_dir(&nested).unwrap();
        assert_eq!(branch(&nested).as_deref(), Some("test/main"));
        git(&["commit", "--allow-empty", "-m", "fixture"]);
        let worktree = root.join("linked");
        git(&["worktree", "add", "-b", "test/linked", worktree.to_str().unwrap()]);
        assert_eq!(branch(&worktree).as_deref(), Some("test/linked"));
        git(&["checkout", "--detach"]);
        assert_eq!(branch(&root), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn list(c: &Changes) -> Vec<(&str, &str)> {
        c.files.iter().map(|f| (f.status.as_str(), f.path.as_str())).collect()
    }

    #[test]
    fn changes_include_untracked_files_and_leave_the_index_alone() {
        let (root, git) = repo();
        git(&["init", "-b", "main"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        assert_eq!(list(&changes(&root, None).unwrap()), vec![("A", "a.txt")]);
        git(&["add", "a.txt"]);
        git(&["commit", "-m", "fixture"]);
        assert!(changes(&root, None).unwrap().files.is_empty());
        let turn = snapshot(&root).unwrap();
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        std::fs::write(root.join("new.txt"), "x\n").unwrap();
        let all = changes(&root, None).unwrap();
        assert_eq!(list(&all), vec![("M", "a.txt"), ("A", "new.txt")]);
        let patch = diff(&root, &all.base, &all.current, "a.txt").unwrap();
        assert!(patch.contains("-one") && patch.contains("+two"), "{patch}");
        // A later turn only shows what changed after it started.
        let next = snapshot(&root).unwrap();
        std::fs::write(root.join("new.txt"), "y\n").unwrap();
        assert_eq!(list(&changes(&root, Some(turn)).unwrap()), vec![("M", "a.txt"), ("A", "new.txt")]);
        assert_eq!(list(&changes(&root, Some(next)).unwrap()), vec![("M", "new.txt")]);
        // Nothing was staged in the real index.
        let status = Command::new("git").current_dir(&root).args(["status", "--porcelain"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&status.stdout), " M a.txt\n?? new.txt\n");
        assert!(changes(&root, Some("not-a-sha".into())).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn worktrees_are_added_next_to_the_repository_and_removed_only_when_clean() {
        let (root, git) = repo();
        git(&["init", "-b", "main"]);
        git(&["commit", "--allow-empty", "-m", "fixture"]);
        assert_eq!(worktree_add(&root, "-x").unwrap_err(), "git.badBranch");
        assert_eq!(worktree_add(&root, "bad..name").unwrap_err(), "git.badBranch");
        let dir = PathBuf::from(worktree_add(&root, "feature/x").unwrap());
        assert!(dir.file_name().unwrap().to_string_lossy().ends_with("-feature-x"));
        assert_eq!(branch(&dir).as_deref(), Some("feature/x"));
        assert!(worktree_add(&root, "feature/x").unwrap_err().starts_with("git.worktreeExists"));
        std::fs::write(dir.join("draft.txt"), "x").unwrap();
        assert!(worktree_remove(&dir).is_err());
        assert!(dir.exists());
        std::fs::remove_file(dir.join("draft.txt")).unwrap();
        worktree_remove(&dir).unwrap();
        assert!(!dir.exists());
        assert!(worktree_remove(&root).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
