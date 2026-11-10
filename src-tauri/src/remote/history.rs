//! Kruhová história terminálového výstupu jednej session, len v pamäti.

/// Strop histórie na session.
pub const HISTORY_BYTES: usize = 1024 * 1024;

/// Súkromné polia môže implementácia zmeniť; verejné metódy nie.
pub struct History {
    cap: usize,
    text: String,
    truncated: bool,
}

impl History {
    pub fn new(cap: usize) -> Self {
        todo!()
    }

    /// Pridá výstup; pri prekročení `cap` zahodí najstarší text (nikdy nie uprostred znaku).
    pub fn push(&mut self, text: &str) {
        todo!()
    }

    /// Text na prehratie novému klientovi. Po orezaní začína `"\x1bc"` a textom od prvého `\n`.
    pub fn replay(&self) -> String {
        todo!()
    }
}
