//! resource-cleanup.ts: prune the resources made unreachable by the final
//! main-document XML, and no others. Only what this save broke is pruned: a
//! relationship the source document already did not reference is a
//! pre-existing orphan, which Word keeps.

use std::collections::{HashMap, HashSet};

use jscompat::{TryJsRegex, js_regex, regex_escape, try_js_regex};
use ooxml_pkg::Package;

use super::rels::{
    decode_part_uri, decode_xml_entities, override_tags, relationship_part_path,
    relationship_source_path, relationship_tags, xml_attr,
};
use super::thrown;

/// `DOCUMENT_OWNED_REL_TYPES`: relationship kinds whose references live directly in document XML.
const DOCUMENT_OWNED_REL_TYPES: [&str; 9] = [
    "chart",
    "diagramcolors",
    "diagramdata",
    "diagramdrawing",
    "diagramlayout",
    "diagramquickstyle",
    "hyperlink",
    "image",
    "oleobject",
];

struct Relationship {
    target: String,
    external: bool,
}

struct RelationshipEdge {
    source: String,
    target: String,
}

/// `relationshipsOf`
fn relationships_of(xml: &str) -> Result<Vec<Relationship>, String> {
    let mut relationships = Vec::new();
    for found in relationship_tags().try_find_iter(xml) {
        let tag = found.map_err(thrown)?.as_str();
        let id = xml_attr(tag, "Id")?;
        let rel_type = xml_attr(tag, "Type")?;
        let target = xml_attr(tag, "Target")?;
        let (Some(id), Some(rel_type), Some(target)) = (id, rel_type, target) else {
            continue;
        };
        if id.is_empty() || rel_type.is_empty() || target.is_empty() {
            continue;
        }
        relationships.push(Relationship {
            target,
            external: xml_attr(tag, "TargetMode")?
                .is_some_and(|mode| mode.to_lowercase() == "external"),
        });
    }
    Ok(relationships)
}

/// `relationshipTypeName`
fn relationship_type_name(rel_type: &str) -> String {
    let name = &rel_type[rel_type.rfind('/').map_or(0, |slash| slash + 1)..];
    (if name.is_empty() { rel_type } else { name }).to_lowercase()
}

/// `normalizePartPath` of resource-cleanup.ts: "" for a path that normalizes to nothing.
fn normalize_part_path(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            parts.pop()?;
        } else {
            parts.push(segment);
        }
    }
    Some(parts.join("/"))
}

/// `resolveTargetPath`
fn resolve_target_path(source_path: &str, target: &str) -> Option<String> {
    let without_fragment = target.split('#').next().unwrap_or_default();
    if without_fragment.is_empty() || js_regex!(r"^[A-Za-z][A-Za-z0-9+.-]*:").test(without_fragment)
    {
        return None;
    }
    let decoded = decode_part_uri(without_fragment);
    if let Some(rooted) = decoded.strip_prefix('/') {
        return normalize_part_path(rooted);
    }
    let dir = source_path
        .rfind('/')
        .map_or("", |slash| &source_path[..=slash]);
    normalize_part_path(&format!("{dir}{decoded}"))
}

/// `isOwnedPart`
fn is_owned_part(path: &str) -> bool {
    path.starts_with("word/media/")
        || path.starts_with("word/charts/")
        || path.starts_with("word/embeddings/")
        || path.starts_with("word/diagrams/")
}

/// `referencedRelationshipIds`: the relationship ids actually referenced by
/// the source XML. Prefixes are discovered from namespace declarations so
/// strict OOXML and non-"r" prefixes remain safe; a missing declaration still
/// gets the conventional "r".
pub fn referenced_relationship_ids(xml: &str) -> Result<HashSet<String>, String> {
    let mut prefixes: Vec<String> = vec!["r".to_owned()];
    let namespace = try_js_regex!(
        r#"\bxmlns:([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*\/relationships)"|'([^']*\/relationships)')"#,
        "g"
    );
    for found in namespace.try_find_iter(xml) {
        let prefix = found.map_err(thrown)?.get(1).unwrap_or_default().to_owned();
        if !prefixes.contains(&prefix) {
            prefixes.push(prefix);
        }
    }
    let mut ids = HashSet::new();
    for prefix in &prefixes {
        let attribute = TryJsRegex::new(
            &format!(
                r#"\b{}:[A-Za-z_][\w.-]*\s*=\s*(?:"([^"]*)"|'([^']*)')"#,
                regex_escape(prefix)
            ),
            "g",
        )
        .map_err(thrown)?;
        for found in attribute.try_find_iter(xml) {
            let found = found.map_err(thrown)?;
            ids.insert(decode_xml_entities(
                found.get(1).or_else(|| found.get(2)).unwrap_or_default(),
            ));
        }
    }
    // Legacy VML/Office producers occasionally put a package relationship id in
    // a non-r namespace attribute (for example o:relid): keep any id still
    // present as an exact XML attribute value.
    let attribute = try_js_regex!(r#"\s[A-Za-z_][\w.:-]*\s*=\s*(?:"([^"]*)"|'([^']*)')"#, "g");
    for found in attribute.try_find_iter(xml) {
        let found = found.map_err(thrown)?;
        let value = decode_xml_entities(found.get(1).or_else(|| found.get(2)).unwrap_or_default());
        if js_regex!(r"^rId[\w.-]*$", "i").test(&value) {
            ids.insert(value);
        }
    }
    Ok(ids)
}

/// `DIAGRAM_TWIN_RE`: `^(.*\/)(?:data|drawing)(\d+)\.xml$`
fn diagram_twin(path: &str) -> Option<(String, String)> {
    js_regex!(r"^(.*\/)(?:data|drawing)(\d+)\.xml$")
        .exec(path)
        .map(|found| {
            (
                found.get(1).unwrap_or_default().to_owned(),
                found.get(2).unwrap_or_default().to_owned(),
            )
        })
}

/// `liveDiagramDrawingParts`: Word links the pre-rendered dsp drawing part only
/// by relationship type, so it lives and dies with its dataN twin.
fn live_diagram_drawing_parts(
    rels_xml: &str,
    document_path: &str,
    referenced_ids: &HashSet<String>,
    kept_ids: &HashSet<String>,
) -> Result<HashSet<String>, String> {
    let mut live = HashSet::new();
    for found in relationship_tags().try_find_iter(rels_xml) {
        let tag = found.map_err(thrown)?.as_str();
        let id = xml_attr(tag, "Id")?;
        let rel_type = xml_attr(tag, "Type")?;
        let target = xml_attr(tag, "Target")?;
        let (Some(id), Some(rel_type), Some(target)) = (id, rel_type, target) else {
            continue;
        };
        // a data twin the save keeps as a pre-existing orphan keeps its drawing too
        if id.is_empty()
            || rel_type.is_empty()
            || target.is_empty()
            || !(referenced_ids.contains(&id) || kept_ids.contains(&id))
        {
            continue;
        }
        if relationship_type_name(&rel_type) != "diagramdata" {
            continue;
        }
        if let Some((dir, number)) =
            resolve_target_path(document_path, &target).and_then(|path| diagram_twin(&path))
        {
            live.insert(format!("{dir}drawing{number}.xml"));
        }
    }
    Ok(live)
}

/// `relationshipEdges`
fn relationship_edges(zip: &Package) -> Result<Vec<RelationshipEdge>, String> {
    let mut edges = Vec::new();
    for part in zip.parts() {
        if !part.name.ends_with(".rels") {
            continue;
        }
        let Some(source) = relationship_source_path(&part.name) else {
            continue;
        };
        let Some(xml) = zip.text(&part.name).map_err(thrown)? else {
            continue;
        };
        for rel in relationships_of(xml)? {
            if rel.external {
                continue;
            }
            if let Some(target) = resolve_target_path(&source, &rel.target) {
                if target.is_empty() {
                    continue;
                }
                edges.push(RelationshipEdge {
                    source: source.clone(),
                    target,
                });
            }
        }
    }
    Ok(edges)
}

/// `addReachableOwnedParts`
fn add_reachable_owned_parts(
    starts: impl IntoIterator<Item = String>,
    outgoing: &HashMap<String, Vec<String>>,
    allowed: Option<&HashSet<String>>,
) -> HashSet<String> {
    let mut reached = HashSet::new();
    let mut pending: Vec<String> = starts.into_iter().collect();
    while let Some(part) = pending.pop() {
        if reached.contains(&part) || allowed.is_some_and(|allowed| !allowed.contains(&part)) {
            continue;
        }
        reached.insert(part.clone());
        for target in outgoing.get(&part).into_iter().flatten() {
            if is_owned_part(target) && allowed.is_none_or(|allowed| allowed.contains(target)) {
                pending.push(target.clone());
            }
        }
    }
    reached
}

/// `cleanupDocxOwnedResources`: prune the resources made unreachable by the
/// final main-document XML. The pass is narrow: only known drawing/hyperlink
/// relationship kinds are pruned at the document root, only owned Word
/// resource directories are removed (recursively), inbound references from any
/// surviving part retain a shared target and its dependencies, and unknown or
/// custom parts are never selected for deletion.
pub fn cleanup_docx_owned_resources(
    zip: &mut Package,
    document_path: &str,
    source_referenced_ids: Option<&HashSet<String>>,
) -> Result<(), String> {
    let rels_path = relationship_part_path(document_path);
    if !zip.has(document_path) || !zip.has(&rels_path) {
        return Ok(());
    }
    let document_xml = zip
        .text(document_path)
        .map_err(thrown)?
        .unwrap_or_default()
        .to_owned();
    let referenced_ids = referenced_relationship_ids(&document_xml)?;
    let mut candidate_roots: Vec<String> = Vec::new();
    let rels_xml = zip
        .text(&rels_path)
        .map_err(thrown)?
        .unwrap_or_default()
        .to_owned();
    // The pre-existing orphans this save must keep. A diagram drawing twin is
    // excluded: it is linked only by relationship type.
    let mut source_orphans_kept: HashSet<String> = HashSet::new();
    if let Some(source_referenced_ids) = source_referenced_ids {
        for found in relationship_tags().try_find_iter(&rels_xml) {
            let tag = found.map_err(thrown)?.as_str();
            let id = xml_attr(tag, "Id")?;
            let rel_type = xml_attr(tag, "Type")?;
            let (Some(id), Some(rel_type)) = (id, rel_type) else {
                continue;
            };
            if id.is_empty() || rel_type.is_empty() || referenced_ids.contains(&id) {
                continue;
            }
            let type_name = relationship_type_name(&rel_type);
            if type_name == "diagramdrawing"
                || !DOCUMENT_OWNED_REL_TYPES.contains(&type_name.as_str())
            {
                continue;
            }
            if !source_referenced_ids.contains(&id) {
                source_orphans_kept.insert(id);
            }
        }
    }
    let live_drawings = live_diagram_drawing_parts(
        &rels_xml,
        document_path,
        &referenced_ids,
        &source_orphans_kept,
    )?;
    let mut failure: Option<String> = None;
    let cleaned_rels_xml = relationship_tags()
        .try_replace_all(&rels_xml, |found| {
            let tag = found.as_str();
            let mut keep = || -> Result<bool, String> {
                let id = xml_attr(tag, "Id")?;
                let rel_type = xml_attr(tag, "Type")?;
                let (Some(id), Some(rel_type)) = (id, rel_type) else {
                    return Ok(true);
                };
                if id.is_empty()
                    || rel_type.is_empty()
                    || referenced_ids.contains(&id)
                    || !DOCUMENT_OWNED_REL_TYPES
                        .contains(&relationship_type_name(&rel_type).as_str())
                {
                    return Ok(true);
                }
                // a relationship the source already did not reference is a
                // pre-existing orphan, not something this save broke
                if source_orphans_kept.contains(&id) {
                    return Ok(true);
                }
                let external = xml_attr(tag, "TargetMode")?
                    .is_some_and(|mode| mode.to_lowercase() == "external");
                let target = xml_attr(tag, "Target")?.filter(|target| !target.is_empty());
                let target_path = match (&target, external) {
                    (Some(target), false) => resolve_target_path(document_path, target),
                    _ => None,
                }
                .filter(|path| !path.is_empty());
                if relationship_type_name(&rel_type) == "diagramdrawing"
                    && match &target_path {
                        None => true,
                        Some(path) => diagram_twin(path).is_none() || live_drawings.contains(path),
                    }
                {
                    return Ok(true);
                }
                if let Some(path) = &target_path
                    && is_owned_part(path)
                    && !candidate_roots.contains(path)
                {
                    candidate_roots.push(path.clone());
                }
                Ok(false)
            };
            match keep() {
                Ok(true) => tag.to_owned(),
                Ok(false) => String::new(),
                Err(error) => {
                    failure.get_or_insert(error);
                    tag.to_owned()
                }
            }
        })
        .map_err(thrown)?;
    if let Some(error) = failure {
        return Err(error);
    }
    if cleaned_rels_xml == rels_xml {
        return Ok(());
    }
    zip.set_file(rels_path, cleaned_rels_xml.into_bytes());

    let edges = relationship_edges(zip)?;
    let mut outgoing: HashMap<String, Vec<String>> = HashMap::new();
    for edge in &edges {
        outgoing
            .entry(edge.source.clone())
            .or_default()
            .push(edge.target.clone());
    }
    let mut candidates = add_reachable_owned_parts(
        candidate_roots
            .into_iter()
            .filter(|path| zip.file(path).is_some()),
        &outgoing,
        None,
    );
    candidates.retain(|path| zip.file(path).is_some());
    if candidates.is_empty() {
        return Ok(());
    }
    // Any inbound edge from outside the candidate subgraph makes that target
    // shared: retain it and every owned dependency reachable from it.
    let mut shared_roots: Vec<String> = Vec::new();
    for edge in &edges {
        if candidates.contains(&edge.target) && !candidates.contains(&edge.source) {
            shared_roots.push(edge.target.clone());
        }
    }
    let retained = add_reachable_owned_parts(shared_roots, &outgoing, Some(&candidates));
    let mut removed: HashSet<String> = HashSet::new();
    for path in &candidates {
        if retained.contains(path) {
            continue;
        }
        removed.insert(path.clone());
        zip.remove(path);
        let dependency_rels_path = relationship_part_path(path);
        if zip.file(&dependency_rels_path).is_some() {
            zip.remove(&dependency_rels_path);
            removed.insert(dependency_rels_path);
        }
    }
    if removed.is_empty() {
        return Ok(());
    }

    let content_types_path = "[Content_Types].xml";
    let Some(content_types_xml) = zip
        .text(content_types_path)
        .map_err(thrown)?
        .map(str::to_owned)
    else {
        return Ok(());
    };
    let mut failure: Option<String> = None;
    let cleaned = override_tags()
        .try_replace_all(&content_types_xml, |found| {
            let tag = found.as_str();
            let part_name = match xml_attr(tag, "PartName") {
                Ok(part_name) => part_name.filter(|name| !name.is_empty()),
                Err(error) => {
                    failure.get_or_insert(error);
                    return tag.to_owned();
                }
            };
            let Some(part_name) = part_name else {
                return tag.to_owned();
            };
            let unrooted = part_name.strip_prefix('/').unwrap_or(&part_name);
            let path =
                normalize_part_path(&decode_part_uri(unrooted)).filter(|path| !path.is_empty());
            match path {
                Some(path) if removed.contains(&path) => String::new(),
                _ => tag.to_owned(),
            }
        })
        .map_err(thrown)?;
    if let Some(error) = failure {
        return Err(error);
    }
    if cleaned != content_types_xml {
        zip.set_file(content_types_path.to_owned(), cleaned.into_bytes());
    }
    Ok(())
}
