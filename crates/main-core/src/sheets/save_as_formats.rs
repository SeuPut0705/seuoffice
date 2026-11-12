//! `apps/sheets/src/main/save-as-formats.ts`.

use jscompat::js_regex;

/// One dialog file type: `{ name, extensions }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveAsFilter {
    pub name: String,
    pub extensions: Vec<&'static str>,
}

/// The labels of the dialog's file types (`FilterLabel`).
pub const FILTER_XLSX: &str = "filterXlsx";
pub const FILTER_XLSM: &str = "filterXlsm";
pub const FILTER_CSV: &str = "filterCsv";
pub const FILTER_ODS: &str = "filterOds";
pub const FILTER_PDF_ACTIVE_SHEET: &str = "filterPdfActiveSheet";

/// The dialog's file types. A macro workbook keeps .xlsm as its only workbook
/// type; ODS and PDF are whole-workbook / active-sheet copies offered on an
/// explicit Save As only. `label` is called in the order the TypeScript calls
/// it: the copies first.
pub fn sheets_save_as_filters(
    macro_enabled: bool,
    offer_copies: bool,
    label: &mut dyn FnMut(&str) -> String,
) -> Vec<SaveAsFilter> {
    let copies = if offer_copies {
        vec![
            SaveAsFilter {
                name: label(FILTER_ODS),
                extensions: vec!["ods"],
            },
            SaveAsFilter {
                name: label(FILTER_PDF_ACTIVE_SHEET),
                extensions: vec!["pdf"],
            },
        ]
    } else {
        Vec::new()
    };
    let mut filters = if macro_enabled {
        vec![SaveAsFilter {
            name: label(FILTER_XLSM),
            extensions: vec!["xlsm"],
        }]
    } else {
        vec![
            SaveAsFilter {
                name: label(FILTER_XLSX),
                extensions: vec!["xlsx"],
            },
            SaveAsFilter {
                name: label(FILTER_CSV),
                extensions: vec!["csv"],
            },
        ]
    };
    filters.extend(copies);
    filters
}

/// The suggested path without its workbook extension.
pub fn sheets_save_as_suggestion(default_path: &str) -> String {
    js_regex!(r"\.(xlsx|xlsm|xls|csv|tsv|ods)$", "gi").replace_all(default_path, |_| String::new())
}

/// A dot after the last path separator means the name carries an extension;
/// a dot only in a folder name does not.
fn has_extension(file_path: &str) -> bool {
    let after = match file_path.rfind(['/', '\\']) {
        Some(at) => &file_path[at + 1..],
        None => file_path,
    };
    after.contains('.')
}

/// What the person picked (`SheetsSaveAsPick`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveAsKind {
    Workbook,
    Csv,
    Ods,
    Pdf,
    NeedsExtension,
}

impl SaveAsKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SaveAsKind::Workbook => "workbook",
            SaveAsKind::Csv => "csv",
            SaveAsKind::Ods => "ods",
            SaveAsKind::Pdf => "pdf",
            SaveAsKind::NeedsExtension => "needs-extension",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SheetsSaveAsPick {
    pub kind: SaveAsKind,
    pub path: String,
}

/// What the person picked. A typed .pdf, .ods or .csv selects that copy where
/// it is offered; anything else is the workbook, whose extension is added when
/// missing; a bare name with copies on offer asks for an extension.
pub fn resolve_sheets_save_as_pick(
    file_path: &str,
    macro_enabled: bool,
    offer_copies: bool,
) -> SheetsSaveAsPick {
    let lower = file_path.to_lowercase();
    let pick = |kind| SheetsSaveAsPick {
        kind,
        path: file_path.to_owned(),
    };
    if offer_copies && lower.ends_with(".pdf") {
        return pick(SaveAsKind::Pdf);
    }
    if offer_copies && lower.ends_with(".ods") {
        return pick(SaveAsKind::Ods);
    }
    if !macro_enabled && lower.ends_with(".csv") {
        return pick(SaveAsKind::Csv);
    }
    if offer_copies && !has_extension(file_path) {
        return pick(SaveAsKind::NeedsExtension);
    }
    let ext = if macro_enabled { "xlsm" } else { "xlsx" };
    SheetsSaveAsPick {
        kind: SaveAsKind::Workbook,
        path: if lower.ends_with(&format!(".{ext}")) {
            file_path.to_owned()
        } else {
            format!("{file_path}.{ext}")
        },
    }
}

/// `SaveAsExportTargets`: one-shot authorization of a Save As › PDF target,
/// by webContents id (a `Map` key: NaN is NaN, -0 is 0).
#[derive(Debug, Default)]
pub struct SaveAsExportTargets {
    targets: Vec<(f64, String)>,
}

fn same_id(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

impl SaveAsExportTargets {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn authorize(&mut self, wc_id: f64, file_path: &str) {
        match self.targets.iter_mut().find(|(id, _)| same_id(*id, wc_id)) {
            Some(entry) => entry.1 = file_path.to_owned(),
            None => self.targets.push((wc_id, file_path.to_owned())),
        }
    }

    pub fn take(&mut self, wc_id: f64, file_path: &str) -> bool {
        let Some(at) = self.targets.iter().position(|(id, _)| same_id(*id, wc_id)) else {
            return false;
        };
        if self.targets[at].1 != file_path {
            return false;
        }
        self.targets.remove(at);
        true
    }

    pub fn forget(&mut self, wc_id: f64) {
        self.targets.retain(|(id, _)| !same_id(*id, wc_id));
    }
}
