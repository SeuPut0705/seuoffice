//! `apps/slides/src/main/save-as-formats.ts`.

use jscompat::js_regex;
use serde::Serialize;

use crate::packages::electron_utils::numbered_export_paths::{RangeError, numbered_export_paths};

/// `SlidesSaveAsPick`: `{ kind, path }`
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SlidesSaveAsPick {
    pub kind: &'static str,
    pub path: String,
}

/// one file type of the dialog: `{ name, extensions }`
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

fn filter(name: &str, extension: &str) -> FileFilter {
    FileFilter {
        name: name.to_owned(),
        extensions: vec![extension.to_owned()],
    }
}

/// `slidesSaveAsFilters(label)`: `label('filterPngSlides')` is the PNG entry's name
pub fn slides_save_as_filters(label: &dyn Fn(&str) -> String) -> Vec<FileFilter> {
    vec![
        filter("PowerPoint", "pptx"),
        filter("PDF", "pdf"),
        filter(&label("filterPngSlides"), "png"),
    ]
}

/// `slidesSaveAsSuggestion(defaultPath)`: `defaultPath.replace(/\.pptx$/i, '')`
pub fn slides_save_as_suggestion(default_path: &str) -> String {
    let re = js_regex!(r"\.pptx$", "i");
    jscompat::replace_first_with(re, default_path, |_| String::new())
}

/// `resolveSlidesSaveAsPick(filePath)`
pub fn resolve_slides_save_as_pick(file_path: &str) -> SlidesSaveAsPick {
    let lower = file_path.to_lowercase();
    if lower.ends_with(".pdf") {
        return SlidesSaveAsPick {
            kind: "pdf",
            path: file_path.to_owned(),
        };
    }
    if lower.ends_with(".png") {
        return SlidesSaveAsPick {
            kind: "png",
            path: file_path.to_owned(),
        };
    }
    // Math.max(lastIndexOf('/'), lastIndexOf('\\')), -1 for none: an offset
    // is compared with another offset of the same text, so bytes do as units
    let slash = [file_path.rfind('/'), file_path.rfind('\\')]
        .into_iter()
        .flatten()
        .max()
        .map_or(-1, |i| i as i64);
    let has_ext = file_path
        .rfind('.')
        .is_some_and(|dot| dot as i64 > slash + 1);
    SlidesSaveAsPick {
        kind: "pptx",
        path: if has_ext {
            file_path.to_owned()
        } else {
            format!("{file_path}.pptx")
        },
    }
}

/// `SaveAsImageTargets`: a `Map<number, string>` of the target authorized per tab
#[derive(Debug, Default)]
pub struct SaveAsImageTargets {
    targets: Vec<(f64, String)>,
}

/// `Map` keys compare by SameValueZero: NaN is NaN, -0 is 0
fn same_key(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

impl SaveAsImageTargets {
    pub fn new() -> Self {
        Self::default()
    }

    /// `authorize(wcId, filePath)`
    pub fn authorize(&mut self, wc_id: f64, file_path: &str) {
        match self.targets.iter_mut().find(|(k, _)| same_key(*k, wc_id)) {
            Some(slot) => slot.1 = file_path.to_owned(),
            None => self.targets.push((wc_id, file_path.to_owned())),
        }
    }

    /// `take(wcId, filePath, count)`: the numbered paths for `count` slides, or
    /// `None` when the target was not authorized for this tab
    pub fn take(
        &mut self,
        wc_id: f64,
        file_path: &str,
        count: f64,
    ) -> Result<Option<Vec<String>>, RangeError> {
        let held = self.targets.iter().find(|(k, _)| same_key(*k, wc_id));
        if held.map(|(_, path)| path.as_str()) != Some(file_path) {
            return Ok(None);
        }
        self.forget(wc_id);
        numbered_export_paths(file_path, count).map(Some)
    }

    /// `forget(wcId)`
    pub fn forget(&mut self, wc_id: f64) {
        self.targets.retain(|(k, _)| !same_key(*k, wc_id));
    }
}
