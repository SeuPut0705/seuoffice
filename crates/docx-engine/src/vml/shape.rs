//! The VML shape readers of packages/docx-engine/src/parse-vml.ts: the WordArt
//! and picture markers, the v:group scale and coordinates, the straight-edge
//! path converter, the v:shapetype table and the textless shape as an SVG data
//! URL. `vmlWordArtBox` returns the document model and is not here.

use std::f64::consts::PI;
use std::fmt::Write;
use std::sync::LazyLock;

use jscompat::{
    JsMap, JsMatch, JsNum, JsObject, JsRegex, Radix, js_regex, math_round, number_to_string,
    parse_float, parse_int, to_number, trim, truthy,
};
use ooxml_xml::XNode;
use serde::{Deserialize, Serialize};

use super::{
    Dim, math_max, math_min, vml_color_hex, vml_fraction, vml_length_px, vml_style_dim_px,
};

/// The source of `VML_WORDART_RE`.
pub const VML_WORDART_SOURCE: &str = r#"<v:textpath[^>]*\bstring=""#;

/// `VML_WORDART_RE`: a shape carrying its text in a v:textpath string attribute.
pub static VML_WORDART_RE: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(VML_WORDART_SOURCE, "").expect("a pattern literal that compiles")
});

/// The source of `VML_PICT_RID_RE`.
pub const VML_PICT_RID_SOURCE: &str = r#"<v:imagedata[^>]*\br:id=""#;

/// `VML_PICT_RID_RE`: a v:imagedata that actually references a picture. WPS
/// writes a bare `<v:imagedata o:title=""/>` on ordinary textbox/geometry
/// shapes; only an r:id makes the pict a picture.
pub static VML_PICT_RID_RE: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(VML_PICT_RID_SOURCE, "").expect("a pattern literal that compiles")
});

/// `VmlGroupScale`: px per group-coordinate unit for children of a v:group
/// (drawing canvas).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct VmlGroupScale {
    pub sx: JsNum,
    pub sy: JsNum,
}

/// `VmlOrigin`: a group-child origin, px from the host paragraph.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct VmlOrigin {
    pub x: f64,
    pub y: f64,
}

/// The `key` of `vmlCoordPx`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Coord {
    Left,
    Top,
}

/// `x` where it is truthy: not absent, 0 or NaN.
fn truthy_num(x: Option<f64>) -> Option<f64> {
    x.filter(|x| *x != 0.0 && !x.is_nan())
}

/// `x > 0`, which NaN fails.
fn positive(x: f64) -> bool {
    x > 0.0
}

/// `vmlGroupScale(group, parentScale)`
pub fn vml_group_scale(
    group: &XNode,
    parent_scale: Option<VmlGroupScale>,
) -> Option<VmlGroupScale> {
    let style = group.attr("style").unwrap_or("");
    // a nested group sizes in its parent's unitless coordinates
    let w_px = vml_shape_dim_px(style, Dim::Width, parent_scale);
    let h_px = vml_shape_dim_px(style, Dim::Height, parent_scale);
    let cs = js_regex!(r"^\s*(-?\d+)[,\s]+(-?\d+)").exec(group.attr("coordsize").unwrap_or(""));
    let cw = cs.as_ref().map_or(f64::NAN, |cs| {
        parse_int(cs.get(1).unwrap_or(""), Radix::Ten)
    });
    let ch = cs.as_ref().map_or(f64::NAN, |cs| {
        parse_int(cs.get(2).unwrap_or(""), Radix::Ten)
    });
    let w_px = truthy_num(w_px)?;
    let h_px = truthy_num(h_px)?;
    if !positive(cw) || !positive(ch) {
        return None;
    }
    Some(VmlGroupScale {
        sx: JsNum(w_px / cw),
        sy: JsNum(h_px / ch),
    })
}

/// `vmlCoordPx(style, key, scale, origin)`: style left/top of a group child as
/// px from the paragraph (group origin + scaled coordinate).
pub fn vml_coord_px(style: &str, key: Coord, scale: VmlGroupScale, origin: VmlOrigin) -> f64 {
    let found = match key {
        Coord::Left => js_regex!(r"(?:^|;)\s*left:(-?[\d.]+)(pt|px|in|mm|cm)?(?=;|$)"),
        Coord::Top => js_regex!(r"(?:^|;)\s*top:(-?[\d.]+)(pt|px|in|mm|cm)?(?=;|$)"),
    }
    .exec(style);
    let base = match key {
        Coord::Left => origin.x,
        Coord::Top => origin.y,
    };
    let Some(found) = found else {
        return base;
    };
    let v = parse_float(found.get(1).unwrap_or(""));
    if !v.is_finite() {
        return base;
    }
    if let Some(unit) = truthy(found.get(2)) {
        let px = match unit {
            "px" => v,
            "in" => v * 96.0,
            "mm" => (v / 25.4) * 96.0,
            "cm" => (v / 2.54) * 96.0,
            _ => (v * 96.0) / 72.0,
        };
        return base + px;
    }
    base + v * match key {
        Coord::Left => scale.sx.0,
        Coord::Top => scale.sy.0,
    }
}

/// `readPairs` of `vmlPathToNormD` over the text from the cursor: the length
/// it reads and the numbers, `None` where it gives null.
fn read_pairs(rest: &str) -> Option<(usize, Vec<f64>)> {
    // an omitted coordinate between separators means 0 ("m,l,21600...")
    let found = js_regex!(r"^[-\d.,\s]+").exec(rest)?;
    let nums: Vec<f64> = js_regex!(r"[,\s]")
        .split(trim(found.as_str()))
        .into_iter()
        .map(|tok| {
            if tok.is_empty() {
                0.0
            } else {
                parse_float(tok)
            }
        })
        .collect();
    if nums.iter().any(|v| !v.is_finite()) {
        return None;
    }
    (!nums.is_empty() && nums.len().is_multiple_of(2)).then_some((found.as_str().len(), nums))
}

/// `vmlPathToNormD(path, cw, ch)`: VML path attribute as a normalized (0..1)
/// SVG path. Straight-edge subset only (m/l absolute, t/r relative, x close,
/// e end); curve or arc commands bail.
pub fn vml_path_to_norm_d(path: &str, cw: f64, ch: f64) -> Option<String> {
    if !positive(cw) || !positive(ch) {
        return None;
    }
    let norm = |v: f64, c: f64| math_round((v / c) * 10000.0) / 10000.0;
    let mut parts = String::new();
    let mut count = 0usize;
    let mut push = |part: &str| {
        if count > 0 {
            parts.push(' ');
        }
        parts.push_str(part);
        count += 1;
    };
    // a byte offset; it only ever moves over whole characters
    let mut i = 0usize;
    let mut cx = 0.0;
    let mut cy = 0.0;
    while let Some(rest) = path.get(i..).filter(|rest| !rest.is_empty()) {
        let Some(c) = rest.chars().next() else {
            break;
        };
        if c == ' ' || c == ',' {
            i += 1;
            continue;
        }
        // nf/ns are fill/stroke hints, not geometry: before the 'e' check, or
        // an 'nf' would read as fatal
        if rest.starts_with("nf") || rest.starts_with("ns") {
            i += 2;
            continue;
        }
        if c == 'e' {
            i += 1;
            continue;
        }
        if c == 'x' {
            push("Z");
            i += 1;
            continue;
        }
        if matches!(c, 'm' | 'l' | 't' | 'r') {
            i += 1;
            let (read, nums) = read_pairs(path.get(i..).unwrap_or(""))?;
            i += read;
            let rel = c == 't' || c == 'r';
            let mv = c == 'm' || c == 't';
            for (k, &[x, y]) in nums.as_chunks::<2>().0.iter().enumerate() {
                cx = if rel { cx + x } else { x };
                cy = if rel { cy + y } else { y };
                let command = if k == 0 && mv { "M" } else { "L" };
                push(&format!(
                    "{command} {} {}",
                    number_to_string(norm(cx, cw)),
                    number_to_string(norm(cy, ch))
                ));
            }
            continue;
        }
        return None;
    }
    (count > 1).then_some(parts)
}

/// `vmlShapeDimPx(style, key, scale)`: shape dimension as px, explicit units
/// directly, unitless via the group scale.
pub fn vml_shape_dim_px(style: &str, key: Dim, scale: Option<VmlGroupScale>) -> Option<f64> {
    let found = match key {
        Dim::Width => js_regex!(r"(?:^|;)\s*width:([0-9.]+)(pt|px|in|mm|cm)?"),
        Dim::Height => js_regex!(r"(?:^|;)\s*height:([0-9.]+)(pt|px|in|mm|cm)?"),
    }
    .exec(style)?;
    let scale = match scale {
        Some(scale) if truthy(found.get(2)).is_none() => scale,
        _ => return vml_style_dim_px(style, key),
    };
    let v = parse_float(found.get(1).unwrap_or(""));
    if !v.is_finite() || v <= 0.0 {
        return None;
    }
    Some(math_round(
        v * match key {
            Dim::Width => scale.sx.0,
            Dim::Height => scale.sy.0,
        },
    ))
}

/// `vmlPictShape(pict)`: the shape element of a VML pict, its shapetype
/// templates stripped. The match points into `body`, which holds the
/// stripped text.
fn vml_pict_shape<'b>(pict: &str, body: &'b mut String) -> Option<JsMatch<'b>> {
    *body =
        js_regex!(r"<v:shapetype\b[\s\S]*?<\/v:shapetype>").replace_all(pict, |_| String::new());
    js_regex!(r"<v:(oval|rect|roundrect|shape)\b([^>]*?)(\/?)>([\s\S]*?<\/v:\1>)?").exec(body)
}

/// `record[key]` of a record `parseTagAttrs` built.
fn attr<'a>(record: &'a JsObject<String>, key: &str) -> Option<&'a str> {
    record.get(key).map(String::as_str)
}

/// The attributes of every v:shapetype start tag of `xml`, in order.
fn shape_type_attrs(xml: &str) -> impl Iterator<Item = JsObject<String>> + '_ {
    js_regex!(r"<v:shapetype\b([^>]*)>")
        .find_iter(xml)
        .map(|found| parse_tag_attrs(found.get(1).unwrap_or("")))
}

/// `vmlShapeTypeTable(xml)`: v:shapetype templates of an XML part, by id
/// (shapes point at them with type="#id").
pub fn vml_shape_type_table(xml: &str) -> JsMap<JsObject<String>> {
    let mut out = JsMap::new();
    for a in shape_type_attrs(xml) {
        if let Some(id) = truthy(attr(&a, "id")).map(str::to_owned) {
            out.set(id, a);
        }
    }
    out
}

/// `VML_SPT_PATHS`, read for its own keys only (`ownValue`): default geometry
/// of the well-known o:spt ids a shape may carry without its shapetype.
fn vml_spt_path(spt: &str) -> Option<&'static str> {
    Some(match spt {
        "1" | "202" => "m,l,21600r21600,l21600,xe",
        "4" | "110" => "m10800,l,10800,10800,21600,21600,10800xe",
        "5" => "m10800,l,21600r21600,xe",
        "6" => "m,l,21600r21600,xe",
        _ => return None,
    })
}

/// `parseTagAttrs(tag)`: every `name="value"` of a tag, each an own entry
/// (`setOwn`), `__proto__` too.
fn parse_tag_attrs(tag: &str) -> JsObject<String> {
    let mut out = JsObject::new();
    for found in js_regex!(r#"([\w:.-]+)="([^"]*)""#).find_iter(tag) {
        out.set(
            found.get(1).unwrap_or(""),
            found.get(2).unwrap_or("").to_owned(),
        );
    }
    out
}

/// What `vmlShapeSvg` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VmlShapeSvg {
    pub data_url: String,
    pub width_px: JsNum,
    pub height_px: JsNum,
    pub style: String,
}

/// `encodeURIComponent(text)` over a Rust string, which holds no lone
/// surrogate, so it never throws.
// to jscompat: encodeURIComponent, which it lacks
pub(crate) fn encode_uri_component(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push('%');
            out.push(char::from(HEX[usize::from(byte >> 4)]));
            out.push(char::from(HEX[usize::from(byte & 15)]));
        }
    }
    out
}

/// `vmlShapeSvg(pict, shapeTypes)`: a textless VML shape (v:oval / v:rect /
/// v:roundrect / straight-path v:shape) with a solid or linear-gradient fill
/// and stroke as an SVG data URL at the shape's declared size. Attributes and
/// geometry the shape omits come from the v:shapetype it points at (in the
/// pict or in `shape_types`). `None` (null) on groups, pictures, text and
/// curved paths.
pub fn vml_shape_svg(
    pict: &str,
    shape_types: Option<&JsMap<JsObject<String>>>,
) -> Option<VmlShapeSvg> {
    if js_regex!(r"<v:(group|imagedata|textpath|textbox)\b|<w:txbxContent").test(pict) {
        return None;
    }
    let mut body_text = String::new();
    let m = vml_pict_shape(pict, &mut body_text)?;
    let raw_kind = m.get(1).unwrap_or("");
    let own = parse_tag_attrs(m.get(2).unwrap_or(""));
    let type_id = js_regex!(r"^#(.+)$")
        .exec(attr(&own, "type").unwrap_or(""))
        .and_then(|found| found.get(1));
    // vmlShapeTypeTable(pict).get(typeId): the last shapetype of that id
    let in_pict = type_id.and_then(|id| {
        shape_type_attrs(pict)
            .filter(|a| attr(a, "id") == Some(id))
            .last()
    });
    let type_attrs = match type_id {
        Some(id) => in_pict
            .as_ref()
            .or_else(|| shape_types.and_then(|table| table.get(id))),
        None => None,
    };
    // `{ ...typeAttrs, ...own }`, read by key only
    let a = |key: &str| attr(&own, key).or_else(|| type_attrs.and_then(|t| attr(t, key)));
    let style = attr(&own, "style").unwrap_or("");
    if js_regex!(r"visibility:\s*hidden").test(style) {
        return None;
    }
    let w = truthy_num(vml_style_dim_px(style, Dim::Width))?;
    let h = truthy_num(vml_style_dim_px(style, Dim::Height))?;
    let children = m.get(4).unwrap_or("");
    let fill_node = parse_tag_attrs(
        js_regex!(r"<v:fill\b([^>]*)>")
            .exec(children)
            .and_then(|found| found.get(1))
            .unwrap_or(""),
    );
    let stroke_node = parse_tag_attrs(
        js_regex!(r"<v:stroke\b([^>]*)>")
            .exec(children)
            .and_then(|found| found.get(1))
            .unwrap_or(""),
    );
    let off = |v: Option<&str>| matches!(v, Some("f" | "false" | "0"));
    let filled = !off(a("filled")) && !off(attr(&fill_node, "on"));
    let color1 = vml_color_hex(a("fillcolor"));
    let color1 = color1.as_deref().unwrap_or("FFFFFF");
    let color2 = vml_color_hex(attr(&fill_node, "color2"));
    let fill_type = attr(&fill_node, "type");
    if let Some(fill_type) = truthy(fill_type)
        && fill_type != "solid"
        && fill_type != "gradient"
    {
        return None;
    }
    let gradient = match &color2 {
        Some(color2) if filled && fill_type == Some("gradient") => {
            Some((vml_gradient(&fill_node), color2.as_str()))
        }
        _ => None,
    };
    let mut defs = String::new();
    let fill = if let Some((gradient, color2)) = gradient {
        let mut stops = String::new();
        for (o, c) in gradient.stops {
            let color = match c {
                StopColor::Fill => color1,
                StopColor::Color2 => color2,
            };
            let _ = write!(
                stops,
                r##"<stop offset="{}" stop-color="#{color}"/>"##,
                number_to_string(*o)
            );
        }
        let _ = write!(
            defs,
            r#"<defs><linearGradient id="g" x1="{}" y1="{}" x2="{}" y2="{}">{stops}</linearGradient></defs>"#,
            number_to_string(gradient.x1),
            number_to_string(gradient.y1),
            number_to_string(gradient.x2),
            number_to_string(gradient.y2),
        );
        "url(#g)".to_owned()
    } else if filled {
        format!("#{color1}")
    } else {
        "none".to_owned()
    };
    let opacity = vml_fraction(attr(&fill_node, "opacity"));
    let stroked = !off(a("stroked")) && !off(attr(&stroke_node, "on"));
    let sw = if stroked {
        vml_length_px(a("strokeweight")).unwrap_or(1.0)
    } else {
        0.0
    };
    let mut paint = format!(r#" fill="{fill}""#);
    if let Some(opacity) = opacity
        && opacity < 1.0
    {
        let _ = write!(paint, r#" fill-opacity="{}""#, number_to_string(opacity));
    }
    if stroked {
        let stroke = vml_color_hex(a("strokecolor"));
        let _ = write!(
            paint,
            r##" stroke="#{}" stroke-width="{}""##,
            stroke.as_deref().unwrap_or("000000"),
            number_to_string(sw)
        );
    }
    // o:spt 2 / 3 shapes drawn as v:shape keep their preset geometry (the
    // shapetype's own path is a curve the path converter cannot take)
    let spt = if truthy(attr(&own, "path")).is_some() {
        None
    } else {
        a("o:spt")
    };
    let kind = match (raw_kind, spt) {
        ("shape", Some("3")) => "oval",
        ("shape", Some("2")) => "roundrect",
        _ => raw_kind,
    };
    // the stroke is centered on the geometry edge: inset it so the img box keeps all of it
    let ix = sw / 2.0;
    let iw = math_max(0.0, w - sw);
    let ih = math_max(0.0, h - sw);
    let body = if kind == "oval" {
        format!(
            r#"<ellipse cx="{}" cy="{}" rx="{}" ry="{}"{paint}/>"#,
            number_to_string(w / 2.0),
            number_to_string(h / 2.0),
            number_to_string(iw / 2.0),
            number_to_string(ih / 2.0),
        )
    } else if kind == "rect" || kind == "roundrect" {
        // arcsize: corner radius as a fraction of half the shorter side (default 0.2)
        let arc = if kind == "roundrect" {
            vml_fraction(a("arcsize")).unwrap_or(0.2)
        } else {
            0.0
        };
        let r = math_round(arc * (math_min(iw, ih) / 2.0) * 100.0) / 100.0;
        let rx = if r > 0.0 {
            format!(r#" rx="{}""#, number_to_string(r))
        } else {
            String::new()
        };
        format!(
            r#"<rect x="{ix}" y="{ix}" width="{}" height="{}"{rx}{paint}/>"#,
            number_to_string(iw),
            number_to_string(ih),
            ix = number_to_string(ix),
        )
    } else {
        let path = a("path").or_else(|| vml_spt_path(a("o:spt").unwrap_or("")));
        let cs =
            js_regex!(r"^\s*(-?\d+)[,\s]+(-?\d+)").exec(a("coordsize").unwrap_or("21600,21600"));
        let d = match (truthy(path), cs) {
            (Some(path), Some(cs)) => vml_path_to_norm_d(
                path,
                parse_int(cs.get(1).unwrap_or(""), Radix::Ten),
                parse_int(cs.get(2).unwrap_or(""), Radix::Ten),
            ),
            _ => None,
        };
        let d = d.filter(|d| !d.is_empty())?;
        let mut axis = 0usize;
        let mut placed = String::with_capacity(d.len());
        for (at, tok) in d.split(' ').enumerate() {
            if at > 0 {
                placed.push(' ');
            }
            let n = to_number(tok);
            if !n.is_finite() {
                axis = 0;
                placed.push_str(tok);
                continue;
            }
            let v = if axis.is_multiple_of(2) {
                ix + n * iw
            } else {
                ix + n * ih
            };
            axis += 1;
            placed.push_str(&number_to_string(math_round(v * 100.0) / 100.0));
        }
        format!(r#"<path d="{placed}"{paint}/>"#)
    };
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {} {}">{defs}{body}</svg>"#,
        number_to_string(w),
        number_to_string(h),
    );
    Some(VmlShapeSvg {
        data_url: format!("data:image/svg+xml,{}", encode_uri_component(&svg)),
        width_px: JsNum(w),
        height_px: JsNum(h),
        style: style.to_owned(),
    })
}

/// A gradient stop colour: 1 = fillcolor, 2 = color2.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopColor {
    Fill,
    Color2,
}

/// What `vmlGradient` returns.
struct Gradient {
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    stops: &'static [(f64, StopColor)],
}

/// `vmlGradient(fillNode)`: v:fill type="gradient" as an SVG linearGradient
/// line (bounding-box fractions) and stops. VML angles count counterclockwise
/// from the bottom edge. A focus in 25%..75% is axial; beyond that a linear
/// fill with swapped ends.
fn vml_gradient(fill_node: &JsObject<String>) -> Gradient {
    let angle = parse_float(attr(fill_node, "angle").unwrap_or("0"));
    // `|| 0`: NaN and -0 are 0
    let angle = if angle == 0.0 || angle.is_nan() {
        0.0
    } else {
        angle
    };
    let focus = attr(fill_node, "focus").map(|focus| focus.replacen('%', "", 1));
    let focus = vml_fraction(focus.as_deref()).unwrap_or(0.0);
    let f = if focus.abs() > 1.0 {
        focus / 100.0
    } else {
        focus
    };
    let rad = ((90.0 - angle) * PI) / 180.0;
    let dx = rad.cos() / 2.0;
    let dy = rad.sin() / 2.0;
    let r = |v: f64| math_round(v * 1000.0) / 1000.0;
    let (x1, y1, x2, y2) = (r(0.5 - dx), r(0.5 - dy), r(0.5 + dx), r(0.5 + dy));
    let axial = f.abs() >= 0.25 && f.abs() <= 0.75;
    let stops: &'static [(f64, StopColor)] = if axial {
        if f > 0.0 {
            &[
                (0.0, StopColor::Fill),
                (0.5, StopColor::Color2),
                (1.0, StopColor::Fill),
            ]
        } else {
            &[
                (0.0, StopColor::Color2),
                (0.5, StopColor::Fill),
                (1.0, StopColor::Color2),
            ]
        }
    } else {
        let mut swap = angle < 0.0;
        if f.abs() > 0.5 {
            swap = !swap;
        }
        if swap {
            &[(0.0, StopColor::Fill), (1.0, StopColor::Color2)]
        } else {
            &[(0.0, StopColor::Color2), (1.0, StopColor::Fill)]
        }
    };
    Gradient {
        x1,
        y1,
        x2,
        y2,
        stops,
    }
}
