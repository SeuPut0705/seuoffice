//! `tMain` of sheets-main.ts: the main process's own strings, English and
//! Korean, read in the app-wide UI language.

use jscompat::{JsObject, JsonValue};
use main_core::packages::i18n::{I18n, create_i18n};

use crate::host::LocaleHost;

/// key, English, Korean
const TABLE: &[(&str, &str, &str)] = &[
    ("filterSpreadsheets", "Spreadsheets", "스프레드시트"),
    ("filterXlsx", "Excel Workbooks", "Excel 통합 문서"),
    (
        "filterXlsm",
        "Excel Macro-Enabled Workbooks",
        "Excel 매크로 사용 통합 문서",
    ),
    ("dlgAddAttachment", "Add Attachments", "첨부 파일 추가"),
    ("filterSupported", "Supported Files", "지원되는 파일"),
    ("filterAll", "All Files", "모든 파일"),
    (
        "errUnsupportedExt",
        ".{ext} files are not supported",
        ".{ext} 형식은 지원되지 않습니다",
    ),
    ("errNotFile", "not a file", "파일이 아닙니다"),
    (
        "errTooLarge",
        "exceeds the {mb}MB limit",
        "{mb}MB 제한을 초과했습니다",
    ),
    (
        "errImageTooLarge",
        "image exceeds the 5MB limit",
        "이미지가 5MB 제한을 초과했습니다",
    ),
    ("errUnreadable", "cannot be read", "읽을 수 없습니다"),
    (
        "errFileTooLarge",
        "File exceeds the size limit",
        "파일이 크기 제한을 초과했습니다",
    ),
    (
        "errParseFailed",
        "Failed to parse file",
        "파일을 구문 분석하지 못했습니다",
    ),
    (
        "errHtmlNoTable",
        "This file is a web page, not a spreadsheet; no table to import was found.",
        "이 파일은 스프레드시트가 아니라 웹 페이지입니다. 가져올 표를 찾지 못했습니다.",
    ),
    (
        "errImageNoText",
        "Image attachments have no text; the image is sent along with the user message",
        "이미지 첨부에는 텍스트가 없습니다. 이미지는 사용자 메시지와 함께 전송되므로 이미지를 직접 확인하세요",
    ),
    (
        "errNotImage",
        "not a supported image type",
        "지원되는 이미지 형식이 아닙니다",
    ),
    (
        "errNoApiKey",
        "No API key configured for {provider}",
        "{provider}의 API 키가 설정되지 않았습니다",
    ),
    (
        "errAiBusy",
        "The AI service is busy right now — please try again in a moment",
        "AI 서비스가 혼잡합니다. 잠시 후 다시 시도해 주세요",
    ),
    (
        "errNoModel",
        "No model name configured",
        "모델 이름이 설정되지 않았습니다",
    ),
    (
        "errImgAbsPath",
        "Image path must be absolute.",
        "이미지 경로는 절대 경로여야 합니다.",
    ),
    (
        "errImgNotFound",
        "Image file not found: {path}",
        "이미지 파일을 찾을 수 없습니다: {path}",
    ),
    (
        "errImgTooLarge20",
        "Image exceeds 20MB and cannot be inserted.",
        "이미지가 20MB를 초과하여 삽입할 수 없습니다.",
    ),
    (
        "errImgBadType",
        "The file is not a PNG/JPEG/GIF image.",
        "이 파일은 PNG/JPEG/GIF 이미지가 아닙니다.",
    ),
    (
        "errEncryptedOpenTitle",
        "Cannot open the password-protected workbook",
        "암호가 걸린 통합 문서를 열 수 없습니다",
    ),
    (
        "errEncryptedUnsupported",
        "This file uses an encryption method this app cannot unlock. Remove the password in Excel, then open it again.",
        "이 파일에 쓰인 암호 방식은 이 앱에서 풀 수 없습니다. Excel에서 암호를 해제한 뒤 다시 열어 주세요.",
    ),
    (
        "errDiskChanged",
        "The workbook changed on disk after it was opened — use Save As instead.",
        "통합 문서가 열린 후 디스크에서 변경되었습니다. 다른 이름으로 저장을 사용하세요.",
    ),
    (
        "errSaveUnreadable",
        "The saved result could not be opened again, so the original file was not overwritten. The original is unchanged and your edits are still on screen.",
        "저장한 결과를 다시 열 수 없어 원래 파일을 덮어쓰지 않았습니다. 원래 파일은 그대로이고, 편집한 내용은 화면에 남아 있습니다.",
    ),
    (
        "errSaveUnreadableReason",
        "Reason: {reason}\n\nChoose \"Copy reason\" and paste it into Send feedback to help us find the cause.",
        "까닭: {reason}\n\n\"까닭 복사\"를 누른 뒤 의견 보내기에 붙여 넣어 주시면 원인을 찾는 데 도움이 됩니다.",
    ),
    ("btnCopyReason", "Copy reason", "까닭 복사"),
    ("btnCloseDialog", "Close", "닫기"),
    ("menuFile", "File", "파일"),
    ("menuOpenWorkbook", "Open Workbook…", "통합 문서 열기…"),
    ("menuSave", "Save", "저장"),
    ("menuSaveAs", "Save As…", "다른 이름으로 저장…"),
    ("menuExportPdf", "Export PDF…", "PDF 내보내기…"),
    ("menuPrint", "Print…", "인쇄…"),
    ("menuClose", "Close", "닫기"),
    ("menuQuit", "Quit", "끝내기"),
    ("menuEdit", "Edit", "편집"),
    ("menuUndo", "Undo", "실행 취소"),
    ("menuRedo", "Redo", "다시 실행"),
    (
        "closeUnsavedMsg",
        "{count} unsaved change(s)",
        "저장하지 않은 변경이 {count}건 있습니다",
    ),
    (
        "closeUnsavedDetail",
        "Your changes will be lost if you close without saving.",
        "저장하지 않고 닫으면 변경 내용이 손실됩니다.",
    ),
    ("btnDontSave", "Don't Save", "저장 안 함"),
    ("btnCancel", "Cancel", "취소"),
    (
        "csvSaveAsNotice",
        "CSV files can't keep formatting — saving as .xlsx keeps all your changes.",
        "CSV 형식은 서식을 저장할 수 없습니다. .xlsx로 저장하면 모든 변경 내용이 유지됩니다.",
    ),
    ("menuExportCsv", "Export CSV…", "CSV 내보내기…"),
    ("menuExportOds", "Export as ODS…", "ODS로 내보내기…"),
    (
        "filterOds",
        "OpenDocument Spreadsheet (.ods)",
        "OpenDocument 스프레드시트 (.ods)",
    ),
    (
        "errOdsOriginalTarget",
        "The original ODS file cannot be overwritten. Choose a different name.",
        "원본 ODS 파일은 덮어쓸 수 없습니다. 다른 이름을 선택하세요.",
    ),
    (
        "errOdsEncrypted",
        "Password-protected workbooks cannot be exported as ODS. Remove the password first.",
        "암호가 걸린 워크북은 ODS로 내보낼 수 없습니다. 먼저 암호를 풀어 주세요.",
    ),
    (
        "odsLossMsg",
        "Not everything can be saved to ODS",
        "ODS에 모두 담을 수 없습니다",
    ),
    (
        "odsLossDetail",
        "This workbook uses features ODS cannot hold. They are left out of the exported copy:",
        "이 워크북에 있는 다음 기능은 ODS에 담지 못해 내보낸 사본에서 빠집니다:",
    ),
    (
        "odsLossFormulas",
        "Formulas kept as values only: {count}",
        "값만 남는 수식: {count}",
    ),
    ("odsLossCharts", "Charts: {count}", "차트: {count}"),
    ("odsLossImages", "Images: {count}", "그림: {count}"),
    (
        "odsLossConditionalFormats",
        "Conditional formatting rules: {count}",
        "조건부 서식 규칙: {count}",
    ),
    (
        "odsLossValidations",
        "Data validation rules: {count}",
        "데이터 유효성 검사 규칙: {count}",
    ),
    (
        "odsLossPivots",
        "Pivot tables: {count}",
        "피벗 테이블: {count}",
    ),
    ("odsLossComments", "Comments: {count}", "메모: {count}"),
    ("odsLossMacros", "Macros: {count}", "매크로: {count}"),
    (
        "odsLossShapes",
        "Shapes and text boxes: {count}",
        "도형·글상자: {count}",
    ),
    ("odsLossSlicers", "Slicers: {count}", "슬라이서: {count}"),
    (
        "odsLossSparklines",
        "Sparklines: {count}",
        "스파크라인: {count}",
    ),
    (
        "withheldExportMsg",
        "A copy as {format} can't keep the cells hidden from the AI",
        "{format} 사본에는 AI에서 숨긴 셀의 표시를 담을 수 없습니다",
    ),
    (
        "withheldExportDetail",
        "{format} has nowhere to record which cells are hidden from the AI, so a copy would hand those cells to anyone who opens it, an AI included.\n\nSave as .xlsx keeps the marks. Export {format} without the marks writes the real values, and the marks are gone from that file. Nothing has been written yet.",
        "{format}에는 AI에서 숨긴 셀을 기록할 곳이 없어, 사본을 여는 누구에게나(AI 포함) 그 셀이 그대로 보입니다.\n\n.xlsx로 저장하면 숨김 표시가 유지됩니다. 표시 없이 {format} 내보내기는 실제 값을 그대로 저장하며, 그 파일에서는 숨김 표시가 사라집니다. 아직 아무것도 저장하지 않았습니다.",
    ),
    (
        "withheldExportWithoutMarksBtn",
        "Export {format} without the marks",
        "표시 없이 {format} 내보내기",
    ),
    ("odsContinueBtn", "Continue", "계속"),
    (
        "errOdsExportFailed",
        "The ODS export failed: {message}",
        "ODS 내보내기에 실패했습니다: {message}",
    ),
    (
        "errOdsReopenFailed",
        "The exported ODS file could not be opened again, so it was removed. The workbook is unchanged.",
        "내보낸 ODS 파일을 다시 열지 못해 지웠습니다. 워크북은 그대로입니다.",
    ),
    ("filterCsv", "CSV (Comma delimited)", "CSV (쉼표로 분리)"),
    (
        "filterPdfActiveSheet",
        "PDF (Current sheet)",
        "PDF (현재 시트)",
    ),
    (
        "csvFormulaLossMsg",
        "This sheet contains formulas that CSV cannot keep.",
        "현재 시트에 CSV 형식이 유지할 수 없는 수식이 포함되어 있습니다.",
    ),
    (
        "csvFormulaLossDetail",
        "CSV keeps plain values only — formulas are flattened to their current results, and formatting is lost.",
        "CSV는 값만 유지합니다 — 수식은 현재 계산 결과로 바뀌고 서식은 손실됩니다.",
    ),
    ("csvKeepXlsxBtn", "Save as .xlsx", ".xlsx로 저장"),
    ("csvContinueBtn", "Continue as CSV", "CSV로 계속 저장"),
    (
        "csvActiveSheetOnlyNotice",
        "CSV files hold a single sheet — only the active sheet \"{name}\" will be exported.",
        "CSV 파일에는 시트 하나만 포함됩니다 — 활성 시트 \"{name}\"만 내보냅니다.",
    ),
    (
        "csvKeepFormatMsg",
        "Keep saving in CSV format?",
        "CSV 형식으로 계속 저장하시겠습니까?",
    ),
    (
        "csvKeepFormatDetail",
        "CSV keeps plain values of a single sheet only — formulas, formatting, and any additional sheets are not saved to the .csv file.",
        "CSV는 시트 하나의 값만 유지합니다 — 수식, 서식, 추가 시트는 .csv 파일에 저장되지 않습니다.",
    ),
    (
        "saveAsNeedsExtension",
        "Add an extension to the file name, for example report.xlsx or report.ods.",
        "파일 이름에 확장자를 붙여 주세요. 예: 보고서.xlsx, 보고서.ods",
    ),
];

/// `tm(key, params)`: the text in the UI language right now
#[derive(Clone)]
pub struct Tm {
    i18n: I18n,
    locale: LocaleHost,
}

impl Tm {
    pub fn new(locale: LocaleHost) -> Tm {
        let mut en = JsObject::new();
        let mut ko = JsObject::new();
        for (key, english, korean) in TABLE {
            en.set(*key, (*english).to_owned());
            ko.set(*key, (*korean).to_owned());
        }
        Tm {
            i18n: create_i18n(en, ko),
            locale,
        }
    }

    pub fn t(&self, key: &str) -> String {
        self.i18n.t(self.locale.ui_lang(), key, None)
    }

    pub fn with(&self, key: &str, params: &[(&str, JsonValue)]) -> String {
        let mut object = JsObject::new();
        for (name, value) in params {
            object.set(*name, value.clone());
        }
        self.i18n.t(self.locale.ui_lang(), key, Some(&object))
    }

    pub fn lang(&self) -> main_core::packages::i18n::Lang {
        self.locale.ui_lang()
    }
}
