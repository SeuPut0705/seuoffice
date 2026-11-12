//! `assemble/export/theme.ts`: when a docx to ODT conversion reports `theme`.
//!
//! The docx engine resolves theme fonts (`w:asciiTheme` ..., including empty
//! East Asian and complex-script slots) and theme colours (`w:themeColor`,
//! `w:themeFill`, with tint and shade) against the document's theme while it
//! parses, and the editor shows those values. The ODT stores the same resolved
//! values, so it looks the same and only the link to the theme goes; that is
//! not reported. A document that merely ships a theme part is not reported.
//!
//! What is reported is a theme reference in the exported content (body,
//! headers and footers, and the styles and document defaults they use) that
//! the theme cannot answer: the theme part is missing or unreadable for a font
//! reference, the referenced Latin slot is empty, or a colour names a slot the
//! theme does not hold. The engine then falls back to the literal value Word
//! cached next to the reference, and the ODT keeps that fallback, which Word
//! would have replaced with the theme's value. One per such reference.

use docx_engine::model::{ParsedDoc, StyleInfo, ThemeColors, ThemeFonts};
use jscompat::{JsMap, js_regex};

/// The keys of `ThemeColors` that `COLOR_SLOTS` names.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ColorSlot {
    Dk1,
    Lt1,
    Dk2,
    Lt2,
    Accent1,
    Accent2,
    Accent3,
    Accent4,
    Accent5,
    Accent6,
    Hlink,
    FolHlink,
}

/// `COLOR_SLOTS`: `w:themeColor` value to colour scheme slot (Word's default
/// mapping). Only its own keys answer, as `ownValue` does.
fn color_slot(name: &str) -> Option<ColorSlot> {
    Some(match name {
        "dark1" | "text1" => ColorSlot::Dk1,
        "light1" | "background1" => ColorSlot::Lt1,
        "dark2" | "text2" => ColorSlot::Dk2,
        "light2" | "background2" => ColorSlot::Lt2,
        "accent1" => ColorSlot::Accent1,
        "accent2" => ColorSlot::Accent2,
        "accent3" => ColorSlot::Accent3,
        "accent4" => ColorSlot::Accent4,
        "accent5" => ColorSlot::Accent5,
        "accent6" => ColorSlot::Accent6,
        "hyperlink" => ColorSlot::Hlink,
        "followedHyperlink" => ColorSlot::FolHlink,
        _ => return None,
    })
}

/// `COLOR_FALLBACK`: slots the engine answers without a theme value.
fn color_fallback(slot: ColorSlot) -> bool {
    matches!(slot, ColorSlot::Dk1 | ColorSlot::Lt1)
}

/// `colors?.[slot]`
fn slot_value(colors: &ThemeColors, slot: ColorSlot) -> Option<&str> {
    match slot {
        ColorSlot::Dk1 => colors.dk1.as_deref(),
        ColorSlot::Lt1 => colors.lt1.as_deref(),
        ColorSlot::Dk2 => colors.dk2.as_deref(),
        ColorSlot::Lt2 => colors.lt2.as_deref(),
        ColorSlot::Accent1 => colors.accent1.as_deref(),
        ColorSlot::Accent2 => colors.accent2.as_deref(),
        ColorSlot::Accent3 => colors.accent3.as_deref(),
        ColorSlot::Accent4 => colors.accent4.as_deref(),
        ColorSlot::Accent5 => colors.accent5.as_deref(),
        ColorSlot::Accent6 => colors.accent6.as_deref(),
        ColorSlot::Hlink => colors.hlink.as_deref(),
        ColorSlot::FolHlink => colors.fol_hlink.as_deref(),
    }
}

/// `ThemeSources`: the XML a conversion takes formatting from.
pub struct ThemeSources<'a> {
    pub document_xml: &'a str,
    pub styles_xml: &'a str,
    /// header and footer parts
    pub parts: Vec<&'a str>,
}

/// `parsed.styles.get(id)`
pub(crate) fn style_of<'a>(parsed: &'a ParsedDoc, id: &str) -> Option<&'a StyleInfo> {
    parsed
        .styles
        .0
        .iter()
        .find(|(key, _)| key == id)
        .map(|(_, style)| style)
}

/// `unresolvedThemeReferences`: theme references the ODT cannot carry as Word
/// would show them.
pub fn unresolved_theme_references(parsed: &ParsedDoc, sources: &ThemeSources<'_>) -> usize {
    let mut content: Vec<&str> = vec![sources.document_xml];
    content.extend(sources.parts.iter().copied());
    let used = used_styles(parsed, &content);
    let mut scanned: Vec<&str> = content.clone();
    for m in js_regex!(r"<w:style\b[^>]*>[\s\S]*?<\/w:style>", "g").find_iter(sources.styles_xml) {
        let id = js_regex!(r#"\bw:styleId="([^"]*)""#)
            .exec(m.as_str())
            .and_then(|found| found.get(1));
        if id.is_some_and(|id| !id.is_empty() && used.has(id)) {
            scanned.push(m.as_str());
        }
    }
    let defaults = js_regex!(r"<w:docDefaults\b[\s\S]*?<\/w:docDefaults>").exec(sources.styles_xml);
    if let Some(defaults) = defaults {
        scanned.push(defaults.as_str());
    }

    let theme_fonts = parsed.theme_fonts.as_ref().and_then(|fonts| fonts.as_ref());
    let theme_colors = parsed
        .theme_colors
        .as_ref()
        .and_then(|colors| colors.as_ref());
    let mut count = 0;
    for xml in scanned {
        for m in js_regex!(
            r#"\bw:(?:asciiTheme|hAnsiTheme|eastAsiaTheme|cstheme)="([^"]*)""#,
            "g"
        )
        .find_iter(xml)
        {
            if !font_resolves(m.get(1).unwrap_or(""), theme_fonts) {
                count += 1;
            }
        }
        for m in js_regex!(r#"\bw:theme(?:Color|Fill)="([^"]*)""#, "g").find_iter(xml) {
            if !color_resolves(m.get(1).unwrap_or(""), theme_colors) {
                count += 1;
            }
        }
    }
    count
}

/// `fontResolves`
fn font_resolves(reference: &str, fonts: Option<&ThemeFonts>) -> bool {
    let Some(fonts) = fonts else {
        return false;
    };
    match reference {
        "majorHAnsi" | "majorAscii" => !fonts.major.is_empty(),
        "minorHAnsi" | "minorAscii" => !fonts.minor.is_empty(),
        // empty East Asian and complex-script slots resolve to the language's face
        "majorEastAsia" | "minorEastAsia" | "majorBidi" | "minorBidi" => true,
        _ => false,
    }
}

/// `colorResolves`
fn color_resolves(name: &str, colors: Option<&ThemeColors>) -> bool {
    let Some(slot) = color_slot(name) else {
        return false;
    };
    if color_fallback(slot) {
        return true;
    }
    let value = colors.and_then(|colors| slot_value(colors, slot));
    value.is_some_and(|value| js_regex!(r"^[0-9A-Fa-f]{6}$").test(value))
}

/// `usedStyles`: styles the content uses, their parents, and the defaults
/// Word applies.
fn used_styles(parsed: &ParsedDoc, content: &[&str]) -> JsMap<()> {
    let mut used: JsMap<()> = JsMap::new();
    for xml in content {
        for m in js_regex!(r#"<w:(?:pStyle|rStyle|tblStyle)\s+w:val="([^"]*)""#, "g").find_iter(xml)
        {
            used.set(m.get(1).unwrap_or(""), ());
        }
    }
    for (_, s) in &parsed.styles.0 {
        if s.is_default == Some(true) {
            used.set(s.style_id.as_str(), ());
        }
    }
    let ids: Vec<String> = used.keys().map(str::to_owned).collect();
    for id in ids {
        let mut next = style_of(parsed, &id).and_then(|s| s.based_on.clone());
        let mut guard = 0;
        while guard < 20 {
            let Some(name) = next.filter(|name| !name.is_empty()) else {
                break;
            };
            used.set(name.as_str(), ());
            next = style_of(parsed, &name).and_then(|s| s.based_on.clone());
            guard += 1;
        }
    }
    used
}
