//! run-picture.ts: the pictures a header/footer strip or the run editor moved,
//! resized or re-wrapped, written back into their `<w:drawing>`.

use jscompat::{number_to_string, try_js_regex};
use serde::Deserialize;

use super::js::{limit, replace_first, replace_first_with};
use crate::generate::drawing_patch::{
    PosOffset, apply_image_wrap, resize_anchored_picture_xml, resize_inline_picture_xml,
    swap_anchor_wrap,
};
use crate::model::{HfPictureEdit, ImageWrap, NumberRecord};
use crate::parse::drawings::image::run_picture_anchor_of;
use crate::parse::tables::hf::hf_movable_picture_frag;
use crate::xml_number::xml_position_offset;

const EMU_PER_PX: f64 = 9525.0;

/// `patchHfPicturesXml`: each edited `<w:drawing>` (by its ordinal) takes the
/// new extents, and each axis it moved along is pinned to the page at the new
/// top-left corner. Every other byte of the part is kept.
pub fn patch_hf_pictures_xml(
    part_xml: &str,
    edits: &NumberRecord<HfPictureEdit>,
) -> Result<String, String> {
    let mut ordinal: i64 = -1;
    let mut failure: Option<String> = None;
    let out = try_js_regex!(r"<w:drawing[\s>][\s\S]*?<\/w:drawing>", "g")
        .try_replace_all(part_xml, |found| {
            ordinal += 1;
            let frag = found.as_str();
            let Some(edit) = edits.0.get(&ordinal.to_string()) else {
                return frag.to_owned();
            };
            if !hf_movable_picture_frag(frag) {
                return frag.to_owned();
            }
            let step = || -> Result<String, String> {
                let mut out = frag.to_owned();
                if edit.pos_x_px.is_some() || edit.pos_y_px.is_some() {
                    // simplePos="1" places by wp:simplePos instead of the position elements
                    out = replace_first(
                        try_js_regex!(r#"(<wp:anchor\b[^>]*\bsimplePos=")(?:1|true)""#),
                        1,
                        &out,
                        "$10\"",
                    )?;
                    out = set_anchor_position(&out, 'H', edit.pos_x_px.map(|n| n.0))?;
                    out = set_anchor_position(&out, 'V', edit.pos_y_px.map(|n| n.0))?;
                }
                Ok(resize_anchored_picture_xml(
                    &out,
                    edit.width_px.0,
                    edit.height_px.0,
                ))
            };
            match step() {
                Ok(out) => out,
                Err(error) => {
                    failure.get_or_insert(error);
                    frag.to_owned()
                }
            }
        })
        .map_err(limit)?;
    match failure {
        Some(error) => Err(error),
        None => Ok(out),
    }
}

/// `setAnchorPosition`: an anchor's wp:positionH / wp:positionV set to a
/// page-relative offset, or left alone when `px` is absent.
fn set_anchor_position(xml: &str, axis: char, px: Option<f64>) -> Result<String, String> {
    let Some(emu) = px.and_then(|px| xml_position_offset(px * EMU_PER_PX)) else {
        return Ok(xml.to_owned());
    };
    let el = format!(
        "<wp:position{axis} relativeFrom=\"page\"><wp:posOffset>{emu}</wp:posOffset></wp:position{axis}>"
    );
    let existing = super::js::dynamic(
        &format!(r"<wp:position{axis}\b[\s\S]*?</wp:position{axis}>"),
        "",
    )?;
    if existing.try_test(xml).map_err(limit)? {
        return replace_first(&existing, 0, xml, &el);
    }
    // the element it follows: wp:positionH for V, else wp:simplePos, else the anchor's open tag
    let mut follows_end: Option<usize> = None;
    if axis == 'V' {
        follows_end = try_js_regex!(r"<wp:positionH\b[\s\S]*?<\/wp:positionH>")
            .try_exec(xml)
            .map_err(limit)?
            .map(|found| found.end());
    }
    if follows_end.is_none() {
        follows_end =
            try_js_regex!(r"<wp:simplePos\b[^>]*\/>|<wp:simplePos\b[\s\S]*?<\/wp:simplePos>")
                .try_exec(xml)
                .map_err(limit)?
                .map(|found| found.end());
    }
    if follows_end.is_none() {
        follows_end = try_js_regex!(r"<wp:anchor\b[^>]*>")
            .try_exec(xml)
            .map_err(limit)?
            .map(|found| found.end());
    }
    let Some(end) = follows_end else {
        return Ok(xml.to_owned());
    };
    Ok(format!("{}{el}{}", &xml[..end], &xml[end..]))
}

/// `RunPictureGeometry`: the editor's geometry of a run-level picture. Absent
/// and null are the same.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPictureGeometry {
    #[serde(default, deserialize_with = "jscompat::js_f64_opt")]
    pub width_px: Option<f64>,
    #[serde(default, deserialize_with = "jscompat::js_f64_opt")]
    pub height_px: Option<f64>,
    pub wrap: Option<ImageWrap>,
    #[serde(default, deserialize_with = "jscompat::js_f64_opt")]
    pub offset_x_emu: Option<f64>,
    #[serde(default, deserialize_with = "jscompat::js_f64_opt")]
    pub offset_y_emu: Option<f64>,
    pub rel_h: Option<String>,
    pub rel_v: Option<String>,
    pub line_center_v: Option<bool>,
}

/// `positionOffset`: an offset in EMU as wp:posOffset can hold it, rounded.
fn position_offset(emu: Option<f64>) -> Option<f64> {
    let text = emu.and_then(xml_position_offset)?;
    text.parse::<f64>().ok()
}

fn wrap_kind(wrap: Option<&ImageWrap>) -> Option<String> {
    wrap.map(|wrap| {
        let text = wrap.as_str();
        text.strip_suffix("-left")
            .or_else(|| text.strip_suffix("-right"))
            .unwrap_or(text)
            .to_owned()
    })
}

fn wrap_side(wrap: Option<&ImageWrap>) -> Option<&'static str> {
    let text = wrap?.as_str();
    if text.ends_with("-left") {
        Some("left")
    } else if text.ends_with("-right") {
        Some("right")
    } else {
        None
    }
}

/// `resize` of run-picture.ts.
fn resize(xml: &str, next: &RunPictureGeometry) -> String {
    let w = next.width_px.unwrap_or(0.0);
    let h = next.height_px.unwrap_or(0.0);
    #[allow(clippy::neg_cmp_op_on_partial_ord)] // NaN-aware, as the TypeScript `!(w > 0)`
    let bad = !(w > 0.0) || !(h > 0.0);
    if bad {
        return xml.to_owned();
    }
    if jscompat::js_regex!(r"<wp:anchor[\s>]").test(xml) {
        resize_anchored_picture_xml(xml, w, h)
    } else {
        resize_inline_picture_xml(xml, w, h)
    }
}

/// `patchRunPictureXml`: a run-level picture's edited geometry written back
/// into its `<w:drawing>` fragment. Only what differs from the fragment's own
/// geometry is rewritten; a VML picture comes back unchanged.
pub fn patch_run_picture_xml(xml: &str, next: &RunPictureGeometry) -> Result<String, String> {
    if !jscompat::js_regex!(r"<wp:(?:inline|anchor)[\s>]").test(xml) {
        return Ok(xml.to_owned());
    }
    let cur = run_picture_anchor_of(xml)?;
    let wrap = next.wrap.as_ref();
    // an offset with no wp:posOffset text is no move
    let x = position_offset(next.offset_x_emu);
    let y = position_offset(next.offset_y_emu);
    let mut out = xml.to_owned();
    let cur_wrap = cur.wrap.as_ref();
    if wrap != cur_wrap {
        let anchored = jscompat::js_regex!(r"<wp:anchor[\s>]").test(&out);
        if wrap.is_none() || !anchored {
            // in-line <-> floating: the anchor is rebuilt; a known offset pins it
            let placed = x.is_some() || y.is_some();
            let pos = PosOffset {
                x: x.unwrap_or(0.0),
                y: y.unwrap_or(0.0),
                relative_to: None,
            };
            out = apply_image_wrap(&out, wrap.cloned(), placed.then_some(&pos), None, None);
            return Ok(resize(&out, next));
        }
        // the side of a square/tight/through float is read off its position
        if wrap_kind(wrap) != wrap_kind(cur_wrap) {
            out = swap_anchor_wrap(&out, wrap.cloned().unwrap_or(ImageWrap::Front), None);
        }
        let side = wrap_side(wrap);
        if x.is_none()
            && let Some(side) = side
            && Some(side) != wrap_side(cur_wrap)
        {
            out = replace_first(
                try_js_regex!(r"<wp:positionH\b[\s\S]*?<\/wp:positionH>"),
                0,
                &out,
                &format!(
                    "<wp:positionH relativeFrom=\"column\"><wp:align>{side}</wp:align></wp:positionH>"
                ),
            )?;
        }
    }
    if wrap.is_some() && jscompat::js_regex!(r"<wp:anchor[\s>]").test(&out) {
        let rel_h = next.rel_h.as_deref();
        let rel_v = next.rel_v.as_deref();
        let cur_rel_h = cur.rel_h.map(|rel| rel_str_h(&rel));
        let cur_rel_v = cur.rel_v.map(|rel| rel_str_v(&rel));
        if let Some(x) = x
            && (Some(x) != cur.offset_x_emu.map(|n| n.0) || rel_h != cur_rel_h.as_deref())
        {
            out = replace_first_with(
                try_js_regex!(r"<wp:positionH\b[\s\S]*?<\/wp:positionH>"),
                &out,
                |_| {
                    format!(
                        "<wp:positionH relativeFrom=\"{}\"><wp:posOffset>{}</wp:posOffset></wp:positionH>",
                        rel_h.unwrap_or("column"),
                        number_to_string(x)
                    )
                },
            )?;
        }
        if let Some(y) = y
            && (Some(y) != cur.offset_y_emu.map(|n| n.0)
                || rel_v != cur_rel_v.as_deref()
                || next.line_center_v.unwrap_or(false) != cur.line_center_v.unwrap_or(false))
        {
            out = replace_first_with(
                try_js_regex!(r"<wp:positionV\b[\s\S]*?<\/wp:positionV>"),
                &out,
                |_| {
                    format!(
                        "<wp:positionV relativeFrom=\"{}\"><wp:posOffset>{}</wp:posOffset></wp:positionV>",
                        rel_v.unwrap_or("paragraph"),
                        number_to_string(y)
                    )
                },
            )?;
        }
    }
    Ok(resize(&out, next))
}

fn rel_str_h(rel: &crate::model::RunImageRelH) -> String {
    serde_json::to_value(rel)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn rel_str_v(rel: &crate::model::RunImageRelV) -> String {
    serde_json::to_value(rel)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}
