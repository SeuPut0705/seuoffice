//! `atob`.

/// The `InvalidCharacterError` `atob` throws, with its message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidCharacterError(pub &'static str);

impl std::fmt::Display for InvalidCharacterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for InvalidCharacterError {}

const INVALID_CHARACTER: InvalidCharacterError = InvalidCharacterError("Invalid character");
const NOT_CORRECTLY_ENCODED: InvalidCharacterError =
    InvalidCharacterError("The string to be decoded is not correctly encoded.");

/// `atob(text)` as Node answers it, the forgiving-base64 decode of the
/// Infra standard: ASCII white space (tab, LF, FF, CR, space) skipped, at
/// most two `=` and only at the end, and only where they pad a group of
/// four; the bits after the last whole byte dropped. The result is the
/// bytes, each one char code of the Latin-1 string `atob` returns.
pub fn atob(text: &str) -> Result<Vec<u8>, InvalidCharacterError> {
    let mut sextets: Vec<u8> = Vec::with_capacity(text.len());
    let mut significant = 0usize;
    let mut equals = 0usize;
    for c in text.chars() {
        if matches!(c, '\t' | '\n' | '\u{0C}' | '\r' | ' ') {
            continue;
        }
        significant += 1;
        let sextet = match c {
            'A'..='Z' => c as u8 - b'A',
            'a'..='z' => c as u8 - b'a' + 26,
            '0'..='9' => c as u8 - b'0' + 52,
            '+' => 62,
            '/' => 63,
            '=' => {
                equals += 1;
                if equals > 2 {
                    return Err(INVALID_CHARACTER);
                }
                continue;
            }
            _ => return Err(INVALID_CHARACTER),
        };
        if equals > 0 {
            return Err(INVALID_CHARACTER);
        }
        sextets.push(sextet);
    }
    let mut remainder = significant % 4;
    if remainder == 0 {
        remainder = (significant - equals) % 4;
    } else if equals > 0 {
        return Err(INVALID_CHARACTER);
    }
    if remainder == 1 {
        return Err(NOT_CORRECTLY_ENCODED);
    }
    let mut out = Vec::with_capacity(sextets.len() * 3 / 4);
    let mut bits = 0u32;
    let mut held = 0u32;
    for sextet in sextets {
        bits = (bits << 6 | u32::from(sextet)) & 0xFFFF;
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push((bits >> held) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The expected values are what Node answers (taken on Node 24.22.1; the
    // forgiving-base64 rules have not changed since Node 22).

    #[test]
    fn decodes_padded_unpadded_and_spaced_text() {
        let cases: [(&str, &[u8]); 15] = [
            ("", &[]),
            ("YQ==", &[97]),
            ("YQ", &[97]),
            (" Y Q = = ", &[97]),
            ("Y\tQ\n=\u{0C}=\r", &[97]),
            ("YQ= =", &[97]),
            ("YQ==\n", &[97]),
            ("YR==", &[97]),
            ("AAAA", &[0, 0, 0]),
            ("4pyT", &[226, 156, 147]),
            ("77u/YQ==", &[239, 187, 191, 97]),
            ("/w==", &[255]),
            ("8J+YgA==", &[240, 159, 152, 128]),
            ("YWJjZA", &[97, 98, 99, 100]),
            ("YWJjZA==", &[97, 98, 99, 100]),
        ];
        for (text, bytes) in cases {
            assert_eq!(atob(text), Ok(bytes.to_vec()), "{text:?}");
        }
    }

    #[test]
    fn throws_where_node_throws() {
        let invalid = [
            "YQ=",
            "YQ===",
            "YQ=a",
            "Y\u{A0}Q",
            "Y\u{0B}Q",
            "_-",
            "YWJjZA=",
            "YWJjZA===",
            "=",
            "==",
            "Y=Q=",
            "A===",
            "ab\u{E9}",
            "YWJjZA==YQ==",
        ];
        for text in invalid {
            assert_eq!(atob(text), Err(INVALID_CHARACTER), "{text:?}");
        }
        for text in ["Y", "AAAAA"] {
            assert_eq!(atob(text), Err(NOT_CORRECTLY_ENCODED), "{text:?}");
        }
        assert_eq!(INVALID_CHARACTER.to_string(), "Invalid character");
    }
}
