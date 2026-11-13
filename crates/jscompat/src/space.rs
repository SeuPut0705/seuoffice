/// `\s` of a JavaScript regular expression, which is also what `trim` removes.
/// It differs from `char::is_whitespace`: U+FEFF is a space, U+0085 is not.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_space)
}

pub fn trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}
