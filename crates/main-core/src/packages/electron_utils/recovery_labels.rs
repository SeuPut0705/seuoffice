//! `packages/electron-utils/src/recovery-labels.ts`: wording for the per-file
//! recovery prompt and the notice for a document that cannot get a copy.
//!
//! The string table is `(key, en, ko)`; `en` defines the key set. Non-ASCII
//! text is written as escapes.

use jscompat::{JsObject, JsonValue};
use serde::Serialize;

use crate::packages::i18n::{I18n, create_i18n, normalize_lang};

/// `RECOVERY_PROMPT_STRINGS` as `(key, en, ko)`.
pub const RECOVERY_PROMPT_STRINGS: &[(&str, &str, &str)] = &[
    (
        "message",
        "\u{201C}{name}\u{201D} has unsaved changes.",
        "\u{201C}{name}\u{201D}\u{C5D0} \u{C800}\u{C7A5}\u{D558}\u{C9C0} \u{C54A}\u{C740} \u{B0B4}\u{C6A9}\u{C774} \u{B0A8}\u{C544} \u{C788}\u{C2B5}\u{B2C8}\u{B2E4}.",
    ),
    (
        "detail",
        "Changes that were not saved last time were kept in a recovery copy. Restore them? Discard opens the file as it was last saved.",
        "\u{C9C0}\u{B09C}\u{BC88}\u{C5D0} \u{C800}\u{C7A5}\u{D558}\u{C9C0} \u{C54A}\u{C740} \u{B0B4}\u{C6A9}\u{C774} \u{BCF5}\u{AD6C} \u{C0AC}\u{BCF8}\u{C5D0} \u{B0A8}\u{C544} \u{C788}\u{C2B5}\u{B2C8}\u{B2E4}. \u{B418}\u{C0B4}\u{B9B4}\u{AE4C}\u{C694}? \u{BC84}\u{B9AC}\u{BA74} \u{B9C8}\u{C9C0}\u{B9C9}\u{C73C}\u{B85C} \u{C800}\u{C7A5}\u{D55C} \u{D30C}\u{C77C} \u{B0B4}\u{C6A9}\u{C73C}\u{B85C} \u{C5FD}\u{B2C8}\u{B2E4}.",
    ),
    (
        "fileChanged",
        "The file has changed since the copy was made. Another program or a sync service may have edited it.",
        "\u{C0AC}\u{BCF8}\u{C744} \u{B9CC}\u{B4E0} \u{B4A4}\u{C5D0} \u{D30C}\u{C77C}\u{C774} \u{BC14}\u{B00C}\u{C5C8}\u{C2B5}\u{B2C8}\u{B2E4}. \u{B2E4}\u{B978} \u{D504}\u{B85C}\u{ADF8}\u{B7A8}\u{C774}\u{B098} \u{B3D9}\u{AE30}\u{D654} \u{C11C}\u{BE44}\u{C2A4}\u{AC00} \u{ACE0}\u{CCE4}\u{C744} \u{C218} \u{C788}\u{C2B5}\u{B2C8}\u{B2E4}.",
    ),
    ("restore", "Restore", "\u{B418}\u{C0B4}\u{B9AC}\u{AE30}"),
    ("discard", "Discard", "\u{BC84}\u{B9AC}\u{AE30}"),
    (
        "unprotectable",
        "This document is password-protected, so no recovery copy can be kept. If the app closes unexpectedly, unsaved changes cannot be recovered. Save often.",
        "\u{C554}\u{D638}\u{AC00} \u{AC78}\u{B9B0} \u{BB38}\u{C11C}\u{B77C} \u{BCF5}\u{AD6C} \u{C0AC}\u{BCF8}\u{C744} \u{B9CC}\u{B4E4} \u{C218} \u{C5C6}\u{C2B5}\u{B2C8}\u{B2E4}. \u{C571}\u{C774} \u{AC11}\u{C790}\u{AE30} \u{AEBC}\u{C9C0}\u{BA74} \u{C800}\u{C7A5}\u{D558}\u{C9C0} \u{C54A}\u{C740} \u{B0B4}\u{C6A9}\u{C744} \u{B418}\u{C0B4}\u{B9B4} \u{C218} \u{C5C6}\u{C73C}\u{B2C8} \u{C790}\u{C8FC} \u{C800}\u{C7A5}\u{D558}\u{C138}\u{C694}.",
    ),
];

/// `createI18n(RECOVERY_PROMPT_STRINGS)`
fn translator() -> I18n {
    let mut en = JsObject::new();
    let mut ko = JsObject::new();
    for (key, en_text, ko_text) in RECOVERY_PROMPT_STRINGS {
        en.set(*key, (*en_text).to_owned());
        ko.set(*key, (*ko_text).to_owned());
    }
    create_i18n(en, ko)
}

/// `RecoveryPromptLabels`: the keys in the order the TypeScript builds them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecoveryPromptLabels {
    /// names the document
    pub message: String,
    pub detail: String,
    /// extra line when the file on disk is newer than the copy
    #[serde(rename = "fileChanged")]
    pub file_changed: String,
    pub restore: String,
    pub discard: String,
}

/// the prompt's strings in the given UI language (raw locale tags accepted)
pub fn recovery_prompt_labels(lang: &str, document_name: &str) -> RecoveryPromptLabels {
    let t = translator();
    let loc = normalize_lang(Some(lang));
    let mut params = JsObject::new();
    params.set("name", JsonValue::String(document_name.to_owned()));
    RecoveryPromptLabels {
        message: t.t(loc, "message", Some(&params)),
        detail: t.t(loc, "detail", None),
        file_changed: t.t(loc, "fileChanged", None),
        restore: t.t(loc, "restore", None),
        discard: t.t(loc, "discard", None),
    }
}

/// The notice an editor shows once, when a tab first opens a document that
/// cannot get a recovery copy (password Excel, HWP or PDF).
pub fn unprotectable_notice_text(lang: &str) -> String {
    translator().t(normalize_lang(Some(lang)), "unprotectable", None)
}
