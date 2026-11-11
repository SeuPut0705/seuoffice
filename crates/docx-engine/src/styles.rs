//! Style readers the property resolver shares
//! (`runBorderOf` of packages/docx-engine/src/parse-styles.ts; the styles part
//! reader is not ported yet).

use jscompat::{JsNum, Radix, parse_int, truthy};
use ooxml_xml::XNode;
use serde::Serialize;

use crate::xml_text::strip_hash;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunBorder {
    pub val: String,
    pub sz: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub space: Option<JsNum>,
}

/// w:bdr as `Run.bdr`; `None` for none and nil.
pub fn run_border_of(bdr: &XNode) -> Option<RunBorder> {
    let val = truthy(bdr.attr("w:val")).filter(|val| !matches!(*val, "none" | "nil"))?;
    let sz = parse_int(bdr.attr("w:sz").unwrap_or(""), Radix::Ten);
    let space = parse_int(bdr.attr("w:space").unwrap_or(""), Radix::Ten);
    Some(RunBorder {
        val: val.to_owned(),
        // `parseInt(...) || 4`: NaN and 0 both fall back
        sz: JsNum(if sz.is_nan() || sz == 0.0 { 4.0 } else { sz }),
        color: truthy(bdr.attr("w:color"))
            .filter(|color| *color != "auto")
            .map(|color| strip_hash(color).to_owned()),
        space: (space > 0.0).then_some(JsNum(space)),
    })
}
