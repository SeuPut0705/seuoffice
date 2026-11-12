//! The text of runs: `w:t`, `w:br` and their kin.

/// `breakCharOf`: a `w:br` that clears floats travels as U+001E, a page break
/// as a form feed, a column break as a vertical tab, any other as `\n`.
pub fn break_char_of(clear: Option<&str>, kind: Option<&str>) -> char {
    if clear.is_some_and(|clear| !clear.is_empty()) {
        return '\u{1e}';
    }
    match kind {
        Some("page") => '\u{c}',
        Some("column") => '\u{b}',
        _ => '\n',
    }
}

/// `wtText`: a line break inside `w:t` is a space; without `xml:space="preserve"`
/// the leading and trailing spaces and tabs go and a tab is a space.
pub fn wt_text(raw: &str, preserve: bool) -> String {
    let mut text = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                text.push(' ');
            }
            '\n' => text.push(' '),
            c => text.push(c),
        }
    }
    if preserve {
        return text;
    }
    text.trim_matches([' ', '\t']).replace('\t', " ")
}
