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
        Self { cap, text: String::new(), truncated: false }
    }

    /// Pridá výstup; pri prekročení `cap` zahodí najstarší text (nikdy nie uprostred znaku).
    pub fn push(&mut self, text: &str) {
        self.text.push_str(text);
        if self.text.len() > self.cap {
            let mut cut = self.text.len() - self.cap;
            while !self.text.is_char_boundary(cut) {
                cut += 1;
            }
            self.text.drain(..cut);
            self.truncated = true;
        }
    }

    /// Text na prehratie novému klientovi. Po orezaní začína `"\x1bc"` a textom od prvého `\n`.
    pub fn replay(&self) -> String {
        if !self.truncated {
            return self.text.clone();
        }
        // Začiatok je zvyčajne uprostred riadku, preto ho zahodíme po prvý \n;
        // ak žiadny nie je (TUI s kurzorom), vrátime celý zvyšok.
        let rest = self.text.split_once('\n').map_or(self.text.as_str(), |(_, r)| r);
        format!("\x1bc{rest}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_within_cap_replays_everything() {
        let mut h = History::new(100);
        h.push("ab");
        h.push("cd");
        assert_eq!(h.replay(), "abcd");
    }

    #[test]
    fn overflow_drops_oldest_and_resets_terminal() {
        let mut h = History::new(10);
        h.push("line1\nline2\nline3\n");
        let r = h.replay();
        assert!(r.starts_with("\x1bc"));
        let body = &r[2..];
        assert!(body.ends_with("line3\n"));
        assert!(body.len() <= 10);
        assert!(!body.contains("line1"));
    }

    #[test]
    fn overflow_never_splits_utf8() {
        let mut h = History::new(8);
        // 5 x 3 bajty; rez pripadne doprostred znaku
        h.push(&"é\n".repeat(5));
        let r = h.replay();
        let body = r.strip_prefix("\x1bc").unwrap();
        assert!(!body.is_empty());
        assert!(!body.contains('\u{FFFD}'));
        assert!(body.len() <= 8);
        assert!(body.chars().all(|c| c == 'é' || c == '\n'));
    }

    #[test]
    fn overflow_without_newline_keeps_text() {
        let mut h = History::new(10);
        let input = "abcdefghij".repeat(3);
        h.push(&input);
        let r = h.replay();
        let body = r.strip_prefix("\x1bc").unwrap();
        assert!(!body.is_empty());
        assert!(body.len() <= 10);
        assert!(input.ends_with(body));
    }
}
