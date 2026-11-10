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
        todo!()
    }

    /// Desktop si veľkosť vzal späť (`pty_resize` z okna).
    pub fn desktop(&mut self, id: &str) {
        todo!()
    }

    pub fn forget(&mut self, id: &str) {
        todo!()
    }
}
