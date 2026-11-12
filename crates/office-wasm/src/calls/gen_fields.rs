//! The field paragraph builders of generate.ts, called by name.

use docx_engine::generate::fields::{
    TocEntry, generate_caption_xml, generate_index_field_xml, generate_toc_field_xml,
};
use jscompat::JsNum;
use serde_json::Value;

use super::{Returned, arg, required, value};

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "generateTocFieldXml" => {
            let entries: Vec<TocEntry> = required(args, "entries")?;
            value(generate_toc_field_xml(&entries))
        }
        "generateCaptionXml" => {
            let label: String = required(args, "label")?;
            let number: JsNum = required(args, "number")?;
            value(generate_caption_xml(&label, number, text))
        }
        "generateIndexFieldXml" => {
            let terms: Vec<String> = required(args, "terms")?;
            // an absent locale takes the default, as a JavaScript default parameter does
            let locale = arg::<String>(args, "locale")?.unwrap_or_else(|| "zh-CN".to_owned());
            value(generate_index_field_xml(&terms, &locale)?)
        }
        _ => Err(format!("genFields has no function {function}")),
    }
}
