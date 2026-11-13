//! index.ts 1155-1923 (shape editing), called as `index.<TypeScript name>` on an
//! opened deck. Each answers `{ r, xml }`: the result, then `patchSlideXml` of
//! the slide afterwards (see tools/pptx-diff/calls-deckshape.ts).

use jscompat::JsObject;
use pptx_engine::deck::shape::{
    EffectsPatch, ElementFill, FillOpts, ImageFillOpts, ImageFillSource, TextBodyPropsPatch,
    autofit_generated_text_boxes, edit_picture_src_rect, replace_picture_bytes,
    set_element_effects, set_element_fill, set_element_image_fill, set_element_redaction,
    set_element_text_anchor, set_element_text_body_props, set_picture_opacity,
    set_shape_adjust_values, set_shape_custom_geometry, set_shape_preset_geometry,
};
use pptx_engine::deck::{OpenedPptx, patch_slide_xml};
use pptx_engine::types::{Insets, TextAnchor};
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::pptx_deck::{deck_op, element_id};
use super::{Returned, arg, required};

fn slide_of(args: &Value) -> Result<usize, String> {
    required::<usize>(args, "slide")
}

fn answer(opened: &mut OpenedPptx, slide: usize, r: impl Serialize) -> Result<Value, String> {
    let xml = opened
        .deck
        .slides
        .get_mut(slide)
        .map(patch_slide_xml)
        .ok_or_else(|| "TypeError: the slide is undefined".to_owned())?;
    let mut out = Map::new();
    out.insert(
        "r".to_owned(),
        serde_json::to_value(r).map_err(|e| e.to_string())?,
    );
    out.insert("xml".to_owned(), Value::String(xml));
    Ok(Value::Object(out))
}

/// `groupId`: the id of element `group` of the slide, when the input asks for one.
fn fill_group(opened: &OpenedPptx, slide: usize, args: &Value) -> Result<Option<String>, String> {
    if !arg::<bool>(args, "groupId")?.unwrap_or(false) {
        return Ok(None);
    }
    let group = arg::<usize>(args, "group")?.unwrap_or(0);
    Ok(Some(element_id(opened, slide, group)))
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    let s = slide_of(args)?;
    let e = required::<usize>(args, "element")?;
    // the TypeScript reads `slide(index)` first: a missing slide throws there
    match function {
        "index.editPictureSrcRect" => deck_op(text, args, |o| {
            let id = element_id(o, s, e);
            let rect: Option<Insets> = arg(args, "srcRect")?;
            let slide = o.deck.slides.get_mut(s).ok_or("no slide")?;
            let r = edit_picture_src_rect(slide, &id, rect);
            answer(o, s, r)
        }),
        "index.setShapePresetGeometry" => deck_op(text, args, |o| {
            let id = element_id(o, s, e);
            let prst: String = required(args, "prst")?;
            let slide = o.deck.slides.get_mut(s).ok_or("no slide")?;
            let r = set_shape_preset_geometry(slide, &id, &prst);
            answer(o, s, r)
        }),
        "index.setShapeCustomGeometry" => deck_op(text, args, |o| {
            let id = element_id(o, s, e);
            let slide = o.deck.slides.get_mut(s).ok_or("no slide")?;
            let r = set_shape_custom_geometry(slide, &id, args.get("geom"))?;
            answer(o, s, r)
        }),
        "index.setShapeAdjustValues" => deck_op(text, args, |o| {
            let id = element_id(o, s, e);
            let adjust: JsObject<f64> = required(args, "adjust")?;
            let slide = o.deck.slides.get_mut(s).ok_or("no slide")?;
            let r = set_shape_adjust_values(slide, &id, &adjust);
            answer(o, s, r)
        }),
        "index.setElementTextAnchor" => deck_op(text, args, |o| {
            let id = element_id(o, s, e);
            let anchor: TextAnchor = required(args, "anchor")?;
            let slide = o.deck.slides.get_mut(s).ok_or("no slide")?;
            let r = set_element_text_anchor(slide, &id, anchor);
            answer(o, s, r)
        }),
        "index.autofitGeneratedTextBoxes" => deck_op(text, args, |o| {
            let slide = o.deck.slides.get_mut(s).ok_or("no slide")?;
            let r = autofit_generated_text_boxes(slide);
            answer(o, s, r)
        }),
        "index.setElementTextBodyProps" => deck_op(text, args, |o| {
            let id = element_id(o, s, e);
            let patch: TextBodyPropsPatch = required(args, "patch")?;
            let slide = o.deck.slides.get_mut(s).ok_or("no slide")?;
            let r = set_element_text_body_props(slide, &id, &patch);
            answer(o, s, r)
        }),
        "index.setElementEffects" => deck_op(text, args, |o| {
            let id = element_id(o, s, e);
            let patch: EffectsPatch = required(args, "patch")?;
            let slide = o.deck.slides.get_mut(s).ok_or("no slide")?;
            let r = set_element_effects(slide, &id, &patch)?;
            answer(o, s, r)
        }),
        "index.setElementFill" => deck_op(text, args, |o| {
            let id = element_id(o, s, e);
            let fill: ElementFill = required(args, "fill")?;
            let opts = FillOpts {
                group_id: fill_group(o, s, args)?,
            };
            let r = set_element_fill(o, s, &id, &fill, &opts)?;
            answer(o, s, r)
        }),
        "index.setElementImageFill" => deck_op(text, args, |o| {
            let id = element_id(o, s, e);
            let source = match arg::<String>(args, "mediaPath")? {
                Some(media_path) => ImageFillSource::MediaPath { media_path },
                None => ImageFillSource::Bytes {
                    bytes: required(args, "bytes")?,
                    ext: required(args, "ext")?,
                },
            };
            let opts = ImageFillOpts {
                tile: arg(args, "tile")?,
                group_id: fill_group(o, s, args)?,
            };
            let r = set_element_image_fill(o, s, &id, &source, &opts)?;
            answer(o, s, r)
        }),
        "index.setElementRedaction" => deck_op(text, args, |o| {
            let id = element_id(o, s, e);
            let label: Option<String> = arg(args, "label")?;
            let slide = o.deck.slides.get_mut(s).ok_or("no slide")?;
            let r = set_element_redaction(slide, &id, label.as_deref())?;
            answer(o, s, r)
        }),
        "index.setPictureOpacity" => deck_op(text, args, |o| {
            let id = element_id(o, s, e);
            let opacity: f64 = required(args, "opacity")?;
            let slide = o.deck.slides.get_mut(s).ok_or("no slide")?;
            let r = set_picture_opacity(slide, &id, opacity);
            answer(o, s, r)
        }),
        "index.replacePictureBytes" => deck_op(text, args, |o| {
            let id = element_id(o, s, e);
            let bytes: Vec<u8> = required(args, "bytes")?;
            let ext: String = required(args, "ext")?;
            let keep = arg::<bool>(args, "keep")?.unwrap_or(false);
            let r = replace_picture_bytes(o, s, &id, &bytes, &ext, keep)?;
            answer(o, s, json!(r))
        }),
        _ => Err(format!("no function {function}")),
    }
}
