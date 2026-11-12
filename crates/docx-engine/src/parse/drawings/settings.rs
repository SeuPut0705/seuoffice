//! The readers of word/settings.xml parse.ts runs before the body, and the
//! bibliography sources.

use jscompat::{JsNum, Radix, js_regex, parse_int};
use ooxml_pkg::Package;
use serde::Serialize;

use crate::model::{NoteProps, NotePropsNumRestart, NotePropsPos};
use crate::package::{Thrown, part_text};
use crate::section::{self, NotePrTag, note_props_from_xml, xml_flag_on};
use crate::sources::{SourceInfo, find_sources_part, parse_sources_xml};

const SETTINGS_PATH: &str = "word/settings.xml";

/// `parseCompatibilityMode`: the compatSetting compatibilityMode of
/// settings.xml, 0 when absent (legacy layout).
pub fn parse_compatibility_mode(zip: &Package) -> Result<f64, Thrown> {
    let Some(xml) = part_text(zip, SETTINGS_PATH)? else {
        return Ok(0.0);
    };
    // attribute order is generator-specific (w:val may precede w:name)
    for tag in js_regex!(r"<w:compatSetting\b[^>]*>").find_iter(xml) {
        let tag = tag.as_str();
        if !js_regex!(r#"\sw:name="compatibilityMode""#).test(tag) {
            continue;
        }
        if let Some(val) = js_regex!(r#"\sw:val="(\d+)""#)
            .exec(tag)
            .and_then(|found| found.get(1))
        {
            return Ok(parse_int(val, Radix::Ten));
        }
    }
    Ok(0.0)
}

/// What `parseLayoutSettings` returns.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_hyphenation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_tab_stop_twips: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance_dbcs_spacing: Option<bool>,
    #[serde(rename = "useFELayout", skip_serializing_if = "Option::is_none")]
    pub use_fe_layout: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compress_punctuation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adjust_line_height_in_table: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_not_numbering_tab_stop: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub do_not_expand_shift_return: Option<bool>,
    #[serde(
        rename = "doNotUseHTMLParagraphAutoSpacing",
        skip_serializing_if = "Option::is_none"
    )]
    pub do_not_use_html_paragraph_auto_spacing: Option<bool>,
}

/// `xmlFlagOn` over a tag literal, whose pattern always compiles.
pub fn flag(xml: &str, tag: &str) -> Result<Option<bool>, Thrown> {
    let on = xml_flag_on(xml, tag).map_err(|error| error.to_string())?;
    Ok(on.then_some(true))
}

/// `parseLayoutSettings`: w:autoHyphenation, w:defaultTabStop (absent is
/// Word's 720 twips) and the compatibility flags of settings.xml the layout
/// reads.
pub fn parse_layout_settings(zip: &Package) -> Result<LayoutSettings, Thrown> {
    let Some(xml) = part_text(zip, SETTINGS_PATH)? else {
        return Ok(LayoutSettings::default());
    };
    let tab = js_regex!(r#"<w:defaultTabStop[^>]*w:val="(-?\d+)""#)
        .exec(xml)
        .and_then(|found| found.get(1));
    let csc = js_regex!(r#"<w:characterSpacingControl[^>]*w:val="(\w+)""#)
        .exec(xml)
        .and_then(|found| found.get(1));
    Ok(LayoutSettings {
        auto_hyphenation: flag(xml, "w:autoHyphenation")?,
        default_tab_stop_twips: tab.map(|tab| JsNum(parse_int(tab, Radix::Ten))),
        balance_dbcs_spacing: flag(xml, "w:balanceSingleByteDoubleByteWidth")?,
        use_fe_layout: flag(xml, "w:useFELayout")?,
        compress_punctuation: csc
            .is_some_and(|csc| csc.starts_with("compressPunctuation"))
            .then_some(true),
        adjust_line_height_in_table: flag(xml, "w:adjustLineHeightInTable")?,
        indent_not_numbering_tab_stop: flag(xml, "w:doNotUseIndentAsNumberingTabStop")?,
        do_not_expand_shift_return: flag(xml, "w:doNotExpandShiftReturn")?,
        do_not_use_html_paragraph_auto_spacing: flag(xml, "w:doNotUseHTMLParagraphAutoSpacing")?,
    })
}

/// What `parseNoteProps` returns.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocNoteProps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footnote_props: Option<NoteProps>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endnote_props: Option<NoteProps>,
}

/// The model's `NoteProps` of what `notePropsFromXml` read, its keys set in
/// the order of its literal.
pub fn model_note_props(read: section::NoteProps) -> NoteProps {
    let mut out = NoteProps::default();
    match read.pos {
        Some("pageBottom") => out.pos.set(NotePropsPos::PageBottom),
        Some("beneathText") => out.pos.set(NotePropsPos::BeneathText),
        Some("sectEnd") => out.pos.set(NotePropsPos::SectEnd),
        Some("docEnd") => out.pos.set(NotePropsPos::DocEnd),
        _ => {}
    }
    out.num_fmt.set_some(read.num_fmt);
    out.num_start.set_some(read.num_start);
    match read.num_restart {
        Some("continuous") => out.num_restart.set(NotePropsNumRestart::Continuous),
        Some("eachSect") => out.num_restart.set(NotePropsNumRestart::EachSect),
        Some("eachPage") => out.num_restart.set(NotePropsNumRestart::EachPage),
        _ => {}
    }
    out
}

/// `parseNoteProps`: the document-wide footnotePr / endnotePr, settings.xml
/// overlaid by the final body sectPr (`{ ...base, ...own }`).
pub fn parse_note_props(zip: &Package, document_xml: &str) -> Result<DocNoteProps, Thrown> {
    let settings_xml = part_text(zip, SETTINGS_PATH)?.unwrap_or("");
    // a tracked w:sectPrChange embeds the previous sectPr after the live one
    let body_xml = crate::xml_tag::remove_elements(document_xml, "w:sectPrChange", None);
    let last_sect_pr = body_xml.rfind("<w:sectPr").map_or("", |at| &body_xml[at..]);
    let merged = |tag: NotePrTag| {
        let base = note_props_from_xml(settings_xml, tag).map(model_note_props);
        let own = note_props_from_xml(last_sect_pr, tag).map(model_note_props);
        if base.is_none() && own.is_none() {
            return None;
        }
        let mut out = base.unwrap_or_default();
        if let Some(own) = &own {
            out.assign(own);
        }
        Some(out)
    };
    Ok(DocNoteProps {
        footnote_props: merged(NotePrTag::Footnote),
        endnote_props: merged(NotePrTag::Endnote),
    })
}

/// `parseSettingsFlag`: an on/off flag of settings.xml such as
/// `<w:evenAndOddHeaders/>` (w:val="0|false" is off). `tag` goes into a
/// pattern unescaped, as in the original.
pub fn parse_settings_flag(zip: &Package, tag: &str) -> Result<bool, Thrown> {
    match part_text(zip, SETTINGS_PATH)? {
        Some(xml) => xml_flag_on(xml, tag).map_err(|error| error.to_string()),
        None => Ok(false),
    }
}

/// `parseSources`
pub fn parse_sources(zip: &Package) -> Result<Vec<SourceInfo>, Thrown> {
    let Some(path) = find_sources_part(zip).map_err(|error| error.to_string())? else {
        return Ok(Vec::new());
    };
    let xml = part_text(zip, &path)?.ok_or("the sources part is gone")?;
    Ok(parse_sources_xml(xml))
}

/// What `readThemeFontLang` returns.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeFontLang {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ea_lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bidi_lang: Option<String>,
}

/// `readThemeFontLang`: w:themeFontLang w:eastAsia / w:bidi of settings.xml.
pub fn read_theme_font_lang(zip: &Package) -> Result<ThemeFontLang, Thrown> {
    let Some(xml) = part_text(zip, SETTINGS_PATH)? else {
        return Ok(ThemeFontLang::default());
    };
    let Some(tag) = js_regex!(r"<w:themeFontLang\b[^>]*>").exec(xml) else {
        return Ok(ThemeFontLang::default());
    };
    let tag = tag.as_str();
    let value = |pattern: &jscompat::JsRegex| {
        pattern
            .exec(tag)
            .and_then(|found| found.get(1))
            .map(str::to_owned)
    };
    Ok(ThemeFontLang {
        ea_lang: value(js_regex!(r#"\bw:eastAsia="([^"]+)""#)),
        bidi_lang: value(js_regex!(r#"\bw:bidi="([^"]+)""#)),
    })
}
