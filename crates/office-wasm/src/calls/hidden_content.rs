//! `hiddenContent.<name>`: hidden-content.ts. The package is `args.parts`, a
//! list of `[name, text]` pairs written to a zip first; `clearHiddenMarks`
//! answers the entries of the package it wrote, as `[name, isFolder, text]`.

use docx_engine::hidden_content::{clear_hidden_marks, docx_holds_hidden_content};
use ooxml_pkg::{DEFAULT_ZIP_LIMITS, load_package, write::generate};
use serde_json::{Value, json};

use super::{Returned, package, value};

pub fn dispatch(function: &str, _text: &str, args: &Value) -> Returned {
    let docx = generate(&package(args)?, 0.0).map_err(|error| error.to_string())?;
    match function {
        "docxHoldsHiddenContent" => value(docx_holds_hidden_content(&docx)?),
        "clearHiddenMarks" => {
            let cleared = clear_hidden_marks(&docx, 0.0)?;
            let loaded = load_package(&cleared, &DEFAULT_ZIP_LIMITS, |_| Ok(()))?;
            let entries: Vec<Value> = loaded
                .parts()
                .iter()
                .map(|part| {
                    let text = if part.is_dir {
                        Ok(String::new())
                    } else {
                        part.text().map(str::to_owned)
                    };
                    text.map(|text| json!([part.name.as_str(), part.is_dir, text]))
                        .map_err(|error| error.to_string())
                })
                .collect::<Result<_, _>>()?;
            value(entries)
        }
        _ => Err(format!("unknown function {function}")),
    }
}
