//! `apps/docs/src/main/free-ai-strings.ts`: the page the browser shows after
//! the OpenRouter sign-in hands it back to this PC. `en` defines the key
//! set. Non-ASCII text is written as escapes.

use jscompat::JsObject;

use crate::packages::i18n::{I18n, create_i18n};

/// `FREE_AI_PAGE_STRINGS` as `(key, en, ko)`, the keys in the order of the
/// TypeScript's dictionaries (both list them alike).
pub const FREE_AI_PAGE_STRINGS: &[(&str, &str, &str)] = &[
    (
        "pageDoneTitle",
        "Connected to SeuOffice",
        "SeuOffice\u{C5D0} \u{C5F0}\u{ACB0}\u{B410}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "pageDoneBody",
        "You can close this tab and go back to the app.",
        "\u{C774} \u{D0ED}\u{C744} \u{B2EB}\u{ACE0} \u{C571}\u{C73C}\u{B85C} \u{B3CC}\u{C544}\u{AC00}\u{C138}\u{C694}.",
    ),
    (
        "pageFailedTitle",
        "The connection was not made",
        "\u{C5F0}\u{ACB0}\u{D558}\u{C9C0} \u{BABB}\u{D588}\u{C2B5}\u{B2C8}\u{B2E4}",
    ),
    (
        "pageFailedBody",
        "Go back to the app and try again.",
        "\u{C571}\u{C73C}\u{B85C} \u{B3CC}\u{C544}\u{AC00} \u{B2E4}\u{C2DC} \u{C2DC}\u{B3C4}\u{D558}\u{C138}\u{C694}.",
    ),
];

/// `defineStrings({ en, ko })`: the two dictionaries of
/// [`FREE_AI_PAGE_STRINGS`], for `I18n::t` and the callers that read a key.
pub fn free_ai_page_i18n() -> I18n {
    let mut en = JsObject::new();
    let mut ko = JsObject::new();
    for (key, en_text, ko_text) in FREE_AI_PAGE_STRINGS {
        en.set(*key, (*en_text).to_owned());
        ko.set(*key, (*ko_text).to_owned());
    }
    create_i18n(en, ko)
}
