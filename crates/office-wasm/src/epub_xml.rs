//! Gate-only calls into the XML half of the EPUB engine and the book reader of
//! `file-parse`, by the name of the TypeScript function: the functions of
//! `epub_engine::book_call` (features `xml` and `book` of `epub-engine`) and
//! `epubToText` (feature `epub` of `file-parse`).
//!
//! `run_named` answers an error as `(name, message)`.

use serde_json::Value;

type Named = (String, String);

/// The gate's entry: `function` is the TypeScript export name; `None` where
/// the function is not one of these.
pub fn run_named(
    function: &str,
    text: &str,
    bytes: &[u8],
    args: &Value,
) -> Option<Result<Value, Named>> {
    if function == "epubToText" {
        return Some(
            file_parse::epub::epub_to_text(bytes)
                .map(Value::String)
                .map_err(|message| ("Error".to_owned(), message)),
        );
    }
    let unknown = format!("unknown function {function}");
    match epub_engine::book_call::call(function, text, bytes, args) {
        Err((_, message)) if message == unknown => None,
        answered => Some(answered),
    }
}
