//! Bounded UTF-8 editing; never truncate the original before a successful write.
use std::{fs, io::{Read, Write}, path::Path, sync::Mutex};
const LIMIT: usize = 2 * 1024 * 1024;
static WRITES: Mutex<()> = Mutex::new(());

#[derive(serde::Serialize)]
pub struct Document { path: String, text: String }
fn failure(e: impl std::fmt::Display) -> String { format!("file.editFailed: {e}") }
fn read(path: &Path) -> Result<String, String> {
    let initial = fs::metadata(path).map_err(failure)?;
    if !initial.is_file() || initial.len() > LIMIT as u64 { return Err("file.textOnly".into()); }
    let file = fs::File::open(path).map_err(failure)?;
    let meta = file.metadata().map_err(failure)?;
    if !meta.is_file() || meta.len() > LIMIT as u64 { return Err("file.textOnly".into()); }
    let mut bytes = Vec::new();
    file.take((LIMIT + 1) as u64).read_to_end(&mut bytes).map_err(failure)?;
    if bytes.len() > LIMIT || bytes.contains(&0) { return Err("file.textOnly".into()); }
    String::from_utf8(bytes).map_err(|_| "file.textOnly".into())
}
pub fn open(path: &str) -> Result<Document, String> {
    if !Path::new(path).is_absolute() { return Err("file.textOnly".into()); }
    let path = fs::canonicalize(path).map_err(failure)?;
    let text = read(&path)?;
    Ok(Document { path: path.to_string_lossy().into_owned(), text })
}
pub fn save(path: &str, expected: &str, text: &str) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(failure)?;
    let path = Path::new(path);
    if !path.is_absolute() || text.len() > LIMIT || text.contains('\0') || expected.len() > LIMIT {
        return Err("file.textOnly".into());
    }
    // Reject replacement with a symlink after opening instead of writing another target.
    let meta = fs::symlink_metadata(path).map_err(failure)?;
    if !meta.is_file() || meta.permissions().readonly() { return Err("file.editFailed: File is not writable".into()); }
    // Atomic replacement would silently break hard-linked instruction files.
    #[cfg(unix)]
    { use std::os::unix::fs::MetadataExt;
      if meta.nlink() > 1 { return Err("file.linked".into()); }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
        let file = fs::File::open(path).map_err(failure)?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(failure(std::io::Error::last_os_error()));
        }
        if info.nNumberOfLinks > 1 { return Err("file.linked".into()); }
    }
    if read(path)? != expected { return Err("file.conflict".into()); }
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("file.textOnly")?).map_err(failure)?;
    temp.write_all(text.as_bytes()).map_err(failure)?;
    temp.as_file().set_permissions(meta.permissions()).map_err(failure)?;
    temp.as_file().sync_all().map_err(failure)?;
    if !fs::symlink_metadata(path).map_err(failure)?.is_file() { return Err("file.conflict".into()); }
    if read(path)? != expected { return Err("file.conflict".into()); }
    temp.persist(path).map_err(failure)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn save_preserves_bytes_and_refuses_external_changes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("notes.txt"); let p = p.to_str().unwrap();
        fs::write(p, "\u{feff}hello\r\n").unwrap();
        let doc = open(p).unwrap();
        save(p, &doc.text, "\u{feff}world\r\n").unwrap();
        assert_eq!(fs::read_to_string(p).unwrap(), "\u{feff}world\r\n");
        assert_eq!(save(p, &doc.text, "lost").unwrap_err(), "file.conflict");
        assert_eq!(fs::read_to_string(p).unwrap(), "\u{feff}world\r\n");
    }
    #[test]
    fn rejects_binary_invalid_utf8_large_and_missing_files() {
        let dir = tempfile::tempdir().unwrap(); let p = dir.path().join("file"); let p = p.to_str().unwrap();
        for bytes in [vec![0], vec![255], vec![b'a'; LIMIT + 1]] {
            fs::write(p, bytes).unwrap(); assert!(open(p).is_err());
        }
        assert!(open("relative").is_err());
        assert!(open(dir.path().to_str().unwrap()).is_err());
    }
    #[test]
    fn refuses_to_break_hard_links() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("original"); let alias = dir.path().join("alias");
        fs::write(&p, "original").unwrap();
        fs::hard_link(&p, &alias).unwrap();
        assert_eq!(save(p.to_str().unwrap(), "original", "new").unwrap_err(), "file.linked");
        assert_eq!(fs::read_to_string(alias).unwrap(), "original");
    }
}
