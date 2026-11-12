//! `apps/slides/src/main/template-selection-store.ts`.
//!
//! `Date.now()` is the `now` of the options, and a document held in a
//! `WeakMap` is a [`TemplateSelectionDocument`] with an `id` for its identity.
//! `console.warn` of the memory has no counterpart: it is not an answer.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;

use jscompat::node_path::host::join;
use jscompat::{JsObject, JsonValue};

use super::template_selection::{TemplateSelection, normalize_template_selection};
use crate::node_fs::{NodeError, node_error, node_error_fd};
use crate::packages::electron_utils::atomic_write::write_json_atomic;
use crate::packages::project_store::canonical_path_key;

/// The record file, directly in the user-data folder
pub const TEMPLATE_SELECTION_FILE: &str = "slides-template-selections.json";
/// Documents remembered at most; beyond it the least recently used are dropped (tunable default)
pub const TEMPLATE_SELECTION_MAX_DOCUMENTS: f64 = 2000.0;
/// A read counts as a use, but rewrites the file at most this often per document
pub const TEMPLATE_SELECTION_TOUCH_INTERVAL_MS: f64 = 60_000.0;

/// `TemplateSelectionStoreOptions`
#[derive(Default)]
pub struct TemplateSelectionStoreOptions {
    pub max_documents: Option<f64>,
    /// The clock, for tests; `Date.now()` when left out
    pub now: Option<Box<dyn Fn() -> f64>>,
}

/// A stored record: the selection plus when it was last read or written (what the cap goes by)
#[derive(Debug, Clone, PartialEq)]
struct StoredSelection {
    selection: TemplateSelection,
    used_at: f64,
}

/// `Map<string, StoredSelection>`: insertion order, a key set again keeps its place
#[derive(Default)]
struct Documents(Vec<(String, StoredSelection)>);

impl Documents {
    fn position(&self, key: &str) -> Option<usize> {
        self.0.iter().position(|(k, _)| k == key)
    }
    fn has(&self, key: &str) -> bool {
        self.position(key).is_some()
    }
    fn get(&self, key: &str) -> Option<&StoredSelection> {
        self.position(key).map(|at| &self.0[at].1)
    }
    fn delete(&mut self, key: &str) {
        if let Some(at) = self.position(key) {
            self.0.remove(at);
        }
    }
    fn set(&mut self, key: &str, entry: StoredSelection) {
        match self.position(key) {
            Some(at) => self.0[at].1 = entry,
            None => self.0.push((key.to_owned(), entry)),
        }
    }
}

fn selection_of(entry: &StoredSelection) -> TemplateSelection {
    entry.selection.clone()
}

/// `finiteOr(value, fallback)`
fn finite_or(value: Option<&JsonValue>, fallback: f64) -> f64 {
    match value {
        Some(JsonValue::Number(x)) if x.is_finite() => *x,
        _ => fallback,
    }
}

/// One entry of the file, or `None` when it is not a record this version can read
fn stored_selection_of(value: &JsonValue) -> Option<StoredSelection> {
    let mut selection = normalize_template_selection(Some(value), 0.0)?;
    let updated_at = finite_or(value.get("updatedAt").as_deref(), 0.0);
    let used_at = finite_or(value.get("usedAt").as_deref(), updated_at);
    selection.updated_at = updated_at;
    Some(StoredSelection { selection, used_at })
}

/// The key a document's record is under, also when it was written under the
/// path as given (a path that did not resolve at the time).
fn find_key(documents: &Documents, file_path: &str) -> Option<String> {
    let key = canonical_path_key(file_path);
    if documents.has(&key) {
        return Some(key);
    }
    let nfc = nfc_of(file_path);
    for alt in [file_path, nfc.as_str()] {
        if alt != key && documents.has(alt) {
            return Some(alt.to_owned());
        }
    }
    None
}

fn nfc_of(text: &str) -> String {
    icu_normalizer::ComposingNormalizerBorrowed::new_nfc()
        .normalize(text)
        .into_owned()
}

fn system_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

pub struct TemplateSelectionStore {
    file_path: String,
    max_documents: f64,
    now: Box<dyn Fn() -> f64>,
}

impl TemplateSelectionStore {
    /// `new TemplateSelectionStore(userDataDir, options)`
    pub fn new(user_data_dir: &str, options: TemplateSelectionStoreOptions) -> Self {
        TemplateSelectionStore {
            file_path: join(&[user_data_dir, TEMPLATE_SELECTION_FILE]),
            max_documents: options
                .max_documents
                .unwrap_or(TEMPLATE_SELECTION_MAX_DOCUMENTS),
            now: options.now.unwrap_or_else(|| Box::new(system_now)),
        }
    }

    /// `store.now()`
    pub fn now(&self) -> f64 {
        (self.now)()
    }

    /// What is stored for the document, exactly as stored; `None` when nothing is. Counts as a use.
    pub fn get(&self, file_path: &str) -> Result<Option<TemplateSelection>, NodeError> {
        let mut documents = self.read()?;
        let Some(found) = find_key(&documents, file_path) else {
            return Ok(None);
        };
        let entry = documents
            .get(&found)
            .cloned()
            .expect("a key that was found");
        let key = canonical_path_key(file_path);
        let now = self.now();
        // also rewritten when the record is still under an earlier spelling of the path
        if found != key || now - entry.used_at >= TEMPLATE_SELECTION_TOUCH_INTERVAL_MS {
            documents.delete(&found);
            documents.set(
                &key,
                StoredSelection {
                    used_at: now,
                    ..entry.clone()
                },
            );
            // reading still works when the folder cannot be written
            let _ = self.write(&mut documents, &key);
        }
        Ok(Some(selection_of(&entry)))
    }

    /// Remember `input` for the document, or forget the document on `null`. Input
    /// that is not a selection is ignored. Returns what is stored afterwards.
    /// `input` `None` is `undefined`.
    pub fn set(
        &self,
        file_path: &str,
        input: Option<&JsonValue>,
    ) -> Result<Option<TemplateSelection>, NodeError> {
        if matches!(input, Some(JsonValue::Null)) {
            self.put(file_path, None)?;
            return Ok(None);
        }
        let Some(selection) = normalize_template_selection(input, self.now()) else {
            let documents = self.read()?;
            return Ok(find_key(&documents, file_path)
                .and_then(|found| documents.get(&found).map(selection_of)));
        };
        self.put(file_path, Some(selection.clone()))?;
        Ok(Some(selection))
    }

    /// Write an already normalized record as it is (its `updatedAt` included), or remove the document's on `None`.
    pub fn put(
        &self,
        file_path: &str,
        selection: Option<TemplateSelection>,
    ) -> Result<(), NodeError> {
        let mut documents = self.read()?;
        let found = find_key(&documents, file_path);
        // forgetting a document that has no record must not create or rewrite the file
        if selection.is_none() && found.is_none() {
            return Ok(());
        }
        if let Some(found) = &found {
            documents.delete(found);
        }
        let key = canonical_path_key(file_path);
        if let Some(selection) = selection {
            let used_at = self.now();
            documents.set(&key, StoredSelection { selection, used_at });
        }
        self.write(&mut documents, &key)
    }

    /// The document is also at `to_path` now (Save As, a draft copy): the same
    /// record is written there and the one under `from_path` stays.
    pub fn copy(&self, from_path: &str, to_path: &str) -> Result<(), NodeError> {
        self.transfer(from_path, to_path, false)
    }

    /// The file went from `from_path` to `to_path` (rename, move): nothing stays under the old path.
    pub fn move_record(&self, from_path: &str, to_path: &str) -> Result<(), NodeError> {
        self.transfer(from_path, to_path, true)
    }

    fn transfer(
        &self,
        from_path: &str,
        to_path: &str,
        remove_source: bool,
    ) -> Result<(), NodeError> {
        let mut documents = self.read()?;
        let to_key = canonical_path_key(to_path);
        let from_key = find_key(&documents, from_path);
        if from_key.as_deref() == Some(to_key.as_str()) {
            return Ok(());
        }
        if canonical_path_key(from_path) == to_key {
            // Both paths are one file (a rename that only changes case, a save onto
            // itself): the record may still be under the earlier spelling.
            let folded = to_key.to_lowercase();
            let earlier = from_key
                .or_else(|| find_key(&documents, to_path))
                .or_else(|| {
                    documents
                        .0
                        .iter()
                        .map(|(key, _)| key)
                        .find(|key| {
                            key.to_lowercase() == folded && canonical_path_key(key) == to_key
                        })
                        .cloned()
                });
            let Some(earlier) = earlier else {
                return Ok(());
            };
            if earlier == to_key {
                return Ok(());
            }
            let entry = documents
                .get(&earlier)
                .cloned()
                .expect("a key that was found");
            documents.delete(&earlier);
            documents.set(&to_key, entry);
            return self.write(&mut documents, &to_key);
        }
        let entry = from_key
            .as_ref()
            .and_then(|key| documents.get(key).cloned());
        let displaced = find_key(&documents, to_path);
        if entry.is_none() && displaced.is_none() {
            return Ok(());
        }
        if let Some(displaced) = &displaced {
            documents.delete(displaced);
        }
        if remove_source && let Some(from_key) = &from_key {
            documents.delete(from_key);
        }
        if let Some(entry) = entry {
            let used_at = self.now();
            documents.set(&to_key, StoredSelection { used_at, ..entry });
        }
        self.write(&mut documents, &to_key)
    }

    /// A missing or corrupt file reads as no records; an entry that does not
    /// validate is skipped. A file that is there but cannot be read right now (a
    /// lock, a permission) is an error instead.
    fn read(&self) -> Result<Documents, NodeError> {
        let mut documents = Documents::default();
        let mut bytes = Vec::new();
        let opened =
            File::open(&self.file_path).map_err(|e| node_error(&e, "open", &self.file_path));
        let read = match opened {
            Ok(mut file) => file
                .read_to_end(&mut bytes)
                .map_err(|e| node_error_fd(&e, "read")),
            Err(e) => Err(e),
        };
        if let Err(error) = read {
            if matches!(error.code, Some("ENOENT") | Some("ENOTDIR")) {
                return Ok(documents);
            }
            return Err(error);
        }
        let text = String::from_utf8_lossy(&bytes);
        let Ok(raw) = jscompat::json_parse(&text) else {
            return Ok(documents);
        };
        let JsonValue::Object(raw) = &raw else {
            return Ok(documents);
        };
        let Some(JsonValue::Object(stored)) = raw.get("documents") else {
            return Ok(documents);
        };
        for (key, value) in stored.entries() {
            if let Some(entry) = stored_selection_of(value) {
                documents.set(key, entry);
            }
        }
        Ok(documents)
    }

    /// Atomic (temp file, then rename). Over the cap, the least recently used go, never `keep`.
    fn write(&self, documents: &mut Documents, keep: &str) -> Result<(), NodeError> {
        let excess = documents.0.len() as f64 - self.max_documents;
        if excess > 0.0 {
            let mut oldest_first: Vec<(String, f64)> = documents
                .0
                .iter()
                .filter(|(key, _)| key != keep)
                .map(|(key, entry)| (key.clone(), entry.used_at))
                .collect();
            // stable, as Array.prototype.sort is
            oldest_first.sort_by(|a, b| a.1.total_cmp(&b.1));
            for (key, _) in oldest_first.into_iter().take(excess.trunc() as usize) {
                documents.delete(&key);
            }
        }
        let mut object: JsObject<JsonValue> = JsObject::new();
        for (key, entry) in &documents.0 {
            object.set(key.clone(), stored_json(entry));
        }
        let mut file = JsObject::new();
        file.set("version", JsonValue::Number(1.0));
        file.set("documents", JsonValue::Object(object));
        write_json_atomic(&self.file_path, &JsonValue::Object(file))
    }
}

/// `{ kind, key, adjustments, updatedAt, usedAt }`
fn stored_json(entry: &StoredSelection) -> JsonValue {
    let mut object = JsObject::new();
    object.set(
        "kind",
        JsonValue::String(entry.selection.kind.as_str().to_owned()),
    );
    object.set("key", JsonValue::String(entry.selection.key.clone()));
    object.set(
        "adjustments",
        JsonValue::Array(
            entry
                .selection
                .adjustments
                .iter()
                .cloned()
                .map(JsonValue::String)
                .collect(),
        ),
    );
    object.set("updatedAt", JsonValue::Number(entry.selection.updated_at));
    object.set("usedAt", JsonValue::Number(entry.used_at));
    JsonValue::Object(object)
}

/// A document as its window holds it: `path` is '' until it has been saved.
/// `id` is its identity, what the `WeakMap` keys by.
#[derive(Debug, Clone, PartialEq)]
pub struct TemplateSelectionDocument {
    pub id: u64,
    pub path: String,
}

/// The store as the editor uses it: a saved document is remembered on disk
/// under its path, one that has no path yet only in memory. Nothing here
/// fails: a failed write costs the memory of one document.
pub struct TemplateSelectionMemory {
    pub store: TemplateSelectionStore,
    unsaved: HashMap<u64, TemplateSelection>,
}

impl TemplateSelectionMemory {
    pub fn new(user_data_dir: &str, options: TemplateSelectionStoreOptions) -> Self {
        TemplateSelectionMemory {
            store: TemplateSelectionStore::new(user_data_dir, options),
            unsaved: HashMap::new(),
        }
    }

    pub fn get(&self, doc: &TemplateSelectionDocument) -> Option<TemplateSelection> {
        if doc.path.is_empty() {
            return self.unsaved.get(&doc.id).cloned();
        }
        // console.warn('[slides] template selection not read:', err)
        self.store.get(&doc.path).unwrap_or_default()
    }

    /// Remember `input` (`null` forgets; anything that is not a selection is ignored). Returns what is remembered afterwards.
    pub fn set(
        &mut self,
        doc: &TemplateSelectionDocument,
        input: Option<&JsonValue>,
    ) -> Option<TemplateSelection> {
        if !doc.path.is_empty() {
            return match self.store.set(&doc.path, input) {
                Ok(selection) => selection,
                // console.warn('[slides] template selection not written:', err)
                Err(_) => self.get(doc),
            };
        }
        if matches!(input, Some(JsonValue::Null)) {
            self.unsaved.remove(&doc.id);
        } else if let Some(selection) = normalize_template_selection(input, self.store.now()) {
            self.unsaved.insert(doc.id, selection);
        }
        self.unsaved.get(&doc.id).cloned()
    }

    /// The document is re-pointed from `from_path` to `to_path` (first save, Save
    /// As, ...): what it has is written under `to_path`, and a record under
    /// `from_path` stays. `from_path` is '' for a document that was never saved.
    pub fn follow(&mut self, doc: &TemplateSelectionDocument, from_path: &str, to_path: &str) {
        if to_path.is_empty() || from_path == to_path {
            return;
        }
        if !from_path.is_empty() {
            // console.warn('[slides] template selection did not follow the document:', err)
            let _ = self.store.copy(from_path, to_path);
            return;
        }
        let remembered = self.unsaved.remove(&doc.id);
        let _ = self.store.put(to_path, remembered);
    }

    /// A new document object takes the place of `previous` in its window: it
    /// starts with what the old one had.
    pub fn inherit(
        &mut self,
        previous: Option<&TemplateSelectionDocument>,
        replacement: &TemplateSelectionDocument,
    ) {
        let Some(previous) = previous else {
            return;
        };
        if !replacement.path.is_empty() {
            return;
        }
        if let Some(selection) = self.get(previous) {
            self.unsaved.insert(replacement.id, selection);
        }
    }

    /// The file was renamed or moved inside the app: the record moves, nothing stays under the old path.
    pub fn moved(&mut self, old_path: &str, new_path: &str) {
        let _ = self.store.move_record(old_path, new_path);
    }
}
