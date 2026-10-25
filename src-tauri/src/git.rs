//! Read-only, event-triggered HEAD lookup. No status scan, shell, hooks or watcher.
use std::{io::Read, path::Path, process::{Command, Stdio}, time::{Duration, Instant}};

fn branch(path: &Path) -> Option<String> {
    if !path.is_absolute() || !path.is_dir() { return None; }
    let mut command = Command::new("git");
    command.current_dir(path).args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    // Inherited repository overrides must not point at a different project.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") { command.env_remove(key); }
    }
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => { let _ = child.kill(); let _ = child.wait(); break None; }
        }
    }?;
    if !status.success() { return None; } // Includes detached HEAD and non-repositories.
    let mut value = String::new();
    child.stdout.take()?.take(4096).read_to_string(&mut value).ok()?;
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) { return None; }
    Some(value.to_owned())
}

#[tauri::command]
pub async fn project_branch(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || branch(Path::new(&path))).await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_unborn_branch_nested_directory_worktree_and_detached_head() {
        let root = std::env::temp_dir().join(format!("desk-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(branch(&root), None);
        let git = |args: &[&str]| {
            let output = Command::new("git").current_dir(&root).args(args).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        };
        git(&["init", "-b", "test/main"]);
        assert_eq!(branch(&root).as_deref(), Some("test/main"));
        let nested = root.join("nested"); std::fs::create_dir(&nested).unwrap();
        assert_eq!(branch(&nested).as_deref(), Some("test/main"));
        git(&["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "--no-gpg-sign", "-m", "fixture"]);
        let worktree = root.join("linked");
        git(&["worktree", "add", "-b", "test/linked", worktree.to_str().unwrap()]);
        assert_eq!(branch(&worktree).as_deref(), Some("test/linked"));
        git(&["checkout", "--detach"]);
        assert_eq!(branch(&root), None);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
