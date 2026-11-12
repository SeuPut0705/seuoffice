//! glb-bounds.ts and chart-workbook.ts of the slides engine, called as
//! `<module>.<TypeScript name>`. Bytes come as `args.bytes`, a list of
//! numbers, and a bytes result goes back as one.

use jscompat::{JsNum, JsObject};
use pptx_engine::chart_workbook::{
    CHART_WORKBOOK_REL_TYPE, ChartWorkbookData, ChartWorkbookSeries, XLSX_CONTENT_TYPE,
    chart_workbook_parts, chart_workbook_xlsx, col_letter, stored_zip,
};
use pptx_engine::glb_bounds::{glb_bounds, glb_json};
use serde::Deserialize;
use serde_json::Value;

use super::{Returned, optional, required, value};

/// `args.data` as the spec writes it. A series value is a number, `null`, or
/// one of the names `"NaN"`, `"Infinity"`, `"-Infinity"`, which JSON cannot
/// carry as numbers.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireData {
    categories: Vec<String>,
    series: Vec<WireSeries>,
    x_values: Option<Vec<f64>>,
}

#[derive(Deserialize)]
struct WireSeries {
    name: String,
    values: Vec<Value>,
}

fn marked(value: &Value) -> Result<Option<JsNum>, String> {
    match value {
        Value::Null => Ok(None),
        Value::String(name) => match name.as_str() {
            "NaN" => Ok(Some(JsNum(f64::NAN))),
            "Infinity" => Ok(Some(JsNum(f64::INFINITY))),
            "-Infinity" => Ok(Some(JsNum(f64::NEG_INFINITY))),
            _ => Err(format!("not a number: {name}")),
        },
        _ => value
            .as_f64()
            .map(|x| Some(JsNum(x)))
            .ok_or_else(|| format!("not a number: {value}")),
    }
}

fn data(args: &Value) -> Result<ChartWorkbookData, String> {
    let wire: WireData = required(args, "data")?;
    let series = wire
        .series
        .into_iter()
        .map(|ser| {
            Ok(ChartWorkbookSeries {
                name: ser.name,
                values: ser
                    .values
                    .iter()
                    .map(marked)
                    .collect::<Result<_, String>>()?,
            })
        })
        .collect::<Result<_, String>>()?;
    Ok(ChartWorkbookData {
        categories: wire.categories,
        series,
        x_values: wire
            .x_values
            .map(|x_values| x_values.into_iter().map(JsNum).collect()),
    })
}

pub fn dispatch(function: &str, _text: &str, args: &Value) -> Returned {
    match function {
        "glb-bounds.glbJson" => value(glb_json(&required::<Vec<u8>>(args, "bytes")?)?),
        "glb-bounds.glbBounds" => value(glb_bounds(&required::<Vec<u8>>(args, "bytes")?)?),
        "chart-workbook.constant" => optional(match required::<String>(args, "name")?.as_str() {
            "CHART_WORKBOOK_REL_TYPE" => Some(CHART_WORKBOOK_REL_TYPE),
            "XLSX_CONTENT_TYPE" => Some(XLSX_CONTENT_TYPE),
            _ => None,
        }),
        "chart-workbook.colLetter" => value(col_letter(required::<f64>(args, "i")?)),
        "chart-workbook.chartWorkbookParts" => value(chart_workbook_parts(&data(args)?)),
        "chart-workbook.storedZip" => {
            value(stored_zip(&required::<JsObject<String>>(args, "files")?)?)
        }
        "chart-workbook.chartWorkbookXlsx" => value(chart_workbook_xlsx(&data(args)?)?),
        _ => Err(format!("unknown function {function}")),
    }
}
