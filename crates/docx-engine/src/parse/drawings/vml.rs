//! The VML readers of parse.ts: horizontal rules, shapes a paragraph floats or
//! keeps inline, stroke and length units, Word's mso-position keywords, and
//! picture geometry.

use jscompat::{JsMap, JsMatch, JsNum, JsObject, js_regex, math_max, math_round, parse_float};
use ooxml_xml::XNode;

use super::{EMU_PER_PT, EMU_PER_PX, EMU_PER_TWIP};
use crate::model::{
    Block, BlockImageAlign, BlockImagePosH, BlockImagePosV, ImageWrap, RunImageRule,
    RunImageRuleAlign, SectionSettings, TextboxDisplay, TextboxDisplayPageRelVFrom,
};
use crate::parse::tables::hf::has_deep_child_outside;
use crate::vml::shape::{VML_PICT_RID_RE, vml_shape_svg};

/// The first capture of a match.
fn capture<'t>(found: Option<JsMatch<'t>>) -> Option<&'t str> {
    found.and_then(|found| found.get(1))
}

/// `vmlHrRule`: the stroke of a VML horizontal rule (`<v:rect o:hr="t">`
/// opening tag). A width of 0 means "fill the available width".
pub fn vml_hr_rule(hr_rect: &str) -> RunImageRule {
    let fill = js_regex!(r##"fillcolor="#?([0-9A-Fa-f]{6})""##)
        .exec(hr_rect)
        .and_then(|found| found.get(1));
    let h_pt = parse_float(
        js_regex!(r"height:([\d.]+)pt")
            .exec(hr_rect)
            .and_then(|found| found.get(1))
            .unwrap_or(""),
    );
    let w_pt = parse_float(
        js_regex!(r"width:([\d.]+)pt")
            .exec(hr_rect)
            .and_then(|found| found.get(1))
            .unwrap_or(""),
    );
    let align = js_regex!(r#"o:hralign="(center|right)""#)
        .exec(hr_rect)
        .and_then(|found| found.get(1))
        .map(|align| {
            if align == "center" {
                RunImageRuleAlign::Center
            } else {
                RunImageRuleAlign::Right
            }
        });
    RunImageRule {
        color_hex: fill.map(str::to_ascii_uppercase),
        thickness_px: (h_pt > 0.0).then(|| JsNum(math_max(1.0, math_round((h_pt / 72.0) * 96.0)))),
        size_half_points: None,
        width_px: (w_pt > 0.0).then(|| JsNum(math_round((w_pt / 72.0) * 96.0))),
        align: align.filter(|_| w_pt > 0.0),
    }
}

/// `hasFloatingVmlGeometry`: a textless top-level v:shape/rect/roundrect/oval
/// placed with position:absolute.
pub fn has_floating_vml_geometry(xml: &str) -> bool {
    if VML_PICT_RID_RE.test(xml) || xml.contains("<w:txbxContent") {
        return false;
    }
    js_regex!(r#"<v:(?:shape|rect|roundrect|oval)\b[^>]*\bstyle="[^"]*position:\s*absolute"#)
        .test(xml)
}

/// `vmlPictsInlineOnly`: every w:pict of the paragraph either draws nothing
/// (no shape instance) or is an inline shape the SVG path can render.
pub fn vml_picts_inline_only(xml: &str, shape_types: Option<&JsMap<JsObject<String>>>) -> bool {
    let picts: Vec<&str> = js_regex!(r"<w:pict[\s>][\s\S]*?<\/w:pict>|<w:pict\s*\/>")
        .find_iter(xml)
        .map(|found| found.as_str())
        .collect();
    if picts.is_empty() || VML_PICT_RID_RE.test(xml) {
        return false;
    }
    picts.iter().all(|pict| {
        let body = js_regex!(r"<v:shapetype\b[\s\S]*?<\/v:shapetype>|<v:shapetype\b[^>]*\/>")
            .replace_all(pict, |_| String::new());
        if !js_regex!(r"<v:\w+").test(&body) {
            return true;
        }
        !js_regex!(r"position:\s*absolute").test(pict) && vml_shape_svg(pict, shape_types).is_some()
    })
}

/// `vmlFlagOff`
pub fn vml_flag_off(value: Option<&str>) -> bool {
    matches!(value, Some("f" | "false" | "0"))
}

/// `vmlStrokeWeightPx`: v:shape strokeweight ("0.75pt", "2px", bare = pt) as
/// CSS px.
pub fn vml_stroke_weight_px(value: Option<&str>) -> Option<f64> {
    let found = js_regex!(r"^\s*([\d.]+)\s*(pt|px)?\s*$").exec(value.unwrap_or(""))?;
    let n = parse_float(found.get(1).unwrap_or(""));
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    let px = if found.get(2) == Some("px") {
        n
    } else {
        (n / 72.0) * 96.0
    };
    Some(math_round(px * 100.0) / 100.0)
}

/// `applyVmlMsoPosition`: Word's VML placement of a top-level absolute shape.
/// mso-position-horizontal keywords resolve against the column, margin or
/// page box (relative "text", the default, is the column), and
/// page/margin-relative numeric offsets become page positions.
pub fn apply_vml_mso_position(box_: &mut TextboxDisplay, style: &str, sect: &SectionSettings) {
    let pos_h = capture(js_regex!(r"mso-position-horizontal:(\w+)").exec(style));
    let rel_h =
        capture(js_regex!(r"mso-position-horizontal-relative:(\w+)").exec(style)).unwrap_or("text");
    let rel_v =
        capture(js_regex!(r"mso-position-vertical-relative:(\w+)").exec(style)).unwrap_or("text");
    let mar_l = sect.margin_left.0 * EMU_PER_TWIP;
    let col_w = (sect.page_width.0 - sect.margin_left.0 - sect.margin_right.0) * EMU_PER_TWIP;
    let from_page = rel_h == "page";
    if from_page || rel_h == "margin" || sect.columns.0 <= 1.0 {
        let origin_x = if from_page { -mar_l } else { 0.0 };
        let span_w = if from_page {
            sect.page_width.0 * EMU_PER_TWIP
        } else {
            col_w
        };
        let w_emu = box_.width_px.map(|width| width.0 * EMU_PER_PX);
        match (pos_h, w_emu) {
            (Some("left" | "inside"), _) => box_.offset_x_emu.set(JsNum(math_round(origin_x))),
            (Some("right" | "outside"), Some(w_emu)) => box_
                .offset_x_emu
                .set(JsNum(math_round(origin_x + span_w - w_emu))),
            (Some("center"), Some(w_emu)) => box_
                .offset_x_emu
                .set(JsNum(math_round(origin_x + (span_w - w_emu) / 2.0))),
            _ if from_page => {
                let x = box_.offset_x_emu.map_or(0.0, |x| x.0);
                box_.offset_x_emu.set(JsNum(math_round(x + origin_x)));
            }
            _ => {}
        }
    }
    let pos_v = capture(js_regex!(r"mso-position-vertical:(\w+)").exec(style));
    let numeric_v = matches!(pos_v, None | Some("absolute"));
    if matches!(rel_v, "page" | "margin") && numeric_v {
        if rel_v == "page" {
            let y = box_.offset_y_emu.map_or(0.0, |y| y.0);
            box_.offset_y_emu
                .set(JsNum(math_round(y - sect.margin_top.0 * EMU_PER_TWIP)));
        }
        box_.page_rel_v.set(true);
        box_.page_rel_v_from.set(if rel_v == "page" {
            TextboxDisplayPageRelVFrom::Page
        } else {
            TextboxDisplayPageRelVFrom::Margin
        });
    }
}

/// `vmlLengthPx` of parse.ts: a VML CSS length in px, pt / in / cm / mm / px /
/// pc, unitless = pt (Word writes a bare 0), rounded to 1/100 px. Not the
/// `vmlLengthPx` of parse-vml.ts (`crate::vml::vml_length_px`).
pub fn vml_length_px(raw: Option<&str>) -> Option<f64> {
    let found = js_regex!(r"^\s*(-?[\d.]+)\s*(pt|in|cm|mm|px|pc)?\s*$").exec(raw.unwrap_or(""))?;
    let v = parse_float(found.get(1).unwrap_or(""));
    if !v.is_finite() {
        return None;
    }
    let per_in = match found.get(2).unwrap_or("pt") {
        "in" => 1.0,
        "cm" => 2.54,
        "mm" => 25.4,
        "px" => 96.0,
        "pc" => 6.0,
        _ => 72.0,
    };
    Some(math_round((v / per_in) * 96.0 * 100.0) / 100.0)
}

/// `vmlImageMeta`: VML picture geometry (v:shape style) as the DrawingML
/// image fields of a block: size, absolute offsets, behind-text z-index and
/// margin- or page-relative keyword placement.
pub fn vml_image_meta(xml: &str) -> Block {
    let mut meta = Block::default();
    let style = capture(js_regex!(r#"<v:shape [^>]*style="([^"]*)""#).exec(xml)).unwrap_or("");
    let w = parse_float(capture(js_regex!(r"(?:^|;)width:([\d.]+)pt").exec(style)).unwrap_or(""));
    let h = parse_float(capture(js_regex!(r"(?:^|;)height:([\d.]+)pt").exec(style)).unwrap_or(""));
    if w > 0.0 {
        meta.image_width_px
            .set(JsNum(math_round((w / 72.0) * 96.0)));
    }
    if h > 0.0 {
        meta.image_height_px
            .set(JsNum(math_round((h / 72.0) * 96.0)));
    }
    match capture(js_regex!(r#"<w:jc w:val="([^"]+)""#).exec(xml)) {
        Some("center") => meta.image_align.set(BlockImageAlign::Center),
        Some("right" | "end") => meta.image_align.set(BlockImageAlign::Right),
        _ => {}
    }
    if js_regex!(r"position:absolute").test(style) {
        meta.image_wrap
            .set(if js_regex!(r"z-index:\s*-").test(style) {
                ImageWrap::Behind
            } else {
                ImageWrap::Front
            });
        let mx =
            parse_float(capture(js_regex!(r"margin-left:(-?[\d.]+)pt").exec(style)).unwrap_or(""));
        let my =
            parse_float(capture(js_regex!(r"margin-top:(-?[\d.]+)pt").exec(style)).unwrap_or(""));
        if mx.is_finite() {
            meta.image_offset_x_emu
                .set(JsNum(math_round(mx * EMU_PER_PT)));
        }
        if my.is_finite() {
            meta.image_offset_y_emu
                .set(JsNum(math_round(my * EMU_PER_PT)));
        }
        let pos_h = capture(js_regex!(r"mso-position-horizontal:(\w+)").exec(style));
        let pos_v = capture(js_regex!(r"mso-position-vertical:(\w+)").exec(style));
        let rel_h = capture(js_regex!(r"mso-position-horizontal-relative:(\w+)").exec(style));
        let rel_v = capture(js_regex!(r"mso-position-vertical-relative:(\w+)").exec(style));
        let pos_h = match pos_h {
            Some("left") => Some(BlockImagePosH::Left),
            Some("center") => Some(BlockImagePosH::Center),
            Some("right") => Some(BlockImagePosH::Right),
            _ => None,
        };
        let pos_v = match pos_v {
            Some("top") => Some(BlockImagePosV::Top),
            Some("center") => Some(BlockImagePosV::Center),
            Some("bottom") => Some(BlockImagePosV::Bottom),
            _ => None,
        };
        if let (Some("margin" | "page"), Some("margin" | "page"), Some(pos_h), Some(pos_v)) =
            (rel_h, rel_v, pos_h, pos_v)
        {
            meta.image_pos_h.set(pos_h);
            meta.image_pos_v.set(pos_v);
        }
    }
    meta
}

/// `vmlStrokeChildOff`: a v:stroke child that switches the stroke off.
pub fn vml_stroke_child_off(shape: &XNode) -> bool {
    shape
        .find_child("v:stroke")
        .is_some_and(|stroke| vml_flag_off(stroke.attr("on")))
}

/// `hasDeepChild`: depth-first search for any descendant with one of the
/// given names.
pub fn has_deep_child(node: &XNode, names: &[&str]) -> bool {
    has_deep_child_outside(node, names, None)
}

/// `hasFloatingVmlPicture`: any descendant floating VML picture shape
/// (watermarks), drawn at its anchor and never in the flow. Textbox shapes are
/// excluded: their own content decides.
pub fn has_floating_vml_picture(node: &XNode) -> bool {
    for child in node.children() {
        if child.name().is_some_and(|name| name.starts_with("v:"))
            && js_regex!(r"position:\s*absolute").test(child.attr("style").unwrap_or(""))
            && !has_deep_child(child, &["w:txbxContent"])
        {
            return true;
        }
        if has_floating_vml_picture(child) {
            return true;
        }
    }
    false
}
