//! Párovací token v `<app_config_dir>/remote.json` (`{"token": "..."}`), nikdy v `state.json`.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

const FILE: &str = "remote.json";

#[derive(Serialize, Deserialize)]
struct Stored {
    token: String,
}

fn valid(token: &str) -> bool {
    token.len() >= 32 && token.bytes().all(|b| b.is_ascii_alphanumeric())
}

pub fn load_or_create_token(dir: &Path) -> io::Result<String> {
    match fs::read_to_string(dir.join(FILE)) {
        Ok(text) => {
            // Poškodený súbor nahradíme novým tokenom; spárované zariadenia sa spárujú znova.
            if let Ok(Stored { token }) = serde_json::from_str(&text) {
                if valid(&token) {
                    return Ok(token);
                }
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    new_token(dir)
}

/// Vygeneruje a uloží nový token (staré zariadenia stratia prístup).
pub fn new_token(dir: &Path) -> io::Result<String> {
    // 2 × 122 náhodných bitov, len [0-9a-f]: bezpečné v URL fragmente aj v `Sec-WebSocket-Protocol`.
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    fs::create_dir_all(dir)?;
    let path = dir.join(FILE);
    let tmp = path.with_extension("json.tmp");
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&tmp)?;
        file.write_all(serde_json::to_string(&Stored { token: token.clone() })?.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map(|_| token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_persists_and_rotates() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_token(dir.path()).unwrap();
        assert!(first.len() >= 32);
        assert_eq!(load_or_create_token(dir.path()).unwrap(), first);
        let second = new_token(dir.path()).unwrap();
        assert_ne!(second, first);
        assert_eq!(load_or_create_token(dir.path()).unwrap(), second);
    }

    #[test]
    fn corrupt_file_gets_a_new_token() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("remote.json"), "nie json").unwrap();
        let token = load_or_create_token(dir.path()).unwrap();
        assert!(token.len() >= 32);
        assert_eq!(load_or_create_token(dir.path()).unwrap(), token);
    }
}
