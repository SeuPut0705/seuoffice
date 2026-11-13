//! Copying a slide between two decks (packages/pptx-engine/src/slide-transfer.ts).
//! A bundle carries the slide's XML plus every package part it depends on
//! (media, charts and their embedded workbooks, ...) so the target deck can be
//! a different file - or a different process.
//!
//! Two things keep this simple. Relationship ids only have to be unique inside
//! one part's .rels, so the copied slide keeps the source's rIds verbatim and
//! its XML never needs rewriting. And the layout is not copied: the slide is
//! re-pointed at a layout in the destination, which is what PowerPoint's "use
//! destination theme" paste does.
//!
//! A record keyed by part path (`parts`, `contentTypes`) is a plain object in
//! the TypeScript: a name `Object.prototype` has (`constructor`, `toString`,
//! ...) reads as present there. [`parts_has`] and [`present`] keep that.

use std::collections::{HashMap, HashSet};

use jscompat::{
    JsMap, JsObject, base64, js_regex, math_max, number_to_string, slice_utf16, to_number,
};
use serde::{Deserialize, Serialize};

use crate::layout::{is_object_prototype_name, replace_literal};
use crate::types::SlideSize;
use crate::xml_utils::{
    attribute_of, c_sld_name_of, decode_xml, default_content_type_for, has_content_type_override,
    has_default_for, max_relationship_id_number,
};
use crate::zip::{PackageArchive, Relationship, rels_path_for, resolve_target};

const LAYOUT_REL: &str = "/slideLayout";
const NOTES_REL: &str = "/notesSlide";

/// The depth a recursive walk of the TypeScript may reach before the engine
/// throws a RangeError (the call stack of a JavaScript host).
const MAX_DEPTH: usize = 10_000;
/// The nesting `identical` may reach in Rust before it refuses, as a stack
/// overflow does in JavaScript (a bundle holds a few dozen parts).
const MAX_IDENTICAL_DEPTH: usize = 1_000;

const STACK_OVERFLOW: &str = "RangeError: Maximum call stack size exceeded";
const NOT_A_BUFFER_SOURCE: &str = "TypeError: The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object.";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideBundleRel {
    pub id: String,
    #[serde(rename = "type")]
    pub r#type: String,
    /// absolute source path for internal targets; the raw target for external ones
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external: Option<bool>,
    /// true for the slideLayout rel, which the destination re-points
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<bool>,
}

/// The source layout->master->theme chain, for "keep source formatting" pastes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideBundleChain {
    pub layout_path: String,
    pub master_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme_path: Option<String>,
    /// the chain parts and everything they reference, base64 like `parts`
    pub parts: JsObject<String>,
    pub content_types: JsObject<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideBundle {
    pub slide_xml: String,
    pub rels: Vec<SlideBundleRel>,
    /// every dependency part, base64 so the bundle survives IPC and JSON
    pub parts: JsObject<String>,
    /// ContentType per dependency: keyed by lower-case extension or by part path
    pub content_types: JsObject<String>,
    /// cSld/@name of the source layout, used to find its counterpart by name
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_name: Option<String>,
    /// source deck's slide size, so the caller can warn about a mismatch
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slide_size: Option<SlideSize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain: Option<SlideBundleChain>,
}

/// `{ path: string; name?: string }` of `listLayouts`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayoutRef {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// `Buffer.from(text, 'base64')`: both alphabets, every other character
/// skipped, the first `=` the end.
fn decode_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for c in text.chars() {
        let sextet = match c {
            'A'..='Z' => c as u32 - 65,
            'a'..='z' => c as u32 - 71,
            '0'..='9' => c as u32 + 4,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => continue,
        };
        acc = (acc << 6) | sextet;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// `Buffer.from(text, 'base64').toString('utf8')`
fn decode_base64_text(text: &str) -> String {
    String::from_utf8_lossy(&decode_base64(text)).into_owned()
}

/// `record[key] = value` on a plain object: `__proto__` sets the prototype
/// (a string there changes nothing) and makes no key.
fn assign(record: &mut JsObject<String>, key: &str, value: String) {
    if key != "__proto__" {
        record.set(key, value);
    }
}

/// `if (parts[path])`: an own string that is not empty, or an inherited property.
fn present(parts: &JsObject<String>, path: &str) -> bool {
    match parts.get(path) {
        Some(value) => !value.is_empty(),
        None => is_object_prototype_name(path),
    }
}

/// `parts[path] != null`: any own string, or an inherited property.
fn parts_has(parts: &JsObject<String>, path: &str) -> bool {
    parts.get(path).is_some() || is_object_prototype_name(path)
}

/// `parts[path] == null ? null : Buffer.from(parts[path], 'base64').toString('utf8')`;
/// an inherited property is no string, and `Buffer.from` throws on it.
fn part_text(parts: &JsObject<String>, path: &str) -> Result<Option<String>, String> {
    match parts.get(path) {
        Some(base64) => Ok(Some(decode_base64_text(base64))),
        None if is_object_prototype_name(path) => Err(NOT_A_BUFFER_SOURCE.to_owned()),
        None => Ok(None),
    }
}

fn ext_of(path: &str) -> String {
    match path.rfind('.') {
        Some(dot) => path.get(dot + 1..).unwrap_or_default().to_lowercase(),
        None => String::new(),
    }
}

/// The content type an Override declares for the part; read decoded, so it is escaped when
/// written.
fn override_content_type(ct: Option<&str>, part_path: &str) -> Option<String> {
    let ct = ct.filter(|ct| !ct.is_empty())?;
    let wanted = format!("/{part_path}");
    for tag in js_regex!(r"<Override\b[^>]*>", "g").find_iter(ct) {
        if attribute_of(tag.as_str(), "PartName").as_deref() == Some(wanted.as_str()) {
            return attribute_of(tag.as_str(), "ContentType");
        }
    }
    None
}

/// One call of `collectPart`: the part's own entries written, and the parts its
/// relationships name, in order; `None` where the call returns early.
fn visit_part(
    archive: &PackageArchive,
    part_path: &str,
    parts: &mut JsObject<String>,
    content_types: &mut JsObject<String>,
) -> Result<Option<Vec<String>>, String> {
    if present(parts, part_path) {
        return Ok(None);
    }
    let Some(bytes) = archive.read_bytes(part_path) else {
        return Ok(None);
    };
    assign(parts, part_path, base64(bytes));

    let ct = archive.read_text("[Content_Types].xml");
    let ct = ct.as_deref();
    if let Some(over) = override_content_type(ct, part_path) {
        assign(content_types, part_path, over);
    } else {
        let ext = ext_of(part_path);
        let dflt = ct
            .filter(|ct| !ct.is_empty())
            .and_then(|ct| default_content_type_for(ct, &ext))
            .filter(|dflt| !dflt.is_empty());
        if let (false, Some(dflt)) = (ext.is_empty(), dflt) {
            // keyed by the part's extension, the document's: `__proto__` is an entry like any
            // other
            content_types.set(&ext, dflt);
        }
    }

    let rels_path = rels_path_for(part_path);
    let Some(rels_xml) = archive.read_text(&rels_path).filter(|xml| !xml.is_empty()) else {
        return Ok(None);
    };
    assign(parts, &rels_path, base64(rels_xml.as_bytes()));
    let mut children = Vec::new();
    for rel in archive.read_rels(part_path)?.values() {
        if rel.target_mode.as_deref() == Some("External") {
            continue;
        }
        children.push(resolve_target(part_path, &rel.target));
    }
    Ok(Some(children))
}

/// Walks a part's rel graph, collecting bytes + content types for everything reachable.
/// The recursion of the TypeScript, depth first in the same order, on a stack of the
/// pending targets; a walk deeper than a JavaScript call stack allows is an error.
pub fn collect_part(
    archive: &PackageArchive,
    part_path: &str,
    parts: &mut JsObject<String>,
    content_types: &mut JsObject<String>,
) -> Result<(), String> {
    let mut stack: Vec<std::vec::IntoIter<String>> = Vec::new();
    if let Some(children) = visit_part(archive, part_path, parts, content_types)? {
        stack.push(children.into_iter());
    }
    while let Some(frame) = stack.last_mut() {
        let Some(child) = frame.next() else {
            stack.pop();
            continue;
        };
        if let Some(children) = visit_part(archive, &child, parts, content_types)? {
            if stack.len() >= MAX_DEPTH {
                return Err(STACK_OVERFLOW.to_owned());
            }
            stack.push(children.into_iter());
        }
    }
    Ok(())
}

fn layout_name_of(archive: &PackageArchive, layout_path: &str) -> Option<String> {
    let xml = archive
        .read_text(layout_path)
        .filter(|xml| !xml.is_empty())?;
    c_sld_name_of(&xml)
}

/// Snapshot a slide and its dependencies. `slide_xml` is passed in so callers can
/// hand over the patched (unsaved-edits-included) XML.
pub fn collect_slide_bundle(
    archive: &PackageArchive,
    slide_path: &str,
    slide_xml: &str,
) -> Result<SlideBundle, String> {
    let mut parts = JsObject::new();
    let mut content_types = JsObject::new();
    let mut rels = Vec::new();
    let mut layout_name: Option<String> = None;

    for rel in archive.read_rels(slide_path)?.values() {
        if rel.r#type.ends_with(NOTES_REL) {
            continue;
        }
        if rel.target_mode.as_deref() == Some("External") {
            rels.push(SlideBundleRel {
                id: rel.id.clone(),
                r#type: rel.r#type.clone(),
                target: rel.target.clone(),
                external: Some(true),
                layout: None,
            });
            continue;
        }
        let absolute = resolve_target(slide_path, &rel.target);
        if rel.r#type.ends_with(LAYOUT_REL) {
            layout_name = layout_name_of(archive, &absolute);
            rels.push(SlideBundleRel {
                id: rel.id.clone(),
                r#type: rel.r#type.clone(),
                target: absolute,
                external: None,
                layout: Some(true),
            });
            continue;
        }
        collect_part(archive, &absolute, &mut parts, &mut content_types)?;
        rels.push(SlideBundleRel {
            id: rel.id.clone(),
            r#type: rel.r#type.clone(),
            target: absolute,
            external: None,
            layout: None,
        });
    }

    // malformed source presentation: the size is only used for a warning
    let slide_size = archive
        .read_presentation()
        .ok()
        .map(|presentation| SlideSize {
            cx: presentation.size.cx,
            cy: presentation.size.cy,
        });

    let mut chain = None;
    let c = archive.resolve_slide_chain(slide_path)?;
    if let (Some(layout_path), Some(master_path)) = (
        c.layout_path.filter(|path| !path.is_empty()),
        c.master_path.filter(|path| !path.is_empty()),
    ) {
        let mut chain_parts = JsObject::new();
        let mut chain_ct = JsObject::new();
        // collectPart walks the rel graph: layout -> master -> theme + the master's other layouts + media
        collect_part(archive, &layout_path, &mut chain_parts, &mut chain_ct)?;
        chain = Some(SlideBundleChain {
            layout_path,
            master_path,
            theme_path: c.theme_path.filter(|path| !path.is_empty()),
            parts: chain_parts,
            content_types: chain_ct,
        });
    }

    Ok(SlideBundle {
        slide_xml: slide_xml.to_owned(),
        rels,
        parts,
        content_types,
        layout_name,
        slide_size,
        chain,
    })
}

/// `source.slice(0, source.lastIndexOf('/'))`: with no slash the index is -1 and
/// the last code unit goes.
fn dir_of(path: &str) -> String {
    match path.rfind('/') {
        Some(at) => path.get(..at).unwrap_or_default().to_owned(),
        None => slice_utf16(path, 0.0, Some(-1.0)),
    }
}

/// First `<dir>/<base><n>.<ext>` free in the target archive and not yet allocated this pass.
fn free_path(archive: &PackageArchive, source_path: &str, taken: &HashSet<String>) -> String {
    let dir = dir_of(source_path);
    let file = match source_path.rfind('/') {
        Some(at) => source_path.get(at + 1..).unwrap_or_default(),
        None => source_path,
    };
    let dot = file.rfind('.');
    let stem = dot.map_or(file, |dot| file.get(..dot).unwrap_or_default());
    let ext = dot.map_or("", |dot| file.get(dot..).unwrap_or_default());
    let base = js_regex!(r"^(.*?)(\d+)$")
        .exec(stem)
        .and_then(|found| found.get(1))
        .unwrap_or(stem);
    let mut n: u64 = 1;
    loop {
        let candidate = format!("{dir}/{base}{n}{ext}");
        if !archive.has(&candidate) && !taken.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

fn relative(from_part: &str, to_path: &str) -> String {
    let from_dir = dir_of(from_part);
    let from: Vec<&str> = from_dir.split('/').filter(|s| !s.is_empty()).collect();
    let to: Vec<&str> = to_path.split('/').filter(|s| !s.is_empty()).collect();
    let mut shared = 0;
    while shared < from.len() && shared < to.len() && from.get(shared) == to.get(shared) {
        shared += 1;
    }
    let mut segments: Vec<&str> = vec![".."; from.len() - shared];
    segments.extend(to.get(shared..).unwrap_or_default());
    segments.join("/")
}

fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('"', "&quot;")
}

/// All layout paths in the target, with their display names.
pub fn list_layouts(archive: &PackageArchive) -> Vec<LayoutRef> {
    archive
        .entries()
        .keys()
        .filter(|path| js_regex!(r"^ppt\/slideLayouts\/slideLayout\d+\.xml$").test(path))
        .map(|path| LayoutRef {
            path: path.to_owned(),
            name: layout_name_of(archive, path),
        })
        .collect()
}

/// Writes a bag of bundled parts into `archive` under non-conflicting names,
/// rewriting each part's own rels to wherever its dependencies landed. Returns
/// the source->destination path map.
fn write_parts(
    archive: &mut PackageArchive,
    parts: &JsObject<String>,
    content_types: &JsObject<String>,
    reusable: Option<&HashSet<String>>,
) -> Result<JsMap<String>, String> {
    // rels parts follow their owner, so map the owners first
    let mut path_map: JsMap<String> = JsMap::new();
    let mut taken: HashSet<String> = HashSet::new();
    for (source_path, _) in parts.entries() {
        if source_path.contains("/_rels/") {
            continue;
        }
        if reusable.is_some_and(|reusable| reusable.contains(source_path)) {
            path_map.set(source_path, source_path.to_owned());
            continue;
        }
        let dest = if archive.has(source_path) || taken.contains(source_path) {
            free_path(archive, source_path, &taken)
        } else {
            source_path.to_owned()
        };
        taken.insert(dest.clone());
        path_map.set(source_path, dest);
    }

    for (source_path, base64) in parts.entries() {
        if source_path.contains("/_rels/")
            || reusable.is_some_and(|reusable| reusable.contains(source_path))
        {
            continue;
        }
        let Some(target_path) = path_map.get(source_path).cloned() else {
            continue;
        };
        archive
            .entries_mut()
            .set(target_path.clone(), decode_base64(base64));

        let Some(source_rels) = parts
            .get(&rels_path_for(source_path))
            .filter(|rels| !rels.is_empty())
        else {
            continue;
        };
        // rewrite this part's own targets to wherever their parts landed
        let rels_xml = decode_base64_text(source_rels);
        let rels_xml = js_regex!(r#"Target="([^"]+)""#, "g").replace_all(&rels_xml, |found| {
            let whole = found.as_str();
            let target = found.get(1).unwrap_or_default();
            if js_regex!(r"^[a-z]+:", "i").test(target) {
                return whole.to_owned();
            }
            let absolute = resolve_target(source_path, &decode_xml(target));
            match path_map.get(&absolute).filter(|mapped| !mapped.is_empty()) {
                Some(mapped) => {
                    format!(
                        "Target=\"{}\"",
                        escape_attr(&relative(&target_path, mapped))
                    )
                }
                None => whole.to_owned(),
            }
        });
        archive
            .entries_mut()
            .set(rels_path_for(&target_path), rels_xml.into_bytes());
    }

    ensure_content_types(archive, content_types, &path_map)?;
    Ok(path_map)
}

/// `identical` of `reusableParts`: the part is byte-identical in the target, rels and
/// dependencies included. A name in `memo` is answered as it stands (the cycle guard).
fn identical(
    archive: &PackageArchive,
    parts: &JsObject<String>,
    source_path: &str,
    memo: &mut HashMap<String, bool>,
    depth: usize,
) -> Result<bool, String> {
    if let Some(cached) = memo.get(source_path) {
        return Ok(*cached);
    }
    if depth >= MAX_IDENTICAL_DEPTH {
        return Err(STACK_OVERFLOW.to_owned());
    }
    memo.insert(source_path.to_owned(), false); // cycle guard
    let mut ok = false;
    if let Some(existing) = archive.read_bytes(source_path) {
        // an inherited name has no base64 text: `Buffer.from` throws on it
        let bundled = parts
            .get(source_path)
            .ok_or_else(|| NOT_A_BUFFER_SOURCE.to_owned())?;
        if existing == decode_base64(bundled).as_slice() {
            let rels_path = rels_path_for(source_path);
            let bundled_rels = parts.get(&rels_path);
            let existing_rels = archive.read_text(&rels_path);
            match (bundled_rels, existing_rels) {
                (None, existing_rels) => ok = existing_rels.is_none(),
                (Some(bundled_rels), Some(existing_rels)) => {
                    ok = decode_base64_text(bundled_rels) == existing_rels;
                    if ok {
                        for rel in archive.read_rels(source_path)?.values() {
                            if rel.target_mode.as_deref() == Some("External") {
                                continue;
                            }
                            let dep = resolve_target(source_path, &rel.target);
                            if parts_has(parts, &dep)
                                && !identical(archive, parts, &dep, memo, depth + 1)?
                            {
                                ok = false;
                                break;
                            }
                        }
                    }
                }
                (Some(_), None) => {}
            }
        }
    }
    memo.insert(source_path.to_owned(), ok);
    Ok(ok)
}

/// Parts the target archive already holds byte-identically (same path, same
/// bytes, same rels, dependencies transitively identical too) - those can be
/// shared instead of re-imported, so a same-deck paste never duplicates media.
fn reusable_parts(
    archive: &PackageArchive,
    parts: &JsObject<String>,
) -> Result<HashSet<String>, String> {
    let mut memo: HashMap<String, bool> = HashMap::new();
    let mut reusable = HashSet::new();
    for (source_path, _) in parts.entries() {
        if !source_path.contains("/_rels/") && identical(archive, parts, source_path, &mut memo, 0)?
        {
            reusable.insert(source_path.to_owned());
        }
    }
    Ok(reusable)
}

/// Lands an element-clipboard's dependency parts in `archive` (paste target).
/// Byte-identical parts already present are shared - a same-deck paste writes
/// nothing; a cross-deck paste imports media/charts under non-conflicting names.
/// Returns the source->destination path map.
pub fn import_clipboard_parts(
    archive: &mut PackageArchive,
    parts: &JsObject<String>,
    content_types: &JsObject<String>,
) -> Result<JsMap<String>, String> {
    let reusable = reusable_parts(archive, parts)?;
    write_parts(archive, parts, content_types, Some(&reusable))
}

/// Writes a bundle's dependency parts into `archive` under fresh names and returns
/// the slide's .rels XML, with every rId preserved and the layout rel pointed at
/// `layout_path`. The caller writes the slide part itself.
pub fn materialize_slide_bundle(
    archive: &mut PackageArchive,
    bundle: &SlideBundle,
    slide_path: &str,
    layout_path: &str,
) -> Result<String, String> {
    let path_map = write_parts(archive, &bundle.parts, &bundle.content_types, None)?;

    // The ids are the source deck's own, kept so the slide XML needs no rewriting. They were read
    // decoded, so they are escaped here: an id holding `&` or `"` would break the part otherwise.
    let mut rel_lines = String::new();
    for rel in &bundle.rels {
        let id = escape_attr(&rel.id);
        if rel.layout == Some(true) {
            rel_lines.push_str(&format!(
                "<Relationship Id=\"{id}\" Type=\"{}\" Target=\"{}\"/>",
                rel.r#type,
                escape_attr(&relative(slide_path, layout_path))
            ));
            continue;
        }
        if rel.external == Some(true) {
            rel_lines.push_str(&format!(
                "<Relationship Id=\"{id}\" Type=\"{}\" Target=\"{}\" TargetMode=\"External\"/>",
                rel.r#type,
                escape_attr(&rel.target)
            ));
            continue;
        }
        let mapped = path_map.get(&rel.target).unwrap_or(&rel.target);
        rel_lines.push_str(&format!(
            "<Relationship Id=\"{id}\" Type=\"{}\" Target=\"{}\"/>",
            rel.r#type,
            escape_attr(&relative(slide_path, mapped))
        ));
    }
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         {rel_lines}</Relationships>"
    ))
}

fn ensure_content_types(
    archive: &mut PackageArchive,
    content_types: &JsObject<String>,
    path_map: &JsMap<String>,
) -> Result<(), String> {
    let ct_path = "[Content_Types].xml";
    let Some(mut ct) = archive
        .read_text(ct_path)
        .filter(|ct| !ct.is_empty())
        .map(|ct| ct.into_owned())
    else {
        return Ok(());
    };
    for (key, content_type) in content_types.entries() {
        if key.contains('/') {
            let Some(target_path) = path_map.get(key).filter(|path| !path.is_empty()) else {
                continue;
            };
            let over = format!(
                "<Override PartName=\"/{}\" ContentType=\"{}\"/>",
                escape_attr(target_path),
                escape_attr(content_type)
            );
            if !has_content_type_override(&ct, target_path) {
                ct = replace_literal(&ct, "</Types>", &format!("{over}</Types>"));
            }
        } else {
            if !has_default_for(&ct, key) {
                // A function replacement: the extension and its content type come from the
                // source deck, so they are written as given, escaped (they were read decoded).
                ct = replace_literal(
                    &ct,
                    "</Types>",
                    &format!(
                        "<Default Extension=\"{}\" ContentType=\"{}\"/></Types>",
                        escape_attr(key),
                        escape_attr(content_type)
                    ),
                );
            }
        }
    }
    archive.entries_mut().set(ct_path, ct.into_bytes());
    Ok(())
}

const PRES_PATH: &str = "ppt/presentation.xml";
const MASTER_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster";

/// A target layout whose XML, owning master and theme are byte-identical to the
/// bundled chain - i.e. this chain was already imported (or the decks share the
/// template), so "keep source formatting" can reuse it instead of adding a master.
fn find_identical_layout(
    archive: &PackageArchive,
    master_xml: &str,
    theme_xml: Option<&str>,
    layout_xml: &str,
) -> Result<Option<String>, String> {
    for path in archive.entries().keys() {
        if !js_regex!(r"^ppt\/slideMasters\/slideMaster\d+\.xml$").test(path) {
            continue;
        }
        if archive.read_text(path).as_deref() != Some(master_xml) {
            continue;
        }
        let rels: Vec<Relationship> = archive.read_rels(path)?.values().cloned().collect();
        if let Some(theme_xml) = theme_xml {
            let theme_path = rels
                .iter()
                .find(|r| r.r#type.ends_with("/theme"))
                .map(|rel| resolve_target(path, &rel.target))
                .filter(|path| !path.is_empty());
            let Some(theme_path) = theme_path else {
                continue;
            };
            if archive.read_text(&theme_path).as_deref() != Some(theme_xml) {
                continue;
            }
        }
        for rel in &rels {
            if !rel.r#type.ends_with(LAYOUT_REL) {
                continue;
            }
            let layout_path = resolve_target(path, &rel.target);
            if archive.read_text(&layout_path).as_deref() == Some(layout_xml) {
                return Ok(Some(layout_path));
            }
        }
    }
    Ok(None)
}

/// Register an imported slideMaster with presentation.xml(.rels).
fn register_master(archive: &mut PackageArchive, master_path: &str) -> bool {
    let pres_rels_path = rels_path_for(PRES_PATH);
    let pres = archive.read_text(PRES_PATH).map(|text| text.into_owned());
    let pres_rels = archive
        .read_text(&pres_rels_path)
        .map(|text| text.into_owned());
    let (Some(pres), Some(pres_rels)) = (
        pres.filter(|text| !text.is_empty()),
        pres_rels.filter(|text| !text.is_empty()),
    ) else {
        return false;
    };
    if !pres.contains("</p:sldMasterIdLst>") {
        return false;
    }
    let max_rid = max_relationship_id_number(&pres_rels);
    let rid = format!("rId{}", number_to_string(max_rid + 1.0));
    archive.entries_mut().set(
        pres_rels_path,
        replace_literal(
            &pres_rels,
            "</Relationships>",
            &format!(
                "<Relationship Id=\"{rid}\" Type=\"{MASTER_REL_TYPE}\" Target=\"{}\"/></Relationships>",
                escape_attr(&relative(PRES_PATH, master_path))
            ),
        )
        .into_bytes(),
    );
    // sldMasterId ids must be unique and >= 2147483648
    let mut max_id = 2147483647.0;
    for found in js_regex!(r#"<p:sldMasterId\s[^>]*id="(\d+)""#, "g").find_iter(&pres) {
        max_id = math_max(max_id, to_number(found.get(1).unwrap_or_default()));
    }
    archive.entries_mut().set(
        PRES_PATH,
        replace_literal(
            &pres,
            "</p:sldMasterIdLst>",
            &format!(
                "<p:sldMasterId id=\"{}\" r:id=\"{rid}\"/></p:sldMasterIdLst>",
                number_to_string(max_id + 1.0)
            ),
        )
        .into_bytes(),
    );
    true
}

/// "Keep source formatting": land the bundled layout->master->theme chain in the
/// target (registering the master) and return the layout path the pasted slide
/// should point at. Returns `None` when the bundle has no chain or the target's
/// presentation.xml can't take another master - callers fall back to `choose_layout`.
pub fn import_source_layout(
    archive: &mut PackageArchive,
    bundle: &SlideBundle,
) -> Result<Option<String>, String> {
    let Some(chain) = &bundle.chain else {
        return Ok(None);
    };
    let layout_xml = part_text(&chain.parts, &chain.layout_path)?;
    let master_xml = part_text(&chain.parts, &chain.master_path)?;
    let (Some(layout_xml), Some(master_xml)) = (layout_xml, master_xml) else {
        return Ok(None);
    };
    let theme_xml = match chain.theme_path.as_deref().filter(|path| !path.is_empty()) {
        Some(theme_path) => part_text(&chain.parts, theme_path)?,
        None => None,
    };

    if let Some(existing) =
        find_identical_layout(archive, &master_xml, theme_xml.as_deref(), &layout_xml)?
    {
        return Ok(Some(existing));
    }

    if archive
        .read_text(PRES_PATH)
        .is_none_or(|pres| pres.is_empty() || !pres.contains("</p:sldMasterIdLst>"))
    {
        return Ok(None);
    }
    let path_map = write_parts(archive, &chain.parts, &chain.content_types, None)?;
    let master_path = path_map
        .get(&chain.master_path)
        .filter(|path| !path.is_empty())
        .cloned();
    let layout_path = path_map
        .get(&chain.layout_path)
        .filter(|path| !path.is_empty())
        .cloned();
    let (Some(master_path), Some(layout_path)) = (master_path, layout_path) else {
        return Ok(None);
    };
    if !register_master(archive, &master_path) {
        return Ok(None);
    }
    Ok(Some(layout_path))
}

/// The destination layout for a pasted slide: same name first, else the neighbour's.
pub fn choose_layout(
    archive: &PackageArchive,
    bundle: &SlideBundle,
    neighbour_slide_path: Option<&str>,
) -> Result<Option<String>, String> {
    let layouts = list_layouts(archive);
    if let Some(layout_name) = bundle
        .layout_name
        .as_deref()
        .filter(|name| !name.is_empty())
        && let Some(by_name) = layouts
            .iter()
            .find(|layout| layout.name.as_deref() == Some(layout_name))
    {
        return Ok(Some(by_name.path.clone()));
    }
    if let Some(neighbour) = neighbour_slide_path.filter(|path| !path.is_empty()) {
        let chain = archive.resolve_slide_chain(neighbour)?;
        if let Some(layout_path) = chain.layout_path.filter(|path| !path.is_empty()) {
            return Ok(Some(layout_path));
        }
    }
    Ok(layouts.into_iter().next().map(|layout| layout.path))
}
