//! `apps/epub/src/main/reading-state.ts`.
//!
//! Where each book was left and the view settings (spec 4), in one small JSON
//! file in the app data folder (`epub-reading.json`). The TypeScript queues
//! its changes on a promise chain and reads the file once; here every call
//! runs to its end before the next, which is the same order. The file is read
//! on the first call and kept; a change mutates that copy first and writes
//! the whole file after, so a refused write leaves the change in the copy, as
//! in the TypeScript.

use std::fs;
use std::io::Read;

use jscompat::node_path::host::join;
use jscompat::{JsObject, JsonValue, json_parse, json_stringify_pretty, sort_by_number};
use serde_json::{Map, Number, Value};

use crate::epub::result_paths::path_key;
use crate::node_fs::{NodeError, namespaced, node_error};

pub const READING_STATE_FILE: &str = "epub-reading.json";
/// remembered books; the least recently read are forgotten first
pub const MAX_POSITIONS: usize = 1000;

/// `EpubViewPrefs`: screen-only settings, shared by every book.
#[derive(Debug, Clone, PartialEq)]
pub struct ViewPrefs {
    /// text size factor, 0.5-3
    pub font_scale: f64,
    /// line height, 1-3; `None` (null) keeps the book's own
    pub line_height: Option<f64>,
    /// the dark view
    pub dark: bool,
}

/// `EPUB_VIEW_PREFS_DEFAULT`
pub const EPUB_VIEW_PREFS_DEFAULT: ViewPrefs = ViewPrefs {
    font_scale: 1.0,
    line_height: None,
    dark: false,
};

/// `EpubReadPosition`
#[derive(Debug, Clone, PartialEq)]
pub struct ReadPosition {
    pub spine_index: f64,
    pub block_id: Option<String>,
}

/// `StoredPosition`: a position and when it was written.
#[derive(Debug, Clone, PartialEq)]
struct StoredPosition {
    spine_index: f64,
    block_id: Option<String>,
    updated_at: f64,
}

#[derive(Debug, Clone)]
struct ReadingFile {
    view_prefs: ViewPrefs,
    positions: JsObject<StoredPosition>,
}

/// `ReadingStateDeps`
pub trait ReadingStateDeps {
    /// the app data folder
    fn dir(&mut self) -> String;
    /// writes the whole file atomically
    fn write(&mut self, path: &str, text: &str) -> Result<(), NodeError>;
    /// `deps.now ?? Date.now`
    fn now(&mut self) -> f64;
}

/// `EpubReadingState`: `{ position, viewPrefs }`.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadingStateAnswer {
    pub position: Option<ReadPosition>,
    pub view_prefs: ViewPrefs,
}

fn number(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

impl ViewPrefs {
    /// `{ fontScale, lineHeight, dark }`
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("fontScale".into(), number(self.font_scale));
        out.insert(
            "lineHeight".into(),
            self.line_height.map_or(Value::Null, number),
        );
        out.insert("dark".into(), Value::Bool(self.dark));
        Value::Object(out)
    }

    fn to_js(&self) -> JsonValue {
        object([
            ("fontScale", JsonValue::Number(self.font_scale)),
            (
                "lineHeight",
                self.line_height.map_or(JsonValue::Null, JsonValue::Number),
            ),
            ("dark", JsonValue::Bool(self.dark)),
        ])
    }
}

impl ReadPosition {
    /// `{ spineIndex, blockId }`
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("spineIndex".into(), number(self.spine_index));
        out.insert(
            "blockId".into(),
            self.block_id.clone().map_or(Value::Null, Value::String),
        );
        Value::Object(out)
    }
}

impl ReadingStateAnswer {
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert(
            "position".into(),
            self.position
                .as_ref()
                .map_or(Value::Null, ReadPosition::to_json),
        );
        out.insert("viewPrefs".into(), self.view_prefs.to_json());
        Value::Object(out)
    }
}

/// an object literal whose keys come in this order and are no array indices
fn object<const N: usize>(entries: [(&str, JsonValue); N]) -> JsonValue {
    JsonValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

/// `delete record[key]`
fn delete<V: Clone>(record: &mut JsObject<V>, key: &str) {
    if record.get(key).is_none() {
        return;
    }
    // the order Object.keys gives is kept: array indices first, the rest as set
    *record = record
        .entries()
        .into_iter()
        .filter(|(name, _)| *name != key)
        .map(|(name, value)| (name.to_owned(), value.clone()))
        .collect();
}

/// `isRecord(v)`
fn is_record(v: Option<&JsonValue>) -> bool {
    matches!(v, Some(JsonValue::Object(_)))
}

/// `Number.isFinite(v)` of an unknown value
fn finite_number(v: Option<&JsonValue>) -> Option<f64> {
    match v {
        Some(JsonValue::Number(x)) if x.is_finite() => Some(*x),
        _ => None,
    }
}

/// `clamp`: `Math.min(max, Math.max(min, v))`
fn clamp(v: f64, min: f64, max: f64) -> f64 {
    jscompat::math_min(max, jscompat::math_max(min, v))
}

/// `viewPrefsOf(v, base)`: view settings from untrusted input, over `base`;
/// unknown or bad fields keep `base`'s.
pub fn view_prefs_of(v: Option<&JsonValue>, base: &ViewPrefs) -> ViewPrefs {
    let mut out = base.clone();
    let Some(record @ JsonValue::Object(_)) = v else {
        return out;
    };
    if let Some(x) = finite_number(record.get("fontScale").as_deref()) {
        out.font_scale = clamp(x, 0.5, 3.0);
    }
    match record.get("lineHeight").as_deref() {
        Some(JsonValue::Null) => out.line_height = None,
        other => {
            if let Some(x) = finite_number(other) {
                out.line_height = Some(clamp(x, 1.0, 3.0));
            }
        }
    }
    if let Some(JsonValue::Bool(dark)) = record.get("dark").as_deref() {
        out.dark = *dark;
    }
    out
}

/// `Number.isSafeInteger(v)` of a number
fn is_safe_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x && x.abs() <= 9_007_199_254_740_991.0
}

/// `readPositionOf(v)`: a reading position from untrusted input; `None` when
/// it is not one.
pub fn read_position_of(v: Option<&JsonValue>) -> Option<ReadPosition> {
    let record = match v {
        Some(record @ JsonValue::Object(_)) => record,
        _ => return None,
    };
    let spine_index = match record.get("spineIndex").as_deref() {
        Some(JsonValue::Number(x)) if is_safe_integer(*x) && *x >= 0.0 => *x,
        _ => return None,
    };
    // `blockId !== null && (typeof blockId !== 'string' || blockId.length > 64)`
    let block_id = match record.get("blockId").as_deref() {
        Some(JsonValue::Null) => None,
        Some(JsonValue::String(text)) if text.encode_utf16().count() <= 64 => Some(text.clone()),
        _ => return None,
    };
    Some(ReadPosition {
        spine_index,
        block_id,
    })
}

fn empty_file() -> ReadingFile {
    ReadingFile {
        view_prefs: EPUB_VIEW_PREFS_DEFAULT.clone(),
        positions: JsObject::new(),
    }
}

fn file_of(v: &JsonValue) -> ReadingFile {
    let mut file = empty_file();
    if !is_record(Some(v)) {
        return file;
    }
    file.view_prefs = view_prefs_of(v.get("viewPrefs").as_deref(), &EPUB_VIEW_PREFS_DEFAULT);
    if let Some(JsonValue::Object(positions)) = v.get("positions").as_deref() {
        for (key, value) in positions.entries() {
            let Some(position) = read_position_of(Some(value)) else {
                continue;
            };
            if !is_record(Some(value)) {
                continue;
            }
            let updated_at = finite_number(value.get("updatedAt").as_deref()).unwrap_or(0.0);
            // `positions["__proto__"] = ...` sets the prototype of a plain object
            // and keeps no own key
            if key == "__proto__" {
                continue;
            }
            file.positions.set(
                key,
                StoredPosition {
                    spine_index: position.spine_index,
                    block_id: position.block_id,
                    updated_at,
                },
            );
        }
    }
    file
}

impl ReadingFile {
    /// `JSON.stringify(file, null, 2)`
    fn to_text(&self) -> String {
        let positions: JsObject<JsonValue> = self
            .positions
            .entries()
            .into_iter()
            .map(|(key, stored)| {
                (
                    key.to_owned(),
                    object([
                        ("spineIndex", JsonValue::Number(stored.spine_index)),
                        (
                            "blockId",
                            stored
                                .block_id
                                .clone()
                                .map_or(JsonValue::Null, JsonValue::String),
                        ),
                        ("updatedAt", JsonValue::Number(stored.updated_at)),
                    ]),
                )
            })
            .collect();
        let file = object([
            ("version", JsonValue::Number(1.0)),
            ("viewPrefs", self.view_prefs.to_js()),
            ("positions", JsonValue::Object(positions)),
        ]);
        format!("{}\n", json_stringify_pretty(&file, 2))
    }
}

/// `createReadingState(deps)`
pub struct ReadingState<D: ReadingStateDeps> {
    deps: D,
    /// the file, read once
    loaded: Option<ReadingFile>,
}

/// `readFile(path, 'utf8')` of a file that may be missing, then
/// `fileOf(JSON.parse(text))`; a file that cannot be read or does not parse
/// counts as empty.
fn read_file_of(path: &str) -> ReadingFile {
    let mut text = Vec::new();
    let read = fs::File::open(namespaced(path)).and_then(|mut file| file.read_to_end(&mut text));
    if read.is_err() {
        return empty_file();
    }
    match json_parse(&String::from_utf8_lossy(&text)) {
        Ok(value) => file_of(&value),
        Err(_) => empty_file(),
    }
}

impl<D: ReadingStateDeps> ReadingState<D> {
    pub fn new(deps: D) -> Self {
        ReadingState { deps, loaded: None }
    }

    /// the deps, for the owner that built them
    pub fn deps(&mut self) -> &mut D {
        &mut self.deps
    }

    fn file_path(deps: &mut D) -> String {
        join(&[&deps.dir(), READING_STATE_FILE])
    }

    /// the file, read once
    fn load<'a>(deps: &mut D, loaded: &'a mut Option<ReadingFile>) -> &'a mut ReadingFile {
        loaded.get_or_insert_with(|| read_file_of(&Self::file_path(deps)))
    }

    /// runs `change` on the file, then writes it
    fn update<T>(
        &mut self,
        change: impl FnOnce(&mut ReadingFile, &mut D) -> T,
    ) -> Result<T, NodeError> {
        let Self { deps, loaded } = self;
        let file = Self::load(deps, loaded);
        let result = change(&mut *file, &mut *deps);
        let dir = deps.dir();
        fs::create_dir_all(namespaced(&dir)).map_err(|e| node_error(&e, "mkdir", &dir))?;
        let path = Self::file_path(deps);
        deps.write(&path, &file.to_text())?;
        Ok(result)
    }

    /// `get(bookPath)`: where this file was left, and the view settings
    pub fn get(&mut self, book_path: Option<&str>) -> ReadingStateAnswer {
        let Self { deps, loaded } = self;
        let file = Self::load(deps, loaded);
        let stored = book_path
            .filter(|path| !path.is_empty())
            .and_then(|path| file.positions.get(&path_key(path, None)));
        ReadingStateAnswer {
            position: stored.map(|stored| ReadPosition {
                spine_index: stored.spine_index,
                block_id: stored.block_id.clone(),
            }),
            view_prefs: file.view_prefs.clone(),
        }
    }

    /// `setPosition(bookPath, position)`
    pub fn set_position(
        &mut self,
        book_path: &str,
        position: &ReadPosition,
    ) -> Result<(), NodeError> {
        self.update(|file, deps| {
            file.positions.set(
                path_key(book_path, None),
                StoredPosition {
                    spine_index: position.spine_index,
                    block_id: position.block_id.clone(),
                    updated_at: deps.now(),
                },
            );
            if file.positions.len() > MAX_POSITIONS {
                let mut keys: Vec<String> = file
                    .positions
                    .entries()
                    .into_iter()
                    .map(|(key, _)| key.to_owned())
                    .collect();
                let updated_at = |key: &String| {
                    file.positions
                        .get(key)
                        .map_or(f64::NAN, |stored| stored.updated_at)
                };
                sort_by_number(&mut keys, |a, b| updated_at(b) - updated_at(a));
                for key in keys.split_off(MAX_POSITIONS) {
                    delete(&mut file.positions, &key);
                }
            }
        })
    }

    /// `setViewPrefs(patch)`
    pub fn set_view_prefs(&mut self, patch: Option<&JsonValue>) -> Result<ViewPrefs, NodeError> {
        self.update(|file, _| {
            file.view_prefs = view_prefs_of(patch, &file.view_prefs);
            file.view_prefs.clone()
        })
    }

    /// `movePosition(fromPath, toPath)`: the file was renamed or saved
    /// elsewhere, so its position follows
    pub fn move_position(&mut self, from_path: &str, to_path: &str) -> Result<(), NodeError> {
        self.update(|file, _| {
            let from = path_key(from_path, None);
            let Some(stored) = file.positions.get(&from).cloned() else {
                return;
            };
            delete(&mut file.positions, &from);
            file.positions.set(path_key(to_path, None), stored);
        })
    }
}
