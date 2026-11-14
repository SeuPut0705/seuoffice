//! Gate-only calls into the EPUB engine.

use serde_json::{Value, json};

type Call = fn(&str, &str, &[u8], &Value) -> Result<Value, (String, String)>;

/// A function name belongs to one module; the first that knows it answers.
/// The package module answers its own error for a name it does not know, so
/// it comes last.
const MODULES: [Call; 6] = [
    epub_engine::primitives::call,
    epub_engine::ranges::call,
    crate::epub_pure::call,
    saxes_call,
    xml_call,
    epub_engine::package::call,
];

/// The XML half and the book reader, which answer `None` for a name they do not know.
fn xml_call(
    function: &str,
    text: &str,
    bytes: &[u8],
    args: &Value,
) -> Result<Value, (String, String)> {
    crate::epub_xml::run_named(function, text, bytes, args)
        .unwrap_or_else(|| Err(("Error".to_owned(), format!("unknown function {function}"))))
}

/// `saxesEvents`, whose recorder answers what saxes threw inside its result.
fn saxes_call(
    function: &str,
    text: &str,
    bytes: &[u8],
    args: &Value,
) -> Result<Value, (String, String)> {
    match crate::saxes_calls::run(function, text, bytes, args) {
        None => Err(("Error".to_owned(), format!("unknown function {function}"))),
        Some(result) => result.map_err(|message| ("Error".to_owned(), message)),
    }
}

pub fn run(function: &str, text: &str, bytes: &[u8], args: &Value) -> Vec<u8> {
    let unknown = format!("unknown function {function}");
    let mut result = Err(("Error".to_owned(), unknown.clone()));
    for call in MODULES {
        result = call(function, text, bytes, args);
        if !matches!(&result, Err((_, message)) if *message == unknown) {
            break;
        }
    }
    let outcome = match result {
        Ok(value) => json!({ "value": value }),
        Err((name, message)) => json!({ "error": { "name": name, "message": message } }),
    };
    serde_json::to_vec(&outcome).expect("EPUB outcome contains only JSON values")
}
