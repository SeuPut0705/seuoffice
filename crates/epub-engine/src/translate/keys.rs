//! `translate/keys.ts`: store keys of a book translation (spec 8). Changing
//! any value here loses every stored book translation.

use std::collections::HashMap;

use crate::pdf_structure::{
    InlineRun, TranslationBlockKey, nfc, runs_text, sha256_hex, sha256_hex_text,
};
use crate::utf16::{is_space, trim, units};

/// the text the title and contents fingerprint is made from; never change it
pub const EPUB_METADATA_FINGERPRINT_SOURCE: &str = "epub-translation:title-and-contents";

/// `EPUB_METADATA_FINGERPRINT`: page fingerprint of every title and contents unit
pub fn epub_metadata_fingerprint() -> String {
    sha256_hex_text(&units(EPUB_METADATA_FINGERPRINT_SOURCE))
}

/// `epubChapterFingerprint`: page fingerprint of a chapter: SHA-256 hex of its zip entry path
pub fn epub_chapter_fingerprint(path: &[u16]) -> String {
    sha256_hex_text(path)
}

/// `text.replace(/\s+/g, ' ')`
pub fn collapse_spaces(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut in_run = false;
    for &unit in text {
        if is_space(unit) {
            if !in_run {
                out.push(0x20);
            }
            in_run = true;
        } else {
            out.push(unit);
            in_run = false;
        }
    }
    out
}

/// what the key hashes: NFC, whitespace runs collapsed, trimmed (as pdf-structure)
fn normalized_text(runs: &[InlineRun]) -> Vec<u16> {
    trim(&collapse_spaces(&nfc(&runs_text(runs)))).to_vec()
}

/// `epubTranslationKeys`: one key per unit, in the given order: fingerprint,
/// text hash, and how many earlier units with that fingerprint had the same hash.
pub fn epub_translation_keys(units: &[(&[InlineRun], &str)]) -> Vec<TranslationBlockKey> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    units
        .iter()
        .map(|(runs, page_fingerprint)| {
            let text_hash = sha256_hex_text(&normalized_text(runs));
            let slot = format!("{page_fingerprint}\u{0}{text_hash}");
            let occurrence = seen.get(&slot).copied().unwrap_or(0);
            seen.insert(slot, occurrence + 1);
            TranslationBlockKey {
                page_fingerprint: (*page_fingerprint).to_owned(),
                text_hash,
                occurrence,
            }
        })
        .collect()
}

/// `epubBlockKeyString`: the map key of a block in a stored translation
pub fn epub_block_key_string(key: &TranslationBlockKey) -> String {
    format!(
        "{}:{}:{}",
        key.page_fingerprint, key.text_hash, key.occurrence
    )
}

/// `epubDocumentHash`: document key of a book: SHA-256 hex of the file bytes
pub fn epub_document_hash(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}
