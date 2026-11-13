//! The texts the main process shows itself: `i18n-main.ts` and the strings
//! of `ai-attachments.ts`.

use main_core::packages::i18n::Lang;

/// `tm(key)` of `i18n-main.ts` in `lang`; an unknown key is the key, as `createI18n` does
pub fn main_text(lang: Lang, key: &str) -> String {
    let (en, ko) = match key {
        "dlgSaveTitle" => ("Save Mind Map", "마인드맵 저장"),
        "filterMindmap" => ("Mind Maps", "마인드맵"),
        "filterPng" => ("PNG Image", "PNG 이미지"),
        "filterSvg" => ("SVG Image", "SVG 이미지"),
        "filterPdf" => ("PDF Documents", "PDF 문서"),
        "filterOutline" => ("Markdown Outline", "마크다운 개요"),
        "untitledFile" => ("Untitled", "제목 없음"),
        "closeUnsavedMsg" => (
            "This document has unsaved changes.",
            "이 문서에 저장하지 않은 변경 사항이 있습니다.",
        ),
        "closeUnsavedDetail" => (
            "Do you want to save them before closing?",
            "닫기 전에 저장하시겠습니까?",
        ),
        "btnSave" => ("Save", "저장"),
        "btnDontSave" => ("Don't Save", "저장 안 함"),
        "btnCancel" => ("Cancel", "취소"),
        _ => return key.to_owned(),
    };
    match lang {
        Lang::En => en,
        Lang::Ko => ko,
    }
    .to_owned()
}

/// `tm(key, vars)` of `ai-attachments.ts`: `{name}` placeholders are filled from `vars`
pub fn attach_text(lang: Lang, key: &str, vars: &[(&str, String)]) -> String {
    let (en, ko) = match key {
        "dlgAddAttachment" => ("Add Attachments", "첨부 파일 추가"),
        "filterSupported" => ("Supported Files", "지원되는 파일"),
        "filterAll" => ("All Files", "모든 파일"),
        "errUnsupportedExt" => (
            ".{ext} files are not supported",
            ".{ext} 형식은 지원되지 않습니다",
        ),
        "errNotFile" => ("not a file", "파일이 아닙니다"),
        "errTooLarge" => ("exceeds the {mb}MB limit", "{mb}MB 제한을 초과했습니다"),
        "errImageTooLarge" => (
            "image exceeds the 5MB limit",
            "이미지가 5MB 제한을 초과했습니다",
        ),
        "errUnreadable" => ("cannot be read", "읽을 수 없습니다"),
        "errFileTooLarge" => (
            "File exceeds the size limit",
            "파일이 크기 제한을 초과했습니다",
        ),
        "errParseFailed" => ("Failed to parse file", "파일을 분석하지 못했습니다"),
        "errImageNoText" => (
            "Image attachments have no text; the image is sent along with the user message",
            "이미지 첨부 파일은 텍스트를 제공하지 않으며, 이미지 형태로 사용자 메시지와 함께 전송되므로 이미지를 직접 확인하면 됩니다",
        ),
        "errNotImage" => (
            "not a supported image type",
            "지원되지 않는 이미지 형식입니다",
        ),
        _ => return key.to_owned(),
    };
    let mut text = match lang {
        Lang::En => en,
        Lang::Ko => ko,
    }
    .to_owned();
    for (name, value) in vars {
        text = text.replace(&format!("{{{name}}}"), value);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_fill_and_unknown_keys_stay() {
        assert_eq!(
            attach_text(Lang::En, "errUnsupportedExt", &[("ext", "zip".into())]),
            ".zip files are not supported"
        );
        assert_eq!(main_text(Lang::Ko, "btnCancel"), "취소");
        assert_eq!(main_text(Lang::En, "nope"), "nope");
    }
}
