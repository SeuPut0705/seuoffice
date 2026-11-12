//! Port of packages/docx-engine/src/zip-load.ts: the one way a docx is opened,
//! and the part of it `PackageArchive.open` of the slides engine shares.

use std::collections::HashMap;

use jscompat::js_regex;

use crate::gate::{
    DEFAULT_ZIP_LIMITS, DeclaredPart, ZipLimits, assert_declared_sizes_within_limits,
    assert_zip_inflates_within_limits,
};
use crate::jszip::{self, LoadedEntry};
use crate::normalize::{
    dedupe_style_refs, has_duplicate_style_refs, has_universal_measures, needs_ooxml_normalization,
    normalize_ooxml_xml,
};
use crate::package::{Package, Part};

const EOCD_SIG: u32 = 0x0605_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const UNICODE_PATH_ID: u16 = 0x7075;

fn u16_at(bytes: &[u8], index: usize) -> usize {
    usize::from(u16::from_le_bytes([bytes[index], bytes[index + 1]]))
}

fn u32_at(bytes: &[u8], index: usize) -> u32 {
    u32::from_le_bytes([
        bytes[index],
        bytes[index + 1],
        bytes[index + 2],
        bytes[index + 3],
    ])
}

/// Word resolves parts by the zip header file names and ignores Info-ZIP
/// Unicode Path (0x7075) extra fields; JSZip honours them, so a field with a
/// valid checksum can shadow word/document.xml with another entry's bytes.
/// The field id is blanked in the central directory so the header names win.
/// `None` when there is nothing to do.
fn neutralize_unicode_path_fields(bytes: &[u8]) -> Option<Vec<u8>> {
    let last = bytes.len().checked_sub(22)?;
    let eocd = (last.saturating_sub(0xffff)..=last)
        .rev()
        .find(|&index| u32_at(bytes, index) == EOCD_SIG)?;
    let count = u16_at(bytes, eocd + 10);
    let cd_offset = u32_at(bytes, eocd + 16);
    if count == 0xffff || cd_offset == 0xffff_ffff {
        // zip64: left as it is
        return None;
    }
    // u64: the sums of the lengths must not wrap on a 32-bit target
    let length = bytes.len() as u64;
    let mut out: Option<Vec<u8>> = None;
    let mut p = u64::from(cd_offset);
    for _ in 0..count {
        if p + 46 > length || u32_at(bytes, p as usize) != CENTRAL_SIG {
            return out;
        }
        let at = p as usize;
        let name_len = u16_at(bytes, at + 28) as u64;
        let extra_len = u16_at(bytes, at + 30) as u64;
        let comment_len = u16_at(bytes, at + 32) as u64;
        let mut q = p + 46 + name_len;
        let extra_end = (q + extra_len).min(length);
        while q + 4 <= extra_end {
            let field = q as usize;
            let field_id = u16_at(bytes, field);
            let field_len = u16_at(bytes, field + 2) as u64;
            if field_id == usize::from(UNICODE_PATH_ID) {
                let out = out.get_or_insert_with(|| bytes.to_vec());
                out[field] = 0xff;
                out[field + 1] = 0xff;
            }
            q += 4 + field_len;
        }
        p += 46 + name_len + extra_len + comment_len;
    }
    out
}

/// Parts holding paragraphs whose duplicate style refs get collapsed (last wins).
fn is_word_part(name: &str) -> bool {
    js_regex!(r"^word\/[^/]+\.xml$", "i").test(name)
}

fn is_story_part(name: &str) -> bool {
    js_regex!(
        r"^word\/(?:document|header\d*|footer\d*|footnotes|endnotes|comments\w*|glossary\/document)\.xml$",
        "i"
    )
    .test(name)
}

/// The parts that carry the strict or non-canonical-prefix markers whenever
/// the package needs normalizing.
const NORMALIZE_GATE_PARTS: [&str; 3] = [
    "word/document.xml",
    "word/_rels/document.xml.rels",
    "_rels/.rels",
];

/// ISO Strict OOXML and non-canonical namespace prefixes are normalized at
/// this single entry point, so the parser's offsets and the save's patches
/// see the same part text. Duplicate style refs of the story parts collapse
/// here too, so every reader sees the winner.
fn normalize_ooxml_parts(package: &mut Package) -> Result<(), String> {
    let mut needed = false;
    for path in NORMALIZE_GATE_PARTS {
        if let Some(xml) = package.text(path).map_err(|error| error.reason)?
            && needs_ooxml_normalization(xml)
        {
            needed = true;
            break;
        }
    }
    let mut changed = Vec::new();
    for part in package.parts() {
        if part.is_dir {
            continue;
        }
        let story = is_story_part(&part.name);
        let word_part = is_word_part(&part.name);
        if !story && !word_part && (!needed || !js_regex!(r"\.(xml|rels)$", "i").test(&part.name)) {
            continue;
        }
        let original = part.text().map_err(|error| error.reason)?;
        let mut xml = original.to_owned();
        if (needed || has_universal_measures(&xml)) && needs_ooxml_normalization(&xml) {
            xml = normalize_ooxml_xml(&xml);
        }
        if story && has_duplicate_style_refs(&xml).map_err(|limit| limit.to_string())? {
            xml = dedupe_style_refs(&xml).map_err(|limit| limit.to_string())?;
        }
        if xml != original {
            changed.push((part.name.clone(), xml));
        }
    }
    for (name, xml) in changed {
        package.set_file(name, xml.into_bytes());
    }
    Ok(())
}

/// `loadDocxZip`: loads a docx resolving part names the way Word does. `Err`
/// is the message of what the TypeScript throws.
pub fn load_docx_package(bytes: &[u8]) -> Result<Package, String> {
    let prepared = neutralize_unicode_path_fields(bytes);
    let prepared = prepared.as_deref().unwrap_or(bytes);
    let mut package = load_zip_package(prepared)?;
    normalize_ooxml_parts(&mut package)?;
    Ok(package)
}

/// Which of the three checks of a load refused the archive, with the message
/// of the TypeScript: `openEpub` names the refusal by the stage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadFailure {
    /// `assertZipInflatesWithinLimits`
    Gate(String),
    /// `JSZip.loadAsync`
    Archive(String),
    /// `assertDeclaredSizesWithinLimits` over the loaded entries
    Declared(String),
}

impl LoadFailure {
    pub fn into_message(self) -> String {
        match self {
            Self::Gate(message) | Self::Archive(message) | Self::Declared(message) => message,
        }
    }
}

/// The gate, JSZip's load and the declared-size gate, one after the other,
/// each failure named. With `keep_raw` every part also keeps its record
/// (`Part::raw`), which a save that copies entries through needs.
pub fn load_zip_package_staged(
    bytes: &[u8],
    limits: &ZipLimits,
    keep_raw: bool,
) -> Result<Package, LoadFailure> {
    load_staged(bytes, limits, keep_raw, |parts| {
        assert_declared_sizes_within_limits(parts, limits)
    })
}

/// The metered gate, `JSZip.loadAsync` and the declared-size check that runs
/// on the loaded zip. The engines word that check differently, so each passes
/// its own. `Err` is the message of what the TypeScript throws.
pub fn load_package(
    bytes: &[u8],
    limits: &ZipLimits,
    assert_declared: impl FnOnce(&[DeclaredPart<'_>]) -> Result<(), String>,
) -> Result<Package, String> {
    load_staged(bytes, limits, false, assert_declared).map_err(LoadFailure::into_message)
}

fn load_staged(
    bytes: &[u8],
    limits: &ZipLimits,
    keep_raw: bool,
    assert_declared: impl FnOnce(&[DeclaredPart<'_>]) -> Result<(), String>,
) -> Result<Package, LoadFailure> {
    // metered inflation first: past this point no part is larger than a limit
    assert_zip_inflates_within_limits(bytes, limits).map_err(LoadFailure::Gate)?;
    let entries = jszip::load(bytes, keep_raw).map_err(LoadFailure::Archive)?;
    let mut package = Package::default();
    // what `assertZipWithinLimits` reads from the zip object: a later entry of
    // the same name replaces the earlier one
    let mut declared: HashMap<String, f64> = HashMap::new();
    for LoadedEntry {
        name,
        is_dir,
        uncompressed_size,
        content,
        date,
        raw,
    } in entries
    {
        declared.insert(name.clone(), uncompressed_size.unwrap_or(0.0));
        package.set(
            Part::new(name, is_dir, content)
                .with_date(Some(date))
                .with_raw(raw),
        );
    }
    {
        let parts: Vec<DeclaredPart<'_>> = package
            .parts()
            .iter()
            .filter(|part| !part.is_dir)
            .map(|part| DeclaredPart {
                name: &part.name,
                usize: declared[&part.name],
            })
            .collect();
        assert_declared(&parts).map_err(LoadFailure::Declared)?;
    }
    Ok(package)
}

/// Metered zip loading with JSZip's names and no Word-only normalization.
pub fn load_zip_package(bytes: &[u8]) -> Result<Package, String> {
    load_zip_package_staged(bytes, &DEFAULT_ZIP_LIMITS, false).map_err(LoadFailure::into_message)
}
