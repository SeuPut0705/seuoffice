//! Theme application (packages/pptx-engine/src/theme-apply.ts): rewrites the
//! <a:clrScheme> and <a:fontScheme> of every ppt/theme/theme*.xml in place,
//! and remaps the deck's explicit srgbClr colors onto the new palette.

use jscompat::{
    JsMap, JsNum, JsObject, JsRegex, Radix, js_regex, math_max, math_min, math_round, pad_start,
    parse_int, replace_first_with, slice_utf16, sort_by_number, string_less_than,
    to_string_radix16, truthy,
};
use serde::Deserialize;

use crate::xml_utils::escape_xml_attr;
use crate::zip::PackageArchive;

/// One theme definition: 12 scheme colors + optional heading/body fonts.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSpec {
    pub name: String,
    /// dk1/lt1/dk2/lt2/accent1..6/hlink/folHlink to #RRGGBB; `None` is `null`.
    pub colors: JsObject<Option<String>>,
    pub major_font: Option<String>,
    pub minor_font: Option<String>,
}

impl ThemeSpec {
    /// `spec.colors[key]`: `None` for a key that is absent or `null`.
    fn color(&self, key: &str) -> Option<&str> {
        self.colors.get(key).and_then(Option::as_deref)
    }
}

/// `new RegExp(`<a:${key}>[\\s\\S]*?</a:${key}>`)` per scheme key.
fn scheme_slots() -> [(&'static str, &'static JsRegex); 12] {
    macro_rules! slot {
        ($key:literal) => {
            (
                $key,
                js_regex!(concat!("<a:", $key, r">[\s\S]*?</a:", $key, ">")),
            )
        };
    }
    [
        slot!("dk1"),
        slot!("lt1"),
        slot!("dk2"),
        slot!("lt2"),
        slot!("accent1"),
        slot!("accent2"),
        slot!("accent3"),
        slot!("accent4"),
        slot!("accent5"),
        slot!("accent6"),
        slot!("hlink"),
        slot!("folHlink"),
    ]
}

fn hex6(c: &str) -> String {
    slice_utf16(c.strip_prefix('#').unwrap_or(c), 0.0, Some(6.0)).to_uppercase()
}

/// `text` with `value` between the two groups of the first match of
/// `pattern`, the rest of the match dropped.
fn between_groups(pattern: &JsRegex, text: &str, value: &str) -> String {
    let Some(found) = pattern.exec(text) else {
        return text.to_owned();
    };
    format!(
        "{}{}{value}{}{}",
        &text[..found.start()],
        found.get(1).unwrap_or(""),
        found.get(2).unwrap_or(""),
        &text[found.end()..],
    )
}

/// Rewrite a theme XML's clrScheme/fontScheme; returned as-is if the scheme
/// structure is missing.
pub fn patch_theme_xml(xml: &str, spec: &ThemeSpec) -> String {
    let mut out = xml.to_owned();
    // Colors: replace the whole <a:dk1>...</a:dk1> section per key (sysClr/srgbClr both become srgbClr)
    for (key, slot) in scheme_slots() {
        let Some(color) = truthy(spec.color(key)) else {
            continue;
        };
        // ledger theme-color-dollar: the TypeScript passes the section as a
        // replacement string, so a `$&`, `$$`, `$'` or `` $` `` in a color that is
        // not a color expands into markup; written as given here.
        out = replace_first_with(slot, &out, |_| {
            format!(r#"<a:{key}><a:srgbClr val="{}"/></a:{key}>"#, hex6(color))
        });
    }
    // ledger theme-name-dollar: the TypeScript writes `$1${name}$2` as a
    // replacement string, so a `$&`, `$1`, `$'` or `` $` `` in the theme name or
    // a font name expands into markup inside the attribute; written as given here.
    out = between_groups(
        js_regex!(r#"(<a:clrScheme name=")[^"]*(")"#),
        &out,
        &escape_xml_attr(&spec.name),
    );
    // Fonts: replace only the major/minor Latin typeface; East Asian / cs kept
    if let Some(font) = truthy(spec.major_font.as_deref()) {
        out = between_groups(
            js_regex!(r#"(<a:majorFont>[\s\S]*?<a:latin[^>]*typeface=")[^"]*(")"#),
            &out,
            &escape_xml_attr(font),
        );
    }
    if let Some(font) = truthy(spec.minor_font.as_deref()) {
        out = between_groups(
            js_regex!(r#"(<a:minorFont>[\s\S]*?<a:latin[^>]*typeface=")[^"]*(")"#),
            &out,
            &escape_xml_attr(font),
        );
    }
    out
}

/// Apply the theme to all theme parts in the package; returns the number
/// rewritten. `archive` is `opened.archive`.
pub fn apply_theme_to_archive(archive: &mut PackageArchive, spec: &ThemeSpec) -> usize {
    let mut patched = 0;
    let paths: Vec<String> = archive.entries().keys().map(str::to_owned).collect();
    for path in paths {
        if !js_regex!(r"^ppt\/theme\/theme\d+\.xml$").test(&path) {
            continue;
        }
        let Some(xml) = archive.read_text(&path).map(|xml| xml.into_owned()) else {
            continue;
        };
        if xml.is_empty() {
            continue;
        }
        let next = patch_theme_xml(&xml, spec);
        if next != xml {
            archive.entries_mut().set(path, next.into_bytes());
            patched += 1;
        }
    }
    patched
}

// Explicit color remapping: neutrals map onto the new theme's dk1/lt1 axis,
// bucketed by lightness; chromatic colors are clustered by hue and the
// clusters assigned to accent1..6 by frequency; the original lightness stays.

#[derive(Debug, Clone, Copy)]
struct Hsl {
    /// 0..360
    h: f64,
    /// 0..1
    s: f64,
    /// 0..1
    l: f64,
}

fn hex_to_hsl(hex: &str) -> Hsl {
    let h6 = hex.strip_prefix('#').unwrap_or(hex);
    let channel = |start: f64| {
        let v = parse_int(&slice_utf16(h6, start, Some(start + 2.0)), Radix::Sixteen);
        // `|| 0`: NaN and -0 read as 0
        (if v == 0.0 || v.is_nan() { 0.0 } else { v }) / 255.0
    };
    let r = channel(0.0);
    let g = channel(2.0);
    let b = channel(4.0);
    let max = math_max(math_max(r, g), b);
    let min = math_min(math_min(r, g), b);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d == 0.0 {
        return Hsl { h: 0.0, s: 0.0, l };
    }
    let s = d / (1.0 - (2.0 * l - 1.0).abs());
    let mut h = if max == r {
        60.0 * (((g - b) / d) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    if h < 0.0 {
        h += 360.0;
    }
    Hsl {
        h,
        s: math_min(1.0, s),
        l,
    }
}

fn hsl_to_hex(Hsl { h, s, l }: Hsl) -> String {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = if h < 60.0 {
        (c, x, 0.0)
    } else if h < 120.0 {
        (x, c, 0.0)
    } else if h < 180.0 {
        (0.0, c, x)
    } else if h < 240.0 {
        (0.0, x, c)
    } else if h < 300.0 {
        (x, 0.0, c)
    } else {
        (c, 0.0, x)
    };
    let to255 = |v: f64| math_max(0.0, math_min(255.0, math_round((v + m) * 255.0)));
    [r, g, b]
        .into_iter()
        .map(|v| pad_start(&to_string_radix16(to255(v)), 2, '0'))
        .collect::<String>()
        .to_uppercase()
}

fn hue_dist(a: f64, b: f64) -> f64 {
    let d = (a - b).abs() % 360.0;
    if d > 180.0 { 360.0 - d } else { d }
}

/// Low saturation / near black-white counts as neutral (mapped along the dk1/lt1 axis)
fn is_neutral(Hsl { s, l, .. }: Hsl) -> bool {
    s < 0.15 || l > 0.95 || l < 0.07
}

fn srgb_re() -> &'static JsRegex {
    js_regex!(r#"<a:srgbClr val="([0-9A-Fa-f]{6})""#)
}

/// Count explicit srgbClr colors in a batch of slide XML (uppercase hex to
/// occurrence count).
pub fn collect_explicit_colors(xmls: &[impl AsRef<str>]) -> JsMap<JsNum> {
    let mut counts: JsMap<JsNum> = JsMap::new();
    for xml in xmls {
        for found in srgb_re().find_iter(xml.as_ref()) {
            let hex = found.get(1).unwrap_or("").to_uppercase();
            let count = counts.get(&hex).map_or(0.0, |count| count.0) + 1.0;
            counts.set(hex, JsNum(count));
        }
    }
    counts
}

/// Mapping table from explicit colors to new theme colors. Identity mappings
/// are omitted. Clusters are assigned by (occurrence count desc, hex asc).
pub fn build_color_map(counts: &JsMap<JsNum>, spec: &ThemeSpec) -> JsMap<String> {
    let neutral_for = |l: f64| {
        let key = if l > 0.85 {
            "lt1"
        } else if l > 0.55 {
            "lt2"
        } else if l > 0.28 {
            "dk2"
        } else {
            "dk1"
        };
        hex6(
            spec.color(key)
                .unwrap_or(if l > 0.5 { "FFFFFF" } else { "000000" }),
        )
    };
    let accents: Vec<Hsl> = [
        "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
    ]
    .into_iter()
    .filter_map(|key| truthy(spec.color(key)))
    .map(hex_to_hsl)
    .collect();

    let mut sorted: Vec<(&str, f64)> = counts.iter().map(|(hex, count)| (hex, count.0)).collect();
    sort_by_number(&mut sorted, |a, b| {
        let d = b.1 - a.1;
        if d != 0.0 && !d.is_nan() {
            d
        } else if string_less_than(a.0, b.0) {
            -1.0
        } else {
            1.0
        }
    });
    let mut clusters: Vec<f64> = Vec::new();
    let mut map = JsMap::new();
    for (hex, _) in sorted {
        let hsl = hex_to_hsl(hex);
        let out = if is_neutral(hsl) {
            neutral_for(hsl.l)
        } else {
            if accents.is_empty() {
                continue;
            }
            let idx = match clusters
                .iter()
                .position(|hue| hue_dist(*hue, hsl.h) <= 35.0)
            {
                Some(idx) => idx,
                None => {
                    clusters.push(hsl.h);
                    clusters.len() - 1
                }
            };
            let Some(target) = accents.get(idx % accents.len()) else {
                continue;
            };
            // Target hue + target base saturation, keeping original lightness
            hsl_to_hex(Hsl {
                h: target.h,
                s: target.s,
                l: hsl.l,
            })
        };
        if out != hex {
            map.set(hex, out);
        }
    }
    map
}

/// Recolor a slide XML per the mapping table (only <a:srgbClr val> touched).
pub fn recolor_xml(xml: &str, map: &JsMap<String>) -> String {
    if map.is_empty() {
        return xml.to_owned();
    }
    srgb_re().replace_all(xml, |found| {
        let full = found.as_str();
        let hex = found.get(1).unwrap_or("");
        match truthy(map.get(&hex.to_uppercase()).map(String::as_str)) {
            // ledger recolor-map-dollar: the TypeScript's `full.replace(hex, to)`
            // reads `$` patterns in the color the map gives; written as given here.
            Some(to) => full.replacen(hex, to, 1),
            None => full.to_owned(),
        }
    })
}

/// What `remapDeckColors` reads of a slide; the model port replaces it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Slide {
    pub path: String,
}

/// What `remapDeckColors` reads of `opened.deck`; the model port replaces it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Deck {
    pub slides: Vec<Slide>,
}

/// Remap all slides' explicit colors onto the theme palette, rewriting the
/// archive entries. Returns the number of distinct colors mapped.
pub fn remap_deck_colors(archive: &mut PackageArchive, deck: &Deck, spec: &ThemeSpec) -> usize {
    let xmls: Vec<String> = deck
        .slides
        .iter()
        .filter_map(|slide| archive.read_text(&slide.path))
        .filter(|xml| !xml.is_empty())
        .map(|xml| xml.into_owned())
        .collect();
    let map = build_color_map(&collect_explicit_colors(&xmls), spec);
    if map.is_empty() {
        return 0;
    }
    for slide in &deck.slides {
        let Some(xml) = archive.read_text(&slide.path).map(|xml| xml.into_owned()) else {
            continue;
        };
        if xml.is_empty() {
            continue;
        }
        let next = recolor_xml(&xml, &map);
        if next != xml {
            archive
                .entries_mut()
                .set(slide.path.clone(), next.into_bytes());
        }
    }
    map.len()
}
