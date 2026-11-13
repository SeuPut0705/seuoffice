//! The words of `docs-main.ts`'s `tMain` that its document handlers show,
//! in both languages (`createI18n`'s `{name}` placeholders).

use main_core::packages::i18n::Lang;

const TEXTS: &[(&str, &str, &str)] = &[
    ("dlgOpenDoc", "Open Document", "문서 열기"),
    ("filterWord", "Word Documents", "Word 문서"),
    ("filterOdt", "OpenDocument Text", "OpenDocument 텍스트"),
    (
        "importSkipConfirm",
        "Convert without asking next time",
        "다음부터 묻지 않고 변환",
    ),
    (
        "docImportMsg",
        "Convert this .{ext} document?",
        "이 .{ext} 문서를 변환할까요?",
    ),
    (
        "docImportDetail",
        "SeuOffice edits .docx, not Word 97-2003 documents. Body text, headings, lists, tables and images carry over; footnotes, comments and text boxes are not fully preserved. The original file is never changed; the converted .docx is a separate copy that later saves write to.",
        "SeuOffice 앱은 Word 97-2003(.doc) 문서가 아니라 .docx를 편집합니다. 본문, 제목, 목록, 표, 이미지는 변환되지만 각주, 메모, 텍스트 상자는 완전히 유지되지 않습니다. 원본 파일은 변경되지 않으며, 변환된 .docx는 이후 저장이 기록되는 독립적인 사본입니다.",
    ),
    ("docImportConvertBtn", "Convert and open", "변환 후 열기"),
    (
        "docImportOriginalTarget",
        "The original document cannot be overwritten. Choose a different name.",
        "원본 문서는 덮어쓸 수 없습니다. 다른 이름을 선택하세요.",
    ),
    ("dlgSaveAs", "Save As", "다른 이름으로 저장"),
    ("markedTitle", "Content hidden from AI", "AI에게 숨긴 내용"),
    (
        "markedOdtMessage",
        "This document has content hidden from AI, and an ODT file cannot keep that.",
        "이 문서에는 AI에게 숨긴 내용이 있는데, ODT 파일에는 이를 담을 수 없습니다.",
    ),
    (
        "markedOdtDetail",
        "Written as ODT, the hidden content would read as plain text to everyone, AI included. Save as Word (.docx) to keep it hidden, or clear the marks and save as ODT: the hidden content then becomes visible to AI in the new file. This document keeps its marks either way.",
        "ODT로 저장하면 숨긴 내용이 AI를 포함한 모두에게 일반 글자로 보입니다. 숨김을 유지하려면 Word(.docx)로 저장하거나, 표시를 지우고 ODT로 저장하세요. 표시를 지우면 새 파일에서 숨긴 내용이 AI에게 보입니다. 어느 쪽이든 현재 문서의 표시는 그대로 남습니다.",
    ),
    ("markedDocx", "Save as Word (.docx)", "Word(.docx)로 저장"),
    (
        "markedExportMessage",
        "This document has content hidden from AI, and the exported file cannot keep that.",
        "이 문서에는 AI에게 숨긴 내용이 있는데, 내보낸 파일에는 이를 담을 수 없습니다.",
    ),
    (
        "markedExportDetail",
        "The exported file has no hidden-from-AI marks: anything that reads it, an AI included, sees the hidden content. Save as Word (.docx) to keep the marks, or export without them. This document keeps its marks either way.",
        "내보낸 파일에는 AI에게 숨긴 표시가 없습니다. 이 파일을 읽는 모든 것은 AI를 포함해 숨긴 내용을 그대로 봅니다. 표시를 유지하려면 Word(.docx)로 저장하거나, 표시 없이 내보내세요. 어느 쪽이든 현재 문서의 표시는 그대로 남습니다.",
    ),
    (
        "markedExportClear",
        "Export without the marks",
        "표시 없이 내보내기",
    ),
    (
        "markedOdtClear",
        "Clear marks and save as ODT",
        "표시 지우고 ODT로 저장",
    ),
    (
        "closeUnsavedMsg",
        "This document has unsaved changes.",
        "이 문서에 저장하지 않은 변경 사항이 있습니다.",
    ),
    (
        "closeUnsavedDetail",
        "Do you want to save them before closing?",
        "닫기 전에 저장하시겠습니까?",
    ),
    (
        "closeNoReplyMsg",
        "The document is not responding and may have unsaved changes.",
        "문서가 응답하지 않으며 저장하지 않은 변경 사항이 있을 수 있습니다.",
    ),
    (
        "closeNoReplyDetail",
        "Close anyway? Unsaved changes will be lost.",
        "그래도 닫을까요? 저장하지 않은 변경 사항은 사라집니다.",
    ),
    ("btnCloseAnyway", "Close Anyway", "닫기"),
    ("btnDontSave", "Don't Save", "저장 안 함"),
    ("btnCancel", "Cancel", "취소"),
    (
        "extModifiedMsg",
        "The file has been modified by another program.",
        "이 파일이 다른 프로그램에서 수정되었습니다.",
    ),
    (
        "extModifiedDetail",
        "Save anyway and overwrite the changes on disk?",
        "그래도 저장하여 디스크의 변경 사항을 덮어쓸까요?",
    ),
    ("btnOverwrite", "Overwrite", "덮어쓰기"),
    ("dlgInsertImage", "Insert Image", "그림 삽입"),
    ("filterImages", "Images", "그림"),
    (
        "dlgMergeDataSource",
        "Select Recipient List",
        "받는 사람 목록 선택",
    ),
    ("filterMergeDataSource", "Excel or CSV", "Excel 또는 CSV"),
    ("filterSupported", "Supported Files", "지원되는 파일"),
    ("dlgExportPdf", "Export as PDF", "PDF로 내보내기"),
    ("dlgExportHtml", "Export as HTML", "HTML로 내보내기"),
    (
        "dlgExportHwp",
        "Export as HWP Document",
        "한글 문서로 내보내기",
    ),
    (
        "dlgExportMarkdown",
        "Export as Markdown",
        "Markdown로 내보내기",
    ),
    (
        "dlgPickExportDir",
        "Choose Export Folder",
        "내보낼 폴더 선택",
    ),
    ("filterPdf", "PDF Document", "PDF 문서"),
    ("filterHtml", "Web Page (HTML)", "웹 페이지(HTML)"),
    ("filterMarkdown", "Markdown Document", "Markdown 문서"),
    ("filterPageImages", "Page Images (PNG)", "쪽 이미지(PNG)"),
    ("filterHwp", "HWP Documents (HWP)", "한글 문서 (HWP)"),
    ("filterHwpx", "HWP Documents (HWPX)", "한글 문서 (HWPX)"),
    (
        "errTooLarge",
        "exceeds the {mb}MB limit",
        "{mb}MB 제한을 초과했습니다",
    ),
    ("errUnreadable", "cannot be read", "읽을 수 없습니다"),
    ("menuSave", "Save", "저장"),
];

/// `tm(key, params)` in `lang`; an unknown key reads as itself
pub(crate) fn tm(lang: Lang, key: &str, params: &[(&str, &str)]) -> String {
    let text = TEXTS
        .iter()
        .find(|(k, _, _)| *k == key)
        .map_or(key, |(_, en, ko)| if lang == Lang::Ko { ko } else { en });
    params.iter().fold(text.to_owned(), |t, (name, value)| {
        t.replace(&format!("{{{name}}}"), value)
    })
}
