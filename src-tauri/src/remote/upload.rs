//! Obrázok z mobilu: uloží sa do dočasného priečinka a agentovi sa vloží jeho cesta
//! ako pri pretiahnutí súboru na desktope (Claude Code aj Codex z nej spravia prílohu).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::Engine;

/// Mobil obrázok zmenší a pošle ako JPEG; väčší sa odmietne.
pub const MAX_IMAGE: usize = 1536 * 1024;
/// Staršie obrázky sa pri ďalšom nahratí zmažú; agent si súbor prečíta pri vložení či odoslaní.
const KEEP: Duration = Duration::from_secs(24 * 60 * 60);

/// Priečinok pre obrázky z mobilu.
pub fn dir() -> PathBuf {
    std::env::temp_dir().join("project-desk-remote-images")
}

/// Overí JPEG v base64, uloží ho pod náhodným menom a vráti cestu. Chyby sú kódy pre `err.*`.
pub fn save_image(dir: &Path, data: &str) -> Result<PathBuf, &'static str> {
    if data.len() > MAX_IMAGE / 3 * 4 + 4 {
        return Err("remote.imageTooLarge");
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "remote.imageInvalid")?;
    if bytes.len() > MAX_IMAGE {
        return Err("remote.imageTooLarge");
    }
    // JPEG začína SOI + markerom a končí EOI.
    if bytes.len() < 4 || bytes[..3] != [0xFF, 0xD8, 0xFF] || bytes[bytes.len() - 2..] != [0xFF, 0xD9] {
        return Err("remote.imageInvalid");
    }
    fs::create_dir_all(dir).map_err(|_| "remote.imageFailed")?;
    prune(dir);
    let path = dir.join(format!("{}.jpg", uuid::Uuid::new_v4().simple()));
    fs::write(&path, &bytes).map_err(|_| "remote.imageFailed")?;
    Ok(path)
}

fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "jpg") {
            continue;
        }
        let old = entry.metadata().and_then(|m| m.modified()).ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > KEEP);
        if old {
            let _ = fs::remove_file(path);
        }
    }
}

/// Bracketed paste cesty v apostrofoch s medzerou na konci, rovnako ako `droppedFilePaths`
/// pri pretiahnutí na desktope. Bez Enteru.
pub fn paste_for(path: &Path) -> Option<String> {
    let path = path.to_str()?;
    if path.chars().any(|c| c.is_control()) {
        return None;
    }
    let quoted = if cfg!(windows) { path.replace('\'', "''") } else { path.replace('\'', "'\\''") };
    Some(format!("\x1b[200~'{quoted}' \x1b[201~"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn temp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("pd-upload-test-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn saves_a_jpeg_under_a_random_name() {
        let d = temp();
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 0xFF, 0xD9];
        let path = save_image(&d, &b64(&jpeg)).unwrap();
        assert_eq!(path.parent(), Some(d.as_path()));
        assert_eq!(path.extension().unwrap(), "jpg");
        assert_eq!(fs::read(&path).unwrap(), jpeg);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn rejects_other_files_bad_base64_and_large_images() {
        let d = temp();
        assert_eq!(save_image(&d, &b64(b"\x89PNG\r\n\x1a\n")), Err("remote.imageInvalid"));
        assert_eq!(save_image(&d, &b64(b"#!/bin/sh\nrm -rf ~\n")), Err("remote.imageInvalid"));
        assert_eq!(save_image(&d, "not base64!"), Err("remote.imageInvalid"));
        let mut big = vec![0u8; MAX_IMAGE + 1];
        big[..3].copy_from_slice(&[0xFF, 0xD8, 0xFF]);
        assert_eq!(save_image(&d, &b64(&big)), Err("remote.imageTooLarge"));
        assert_eq!(fs::read_dir(&d).unwrap().count(), 0);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn pastes_the_quoted_path_without_enter() {
        let p = Path::new("/tmp/it's here.jpg");
        let quoted = if cfg!(windows) { "'/tmp/it''s here.jpg' " } else { "'/tmp/it'\\''s here.jpg' " };
        assert_eq!(paste_for(p).unwrap(), format!("\x1b[200~{quoted}\x1b[201~"));
        assert_eq!(paste_for(Path::new("/tmp/a\x1b[201~b.jpg")), None);
    }
}
