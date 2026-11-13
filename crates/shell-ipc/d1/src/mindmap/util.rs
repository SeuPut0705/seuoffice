//! Small JavaScript behaviors the handlers lean on.

use jscompat::{js_regex, number_to_string, slice_utf16, to_number, trim};
use shell_contract::IpcValue;

/// `value.length` of a string: UTF-16 code units
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(start, end)` in UTF-16 units
pub fn slice(text: &str, start: usize, end: usize) -> String {
    slice_utf16(text, start as f64, Some(end as f64))
}

/// `(name ?? '').replace(/[/\\:*?"<>|]/g, '_').slice(0, 80).trim()`
pub fn file_name_base(name: Option<&str>) -> String {
    let replaced = js_regex!(r#"[/\\:*?"<>|]"#).replace_all(name.unwrap_or(""), |_| "_".to_owned());
    trim(&slice(&replaced, 0, 80)).to_owned()
}

/// `text.replace(/\s+/g, ' ').trim()`
pub fn one_line(text: &str) -> String {
    let flat = js_regex!(r"\s+").replace_all(text, |_| " ".to_owned());
    trim(&flat).to_owned()
}

/// `Number(value)` of what a renderer may send
pub fn js_number(value: &IpcValue) -> f64 {
    match value {
        IpcValue::Number(x) => *x,
        IpcValue::Null => 0.0,
        IpcValue::Bool(flag) => f64::from(u8::from(*flag)),
        IpcValue::String(text) => to_number(text),
        _ => f64::NAN,
    }
}

/// `String(value)`
pub fn js_string(value: &IpcValue) -> String {
    match value {
        IpcValue::Undefined => "undefined".to_owned(),
        IpcValue::Null => "null".to_owned(),
        IpcValue::Bool(flag) => flag.to_string(),
        IpcValue::Number(x) => number_to_string(*x),
        IpcValue::String(text) => text.clone(),
        _ => "[object Object]".to_owned(),
    }
}

/// `'key' in object` for a plain object
pub fn has_key(value: &IpcValue, key: &str) -> bool {
    matches!(value, IpcValue::Object(entries) if entries.iter().any(|(name, _)| name == key))
}
