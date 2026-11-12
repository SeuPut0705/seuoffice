//! The picture and shape patches of generate.ts: size, rotation, alignment,
//! position, wrap and stacking of an existing drawing, rewritten in its bytes.

use jscompat::{
    JsMatch, JsRegex, get_substitution as substitute, js_regex, math_max as js_max, math_round,
    number_to_string, replace_first_with, to_number,
};

use super::text_patch::{para_plain_text, xml_segments};
use crate::model::ImageWrap;
use crate::xml_number::{
    xml_decimal, xml_int, xml_position_offset, xml_positive_coordinate, xml_unsigned_int,
};
use serde::{Deserialize, Deserializer};

const EMU_PER_PX: f64 = 9525.0;

/// `if (x)` on a number.
fn num_truthy(x: Option<f64>) -> bool {
    matches!(x, Some(x) if x != 0.0 && !x.is_nan())
}

fn num(x: f64) -> String {
    number_to_string(x)
}

fn groups_of<'t>(m: &JsMatch<'t>, count: usize) -> Vec<Option<&'t str>> {
    (1..=count).map(|index| m.get(index)).collect()
}

/// `text.replace(re, template)` without the `g` flag; `count` is the number
/// of capture groups of `re`.
fn replace_first(re: &JsRegex, count: usize, text: &str, template: &str) -> String {
    match re.exec(text) {
        Some(m) => {
            let replacement =
                substitute(m.as_str(), text, m.start(), &groups_of(&m, count), template);
            format!("{}{}{}", &text[..m.start()], replacement, &text[m.end()..])
        }
        None => text.to_owned(),
    }
}

/// `text.replace(pattern, template)` with a string pattern.
fn replace_str(text: &str, pattern: &str, template: &str) -> String {
    match text.find(pattern) {
        Some(at) => format!(
            "{}{}{}",
            &text[..at],
            substitute(pattern, text, at, &[], template),
            &text[at + pattern.len()..]
        ),
        None => text.to_owned(),
    }
}

/// A field that tells `undefined` (absent) from `null` (`Some(None)`).
pub(crate) fn nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// `ImagePatch`. `align` is `None` for undefined and `Some(None)` for null.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePatch {
    #[serde(default, deserialize_with = "jscompat::js_f64_opt")]
    pub width_px: Option<f64>,
    #[serde(default, deserialize_with = "jscompat::js_f64_opt")]
    pub height_px: Option<f64>,
    #[serde(default, deserialize_with = "nullable")]
    pub align: Option<Option<String>>,
    #[serde(default, deserialize_with = "jscompat::js_f64_opt")]
    pub pos_offset_x: Option<f64>,
    #[serde(default, deserialize_with = "jscompat::js_f64_opt")]
    pub pos_offset_y: Option<f64>,
    #[serde(default, deserialize_with = "jscompat::js_f64_opt")]
    pub rot_deg: Option<f64>,
    #[serde(default)]
    pub flip_h: Option<bool>,
    #[serde(default)]
    pub flip_v: Option<bool>,
}

fn xfrm_attr_re(name: &str) -> &'static JsRegex {
    match name {
        "rot" => js_regex!(r#"\s*\brot\s*=\s*(?:"[^"]*"|'[^']*')"#),
        "flipH" => js_regex!(r#"\s*\bflipH\s*=\s*(?:"[^"]*"|'[^']*')"#),
        _ => js_regex!(r#"\s*\bflipV\s*=\s*(?:"[^"]*"|'[^']*')"#),
    }
}

/// `patchImageParagraphXml`
pub fn patch_image_paragraph_xml(xml: &str, patch: &ImagePatch) -> String {
    let mut out = xml.to_owned();
    if patch.rot_deg.is_some() || patch.flip_h.is_some() || patch.flip_v.is_some() {
        out = replace_first_with(
            js_regex!(r"(<pic:spPr[^>]*>[\s\S]*?)<a:xfrm([^>]*)>"),
            &out,
            |m| {
                let prefix = m.get(1).unwrap_or("");
                let mut a = m.get(2).unwrap_or("").to_owned();
                let mut set_attr = |name: &str, value: Option<String>| {
                    a = replace_first(xfrm_attr_re(name), 0, &a, "");
                    if let Some(value) = value {
                        a = format!("{a} {name}=\"{value}\"");
                    }
                };
                if let Some(rot) = patch.rot_deg.filter(|r| r.is_finite()) {
                    let norm = ((math_round(rot) % 360.0) + 360.0) % 360.0;
                    set_attr(
                        "rot",
                        if norm != 0.0 && !norm.is_nan() {
                            Some(num(norm * 60000.0))
                        } else {
                            None
                        },
                    );
                }
                if let Some(flip) = patch.flip_h {
                    set_attr("flipH", flip.then(|| "1".to_owned()));
                }
                if let Some(flip) = patch.flip_v {
                    set_attr("flipV", flip.then(|| "1".to_owned()));
                }
                format!("{prefix}<a:xfrm{a}>")
            },
        );
    }
    let touch_size = num_truthy(patch.width_px) && num_truthy(patch.height_px);
    if touch_size {
        // a size with no ST_PositiveCoordinate text keeps the extents
        let to_emu = |px: f64| {
            px.is_finite()
                .then(|| xml_positive_coordinate(js_max(1.0, px * EMU_PER_PX)))
                .flatten()
        };
        let cx = to_emu(patch.width_px.unwrap_or(f64::NAN));
        let cy = to_emu(patch.height_px.unwrap_or(f64::NAN));
        if let (Some(cx), Some(cy)) = (cx, cy) {
            let resize = |tag: &str| {
                let tag = replace_first(js_regex!(r#"cx="\d+""#), 0, tag, &format!("cx=\"{cx}\""));
                replace_first(js_regex!(r#"cy="\d+""#), 0, &tag, &format!("cy=\"{cy}\""))
            };
            out = replace_first_with(js_regex!(r"<wp:extent[^>]*\/?>"), &out, |m| {
                resize(m.as_str())
            });
            out = replace_first_with(js_regex!(r"<a:ext[^>]*\/>"), &out, |m| resize(m.as_str()));
        }
    }
    {
        let rot_m = js_regex!(r#"<pic:spPr[^>]*>[\s\S]*?<a:xfrm[^>]*?\brot="(-?\d+)""#)
            .exec(&out)
            .map(|m| m.get(1).unwrap_or("").to_owned());
        let ext_m = js_regex!(r#"<wp:extent[^>]*?\bcx="(\d+)"[^>]*?\bcy="(\d+)""#)
            .exec(&out)
            .map(|m| {
                (
                    m.get(1).unwrap_or("").to_owned(),
                    m.get(2).unwrap_or("").to_owned(),
                )
            });
        let touch_rot = patch.rot_deg.is_some();
        if let Some((ext_cx, ext_cy)) = ext_m
            && (touch_rot || (touch_size && rot_m.is_some()))
        {
            let rot = rot_m.as_deref().map_or(0.0, to_number);
            let rad = ((rot / 60000.0) * std::f64::consts::PI) / 180.0;
            let cx = to_number(&ext_cx);
            let cy = to_number(&ext_cy);
            let bw = (cx * rad.cos()).abs() + (cy * rad.sin()).abs();
            let bh = (cx * rad.sin()).abs() + (cy * rad.cos()).abs();
            let dx = num(js_max(0.0, math_round((bw - cx) / 2.0)));
            let dy = num(js_max(0.0, math_round((bh - cy) / 2.0)));
            let ee = format!("<wp:effectExtent l=\"{dx}\" t=\"{dy}\" r=\"{dx}\" b=\"{dy}\"/>");
            let effect = js_regex!(r"<wp:effectExtent\b[^>]*\/>");
            out = if effect.test(&out) {
                replace_first(effect, 0, &out, &ee)
            } else {
                replace_first(
                    js_regex!(r"(<wp:extent\b[^>]*\/?>)"),
                    1,
                    &out,
                    &format!("$1{ee}"),
                )
            };
        }
    }
    if let Some(align) = &patch.align {
        out = replace_first(js_regex!(r#"<w:jc w:val="[^"]*"\/>"#), 0, &out, "");
        out = replace_first(js_regex!(r"<w:pPr\s*\/>"), 0, &out, "<w:pPr></w:pPr>");
        let align = align.as_deref().filter(|a| *a != "left");
        if let Some(align) = align.filter(|a| !a.is_empty()) {
            let jc = format!("<w:jc w:val=\"{align}\"/>");
            let found = js_regex!(r"(<w:pPr[^>]*>)([\s\S]*?)<\/w:pPr>")
                .exec(&out)
                .map(|m| {
                    (
                        m.start(),
                        m.as_str().len(),
                        m.get(1).unwrap_or("").to_owned(),
                        m.get(2).unwrap_or("").to_owned(),
                    )
                });
            if let Some((index, whole_len, open, inner)) = found {
                let patched = match inner.find("<w:rPr>") {
                    None => format!("{inner}{jc}"),
                    Some(at) => format!("{}{}{}", &inner[..at], jc, &inner[at..]),
                };
                out = format!(
                    "{}{}{}</w:pPr>{}",
                    &out[..index],
                    open,
                    patched,
                    &out[index + whole_len..]
                );
            } else {
                out = replace_first(
                    js_regex!(r"(<w:p(?: [^>]*)?>)"),
                    1,
                    &out,
                    &format!("$1<w:pPr>{jc}</w:pPr>"),
                );
            }
        }
    }
    if let Some(x) = patch.pos_offset_x.and_then(xml_position_offset) {
        out = replace_first(
            js_regex!(
                r"(<wp:positionH[^>]*>[\s\S]*?)<wp:posOffset>-?\d+<\/wp:posOffset>([\s\S]*?<\/wp:positionH>)"
            ),
            2,
            &out,
            &format!("$1<wp:posOffset>{x}</wp:posOffset>$2"),
        );
    }
    if let Some(y) = patch.pos_offset_y.and_then(xml_position_offset) {
        out = replace_first(
            js_regex!(
                r"(<wp:positionV[^>]*>[\s\S]*?)<wp:posOffset>-?\d+<\/wp:posOffset>([\s\S]*?<\/wp:positionV>)"
            ),
            2,
            &out,
            &format!("$1<wp:posOffset>{y}</wp:posOffset>$2"),
        );
    }
    out
}

fn wrap_element_re() -> &'static JsRegex {
    js_regex!(
        r"<wp:wrapNone\s*\/>|<wp:wrapSquare[^>]*\/>|<wp:wrapTight[^>]*\/>|<wp:wrapThrough[^>]*\/>|<wp:wrapTopAndBottom\s*\/>|<wp:wrapSquare[\s\S]*?<\/wp:wrapSquare>|<wp:wrapTight[\s\S]*?<\/wp:wrapTight>|<wp:wrapThrough[\s\S]*?<\/wp:wrapThrough>|<wp:wrapTopAndBottom[\s\S]*?<\/wp:wrapTopAndBottom>",
        "g"
    )
}

fn remove_wraps(xml: &str) -> String {
    wrap_element_re().replace_all(xml, |_| String::new())
}

/// `applyImageZOrder`. A rank with no XML text (`xml_number`) leaves the
/// drawing as it was.
pub fn apply_image_z_order(xml: &str, z_order: Option<f64>) -> String {
    let Some(rank) = xml_unsigned_int(251658240.0 + z_order.unwrap_or(0.0)) else {
        return xml.to_owned();
    };
    replace_first(
        js_regex!(r#"(<wp:anchor[^>]*?relativeHeight=")\d+(")"#),
        2,
        xml,
        &format!("$1{rank}$2"),
    )
}

/// `posOffset` of `applyImageWrap`; `relative_to` is `'page' | 'margin'`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PosOffset {
    #[serde(deserialize_with = "jscompat::js_f64")]
    pub x: f64,
    #[serde(deserialize_with = "jscompat::js_f64")]
    pub y: f64,
    #[serde(default)]
    pub relative_to: Option<String>,
}

/// `marginAlign` of `applyImageWrap`.
#[derive(Debug, Clone, Deserialize)]
pub struct MarginAlign {
    pub h: String,
    pub v: String,
}

/// `applyImageWrap`
pub fn apply_image_wrap(
    xml: &str,
    wrap: Option<ImageWrap>,
    pos_offset: Option<&PosOffset>,
    margin_align: Option<&MarginAlign>,
    z_order: Option<f64>,
) -> String {
    let has_anchor = js_regex!(r"<wp:anchor[\s>]").test(xml);
    let existing_wrap = wrap_element_re().exec(xml).map(|m| m.as_str().to_owned());
    // what an anchor held, kept when the new value has no XML text
    let kept_h = js_regex!(r"<wp:positionH[\s\S]*?<\/wp:positionH>")
        .exec(xml)
        .map(|m| m.as_str().to_owned());
    let kept_v = js_regex!(r"<wp:positionV[\s\S]*?<\/wp:positionV>")
        .exec(xml)
        .map(|m| m.as_str().to_owned());
    let kept_rank = js_regex!(r#"<wp:anchor\b[^>]*?\brelativeHeight="(\d+)""#)
        .exec(xml)
        .and_then(|m| m.get(1).map(str::to_owned));
    let mut out = replace_first(js_regex!(r"<wp:simplePos[^>]*\/>"), 0, xml, "");
    out = replace_first(
        js_regex!(r"<wp:positionH[\s\S]*?<\/wp:positionH>"),
        0,
        &out,
        "",
    );
    out = replace_first(
        js_regex!(r"<wp:positionV[\s\S]*?<\/wp:positionV>"),
        0,
        &out,
        "",
    );
    out = remove_wraps(&out);

    let Some(wrap) = wrap else {
        if !has_anchor {
            return xml.to_owned();
        }
        out = replace_first(
            js_regex!(r"<wp:anchor[^>]*>"),
            0,
            &out,
            r#"<wp:inline distT="0" distB="0" distL="0" distR="0">"#,
        );
        return replace_first(js_regex!(r"<\/wp:anchor>"), 0, &out, "</wp:inline>");
    };
    let wrap = wrap.as_str();

    let behind = if wrap == "behind" { "1" } else { "0" };
    let is_side = matches!(
        wrap,
        "square-left"
            | "square-right"
            | "tight-left"
            | "tight-right"
            | "through-left"
            | "through-right"
    );
    let h_align = if wrap.ends_with("-right") {
        "right"
    } else if wrap == "topBottom" {
        "center"
    } else {
        "left"
    };
    let mut position_h = match margin_align {
        Some(align) => format!(
            "<wp:positionH relativeFrom=\"margin\"><wp:align>{}</wp:align></wp:positionH>",
            align.h
        ),
        None => format!(
            "<wp:positionH relativeFrom=\"column\"><wp:align>{h_align}</wp:align></wp:positionH>"
        ),
    };
    let mut position_v = match margin_align {
        Some(align) => format!(
            "<wp:positionV relativeFrom=\"margin\"><wp:align>{}</wp:align></wp:positionV>",
            align.v
        ),
        None => {
            "<wp:positionV relativeFrom=\"paragraph\"><wp:posOffset>0</wp:posOffset></wp:positionV>"
                .to_owned()
        }
    };
    if let Some(pos) = pos_offset {
        position_h = match xml_position_offset(pos.x) {
            None => kept_h.unwrap_or(position_h),
            Some(x) => format!(
                "<wp:positionH relativeFrom=\"{}\"><wp:posOffset>{x}</wp:posOffset></wp:positionH>",
                pos.relative_to.as_deref().unwrap_or("column")
            ),
        };
        position_v = match xml_position_offset(pos.y) {
            None => kept_v.unwrap_or(position_v),
            Some(y) => format!(
                "<wp:positionV relativeFrom=\"{}\"><wp:posOffset>{y}</wp:posOffset></wp:positionV>",
                pos.relative_to.as_deref().unwrap_or("paragraph")
            ),
        };
    }
    let position = format!("<wp:simplePos x=\"0\" y=\"0\"/>{position_h}{position_v}");
    let keep_kind = if wrap.starts_with("tight-") {
        Some("wp:wrapTight")
    } else if wrap.starts_with("through-") {
        Some("wp:wrapThrough")
    } else {
        None
    };
    let reused = keep_kind.and_then(|kind| {
        existing_wrap
            .as_deref()
            .filter(|existing| existing.starts_with(&format!("<{kind}")))
    });
    let wrap_element = match reused {
        Some(existing) => existing,
        None if is_side => r#"<wp:wrapSquare wrapText="bothSides"/>"#,
        None if wrap == "topBottom" => "<wp:wrapTopAndBottom/>",
        None => "<wp:wrapNone/>",
    };
    let rank = xml_unsigned_int(251658240.0 + z_order.unwrap_or(0.0))
        .or(kept_rank)
        .unwrap_or_else(|| "251658240".to_owned());
    let anchor_open = format!(
        "<wp:anchor distT=\"0\" distB=\"0\" distL=\"114300\" distR=\"114300\" simplePos=\"0\" relativeHeight=\"{rank}\" behindDoc=\"{behind}\" locked=\"0\" layoutInCell=\"1\" allowOverlap=\"1\">",
    );
    if has_anchor {
        out = replace_first(js_regex!(r"<wp:anchor[^>]*>"), 0, &out, &anchor_open);
    } else {
        out = replace_first(js_regex!(r"<wp:inline[^>]*>"), 0, &out, &anchor_open);
        out = replace_first(js_regex!(r"<\/wp:inline>"), 0, &out, "</wp:anchor>");
    }
    out = replace_first(
        js_regex!(r"(<wp:anchor[^>]*>)"),
        1,
        &out,
        &format!("$1{position}"),
    );
    insert_wrap_element(&out, wrap_element)
}

/// The wrap element between extent/effectExtent and docPr, else before a:graphic.
fn insert_wrap_element(out: &str, wrap_element: &str) -> String {
    if js_regex!(r"<wp:docPr").test(out) {
        return replace_first(
            js_regex!(r"<wp:docPr"),
            0,
            out,
            &format!("{wrap_element}<wp:docPr"),
        );
    }
    replace_first_with(js_regex!(r"<a:graphic[\s>]"), out, |m| {
        format!("{wrap_element}{}", m.as_str())
    })
}

fn box_drawing_segments(paragraph_xml: &str) -> Vec<(usize, usize)> {
    xml_segments(paragraph_xml, "w:drawing", 0, paragraph_xml.len())
        .into_iter()
        .map(|seg| (seg.start, seg.end))
        .filter(|&(start, end)| is_box_drawing(&paragraph_xml[start..end]))
        .collect()
}

/// `ShapeDrawingLocation`. `box_index` is a number: only an array index finds a drawing.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeDrawingLocation {
    #[serde(default)]
    pub shape_id: Option<String>,
    #[serde(deserialize_with = "jscompat::js_f64")]
    pub box_index: f64,
}

fn shape_drawing_segment(
    paragraph_xml: &str,
    location: &ShapeDrawingLocation,
) -> Option<(usize, usize)> {
    if let Some(shape_id) = location.shape_id.as_deref().filter(|id| !id.is_empty()) {
        return xml_segments(paragraph_xml, "w:drawing", 0, paragraph_xml.len())
            .into_iter()
            .map(|seg| (seg.start, seg.end))
            .find(|&(start, end)| {
                js_regex!(r#"<(?:wps|pic):cNvPr\b[^>]*\bid="([^"]+)""#)
                    .exec(&paragraph_xml[start..end])
                    .and_then(|m| m.get(1))
                    == Some(shape_id)
            });
    }
    let index = location.box_index;
    let segments = box_drawing_segments(paragraph_xml);
    if index >= 0.0 && index.fract() == 0.0 && index < segments.len() as f64 {
        Some(segments[index as usize])
    } else {
        None
    }
}

fn set_anchor_rank(drawing_xml: &str, z_order: f64) -> String {
    let Some(rank) = xml_unsigned_int(251658240.0 + z_order) else {
        return drawing_xml.to_owned();
    };
    replace_first_with(js_regex!(r"<wp:anchor[^>]*>"), drawing_xml, |m| {
        replace_first(
            js_regex!(r#"relativeHeight="\d+""#),
            0,
            m.as_str(),
            &format!("relativeHeight=\"{rank}\""),
        )
    })
}

/// `applyShapeZOrderAt`
pub fn apply_shape_z_order_at(
    paragraph_xml: &str,
    location: &ShapeDrawingLocation,
    z_order: f64,
) -> String {
    let Some((start, end)) = shape_drawing_segment(paragraph_xml, location) else {
        return paragraph_xml.to_owned();
    };
    let next = set_anchor_rank(&paragraph_xml[start..end], z_order);
    format!(
        "{}{}{}",
        &paragraph_xml[..start],
        next,
        &paragraph_xml[end..]
    )
}

/// `applyShapeWrapAt`
pub fn apply_shape_wrap_at(
    paragraph_xml: &str,
    location: &ShapeDrawingLocation,
    wrap: Option<ImageWrap>,
    z_order: Option<f64>,
) -> String {
    let Some((start, end)) = shape_drawing_segment(paragraph_xml, location) else {
        return paragraph_xml.to_owned();
    };
    let drawing = &paragraph_xml[start..end];
    let has_anchor = js_regex!(r"<wp:anchor[\s>]").test(drawing);
    let next = match wrap {
        None => {
            if !has_anchor {
                return paragraph_xml.to_owned();
            }
            let next = replace_first(js_regex!(r"<wp:simplePos[^>]*\/>"), 0, drawing, "");
            let next = replace_first(
                js_regex!(r"<wp:positionH[\s\S]*?<\/wp:positionH>"),
                0,
                &next,
                "",
            );
            let next = replace_first(
                js_regex!(r"<wp:positionV[\s\S]*?<\/wp:positionV>"),
                0,
                &next,
                "",
            );
            let next = remove_wraps(&next);
            let next = replace_first(
                js_regex!(r"<wp:anchor[^>]*>"),
                0,
                &next,
                r#"<wp:inline distT="0" distB="0" distL="0" distR="0">"#,
            );
            replace_first(js_regex!(r"<\/wp:anchor>"), 0, &next, "</wp:inline>")
        }
        Some(wrap) if !has_anchor => apply_image_wrap(drawing, Some(wrap), None, None, z_order),
        Some(wrap) => swap_anchor_wrap(drawing, wrap, z_order),
    };
    format!(
        "{}{}{}",
        &paragraph_xml[..start],
        next,
        &paragraph_xml[end..]
    )
}

/// `swapAnchorWrap`
pub fn swap_anchor_wrap(drawing_xml: &str, wrap: ImageWrap, z_order: Option<f64>) -> String {
    let wrap = wrap.as_str();
    let behind = if wrap == "behind" { "1" } else { "0" };
    let wrap_element = if wrap == "front" || wrap == "behind" {
        "<wp:wrapNone/>"
    } else if wrap == "topBottom" {
        "<wp:wrapTopAndBottom/>"
    } else {
        r#"<wp:wrapSquare wrapText="bothSides"/>"#
    };
    let next = remove_wraps(drawing_xml);
    let mut next = replace_first_with(js_regex!(r"<wp:anchor[^>]*>"), &next, |m| {
        let tag = m.as_str();
        if tag.contains("behindDoc=") {
            replace_first(
                js_regex!(r#"behindDoc="[^"]*""#),
                0,
                tag,
                &format!("behindDoc=\"{behind}\""),
            )
        } else {
            replace_first(
                js_regex!(r"<wp:anchor"),
                0,
                tag,
                &format!("<wp:anchor behindDoc=\"{behind}\""),
            )
        }
    });
    if let Some(z_order) = z_order {
        next = set_anchor_rank(&next, z_order);
    }
    insert_wrap_element(&next, wrap_element)
}

/// The shape's own a:ext in its wps:spPr; `None` keeps that dimension (the
/// TypeScript's `size.cx ?? cx of the tag`). The sizes are the digits
/// `box_length` gives.
fn set_shape_ext(drawing_xml: &str, cx: Option<&str>, cy: Option<&str>) -> String {
    let Some(sp_pr) =
        js_regex!(r"<wps:spPr(?:\s[^>]*)?>[\s\S]*?<\/wps:spPr>|<wps:spPr(?:\s[^>]*)?\/>")
            .exec(drawing_xml)
    else {
        return drawing_xml.to_owned();
    };
    let sp = sp_pr.as_str();
    let Some(tag) = js_regex!(r"<a:ext\b[^>]*?(?:\/>|><\/a:ext>)").exec(sp) else {
        return drawing_xml.to_owned();
    };
    let dimension = |given: Option<&str>, digits: &JsRegex| {
        given.map(str::to_owned).or_else(|| {
            digits
                .exec(tag.as_str())
                .and_then(|m| m.get(1))
                .map(str::to_owned)
        })
    };
    let (Some(cx), Some(cy)) = (
        dimension(cx, js_regex!(r#"\bcx="(\d+)""#)),
        dimension(cy, js_regex!(r#"\bcy="(\d+)""#)),
    ) else {
        return drawing_xml.to_owned();
    };
    format!(
        "{}{}<a:ext cx=\"{cx}\" cy=\"{cy}\"/>{}{}",
        &drawing_xml[..sp_pr.start()],
        &sp[..tag.start()],
        &sp[tag.end()..],
        &drawing_xml[sp_pr.end()..]
    )
}

fn set_extent_cx(xml: &str, cx: &str) -> String {
    replace_first(
        js_regex!(r#"(<wp:extent\b[^>]*\bcx=")\d+(")"#),
        2,
        xml,
        &format!("$1{cx}$2"),
    )
}

fn set_extent_cy(xml: &str, cy: &str) -> String {
    replace_first(
        js_regex!(r#"(<wp:extent\b[^>]*\bcy=")\d+(")"#),
        2,
        xml,
        &format!("$1{cy}$2"),
    )
}

/// `setVmlStyleLength`: one length of a VML twin's style from CSS px, in the
/// unit the style already uses (two decimals). A length with no plain decimal
/// text keeps the old one.
fn set_vml_style_length(xml: &str, re: &JsRegex, px: f64) -> String {
    replace_first_with(re, xml, |m| {
        let prefix = m.get(1).unwrap_or("");
        let unit = m.get(2).unwrap_or("");
        let value = xml_decimal(if unit == "pt" {
            math_round(px * 75.0) / 100.0
        } else {
            math_round(px * 100.0) / 100.0
        });
        match value {
            Some(value) => format!("{prefix}{value}{unit}"),
            None => m.as_str().to_owned(),
        }
    })
}

/// `boxLength`: one box length as both twins write it, DrawingML's EMU (at
/// least 1) and the px the VML style takes from the same clamp, or `None` when
/// the EMU has no plain-digit text.
fn box_length(px: f64) -> Option<(String, f64)> {
    let emu = xml_positive_coordinate(js_max(1.0, px * EMU_PER_PX))?;
    Some((emu, js_max(1.0 / EMU_PER_PX, px)))
}

fn fallback_height_re() -> &'static JsRegex {
    js_regex!(r#"(style="[^"]*\bheight:)\s*[\d.]+(pt|px)"#)
}

fn fallback_width_re() -> &'static JsRegex {
    js_regex!(r#"(style="[^"]*\bwidth:)\s*[\d.]+(pt|px)"#)
}

fn fallback_re() -> &'static JsRegex {
    js_regex!(r"<mc:Fallback>[\s\S]*?<\/mc:Fallback>", "g")
}

/// `patchTextboxHeights`; `None` is null or undefined.
pub fn patch_textbox_heights(paragraph_xml: &str, heights_px: &[Option<f64>]) -> String {
    if heights_px.iter().all(Option::is_none) {
        return paragraph_xml.to_owned();
    }
    let drawings = xml_segments(paragraph_xml, "w:drawing", 0, paragraph_xml.len());
    let mut out = String::new();
    let mut cursor = 0;
    let mut box_index = 0usize;
    let mut seen = false;
    for drawing in drawings {
        let drawing_xml = &paragraph_xml[drawing.start..drawing.end];
        if !drawing_xml.contains("<w:txbxContent") || para_plain_text(drawing_xml).is_empty() {
            continue;
        }
        if seen {
            box_index += 1;
        }
        seen = true;
        let height_px = heights_px.get(box_index).copied().flatten();
        if !num_truthy(height_px) {
            continue;
        }
        let Some((cy, _)) = box_length(height_px.unwrap_or(f64::NAN)) else {
            continue;
        };
        let resized = set_shape_ext(&set_extent_cy(drawing_xml, &cy), None, Some(&cy));
        out.push_str(&paragraph_xml[cursor..drawing.start]);
        out.push_str(&resized);
        cursor = drawing.end;
    }
    out.push_str(&paragraph_xml[cursor..]);

    let mut fallback_index = 0usize;
    let mut fallback_seen = false;
    fallback_re().replace_all(&out, |m| {
        let fallback = m.as_str();
        if !fallback.contains("<w:txbxContent") || para_plain_text(fallback).is_empty() {
            return fallback.to_owned();
        }
        if fallback_seen {
            fallback_index += 1;
        }
        fallback_seen = true;
        let height_px = heights_px.get(fallback_index).copied().flatten();
        let height = if num_truthy(height_px) {
            box_length(height_px.unwrap_or(f64::NAN))
        } else {
            None
        };
        match height {
            Some((_, px)) => set_vml_style_length(fallback, fallback_height_re(), px),
            None => fallback.to_owned(),
        }
    })
}

fn is_box_drawing(drawing_xml: &str) -> bool {
    if drawing_xml.contains("<w:txbxContent") && !para_plain_text(drawing_xml).is_empty() {
        return true;
    }
    js_regex!(r#"<a:prstGeom[^>]*prst="(?:line|straightConnector1|bentConnector[234]|curvedConnector[234])""#)
        .test(drawing_xml)
        && drawing_xml.contains("<wp:wrapSquare")
}

/// `TextboxSizePatch`; `None` is null or undefined.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextboxSizePatch {
    #[serde(default, deserialize_with = "jscompat::js_f64_opt")]
    pub w_px: Option<f64>,
    #[serde(default, deserialize_with = "jscompat::js_f64_opt")]
    pub h_px: Option<f64>,
}

/// `patchTextboxSizes`; an entry `None` is null or undefined.
pub fn patch_textbox_sizes(paragraph_xml: &str, sizes: &[Option<TextboxSizePatch>]) -> String {
    let empty = |size: &Option<TextboxSizePatch>| {
        size.as_ref()
            .is_none_or(|size| size.w_px.is_none() && size.h_px.is_none())
    };
    if sizes.iter().all(empty) {
        return paragraph_xml.to_owned();
    }
    let drawings = xml_segments(paragraph_xml, "w:drawing", 0, paragraph_xml.len());
    let mut out = String::new();
    let mut cursor = 0;
    let mut box_index = 0usize;
    let mut seen = false;
    for drawing in drawings {
        let drawing_xml = &paragraph_xml[drawing.start..drawing.end];
        if !is_box_drawing(drawing_xml) {
            continue;
        }
        if seen {
            box_index += 1;
        }
        seen = true;
        let Some(size) = sizes.get(box_index).and_then(Option::as_ref) else {
            continue;
        };
        if size.w_px.is_none() && size.h_px.is_none() {
            continue;
        }
        let mut resized = drawing_xml.to_owned();
        if let Some((cx, _)) = size.w_px.and_then(box_length) {
            resized = set_shape_ext(&set_extent_cx(&resized, &cx), Some(&cx), None);
        }
        if let Some((cy, _)) = size.h_px.and_then(box_length) {
            resized = set_shape_ext(&set_extent_cy(&resized, &cy), None, Some(&cy));
            // a fixed height only sticks if Word stops auto-fitting the shape
            resized = replace_first(
                js_regex!(r"<a:spAutoFit\s*\/>|<a:spAutoFit\s*>\s*<\/a:spAutoFit>"),
                0,
                &resized,
                "<a:noAutofit/>",
            );
        }
        out.push_str(&paragraph_xml[cursor..drawing.start]);
        out.push_str(&resized);
        cursor = drawing.end;
    }
    out.push_str(&paragraph_xml[cursor..]);

    let mut fallback_index = 0usize;
    let mut fallback_seen = false;
    fallback_re().replace_all(&out, |m| {
        let fallback = m.as_str();
        if !is_box_drawing(fallback) && !fallback.contains("<w:txbxContent") {
            return fallback.to_owned();
        }
        if fallback.contains("<w:txbxContent") && para_plain_text(fallback).is_empty() {
            return fallback.to_owned();
        }
        if fallback_seen {
            fallback_index += 1;
        }
        fallback_seen = true;
        let Some(size) = sizes.get(fallback_index).and_then(Option::as_ref) else {
            return fallback.to_owned();
        };
        let mut next = fallback.to_owned();
        if let Some((_, px)) = size.h_px.and_then(box_length) {
            next = set_vml_style_length(&next, fallback_height_re(), px);
        }
        if let Some((_, px)) = size.w_px.and_then(box_length) {
            next = set_vml_style_length(&next, fallback_width_re(), px);
        }
        next
    })
}

/// `ShapeStylePatch`: `None` is undefined (keep), `Some(None)` is null.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeStylePatch {
    #[serde(default, deserialize_with = "nullable")]
    pub fill_hex: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub border_hex: Option<Option<String>>,
    #[serde(default, deserialize_with = "jscompat::js_f64_nullable")]
    pub rot_deg: Option<Option<f64>>,
    #[serde(default, deserialize_with = "jscompat::js_f64_nullable")]
    pub border_width_px: Option<Option<f64>>,
}

impl ShapeStylePatch {
    fn keeps_all(&self) -> bool {
        self.fill_hex.is_none()
            && self.border_hex.is_none()
            && self.rot_deg.is_none()
            && self.border_width_px.is_none()
    }
}

fn patch_shape_rotation(sp_pr: &str, rot_deg: Option<f64>) -> String {
    let norm = rot_deg.map_or(0.0, |rot| ((rot % 360.0) + 360.0) % 360.0);
    // 360deg wraps to 0: never write a full turn
    let Some(emu) = xml_int(math_round(norm * 60000.0) % 21600000.0) else {
        return sp_pr.to_owned();
    };
    let Some(xfrm) = js_regex!(r"<a:xfrm\b[^>]*>").exec(sp_pr) else {
        if emu == "0" {
            return sp_pr.to_owned();
        }
        return replace_first(
            js_regex!(r"^(<wps:spPr\b[^>]*>)"),
            1,
            sp_pr,
            &format!("$1<a:xfrm rot=\"{emu}\"/>"),
        );
    };
    let xfrm = xfrm.as_str();
    let tag = if emu == "0" {
        replace_first(js_regex!(r#"\s+rot="[^"]*""#), 0, xfrm, "")
    } else if js_regex!(r#"\brot=""#).test(xfrm) {
        replace_first(
            js_regex!(r#"\brot="[^"]*""#),
            0,
            xfrm,
            &format!("rot=\"{emu}\""),
        )
    } else {
        replace_first(
            js_regex!(r"^<a:xfrm\b"),
            0,
            xfrm,
            &format!("<a:xfrm rot=\"{emu}\""),
        )
    };
    replace_str(sp_pr, xfrm, &tag)
}

fn patch_shape_line_width(sp_pr: &str, border_width_px: Option<f64>) -> String {
    let emu = match border_width_px {
        None => None,
        Some(px) => match xml_int(js_max(1.0, px * EMU_PER_PX)) {
            Some(emu) => Some(emu),
            None => return sp_pr.to_owned(),
        },
    };
    let Some(ln) = js_regex!(r"<a:ln\b[^>]*>").exec(sp_pr) else {
        return match emu {
            None => sp_pr.to_owned(),
            Some(emu) => replace_str(
                sp_pr,
                "</wps:spPr>",
                &format!("<a:ln w=\"{emu}\"/></wps:spPr>"),
            ),
        };
    };
    let ln = ln.as_str();
    let tag = match emu {
        None => replace_first(js_regex!(r#"\s+w="[^"]*""#), 0, ln, ""),
        Some(emu) if js_regex!(r#"\bw=""#).test(ln) => {
            replace_first(js_regex!(r#"\bw="[^"]*""#), 0, ln, &format!("w=\"{emu}\""))
        }
        Some(emu) => replace_first(js_regex!(r"^<a:ln\b"), 0, ln, &format!("<a:ln w=\"{emu}\"")),
    };
    replace_str(sp_pr, ln, &tag)
}

fn replace_fill_slot(xml: &str, hex: Option<&str>) -> String {
    let markup = match hex.filter(|hex| !hex.is_empty()) {
        Some(hex) => format!("<a:solidFill><a:srgbClr val=\"{hex}\"/></a:solidFill>"),
        None => "<a:noFill/>".to_owned(),
    };
    let solid = js_regex!(r"<a:solidFill>[\s\S]*?<\/a:solidFill>");
    if solid.test(xml) {
        return replace_first(solid, 0, xml, &markup);
    }
    if xml.contains("<a:noFill/>") {
        return replace_str(xml, "<a:noFill/>", &markup);
    }
    xml.to_owned()
}

/// `patchShapeStyles`; an entry `None` is null or undefined.
pub fn patch_shape_styles(paragraph_xml: &str, styles: &[Option<ShapeStylePatch>]) -> String {
    if styles
        .iter()
        .all(|s| s.as_ref().is_none_or(ShapeStylePatch::keeps_all))
    {
        return paragraph_xml.to_owned();
    }
    let drawings = xml_segments(paragraph_xml, "w:drawing", 0, paragraph_xml.len());
    let mut out = String::new();
    let mut cursor = 0;
    let mut box_index = 0usize;
    let mut seen = false;
    for drawing in drawings {
        let mut drawing_xml = paragraph_xml[drawing.start..drawing.end].to_owned();
        if !is_box_drawing(&drawing_xml) {
            continue;
        }
        if seen {
            box_index += 1;
        }
        seen = true;
        let Some(style) = styles
            .get(box_index)
            .and_then(Option::as_ref)
            .filter(|s| !s.keeps_all())
        else {
            continue;
        };
        let sp_pr_match = js_regex!(r"<wps:spPr>[\s\S]*?<\/wps:spPr>")
            .exec(&drawing_xml)
            .map(|m| m.as_str().to_owned());
        if let Some(sp_pr_match) = sp_pr_match {
            let mut sp_pr = sp_pr_match.clone();
            let ln_start = js_regex!(r"<a:ln[\s>]").exec(&sp_pr).map(|m| m.start());
            if let Some(fill_hex) = &style.fill_hex {
                let (head, tail) = match ln_start {
                    None => (sp_pr.as_str(), ""),
                    Some(at) => (&sp_pr[..at], &sp_pr[at..]),
                };
                sp_pr = format!("{}{}", replace_fill_slot(head, fill_hex.as_deref()), tail);
            }
            if let Some(border_hex) = &style.border_hex {
                let ln_match = js_regex!(r"<a:ln[\s>][\s\S]*?<\/a:ln>")
                    .exec(&sp_pr)
                    .map(|m| m.as_str().to_owned());
                if let Some(ln_match) = ln_match {
                    sp_pr = replace_str(
                        &sp_pr,
                        &ln_match,
                        &replace_fill_slot(&ln_match, border_hex.as_deref()),
                    );
                } else if let Some(hex) = border_hex.as_deref().filter(|hex| !hex.is_empty()) {
                    sp_pr = replace_str(
                        &sp_pr,
                        "</wps:spPr>",
                        &format!(
                            "<a:ln><a:solidFill><a:srgbClr val=\"{hex}\"/></a:solidFill></a:ln></wps:spPr>"
                        ),
                    );
                }
            }
            if let Some(rot_deg) = style.rot_deg {
                sp_pr = patch_shape_rotation(&sp_pr, rot_deg);
            }
            if let Some(width) = style.border_width_px {
                sp_pr = patch_shape_line_width(&sp_pr, width);
            }
            drawing_xml = replace_str(&drawing_xml, &sp_pr_match, &sp_pr);
        }
        out.push_str(&paragraph_xml[cursor..drawing.start]);
        out.push_str(&drawing_xml);
        cursor = drawing.end;
    }
    out.push_str(&paragraph_xml[cursor..]);
    out
}

/// `patchDrawingExtent`
pub fn patch_drawing_extent(paragraph_xml: &str, w_px: f64, h_px: f64) -> String {
    let cx = xml_positive_coordinate(js_max(1.0, w_px * EMU_PER_PX));
    let cy = xml_positive_coordinate(js_max(1.0, h_px * EMU_PER_PX));
    let mut out = paragraph_xml.to_owned();
    let mut set = |re: &JsRegex, digits: &Option<String>| {
        if let Some(digits) = digits {
            out = replace_first(re, 2, &out, &format!("$1{digits}$2"));
        }
    };
    set(js_regex!(r#"(<wp:extent\b[^>]*\bcx=")\d+(")"#), &cx);
    set(js_regex!(r#"(<wp:extent\b[^>]*\bcy=")\d+(")"#), &cy);
    set(js_regex!(r#"(<a:ext\b[^>]*\bcx=")\d+(")"#), &cx);
    set(js_regex!(r#"(<a:ext\b[^>]*\bcy=")\d+(")"#), &cy);
    out
}

/// `resizeInlinePictureXml`
pub fn resize_inline_picture_xml(xml: &str, width_px: f64, height_px: f64) -> String {
    if !js_regex!(r"<wp:inline[\s>]").test(xml) {
        return xml.to_owned();
    }
    resize_drawing_extents(xml, width_px, height_px)
}

/// `resizeAnchoredPictureXml`
pub fn resize_anchored_picture_xml(xml: &str, width_px: f64, height_px: f64) -> String {
    if !js_regex!(r"<wp:anchor[\s>]").test(xml) || js_regex!(r"<wpg:").test(xml) {
        return xml.to_owned();
    }
    if js_regex!(r"<pic:pic[\s>]", "g").find_iter(xml).count() != 1 {
        return xml.to_owned();
    }
    resize_drawing_extents(xml, width_px, height_px)
}

fn resize_drawing_extents(xml: &str, width_px: f64, height_px: f64) -> String {
    // `!(w > 0) || !(h > 0)`: a NaN is not above zero either
    if width_px.is_nan() || width_px <= 0.0 || height_px.is_nan() || height_px <= 0.0 {
        return xml.to_owned();
    }
    let cx = xml_positive_coordinate(js_max(1.0, width_px * EMU_PER_PX));
    let cy = xml_positive_coordinate(js_max(1.0, height_px * EMU_PER_PX));
    let Some(extent) = js_regex!(r#"<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)""#).exec(xml)
    else {
        return xml.to_owned();
    };
    let same_px =
        |emu: &str, px: f64| math_round((to_number(emu) / EMU_PER_PX) * 100.0) / 100.0 == px;
    if same_px(extent.get(1).unwrap_or(""), width_px)
        && same_px(extent.get(2).unwrap_or(""), height_px)
    {
        return xml.to_owned();
    }
    // a size with no XML text keeps the attribute's value, the other is written
    let ext = |tag: &str| {
        let tag = match &cx {
            Some(cx) => replace_first(js_regex!(r#"\bcx="\d+""#), 0, tag, &format!("cx=\"{cx}\"")),
            None => tag.to_owned(),
        };
        match &cy {
            Some(cy) => replace_first(js_regex!(r#"\bcy="\d+""#), 0, &tag, &format!("cy=\"{cy}\"")),
            None => tag,
        }
    };
    let mut out = replace_first_with(js_regex!(r"<wp:extent\b[^>]*>"), xml, |m| ext(m.as_str()));
    let pic = js_regex!(r"<pic:spPr[\s>][\s\S]*?<\/pic:spPr>")
        .exec(&out)
        .map(|m| m.as_str().to_owned());
    if let Some(pic) = pic {
        let resized = replace_first_with(js_regex!(r"<a:ext\b[^>]*>"), &pic, |m| ext(m.as_str()));
        out = replace_str(&out, &pic, &resized);
    }
    out
}
