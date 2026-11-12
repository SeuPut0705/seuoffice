//! `apps/markdown/src/main/asset-lifecycle.ts`: the pictures a document owns
//! in its `assets/` folder, and the manifest that says which are the app's.
//!
//! The TypeScript serialises its read-modify-write cycles of one manifest
//! with a promise-chain lock; here every call runs to its end, so the lock
//! has nothing to do and `withManifestLock` is only the resolution of the
//! manifest path it performs.

use std::collections::HashSet;
use std::fs;

use icu_collator::Collator;
use icu_collator::options::CollatorOptions;
use jscompat::node_path::host::{SEP, basename, dirname, extname, join, resolve};
use jscompat::{
    JsObject, JsonValue, decode_uri_component, js_regex, json_parse, json_stringify_pretty,
    json_value_to_serde, slice_utf16, trim,
};
use serde::Serialize;

use super::asset_scan::scan_image_sources;
pub use super::asset_scan::{extract_markdown_image_sources, rewrite_markdown_image_sources};
use super::fs_util::{
    copy_file_excl, is_path_inside, mkdir_p, plain_error, read_file_utf8, rm_file, sha256_file,
    write_file_excl,
};
use super::old_names::{ASSET_MANIFEST_FILENAME_WRITTEN, OLD_ASSET_MANIFEST_FILENAMES};
use super::ord_map::OrdMap;
use crate::node_fs::{NodeError, namespaced, node_error};
use crate::packages::electron_utils::atomic_write::atomic_write_file;
use crate::packages::i18n::existing_or_current;
use crate::shell::recent_files::StatInfo;

pub const ASSET_MANIFEST_FILENAME: &str = ".seuoffice-assets.json";

type R<T> = Result<T, NodeError>;

/// never a picture's name: the list, under its current or an earlier name
fn is_manifest_name(name: &str) -> bool {
    name == ASSET_MANIFEST_FILENAME || OLD_ASSET_MANIFEST_FILENAMES.contains(&name)
}

/// An assets folder an earlier version made keeps its list under the name it was given.
fn manifest_path_in(assets_dir: &str) -> String {
    let name = existing_or_current(
        ASSET_MANIFEST_FILENAME,
        &OLD_ASSET_MANIFEST_FILENAMES,
        |old| fs::metadata(namespaced(&join(&[assets_dir, old]))).is_ok(),
        None,
    );
    // neither exists: a new folder gets the name 0.12.37 can read
    if name == ASSET_MANIFEST_FILENAME
        && fs::metadata(namespaced(&join(&[assets_dir, &name]))).is_err()
    {
        return join(&[assets_dir, ASSET_MANIFEST_FILENAME_WRITTEN]);
    }
    join(&[assets_dir, &name])
}

/// `OwnedAssetRecord`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OwnedAssetRecord {
    pub name: String,
    pub sha256: String,
}

/// `OwnedAssetManifest`
pub struct OwnedAssetManifest {
    pub files: Vec<OwnedAssetRecord>,
    /// Markdown file name -> app-owned files referenced by its last successful save.
    pub documents: OrdMap<Vec<String>>,
    /// Newly created files stay protected until their owning document successfully saves.
    pub pending: OrdMap<Vec<String>>,
}

impl OwnedAssetManifest {
    fn empty() -> Self {
        OwnedAssetManifest {
            files: Vec::new(),
            documents: OrdMap::new(),
            pending: OrdMap::new(),
        }
    }

    /// the manifest as the TypeScript's object holds it
    fn to_json(&self) -> JsonValue {
        let names = |table: &OrdMap<Vec<String>>| {
            let mut object: JsObject<JsonValue> = JsObject::new();
            for (key, list) in table.iter() {
                object.set(
                    key,
                    JsonValue::Array(list.iter().map(|n| JsonValue::String(n.clone())).collect()),
                );
            }
            JsonValue::Object(object)
        };
        let mut object: JsObject<JsonValue> = JsObject::new();
        object.set("version", JsonValue::Number(1.0));
        object.set(
            "files",
            JsonValue::Array(
                self.files
                    .iter()
                    .map(|record| {
                        let mut file: JsObject<JsonValue> = JsObject::new();
                        file.set("name", JsonValue::String(record.name.clone()));
                        file.set("sha256", JsonValue::String(record.sha256.clone()));
                        JsonValue::Object(file)
                    })
                    .collect(),
            ),
        );
        object.set("documents", names(&self.documents));
        object.set("pending", names(&self.pending));
        JsonValue::Object(object)
    }

    /// what `JSON.stringify` makes of the manifest, as a value
    pub fn to_value(&self) -> serde_json::Value {
        json_value_to_serde(&self.to_json())
    }
}

/// `AssetRewrite`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AssetRewrite {
    pub from: String,
    pub to: String,
}

/// `ReconcileResult`
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ReconcileResult {
    pub deleted: Vec<String>,
    pub preserved: Vec<String>,
    pub errors: Vec<String>,
}

/// `PreparedSaveAsAssets`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PreparedSaveAsAssets {
    #[serde(rename = "targetDocumentPath")]
    pub target_document_path: String,
    pub text: String,
    #[serde(rename = "imageSources")]
    pub image_sources: Vec<String>,
    pub rewrites: Vec<AssetRewrite>,
    pub created: Vec<OwnedAssetRecord>,
}

fn assets_dir_for(document_path: &str) -> String {
    join(&[&dirname(&resolve(&[document_path])), "assets"])
}

fn document_key(document_path: &str) -> String {
    basename(&resolve(&[document_path]), None)
}

fn is_code(error: &NodeError, code: &str) -> bool {
    error.code == Some(code)
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn is_safe_asset_name(name: &str) -> bool {
    let length = utf16_len(name);
    length > 0
        && length <= 180
        && name != "."
        && name != ".."
        && !is_manifest_name(name)
        && basename(name, None) == name
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

fn replace_control_characters(value: &str) -> String {
    value
        .chars()
        .map(|c| if (c as u32) < 32 { '_' } else { c })
        .collect()
}

fn sanitize_asset_name(input: &str) -> String {
    // path.win32.basename reads a leading <letter>: as a drive prefix; replace
    // colons first so the sanitizer decides what a colon becomes
    let slashed = input.replace('\\', "/").replace(':', "_");
    let raw = basename(&slashed, None);
    let raw_ext = extname(&raw);
    let ext = if js_regex!(r"^\.[a-z0-9]{1,10}$", "i").test(&raw_ext) {
        raw_ext.to_lowercase()
    } else {
        String::new()
    };
    let max_stem = 140 - utf16_len(&ext);
    let stem = &raw[..raw.len() - raw_ext.len()];
    let cleaned = replace_control_characters(stem);
    let cleaned = js_regex!(r#"[/\\:*?"<>|#%]+"#, "g").replace_all(&cleaned, |_| "_".to_owned());
    let cleaned = js_regex!(r"\s+", "g").replace_all(&cleaned, |_| "_".to_owned());
    let cleaned = cleaned.trim_start_matches('.');
    let cleaned = slice_utf16(cleaned, 0.0, Some(max_stem as f64));
    let cleaned = cleaned.trim_end_matches(['.', ' ']);
    let stem = if cleaned.is_empty() { "image" } else { cleaned };
    let name = format!("{stem}{ext}");
    if is_manifest_name(&name) {
        format!("image-{name}")
    } else {
        name
    }
}

fn name_with_suffix(name: &str, suffix: u32) -> String {
    if suffix == 0 {
        return name.to_owned();
    }
    let ext = extname(name);
    format!("{}-{suffix}{ext}", basename(name, Some(&ext)))
}

/// `[...new Set(names)].sort()`: first occurrences, in UTF-16 order
fn sorted_unique(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut unique: Vec<String> = Vec::new();
    for name in names {
        if seen.insert(name.clone()) {
            unique.push(name);
        }
    }
    unique.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    unique
}

/// `a.name.localeCompare(b.name)`: the root collation
fn locale_sorter() -> impl Fn(&str, &str) -> std::cmp::Ordering {
    let collator = Collator::try_new(Default::default(), CollatorOptions::default())
        .expect("the root collation is compiled in");
    move |a, b| collator.compare(a, b)
}

/// `normalizedManifest(value)`
fn normalized_manifest(value: &JsonValue) -> R<OwnedAssetManifest> {
    if !matches!(value, JsonValue::Object(_) | JsonValue::Array(_)) {
        return Err(plain_error("asset manifest is not an object"));
    }
    let version_ok =
        matches!(value.get("version").as_deref(), Some(JsonValue::Number(v)) if *v == 1.0);
    let files_raw = match value.get("files").as_deref() {
        Some(JsonValue::Array(items)) => Some(items.clone()),
        _ => None,
    };
    let Some(files_raw) = files_raw.filter(|_| version_ok) else {
        return Err(plain_error("asset manifest has an unsupported format"));
    };

    let mut files: Vec<OwnedAssetRecord> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for item in &files_raw {
        if !matches!(item, JsonValue::Object(_) | JsonValue::Array(_)) {
            return Err(plain_error("asset manifest has a bad file entry"));
        }
        let name = match item.get("name").as_deref() {
            Some(JsonValue::String(name)) => Some(name.clone()),
            _ => None,
        };
        let sha256 = match item.get("sha256").as_deref() {
            Some(JsonValue::String(sha)) => Some(sha.clone()),
            _ => None,
        };
        let (Some(name), Some(sha256)) = (name, sha256) else {
            return Err(plain_error("asset manifest has an unsafe file entry"));
        };
        if !is_safe_asset_name(&name)
            || !js_regex!(r"^[a-f0-9]{64}$").test(&sha256)
            || seen.contains(&name)
        {
            return Err(plain_error("asset manifest has an unsafe file entry"));
        }
        seen.insert(name.clone());
        files.push(OwnedAssetRecord { name, sha256 });
    }

    let references = |field: &str, bad: &str, unsafe_message: &str| -> R<OrdMap<Vec<String>>> {
        let mut table: OrdMap<Vec<String>> = OrdMap::new();
        let Some(raw) = value.get(field) else {
            return Ok(table);
        };
        let JsonValue::Object(entries) = &*raw else {
            return Err(plain_error(bad));
        };
        for (key, names) in entries.entries() {
            let JsonValue::Array(names) = names else {
                return Err(plain_error(unsafe_message));
            };
            if !is_safe_asset_name(key) {
                return Err(plain_error(unsafe_message));
            }
            let mut unique: Vec<String> = Vec::new();
            for name in names {
                match name {
                    JsonValue::String(name) if is_safe_asset_name(name) => {
                        unique.push(name.clone())
                    }
                    _ => return Err(plain_error(unsafe_message)),
                }
            }
            table.set(key, sorted_unique(unique));
        }
        Ok(table)
    };
    let documents = references(
        "documents",
        "asset manifest has bad document references",
        "asset manifest has unsafe document references",
    )?;
    let pending = references(
        "pending",
        "asset manifest has bad pending references",
        "asset manifest has unsafe pending references",
    )?;

    let compare = locale_sorter();
    files.sort_by(|a, b| compare(&a.name, &b.name));
    Ok(OwnedAssetManifest {
        files,
        documents,
        pending,
    })
}

fn lstat(path: &str) -> R<fs::Metadata> {
    fs::symlink_metadata(namespaced(path)).map_err(|e| node_error(&e, "lstat", path))
}

fn is_real_dir(info: &fs::Metadata) -> bool {
    info.is_dir() && !info.file_type().is_symlink()
}

fn existing_assets_dir(document_path: &str) -> R<Option<String>> {
    let assets_dir = assets_dir_for(document_path);
    match lstat(&assets_dir) {
        Ok(info) => {
            if !is_real_dir(&info) {
                return Err(plain_error("markdown assets path must be a real directory"));
            }
            Ok(Some(assets_dir))
        }
        Err(error) if is_code(&error, "ENOENT") => Ok(None),
        Err(error) => Err(error),
    }
}

fn ensure_assets_dir(document_path: &str) -> R<String> {
    if let Some(existing) = existing_assets_dir(document_path)? {
        return Ok(existing);
    }
    let assets_dir = assets_dir_for(document_path);
    mkdir_p(&assets_dir)?;
    let info = lstat(&assets_dir)?;
    if !is_real_dir(&info) {
        return Err(plain_error("markdown assets path must be a real directory"));
    }
    Ok(assets_dir)
}

fn assert_safe_manifest_file(path: &str) -> R<()> {
    match lstat(path) {
        Ok(info) => {
            if !info.is_file() || info.file_type().is_symlink() {
                return Err(plain_error("asset manifest path must be a real file"));
            }
            Ok(())
        }
        Err(error) if is_code(&error, "ENOENT") => Ok(()),
        Err(error) => Err(error),
    }
}

fn read_manifest_unlocked(document_path: &str, manifest_path: &str) -> R<OwnedAssetManifest> {
    let Some(_) = existing_assets_dir(document_path)? else {
        return Ok(OwnedAssetManifest::empty());
    };
    let attempt = (|| -> R<OwnedAssetManifest> {
        assert_safe_manifest_file(manifest_path)?;
        let text = read_file_utf8(manifest_path)?;
        let value = json_parse(&text).map_err(|_| plain_error("asset manifest is invalid JSON"))?;
        normalized_manifest(&value)
    })();
    match attempt {
        Err(error) if is_code(&error, "ENOENT") => Ok(OwnedAssetManifest::empty()),
        other => other,
    }
}

fn write_manifest_unlocked(
    document_path: &str,
    manifest: &OwnedAssetManifest,
    manifest_path: &str,
) -> R<()> {
    ensure_assets_dir(document_path)?;
    let normalized = normalized_manifest(&manifest.to_json())?;
    let text = format!("{}\n", json_stringify_pretty(&normalized.to_json(), 2));
    assert_safe_manifest_file(manifest_path)?;
    atomic_write_file(manifest_path, text.as_bytes())
}

/// the resolution `withManifestLock` performs once the lock is held
fn locked_manifest_path(document_path: &str) -> String {
    manifest_path_in(&assets_dir_for(document_path))
}

fn add_owned_record(document_path: &str, record: OwnedAssetRecord) -> R<()> {
    let manifest_path = locked_manifest_path(document_path);
    let mut manifest = read_manifest_unlocked(document_path, &manifest_path)?;
    let existing = manifest.files.iter().find(|file| file.name == record.name);
    if let Some(existing) = existing
        && existing.sha256 != record.sha256
    {
        return Err(plain_error(
            "asset manifest already owns a different file with this name",
        ));
    }
    let key = document_key(document_path);
    let name = record.name.clone();
    if existing.is_none() {
        manifest.files.push(record);
    }
    let mut names: Vec<String> = manifest.pending.get(&key).cloned().unwrap_or_default();
    names.push(name);
    manifest.pending.set(&key, sorted_unique(names));
    write_manifest_unlocked(document_path, &manifest, &manifest_path)
}

fn create_owned_asset(
    document_path: &str,
    preferred_name: &str,
    create: &dyn Fn(&str) -> R<()>,
) -> R<String> {
    let assets_dir = ensure_assets_dir(document_path)?;
    let base = sanitize_asset_name(preferred_name);
    for suffix in 0..100_000u32 {
        let name = name_with_suffix(&base, suffix);
        let target = join(&[&assets_dir, &name]);
        match create(&target) {
            Ok(()) => {}
            Err(error) if is_code(&error, "EEXIST") => continue,
            Err(error) => return Err(error),
        }
        let recorded = sha256_file(&target).and_then(|sha256| {
            add_owned_record(
                document_path,
                OwnedAssetRecord {
                    name: name.clone(),
                    sha256,
                },
            )
        });
        return match recorded {
            Ok(()) => Ok(format!("assets/{name}")),
            Err(error) => {
                let _ = rm_file(&target, true);
                Err(error)
            }
        };
    }
    Err(plain_error("markdown asset name space exhausted"))
}

/// `copyImageIntoOwnedAssets(documentPath, sourcePath)`
pub fn copy_image_into_owned_assets(document_path: &str, source_path: &str) -> R<String> {
    create_owned_asset(document_path, &basename(source_path, None), &|target| {
        copy_file_excl(source_path, target)
    })
}

/// `writeImageIntoOwnedAssets(documentPath, preferredName, bytes)`
pub fn write_image_into_owned_assets(
    document_path: &str,
    preferred_name: &str,
    bytes: &[u8],
) -> R<String> {
    create_owned_asset(document_path, preferred_name, &|target| {
        write_file_excl(target, bytes)
    })
}

fn decode_local_source(source: &str) -> Option<String> {
    let trimmed = trim(source);
    if trimmed.is_empty()
        || trimmed.contains('\0')
        || trimmed.contains('?')
        || trimmed.contains('#')
        || trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || js_regex!(r"^[a-zA-Z]:[\\/]").test(trimmed)
        || js_regex!(r"^[a-z][a-z0-9+.-]*:", "i").test(trimmed)
    {
        return None;
    }
    decode_uri_component(trimmed).ok()
}

/// `realpath(path)`
fn realpath(path: &str) -> R<String> {
    fs::canonicalize(namespaced(path))
        .map(|real| real.to_string_lossy().into_owned())
        .map_err(|e| node_error(&e, "realpath", path))
}

fn stat_is_file(path: &str) -> R<bool> {
    fs::metadata(namespaced(path))
        .map(|meta| meta.is_file())
        .map_err(|e| node_error(&e, "stat", path))
}

/// `resolveSafeRelativeImagePath(documentPath, source)`
pub fn resolve_safe_relative_image_path(document_path: &str, source: &str) -> Option<String> {
    let decoded = decode_local_source(source).filter(|d| !d.is_empty())?;
    let document_dir = dirname(&resolve(&[document_path]));
    let candidate = resolve(&[&document_dir, &decoded.replace(['\\', '/'], SEP)]);
    if !is_path_inside(&document_dir, &candidate) {
        return None;
    }
    let real_document_dir = realpath(&document_dir).ok()?;
    let real_candidate = realpath(&candidate).ok()?;
    let is_file = stat_is_file(&candidate).ok()?;
    if !is_file || !is_path_inside(&real_document_dir, &real_candidate) {
        return None;
    }
    Some(real_candidate)
}

/// `resolveSafeVaultImagePath(root, target)`
pub fn resolve_safe_vault_image_path(root: &str, target: &str) -> Option<String> {
    let vault_root = resolve(&[root]);
    if !is_in_doc_dir(target, &vault_root, SEP) {
        return None;
    }
    let real_root = realpath(&vault_root).ok()?;
    let real_candidate = realpath(target).ok()?;
    let is_file = stat_is_file(target).ok()?;
    if !is_file || !is_in_doc_dir(&real_candidate, &real_root, SEP) {
        return None;
    }
    Some(real_candidate)
}

fn owned_name_for_source(source: &str) -> Option<String> {
    let decoded = decode_local_source(source)?;
    let slashed = decoded.replace('\\', "/");
    let parts: Vec<&str> = slashed
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    if parts.len() != 2
        || parts[0].to_lowercase() != "assets"
        || parts.contains(&"..")
        || !is_safe_asset_name(parts[1])
    {
        return None;
    }
    Some(parts[1].to_owned())
}

fn sibling_markdown_references(
    document_path: &str,
    owned_names: &HashSet<String>,
    include_current: bool,
) -> HashSet<String> {
    let mut references: HashSet<String> = HashSet::new();
    let document_dir = dirname(&resolve(&[document_path]));
    let current_key = document_key(document_path);
    let Ok(reader) = fs::read_dir(namespaced(&document_dir)) else {
        return owned_names.clone();
    };
    let mut entries: Vec<(String, bool)> = Vec::new();
    for entry in reader {
        let Ok(entry) = entry else {
            return owned_names.clone();
        };
        let Ok(kind) = entry.file_type() else {
            return owned_names.clone();
        };
        entries.push((
            entry.file_name().to_string_lossy().into_owned(),
            kind.is_file(),
        ));
    }
    // libuv sorts the names by bytes
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, is_file) in entries {
        if !is_file
            || (!include_current && name == current_key)
            || !js_regex!(r"\.(?:md|markdown)$", "i").test(&name)
        {
            continue;
        }
        let path = join(&[&document_dir, &name]);
        let Ok(meta) = fs::metadata(namespaced(&path)) else {
            return owned_names.clone();
        };
        // refuse to load an unexpectedly huge sibling just for GC: preserving
        // all candidates is the safe fallback when its references are unknown
        if StatInfo::of(&meta).size > 16 * 1024 * 1024 {
            return owned_names.clone();
        }
        let Ok(text) = read_file_utf8(&path) else {
            return owned_names.clone();
        };
        let Ok(scan) = scan_image_sources(&text) else {
            return owned_names.clone();
        };
        // a browser may still recover an image source from malformed HTML in a
        // way this deliberately small parser cannot prove
        if scan.ambiguous_html {
            return owned_names.clone();
        }
        for range in &scan.ranges {
            if let Some(owned) = owned_name_for_source(&range.source)
                && owned_names.contains(&owned)
            {
                references.insert(owned);
            }
        }
    }
    references
}

/// `isInDocDir(target, dir, separator)`: a resolved image target lives inside
/// a resolved document directory (the md-asset:// serve gate).
pub fn is_in_doc_dir(target: &str, dir: &str, separator: &str) -> bool {
    if target == dir {
        return false;
    }
    let prefix = if dir.ends_with(separator) {
        dir.to_owned()
    } else {
        format!("{dir}{separator}")
    };
    target.starts_with(&prefix)
}

/// the names every document and pending entry refers to
fn referenced_names(manifest: &OwnedAssetManifest) -> HashSet<String> {
    manifest
        .documents
        .iter()
        .chain(manifest.pending.iter())
        .flat_map(|(_, names)| names.iter().cloned())
        .collect()
}

/// the `try` of the loops below: the file is the one the manifest recorded
fn is_owned_file(path: &str, sha256: &str) -> R<bool> {
    let info = lstat(path)?;
    if !info.is_file() || info.file_type().is_symlink() {
        return Ok(false);
    }
    Ok(sha256_file(path)? == sha256)
}

fn prune(table: &mut OrdMap<Vec<String>>, keep: &dyn Fn(&str) -> bool) {
    let keys: Vec<String> = table.keys().map(str::to_owned).collect();
    for key in keys {
        let kept: Vec<String> = table
            .get(&key)
            .map(|names| names.iter().filter(|name| keep(name)).cloned().collect())
            .unwrap_or_default();
        if kept.is_empty() {
            table.remove(&key);
        } else {
            table.set(&key, kept);
        }
    }
}

fn remove_created_records(document_path: &str, created: &[OwnedAssetRecord]) -> R<()> {
    if created.is_empty() {
        return Ok(());
    }
    let manifest_path = locked_manifest_path(document_path);
    let mut manifest = read_manifest_unlocked(document_path, &manifest_path)?;
    let created_names: HashSet<&str> = created.iter().map(|record| record.name.as_str()).collect();
    let key = document_key(document_path);
    let left: Vec<String> = manifest
        .pending
        .get(&key)
        .map(|names| {
            names
                .iter()
                .filter(|name| !created_names.contains(name.as_str()))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if left.is_empty() {
        manifest.pending.remove(&key);
    } else {
        manifest.pending.set(&key, left);
    }
    let referenced = referenced_names(&manifest);
    let mut remove_names: HashSet<String> = HashSet::new();
    for record in created {
        if referenced.contains(&record.name) {
            continue;
        }
        let current = manifest
            .files
            .iter()
            .any(|file| file.name == record.name && file.sha256 == record.sha256);
        if !current {
            continue;
        }
        let path = join(&[&assets_dir_for(document_path), &record.name]);
        let outcome = (|| -> R<bool> {
            if !is_owned_file(&path, &record.sha256)? {
                return Ok(false);
            }
            rm_file(&path, false)?;
            Ok(true)
        })();
        match outcome {
            Ok(true) => {
                remove_names.insert(record.name.clone());
            }
            Ok(false) => {}
            Err(error) if is_code(&error, "ENOENT") => {
                remove_names.insert(record.name.clone());
            }
            Err(_) => {}
        }
    }
    manifest
        .files
        .retain(|file| !remove_names.contains(&file.name));
    prune(&mut manifest.documents, &|name| {
        !remove_names.contains(name)
    });
    prune(&mut manifest.pending, &|name| !remove_names.contains(name));
    write_manifest_unlocked(document_path, &manifest, &manifest_path)
}

/// `prepareAssetsForSaveAs(sourceDocumentPath, targetDocumentPath, text, imageSources)`
pub fn prepare_assets_for_save_as(
    source_document_path: &str,
    target_document_path: &str,
    text: &str,
    image_sources: &[String],
) -> R<PreparedSaveAsAssets> {
    let mut all_image_sources: Vec<String> = image_sources.to_vec();
    let mut known_sources: HashSet<String> = all_image_sources.iter().cloned().collect();
    for source in extract_markdown_image_sources(text)? {
        if known_sources.contains(&source) {
            continue;
        }
        known_sources.insert(source.clone());
        all_image_sources.push(source);
    }
    if resolve(&[&dirname(source_document_path)]) == resolve(&[&dirname(target_document_path)]) {
        return Ok(PreparedSaveAsAssets {
            target_document_path: target_document_path.to_owned(),
            text: text.to_owned(),
            image_sources: all_image_sources,
            rewrites: Vec::new(),
            created: Vec::new(),
        });
    }

    let mut created: Vec<OwnedAssetRecord> = Vec::new();
    let mut rewrites: OrdMap<String> = OrdMap::new();
    let target_assets_dir = ensure_assets_dir(target_document_path)?;
    let locked = (|| -> R<()> {
        let manifest_path = locked_manifest_path(target_document_path);
        let mut manifest = read_manifest_unlocked(target_document_path, &manifest_path)?;
        let mut reserved_names: HashSet<String> = manifest
            .files
            .iter()
            .map(|file| file.name.clone())
            .collect();
        let mut copied_by_real_path: OrdMap<String> = OrdMap::new();
        for source in &all_image_sources {
            if rewrites.has(source) {
                continue;
            }
            let Some(safe_source) = resolve_safe_relative_image_path(source_document_path, source)
            else {
                continue;
            };
            if let Some(already_copied) = copied_by_real_path.get(&safe_source) {
                let already_copied = already_copied.clone();
                rewrites.set(source, already_copied);
                continue;
            }

            let base = sanitize_asset_name(&basename(&safe_source, None));
            let mut copied: Option<OwnedAssetRecord> = None;
            for suffix in 0..100_000u32 {
                let name = name_with_suffix(&base, suffix);
                if reserved_names.contains(&name) {
                    continue;
                }
                let target = join(&[&target_assets_dir, &name]);
                let attempt =
                    copy_file_excl(&safe_source, &target).and_then(|()| sha256_file(&target));
                match attempt {
                    Ok(sha256) => {
                        copied = Some(OwnedAssetRecord { name, sha256 });
                        break;
                    }
                    Err(error) if is_code(&error, "EEXIST") => continue,
                    Err(error) => return Err(error),
                }
            }
            let Some(copied) = copied else {
                return Err(plain_error("markdown asset name space exhausted"));
            };
            created.push(copied.clone());
            manifest.files.push(copied.clone());
            reserved_names.insert(copied.name.clone());
            let target_key = document_key(target_document_path);
            let mut names: Vec<String> = manifest
                .pending
                .get(&target_key)
                .cloned()
                .unwrap_or_default();
            names.push(copied.name.clone());
            manifest.pending.set(&target_key, sorted_unique(names));
            let authored = format!("assets/{}", copied.name);
            copied_by_real_path.set(&safe_source, authored.clone());
            rewrites.set(source, authored);
        }
        let rewritten_destinations: HashSet<String> =
            extract_markdown_image_sources(&rewrite_markdown_image_sources(text, &rewrites)?)?
                .into_iter()
                .collect();
        for (_, destination) in rewrites.iter() {
            if !rewritten_destinations.contains(destination) {
                return Err(plain_error(
                    "could not safely rewrite a Markdown image during Save As",
                ));
            }
        }
        write_manifest_unlocked(target_document_path, &manifest, &manifest_path)
    })();
    if let Err(error) = locked {
        for record in &created {
            let _ = rm_file(&join(&[&target_assets_dir, &record.name]), true);
        }
        return Err(error);
    }

    let rewrite_list: Vec<AssetRewrite> = rewrites
        .iter()
        .map(|(from, to)| AssetRewrite {
            from: from.to_owned(),
            to: to.clone(),
        })
        .collect();
    Ok(PreparedSaveAsAssets {
        target_document_path: target_document_path.to_owned(),
        text: rewrite_markdown_image_sources(text, &rewrites)?,
        image_sources: all_image_sources
            .iter()
            .map(|source| {
                rewrites
                    .get(source)
                    .cloned()
                    .unwrap_or_else(|| source.clone())
            })
            .collect(),
        rewrites: rewrite_list,
        created,
    })
}

/// `rollbackPreparedSaveAsAssets(plan)`
pub fn rollback_prepared_save_as_assets(plan: &PreparedSaveAsAssets) -> R<()> {
    remove_created_records(&plan.target_document_path, &plan.created)
}

/// `pendingOwnedAssetsForDocument(documentPath)`
pub fn pending_owned_assets_for_document(document_path: &str) -> Vec<String> {
    let attempt = (|| -> R<Vec<String>> {
        let manifest_path = locked_manifest_path(document_path);
        let manifest = read_manifest_unlocked(document_path, &manifest_path)?;
        Ok(manifest
            .pending
            .get(&document_key(document_path))
            .cloned()
            .unwrap_or_default())
    })();
    attempt.unwrap_or_default()
}

fn error_text(error: &NodeError) -> &str {
    &error.message
}

fn resolve_pending_inner(
    document_path: &str,
    pending_at_operation_start: Option<&[String]>,
    result: &mut ReconcileResult,
) -> R<()> {
    let manifest_path = locked_manifest_path(document_path);
    let mut manifest = read_manifest_unlocked(document_path, &manifest_path)?;
    let key = document_key(document_path);
    let current_pending: Vec<String> = manifest.pending.get(&key).cloned().unwrap_or_default();
    let requested: HashSet<String> = match pending_at_operation_start {
        Some(names) => names.iter().cloned().collect(),
        None => current_pending.iter().cloned().collect(),
    };
    let pending_names: Vec<String> = current_pending
        .iter()
        .filter(|name| requested.contains(*name))
        .cloned()
        .collect();
    if pending_names.is_empty() {
        return Ok(());
    }
    let left: Vec<String> = current_pending
        .iter()
        .filter(|name| !pending_names.contains(name))
        .cloned()
        .collect();
    if left.is_empty() {
        manifest.pending.remove(&key);
    } else {
        manifest.pending.set(&key, left);
    }

    let Some(assets_dir) = existing_assets_dir(document_path)? else {
        return Ok(());
    };
    let mut records_by_name: OrdMap<OwnedAssetRecord> = OrdMap::new();
    for record in &manifest.files {
        records_by_name.set(&record.name, record.clone());
    }
    let owned_names: HashSet<String> = records_by_name.keys().map(str::to_owned).collect();
    let mut referenced = referenced_names(&manifest);
    for name in sibling_markdown_references(document_path, &owned_names, true) {
        referenced.insert(name);
    }

    let mut relinquished: HashSet<String> = HashSet::new();
    for name in &pending_names {
        let Some(record) = records_by_name.get(name) else {
            continue;
        };
        let path = join(&[&assets_dir, name]);
        let outcome = (|| -> R<bool> {
            if !is_owned_file(&path, &record.sha256)? {
                relinquished.insert(name.clone());
                result.preserved.push(name.clone());
                return Ok(false);
            }
            if referenced.contains(name) {
                result.preserved.push(name.clone());
                return Ok(false);
            }
            rm_file(&path, false)?;
            relinquished.insert(name.clone());
            result.deleted.push(name.clone());
            Ok(true)
        })();
        if let Err(error) = outcome {
            if is_code(&error, "ENOENT") {
                relinquished.insert(name.clone());
            } else {
                result.preserved.push(name.clone());
                result
                    .errors
                    .push(format!("{name}: {}", error_text(&error)));
            }
        }
    }

    manifest
        .files
        .retain(|record| !relinquished.contains(&record.name));
    prune(&mut manifest.documents, &|name| {
        !relinquished.contains(name)
    });
    prune(&mut manifest.pending, &|name| !relinquished.contains(name));
    write_manifest_unlocked(document_path, &manifest, &manifest_path)
}

fn resolve_pending_owned_assets(
    document_path: &str,
    pending_at_operation_start: Option<&[String]>,
) -> ReconcileResult {
    let mut result = ReconcileResult::default();
    if let Err(error) =
        resolve_pending_inner(document_path, pending_at_operation_start, &mut result)
    {
        result.errors.push(error_text(&error).to_owned());
    }
    result
}

/// `discardPendingOwnedAssets(documentPath)`
pub fn discard_pending_owned_assets(document_path: &str) -> ReconcileResult {
    resolve_pending_owned_assets(document_path, None)
}

/// `resolveSourcePendingAfterSaveAs(sourceDocumentPath, pendingAtSaveStart)`
pub fn resolve_source_pending_after_save_as(
    source_document_path: &str,
    pending_at_save_start: &[String],
) -> ReconcileResult {
    resolve_pending_owned_assets(source_document_path, Some(pending_at_save_start))
}

fn reconcile_inner(
    document_path: &str,
    image_sources: &[String],
    pending_names: Option<&[String]>,
    result: &mut ReconcileResult,
) -> R<()> {
    let manifest_path = locked_manifest_path(document_path);
    let mut manifest = read_manifest_unlocked(document_path, &manifest_path)?;
    let Some(assets_dir) = existing_assets_dir(document_path)? else {
        return Ok(());
    };

    let mut valid_records: Vec<OwnedAssetRecord> = Vec::new();
    let mut relinquished: HashSet<String> = HashSet::new();
    for record in &manifest.files {
        let path = join(&[&assets_dir, &record.name]);
        match is_owned_file(&path, &record.sha256) {
            Ok(false) => {
                relinquished.insert(record.name.clone());
                result.preserved.push(record.name.clone());
            }
            Ok(true) => valid_records.push(record.clone()),
            Err(error) => {
                if !is_code(&error, "ENOENT") {
                    relinquished.insert(record.name.clone());
                    result.preserved.push(record.name.clone());
                    result
                        .errors
                        .push(format!("{}: {}", record.name, error_text(&error)));
                }
            }
        }
    }
    manifest.files = valid_records.clone();

    let owned_names: HashSet<String> = valid_records.iter().map(|r| r.name.clone()).collect();
    prune(&mut manifest.documents, &|name| {
        owned_names.contains(name) && !relinquished.contains(name)
    });
    prune(&mut manifest.pending, &|name| {
        owned_names.contains(name) && !relinquished.contains(name)
    });

    let mut current_references: Vec<String> = Vec::new();
    for source in image_sources {
        if let Some(name) = owned_name_for_source(source)
            && owned_names.contains(&name)
        {
            current_references.push(name);
        }
    }
    let key = document_key(document_path);
    if !current_references.is_empty() {
        manifest
            .documents
            .set(&key, sorted_unique(current_references));
    } else {
        manifest.documents.remove(&key);
    }
    let pending_to_resolve: HashSet<String> = match pending_names {
        Some(names) => names.iter().cloned().collect(),
        None => manifest
            .pending
            .get(&key)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect(),
    };
    let left: Vec<String> = manifest
        .pending
        .get(&key)
        .map(|names| {
            names
                .iter()
                .filter(|name| !pending_to_resolve.contains(*name))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if left.is_empty() {
        manifest.pending.remove(&key);
    } else {
        manifest.pending.set(&key, left);
    }

    let mut referenced = referenced_names(&manifest);
    for name in sibling_markdown_references(document_path, &owned_names, false) {
        referenced.insert(name);
    }
    let mut deleted: HashSet<String> = HashSet::new();
    for record in &valid_records {
        if referenced.contains(&record.name) {
            continue;
        }
        let path = join(&[&assets_dir, &record.name]);
        let outcome = (|| -> R<bool> {
            if !is_owned_file(&path, &record.sha256)? {
                return Ok(false);
            }
            rm_file(&path, false)?;
            Ok(true)
        })();
        match outcome {
            Ok(false) => result.preserved.push(record.name.clone()),
            Ok(true) => {
                deleted.insert(record.name.clone());
                result.deleted.push(record.name.clone());
            }
            Err(error) if is_code(&error, "ENOENT") => {
                deleted.insert(record.name.clone());
            }
            Err(error) => result
                .errors
                .push(format!("{}: {}", record.name, error_text(&error))),
        }
    }
    manifest
        .files
        .retain(|record| !deleted.contains(&record.name));
    prune(&mut manifest.documents, &|name| !deleted.contains(name));
    prune(&mut manifest.pending, &|name| !deleted.contains(name));
    if let Err(error) = write_manifest_unlocked(document_path, &manifest, &manifest_path) {
        result.errors.push(error_text(&error).to_owned());
    }
    Ok(())
}

/// `reconcileOwnedAssets(documentPath, imageSources, { pendingNames })`
pub fn reconcile_owned_assets(
    document_path: &str,
    image_sources: &[String],
    pending_names: Option<&[String]>,
) -> ReconcileResult {
    let mut result = ReconcileResult::default();
    if let Err(error) = reconcile_inner(document_path, image_sources, pending_names, &mut result) {
        result.errors.push(error_text(&error).to_owned());
    }
    result
}

/// `renameOwnedAssetDocument(oldDocumentPath, newDocumentPath)`
pub fn rename_owned_asset_document(old_document_path: &str, new_document_path: &str) -> R<()> {
    if resolve(&[&dirname(old_document_path)]) != resolve(&[&dirname(new_document_path)]) {
        return Ok(());
    }
    let manifest_path = locked_manifest_path(new_document_path);
    let mut manifest = read_manifest_unlocked(new_document_path, &manifest_path)?;
    let old_key = document_key(old_document_path);
    let new_key = document_key(new_document_path);
    let old_references = manifest.documents.get(&old_key).cloned();
    let old_pending = manifest.pending.get(&old_key).cloned();
    if (old_references.is_none() && old_pending.is_none()) || old_key == new_key {
        return Ok(());
    }
    if let Some(old_references) = old_references {
        let mut names: Vec<String> = manifest
            .documents
            .get(&new_key)
            .cloned()
            .unwrap_or_default();
        names.extend(old_references);
        manifest.documents.set(&new_key, sorted_unique(names));
        manifest.documents.remove(&old_key);
    }
    if let Some(old_pending) = old_pending {
        let mut names: Vec<String> = manifest.pending.get(&new_key).cloned().unwrap_or_default();
        names.extend(old_pending);
        manifest.pending.set(&new_key, sorted_unique(names));
        manifest.pending.remove(&old_key);
    }
    write_manifest_unlocked(new_document_path, &manifest, &manifest_path)
}

/// `readOwnedAssetManifest(documentPath)`: `None` is `null`
pub fn read_owned_asset_manifest(document_path: &str) -> Option<OwnedAssetManifest> {
    let attempt = (|| -> R<Option<OwnedAssetManifest>> {
        let Some(assets_dir) = existing_assets_dir(document_path)? else {
            return Ok(None);
        };
        read_manifest_unlocked(document_path, &manifest_path_in(&assets_dir)).map(Some)
    })();
    attempt.ok().flatten()
}
