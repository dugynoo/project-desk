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

    /// Pridá výstup; najstarší text zahodí (nikdy nie uprostred znaku) až nad 2× `cap`,
    /// aby sa pri plnej histórii neposúval celý buffer pri každom kúsku.
    pub fn push(&mut self, text: &str) {
        self.text.push_str(text);
        if self.text.len() > self.cap.saturating_mul(2) {
            let cut = self.start();
            self.text.drain(..cut);
            self.truncated = true;
        }
    }

    /// Začiatok posledných najviac `cap` bajtov na hranici znaku.
    fn start(&self) -> usize {
        let mut cut = self.text.len().saturating_sub(self.cap);
        while !self.text.is_char_boundary(cut) {
            cut += 1;
        }
        cut
    }

    /// Text na prehratie novému klientovi (najviac `cap` bajtov). Po orezaní začína `"\x1bc"` a textom od prvého `\n`.
    pub fn replay(&self) -> String {
        let start = self.start();
        let view = &self.text[start..];
        if !self.truncated && start == 0 {
            return view.to_owned();
        }
        // Začiatok je zvyčajne uprostred riadku, preto ho zahodíme po prvý \n;
        // ak žiadny nie je (TUI s kurzorom), vrátime celý zvyšok.
        let rest = view.split_once('\n').map_or(view, |(_, r)| r);
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
    fn trimming_is_amortized() {
        let mut h = History::new(10);
        h.push(&"x".repeat(15));
        // Do 2× cap sa nič neposúva; replay aj tak vráti najviac cap.
        assert_eq!(h.text.len(), 15);
        h.push(&"y".repeat(6));
        assert_eq!(h.text.len(), 10);
    }

    #[test]
    fn many_small_pushes_replay_input_tail() {
        let mut h = History::new(64);
        let mut input = String::new();
        for i in 0..1000 {
            let chunk = format!("{i}é,");
            input.push_str(&chunk);
            h.push(&chunk);
            let r = h.replay();
            let body = r.strip_prefix("\x1bc").unwrap_or(&r);
            assert!(body.len() <= 64, "{}", body.len());
            assert!(input.ends_with(body));
        }
        assert!(h.replay().starts_with("\x1bc"));
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
