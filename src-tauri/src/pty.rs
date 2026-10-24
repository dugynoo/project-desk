//! Pseudo-terminály: spustenie shellu, čítanie výstupu, zápis, resize, ukončenie.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    #[cfg_attr(not(any(unix, windows)), allow(dead_code))]
    pid: Option<u32>,
}

impl PtySession {
    fn kill(&mut self) -> std::io::Result<()> {
        // Shell je vedúci vlastnej skupiny procesov; SIGHUP celej skupine ukončí aj agenta v ňom.
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            // SAFETY: killpg iba posiela signál, nepracuje s pamäťou.
            unsafe { libc::killpg(pid as libc::pid_t, libc::SIGHUP) };
        }
        // portable-pty 0.9's cloned Windows killer reverses the BOOL success
        // check. Use the native result while the child handle is still held by
        // the wait thread (and the session registry lock prevents its removal).
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            return kill_windows_process(pid);
        }
        self.killer.kill()
    }
}

#[cfg(windows)]
fn kill_windows_process(pid: u32) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    // SAFETY: OpenProcess creates an owned handle; it is closed on every path.
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if process.is_null() { return Err(std::io::Error::last_os_error()); }
        let result = if TerminateProcess(process, 1) != 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) };
        CloseHandle(process);
        result
    }
}

#[derive(Default, Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    /// Pri ukončení aplikácie nehlásime exit, aby UI nezmazalo relácie, ktoré majú po reštarte pokračovať.
    shutting_down: Arc<AtomicBool>,
    preparing_shutdown: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    id: String,
    code: Option<u32>,
    system_shutdown: bool,
}

fn system_is_shutting_down() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};
        // SAFETY: This read-only system metric requires no pointers or handles.
        unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
    }
    #[cfg(not(windows))]
    { false }
}

pub struct SpawnRequest {
    pub id: String,
    pub cwd: String,
    /// Príkaz, ktorý shell spustí a potom ostane bežať. `None` = čistý shell.
    pub command: Option<String>,
    pub shell: Option<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }
}

/// Zostaví príkaz pre shell. Názvy projektov a úloh sa sem nikdy nedostanú,
/// `command` pochádza iba z nastavení aplikácie a cwd sa nastavuje cez option.
fn build_command(shell: Option<&str>, command: Option<&str>) -> CommandBuilder {
    if cfg!(windows) {
        let mut cmd = CommandBuilder::new(shell.unwrap_or("powershell.exe"));
        cmd.arg("-NoLogo");
        if let Some(c) = command {
            cmd.arg("-NoExit");
            cmd.arg("-Command");
            cmd.arg(c);
        }
        cmd
    } else {
        let default_shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut cmd = CommandBuilder::new(shell.map(str::to_owned).unwrap_or(default_shell));
        match command {
            Some(c) => {
                cmd.arg("-l");
                cmd.arg("-i");
                cmd.arg("-c");
                cmd.arg(format!("{c}; exec \"$0\" -l"));
            }
            None => cmd.arg("-l"),
        }
        cmd
    }
}

/// Bajty z PTY môžu rozdeliť UTF-8 znak medzi dva bloky. Neúplný koniec si
/// podržíme do ďalšieho čítania, aby sa nerozbila diakritika.
pub fn take_utf8(pending: &mut Vec<u8>) -> String {
    let valid_up_to = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => pending.len(),
    };
    let rest = pending.split_off(valid_up_to);
    let text = String::from_utf8_lossy(pending).into_owned();
    *pending = rest;
    text
}

impl PtyManager {
    pub fn spawn(&self, app: AppHandle, req: SpawnRequest, output: Channel<String>) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(&req.id) {
            return Err("pty.alreadyRunning".into());
        }

        let pair = native_pty_system()
            .openpty(size(req.cols, req.rows))
            .map_err(|e| format!("pty.openFailed: {e}"))?;

        let mut cmd = build_command(req.shell.as_deref(), req.command.as_deref());
        cmd.cwd(&req.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        for (k, v) in &req.env {
            cmd.env(k, v);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("pty.shellFailed: {e}"))?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();
        let pid = child.process_id();

        thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            let mut pending = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let text = take_utf8(&mut pending);
                        if !text.is_empty() && output.send(text).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let id = req.id.clone();
        let registry = self.sessions.clone();
        let shutting_down = self.shutting_down.clone();
        let preparing_shutdown = self.preparing_shutdown.clone();
        thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code());
            // Capture immediately: Windows can terminate console processes before
            // the app receives its own shutdown notification. Exit codes alone
            // cannot distinguish shutdown from an unrelated forced termination.
            let system_shutdown = system_is_shutting_down() || preparing_shutdown.load(Ordering::SeqCst);
            // Uvoľnenie mastera ukončí aj čítacie vlákno (ConPTY inak nedostane EOF).
            if let Ok(mut map) = registry.lock() {
                map.remove(&id);
            }
            if !shutting_down.load(Ordering::SeqCst) {
                let _ = app.emit("pty-exit", ExitEvent { id, code, system_shutdown });
            }
        });

        sessions.insert(req.id, PtySession { master: pair.master, writer, killer, pid });
        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let s = sessions.get_mut(id).ok_or("pty.notRunning")?;
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(s) = sessions.get(id) {
            s.master.resize(size(cols, rows)).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn kill(&self, id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(s) = sessions.get_mut(id) {
            s.kill().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn kill_all(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Ok(mut sessions) = self.sessions.lock() {
            for s in sessions.values_mut() {
                let _ = s.kill();
            }
        }
    }

    pub fn prepare_shutdown(&self, active: bool) {
        self.preparing_shutdown.store(active, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::take_utf8;

    #[test]
    fn exit_payload_preserves_shutdown_reason_for_frontend() {
        for system_shutdown in [false, true] {
            let payload = serde_json::to_value(super::ExitEvent {
                id: "test".into(), code: Some(0x40010004), system_shutdown,
            }).unwrap();
            assert_eq!(payload["systemShutdown"], system_shutdown);
            assert_eq!(payload["code"], 0x40010004_u32);
        }
    }

    #[cfg(windows)]
    #[test]
    fn killing_a_live_windows_process_reports_success() {
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"])
            .creation_flags(0x08000000)
            .spawn().unwrap();
        let result = super::kill_windows_process(child.id());
        if result.is_err() { let _ = child.kill(); }
        let status = child.wait().unwrap();
        assert!(result.is_ok(), "{result:?}");
        assert!(!status.success());
    }

    #[test]
    fn keeps_split_multibyte_char_for_next_chunk() {
        let bytes = "ď".as_bytes();
        let mut pending = vec![b'a', bytes[0]];
        assert_eq!(take_utf8(&mut pending), "a");
        assert_eq!(pending, vec![bytes[0]]);
        pending.push(bytes[1]);
        assert_eq!(take_utf8(&mut pending), "ď");
        assert!(pending.is_empty());
    }

    #[test]
    fn invalid_bytes_do_not_block_output() {
        let mut pending = vec![0xff, b'x'];
        assert_eq!(take_utf8(&mut pending), "\u{fffd}x");
        assert!(pending.is_empty());
    }
}
