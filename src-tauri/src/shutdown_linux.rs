
use std::os::fd::{FromRawFd, OwnedFd};
use std::sync::Mutex;
use gio::prelude::*;
use glib::variant::ToVariant;

use tauri::{AppHandle, Manager};
use super::Reason;

#[derive(Default)]
struct Inhibitor(Mutex<Option<OwnedFd>>);
#[derive(Default)]
struct SessionClient(Mutex<Option<gio::DBusProxy>>);
#[derive(Default)]
struct Portal(Mutex<Option<(gio::DBusProxy, glib::variant::ObjectPath)>>);
#[derive(Default)]
struct PortalInhibitor(Mutex<Option<glib::variant::ObjectPath>>);

fn inhibit(proxy: &gio::DBusProxy) -> Result<OwnedFd, glib::Error> {
    let (_, fds) = proxy.call_with_unix_fd_list_sync(
        "Inhibit", Some(&("shutdown", "Project Desk", "Save terminal sessions", "delay").to_variant()),
        gio::DBusCallFlags::NONE, 1000, None::<&gio::UnixFDList>, gio::Cancellable::NONE,
    )?;
    // logind returns one descriptor. get duplicates it, independently of the list.
    let fd = fds.get(0)?;
    // SAFETY: g_unix_fd_list_get returns a new owned descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

pub fn install(app: &AppHandle) {
    app.manage(Inhibitor::default());
    app.manage(SessionClient::default());
    app.manage(Portal::default());
    app.manage(PortalInhibitor::default());
    let handle = app.clone();
    std::thread::spawn(move || {
        let context = glib::MainContext::new();
        let _ = context.with_thread_default(|| {
            install_session_client(&handle);
            let proxy = match gio::DBusProxy::for_bus_sync(gio::BusType::System,
                gio::DBusProxyFlags::DO_NOT_AUTO_START, None, "org.freedesktop.login1",
                "/org/freedesktop/login1", "org.freedesktop.login1.Manager", gio::Cancellable::NONE) {
                Ok(proxy) => proxy,
                Err(e) => { eprintln!("Shutdown notifications unavailable: {e}"); loop { context.iteration(true); } }
            };
            let app = handle.clone();
            let proxy_for_signal = proxy.clone();
            proxy.connection().signal_subscribe(Some("org.freedesktop.login1"), Some("org.freedesktop.login1.Manager"),
                Some("PrepareForShutdown"), Some("/org/freedesktop/login1"), None, gio::DBusSignalFlags::NONE,
                move |_, _, _, _, _, parameters| {
                    match parameters.get::<(bool,)>() {
                        Some((true,)) => super::request(&app, Reason::System),
                        Some((false,)) => {
                            super::cancel(&app, Reason::System);
                            match inhibit(&proxy_for_signal) {
                                Ok(fd) => *app.state::<Inhibitor>().0.lock().unwrap() = Some(fd),
                                Err(e) => eprintln!("Could not reacquire shutdown delay: {e}"),
                            }
                        }
                        _ => {}
                    }
                });
            match inhibit(&proxy) {
                Ok(fd) => *handle.state::<Inhibitor>().0.lock().unwrap() = Some(fd),
                Err(e) => eprintln!("Shutdown delay unavailable; saving is best effort: {e}"),
            }
            loop { context.iteration(true); }
        });
    });
}

pub fn complete(app: &AppHandle, reason: Reason, saved: bool) {
    match reason {
        Reason::System => { app.state::<Inhibitor>().0.lock().unwrap().take(); }
        Reason::Logout => { reply_session(app, saved); release_portal_inhibitor(app); }
        Reason::Quit => if saved { reply_session(app, true); app.exit(0); },
    }
}

fn reply_session(app: &AppHandle, saved: bool) {
    if let Some(client) = app.state::<SessionClient>().0.lock().unwrap().as_ref() {
        if let Err(e) = client.call_sync("EndSessionResponse", Some(&(saved, if saved { "" } else { "Could not save sessions" }).to_variant()),
            gio::DBusCallFlags::NONE, 1000, gio::Cancellable::NONE) {
            eprintln!("Could not acknowledge desktop logout: {e}");
        }
    }
}

fn install_session_client(app: &AppHandle) {
    for (name, path, interface, client_interface) in [
        ("org.gnome.SessionManager", "/org/gnome/SessionManager", "org.gnome.SessionManager", "org.gnome.SessionManager.ClientPrivate"),
        ("org.xfce.SessionManager", "/org/xfce/SessionManager", "org.xfce.Session.Manager", "org.xfce.Session.Client"),
    ] {
        let Ok(manager) = gio::DBusProxy::for_bus_sync(gio::BusType::Session, gio::DBusProxyFlags::DO_NOT_AUTO_START,
            None, name, path, interface, gio::Cancellable::NONE) else { continue; };
        if manager.name_owner().is_none() { continue; }
        let Ok(result) = manager.call_sync("RegisterClient", Some(&(app.config().identifier.as_str(), "").to_variant()),
            gio::DBusCallFlags::NONE, 1000, gio::Cancellable::NONE) else { continue; };
        let client_path = result.child_value(0);
        let Some(client_path) = client_path.str() else { continue; };
        let Ok(client) = gio::DBusProxy::for_bus_sync(gio::BusType::Session, gio::DBusProxyFlags::DO_NOT_AUTO_START,
            None, name, client_path, client_interface, gio::Cancellable::NONE) else { continue; };
        let handle = app.clone();
        client.connection().signal_subscribe(Some(name), Some(client_interface), None, Some(client_path), None,
            gio::DBusSignalFlags::NONE, move |_, _, _, _, signal, _| match signal {
                "QueryEndSession" => super::request(&handle, Reason::Logout),
                "CancelEndSession" => super::cancel(&handle, Reason::Logout),
                "EndSession" | "Stop" => super::request(&handle, Reason::Quit),
                _ => {},
            });
        *app.state::<SessionClient>().0.lock().unwrap() = Some(client);
        return;
    }
    if let Err(e) = install_portal(app) {
        eprintln!("Desktop logout notifications unavailable: {e}; logind shutdown monitoring remains enabled");
    }
}

pub fn release_portal_inhibitor(app: &AppHandle) {
    let request = app.state::<PortalInhibitor>().0.lock().unwrap().take();
    if let (Some(request), Some((proxy, _))) = (request, app.state::<Portal>().0.lock().unwrap().as_ref()) {
        let _ = proxy.connection().call_sync(Some("org.freedesktop.portal.Desktop"), request.as_str(),
            "org.freedesktop.portal.Request", "Close", None, None, gio::DBusCallFlags::NONE,
            1000, gio::Cancellable::NONE);
    }
}

fn install_portal(app: &AppHandle) -> Result<(), glib::Error> {
    use std::collections::HashMap;
    use glib::variant::ObjectPath;
    let proxy = gio::DBusProxy::for_bus_sync(gio::BusType::Session, gio::DBusProxyFlags::NONE, None,
        "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Inhibit",
        gio::Cancellable::NONE)?;
    let token = format!("desk{}", uuid::Uuid::new_v4().simple());
    let sender = proxy.connection().unique_name().map(|s| s.trim_start_matches(':').replace('.', "_")).unwrap_or_default();
    let session_path = ObjectPath::try_from(format!("/org/freedesktop/portal/desktop/session/{sender}/{token}")).unwrap();
    let handle = app.clone();
    let monitored_path = session_path.clone();
    let signal = proxy.connection().signal_subscribe(Some("org.freedesktop.portal.Desktop"), Some("org.freedesktop.portal.Inhibit"),
        Some("StateChanged"), Some("/org/freedesktop/portal/desktop"), None, gio::DBusSignalFlags::NONE,
        move |_, _, _, _, _, parameters| {
            let Some((path, values)) = parameters.get::<(ObjectPath, HashMap<String, glib::Variant>)>() else { return; };
            if path != monitored_path { return; }
            match values.get("session-state").and_then(|v| v.get::<u32>()) {
                Some(1) => { super::cancel(&handle, Reason::Logout); }
                Some(2) => {
                    if let Some((proxy, _)) = handle.state::<Portal>().0.lock().unwrap().as_ref() {
                        let options = HashMap::from([("reason", "Save terminal sessions".to_variant())]);
                        if let Ok(result) = proxy.call_sync("Inhibit", Some(&("", 1u32, options).to_variant()),
                            gio::DBusCallFlags::NONE, 500, gio::Cancellable::NONE) {
                            if let Some((request,)) = result.get::<(ObjectPath,)>() {
                                *handle.state::<PortalInhibitor>().0.lock().unwrap() = Some(request);
                            }
                        }
                        // Respond within the portal's one-second deadline. The
                        // inhibitor remains held until the frontend save finishes.
                        let _ = proxy.call_sync("QueryEndResponse", Some(&(path,).to_variant()),
                            gio::DBusCallFlags::NONE, 500, gio::Cancellable::NONE);
                    }
                    super::request(&handle, Reason::Logout);
                }
                Some(3) => super::request(&handle, Reason::Quit),
                _ => {},
            }
        });
    let options = HashMap::from([("session_handle_token", token.to_variant()), ("handle_token", token.to_variant())]);
    if let Err(e) = proxy.call_sync("CreateMonitor", Some(&("", options).to_variant()), gio::DBusCallFlags::NONE,
        1000, gio::Cancellable::NONE) {
        proxy.connection().signal_unsubscribe(signal);
        return Err(e);
    }
    *app.state::<Portal>().0.lock().unwrap() = Some((proxy, session_path));
    Ok(())
}
