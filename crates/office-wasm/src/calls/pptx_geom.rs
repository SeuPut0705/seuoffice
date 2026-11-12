//! custgeom.ts and preset-shape-types.ts of the slides engine, called as
//! `<module>.<TypeScript name>`.

use jscompat::JsNum;
use pptx_engine::custgeom::{
    CUST_GEOM_PT_COUNT, CustGeomPath, Guide, cust_geom_xml, eval_guides, parse_cust_geom,
    valid_cust_geom_path,
};
use pptx_engine::preset_shape_types::{PRESET_SHAPE_TYPES, is_preset_shape_type};
use serde_json::{Map, Value};

use super::{Returned, optional, required, value};

/// A number as the spec of `evalGuides` writes it: what JSON cannot carry
/// (NaN, the infinities, -0) as a string.
fn number_form(x: f64) -> Value {
    if x.is_nan() {
        Value::from("NaN")
    } else if x == f64::INFINITY {
        Value::from("Infinity")
    } else if x == f64::NEG_INFINITY {
        Value::from("-Infinity")
    } else if x == 0.0 && x.is_sign_negative() {
        Value::from("-0")
    } else {
        serde_json::to_value(JsNum(x)).unwrap_or(Value::Null)
    }
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "custgeom.evalGuides" => {
            let gds: Vec<Guide> = required(args, "gds")?;
            let env = eval_guides(&gds, required(args, "w")?, required(args, "h")?);
            let mut out = Map::new();
            for (key, x) in env.entries() {
                out.insert(key.to_owned(), number_form(*x));
            }
            value(out)
        }
        "custgeom.parseCustGeom" => optional(
            parse_cust_geom(text, required(args, "shapeW")?, required(args, "shapeH")?)
                .map_err(|limit| limit.to_string())?,
        ),
        "custgeom.CUST_GEOM_PT_COUNT" => {
            let op: String = required(args, "op")?;
            optional(
                CUST_GEOM_PT_COUNT
                    .iter()
                    .find(|(key, _)| *key == op)
                    .map(|(_, count)| *count),
            )
        }
        "custgeom.validCustGeomPath" => value(valid_cust_geom_path(args.get("p"))?),
        "custgeom.custGeomXml" => {
            let p: CustGeomPath = required(args, "p")?;
            value(cust_geom_xml(&p))
        }
        "preset-shape-types.PRESET_SHAPE_TYPES" => {
            let index: f64 = required(args, "index")?;
            let at = (index >= 0.0 && index.fract() == 0.0)
                .then(|| PRESET_SHAPE_TYPES.get(index as usize))
                .flatten();
            optional(at)
        }
        "preset-shape-types.isPresetShapeType" => value(is_preset_shape_type(text)),
        _ => Err(format!("unknown function {function}")),
    }
}
