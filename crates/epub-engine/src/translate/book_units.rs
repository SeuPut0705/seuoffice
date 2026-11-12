//! `translate/units.ts`, the half that reads an opened book: the contents
//! labels of both tables of contents (`epubTocLabels`) and the translation
//! units of a whole book (`epubTranslationUnits`). The units themselves are in
//! `units.rs`.

use crate::blocks::{ChapterMap, open_chapter};
use crate::package::{nav_toc_entries, ncx_entries};
use crate::translate::units::{
    EpubMetadataLabels, EpubTranslationUnit, chapter_translation_units, metadata_translation_units,
};
use crate::types::EpubBook;
use crate::utf16::units;
use crate::xml::{XmlElement, parse_html, parse_xml};
use crate::xml_positions::PositionsHost;
use crate::xml_positions_types::Thrown;
use jscompat::number_to_string;

const NCX_MEDIA_TYPE: &str = "application/x-dtbncx+xml";

/// `readTree`: the XML tree of an entry, else the HTML tree, else `None`.
/// `Err` is what reading the entry rejects with.
fn read_tree(book: &EpubBook, path: Option<&str>) -> Result<Option<XmlElement>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    let Some(decoded) = book.read_text(path)? else {
        return Ok(None);
    };
    Ok(parse_xml(&decoded.text)
        .or_else(|_| parse_html(&decoded.text))
        .ok())
}

/// The titles of the nav `toc` entries and of the NCX navPoints.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EpubTocLabels {
    pub nav: Vec<String>,
    pub ncx: Vec<String>,
}

/// `epubTocLabels`: the contents labels of both tables of contents a book may
/// carry: the EPUB 3 nav `toc` and the NCX (the spine's `toc` item, else the
/// first NCX in the manifest). A missing or unreadable one gives no labels.
pub fn epub_toc_labels(book: &EpubBook) -> Result<EpubTocLabels, String> {
    let info = &book.info;
    let nav_item = info
        .manifest
        .iter()
        .find(|m| m.properties.iter().any(|p| p == "nav") && m.path.is_some());
    let ncx_by_id = info.spine.toc_id.as_deref().and_then(|toc_id| {
        info.manifest
            .iter()
            .find(|m| m.id == toc_id && m.path.is_some())
    });
    let ncx_item = ncx_by_id.or_else(|| {
        info.manifest
            .iter()
            .find(|m| m.media_type == NCX_MEDIA_TYPE && m.path.is_some())
    });
    let nav_root = match nav_item {
        Some(item) => read_tree(book, item.path.as_deref())?,
        None => None,
    };
    let ncx_root = match ncx_item {
        Some(item) => read_tree(book, item.path.as_deref())?,
        None => None,
    };
    let titles = |entries: Result<Vec<crate::package::RawEntry>, Thrown>| {
        entries
            .map(|entries| entries.into_iter().map(|e| e.title).collect::<Vec<_>>())
            .map_err(|error| error.message)
    };
    Ok(EpubTocLabels {
        nav: match (&nav_root, nav_item) {
            (Some(root), Some(item)) => titles(nav_toc_entries(
                root,
                item.path.as_deref().unwrap_or_default(),
            ))?,
            _ => Vec::new(),
        },
        ncx: match (&ncx_root, ncx_item) {
            (Some(root), Some(item)) => {
                titles(ncx_entries(root, item.path.as_deref().unwrap_or_default()))?
            }
            _ => Vec::new(),
        },
    })
}

/// `EpubSkippedChapter`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpubSkippedChapter {
    pub index: usize,
    pub path: String,
    /// `fixed-layout` or `broken`
    pub reason: &'static str,
}

/// `EpubTranslationUnits`
#[derive(Debug, Clone, PartialEq)]
pub struct EpubTranslationUnits {
    pub units: Vec<EpubTranslationUnit>,
    pub skipped: Vec<EpubSkippedChapter>,
}

/// `chosenIndices`: the chosen spine indices, ascending.
fn chosen_indices(book: &EpubBook, chapters: Option<&[f64]>) -> Result<Vec<usize>, Thrown> {
    let count = book.info.spine.items.len();
    let Some(chapters) = chapters else {
        return Ok(book.info.spine.items.iter().map(|i| i.index).collect());
    };
    let mut chosen: Vec<usize> = Vec::new();
    for &index in chapters {
        if index.fract() != 0.0 || index < 0.0 || index >= count as f64 || index.is_nan() {
            return Err(Thrown::new(
                "RangeError",
                format!(
                    "epub translation: no chapter {} (the book has {count})",
                    number_to_string(index)
                ),
            ));
        }
        if !chosen.contains(&(index as usize)) {
            chosen.push(index as usize);
        }
    }
    chosen.sort_unstable();
    Ok(chosen)
}

/// `epubTranslationUnits`: the translation units of a book: title and
/// contents, then the editable blocks of the chosen chapters in spine order.
/// Chapters are read from the book as it is stored (save before translating).
/// A chapter file listed twice in the spine gives its units once. `Err` is
/// what the TypeScript rejects with.
pub fn epub_translation_units(
    book: &EpubBook,
    chapters: Option<&[f64]>,
) -> Result<EpubTranslationUnits, Thrown> {
    let indices = chosen_indices(book, chapters)?;
    let labels = epub_toc_labels(book).map_err(|message| Thrown::new("Error", message))?;
    let mut out = metadata_translation_units(&EpubMetadataLabels {
        titles: book.info.metadata.titles.iter().map(|t| units(t)).collect(),
        nav: labels.nav.iter().map(|t| units(t)).collect(),
        ncx: labels.ncx.iter().map(|t| units(t)).collect(),
    });
    let mut skipped = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    for index in indices {
        let item = &book.info.spine.items[index];
        if seen.contains(&item.path.as_str()) {
            continue;
        }
        seen.push(&item.path);
        if item.fixed_layout {
            skipped.push(EpubSkippedChapter {
                index,
                path: item.path.clone(),
                reason: "fixed-layout",
            });
            continue;
        }
        let decoded = book
            .read_text(&item.path)
            .map_err(|message| Thrown::new("Error", message))?;
        let map = match decoded.filter(|decoded| decoded.valid) {
            Some(decoded) => Some(open_chapter(&PositionsHost, &units(&decoded.text))?),
            None => None,
        };
        match map {
            Some(ChapterMap::Open(map)) => {
                out.extend(chapter_translation_units(&map, index as f64, &item.path)?);
            }
            _ => skipped.push(EpubSkippedChapter {
                index,
                path: item.path.clone(),
                reason: "broken",
            }),
        }
    }
    Ok(EpubTranslationUnits {
        units: out,
        skipped,
    })
}
