//! `apps/hwp/src/main/save-as-formats.ts`: the Save As format list of the HWP
//! editor. HWP and HWPX are the document's own formats (the document's
//! current one first, so it is the dialog's default type); PDF is a copy
//! written by the PDF export, so picking it leaves the open document as it was.

use jscompat::js_regex;

use super::ipc::HwpFormat;
use super::save_plan::with_format_extension;

/// `HwpSaveAsKind`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HwpSaveAsKind {
    Hwp,
    Hwpx,
    Pdf,
}

impl HwpSaveAsKind {
    pub fn as_str(self) -> &'static str {
        match self {
            HwpSaveAsKind::Hwp => "hwp",
            HwpSaveAsKind::Hwpx => "hwpx",
            HwpSaveAsKind::Pdf => "pdf",
        }
    }
}

/// `SaveAsLabelKey`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveAsLabelKey {
    FilterHwp,
    FilterHwpx,
    FilterPdf,
}

impl SaveAsLabelKey {
    pub fn as_str(self) -> &'static str {
        match self {
            SaveAsLabelKey::FilterHwp => "filterHwp",
            SaveAsLabelKey::FilterHwpx => "filterHwpx",
            SaveAsLabelKey::FilterPdf => "filterPdf",
        }
    }
}

/// `SaveAsFilter`
#[derive(Debug, Clone, PartialEq)]
pub struct SaveAsFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// The dialog's filters: the document's format, the other one, then, for Save As, PDF.
pub fn save_as_filters(
    fallback: HwpFormat,
    offer_exports: bool,
    label: &mut dyn FnMut(SaveAsLabelKey) -> String,
) -> Vec<SaveAsFilter> {
    let hwp = SaveAsFilter {
        name: label(SaveAsLabelKey::FilterHwp),
        extensions: vec!["hwp".to_owned()],
    };
    let hwpx = SaveAsFilter {
        name: label(SaveAsLabelKey::FilterHwpx),
        extensions: vec!["hwpx".to_owned()],
    };
    let mut native = if fallback == HwpFormat::Hwpx {
        vec![hwpx, hwp]
    } else {
        vec![hwp, hwpx]
    };
    if !offer_exports {
        return native;
    }
    native.push(SaveAsFilter {
        name: label(SaveAsLabelKey::FilterPdf),
        extensions: vec!["pdf".to_owned()],
    });
    native
}

/// With PDF offered the suggestion carries no .hwp/.hwpx, so the file type
/// chosen in the dialog supplies the extension (a typed name keeps its own).
pub fn save_as_default_path(suggestion: &str, offer_exports: bool) -> String {
    if !offer_exports {
        return suggestion.to_owned();
    }
    match js_regex!(r"\.hwpx?$", "i").exec(suggestion) {
        Some(found) => format!(
            "{}{}",
            &suggestion[..found.start()],
            &suggestion[found.end()..]
        ),
        None => suggestion.to_owned(),
    }
}

/// What the dialog's answer means. With PDF offered, a .pdf name writes the
/// PDF copy. Anything else (.hwp/.hwpx, or a bare name from a dialog that does
/// not add the chosen type's extension) saves the document as before.
pub fn save_as_target(
    file_path: &str,
    fallback: HwpFormat,
    offer_exports: bool,
) -> (String, HwpSaveAsKind) {
    if offer_exports && js_regex!(r"\.pdf$", "i").test(file_path) {
        return (file_path.to_owned(), HwpSaveAsKind::Pdf);
    }
    let path = with_format_extension(file_path, fallback);
    let kind = if js_regex!(r"\.hwpx$", "i").test(&path) {
        HwpSaveAsKind::Hwpx
    } else {
        HwpSaveAsKind::Hwp
    };
    (path, kind)
}
