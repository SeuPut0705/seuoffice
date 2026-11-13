//! `packages/font-metrics/src/family-info.ts`: per-family facts the font
//! pickers need but the renderer's font enumeration does not report: the
//! Korean family name and the Hangul coverage, read from the font files' own
//! tables.
//!
//! The scan (`scan`, `scanGeneration`) is a [`FamilyInfoScan`] the caller owns;
//! the folders it reads are the [`FontScan`]'s. The TypeScript yields to the
//! event loop between batches of 16 files; a plain call has nothing to yield.

use std::collections::{HashMap, HashSet};
use std::fs;

use jscompat::{JsonValue, RegexLimit, slice_utf16, trim, try_js_regex};
use serde::Serialize;

use super::sfnt::FontScan;
use crate::pdf::font_locate::{face_offsets, norm, read_table, read_table_dir};

/// `FamilyInfo`, its keys in the order the literals write them
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FamilyInfo {
    /// Korean family name (name table, Windows langID 0x0412) when the font carries one
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ko: Option<String>,
    /// the font declares Hangul coverage, or carries a Korean name
    pub hangul: bool,
}

const KOREAN_LANG_ID: i64 = 0x0412;

/// `HANGUL.test(text)`: Hangul Jamo, Compatibility Jamo, Hangul Syllables
fn has_hangul(text: &str) -> bool {
    text.chars()
        .any(|c| matches!(u32::from(c), 0x1100..=0x11ff | 0x3130..=0x318f | 0xac00..=0xd7a3))
}

/// `FamilyNameRecord` of `family-info.ts`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FamilyNameRecord {
    /// 1 = family, 16 = typographic family
    pub id: u16,
    pub name: String,
    pub korean: bool,
}

fn be16(buf: &[u8], at: usize) -> i64 {
    i64::from(u16::from_be_bytes([buf[at], buf[at + 1]]))
}

/// `parseFamilyNames(buf)`: family-name records (nameID 1/16) of a name
/// table, Windows/Unicode platforms only
pub fn parse_family_names(buf: &[u8]) -> Vec<FamilyNameRecord> {
    let mut out = Vec::new();
    if buf.len() < 6 {
        return out;
    }
    let count = be16(buf, 2);
    let str_base = be16(buf, 4);
    for i in 0..count {
        let r = 6 + 12 * i;
        if r + 12 > buf.len() as i64 {
            break;
        }
        let r = r as usize;
        let platform = be16(buf, r);
        let name_id = be16(buf, r + 6);
        if (name_id != 1 && name_id != 16) || (platform != 0 && platform != 3) {
            continue;
        }
        let len = be16(buf, r + 8);
        let off = str_base + be16(buf, r + 10);
        if len == 0 || len % 2 != 0 || off + len > buf.len() as i64 {
            continue;
        }
        let slice = &buf[off as usize..(off + len) as usize];
        let units: Vec<u16> = slice
            .as_chunks::<2>()
            .0
            .iter()
            .map(|p| u16::from_be_bytes([p[0], p[1]]))
            .collect();
        out.push(FamilyNameRecord {
            id: name_id as u16,
            name: String::from_utf16_lossy(&units),
            korean: platform == 3 && be16(buf, r + 4) == KOREAN_LANG_ID,
        });
    }
    out
}

/// `declaresHangul(os2)`: OS/2 ulCodePageRange1 bit 19 (Korean Wansung) or 21
/// (Korean Johab); absent before OS/2 v1
pub fn declares_hangul(os2: Option<&[u8]>) -> bool {
    let Some(os2) = os2.filter(|t| t.len() >= 82) else {
        return false;
    };
    let range = u32::from_be_bytes([os2[78], os2[79], os2[80], os2[81]]);
    range & ((1 << 19) | (1 << 21)) != 0
}

/// `FaceFamily`: one family spelling of one face, with the Korean spelling of
/// the same nameID
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaceFamily {
    pub name: String,
    pub ko: Option<String>,
    pub hangul: bool,
}

/// `faceFamilies(records, hangulDeclared)`: a Korean name is paired with the
/// other spellings of the same nameID only
pub fn face_families(records: &[FamilyNameRecord], hangul_declared: bool) -> Vec<FaceFamily> {
    let mut out: Vec<FaceFamily> = Vec::new();
    for id in [16u16, 1] {
        let names: Vec<&FamilyNameRecord> = records.iter().filter(|r| r.id == id).collect();
        let ko = names
            .iter()
            .find(|r| r.korean && has_hangul(&r.name))
            .map(|r| r.name.clone());
        for record in &names {
            if out.iter().any(|f| f.name == record.name) {
                continue;
            }
            out.push(match &ko {
                Some(ko) => FaceFamily {
                    name: record.name.clone(),
                    ko: Some(ko.clone()),
                    hangul: true,
                },
                None => FaceFamily {
                    name: record.name.clone(),
                    ko: None,
                    hangul: hangul_declared,
                },
            });
        }
    }
    out
}

/// `STYLE_SUFFIX.test(text)`: the OS groups weight/width/slope faces into one
/// family and drops those words from its name, so an enumerated family can be
/// a face's family name minus a style suffix.
fn is_style_suffix(text: &str) -> Result<bool, RegexLimit> {
    try_js_regex!(
        r"^(?:[\s-]+(?:extra|ultra|semi|demi)?[\s-]?(?:thin|hairline|light|regular|normal|book|medium|bold|heavy|black|italic|oblique|condensed|narrow|expanded))+$",
        "i"
    )
    .try_test(text)
}

/// `mergeFaces(family, hits, suffixOf)`
fn merge_faces(
    family: &str,
    hits: &[&FaceFamily],
    suffix_of: Option<&dyn Fn(&FaceFamily) -> String>,
) -> FamilyInfo {
    let mut ko: Option<String> = None;
    let mut hangul = false;
    for f in hits {
        hangul = hangul || f.hangul;
        let Some(face_ko) = f.ko.as_ref().filter(|k| !k.is_empty()) else {
            continue;
        };
        if ko.is_some() {
            continue;
        }
        let suffix = suffix_of.map_or_else(String::new, |of| of(f));
        if !face_ko.to_lowercase().ends_with(&suffix.to_lowercase()) {
            continue;
        }
        let end = face_ko.encode_utf16().count() as f64 - suffix.encode_utf16().count() as f64;
        let name = slice_utf16(face_ko, 0.0, Some(end));
        let name = trim(&name);
        if !name.is_empty() && norm(name) != norm(family) {
            ko = Some(name.to_owned());
        }
    }
    FamilyInfo { ko, hangul }
}

/// `resolveFamilyInfo(families, faces)`: info for each enumerated family that
/// is Korean in name or coverage; the rest are left out. `Err` is a style
/// suffix test that hit the regex search limit (a name table of 30,000
/// characters).
pub fn resolve_family_info(
    families: &[String],
    faces: &[FaceFamily],
) -> Result<Vec<(String, FamilyInfo)>, RegexLimit> {
    let mut exact: HashMap<String, Vec<&FaceFamily>> = HashMap::new();
    for f in faces {
        exact.entry(norm(&f.name)).or_default().push(f);
    }
    let mut out = Vec::new();
    for family in families {
        let info = if let Some(hits) = exact.get(&norm(family)) {
            merge_faces(family, hits, None)
        } else {
            let lower = family.to_lowercase();
            let family_length = family.encode_utf16().count() as f64;
            let suffix_of = |f: &FaceFamily| slice_utf16(&f.name, family_length, None);
            let mut matching: Vec<&FaceFamily> = Vec::new();
            for f in faces {
                if f.name.to_lowercase().starts_with(&lower) && is_style_suffix(&suffix_of(f))? {
                    matching.push(f);
                }
            }
            merge_faces(family, &matching, Some(&suffix_of))
        };
        if info.hangul || info.ko.is_some() {
            out.push((family.clone(), info));
        }
    }
    Ok(out)
}

/// `scanFile(path, faces, seen)`
fn scan_file(path: &str, faces: &mut Vec<FaceFamily>, seen: &mut HashSet<String>) {
    let Ok(file) = fs::File::open(path) else {
        return;
    };
    // unreadable or malformed file: skip (what was added stays)
    let _ = (|| -> Result<(), crate::pdf::font_locate::Thrown> {
        for offset in face_offsets(&file)? {
            let Some(tables) = read_table_dir(&file, offset)? else {
                continue;
            };
            let Some(name) = read_table(&file, &tables, "name", 1 << 20)? else {
                continue;
            };
            let os2 = read_table(&file, &tables, "OS/2", 512)?;
            let hangul = declares_hangul(os2.as_deref());
            for f in face_families(&parse_family_names(&name), hangul) {
                // the faces of one family repeat the same spellings
                let key = format!(
                    "{}\0{}\0{}",
                    f.name,
                    f.ko.as_deref().unwrap_or(""),
                    f.hangul
                );
                if seen.contains(&key) {
                    continue;
                }
                seen.insert(key);
                faces.push(f);
            }
        }
        Ok(())
    })();
}

/// `scan` and `scanGeneration`: scanned once per process (fonts installed
/// later show up after a restart); naming the app's own font folders starts it
/// over.
pub struct FamilyInfoScan {
    faces: Option<Vec<FaceFamily>>,
    generation: i64,
}

impl Default for FamilyInfoScan {
    fn default() -> Self {
        FamilyInfoScan {
            faces: None,
            generation: -1,
        }
    }
}

impl FamilyInfoScan {
    pub fn new() -> Self {
        Self::default()
    }

    /// `installedFaces()`
    fn installed_faces(&mut self, fonts: &FontScan) -> &[FaceFamily] {
        if self.generation != fonts.font_dirs_generation() as i64 {
            self.faces = None;
            self.generation = fonts.font_dirs_generation() as i64;
        }
        if self.faces.is_none() {
            let mut faces = Vec::new();
            let mut seen = HashSet::new();
            for path in fonts.scanned_font_files() {
                scan_file(&path, &mut faces, &mut seen);
            }
            self.faces = Some(faces);
        }
        self.faces.as_deref().unwrap_or_default()
    }
}

const MAX_FAMILIES: usize = 5000;
const MAX_FAMILY_CHARS: usize = 256;

/// `familyInfoFor(families)`: the IPC entry. `families` is the renderer's
/// enumeration, so it is validated as untrusted input: anything but an array
/// answers nothing, and only strings of at most 256 code units count, the
/// first 5,000 of them.
pub fn family_info_for(
    fonts: &FontScan,
    scan: &mut FamilyInfoScan,
    families: &JsonValue,
) -> Result<Vec<(String, FamilyInfo)>, RegexLimit> {
    let JsonValue::Array(items) = families else {
        return Ok(Vec::new());
    };
    let names: Vec<String> = items
        .iter()
        .filter_map(|f| match f {
            JsonValue::String(text) if text.encode_utf16().count() <= MAX_FAMILY_CHARS => {
                Some(text.clone())
            }
            _ => None,
        })
        .take(MAX_FAMILIES)
        .collect();
    resolve_family_info(&names, scan.installed_faces(fonts))
}
