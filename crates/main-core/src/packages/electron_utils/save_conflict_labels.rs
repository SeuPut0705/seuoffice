//! `packages/electron-utils/src/save-conflict-labels.ts`: wording for the
//! same-document save conflict prompt.
//!
//! The string table is `(key, en, ko)`; `en` defines the key set. Non-ASCII
//! text is written as escapes.

use jscompat::JsObject;
use serde::Serialize;

use crate::packages::i18n::{I18n, create_i18n, normalize_lang};

/// `SAVE_CONFLICT_STRINGS` as `(key, en, ko)`.
pub const SAVE_CONFLICT_STRINGS: &[(&str, &str, &str)] = &[
    (
        "message",
        "This document has changed elsewhere.",
        "\u{C774} \u{BB38}\u{C11C}\u{AC00} \u{B2E4}\u{B978} \u{ACF3}\u{C5D0}\u{C11C} \u{BC14}\u{B00C}\u{C5C8}\u{C2B5}\u{B2C8}\u{B2E4}.",
    ),
    (
        "detail",
        "Save anyway and overwrite the changes on disk?",
        "\u{ADF8}\u{B798}\u{B3C4} \u{C800}\u{C7A5}\u{D558}\u{C5EC} \u{B514}\u{C2A4}\u{D06C}\u{C758} \u{BCC0}\u{ACBD} \u{C0AC}\u{D56D}\u{C744} \u{B36E}\u{C5B4}\u{C4F8}\u{AE4C}\u{C694}?",
    ),
    ("overwrite", "Overwrite", "\u{B36E}\u{C5B4}\u{C4F0}\u{AE30}"),
    ("cancel", "Cancel", "\u{CDE8}\u{C18C}"),
];

/// `createI18n(SAVE_CONFLICT_STRINGS)`
fn translator() -> I18n {
    let mut en = JsObject::new();
    let mut ko = JsObject::new();
    for (key, en_text, ko_text) in SAVE_CONFLICT_STRINGS {
        en.set(*key, (*en_text).to_owned());
        ko.set(*key, (*ko_text).to_owned());
    }
    create_i18n(en, ko)
}

/// `SaveConflictLabels`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SaveConflictLabels {
    pub message: String,
    pub detail: String,
    pub overwrite: String,
    pub cancel: String,
}

/// The four prompt strings in the given UI language (raw locale tags accepted).
pub fn save_conflict_labels(lang: &str) -> SaveConflictLabels {
    let t = translator();
    let loc = normalize_lang(Some(lang));
    SaveConflictLabels {
        message: t.t(loc, "message", None),
        detail: t.t(loc, "detail", None),
        overwrite: t.t(loc, "overwrite", None),
        cancel: t.t(loc, "cancel", None),
    }
}
