//! Data-directory ownership, including desktops without a working session bus.
use std::fs::{self, File, TryLockError};
use std::io;
use std::path::Path;

/// Keep the OS lock until Tauri's final resource cleanup (also before relaunch).
/// Never delete the lock file: unlinking it could let another process lock a
/// different inode while the original owner is still writing state.
pub struct DataLock {
    _file: File,
}

impl tauri::Resource for DataLock {}

impl DataLock {
    pub fn acquire(config_dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(config_dir)?;
        let file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(config_dir.join("instance.lock"))?;
        match file.try_lock() {
            Ok(()) => Ok(Self { _file: file }),
            Err(TryLockError::WouldBlock) => Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "Project Desk is already using this data directory. Close the other instance before starting again.",
            )),
            Err(TryLockError::Error(error)) => Err(error),
        }
    }
}
