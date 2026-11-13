//! `objects/package.ts`: the objects layer's steps around a write-back, and
//! the package changes it hands to re-packing.
//!
//! Order (the assembling code calls these): `prepare_object_write_back`
//! before `rebuild_odt_body`, `object_package_changes` after the patches are
//! applied; then re-pack: drop `changes.remove`, add `changes.add`, and write
//! `META-INF/manifest.xml` as `patch_manifest_xml(original, &changes)`.

use std::collections::HashSet;

use jscompat::{decode_uri_component, js_regex};

use crate::core::convert::{BridgeElementKind, OoxmlToOdfContext};
use crate::core::errors::OdtError;
use crate::core::manifest::read_manifest;
use crate::core::xml::{decode_xml_entities, escape_xml_attr, read_root};

use super::analyze::{href_path, js_sort};
use super::state::{AddedEntry, edited_note, note_key, save_state};

/// `REWRITE_MARK`: appended to a bridge element's XML so the flow hands it to
/// its owner.
pub const REWRITE_MARK: &str = "<!--odt-objects:rewrite-->";

/// `forceRewrite`: marks the bridge element of a paragraph as changed so the
/// text layer rewrites it.
fn force_rewrite(rctx: &mut OoxmlToOdfContext, paragraph_id: usize) -> Result<(), OdtError> {
    let st = save_state(rctx)?;
    st.borrow_mut().dirty_paragraphs.insert(paragraph_id);
    let own = rctx
        .map
        .elements
        .iter()
        .find(|e| e.paragraph == Some(paragraph_id))
        .map(|e| e.id);
    // a paragraph that is no element of its own (a table cell's): the tables of
    // its block are marked, and their owner asks `paragraph_needs_rewrite`
    let block = rctx.map.paragraphs.get(paragraph_id).and_then(|p| p.block);
    let elements: Vec<usize> = match own {
        Some(id) => vec![id],
        None => match block {
            None => Vec::new(),
            Some(block) => rctx
                .map
                .elements
                .iter()
                .filter(|e| e.block == block && e.kind == BridgeElementKind::Table)
                .map(|e| e.id)
                .collect(),
        },
    };
    for id in elements {
        if st.borrow().dirty_elements.iter().any(|d| d.0 == id) {
            continue;
        }
        let xml = rctx.map.elements[id].xml.clone();
        st.borrow_mut().dirty_elements.push((id, xml.clone()));
        rctx.map.elements[id].xml = format!("{xml}{REWRITE_MARK}");
    }
    Ok(())
}

/// `prepareObjectWriteBack`: before `rebuildOdtBody`, a note whose text the
/// editor changed lives in word/footnotes.xml, so its paragraph comes back
/// unchanged and would be copied verbatim. Such paragraphs are marked so the
/// text layer rewrites them (their note references then write the new note
/// bodies). Also warns about comment edits and new comments, which ODT
/// documents do not save.
///
/// For paragraphs that are not bridge elements (table cells) the tables of
/// their block are marked instead; the table layer then asks
/// `paragraph_needs_rewrite` for each cell paragraph.
pub fn prepare_object_write_back(rctx: &mut OoxmlToOdfContext) -> Result<(), OdtError> {
    let st = save_state(rctx)?;
    {
        let mut st = st.borrow_mut();
        if st.prepared {
            return Ok(());
        }
        st.prepared = true;
    }
    let notes = st.borrow().ext.notes.clone();
    for note in &notes {
        let edited = edited_note(rctx, note.kind, &note.id);
        if let Some(edited) = edited
            && edited.text != note.text
        {
            force_rewrite(rctx, note.paragraph)?;
        }
    }
    let comments = rctx.edited.comments.clone();
    for c in &comments {
        let known_text = st.borrow().comment(&c.id).map(|k| k.text.clone());
        match known_text {
            None => rctx.warn("dropped a new comment: ODT documents keep only their own comments"),
            Some(text) if c.text != text => {
                rctx.warn("comment edits are not saved into ODT documents")
            }
            Some(_) => {}
        }
    }
    Ok(())
}

/// `paragraphNeedsRewrite`: whether a paragraph record must be rewritten even
/// though its OOXML came back unchanged (a note in it changed). For owners
/// whose paragraphs are not bridge elements (table cells).
pub fn paragraph_needs_rewrite(rctx: &OoxmlToOdfContext, paragraph_id: usize) -> bool {
    match save_state(rctx) {
        Ok(st) => st.borrow().dirty_paragraphs.contains(&paragraph_id),
        // the slot was read (or refused) by `prepare_object_write_back` already
        Err(_) => false,
    }
}

/// `OdtPackageChanges`
#[derive(Debug, Clone, PartialEq)]
pub struct OdtPackageChanges {
    /// new entries to write (each also needs a manifest entry)
    pub add: Vec<AddedEntry>,
    /// entries nothing references any more (drop them and their manifest entries)
    pub remove: Vec<String>,
}

/// `referencedPaths`: package paths named by any `*:href` of the final parts.
fn referenced_paths(parts: &[Option<&str>]) -> HashSet<String> {
    let mut out = HashSet::new();
    for xml in parts {
        let Some(xml) = jscompat::truthy(*xml) else {
            continue;
        };
        for m in js_regex!(r#"\s[\w.-]+:href\s*=\s*(?:"([^"]*)"|'([^']*)')"#, "g").find_iter(xml) {
            let raw = m.get(1).or_else(|| m.get(2)).unwrap_or("");
            let Some(path) = href_path(&decode_xml_entities(raw)) else {
                continue;
            };
            out.insert(path.strip_suffix('/').unwrap_or(&path).to_string());
            // not percent-encoded: the decode fails and nothing is added
            if let Ok(decoded) = decode_uri_component(&path) {
                out.insert(decoded.strip_suffix('/').unwrap_or(&decoded).to_string());
            }
        }
    }
    out
}

/// The `final` argument of `objectPackageChanges`.
pub struct FinalParts<'a> {
    pub content_xml: &'a str,
    pub styles_xml: Option<&'a str>,
}

/// `objectPackageChanges`: after the patches are applied, the package entries
/// to add (new pictures still referenced) and to remove (entries pictures and
/// objects referenced that nothing references any more). Only entries the
/// bridge recorded for pictures and objects are ever removed. Restores the
/// bridge map changed by `prepare_object_write_back`.
pub fn object_package_changes(
    rctx: &mut OoxmlToOdfContext,
    final_parts: &FinalParts<'_>,
) -> Result<OdtPackageChanges, OdtError> {
    let st = save_state(rctx)?;
    let dirty = std::mem::take(&mut st.borrow_mut().dirty_elements);
    for (id, xml) in dirty {
        rctx.map.elements[id].xml = xml;
    }
    let notes = st.borrow().ext.notes.clone();
    for note in &notes {
        let edited = edited_note(rctx, note.kind, &note.id);
        if let Some(edited) = edited
            && edited.text != note.text
            && !st
                .borrow()
                .emitted_notes
                .contains(&note_key(note.kind, &note.id))
        {
            rctx.warn("a changed note could not be written back; it keeps its original text");
        }
    }
    let referenced = referenced_paths(&[Some(final_parts.content_xml), final_parts.styles_xml]);
    let is_referenced = |entry: &str| {
        let path = entry.strip_suffix('/').unwrap_or(entry);
        if referenced.contains(path) {
            return true;
        }
        referenced
            .iter()
            .any(|r| path.starts_with(&format!("{r}/")))
    };
    let st = st.borrow();
    let mut candidates: Vec<String> = Vec::new();
    for p in &st.ext.pictures {
        for e in &p.entries {
            if !candidates.contains(e) {
                candidates.push(e.clone());
            }
        }
    }
    for p in &st.ext.placeholders {
        for e in &p.entries {
            if !candidates.contains(e) {
                candidates.push(e.clone());
            }
        }
    }
    let mut remove: Vec<String> = candidates
        .into_iter()
        .filter(|e| !is_referenced(e))
        .collect();
    js_sort(&mut remove);
    Ok(OdtPackageChanges {
        add: st
            .added
            .iter()
            .filter(|a| is_referenced(&a.path))
            .cloned()
            .collect(),
        remove,
    })
}

/// `patchManifestXml`: the manifest with the package changes applied: removed
/// entries' elements cut out, new entries appended before the root's end tag;
/// everything else byte for byte.
pub fn patch_manifest_xml(manifest_xml: &str, changes: &OdtPackageChanges) -> String {
    if changes.add.is_empty() && changes.remove.is_empty() {
        return manifest_xml.to_string();
    }
    let manifest = read_manifest(Some(manifest_xml));
    let remove: HashSet<&str> = changes.remove.iter().map(String::as_str).collect();
    let mut cuts: Vec<_> = manifest
        .entries
        .iter()
        .filter(|e| remove.contains(e.full_path.as_str()))
        .collect();
    cuts.sort_by_key(|c| std::cmp::Reverse(c.start));
    let mut out = manifest_xml.to_string();
    for e in cuts {
        out = format!("{}{}", &out[..e.start], &out[e.end..]);
    }
    let present: HashSet<&str> = manifest
        .entries
        .iter()
        .map(|e| e.full_path.as_str())
        .collect();
    let added: Vec<&AddedEntry> = changes
        .add
        .iter()
        .filter(|a| !present.contains(a.path.as_str()))
        .collect();
    if added.is_empty() {
        return out;
    }
    let tag = read_root(&out).map(|root| root.tag.to_string());
    let tag = jscompat::truthy(tag.as_deref());
    let prefix = match tag {
        Some(tag) if tag.contains(':') => format!("{}:", tag.split(':').next().unwrap_or("")),
        _ => "manifest:".to_string(),
    };
    let xml: String = added
        .iter()
        .map(|a| {
            format!(
                "<{prefix}file-entry {prefix}full-path=\"{}\" {prefix}media-type=\"{}\"/>",
                escape_xml_attr(&a.path),
                escape_xml_attr(&a.media_type)
            )
        })
        .collect();
    let close = tag.and_then(|tag| out.rfind(&format!("</{tag}>")));
    match close {
        None => out + &xml,
        Some(close) => format!("{}{}{}", &out[..close], xml, &out[close..]),
    }
}
