//! `packages/pdf-structure/src/highlight/run-id.ts`: the id of one AI
//! highlight run, the hash of the preset id and the ordered label names.

use jscompat::{js_regex, json_quote, trim};

use super::tree_hash::sha256_hex;

/// `HIGHLIGHT_RUN_ID_LENGTH`: hex characters of the run id
pub const HIGHLIGHT_RUN_ID_LENGTH: usize = 32;

/// `s.normalize('NFC')`
pub(crate) fn nfc(text: &str) -> String {
    icu_normalizer::ComposingNormalizerBorrowed::new_nfc()
        .normalize(text)
        .into_owned()
}

/// `normalizeLabelName(name)`: NFC, whitespace collapsed, trimmed
pub fn normalize_label_name(name: &str) -> String {
    let collapsed = js_regex!(r"\s+", "g").replace_all(&nfc(name), |_| " ".to_owned());
    trim(&collapsed).to_owned()
}

/// `highlightRunId(presetId, labelNames)`
pub fn highlight_run_id(preset_id: &str, label_names: &[&str]) -> String {
    let mut items = vec![json_quote(preset_id)];
    items.extend(
        label_names
            .iter()
            .map(|name| json_quote(&normalize_label_name(name))),
    );
    let key = format!("[{}]", items.join(","));
    sha256_hex(&key)
        .chars()
        .take(HIGHLIGHT_RUN_ID_LENGTH)
        .collect()
}
