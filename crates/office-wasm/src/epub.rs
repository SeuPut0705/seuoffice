//! Gate-only calls into the EPUB engine.

use serde_json::{Value, json};

type Call = fn(&str, &str, &[u8], &Value) -> Result<Value, (String, String)>;

/// A function name belongs to one module; the first that knows it answers.
const MODULES: [Call; 3] = [
    epub_engine::primitives::call,
    epub_engine::ranges::call,
    epub_engine::package::call,
];

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
