//! packages/pptx-engine/src/index.ts, element group / ungroup and in-group
//! editing (4379-4841).
//!
//! In-group editing goes one level: a group of `slide.elements` and its direct
//! child. Offsets of a `GroupChildSlice` are byte offsets into the group XML.

use std::sync::Arc;

use jscompat::{
    JsNum, JsObject, TryJsRegex, js_regex, math_round, number_to_string, number_truthy,
    regex_escape,
};
use serde::Serialize;
use serde_json::Value;

use super::{
    ElementFontPatch, OpenedPptx, append_raw_elements, apply_custom_geometry_model,
    apply_font_patch, materialize_slide, patched_element_xml, preset_geom_xml, random_uuid,
    swap_av_lst_xml, swap_geometry_xml, valid_adjust,
};
use crate::custgeom::{CustGeomPath, cust_geom_xml, valid_cust_geom_path};
use crate::generate::{
    FillPatch, StrokeGradient, StrokePatch, patch_element_fill, patch_element_stroke,
    patch_element_xfrm, patch_text_element_xml,
};
use crate::identity::matches_element_ref;
use crate::insert::{build_grp_sp_xml, calc_bounding_box};
use crate::parse::slice_group_child_xmls;
use crate::types::{
    ElementType, EmuRect, Fill, GradientFill, GroupElement, LineCap, Slide, SlideElement, Stroke,
    TextElement, Transform,
};
use crate::xml_utils::attribute_of;

/// `slide.elements`; empty where the slide has none.
fn elements(slide: &Slide) -> &[SlideElement] {
    (*slide.elements).as_deref().unwrap_or(&[])
}

/// The group at index `at` of the slide's elements.
fn group_at(slide: &mut Slide, at: usize) -> Option<&mut GroupElement> {
    match slide.elements.as_mut()?.get_mut(at)? {
        SlideElement::Group(group) => Some(&mut **group),
        _ => None,
    }
}

/// The text/shape child at index `at` of a group.
fn text_child_mut(grp: &mut GroupElement, at: usize) -> Option<&mut TextElement> {
    match grp.children.as_mut()?.get_mut(at)? {
        SlideElement::Text(text) => Some(&mut **text),
        _ => None,
    }
}

/// `child.nvId`, the text of the child's `<p:cNvPr id>`.
fn child_nv_id(grp: &GroupElement, at: usize) -> Option<String> {
    let child = (*grp.children).as_deref()?.get(at)?;
    crate::with_element!(child, e => (*e.nv_id).clone())
}

fn is_text_or_shape(el: &SlideElement) -> bool {
    matches!(
        el.element_type(),
        Some(ElementType::Text | ElementType::Shape)
    )
}

// ── Element group / ungroup ─────────────────────────────────────────────

/// `groupElements`: group text/shape/picture elements into one `p:grpSp`.
/// Returns the new group's id (the slide is `opened.deck.slides[slide_index]`);
/// `None` is the TypeScript `null`.
pub fn group_elements(
    opened: &mut OpenedPptx,
    slide_index: usize,
    source_ids: &[String],
) -> Result<Option<String>, String> {
    let grp_xml = {
        let Some(slide) = opened.deck.slides.get_mut(slide_index) else {
            return Ok(None);
        };
        if source_ids.len() < 2 {
            return Ok(None);
        }
        // Refs resolve like every other op, deduplicated
        let mut targets: Vec<usize> = Vec::new();
        for id in source_ids {
            let mut found = None;
            for (at, e) in elements(slide).iter().enumerate() {
                if matches_element_ref(e, id)? {
                    found = Some(at);
                    break;
                }
            }
            if let Some(at) = found
                && !targets.contains(&at)
            {
                targets.push(at);
            }
        }
        if targets.len() < 2 {
            return Ok(None);
        }
        let groupable = targets.iter().all(|at| {
            elements(slide).get(*at).is_some_and(|e| {
                matches!(
                    e.element_type(),
                    Some(ElementType::Text | ElementType::Shape | ElementType::Picture)
                )
            })
        });
        if !groupable {
            return Ok(None);
        }
        let bbox = {
            let picked: Vec<&SlideElement> = targets
                .iter()
                .filter_map(|at| elements(slide).get(*at))
                .collect();
            calc_bounding_box(picked)
        };
        let mut children_xml = String::new();
        if let Some(all) = slide.elements.as_mut() {
            for at in &targets {
                if let Some(el) = all.get_mut(*at) {
                    children_xml.push_str(&patched_element_xml(el));
                }
            }
        }
        let grp_xml = build_grp_sp_xml(slide, &bbox, &children_xml, &random_uuid());
        if let Some(all) = slide.elements.as_mut() {
            let mut at = 0usize;
            all.retain(|_| {
                let keep = !targets.contains(&at);
                at += 1;
                keep
            });
        }
        grp_xml
    };
    let Some(ids) = append_raw_elements(opened, slide_index, &[grp_xml])? else {
        return Ok(None);
    };
    Ok(ids.last().cloned())
}

/// `ungroupElement`: lift the group's children to the slide top level. The
/// fresh slide is `opened.deck.slides[slide_index]`; `false` is the TypeScript
/// `null`.
pub fn ungroup_element(
    opened: &mut OpenedPptx,
    slide_index: usize,
    source_id: &str,
) -> Result<bool, String> {
    let lifted: Vec<String> = {
        let Some(slide) = opened.deck.slides.get_mut(slide_index) else {
            return Ok(false);
        };
        let Some(SlideElement::Group(grp)) = elements(slide).iter().find(|e| e.id() == source_id)
        else {
            return Ok(false);
        };
        let zero = EmuRect {
            x: JsNum(0.0),
            y: JsNum(0.0),
            cx: JsNum(0.0),
            cy: JsNum(0.0),
        };
        // group's position on the slide
        let g_off = (*grp.transform).map_or(zero, |t| t.offset);
        let ch_off = (*grp.child_offset).unwrap_or(EmuRect {
            x: JsNum(0.0),
            y: JsNum(0.0),
            cx: g_off.cx,
            cy: g_off.cy,
        });
        let scale_x = if ch_off.cx.0 > 0.0 {
            g_off.cx.0 / ch_off.cx.0
        } else {
            1.0
        };
        let scale_y = if ch_off.cy.0 > 0.0 {
            g_off.cy.0 / ch_off.cy.0
        } else {
            1.0
        };
        let orig: Arc<str> = match (*grp.anchor).as_ref() {
            Some(anchor) => anchor.original_xml.clone(),
            None => Arc::from(""),
        };
        let transforms: Vec<Option<Transform>> = (*grp.children)
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(|c| crate::with_element!(c, e => *e.transform))
            .collect();
        let child_xmls = slice_group_child_xmls(&orig)?;
        let mut lifted: Vec<String> = Vec::new();
        for (i, child_xml) in child_xmls.iter().enumerate() {
            let Some(Some(t)) = transforms.get(i) else {
                // No corresponding model, keep as-is
                lifted.push((*child_xml).to_owned());
                continue;
            };
            let co = t.offset;
            let slide_x = math_round((co.x.0 - ch_off.x.0) * scale_x + g_off.x.0);
            let slide_y = math_round((co.y.0 - ch_off.y.0) * scale_y + g_off.y.0);
            let slide_cx = math_round(co.cx.0 * scale_x);
            let slide_cy = math_round(co.cy.0 * scale_y);
            lifted.push(patch_element_xfrm_direct(
                child_xml, slide_x, slide_y, slide_cx, slide_cy, t.rot.0,
            ));
        }
        if let Some(all) = slide.elements.as_mut() {
            all.retain(|e| e.id() != source_id);
        }
        if lifted.is_empty() {
            // Empty group or extraction failed; just materialize
            slide.structure_dirty.set(true);
        }
        lifted
    };
    if lifted.is_empty() {
        return materialize_slide(opened, slide_index);
    }
    Ok(append_raw_elements(opened, slide_index, &lifted)?.is_some())
}

/// `patchElementXfrmDirect`: replace off/ext of the first xfrm block, keeping
/// rot/flip semantics of the arguments and a nested group's chOff/chExt.
fn patch_element_xfrm_direct(xml: &str, x: f64, y: f64, cx: f64, cy: f64, rot: f64) -> String {
    let Some(m) = js_regex!(r"(<(?:a|p):xfrm\b[^>]*>)([\s\S]*?)(<\/(?:a|p):xfrm>)").exec(xml)
    else {
        return xml.to_owned();
    };
    let open_tag = m.get(1).unwrap_or_default();
    let inner_xml = m.get(2).unwrap_or_default();
    let close_tag = m.get(3).unwrap_or_default();
    let ch_off = js_regex!(r"<a:chOff\b[^>]*\/>")
        .exec(inner_xml)
        .map_or("", |f| f.as_str());
    let ch_ext = js_regex!(r"<a:chExt\b[^>]*\/>")
        .exec(inner_xml)
        .map_or("", |f| f.as_str());
    let inner = format!(
        "<a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/>{ch_off}{ch_ext}",
        number_to_string(x),
        number_to_string(y),
        number_to_string(cx),
        number_to_string(cy)
    );
    let rot_attr = if number_truthy(rot) {
        format!(" rot=\"{}\"", number_to_string(rot))
    } else {
        String::new()
    };
    let flip_h = if open_tag.contains("flipH=\"1\"") {
        " flipH=\"1\""
    } else {
        ""
    };
    let flip_v = if open_tag.contains("flipV=\"1\"") {
        " flipV=\"1\""
    } else {
        ""
    };
    let tag = if open_tag.starts_with("<a:") {
        "a:xfrm"
    } else {
        "p:xfrm"
    };
    format!(
        "{}<{tag}{rot_attr}{flip_h}{flip_v}>{inner}{close_tag}{}",
        xml.get(..m.start()).unwrap_or_default(),
        xml.get(m.end()..).unwrap_or_default()
    )
}

// ── In-group editing ────────────────────────────────────────────────────

/// `elementEnd`: the end of the `<tag …>` element at `start`, closing tag
/// included (correct for self-closing and same-name nesting); `None` is -1.
pub(crate) fn element_end(xml: &str, start: usize, tag: &str) -> Result<Option<usize>, String> {
    let escaped = regex_escape(tag);
    let re = TryJsRegex::new(&format!(r"<{escaped}(?=[\s/>])[^>]*>|</{escaped}>"), "g")
        .map_err(|error| error.to_string())?;
    let mut depth = 0i64;
    // the pattern starts at `<` and reads nothing behind: the search of the
    // tail is the search from `lastIndex = start`
    let Some(tail) = xml.get(start..) else {
        return Ok(None);
    };
    for found in re.try_find_iter(tail) {
        let m = found.map_err(|error| error.to_string())?;
        let text = m.as_str();
        if text.starts_with("</") {
            depth -= 1;
            if depth == 0 {
                return Ok(Some(start + m.end()));
            }
        } else if text.ends_with("/>") {
            if depth == 0 {
                return Ok(Some(start + m.end()));
            }
        } else {
            depth += 1;
        }
    }
    Ok(None)
}

/// `GroupChildSlice`; `start` and `end` are byte offsets.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupChildSlice {
    pub start: usize,
    pub end: usize,
    pub xml: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nv_id: Option<String>,
}

/// `groupChildSlices`: direct child slices of the group XML (document order).
pub fn group_child_slices(grp_xml: &str) -> Result<Vec<GroupChildSlice>, String> {
    // The content region starts after the group's own </p:grpSpPr>
    let mut pos = js_regex!(r"<p:grpSpPr\b[^>]*\/>|<\/p:grpSpPr>")
        .exec(grp_xml)
        .map_or(0, |m| m.end());
    let open_re = js_regex!(
        r"<(p:(?:sp|pic|grpSp|graphicFrame|cxnSp)|mc:AlternateContent)(?=[\s/>])",
        "g"
    );
    let mut slices: Vec<GroupChildSlice> = Vec::new();
    // one search: the opens inside a child it has already walked are skipped
    for m in open_re.find_iter(grp_xml) {
        if m.start() < pos {
            continue;
        }
        let name = m.get(1).unwrap_or_default();
        let Some(end) = element_end(grp_xml, m.start(), name)? else {
            break;
        };
        // a markup-compatibility block is one child modelled from one branch
        if name == "mc:AlternateContent" {
            pos = end;
            continue;
        }
        let xml = grp_xml.get(m.start()..end).unwrap_or_default();
        // decoded, like the child's nvId the parser read
        let nv_id = js_regex!(r"<p:cNvPr\b[^>]*>")
            .exec(xml)
            .and_then(|f| attribute_of(f.as_str(), "id"))
            .filter(|id| !id.is_empty());
        slices.push(GroupChildSlice {
            start: m.start(),
            end,
            xml: xml.to_owned(),
            nv_id,
        });
        pos = end;
    }
    Ok(slices)
}

/// `patchGroupChildXml`: patch the in-group slice matching the child's nvId in
/// place. `nv_id` is `child.nvId` (the caller reads it before it borrows the
/// group); `true` on success.
pub fn patch_group_child_xml(
    grp: &mut GroupElement,
    nv_id: Option<&str>,
    patch: impl FnOnce(&str) -> Result<String, String>,
) -> Result<bool, String> {
    let Some(nv_id) = nv_id.filter(|id| !id.is_empty()) else {
        return Ok(false);
    };
    let Some(anchor) = grp.anchor.as_mut() else {
        return Ok(false);
    };
    let grp_xml = anchor.original_xml.clone();
    let slices = group_child_slices(&grp_xml)?;
    let Some(slice) = slices.iter().find(|s| s.nv_id.as_deref() == Some(nv_id)) else {
        return Ok(false);
    };
    let patched = patch(&slice.xml)?;
    anchor.original_xml = Arc::from(format!(
        "{}{patched}{}",
        grp_xml.get(..slice.start).unwrap_or_default(),
        grp_xml.get(slice.end..).unwrap_or_default()
    ));
    Ok(true)
}

/// `findGroupChild`: the indexes of the top-level group and of its direct
/// child in `slide.elements` and `group.children`.
pub fn find_group_child(slide: &Slide, group_id: &str, child_id: &str) -> Option<(usize, usize)> {
    let (gi, grp) = elements(slide)
        .iter()
        .enumerate()
        .find_map(|(i, e)| match e {
            SlideElement::Group(g) if e.id() == group_id => Some((i, g)),
            _ => None,
        })?;
    let ci = (*grp.children)
        .as_deref()?
        .iter()
        .position(|c| c.id() == child_id)?;
    Some((gi, ci))
}

/// `editGroupChildTransform`: offset is in the child EMU coordinate system.
pub fn edit_group_child_transform(
    slide: &mut Slide,
    group_id: &str,
    child_id: &str,
    offset: EmuRect,
    rotation_deg: f64,
) -> Result<bool, String> {
    let Some((gi, ci)) = find_group_child(slide, group_id, child_id) else {
        return Ok(false);
    };
    {
        let Some(grp) = group_at(slide, gi) else {
            return Ok(false);
        };
        let nv_id = child_nv_id(grp, ci);
        let Some(mut child) = (*grp.children).as_deref().and_then(|c| c.get(ci)).cloned() else {
            return Ok(false);
        };
        let prev = crate::with_element!(&child, e => *e.transform).unwrap_or(Transform {
            offset,
            rot: JsNum(0.0),
            flip_h: false,
            flip_v: false,
        });
        let next = Transform {
            offset,
            rot: JsNum(math_round(rotation_deg * 60000.0)),
            ..prev
        };
        crate::with_element!(&mut child, e => e.transform.set(next));
        // patchElementXfrm reads the model transform
        let patched = patch_group_child_xml(grp, nv_id.as_deref(), |xml| {
            Ok(patch_element_xfrm(&child, xml))
        })?;
        if !patched {
            return Ok(false);
        }
        if let Some(target) = grp.children.as_mut().and_then(|c| c.get_mut(ci)) {
            crate::with_element!(target, e => e.transform.set(next));
        }
    }
    slide.structure_dirty.set(true);
    Ok(true)
}

/// `patchGroupChildText`: called after the model paragraphs are updated;
/// regenerates the slice's txBody.
pub fn patch_group_child_text(
    slide: &mut Slide,
    group_id: &str,
    child: &TextElement,
) -> Result<bool, String> {
    let Some(gi) = elements(slide)
        .iter()
        .position(|e| matches!(e, SlideElement::Group(_)) && e.id() == group_id)
    else {
        return Ok(false);
    };
    let Some(grp) = group_at(slide, gi) else {
        return Ok(false);
    };
    if !patch_group_child_xml(grp, child.nv_id.as_deref(), |xml| {
        patch_text_element_xml(child, xml)
    })? {
        return Ok(false);
    }
    slide.structure_dirty.set(true);
    Ok(true)
}

/// `setGroupChildFont`: font/size on a whole group child. `size_map` is
/// `FontSizeMap`.
pub fn set_group_child_font(
    slide: &mut Slide,
    group_id: &str,
    child_id: &str,
    patch: &ElementFontPatch,
    size_map: Option<&dyn Fn(Option<f64>) -> f64>,
) -> Result<bool, String> {
    let Some((gi, ci)) = find_group_child(slide, group_id, child_id) else {
        return Ok(false);
    };
    let updated = {
        let Some(grp) = group_at(slide, gi) else {
            return Ok(false);
        };
        let Some(t) = text_child_mut(grp, ci) else {
            return Ok(false);
        };
        let Some(body) = t.text.as_mut() else {
            return Ok(false);
        };
        let Some(paragraphs) = body.paragraphs.as_mut() else {
            return Ok(false);
        };
        if paragraphs.is_empty() {
            return Ok(false);
        }
        apply_font_patch(paragraphs, patch, size_map);
        t.clone()
    };
    patch_group_child_text(slide, group_id, &updated)
}

/// `editGroupChildFill`: 'none' | #RRGGBB(AA) | gradient.
pub fn edit_group_child_fill(
    slide: &mut Slide,
    group_id: &str,
    child_id: &str,
    fill: &FillPatch,
) -> Result<bool, String> {
    let Some((gi, ci)) = find_group_child(slide, group_id, child_id) else {
        return Ok(false);
    };
    {
        let Some(grp) = group_at(slide, gi) else {
            return Ok(false);
        };
        let nv_id = child_nv_id(grp, ci);
        let Some(t) = text_child_mut(grp, ci) else {
            return Ok(false);
        };
        let model = match fill {
            FillPatch::Color(color) if color == "none" => Fill::None,
            FillPatch::Color(color) => Fill::Solid {
                color: color.clone(),
            },
            FillPatch::Gradient(g) => {
                // radial is the legacy alias for path: circle
                let path = g.path.or_else(|| {
                    g.radial
                        .unwrap_or(false)
                        .then_some(crate::types::GradientPath::Circle)
                });
                Fill::Gradient(GradientFill {
                    stops: g.stops.clone(),
                    angle: g.angle,
                    scaled: None,
                    path,
                    fill_to: if path.is_some() { g.fill_to } else { None },
                    tile_rect: None,
                })
            }
            _ => return Ok(false),
        };
        t.fill.set(model);
        if !patch_group_child_xml(grp, nv_id.as_deref(), |xml| patch_element_fill(xml, fill))? {
            return Ok(false);
        }
    }
    slide.structure_dirty.set(true);
    Ok(true)
}

/// `modelStrokeToPatch`: in-memory Stroke → StrokePatch (inverse of
/// `strokePatchToModel`); `None` for fills a StrokePatch cannot express.
#[allow(dead_code)]
pub(crate) fn model_stroke_to_patch(stroke: &Stroke) -> Option<StrokePatch> {
    let cap = stroke.cap.map(|cap| {
        match cap {
            LineCap::Flat => "flat",
            LineCap::Round => "rnd",
            LineCap::Square => "sq",
        }
        .to_owned()
    });
    let join = stroke.join.map(|j| {
        match j {
            crate::types::LineJoin::Round => "round",
            crate::types::LineJoin::Bevel => "bevel",
            crate::types::LineJoin::Miter => "miter",
        }
        .to_owned()
    });
    let compound = stroke.compound.map(|c| {
        match c {
            crate::types::LineCompound::Sng => "sng",
            crate::types::LineCompound::Dbl => "dbl",
            crate::types::LineCompound::ThickThin => "thickThin",
            crate::types::LineCompound::ThinThick => "thinThick",
            crate::types::LineCompound::Tri => "tri",
        }
        .to_owned()
    });
    // 'solid' actively clears a stale prstDash left in the original bytes
    let dash = Some(stroke.dash.clone().unwrap_or_else(|| "solid".to_owned()));
    match &stroke.fill {
        Fill::Solid { color } => Some(StrokePatch {
            color: color.clone(),
            width_emu: stroke.width,
            dash,
            cap,
            compound,
            join,
            gradient: None,
        }),
        Fill::Gradient(g) => Some(StrokePatch {
            color: g
                .stops
                .first()
                .map_or_else(|| "#000000".to_owned(), |s| s.color.clone()),
            width_emu: stroke.width,
            dash,
            cap,
            compound,
            join,
            gradient: Some(StrokeGradient {
                stops: g.stops.clone(),
                angle: g.angle.unwrap_or(JsNum(0.0)),
            }),
        }),
        _ => None,
    }
}

/// `strokePatchToModel`: StrokePatch → in-memory Stroke (mirrors what
/// `patchLnXml` writes into the XML).
pub fn stroke_patch_to_model(stroke: &StrokePatch) -> Stroke {
    let fill = match &stroke.gradient {
        Some(g) => Fill::Gradient(GradientFill {
            stops: g.stops.clone(),
            angle: Some(JsNum(math_round(g.angle.0))),
            scaled: None,
            path: None,
            fill_to: None,
            tile_rect: None,
        }),
        None => Fill::Solid {
            color: stroke.color.clone(),
        },
    };
    Stroke {
        fill,
        width: stroke.width_emu,
        dash: stroke
            .dash
            .clone()
            .filter(|d| !d.is_empty() && d != "solid"),
        cap: match stroke.cap.as_deref() {
            Some("flat") => Some(LineCap::Flat),
            Some("rnd") => Some(LineCap::Round),
            Some("sq") => Some(LineCap::Square),
            _ => None,
        },
        join: match stroke.join.as_deref() {
            Some("round") => Some(crate::types::LineJoin::Round),
            Some("bevel") => Some(crate::types::LineJoin::Bevel),
            Some("miter") => Some(crate::types::LineJoin::Miter),
            _ => None,
        },
        compound: match stroke.compound.as_deref() {
            Some("dbl") => Some(crate::types::LineCompound::Dbl),
            Some("thickThin") => Some(crate::types::LineCompound::ThickThin),
            Some("thinThick") => Some(crate::types::LineCompound::ThinThick),
            Some("tri") => Some(crate::types::LineCompound::Tri),
            _ => None,
        },
        head_end: None,
        tail_end: None,
    }
}

/// `editGroupChildStroke`: `None` removes the stroke.
pub fn edit_group_child_stroke(
    slide: &mut Slide,
    group_id: &str,
    child_id: &str,
    stroke: Option<&StrokePatch>,
) -> Result<bool, String> {
    let Some((gi, ci)) = find_group_child(slide, group_id, child_id) else {
        return Ok(false);
    };
    {
        let Some(grp) = group_at(slide, gi) else {
            return Ok(false);
        };
        let nv_id = child_nv_id(grp, ci);
        let model = stroke.map(stroke_patch_to_model);
        match grp.children.as_mut().and_then(|c| c.get_mut(ci)) {
            Some(SlideElement::Text(t)) => t.stroke.assign(model),
            Some(SlideElement::Picture(p)) => p.stroke.assign(model),
            _ => return Ok(false),
        }
        if !patch_group_child_xml(grp, nv_id.as_deref(), |xml| {
            patch_element_stroke(xml, stroke)
        })? {
            return Ok(false);
        }
    }
    slide.structure_dirty.set(true);
    Ok(true)
}

/// `setGroupChildShapeAdjustValues`: same avLst-swap semantics as `setShapeAdjustValues`.
pub fn set_group_child_shape_adjust_values(
    slide: &mut Slide,
    group_id: &str,
    child_id: &str,
    adjust: &JsObject<JsNum>,
) -> Result<bool, String> {
    let numbers: JsObject<f64> = adjust
        .entries()
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.0))
        .collect();
    if !valid_adjust(&numbers) {
        return Ok(false);
    }
    let Some((gi, ci)) = find_group_child(slide, group_id, child_id) else {
        return Ok(false);
    };
    {
        let Some(grp) = group_at(slide, gi) else {
            return Ok(false);
        };
        if !grp
            .children
            .as_deref()
            .and_then(|c| c.get(ci))
            .is_some_and(is_text_or_shape)
        {
            return Ok(false);
        }
        let nv_id = child_nv_id(grp, ci);
        let mut swapped = false;
        let ok = patch_group_child_xml(grp, nv_id.as_deref(), |xml| {
            let next = swap_av_lst_xml(xml, &numbers);
            swapped = next.is_some();
            Ok(next.unwrap_or_else(|| xml.to_owned()))
        })?;
        if !ok || !swapped {
            return Ok(false);
        }
        let Some(t) = text_child_mut(grp, ci) else {
            return Ok(false);
        };
        t.adjust.set(adjust.clone());
    }
    slide.structure_dirty.set(true);
    Ok(true)
}

/// `setGroupChildShapePresetGeometry`: same geometry-swap semantics as `setShapePresetGeometry`.
pub fn set_group_child_shape_preset_geometry(
    slide: &mut Slide,
    group_id: &str,
    child_id: &str,
    prst: &str,
) -> Result<bool, String> {
    if !js_regex!(r"^[A-Za-z0-9]+$").test(prst) {
        return Ok(false);
    }
    let Some((gi, ci)) = find_group_child(slide, group_id, child_id) else {
        return Ok(false);
    };
    {
        let Some(grp) = group_at(slide, gi) else {
            return Ok(false);
        };
        if !grp
            .children
            .as_deref()
            .and_then(|c| c.get(ci))
            .is_some_and(is_text_or_shape)
        {
            return Ok(false);
        }
        let nv_id = child_nv_id(grp, ci);
        let mut swapped = false;
        let ok = patch_group_child_xml(grp, nv_id.as_deref(), |xml| {
            let next = swap_geometry_xml(xml, &preset_geom_xml(prst));
            swapped = next.is_some();
            Ok(next.unwrap_or_else(|| xml.to_owned()))
        })?;
        if !ok || !swapped {
            return Ok(false);
        }
        let Some(shape) = text_child_mut(grp, ci) else {
            return Ok(false);
        };
        shape.preset_geometry.set(prst.to_owned());
        shape.adjust.delete();
        shape.custom_geometry.delete();
    }
    slide.structure_dirty.set(true);
    Ok(true)
}

/// `setGroupChildShapeCustomGeometry`: freeform geometry. `geom` is the
/// `CustGeomPath` as JSON, validated here as `validCustGeomPath` does.
pub fn set_group_child_shape_custom_geometry(
    slide: &mut Slide,
    group_id: &str,
    child_id: &str,
    geom: &Value,
) -> Result<bool, String> {
    if !valid_cust_geom_path(Some(geom))? {
        return Ok(false);
    }
    let Some((gi, ci)) = find_group_child(slide, group_id, child_id) else {
        return Ok(false);
    };
    let path: CustGeomPath = serde_json::from_value(geom.clone()).map_err(|e| e.to_string())?;
    {
        let Some(grp) = group_at(slide, gi) else {
            return Ok(false);
        };
        if !grp
            .children
            .as_deref()
            .and_then(|c| c.get(ci))
            .is_some_and(is_text_or_shape)
        {
            return Ok(false);
        }
        let nv_id = child_nv_id(grp, ci);
        let mut written: Option<String> = None;
        let ok = patch_group_child_xml(grp, nv_id.as_deref(), |xml| {
            written = swap_geometry_xml(xml, &cust_geom_xml(&path));
            Ok(written.clone().unwrap_or_else(|| xml.to_owned()))
        })?;
        let Some(written) = written.filter(|_| ok) else {
            return Ok(false);
        };
        let Some(shape) = text_child_mut(grp, ci) else {
            return Ok(false);
        };
        apply_custom_geometry_model(shape, &written)?;
    }
    slide.structure_dirty.set(true);
    Ok(true)
}
