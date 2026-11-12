//! `assemble/report.ts`: the change report: what a conversion turns into
//! something else (`converted`) or leaves out (`dropped`), by feature, so the
//! save dialog can say what changes before the user commits to a format.
//!
//! - ODT to docx (`odtToDocx`): what changes if this ODT is saved as docx.
//! - docx to ODT (`docxToOdt`): what the ODT will not keep as it was.
//! - edited docx to ODT (`saveOdt`): the same, for what the edit brought in.

use jscompat::js_regex;
use serde::Serialize;

use ooxml_pkg::Package;

use crate::core::{BridgeMap, BridgeMarkerKind, OdtDocument, OdtError};

/// `ReportFeature`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum ReportFeature {
    #[serde(rename = "toc")]
    Toc,
    #[serde(rename = "chart")]
    Chart,
    #[serde(rename = "equation")]
    Equation,
    #[serde(rename = "shape")]
    Shape,
    #[serde(rename = "textbox")]
    Textbox,
    #[serde(rename = "columns")]
    Columns,
    #[serde(rename = "citation")]
    Citation,
    #[serde(rename = "cross_reference")]
    CrossReference,
    #[serde(rename = "page_color")]
    PageColor,
    #[serde(rename = "mirror_margins")]
    MirrorMargins,
    #[serde(rename = "theme")]
    Theme,
    #[serde(rename = "comment")]
    Comment,
    #[serde(rename = "revision")]
    Revision,
    #[serde(rename = "ink")]
    Ink,
    #[serde(rename = "watermark")]
    Watermark,
    #[serde(rename = "password")]
    Password,
    #[serde(rename = "protection")]
    Protection,
    #[serde(rename = "form_field")]
    FormField,
    #[serde(rename = "object")]
    Object,
    #[serde(rename = "hidden_from_ai")]
    HiddenFromAi,
}

/// `REPORT_FEATURES`
pub const REPORT_FEATURES: [ReportFeature; 20] = [
    ReportFeature::Toc,
    ReportFeature::Chart,
    ReportFeature::Equation,
    ReportFeature::Shape,
    ReportFeature::Textbox,
    ReportFeature::Columns,
    ReportFeature::Citation,
    ReportFeature::CrossReference,
    ReportFeature::PageColor,
    ReportFeature::MirrorMargins,
    ReportFeature::Theme,
    ReportFeature::Comment,
    ReportFeature::Revision,
    ReportFeature::Ink,
    ReportFeature::Watermark,
    ReportFeature::Password,
    ReportFeature::Protection,
    ReportFeature::FormField,
    ReportFeature::Object,
    ReportFeature::HiddenFromAi,
];

impl ReportFeature {
    /// The string the TypeScript holds.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Toc => "toc",
            Self::Chart => "chart",
            Self::Equation => "equation",
            Self::Shape => "shape",
            Self::Textbox => "textbox",
            Self::Columns => "columns",
            Self::Citation => "citation",
            Self::CrossReference => "cross_reference",
            Self::PageColor => "page_color",
            Self::MirrorMargins => "mirror_margins",
            Self::Theme => "theme",
            Self::Comment => "comment",
            Self::Revision => "revision",
            Self::Ink => "ink",
            Self::Watermark => "watermark",
            Self::Password => "password",
            Self::Protection => "protection",
            Self::FormField => "form_field",
            Self::Object => "object",
            Self::HiddenFromAi => "hidden_from_ai",
        }
    }

    fn index(self) -> usize {
        REPORT_FEATURES
            .iter()
            .position(|f| *f == self)
            .unwrap_or_default()
    }
}

/// `ReportItem['kind']`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum ReportKind {
    #[serde(rename = "converted")]
    Converted,
    #[serde(rename = "dropped")]
    Dropped,
}

/// `ReportItem`
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ReportItem {
    pub kind: ReportKind,
    pub feature: ReportFeature,
    pub count: usize,
}

/// `ConversionReport`
pub type ConversionReport = Vec<ReportItem>;

/// `ReportBuilder`: collects counts; items come out in the fixed feature
/// order, zero counts left out.
#[derive(Default)]
pub struct ReportBuilder {
    /// `converted` then `dropped`, per feature in `REPORT_FEATURES` order
    counts: [[usize; REPORT_FEATURES.len()]; 2],
}

impl ReportBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// `ReportBuilder.add`; a count of zero adds nothing.
    pub fn add(&mut self, kind: ReportKind, feature: ReportFeature, count: usize) -> &mut Self {
        if count == 0 {
            return self;
        }
        let row = match kind {
            ReportKind::Converted => 0,
            ReportKind::Dropped => 1,
        };
        self.counts[row][feature.index()] += count;
        self
    }

    /// `ReportBuilder.build`
    pub fn build(&self) -> ConversionReport {
        let mut out = Vec::new();
        for feature in REPORT_FEATURES {
            for (row, kind) in [ReportKind::Converted, ReportKind::Dropped]
                .into_iter()
                .enumerate()
            {
                let count = self.counts[row][feature.index()];
                if count != 0 {
                    out.push(ReportItem {
                        kind,
                        feature,
                        count,
                    });
                }
            }
        }
        out
    }
}

/// `hiddenFromAiMarks`: the "hidden from AI" marks of a docx package,
/// counted in every XML part. The mark is matched under any prefix or none, as
/// the docx engine reads it (the editor writes `<go:redact w:label="..."/>` in
/// a run's rPr). An ODT has no place for the mark, so a conversion to ODT
/// keeps none of them and the text they hid reads as plain text to anything
/// that opens the ODT; a caller refuses on `dropped`/`hidden_from_ai`.
pub fn hidden_from_ai_marks(zip: &Package) -> Result<usize, OdtError> {
    let mut count = 0;
    for part in zip.parts() {
        if part.is_dir || !part.name.as_str().ends_with(".xml") {
            continue;
        }
        let text = part
            .text()
            .map_err(|error| OdtError::thrown(error.to_string()))?;
        count += js_regex!(r"<(?:[\w.-]+:)?redact\b", "g")
            .find_iter(text)
            .count();
    }
    Ok(count)
}

/// `odtToDocxReport`: what saving the opened ODT as docx changes: locked
/// objects become pictures (by kind), Hancom fill-in fields become plain text,
/// locked cells lose their lock, tracked changes are flattened to their final
/// text.
pub fn odt_to_docx_report(doc: &OdtDocument, map: &BridgeMap) -> ConversionReport {
    odt_to_docx_report_over(&doc.content_xml.text, map)
}

/// The `kind` of a placeholder record.
fn kind_of(p: &serde_json::Value) -> Option<&str> {
    p.get("kind").and_then(|kind| kind.as_str())
}

/// `odtToDocxReport` over the one thing it reads of the document, its
/// `content.xml`.
pub fn odt_to_docx_report_over(content_xml: &str, map: &BridgeMap) -> ConversionReport {
    let mut report = ReportBuilder::new();
    // `map.ext.objects.placeholders`, as far as the report reads it
    let placeholders: &[serde_json::Value] = map
        .ext
        .get("objects")
        .and_then(|objects| objects.get("placeholders"))
        .and_then(|placeholders| placeholders.as_array())
        .map_or(&[], |placeholders| placeholders.as_slice());
    for p in placeholders {
        let feature = match kind_of(p) {
            Some("toc") => ReportFeature::Toc,
            Some("chart") => ReportFeature::Chart,
            Some("equation") => ReportFeature::Equation,
            Some("shape") => ReportFeature::Shape,
            Some("textbox") => ReportFeature::Textbox,
            Some("revision") => ReportFeature::Revision,
            _ => ReportFeature::Object,
        };
        if feature != ReportFeature::Revision {
            report.add(ReportKind::Converted, feature, 1);
        }
    }
    // tracked changes: every change region the document records
    let regions = js_regex!(r"<[\w-]*:?changed-region[\s>]", "g")
        .find_iter(content_xml)
        .count();
    let revision_placeholders = placeholders
        .iter()
        .filter(|p| kind_of(p) == Some("revision"))
        .count();
    report.add(
        ReportKind::Converted,
        ReportFeature::Revision,
        regions.max(revision_placeholders),
    );
    // Hancom fill-in fields: one per start (or point) bookmark
    let mut fields = 0;
    for p in map.paragraphs.iter() {
        for m in &p.markers {
            if m.field
                && matches!(
                    m.kind,
                    BridgeMarkerKind::BookmarkStart | BridgeMarkerKind::Bookmark
                )
            {
                fields += 1;
            }
        }
    }
    report.add(ReportKind::Converted, ReportFeature::FormField, fields);
    let protected_cells = map
        .ext
        .get("table")
        .and_then(|table| table.get("protectedCells"))
        .and_then(|cells| cells.as_array())
        .map_or(0, |cells| cells.len());
    let sections = js_regex!(r#"<text:section\b[^>]*\stext:protected="true""#, "g")
        .find_iter(content_xml)
        .count();
    report.add(
        ReportKind::Dropped,
        ReportFeature::Protection,
        protected_cells + sections,
    );
    report.build()
}
