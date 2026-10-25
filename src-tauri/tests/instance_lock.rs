#[path = "../src/instance.rs"]
mod instance;

use instance::DataLock;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

// On Unix a concurrently spawned child can briefly inherit another test's
// open lock across fork, until exec closes CLOEXEC descriptors. Do not let
// that unrelated child keep the normal-cleanup test's lock alive.
static PROCESS_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct TempDir(std::path::PathBuf);
impl TempDir {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("project-desk-lock-{}", uuid::Uuid::new_v4())))
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn separate_process_is_blocked_and_crash_releases_lock() {
    let _serial = PROCESS_TEST.lock().unwrap();
    const DIR_ENV: &str = "PROJECT_DESK_LOCK_TEST_DIR";
    if let Some(dir) = std::env::var_os(DIR_ENV) {
        let _lock = DataLock::acquire(std::path::Path::new(&dir)).unwrap();
        println!("LOCK_READY");
        std::io::stdout().flush().unwrap();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
        return;
    }
    let dir = TempDir::new();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "separate_process_is_blocked_and_crash_releases_lock", "--nocapture"])
        .env(DIR_ENV, &dir.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    loop {
        assert_ne!(output.read_line(&mut line).unwrap(), 0, "child exited before acquiring lock");
        if line.contains("LOCK_READY") { break; }
        line.clear();
    }
    let result = DataLock::acquire(&dir.0);
    // Kill without Rust destructors: the OS must release ownership after a crash.
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(matches!(result, Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    let _restarted = DataLock::acquire(&dir.0).unwrap();
}

#[test]
fn independent_directories_and_normal_cleanup_allow_restart() {
    let _serial = PROCESS_TEST.lock().unwrap();
    let dir = TempDir::new();
    let prod = dir.0.join("production");
    let dev = dir.0.join("development");
    let first = DataLock::acquire(&prod).unwrap();
    let _dev = DataLock::acquire(&dev).unwrap();
    assert!(matches!(DataLock::acquire(&prod), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    drop(first);
    assert!(prod.join("instance.lock").exists());
    let _restarted = DataLock::acquire(&prod).unwrap();
}

#[test]
fn invalid_directory_fails_closed() {
    let dir = TempDir::new();
    std::fs::create_dir_all(&dir.0).unwrap();
    let path = dir.0.join("not-a-directory");
    std::fs::write(&path, "untouched").unwrap();
    assert!(DataLock::acquire(&path).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "untouched");
}
