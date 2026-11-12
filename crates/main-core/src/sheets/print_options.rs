//! `apps/sheets/src/main/print-options.ts`.

use jscompat::{math_round, to_number};
use serde_json::{Map, Number, Value};

pub const MICRONS_PER_INCH: f64 = 25_400.0;
pub const CSS_PX_PER_INCH: f64 = 96.0;

/// A number the request holds: a JSON `null` is how a NaN arrives, a string
/// is read as `Number(text)` does, anything else is NaN.
fn number_of(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => to_number(text),
        _ => f64::NAN,
    }
}

/// `Math.round(x)` as a JSON number (NaN prints as `null`)
fn rounded(x: f64) -> Value {
    Number::from_f64(math_round(x)).map_or(Value::Null, Value::Number)
}

fn field<'a>(object: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    object.and_then(|value| value.get(key))
}

/// `printOptionsFor(request)`: the `webContents.print` options matching what
/// `printToPDF` gets for the same request. `request` is the
/// `WorkbookExportPdfRequest`; an optional field the request leaves out is
/// left out of the options.
pub fn print_options_for(request: &Value) -> Value {
    let margins = request.get("margins");
    let page_size = request.get("pageSize");
    let device_name = request.get("deviceName");
    let mut options = Map::new();
    options.insert("silent".into(), Value::Bool(device_name.is_some()));
    if let Some(device_name) = device_name {
        options.insert("deviceName".into(), device_name.clone());
    }
    if let Some(copies) = request.get("copies") {
        options.insert("copies".into(), copies.clone());
    }
    if let Some(collate) = request.get("collate") {
        options.insert("collate".into(), collate.clone());
    }
    options.insert("printBackground".into(), Value::Bool(true));
    if let Some(landscape) = request.get("landscape") {
        options.insert("landscape".into(), landscape.clone());
    }
    let size = match page_size {
        Some(Value::String(name)) => Value::String(name.clone()),
        _ => {
            let mut size = Map::new();
            size.insert(
                "width".into(),
                rounded(number_of(field(page_size, "width")) * MICRONS_PER_INCH),
            );
            size.insert(
                "height".into(),
                rounded(number_of(field(page_size, "height")) * MICRONS_PER_INCH),
            );
            Value::Object(size)
        }
    };
    options.insert("pageSize".into(), size);
    let mut custom = Map::new();
    custom.insert("marginType".into(), Value::from("custom"));
    for side in ["top", "bottom", "left", "right"] {
        custom.insert(
            side.into(),
            rounded(number_of(field(margins, side)) * CSS_PX_PER_INCH),
        );
    }
    options.insert("margins".into(), Value::Object(custom));
    options.insert(
        "scaleFactor".into(),
        rounded(number_of(request.get("scale")) * 100.0),
    );
    Value::Object(options)
}
