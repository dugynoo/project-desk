use std::sync::OnceLock;
use objc2::{class, msg_send, sel};
use objc2::runtime::{AnyObject, Bool, Imp, Sel};
use tauri::AppHandle;
use super::Reason;

static APP: OnceLock<AppHandle> = OnceLock::new();

unsafe extern "C-unwind" fn should_terminate(_: &AnyObject, _: Sel, _: *mut AnyObject) -> usize {
    if let Some(app) = APP.get() {
        super::request(app, Reason::NativeQuit);
        2 // NSTerminateLater: keep AppKit alive until the saved-state acknowledgement.
    } else { 1 }
}

pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    // Tauri/tao owns the delegate. Add only the currently absent termination
    // method, preserving every existing delegate method and its ownership.
    // SAFETY: setup runs on the AppKit main thread; the signature matches
    // applicationShouldTerminate: (NSUInteger, id, SEL, NSApplication*).
    unsafe {
        let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = msg_send![application, delegate];
        let Some(delegate) = delegate.as_ref() else { return; };
        if delegate.class().instance_method(sel!(applicationShouldTerminate:)).is_some() {
            eprintln!("Native delegate already handles applicationShouldTerminate; shutdown hook not installed");
            return;
        }
        let implementation: Imp = std::mem::transmute(
            should_terminate as unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize,
        );
        if !objc2::ffi::class_addMethod(
            delegate.class() as *const _ as *mut _, sel!(applicationShouldTerminate:),
            implementation, c"Q@:@".as_ptr(),
        ).as_bool() { eprintln!("Could not install native termination hook"); }
    }
}

pub fn complete(app: &AppHandle, reason: Reason, saved: bool) {
    if reason == Reason::Quit {
        if saved { app.exit(0); }
        return;
    }
    let _ = app.run_on_main_thread(move || {
        // SAFETY: AppKit reply runs on its main thread, once per pending request.
        unsafe {
            let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![application, replyToApplicationShouldTerminate: Bool::new(saved)];
        }
    });
}
