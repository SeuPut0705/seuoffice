//! Gate-only call into the saxes port: `saxesEvents` parses a text with a
//! handler on every event and answers the events with the parser position.

use serde_json::Value;

pub fn run(
    function: &str,
    text: &str,
    _bytes: &[u8],
    args: &Value,
) -> Option<Result<Value, String>> {
    match function {
        "saxesEvents" => Some(saxes::record::run(args, text)),
        _ => None,
    }
}
