//! `apps/hwp/src/main/dialog-strings.ts`: text the main process shows or hands
//! back (the save dialogs, the unsaved-changes prompt, attachment errors).
//!
//! The string table is `(key, en, ko)`; `en` defines the key set. Non-ASCII
//! text is written as escapes. `tm` reads the process-wide UI language in the
//! TypeScript; here the caller passes it.

use std::sync::LazyLock;

use jscompat::{JsObject, JsonValue};

use crate::packages::i18n::{I18n, Lang, create_i18n};

/// The dictionaries of `createI18n({ en, ko })`, as `(key, en, ko)`.
pub const DLG_STRINGS: &[(&str, &str, &str)] = &[
    (
        "dlgSaveTitle",
        "Save HWP Document",
        "\u{D55C}\u{AE00} \u{BB38}\u{C11C} \u{C800}\u{C7A5}",
    ),
    (
        "untitledFile",
        "Untitled",
        "\u{C81C}\u{BAA9} \u{C5C6}\u{C74C}",
    ),
    (
        "dlgExportPdfTitle",
        "Export as PDF",
        "PDF\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}",
    ),
    (
        "filterHwp",
        "HWP Documents (HWP)",
        "\u{D55C}\u{AE00} \u{BB38}\u{C11C} (HWP)",
    ),
    (
        "filterHwpx",
        "HWP Documents (HWPX)",
        "\u{D55C}\u{AE00} \u{BB38}\u{C11C} (HWPX)",
    ),
    ("filterPdf", "PDF Documents", "PDF \u{BB38}\u{C11C}"),
    (
        "closeUnsavedMsg",
        "This document has unsaved changes.",
        "\u{C774} \u{BB38}\u{C11C}\u{C5D0} \u{C800}\u{C7A5}\u{D558}\u{C9C0} \u{C54A}\u{C740} \u{BCC0}\u{ACBD} \u{C0AC}\u{D56D}\u{C774} \u{C788}\u{C2B5}\u{B2C8}\u{B2E4}.",
    ),
    (
        "closeUnsavedDetail",
        "Do you want to save them before closing?",
        "\u{B2EB}\u{AE30} \u{C804}\u{C5D0} \u{C800}\u{C7A5}\u{D558}\u{C2DC}\u{ACA0}\u{C2B5}\u{B2C8}\u{AE4C}?",
    ),
    ("btnSave", "Save", "\u{C800}\u{C7A5}"),
    (
        "btnDontSave",
        "Don't Save",
        "\u{C800}\u{C7A5} \u{C548} \u{D568}",
    ),
    ("btnCancel", "Cancel", "\u{CDE8}\u{C18C}"),
    (
        "closeMemoMsg",
        "A memo you are writing is still open.",
        "\u{C791}\u{C131} \u{C911}\u{C778} \u{BA54}\u{BAA8} \u{CC3D}\u{C774} \u{C5F4}\u{B824} \u{C788}\u{C2B5}\u{B2C8}\u{B2E4}.",
    ),
    (
        "closeMemoDetail",
        "Its text is not in the document yet. Discard it, along with any unsaved changes, and close?",
        "\u{BA54}\u{BAA8} \u{B0B4}\u{C6A9}\u{C740} \u{C544}\u{C9C1} \u{BB38}\u{C11C}\u{C5D0} \u{B4E4}\u{C5B4}\u{AC00}\u{C9C0} \u{C54A}\u{C558}\u{C2B5}\u{B2C8}\u{B2E4}. \u{BA54}\u{BAA8}\u{C640} \u{C800}\u{C7A5}\u{D558}\u{C9C0} \u{C54A}\u{C740} \u{BCC0}\u{ACBD} \u{C0AC}\u{D56D}\u{C744} \u{BC84}\u{B9AC}\u{ACE0} \u{B2EB}\u{C744}\u{AE4C}\u{C694}?",
    ),
    (
        "btnDiscardClose",
        "Discard and Close",
        "\u{BC84}\u{B9AC}\u{ACE0} \u{B2EB}\u{AE30}",
    ),
    (
        "dlgAddAttachment",
        "Add Attachments",
        "\u{CCA8}\u{BD80} \u{D30C}\u{C77C} \u{CD94}\u{AC00}",
    ),
    (
        "filterSupported",
        "Supported Files",
        "\u{C9C0}\u{C6D0}\u{B418}\u{B294} \u{D30C}\u{C77C}",
    ),
    (
        "filterAll",
        "All Files",
        "\u{BAA8}\u{B4E0} \u{D30C}\u{C77C}",
    ),
    (
        "errUnsupportedExt",
        ".{ext} files are not supported",
        ".{ext} \u{D615}\u{C2DD}\u{C740} \u{C9C0}\u{C6D0}\u{B418}\u{C9C0} \u{C54A}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "errNotFile",
        "not a file",
        "\u{D30C}\u{C77C}\u{C774} \u{C544}\u{B2D9}\u{B2C8}\u{B2E4}",
    ),
    (
        "errTooLarge",
        "exceeds the {mb}MB limit",
        "{mb}MB \u{C81C}\u{D55C}\u{C744} \u{CD08}\u{ACFC}\u{D588}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "errImageTooLarge",
        "image exceeds the 5MB limit",
        "\u{C774}\u{BBF8}\u{C9C0}\u{AC00} 5MB \u{C81C}\u{D55C}\u{C744} \u{CD08}\u{ACFC}\u{D588}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "errUnreadable",
        "cannot be read",
        "\u{C77D}\u{C744} \u{C218} \u{C5C6}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "errFileTooLarge",
        "File exceeds the size limit",
        "\u{D30C}\u{C77C}\u{C774} \u{D06C}\u{AE30} \u{C81C}\u{D55C}\u{C744} \u{CD08}\u{ACFC}\u{D588}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "errParseFailed",
        "Failed to parse file",
        "\u{D30C}\u{C77C}\u{C744} \u{BD84}\u{C11D}\u{D558}\u{C9C0} \u{BABB}\u{D588}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "errImageNoText",
        "Image attachments have no text; the image is sent along with the user message",
        "\u{C774}\u{BBF8}\u{C9C0} \u{CCA8}\u{BD80} \u{D30C}\u{C77C}\u{C740} \u{D14D}\u{C2A4}\u{D2B8}\u{B97C} \u{C81C}\u{ACF5}\u{D558}\u{C9C0} \u{C54A}\u{C73C}\u{BA70}, \u{C774}\u{BBF8}\u{C9C0} \u{D615}\u{D0DC}\u{B85C} \u{C0AC}\u{C6A9}\u{C790} \u{BA54}\u{C2DC}\u{C9C0}\u{C640} \u{D568}\u{AED8} \u{C804}\u{C1A1}\u{B418}\u{BBC0}\u{B85C} \u{C774}\u{BBF8}\u{C9C0}\u{B97C} \u{C9C1}\u{C811} \u{D655}\u{C778}\u{D558}\u{BA74} \u{B429}\u{B2C8}\u{B2E4}",
    ),
    (
        "errNotImage",
        "not a supported image type",
        "\u{C9C0}\u{C6D0}\u{B418}\u{C9C0} \u{C54A}\u{B294} \u{C774}\u{BBF8}\u{C9C0} \u{D615}\u{C2DD}\u{C785}\u{B2C8}\u{B2E4}",
    ),
];

static TRANSLATOR: LazyLock<I18n> = LazyLock::new(|| {
    let mut en = JsObject::new();
    let mut ko = JsObject::new();
    for (key, en_text, ko_text) in DLG_STRINGS {
        en.set(*key, (*en_text).to_owned());
        ko.set(*key, (*ko_text).to_owned());
    }
    create_i18n(en, ko)
});

/// `tm(key, vars)` with the UI language `lang` (`getUiLang()` there). A key
/// that is in no dictionary comes back as itself, as `createI18n` returns it.
pub fn tm(lang: Lang, key: &str, vars: Option<&JsObject<JsonValue>>) -> String {
    TRANSLATOR.t(lang, key, vars)
}
