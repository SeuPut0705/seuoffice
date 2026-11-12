//! `apps/docs/src/main/save-as-formats.ts`: the Save As format list of the
//! Word editor.

use jscompat::js_regex;

use super::doc_format::{DocFormat, doc_format_of_path, with_doc_extension};

/// `SaveAsKind`: the document's own formats, or a copy written by an export.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveAsKind {
    Docx,
    Odt,
    Pdf,
    Hwp,
    Hwpx,
    Html,
    Md,
    Png,
}

impl SaveAsKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SaveAsKind::Docx => "docx",
            SaveAsKind::Odt => "odt",
            SaveAsKind::Pdf => "pdf",
            SaveAsKind::Hwp => "hwp",
            SaveAsKind::Hwpx => "hwpx",
            SaveAsKind::Html => "html",
            SaveAsKind::Md => "md",
            SaveAsKind::Png => "png",
        }
    }
}

impl From<DocFormat> for SaveAsKind {
    fn from(format: DocFormat) -> Self {
        match format {
            DocFormat::Docx => SaveAsKind::Docx,
            DocFormat::Odt => SaveAsKind::Odt,
        }
    }
}

/// `SaveAsFilter`
#[derive(Debug, Clone, PartialEq)]
pub struct SaveAsFilter {
    pub name: String,
    pub extensions: Vec<&'static str>,
}

/// `HwpExportFormat`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HwpExportFormat {
    Hwp,
    Hwpx,
}

impl HwpExportFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            HwpExportFormat::Hwp => "hwp",
            HwpExportFormat::Hwpx => "hwpx",
        }
    }
}

/// `EXPORT_KINDS`: export kinds in the order the dialog lists them, with the
/// label key and the extensions each accepts.
const EXPORT_KINDS: [(SaveAsKind, &str, &[&str]); 6] = [
    (SaveAsKind::Pdf, "filterPdf", &["pdf"]),
    (SaveAsKind::Hwp, "filterHwp", &["hwp"]),
    (SaveAsKind::Hwpx, "filterHwpx", &["hwpx"]),
    (SaveAsKind::Html, "filterHtml", &["html", "htm"]),
    (SaveAsKind::Md, "filterMarkdown", &["md", "markdown"]),
    (SaveAsKind::Png, "filterPageImages", &["png"]),
];

/// The dialog's filters: the document's own format first, then the other
/// native format, then (for Save As) every export. `label` is the TypeScript's
/// label function, called in the same order.
pub fn save_as_filters(
    current: DocFormat,
    offer_exports: bool,
    label: &mut dyn FnMut(&str) -> String,
) -> Vec<SaveAsFilter> {
    let word = SaveAsFilter {
        name: label("filterWord"),
        extensions: vec!["docx"],
    };
    let odt = SaveAsFilter {
        name: label("filterOdt"),
        extensions: vec!["odt"],
    };
    let mut filters = if current == DocFormat::Odt {
        vec![odt, word]
    } else {
        vec![word, odt]
    };
    if !offer_exports {
        return filters;
    }
    for (_, key, extensions) in EXPORT_KINDS {
        filters.push(SaveAsFilter {
            name: label(key),
            extensions: extensions.to_vec(),
        });
    }
    filters
}

/// With exports offered the suggestion carries no document extension.
pub fn save_as_default_path(suggestion: &str, offer_exports: bool) -> String {
    if offer_exports {
        js_regex!(r"\.(?:docx|odt)$", "i").replace_all(suggestion, |_| String::new())
    } else {
        suggestion.to_owned()
    }
}

/// `/\.([^./\\]+)$/.exec(filePath)?.[1]?.toLowerCase()`
fn extension_of(file_path: &str) -> Option<String> {
    js_regex!(r"\.([^./\\]+)$")
        .exec(file_path)
        .and_then(|found| found.get(1))
        .map(str::to_lowercase)
}

/// What the dialog's answer means.
pub fn save_as_target(
    file_path: &str,
    current: DocFormat,
    offer_exports: bool,
) -> (String, SaveAsKind) {
    if let Some(native) = doc_format_of_path(file_path) {
        return (file_path.to_owned(), native.into());
    }
    if offer_exports {
        let hit = extension_of(file_path).and_then(|ext| {
            EXPORT_KINDS
                .iter()
                .find(|(_, _, extensions)| extensions.contains(&ext.as_str()))
        });
        if let Some((kind, _, _)) = hit {
            return (file_path.to_owned(), *kind);
        }
    }
    (with_doc_extension(file_path, current), current.into())
}

/// The Hangul export's own dialog: the format new Hangul documents are saved
/// in comes first.
pub fn hwp_export_filters(
    first: HwpExportFormat,
    label: &mut dyn FnMut(&str) -> String,
) -> Vec<SaveAsFilter> {
    let hwp = SaveAsFilter {
        name: label("filterHwp"),
        extensions: vec!["hwp"],
    };
    let hwpx = SaveAsFilter {
        name: label("filterHwpx"),
        extensions: vec!["hwpx"],
    };
    if first == HwpExportFormat::Hwpx {
        vec![hwpx, hwp]
    } else {
        vec![hwp, hwpx]
    }
}

/// The Hangul format a path names; a bare name gets the dialog's default.
pub fn hwp_export_target(file_path: &str, first: HwpExportFormat) -> (String, HwpExportFormat) {
    match extension_of(file_path).as_deref() {
        Some("hwp") => (file_path.to_owned(), HwpExportFormat::Hwp),
        Some("hwpx") => (file_path.to_owned(), HwpExportFormat::Hwpx),
        _ => (format!("{file_path}.{}", first.as_str()), first),
    }
}
