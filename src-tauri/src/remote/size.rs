//! Kto určuje veľkosť PTY: zariadenie, ktoré session naposledy aktívne použilo.

use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    Desktop,
    Remote { cols: u16, rows: u16 },
}

#[derive(Default)]
pub struct SizeArbiter {
    owners: HashMap<String, Owner>,
}

impl SizeArbiter {
    /// Mobil si nárokuje veľkosť. `true` = treba zmeniť PTY a oznámiť desktopu (`SizeTaken`).
    pub fn remote(&mut self, id: &str, cols: u16, rows: u16) -> bool {
        let next = Owner::Remote { cols, rows };
        self.owners.insert(id.to_string(), next) != Some(next)
    }

    /// Desktop si veľkosť vzal späť (`pty_resize` z okna).
    pub fn desktop(&mut self, id: &str) {
        self.owners.insert(id.to_string(), Owner::Desktop);
    }

    pub fn forget(&mut self, id: &str) {
        self.owners.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_remote_claim_resizes() {
        let mut s = SizeArbiter::default();
        assert!(s.remote("a", 40, 20));
    }

    #[test]
    fn same_remote_size_is_noop() {
        let mut s = SizeArbiter::default();
        assert!(s.remote("a", 40, 20));
        assert!(!s.remote("a", 40, 20));
    }

    #[test]
    fn desktop_reclaim_then_remote_resizes_again() {
        let mut s = SizeArbiter::default();
        s.remote("a", 40, 20);
        s.desktop("a");
        assert!(s.remote("a", 40, 20));
    }

    #[test]
    fn forget_clears_owner() {
        let mut s = SizeArbiter::default();
        s.remote("a", 40, 20);
        s.forget("a");
        assert!(s.remote("a", 40, 20));
    }
}
