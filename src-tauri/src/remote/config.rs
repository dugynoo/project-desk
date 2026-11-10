//! Párovací token v `<app_config_dir>/remote.json` (`{"token": "..."}`), nikdy v `state.json`.

use std::io;
use std::path::Path;

pub fn load_or_create_token(dir: &Path) -> io::Result<String> {
    todo!()
}

/// Vygeneruje a uloží nový token (staré zariadenia stratia prístup).
pub fn new_token(dir: &Path) -> io::Result<String> {
    todo!()
}
