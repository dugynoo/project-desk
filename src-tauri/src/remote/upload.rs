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
/// Strop priečinka: pri prekročení sa mažú najstaršie obrázky.
const MAX_FILES: usize = 50;
const MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Priečinok pre obrázky z mobilu. Na Unixe môže byť dočasný priečinok spoločný (`/tmp`),
/// preto meno obsahuje UID a `private_dir` overí, že patrí nám a nik iný doň nevidí.
pub fn dir() -> PathBuf {
    #[cfg(unix)]
    // SAFETY: getuid nemá vstupy a nezlyhá.
    let name = format!("project-desk-remote-images-{}", unsafe { libc::getuid() });
    #[cfg(not(unix))]
    let name = "project-desk-remote-images".to_owned();
    std::env::temp_dir().join(name)
}

/// Vytvorí priečinok len pre seba; existujúci odmietne, ak je to symlink, patrí inému
/// používateľovi alebo doň vidia iní.
fn private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let meta = fs::symlink_metadata(dir)?;
    if !meta.is_dir() {
        return Err(std::io::Error::other("not a directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: getuid nemá vstupy a nezlyhá.
        if meta.uid() != unsafe { libc::getuid() } || meta.mode() & 0o077 != 0 {
            return Err(std::io::Error::other("directory is not private"));
        }
    }
    Ok(())
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
    private_dir(dir).map_err(|_| "remote.imageFailed")?;
    prune(dir);
    let path = dir.join(format!("{}.jpg", uuid::Uuid::new_v4().simple()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options.open(&path).and_then(|mut f| std::io::Write::write_all(&mut f, &bytes));
    if written.is_err() {
        let _ = fs::remove_file(&path);
        return Err("remote.imageFailed");
    }
    Ok(path)
}

/// Zmaže obrázky staršie ako `KEEP` a najstaršie nad strop počtu a veľkosti.
/// Volá sa pri nahratí aj pri zapnutí a vypnutí vzdialeného prístupu.
pub fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let images = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jpg"))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some((e.path(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len()))
        })
        .collect();
    for path in excess(images, SystemTime::now()) {
        let _ = fs::remove_file(path);
    }
}

/// Ktoré obrázky zmazať: príliš staré, a potom od najstarších, kým nesedí počet a veľkosť.
fn excess(mut images: Vec<(PathBuf, SystemTime, u64)>, now: SystemTime) -> Vec<PathBuf> {
    // Najnovšie prvé; nad stropom ostanú len tie, ktoré sa ešte zmestia.
    images.sort_by_key(|image| std::cmp::Reverse(image.1));
    let (mut count, mut bytes) = (0, 0);
    images
        .into_iter()
        .filter(|(_, modified, len)| {
            let old = now.duration_since(*modified).is_ok_and(|age| age > KEEP);
            let keep = !old && count < MAX_FILES && bytes + len <= MAX_BYTES;
            if keep {
                count += 1;
                bytes += len;
            }
            !keep
        })
        .map(|(path, ..)| path)
        .collect()
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
        std::env::temp_dir().join(format!("pd-upload-test-{}", uuid::Uuid::new_v4().simple()))
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_shared_or_symlinked_directory() {
        use std::os::unix::fs::PermissionsExt;
        let jpeg = b64(&[0xFF, 0xD8, 0xFF, 0xE0, 0xFF, 0xD9]);
        let open = temp();
        fs::create_dir(&open).unwrap();
        fs::set_permissions(&open, fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(save_image(&open, &jpeg), Err("remote.imageFailed"));
        let target = temp();
        fs::create_dir(&target).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
        let link = temp();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(save_image(&link, &jpeg), Err("remote.imageFailed"));
        let path = save_image(&target, &jpeg).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        fs::remove_dir_all(&open).unwrap();
        fs::remove_dir_all(&target).unwrap();
        fs::remove_file(link).unwrap();
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
        assert!(fs::read_dir(&d).map_or(true, |mut e| e.next().is_none()));
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn pastes_the_quoted_path_without_enter() {
        let p = Path::new("/tmp/it's here.jpg");
        let quoted = if cfg!(windows) { "'/tmp/it''s here.jpg' " } else { "'/tmp/it'\\''s here.jpg' " };
        assert_eq!(paste_for(p).unwrap(), format!("\x1b[200~{quoted}\x1b[201~"));
        assert_eq!(paste_for(Path::new("/tmp/a\x1b[201~b.jpg")), None);
    }

    #[test]
    fn prune_drops_old_images_then_the_oldest_over_the_caps() {
        let now = SystemTime::now();
        let at = |secs: u64| now - Duration::from_secs(secs);
        let mut images: Vec<_> = (0..MAX_FILES as u64 + 3).map(|i| (PathBuf::from(format!("{i}.jpg")), at(i), 1)).collect();
        images.push(("stale.jpg".into(), at(KEEP.as_secs() + 1), 1));
        let mut gone = excess(images, now);
        gone.sort();
        let mut expected: Vec<PathBuf> = (MAX_FILES as u64..MAX_FILES as u64 + 3).map(|i| format!("{i}.jpg").into()).collect();
        expected.push("stale.jpg".into());
        expected.sort();
        assert_eq!(gone, expected);
        let big = vec![("new.jpg".into(), at(1), MAX_BYTES - 10), ("older.jpg".into(), at(2), 20)];
        assert_eq!(excess(big, now), vec![PathBuf::from("older.jpg")]);
    }
}
