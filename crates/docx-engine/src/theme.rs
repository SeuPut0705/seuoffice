//! The theme part (packages/docx-engine/src/theme.ts, the reading half, and
//! `parseTheme` of parse.ts): the font pair, the palette, and the resolution
//! of a w:themeColor reference.

use jscompat::{
    JsObject, JsRegex, Radix, RegexLimit, TryJsRegex, js_regex, math_round, pad_start, parse_int,
    to_string_radix16, trim, truthy,
};
use ooxml_pkg::Package;
use serde::{Deserialize, Serialize};

use crate::package::{Thrown, part_text};

pub const THEME_PART_PATH: &str = "word/theme/theme1.xml";

/// The a:clrScheme slots, as `readThemeColors` fills them.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColors {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dk1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lt1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dk2: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lt2: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent2: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent3: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent4: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent5: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent6: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hlink: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fol_hlink: Option<String>,
}

impl ThemeColors {
    /// The built-in Office palette: what Word resolves theme colours against
    /// when a document ships no theme part.
    pub fn office() -> Self {
        let hex = |value: &str| Some(value.to_owned());
        Self {
            name: None,
            dk1: hex("000000"),
            lt1: hex("FFFFFF"),
            dk2: hex("44546A"),
            lt2: hex("E7E6E6"),
            accent1: hex("4472C4"),
            accent2: hex("ED7D31"),
            accent3: hex("A5A5A5"),
            accent4: hex("FFC000"),
            accent5: hex("5B9BD5"),
            accent6: hex("70AD47"),
            hlink: hex("0563C1"),
            fol_hlink: hex("954F72"),
        }
    }

    fn slot_mut(&mut self, tag: &str) -> &mut Option<String> {
        match tag {
            "dk1" => &mut self.dk1,
            "lt1" => &mut self.lt1,
            "dk2" => &mut self.dk2,
            "lt2" => &mut self.lt2,
            "accent1" => &mut self.accent1,
            "accent2" => &mut self.accent2,
            "accent3" => &mut self.accent3,
            "accent4" => &mut self.accent4,
            "accent5" => &mut self.accent5,
            "accent6" => &mut self.accent6,
            "hlink" => &mut self.hlink,
            _ => &mut self.fol_hlink,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeFonts {
    /// `''` where a caller's object leaves it out, as a TypeScript reader of
    /// the East Asian slots never looks at it (the parse always writes it)
    #[serde(default)]
    pub major: String,
    #[serde(default)]
    pub minor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub east_asia: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub major_east_asia: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minor_cs: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub major_cs: Option<String>,
    /// Per-script faces (`<a:font script="Hang" typeface="..."/>`) of each font group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub major_scripts: Option<JsObject<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minor_scripts: Option<JsObject<String>>,
    /// settings.xml w:themeFontLang w:eastAsia
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ea_lang: Option<String>,
    /// settings.xml w:themeFontLang w:bidi
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bidi_lang: Option<String>,
}

/// The first `<tag ...>...</tag>` of the part, for the three sections read
/// here; `None` for any other tag.
fn section_of<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let pattern = match tag {
        "a:clrScheme" => js_regex!(r"<a:clrScheme(?:\s[^>]*)?>[\s\S]*?</a:clrScheme>"),
        "a:majorFont" => js_regex!(r"<a:majorFont(?:\s[^>]*)?>[\s\S]*?</a:majorFont>"),
        "a:minorFont" => js_regex!(r"<a:minorFont(?:\s[^>]*)?>[\s\S]*?</a:minorFont>"),
        _ => return None,
    };
    pattern.exec(xml).map(|found| found.as_str())
}

fn font_of(xml: &str, tag: &str) -> Option<String> {
    let section = section_of(xml, tag)?;
    js_regex!(r#"<a:latin typeface="([^"]*)""#)
        .exec(section)
        .and_then(|found| found.get(1))
        .map(str::to_owned)
}

/// Per-script faces of a font group.
fn script_fonts_of(xml: &str, tag: &str) -> Option<JsObject<String>> {
    let section = section_of(xml, tag)?;
    let out: JsObject<String> = js_regex!(r#"<a:font script="([^"]+)" typeface="([^"]+)""#)
        .find_iter(section)
        .map(|found| {
            (
                found.get(1).unwrap_or("").to_owned(),
                found.get(2).unwrap_or("").to_owned(),
            )
        })
        .collect();
    (!out.is_empty()).then_some(out)
}

/// The latin, East Asian and complex-script typefaces of the major and minor
/// font groups of theme1.xml.
pub fn read_theme_fonts(theme_xml: &str) -> Option<ThemeFonts> {
    let major = font_of(theme_xml, "a:majorFont");
    let minor = font_of(theme_xml, "a:minorFont");
    if truthy(major.as_deref()).is_none() && truthy(minor.as_deref()).is_none() {
        return None;
    }
    let slot = |tag: &str, kind: &JsRegex| -> Option<String> {
        let face = kind.exec(section_of(theme_xml, tag)?)?.get(1)?;
        (!face.is_empty()).then(|| face.to_owned())
    };
    let ea = js_regex!(r#"<a:ea typeface="([^"]*)""#);
    let cs = js_regex!(r#"<a:cs typeface="([^"]*)""#);
    Some(ThemeFonts {
        major: major.unwrap_or_default(),
        minor: minor.unwrap_or_default(),
        east_asia: slot("a:minorFont", ea),
        major_east_asia: slot("a:majorFont", ea),
        minor_cs: slot("a:minorFont", cs),
        major_cs: slot("a:majorFont", cs),
        ea_lang: None,
        bidi_lang: None,
        major_scripts: script_fonts_of(theme_xml, "a:majorFont"),
        minor_scripts: script_fonts_of(theme_xml, "a:minorFont"),
    })
}

/// Every a:clrScheme slot; dk1 and lt1 may be system colours.
const READ_TAGS: [&str; 12] = [
    "dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
    "hlink", "folHlink",
];

pub fn read_theme_colors(theme_xml: &str) -> Result<Option<ThemeColors>, RegexLimit> {
    let Some(scheme) = section_of(theme_xml, "a:clrScheme") else {
        return Ok(None);
    };
    let mut out = ThemeColors {
        name: js_regex!(r#"<a:clrScheme name="([^"]*)""#)
            .exec(theme_xml)
            .and_then(|found| truthy(found.get(1)))
            .map(str::to_owned),
        ..ThemeColors::default()
    };
    for tag in READ_TAGS {
        let Ok(slot) = TryJsRegex::new(
            &format!(r#"<a:{tag}>\s*<a:(?:srgbClr val|sysClr[^>]*? lastClr)="([0-9A-Fa-f]{{6}})""#),
            "",
        ) else {
            return Ok(None);
        };
        if let Some(hex) = slot.try_exec(scheme)?.and_then(|found| found.get(1)) {
            *out.slot_mut(tag) = Some(hex.to_uppercase());
        }
    }
    Ok((out != ThemeColors::default()).then_some(out))
}

/// What the rest of the parser resolves theme references against.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Theme {
    pub fonts: Option<ThemeFonts>,
    pub colors: Option<ThemeColors>,
}

/// `parseTheme` of parse.ts. A package without a theme part still resolves
/// colour references, against the built-in Office palette.
pub fn parse_theme(package: &Package) -> Result<Theme, Thrown> {
    let Some(xml) = part_text(package, THEME_PART_PATH)? else {
        return Ok(Theme {
            fonts: None,
            colors: Some(ThemeColors::office()),
        });
    };
    let mut fonts = read_theme_fonts(xml);
    if let Some(fonts) = &mut fonts {
        // settings.xml w:themeFontLang picks Word's face for an empty slot
        let tag = part_text(package, "word/settings.xml")?
            .and_then(|settings| js_regex!(r"<w:themeFontLang\b[^>]*>").exec(settings));
        if let Some(tag) = tag {
            let attr = |pattern: &JsRegex| {
                pattern
                    .exec(tag.as_str())
                    .and_then(|found| found.get(1))
                    .map(str::to_owned)
            };
            if let Some(ea_lang) = attr(js_regex!(r#"\bw:eastAsia="([^"]+)""#)) {
                fonts.ea_lang = Some(ea_lang);
            }
            if let Some(bidi_lang) = attr(js_regex!(r#"\bw:bidi="([^"]+)""#)) {
                fonts.bidi_lang = Some(bidi_lang);
            }
        }
    }
    Ok(Theme {
        fonts,
        colors: read_theme_colors(xml).map_err(|limit| limit.to_string())?,
    })
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
