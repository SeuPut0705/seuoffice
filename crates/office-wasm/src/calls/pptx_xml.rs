//! `pptxXml.*`: the object tree fast-xml-parser's `XMLParser` gives the slides
//! engine, under the options of each parser the engine builds.

use ooxml_xml::ObjectOptions;
use pptx_engine::xml_utils::xml_parse_object as parse_object;
use serde_json::Value;

use super::{Returned, arg, value};

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "parseObject" => {
            let defaults = ObjectOptions::default();
            let names: Vec<String> = arg(args, "arrayNames")?.unwrap_or_default();
            let names: Vec<&str> = names.iter().map(String::as_str).collect();
            let options = ObjectOptions {
                trim_values: arg(args, "trimValues")?.unwrap_or(defaults.trim_values),
                parse_tag_value: arg(args, "parseTagValue")?.unwrap_or(defaults.parse_tag_value),
                array_names: &names,
            };
            value(parse_object(text, &options).map_err(|error| error.to_string())?)
        }
        _ => Err(format!("unknown function {function}")),
    }
}
