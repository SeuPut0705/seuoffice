/// What `decodeURIComponent` throws: a `%` that does not start an escape, or
/// escapes that are not the UTF-8 form of one character.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UriError;

impl std::fmt::Display for UriError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("URI malformed")
    }
}

impl std::error::Error for UriError {}

/// `decodeURIComponent(text)`
pub fn decode_uri_component(text: &str) -> Result<String, UriError> {
    fn escaped_byte(bytes: &[u8], at: usize) -> Result<u8, UriError> {
        let digit = |index: usize| {
            bytes
                .get(index)
                .and_then(|byte| char::from(*byte).to_digit(16))
                .ok_or(UriError)
        };
        if bytes.get(at) != Some(&b'%') {
            return Err(UriError);
        }
        Ok((digit(at + 1)? * 16 + digit(at + 2)?) as u8)
    }

    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    let mut copied = 0;
    while let Some(percent) = text[at..].find('%').map(|found| at + found) {
        out.push_str(&text[copied..percent]);
        let first = escaped_byte(bytes, percent)?;
        let length = match first {
            0x00..=0x7f => 1,
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return Err(UriError),
        };
        let mut sequence = [first, 0, 0, 0];
        for (index, byte) in sequence.iter_mut().enumerate().take(length).skip(1) {
            *byte = escaped_byte(bytes, percent + 3 * index)?;
        }
        // overlong forms, surrogates and values past U+10FFFF are refused
        out.push_str(std::str::from_utf8(&sequence[..length]).map_err(|_| UriError)?);
        at = percent + 3 * length;
        copied = at;
    }
    out.push_str(&text[copied..]);
    Ok(out)
}

/// Standard base64 with padding: `btoa` over bytes.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let value = group
            .iter()
            .fold(0u32, |value, byte| value << 8 | u32::from(*byte))
            << (8 * (3 - group.len()));
        for index in 0..4 {
            if index <= group.len() {
                out.push(char::from(
                    ALPHABET[(value >> (18 - 6 * index) & 63) as usize],
                ));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // The expected values are what Node 22 answers.

    #[test]
    fn escapes_decode_as_utf8() {
        assert_eq!(decode_uri_component("a%20b").as_deref(), Ok("a b"));
        assert_eq!(
            decode_uri_component("%ED%95%9C%EA%B8%80.xml").as_deref(),
            Ok("\u{d55c}\u{ae00}.xml")
        );
        assert_eq!(
            decode_uri_component("%F0%9F%98%80").as_deref(),
            Ok("\u{1f600}")
        );
        assert_eq!(decode_uri_component("%2f%2F%25").as_deref(), Ok("//%"));
        assert_eq!(
            decode_uri_component("\u{e9}%41+").as_deref(),
            Ok("\u{e9}A+")
        );
        assert_eq!(decode_uri_component("").as_deref(), Ok(""));
    }

    #[test]
    fn what_is_not_an_escaped_character_is_an_error() {
        for malformed in [
            "%",
            "%4",
            "%zz",
            "100%",
            "%E0%A4%A",
            "%C3",
            "%C3x",
            "%80",
            "%C0%AF",
            "%ED%A0%80",
            "%F8%80%80%80",
            "%F4%90%80%80",
            "%C3%28",
            "%E2%82",
        ] {
            assert_eq!(
                decode_uri_component(malformed),
                Err(UriError),
                "{malformed}"
            );
        }
    }

    #[test]
    fn base64_pads_the_last_group() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(&[0xfb, 0xff, 0xfe]), "+//+");
    }
}
