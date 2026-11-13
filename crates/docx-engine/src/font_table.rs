//! Port of packages/docx-engine/src/font-table.ts: word/fontTable.xml as
//! substitution hints, and the fonts a document embeds.

use jscompat::{JsNum, Radix, js_regex, parse_int, truthy};
use ooxml_pkg::Package;
use ooxml_xml::XNode;
use serde::Serialize;

use crate::package::{Thrown, parse_part, parse_rels, resolve_relationship_target_path};

pub const FONT_TABLE_PART_PATH: &str = "word/fontTable.xml";
pub const FONT_TABLE_RELS_PATH: &str = "word/_rels/fontTable.xml.rels";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedFontRef {
    pub r_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_key: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedSlots {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub regular: Option<EmbeddedFontRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold: Option<EmbeddedFontRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<EmbeddedFontRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold_italic: Option<EmbeddedFontRef>,
}

/// One word/fontTable.xml entry: Word's substitution hints for a missing font.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontTableEntry {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panose: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub charset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub csb0: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedded: Option<EmbedSlots>,
}

/// A fontTable.xml the parser refuses gives no hints rather than an error.
pub fn parse_font_table(xml: &str) -> Vec<FontTableEntry> {
    let Ok(parsed) = parse_part(xml) else {
        return Vec::new();
    };
    let Some(root) = parsed.iter().find(|node| node.name() == Some("w:fonts")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for node in root.children() {
        if node.name() != Some("w:font") {
            continue;
        }
        let Some(name) = truthy(node.attr("w:name")) else {
            continue;
        };
        let attr_of = |tag: &str, key: &str| -> Option<String> {
            truthy(node.find_child(tag).and_then(|child| child.attr(key))).map(str::to_owned)
        };
        out.push(FontTableEntry {
            name: name.to_owned(),
            alt_name: attr_of("w:altName", "w:val"),
            panose: attr_of("w:panose1", "w:val"),
            family: attr_of("w:family", "w:val"),
            charset: attr_of("w:charset", "w:val"),
            csb0: attr_of("w:sig", "w:csb0"),
            pitch: attr_of("w:pitch", "w:val"),
            embedded: parse_embed_slots(node),
        });
    }
    out
}

fn parse_embed_slots(font: &XNode) -> Option<EmbedSlots> {
    let slot = |tag: &str| -> Option<EmbeddedFontRef> {
        let element = font.find_child(tag)?;
        Some(EmbeddedFontRef {
            r_id: truthy(element.attr("r:id"))?.to_owned(),
            font_key: truthy(element.attr("w:fontKey")).map(str::to_owned),
        })
    };
    let slots = EmbedSlots {
        regular: slot("w:embedRegular"),
        bold: slot("w:embedBold"),
        italic: slot("w:embedItalic"),
        bold_italic: slot("w:embedBoldItalic"),
    };
    (slots != EmbedSlots::default()).then_some(slots)
}

pub fn is_sfnt(bytes: &[u8]) -> bool {
    bytes.len() >= 12
        && matches!(
            u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            0x0001_0000 | 0x4f54_544f | 0x7472_7565
        )
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMetrics {
    pub ascent: JsNum,
    pub descent: JsNum,
    pub line_gap: JsNum,
}

/// The hhea line box of a single sfnt face in em units; `None` without head
/// or hhea.
pub fn sfnt_line_metrics(bytes: &[u8]) -> Option<LineMetrics> {
    if !is_sfnt(bytes) {
        return None;
    }
    let u16_at = |at: usize| u16::from_be_bytes([bytes[at], bytes[at + 1]]);
    let i16_at = |at: usize| f64::from(u16_at(at) as i16);
    let u32_at = |at: usize| {
        u64::from(u32::from_be_bytes([
            bytes[at],
            bytes[at + 1],
            bytes[at + 2],
            bytes[at + 3],
        ]))
    };
    let length = bytes.len() as u64;
    let mut units_per_em = 0.0;
    let mut hhea = None;
    for table in 0..usize::from(u16_at(4)) {
        let record = 12 + 16 * table;
        if record + 16 > bytes.len() {
            return None;
        }
        let tag = &bytes[record..record + 4];
        let offset = u32_at(record + 8);
        let table_length = u32_at(record + 12);
        if tag == b"head" && table_length >= 20 && offset + 20 <= length {
            units_per_em = f64::from(u16_at(offset as usize + 18));
        }
        if tag == b"hhea" && table_length >= 10 && offset + 10 <= length {
            hhea = Some(offset as usize);
        }
    }
    let hhea = hhea.filter(|_| units_per_em != 0.0)?;
    Some(LineMetrics {
        ascent: JsNum(i16_at(hhea + 4) / units_per_em),
        descent: JsNum(-i16_at(hhea + 6) / units_per_em),
        line_gap: JsNum(i16_at(hhea + 8) / units_per_em),
    })
}

/// Undoes the ECMA-376 17.8.1 obfuscation: the first 32 bytes are XORed with
/// the 16 bytes of the fontKey GUID taken in reverse order. `None` where the
/// bytes are returned as they are: a missing or zero key, or a part that
/// already starts with an sfnt magic.
pub fn deobfuscate_odttf(bytes: &[u8], font_key: Option<&str>) -> Option<Vec<u8>> {
    let hex: String = font_key
        .unwrap_or("")
        .chars()
        .filter(char::is_ascii_hexdigit)
        .collect();
    if hex.len() != 32 || js_regex!("^0+$").test(&hex) || is_sfnt(bytes) {
        return None;
    }
    let key: Vec<u8> = (0..16)
        .map(|index| parse_int(&hex[index * 2..index * 2 + 2], Radix::Sixteen) as u8)
        .collect();
    let mut out = bytes.to_vec();
    for (index, byte) in out.iter_mut().take(32).enumerate() {
        *byte ^= key[15 - index % 16];
    }
    Some(out)
}

#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddedFont {
    pub family: String,
    pub bold: bool,
    pub italic: bool,
    pub data: Vec<u8>,
    pub line_metrics: Option<LineMetrics>,
}

/// The fontTable embed slots as de-obfuscated faces. A slot whose part is
/// missing, external or not a font is skipped.
pub fn read_embedded_fonts(
    package: &Package,
    font_table: &[FontTableEntry],
) -> Result<Vec<EmbeddedFont>, Thrown> {
    if font_table.iter().all(|entry| entry.embedded.is_none()) {
        return Ok(Vec::new());
    }
    let rels = parse_rels(package, FONT_TABLE_RELS_PATH)?;
    let mut out = Vec::new();
    for entry in font_table {
        let Some(embedded) = &entry.embedded else {
            continue;
        };
        let slots = [
            (&embedded.regular, false, false),
            (&embedded.bold, true, false),
            (&embedded.italic, false, true),
            (&embedded.bold_italic, true, true),
        ];
        for (slot, bold, italic) in slots {
            let Some(font_ref) = slot else {
                continue;
            };
            let Some(rel) = rels
                .get(&font_ref.r_id)
                .filter(|rel| rel.target_mode.as_deref() != Some("External"))
            else {
                continue;
            };
            let Some(path) = resolve_relationship_target_path(FONT_TABLE_PART_PATH, &rel.target)
            else {
                continue;
            };
            let Some(part) = package.file(&path) else {
                continue;
            };
            let stored = part.bytes().map_err(|error| error.to_string())?;
            let data = deobfuscate_odttf(stored, font_ref.font_key.as_deref())
                .unwrap_or_else(|| stored.to_vec());
            if !is_sfnt(&data) {
                continue;
            }
            out.push(EmbeddedFont {
                family: entry.name.clone(),
                bold,
                italic,
                line_metrics: sfnt_line_metrics(&data),
                data,
            });
        }
    }
    Ok(out)
}
