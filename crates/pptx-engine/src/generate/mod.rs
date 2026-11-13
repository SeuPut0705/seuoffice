//! Element-level patch generation (packages/pptx-engine/src/generate.ts):
//! surgical in-place patches of the original XML bytes of dirty elements.
//!
//! Offsets are UTF-8 byte offsets, as everywhere in the engine; every slice
//! goes through [`sl`], [`from_`] or [`upto`], so none can panic.

use jscompat::{
    Radix, RegexLimit, math_max, math_min, math_round, number_to_string, parse_int, slice_utf16,
    try_js_regex,
};

mod shape;
mod slide;
mod text;

pub use crate::parse::context::COORD_MAX;
pub use shape::*;
pub use slide::*;
pub use text::*;

pub(crate) use crate::xml_utils::{escape_xml_attr, escape_xml_text};

/// A regex search that stopped at its backtrack limit, as the error the TypeScript throws.
pub(crate) fn lim(error: RegexLimit) -> String {
    error.to_string()
}

/// The largest char boundary at or below `at`, `at` clamped to the length: `slice` clamps.
fn floor_boundary(s: &str, at: usize) -> usize {
    let mut at = at.min(s.len());
    while !s.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// `s.slice(a, b)` at byte offsets, clamped as `slice` clamps.
pub(crate) fn sl(s: &str, a: usize, b: usize) -> &str {
    let (a, b) = (floor_boundary(s, a), floor_boundary(s, b));
    if a > b {
        return "";
    }
    s.get(a..b).unwrap_or_default()
}

/// `s.slice(a)`
pub(crate) fn from_(s: &str, a: usize) -> &str {
    s.get(floor_boundary(s, a)..).unwrap_or_default()
}

/// `s.slice(0, b)`
pub(crate) fn upto(s: &str, b: usize) -> &str {
    s.get(..floor_boundary(s, b)).unwrap_or_default()
}

/// `String(v)`
pub(crate) fn n(v: f64) -> String {
    number_to_string(v)
}

/// Points → ST_TextFontSize hundredths, clamped to the schema range (1pt..4000pt).
/// Non-finite inputs land on the lower bound.
pub fn sz_attr(pt: f64) -> String {
    let safe = if pt.is_finite() { pt } else { 1.0 };
    n(math_round(math_min(4000.0, math_max(1.0, safe)) * 100.0))
}

/// Integer attribute value inside a schema range; NaN/Infinity land on the lower bound.
pub fn clamp_int(v: f64, min: f64, max: f64) -> f64 {
    math_min(
        max,
        math_max(min, math_round(if v.is_finite() { v } else { min })),
    )
}

pub fn clamp_emu(v: f64) -> f64 {
    clamp_int(v, -COORD_MAX, COORD_MAX)
}

pub fn clamp_pos_emu(v: f64) -> f64 {
    clamp_int(v, 0.0, COORD_MAX)
}

pub(crate) fn emu_attr(v: f64) -> String {
    n(clamp_emu(v))
}

pub(crate) fn pos_emu_attr(v: f64) -> String {
    n(clamp_pos_emu(v))
}

pub(crate) fn angle_attr(v: f64) -> String {
    n(clamp_int(v, -2_147_483_648.0, 2_147_483_647.0))
}

pub(crate) fn spc_pts_xml(pt: f64) -> String {
    format!(
        "<a:spcPts val=\"{}\"/>",
        n(clamp_int(pt * 100.0, 0.0, 158_400.0))
    )
}

pub(crate) fn spc_pct_xml(pct: f64) -> String {
    format!(
        "<a:spcPct val=\"{}\"/>",
        n(clamp_int(pct * 1000.0, 0.0, 13_200_000.0))
    )
}

/// Normalize to 6-digit uppercase hex (dropping # and alpha).
pub(crate) fn hex6(color: &str) -> String {
    let mut c = color.strip_prefix('#').unwrap_or(color).to_uppercase();
    let len = c.encode_utf16().count();
    if len == 3 || len == 4 {
        c = slice_utf16(&c, 0.0, Some(3.0))
            .chars()
            .flat_map(|ch| [ch, ch])
            .collect();
    }
    if c.encode_utf16().count() >= 6 {
        c = slice_utf16(&c, 0.0, Some(6.0));
    }
    // ST_HexColorRGB; anything else is a repair prompt, black is the least surprising stand-in
    if c.len() == 6 && c.bytes().all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'F')) {
        c
    } else {
        "000000".to_owned()
    }
}

/// `<a:alpha>` child for an #RRGGBBAA color; '' when opaque or 6-digit.
fn alpha_xml(color: &str) -> String {
    let c = color.strip_prefix('#').unwrap_or(color);
    if c.encode_utf16().count() < 8 {
        return String::new();
    }
    let a = parse_int(&slice_utf16(c, 6.0, Some(8.0)), Radix::Sixteen);
    if !a.is_finite() || a >= 255.0 {
        return String::new();
    }
    format!(
        "<a:alpha val=\"{}\"/>",
        n(math_round(a / 255.0 * 100_000.0))
    )
}

pub(crate) fn srgb_clr_xml(color: &str) -> String {
    let alpha = alpha_xml(color);
    if alpha.is_empty() {
        format!("<a:srgbClr val=\"{}\"/>", hex6(color))
    } else {
        format!("<a:srgbClr val=\"{}\">{alpha}</a:srgbClr>", hex6(color))
    }
}

/// The fill group of CT_ShapeProperties and friends.
pub(crate) fn is_fill_tag(name: &str) -> bool {
    matches!(
        name,
        "a:noFill" | "a:solidFill" | "a:gradFill" | "a:blipFill" | "a:pattFill" | "a:grpFill"
    )
}

/// One top-level child found by [`top_level_children`]; offsets are bytes.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TopLevelChild {
    pub name: String,
    pub start: usize,
    pub end: usize,
}

/// Scan top-level children (depth 1) in the [from,to) range of an xml fragment.
pub fn top_level_children(xml: &str, from: usize, to: usize) -> Result<Vec<TopLevelChild>, String> {
    let mut out = Vec::new();
    if from > xml.len() || !xml.is_char_boundary(from) {
        return Ok(out);
    }
    let re = try_js_regex!(r#"<(\/?)([a-zA-Z][\w:]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>"#);
    let mut depth: i64 = 0;
    let mut cur_start = 0usize;
    let mut cur_name = String::new();
    // the pattern starts at `<` and reads nothing behind: the search of the
    // tail is the search from `lastIndex = from`
    let Some(tail) = xml.get(from..) else {
        return Ok(out);
    };
    for found in re.try_find_iter(tail) {
        let m = found.map_err(lim)?;
        let (m_start, m_end) = (from + m.start(), from + m.end());
        if m_start >= to {
            break;
        }
        let closing = m.get(1) == Some("/");
        let self_close = m.get(4) == Some("/");
        let name = m.get(2).unwrap_or_default();
        if !closing && !self_close {
            if depth == 0 {
                cur_start = m_start;
                cur_name = name.to_owned();
            }
            depth += 1;
        } else if closing {
            depth -= 1;
            if depth == 0 {
                out.push(TopLevelChild {
                    name: cur_name.clone(),
                    start: cur_start,
                    end: m_end,
                });
            }
        } else if self_close && depth == 0 {
            out.push(TopLevelChild {
                name: name.to_owned(),
                start: m_start,
                end: m_end,
            });
        }
    }
    Ok(out)
}
