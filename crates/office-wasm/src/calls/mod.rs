//! Functions of the engines called by name, for the gate. Each group of ported
//! modules has a module here that answers to `<group>.<TypeScript name>`.

use ooxml_pkg::Package;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

mod blank;
mod docprops;
mod fields;
mod gen_drawing;
mod gen_drawing_build;
mod gen_fields;
mod gen_paragraph;
mod gen_props;
mod gen_rpr;
mod gen_runs;
mod gen_table;
mod gen_text;
mod markers;
mod math;
mod resolve;
mod section;

/// What a call gives: a value, nothing where the TypeScript function returns
/// `undefined`, or an error where it throws.
pub type Returned = Result<Option<Value>, String>;

/// A returned value. A `None` inside it is `null`.
pub fn value(result: impl Serialize) -> Returned {
    serde_json::to_value(result)
        .map(Some)
        .map_err(|error| error.to_string())
}

/// For a function that returns `undefined` where Rust has `None`.
pub fn optional(result: Option<impl Serialize>) -> Returned {
    result.map_or(Ok(None), value)
}

/// The argument `key`; `None` where it is absent or null.
pub fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<Option<T>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|error| format!("the {key} argument: {error}")),
    }
}

pub fn required<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    arg(args, key)?.ok_or_else(|| format!("the {key} argument is missing"))
}

/// The package of `args.parts`, a list of `[name, text]` pairs: what the
/// TypeScript side builds with `zipOf`.
pub fn package(args: &Value) -> Result<Package, String> {
    let parts: Vec<(String, String)> = required(args, "parts")?;
    Ok(Package::from_parts(parts))
}

/// `None` where no group of that name is built in.
pub fn dispatch(name: &str, text: &str, args: &Value) -> Option<Returned> {
    let (group, function) = name.split_once('.')?;
    match group {
        "blank" => Some(blank::dispatch(function, text, args)),
        "docprops" => Some(docprops::dispatch(function, text, args)),
        "fields" => Some(fields::dispatch(function, text, args)),
        "markers" => Some(markers::dispatch(function, text, args)),
        "math" => Some(math::dispatch(function, text, args)),
        "resolve" => Some(resolve::dispatch(function, text, args)),
        "section" => Some(section::dispatch(function, text, args)),
        "genRpr" => Some(gen_rpr::dispatch(function, text, args)),
        "genProps" => Some(gen_props::dispatch(function, text, args)),
        "genDrawing" => Some(gen_drawing::dispatch(function, text, args)),
        "genDrawingBuild" => Some(gen_drawing_build::dispatch(function, text, args)),
        "genText" => Some(gen_text::dispatch(function, text, args)),
        "genTable" => Some(gen_table::dispatch(function, text, args)),
        "genFields" => Some(gen_fields::dispatch(function, text, args)),
        "genRuns" => Some(gen_runs::dispatch(function, text, args)),
        "genParagraph" => Some(gen_paragraph::dispatch(function, text, args)),
        _ => None,
    }
}
