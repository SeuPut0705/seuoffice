//! `apps/html/src/main/asset-lifecycle.ts`.
//!
//! The app-owned images of an HTML document: the `assets/` folder next to it
//! and the list (`.seuoffice-assets.json`) of the files the app made there,
//! what the saved text still points at, and what is deleted when nothing does.
//!
//! The TypeScript is asynchronous and serialises the work on one list through
//! a promise queue per list (`withManifestLock`); here each function runs to
//! its end, which is the same order, and the lock is the call of `run` with the
//! list's path.
//!
//! Text offsets are UTF-16 code units, as in JavaScript: the scanners walk a
//! `Vec<u16>` of the text (the line-start quirks of `markdownCodeRanges` show
//! in the offsets, so they cannot be bytes). A slice that cuts a surrogate pair
//! cannot be held by a Rust string and comes out as U+FFFD.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Read, Write};
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use jscompat::node_path::host::{
    SEP, basename, dirname, extname, is_absolute, join, relative, resolve,
};
use jscompat::{
    JsMap, JsObject, JsonValue, RegexLimit, decode_uri_component, is_js_space, js_regex,
    json_parse, json_stringify_pretty, parse_int, slice_utf16, sort_by_number, string_less_than,
    try_js_regex,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::html::atomic_write::atomic_write_file;
use crate::html::old_names::{ASSET_MANIFEST_FILENAME_WRITTEN, OLD_ASSET_MANIFEST_FILENAMES};
use crate::node_fs::{NodeError, namespaced, node_error, node_error_fd};
use crate::packages::i18n::existing_or_current;

pub const ASSET_MANIFEST_FILENAME: &str = ".seuoffice-assets.json";

/// never a picture's name: the list, under its current or an earlier name
fn is_manifest_name(name: &str) -> bool {
    name == ASSET_MANIFEST_FILENAME || OLD_ASSET_MANIFEST_FILENAMES.contains(&name)
}

type Res<T> = Result<T, NodeError>;

/// `new Error(message)`
fn plain(message: impl Into<String>) -> NodeError {
    NodeError {
        code: None,
        message: message.into(),
    }
}

/// `errorCode(error)`
fn error_code(error: &NodeError) -> &'static str {
    error.code.unwrap_or("")
}

/// what a search that stopped at the backtrack bound throws
fn limit(stop: RegexLimit) -> NodeError {
    plain(stop.to_string())
}

// ---------- the file system, as Node's promises API answers ----------

fn lstat(path: &str) -> Res<fs::Metadata> {
    fs::symlink_metadata(namespaced(path)).map_err(|e| node_error(&e, "lstat", path))
}

fn stat(path: &str) -> Res<fs::Metadata> {
    fs::metadata(namespaced(path)).map_err(|e| node_error(&e, "stat", path))
}

fn realpath(path: &str) -> Res<String> {
    let real = fs::canonicalize(namespaced(path)).map_err(|e| node_error(&e, "realpath", path))?;
    let text = real.to_string_lossy().into_owned();
    // the verbatim form std gives on Windows is not what Node's realpath answers
    #[cfg(windows)]
    if let Some(plain) = text.strip_prefix(r"\\?\")
        && !plain.starts_with("UNC\\")
    {
        return Ok(plain.to_owned());
    }
    Ok(text)
}

/// `readFile(path)`: `open`, then `read`
fn read_file(path: &str) -> Res<Vec<u8>> {
    let mut file = fs::File::open(namespaced(path)).map_err(|e| node_error(&e, "open", path))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| node_error_fd(&e, "read"))?;
    Ok(bytes)
}

/// `rm(path)` without options: `lstat`, a folder is refused, then `unlink`
fn rm(path: &str) -> Res<()> {
    let info = lstat(path)?;
    if info.is_dir() {
        return Err(NodeError {
            code: Some("ERR_FS_EISDIR"),
            message: format!("Path is a directory: rm returned EISDIR (is a directory) {path}"),
        });
    }
    fs::remove_file(namespaced(path)).map_err(|e| node_error(&e, "unlink", path))
}

/// `mkdir(path, { recursive: true })`
fn mkdir_recursive(path: &str) -> Res<()> {
    fs::create_dir_all(namespaced(path)).map_err(|e| node_error(&e, "mkdir", path))
}

/// `copyFile(from, to, COPYFILE_EXCL)`
fn copy_file_excl(from: &str, to: &str) -> Res<()> {
    crate::node_fs::copy_file(from, to, true)
}

/// `writeFile(path, bytes, { flag: 'wx' })`
fn write_file_new(path: &str, bytes: &[u8]) -> Res<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(namespaced(path))
        .map_err(|e| node_error(&e, "open", path))?;
    file.write_all(bytes)
        .map_err(|e| node_error_fd(&e, "write"))
}

/// `existsSync(path)`
fn exists_sync(path: &str) -> bool {
    fs::metadata(namespaced(path)).is_ok()
}

/// `sha256File(path)`
fn sha256_file(path: &str) -> Res<String> {
    let digest = Sha256::digest(read_file(path)?);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

// ---------- JavaScript helpers ----------

/// `delete record[key]`
fn delete<V: Clone>(record: &mut JsObject<V>, key: &str) {
    if record.get(key).is_none() {
        return;
    }
    // Object.keys order is kept: array indices first, the rest as set
    *record = record
        .entries()
        .into_iter()
        .filter(|(name, _)| *name != key)
        .map(|(name, value)| (name.to_owned(), value.clone()))
        .collect();
}

fn keys_of<V>(record: &JsObject<V>) -> Vec<String> {
    record
        .entries()
        .into_iter()
        .map(|(key, _)| key.to_owned())
        .collect()
}

/// `names.sort()`: by UTF-16 code units
fn sort_names(names: &mut [String]) {
    sort_by_number(names, |a, b| {
        if string_less_than(a, b) {
            -1.0
        } else if string_less_than(b, a) {
            1.0
        } else {
            0.0
        }
    });
}

/// `[...new Set([...first, ...second])].sort()`
fn union_sorted(first: &[String], second: &[String]) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for name in first.iter().chain(second) {
        if seen.insert(name) {
            out.push(name.clone());
        }
    }
    sort_names(&mut out);
    out
}

static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    Collator::try_new(CollatorPreferences::default(), CollatorOptions::default())
        .expect("the compiled root collation")
});

/// `a.localeCompare(b)`, in the root collation
fn locale_compare(a: &str, b: &str) -> f64 {
    match COLLATOR.compare(a, b) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    }
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

// ---------- the manifest ----------

/// `OwnedAssetRecord`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OwnedAssetRecord {
    pub name: String,
    pub sha256: String,
}

/// `OwnedAssetManifest` (its `version` is always 1)
#[derive(Debug, Clone)]
pub struct OwnedAssetManifest {
    pub files: Vec<OwnedAssetRecord>,
    /// HTML file name -> app-owned files referenced by its last successful save.
    pub documents: JsObject<Vec<String>>,
    /// Newly created files stay protected until their owning document successfully saves.
    pub pending: JsObject<Vec<String>>,
}

impl OwnedAssetManifest {
    /// the object `OwnedAssetManifest` is, as JSON
    pub fn to_json(&self) -> serde_json::Value {
        let mut out = serde_json::Map::new();
        out.insert("version".into(), serde_json::Value::from(1));
        out.insert(
            "files".into(),
            serde_json::to_value(&self.files).expect("records print"),
        );
        out.insert(
            "documents".into(),
            serde_json::to_value(&self.documents).expect("references print"),
        );
        out.insert(
            "pending".into(),
            serde_json::to_value(&self.pending).expect("references print"),
        );
        serde_json::Value::Object(out)
    }

    fn to_js(&self) -> JsonValue {
        let refs = |record: &JsObject<Vec<String>>| {
            JsonValue::Object(
                record
                    .entries()
                    .into_iter()
                    .map(|(key, names)| {
                        (
                            key.to_owned(),
                            JsonValue::Array(
                                names.iter().cloned().map(JsonValue::String).collect(),
                            ),
                        )
                    })
                    .collect(),
            )
        };
        let files = self
            .files
            .iter()
            .map(|record| {
                JsonValue::Object(
                    [
                        ("name".to_owned(), JsonValue::String(record.name.clone())),
                        (
                            "sha256".to_owned(),
                            JsonValue::String(record.sha256.clone()),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                )
            })
            .collect();
        JsonValue::Object(
            [
                ("version".to_owned(), JsonValue::Number(1.0)),
                ("files".to_owned(), JsonValue::Array(files)),
                ("documents".to_owned(), refs(&self.documents)),
                ("pending".to_owned(), refs(&self.pending)),
            ]
            .into_iter()
            .collect(),
        )
    }
}

/// `AssetRewrite`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreparedSaveAsAssets {
    #[serde(rename = "targetDocumentPath")]
    pub target_document_path: String,
    pub text: String,
    #[serde(rename = "imageSources")]
    pub image_sources: Vec<String>,
    pub rewrites: Vec<AssetRewrite>,
    pub created: Vec<OwnedAssetRecord>,
}

/// `emptyManifest()`
fn empty_manifest() -> OwnedAssetManifest {
    OwnedAssetManifest {
        files: Vec::new(),
        documents: JsObject::new(),
        pending: JsObject::new(),
    }
}

/// `assetsDirFor(documentPath)`
fn assets_dir_for(document_path: &str) -> String {
    join(&[&dirname(&resolve(&[document_path])), "assets"])
}

/// `documentKey(documentPath)`
fn document_key(document_path: &str) -> String {
    basename(&resolve(&[document_path]), None)
}

/// `manifestPathIn(assetsDir)`: an assets folder an earlier version made keeps
/// its list under the name it was given.
fn manifest_path_in(assets_dir: &str) -> String {
    let name = existing_or_current(
        ASSET_MANIFEST_FILENAME,
        &OLD_ASSET_MANIFEST_FILENAMES,
        |old| exists_sync(&join(&[assets_dir, old])),
        None,
    );
    // neither exists: a new folder gets the name 0.12.37 can read
    if name == ASSET_MANIFEST_FILENAME && !exists_sync(&join(&[assets_dir, &name])) {
        return join(&[assets_dir, ASSET_MANIFEST_FILENAME_WRITTEN]);
    }
    join(&[assets_dir, &name])
}

/// `isSafeAssetName(name)`
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

/// `replaceControlCharacters(value)`
fn replace_control_characters(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if (character as u32) < 32 {
                '_'
            } else {
                character
            }
        })
        .collect()
}

/// `sanitizeAssetName(input)`: path.win32.basename reads a leading `<letter>:`
/// as a drive prefix and strips it before the sanitizer ever sees the colon, so
/// colons are replaced first.
fn sanitize_asset_name(input: &str) -> String {
    let raw = basename(&input.replace('\\', "/").replace(':', "_"), None);
    let raw_ext = extname(&raw);
    let ext = if js_regex!(r"^\.[a-z0-9]{1,10}$", "i").test(&raw_ext) {
        raw_ext.to_lowercase()
    } else {
        String::new()
    };
    let max_stem = 140 - ext.len();
    let stem = replace_control_characters(&raw[..raw.len() - raw_ext.len()]);
    let stem = js_regex!(r#"[/\\:*?"<>|#%]+"#).replace_all(&stem, |_| "_".to_owned());
    let stem = js_regex!(r"\s+").replace_all(&stem, |_| "_".to_owned());
    let stem = js_regex!(r"^\.+").replace_all(&stem, |_| String::new());
    let stem = slice_utf16(&stem, 0.0, Some(max_stem as f64));
    let stem = js_regex!(r"[. ]+$").replace_all(&stem, |_| String::new());
    let stem = if stem.is_empty() {
        "image".to_owned()
    } else {
        stem
    };
    let name = format!("{stem}{ext}");
    if is_manifest_name(&name) {
        format!("image-{name}")
    } else {
        name
    }
}

/// `nameWithSuffix(name, suffix)`
fn name_with_suffix(name: &str, suffix: usize) -> String {
    if suffix == 0 {
        return name.to_owned();
    }
    let ext = extname(name);
    let stem = basename(name, if ext.is_empty() { None } else { Some(&ext) });
    format!("{stem}-{suffix}{ext}")
}

/// the `documents` and `pending` tables of `normalizedManifest`, whose words
/// differ: `what` is `document` or `pending`
fn normalized_references(
    raw: Option<std::borrow::Cow<'_, JsonValue>>,
    what: &str,
) -> Res<JsObject<Vec<String>>> {
    let mut out: JsObject<Vec<String>> = JsObject::new();
    let Some(raw) = raw else {
        return Ok(out);
    };
    let JsonValue::Object(table) = &*raw else {
        return Err(plain(format!("asset manifest has bad {what} references")));
    };
    for (key, names) in table.entries() {
        let JsonValue::Array(names) = names else {
            return Err(plain(format!(
                "asset manifest has unsafe {what} references"
            )));
        };
        if !is_safe_asset_name(key) {
            return Err(plain(format!(
                "asset manifest has unsafe {what} references"
            )));
        }
        let mut unique: Vec<String> = Vec::new();
        for name in names {
            match name {
                JsonValue::String(text) if is_safe_asset_name(text) => {
                    if !unique.contains(text) {
                        unique.push(text.clone());
                    }
                }
                _ => {
                    return Err(plain(format!(
                        "asset manifest has unsafe {what} references"
                    )));
                }
            }
        }
        sort_names(&mut unique);
        out.set(key, unique);
    }
    Ok(out)
}

/// `normalizedManifest(value)`
fn normalized_manifest(value: &JsonValue) -> Res<OwnedAssetManifest> {
    match value {
        JsonValue::Object(_) | JsonValue::Array(_) => {}
        _ => return Err(plain("asset manifest is not an object")),
    }
    let files_raw = value.get("files");
    let version_is_one =
        matches!(value.get("version").as_deref(), Some(JsonValue::Number(x)) if *x == 1.0);
    let Some(JsonValue::Array(items)) = files_raw.as_deref().filter(|_| version_is_one) else {
        return Err(plain("asset manifest has an unsupported format"));
    };

    let mut files: Vec<OwnedAssetRecord> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for item in items {
        if !matches!(item, JsonValue::Object(_) | JsonValue::Array(_)) {
            return Err(plain("asset manifest has a bad file entry"));
        }
        let name = item.get("name");
        let sha256 = item.get("sha256");
        match (name.as_deref(), sha256.as_deref()) {
            (Some(JsonValue::String(name)), Some(JsonValue::String(sha256)))
                if is_safe_asset_name(name)
                    && js_regex!(r"^[a-f0-9]{64}$").test(sha256)
                    && !seen.contains(name) =>
            {
                seen.insert(name.clone());
                files.push(OwnedAssetRecord {
                    name: name.clone(),
                    sha256: sha256.clone(),
                });
            }
            _ => return Err(plain("asset manifest has an unsafe file entry")),
        }
    }

    let documents = normalized_references(value.get("documents"), "document")?;
    let pending = normalized_references(value.get("pending"), "pending")?;

    sort_by_number(&mut files, |a, b| locale_compare(&a.name, &b.name));
    Ok(OwnedAssetManifest {
        files,
        documents,
        pending,
    })
}

/// `existingAssetsDir(documentPath)`
fn existing_assets_dir(document_path: &str) -> Res<Option<String>> {
    let assets_dir = assets_dir_for(document_path);
    match lstat(&assets_dir) {
        Ok(info) => {
            if !info.is_dir() || info.file_type().is_symlink() {
                return Err(plain("html assets path must be a real directory"));
            }
            Ok(Some(assets_dir))
        }
        Err(error) => {
            if error_code(&error) == "ENOENT" {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

/// `ensureAssetsDir(documentPath)`
fn ensure_assets_dir(document_path: &str) -> Res<String> {
    if let Some(existing) = existing_assets_dir(document_path)? {
        return Ok(existing);
    }
    let assets_dir = assets_dir_for(document_path);
    mkdir_recursive(&assets_dir)?;
    let info = lstat(&assets_dir)?;
    if !info.is_dir() || info.file_type().is_symlink() {
        return Err(plain("html assets path must be a real directory"));
    }
    Ok(assets_dir)
}

/// `assertSafeManifestFile(path)`
fn assert_safe_manifest_file(path: &str) -> Res<()> {
    match lstat(path) {
        Ok(info) => {
            if !info.is_file() || info.file_type().is_symlink() {
                return Err(plain("asset manifest path must be a real file"));
            }
            Ok(())
        }
        Err(error) => {
            if error_code(&error) != "ENOENT" {
                return Err(error);
            }
            Ok(())
        }
    }
}

/// `readManifestUnlocked(documentPath, manifestPath)`
fn read_manifest_unlocked(document_path: &str, manifest_path: &str) -> Res<OwnedAssetManifest> {
    if existing_assets_dir(document_path)?.is_none() {
        return Ok(empty_manifest());
    }
    let read = assert_safe_manifest_file(manifest_path).and_then(|()| read_file(manifest_path));
    let bytes = match read {
        Ok(bytes) => bytes,
        Err(error) => {
            if error_code(&error) == "ENOENT" {
                return Ok(empty_manifest());
            }
            return Err(error);
        }
    };
    match json_parse(&String::from_utf8_lossy(&bytes)) {
        Ok(value) => normalized_manifest(&value),
        Err(_) => Err(plain("asset manifest is invalid JSON")),
    }
}

/// `writeManifestUnlocked(documentPath, manifest, manifestPath)`
fn write_manifest_unlocked(
    document_path: &str,
    manifest: &OwnedAssetManifest,
    manifest_path: &str,
) -> Res<()> {
    ensure_assets_dir(document_path)?;
    let normalized = normalized_manifest(&manifest.to_js())?;
    let text = format!("{}\n", json_stringify_pretty(&normalized.to_js(), 2));
    assert_safe_manifest_file(manifest_path)?;
    atomic_write_file(manifest_path, text.as_bytes())
}

/// `withManifestLock(documentPath, run)`: `run` gets the manifest path,
/// resolved once with the lock held.
fn with_manifest_lock<T>(document_path: &str, run: impl FnOnce(&str) -> Res<T>) -> Res<T> {
    run(&manifest_path_in(&assets_dir_for(document_path)))
}

/// `addOwnedRecord(documentPath, record)`
fn add_owned_record(document_path: &str, record: &OwnedAssetRecord) -> Res<()> {
    with_manifest_lock(document_path, |manifest_path| {
        let mut manifest = read_manifest_unlocked(document_path, manifest_path)?;
        let existing = manifest.files.iter().find(|file| file.name == record.name);
        if let Some(existing) = existing {
            if existing.sha256 != record.sha256 {
                return Err(plain(
                    "asset manifest already owns a different file with this name",
                ));
            }
        } else {
            manifest.files.push(record.clone());
        }
        let key = document_key(document_path);
        let current = manifest.pending.get(&key).cloned().unwrap_or_default();
        manifest.pending.set(
            key,
            union_sorted(&current, std::slice::from_ref(&record.name)),
        );
        write_manifest_unlocked(document_path, &manifest, manifest_path)
    })
}

/// `createOwnedAsset(documentPath, preferredName, create)`
fn create_owned_asset(
    document_path: &str,
    preferred_name: &str,
    create: &dyn Fn(&str) -> Res<()>,
) -> Res<String> {
    let assets_dir = ensure_assets_dir(document_path)?;
    let base = sanitize_asset_name(preferred_name);
    for suffix in 0..100_000 {
        let name = name_with_suffix(&base, suffix);
        let target = join(&[&assets_dir, &name]);
        if let Err(error) = create(&target) {
            if error_code(&error) == "EEXIST" {
                continue;
            }
            return Err(error);
        }
        let added = sha256_file(&target).and_then(|sha256| {
            add_owned_record(
                document_path,
                &OwnedAssetRecord {
                    name: name.clone(),
                    sha256,
                },
            )
        });
        return match added {
            Ok(()) => Ok(format!("assets/{name}")),
            Err(error) => {
                let _ = rm(&target);
                Err(error)
            }
        };
    }
    Err(plain("html asset name space exhausted"))
}

/// `copyImageIntoOwnedAssets(documentPath, sourcePath)`
pub fn copy_image_into_owned_assets(document_path: &str, source_path: &str) -> Res<String> {
    create_owned_asset(document_path, &basename(source_path, None), &|target| {
        copy_file_excl(source_path, target)
    })
}

/// `writeImageIntoOwnedAssets(documentPath, preferredName, bytes)`
pub fn write_image_into_owned_assets(
    document_path: &str,
    preferred_name: &str,
    bytes: &[u8],
) -> Res<String> {
    create_owned_asset(document_path, preferred_name, &|target| {
        write_file_new(target, bytes)
    })
}

// ---------- local sources ----------

/// `decodeLocalSource(source)`
fn decode_local_source(source: &str) -> Option<String> {
    let trimmed = jscompat::trim(source);
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

/// `isPathInside(root, candidate)`
fn is_path_inside(root: &str, candidate: &str) -> bool {
    let from_root = relative(root, candidate);
    !from_root.is_empty()
        && from_root != ".."
        && !from_root.starts_with(&format!("..{SEP}"))
        && !is_absolute(&from_root)
}

/// `resolveSafeRelativeImagePath(documentPath, source)`: the real path of a
/// file a relative reference names inside the document's folder
pub fn resolve_safe_relative_image_path(document_path: &str, source: &str) -> Option<String> {
    let decoded = decode_local_source(source).filter(|decoded| !decoded.is_empty())?;
    let document_dir = dirname(&resolve(&[document_path]));
    let candidate = resolve(&[
        &document_dir,
        &js_regex!(r"[\\/]").replace_all(&decoded, |_| SEP.to_owned()),
    ]);
    if !is_path_inside(&document_dir, &candidate) {
        return None;
    }
    // Promise.all of the three: the first to fail decides, and none matters here
    let real_document_dir = realpath(&document_dir).ok()?;
    let real_candidate = realpath(&candidate).ok()?;
    let info = stat(&candidate).ok()?;
    if !info.is_file() || !is_path_inside(&real_document_dir, &real_candidate) {
        return None;
    }
    Some(real_candidate)
}

/// `ownedNameForSource(source)`
fn owned_name_for_source(source: &str) -> Option<String> {
    let decoded = decode_local_source(source).filter(|decoded| !decoded.is_empty())?;
    let decoded = decoded.replace('\\', "/");
    let parts: Vec<&str> = decoded
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

// ---------- scanning text ----------

/// `DestinationRange.htmlQuote`: `undefined` for a Markdown destination, `null`
/// for an unquoted attribute, the quote for a quoted one
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HtmlQuote {
    Markdown,
    Unquoted,
    Double,
    Single,
}

/// `DestinationRange`
#[derive(Debug, Clone)]
struct DestinationRange {
    start: usize,
    end: usize,
    source: String,
    html_quote: HtmlQuote,
}

/// `ImageSourceScan`
struct ImageSourceScan {
    ranges: Vec<DestinationRange>,
    ambiguous_html: bool,
}

/// `TextRange`
#[derive(Debug, Clone, Copy)]
struct TextRange {
    start: usize,
    end: usize,
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn text_of(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `text[index] === character`
fn is_at(text: &[u16], index: usize, character: char) -> bool {
    text.get(index).copied() == Some(character as u16)
}

/// `/\s/.test(text[index])` of a code unit
fn is_space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_space)
}

fn is_space_at(text: &[u16], index: usize) -> bool {
    text.get(index).copied().is_some_and(is_space)
}

/// `text.startsWith(needle, index)`
fn starts_with_at(text: &[u16], needle: &str, index: usize) -> bool {
    let needle = units(needle);
    text.get(index..index + needle.len())
        .is_some_and(|part| part == needle.as_slice())
}

/// `text.indexOf(character, from)`
fn index_of_unit(text: &[u16], character: char, from: usize) -> Option<usize> {
    let slice = text.get(from..)?;
    slice
        .iter()
        .position(|unit| *unit == character as u16)
        .map(|found| found + from)
}

/// `text.indexOf(needle, from)`
fn index_of_str(text: &[u16], needle: &str, from: usize) -> Option<usize> {
    let needle = units(needle);
    let slice = text.get(from..)?;
    slice
        .windows(needle.len())
        .position(|window| window == needle.as_slice())
        .map(|found| found + from)
}

/// `escapedAt(text, index)`
fn escaped_at(text: &[u16], index: usize) -> bool {
    let mut slashes = 0;
    let mut i = index;
    while i > 0 && is_at(text, i - 1, '\\') {
        slashes += 1;
        i -= 1;
    }
    slashes % 2 == 1
}

/// `imageDestinationRanges(markdown)`
fn image_destination_ranges(markdown: &[u16]) -> Result<Vec<DestinationRange>, RegexLimit> {
    let length = markdown.len();
    let mut ranges: Vec<DestinationRange> = Vec::new();
    let mut i = 0;
    while i + 2 < length {
        'body: {
            if !is_at(markdown, i, '!') || !is_at(markdown, i + 1, '[') || escaped_at(markdown, i) {
                break 'body;
            }
            let mut bracket_depth = 1;
            let mut alt_end = i + 2;
            while alt_end < length {
                if !escaped_at(markdown, alt_end) {
                    if is_at(markdown, alt_end, '[') {
                        bracket_depth += 1;
                    } else if is_at(markdown, alt_end, ']') {
                        bracket_depth -= 1;
                        if bracket_depth == 0 {
                            break;
                        }
                    }
                }
                alt_end += 1;
            }
            if bracket_depth != 0 {
                break 'body;
            }
            let mut open = alt_end + 1;
            while is_at(markdown, open, ' ') || is_at(markdown, open, '\t') {
                open += 1;
            }
            if !is_at(markdown, open, '(') {
                i = alt_end;
                break 'body;
            }

            let mut close = open + 1;
            let mut paren_depth = 1;
            let mut quote: Option<u16> = None;
            let mut angle = false;
            while close < length {
                let unit = markdown[close];
                if !escaped_at(markdown, close) {
                    if let Some(open_quote) = quote {
                        if unit == open_quote {
                            quote = None;
                        }
                    } else if angle {
                        if unit == u16::from(b'>') {
                            angle = false;
                        }
                    } else if unit == u16::from(b'"') || unit == u16::from(b'\'') {
                        quote = Some(unit);
                    } else if unit == u16::from(b'<') {
                        angle = true;
                    } else if unit == u16::from(b'(') {
                        paren_depth += 1;
                    } else if unit == u16::from(b')') {
                        paren_depth -= 1;
                        if paren_depth == 0 {
                            break;
                        }
                    }
                }
                close += 1;
            }
            if paren_depth != 0 {
                break 'body;
            }

            let mut start = open + 1;
            let mut end = close;
            while start < end && is_space_at(markdown, start) {
                start += 1;
            }
            while end > start && is_space_at(markdown, end - 1) {
                end -= 1;
            }
            if is_at(markdown, start, '<') {
                if let Some(angle_end) = index_of_unit(markdown, '>', start + 1)
                    && angle_end > start
                    && angle_end <= end
                {
                    start += 1;
                    end = angle_end;
                }
            } else {
                let raw = text_of(&markdown[start..end]);
                let title = try_js_regex!(
                    r#"\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))\s*$"#
                )
                .try_exec(&raw)?;
                if let Some(title) = title {
                    end = start + utf16_len(&raw[..title.start()]);
                }
                while end > start && is_space_at(markdown, end - 1) {
                    end -= 1;
                }
            }
            if end > start {
                let source = js_regex!(r"\\([\\()[\]<> ])")
                    .replace_all(&text_of(&markdown[start..end]), |found| {
                        found.get(1).unwrap_or("").to_owned()
                    });
                ranges.push(DestinationRange {
                    start,
                    end,
                    source,
                    html_quote: HtmlQuote::Markdown,
                });
            }
            i = close;
        }
        i += 1;
    }
    Ok(ranges)
}

/// `decodeHtmlImageSource(value)`: the source with the basic entities decoded,
/// and whether an entity made the reading uncertain
fn decode_html_image_source(value: &str) -> (String, bool) {
    let mut ambiguous = false;
    let source = js_regex!(r"&([^&;\s]+);").replace_all(value, |found| {
        let entity = found.as_str();
        let body = found.get(1).unwrap_or("");
        if body.starts_with('#') {
            let hexadecimal = matches!(body.chars().nth(1), Some('x' | 'X'));
            let digits = &body[if hexadecimal { 2 } else { 1 }..];
            let valid = if hexadecimal {
                js_regex!(r"^[0-9a-f]+$", "i").test(digits)
            } else {
                js_regex!(r"^[0-9]+$").test(digits)
            };
            if digits.is_empty() || !valid {
                ambiguous = true;
                return entity.to_owned();
            }
            let code_point = parse_int(
                digits,
                if hexadecimal {
                    jscompat::Radix::Sixteen
                } else {
                    jscompat::Radix::Ten
                },
            );
            if code_point <= 0.0
                || code_point > 1_114_111.0
                || (55_296.0..=57_343.0).contains(&code_point)
            {
                ambiguous = true;
                return entity.to_owned();
            }
            return char::from_u32(code_point as u32)
                .map(String::from)
                .unwrap_or_else(|| entity.to_owned());
        }
        // `BASIC_HTML_ENTITIES[body.toLowerCase()]` reads the prototype of the
        // table too: its all-lower-case names are `constructor` (a function,
        // which the replacement turns into its source text) and `__proto__`
        // (the prototype object)
        match body.to_lowercase().as_str() {
            "amp" => "&".to_owned(),
            "apos" => "'".to_owned(),
            "gt" => ">".to_owned(),
            "lt" => "<".to_owned(),
            "nbsp" => "\u{a0}".to_owned(),
            "quot" => "\"".to_owned(),
            "constructor" => "function Object() { [native code] }".to_owned(),
            "__proto__" => "[object Object]".to_owned(),
            _ => {
                // The complete HTML named-entity table is intentionally not
                // duplicated here. Unknown entities make sibling-GC parsing
                // uncertain and therefore trigger its retain-all fallback.
                ambiguous = true;
                entity.to_owned()
            }
        }
    });
    if js_regex!(r"&#(?:x[0-9a-f]*|[0-9]*)", "i").test(&source) {
        ambiguous = true;
    }
    (source, ambiguous)
}

/// `parseHtmlImageTag(text, tagStart)`: `(nextIndex, range, ambiguous)`
fn parse_html_image_tag(text: &[u16], tag_start: usize) -> (usize, Option<DestinationRange>, bool) {
    let length = text.len();
    let mut cursor = tag_start + 4;
    let mut source_range: Option<DestinationRange> = None;
    let mut ambiguous = false;

    while cursor < length {
        while cursor < length && is_space_at(text, cursor) {
            cursor += 1;
        }
        if cursor >= length {
            return (length, None, true);
        }
        if is_at(text, cursor, '>') {
            let range = if ambiguous { None } else { source_range };
            return (cursor + 1, range, ambiguous);
        }
        if is_at(text, cursor, '/') && is_at(text, cursor + 1, '>') {
            let range = if ambiguous { None } else { source_range };
            return (cursor + 2, range, ambiguous);
        }
        if is_at(text, cursor, '/') {
            ambiguous = true;
            cursor += 1;
            continue;
        }

        let name_start = cursor;
        while cursor < length
            && !is_space_at(text, cursor)
            && !is_at(text, cursor, '=')
            && !is_at(text, cursor, '/')
            && !is_at(text, cursor, '>')
        {
            cursor += 1;
        }
        if cursor == name_start {
            ambiguous = true;
            cursor += 1;
            continue;
        }
        let attribute_name = text_of(&text[name_start..cursor]).to_lowercase();
        while cursor < length && is_space_at(text, cursor) {
            cursor += 1;
        }
        if !is_at(text, cursor, '=') {
            if attribute_name == "src" {
                ambiguous = true;
            }
            continue;
        }

        cursor += 1;
        while cursor < length && is_space_at(text, cursor) {
            cursor += 1;
        }
        if cursor >= length
            || is_at(text, cursor, '>')
            || (is_at(text, cursor, '/') && is_at(text, cursor + 1, '>'))
        {
            if attribute_name == "src" {
                ambiguous = true;
            }
            continue;
        }

        let quote = if is_at(text, cursor, '"') {
            HtmlQuote::Double
        } else if is_at(text, cursor, '\'') {
            HtmlQuote::Single
        } else {
            HtmlQuote::Unquoted
        };
        let value_start;
        let value_end;
        if quote != HtmlQuote::Unquoted {
            value_start = cursor + 1;
            let quote_char = if quote == HtmlQuote::Double {
                '"'
            } else {
                '\''
            };
            match index_of_unit(text, quote_char, value_start) {
                None => return (length, None, true),
                Some(found) => value_end = found,
            }
            cursor = value_end + 1;
        } else {
            value_start = cursor;
            while cursor < length
                && !is_space_at(text, cursor)
                && !is_at(text, cursor, '>')
                && !(is_at(text, cursor, '/') && is_at(text, cursor + 1, '>'))
            {
                if ['"', '\'', '`', '<', '=']
                    .iter()
                    .any(|c| is_at(text, cursor, *c))
                {
                    ambiguous = true;
                }
                cursor += 1;
            }
            value_end = cursor;
            if value_end == value_start && attribute_name == "src" {
                ambiguous = true;
            }
        }

        if attribute_name != "src" {
            continue;
        }
        if source_range.is_some() {
            ambiguous = true;
            continue;
        }
        let (source, uncertain) = decode_html_image_source(&text_of(&text[value_start..value_end]));
        if uncertain {
            ambiguous = true;
        }
        source_range = Some(DestinationRange {
            start: value_start,
            end: value_end,
            source,
            html_quote: quote,
        });
    }
    (length, None, true)
}

/// `positionInRanges(ranges, position)`
fn position_in_ranges(ranges: &[TextRange], position: usize) -> Option<TextRange> {
    let mut low: i64 = 0;
    let mut high: i64 = ranges.len() as i64 - 1;
    while low <= high {
        let middle = (low + high) / 2;
        let range = ranges[middle as usize];
        if position < range.start {
            high = middle - 1;
        } else if position >= range.end {
            low = middle + 1;
        } else {
            return Some(range);
        }
    }
    None
}

/// `new RegExp('^ {0,3}\\' + marker + '{' + length + ',}[ \\t]*$').test(line)`:
/// up to three spaces, a run of at least `length` markers, then spaces and
/// tabs to the end
fn closes_fence(line: &str, marker: char, length: usize) -> bool {
    let rest = line.trim_start_matches(' ');
    if line.len() - rest.len() > 3 {
        return false;
    }
    let after = rest.trim_start_matches(marker);
    let run = rest.len() - after.len();
    run >= length && after.chars().all(|c| c == ' ' || c == '\t')
}

/// `markdownCodeRanges(markdown)`: fenced, indented and inline code ranges
/// where image-looking text is not rendered content
fn markdown_code_ranges(markdown: &[u16]) -> Vec<TextRange> {
    let mut block_ranges: Vec<TextRange> = Vec::new();
    let mut fence: Option<(char, usize, usize)> = None;
    let mut offset = 0usize;
    let text = text_of(markdown);
    for found in js_regex!(r".*(?:\n|$)").find_iter(&text) {
        let line_with_break = found.as_str();
        if line_with_break.is_empty() {
            continue;
        }
        let line = line_with_break
            .strip_suffix('\n')
            .unwrap_or(line_with_break);
        let line_end = offset + utf16_len(line_with_break);
        if let Some((marker, length, start)) = fence {
            if closes_fence(line, marker, length) {
                block_ranges.push(TextRange {
                    start,
                    end: line_end,
                });
                fence = None;
            }
        } else {
            let open = js_regex!(r"^ {0,3}(`{3,}|~{3,})(.*)$").exec(line);
            let opens = open.as_ref().and_then(|open| {
                let run = open.get(1)?;
                let rest = open.get(2)?;
                let marker = run.chars().next()?;
                (marker == '~' || !rest.contains('`')).then_some((marker, run.len()))
            });
            if let Some((marker, length)) = opens {
                fence = Some((marker, length, offset));
            } else if js_regex!(r"^(?: {4}|\t)").test(line) {
                block_ranges.push(TextRange {
                    start: offset,
                    end: line_end,
                });
            }
        }
        offset = line_end;
    }
    if let Some((_, _, start)) = fence {
        block_ranges.push(TextRange {
            start,
            end: markdown.len(),
        });
    }
    sort_by_number(&mut block_ranges, |left, right| {
        left.start as f64 - right.start as f64
    });

    let mut ranges = block_ranges.clone();
    let mut index = 0usize;
    while index < markdown.len() {
        if let Some(block) = position_in_ranges(&block_ranges, index) {
            index = block.end;
            continue;
        }
        if !is_at(markdown, index, '`') || escaped_at(markdown, index) {
            index += 1;
            continue;
        }
        let mut run_end = index + 1;
        while is_at(markdown, run_end, '`') {
            run_end += 1;
        }
        let run_length = run_end - index;
        let mut search = run_end;
        let mut close_end: Option<usize> = None;
        while search < markdown.len() {
            if let Some(blocked) = position_in_ranges(&block_ranges, search) {
                search = blocked.end;
                continue;
            }
            let Some(next) = index_of_unit(markdown, '`', search) else {
                break;
            };
            let mut next_end = next + 1;
            while is_at(markdown, next_end, '`') {
                next_end += 1;
            }
            if next_end - next == run_length {
                close_end = Some(next_end);
                break;
            }
            search = next_end;
        }
        match close_end {
            Some(end) if end > 0 => {
                ranges.push(TextRange { start: index, end });
                index = end;
            }
            // An unmatched run is literal Markdown, so later HTML may still render.
            _ => index = run_end,
        }
    }
    sort_by_number(&mut ranges, |left, right| {
        left.start as f64 - right.start as f64
    });
    ranges
}

/// `htmlImageSourceRanges(markdown, codeRanges)`
fn html_image_source_ranges(markdown: &[u16], code_ranges: &[TextRange]) -> ImageSourceScan {
    let length = markdown.len();
    let mut ranges: Vec<DestinationRange> = Vec::new();
    let mut ambiguous_html = false;
    let mut index = 0usize;
    while index < length {
        if let Some(code) = position_in_ranges(code_ranges, index) {
            index = code.end;
            continue;
        }
        if !is_at(markdown, index, '<') {
            index += 1;
            continue;
        }
        if starts_with_at(markdown, "<!--", index) {
            match index_of_str(markdown, "-->", index + 4) {
                None => {
                    if js_regex!(r"<img(?:\s|/|>)", "i").test(&text_of(&markdown[index + 4..])) {
                        ambiguous_html = true;
                    }
                    break;
                }
                Some(comment_end) => {
                    index = comment_end + 3;
                    continue;
                }
            }
        }
        let is_img = markdown.get(index + 1..index + 4).is_some_and(|name| {
            name.iter()
                .zip(b"img")
                .all(|(unit, letter)| *unit < 128 && (*unit as u8).to_ascii_lowercase() == *letter)
        });
        if !is_img
            || (index + 4 < length
                && !(is_space_at(markdown, index + 4)
                    || is_at(markdown, index + 4, '/')
                    || is_at(markdown, index + 4, '>')))
        {
            index += 1;
            continue;
        }
        let (next_index, range, ambiguous) = parse_html_image_tag(markdown, index);
        if ambiguous {
            ambiguous_html = true;
        }
        if let Some(range) = range {
            ranges.push(range);
        }
        index = index.max(next_index - 1) + 1;
    }
    ImageSourceScan {
        ranges,
        ambiguous_html,
    }
}

/// `scanImageSources(markdown)`
fn scan_image_sources(markdown: &[u16]) -> Result<ImageSourceScan, RegexLimit> {
    let code_ranges = markdown_code_ranges(markdown);
    let mut html = html_image_source_ranges(markdown, &code_ranges);
    let mut ordered: Vec<DestinationRange> = image_destination_ranges(markdown)?
        .into_iter()
        .filter(|range| position_in_ranges(&code_ranges, range.start).is_none())
        .collect();
    ordered.append(&mut html.ranges);
    sort_by_number(&mut ordered, |left, right| {
        let by_start = left.start as f64 - right.start as f64;
        if by_start != 0.0 {
            by_start
        } else {
            left.end as f64 - right.end as f64
        }
    });
    let mut ranges: Vec<DestinationRange> = Vec::new();
    for range in ordered {
        if let Some(previous) = ranges.last()
            && range.start < previous.end
        {
            html.ambiguous_html = true;
            continue;
        }
        ranges.push(range);
    }
    Ok(ImageSourceScan {
        ranges,
        ambiguous_html: html.ambiguous_html,
    })
}

/// `isInDocDir(target, dir, separator)`: the html-asset:// serve gate. Root
/// directories ("/", "C:\\") already end in a separator, so `dir + sep` would
/// 403 every sibling image of a root document.
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

/// `extractHtmlImageSources(markdown)`
pub fn extract_html_image_sources(markdown: &str) -> Result<Vec<String>, RegexLimit> {
    Ok(scan_image_sources(&units(markdown))?
        .ranges
        .into_iter()
        .map(|range| range.source)
        .collect())
}

/// `extractDocumentImageSources(html)`: the `<img src>` references of an HTML
/// document, read with no Markdown semantics: an indented line is
/// pretty-printed markup, not a code block, and `![alt](src)` is literal text.
pub fn extract_document_image_sources(html: &str) -> Vec<String> {
    html_image_source_ranges(&units(html), &[])
        .ranges
        .into_iter()
        .map(|range| range.source)
        .collect()
}

/// `CssUrlMatch`; offsets are UTF-16 code units
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CssUrlMatch {
    pub start: usize,
    pub end: usize,
    pub source: String,
    /// the delimiter as written, so a rewrite reproduces it (`&quot;` inside a style attribute)
    pub quote: String,
}

/// `scanCssUrls(text)`: every CSS `url(...)` reference: `<style>` rules and
/// inline style attributes alike. A DOM serializer escapes the quotes inside a
/// style attribute, so `url(&quot;...&quot;)` and `url(&#39;...&#39;)` count as
/// quoted too.
pub fn scan_css_urls(text: &str) -> Vec<CssUrlMatch> {
    let pattern = js_regex!(
        r#"url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|(&quot;|&#34;|&#39;|&apos;)([^\n]*?)\3|([^)"'\s]+))\s*\)"#,
        "i"
    );
    let mut out = Vec::new();
    // byte and unit offset of the end of the last match used
    let (mut last_byte, mut last_unit) = (0usize, 0usize);
    for found in pattern.find_iter(text) {
        let source = found
            .get(1)
            .or(found.get(2))
            .or(found.get(4))
            .or(found.get(5))
            .unwrap_or("");
        if source.is_empty() {
            continue;
        }
        let start = last_unit + utf16_len(&text[last_byte..found.start()]);
        let end = start + utf16_len(found.as_str());
        let quote = if found.get(1).is_some() {
            "\""
        } else if found.get(2).is_some() {
            "'"
        } else {
            found.get(3).unwrap_or("")
        };
        out.push(CssUrlMatch {
            start,
            end,
            source: source.to_owned(),
            quote: quote.to_owned(),
        });
        last_byte = found.end();
        last_unit = end;
    }
    out
}

/// `extractHtmlAssetReferences(html)`: every local source a document still
/// points at: `<img src>` plus CSS `url()`. The asset GC decides what to
/// collect from this set, so a reference form missing here is deleted from
/// disk while the saved text still points at it.
pub fn extract_html_asset_references(html: &str) -> Result<Vec<String>, RegexLimit> {
    let mut sources: Vec<String> = Vec::new();
    for source in extract_html_image_sources(html)? {
        if !source.is_empty() && !sources.contains(&source) {
            sources.push(source);
        }
    }
    for found in scan_css_urls(html) {
        if !sources.contains(&found.source) {
            sources.push(found.source);
        }
    }
    Ok(sources)
}

/// `encodeHtmlAttributeReplacement(value, quote)`
fn encode_html_attribute_replacement(value: &str, quote: HtmlQuote) -> String {
    let mut encoded = String::new();
    for character in value.chars() {
        if character == '&' {
            encoded.push_str("&amp;");
        } else if character == '<' {
            encoded.push_str("&lt;");
        } else if quote == HtmlQuote::Double && character == '"' {
            encoded.push_str("&quot;");
        } else if quote == HtmlQuote::Single && character == '\'' {
            encoded.push_str("&#39;");
        } else if quote == HtmlQuote::Unquoted
            && (is_js_space(character) || matches!(character, '"' | '\'' | '`' | '=' | '>'))
        {
            encoded.push_str(&format!("&#{};", character as u32));
        } else {
            encoded.push(character);
        }
    }
    encoded
}

/// `rewriteImageRanges(markdown, ranges, rewrites)`
fn rewrite_image_ranges(
    markdown: &[u16],
    ranges: &[DestinationRange],
    rewrites: &JsMap<String>,
) -> String {
    let mut cursor = 0usize;
    let mut output: Vec<u16> = Vec::new();
    for range in ranges {
        let Some(replacement) = rewrites.get(&range.source) else {
            continue;
        };
        output.extend_from_slice(&markdown[cursor.min(range.start)..range.start]);
        if range.html_quote == HtmlQuote::Markdown {
            output.extend(replacement.encode_utf16());
        } else {
            output.extend(
                encode_html_attribute_replacement(replacement, range.html_quote).encode_utf16(),
            );
        }
        cursor = range.end;
    }
    if cursor == 0 {
        return text_of(markdown);
    }
    output.extend_from_slice(&markdown[cursor..]);
    text_of(&output)
}

/// `rewriteHtmlImageSources(markdown, rewrites)`
pub fn rewrite_html_image_sources(
    markdown: &str,
    rewrites: &JsMap<String>,
) -> Result<String, RegexLimit> {
    if rewrites.is_empty() {
        return Ok(markdown.to_owned());
    }
    let text = units(markdown);
    Ok(rewrite_image_ranges(
        &text,
        &scan_image_sources(&text)?.ranges,
        rewrites,
    ))
}

/// `rewriteDocumentImageSources(html, rewrites)`: `rewriteHtmlImageSources` for
/// an HTML document: see `extractDocumentImageSources`.
pub fn rewrite_document_image_sources(html: &str, rewrites: &JsMap<String>) -> String {
    if rewrites.is_empty() {
        return html.to_owned();
    }
    let text = units(html);
    rewrite_image_ranges(
        &text,
        &html_image_source_ranges(&text, &[]).ranges,
        rewrites,
    )
}

// ---------- the siblings, the list and the files ----------

/// `siblingHtmlReferences(documentPath, ownedNames, includeCurrent)`
fn sibling_html_references(
    document_path: &str,
    owned_names: &HashSet<String>,
    include_current: bool,
) -> HashSet<String> {
    let mut references: HashSet<String> = HashSet::new();
    let document_dir = dirname(&resolve(&[document_path]));
    let current_key = document_key(document_path);
    let entries = match fs::read_dir(namespaced(&document_dir))
        .and_then(|entries| entries.collect::<io::Result<Vec<_>>>())
    {
        Ok(entries) => entries,
        Err(_) => return owned_names.clone(),
    };
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_file = entry.file_type().is_ok_and(|kind| kind.is_file());
        if !is_file
            || (!include_current && name == current_key)
            || !js_regex!(r"\.html?$", "i").test(&name)
        {
            continue;
        }
        let path = join(&[&document_dir, &name]);
        let Ok(info) = stat(&path) else {
            return owned_names.clone();
        };
        // Refuse to load an unexpectedly huge sibling just for GC. Preserving
        // all candidates is the safe fallback when its references are unknown.
        if info.len() > 16 * 1024 * 1024 {
            return owned_names.clone();
        }
        let Ok(bytes) = read_file(&path) else {
            return owned_names.clone();
        };
        let text = String::from_utf8_lossy(&bytes);
        let Ok(scan) = scan_image_sources(&units(&text)) else {
            return owned_names.clone();
        };
        // A browser may still recover an image source from malformed HTML in a
        // way this deliberately small parser cannot prove. Keep every owned
        // candidate rather than collecting a possibly referenced file.
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
        // A sibling may hold an asset open from a CSS url() the <img> scan
        // cannot see; the same reference set drives its survival here.
        for found in scan_css_urls(&text) {
            if let Some(owned) = owned_name_for_source(&found.source)
                && owned_names.contains(&owned)
            {
                references.insert(owned);
            }
        }
    }
    references
}

/// `new Set([...Object.values(documents).flat(), ...Object.values(pending).flat()])`
fn referenced_names(manifest: &OwnedAssetManifest) -> HashSet<String> {
    manifest
        .documents
        .entries()
        .into_iter()
        .chain(manifest.pending.entries())
        .flat_map(|(_, names)| names.iter().cloned())
        .collect()
}

/// drops `names` from every list of `table` and the lists that come out empty
fn prune_references(table: &mut JsObject<Vec<String>>, should_drop: &dyn Fn(&str) -> bool) {
    for key in keys_of(table) {
        let kept: Vec<String> = table
            .get(&key)
            .map(|names| {
                names
                    .iter()
                    .filter(|name| !should_drop(name))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if kept.is_empty() {
            delete(table, &key);
        } else {
            table.set(key, kept);
        }
    }
}

/// `removeCreatedRecords(documentPath, created)`
fn remove_created_records(document_path: &str, created: &[OwnedAssetRecord]) -> Res<()> {
    if created.is_empty() {
        return Ok(());
    }
    with_manifest_lock(document_path, |manifest_path| {
        let mut manifest = read_manifest_unlocked(document_path, manifest_path)?;
        let created_names: HashSet<&str> =
            created.iter().map(|record| record.name.as_str()).collect();
        let key = document_key(document_path);
        let kept: Vec<String> = manifest
            .pending
            .get(&key)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|name| !created_names.contains(name.as_str()))
            .collect();
        if kept.is_empty() {
            // `manifest.pending[key] = []`, then `delete`
            delete(&mut manifest.pending, &key);
        } else {
            manifest.pending.set(key, kept);
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
            let removed = (|| -> Res<bool> {
                let info = lstat(&path)?;
                if !info.is_file()
                    || info.file_type().is_symlink()
                    || sha256_file(&path)? != record.sha256
                {
                    return Ok(false);
                }
                rm(&path)?;
                Ok(true)
            })();
            match removed {
                Ok(true) => {
                    remove_names.insert(record.name.clone());
                }
                Ok(false) => {}
                Err(error) => {
                    if error_code(&error) == "ENOENT" {
                        remove_names.insert(record.name.clone());
                    }
                }
            }
        }
        manifest
            .files
            .retain(|file| !remove_names.contains(&file.name));
        prune_references(&mut manifest.documents, &|name| remove_names.contains(name));
        prune_references(&mut manifest.pending, &|name| remove_names.contains(name));
        write_manifest_unlocked(document_path, &manifest, manifest_path)
    })
}

/// `prepareAssetsForSaveAs(sourceDocumentPath, targetDocumentPath, text, imageSources)`
pub fn prepare_assets_for_save_as(
    source_document_path: &str,
    target_document_path: &str,
    text: &str,
    image_sources: &[String],
) -> Res<PreparedSaveAsAssets> {
    let mut all_image_sources: Vec<String> = image_sources.to_vec();
    let mut known_sources: HashSet<String> = all_image_sources.iter().cloned().collect();
    for source in extract_html_image_sources(text).map_err(limit)? {
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
    let mut rewrites: JsMap<String> = JsMap::new();
    let target_assets_dir = ensure_assets_dir(target_document_path)?;
    let locked = with_manifest_lock(target_document_path, |manifest_path| {
        let mut manifest = read_manifest_unlocked(target_document_path, manifest_path)?;
        let mut reserved_names: HashSet<String> = manifest
            .files
            .iter()
            .map(|file| file.name.clone())
            .collect();
        let mut copied_by_real_path: JsMap<String> = JsMap::new();
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
                rewrites.set(source.clone(), already_copied);
                continue;
            }

            let base = sanitize_asset_name(&basename(&safe_source, None));
            let mut copied: Option<OwnedAssetRecord> = None;
            for suffix in 0..100_000 {
                let name = name_with_suffix(&base, suffix);
                if reserved_names.contains(&name) {
                    continue;
                }
                let target = join(&[&target_assets_dir, &name]);
                let attempt = copy_file_excl(&safe_source, &target).and_then(|()| {
                    Ok(OwnedAssetRecord {
                        name: name.clone(),
                        sha256: sha256_file(&target)?,
                    })
                });
                match attempt {
                    Ok(record) => {
                        copied = Some(record);
                        break;
                    }
                    Err(error) => {
                        if error_code(&error) == "EEXIST" {
                            continue;
                        }
                        return Err(error);
                    }
                }
            }
            let Some(copied) = copied else {
                return Err(plain("html asset name space exhausted"));
            };
            created.push(copied.clone());
            manifest.files.push(copied.clone());
            reserved_names.insert(copied.name.clone());
            let target_key = document_key(target_document_path);
            let current = manifest
                .pending
                .get(&target_key)
                .cloned()
                .unwrap_or_default();
            manifest.pending.set(
                target_key,
                union_sorted(&current, std::slice::from_ref(&copied.name)),
            );
            let authored = format!("assets/{}", copied.name);
            copied_by_real_path.set(safe_source, authored.clone());
            rewrites.set(source.clone(), authored);
        }
        let rewritten_destinations: HashSet<String> = extract_html_image_sources(
            &rewrite_html_image_sources(text, &rewrites).map_err(limit)?,
        )
        .map_err(limit)?
        .into_iter()
        .collect();
        for destination in rewrites.values() {
            if !rewritten_destinations.contains(destination) {
                return Err(plain(
                    "could not safely rewrite a Markdown image during Save As",
                ));
            }
        }
        write_manifest_unlocked(target_document_path, &manifest, manifest_path)
    });
    if let Err(error) = locked {
        for record in &created {
            let _ = rm(&join(&[&target_assets_dir, &record.name]));
        }
        return Err(error);
    }

    let rewrite_list = rewrites
        .iter()
        .map(|(from, to)| AssetRewrite {
            from: from.to_owned(),
            to: to.clone(),
        })
        .collect();
    Ok(PreparedSaveAsAssets {
        target_document_path: target_document_path.to_owned(),
        text: rewrite_html_image_sources(text, &rewrites).map_err(limit)?,
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
pub fn rollback_prepared_save_as_assets(plan: &PreparedSaveAsAssets) -> Res<()> {
    remove_created_records(&plan.target_document_path, &plan.created)
}

/// `pendingOwnedAssetsForDocument(documentPath)`
pub fn pending_owned_assets_for_document(document_path: &str) -> Vec<String> {
    with_manifest_lock(document_path, |manifest_path| {
        let manifest = read_manifest_unlocked(document_path, manifest_path)?;
        Ok(manifest
            .pending
            .get(&document_key(document_path))
            .cloned()
            .unwrap_or_default())
    })
    .unwrap_or_default()
}

/// `resolvePendingOwnedAssets(documentPath, pendingAtOperationStart)`
fn resolve_pending_owned_assets(
    document_path: &str,
    pending_at_operation_start: Option<&[String]>,
) -> ReconcileResult {
    let mut result = ReconcileResult::default();
    let locked = with_manifest_lock(document_path, |manifest_path| {
        let mut manifest = read_manifest_unlocked(document_path, manifest_path)?;
        let key = document_key(document_path);
        let current_pending = manifest.pending.get(&key).cloned().unwrap_or_default();
        let requested: &[String] = pending_at_operation_start.unwrap_or(&current_pending);
        let mut pending_names: Vec<String> = Vec::new();
        for name in &current_pending {
            if requested.contains(name) && !pending_names.contains(name) {
                pending_names.push(name.clone());
            }
        }
        if pending_names.is_empty() {
            return Ok(());
        }
        let kept: Vec<String> = current_pending
            .iter()
            .filter(|name| !pending_names.contains(name))
            .cloned()
            .collect();
        if kept.is_empty() {
            delete(&mut manifest.pending, &key);
        } else {
            manifest.pending.set(key, kept);
        }

        let Some(assets_dir) = existing_assets_dir(document_path)? else {
            return Ok(());
        };
        let owned_names: HashSet<String> = manifest
            .files
            .iter()
            .map(|record| record.name.clone())
            .collect();
        let mut referenced = referenced_names(&manifest);
        referenced.extend(sibling_html_references(document_path, &owned_names, true));

        let mut relinquished: HashSet<String> = HashSet::new();
        for name in &pending_names {
            let Some(record) = manifest.files.iter().find(|record| &record.name == name) else {
                continue;
            };
            let path = join(&[&assets_dir, name]);
            let step = (|| -> Res<()> {
                let info = lstat(&path)?;
                if !info.is_file()
                    || info.file_type().is_symlink()
                    || sha256_file(&path)? != record.sha256
                {
                    relinquished.insert(name.clone());
                    result.preserved.push(name.clone());
                    return Ok(());
                }
                if referenced.contains(name) {
                    result.preserved.push(name.clone());
                    return Ok(());
                }
                rm(&path)?;
                relinquished.insert(name.clone());
                result.deleted.push(name.clone());
                Ok(())
            })();
            if let Err(error) = step {
                if error_code(&error) == "ENOENT" {
                    relinquished.insert(name.clone());
                } else {
                    result.preserved.push(name.clone());
                    result.errors.push(format!("{name}: {}", error.message));
                }
            }
        }

        manifest
            .files
            .retain(|record| !relinquished.contains(&record.name));
        prune_references(&mut manifest.documents, &|name| relinquished.contains(name));
        prune_references(&mut manifest.pending, &|name| relinquished.contains(name));
        write_manifest_unlocked(document_path, &manifest, manifest_path)
    });
    if let Err(error) = locked {
        result.errors.push(error.message);
    }
    result
}

/// `discardPendingOwnedAssets(documentPath)`: the user explicitly discarded
/// unsaved edits. Remove only this document's pending app-owned files;
/// saved/shared references and changed files survive.
pub fn discard_pending_owned_assets(document_path: &str) -> ReconcileResult {
    resolve_pending_owned_assets(document_path, None)
}

/// `resolveSourcePendingAfterSaveAs(sourceDocumentPath, pendingAtSaveStart)`:
/// Save As moved the editing session to a new path. Resolve only pending files
/// that existed when Save As started; later insertions remain undoable.
pub fn resolve_source_pending_after_save_as(
    source_document_path: &str,
    pending_at_save_start: &[String],
) -> ReconcileResult {
    resolve_pending_owned_assets(source_document_path, Some(pending_at_save_start))
}

/// `reconcileOwnedAssets(documentPath, imageSources, options)`
pub fn reconcile_owned_assets(
    document_path: &str,
    image_sources: &[String],
    pending_names: Option<&[String]>,
) -> ReconcileResult {
    let mut result = ReconcileResult::default();
    let locked = with_manifest_lock(document_path, |manifest_path| {
        let mut manifest = read_manifest_unlocked(document_path, manifest_path)?;
        let Some(assets_dir) = existing_assets_dir(document_path)? else {
            return Ok(());
        };

        let mut valid_records: Vec<OwnedAssetRecord> = Vec::new();
        let mut relinquished: HashSet<String> = HashSet::new();
        for record in &manifest.files {
            let path = join(&[&assets_dir, &record.name]);
            let checked = (|| -> Res<bool> {
                let info = lstat(&path)?;
                Ok(info.is_file()
                    && !info.file_type().is_symlink()
                    && sha256_file(&path)? == record.sha256)
            })();
            match checked {
                Ok(true) => valid_records.push(record.clone()),
                Ok(false) => {
                    relinquished.insert(record.name.clone());
                    result.preserved.push(record.name.clone());
                }
                Err(error) => {
                    if error_code(&error) != "ENOENT" {
                        relinquished.insert(record.name.clone());
                        result.preserved.push(record.name.clone());
                        result
                            .errors
                            .push(format!("{}: {}", record.name, error.message));
                    }
                }
            }
        }
        manifest.files = valid_records.clone();

        let owned_names: HashSet<String> = valid_records
            .iter()
            .map(|record| record.name.clone())
            .collect();
        let keep = |name: &str| owned_names.contains(name) && !relinquished.contains(name);
        prune_references(&mut manifest.documents, &|name| !keep(name));
        prune_references(&mut manifest.pending, &|name| !keep(name));

        let mut current_references: Vec<String> = Vec::new();
        for source in image_sources {
            if let Some(name) = owned_name_for_source(source)
                && owned_names.contains(&name)
                && !current_references.contains(&name)
            {
                current_references.push(name);
            }
        }
        let key = document_key(document_path);
        if !current_references.is_empty() {
            sort_names(&mut current_references);
            manifest.documents.set(key.clone(), current_references);
        } else {
            delete(&mut manifest.documents, &key);
        }
        let pending_to_resolve: Vec<String> = match pending_names {
            Some(names) => names.to_vec(),
            None => manifest.pending.get(&key).cloned().unwrap_or_default(),
        };
        let kept: Vec<String> = manifest
            .pending
            .get(&key)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|name| !pending_to_resolve.contains(name))
            .collect();
        if kept.is_empty() {
            delete(&mut manifest.pending, &key);
        } else {
            manifest.pending.set(key, kept);
        }

        let mut referenced = referenced_names(&manifest);
        referenced.extend(sibling_html_references(document_path, &owned_names, false));
        let mut deleted: HashSet<String> = HashSet::new();
        for record in &valid_records {
            if referenced.contains(&record.name) {
                continue;
            }
            let path = join(&[&assets_dir, &record.name]);
            let step = (|| -> Res<bool> {
                let info = lstat(&path)?;
                if !info.is_file()
                    || info.file_type().is_symlink()
                    || sha256_file(&path)? != record.sha256
                {
                    return Ok(false);
                }
                rm(&path)?;
                Ok(true)
            })();
            match step {
                Ok(true) => {
                    deleted.insert(record.name.clone());
                    result.deleted.push(record.name.clone());
                }
                Ok(false) => result.preserved.push(record.name.clone()),
                Err(error) => {
                    if error_code(&error) == "ENOENT" {
                        deleted.insert(record.name.clone());
                    } else {
                        result
                            .errors
                            .push(format!("{}: {}", record.name, error.message));
                    }
                }
            }
        }
        manifest
            .files
            .retain(|record| !deleted.contains(&record.name));
        prune_references(&mut manifest.documents, &|name| deleted.contains(name));
        prune_references(&mut manifest.pending, &|name| deleted.contains(name));
        if let Err(error) = write_manifest_unlocked(document_path, &manifest, manifest_path) {
            result.errors.push(error.message);
        }
        Ok(())
    });
    if let Err(error) = locked {
        result.errors.push(error.message);
    }
    result
}

/// `renameOwnedAssetDocument(oldDocumentPath, newDocumentPath)`
pub fn rename_owned_asset_document(old_document_path: &str, new_document_path: &str) -> Res<()> {
    if resolve(&[&dirname(old_document_path)]) != resolve(&[&dirname(new_document_path)]) {
        return Ok(());
    }
    with_manifest_lock(new_document_path, |manifest_path| {
        let mut manifest = read_manifest_unlocked(new_document_path, manifest_path)?;
        let old_key = document_key(old_document_path);
        let new_key = document_key(new_document_path);
        let old_references = manifest.documents.get(&old_key).cloned();
        let old_pending = manifest.pending.get(&old_key).cloned();
        if (old_references.is_none() && old_pending.is_none()) || old_key == new_key {
            return Ok(());
        }
        if let Some(old_references) = old_references {
            let current = manifest
                .documents
                .get(&new_key)
                .cloned()
                .unwrap_or_default();
            manifest
                .documents
                .set(new_key.clone(), union_sorted(&current, &old_references));
            delete(&mut manifest.documents, &old_key);
        }
        if let Some(old_pending) = old_pending {
            let current = manifest.pending.get(&new_key).cloned().unwrap_or_default();
            manifest
                .pending
                .set(new_key.clone(), union_sorted(&current, &old_pending));
            delete(&mut manifest.pending, &old_key);
        }
        write_manifest_unlocked(new_document_path, &manifest, manifest_path)
    })
}

/// `readOwnedAssetManifest(documentPath)`
pub fn read_owned_asset_manifest(document_path: &str) -> Option<OwnedAssetManifest> {
    let assets_dir = existing_assets_dir(document_path).ok()??;
    read_manifest_unlocked(document_path, &manifest_path_in(&assets_dir)).ok()
}
