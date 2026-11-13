//! generate.ts of the slides engine, called as `generate.<TypeScript name>`.

use jscompat::{JsNum, js_regex};
use pptx_engine::generate::{
    self, BackgroundFillPatch, FillPatch, SlideTransitionKind, StrokePatch,
};
use pptx_engine::types::{
    ChartElement, ElementType, GroupElement, Insets, PPrDirty, Paragraph, PassthroughElement,
    PictureElement, SlideElement, TableElement, TextBody, TextElement, TextRun, Transform,
};
use serde::Serialize;
use serde_json::Value;

use super::{Returned, arg, optional, required, value};

/// `<a:fld>` takes a random GUID: both sides print it as one fixed text.
fn no_guid(xml: &str) -> String {
    js_regex!(
        r#"(<a:fld id=")\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}""#,
        "g"
    )
    .replace_all(xml, |m| format!("{}{{G}}\"", m.get(1).unwrap_or_default()))
}

/// The UTF-16 index of a byte offset.
fn utf16_at(text: &str, byte: usize) -> usize {
    text.get(..byte)
        .map_or(0, |head| head.encode_utf16().count())
}

/// The byte offset of a UTF-16 index (the end of the text past it).
fn byte_at(text: &str, units: usize) -> usize {
    let mut count = 0;
    for (at, ch) in text.char_indices() {
        if count >= units {
            return at;
        }
        count += ch.len_utf16();
    }
    text.len()
}

/// The model's text element: `args.text` and `args.textMoved`.
fn text_element(args: &Value) -> Result<TextElement, String> {
    let mut el = TextElement::default();
    el.r#type.set(ElementType::Text);
    if let Some(body) = arg::<TextBody>(args, "text")? {
        el.text.set(body);
    }
    if let Some(moved) = arg::<bool>(args, "textMoved")? {
        el.text_moved.set(moved);
    }
    Ok(el)
}

/// An element of `type` carrying `transform`, for the geometry patch.
fn element_of(kind: &str, transform: Transform) -> Result<SlideElement, String> {
    macro_rules! make {
        ($ty:ident, $variant:ident, $kind:ident) => {{
            let mut e = $ty::default();
            e.r#type.set(ElementType::$kind);
            e.transform.set(transform);
            SlideElement::$variant(Box::new(e))
        }};
    }
    Ok(match kind {
        "text" | "shape" => make!(TextElement, Text, Text),
        "picture" => make!(PictureElement, Picture, Picture),
        "group" => make!(GroupElement, Group, Group),
        "table" => make!(TableElement, Table, Table),
        "chart" => make!(ChartElement, Chart, Chart),
        "passthrough" => make!(PassthroughElement, Passthrough, Passthrough),
        other => return Err(format!("unknown element type {other}")),
    })
}

#[derive(Serialize)]
struct Child {
    name: String,
    start: usize,
    end: usize,
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    let which = || required::<PPrDirty>(args, "which");
    match function {
        "generate.patchTextElementXml" => value(no_guid(&generate::patch_text_element_xml(
            &text_element(args)?,
            text,
        )?)),
        "generate.patchParagraphPPrXml" => value(generate::patch_paragraph_p_pr_xml(
            text,
            &required::<Paragraph>(args, "p")?,
            &which()?,
        )?),
        "generate.patchElementPPr" => value(generate::patch_element_p_pr(
            &text_element(args)?,
            text,
            &which()?,
        )?),
        "generate.szAttr" => value(generate::sz_attr(required::<JsNum>(args, "pt")?.0)),
        "generate.clampInt" => value(JsNum(generate::clamp_int(
            required::<JsNum>(args, "v")?.0,
            required::<JsNum>(args, "min")?.0,
            required::<JsNum>(args, "max")?.0,
        ))),
        "generate.clampEmu" => value(JsNum(generate::clamp_emu(required::<JsNum>(args, "v")?.0))),
        "generate.clampPosEmu" => value(JsNum(generate::clamp_pos_emu(
            required::<JsNum>(args, "v")?.0,
        ))),
        "generate.constants" => match required::<String>(args, "name")?.as_str() {
            "COORD_MAX" => value(JsNum(generate::COORD_MAX)),
            "TRANSITION_KINDS" => value(generate::TRANSITION_KINDS),
            name => Err(format!("no constant {name}")),
        },
        "generate.isConnectorXml" => value(generate::is_connector_xml(text)),
        "generate.rebuildTxBody" => {
            // TypeScript reads `el.text!.paragraphs`: a missing model throws.
            required::<TextBody>(args, "text")?;
            value(no_guid(&generate::rebuild_tx_body(
                &text_element(args)?,
                text,
            )))
        }
        "generate.generateParagraphXml" => {
            value(no_guid(&generate::generate_paragraph_xml(&required::<
                Paragraph,
            >(
                args, "p"
            )?)))
        }
        "generate.alternateContentBranches" => {
            let branches = generate::alternate_content_branches(text)?;
            value(branches.map(|list| {
                list.into_iter()
                    .map(|b| {
                        let start = utf16_at(text, b.start);
                        let end = utf16_at(text, b.end);
                        serde_json::json!({
                            "name": b.name,
                            "start": start,
                            "end": end,
                            "tag": b.tag,
                            "fallback": b.fallback,
                        })
                    })
                    .collect::<Vec<_>>()
            }))
        }
        "generate.topLevelChildren" => {
            let from = byte_at(text, required::<JsNum>(args, "from")?.0.max(0.0) as usize);
            let to = byte_at(text, required::<JsNum>(args, "to")?.0.max(0.0) as usize);
            let children = generate::top_level_children(text, from, to)?;
            value(
                children
                    .into_iter()
                    .map(|c| Child {
                        start: utf16_at(text, c.start),
                        end: utf16_at(text, c.end),
                        name: c.name,
                    })
                    .collect::<Vec<_>>(),
            )
        }
        "generate.patchElementFill" => value(generate::patch_element_fill(
            text,
            &required::<FillPatch>(args, "fill")?,
        )?),
        "generate.patchElementStroke" => {
            let stroke: Option<StrokePatch> = arg(args, "stroke")?;
            value(generate::patch_element_stroke(text, stroke.as_ref())?)
        }
        "generate.patchPictureSrcRect" => {
            let rect: Option<Insets> = arg(args, "srcRect")?;
            value(generate::patch_picture_src_rect(text, rect.as_ref())?)
        }
        "generate.patchSlideBackgroundXml" => value(generate::patch_slide_background_xml(
            text,
            &required::<BackgroundFillPatch>(args, "fill")?,
        )),
        "generate.removeSlideBackgroundXml" => value(generate::remove_slide_background_xml(text)),
        "generate.patchSlideShowMasterSpXml" => value(generate::patch_slide_show_master_sp_xml(
            text,
            required::<bool>(args, "hidden")?,
        )?),
        "generate.patchSlideTransitionXml" => value(generate::patch_slide_transition_xml(
            text,
            required::<SlideTransitionKind>(args, "kind")?,
        )),
        "generate.readSlideTransitionXml" => value(generate::read_slide_transition_xml(text)),
        "generate.patchSlideAdvanceTimeXml" => {
            let ms: Option<JsNum> = arg(args, "ms")?;
            value(generate::patch_slide_advance_time_xml(
                text,
                ms.map(|ms| ms.0),
            ))
        }
        "generate.readSlideAdvanceTimeXml" => {
            value(generate::read_slide_advance_time_xml(text).map(JsNum))
        }
        "generate.patchSlideHiddenXml" => value(generate::patch_slide_hidden_xml(
            text,
            required::<bool>(args, "hidden")?,
        )),
        "generate.readSlideHiddenXml" => value(generate::read_slide_hidden_xml(text)),
        "generate.generateXfrmXml" => {
            let tag: Option<String> = arg(args, "tag")?;
            value(generate::generate_xfrm_xml(
                &required::<Transform>(args, "t")?,
                tag.as_deref().unwrap_or("a:xfrm"),
            ))
        }
        "generate.patchElementXfrm" => {
            let kind = required::<String>(args, "type")?;
            let el = element_of(&kind, required::<Transform>(args, "transform")?)?;
            value(generate::patch_element_xfrm(&el, text))
        }
        "generate.hangulLang" => optional(generate::hangul_lang(text)),
        "generate.tagHangulRun" => {
            let run: TextRun = required(args, "run")?;
            value(generate::tag_hangul_run(&run))
        }
        "generate.tagHangulParagraphs" => {
            let paragraphs: Vec<Paragraph> = required(args, "paragraphs")?;
            value(generate::tag_hangul_paragraphs(&paragraphs))
        }
        "generate.patchBodyPrAutofit" => {
            let reduction: Option<JsNum> = arg(args, "lnSpcReduction")?;
            value(generate::patch_body_pr_autofit(
                text,
                required::<JsNum>(args, "fontScale")?.0,
                reduction.map(|r| r.0),
            ))
        }
        _ => Err(format!("unknown function {function}")),
    }
}
