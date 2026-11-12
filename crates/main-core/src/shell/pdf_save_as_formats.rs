//! `apps/shell/src/main/pdf-save-as-formats.ts`.

use jscompat::{js_regex, replace_first};
use serde::Serialize;

/// `PdfSaveAsFormat`: what a Save As pick writes
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PdfSaveAsFormat {
    Pdf,
    Md,
    Docx,
    Pptx,
    Xlsx,
    Epub,
    Png,
}

/// `PdfSaveAsLabelKey`: shell main-process string keys used as dialog filter names
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PdfSaveAsLabelKey {
    FilterPdf,
    FilterWord,
    FilterPpt,
    FilterExcel,
    FilterEpub,
    FilterPdfPageImages,
}

impl PdfSaveAsLabelKey {
    /// the key as the TypeScript spells it
    pub fn as_str(self) -> &'static str {
        match self {
            PdfSaveAsLabelKey::FilterPdf => "filterPdf",
            PdfSaveAsLabelKey::FilterWord => "filterWord",
            PdfSaveAsLabelKey::FilterPpt => "filterPpt",
            PdfSaveAsLabelKey::FilterExcel => "filterExcel",
            PdfSaveAsLabelKey::FilterEpub => "filterEpub",
            PdfSaveAsLabelKey::FilterPdfPageImages => "filterPdfPageImages",
        }
    }
}

/// `PdfSaveAsEntry.label`: a string key, or a format name shown as is
enum Label {
    Key(PdfSaveAsLabelKey),
    Literal(&'static str),
}

struct PdfSaveAsEntry {
    format: PdfSaveAsFormat,
    extension: &'static str,
    label: Label,
}

/// The dialog's list in order: the PDF itself first, then every conversion
const PDF_SAVE_AS_ENTRIES: [PdfSaveAsEntry; 7] = [
    PdfSaveAsEntry {
        format: PdfSaveAsFormat::Pdf,
        extension: "pdf",
        label: Label::Key(PdfSaveAsLabelKey::FilterPdf),
    },
    PdfSaveAsEntry {
        format: PdfSaveAsFormat::Md,
        extension: "md",
        label: Label::Literal("Markdown"),
    },
    PdfSaveAsEntry {
        format: PdfSaveAsFormat::Docx,
        extension: "docx",
        label: Label::Key(PdfSaveAsLabelKey::FilterWord),
    },
    PdfSaveAsEntry {
        format: PdfSaveAsFormat::Pptx,
        extension: "pptx",
        label: Label::Key(PdfSaveAsLabelKey::FilterPpt),
    },
    PdfSaveAsEntry {
        format: PdfSaveAsFormat::Xlsx,
        extension: "xlsx",
        label: Label::Key(PdfSaveAsLabelKey::FilterExcel),
    },
    PdfSaveAsEntry {
        format: PdfSaveAsFormat::Epub,
        extension: "epub",
        label: Label::Key(PdfSaveAsLabelKey::FilterEpub),
    },
    // one name typed, one file per page beside it (numberedExportPaths)
    PdfSaveAsEntry {
        format: PdfSaveAsFormat::Png,
        extension: "png",
        label: Label::Key(PdfSaveAsLabelKey::FilterPdfPageImages),
    },
];

/// `PdfSaveAsFilter`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PdfSaveAsFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// `pdfSaveAsFilters(label)`: dialog filters, each name translated by `label`
pub fn pdf_save_as_filters(
    label: &mut dyn FnMut(PdfSaveAsLabelKey) -> String,
) -> Vec<PdfSaveAsFilter> {
    PDF_SAVE_AS_ENTRIES
        .iter()
        .map(|entry| PdfSaveAsFilter {
            name: match &entry.label {
                Label::Key(key) => label(*key),
                Label::Literal(literal) => (*literal).to_string(),
            },
            extensions: vec![entry.extension.to_string()],
        })
        .collect()
}

/// `pdfSaveAsDefaultPath(filePath)`: the suggestion carries no extension: the
/// file type chosen in the dialog supplies it
pub fn pdf_save_as_default_path(file_path: &str) -> String {
    replace_first(js_regex!(r"\.pdf$", "i"), 0, file_path, "")
}

/// `extensionOf(path)`: extension of the last path segment, lower case,
/// without the dot (`""` when none)
fn extension_of(path: &str) -> String {
    // byte offsets stand for the UTF-16 indices: the characters looked for
    // are ASCII and only their order is compared
    let slash = [path.rfind('/'), path.rfind('\\')]
        .into_iter()
        .flatten()
        .max();
    let dot = path.rfind('.');
    // `dot > slash + 1`, where a missing index is -1
    let slash_end = slash.map_or(0, |at| at + 1);
    match dot {
        Some(dot) if dot > slash_end => path[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// `pdfSaveAsPickedPath(filePath)`: a dialog that does not add the chosen
/// type's extension (some Linux desktops) leaves a bare name: the default
/// type is PDF.
pub fn pdf_save_as_picked_path(file_path: &str) -> String {
    if extension_of(file_path).is_empty() {
        format!("{file_path}.pdf")
    } else {
        file_path.to_string()
    }
}

/// `pdfSaveAsFormatOf(target)`: what a picked path writes. A known conversion
/// extension selects that conversion; any other name stays a plain PDF copy.
pub fn pdf_save_as_format_of(target: &str) -> PdfSaveAsFormat {
    let ext = extension_of(target);
    PDF_SAVE_AS_ENTRIES
        .iter()
        .find(|entry| entry.extension == ext)
        .map_or(PdfSaveAsFormat::Pdf, |entry| entry.format)
}
