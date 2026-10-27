//! Pseudo-terminály: spustenie shellu, čítanie výstupu, zápis, resize, ukončenie.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

// Bound transport + parser backlog, with one acknowledgement per ~64 KiB.
// Limits count UTF-8 bytes on the backend; the frontend echoes offsets unchanged.
const OUTPUT_HIGH: u64 = 256 * 1024;
const OUTPUT_ACK_BATCH: u64 = 64 * 1024;

// Includes the write currently blocked in the OS. Bound message overhead too.
const INPUT_BYTES: usize = 1024 * 1024;
const INPUT_MESSAGES: usize = 1024;

struct InputChunk {
    data: Vec<u8>,
    pending: Arc<AtomicUsize>,
}

impl Drop for InputChunk {
    fn drop(&mut self) {
        self.pending.fetch_sub(self.data.len(), Ordering::Relaxed);
    }
}

struct InputQueue {
    sender: mpsc::SyncSender<InputChunk>,
    pending: Arc<AtomicUsize>,
}

impl InputQueue {
    fn new() -> (Self, mpsc::Receiver<InputChunk>) {
        let (sender, receiver) = mpsc::sync_channel(INPUT_MESSAGES);
        (Self { sender, pending: Arc::new(AtomicUsize::new(0)) }, receiver)
    }

    fn send(&self, data: &[u8]) -> Result<(), String> {
        if data.len() > INPUT_BYTES { return Err("pty.inputTooLarge".into()); }
        if data.is_empty() { return Ok(()); }
        self.pending.try_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
            (data.len() <= INPUT_BYTES - used).then_some(used + data.len())
        }).map_err(|_| "pty.inputFull".to_string())?;
        // Reserve before allocating; a rejected paste is never partially enqueued.
        let chunk = InputChunk { data: data.to_vec(), pending: self.pending.clone() };
        self.sender.try_send(chunk).map_err(|error| match error {
            mpsc::TrySendError::Full(_) => "pty.inputFull".into(),
            mpsc::TrySendError::Disconnected(_) => "pty.notRunning".into(),
        })
    }
}

fn pump_input(mut writer: impl Write, receiver: mpsc::Receiver<InputChunk>) {
    for chunk in receiver {
        if writer.write_all(&chunk.data).and_then(|_| writer.flush()).is_err() { break; }
        // Drop releases credit only after write AND flush (or on failure).
    }
}

#[derive(Default)]
struct OutputState {
    sent: u64,
    acknowledged: u64,
    checkpoint: u64,
    cancelled: bool,
}

#[derive(Default)]
struct OutputFlow {
    state: Mutex<OutputState>,
    ready: Condvar,
}

impl OutputFlow {
    fn reserve(&self, bytes: usize) -> Option<Option<u64>> {
        let mut state = self.state.lock().ok()?;
        while !state.cancelled && state.sent - state.acknowledged >= OUTPUT_HIGH {
            state = self.ready.wait(state).ok()?;
        }
        if state.cancelled { return None; }
        state.sent += bytes as u64;
        if state.sent - state.checkpoint >= OUTPUT_ACK_BATCH {
            state.checkpoint = state.sent;
            Some(Some(state.sent))
        } else {
            Some(None)
        }
    }

    fn acknowledge(&self, through: u64) {
        if let Ok(mut state) = self.state.lock() {
            // Cumulative offsets make delayed/duplicate acknowledgements harmless.
            if through > state.acknowledged && through <= state.checkpoint {
                state.acknowledged = through;
                self.ready.notify_one();
            }
        }
    }

    fn cancel(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.cancelled = true;
            self.ready.notify_all();
        }
    }
}

#[derive(Serialize)]
pub struct OutputChunk {
    data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ack: Option<u64>,
}

struct PtySession {
    output: Arc<OutputFlow>,
    master: Box<dyn MasterPty + Send>,
    /// Input goes through a writer thread: a child that stops reading must not block the caller.
    input: InputQueue,
    killer: Box<dyn ChildKiller + Send + Sync>,
    #[cfg_attr(not(any(unix, windows)), allow(dead_code))]
    pid: Option<u32>,
}

impl PtySession {
    fn kill(&mut self) -> std::io::Result<()> {
        // Like a terminal hangup: SIGHUP the foreground group (an interactive shell gives
        // the agent its own group) and the shell's group.
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            let foreground = self.master.process_group_leader().filter(|&g| g != pid as libc::pid_t);
            // SAFETY: killpg iba posiela signál, nepracuje s pamäťou.
            unsafe {
                if let Some(group) = foreground { libc::killpg(group, libc::SIGHUP); }
                libc::killpg(pid as libc::pid_t, libc::SIGHUP);
            }
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
    // Reader lifetime, independent of child exit: final output can still be acknowledged.
    outputs: Arc<Mutex<HashMap<String, Arc<OutputFlow>>>>,
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
    pub direct: Option<(std::path::PathBuf, Vec<String>)>,
    pub id: String,
    pub output_id: String,
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

/// Forwards PTY output until EOF. After the frontend stops listening it keeps
/// reading and discards: macOS holds an exiting session leader until its output
/// is read, and older Windows block ClosePseudoConsole until the pipe drains.
fn pump_output(mut reader: impl Read, flow: &OutputFlow, mut send: impl FnMut(OutputChunk) -> bool) {
    let mut buf = [0u8; 16 * 1024];
    let mut pending = Vec::new();
    let mut forwarding = true;
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) if !forwarding => {}
            Ok(n) => {
                pending.extend_from_slice(&buf[..n]);
                let text = take_utf8(&mut pending);
                if text.is_empty() { continue; }
                forwarding = flow.reserve(text.len()).is_some_and(|ack| send(OutputChunk { data: text, ack }));
            }
        }
    }
}

impl PtyManager {
    pub fn spawn(&self, app: AppHandle, req: SpawnRequest, output: Channel<OutputChunk>) -> Result<(), String> {
        // Open and fork without the registry lock: ConPTY and process creation can be slow,
        // and input, resizes and kills of other sessions must not wait for them.
        if self.sessions.lock().map_err(|e| e.to_string())?.contains_key(&req.id)
            || self.outputs.lock().map_err(|e| e.to_string())?.contains_key(&req.output_id) {
            return Err("pty.alreadyRunning".into());
        }

        let pair = native_pty_system()
            .openpty(size(req.cols, req.rows))
            .map_err(|e| format!("pty.openFailed: {e}"))?;
        // Before the fork, so an error here cannot leave a child running.
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let mut cmd = if let Some((program, args)) = req.direct {
            let mut cmd = CommandBuilder::new(program); cmd.args(args); cmd
        } else { build_command(req.shell.as_deref(), req.command.as_deref()) };
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

        let flow = Arc::new(OutputFlow::default());
        let (input, input_rx) = InputQueue::new();
        let session = PtySession { master: pair.master, input, killer: child.clone_killer(), pid: child.process_id(), output: flow.clone() };
        if let Err((error, mut session)) = self.register(&req.id, &req.output_id, session) {
            let _ = session.kill();
            thread::spawn(move || { let _ = child.wait(); });
            return Err(error);
        }

        let outputs = self.outputs.clone();
        let output_id = req.output_id;
        thread::spawn(move || {
            pump_output(reader, &flow, |chunk| output.send(chunk).is_ok());
            if let Ok(mut map) = outputs.lock() { map.remove(&output_id); }
        });

        thread::spawn(move || {
            // Ends when the session drops its sender or the PTY rejects the write; dropping the writer sends EOF.
            pump_input(writer, input_rx);
        });

        // Started only after registration, so an instant exit cannot leave a stale session behind.
        let id = req.id;
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
        Ok(())
    }

    /// Registers a forked session unless a concurrent start or app shutdown got there first.
    fn register(&self, id: &str, output_id: &str, session: PtySession) -> Result<(), (String, PtySession)> {
        let mut sessions = match self.sessions.lock() { Ok(map) => map, Err(e) => return Err((e.to_string(), session)) };
        let mut outputs = match self.outputs.lock() { Ok(map) => map, Err(e) => return Err((e.to_string(), session)) };
        // kill_all sets the flag before taking the registry, so a session is either killed there or refused here.
        if self.shutting_down.load(Ordering::SeqCst) || sessions.contains_key(id) || outputs.contains_key(output_id) {
            return Err(("pty.alreadyRunning".into(), session));
        }
        outputs.insert(output_id.to_owned(), session.output.clone());
        sessions.insert(id.to_owned(), session);
        Ok(())
    }

    pub fn acknowledge_output(&self, output_id: &str, through: u64) {
        if let Ok(outputs) = self.outputs.lock() {
            if let Some(flow) = outputs.get(output_id) { flow.acknowledge(through); }
        }
    }

    pub fn cancel_output(&self, output_id: &str) {
        if let Ok(outputs) = self.outputs.lock() {
            if let Some(flow) = outputs.get(output_id) { flow.cancel(); }
        }
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let s = sessions.get(id).ok_or("pty.notRunning")?;
        s.input.send(data.as_bytes())
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
            s.output.cancel();
        }
        Ok(())
    }

    pub fn kill_all(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Ok(outputs) = self.outputs.lock() {
            for flow in outputs.values() { flow.cancel(); }
        }
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
    fn input_limits_include_in_flight_bytes_and_reject_whole_pastes() {
        use super::{InputQueue, INPUT_BYTES};
        let (queue, rx) = InputQueue::new();
        assert_eq!(queue.send(&vec![b'x'; INPUT_BYTES + 1]), Err("pty.inputTooLarge".into()));
        assert!(rx.try_recv().is_err());
        queue.send(&vec![b'x'; INPUT_BYTES - 1]).unwrap();
        let in_flight = rx.recv().unwrap();
        // UTF-8 bytes, not characters; receiving does not release the credit.
        assert_eq!(queue.send("á".as_bytes()), Err("pty.inputFull".into()));
        assert!(rx.try_recv().is_err());
        queue.send(b"z").unwrap();
        assert_eq!(queue.send(b"!"), Err("pty.inputFull".into()));
        drop(in_flight);
        let paste = b"\x1b[200~hello\x1b[201~";
        queue.send(paste).unwrap();
        assert_eq!(rx.recv().unwrap().data, b"z");
        assert_eq!(rx.recv().unwrap().data, paste);
        assert_eq!(queue.pending.load(std::sync::atomic::Ordering::Relaxed), 0);
    }

    #[test]
    fn input_message_limit_and_disconnect_return_credit() {
        use super::{InputQueue, INPUT_MESSAGES};
        use std::sync::atomic::Ordering;
        let (queue, rx) = InputQueue::new();
        for _ in 0..INPUT_MESSAGES { queue.send(b"x").unwrap(); }
        assert_eq!(queue.send(b"y"), Err("pty.inputFull".into()));
        assert_eq!(queue.pending.load(Ordering::Relaxed), INPUT_MESSAGES);
        drop(rx.recv().unwrap());
        queue.send(b"z").unwrap();
        drop(rx);
        assert_eq!(queue.pending.load(Ordering::Relaxed), 0);
        assert_eq!(queue.send(b"a"), Err("pty.notRunning".into()));
        assert_eq!(queue.pending.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn stalled_writer_does_not_block_input_and_failure_releases_backlog() {
        use super::{InputQueue, INPUT_BYTES, pump_input};
        use std::io::{self, Write};
        use std::sync::{mpsc, atomic::Ordering};
        use std::time::Duration;
        struct StalledWriter { entered: mpsc::Sender<()>, release: mpsc::Receiver<()> }
        impl Write for StalledWriter {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                self.entered.send(()).unwrap();
                self.release.recv_timeout(Duration::from_secs(5)).unwrap();
                Err(io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> io::Result<()> { Ok(()) }
        }
        let (queue, rx) = InputQueue::new();
        let (entered, started) = mpsc::channel();
        let (release, resumed) = mpsc::channel();
        let worker = std::thread::spawn(move || pump_input(StalledWriter { entered, release: resumed }, rx));
        queue.send(&vec![b'x'; INPUT_BYTES - 1]).unwrap();
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        queue.send(b"z").unwrap();
        assert_eq!(queue.send(b"!"), Err("pty.inputFull".into()));
        // An independent terminal can still accept input.
        let (other, _rx) = InputQueue::new();
        other.send(b"ok").unwrap();
        release.send(()).unwrap();
        worker.join().unwrap();
        assert_eq!(queue.pending.load(Ordering::Relaxed), 0);
        assert_eq!(queue.send(b"a"), Err("pty.notRunning".into()));
    }

    #[test]
    fn output_window_blocks_until_valid_ack_and_cancel_wakes_reader() {
        use super::{OutputFlow, OUTPUT_ACK_BATCH, OUTPUT_HIGH};
        use std::sync::{Arc, mpsc};
        use std::time::Duration;
        let flow = Arc::new(OutputFlow::default());
        for n in 1..=OUTPUT_HIGH / OUTPUT_ACK_BATCH {
            assert_eq!(flow.reserve(OUTPUT_ACK_BATCH as usize), Some(Some(n * OUTPUT_ACK_BATCH)));
        }
        let (tx, rx) = mpsc::channel();
        let reader = flow.clone();
        let worker = std::thread::spawn(move || { tx.send(reader.reserve(1)).unwrap(); });
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        flow.acknowledge(OUTPUT_HIGH + 1); // future / corrupt ack cannot grant credit
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        flow.acknowledge(OUTPUT_ACK_BATCH);
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), Some(None));
        worker.join().unwrap();
        flow.acknowledge(OUTPUT_ACK_BATCH); // duplicate must not grant more credit
        assert_eq!(flow.state.lock().unwrap().acknowledged, OUTPUT_ACK_BATCH);
        assert_eq!(flow.reserve((OUTPUT_ACK_BATCH - 1) as usize), Some(Some(OUTPUT_HIGH + OUTPUT_ACK_BATCH)));
        let (tx, rx) = mpsc::channel();
        let reader = flow.clone();
        let worker = std::thread::spawn(move || { tx.send(reader.reserve(1)).unwrap(); });
        assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
        flow.cancel();
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), None);
        worker.join().unwrap();
    }

    #[test]
    fn output_generations_are_independent_and_small_writes_do_not_need_ack() {
        use super::{OutputFlow, PtyManager, OUTPUT_ACK_BATCH};
        use std::sync::Arc;
        let manager = PtyManager::default();
        let old = Arc::new(OutputFlow::default());
        let new = Arc::new(OutputFlow::default());
        manager.outputs.lock().unwrap().insert("old".into(), old.clone());
        manager.outputs.lock().unwrap().insert("new".into(), new.clone());
        assert_eq!(old.reserve(OUTPUT_ACK_BATCH as usize), Some(Some(OUTPUT_ACK_BATCH)));
        assert_eq!(new.reserve("\u{10f}\u{1f642}".len()), Some(None));
        manager.acknowledge_output("old", OUTPUT_ACK_BATCH);
        manager.cancel_output("old");
        assert_eq!(old.reserve(1), None);
        assert_eq!(new.reserve(1), Some(None));
        assert_eq!(new.state.lock().unwrap().acknowledged, 0);
        manager.kill_all();
        assert_eq!(new.reserve(1), None);
    }

    #[test]
    fn cancelled_output_keeps_draining_until_eof() {
        use super::{pump_output, OutputFlow};
        use std::io::Read;
        struct Source { left: usize, read: usize }
        impl Read for Source {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let n = buf.len().min(self.left).min(1000);
                buf[..n].fill(b'x');
                self.left -= n;
                self.read += n;
                Ok(n)
            }
        }
        let flow = OutputFlow::default();
        let mut source = Source { left: 5000, read: 0 };
        let mut sent = 0;
        pump_output(&mut source, &flow, |_| { sent += 1; flow.cancel(); true });
        assert_eq!((sent, source.read), (1, 5000));

        let mut source = Source { left: 5000, read: 0 };
        let mut sent = 0;
        pump_output(&mut source, &OutputFlow::default(), |_| { sent += 1; false });
        assert_eq!((sent, source.read), (1, 5000));
    }

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
