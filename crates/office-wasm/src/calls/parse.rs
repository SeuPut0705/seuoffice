//! `parse.*`: the internal functions of parse.ts, by their TypeScript names,
//! answered by the module of `docx_engine::parse` that ports each.

use serde_json::Value;

use super::Returned;

mod drawings;
mod tables;
mod text;

pub fn dispatch(function: &str, text_arg: &str, args: &Value) -> Returned {
    text::dispatch(function, text_arg, args)
        .or_else(|| tables::dispatch(function, text_arg, args))
        .or_else(|| drawings::dispatch(function, text_arg, args))
        .unwrap_or_else(|| Err(format!("no function {function}")))
}
