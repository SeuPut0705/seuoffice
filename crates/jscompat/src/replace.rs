//! `String.prototype.replace` with a string replacement.

/// GetSubstitution: the replacement patterns `$$`, `$&`, `` $` ``, `$'`,
/// `$n` and `$nn` of `template`, for a match `matched` at byte `position` of
/// `text` with the capture `groups` (absent ones `None`).
pub fn get_substitution(
    template: &str,
    matched: &str,
    position: usize,
    text: &str,
    groups: &[Option<&str>],
) -> String {
    let bytes = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'$' || i + 1 >= bytes.len() {
            i += 1;
            continue;
        }
        let next = bytes[i + 1];
        let (piece, used): (Option<&str>, usize) = match next {
            b'$' => (Some("$"), 2),
            b'&' => (Some(matched), 2),
            b'`' => (Some(&text[..position]), 2),
            b'\'' => (Some(&text[(position + matched.len()).min(text.len())..]), 2),
            b'0'..=b'9' => {
                let one = usize::from(next - b'0');
                let two = bytes
                    .get(i + 2)
                    .filter(|d| d.is_ascii_digit())
                    .map(|d| one * 10 + usize::from(d - b'0'));
                match two {
                    Some(nn) if nn >= 1 && nn <= groups.len() => {
                        (Some(groups[nn - 1].unwrap_or("")), 3)
                    }
                    _ if one >= 1 && one <= groups.len() => {
                        (Some(groups[one - 1].unwrap_or("")), 2)
                    }
                    _ => (None, 0),
                }
            }
            _ => (None, 0),
        };
        match piece {
            Some(piece) => {
                out.push_str(&template[copied..i]);
                out.push_str(piece);
                i += used;
                copied = i;
            }
            None => i += 1,
        }
    }
    out.push_str(&template[copied..]);
    out
}

/// `text.replace(needle, replacement)` with a string `needle`: the first
/// occurrence only, the replacement patterns applied.
pub fn replace_first_string(text: &str, needle: &str, replacement: &str) -> String {
    match text.find(needle) {
        Some(at) => {
            let end = at + needle.len();
            let piece = get_substitution(replacement, &text[at..end], at, text, &[]);
            format!("{}{piece}{}", &text[..at], &text[end..])
        }
        None => text.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // answers of node 22: 'a-b-c'.replace('-', R)
    #[test]
    fn string_patterns() {
        assert_eq!(replace_first_string("a-b-c", "-", "[$&]"), "a[-]b-c");
        assert_eq!(replace_first_string("a-b-c", "-", "$$"), "a$b-c");
        assert_eq!(replace_first_string("a-b-c", "-", "$`"), "aab-c");
        assert_eq!(replace_first_string("a-b-c", "-", "$'"), "ab-cb-c");
        assert_eq!(replace_first_string("a-b-c", "-", "$1$"), "a$1$b-c");
        assert_eq!(replace_first_string("a-b-c", "x", "$&"), "a-b-c");
        assert_eq!(replace_first_string("abc", "", "$&!"), "!abc");
    }

    // 'xaby'.replace(/(a)(b)?/, R) and /(a)/ for $nn falling back to $n
    #[test]
    fn group_patterns() {
        let g = [Some("a"), None];
        assert_eq!(get_substitution("<$1|$2|$3>", "a", 1, "xay", &g), "<a||$3>");
        assert_eq!(get_substitution("$01$10$0", "a", 1, "xay", &g), "aa0$0");
    }
}
