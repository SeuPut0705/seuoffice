//! `checkbox.*`: checkbox-control.ts. `isOn` reads the text, or `undefined`
//! where `args.missing` is set; `sdtCheckboxControl` reads the first top-level
//! w:sdt of the text, or `{}` where there is none.

use docx_engine::checkbox_control;
use docx_engine::package::parse_part;
use ooxml_xml::XNode;
use serde_json::Value;

use super::{Returned, arg, required, value};

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "isOn" => {
            let missing = arg::<bool>(args, "missing")?.unwrap_or(false);
            value(checkbox_control::is_on((!missing).then_some(text)))
        }
        "sdtCheckboxGlyphs" => value(checkbox_control::sdt_checkbox_glyphs(text)),
        "sdtCheckboxControl" => {
            let nodes = parse_part(text)?;
            let empty = XNode::empty();
            let sdt = nodes
                .iter()
                .find(|node| node.name() == Some("w:sdt"))
                .unwrap_or(&empty);
            value(checkbox_control::sdt_checkbox_control(sdt))
        }
        "sdtCheckboxIsChecked" => value(checkbox_control::sdt_checkbox_is_checked(
            text,
            &required::<String>(args, "glyph")?,
        )),
        "syncSdtCheckbox" => value(checkbox_control::sync_sdt_checkbox(
            text,
            required(args, "checked")?,
        )),
        _ => Err(format!("no function {function}")),
    }
}
