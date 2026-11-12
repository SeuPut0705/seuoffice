//! `toc.ts`: the table of contents (spec 4, "Contents"): the EPUB 3 navigation
//! document's `toc` nav, else the EPUB 2 NCX, else one entry per spine item
//! titled by the chapter's first heading or, failing that, its file name. The
//! tree readers (`navTocEntries`, `ncxEntries`) are in `package.rs`.
//!
//! `buildToc` was async over `readText`; reading is synchronous here, and an
//! `Err` of a source is the message of what the TypeScript's read rejects with.

use std::collections::HashMap;

use crate::package::{RawEntry, lower_is, nav_toc_entries, ncx_entries, title_of, walk};
use crate::primitives::{DecodedText, file_name_of};
use crate::types::{EpubManifestItem, EpubSpine, EpubToc, EpubTocEntry};
use crate::xml::{XmlElement, parse_html, parse_xml};

const NCX_MEDIA_TYPE: &str = "application/x-dtbncx+xml";

pub struct TocSources<'a> {
    pub manifest: &'a [EpubManifestItem],
    pub spine: &'a EpubSpine,
    /// the archive's own name for a resolved path (exact, else case-insensitive), or `None`
    pub find_entry: &'a dyn Fn(&str) -> Option<String>,
    pub read_text: &'a dyn Fn(&str) -> Result<Option<DecodedText>, String>,
}

/// `parseLenient`: parses as XML; markup only an HTML parser accepts is read
/// the way a browser would. `None` is what `readTree` makes of a throw.
fn parse_lenient(text: &str) -> Option<XmlElement> {
    parse_xml(text).or_else(|_| parse_html(text)).ok()
}

/// `readTree`
fn read_tree(sources: &TocSources, path: Option<&str>) -> Result<Option<XmlElement>, String> {
    let Some(name) = path.and_then(|path| (sources.find_entry)(path)) else {
        return Ok(None);
    };
    let Some(decoded) = (sources.read_text)(&name)? else {
        return Ok(None);
    };
    Ok(parse_lenient(&decoded.text))
}

/// `firstHeading`: the first heading's text in a chapter, or `""` when it has none.
fn first_heading(root: &XmlElement) -> String {
    for el in walk(root) {
        if !["h1", "h2", "h3", "h4", "h5", "h6"]
            .iter()
            .any(|heading| lower_is(&el.local, heading))
        {
            continue;
        }
        let title = title_of(el);
        if !title.is_empty() {
            return title;
        }
    }
    String::new()
}

/// `buildToc`
pub fn build_toc(sources: &TocSources) -> Result<EpubToc, String> {
    let mut spine_index: HashMap<&str, usize> = HashMap::new();
    for item in &sources.spine.items {
        spine_index.entry(item.path.as_str()).or_insert(item.index);
    }
    let finish = |source: &'static str, raw: Vec<RawEntry>| EpubToc {
        source,
        entries: raw
            .into_iter()
            .map(|entry| {
                let path = entry
                    .path
                    .map(|path| (sources.find_entry)(&path).unwrap_or(path));
                let spine_index = path
                    .as_deref()
                    .and_then(|path| spine_index.get(path).copied());
                EpubTocEntry {
                    title: entry.title,
                    path,
                    fragment: entry.fragment,
                    depth: entry.depth,
                    spine_index,
                }
            })
            .collect(),
    };

    if let Some(nav) = sources
        .manifest
        .iter()
        .find(|m| m.properties.iter().any(|p| p == "nav") && m.path.is_some())
    {
        let entries = match read_tree(sources, nav.path.as_deref())? {
            Some(root) => nav_toc_entries(&root, nav.path.as_deref().unwrap_or_default())
                .map_err(|error| error.message)?,
            None => Vec::new(),
        };
        if !entries.is_empty() {
            return Ok(finish("nav", entries));
        }
    }

    let by_id = sources.spine.toc_id.as_deref().and_then(|toc_id| {
        sources
            .manifest
            .iter()
            .find(|m| m.id == toc_id && m.path.is_some())
    });
    let ncx = by_id.or_else(|| {
        sources
            .manifest
            .iter()
            .find(|m| m.media_type == NCX_MEDIA_TYPE && m.path.is_some())
    });
    if let Some(ncx) = ncx {
        let entries = match read_tree(sources, ncx.path.as_deref())? {
            Some(root) => ncx_entries(&root, ncx.path.as_deref().unwrap_or_default())
                .map_err(|error| error.message)?,
            None => Vec::new(),
        };
        if !entries.is_empty() {
            return Ok(finish("ncx", entries));
        }
    }

    let mut from_spine = Vec::new();
    for item in &sources.spine.items {
        let heading = match read_tree(sources, Some(&item.path))? {
            Some(root) => first_heading(&root),
            None => String::new(),
        };
        from_spine.push(RawEntry {
            title: if heading.is_empty() {
                file_name_of(&item.path).to_owned()
            } else {
                heading
            },
            path: Some(item.path.clone()),
            fragment: None,
            depth: 1,
        });
    }
    Ok(finish("spine", from_spine))
}
