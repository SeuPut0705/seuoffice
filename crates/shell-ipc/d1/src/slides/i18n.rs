//! `apps/slides/src/main/i18n-main.ts`: the main-process strings the
//! handlers in this crate show (dialog titles, filters, close prompt,
//! attachment errors, generated-page errors, chart colour scheme labels).
//! The keys the shell's own dialogs use (freeze, legacy import, media
//! warnings) stay with the shell; extend the table as handlers move over.

use main_core::packages::i18n::{Lang, format as format_template, platform_shortcuts};

use jscompat::{JsObject, JsonValue};

/// `(key, en, ko)`
const STRINGS: &[(&str, &str, &str)] = &[
    ("dlgInsertImage", "Insert Image", "그림 삽입"),
    ("dlgReplacePicture", "Replace Picture", "그림 바꾸기"),
    ("filterImages", "Images", "그림"),
    ("dlgInsertVideo", "Insert Video", "비디오 삽입"),
    ("dlgInsertAudio", "Insert Audio", "오디오 삽입"),
    ("filterVideo", "Video", "비디오"),
    ("filterAudio", "Audio", "오디오"),
    ("dlgInsert3d", "Insert 3D Model", "3D 모델 삽입"),
    ("filter3d", "3D Models", "3D 모델"),
    (
        "dlgPickExportDir",
        "Choose Export Folder",
        "내보낼 폴더 선택",
    ),
    ("btnExport", "Export", "내보내기"),
    ("dlgExportPdf", "Export as PDF", "PDF로 내보내기"),
    ("dlgSavePicture", "Save as Picture", "그림으로 저장"),
    (
        "withheldExportMsg",
        "A copy as {format} can't keep the content hidden from the AI",
        "{format} 사본에는 AI에서 숨긴 내용의 표시를 담을 수 없습니다",
    ),
    (
        "withheldExportDetail",
        "{format} has nowhere to record what is hidden from the AI, so the exported file would show those pictures and words to anyone who opens it, an AI included.\n\nSave as .pptx keeps the marks. Export without the marks writes everything as it appears on the slides. The exported file has no hidden-from-AI marks: anything that reads it, an AI included, sees the hidden content. Nothing has been written yet.",
        "{format}에는 AI에서 숨긴 그림과 글을 기록할 곳이 없어, 내보낸 파일을 여는 누구에게나(AI 포함) 그대로 보입니다.\n\n.pptx로 저장하면 숨김 표시가 유지됩니다. 표시 없이 내보내기는 슬라이드에 보이는 그대로 저장합니다. 내보낸 파일에는 AI 숨김 표시가 없습니다. 그 파일을 읽는 모든 것(AI 포함)이 숨긴 내용을 그대로 봅니다. 아직 아무것도 저장하지 않았습니다.",
    ),
    ("withheldExportKeepPptxBtn", "Save as .pptx", ".pptx로 저장"),
    (
        "withheldExportWithoutMarksBtn",
        "Export {format} without the marks",
        "표시 없이 {format} 내보내기",
    ),
    (
        "filterPngSlides",
        "PNG images (one per slide)",
        "PNG 그림 (슬라이드마다 한 장)",
    ),
    ("dlgAddAttachment", "Add Attachments", "첨부 파일 추가"),
    ("filterSupported", "Supported Files", "지원되는 파일"),
    ("filterAll", "All Files", "모든 파일"),
    (
        "untitledDeck",
        "Untitled Presentation",
        "제목 없는 프레젠테이션",
    ),
    (
        "closeUnsavedMsg",
        "This presentation has unsaved changes.",
        "이 프레젠테이션에 저장하지 않은 변경 사항이 있습니다.",
    ),
    (
        "closeUnsavedDetail",
        "Do you want to save them before closing?",
        "닫기 전에 저장하시겠습니까?",
    ),
    ("btnDontSave", "Don't Save", "저장 안 함"),
    ("btnCancel", "Cancel", "취소"),
    ("menuSave", "Save", "저장"),
    (
        "errUnsupportedExt",
        ".{ext} files are not supported",
        ".{ext} 형식은 지원되지 않습니다",
    ),
    ("errNotFile", "not a file", "파일이 아님"),
    (
        "errTooLarge",
        "exceeds the {mb}MB limit",
        "{mb}MB 한도 초과",
    ),
    (
        "errImageTooLarge",
        "image exceeds the 5MB limit",
        "이미지가 5MB 한도를 초과함",
    ),
    ("errUnreadable", "cannot be read", "읽을 수 없음"),
    (
        "errFileTooLarge",
        "File exceeds the size limit",
        "파일이 크기 한도를 초과했습니다",
    ),
    (
        "errParseFailed",
        "Failed to parse file",
        "파일 분석에 실패했습니다",
    ),
    (
        "errImageNoText",
        "Image attachments have no text; the image is sent along with the user message",
        "이미지 첨부는 텍스트를 제공하지 않으며, 이미지로 사용자 메시지와 함께 전송되었으니 이미지를 직접 확인하세요",
    ),
    (
        "errNotImage",
        "not a supported image type",
        "지원되는 이미지 형식이 아님",
    ),
    (
        "errNoDeckAppend",
        "No deck to append to (session missing). Generate the first page with mode:\"replace\" or add pages with the native tools.",
        "추가할 수 있는 문서가 없습니다(세션 없음). 먼저 mode:\"replace\"로 첫 페이지를 생성하거나 네이티브 도구로 페이지를 추가하세요.",
    ),
    (
        "errAppendFailed",
        "Append failed: {reason}",
        "추가 실패: {reason}",
    ),
    (
        "errPartialAppend",
        "Some pages failed to append: {reason}",
        "일부 페이지 추가 실패: {reason}",
    ),
    (
        "errMergeFailed",
        "Failed to merge slide (source single-page pptx has no valid slide)",
        "슬라이드 병합 실패(원본 단일 페이지 pptx에 유효한 페이지 없음)",
    ),
    (
        "errNoDeckReplace",
        "No deck is open (session missing); cannot redo the page.",
        "열려 있는 문서가 없어(세션 없음) 페이지를 다시 생성할 수 없습니다.",
    ),
    (
        "errNoDeckInsert",
        "No deck is open (session missing); cannot insert the page.",
        "열려 있는 문서가 없어(세션 없음) 페이지를 삽입할 수 없습니다.",
    ),
    (
        "errIndexRange",
        "atIndex out of range (0-{max})",
        "atIndex가 범위를 벗어남(0-{max})",
    ),
    (
        "errReplaceNeedsOne",
        "replace_at mode requires exactly one HTML page",
        "replace_at 모드에는 정확히 한 페이지의 HTML이 필요합니다",
    ),
    (
        "errInsertNeedsOne",
        "insert_at mode requires exactly one HTML page",
        "insert_at 모드에는 정확히 한 페이지의 HTML이 필요합니다",
    ),
    (
        "errReplaceFailed",
        "In-place page replacement failed (error moving/deleting the old page)",
        "페이지 제자리 교체 실패(기존 페이지 이동/삭제 중 오류)",
    ),
    (
        "errInsertFailed",
        "Page insertion failed (error moving the new page)",
        "페이지 삽입 실패(새 페이지 이동 중 오류)",
    ),
    ("errUnknown", "unknown error", "알 수 없는 오류"),
    (
        "chartSimplifyTitle",
        "Editing will simplify this chart",
        "편집하면 이 차트가 단순화됩니다",
    ),
    (
        "chartSimplifyBody",
        "This chart comes from an external file. Editing rebuilds it with this app’s model; fine-grained formatting such as number formats, trendlines, error bars and per-point styles will be lost.",
        "이 차트는 외부 파일에서 가져왔습니다. 편집하면 이 앱의 모델로 재구성되어 숫자 서식, 추세선, 오차 막대, 요소별 스타일 등 세부 서식이 손실됩니다.",
    ),
    ("chartSimplifyOk", "Edit anyway", "계속 편집"),
    ("schemeThemeDefault", "Theme Default", "테마 기본값"),
    ("schemeColorful", "Colorful", "색상형"),
    ("schemeColorful2", "Colorful 2", "색상형 2"),
    ("schemeMono", "Monochromatic {n}", "단색 {n}"),
    (
        "mediaUnsupportedTitle",
        "This video may not play inside the app",
        "이 비디오는 앱 내에서 재생되지 않을 수 있습니다",
    ),
    (
        "mediaNoAudioBody",
        "The video’s audio codec ({codec}) is not supported by the built-in player, so in-app playback will have no sound. The file is embedded as-is and plays normally in PowerPoint after export.",
        "이 비디오의 오디오 코덱({codec})은 내장 플레이어에서 지원되지 않아 앱 내 재생 시 소리가 나지 않습니다. 파일은 원본 그대로 삽입되며 내보낸 후 PowerPoint에서는 정상적으로 재생됩니다.",
    ),
    (
        "mediaAviBody",
        "The AVI format is not supported by the built-in player, so it cannot be played inside the app. The file is embedded as-is and still plays in PowerPoint after export.",
        "AVI 형식은 내장 플레이어에서 지원되지 않아 앱 내에서 재생할 수 없습니다. 파일은 원본 그대로 삽입되며 내보낸 후 PowerPoint에서는 재생할 수 있습니다.",
    ),
    ("legacyPptOk", "OK", "확인"),
];

/// `tMain(lang, key, params)`: the text of `lang`, else English, else the
/// key, then the placeholders filled
pub fn tm(lang: Lang, key: &str, params: &[(&str, JsonValue)]) -> String {
    let text =
        STRINGS
            .iter()
            .find(|(name, _, _)| *name == key)
            .map_or(key, |(_, en, ko)| match lang {
                Lang::En => en,
                Lang::Ko => ko,
            });
    let text = platform_shortcuts(text);
    if params.is_empty() {
        return text;
    }
    let mut object = JsObject::new();
    for (name, value) in params {
        object.set(*name, value.clone());
    }
    format_template(&text, &object)
}
