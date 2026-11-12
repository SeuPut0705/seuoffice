//! insert.ts, background-promote.ts, headerfooter.ts and smartart.ts of the
//! slides engine, called as `<module>.<TypeScript name>`. Each runs on a deck
//! opened by `deck_op`, as tools/pptx-diff/calls-insert.ts does; `args.uuid`
//! is what `crypto.randomUUID()` gives and `args.now` what `Date.now()` gives.

use jscompat::{JsNum, js_regex};
use pptx_engine::background_promote::{is_background_like_element, promote_slide_background};
use pptx_engine::deck::OpenedPptx;
use pptx_engine::headerfooter::{HeaderFooterOptions, apply_header_footer, read_header_footer};
use pptx_engine::insert::{
    NewElementOptions, NewPictureOptions, NewTableGridOptions, NewTableOptions, add_element,
    add_image_media_and_rel, add_picture, build_grp_sp_xml, build_sp_xml, build_table_grid_xml,
    build_table_xml, calc_bounding_box, delete_element, is_line_kind, next_c_nv_pr_id,
};
use pptx_engine::smartart::{NewSmartArtOptions, add_smart_art, build_smart_art_xml};
use pptx_engine::types::{EmuRect, Slide};
use serde::Deserialize;
use serde_json::{Value, json};

use super::pptx_deck::{deck_op, element_id};
use super::{Returned, arg, required, value};

const UUID: &str = "3f2b8c1e-5a4d-4e6f-9b7a-0c1d2e3f4a5b";
const NOW: f64 = 1_700_000_000_000.0;

fn uuid(args: &Value) -> Result<String, String> {
    Ok(arg::<String>(args, "uuid")?.unwrap_or_else(|| UUID.to_owned()))
}

fn now(args: &Value) -> Result<f64, String> {
    Ok(arg::<f64>(args, "now")?.unwrap_or(NOW))
}

fn slide_of(opened: &OpenedPptx, index: usize) -> Result<&Slide, String> {
    opened
        .deck
        .slides
        .get(index)
        .ok_or_else(|| "the slide does not exist".to_owned())
}

fn to_value(result: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(result).map_err(|error| error.to_string())
}

/// `NewPictureOptions` with `bytes` as a list of numbers.
fn picture_opts(args: &Value, key: &str) -> Result<NewPictureOptions, String> {
    required(args, key)
}

#[derive(Deserialize)]
struct Bytes(Vec<u8>);

/// `<a:fld>` takes a random GUID (generate.ts `fieldGuid`): both sides print it as one fixed text.
fn no_field_guid(node: &mut Value) {
    match node {
        Value::String(text) => {
            *text = js_regex!(
                r#"(<a:fld id=")\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}""#,
                "g"
            )
            .replace_all(text, |m| format!("{}{{G}}\"", m.get(1).unwrap_or_default()));
        }
        Value::Array(items) => items.iter_mut().for_each(no_field_guid),
        Value::Object(object) => object.values_mut().for_each(no_field_guid),
        _ => {}
    }
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "insert.isLineKind" => value(is_line_kind(text)),
        "insert.nextCNvPrId" => deck_op(text, args, |opened| {
            to_value(JsNum(next_c_nv_pr_id(slide_of(opened, 0)?)))
        }),
        "insert.buildSpXml" => deck_op(text, args, |opened| {
            let opts: NewElementOptions = required(args, "opts")?;
            to_value(build_sp_xml(slide_of(opened, 0)?, &opts, &uuid(args)?))
        }),
        "insert.addElement" => deck_op(text, args, |opened| {
            let opts: NewElementOptions = required(args, "opts")?;
            let (uuid, now) = (uuid(args)?, now(args)?);
            let slide = opened
                .deck
                .slides
                .get_mut(0)
                .ok_or_else(|| "the slide does not exist".to_owned())?;
            to_value(add_element(slide, &opts, &uuid, now)?)
        }),
        "insert.buildTableXml" => deck_op(text, args, |opened| {
            let opts: NewTableOptions = required(args, "opts")?;
            to_value(build_table_xml(slide_of(opened, 0)?, &opts, &uuid(args)?))
        }),
        "insert.buildTableGridXml" => deck_op(text, args, |opened| {
            let opts: NewTableGridOptions = required(args, "opts")?;
            to_value(build_table_grid_xml(
                slide_of(opened, 0)?,
                &opts,
                &uuid(args)?,
            ))
        }),
        "insert.addImageMediaAndRel" => deck_op(text, args, |opened| {
            let bytes: Bytes = Bytes(required(args, "bytes")?);
            let ext: String = required(args, "ext")?;
            to_value(add_image_media_and_rel(opened, 0, &bytes.0, &ext)?)
        }),
        "insert.addPicture" => deck_op(text, args, |opened| {
            let opts = picture_opts(args, "opts")?;
            to_value(add_picture(opened, 0, &opts, &uuid(args)?, now(args)?)?)
        }),
        "insert.deleteElement" => deck_op(text, args, |opened| {
            let element: usize = required(args, "element")?;
            let id = element_id(opened, 0, element);
            to_value(delete_element(opened, 0, &id)?)
        }),
        "insert.calcBoundingBox" => deck_op(text, args, |opened| {
            let slide = slide_of(opened, 0)?;
            let rect: EmuRect = calc_bounding_box(slide.elements.as_deref().unwrap_or(&[]));
            to_value(rect)
        }),
        "insert.buildGrpSpXml" => deck_op(text, args, |opened| {
            let bbox: EmuRect = required(args, "bbox")?;
            let children: String = required(args, "childrenXml")?;
            to_value(build_grp_sp_xml(
                slide_of(opened, 0)?,
                &bbox,
                &children,
                &uuid(args)?,
            ))
        }),
        "background-promote.promoteSlideBackground" => deck_op(text, args, |opened| {
            let size = opened.deck.size;
            let slide = opened
                .deck
                .slides
                .get_mut(0)
                .ok_or_else(|| "the slide does not exist".to_owned())?;
            to_value(promote_slide_background(slide, &size))
        }),
        "background-promote.isBackgroundLikeElement" => deck_op(text, args, |opened| {
            let size = opened.deck.size;
            let slide = slide_of(opened, 0)?;
            let flags: Vec<bool> = slide
                .elements
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .map(|el| is_background_like_element(el, &size))
                .collect();
            to_value(flags)
        }),
        "headerfooter.applyHeaderFooter" => {
            let answer = deck_op(text, args, |opened| {
                let opts: HeaderFooterOptions = required(args, "opts")?;
                let indexes: Option<Vec<f64>> = arg(args, "indexes")?;
                to_value(apply_header_footer(
                    opened,
                    &opts,
                    indexes.as_deref(),
                    now(args)?,
                )?)
            })?;
            Ok(answer.map(|mut answer| {
                no_field_guid(&mut answer);
                answer
            }))
        }
        "headerfooter.readHeaderFooter" => deck_op(text, args, |opened| {
            to_value(read_header_footer(slide_of(opened, 0)?))
        }),
        "smartart.buildSmartArtXml" => deck_op(text, args, |opened| {
            let opts: NewSmartArtOptions = required(args, "opts")?;
            to_value(build_smart_art_xml(
                slide_of(opened, 0)?,
                &opts,
                &uuid(args)?,
            ))
        }),
        "smartart.addSmartArt" => deck_op(text, args, |opened| {
            let opts: NewSmartArtOptions = required(args, "opts")?;
            let slide: usize = required(args, "slide")?;
            let added = add_smart_art(opened, slide, &opts, &uuid(args)?)?;
            Ok(match added {
                Some(r) => json!({ "elementId": r.element_id }),
                None => Value::Null,
            })
        }),
        _ => Err(format!("unknown function {function}")),
    }
}
