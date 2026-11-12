//! `apps/html/src/main/single-file-html.ts`.
//!
//! Single-file HTML export: a copy of the document with every local image
//! reference (img src and CSS url()) inlined as a data URL, so the exported
//! file opens anywhere without the sibling assets/ folder. The working
//! document is never rewritten.

use std::fs;
use std::io::Read;

use jscompat::node_path::host::extname;
use jscompat::{JsMap, base64, js_regex};
use serde::Serialize;

use crate::html::asset_lifecycle::{
    extract_document_image_sources, resolve_safe_relative_image_path,
    rewrite_document_image_sources, scan_css_urls,
};
use crate::html::asset_mime::{ASSET_SNIFF_BYTES, sniff_binary_asset_mime};
use crate::node_fs::namespaced;

/// `SingleFileHtmlResult`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SingleFileHtmlResult {
    pub html: String,
    /// references replaced with data URLs (occurrences, not unique sources)
    pub inlined: usize,
    /// local-looking references that could not be resolved and were left as-is
    pub skipped: Vec<String>,
}

/// `singleFileExportBaseName(name)`: suggested base name for the export. A
/// re-export of an exported copy does not stack suffixes.
pub fn single_file_export_base_name(name: &str) -> String {
    format!(
        "{}.single",
        js_regex!(r"\.single$", "i").replace_all(name, |_| String::new())
    )
}

/// `isExternalRef(source)`: a reference the browser resolves elsewhere: any
/// scheme (http:, data:, ...) or scheme-relative
fn is_external_ref(source: &str) -> bool {
    js_regex!(r"^[a-z][a-z0-9+.-]*:", "i").test(source) || source.starts_with("//")
}

/// `readAsDataUrl(documentPath, source)`
fn read_as_data_url(document_path: &str, source: &str) -> Option<String> {
    let target = resolve_safe_relative_image_path(document_path, source)?;
    let mut bytes = Vec::new();
    fs::File::open(namespaced(&target))
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .ok()?;
    // content decides the type; SVG is text and has no binary signature
    let head = &bytes[..bytes.len().min(ASSET_SNIFF_BYTES)];
    let mime = sniff_binary_asset_mime(head)
        .or_else(|| (extname(&target).to_lowercase() == ".svg").then_some("image/svg+xml"))?;
    if !mime.starts_with("image/") {
        return None;
    }
    Some(format!("data:{mime};base64,{}", base64(&bytes)))
}

/// `rewriteCssUrls(text, dataBySource)`: base64 data URLs contain no spaces,
/// quotes or parens, so the original quoting form stays valid.
fn rewrite_css_urls(text: &str, data_by_source: &JsMap<String>) -> (String, usize) {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut cursor = 0usize;
    let mut output: Vec<u16> = Vec::new();
    let mut rewritten = 0usize;
    for found in scan_css_urls(text) {
        let Some(data) = data_by_source.get(&found.source) else {
            continue;
        };
        output.extend_from_slice(&units[cursor.min(found.start)..found.start]);
        output.extend(format!("url({}{data}{})", found.quote, found.quote).encode_utf16());
        cursor = found.end;
        rewritten += 1;
    }
    if cursor == 0 {
        (text.to_owned(), rewritten)
    } else {
        output.extend_from_slice(&units[cursor..]);
        (String::from_utf16_lossy(&output), rewritten)
    }
}

/// `inlineImagesForSingleFile(text, documentPath)`; `None` is a document that
/// was never saved, whose images are already data URLs.
pub fn inline_images_for_single_file(
    text: &str,
    document_path: Option<&str>,
) -> SingleFileHtmlResult {
    let Some(document_path) = document_path.filter(|path| !path.is_empty()) else {
        return SingleFileHtmlResult {
            html: text.to_owned(),
            inlined: 0,
            skipped: Vec::new(),
        };
    };
    // HTML-only scan: the Markdown-aware scanners would skip every indented <img>
    let image_sources = extract_document_image_sources(text);
    let css_matches = scan_css_urls(text);
    let mut candidates: Vec<String> = Vec::new();
    for source in image_sources
        .iter()
        .cloned()
        .chain(css_matches.iter().map(|found| found.source.clone()))
    {
        if !source.is_empty() && !is_external_ref(&source) && !candidates.contains(&source) {
            candidates.push(source);
        }
    }
    let mut data_by_source: JsMap<String> = JsMap::new();
    let mut skipped: Vec<String> = Vec::new();
    for source in candidates {
        match read_as_data_url(document_path, &source) {
            Some(data) => data_by_source.set(source, data),
            None => skipped.push(source),
        }
    }
    if data_by_source.is_empty() {
        return SingleFileHtmlResult {
            html: text.to_owned(),
            inlined: 0,
            skipped,
        };
    }
    let inlined_imgs = image_sources
        .iter()
        .filter(|source| data_by_source.has(source))
        .count();
    let after_imgs = rewrite_document_image_sources(text, &data_by_source);
    let (html, rewritten) = rewrite_css_urls(&after_imgs, &data_by_source);
    SingleFileHtmlResult {
        html,
        inlined: inlined_imgs + rewritten,
        skipped,
    }
}
