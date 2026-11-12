//! `apps/pdf/src/main/font-similar.ts`: the installed face that looks most
//! like the face a PDF run was drawn with.

use super::font_classes::{
    FontClass, FontScript, FontStyleClass, classify_font_name, lookalike_families, stand_in_script,
};
use super::font_cmap::font_covers_text;
use super::font_cmap::{latin1, u16_at, u32_at};
use super::font_locate::FontLocator;
use jscompat::to_int32;

/// FontDescriptor flag bits (ISO 32000-1 table 123)
const FLAG_FIXED_PITCH: i32 = 1;
const FLAG_SERIF: i32 = 1 << 1;
const FLAG_SYMBOLIC: i32 = 1 << 2;
const FLAG_SCRIPT: i32 = 1 << 3;
const FLAG_NONSYMBOLIC: i32 = 1 << 5;
const FLAG_ITALIC: i32 = 1 << 6;
const FLAG_FORCE_BOLD: i32 = 1 << 18;

/// The document face a run was drawn with, as far as the file tells
#[derive(Debug, Clone)]
pub struct SourceFace {
    /// BaseFont, subset tag stripped, decoded (decodeFontName)
    pub ps_name: String,
    /// FontDescriptor /Flags (0 when absent)
    pub flags: f64,
    /// Embedded font program, when there is one
    pub embedded: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Os2Traits {
    pub weight: Option<f64>,
    pub style: Option<FontStyleClass>,
}

/// usWeightClass and the PANOSE classification of an sfnt's OS/2 table.
pub fn os2_traits(font: Option<&[u8]>) -> Os2Traits {
    let Some(font) = font.filter(|f| f.len() >= 12) else {
        return Os2Traits::default();
    };
    read_os2(font).unwrap_or_default()
}

fn read_os2(font: &[u8]) -> Result<Os2Traits, super::font_cmap::OutOfRange> {
    let num_tables = u16_at(font, 4)?;
    if num_tables > 64 || 12 + num_tables * 16 > font.len() as i64 {
        return Ok(Os2Traits::default());
    }
    for i in 0..num_tables {
        let rec = 12 + i * 16;
        if latin1(font, rec, rec + 4) != "OS/2" {
            continue;
        }
        let off = u32_at(font, rec + 8)?;
        if off + 42 > font.len() as i64 {
            return Ok(Os2Traits::default());
        }
        let weight = u16_at(font, off + 4)?;
        let panose = &font[(off + 32) as usize..(off + 36) as usize];
        let (family_type, serif_style, proportion) = (panose[0], panose[1], panose[3]);
        let mut style = None;
        // PANOSE bytes are only meaningful for the Latin Text / Hand Written kinds
        if family_type == 3 {
            style = Some(FontStyleClass::Brush);
        } else if family_type == 2 {
            if proportion == 9 {
                style = Some(FontStyleClass::Mono);
            } else if (11..=15).contains(&serif_style) {
                style = Some(FontStyleClass::Sans);
            } else if (2..=10).contains(&serif_style) {
                style = Some(FontStyleClass::Serif);
            }
        }
        return Ok(Os2Traits {
            weight: (weight != 0).then_some(weight as f64),
            style,
        });
    }
    Ok(Os2Traits::default())
}

/// Style from FontDescriptor flags; `None` when the flags carry nothing
fn flag_style(flags: i32, script: FontScript) -> Option<FontStyleClass> {
    if flags & (FLAG_SYMBOLIC | FLAG_NONSYMBOLIC) == 0 {
        return None;
    }
    if flags & FLAG_FIXED_PITCH != 0 && script == FontScript::Latin {
        return Some(FontStyleClass::Mono);
    }
    if flags & FLAG_SCRIPT != 0 && script != FontScript::Latin {
        return Some(FontStyleClass::Brush);
    }
    Some(if flags & FLAG_SERIF != 0 {
        FontStyleClass::Serif
    } else {
        FontStyleClass::Sans
    })
}

/// `FontClass & { style: FontStyleClass }`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceTraits {
    pub script: Option<FontScript>,
    pub style: FontStyleClass,
    pub bold: bool,
    pub italic: bool,
}

/// What the document face looks like: the name first (explicit), then the
/// embedded program's PANOSE, then the descriptor flags; sans when nothing says.
pub fn source_traits(face: &SourceFace, script: Option<FontScript>) -> SourceTraits {
    let named: FontClass = classify_font_name(&face.ps_name);
    let os2 = os2_traits(face.embedded.as_deref());
    let flags = to_int32(face.flags);
    let flagged = flag_style(flags, script.or(named.script).unwrap_or(FontScript::Latin));
    SourceTraits {
        script: named.script,
        style: named
            .style
            .or(os2.style)
            .or(flagged)
            .unwrap_or(FontStyleClass::Sans),
        bold: named.bold || (flags & FLAG_FORCE_BOLD) != 0 || os2.weight.unwrap_or(0.0) >= 600.0,
        italic: named.italic || (flags & FLAG_ITALIC) != 0,
    }
}

/// `{ bytes, bold, sourceBold }`
#[derive(Debug, Clone, PartialEq)]
pub struct SimilarFont {
    pub bytes: Vec<u8>,
    pub bold: bool,
    pub source_bold: bool,
}

/// Installed face that looks most like the document face and draws every char
/// of `drawn`: same script and style class, the source's weight and slant
/// preferred. `None` when no look-alike is installed.
pub fn similar_font_for(
    fonts: &mut FontLocator,
    face: &SourceFace,
    drawn: &str,
    italic_opt: bool,
) -> Option<SimilarFont> {
    let script = stand_in_script(classify_font_name(&face.ps_name).script, drawn);
    let traits = source_traits(face, Some(script));
    let italic = traits.italic || italic_opt;
    let suffix = format!(
        "{}{}",
        if traits.bold { "Bold" } else { "" },
        if italic { "Italic" } else { "" }
    );
    for family in lookalike_families(script, traits.style) {
        // A "<family>-<style>" PostScript query ranks the family's faces by style tokens
        let ps = if suffix.is_empty() {
            String::new()
        } else {
            format!("{family}-{suffix}")
        };
        let Some(bytes) = fonts.find_system_font(&ps, family) else {
            continue;
        };
        if !font_covers_text(&bytes, drawn) {
            continue;
        }
        let weight = os2_traits(Some(&bytes)).weight.unwrap_or(400.0);
        return Some(SimilarFont {
            bytes,
            bold: weight >= 600.0,
            source_bold: traits.bold,
        });
    }
    None
}
