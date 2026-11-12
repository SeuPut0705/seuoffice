//! Colour node resolution (packages/pptx-engine/src/color.ts): `srgbClr`,
//! `schemeClr`, `sysClr` and `prstClr` with the DrawingML colour transforms.

use std::borrow::Cow;

use jscompat::{
    JsNum, Radix, math_max, math_min, math_pow, math_round, number_truthy, pad_start, parse_int,
    slice_utf16, to_string_radix16, value_to_string, value_truthy,
};
use serde::Serialize;
use serde_json::Value;

use crate::theme::{Theme, resolve_scheme_color, sys_color_hex};
use crate::xml_utils::{as_xml_node, percent_fraction, xml_array};

/// `String(value ?? '')`
fn string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => value_to_string(Some(value)),
    }
}

/// `resolveColorNode`: the colour of a node holding a colour element, with
/// its transforms; `#RRGGBB`, or `#RRGGBBAA` with an alpha below 100%.
pub fn resolve_color_node(
    node: Option<&Value>,
    theme: Option<&Theme>,
    ph_clr: Option<&str>,
) -> Option<String> {
    if !value_truthy(node) {
        return None;
    }
    let n = as_xml_node(node);
    let mut base: Option<String> = None;
    let mut mods: Option<&Value> = None;
    if value_truthy(n.get("a:srgbClr")) {
        let m = as_xml_node(n.get("a:srgbClr"));
        mods = Some(m);
        // a missing val stays unresolved instead of reading as '#UNDEFINED'
        let raw = string_or_empty(m.get("@_val"));
        if !raw.is_empty() {
            base = Some(format!("#{}", raw.to_uppercase()));
        }
    } else if value_truthy(n.get("a:schemeClr")) {
        let m = as_xml_node(n.get("a:schemeClr"));
        mods = Some(m);
        let name = value_to_string(m.get("@_val"));
        base = resolve_scheme_color(&name, theme, ph_clr).map(str::to_owned);
    } else if value_truthy(n.get("a:sysClr")) {
        let m = as_xml_node(n.get("a:sysClr"));
        mods = Some(m);
        base = Some(sys_color_hex(m.get("@_val"), m.get("@_lastClr")));
    } else if value_truthy(n.get("a:prstClr")) {
        let m = as_xml_node(n.get("a:prstClr"));
        mods = Some(m);
        let raw = string_or_empty(m.get("@_val"));
        // `ownValue`: the table answers its own color names only
        base = preset_color(&raw)
            .or_else(|| preset_color_lower(&raw.to_lowercase()))
            .or_else(|| preset_color(&lower_first(&raw)))
            .map(str::to_owned);
    }
    let base = base.filter(|base| !base.is_empty())?;
    Some(apply_color_mods(&base, mods))
}

/// `raw.charAt(0).toLowerCase() + raw.slice(1)`. A first character outside
/// the BMP is half of it to `charAt`, which lowercases to itself.
fn lower_first(raw: &str) -> Cow<'_, str> {
    let mut chars = raw.chars();
    match chars.next() {
        Some(first) if first.len_utf16() == 1 => {
            Cow::Owned(first.to_lowercase().chain(chars).collect())
        }
        _ => Cow::Borrowed(raw),
    }
}

/// `PRESET_COLORS[key]` for its own keys.
fn preset_color(key: &str) -> Option<&'static str> {
    PRESET_COLORS
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, hex)| *hex)
}

/// `PRESET_COLORS_LOWER.get(lowered)`: a later key that lowercases alike
/// would have overwritten an earlier one in the map.
fn preset_color_lower(lowered: &str) -> Option<&'static str> {
    PRESET_COLORS
        .iter()
        .rev()
        .find(|(name, _)| {
            name.len() == lowered.len()
                && name
                    .bytes()
                    .zip(lowered.bytes())
                    .all(|(n, l)| n.to_ascii_lowercase() == l)
        })
        .map(|(_, hex)| *hex)
}

/// ECMA-376 ST_PresetColorVal (CSS/X11 values plus the dk/lt/med aliases).
const PRESET_COLORS: &[(&str, &str)] = &[
    ("aliceBlue", "#F0F8FF"),
    ("antiqueWhite", "#FAEBD7"),
    ("aqua", "#00FFFF"),
    ("aquamarine", "#7FFFD4"),
    ("azure", "#F0FFFF"),
    ("beige", "#F5F5DC"),
    ("bisque", "#FFE4C4"),
    ("black", "#000000"),
    ("blanchedAlmond", "#FFEBCD"),
    ("blue", "#0000FF"),
    ("blueViolet", "#8A2BE2"),
    ("brown", "#A52A2A"),
    ("burlyWood", "#DEB887"),
    ("cadetBlue", "#5F9EA0"),
    ("chartreuse", "#7FFF00"),
    ("chocolate", "#D2691E"),
    ("coral", "#FF7F50"),
    ("cornflowerBlue", "#6495ED"),
    ("cornsilk", "#FFF8DC"),
    ("crimson", "#DC143C"),
    ("cyan", "#00FFFF"),
    ("darkBlue", "#00008B"),
    ("darkCyan", "#008B8B"),
    ("darkGoldenrod", "#B8860B"),
    ("darkGray", "#A9A9A9"),
    ("darkGreen", "#006400"),
    ("darkGrey", "#A9A9A9"),
    ("darkKhaki", "#BDB76B"),
    ("darkMagenta", "#8B008B"),
    ("darkOliveGreen", "#556B2F"),
    ("darkOrange", "#FF8C00"),
    ("darkOrchid", "#9932CC"),
    ("darkRed", "#8B0000"),
    ("darkSalmon", "#E9967A"),
    ("darkSeaGreen", "#8FBC8F"),
    ("darkSlateBlue", "#483D8B"),
    ("darkSlateGray", "#2F4F4F"),
    ("darkSlateGrey", "#2F4F4F"),
    ("darkTurquoise", "#00CED1"),
    ("darkViolet", "#9400D3"),
    ("deepPink", "#FF1493"),
    ("deepSkyBlue", "#00BFFF"),
    ("dimGray", "#696969"),
    ("dimGrey", "#696969"),
    ("dkBlue", "#00008B"),
    ("dkCyan", "#008B8B"),
    ("dkGoldenrod", "#B8860B"),
    ("dkGray", "#A9A9A9"),
    ("dkGreen", "#006400"),
    ("dkGrey", "#A9A9A9"),
    ("dkKhaki", "#BDB76B"),
    ("dkMagenta", "#8B008B"),
    ("dkOliveGreen", "#556B2F"),
    ("dkOrange", "#FF8C00"),
    ("dkOrchid", "#9932CC"),
    ("dkRed", "#8B0000"),
    ("dkSalmon", "#E9967A"),
    ("dkSeaGreen", "#8FBC8F"),
    ("dkSlateBlue", "#483D8B"),
    ("dkSlateGray", "#2F4F4F"),
    ("dkSlateGrey", "#2F4F4F"),
    ("dkTurquoise", "#00CED1"),
    ("dkViolet", "#9400D3"),
    ("dodgerBlue", "#1E90FF"),
    ("firebrick", "#B22222"),
    ("floralWhite", "#FFFAF0"),
    ("forestGreen", "#228B22"),
    ("fuchsia", "#FF00FF"),
    ("gainsboro", "#DCDCDC"),
    ("ghostWhite", "#F8F8FF"),
    ("gold", "#FFD700"),
    ("goldenrod", "#DAA520"),
    ("gray", "#808080"),
    ("green", "#008000"),
    ("greenYellow", "#ADFF2F"),
    ("grey", "#808080"),
    ("honeydew", "#F0FFF0"),
    ("hotPink", "#FF69B4"),
    ("indianRed", "#CD5C5C"),
    ("indigo", "#4B0082"),
    ("ivory", "#FFFFF0"),
    ("khaki", "#F0E68C"),
    ("lavender", "#E6E6FA"),
    ("lavenderBlush", "#FFF0F5"),
    ("lawnGreen", "#7CFC00"),
    ("lemonChiffon", "#FFFACD"),
    ("lightBlue", "#ADD8E6"),
    ("lightCoral", "#F08080"),
    ("lightCyan", "#E0FFFF"),
    ("lightGoldenrodYellow", "#FAFAD2"),
    ("lightGray", "#D3D3D3"),
    ("lightGreen", "#90EE90"),
    ("lightGrey", "#D3D3D3"),
    ("lightPink", "#FFB6C1"),
    ("lightSalmon", "#FFA07A"),
    ("lightSeaGreen", "#20B2AA"),
    ("lightSkyBlue", "#87CEFA"),
    ("lightSlateGray", "#778899"),
    ("lightSlateGrey", "#778899"),
    ("lightSteelBlue", "#B0C4DE"),
    ("lightYellow", "#FFFFE0"),
    ("lime", "#00FF00"),
    ("limeGreen", "#32CD32"),
    ("linen", "#FAF0E6"),
    ("ltBlue", "#ADD8E6"),
    ("ltCoral", "#F08080"),
    ("ltCyan", "#E0FFFF"),
    ("ltGoldenrodYellow", "#FAFAD2"),
    ("ltGray", "#D3D3D3"),
    ("ltGreen", "#90EE90"),
    ("ltGrey", "#D3D3D3"),
    ("ltPink", "#FFB6C1"),
    ("ltSalmon", "#FFA07A"),
    ("ltSeaGreen", "#20B2AA"),
    ("ltSkyBlue", "#87CEFA"),
    ("ltSlateGray", "#778899"),
    ("ltSlateGrey", "#778899"),
    ("ltSteelBlue", "#B0C4DE"),
    ("ltYellow", "#FFFFE0"),
    ("magenta", "#FF00FF"),
    ("maroon", "#800000"),
    ("medAquamarine", "#66CDAA"),
    ("medBlue", "#0000CD"),
    ("mediumAquamarine", "#66CDAA"),
    ("mediumBlue", "#0000CD"),
    ("mediumOrchid", "#BA55D3"),
    ("mediumPurple", "#9370DB"),
    ("mediumSeaGreen", "#3CB371"),
    ("mediumSlateBlue", "#7B68EE"),
    ("mediumSpringGreen", "#00FA9A"),
    ("mediumTurquoise", "#48D1CC"),
    ("mediumVioletRed", "#C71585"),
    ("medOrchid", "#BA55D3"),
    ("medPurple", "#9370DB"),
    ("medSeaGreen", "#3CB371"),
    ("medSlateBlue", "#7B68EE"),
    ("medSpringGreen", "#00FA9A"),
    ("medTurquoise", "#48D1CC"),
    ("medVioletRed", "#C71585"),
    ("midnightBlue", "#191970"),
    ("mintCream", "#F5FFFA"),
    ("mistyRose", "#FFE4E1"),
    ("moccasin", "#FFE4B5"),
    ("navajoWhite", "#FFDEAD"),
    ("navy", "#000080"),
    ("oldLace", "#FDF5E6"),
    ("olive", "#808000"),
    ("oliveDrab", "#6B8E23"),
    ("orange", "#FFA500"),
    ("orangeRed", "#FF4500"),
    ("orchid", "#DA70D6"),
    ("paleGoldenrod", "#EEE8AA"),
    ("paleGreen", "#98FB98"),
    ("paleTurquoise", "#AFEEEE"),
    ("paleVioletRed", "#DB7093"),
    ("papayaWhip", "#FFEFD5"),
    ("peachPuff", "#FFDAB9"),
    ("peru", "#CD853F"),
    ("pink", "#FFC0CB"),
    ("plum", "#DDA0DD"),
    ("powderBlue", "#B0E0E6"),
    ("purple", "#800080"),
    ("red", "#FF0000"),
    ("rosyBrown", "#BC8F8F"),
    ("royalBlue", "#4169E1"),
    ("saddleBrown", "#8B4513"),
    ("salmon", "#FA8072"),
    ("sandyBrown", "#F4A460"),
    ("seaGreen", "#2E8B57"),
    ("seaShell", "#FFF5EE"),
    ("sienna", "#A0522D"),
    ("silver", "#C0C0C0"),
    ("skyBlue", "#87CEEB"),
    ("slateBlue", "#6A5ACD"),
    ("slateGray", "#708090"),
    ("slateGrey", "#708090"),
    ("snow", "#FFFAFA"),
    ("springGreen", "#00FF7F"),
    ("steelBlue", "#4682B4"),
    ("tan", "#D2B48C"),
    ("teal", "#008080"),
    ("thistle", "#D8BFD8"),
    ("tomato", "#FF6347"),
    ("turquoise", "#40E0D0"),
    ("violet", "#EE82EE"),
    ("wheat", "#F5DEB3"),
    ("white", "#FFFFFF"),
    ("whiteSmoke", "#F5F5F5"),
    ("yellow", "#FFFF00"),
    ("yellowGreen", "#9ACD32"),
];

/// The `val` of every `k` child of `mods` as `percentFraction(v) ?? 0`, in
/// document order; a child without `val` is skipped.
fn vals(mods: Option<&Value>, k: &str) -> Vec<f64> {
    xml_array(mods.and_then(|mods| mods.get(k)))
        .filter_map(|n| n.get("@_val").filter(|v| !v.is_null()))
        .map(|v| percent_fraction(Some(v)).unwrap_or(0.0))
        .collect()
}

fn last(mods: Option<&Value>, k: &str) -> Option<f64> {
    vals(mods, k).last().copied()
}

fn product(mods: Option<&Value>, k: &str) -> Option<f64> {
    let v = vals(mods, k);
    (!v.is_empty()).then(|| v.iter().fold(1.0, |a, b| a * b))
}

/// `sum`: percentages add as fractions; `raw_divisor` (hueOff, an angle in
/// 1/60000 degree) reads the value as `parseInt(raw, 10) || 0` over it.
fn sum(mods: Option<&Value>, k: &str, raw_divisor: Option<f64>) -> Option<f64> {
    let v: Vec<f64> = xml_array(mods.and_then(|mods| mods.get(k)))
        .filter_map(|n| n.get("@_val").filter(|v| !v.is_null()))
        .map(|raw| match raw_divisor {
            Some(divisor) if divisor != 0.0 => {
                let parsed = parse_int(&value_to_string(Some(raw)), Radix::Ten);
                (if number_truthy(parsed) { parsed } else { 0.0 }) / divisor
            }
            _ => percent_fraction(Some(raw)).unwrap_or(0.0),
        })
        .collect();
    (!v.is_empty()).then(|| v.iter().fold(0.0, |a, b| a + b))
}

/// `applyColorMods`: `lumMod`, `lumOff`, `tint`, `shade`, `satMod`,
/// `hueOff`, `satOff` and `alpha` of `mods` applied to `hex`. Repeated
/// multipliers compound, offsets add, the last alpha wins.
pub fn apply_color_mods(hex: &str, mods: Option<&Value>) -> String {
    let Rgb { r, g, b } = hex_to_rgb(hex);
    let (mut r, mut g, mut b) = (r.0, g.0, b.0);
    let lum_mod = product(mods, "a:lumMod");
    let lum_off = sum(mods, "a:lumOff", None);
    let shade = product(mods, "a:shade");
    let tint = product(mods, "a:tint");
    // hueOff counts 1/60000 degree
    let hue_off = sum(mods, "a:hueOff", Some(60_000.0));
    let sat_off = sum(mods, "a:satOff", None);
    if hue_off.is_some_and(|v| v != 0.0) || sat_off.is_some_and(|v| v != 0.0) {
        let (h, s, l) = rgb_to_hsl(r, g, b);
        let h2 = (((h + hue_off.unwrap_or(0.0) / 360.0) % 1.0) + 1.0) % 1.0;
        let s2 = math_max(0.0, math_min(1.0, s + sat_off.unwrap_or(0.0)));
        (r, g, b) = hsl_to_rgb(h2, s2, l);
    }
    let sat_mod = product(mods, "a:satMod");
    if let Some(sat_mod) = sat_mod {
        let (h, s, l) = rgb_to_hsl(r, g, b);
        (r, g, b) = hsl_to_rgb(h, math_max(0.0, math_min(1.0, s * sat_mod)), l);
    }
    if lum_mod.is_some() || lum_off.is_some() {
        let (h, s, l) = rgb_to_hsl(r, g, b);
        let l2 = math_max(
            0.0,
            math_min(1.0, l * lum_mod.unwrap_or(1.0) + lum_off.unwrap_or(0.0)),
        );
        (r, g, b) = hsl_to_rgb(h, s, l2);
    }
    // tint and shade blend in linear-gamma space
    let lin = |v: f64| math_pow(math_max(v, 0.0) / 255.0, 2.2);
    let unlin = |v: f64| 255.0 * math_pow(math_max(v, 0.0), 1.0 / 2.2);
    if let Some(shade) = shade {
        r = unlin(lin(r) * shade);
        g = unlin(lin(g) * shade);
        b = unlin(lin(b) * shade);
    }
    if let Some(tint) = tint {
        r = unlin(lin(r) * tint + (1.0 - tint));
        g = unlin(lin(g) * tint + (1.0 - tint));
        b = unlin(lin(b) * tint + (1.0 - tint));
    }
    let clamp = |v: f64| math_max(0.0, math_min(255.0, math_round(v)));
    let channels: String = [clamp(r), clamp(g), clamp(b)]
        .into_iter()
        .map(|v| pad_start(&to_string_radix16(v), 2, '0'))
        .collect();
    let mut out = format!("#{}", channels.to_uppercase());
    if let Some(alpha) = last(mods, "a:alpha")
        && alpha < 1.0
    {
        // Broken input can carry a negative alpha: clamp so the suffix stays two hex digits
        let byte = math_max(0.0, math_min(255.0, math_round(alpha * 255.0)));
        let alpha = pad_start(&to_string_radix16(byte), 2, '0');
        out.push_str(&alpha.to_uppercase());
    }
    out
}

/// The `{ r, g, b }` of `hexToRgb`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Rgb {
    pub r: JsNum,
    pub g: JsNum,
    pub b: JsNum,
}

/// `hexToRgb`: each pair of UTF-16 code units after one leading `#` read
/// as `parseInt(pair, 16) || 0`.
pub fn hex_to_rgb(hex: &str) -> Rgb {
    let h = hex.strip_prefix('#').unwrap_or(hex);
    let channel = |start: f64, end: f64| {
        let v = parse_int(&slice_utf16(h, start, Some(end)), Radix::Sixteen);
        JsNum(if number_truthy(v) { v } else { 0.0 })
    };
    Rgb {
        r: channel(0.0, 2.0),
        g: channel(2.0, 4.0),
        b: channel(4.0, 6.0),
    }
}

fn rgb_to_hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let (r, g, b) = (r / 255.0, g / 255.0, b / 255.0);
    let max = math_max(math_max(r, g), b);
    let min = math_min(math_min(r, g), b);
    let l = (max + min) / 2.0;
    if max == min {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 {
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
    (h, s, l)
}

/// `scaleLuminance`: the HSL luminance scaled by `factor`, at most 0.97.
pub fn scale_luminance(hex: &str, factor: f64) -> String {
    let Rgb { r, g, b } = hex_to_rgb(hex);
    let (h, s, l) = rgb_to_hsl(r.0, g.0, b.0);
    let (r, g, b) = hsl_to_rgb(h, s, math_max(0.0, math_min(0.97, l * factor)));
    let to2 = |v: f64| {
        pad_start(
            &to_string_radix16(math_max(0.0, math_min(255.0, math_round(v)))),
            2,
            '0',
        )
    };
    format!("#{}{}{}", to2(r), to2(g), to2(b)).to_uppercase()
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (f64, f64, f64) {
    if s == 0.0 {
        let v = l * 255.0;
        return (v, v, v);
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let f = |mut t: f64| {
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
    (
        f(h + 1.0 / 3.0) * 255.0,
        f(h) * 255.0,
        f(h - 1.0 / 3.0) * 255.0,
    )
}
