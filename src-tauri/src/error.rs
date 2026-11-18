//! Errors cross IPC as `code` or `code: detail`; the frontend shows the `err.<code>` translation
//! (`errorText` in src/i18n.ts) and falls back to the raw text only for unknown codes.
use std::fmt::Display;

/// `code: detail`, for errors whose cause is worth showing next to the translated text.
pub fn with(code: &'static str, detail: impl Display) -> String {
    format!("{code}: {detail}")
}

/// Unexpected internal failures (a poisoned lock, a failed background task, no home folder).
pub fn internal(detail: impl Display) -> String {
    with("app.internal", detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_match_the_frontend_code_pattern() {
        // Same shape as `errorText` in src/i18n.ts.
        let code = |s: &str| s.split_once(": ").map_or(s, |(c, _)| c).to_owned();
        for e in [internal("join error: x"), with("pty.resizeFailed", "Access is denied.")] {
            let c = code(&e);
            let (prefix, name) = c.split_once('.').unwrap();
            assert!(prefix.bytes().all(|b| b.is_ascii_lowercase()) && name.bytes().all(|b| b.is_ascii_alphabetic()), "{e}");
        }
    }
}
