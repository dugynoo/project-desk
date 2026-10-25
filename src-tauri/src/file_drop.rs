//! Sample modifiers at the native drop, before asynchronous frontend delivery.
use serde::Serialize;
use tauri::{DragDropEvent, Emitter, Window, WindowEvent};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDrag {
    kind: &'static str,
    paths: Vec<String>,
    position: Option<tauri::PhysicalPosition<f64>>,
    shift: bool,
}

pub fn on_event(window: &Window, event: &WindowEvent) {
    // Tauri routes WindowContent (our main WebviewWindow) drops through
    // WindowEvent; WebviewEvent is only used for separate child webviews.
    if window.label() != "main" { return; }
    let WindowEvent::DragDrop(event) = event else { return; };
    let (kind, paths, position) = match event {
        DragDropEvent::Enter { paths, position } => ("enter", paths.as_slice(), Some(*position)),
        DragDropEvent::Over { position } => ("over", [].as_slice(), Some(*position)),
        DragDropEvent::Drop { paths, position } => ("drop", paths.as_slice(), Some(*position)),
        DragDropEvent::Leave => ("leave", [].as_slice(), None),
        _ => return,
    };
    let _ = window.emit("terminal-file-drag", FileDrag {
        kind,
        // Do not turn non-Unicode filenames into a different, incorrect path.
        paths: paths.iter().map(|path| path.to_str().unwrap_or("").to_owned()).collect(),
        position,
        shift: shift_pressed(),
    });
}

#[cfg(windows)]
fn shift_pressed() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_SHIFT};
    // SAFETY: query only the current Shift state; no pointers or input injection.
    unsafe { GetAsyncKeyState(VK_SHIFT as i32) < 0 }
}

#[cfg(target_os = "macos")]
fn shift_pressed() -> bool {
    // SAFETY: NSEvent's class method returns the current NSUInteger flags and
    // is called on the native event thread. NSEventModifierFlagShift = 1 << 17.
    let flags: usize = unsafe { objc2::msg_send![objc2::class!(NSEvent), modifierFlags] };
    flags & (1 << 17) != 0
}

#[cfg(target_os = "linux")]
fn shift_pressed() -> bool {
    gdk::Display::default()
        .and_then(|display| gdk::Keymap::for_display(&display))
        .is_some_and(|keymap| keymap.modifier_state() & gdk::ModifierType::SHIFT_MASK.bits() != 0)
}
