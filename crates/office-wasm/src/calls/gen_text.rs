//! `genText.<name>`: the text patches of generate.ts (field cached text, OMML
//! tokens, table cell texts, textbox paragraphs). Offsets cross as UTF-16
//! code units.

use docx_engine::generate::text_patch::{
    self, CellTextsPatch, FieldTextPatch, TextboxParasPatchSet,
};
use docx_engine::xml_tag;
use ooxml_xml::Utf16Map;
use serde::Serialize;
use serde_json::Value;

use super::{Returned, required, value};

#[derive(Serialize)]
struct Segment16 {
    start: u32,
    end: u32,
}

/// The byte offset of the first character that starts at or after UTF-16 unit `unit`.
fn byte_at_unit(text: &str, unit: usize) -> usize {
    let mut units = 0;
    for (at, ch) in text.char_indices() {
        if units >= unit {
            return at;
        }
        units += ch.len_utf16();
    }
    text.len()
}

/// `xmlSegments(text, tag, from, to)` with JavaScript numbers for the bounds:
/// `indexOf` truncates `from` and clamps it at 0, and every offset compared
/// with `to` is an integer, so `o < to` is `o < ceil(to)`.
fn xml_segments16(text: &str, tag: &str, from: f64, to: f64) -> Vec<Segment16> {
    // `!(from < to)`: no segment where either bound is NaN
    if from.is_nan() || to.is_nan() || from >= to {
        return Vec::new();
    }
    let len16 = text.encode_utf16().count() as f64;
    let from16 = from.trunc().clamp(0.0, len16) as usize;
    let to16 = to.ceil().clamp(0.0, len16) as usize;
    let map = Utf16Map::new(text);
    xml_tag::xml_segments(
        text,
        tag,
        byte_at_unit(text, from16),
        byte_at_unit(text, to16),
    )
    .into_iter()
    .map(|seg| Segment16 {
        start: map.to_utf16(seg.start),
        end: map.to_utf16(seg.end),
    })
    .collect()
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "xmlSegments" => {
            let tag: String = required(args, "tag")?;
            let from: f64 = required(args, "from")?;
            let to: f64 = required(args, "to")?;
            value(xml_segments16(text, &tag, from, to))
        }
        "patchFieldParagraphXml" => {
            let patch: FieldTextPatch = required(args, "patch")?;
            value(text_patch::patch_field_paragraph_xml(text, &patch))
        }
        "patchMathTokens" => {
            let tokens: Vec<String> = required(args, "tokens")?;
            value(text_patch::patch_math_tokens(text, &tokens))
        }
        "patchTableCellTexts" => {
            let texts: Vec<Option<Vec<Option<CellTextsPatch>>>> = required(args, "texts")?;
            value(
                text_patch::patch_table_cell_texts(text, &texts)
                    .map_err(|limit| limit.to_string())?,
            )
        }
        "patchTextboxParas" => {
            let patches: TextboxParasPatchSet = required(args, "patches")?;
            value(
                text_patch::patch_textbox_paras(text, &patches)
                    .map_err(|limit| limit.to_string())?,
            )
        }
        _ => Err(format!("unknown function {function}")),
    }
}
