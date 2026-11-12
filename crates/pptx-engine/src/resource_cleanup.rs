//! Port of packages/pptx-engine/src/resource-cleanup.ts: relationship-aware
//! cleanup for package parts dropped by slide mutations.
//!
//! A media/chart part cannot be removed merely because one shape stopped
//! using it: duplicated slides and copied objects may point at the same
//! target. Cleanup first removes only relationships no longer used by the
//! owning XML, then collects the now-unreachable resource subgraph.
//!
//! A JavaScript `Set` iterates in insertion order and a `Map` too; both are
//! [`JsMap`]s here (a [`Set`] holds `()`), so every walk takes the order the
//! TypeScript's does.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use jscompat::{JsMap, js_regex};
use serde::Serialize;

use crate::deck::OpenedPptx;
use crate::types::{ByteAnchor, Slide, SlideElement};
use crate::zip::{PackageArchive, rels_path_for, resolve_target};

/// `ResourceCleanupStats`
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceCleanupStats {
    pub relationships_removed: usize,
    pub parts_removed: usize,
    pub bytes_removed: usize,
}

/// A JavaScript `Set<string>`.
type Set = JsMap<()>;

const MODEL_3D_MARKER: &str = "aislides-3d:";

/// Shape-tree parts: the only ones a cNvPr@descr 3D marker can live in.
const MODEL_3D_PART_PREFIXES: [&str; 3] = ["ppt/slides/", "ppt/slideLayouts/", "ppt/slideMasters/"];

/// Parts below these directories are owned by a slide object/slide and can be
/// collected once no retained package part points at them.
const OWNED_RESOURCE_PREFIXES: [&str; 18] = [
    "ppt/media/",
    "ppt/charts/",
    "ppt/embeddings/",
    "ppt/diagrams/",
    "ppt/drawings/",
    "ppt/oleObjects/",
    "ppt/activeX/",
    "ppt/ctrlProps/",
    "ppt/controls/",
    "ppt/tags/",
    "ppt/notesSlides/",
    "ppt/comments/",
    "ppt/threadedComments/",
    "ppt/printerSettings/",
    "ppt/vmlDrawings/",
    "ppt/ink/",
    "ppt/model3d/",
    "ppt/models3d/",
];

/// `isOwnedResourcePath`
fn is_owned_resource_path(path: &str) -> bool {
    OWNED_RESOURCE_PREFIXES
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

/// `attributeValues`
fn attribute_values(xml: &str) -> HashSet<String> {
    js_regex!(r#"\s[\w:.-]+\s*=\s*(["'])(.*?)\1"#, "g")
        .find_iter(xml)
        .map(|m| m.get(2).unwrap_or_default().to_owned())
        .collect()
}

/// `model3dRefs`
fn model3d_refs(xml: &str) -> Set {
    let mut out = Set::new();
    if !xml.contains(MODEL_3D_MARKER) {
        return out;
    }
    for m in js_regex!(r#"aislides-3d:(ppt\/media\/[^"'&<\s]+)"#, "g").find_iter(xml) {
        out.set(m.get(1).unwrap_or_default(), ());
    }
    out
}

/// `mayCarryModel3dRef`
fn may_carry_model3d_ref(path: &str) -> bool {
    if !path.ends_with(".xml") || path.contains("/_rels/") {
        return false;
    }
    MODEL_3D_PART_PREFIXES
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

/// `hasModel3dMarker`
fn has_model3d_marker(bytes: &[u8]) -> bool {
    bytes
        .windows(MODEL_3D_MARKER.len())
        .any(|window| window == MODEL_3D_MARKER.as_bytes())
}

/// `el.anchor` of any element.
fn anchor_of(el: &SlideElement) -> Option<&ByteAnchor> {
    crate::with_element!(el, e => (*e.anchor).as_ref())
}

/// `currentSlideXml`: the slide's prefix, every element's original bytes with
/// its gap, then the suffix.
fn current_slide_xml(slide: &Slide) -> String {
    let mut out = String::from(slide.body_prefix.as_deref().unwrap_or(""));
    for element in (*slide.elements).as_deref().unwrap_or(&[]) {
        if let Some(anchor) = anchor_of(element) {
            out.push_str(&anchor.original_xml);
            if let Some(gap) = &anchor.gap_after {
                out.push_str(gap);
            }
        }
    }
    out.push_str(slide.body_suffix.as_deref().unwrap_or(""));
    out
}

/// `sourcePartForRels`
fn source_part_for_rels(path: &str) -> Option<String> {
    if path == "_rels/.rels" {
        return Some(String::new());
    }
    let marker = "/_rels/";
    let marker_at = path.rfind(marker)?;
    if !path.ends_with(".rels") {
        return None;
    }
    let dir = path.get(..marker_at).unwrap_or_default();
    // path.slice(markerAt + marker.length, -'.rels'.length)
    let name = path
        .get(marker_at + marker.len()..path.len().saturating_sub(".rels".len()))
        .unwrap_or_default();
    Some(format!("{dir}/{name}"))
}

/// `stripRelationships`
fn strip_relationships(xml: &str, ids: &HashSet<String>) -> String {
    js_regex!(r"<Relationship\b[^>]*\/\s*>", "g").replace_all(xml, |m| {
        let tag = m.as_str();
        let id = js_regex!(r#"\bId\s*=\s*(["'])(.*?)\1"#)
            .exec(tag)
            .and_then(|found| found.get(2))
            .filter(|id| !id.is_empty());
        match id {
            Some(id) if ids.contains(id) => String::new(),
            _ => tag.to_owned(),
        }
    })
}

/// Drop `path` from the entries, the order of the others kept (`entries.delete`).
fn delete_entry(archive: &mut PackageArchive, path: &str) {
    if !archive.has(path) {
        return;
    }
    let entries = std::mem::take(archive.entries_mut());
    *archive.entries_mut() = entries.into_iter().filter(|(key, _)| key != path).collect();
}

/// `removeContentTypeOverrides`
fn remove_content_type_overrides(archive: &mut PackageArchive, removed_parts: &Set) {
    if removed_parts.is_empty() {
        return;
    }
    let path = "[Content_Types].xml";
    let Some(xml) = archive
        .read_text(path)
        .filter(|xml| !xml.is_empty())
        .map(|xml| xml.into_owned())
    else {
        return;
    };
    let next = js_regex!(r"<Override\b[^>]*\/\s*>", "g").replace_all(&xml, |m| {
        let tag = m.as_str();
        let part_name = js_regex!(r#"\bPartName\s*=\s*(["'])(.*?)\1"#)
            .exec(tag)
            .and_then(|found| found.get(2))
            .filter(|name| !name.is_empty())
            .map(|name| name.strip_prefix('/').unwrap_or(name));
        match part_name {
            Some(name) if !name.is_empty() && removed_parts.has(name) => String::new(),
            _ => tag.to_owned(),
        }
    });
    if next != xml {
        archive.entries_mut().set(path, next.into_bytes());
    }
}

/// `packageRelationshipGraph`: `(outgoing, incoming)` edges between parts.
fn package_relationship_graph(
    archive: &PackageArchive,
) -> Result<(JsMap<Set>, JsMap<Set>), String> {
    fn add_edge(edges: &mut JsMap<Set>, key: &str, value: &str) {
        if let Some(set) = edges.get_mut(key) {
            set.set(value, ());
            return;
        }
        let mut set = Set::new();
        set.set(value, ());
        edges.set(key, set);
    }
    let mut outgoing: JsMap<Set> = JsMap::new();
    let mut incoming: JsMap<Set> = JsMap::new();
    for path in archive.entries().keys() {
        if !path.ends_with(".rels") {
            continue;
        }
        let Some(source) = source_part_for_rels(path) else {
            continue;
        };
        if !source.is_empty() && !archive.has(&source) {
            continue;
        }
        for rel in archive.read_rels(&source)?.values() {
            if rel.target_mode.as_deref() == Some("External") {
                continue;
            }
            let target = resolve_target(&source, &rel.target);
            add_edge(&mut outgoing, &source, &target);
            add_edge(&mut incoming, &target, &source);
        }
    }
    Ok((outgoing, incoming))
}

/// `removeUnreferencedOwnedParts`: remove the candidate resource closure only
/// when it has no incoming edge from a retained package part. If a shared
/// chart/image is retained, its dependencies are retained too.
fn remove_unreferenced_owned_parts(
    archive: &mut PackageArchive,
    initial_candidates: &Set,
    xml_overrides: &HashMap<String, String>,
) -> Result<ResourceCleanupStats, String> {
    let (outgoing, incoming) = package_relationship_graph(archive)?;
    let mut closure = Set::new();
    let mut pending: Vec<String> = initial_candidates.keys().map(str::to_owned).collect();
    while let Some(path) = pending.pop() {
        if closure.has(&path) || !is_owned_resource_path(&path) || !archive.has(&path) {
            continue;
        }
        closure.set(path.clone(), ());
        if let Some(targets) = outgoing.get(&path) {
            for target in targets.keys() {
                if is_owned_resource_path(target) {
                    pending.push(target.to_owned());
                }
            }
        }
    }
    if closure.is_empty() {
        return Ok(ResourceCleanupStats::default());
    }

    let mut retained = Set::new();
    for path in closure.keys() {
        if let Some(sources) = incoming.get(path) {
            for source in sources.keys() {
                if !closure.has(source) {
                    retained.set(path, ());
                    break;
                }
            }
        }
    }

    // SeuOffice's simplified 3D placeholder records the model path in cNvPr@descr
    // rather than an OOXML relationship, so include those direct references.
    for (path, bytes) in archive.entries().iter() {
        if closure.has(path) || !may_carry_model3d_ref(path) {
            continue;
        }
        let over = xml_overrides.get(path);
        if over.is_none() && !has_model3d_marker(bytes) {
            continue;
        }
        let xml: Cow<'_, str> = match over {
            Some(xml) => Cow::Borrowed(xml.as_str()),
            None => String::from_utf8_lossy(bytes),
        };
        for target in model3d_refs(&xml).keys() {
            if closure.has(target) {
                retained.set(target, ());
            }
        }
    }

    let mut propagate: Vec<String> = retained.keys().map(str::to_owned).collect();
    while let Some(source) = propagate.pop() {
        if let Some(targets) = outgoing.get(&source) {
            for target in targets.keys() {
                if closure.has(target) && !retained.has(target) {
                    retained.set(target, ());
                    propagate.push(target.to_owned());
                }
            }
        }
    }

    let mut removed = Set::new();
    let mut bytes_removed = 0;
    for path in closure.keys() {
        if retained.has(path) {
            continue;
        }
        let Some(length) = archive.entries().get(path).map(Vec::len) else {
            continue;
        };
        bytes_removed += length;
        removed.set(path, ());
        delete_entry(archive, path);
        delete_entry(archive, &rels_path_for(path));
    }
    remove_content_type_overrides(archive, &removed);
    Ok(ResourceCleanupStats {
        relationships_removed: 0,
        parts_removed: removed.len(),
        bytes_removed,
    })
}

/// `removeRelationshipsAndCollectOwnedTargets`: remove selected relationship
/// rows and collect their now-unreferenced owned targets. The package graph
/// is rebuilt after the rows are removed, so another relationship to the same
/// target keeps that target and its dependency closure.
fn remove_relationships_and_collect_owned_targets(
    archive: &mut PackageArchive,
    source_part: &str,
    relationship_ids: &[String],
    extra_candidates: &Set,
    xml_overrides: &HashMap<String, String>,
) -> Result<ResourceCleanupStats, String> {
    let rels = archive.read_rels(source_part)?;
    let mut ids: HashSet<String> = HashSet::new();
    let mut candidates = extra_candidates.clone();
    for id in relationship_ids {
        let Some(rel) = rels.get(id) else {
            continue;
        };
        ids.insert(id.clone());
        if rel.target_mode.as_deref() != Some("External") {
            let target = resolve_target(source_part, &rel.target);
            if is_owned_resource_path(&target) {
                candidates.set(target, ());
            }
        }
    }

    if !ids.is_empty() {
        let path = rels_path_for(source_part);
        let xml = archive
            .read_text(&path)
            .filter(|xml| !xml.is_empty())
            .map(|xml| xml.into_owned());
        if let Some(xml) = xml {
            let stripped = strip_relationships(&xml, &ids);
            archive.entries_mut().set(path, stripped.into_bytes());
        }
    }

    let collected = remove_unreferenced_owned_parts(archive, &candidates, xml_overrides)?;
    Ok(ResourceCleanupStats {
        relationships_removed: ids.len(),
        parts_removed: collected.parts_removed,
        bytes_removed: collected.bytes_removed,
    })
}

/// `cleanupSupersededSlideResources`: compare XML from before and after a
/// slide mutation. Relationship ids that disappeared from the live slide are
/// pruned, then their unshared owned targets are collected. Callers pass the
/// fully patched current slide XML so pending in-memory edits participate in
/// the liveness check. The slide is `opened.deck.slides[slide_index]`.
pub fn cleanup_superseded_slide_resources(
    opened: &mut OpenedPptx,
    slide_index: usize,
    previous_xml: &str,
    current_xml: &str,
) -> Result<ResourceCleanupStats, String> {
    let OpenedPptx { deck, archive, .. } = opened;
    let Some(slide) = deck.slides.get(slide_index) else {
        return Err("cleanup: no such slide".to_owned());
    };
    let slide_path = slide.path.as_deref().unwrap_or("").to_owned();
    let rels = archive.read_rels(&slide_path)?;
    let previous_values = attribute_values(previous_xml);
    let current_values = attribute_values(current_xml);
    let mut live_slide_xml: HashMap<String, String> = HashMap::new();
    for deck_slide in &deck.slides {
        live_slide_xml.insert(
            deck_slide.path.as_deref().unwrap_or("").to_owned(),
            current_slide_xml(deck_slide),
        );
    }
    live_slide_xml.insert(slide_path.clone(), current_xml.to_owned());
    let mut ids: Vec<String> = Vec::new();
    let mut candidates = Set::new();
    for id in rels.keys() {
        if !previous_values.contains(id) || current_values.contains(id) {
            continue;
        }
        ids.push(id.to_owned());
    }

    let current_models = model3d_refs(current_xml);
    for target in model3d_refs(previous_xml).keys() {
        if !current_models.has(target) {
            candidates.set(target, ());
        }
    }

    remove_relationships_and_collect_owned_targets(
        archive,
        &slide_path,
        &ids,
        &candidates,
        &live_slide_xml,
    )
}

/// `cleanupDeletedElementResources`: called after an element has left
/// `slide.elements`. It removes relationship rows used only by that element,
/// then collects unshared media/chart dependency parts.
pub fn cleanup_deleted_element_resources(
    opened: &mut OpenedPptx,
    slide_index: usize,
    removed_element_xml: &str,
) -> Result<ResourceCleanupStats, String> {
    let Some(slide) = opened.deck.slides.get(slide_index) else {
        return Err("cleanup: no such slide".to_owned());
    };
    let current = current_slide_xml(slide);
    cleanup_superseded_slide_resources(opened, slide_index, removed_element_xml, &current)
}

/// `removeRelationshipAndCollectOwnedTarget`: remove one explicit
/// relationship and collect its internal owned target only when no retained
/// package relationship still points at it. This covers relationship-owned
/// parts (such as a slide's comments part) that are not referenced from the
/// source XML.
pub fn remove_relationship_and_collect_owned_target(
    archive: &mut PackageArchive,
    source_part: &str,
    relationship_id: &str,
) -> Result<ResourceCleanupStats, String> {
    remove_relationships_and_collect_owned_targets(
        archive,
        source_part,
        &[relationship_id.to_owned()],
        &Set::new(),
        &HashMap::new(),
    )
}

/// `removePartWithOwnedResources`: delete a package part and collect resource
/// parts that were owned exclusively by it. Used by slide deletion after the
/// presentation relationship is removed.
pub fn remove_part_with_owned_resources(
    archive: &mut PackageArchive,
    part_path: &str,
) -> Result<ResourceCleanupStats, String> {
    let mut candidates = Set::new();
    for rel in archive.read_rels(part_path)?.values() {
        if rel.target_mode.as_deref() == Some("External") {
            continue;
        }
        let target = resolve_target(part_path, &rel.target);
        if is_owned_resource_path(&target) {
            candidates.set(target, ());
        }
    }
    let xml = archive
        .read_text(part_path)
        .filter(|xml| !xml.is_empty())
        .map(|xml| xml.into_owned());
    if let Some(xml) = xml {
        for target in model3d_refs(&xml).keys() {
            candidates.set(target, ());
        }
    }

    let mut bytes_removed = archive.entries().get(part_path).map_or(0, Vec::len);
    delete_entry(archive, part_path);
    delete_entry(archive, &rels_path_for(part_path));
    let mut only = Set::new();
    only.set(part_path, ());
    remove_content_type_overrides(archive, &only);

    let collected = remove_unreferenced_owned_parts(archive, &candidates, &HashMap::new())?;
    bytes_removed += collected.bytes_removed;
    Ok(ResourceCleanupStats {
        relationships_removed: 0,
        parts_removed: 1 + collected.parts_removed,
        bytes_removed,
    })
}
