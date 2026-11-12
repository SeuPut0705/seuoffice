//! remove-parts.ts: the metadata-carrying part families the docs `remove_parts`
//! op can target (`customXml/`, `word/webextensions/`), their relationship
//! parts, dangling relationships, content-type entries and empty folders.

use std::collections::HashMap;

use jscompat::{js_regex, try_js_regex};
use ooxml_pkg::{Package, load_docx_package};
use serde::{Deserialize, Serialize};

use super::rels::{
    attribute_of, decode_part_uri, override_tags, relationship_part_path, relationship_source_path,
    relationship_tags,
};
use super::thrown;
use crate::package::{resolve_main_document_path, resolve_relationship_target_path};

/// `REMOVE_PARTS_KINDS`
pub const REMOVE_PARTS_KINDS: [&str; 2] = ["customXml", "webExtensions"];

/// `KIND_PREFIXES`: the package prefix of each part family; None for a name that is no kind.
fn kind_prefix(kind: &str) -> Option<&'static str> {
    match kind {
        // template / DMS data stores: item*.xml, itemProps*.xml and their rels
        "customXml" => Some("customXml/"),
        // task panes / add-ins: webextension*.xml, taskpanes.xml and their rels
        "webExtensions" => Some("word/webextensions/"),
        _ => None,
    }
}

/// Story parts that can carry a block-level `w:sdt` with a `w:dataBinding`.
const STORY_PART_PATHS: [&str; 4] = [
    "word/document.xml",
    "word/footnotes.xml",
    "word/endnotes.xml",
    "word/glossary/document.xml",
];

/// `RemovePartsOptions`
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovePartsOptions {
    /// explicit package paths (relative to the package root, no leading slash); unknown paths are reported and ignored
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
    /// whole part families to remove
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<String>>,
    /// what to do when a removed customXml store backs a `w:dataBinding` control: refuse (default) or strip
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_binding: Option<String>,
}

/// `RemovedPartBinding`: one content control bound to a customXml store that is being removed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedPartBinding {
    /// story part carrying the control
    pub part: String,
    /// `w:sdtPr/w:tag` of the control, when present
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// `w:sdtPr/w:id` of the control, when present
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control_id: Option<String>,
    /// the `ds:itemID` the control is bound to, as written in `w:storeItemID`
    #[serde(rename = "storeItemID")]
    pub store_item_id: String,
    /// the `customXml/itemProps*.xml` part declaring that itemID
    pub item_props_path: String,
}

/// `RemovePartsPlan`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovePartsPlan {
    /// package paths removal drops (or has already dropped), sorted
    pub removed_paths: Vec<String>,
    /// explicit paths that are not present in the package
    pub unknown_paths: Vec<String>,
    /// explicit paths naming parts the package depends on; the save refuses
    pub refused_paths: Vec<String>,
    /// content controls bound to removed customXml stores
    pub data_bindings: Vec<RemovedPartBinding>,
}

/// An array sorted the way `Array.prototype.sort()` sorts strings: by UTF-16 code units.
fn sort_js(paths: &mut [String]) {
    paths.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// `normalizePartPath` of remove-parts.ts: None for a path that normalizes to nothing.
fn normalize_part_path(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for segment in normalized.trim_start_matches('/').split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            parts.pop()?;
        } else {
            parts.push(segment);
        }
    }
    let joined = parts.join("/");
    (!joined.is_empty()).then_some(joined)
}

/// `extensionOf`
fn extension_of(path: &str) -> Option<String> {
    let name = &path[path.rfind('/').map_or(0, |slash| slash + 1)..];
    let dot = name.rfind('.')?;
    (dot > 0).then(|| name[dot + 1..].to_lowercase())
}

/// `normalizeItemId`: a GUID comparison ignores braces and case.
fn normalize_item_id(value: &str) -> String {
    jscompat::trim(&value.replace(['{', '}'], "")).to_uppercase()
}

/// `STRUCTURAL_PART_RE`: the parts the package structurally depends on (Word
/// repairs or refuses a file without them).
fn is_structural_part(path: &str) -> bool {
    js_regex!(r"^docProps\/(?:core|app|custom)\.xml$", "i").test(path)
        || js_regex!(r"^docProps\/thumbnail\.", "i").test(path)
        || js_regex!(
            r"^word\/(?:styles|settings|numbering|fontTable|webSettings)\.xml$",
            "i"
        )
        .test(path)
        || js_regex!(r"^word\/theme\/", "i").test(path)
}

/// An insertion-ordered set of paths.
#[derive(Default)]
struct PathSet(Vec<String>);

impl PathSet {
    fn add(&mut self, path: String) {
        if !self.0.contains(&path) {
            self.0.push(path);
        }
    }

    fn contains(&self, path: &str) -> bool {
        self.0.iter().any(|item| item == path)
    }
}

struct Wanted {
    paths: PathSet,
    missing_paths: Vec<String>,
    refused_paths: Vec<String>,
}

/// `wantedParts`: the parts an option set selects, plus explicit paths that miss or must be refused.
fn wanted_parts(zip: &Package, options: &RemovePartsOptions) -> Result<Wanted, String> {
    let mut protected: Vec<String> =
        vec!["[Content_Types].xml".to_owned(), "_rels/.rels".to_owned()];
    if let Some(main_path) = resolve_main_document_path(zip)? {
        protected.push(relationship_part_path(&main_path));
        protected.push(main_path);
        protected.extend(STORY_PART_PATHS.iter().map(|path| (*path).to_owned()));
    }
    let mut paths = PathSet::default();
    for kind in options.kinds.as_deref().unwrap_or_default() {
        let Some(prefix) = kind_prefix(kind) else {
            continue;
        };
        for part in zip.parts() {
            if !part.is_dir && part.name.starts_with(prefix) {
                paths.add(part.name.clone());
            }
        }
    }
    let mut missing_paths = Vec::new();
    let mut refused_paths = Vec::new();
    for raw in options.paths.as_deref().unwrap_or_default() {
        let path = normalize_part_path(raw);
        let Some(path) = path.filter(|path| zip.file(path).is_some()) else {
            missing_paths.push(raw.clone());
            continue;
        };
        if protected.contains(&path) || is_structural_part(&path) {
            refused_paths.push(raw.clone());
            continue;
        }
        paths.add(path);
    }
    // a customXml data store rides with its itemProps part: removing item1.xml
    // alone would orphan itemProps1.xml and skip the dataBinding check
    for path in paths.0.clone() {
        let Some(found) = js_regex!(r"^customXml\/item(?!Props)([^/]*)\.xml$", "i").exec(&path)
        else {
            continue;
        };
        let props = format!(
            "customXml/itemProps{}.xml",
            found.get(1).unwrap_or_default()
        );
        if zip.file(&props).is_some() && !protected.contains(&props) {
            paths.add(props);
        }
    }
    Ok(Wanted {
        paths,
        missing_paths,
        refused_paths,
    })
}

/// `withOwnRels`: the relationship part of every selected part goes with it.
fn with_own_rels(zip: &Package, paths: &PathSet) -> PathSet {
    let mut out = PathSet(paths.0.clone());
    for path in &paths.0 {
        if path.to_lowercase().ends_with(".rels") {
            continue;
        }
        let rels_path = relationship_part_path(path);
        if zip.file(&rels_path).is_some() {
            out.add(rels_path);
        }
    }
    out
}

/// `itemIdsOf`: the `ds:itemID` of every removed customXml itemProps part, keyed by the normalized GUID.
fn item_ids_of(zip: &Package, remove_set: &PathSet) -> Result<HashMap<String, String>, String> {
    let mut ids = HashMap::new();
    for path in &remove_set.0 {
        if !js_regex!(r"^customXml\/itemProps[^/]*\.xml$", "i").test(path) {
            continue;
        }
        let Some(xml) = zip.text(path).map_err(thrown)? else {
            continue;
        };
        let root = try_js_regex!(r"<(?:[A-Za-z_][\w.-]*:)?datastoreItem\b[^>]*>")
            .try_exec(xml)
            .map_err(thrown)?
            .map(|found| found.as_str());
        let item_id = match root {
            Some(root) => attribute_of(root, "itemID")?,
            None => None,
        };
        if let Some(item_id) = item_id.filter(|id| !id.is_empty()) {
            ids.insert(normalize_item_id(&item_id), path.clone());
        }
    }
    Ok(ids)
}

/// `storyPartsOf`: the story parts that may hold block-level content controls.
fn story_parts_of(zip: &Package) -> Result<Vec<String>, String> {
    let mut paths = PathSet::default();
    for path in STORY_PART_PATHS {
        paths.add(path.to_owned());
    }
    if let Some(doc_path) = resolve_main_document_path(zip)? {
        paths.add(doc_path);
    }
    for part in zip.parts() {
        if !part.is_dir && js_regex!(r"^word\/(?:header|footer)[^/]*\.xml$", "i").test(&part.name) {
            paths.add(part.name.clone());
        }
    }
    let mut out: Vec<String> = paths
        .0
        .into_iter()
        .filter(|path| zip.file(path).is_some())
        .collect();
    sort_js(&mut out);
    Ok(out)
}

struct Scanned {
    bindings: Vec<RemovedPartBinding>,
    /// story part XML with the dataBinding elements removed (only when stripping), in part order
    stripped: Vec<(String, String)>,
}

/// `scanDataBindings`: find (and strip, when asked) `w:dataBinding` elements
/// whose `w:storeItemID` names a removed customXml store. `w:sdtPr` does not
/// nest, so the per-control walk is exact; the control keeps its tag, id and
/// current text.
fn scan_data_bindings(
    zip: &Package,
    item_ids: &HashMap<String, String>,
    story_parts: &[String],
    strip: bool,
) -> Result<Scanned, String> {
    let mut scanned = Scanned {
        bindings: Vec::new(),
        stripped: Vec::new(),
    };
    if item_ids.is_empty() {
        return Ok(scanned);
    }
    for part in story_parts {
        let Some(xml) = zip.text(part).map_err(thrown)? else {
            continue;
        };
        let mut found: Vec<RemovedPartBinding> = Vec::new();
        let mut failure: Option<String> = None;
        let next = try_js_regex!(r"<w:sdtPr\b[^>]*>[\s\S]*?<\/w:sdtPr>", "g")
            .try_replace_all(xml, |sdt_pr| {
                let sdt_pr = sdt_pr.as_str();
                let mut scan = || -> Result<Option<String>, String> {
                    let data_binding = try_js_regex!(
                        r"<w1?5?:dataBinding\b[^>]*(?:\/>|>[\s\S]*?<\/w1?5?:dataBinding>)"
                    )
                    .try_exec(sdt_pr)
                    .map_err(thrown)?
                    .map(|found| found.as_str());
                    let Some(data_binding) = data_binding else {
                        return Ok(None);
                    };
                    let store_item_id =
                        attribute_of(data_binding, "storeItemID")?.filter(|id| !id.is_empty());
                    let item_props_path = store_item_id
                        .as_ref()
                        .and_then(|id| item_ids.get(&normalize_item_id(id)));
                    let (Some(store_item_id), Some(item_props_path)) =
                        (store_item_id.as_ref(), item_props_path)
                    else {
                        return Ok(None);
                    };
                    let tag_open = js_regex!(r"<w:tag\b[^>]*>")
                        .exec(sdt_pr)
                        .map_or("", |found| found.as_str());
                    let id_open = js_regex!(r"<w:id\b[^>]*>")
                        .exec(sdt_pr)
                        .map_or("", |found| found.as_str());
                    found.push(RemovedPartBinding {
                        part: part.clone(),
                        tag: attribute_of(tag_open, "val")?.filter(|tag| !tag.is_empty()),
                        control_id: attribute_of(id_open, "val")?.filter(|id| !id.is_empty()),
                        store_item_id: store_item_id.clone(),
                        item_props_path: item_props_path.clone(),
                    });
                    // `sdtPr.replace(dataBinding, '')`: the first occurrence of the text
                    Ok(Some(sdt_pr.replacen(data_binding, "", 1)))
                };
                match scan() {
                    Ok(Some(replacement)) => replacement,
                    Ok(None) => sdt_pr.to_owned(),
                    Err(error) => {
                        failure.get_or_insert(error);
                        sdt_pr.to_owned()
                    }
                }
            })
            .map_err(thrown)?;
        if let Some(error) = failure {
            return Err(error);
        }
        if found.is_empty() {
            continue;
        }
        scanned.bindings.extend(found);
        if strip && next != xml {
            scanned.stripped.push((part.clone(), next));
        }
    }
    Ok(scanned)
}

/// `describeControl`
fn describe_control(binding: &RemovedPartBinding) -> String {
    let label = match binding.tag.as_deref().filter(|tag| !tag.is_empty()) {
        Some(tag) => format!("\"{tag}\""),
        None => "untagged control".to_owned(),
    };
    let id = match binding.control_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => format!(" (w:id {id})"),
        None => String::new(),
    };
    format!(
        "{label}{id} in {} is bound to storeItemID {} of {}",
        binding.part, binding.store_item_id, binding.item_props_path
    )
}

/// `removePartsRefusalMessage`: the guided error a 'refuse' save throws when bound controls would be orphaned.
pub fn remove_parts_refusal_message(bindings: &[RemovedPartBinding]) -> String {
    format!(
        "remove_parts would orphan content controls: {}. Pass dataBinding: \"strip\" to unbind them and keep their current text, or remove the customXml parts in Word first.",
        bindings
            .iter()
            .map(describe_control)
            .collect::<Vec<_>>()
            .join("; ")
    )
}

/// `removePartsRefusalMessageFor`: the error for explicit paths naming parts the package depends on.
pub fn remove_parts_refusal_message_for(refused_paths: &[String]) -> String {
    format!(
        "remove_parts refuses parts the package depends on: {}. Removing them would corrupt or degrade the saved file.",
        refused_paths.join(", ")
    )
}

struct ZipPlan {
    plan: RemovePartsPlan,
    stripped: Vec<(String, String)>,
}

/// `planInZip`
fn plan_in_zip(zip: &Package, options: &RemovePartsOptions) -> Result<ZipPlan, String> {
    let wanted = wanted_parts(zip, options)?;
    let remove_set = with_own_rels(zip, &wanted.paths);
    let item_ids = item_ids_of(zip, &remove_set)?;
    let story_parts = story_parts_of(zip)?;
    let strip = options.data_binding.as_deref().unwrap_or("refuse") == "strip";
    let scanned = scan_data_bindings(zip, &item_ids, &story_parts, strip)?;
    let mut removed_paths = remove_set.0;
    sort_js(&mut removed_paths);
    Ok(ZipPlan {
        plan: RemovePartsPlan {
            removed_paths,
            unknown_paths: wanted.missing_paths,
            refused_paths: wanted.refused_paths,
            data_bindings: scanned.bindings,
        },
        stripped: scanned.stripped,
    })
}

/// `dropDanglingRelationships`: rewrite every remaining relationships part so relations to removed parts are gone.
fn drop_dangling_relationships(zip: &mut Package, removed: &PathSet) -> Result<(), String> {
    let names: Vec<String> = zip
        .parts()
        .iter()
        .filter(|part| !part.is_dir && part.name.ends_with(".rels"))
        .map(|part| part.name.clone())
        .collect();
    for path in names {
        let Some(source) = relationship_source_path(&path) else {
            continue;
        };
        let Some(xml) = zip.text(&path).map_err(thrown)?.map(str::to_owned) else {
            continue;
        };
        let mut failure: Option<String> = None;
        let next = relationship_tags()
            .try_replace_all(&xml, |found| {
                let tag = found.as_str();
                if js_regex!(r#"TargetMode\s*=\s*["']external["']"#, "i").test(tag) {
                    return tag.to_owned();
                }
                let target = match attribute_of(tag, "Target") {
                    Ok(target) => target.filter(|target| !target.is_empty()),
                    Err(error) => {
                        failure.get_or_insert(error);
                        return tag.to_owned();
                    }
                };
                let Some(target) = target else {
                    return tag.to_owned();
                };
                match resolve_relationship_target_path(&source, &target) {
                    Some(resolved) if removed.contains(&resolved) => String::new(),
                    _ => tag.to_owned(),
                }
            })
            .map_err(thrown)?;
        if let Some(error) = failure {
            return Err(error);
        }
        if next != xml {
            zip.set_file(path, next.into_bytes());
        }
    }
    Ok(())
}

/// `cleanContentTypes`: drop overrides of removed parts, and Default extensions no remaining part uses.
fn clean_content_types(zip: &mut Package, removed: &PathSet) -> Result<(), String> {
    let path = "[Content_Types].xml";
    let Some(xml) = zip.text(path).map_err(thrown)?.map(str::to_owned) else {
        return Ok(());
    };
    let mut failure: Option<String> = None;
    let mut next = override_tags()
        .try_replace_all(&xml, |found| {
            let tag = found.as_str();
            let part_name = match attribute_of(tag, "PartName") {
                Ok(name) => name.filter(|name| !name.is_empty()),
                Err(error) => {
                    failure.get_or_insert(error);
                    return tag.to_owned();
                }
            };
            let Some(part_name) = part_name else {
                return tag.to_owned();
            };
            match normalize_part_path(&decode_part_uri(&part_name)) {
                Some(normalized) if removed.contains(&normalized) => String::new(),
                _ => tag.to_owned(),
            }
        })
        .map_err(thrown)?;
    let used_extensions: Vec<String> = zip
        .parts()
        .iter()
        .filter(|part| !part.is_dir)
        .filter_map(|part| extension_of(&part.name))
        .filter(|extension| !extension.is_empty())
        .collect();
    let default_tag = try_js_regex!(
        r"<(?:[A-Za-z_][\w.-]*:)?Default\b[^>]*(?:\/\s*>|>\s*<\/(?:[A-Za-z_][\w.-]*:)?Default\s*>)",
        "g"
    );
    next = default_tag
        .try_replace_all(&next, |found| {
            let tag = found.as_str();
            let extension = match attribute_of(tag, "Extension") {
                Ok(extension) => extension.unwrap_or_default().to_lowercase(),
                Err(error) => {
                    failure.get_or_insert(error);
                    return tag.to_owned();
                }
            };
            if !extension.is_empty() && !used_extensions.contains(&extension) {
                String::new()
            } else {
                tag.to_owned()
            }
        })
        .map_err(thrown)?;
    if let Some(error) = failure {
        return Err(error);
    }
    if next != xml {
        zip.set_file(path.to_owned(), next.into_bytes());
    }
    Ok(())
}

/// `removeEmptyFolders`: drop explicit folder entries no remaining part sits under.
fn remove_empty_folders(zip: &mut Package) {
    // snapshot first: removing a folder also drops its entries
    let entries: Vec<(String, bool)> = zip
        .parts()
        .iter()
        .map(|part| (part.name.clone(), part.is_dir))
        .collect();
    let files: Vec<&str> = entries
        .iter()
        .filter(|(_, is_dir)| !is_dir)
        .map(|(name, _)| name.as_str())
        .collect();
    let empty: Vec<String> = entries
        .iter()
        .filter(|(name, is_dir)| {
            *is_dir && !files.iter().any(|file| file.starts_with(name.as_str()))
        })
        .map(|(name, _)| name.clone())
        .collect();
    for name in empty {
        zip.remove(&name);
    }
}

/// `removePartsFromZip`
fn remove_parts_from_zip(zip: &mut Package, removed_paths: &[String]) -> Result<(), String> {
    let mut removed = PathSet::default();
    for path in removed_paths {
        removed.add(path.clone());
    }
    for path in &removed.0 {
        zip.remove(path);
    }
    drop_dangling_relationships(zip, &removed)?;
    clean_content_types(zip, &removed)?;
    remove_empty_folders(zip);
    Ok(())
}

/// `planRemoveParts`: plan a remove_parts pass without changing anything: which
/// package parts would go, which explicit paths are missing, and which content
/// controls are bound to the removed customXml stores.
pub fn plan_remove_parts(
    bytes: &[u8],
    options: &RemovePartsOptions,
) -> Result<RemovePartsPlan, String> {
    let zip = load_docx_package(bytes)?;
    Ok(plan_in_zip(&zip, options)?.plan)
}

/// `applyRemoveParts`: apply a remove_parts pass to an assembled save zip: drop
/// the selected parts, their own rels parts, dangling relationship elements,
/// content-type entries and empty folders. Other parts keep their bytes.
/// Errors when a bound control would be orphaned and dataBinding is 'refuse'.
pub fn apply_remove_parts(
    zip: &mut Package,
    options: &RemovePartsOptions,
) -> Result<RemovePartsPlan, String> {
    let ZipPlan { plan, stripped } = plan_in_zip(zip, options)?;
    if !plan.refused_paths.is_empty() {
        return Err(remove_parts_refusal_message_for(&plan.refused_paths));
    }
    if plan.removed_paths.is_empty() {
        return Ok(plan);
    }
    if !plan.data_bindings.is_empty() {
        if options.data_binding.as_deref().unwrap_or("refuse") != "strip" {
            return Err(remove_parts_refusal_message(&plan.data_bindings));
        }
        for (part, xml) in stripped {
            zip.set_file(part, xml.into_bytes());
        }
    }
    remove_parts_from_zip(zip, &plan.removed_paths)?;
    Ok(plan)
}
