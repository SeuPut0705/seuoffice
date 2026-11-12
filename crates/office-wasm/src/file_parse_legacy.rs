//! Gate-only calls into the legacy binary readers: `pptToText`, `docToText`,
//! `assertCompoundFile` and `assertSoundCompoundFile` (`args.type` is the
//! document type the message names; `Word 97-2003` when it is absent).
//!
//! An error is returned as the text the gate compares, `name` and `message`
//! as one string `"<name>\u{1}<message>"`, so that the caller that wraps it
//! in `{ error: { name, message } }` can split it again: the names these
//! readers throw (`DamagedFileError`, `RangeError`, `TypeError`, and the
//! `string` of a thrown string) cannot be told from the message alone.

use serde_json::Value;

/// `<name>\u{1}<message>`.
fn failure(error: file_parse::compound_gate::JsError) -> String {
    format!("{}\u{1}{}", error.name, error.message)
}

/// `None`: `function` is not one of these.
pub fn run(
    function: &str,
    _text: &str,
    bytes: &[u8],
    args: &Value,
) -> Option<Result<Value, String>> {
    Some(match function {
        "pptToText" => file_parse::ppt::ppt_to_text(bytes)
            .map(Value::String)
            .map_err(failure),
        "docToText" => file_parse::doc::doc_to_text(bytes)
            .map(Value::String)
            .map_err(failure),
        "assertCompoundFile" => file_parse::compound_gate::assert_compound_file(bytes)
            .map(|()| Value::Null)
            .map_err(|error| {
                failure(file_parse::compound_gate::JsError::new(
                    error.name(),
                    error.message(),
                ))
            }),
        "assertSoundCompoundFile" => {
            let document_type = args
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("Word 97-2003");
            file_parse::compound_gate::assert_sound_compound_file(bytes, document_type)
                .map(|()| Value::Null)
                .map_err(|error| failure(error.into()))
        }
        _ => return None,
    })
}
