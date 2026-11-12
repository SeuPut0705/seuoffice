//! index.ts of the slides engine, lines 4179-4841 (element clipboard, slide
//! transitions, advance time, hidden slides, `reassembleSlideXml`, group /
//! ungroup, in-group editing), called as `index.<TypeScript name>`. The decks
//! are opened and compared as tools/pptx-diff/calls-deckgroups.ts does.

use jscompat::{JsNum, JsObject};
use pptx_engine::deck::{
    ElementClipboardItem, ElementFontPatch, OpenedPptx, ShiftEmu, copy_element_data,
    edit_group_child_fill, edit_group_child_stroke, edit_group_child_transform, find_group_child,
    get_slide_advance_time, get_slide_hidden, get_slide_transition, group_child_slices,
    group_elements, paste_elements, patch_group_child_text, patch_group_child_xml,
    reassemble_slide_xml, set_group_child_font, set_group_child_shape_adjust_values,
    set_group_child_shape_custom_geometry, set_group_child_shape_preset_geometry,
    set_slide_advance_time, set_slide_hidden, set_slide_transition, stroke_patch_to_model,
    ungroup_element, with_uuid,
};
use pptx_engine::generate::{FillPatch, SlideTransitionKind, StrokePatch};
use pptx_engine::types::{EmuRect, GroupElement, Slide, SlideElement, TextElement};
use serde::Serialize;
use serde_json::Value;

use super::pptx_deck::{deck_op, element_id};
use super::{Returned, arg, required, value};

/// `crypto.randomUUID()` while a call runs, as `withUuid(UUID, ...)` on the TypeScript side.
const UUID: &str = "6f1d2c3b-4a59-4687-9e0d-1c2b3a495867";

fn v(result: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(result).map_err(|error| error.to_string())
}

fn index(args: &Value, key: &str) -> Result<usize, String> {
    required(args, key)
}

/// `opened.deck.slides[args.slide]!`
fn slide_mut<'a>(opened: &'a mut OpenedPptx, args: &Value) -> Result<&'a mut Slide, String> {
    let at = index(args, "slide")?;
    opened
        .deck
        .slides
        .get_mut(at)
        .ok_or_else(|| "no such slide".to_owned())
}

/// The group at `args.element` of `args.slide`.
fn group_mut<'a>(opened: &'a mut OpenedPptx, args: &Value) -> Result<&'a mut GroupElement, String> {
    let element = index(args, "element")?;
    let slide = slide_mut(opened, args)?;
    match slide.elements.as_mut().and_then(|all| all.get_mut(element)) {
        Some(SlideElement::Group(group)) => Ok(&mut **group),
        _ => Err("not a group".to_owned()),
    }
}

/// `groupId(at, a)`
fn group_id(opened: &OpenedPptx, args: &Value) -> Result<String, String> {
    if let Some(id) = arg::<String>(args, "groupId")? {
        return Ok(id);
    }
    Ok(element_id(
        opened,
        index(args, "slide")?,
        index(args, "element")?,
    ))
}

/// `childId(opened, a)`: '' where the group or the child is not there.
fn child_id(opened: &OpenedPptx, args: &Value) -> Result<String, String> {
    if let Some(id) = arg::<String>(args, "childId")? {
        return Ok(id);
    }
    let (slide, element, child) = (
        index(args, "slide")?,
        index(args, "element")?,
        index(args, "child")?,
    );
    let group = opened
        .deck
        .slides
        .get(slide)
        .and_then(|s| (*s.elements).as_deref())
        .and_then(|all| all.get(element));
    Ok(match group {
        Some(SlideElement::Group(group)) => (*group.children)
            .as_deref()
            .and_then(|all| all.get(child))
            .map(|c| c.id().to_owned())
            .unwrap_or_default(),
        _ => String::new(),
    })
}

/// One `GroupChildSlice` as the TypeScript gives it: UTF-16 offsets.
#[derive(Serialize)]
struct Slice {
    start: usize,
    end: usize,
    xml: String,
    #[serde(rename = "nvId", skip_serializing_if = "Option::is_none")]
    nv_id: Option<String>,
}

fn utf16_at(text: &str, byte: usize) -> usize {
    text.get(..byte)
        .map_or(0, |head| head.encode_utf16().count())
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "index.groupChildSlices" => {
            let slices: Vec<Slice> = group_child_slices(text)?
                .into_iter()
                .map(|s| Slice {
                    start: utf16_at(text, s.start),
                    end: utf16_at(text, s.end),
                    xml: s.xml,
                    nv_id: s.nv_id,
                })
                .collect();
            value(slices)
        }
        "index.strokePatchToModel" => value(stroke_patch_to_model(&required::<StrokePatch>(
            args, "stroke",
        )?)),
        _ => deck_op(text, args, |opened| {
            with_uuid(UUID, || deck_function(function, opened, args))
        }),
    }
}

fn deck_function(function: &str, opened: &mut OpenedPptx, args: &Value) -> Result<Value, String> {
    match function {
        "index.copyElementData" => {
            let item = copy_element_data(opened, index(args, "slide")?, index(args, "element")?)?;
            v(item)
        }
        "index.pasteElements" => {
            let items: Vec<ElementClipboardItem> = required(args, "items")?;
            let shift: ShiftEmu = required(args, "shift")?;
            v(paste_elements(
                opened,
                index(args, "slide")?,
                &items,
                shift,
            )?)
        }
        "index.setSlideTransition" => {
            let kind: SlideTransitionKind = required(args, "kind")?;
            set_slide_transition(slide_mut(opened, args)?, kind);
            Ok(Value::Null)
        }
        "index.getSlideTransition" => v(get_slide_transition(slide_mut(opened, args)?)),
        "index.setSlideAdvanceTime" => {
            let ms: Option<f64> = arg(args, "ms")?;
            set_slide_advance_time(slide_mut(opened, args)?, ms);
            Ok(Value::Null)
        }
        "index.getSlideAdvanceTime" => {
            v(get_slide_advance_time(slide_mut(opened, args)?).map(JsNum))
        }
        "index.setSlideHidden" => {
            let hidden: bool = required(args, "hidden")?;
            set_slide_hidden(slide_mut(opened, args)?, hidden);
            Ok(Value::Null)
        }
        "index.getSlideHidden" => v(get_slide_hidden(slide_mut(opened, args)?)),
        "index.reassembleSlideXml" => v(reassemble_slide_xml(slide_mut(opened, args)?)),
        "index.groupElements" => {
            let slide = index(args, "slide")?;
            let mut ids: Vec<String> = arg::<Vec<usize>>(args, "elements")?
                .unwrap_or_default()
                .into_iter()
                .map(|e| element_id(opened, slide, e))
                .collect();
            ids.extend(arg::<Vec<String>>(args, "refs")?.unwrap_or_default());
            v(group_elements(opened, slide, &ids)?)
        }
        "index.ungroupElement" => {
            let slide = index(args, "slide")?;
            let id = match arg::<String>(args, "sourceId")? {
                Some(id) => id,
                None => element_id(opened, slide, index(args, "element")?),
            };
            v(ungroup_element(opened, slide, &id)?)
        }
        "index.patchGroupChildXml" => {
            let child = index(args, "child")?;
            let grp = group_mut(opened, args)?;
            let nv_id = (*grp.children)
                .as_deref()
                .and_then(|all| all.get(child))
                .map(|c| pptx_engine::with_element!(c, e => (*e.nv_id).clone()))
                .ok_or_else(|| "no such child".to_owned())?;
            v(patch_group_child_xml(grp, nv_id.as_deref(), |xml| {
                Ok(format!("<!--patched-->{xml}"))
            })?)
        }
        "index.findGroupChild" => {
            let (gid, cid) = (group_id(opened, args)?, child_id(opened, args)?);
            let slide = slide_mut(opened, args)?;
            let found = find_group_child(slide, &gid, &cid).and_then(|(gi, ci)| {
                let group = (*slide.elements).as_deref()?.get(gi)?;
                let SlideElement::Group(group) = group else {
                    return None;
                };
                let child = (*group.children).as_deref()?.get(ci)?;
                Some([
                    group.id.as_deref().unwrap_or("").to_owned(),
                    child.id().to_owned(),
                ])
            });
            v(found)
        }
        "index.editGroupChildTransform" => {
            let (gid, cid) = (group_id(opened, args)?, child_id(opened, args)?);
            let offset: EmuRect = required(args, "offset")?;
            let rotation: f64 = required(args, "rotationDeg")?;
            v(edit_group_child_transform(
                slide_mut(opened, args)?,
                &gid,
                &cid,
                offset,
                rotation,
            )?)
        }
        "index.patchGroupChildText" => {
            let gid = group_id(opened, args)?;
            let child = index(args, "child")?;
            let model: TextElement = match (*group_mut(opened, args)?.children)
                .as_deref()
                .and_then(|all| all.get(child))
            {
                Some(SlideElement::Text(text)) => (**text).clone(),
                _ => return Err("the child is not a text element".to_owned()),
            };
            v(patch_group_child_text(
                slide_mut(opened, args)?,
                &gid,
                &model,
            )?)
        }
        "index.setGroupChildFont" => {
            let (gid, cid) = (group_id(opened, args)?, child_id(opened, args)?);
            let patch: ElementFontPatch = required(args, "patch")?;
            let grow: Option<f64> = arg(args, "grow")?;
            let size_map = grow.map(|grow| move |pt: Option<f64>| pt.unwrap_or(18.0) + grow);
            let slide = slide_mut(opened, args)?;
            v(set_group_child_font(
                slide,
                &gid,
                &cid,
                &patch,
                size_map.as_ref().map(|f| f as &dyn Fn(Option<f64>) -> f64),
            )?)
        }
        "index.editGroupChildFill" => {
            let (gid, cid) = (group_id(opened, args)?, child_id(opened, args)?);
            let fill: FillPatch = required(args, "fill")?;
            v(edit_group_child_fill(
                slide_mut(opened, args)?,
                &gid,
                &cid,
                &fill,
            )?)
        }
        "index.editGroupChildStroke" => {
            let (gid, cid) = (group_id(opened, args)?, child_id(opened, args)?);
            let stroke: Option<StrokePatch> = arg(args, "stroke")?;
            v(edit_group_child_stroke(
                slide_mut(opened, args)?,
                &gid,
                &cid,
                stroke.as_ref(),
            )?)
        }
        "index.setGroupChildShapeAdjustValues" => {
            let (gid, cid) = (group_id(opened, args)?, child_id(opened, args)?);
            let adjust: JsObject<JsNum> = required(args, "adjust")?;
            v(set_group_child_shape_adjust_values(
                slide_mut(opened, args)?,
                &gid,
                &cid,
                &adjust,
            )?)
        }
        "index.setGroupChildShapePresetGeometry" => {
            let (gid, cid) = (group_id(opened, args)?, child_id(opened, args)?);
            let prst: String = required(args, "prst")?;
            v(set_group_child_shape_preset_geometry(
                slide_mut(opened, args)?,
                &gid,
                &cid,
                &prst,
            )?)
        }
        "index.setGroupChildShapeCustomGeometry" => {
            let (gid, cid) = (group_id(opened, args)?, child_id(opened, args)?);
            let geom = args.get("geom").cloned().unwrap_or(Value::Null);
            v(set_group_child_shape_custom_geometry(
                slide_mut(opened, args)?,
                &gid,
                &cid,
                &geom,
            )?)
        }
        other => Err(format!("no function {other} in deckgroups")),
    }
}
