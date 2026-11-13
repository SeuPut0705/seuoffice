//! `apps/html/src/main/odt-export.ts` (the Markdown editor keeps the same
//! report box in `apps/markdown/src/main/odt-export.ts` and reuses it from
//! here): the change report a `docxToOdt` conversion is confirmed with, the
//! box for a page with content hidden from AI, and their words.

use main_core::packages::electron_utils::marked_odt::{
    MarkedOdtBox, MarkedOdtChoice, MarkedOdtText, marked_odt_box, marked_odt_choice,
};
use shell_contract::hosts::MessageBox;

use super::text_doc::tr;

/// One line of `docxToOdt`'s report (`ConversionReport` item)
#[derive(Clone, Debug, PartialEq)]
pub struct ReportItem {
    /// `'converted'` or `'dropped'`
    pub kind: String,
    /// `ReportFeature`: `toc`, `chart`, ...
    pub feature: String,
    pub count: f64,
}

/// `DocxToOdtResult`
#[derive(Clone, Debug, PartialEq)]
pub struct OdtConversion {
    pub odt: Vec<u8>,
    pub report: Vec<ReportItem>,
}

/// `FEATURE_KEY` with the `tOdt` words of each feature
fn feature_name(lang: &str, feature: &str) -> String {
    let (en, ko) = match feature {
        "toc" => ("Table of contents", "목차"),
        "chart" => ("Charts", "차트"),
        "equation" => ("Equations", "수식"),
        "shape" => ("Shapes", "도형"),
        "textbox" => ("Text boxes", "글상자"),
        "columns" => ("Columns", "다단"),
        "citation" => ("Citations and bibliography", "인용·참고 문헌"),
        "cross_reference" => (
            "Cross-references and caption numbers",
            "상호 참조·그림 번호",
        ),
        "page_color" => ("Page color", "쪽 배경색"),
        "mirror_margins" => ("Mirror margins", "마주보는 여백"),
        "theme" => ("Theme fonts and colors", "테마 글꼴·색"),
        "comment" => ("Comments", "메모"),
        "revision" => ("Tracked changes", "변경 기록"),
        "ink" => ("Ink", "펜 글씨"),
        "watermark" => ("Watermark", "워터마크"),
        "password" => ("Password", "암호"),
        "protection" => (
            "Editing restrictions and read-only recommendation",
            "편집 제한·읽기 전용 권장",
        ),
        "form_field" => ("Form fields", "누름틀"),
        "object" => ("Other objects", "기타 개체"),
        // an unknown feature reads `undefined` in the TypeScript's table
        _ => ("undefined", "undefined"),
    };
    tr(lang, en, ko)
}

/// `odtReportMessageBox(report, lang)`
pub(crate) fn odt_report_box(report: &[ReportItem], lang: &str) -> MessageBox {
    let section = |kind: &str, heading: String| {
        let lines: Vec<String> = report
            .iter()
            .filter(|item| item.kind == kind)
            .map(|item| {
                let name = feature_name(lang, &item.feature);
                if item.count > 1.0 {
                    format!("• {name} ({})", jscompat::number_to_string(item.count))
                } else {
                    format!("• {name}")
                }
            })
            .collect();
        (!lines.is_empty()).then(|| {
            std::iter::once(heading)
                .chain(lines)
                .collect::<Vec<_>>()
                .join("\n")
        })
    };
    let detail = [
        section("converted", tr(lang, "What changes", "바뀌는 것")),
        section("dropped", tr(lang, "What is left out", "빠지는 것")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");
    MessageBox {
        kind: Some("warning".into()),
        title: Some(tr(lang, "Export as ODT", "ODT로 내보내기")),
        message: tr(
            lang,
            "Some content will change or be left out in the ODT file.",
            "ODT 파일에서는 일부 내용이 바뀌거나 빠집니다.",
        ),
        detail: Some(detail),
        buttons: vec![tr(lang, "Save", "저장"), tr(lang, "Cancel", "취소")],
        default_id: Some(0),
        cancel_id: Some(1),
        checkbox_label: None,
    }
}

/// `odtFilterName(lang)`
pub(crate) fn odt_filter_name(lang: &str) -> String {
    tr(lang, "ODT Text Document", "ODT 문서")
}

/// A `markedOdtBox` as the shared dialogs host shows it
pub(crate) fn marked_box(b: &MarkedOdtBox) -> MessageBox {
    MessageBox {
        kind: Some(b.kind.to_owned()),
        title: Some(b.title.clone()),
        message: b.message.clone(),
        detail: Some(b.detail.clone()),
        buttons: b.buttons.clone(),
        default_id: Some(usize::from(b.default_id)),
        cancel_id: Some(b.cancel_id),
        checkbox_label: None,
    }
}

/// The export a marked page is about to get (`askMarkedExport`'s `format`)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MarkedFormat {
    Odt,
    Docx,
}

/// `askMarkedExport(format, show, lang)`'s box: clear the marks for the copy, or cancel
pub(crate) fn marked_export_box(format: MarkedFormat, lang: &str) -> MessageBox {
    let odt = format == MarkedFormat::Odt;
    marked_box(&marked_odt_box(&MarkedOdtText {
        title: tr(lang, "Content hidden from AI", "AI에게 숨긴 내용"),
        message: if odt {
            tr(
                lang,
                "This page has content hidden from AI, and an ODT file cannot keep that.",
                "이 페이지에는 AI에게 숨긴 내용이 있는데, ODT 파일에는 이를 담을 수 없습니다.",
            )
        } else {
            tr(
                lang,
                "This page has content hidden from AI, and a Word export cannot keep that.",
                "이 페이지에는 AI에게 숨긴 내용이 있는데, Word로 내보내면 이를 담을 수 없습니다.",
            )
        },
        detail: tr(
            lang,
            "Exported this way, the hidden content would read as plain text to everyone, AI included. You can export a copy with the marks cleared; this page keeps its marks.",
            "이 형식으로 내보내면 숨긴 내용이 AI를 포함한 모두에게 일반 글자로 보입니다. 표시를 지운 사본을 내보낼 수 있으며, 이 페이지의 표시는 그대로 남습니다.",
        ),
        save_docx: None,
        clear_marks: if odt {
            tr(
                lang,
                "Clear marks and export as ODT",
                "표시 지우고 ODT로 내보내기",
            )
        } else {
            tr(
                lang,
                "Clear marks and export as Word",
                "표시 지우고 Word로 내보내기",
            )
        },
        cancel: tr(lang, "Cancel", "취소"),
    }))
}

/// `askMarkedExport`'s answer from the pressed button: true clears the marks
pub(crate) fn marked_export_clears(response: usize) -> bool {
    marked_odt_choice(response as f64, false) == MarkedOdtChoice::Clear
}

/// `markedExportRefusal(lang)`
pub(crate) fn marked_export_refusal(lang: &str) -> String {
    tr(
        lang,
        "this page has content hidden from AI, and this export cannot keep that; clear the marks first",
        "이 페이지에는 AI에게 숨긴 내용이 있어 이 형식으로 내보낼 수 없습니다. 표시를 먼저 지우세요",
    )
}

#[cfg(test)]
mod tests {
    use super::{ReportItem, odt_report_box};

    #[test]
    fn the_report_box_lists_changes_then_omissions_with_counts() {
        let item = |kind: &str, feature: &str, count| ReportItem {
            kind: kind.into(),
            feature: feature.into(),
            count,
        };
        let b = odt_report_box(
            &[
                item("dropped", "ink", 1.0),
                item("converted", "chart", 3.0),
                item("converted", "toc", 1.0),
            ],
            "en",
        );
        assert_eq!(
            b.detail.as_deref(),
            Some("What changes\n• Charts (3)\n• Table of contents\n\nWhat is left out\n• Ink")
        );
        let ko = odt_report_box(&[item("dropped", "comment", 2.0)], "ko");
        assert_eq!(ko.detail.as_deref(), Some("빠지는 것\n• 메모 (2)"));
        assert_eq!(ko.buttons, vec!["저장", "취소"]);
    }
}
