//! `save.*`: the internal functions of the write side, by their TypeScript
//! names, answered by the module of `docx_engine::save` that ports each.

use serde_json::Value;

use super::Returned;

pub(crate) mod features;
mod parts;
#[allow(clippy::module_inception)] // mirrors the TypeScript calls/save/save layout
mod save;

pub fn dispatch(function: &str, text_arg: &str, args: &Value) -> Returned {
    save::dispatch(function, text_arg, args)
        .or_else(|| parts::dispatch(function, text_arg, args))
        .or_else(|| features::dispatch(function, text_arg, args))
        .unwrap_or_else(|| Err(format!("no function {function}")))
}
