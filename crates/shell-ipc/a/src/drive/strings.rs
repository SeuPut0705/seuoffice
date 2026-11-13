//! `apps/shell/src/main/drive/drive-strings.ts`: text the main process shows
//! for Google Drive: the page the browser shows after the Google sign-in, and
//! the dialogs about saving back to Drive. `en` defines the key set.

use std::sync::LazyLock;

use jscompat::{JsObject, JsonValue};
use main_core::packages::i18n::{I18n, Lang, create_i18n};

/// `(key, en, ko)` of `DRIVE_MAIN_STRINGS`
const STRINGS: &[(&str, &str, &str)] = &[
    (
        "pageDoneTitle",
        "Google Drive is connected",
        "Google 드라이브를 연결했습니다",
    ),
    (
        "pageDoneBody",
        "You can close this tab and go back to SeuOffice.",
        "이 탭을 닫고 SeuOffice로 돌아가세요.",
    ),
    (
        "pageFailedTitle",
        "Google Drive was not connected",
        "Google 드라이브를 연결하지 못했습니다",
    ),
    (
        "pageFailedBody",
        "Go back to SeuOffice and try again.",
        "SeuOffice로 돌아가 다시 시도하세요.",
    ),
    ("dialogTitle", "Google Drive", "Google 드라이브"),
    (
        "askChanged",
        "“{name}” was changed in Google Drive after you opened it.",
        "“{name}”을(를) 연 뒤에 Google 드라이브에서 누군가 고쳤습니다.",
    ),
    (
        "askReadOnly",
        "You can’t edit “{name}” in Google Drive.",
        "Google 드라이브에서 “{name}”을(를) 고칠 권한이 없습니다.",
    ),
    (
        "askGone",
        "“{name}” is no longer in Google Drive, or this account can’t see it.",
        "“{name}”이(가) Google 드라이브에 없거나, 이 계정으로는 볼 수 없습니다.",
    ),
    (
        "askDetail",
        "Your changes are saved on this PC. What should happen in Drive?",
        "고친 내용은 이 PC에 저장돼 있습니다. 드라이브는 어떻게 할까요?",
    ),
    (
        "btnOverwrite",
        "Overwrite it in Drive",
        "드라이브의 파일 덮어쓰기",
    ),
    (
        "btnCopy",
        "Save a copy to Drive",
        "드라이브에 사본으로 저장",
    ),
    ("btnLocal", "Keep on this PC only", "이 PC에만 저장"),
    ("copySuffix", "copy", "사본"),
    (
        "noticeOfficeCopy",
        "“{name}” is a Google document, so it was left as it is. Your changes were saved to Google Drive as “{copyName}”.",
        "“{name}”은(는) Google 문서라서 그대로 두었습니다. 고친 내용은 Google 드라이브에 “{copyName}”(으)로 저장했습니다.",
    ),
    (
        "noticeCopy",
        "Your changes were saved to Google Drive as “{copyName}”.",
        "고친 내용을 Google 드라이브에 “{copyName}”(으)로 저장했습니다.",
    ),
    (
        "noticeUploadFailed",
        "“{name}” could not be uploaded to Google Drive. Your changes are saved on this PC, and the app will try again.",
        "“{name}”을(를) Google 드라이브에 올리지 못했습니다. 고친 내용은 이 PC에 저장돼 있고, 앱이 다시 올려 봅니다.",
    ),
    ("pagePickedTitle", "Files chosen", "파일을 골랐습니다"),
    (
        "pagePickedBody",
        "You can close this tab and go back to SeuOffice.",
        "이 탭을 닫고 SeuOffice로 돌아가세요.",
    ),
    (
        "freeAiDocRefusal",
        "This document is a copy of a Google Drive file, and the AI in use is a free connection that may train on what it receives. Choose another AI to work on this document.",
        "이 문서는 Google 드라이브 파일의 사본이고, 지금 쓰는 AI는 받은 내용을 학습에 쓸 수 있는 무료 연결입니다. 이 문서는 다른 AI를 골라 맡기세요.",
    ),
    ("ok", "OK", "확인"),
];

static DRIVE_TEXT: LazyLock<I18n> = LazyLock::new(|| {
    let mut en = JsObject::new();
    let mut ko = JsObject::new();
    for (key, english, korean) in STRINGS {
        en.set(*key, (*english).to_owned());
        ko.set(*key, (*korean).to_owned());
    }
    create_i18n(en, ko)
});

/// `driveText(lang, key, params)`
pub fn drive_text(lang: Lang, key: &str, params: &[(&str, &str)]) -> String {
    if params.is_empty() {
        return DRIVE_TEXT.t(lang, key, None);
    }
    let mut object = JsObject::new();
    for (name, value) in params {
        object.set(*name, JsonValue::String((*value).to_owned()));
    }
    DRIVE_TEXT.t(lang, key, Some(&object))
}

/// `copyFileName(name, suffix)`: "report (copy).docx": the suffix goes before
/// the extension
pub fn copy_file_name(name: &str, suffix: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{} ({suffix}){}", &name[..dot], &name[dot..]),
        _ => format!("{name} ({suffix})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_suffix_goes_before_the_extension() {
        assert_eq!(copy_file_name("report.docx", "copy"), "report (copy).docx");
        assert_eq!(copy_file_name("a.b.xlsx", "사본"), "a.b (사본).xlsx");
        assert_eq!(copy_file_name("notes", "copy"), "notes (copy)");
        assert_eq!(copy_file_name(".hidden", "copy"), ".hidden (copy)");
    }

    #[test]
    fn placeholders_are_filled_in_the_language_asked() {
        let en = drive_text(Lang::En, "noticeCopy", &[("copyName", "x (copy).docx")]);
        let ko = drive_text(Lang::Ko, "noticeCopy", &[("copyName", "x (copy).docx")]);
        assert!(en.contains("“x (copy).docx”"));
        assert!(ko.contains("“x (copy).docx”"));
        assert_ne!(en, ko);
        // an unknown key reads as itself
        assert_eq!(drive_text(Lang::En, "nope", &[]), "nope");
    }
}
