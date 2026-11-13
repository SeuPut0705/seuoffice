/// `text.padStart(length, fill)`, the length counted in UTF-16 code units.
pub fn pad_start(text: &str, length: usize, fill: char) -> String {
    let units = text.encode_utf16().count();
    let mut out: String = std::iter::repeat_n(fill, length.saturating_sub(units)).collect();
    out.push_str(text);
    out
}

/// A string where JavaScript tests it for truth: absent and empty are both false.
pub fn truthy(text: Option<&str>) -> Option<&str> {
    text.filter(|text| !text.is_empty())
}
