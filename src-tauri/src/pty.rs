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
    #[cfg_attr(not(unix), allow(dead_code))]
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
        self.killer.kill()
    }
}

#[derive(Default, Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    /// Pri ukončení aplikácie nehlásime exit, aby UI nezmazalo relácie, ktoré majú po reštarte pokračovať.
    shutting_down: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    id: String,
    code: Option<u32>,
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
            return Err("Terminál pre túto reláciu už beží.".into());
        }

        let pair = native_pty_system()
            .openpty(size(req.cols, req.rows))
            .map_err(|e| format!("Nepodarilo sa otvoriť PTY: {e}"))?;

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
            .map_err(|e| format!("Nepodarilo sa spustiť shell: {e}"))?;
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
        thread::spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code());
            // Uvoľnenie mastera ukončí aj čítacie vlákno (ConPTY inak nedostane EOF).
            if let Ok(mut map) = registry.lock() {
                map.remove(&id);
            }
            if !shutting_down.load(Ordering::SeqCst) {
                let _ = app.emit("pty-exit", ExitEvent { id, code });
            }
        });

        sessions.insert(req.id, PtySession { master: pair.master, writer, killer, pid });
        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let s = sessions.get_mut(id).ok_or("Terminál nebeží.")?;
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
}

#[cfg(test)]
mod tests {
    use super::take_utf8;

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
