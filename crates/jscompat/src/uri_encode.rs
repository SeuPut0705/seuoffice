//! `encodeURIComponent`.

/// `encodeURIComponent(text)` over a Rust string, which holds no lone
/// surrogate, so it never throws: every UTF-8 byte but a letter, a digit and
/// `-_.!~*'()` becomes `%XX` in upper-case hex.
pub fn encode_uri_component(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push('%');
            out.push(char::from(HEX[usize::from(byte >> 4)]));
            out.push(char::from(HEX[usize::from(byte & 15)]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::encode_uri_component;

    #[test]
    fn encodes_like_javascript() {
        assert_eq!(encode_uri_component("a b&c/d"), "a%20b%26c%2Fd");
        assert_eq!(encode_uri_component("\u{e9}"), "%C3%A9");
        assert_eq!(encode_uri_component("\u{1F600}"), "%F0%9F%98%80");
        assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
    }
}
