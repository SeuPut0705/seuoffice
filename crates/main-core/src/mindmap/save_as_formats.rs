//! `apps/mindmap/src/main/save-as-formats.ts`: the Save As format list of the
//! mind map editor.

use jscompat::js_regex;

pub use crate::docs::save_as_formats::SaveAsFilter;

/// `ExportFormat` and `'xmind'`: `MapSaveAsKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MapSaveAsKind {
    Xmind,
    Png,
    Svg,
    Pdf,
    Markdown,
}

impl MapSaveAsKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MapSaveAsKind::Xmind => "xmind",
            MapSaveAsKind::Png => "png",
            MapSaveAsKind::Svg => "svg",
            MapSaveAsKind::Pdf => "pdf",
            MapSaveAsKind::Markdown => "markdown",
        }
    }
}

/// `EXPORT_KINDS`: export kinds in the order the dialog lists them, with the
/// label key and the extensions each accepts.
const EXPORT_KINDS: [(MapSaveAsKind, &str, &str); 4] = [
    (MapSaveAsKind::Png, "filterPng", "png"),
    (MapSaveAsKind::Svg, "filterSvg", "svg"),
    (MapSaveAsKind::Pdf, "filterPdf", "pdf"),
    (MapSaveAsKind::Markdown, "filterOutline", "md"),
];

/// The dialog's filters: the map's own format first, then (for Save As) every
/// export. `label` is called in the order the TypeScript calls it.
pub fn save_as_filters(
    offer_exports: bool,
    label: &mut dyn FnMut(&str) -> String,
) -> Vec<SaveAsFilter> {
    let map = SaveAsFilter {
        name: label("filterMindmap"),
        extensions: vec!["xmind"],
    };
    if !offer_exports {
        return vec![map];
    }
    let mut filters = vec![map];
    for (_, key, extension) in EXPORT_KINDS {
        filters.push(SaveAsFilter {
            name: label(key),
            extensions: vec![extension],
        });
    }
    filters
}

/// With exports offered the suggestion carries no `.xmind`.
pub fn save_as_default_path(suggestion: &str, offer_exports: bool) -> String {
    if offer_exports {
        js_regex!(r"\.xmind$", "i").replace_all(suggestion, |_| String::new())
    } else {
        suggestion.to_owned()
    }
}

/// What the dialog's answer means: with exports offered a known export
/// extension writes that copy; anything else saves the map as `.xmind`.
pub fn save_as_target(file_path: &str, offer_exports: bool) -> (String, MapSaveAsKind) {
    if offer_exports {
        let ext = js_regex!(r"\.([^./\\]+)$")
            .exec(file_path)
            .and_then(|found| found.get(1))
            .map(str::to_lowercase);
        let hit = ext.and_then(|ext| {
            EXPORT_KINDS
                .iter()
                .find(|(_, _, extension)| *extension == ext)
        });
        if let Some((kind, _, _)) = hit {
            return (file_path.to_owned(), *kind);
        }
    }
    let path = if js_regex!(r"\.xmind$", "i").test(file_path) {
        file_path.to_owned()
    } else {
        format!("{file_path}.xmind")
    };
    (path, MapSaveAsKind::Xmind)
}
