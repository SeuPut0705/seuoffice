//! The functions of section.ts, watermark.ts, notes.ts and the parse-vml.ts
//! helpers they stand on, under their TypeScript names.

use docx_engine::notes::{self, NoteKind};
use docx_engine::section::{self, HfKind, NotePrTag, SectionBlock};
use docx_engine::vml::{self, Dim, FloatAnchor};
use docx_engine::watermark::{self, BoxPt, PictureWatermarkSpec, Watermark, WatermarkSpec};
use jscompat::JsNum;
use serde_json::Value;

use super::{Returned, arg, optional, required, value};

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "sectionSettingsFromXml" => value(section::section_settings_from_xml(
            text,
            arg(args, "gutterAtTop")?,
        )),
        "notePropsFromXml" => {
            let tag: NotePrTag = required(args, "tag")?;
            optional(section::note_props_from_xml(text, tag))
        }
        "lineNumberingOf" => optional(section::line_numbering_of(text)),
        "readSectionSettings" => {
            let blocks: Vec<SectionBlock> = required(args, "blocks")?;
            value(section::read_section_settings(
                &blocks,
                arg(args, "gutterAtTop")?,
            ))
        }
        "xmlFlagOn" => {
            let tag: String = required(args, "tag")?;
            value(section::xml_flag_on(text, &tag).map_err(|error| error.to_string())?)
        }
        "hfReferenceTags" => {
            let kind: HfKind = required(args, "kind")?;
            value(section::hf_reference_tags(text, kind))
        }
        "hfReferenceType" => optional(section::hf_reference_type(text)),
        "hfReferenceRId" => optional(section::hf_reference_r_id(text)),
        "sectionFromSectPr" => value(section::section_from_sect_pr(
            text,
            required(args, "first")?,
            required(args, "last")?,
            arg(args, "gutterAtTop")?,
        )),
        "readSections" => {
            let blocks: Vec<SectionBlock> = required(args, "blocks")?;
            value(section::read_sections(&blocks, arg(args, "gutterAtTop")?))
        }
        "readPageColor" => value(section::read_page_color(text)),

        "readWatermarkText" => value(watermark::read_watermark_text(text)),
        "readWatermarkShape" => value(watermark::read_watermark_shape(text)),
        "isPictureWatermark" => {
            let wm: Watermark = required(args, "wm")?;
            value(watermark::is_picture_watermark(&wm))
        }
        "isWatermarkChild" => {
            let name: String = required(args, "name")?;
            value(watermark::is_watermark_child(&name, text))
        }
        "isPictureWatermarkShape" => value(watermark::is_picture_watermark_shape(text)),
        "readPictureWatermark" => value(watermark::read_picture_watermark(text)),
        "pictureWatermarkPreviewImage" => {
            let spec: PictureWatermarkSpec = required(args, "spec")?;
            let margin_box: Option<BoxPt> = arg(args, "marginBox")?;
            value(watermark::picture_watermark_preview_image(
                &spec,
                margin_box.as_ref(),
            ))
        }
        "textWatermarkBoxPt" => {
            let spec: WatermarkSpec = required(args, "spec")?;
            value(watermark::text_watermark_box_pt(&spec))
        }
        "textWatermarkPreviewImage" => {
            let spec: WatermarkSpec = required(args, "spec")?;
            value(watermark::text_watermark_preview_image(&spec))
        }
        "pictureWatermarkBoxPt" => {
            let spec: PictureWatermarkSpec = required(args, "spec")?;
            let margin_box: Option<BoxPt> = arg(args, "marginBox")?;
            value(watermark::picture_watermark_box_pt(
                &spec,
                margin_box.as_ref(),
            ))
        }

        "vmlLengthPx" => optional(vml::vml_length_px(Some(text)).map(JsNum)),
        "vmlStyleProp" => {
            let key: String = required(args, "key")?;
            optional(vml::vml_style_prop(text, &key).map_err(|error| error.to_string())?)
        }
        "vmlStyleDimPx" => {
            let key: Dim = required(args, "key")?;
            optional(vml::vml_style_dim_px(text, key).map(JsNum))
        }
        "vmlRotationDeg" => optional(vml::vml_rotation_deg(text).map(JsNum)),
        "anchorRelH" => value(vml::anchor_rel_h(Some(text))),
        "anchorRelV" => value(vml::anchor_rel_v(Some(text))),
        "vmlFloatAnchor" => {
            let mut out = FloatAnchor::default();
            vml::vml_float_anchor(text, &mut out);
            value(out)
        }
        "vmlFraction" => optional(vml::vml_fraction(Some(text)).map(JsNum)),
        "vmlColorHex" => optional(vml::vml_color_hex(Some(text))),

        "parseNotesXml" => {
            let kind: NoteKind = required(args, "kind")?;
            value(notes::parse_notes_xml(text, kind))
        }
        "noteModelText" => {
            let rich_paras: Vec<Vec<docx_engine::model::NoteRun>> = required(args, "richParas")?;
            optional(notes::note_model_text(&rich_paras))
        }
        "nextNoteId" => {
            let kind: NoteKind = required(args, "kind")?;
            value(notes::next_note_id(&notes::parse_notes_xml(text, kind)))
        }
        "rootAttributes" => {
            let root_tag: String = required(args, "rootTag")?;
            let fallback: String = required(args, "fallback")?;
            let required_namespaces: Vec<(String, String)> =
                arg(args, "required")?.unwrap_or_default();
            value(
                notes::root_attributes(Some(text), &root_tag, &fallback, &required_namespaces)
                    .map_err(|error| error.to_string())?,
            )
        }
        _ => Err(format!("unknown function {function}")),
    }
}
