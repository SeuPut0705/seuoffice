//! Gate-only calls into `file_parse::hwp`.

use serde_json::Value;

/// `None`: the function is not one of the Hangul readers. An `Err` is the
/// message of what the TypeScript throws; the name is read from it by the caller
/// (`DamagedFileError` for "The file is damaged or is not a valid HWP document").
pub fn run(
    function: &str,
    _text: &str,
    bytes: &[u8],
    args: &Value,
) -> Option<Result<Value, String>> {
    let result = match function {
        "hwpToText" => file_parse::hwp::hwp_to_text(bytes).map(Value::String),
        "hwpMemosOf" => file_parse::hwp::hwp_memos_of(bytes).map(Value::Array),
        "checkedHwpBytes" => {
            let ext = args.get("ext").and_then(Value::as_str).unwrap_or_default();
            file_parse::hwp::checked_hwp_bytes(bytes, ext)
                .map(|bytes| Value::Array(bytes.iter().copied().map(Value::from).collect()))
        }
        _ => return None,
    };
    Some(result)
}
