//! The fresh drawing builders of generate.ts, called by name. Each takes its
//! options object as `args.opts`. A builder refuses a number with no XML text
//! (`docx_engine::xml_number`); the refusal is the call's error.

use docx_engine::generate::drawing_build::{
    build_anchored_textbox_paragraph_xml, build_line_paragraph_xml, build_shape_paragraph_xml,
    build_textbox_paragraph_xml, build_word_art_paragraph_xml, inline_picture_drawing_xml,
    line_kind,
};
use serde_json::Value;

use super::{Returned, arg, optional, required, value};

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "LINE_KINDS" => optional(line_kind(text)),
        "buildLineParagraphXml" => value(build_line_paragraph_xml(&required(args, "opts")?)?),
        "inlinePictureDrawingXml" => value(inline_picture_drawing_xml(&required(args, "opts")?)?),
        "buildTextboxParagraphXml" => {
            value(build_textbox_paragraph_xml(arg(args, "opts")?.as_ref())?)
        }
        "buildAnchoredTextboxParagraphXml" => value(build_anchored_textbox_paragraph_xml(
            &required(args, "opts")?,
        )?),
        "buildShapeParagraphXml" => value(build_shape_paragraph_xml(&required(args, "opts")?)?),
        "buildWordArtParagraphXml" => {
            value(build_word_art_paragraph_xml(&required(args, "opts")?)?)
        }
        _ => Err(format!("unknown function {function}")),
    }
}
