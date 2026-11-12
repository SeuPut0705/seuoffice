//! w:rFonts with theme references resolved.

use jscompat::truthy;
use ooxml_xml::XNode;
use serde::Serialize;

use crate::theme::ThemeFonts;

/// Word's face for an East Asian theme slot whose typeface is empty (`<a:ea typeface=""/>`).
pub const EMPTY_EA_THEME_FONT: &str = "DengXian";

/// Empty EA slot faces by settings.xml w:themeFontLang w:eastAsia: (major, minor).
fn empty_ea_slot_by_lang(lang: &str) -> Option<(&'static str, &'static str)> {
    match lang {
        "ja" => Some(("Yu Gothic", "Yu Mincho")),
        "ko" => Some(("Malgun Gothic", "Malgun Gothic")),
        _ => None,
    }
}

/// themeFontLang w:eastAsia as a theme script-table tag (`<a:font script=...>`).
fn ea_lang_script(lang: &str) -> Option<&'static str> {
    Some(match lang {
        "ko" => "Hang",
        "ja" => "Jpan",
        "zh" | "zh-cn" | "zh-sg" => "Hans",
        "zh-tw" | "zh-hk" | "zh-mo" => "Hant",
        _ => return None,
    })
}

/// themeFontLang w:bidi as a theme script-table tag.
fn bidi_lang_script(lang: &str) -> Option<&'static str> {
    Some(match lang {
        "ar" | "fa" | "ur" | "ps" | "ug" => "Arab",
        "he" | "yi" => "Hebr",
        "th" => "Thai",
        "syr" => "Syrc",
        "dv" => "Thaa",
        "hi" | "mr" | "ne" => "Deva",
        "bn" => "Beng",
        "pa" => "Guru",
        "gu" => "Gujr",
        "ta" => "Taml",
        "te" => "Telu",
        "kn" => "Knda",
        "ml" => "Mlym",
        "si" => "Sinh",
        "km" => "Khmr",
        "lo" => "Laoo",
        "bo" => "Tibt",
        "my" => "Mymr",
        "am" | "ti" => "Ethi",
        "ka" => "Geor",
        "hy" => "Armn",
        "mn" => "Mong",
        _ => return None,
    })
}

/// `text.split('-')[0]`
fn before_hyphen(text: &str) -> &str {
    text.split('-').next().unwrap_or("")
}

/// Word's face for an empty complex-script theme slot: the font group's
/// script-table entry for themeFontLang w:bidi, else Times New Roman.
fn empty_cs_slot_font(fonts: &ThemeFonts, cs_ref: &str) -> String {
    let lang = fonts.bidi_lang.as_deref().map(|lang| lang.to_lowercase());
    let script = lang
        .as_deref()
        .and_then(|lang| bidi_lang_script(before_hyphen(lang)));
    let table = if cs_ref == "majorBidi" {
        &fonts.major_scripts
    } else {
        &fonts.minor_scripts
    };
    script
        .and_then(|script| table.as_ref()?.get(script))
        .map_or_else(|| "Times New Roman".to_owned(), String::clone)
}

fn empty_ea_slot_font(fonts: &ThemeFonts, ea_ref: Option<&str>) -> String {
    theme_lang_ea_slot_font(fonts, ea_ref).unwrap_or_else(|| EMPTY_EA_THEME_FONT.to_owned())
}

/// `themeScriptEaFont`: the theme script table's face (`<a:font script=...>`)
/// of the font group for themeFontLang w:eastAsia. Word lays an EA theme slot
/// with it whenever the table names one, over the literal `<a:ea>` typeface.
pub fn theme_script_ea_font(fonts: &ThemeFonts, ea_ref: Option<&str>) -> Option<String> {
    let full = truthy(fonts.ea_lang.as_deref())?.to_lowercase();
    let major = match ea_ref {
        Some("majorEastAsia") => true,
        Some("minorEastAsia") => false,
        _ => return None,
    };
    let script = ea_lang_script(&full).or_else(|| ea_lang_script(before_hyphen(&full)))?;
    let table = if major {
        &fonts.major_scripts
    } else {
        &fonts.minor_scripts
    };
    table
        .as_ref()?
        .get(script)
        .filter(|face| !face.is_empty())
        .cloned()
}

/// The empty-EA-slot face themeFontLang specifically resolves (theme script
/// table first, then the probed per-language defaults); `None` when only the
/// generic DengXian applies.
pub fn theme_lang_ea_slot_font(fonts: &ThemeFonts, ea_ref: Option<&str>) -> Option<String> {
    if let Some(face) = theme_script_ea_font(fonts, ea_ref) {
        return Some(face);
    }
    let full = truthy(fonts.ea_lang.as_deref())?.to_lowercase();
    let (major_face, minor_face) = empty_ea_slot_by_lang(before_hyphen(&full))?;
    Some(
        if ea_ref == Some("majorEastAsia") {
            major_face
        } else {
            minor_face
        }
        .to_owned(),
    )
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemedRFonts {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ascii: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub h_ansi: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub east_asia: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cs: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ea_slot_empty: bool,
    pub themed: Themed,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Themed {
    pub ascii: bool,
    pub h_ansi: bool,
    pub east_asia: bool,
}

/// w:rFonts with theme references resolved: a theme attribute supersedes the
/// literal of the same slot. An unresolvable reference falls back to the
/// literal, except an empty East Asian or complex-script theme slot, where
/// Word keeps the theme's authority and renders the language default face.
///
/// `r_fonts` is the w:rFonts element, or an empty node where there is none.
pub fn themed_r_fonts(r_fonts: &XNode, fonts: Option<&ThemeFonts>) -> ThemedRFonts {
    let literal = |key| r_fonts.attr(key).map(str::to_owned);
    let theme_val = |theme_ref: Option<&str>| -> Option<String> {
        let fonts = fonts?;
        let face = match truthy(theme_ref)? {
            "majorAscii" | "majorHAnsi" => Some(&fonts.major),
            "minorAscii" | "minorHAnsi" => Some(&fonts.minor),
            "majorEastAsia" => fonts.major_east_asia.as_ref(),
            "minorEastAsia" => fonts.east_asia.as_ref(),
            "majorBidi" => fonts.major_cs.as_ref(),
            "minorBidi" => fonts.minor_cs.as_ref(),
            _ => None,
        };
        face.filter(|face| !face.is_empty()).cloned()
    };
    let ea_ref = r_fonts.attr("w:eastAsiaTheme");
    let literal_ea = theme_val(ea_ref);
    let ea_slot_empty = literal_ea.is_none()
        && fonts.is_some()
        && matches!(ea_ref, Some("majorEastAsia" | "minorEastAsia"));
    // a filled EA slot still yields to the script table's themeFontLang face
    let themed_ea = match (literal_ea, fonts) {
        (Some(literal), Some(fonts)) => {
            Some(theme_script_ea_font(fonts, ea_ref).unwrap_or(literal))
        }
        (literal, _) => literal,
    };
    let themed_or_empty_slot = |theme_ref: Option<&str>| -> Option<String> {
        let themed = theme_val(theme_ref);
        let Some(fonts) = fonts else {
            return themed;
        };
        if let Some(themed) = themed {
            return Some(theme_script_ea_font(fonts, theme_ref).unwrap_or(themed));
        }
        match theme_ref {
            Some(cs_ref @ ("majorBidi" | "minorBidi")) => Some(empty_cs_slot_font(fonts, cs_ref)),
            Some("majorEastAsia" | "minorEastAsia") => Some(empty_ea_slot_font(fonts, theme_ref)),
            _ => None,
        }
    };
    let themed_ascii = themed_or_empty_slot(r_fonts.attr("w:asciiTheme"));
    let themed_h_ansi = themed_or_empty_slot(r_fonts.attr("w:hAnsiTheme"));
    let empty_ea_face = || {
        fonts
            .filter(|_| ea_slot_empty)
            .map(|fonts| empty_ea_slot_font(fonts, ea_ref))
    };
    ThemedRFonts {
        themed: Themed {
            ascii: themed_ascii.is_some(),
            h_ansi: themed_h_ansi.is_some(),
            east_asia: themed_ea.is_some() || ea_slot_empty,
        },
        ascii: themed_ascii.or_else(|| literal("w:ascii")),
        h_ansi: themed_h_ansi.or_else(|| literal("w:hAnsi")),
        east_asia: themed_ea.or_else(empty_ea_face).or_else(|| {
            if ea_slot_empty {
                None
            } else {
                literal("w:eastAsia")
            }
        }),
        cs: themed_or_empty_slot(r_fonts.attr("w:cstheme")).or_else(|| literal("w:cs")),
        ea_slot_empty,
    }
}

/// Word's substitution face when the East Asian font slot is empty, by w:lang
/// w:eastAsia (`EA_LANG_DEFAULT_FONT[lang]`).
pub fn ea_lang_default_font(lang: &str) -> Option<&'static str> {
    Some(match lang {
        "ko" | "ko-kr" => "Malgun Gothic",
        "ja" | "ja-jp" => "MS Mincho",
        "zh-cn" => "SimSun",
        "zh-tw" | "zh-hk" => "PMingLiU",
        _ => return None,
    })
}
