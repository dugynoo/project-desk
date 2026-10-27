//! On-demand version checks. Never execute the user's full session command.
use std::{io::Read, process::{Command, Stdio}, sync::Mutex, time::{Duration, Instant}};
use serde::Serialize;

static CHECK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Debug)]
pub struct Check {
    pub status: &'static str,
    pub version: String,
}
fn result(status: &'static str) -> Check { Check { status, version: String::new() } }

fn executable<'a>(command: &'a str, expected: &str) -> Option<&'a str> {
    if command.chars().any(|c| c.is_control() || ";|&`$<>(){}".contains(c)) { return None; }
    let command = command.trim();
    let (program, rest) = if command.starts_with(['\'', '"']) {
        let quote = command.chars().next()?;
        let end = command[1..].find(quote)? + 1;
        (&command[1..end], &command[end + 1..])
    } else {
        let end = command.find(char::is_whitespace).unwrap_or(command.len());
        (&command[..end], &command[end..])
    };
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) { return None; }
    let name = program.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    let name = name.strip_suffix(".exe").or_else(|| name.strip_suffix(".cmd")).or_else(|| name.strip_suffix(".ps1")).unwrap_or(&name);
    (name == expected).then_some(program)
}

#[cfg(windows)]
struct ProcessGroup(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl ProcessGroup {
    fn new(child: &std::process::Child) -> Option<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() { return None; }
            let group = Self(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(handle, JobObjectExtendedLimitInformation, (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of_val(&info) as u32) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0 { return None; }
            Some(group)
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessGroup {
    fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); } }
}

fn run(command: Command, timeout: Duration) -> Check {
    let (status, text) = execute(command, timeout, 4096);
    let version = text.lines().rev().find(|line| line.chars().any(|c| c.is_ascii_digit()))
        .unwrap_or("").chars().filter(|c| !c.is_control()).take(160).collect::<String>();
    Check { status: if status == "available" && version.is_empty() { "failed" } else { status }, version: if status == "available" { version } else { String::new() } }
}

fn execute(mut command: Command, timeout: Duration, limit: usize) -> (&'static str, String) {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; command.process_group(0); }
    let Ok(mut child) = command.spawn() else { return ("failed", String::new()) };
    #[cfg(windows)]
    let group = match ProcessGroup::new(&child) {
        Some(group) => group,
        None => { let _ = child.kill(); let _ = child.wait(); return ("failed", String::new()); }
    };
    let mut stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut buffer = [0; 1024];
        while let Ok(n) = stdout.read(&mut buffer) {
            if n == 0 { break; }
            let retain = n.min(limit - kept.len());
            kept.extend_from_slice(&buffer[..retain]);
        }
        kept
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break if status.success() { "available" } else if status.code() == Some(127) { "missing" } else { "failed" },
            Err(_) => break "failed",
            _ if start.elapsed() >= timeout => break "timeout",
            _ => std::thread::sleep(Duration::from_millis(25)),
        }
    };
    // Kill the entire probe tree, including children retaining the stdout pipe.
    #[cfg(windows)]
    drop(group);
    #[cfg(unix)]
    unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
    let _ = child.kill();
    let _ = child.wait();
    let bytes = reader.join().unwrap_or_default();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

/// Runs only the agent executable with one fixed argument through the user's shell.
fn shell_command(program: &str, shell: &str, argument: &'static str) -> Option<Command> {
    let shell = if shell.trim().is_empty() {
        if cfg!(windows) { "powershell.exe".into() } else { std::env::var("SHELL").unwrap_or("/bin/sh".into()) }
    } else { shell.to_owned() };
    let name = shell.rsplit(['/', '\\']).next().unwrap_or("").to_ascii_lowercase();
    let mut cmd = Command::new(&shell);
    if cfg!(windows) {
        if !["powershell", "powershell.exe", "pwsh", "pwsh.exe"].contains(&name.as_str()) { return None; }
        cmd.args(["-NoLogo", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $c=Get-Command -Name $env:PD_CHECK_CLI -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1; if (!$c) {exit 127}; try { & $c.Source $env:PD_CHECK_ARG; if ($LASTEXITCODE) {exit $LASTEXITCODE} } catch {exit 1}"]);
    } else {
        if !["sh", "bash", "zsh", "dash", "ksh"].contains(&name.as_str()) { return None; }
        cmd.args(["-l", "-i", "-c", "command -v \"$PD_CHECK_CLI\" >/dev/null 2>&1 || exit 127; command \"$PD_CHECK_CLI\" \"$PD_CHECK_ARG\""]);
    }
    cmd.env("PD_CHECK_CLI", program).env("PD_CHECK_ARG", argument).env("NO_COLOR", "1");
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) { cmd.current_dir(home); }
    Some(cmd)
}

fn probe(command: &str, expected: &str, shell: &str) -> Check {
    let Some(program) = executable(command, expected) else { return result("unsupported") };
    let Some(cmd) = shell_command(program, shell, "--version") else { return result("unsupported") };
    run(cmd, Duration::from_secs(8))
}

/// False only when the installed Codex demonstrably lacks `--no-daemon` (older releases);
/// unknown commands and failed probes keep the configured command unchanged.
fn codex_lacks_no_daemon(command: &str, shell: &str) -> bool {
    let Some(cmd) = executable(command, "codex").and_then(|program| shell_command(program, shell, "--help")) else { return false };
    let (status, help) = execute(cmd, Duration::from_secs(8), 65_536);
    status == "available" && !help.contains("--no-daemon")
}

#[tauri::command]
pub async fn codex_no_daemon(command: String, shell: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || !codex_lacks_no_daemon(&command, &shell)).await.unwrap_or(true)
}

#[tauri::command]
pub async fn check_cli(commands: [String; 3], shell: String) -> Vec<Check> {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(_guard) = CHECK.try_lock() else { return vec![result("busy"); 3] };
        std::thread::scope(|scope| {
            let jobs: Vec<_> = commands.iter().zip(["claude", "codex", "agy"])
                .map(|(command, expected)| { let shell = &shell; scope.spawn(move || probe(command, expected, shell)) }).collect();
            jobs.into_iter().map(|job| job.join().unwrap_or_else(|_| result("failed"))).collect()
        })
    }).await.unwrap_or_else(|_| vec![result("failed"); 3])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_extracts_literal_agent_executables() {
        assert_eq!(executable("claude --dangerously-skip-permissions", "claude"), Some("claude"));
        assert_eq!(executable(r#""C:\Program Files\Codex\codex.exe" --flag"#, "codex"), Some(r"C:\Program Files\Codex\codex.exe"));
        for input in ["npx codex", "claude; echo bad", "$(claude)", "claude\n", "'claude'x", "'claude", "codex"] {
            assert_eq!(executable(input, "claude"), None, "{input}");
        }
    }
    fn script(text: &str) -> Command {
        // Basic process/output checks do not need PowerShell's cold startup.
        // The separate probe test below still exercises actual PowerShell launch.
        let mut cmd = Command::new(if cfg!(windows) { "cmd.exe" } else { "/bin/sh" });
        if cfg!(windows) { cmd.args(["/D", "/C", text]); } else { cmd.args(["-c", text]); }
        cmd
    }
    #[test]
    fn checks_success_missing_failure_and_timeout() {
        let checked = run(script("echo tool 1.2.3"), Duration::from_secs(5));
        assert_eq!(checked.status, "available", "{checked:?}");
        assert_eq!(checked.version, "tool 1.2.3");
        assert_eq!(run(script("exit 127"), Duration::from_secs(5)).status, "missing");
        assert_eq!(run(script("exit 1"), Duration::from_secs(5)).status, "failed");
        let mut sleeper = if cfg!(windows) { Command::new("powershell.exe") } else { script("sleep 30") };
        if cfg!(windows) { sleeper.args(["-NoProfile", "-Command", "Start-Sleep 30"]); }
        let start = Instant::now();
        assert_eq!(run(sleeper, Duration::from_millis(100)).status, "timeout");
        assert!(start.elapsed() < Duration::from_secs(5));
    }
    #[test]
    fn probes_quoted_paths_without_session_arguments() {
        let dir = std::env::temp_dir().join(format!("pd cli {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(if cfg!(windows) { "claude.ps1" } else { "claude" });
        let body = if cfg!(windows) {
            "if ($args.Count -ne 1 -or $args[0] -ne '--version') { exit 1 }; Write-Output 'fixture 1.2.3'"
        } else {
            "#!/bin/sh\n[ \"$#\" = 1 ] && [ \"$1\" = --version ] || exit 1\nprintf 'fixture 1.2.3\\n'\n"
        };
        std::fs::write(&path, body).unwrap();
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap(); }
        let shell = if cfg!(windows) { "powershell.exe" } else { "/bin/sh" };
        let checked = probe(&format!("\"{}\" --resume never-run", path.display()), "claude", shell);
        std::fs::remove_file(&path).unwrap();
        let missing = probe(&format!("\"{}\"", path.display()), "claude", shell);
        std::fs::remove_dir(&dir).unwrap();
        assert_eq!(checked.status, "available", "{checked:?}");
        assert_eq!(checked.version, "fixture 1.2.3");
        assert_eq!(missing.status, "missing");
    }
    #[test]
    fn detects_codex_without_no_daemon_only_from_its_help() {
        let dir = std::env::temp_dir().join(format!("pd codex {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(if cfg!(windows) { "codex.ps1" } else { "codex" });
        let shell = if cfg!(windows) { "powershell.exe" } else { "/bin/sh" };
        let command = format!("\"{}\" resume --no-daemon", path.display());
        // The flag appears after more than the version probe's 4 KiB, as in real Codex help.
        for (flag, lacks) in [("--no-daemon", false), ("--no-alt-screen", true)] {
            let body = if cfg!(windows) {
                format!("if ($args.Count -ne 1 -or $args[0] -ne '--help') {{ exit 1 }}; Write-Output ('x' * 5000); Write-Output '{flag}'")
            } else {
                format!("#!/bin/sh\n[ \"$#\" = 1 ] && [ \"$1\" = --help ] || exit 1\nhead -c 5000 /dev/zero | tr '\\0' x; printf '\\n%s\\n' '{flag}'\n")
            };
            std::fs::write(&path, body).unwrap();
            #[cfg(unix)]
            { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap(); }
            assert_eq!(codex_lacks_no_daemon(&command, shell), lacks, "{flag}");
        }
        std::fs::remove_file(&path).unwrap();
        assert!(!codex_lacks_no_daemon(&command, shell), "a missing Codex keeps the command");
        assert!(!codex_lacks_no_daemon("npx codex", shell));
        std::fs::remove_dir(&dir).unwrap();
    }
}
