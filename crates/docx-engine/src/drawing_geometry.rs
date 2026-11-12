//! Drawing geometry readers (packages/docx-engine/src/parse-drawing-geometry.ts;
//! only `w14TextOutlineOf` is ported yet).

use jscompat::{JsNum, Radix, js_regex, math_round, pad_start, parse_int, to_string_radix16, trim};
use ooxml_xml::XNode;
use serde::{Deserialize, Serialize};

use crate::theme::ThemeColors;

pub mod anchor;
pub mod fill;
pub mod line_box;

/// w14:textOutline stroke: hex without '#', width in points, opacity 0..1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextOutline {
    pub color: String,
    pub width_pt: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alpha: Option<JsNum>,
}

/// `theme?.[SCHEME_CLR_SLOTS[val]] ?? DEFAULT_THEME_COLORS[slot]`; `None` for an
/// unknown scheme name.
pub(crate) fn scheme_clr_base(val: &str, theme: Option<&ThemeColors>) -> Option<Option<String>> {
    let (pick, fallback): (fn(&ThemeColors) -> &Option<String>, &str) = match val {
        "tx1" | "dk1" => (|t| &t.dk1, "000000"),
        "bg1" | "lt1" => (|t| &t.lt1, "FFFFFF"),
        "tx2" | "dk2" => (|t| &t.dk2, "44546A"),
        "bg2" | "lt2" => (|t| &t.lt2, "E7E6E6"),
        "accent1" => (|t| &t.accent1, "4472C4"),
        "accent2" => (|t| &t.accent2, "ED7D31"),
        "accent3" => (|t| &t.accent3, "A5A5A5"),
        "accent4" => (|t| &t.accent4, "FFC000"),
        "accent5" => (|t| &t.accent5, "5B9BD5"),
        "accent6" => (|t| &t.accent6, "70AD47"),
        "hlink" => (|t| &t.hlink, "0563C1"),
        "folHlink" => (|t| &t.fol_hlink, "954F72"),
        _ => return None,
    };
    Some(Some(
        theme
            .and_then(|theme| pick(theme).clone())
            .unwrap_or_else(|| fallback.to_owned()),
    ))
}

pub(crate) fn rgb_hex(rgb: &[f64]) -> String {
    rgb.iter()
        .map(|c| {
            pad_start(&to_string_radix16(math_round(c.clamp(0.0, 255.0))), 2, '0').to_uppercase()
        })
        .collect()
}

pub(crate) fn w14_color_rgb(node: &XNode, theme: Option<&ThemeColors>) -> Option<Vec<f64>> {
    let color_node = node
        .find_child("w14:srgbClr")
        .or_else(|| node.find_child("w14:schemeClr"))?;
    let is_scheme = color_node.name() == Some("w14:schemeClr");
    let mut base = color_node.attr("w14:val").map(str::to_owned);
    if is_scheme {
        base = scheme_clr_base(base.as_deref().unwrap_or(""), theme)?;
    }
    let base_trimmed = trim(base.as_deref().unwrap_or(""));
    if base_trimmed.is_empty() || !js_regex!("^[0-9A-Fa-f]{6}$").test(base_trimmed) {
        return None;
    }
    let mut rgb: Vec<f64> = [0, 2, 4]
        .iter()
        .map(|&i| parse_int(&base_trimmed[i..i + 2], Radix::Sixteen))
        .collect();
    let pct = |name: &str| {
        let v = parse_int(
            color_node
                .find_child(name)
                .and_then(|child| child.attr("w14:val"))
                .unwrap_or(""),
            Radix::Ten,
        );
        (v.is_finite() && v >= 0.0).then_some(v / 100000.0)
    };
    if let Some(lum_mod) = pct("w14:lumMod") {
        rgb = rgb.iter().map(|c| c * lum_mod).collect();
    }
    if let Some(lum_off) = pct("w14:lumOff") {
        rgb = rgb.iter().map(|c| c + 255.0 * lum_off).collect();
    }
    if let Some(shade) = pct("w14:shade") {
        rgb = rgb.iter().map(|c| c * shade).collect();
    }
    if let Some(tint) = pct("w14:tint") {
        rgb = rgb
            .iter()
            .map(|c| c * tint + 255.0 * (1.0 - tint))
            .collect();
    }
    if let Some(sat_mod) = pct("w14:satMod").filter(|sat_mod| *sat_mod != 1.0) {
        rgb = saturation_modulate(rgb, sat_mod);
    }
    Some(rgb)
}

/// HSL saturation modulation (a:satMod / w14:satMod semantics, clamped).
fn saturation_modulate(rgb: Vec<f64>, modulation: f64) -> Vec<f64> {
    let [r, g, b] = [0, 1, 2].map(|i| 255f64.min(0f64.max(rgb[i])) / 255.0);
    // Math.max / Math.min of three numbers that are never NaN here
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d == 0.0 {
        return rgb;
    }
    let mut s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        ((g - b) / d + if g < b { 6.0 } else { 0.0 }) / 6.0
    } else if max == g {
        ((b - r) / d + 2.0) / 6.0
    } else {
        ((r - g) / d + 4.0) / 6.0
    };
    s = 1f64.min(s * modulation);
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let hue = |mut t: f64| {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            return p + (q - p) * 6.0 * t;
        }
        if t < 1.0 / 2.0 {
            return q;
        }
        if t < 2.0 / 3.0 {
            return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
        }
        p
    };
    [hue(h + 1.0 / 3.0), hue(h), hue(h - 1.0 / 3.0)]
        .iter()
        .map(|c| c * 255.0)
        .collect()
}

/// w14:textOutline stroke (solid fills only; gradient and noFill outlines are not drawn).
pub fn w14_text_outline_of(r_pr: &XNode, theme: Option<&ThemeColors>) -> Option<TextOutline> {
    let outline = r_pr.find_child("w14:textOutline")?;
    let solid = outline.find_child("w14:solidFill")?;
    let rgb = w14_color_rgb(solid, theme)?;
    let width_emu = parse_int(outline.attr("w14:w").unwrap_or(""), Radix::Ten);
    if width_emu.is_nan() || width_emu <= 0.0 {
        return None;
    }
    let color_node = solid
        .find_child("w14:srgbClr")
        .or_else(|| solid.find_child("w14:schemeClr"));
    let alpha_raw = parse_int(
        color_node
            .and_then(|node| node.find_child("w14:alpha"))
            .and_then(|alpha| alpha.attr("w14:val"))
            .unwrap_or(""),
        Radix::Ten,
    );
    let alpha = (0.0..100000.0)
        .contains(&alpha_raw)
        .then(|| JsNum(alpha_raw / 100000.0));
    Some(TextOutline {
        color: rgb_hex(&rgb),
        width_pt: JsNum(math_round(width_emu / 12700.0 * 100.0) / 100.0),
        alpha,
    })
}
