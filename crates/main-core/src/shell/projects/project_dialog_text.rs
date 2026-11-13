//! `apps/shell/src/main/projects/project-dialog-text.ts`: the shell main
//! process's project folder dialogs (decision 0088): the first-time trust
//! prompt (spec 5.10), the download question for a file that is not on this PC
//! (spec 5.8), "use this folder as the project?" for a new project and the
//! folder pickers (spec 5.1). Only the texts and the dialog options live here,
//! so they are testable without Electron; the caller shows them parented to
//! the asking window.
//!
//! The string table is `(key, en, ko)`; `en` defines the key set. Non-ASCII
//! text is written as escapes. The options of `showMessageBox` are the
//! `MessageBoxOptions` of `message_box`, those of `showOpenDialog` the
//! `JsObject<JsonValue>` of `dialog_memory`'s `Dialog`.
//!
//! `Intl.NumberFormat` and `Intl.DateTimeFormat` (the count and the date the
//! trust prompt shows) are the host's: [`IntlFormat`] (engine-waiting: ICU,
//! the process time zone).

use std::sync::LazyLock;

use jscompat::{JsObject, JsonValue, date_parse, number_to_string, to_iso_string, trim};

use crate::packages::electron_utils::default_save_dir::Thrown;
use crate::packages::electron_utils::message_box::MessageBoxOptions;
use crate::packages::i18n::{I18n, Lang, create_i18n};
use crate::packages::project_store::{ProjectTrustDecision, ProjectTrustPrompt};

/// `PROJECT_DIALOG_STRINGS`: the dictionaries of `defineStrings({ en, ko })`,
/// as `(key, en, ko)`.
pub const PROJECT_DIALOG_STRINGS: &[(&str, &str, &str)] = &[
    (
        "trustTitle",
        "Use the instructions in this folder?",
        "\u{C774} \u{D3F4}\u{B354}\u{C758} \u{C9C0}\u{CE68}\u{C744} \u{C0AC}\u{C6A9}\u{D560}\u{AE4C}\u{C694}?",
    ),
    (
        "trustMessage",
        "The folder \u{201C}{name}\u{201D} holds instructions, memory or chats that the app on this PC did not write.",
        "\u{2018}{name}\u{2019} \u{D3F4}\u{B354}\u{C5D0} \u{C774} PC\u{C758} \u{C571}\u{C774} \u{C4F0}\u{C9C0} \u{C54A}\u{C740} \u{C9C0}\u{CE68}\u{B7}\u{AE30}\u{C5B5}\u{B7}\u{B300}\u{D654}\u{AC00} \u{C788}\u{C2B5}\u{B2C8}\u{B2E4}.",
    ),
    (
        "trustHint",
        "Read them, then choose. With \u{201C}Use without instructions\u{201D} the AI uses only the folder\u{2019}s files and this PC\u{2019}s chats.",
        "\u{C77D}\u{C5B4} \u{BCF4}\u{ACE0} \u{ACE0}\u{B974}\u{C138}\u{C694}. [\u{C9C0}\u{CE68} \u{C5C6}\u{C774} \u{C0AC}\u{C6A9}]\u{C744} \u{ACE0}\u{B974}\u{BA74} AI\u{B294} \u{D3F4}\u{B354}\u{C758} \u{D30C}\u{C77C}\u{ACFC} \u{C774} PC\u{C758} \u{B300}\u{D654}\u{B9CC} \u{C501}\u{B2C8}\u{B2E4}.",
    ),
    (
        "trustInstructions",
        "Instructions (instructions.md)",
        "\u{C9C0}\u{CE68} (instructions.md)",
    ),
    (
        "trustMemory",
        "Memory (memory.md)",
        "\u{AE30}\u{C5B5} (memory.md)",
    ),
    (
        "trustForeignChats",
        "Chats written on other PCs",
        "\u{B2E4}\u{B978} PC\u{C5D0}\u{C11C} \u{C4F4} \u{B300}\u{D654}",
    ),
    (
        "trustMoreChats",
        "\u{2026}and {count} more",
        "\u{2026}\u{ADF8} \u{BC16}\u{C5D0} {count}\u{AC1C}",
    ),
    (
        "chatUntitled",
        "(untitled)",
        "(\u{C81C}\u{BAA9} \u{C5C6}\u{C74C})",
    ),
    (
        "trustUse",
        "Use with instructions",
        "\u{C9C0}\u{CE68}\u{AE4C}\u{C9C0} \u{C0AC}\u{C6A9}",
    ),
    (
        "trustWithout",
        "Use without instructions",
        "\u{C9C0}\u{CE68} \u{C5C6}\u{C774} \u{C0AC}\u{C6A9}",
    ),
    ("cancel", "Cancel", "\u{CDE8}\u{C18C}"),
    (
        "trustViewAll",
        "View all",
        "\u{C804}\u{CCB4} \u{BCF4}\u{AE30}",
    ),
    (
        "trustViewHint",
        "\u{201C}View all\u{201D} opens the files in the app. Come back to this window when you have read them and the question appears again.",
        "[\u{C804}\u{CCB4} \u{BCF4}\u{AE30}]\u{B97C} \u{B204}\u{B974}\u{BA74} \u{D30C}\u{C77C}\u{C744} \u{C571}\u{C5D0}\u{C11C} \u{C5FD}\u{B2C8}\u{B2E4}. \u{B2E4} \u{C77D}\u{ACE0} \u{C774} \u{D654}\u{BA74}\u{C73C}\u{B85C} \u{B3CC}\u{C544}\u{C624}\u{BA74} \u{B2E4}\u{C2DC} \u{BB3B}\u{C2B5}\u{B2C8}\u{B2E4}.",
    ),
    (
        "trustMoreChars",
        "({count} more characters)",
        "({count}\u{C790} \u{B354} \u{C788}\u{C74C})",
    ),
    (
        "downloadTitle",
        "File not on this PC",
        "PC\u{C5D0} \u{C5C6}\u{B294} \u{D30C}\u{C77C}",
    ),
    (
        "downloadMessage",
        "\u{201C}{file}\u{201D} is not on this PC and has to be downloaded. Download it?",
        "\u{2018}{file}\u{2019}\u{C740} PC\u{C5D0} \u{C5C6}\u{C5B4} \u{B0B4}\u{B824}\u{BC1B}\u{C544}\u{C57C} \u{D569}\u{B2C8}\u{B2E4}. \u{B0B4}\u{B824}\u{BC1B}\u{C744}\u{AE4C}\u{C694}?",
    ),
    (
        "downloadButton",
        "Download",
        "\u{B0B4}\u{B824}\u{BC1B}\u{AE30}",
    ),
    (
        "newProjectTitle",
        "New project",
        "\u{C0C8} \u{D504}\u{B85C}\u{C81D}\u{D2B8}",
    ),
    (
        "useExistingMessage",
        "A folder named \u{201C}{name}\u{201D} already exists. Use that folder as the project?",
        "\u{2018}{name}\u{2019} \u{D3F4}\u{B354}\u{AC00} \u{C774}\u{BBF8} \u{C788}\u{C2B5}\u{B2C8}\u{B2E4}. \u{ADF8} \u{D3F4}\u{B354}\u{B97C} \u{D504}\u{B85C}\u{C81D}\u{D2B8}\u{B85C} \u{C0AC}\u{C6A9}\u{D560}\u{AE4C}\u{C694}?",
    ),
    (
        "useExistingButton",
        "Use this folder",
        "\u{C774} \u{D3F4}\u{B354} \u{C0AC}\u{C6A9}",
    ),
    (
        "pickFolderTitle",
        "Choose a folder to use as a project",
        "\u{D504}\u{B85C}\u{C81D}\u{D2B8}\u{B85C} \u{C4F8} \u{D3F4}\u{B354} \u{ACE0}\u{B974}\u{AE30}",
    ),
    (
        "relocateTitle",
        "Choose the project folder again",
        "\u{D504}\u{B85C}\u{C81D}\u{D2B8} \u{D3F4}\u{B354} \u{B2E4}\u{C2DC} \u{ACE0}\u{B974}\u{AE30}",
    ),
    (
        "pickParentTitle",
        "Choose where to create the new project",
        "\u{C0C8} \u{D504}\u{B85C}\u{C81D}\u{D2B8}\u{B97C} \u{B9CC}\u{B4E4} \u{ACF3} \u{ACE0}\u{B974}\u{AE30}",
    ),
    ("pickFolderButton", "Choose", "\u{ACE0}\u{B974}\u{AE30}"),
];

static TRANSLATOR: LazyLock<I18n> = LazyLock::new(|| {
    let mut en = JsObject::new();
    let mut ko = JsObject::new();
    for (key, en_text, ko_text) in PROJECT_DIALOG_STRINGS {
        en.set(*key, (*en_text).to_owned());
        ko.set(*key, (*ko_text).to_owned());
    }
    create_i18n(en, ko)
});

/// `projectDialogText(lang, key, params)`: a key that is in no dictionary
/// comes back as itself, as `createI18n` returns it
pub fn project_dialog_text(lang: Lang, key: &str, params: Option<&JsObject<JsonValue>>) -> String {
    TRANSLATOR.t(lang, key, params)
}

/// `{ [name]: value }` of the `params` the dialog texts take
fn one_param(name: &str, value: JsonValue) -> JsObject<JsonValue> {
    let mut params = JsObject::new();
    params.set(name, value);
    params
}

/// `projectDialogText(lang, key, { [name]: value })` with a string value
fn text_with(lang: Lang, key: &str, name: &str, value: &str) -> String {
    project_dialog_text(
        lang,
        key,
        Some(&one_param(name, JsonValue::String(value.to_owned()))),
    )
}

/// `TRUST_TEXT_SHOWN_CHARS`: characters of each file the trust prompt shows;
/// the rest is counted ("N more characters")
pub const TRUST_TEXT_SHOWN_CHARS: usize = 1_500;

/// `TRUST_CHATS_SHOWN`: chats from other PCs the trust prompt lists by name;
/// the rest are counted
pub const TRUST_CHATS_SHOWN: usize = 20;

/// `shownText(text, max)`: `text` cut to `max` characters (whole code points)
/// with an ellipsis. `max` is [`TRUST_TEXT_SHOWN_CHARS`] where it is `None`.
pub fn shown_text(text: &str, max: Option<usize>) -> String {
    shown_excerpt(text, max).text
}

/// What `shownExcerpt` answers
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShownExcerpt {
    pub text: String,
    /// how many characters were left out
    pub more: usize,
}

/// `shownExcerpt(text, max)`: `text` trimmed and cut to `max` whole
/// characters, and how many characters were left out
pub fn shown_excerpt(text: &str, max: Option<usize>) -> ShownExcerpt {
    let max = max.unwrap_or(TRUST_TEXT_SHOWN_CHARS);
    let trimmed = trim(text);
    let length = trimmed.chars().count();
    if length <= max {
        return ShownExcerpt {
            text: trimmed.to_owned(),
            more: 0,
        };
    }
    let kept: String = trimmed.chars().take(max).collect();
    ShownExcerpt {
        text: format!("{kept}\u{2026}"),
        more: length - max,
    }
}

/// The host's `Intl` formatters, which `shownCount` and `shownDate` call
pub trait IntlFormat {
    /// `new Intl.NumberFormat(lang).format(count)`; `Err` where the
    /// constructor or `format` throws
    fn format_number(&self, count: f64, lang: Lang) -> Result<String, Thrown>;

    /// `new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle:
    /// 'short' }).format(at)` of the date at `at_ms` (a valid time), in the
    /// process time zone; `Err` where it throws
    fn format_date_time(&self, at_ms: f64, lang: Lang) -> Result<String, Thrown>;
}

/// `shownCount(count, lang)`
fn shown_count(count: f64, lang: Lang, intl: &dyn IntlFormat) -> String {
    intl.format_number(count, lang)
        .unwrap_or_else(|_| number_to_string(count))
}

/// `shownDate(iso, lang)`
fn shown_date(iso: &str, lang: Lang, intl: &dyn IntlFormat) -> String {
    let at = date_parse(iso);
    if at.is_nan() {
        return iso.to_owned();
    }
    intl.format_date_time(at, lang)
        .unwrap_or_else(|_| to_iso_string(at).expect("a time that parsed is a valid date"))
}

/// `ProjectTrustChoice`: what the person picked in the trust prompt: the
/// answer, or `View` for [view all] (open the files, then ask again). `None`
/// (`null`) is closed or cancelled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectTrustChoice {
    Answer(ProjectTrustDecision),
    View,
}

/// the response index of each trust prompt button
const TRUST_USE: u32 = 0;
const TRUST_WITHOUT: u32 = 1;
const TRUST_VIEW: u32 = 2;
const TRUST_CANCEL: u32 = 3;

/// `trustPromptOptions(lang, prompt)`: the first-time trust prompt (spec
/// 5.10): the texts this install did not write (each cut to its first
/// `TRUST_TEXT_SHOWN_CHARS` characters with "N more characters") and the
/// chats from other PCs, with [use] / [use without instructions] / [view all]
/// / [cancel]. Cancel is the default and what closing means.
pub fn trust_prompt_options(
    lang: Lang,
    prompt: &ProjectTrustPrompt,
    intl: &dyn IntlFormat,
) -> MessageBoxOptions {
    let t = |key: &str| project_dialog_text(lang, key, None);
    let mut parts: Vec<String> = vec![
        t("trustHint"),
        t("trustViewHint"),
        prompt.folder_path.clone(),
    ];
    let mut section = |label: String, text: Option<&String>| {
        let Some(text) = text else {
            return;
        };
        if trim(text).is_empty() {
            return;
        }
        let shown = shown_excerpt(text, None);
        let more = if shown.more > 0 {
            let count = shown_count(shown.more as f64, lang, intl);
            format!("\n{}", text_with(lang, "trustMoreChars", "count", &count))
        } else {
            String::new()
        };
        parts.push(format!("\u{2014} {label} \u{2014}\n{}{more}", shown.text));
    };
    section(t("trustInstructions"), prompt.instructions.as_ref());
    section(t("trustMemory"), prompt.memory.as_ref());
    section("AGENTS.md".to_owned(), prompt.agents.as_ref());
    section("CLAUDE.md".to_owned(), prompt.claude.as_ref());
    if !prompt.foreign_chats.is_empty() {
        let mut lines: Vec<String> = prompt
            .foreign_chats
            .iter()
            .take(TRUST_CHATS_SHOWN)
            .map(|chat| {
                let title = shown_text(&chat.title, Some(120));
                let title = if title.is_empty() {
                    t("chatUntitled")
                } else {
                    title
                };
                format!(
                    "\u{2022} {title} ({})",
                    shown_date(&chat.updated_at, lang, intl)
                )
            })
            .collect();
        let more = prompt.foreign_chats.len().saturating_sub(TRUST_CHATS_SHOWN);
        if more > 0 {
            lines.push(project_dialog_text(
                lang,
                "trustMoreChats",
                Some(&one_param("count", JsonValue::Number(more as f64))),
            ));
        }
        parts.push(format!(
            "\u{2014} {} \u{2014}\n{}",
            t("trustForeignChats"),
            lines.join("\n")
        ));
    }
    MessageBoxOptions {
        kind: "question",
        title: Some(t("trustTitle")),
        message: text_with(lang, "trustMessage", "name", &prompt.name),
        detail: Some(parts.join("\n\n")),
        buttons: vec![
            t("trustUse"),
            t("trustWithout"),
            t("trustViewAll"),
            t("cancel"),
        ],
        default_id: TRUST_CANCEL,
        cancel_id: Some(TRUST_CANCEL),
        no_link: Some(true),
    }
}

/// `trustChoiceOf(response)`: the person's pick from the trust prompt's
/// response; anything but the three choices cancels (`None`)
pub fn trust_choice_of(response: f64) -> Option<ProjectTrustChoice> {
    if response == f64::from(TRUST_USE) {
        Some(ProjectTrustChoice::Answer(ProjectTrustDecision::Use))
    } else if response == f64::from(TRUST_WITHOUT) {
        Some(ProjectTrustChoice::Answer(ProjectTrustDecision::Without))
    } else if response == f64::from(TRUST_VIEW) {
        Some(ProjectTrustChoice::View)
    } else {
        None
    }
}

/// `downloadPromptOptions(lang, fileName)`: "'<file>' is not on this PC ...":
/// [download] is response 0; cancel is the default
pub fn download_prompt_options(lang: Lang, file_name: &str) -> MessageBoxOptions {
    MessageBoxOptions {
        kind: "question",
        title: Some(project_dialog_text(lang, "downloadTitle", None)),
        message: text_with(lang, "downloadMessage", "file", file_name),
        detail: None,
        buttons: vec![
            project_dialog_text(lang, "downloadButton", None),
            project_dialog_text(lang, "cancel", None),
        ],
        default_id: 1,
        cancel_id: Some(1),
        no_link: Some(true),
    }
}

/// `folderBaseName(folderPath)`: the last part of a folder path, either
/// separator ("D:\docs\Budget" -> "Budget")
fn folder_base_name(folder_path: &str) -> &str {
    folder_path
        .split(['\\', '/'])
        .rfind(|part| !part.is_empty())
        .unwrap_or(folder_path)
}

/// `useExistingPromptOptions(lang, folderPath)`: "'<name>' already exists.
/// Use that folder as the project?" for a new project whose folder exists:
/// [use this folder] is response 0
pub fn use_existing_prompt_options(lang: Lang, folder_path: &str) -> MessageBoxOptions {
    MessageBoxOptions {
        kind: "question",
        title: Some(project_dialog_text(lang, "newProjectTitle", None)),
        message: text_with(
            lang,
            "useExistingMessage",
            "name",
            folder_base_name(folder_path),
        ),
        detail: Some(folder_path.to_owned()),
        buttons: vec![
            project_dialog_text(lang, "useExistingButton", None),
            project_dialog_text(lang, "cancel", None),
        ],
        default_id: 0,
        cancel_id: Some(1),
        no_link: Some(true),
    }
}

/// `ProjectFolderPickPurpose`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectFolderPickPurpose {
    Add,
    Relocate,
    Parent,
}

/// `folderPickerOptions(lang, purpose)`: the options of the folder picker for
/// "add folder", relocating a missing project, and a new project's parent
/// folder ("create somewhere else...", spec 5.1)
pub fn folder_picker_options(lang: Lang, purpose: ProjectFolderPickPurpose) -> JsObject<JsonValue> {
    let title = match purpose {
        ProjectFolderPickPurpose::Add => "pickFolderTitle",
        ProjectFolderPickPurpose::Relocate => "relocateTitle",
        ProjectFolderPickPurpose::Parent => "pickParentTitle",
    };
    let mut options = JsObject::new();
    options.set(
        "title",
        JsonValue::String(project_dialog_text(lang, title, None)),
    );
    options.set(
        "buttonLabel",
        JsonValue::String(project_dialog_text(lang, "pickFolderButton", None)),
    );
    options.set(
        "properties",
        JsonValue::Array(vec![
            JsonValue::String("openDirectory".to_owned()),
            JsonValue::String("createDirectory".to_owned()),
        ]),
    );
    options
}
