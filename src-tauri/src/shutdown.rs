//! Native termination waits for a frontend snapshot before releasing the OS.
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "macos")]
#[path = "shutdown_macos.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "shutdown_linux.rs"]
mod platform;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Quit,
    #[cfg(target_os = "macos")]
    NativeQuit,
    #[cfg(target_os = "linux")]
    System,
    #[cfg(target_os = "linux")]
    Logout,
}

#[derive(Default)]
pub struct Coordinator {
    pending: Mutex<Vec<(String, Reason)>>,
    active: Mutex<Vec<Reason>>,
}

impl Coordinator {
    fn take(&self, id: &str) -> Option<Reason> {
        let mut pending = self.pending.lock().unwrap();
        pending.iter().position(|(current, _)| current == id).map(|index| pending.remove(index).1)
    }
}

pub fn install(app: &AppHandle) {
    app.manage(Coordinator::default());
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    platform::install(app);
}

pub fn request(app: &AppHandle, reason: Reason) {
    let coordinator = app.state::<Coordinator>();
    let mut pending = coordinator.pending.lock().unwrap();
    if pending.iter().any(|(_, current)| *current == reason) { return; }
    let id = uuid::Uuid::new_v4().to_string();
    pending.push((id.clone(), reason));
    let mut active = coordinator.active.lock().unwrap();
    if !active.contains(&reason) { active.push(reason); }
    drop(active);
    app.state::<crate::AppState>().pty.prepare_shutdown(true);
    drop(pending);
    let _ = app.emit("prepare-shutdown", &id);
    // Never indefinitely block logout if the webview has failed. A timeout
    // cancels a normal quit and releases Linux's bounded OS inhibitor.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        complete(&handle, &id, false);
    });
}

pub fn pending(app: &AppHandle) -> Vec<String> {
    app.state::<Coordinator>().pending.lock().unwrap().iter().map(|(id, _)| id.clone()).collect()
}

pub fn complete(app: &AppHandle, id: &str, saved: bool) {
    let Some(reason) = app.state::<Coordinator>().take(id) else { return; };
    if !saved { eprintln!("Could not flush frontend state before termination"); }
    if !saved {
        match reason {
            Reason::Quit => clear_reason(app, reason),
            #[cfg(target_os = "macos")]
            Reason::NativeQuit => clear_reason(app, reason),
            #[cfg(target_os = "linux")]
            _ => {},
        }
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    platform::complete(app, reason, saved);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    if reason == Reason::Quit && saved { app.exit(0); }
}

fn clear_reason(app: &AppHandle, reason: Reason) {
    let coordinator = app.state::<Coordinator>();
    let mut active = coordinator.active.lock().unwrap();
    active.retain(|current| *current != reason);
    app.state::<crate::AppState>().pty.prepare_shutdown(!active.is_empty());
    if active.is_empty() { let _ = app.emit("shutdown-cancelled", ()); }
}

#[cfg(target_os = "linux")]
fn cancel(app: &AppHandle, reason: Reason) {
    let coordinator = app.state::<Coordinator>();
    let mut pending = coordinator.pending.lock().unwrap();
    pending.retain(|(_, current)| *current != reason);
    drop(pending);
    clear_reason(app, reason);
    if reason == Reason::System { platform::complete(app, reason, false); }
    if reason == Reason::Logout { platform::release_portal_inhibitor(app); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_or_duplicate_acknowledgement_cannot_finish_another_shutdown() {
        let coordinator = Coordinator::default();
        coordinator.pending.lock().unwrap().push(("new".into(), Reason::Quit));
        assert!(coordinator.take("old").is_none());
        assert!(coordinator.take("new") == Some(Reason::Quit));
        assert!(coordinator.take("new").is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn logout_and_system_shutdown_keep_independent_acknowledgements() {
        let coordinator = Coordinator::default();
        coordinator.pending.lock().unwrap().extend([
            ("logout".into(), Reason::Logout), ("system".into(), Reason::System),
        ]);
        assert!(coordinator.take("logout") == Some(Reason::Logout));
        assert!(coordinator.take("logout").is_none());
        assert!(coordinator.take("system") == Some(Reason::System));
    }
}
