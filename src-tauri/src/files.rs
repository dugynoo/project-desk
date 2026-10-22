//! Súbor z výstupu terminálu: otvoriť v predvolenej aplikácii systému alebo ukázať v priečinku.
use std::path::Path;

/// Prípony, ktoré by predvolená aplikácia spustila ako program, skript, inštalátor alebo skratku.
/// Takýto súbor ide len do editora; nastavenie to neprepíše.
const RUNNABLE: &[&str] = &[
    // Windows
    "exe", "com", "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "wsc", "sct", "hta",
    "cpl", "msc", "msi", "msp", "mst", "msix", "msixbundle", "appx", "appxbundle", "appinstaller", "reg", "scr",
    "pif", "inf", "scf", "lnk", "url", "website", "application", "appref-ms", "gadget", "diagcab", "xbap", "chm",
    "library-ms", "search-ms", "searchconnector-ms", "settingcontent-ms",
    // macOS
    "app", "command", "tool", "terminal", "pkg", "mpkg", "dmg", "scpt", "scptd", "applescript", "workflow", "action",
    "prefpane", "kext", "webloc", "inetloc", "fileloc",
    // Linux
    "desktop", "appimage", "run", "deb", "rpm", "snap", "flatpakref",
    // skripty, ktoré majú na niektorom systéme priradený interpreter
    "sh", "bash", "zsh", "fish", "csh", "ksh", "py", "pyw", "pyc", "pyz", "pl", "rb", "jar", "jnlp",
];

/// Spustil by sa súbor namiesto otvorenia? Bez prípony áno (na Unixe to môže byť program).
pub fn is_runnable(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return true };
    // Windows ignoruje bodky a medzery na konci (`a.exe.` = `a.exe`); dvojbodka je alternatívny dátový prúd.
    let name = name.trim_end_matches(['.', ' ']);
    if name.contains(':') {
        return true;
    }
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => RUNNABLE.contains(&ext.to_ascii_lowercase().as_str()),
        _ => true,
    }
}

fn existing_file(path: &str) -> Result<&Path, String> {
    let p = Path::new(path);
    if p.is_absolute() && p.is_file() {
        Ok(p)
    } else {
        Err(format!("file.missing: {path}"))
    }
}

pub fn open_default(path: &str) -> Result<(), String> {
    let p = existing_file(path)?;
    if is_runnable(p) {
        return Err("file.runnable".into());
    }
    tauri_plugin_opener::open_path(p, None::<&str>).map_err(|e| format!("file.openFailed: {e}"))
}

pub fn reveal(path: &str) -> Result<(), String> {
    let p = existing_file(path)?;
    tauri_plugin_opener::reveal_item_in_dir(p).map_err(|e| format!("file.revealFailed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::is_runnable;
    use std::path::Path;

    #[test]
    fn documents_open_programs_do_not() {
        for ok in ["index.html", "a/b/report.PDF", "logo.svg", "notes.md", "data.csv"] {
            assert!(!is_runnable(Path::new(ok)), "{ok}");
        }
        for bad in ["setup.exe", "run.BAT", "x.ps1", "Makefile", "build", "a.exe.", "a.exe ", "a.html:b.exe", ".bashrc", "app.AppImage"] {
            assert!(is_runnable(Path::new(bad)), "{bad}");
        }
    }
}
