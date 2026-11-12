//! Exports of index.ts that no other module of the Rust has a home for:
//! `revisionDateBefore` of revision-xml.ts and `previewFontSettings` of
//! font-settings.ts.

use ooxml_pkg::load_docx_package;

use crate::revision_xml::revision_date_ms;
use crate::save::parts::style_upsert::{
    DefaultFonts, StyleUpsert, merge_default_fonts_xml, upsert_style_xml,
};
use crate::styles::{ParsedStyles, parse_styles};
use crate::theme::{ThemeColors, ThemeFonts};

/// `revisionDateBefore`: a change recorded at `date` lies strictly before
/// `before_ms`; a w:date that is no date does not
pub fn revision_date_before(date: Option<&str>, before_ms: f64) -> bool {
    date.is_some_and(|date| revision_date_ms(date) < before_ms)
}

/// `previewFontSettings`: resolve live style inheritance without reparsing the
/// document body or its media. `original_bytes` is `parsed.internal.originalBytes`.
pub fn preview_font_settings(
    original_bytes: &[u8],
    theme_colors: Option<&ThemeColors>,
    theme_fonts: Option<&ThemeFonts>,
    upserts: &[StyleUpsert],
    defaults: Option<&DefaultFonts>,
) -> Result<ParsedStyles, String> {
    let mut package = load_docx_package(original_bytes)?;
    let mut xml = match package
        .text("word/styles.xml")
        .map_err(|error| error.to_string())?
    {
        Some(xml) => xml.to_owned(),
        None => "<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"></w:styles>".to_owned(),
    };
    for up in upserts {
        xml = upsert_style_xml(&xml, up)?;
    }
    if let Some(defaults) = defaults {
        xml = merge_default_fonts_xml(&xml, defaults)?;
    }
    package.set_file("word/styles.xml".to_owned(), xml.into_bytes());
    parse_styles(&package, theme_colors, theme_fonts)
}
