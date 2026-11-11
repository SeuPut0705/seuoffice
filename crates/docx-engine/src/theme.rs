//! Theme palette and fonts as the property readers use them
//! (`resolveThemeColor` of packages/docx-engine/src/theme.ts; the theme part
//! readers are not ported yet).

use std::collections::BTreeMap;

use jscompat::{Radix, js_regex, math_round, pad_start, parse_int, to_string_radix16, trim};
use serde::Deserialize;

/// The slots `readThemeColors` fills for w:themeColor resolution.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColors {
    pub dk1: Option<String>,
    pub lt1: Option<String>,
    pub dk2: Option<String>,
    pub lt2: Option<String>,
    pub accent1: Option<String>,
    pub accent2: Option<String>,
    pub accent3: Option<String>,
    pub accent4: Option<String>,
    pub accent5: Option<String>,
    pub accent6: Option<String>,
    pub hlink: Option<String>,
    pub fol_hlink: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeFonts {
    pub major: String,
    pub minor: String,
    pub east_asia: Option<String>,
    pub major_east_asia: Option<String>,
    pub major_cs: Option<String>,
    pub minor_cs: Option<String>,
    /// settings.xml w:themeFontLang w:eastAsia
    pub ea_lang: Option<String>,
    /// settings.xml w:themeFontLang w:bidi
    pub bidi_lang: Option<String>,
    /// Per-script faces (`<a:font script="Hang" typeface="..."/>`) of each font group.
    pub major_scripts: Option<BTreeMap<String, String>>,
    pub minor_scripts: Option<BTreeMap<String, String>>,
}

/// The palette slot a w:themeColor value names, with the built-in fallback of
/// the two slots that have one.
fn slot_of<'a>(theme_color: &str, colors: &'a ThemeColors) -> Option<Option<&'a str>> {
    let (slot, fallback) = match theme_color {
        "dark1" | "text1" => (&colors.dk1, Some("000000")),
        "light1" | "background1" => (&colors.lt1, Some("FFFFFF")),
        "dark2" | "text2" => (&colors.dk2, None),
        "light2" | "background2" => (&colors.lt2, None),
        "accent1" => (&colors.accent1, None),
        "accent2" => (&colors.accent2, None),
        "accent3" => (&colors.accent3, None),
        "accent4" => (&colors.accent4, None),
        "accent5" => (&colors.accent5, None),
        "accent6" => (&colors.accent6, None),
        "hyperlink" => (&colors.hlink, None),
        "followedHyperlink" => (&colors.fol_hlink, None),
        _ => return None,
    };
    Some(slot.as_deref().or(fallback))
}

/// Resolves a w:themeColor reference (with optional w:themeTint and
/// w:themeShade, hex 00-FF) against the palette. Word scales HSL lightness:
/// shade is `L * s`, tint is `L * t + (1 - t)`.
pub fn resolve_theme_color(
    theme_color: &str,
    colors: &ThemeColors,
    tint: Option<&str>,
    shade: Option<&str>,
) -> Option<String> {
    let base = trim(slot_of(theme_color, colors)?.unwrap_or(""));
    if base.is_empty() || !js_regex!("^[0-9A-Fa-f]{6}$").test(base) {
        return None;
    }
    let factor_of = |hex: Option<&str>| {
        let value = hex
            .filter(|hex| !hex.is_empty())
            .map_or(f64::NAN, |hex| parse_int(hex, Radix::Sixteen));
        value
            .is_finite()
            .then(|| 0f64.max(255f64.min(value)) / 255.0)
    };
    let shade = factor_of(shade);
    let tint = factor_of(tint);
    if shade.is_none() && tint.is_none() {
        return Some(base.to_uppercase());
    }
    let channel = |at: usize| parse_int(&base[at..at + 2], Radix::Sixteen) / 255.0;
    let (hue, saturation, mut lightness) = rgb_to_hsl(channel(0), channel(2), channel(4));
    if let Some(shade) = shade {
        lightness *= shade;
    }
    if let Some(tint) = tint {
        lightness = lightness * tint + (1.0 - tint);
    }
    Some(
        hsl_to_rgb(hue, saturation, lightness)
            .iter()
            .map(|channel| {
                pad_start(&to_string_radix16(math_round(channel * 255.0)), 2, '0').to_uppercase()
            })
            .collect(),
    )
}

fn rgb_to_hsl(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d == 0.0 {
        return (0.0, 0.0, l);
    }
    let s = d / (1.0 - (2.0 * l - 1.0).abs());
    let h = if max == r {
        ((g - b) / d + 6.0) % 6.0
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h / 6.0, s, l)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> [f64; 3] {
    if s == 0.0 {
        return [l, l, l];
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let channel = |t0: f64| {
        let t = ((t0 % 1.0) + 1.0) % 1.0;
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 1.0 / 2.0 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    [channel(h + 1.0 / 3.0), channel(h), channel(h - 1.0 / 3.0)]
}
