//! `images.*`: the predicates of tiff.ts and metafile.ts. A MIME argument is
//! the text, or `undefined` where `args.missing` is set. The `unknown`
//! arguments of `tiffDimsOk` cross as JSON, with `{ "$": tag }` for what JSON
//! cannot carry: `NaN`, `Infinity`, `-Infinity`, `-0` and `undefined`.

use docx_engine::image_kinds::{self, MAX_METAFILE_GUNZIP_BYTES};
use jscompat::JsNum;
use serde_json::Value;

use super::{Returned, arg, required, value};

/// The value of an `unknown` argument when its `typeof` is `number`.
fn number_of(raw: Option<&Value>) -> Option<f64> {
    match raw? {
        Value::Number(number) => number.as_f64(),
        Value::Object(tagged) => match tagged.get("$")?.as_str()? {
            "NaN" => Some(f64::NAN),
            "Infinity" => Some(f64::INFINITY),
            "-Infinity" => Some(f64::NEG_INFINITY),
            "-0" => Some(-0.0),
            _ => None,
        },
        _ => None,
    }
}

fn mime_of<'a>(text: &'a str, args: &Value) -> Result<Option<&'a str>, String> {
    let missing = arg::<bool>(args, "missing")?.unwrap_or(false);
    Ok((!missing).then_some(text))
}

fn constant(name: &str) -> Returned {
    match name {
        "MAX_METAFILE_GUNZIP_BYTES" => value(JsNum(MAX_METAFILE_GUNZIP_BYTES)),
        _ => Err(format!("no constant {name}")),
    }
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "constants" => constant(&required::<String>(args, "name")?),
        "isTiffMime" => value(image_kinds::is_tiff_mime(mime_of(text, args)?)),
        "tiffDimsOk" => value(image_kinds::tiff_dims_ok(
            number_of(args.get("width")),
            number_of(args.get("height")),
        )),
        "isMetafileMime" => value(image_kinds::is_metafile_mime(mime_of(text, args)?)),
        _ => Err(format!("no function {function}")),
    }
}
