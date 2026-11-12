//! `genTable.<name>`: the table generators of generate.ts. The text is the
//! original table XML of `generateTableModelXml` ('' where there is none).

use docx_engine::generate::table::{self, TableGenOptions};
use docx_engine::model::TableModel;
use serde::Deserialize;
use serde_json::Value;

use super::{Returned, arg, required, value};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OptsArg {
    header_row: Option<bool>,
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "generateTableModelXml" => {
            let model: TableModel = required(args, "model")?;
            let original = (!text.is_empty()).then_some(text);
            value(
                table::generate_table_model_xml(&model, original, None)
                    .map_err(|error| error.to_string())?,
            )
        }
        "generateTableXml" => {
            let rows: f64 = required(args, "rows")?;
            let cols: f64 = required(args, "cols")?;
            let opts = arg::<OptsArg>(args, "opts")?.unwrap_or_default();
            value(table::generate_table_xml(
                rows,
                cols,
                TableGenOptions {
                    header_row: opts.header_row == Some(true),
                },
            ))
        }
        _ => Err(format!("unknown function {function}")),
    }
}
