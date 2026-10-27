//! Súbor z výstupu terminálu: otvoriť v predvolenej aplikácii systému alebo ukázať v priečinku.
use std::path::Path;

/// Compare directory identities, respecting the actual filesystem's case rules
/// and aliases. Keep only the selected handle and one candidate open at a time.
pub fn project_exists(path: &str, existing: &[String]) -> Result<bool, String> {
    let selected = Path::new(path);
    if !selected.is_absolute() || !selected.is_dir() {
        return Err(format!("file.missing: {path}"));
    }
    let selected = same_file::Handle::from_path(selected)
        .map_err(|e| format!("file.missing: {path}: {e}"))?;
    Ok(existing.iter().any(|other| {
        // Unavailable old projects must not prevent adding a reachable project.
        other == path || same_file::Handle::from_path(other).is_ok_and(|handle| handle == selected)
    }))
}

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
    // The opener follows symlinks: `notes.txt -> run.command` must not launch its target.
    let target = std::fs::canonicalize(p).map_err(|e| format!("file.missing: {path}: {e}"))?;
    if is_runnable(p) || is_runnable(&target) {
        return Err("file.runnable".into());
    }
    tauri_plugin_opener::open_path(p, None::<&str>).map_err(|e| format!("file.openFailed: {e}"))
}

pub fn reveal(path: &str) -> Result<(), String> {
    let p = existing_file(path)?;
    tauri_plugin_opener::reveal_item_in_dir(p).map_err(|e| format!("file.revealFailed: {e}"))
}

/// Otvorí priečinok projektu v Prieskumníkovi, Finderi alebo správcovi súborov.
/// Priečinok s príponou balíka (napr. `.app`) by sa spustil, ten len ukážeme v nadradenom.
pub fn open_folder(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_absolute() || !p.is_dir() {
        return Err(format!("folder.missing: {path}"));
    }
    let opened = if is_runnable(p) && p.extension().is_some() {
        tauri_plugin_opener::reveal_item_in_dir(p)
    } else {
        tauri_plugin_opener::open_path(p, None::<&str>)
    };
    opened.map_err(|e| format!("folder.openFailed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::is_runnable;
    use std::path::Path;

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("project-desk-path-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self, name: &str) -> String {
            self.0.join(name).to_str().unwrap().to_owned()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn projects_follow_filesystem_case_rules_and_ignore_missing_old_paths() {
        let f = Fixture::new();
        let upper = f.path("Project");
        let lower = f.path("project");
        std::fs::create_dir(&upper).unwrap();
        let same = match std::fs::create_dir(&lower) {
            Ok(()) => false,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => true,
            Err(e) => panic!("cannot create fixture: {e}"),
        };
        assert_eq!(super::project_exists(&lower, std::slice::from_ref(&upper)).unwrap(), same);
        assert!(super::project_exists(&upper, std::slice::from_ref(&upper)).unwrap());
        assert!(super::project_exists(&f.path("Project/."), std::slice::from_ref(&upper)).unwrap());
        assert!(!super::project_exists(&upper, &[f.path("missing")]).unwrap());
        assert!(super::project_exists(&f.path("missing"), &[]).is_err());
        let file = f.path("file");
        std::fs::write(&file, b"").unwrap();
        assert!(super::project_exists(&file, &[]).is_err());
        assert!(super::project_exists(".", &[]).is_err());
    }

    #[test]
    fn open_folder_accepts_only_existing_absolute_directories() {
        let f = Fixture::new();
        let file = f.path("plain-file");
        std::fs::write(&file, b"").unwrap();
        for path in ["relative", &f.path("missing"), &file] {
            assert!(super::open_folder(path).unwrap_err().starts_with("folder.missing: "), "{path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn project_symlink_is_the_same_directory() {
        let f = Fixture::new();
        let original = f.path("original");
        let alias = f.path("alias");
        std::fs::create_dir(&original).unwrap();
        std::os::unix::fs::symlink(&original, &alias).unwrap();
        assert!(super::project_exists(&alias, &[original]).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_program_does_not_open() {
        let f = Fixture::new();
        let target = f.path("payload.command");
        let link = f.path("notes.txt");
        std::fs::write(&target, "").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(super::open_default(&link), Err("file.runnable".into()));
    }

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
