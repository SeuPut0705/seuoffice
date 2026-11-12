//! DrawingML colour readers of packages/docx-engine/src/parse-drawing-geometry.ts:
//! colour-bearing nodes, solid fill alpha, the gradient approximation and the
//! w14 text fill and glow.

use jscompat::{JsNum, Radix, js_regex, math_round, parse_int, trim, truthy};
use ooxml_xml::XNode;
use serde::Serialize;

use super::{rgb_hex, scheme_clr_base, w14_color_rgb};
use crate::theme::ThemeColors;

/// `TextGlow`: w14:glow halo, hex without '#', radius in points, opacity 0..1.
/// model type, to be replaced by the generated model
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextGlow {
    pub color: String,
    pub radius_pt: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alpha: Option<JsNum>,
}

/// `ownValue(PRST_CLR_HEX, val)`
fn prst_clr_hex(val: &str) -> Option<&'static str> {
    Some(match val {
        "black" => "000000",
        "white" => "FFFFFF",
        "red" => "FF0000",
        "green" => "008000",
        "blue" => "0000FF",
        "yellow" => "FFFF00",
        "cyan" => "00FFFF",
        "magenta" => "FF00FF",
        "gray" => "808080",
        _ => return None,
    })
}

/// `gradStopRgb`: one a:gs stop (or any colour-bearing node) to an sRGB triple
/// (srgbClr/sysClr/prstClr or theme-resolved schemeClr, lumMod/lumOff applied).
fn grad_stop_rgb(gs: &XNode, theme: Option<&ThemeColors>) -> Option<[f64; 3]> {
    let mut base: Option<&str> = gs.find_child("a:srgbClr").and_then(|srgb| srgb.attr("val"));
    if truthy(base).is_none()
        && let Some(sys) = gs.find_child("a:sysClr")
    {
        // Word writes the resolved system color into lastClr
        base = Some(
            sys.attr("lastClr")
                .unwrap_or(if sys.attr("val") == Some("windowText") {
                    "000000"
                } else {
                    "FFFFFF"
                }),
        );
    }
    if truthy(base).is_none()
        && let Some(prst) = gs.find_child("a:prstClr")
    {
        base = prst_clr_hex(prst.attr("val").unwrap_or(""));
    }
    let scheme = if truthy(base).is_some() {
        None
    } else {
        gs.find_child("a:schemeClr")
    };
    let themed: Option<String>;
    if let Some(scheme) = scheme {
        themed = scheme_clr_base(scheme.attr("val").unwrap_or(""), theme)?;
        base = themed.as_deref();
    }
    let base_trimmed = trim(base.unwrap_or(""));
    if base_trimmed.is_empty() || !js_regex!("^[0-9A-Fa-f]{6}$").test(base_trimmed) {
        return None;
    }
    let mut rgb = [0, 2, 4].map(|i| {
        base_trimmed
            .get(i..i + 2)
            .map_or(f64::NAN, |pair| parse_int(pair, Radix::Sixteen))
    });
    if let Some(scheme) = scheme {
        let pct = |name: &str| {
            let v = parse_int(
                scheme
                    .find_child(name)
                    .and_then(|child| child.attr("val"))
                    .unwrap_or(""),
                Radix::Ten,
            );
            // Math.min(100000, Math.max(0, v)): Math.max(0, -0) is +0
            v.is_finite()
                .then(|| (if v > 0.0 { v.min(100000.0) } else { 0.0 }) / 100000.0)
        };
        if let Some(lum_mod) = pct("a:lumMod") {
            rgb = rgb.map(|c| c * lum_mod);
        }
        if let Some(lum_off) = pct("a:lumOff") {
            rgb = rgb.map(|c| c + 255.0 * lum_off);
        }
        if let Some(shade) = pct("a:shade") {
            rgb = rgb.map(|c| c * shade);
        }
        if let Some(tint) = pct("a:tint") {
            rgb = rgb.map(|c| c * tint + 255.0 * (1.0 - tint));
        }
    }
    Some(rgb)
}

/// `colorNodeHex`: colour-bearing node (a:solidFill / a:fillRef / a:lnRef ...)
/// to hex without '#'.
pub fn color_node_hex(node: Option<&XNode>, theme: Option<&ThemeColors>) -> Option<String> {
    let rgb = grad_stop_rgb(node?, theme)?;
    Some(rgb_hex(&rgb))
}

const COLOR_NODE_NAMES: [&str; 4] = ["a:srgbClr", "a:schemeClr", "a:sysClr", "a:prstClr"];

/// `solidFillAlpha`: a:alpha of a solid fill's colour as 0..1; `None` when
/// opaque or absent.
pub fn solid_fill_alpha(solid_fill: Option<&XNode>) -> Option<f64> {
    let solid_fill = solid_fill?;
    for name in COLOR_NODE_NAMES {
        let Some(color) = solid_fill.find_child(name) else {
            continue;
        };
        let raw = parse_int(
            color
                .find_child("a:alpha")
                .and_then(|alpha| alpha.attr("val"))
                .unwrap_or(""),
            Radix::Ten,
        );
        return (raw.is_finite() && (0.0..100000.0).contains(&raw)).then(|| raw / 100000.0);
    }
    None
}

/// The equal-weight average of `stops`, summed per channel in stop order from
/// 0 as `stops.reduce((sum, rgb) => sum + rgb[i], 0) / stops.length` does;
/// `None` for no stop.
fn average<R: AsRef<[f64]>>(stops: impl Iterator<Item = R>) -> Option<[f64; 3]> {
    let mut sums = [0.0; 3];
    let mut count: u32 = 0;
    for rgb in stops {
        let rgb = rgb.as_ref();
        for (i, sum) in sums.iter_mut().enumerate() {
            // rgb[i] of a shorter array is undefined, which sums to NaN
            *sum += rgb.get(i).copied().unwrap_or(f64::NAN);
        }
        count += 1;
    }
    (count > 0).then(|| sums.map(|sum| sum / f64::from(count)))
}

/// `gradFillApproxHex`: a:gradFill approximated as a solid colour (display
/// only), the equal-weight sRGB average of all stops.
pub fn grad_fill_approx_hex(sp_pr: &XNode, theme: Option<&ThemeColors>) -> Option<String> {
    let gs_lst = sp_pr.find_child("a:gradFill")?.find_child("a:gsLst")?;
    let stops = gs_lst
        .children()
        .iter()
        .filter(|n| n.name() == Some("a:gs"))
        .filter_map(|gs| grad_stop_rgb(gs, theme));
    Some(rgb_hex(&average(stops)?))
}

/// `w14TextFillHex`: WordArt-styled run text (w14:textFill), a solid fill
/// directly, a gradient fill as the equal-weight average of its stops.
pub fn w14_text_fill_hex(r_pr: &XNode, theme: Option<&ThemeColors>) -> Option<String> {
    let tf = r_pr.find_child("w14:textFill")?;
    if let Some(solid) = tf.find_child("w14:solidFill") {
        return w14_color_rgb(solid, theme).map(|rgb| rgb_hex(&rgb));
    }
    let gs_lst = tf.find_child("w14:gradFill")?.find_child("w14:gsLst")?;
    let stops = gs_lst
        .children()
        .iter()
        .filter(|n| n.name() == Some("w14:gs"))
        .filter_map(|gs| w14_color_rgb(gs, theme));
    Some(rgb_hex(&average(stops)?))
}

/// `w14GlowOf`: w14:glow halo (radius in EMU, colour with optional alpha).
pub fn w14_glow_of(r_pr: &XNode, theme: Option<&ThemeColors>) -> Option<TextGlow> {
    let glow = r_pr.find_child("w14:glow")?;
    let rgb = w14_color_rgb(glow, theme);
    let rad_emu = parse_int(glow.attr("w14:rad").unwrap_or(""), Radix::Ten);
    let rgb = rgb?;
    if rad_emu.is_nan() || rad_emu <= 0.0 {
        return None;
    }
    let color_node = glow
        .find_child("w14:srgbClr")
        .or_else(|| glow.find_child("w14:schemeClr"));
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
    Some(TextGlow {
        color: rgb_hex(&rgb),
        radius_pt: JsNum(math_round((rad_emu / 12700.0) * 100.0) / 100.0),
        alpha,
    })
}
