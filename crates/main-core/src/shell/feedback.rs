//! `apps/shell/src/main/feedback.ts`.

use jscompat::{JsObject, JsonValue};

use crate::packages::i18n::{I18n, Lang, create_i18n};

/// The published feedback survey (Google Forms, owned by the repository
/// owner). The Help menu and Settings > About open it in the user's browser;
/// the app itself sends nothing.
pub const FEEDBACK_SURVEY_URL: &str = "https://docs.google.com/forms/d/e/1FAIpQLSfD_dlKfi_ZkcjBJFTH3S2nldTIoW0cMI9d_yDaEe6DwKY47A/viewform";

fn dictionary(entries: &[(&str, &str)]) -> JsObject<String> {
    let mut dict = JsObject::new();
    for (key, text) in entries {
        dict.set(*key, (*text).to_string());
    }
    dict
}

/// `FEEDBACK_STRINGS`: the `en` and `ko` dictionaries, each key in the order
/// the TypeScript lists it.
pub fn feedback_strings() -> I18n {
    let en = dictionary(&[
        ("menuLabel", "Send feedback"),
        ("dialogTitle", "Send feedback"),
        (
            "dialogBody",
            "The survey opens in your browser. The details below are copied to the clipboard so you can paste them into the survey. The app sends nothing itself, and document contents are never included.",
        ),
        (
            "details",
            "Version {version}\nOS {os}\nUI language {language}",
        ),
        ("btnOpen", "Open survey"),
        ("btnCancel", "Cancel"),
    ]);
    let ko = dictionary(&[
        ("menuLabel", "\u{C758}\u{ACAC} \u{BCF4}\u{B0B4}\u{AE30}"),
        ("dialogTitle", "\u{C758}\u{ACAC} \u{BCF4}\u{B0B4}\u{AE30}"),
        (
            "dialogBody",
            "\u{C124}\u{BB38}\u{C774} \u{BE0C}\u{B77C}\u{C6B0}\u{C800}\u{C5D0}\u{C11C} \u{C5F4}\u{B9BD}\u{B2C8}\u{B2E4}. \u{C544}\u{B798} \u{C815}\u{BCF4}\u{B294} \u{D074}\u{B9BD}\u{BCF4}\u{B4DC}\u{C5D0} \u{BCF5}\u{C0AC}\u{B418}\u{C5B4} \u{C124}\u{BB38}\u{C5D0} \u{BD99}\u{C5EC} \u{B123}\u{C744} \u{C218} \u{C788}\u{C2B5}\u{B2C8}\u{B2E4}. \u{C571}\u{C740} \u{C544}\u{BB34}\u{AC83}\u{B3C4} \u{BCF4}\u{B0B4}\u{C9C0} \u{C54A}\u{C73C}\u{BA70}, \u{BB38}\u{C11C} \u{B0B4}\u{C6A9}\u{C740} \u{D3EC}\u{D568}\u{B418}\u{C9C0} \u{C54A}\u{C2B5}\u{B2C8}\u{B2E4}.",
        ),
        (
            "details",
            "\u{BC84}\u{C804} {version}\n\u{C6B4}\u{C601}\u{CCB4}\u{C81C} {os}\n\u{D654}\u{BA74} \u{C5B8}\u{C5B4} {language}",
        ),
        ("btnOpen", "\u{C124}\u{BB38} \u{C5F4}\u{AE30}"),
        ("btnCancel", "\u{CDE8}\u{C18C}"),
    ]);
    create_i18n(en, ko)
}

/// `feedbackText(lang, key, params)`
pub fn feedback_text(lang: Lang, key: &str, params: Option<&JsObject<JsonValue>>) -> String {
    feedback_strings().t(lang, key, params)
}

/// `FeedbackEnvironment`
#[derive(Debug, Clone, PartialEq)]
pub struct FeedbackEnvironment {
    pub version: String,
    pub os: String,
    pub language: String,
}

/// `platformLabel(platform)`: `Windows`, `macOS`, `Linux`; anything else is
/// shown as the platform names itself.
pub fn platform_label(platform: &str) -> String {
    match platform {
        "win32" => "Windows".to_string(),
        "darwin" => "macOS".to_string(),
        "linux" => "Linux".to_string(),
        other => other.to_string(),
    }
}

/// `feedbackDetails(lang, env)`: the block copied to the clipboard: version,
/// OS and UI language, nothing else.
pub fn feedback_details(lang: Lang, env: &FeedbackEnvironment) -> String {
    let mut params = JsObject::new();
    params.set("version", JsonValue::String(env.version.clone()));
    params.set("os", JsonValue::String(env.os.clone()));
    params.set("language", JsonValue::String(env.language.clone()));
    feedback_text(lang, "details", Some(&params))
}
