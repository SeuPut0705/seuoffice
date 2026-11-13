//! Text and unit primitives shared by the property readers
//! (packages/docx-engine/src/parse-xml-text.ts).

use std::borrow::Cow;

use jscompat::{Radix, RegexError, TryJsRegex, js_regex, parse_int, trim, truthy};
use ooxml_pkg::canonical_xml_syntax;
use ooxml_xml::XNode;

use crate::theme::{ThemeColors, resolve_theme_color};

pub const EMU_PER_PX: f64 = 9525.0;
pub const EMU_PER_PT: f64 = 12700.0;

/// Hex color value tolerance: Word and LibreOffice accept a leading `#`.
pub fn strip_hash(value: &str) -> &str {
    let trimmed = trim(value);
    trimmed.strip_prefix('#').unwrap_or(trimmed)
}

/// Word reads a fractional w:line (Google Docs exports) and truncates it; garbage stays NaN.
pub fn line_twips_of(value: Option<&str>) -> f64 {
    match value {
        Some(value) if js_regex!(r"^-?\d+(?:\.\d*)?$").test(value) => parse_int(value, Radix::Ten),
        _ => f64::NAN,
    }
}

/// w:color as a display hex; w:themeColor resolves against the live palette
/// and beats a stale w:val.
pub fn color_from(container: Option<&XNode>, theme: Option<&ThemeColors>) -> Option<String> {
    let color = container?.find_child("w:color");
    let attr = |key| color.and_then(|color| color.attr(key));
    if let (Some(theme_color), Some(theme)) = (truthy(attr("w:themeColor")), theme) {
        let resolved = resolve_theme_color(
            theme_color,
            theme,
            attr("w:themeTint"),
            attr("w:themeShade"),
        );
        if let Some(resolved) = resolved.filter(|hex| !hex.is_empty()) {
            return Some(resolved);
        }
    }
    truthy(attr("w:val"))
        .filter(|value| *value != "auto")
        .map(|value| strip_hash(value).to_owned())
}

/// Explicit `<w:color w:val="auto"/>`: it overrides an inherited style colour.
pub fn auto_color_of(container: Option<&XNode>) -> Option<&'static str> {
    let value = container?.find_child("w:color")?.attr("w:val");
    (value == Some("auto")).then_some("auto")
}

fn is_off(value: &str) -> bool {
    ["0", "false", "none", "off"].contains(&&*value.to_lowercase())
}

/// OOXML on/off toggle, three-state: absent is `None`, explicit off is `Some(false)`.
pub fn on_off_of(parent: &XNode, name: &str) -> Option<bool> {
    let child = parent.find_child(name)?;
    Some(child.attr("w:val").is_none_or(|value| !is_off(value)))
}

/// `boolProp`: absent and explicit off are both false.
pub fn bool_prop(parent: &XNode, name: &str) -> bool {
    let Some(child) = parent.find_child(name) else {
        return false;
    };
    match child.attr("w:val") {
        None => true,
        Some(val) => !is_off(val),
    }
}

/// `on_off_of` for a caller that only has the raw XML of a run's rPr. `name`
/// goes into the pattern unescaped, as in the original.
pub fn on_off_tag_in(xml: &str, name: &str) -> Result<Option<bool>, RegexError> {
    let tag_pattern = TryJsRegex::new(&format!(r"<{name}(?=[\s/>])[^>]*>"), "i")?;
    let Some(tag) = tag_pattern.try_exec(xml)? else {
        return Ok(None);
    };
    let value = js_regex!(r#"\bw:val=(?:"([^"]*)"|'([^']*)')"#, "i").exec(tag.as_str());
    let raw = value.and_then(|value| value.get(1).or(value.get(2)));
    Ok(Some(raw.is_none_or(|raw| !is_off(raw))))
}

pub fn plain_text(source: &str) -> String {
    let xml = canonical_xml_syntax(source);
    let mut texts = String::new();
    let mut any_text = false;
    // a space at cell boundaries keeps table text from gluing together
    let mut pending_gap = false;
    for found in js_regex!(r"<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<\/w:tc>").find_iter(&xml) {
        if found.as_str() == "</w:tc>" {
            pending_gap = any_text;
            continue;
        }
        if pending_gap {
            texts.push(' ');
            pending_gap = false;
        }
        texts.push_str(found.get(1).unwrap_or(""));
        any_text = true;
    }
    decode_entities(&texts)
}

/// Visible OMML leaf tokens.
pub fn math_tokens(xml: &str) -> Vec<String> {
    js_regex!(r"<m:t(?:\s[^>]*)?>([\s\S]*?)<\/m:t>")
        .find_iter(xml)
        .map(|found| decode_entities(found.get(1).unwrap_or("")))
        .collect()
}

/// Numeric character references only (`&#65;`, `&#xF0B7;`), which the ordered
/// parser leaves alone. Text read off the parse tree has had the five named
/// entities resolved already and must not be decoded for them again.
pub fn decode_numeric_char_refs(text: &str) -> Cow<'_, str> {
    if !text.contains("&#") {
        return Cow::Borrowed(text);
    }
    let decoded = js_regex!(r"&#(?:x([0-9a-f]+)|([0-9]+));", "i").replace_all(text, |entity| {
        let code_point = match (entity.get(1), entity.get(2)) {
            (Some(hex), _) if !hex.is_empty() => parse_int(hex, Radix::Sixteen),
            (_, decimal) => parse_int(decimal.unwrap_or(""), Radix::Ten),
        };
        // char::from_u32 refuses what the original refuses: surrogates and past U+10FFFF
        let scalar = (code_point.is_finite() && (0.0..=1_114_111.0).contains(&code_point))
            .then(|| char::from_u32(code_point as u32))
            .flatten();
        match scalar {
            Some(scalar) => scalar.to_string(),
            None => entity.as_str().to_owned(),
        }
    });
    Cow::Owned(decoded)
}

/// Full decode, for raw XML slices that never passed through the parser.
pub fn decode_entities(text: &str) -> String {
    decode_numeric_char_refs(text)
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}
