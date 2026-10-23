//! Nainštalované editory a ich spustenie bez shellu.
//!
//! Hľadá sa podľa inštalácie, nie podľa PATH: Cursor si do PATH pridáva aj vlastný `code`,
//! takže podľa PATH by sa tváril ako VS Code. Windows: Uninstall záznamy v registri s kontrolou
//! názvu a vydavateľa (ako GitHub Desktop). macOS: bundle ID cez Spotlight. Linux: PATH.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

/// Ako editor skočí na riadok.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Family {
    /// `-g súbor:riadok`
    VsCode,
    /// `--line N súbor`
    JetBrains,
    /// `súbor:riadok`
    Colon,
    /// `-nN súbor`
    NotepadPlusPlus,
}

// Polia pre ostatné platformy sa na danej platforme nečítajú.
#[allow(dead_code)]
struct Def {
    id: &'static str,
    label: &'static str,
    family: Family,
    /// Windows: začiatok DisplayName v Uninstall zázname.
    win_names: &'static [&'static str],
    /// Windows: povolení vydavatelia; prázdne = stačí názov.
    win_publishers: &'static [&'static str],
    /// Windows: exe relatívne k InstallLocation (alebo názov súboru v DisplayIcon).
    win_exe: &'static [&'static str],
    mac_bundles: &'static [&'static str],
    /// macOS: CLI vnútri balíka, ktoré vie argumenty (skok na riadok).
    mac_cli: &'static str,
    /// Linux: príkazy v PATH.
    unix_cmds: &'static [&'static str],
}

const JB: &[&str] = &["JetBrains s.r.o."];

const DEFS: &[Def] = &[
    Def {
        id: "cursor",
        label: "Cursor",
        family: Family::VsCode,
        win_names: &["Cursor"],
        win_publishers: &["Anysphere", "Cursor AI, Inc."],
        win_exe: &["Cursor.exe"],
        mac_bundles: &["com.todesktop.230313mzl4w4u92"],
        mac_cli: "Contents/Resources/app/bin/cursor",
        unix_cmds: &["cursor"],
    },
    Def {
        id: "code",
        label: "VS Code",
        family: Family::VsCode,
        win_names: &["Microsoft Visual Studio Code"],
        win_publishers: &["Microsoft Corporation"],
        win_exe: &["Code.exe"],
        mac_bundles: &["com.microsoft.VSCode"],
        mac_cli: "Contents/Resources/app/bin/code",
        unix_cmds: &["code"],
    },
    Def {
        id: "code-insiders",
        label: "VS Code Insiders",
        family: Family::VsCode,
        win_names: &["Microsoft Visual Studio Code Insiders"],
        win_publishers: &["Microsoft Corporation"],
        win_exe: &["Code - Insiders.exe"],
        mac_bundles: &["com.microsoft.VSCodeInsiders"],
        mac_cli: "Contents/Resources/app/bin/code-insiders",
        unix_cmds: &["code-insiders"],
    },
    Def {
        id: "windsurf",
        label: "Windsurf",
        family: Family::VsCode,
        win_names: &["Windsurf"],
        win_publishers: &[],
        win_exe: &["Windsurf.exe"],
        mac_bundles: &["com.exafunction.windsurf"],
        mac_cli: "Contents/Resources/app/bin/windsurf",
        unix_cmds: &["windsurf"],
    },
    Def {
        id: "codium",
        label: "VSCodium",
        family: Family::VsCode,
        win_names: &["VSCodium"],
        win_publishers: &[],
        win_exe: &["VSCodium.exe"],
        mac_bundles: &["com.vscodium"],
        mac_cli: "Contents/Resources/app/bin/codium",
        unix_cmds: &["codium"],
    },
    Def {
        id: "trae",
        label: "Trae",
        family: Family::VsCode,
        win_names: &["Trae"],
        win_publishers: &[],
        win_exe: &["Trae.exe"],
        mac_bundles: &[],
        mac_cli: "",
        unix_cmds: &[],
    },
    Def {
        id: "zed",
        label: "Zed",
        family: Family::Colon,
        win_names: &["Zed"],
        win_publishers: &[],
        win_exe: &["Zed.exe"],
        mac_bundles: &["dev.zed.Zed"],
        mac_cli: "Contents/MacOS/cli",
        unix_cmds: &["zed", "zeditor"],
    },
    Def {
        id: "subl",
        label: "Sublime Text",
        family: Family::Colon,
        win_names: &["Sublime Text"],
        win_publishers: &[],
        win_exe: &["sublime_text.exe"],
        mac_bundles: &["com.sublimetext.4", "com.sublimetext.3"],
        mac_cli: "Contents/SharedSupport/bin/subl",
        unix_cmds: &["subl"],
    },
    Def {
        id: "idea",
        label: "IntelliJ IDEA",
        family: Family::JetBrains,
        win_names: &["IntelliJ IDEA"],
        win_publishers: JB,
        win_exe: &["bin/idea64.exe"],
        mac_bundles: &["com.jetbrains.intellij", "com.jetbrains.intellij.ce"],
        mac_cli: "Contents/MacOS/idea",
        unix_cmds: &["idea", "intellij-idea-ultimate", "intellij-idea-community"],
    },
    Def {
        id: "webstorm",
        label: "WebStorm",
        family: Family::JetBrains,
        win_names: &["WebStorm", "JetBrains WebStorm"],
        win_publishers: JB,
        win_exe: &["bin/webstorm64.exe"],
        mac_bundles: &["com.jetbrains.WebStorm"],
        mac_cli: "Contents/MacOS/webstorm",
        unix_cmds: &["webstorm"],
    },
    Def {
        id: "phpstorm",
        label: "PhpStorm",
        family: Family::JetBrains,
        win_names: &["PhpStorm", "JetBrains PhpStorm"],
        win_publishers: JB,
        win_exe: &["bin/phpstorm64.exe"],
        mac_bundles: &["com.jetbrains.PhpStorm"],
        mac_cli: "Contents/MacOS/phpstorm",
        unix_cmds: &["phpstorm"],
    },
    Def {
        id: "pycharm",
        label: "PyCharm",
        family: Family::JetBrains,
        win_names: &["PyCharm", "JetBrains PyCharm"],
        win_publishers: JB,
        win_exe: &["bin/pycharm64.exe"],
        mac_bundles: &["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"],
        mac_cli: "Contents/MacOS/pycharm",
        unix_cmds: &["pycharm", "pycharm-professional", "pycharm-community"],
    },
    Def {
        id: "rider",
        label: "Rider",
        family: Family::JetBrains,
        win_names: &["JetBrains Rider", "Rider"],
        win_publishers: JB,
        win_exe: &["bin/rider64.exe"],
        mac_bundles: &["com.jetbrains.rider"],
        mac_cli: "Contents/MacOS/rider",
        unix_cmds: &["rider"],
    },
    Def {
        id: "goland",
        label: "GoLand",
        family: Family::JetBrains,
        win_names: &["GoLand", "JetBrains GoLand"],
        win_publishers: JB,
        win_exe: &["bin/goland64.exe"],
        mac_bundles: &["com.jetbrains.goland"],
        mac_cli: "Contents/MacOS/goland",
        unix_cmds: &["goland"],
    },
    Def {
        id: "rustrover",
        label: "RustRover",
        family: Family::JetBrains,
        win_names: &["RustRover", "JetBrains RustRover"],
        win_publishers: JB,
        win_exe: &["bin/rustrover64.exe"],
        mac_bundles: &["com.jetbrains.rustrover"],
        mac_cli: "Contents/MacOS/rustrover",
        unix_cmds: &["rustrover"],
    },
    Def {
        id: "clion",
        label: "CLion",
        family: Family::JetBrains,
        win_names: &["CLion", "JetBrains CLion"],
        win_publishers: JB,
        win_exe: &["bin/clion64.exe"],
        mac_bundles: &["com.jetbrains.CLion"],
        mac_cli: "Contents/MacOS/clion",
        unix_cmds: &["clion"],
    },
    Def {
        id: "notepad++",
        label: "Notepad++",
        family: Family::NotepadPlusPlus,
        win_names: &["Notepad++"],
        win_publishers: &[],
        win_exe: &["notepad++.exe"],
        mac_bundles: &[],
        mac_cli: "",
        unix_cmds: &[],
    },
];

/// Nájdený editor. `path` je exe (Windows), `.app` (macOS) alebo príkaz (Linux).
#[derive(Serialize, Clone, Debug)]
pub struct Found {
    pub id: String,
    pub label: String,
    pub path: String,
}

/// Čo si používateľ vybral. Prázdne `id` = prvý nájdený, `custom` = vlastný program.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Choice {
    pub id: String,
    pub custom_path: String,
    pub custom_args: String,
}

pub const CUSTOM: &str = "custom";
pub const TARGET_PATH: &str = "%TARGET_PATH%";
pub const LINE: &str = "%LINE%";

fn def(id: &str) -> Option<&'static Def> {
    DEFS.iter().find(|d| d.id == id)
}

/// Všetky nainštalované editory v poradí zoznamu DEFS.
pub fn detect() -> Vec<Found> {
    let mut found = platform_detect();
    found.sort_by_key(|f| DEFS.iter().position(|d| d.id == f.id));
    found.dedup_by(|a, b| a.id == b.id);
    found
}

#[cfg(windows)]
fn platform_detect() -> Vec<Found> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    const UNINSTALL_32: &str = r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";
    let roots = [
        (HKEY_CURRENT_USER, UNINSTALL),
        (HKEY_LOCAL_MACHINE, UNINSTALL),
        (HKEY_LOCAL_MACHINE, UNINSTALL_32),
    ];
    let mut found = Vec::new();
    for (hive, path) in roots {
        let Ok(list) = RegKey::predef(hive).open_subkey_with_flags(path, KEY_READ) else { continue };
        for name in list.enum_keys().flatten() {
            let Ok(key) = list.open_subkey_with_flags(&name, KEY_READ) else { continue };
            let get = |v: &str| key.get_value::<String, _>(v).unwrap_or_default();
            let entry = UninstallEntry {
                name: get("DisplayName"),
                publisher: get("Publisher"),
                location: get("InstallLocation"),
                icon: get("DisplayIcon"),
            };
            if let Some(f) = match_entry(&entry) {
                found.push(f);
            }
        }
    }
    found
}

#[cfg_attr(not(windows), allow(dead_code))] // volá ho len Windows; testy bežia všade
struct UninstallEntry {
    name: String,
    publisher: String,
    location: String,
    icon: String,
}

/// Uninstall záznam → editor. Vyhrá najdlhšia zhoda názvu („… Code Insiders“ pred „… Code“).
#[cfg_attr(not(windows), allow(dead_code))] // volá ho len Windows; testy bežia všade
fn match_entry(e: &UninstallEntry) -> Option<Found> {
    let d = match_def(e)?;
    let exe = win_exe(d, e)?;
    Some(Found { id: d.id.into(), label: d.label.into(), path: exe.to_string_lossy().into_owned() })
}

#[cfg_attr(not(windows), allow(dead_code))] // volá ho len Windows; testy bežia všade
fn match_def(e: &UninstallEntry) -> Option<&'static Def> {
    DEFS.iter()
        .filter(|d| d.win_publishers.is_empty() || d.win_publishers.contains(&e.publisher.trim()))
        .filter_map(|d| d.win_names.iter().filter(|n| e.name.starts_with(**n)).map(|n| n.len()).max().map(|l| (d, l)))
        .max_by_key(|(_, l)| *l)
        .map(|(d, _)| d)
}

/// Exe z DisplayIcon (ak sa volá ako editor), inak InstallLocation + známa relatívna cesta.
#[cfg_attr(not(windows), allow(dead_code))] // volá ho len Windows; testy bežia všade
fn win_exe(d: &Def, e: &UninstallEntry) -> Option<PathBuf> {
    let icon = e.icon.split(',').next().unwrap_or("").trim().trim_matches('"');
    let file_names: Vec<&str> = d.win_exe.iter().map(|p| p.rsplit('/').next().unwrap_or(p)).collect();
    let mut candidates = Vec::new();
    if !icon.is_empty() {
        let icon = PathBuf::from(icon);
        let name = icon.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
        if file_names.iter().any(|f| f.to_lowercase() == name) {
            candidates.push(icon);
        }
    }
    let location = e.location.trim().trim_matches('"');
    if !location.is_empty() {
        candidates.extend(d.win_exe.iter().map(|rel| Path::new(location).join(rel)));
    }
    candidates.into_iter().find(|p| p.is_file())
}

#[cfg(target_os = "macos")]
fn platform_detect() -> Vec<Found> {
    let mut found = Vec::new();
    for d in DEFS {
        for bundle in d.mac_bundles {
            // Bundle ID je konštanta z DEFS, do dotazu sa nedostane nič od používateľa.
            let query = format!("kMDItemCFBundleIdentifier == '{bundle}'");
            let Ok(out) = Command::new("mdfind").arg(query).output() else { continue };
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(app) = text.lines().find(|l| l.ends_with(".app") && Path::new(l).is_dir()) {
                found.push(Found { id: d.id.into(), label: d.label.into(), path: app.into() });
                break;
            }
        }
    }
    found
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_detect() -> Vec<Found> {
    DEFS.iter()
        .filter_map(|d| {
            let cmd = d.unix_cmds.iter().find_map(|c| in_path(c))?;
            Some(Found { id: d.id.into(), label: d.label.into(), path: cmd.to_string_lossy().into_owned() })
        })
        .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn in_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|p| p.is_file())
}

/// Argumenty pre známy editor. Cesta ide vždy ako samostatný argument.
fn family_args(family: Family, path: &str, line: Option<u32>) -> Vec<String> {
    match (family, line) {
        (Family::VsCode, Some(l)) => vec!["-g".into(), format!("{path}:{l}")],
        (Family::JetBrains, Some(l)) => vec!["--line".into(), l.to_string(), path.into()],
        (Family::Colon, Some(l)) => vec![format!("{path}:{l}")],
        (Family::NotepadPlusPlus, Some(l)) => vec![format!("-n{l}"), path.into()],
        (_, None) => vec![path.into()],
    }
}

/// Rozdelí argumenty vlastného editora (úvodzovky držia medzery) a dosadí cestu a riadok.
/// Bez `%TARGET_PATH%` sa cesta pridá na koniec.
pub fn custom_args(template: &str, path: &str, line: Option<u32>) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut any = false;
    for c in template.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                any = true;
            }
            c if c.is_whitespace() && !quoted => {
                if any {
                    tokens.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            c => {
                cur.push(c);
                any = true;
            }
        }
    }
    if any {
        tokens.push(cur);
    }
    if !tokens.iter().any(|t| t.contains(TARGET_PATH)) {
        tokens.push(TARGET_PATH.into());
    }
    let line = line.unwrap_or(1).to_string();
    tokens.into_iter().map(|t| t.replace(TARGET_PATH, path).replace(LINE, &line)).collect()
}

/// Vlastný program musí byť spustiteľný bez shellu (na Windows .exe/.com, .cmd/.bat nie).
pub fn validate_custom(program: &str) -> Result<(), String> {
    let p = Path::new(program);
    if program.trim().is_empty() {
        return Err("editor.needProgram".into());
    }
    if cfg!(target_os = "macos") && program.ends_with(".app") && p.is_dir() {
        return Ok(());
    }
    if !p.is_file() {
        return Err(format!("editor.programMissing: {program}"));
    }
    if cfg!(windows) {
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if ext != "exe" && ext != "com" {
            return Err("editor.windowsExe".into());
        }
    }
    Ok(())
}

/// Program a argumenty pre výber používateľa. `installed` je výsledok `detect()`.
pub fn resolve(choice: &Choice, installed: &[Found], path: &str, line: Option<u32>) -> Result<(String, Vec<String>), String> {
    if choice.id == CUSTOM {
        validate_custom(&choice.custom_path)?;
        let args = custom_args(&choice.custom_args, path, line);
        return Ok(mac_app(&choice.custom_path, args));
    }
    let found = if choice.id.is_empty() {
        installed.first().ok_or("editor.noneInstalled")?
    } else {
        installed
            .iter()
            .find(|f| f.id == choice.id)
            .ok_or("editor.missing")?
    };
    let d = def(&found.id).ok_or("editor.unknown")?;
    let args = family_args(d.family, path, line);
    if cfg!(target_os = "macos") {
        let cli = Path::new(&found.path).join(d.mac_cli);
        if !d.mac_cli.is_empty() && cli.is_file() {
            return Ok((cli.to_string_lossy().into_owned(), args));
        }
        // Bez CLI sa súbor otvorí, ale na riadok neskočí.
        return Ok(mac_app(&found.path, vec![path.into()]));
    }
    Ok((found.path.clone(), args))
}

/// Na macOS sa `.app` spúšťa cez `open -a`.
fn mac_app(program: &str, args: Vec<String>) -> (String, Vec<String>) {
    if cfg!(target_os = "macos") && program.ends_with(".app") {
        let mut open = vec!["-a".to_owned(), program.to_owned()];
        open.extend(args);
        return ("open".into(), open);
    }
    (program.into(), args)
}

/// Spustí editor priamo, bez shellu.
pub fn launch(program: &str, args: &[String]) -> Result<(), String> {
    let command = || {
        let mut cmd = Command::new(program);
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd
    };
    #[cfg(windows)]
    let spawned = {
        use std::os::windows::process::CommandExt;
        // Editor nesmie patriť do Job Objectu aplikácie, inak by ho zatvorenie Project Desku zabilo.
        // Ak nás spustil iný job, ktorý odchod nepovolí, spustí sa normálne.
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        command().creation_flags(CREATE_BREAKAWAY_FROM_JOB).spawn().or_else(|_| command().spawn())
    };
    #[cfg(not(windows))]
    let spawned = command().spawn();
    let mut child = spawned.map_err(|e| format!("editor.launchFailed: {e}"))?;
    // Nech po editore neostane zombie proces.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, publisher: &str, location: &str, icon: &str) -> UninstallEntry {
        UninstallEntry { name: name.into(), publisher: publisher.into(), location: location.into(), icon: icon.into() }
    }

    #[test]
    fn line_arguments_per_family() {
        assert_eq!(family_args(Family::VsCode, "a.ts", Some(3)), ["-g", "a.ts:3"]);
        assert_eq!(family_args(Family::JetBrains, "a.ts", Some(3)), ["--line", "3", "a.ts"]);
        assert_eq!(family_args(Family::Colon, "a.ts", Some(3)), ["a.ts:3"]);
        assert_eq!(family_args(Family::NotepadPlusPlus, "a.ts", Some(3)), ["-n3", "a.ts"]);
        assert_eq!(family_args(Family::VsCode, r"C:\p", None), [r"C:\p"]);
    }

    #[test]
    fn custom_template() {
        assert_eq!(custom_args("", "a b.ts", None), ["a b.ts"]);
        assert_eq!(custom_args("%TARGET_PATH%", "a.ts", Some(4)), ["a.ts"]);
        assert_eq!(custom_args("-n%LINE% \"%TARGET_PATH%\"", "C:\\x y\\a.ts", Some(4)), ["-n4", "C:\\x y\\a.ts"]);
        assert_eq!(custom_args("--new-window", "a.ts", None), ["--new-window", "a.ts"]);
    }

    #[test]
    fn registry_entries_match_by_name_and_publisher() {
        let pick = |e: &UninstallEntry| match_def(e).map(|d| d.id);
        assert_eq!(pick(&entry("Cursor (User)", "Anysphere", "", "")), Some("cursor"));
        assert_eq!(pick(&entry("Cursor (User)", "Someone Else", "", "")), None);
        assert_eq!(pick(&entry("Microsoft Visual Studio Code (User)", "Microsoft Corporation", "", "")), Some("code"));
        assert_eq!(
            pick(&entry("Microsoft Visual Studio Code Insiders (User)", "Microsoft Corporation", "", "")),
            Some("code-insiders")
        );
        assert_eq!(pick(&entry("WebStorm 2025.2", "JetBrains s.r.o.", "", "")), Some("webstorm"));
    }

    #[test]
    fn exe_comes_from_display_icon_only_when_it_is_the_editor() {
        let dir = std::env::temp_dir().join(format!("pd-editors-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("Cursor.exe");
        std::fs::write(&exe, b"").unwrap();
        let cursor = def("cursor").unwrap();
        let e = entry("Cursor (User)", "Anysphere", "", &format!("\"{}\",0", exe.display()));
        assert_eq!(win_exe(cursor, &e), Some(exe.clone()));
        let uninstaller = entry("Cursor (User)", "Anysphere", &dir.to_string_lossy(), &dir.join("unins000.exe").to_string_lossy());
        assert_eq!(win_exe(cursor, &uninstaller), Some(exe));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Reálna detekcia na tomto počítači: `cargo test real_detect -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_detect() {
        for f in detect() {
            println!("{} | {} | {}", f.id, f.label, f.path);
        }
    }
}
