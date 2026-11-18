//! Crash-safe file replacement shared by every file the app owns.
use std::fs;
use std::io::{self, Write};
use std::path::Path;

/// Writes `bytes` to a unique temporary file beside `path`, flushes it to disk and renames
/// it over `path`, so readers see either the old or the new file, never a truncated one.
/// `private` restricts the file to its owner on Unix (tokens, endpoints).
pub fn atomic_write(path: &Path, bytes: &[u8], private: bool) -> io::Result<()> {
    let name = path.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let tmp = path.with_file_name(format!(".{}.{}.tmp", name.to_string_lossy(), uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if private { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        #[cfg(not(unix))]
        let _ = private;
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        // Replaces an existing target on Windows too (MoveFileEx with REPLACE_EXISTING).
        fs::rename(&tmp, path)?;
        // Make the rename itself durable; directories cannot be opened like this on Windows.
        #[cfg(unix)]
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) { fs::File::open(dir)?.sync_all()?; }
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&tmp); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_the_target_and_leaves_no_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        atomic_write(&path, b"one", false).unwrap();
        atomic_write(&path, b"two", true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn a_failed_write_keeps_the_old_file_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("target");
        fs::create_dir(&path).unwrap(); // renaming a file over a directory fails
        assert!(atomic_write(&path, b"x", false).is_err());
        assert!(path.is_dir());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn private_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("endpoint.json");
        atomic_write(&path, b"{}", true).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
