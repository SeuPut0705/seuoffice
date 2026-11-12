//! Functions of the engines called by name, for the gate. Each group of ported
//! modules has a module here that answers to `<group>.<TypeScript name>`.

use ooxml_pkg::Package;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

mod altchunk;
mod blank;
mod checkbox;
mod docprops;
mod drawing;
mod fielddisplay;
mod fields;
mod images;
mod markers;
mod math;
mod resolve;
#[cfg(feature = "u2_revision")]
mod revision;
mod section;
mod vml;

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
        "altchunk" => Some(altchunk::dispatch(function, text, args)),
        "blank" => Some(blank::dispatch(function, text, args)),
        "checkbox" => Some(checkbox::dispatch(function, text, args)),
        "docprops" => Some(docprops::dispatch(function, text, args)),
        "drawing" => Some(drawing::dispatch(function, text, args)),
        "fielddisplay" => Some(fielddisplay::dispatch(function, text, args)),
        "fields" => Some(fields::dispatch(function, text, args)),
        "images" => Some(images::dispatch(function, text, args)),
        "markers" => Some(markers::dispatch(function, text, args)),
        "math" => Some(math::dispatch(function, text, args)),
        "resolve" => Some(resolve::dispatch(function, text, args)),
        #[cfg(feature = "u2_revision")]
        "revision" => Some(revision::dispatch(function, text, args)),
        "section" => Some(section::dispatch(function, text, args)),
        "vml" => Some(vml::dispatch(function, text, args)),
        _ => None,
    }
}
