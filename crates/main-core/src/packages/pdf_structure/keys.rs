//! `packages/pdf-structure/src/store/keys.ts`: translation block keys (spec
//! §6). A block's key is the fingerprint of the page it starts on, the hash
//! of its normalized source text, and how many earlier blocks on that page
//! had the same hash.

use jscompat::{JsMap, js_regex, number_to_string, trim};

use super::highlight_run_id::nfc;
use super::tree_hash::sha256_hex;
use super::tree_inline::{InlineRun, runs_text};

/// `TranslationBlockKey`
#[derive(Debug, Clone, PartialEq)]
pub struct TranslationBlockKey {
    /// fingerprint of the page the block starts on
    pub page_fingerprint: String,
    /// SHA-256 hex of `normalizeSourceText(runs)`
    pub text_hash: String,
    /// 0-based index of this hash among the blocks of that page (a JavaScript number)
    pub occurrence: f64,
}

/// `normalizeSourceText(runs)`: NFC, whitespace runs collapsed, trimmed
pub fn normalize_source_text(runs: &[InlineRun]) -> String {
    let collapsed = js_regex!(r"\s+", "g").replace_all(&nfc(&runs_text(runs)), |_| " ".to_owned());
    trim(&collapsed).to_owned()
}

/// the fields of a `TextUnit` that `translationBlockKeys` reads
pub struct KeyUnit<'a> {
    pub runs: &'a [InlineRun],
    pub page_fingerprint: &'a str,
}

/// `translationBlockKeys(units)`: one key per unit, in the given (reading) order
pub fn translation_block_keys(units: &[KeyUnit<'_>]) -> Vec<TranslationBlockKey> {
    let mut seen: JsMap<f64> = JsMap::new();
    units
        .iter()
        .map(|unit| {
            let text_hash = sha256_hex(&normalize_source_text(unit.runs));
            let slot = format!("{}\u{0}{text_hash}", unit.page_fingerprint);
            let occurrence = seen.get(&slot).copied().unwrap_or(0.0);
            seen.set(slot, occurrence + 1.0);
            TranslationBlockKey {
                page_fingerprint: unit.page_fingerprint.to_owned(),
                text_hash,
                occurrence,
            }
        })
        .collect()
}

/// `blockKeyString(key)`: the stable string form, the map key of
/// `StoredTranslation.blocks`
pub fn block_key_string(key: &TranslationBlockKey) -> String {
    format!(
        "{}:{}:{}",
        key.page_fingerprint,
        key.text_hash,
        number_to_string(key.occurrence)
    )
}
