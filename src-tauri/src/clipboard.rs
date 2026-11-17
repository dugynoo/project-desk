//! Kopírovanie textu do schránky na Linuxe cez `wl-copy` (Wayland) alebo `xclip` (X11).
//! Schránka WebKitGTK na Waylande patrí oknu Desku: keď stratí fokus, vloženie
//! v inej aplikácii môže zamrznúť. Externý nástroj schránku drží sám.
//! Text ide len cez stdin, nikdy ako argument príkazu.

#[cfg(target_os = "linux")]
fn pipe(program: &str, args: &[&str], text: &str) -> bool {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let Ok(mut child) = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let written = child.stdin.take().is_some_and(|mut stdin| stdin.write_all(text.as_bytes()).is_ok());
    // `wl-copy` aj `xclip` sa po prečítaní vstupu odpoja na pozadie a rodič skončí.
    child.wait().is_ok_and(|s| s.success()) && written
}

#[cfg(target_os = "linux")]
fn copy(text: &str) -> bool {
    (std::env::var_os("WAYLAND_DISPLAY").is_some() && pipe("wl-copy", &[], text))
        || (std::env::var_os("DISPLAY").is_some() && pipe("xclip", &["-selection", "clipboard"], text))
}

/// `Err` = nech to spraví webview (iný systém alebo chýbajúci nástroj).
#[tauri::command]
pub async fn copy_text(text: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let ok = tauri::async_runtime::spawn_blocking(move || copy(&text)).await.unwrap_or(false);
        if ok { Ok(()) } else { Err("clipboard.unavailable".into()) }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = text;
        Err("clipboard.unavailable".into())
    }
}
