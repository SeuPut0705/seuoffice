//! `apps/shell/src/main/session-record.ts`.
//!
//! The session record (crash recovery spec 4, 5.2, 11): which document tabs
//! are open, in what order, which one is in front, the split, and whether the
//! run ended through the full quit path.
//!
//! Values that cross the boundary as JavaScript values (what a file or a
//! caller hands over, where the TypeScript checks types at run time) are
//! [`JsonValue`]s; what the module builds is typed and written as
//! `JSON.stringify` writes it ([`record_to_value`] and its kin).
//!
//! The recorder's two timers are explicit: [`SessionRecorder::write_timer`]
//! and [`SessionRecorder::startup_timer`] say whether each is pending, and
//! the caller fires one with [`SessionRecorder::fire_write_timer`] or
//! [`SessionRecorder::fire_startup_timer`] when its delay
//! ([`SessionRecorder::write_delay_ms`], [`SessionRecorder::crash_loop_window_ms`])
//! has passed. `console.warn` and `Date.now` come through
//! [`SessionRecorderEnv`]; the process-wide recorder is
//! [`SessionRecordProcess`].

use std::collections::HashMap;
use std::fs;

use jscompat::node_path::host::join;
use jscompat::{
    JsObject, JsRegex, JsonValue, js_regex, json_parse, json_to_string, json_value_from_serde,
    math_max, math_min,
};
use serde_json::{Map, Number, Value};

use crate::node_fs::{NodeError, code_of};
use crate::packages::electron_utils::atomic_write::write_json_atomic;

pub const SESSION_RECORD_FILE: &str = "session-record.json";

/// a burst of tab changes (a divider drag, a restore) lands as one write
/// (tunable)
pub const SESSION_RECORD_WRITE_DELAY_MS: f64 = 1000.0;

/// A restore run that ends abnormally sooner than this after its start counts
/// as a crash loop: the next run preloads no tab (spec 5.3, tunable).
pub const CRASH_LOOP_WINDOW_MS: f64 = 2.0 * 60.0 * 1000.0;

const DOCUMENT_KINDS: [&str; 10] = [
    "docs", "sheets", "slides", "pdf", "markdown", "html", "mindmap", "hwp", "epub", "diagram",
];

/// the same shape the recovery store accepts for an untitled copy
fn untitled_id_re() -> &'static JsRegex {
    js_regex!(r"^[A-Za-z0-9_-]{1,64}$")
}

fn ext_re() -> &'static JsRegex {
    js_regex!(r"^\.[a-z0-9]{1,10}$")
}

const MIN_RATIO: f64 = 0.05;
const MAX_RATIO: f64 = 0.95;

/// `SessionUntitledCopy`: the recovery-copy identity of an untitled document
#[derive(Debug, Clone, PartialEq)]
pub struct SessionUntitledCopy {
    pub untitled_id: String,
    /// lower-case, with the dot, as in RecoveryUntitledIdentity
    pub ext: String,
}

/// `SessionRecordTab`: one document tab as recorded
#[derive(Debug, Clone, PartialEq)]
pub struct SessionRecordTab {
    pub kind: String,
    pub title: String,
    /// absent for an untitled document
    pub file_path: Option<String>,
    /// an untitled document's recovery copy, when the editor reported one
    pub untitled: Option<SessionUntitledCopy>,
    /// the tab sat in a detached window; it comes back as a main-window tab
    pub detached: bool,
}

/// `SessionRecordSplit`: the split of the main window, by index into `tabs`
#[derive(Debug, Clone, PartialEq)]
pub struct SessionRecordSplit {
    pub a: usize,
    pub b: usize,
    /// `"side"` or `"stack"`
    pub orientation: &'static str,
    pub ratio: f64,
    /// `"a"` or `"b"`
    pub focus: &'static str,
}

/// `SessionRecord`
#[derive(Debug, Clone, PartialEq)]
pub struct SessionRecord {
    /// the run passed the whole quit path, or closed its window into the tray
    pub clean_exit: bool,
    /// epoch ms when the run started
    pub started_at: f64,
    /// the run rebuilt tabs after an abnormal exit
    pub restore_run: bool,
    /// the run outlived CRASH_LOOP_WINDOW_MS
    pub past_startup: bool,
    /// main-window tabs in strip order, then the detached ones
    pub tabs: Vec<SessionRecordTab>,
    /// index into `tabs` of the main window's front tab; `None` = Home
    pub active: Option<usize>,
    pub split: Option<SessionRecordSplit>,
    /// the run ended in "Restart & Install": its tabs, as they were when the
    /// quit began, come back in the next run (decision 0077)
    pub update_restart: bool,
    /// where the key sits: `parseSessionRecord` writes `updateRestart` before
    /// `active` and `split`; `markUpdateRestart` spreads the record and adds
    /// it after them
    pub update_restart_last: bool,
}

/// `SessionSnapshot`: what the record keeps of the live app
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SessionSnapshot {
    pub tabs: Vec<SessionRecordTab>,
    pub active: Option<usize>,
    pub split: Option<SessionRecordSplit>,
}

/// `JSON.stringify` writes a number: NaN and the infinities as `null`.
fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

/// The tab as `normalizeTab` builds it: `kind`, `title`, then the keys it
/// has.
pub fn tab_to_value(tab: &SessionRecordTab) -> Value {
    let mut map = Map::new();
    map.insert("kind".into(), Value::from(tab.kind.as_str()));
    map.insert("title".into(), Value::from(tab.title.as_str()));
    if let Some(file_path) = &tab.file_path {
        map.insert("filePath".into(), Value::from(file_path.as_str()));
    }
    if let Some(untitled) = &tab.untitled {
        let mut copy = Map::new();
        copy.insert(
            "untitledId".into(),
            Value::from(untitled.untitled_id.as_str()),
        );
        copy.insert("ext".into(), Value::from(untitled.ext.as_str()));
        map.insert("untitled".into(), Value::Object(copy));
    }
    if tab.detached {
        map.insert("detached".into(), Value::Bool(true));
    }
    Value::Object(map)
}

/// `{ a, b, orientation, ratio, focus }`
pub fn split_to_value(split: &SessionRecordSplit) -> Value {
    let mut map = Map::new();
    map.insert("a".into(), num(split.a as f64));
    map.insert("b".into(), num(split.b as f64));
    map.insert("orientation".into(), Value::from(split.orientation));
    map.insert("ratio".into(), num(split.ratio));
    map.insert("focus".into(), Value::from(split.focus));
    Value::Object(map)
}

fn tabs_to_value(tabs: &[SessionRecordTab]) -> Value {
    Value::Array(tabs.iter().map(tab_to_value).collect())
}

/// The record as `JSON.stringify` writes it.
pub fn record_to_value(record: &SessionRecord) -> Value {
    let mut map = Map::new();
    map.insert("version".into(), num(1.0));
    map.insert("cleanExit".into(), Value::Bool(record.clean_exit));
    map.insert("startedAt".into(), num(record.started_at));
    map.insert("restoreRun".into(), Value::Bool(record.restore_run));
    map.insert("pastStartup".into(), Value::Bool(record.past_startup));
    map.insert("tabs".into(), tabs_to_value(&record.tabs));
    if record.update_restart && !record.update_restart_last {
        map.insert("updateRestart".into(), Value::Bool(true));
    }
    if let Some(active) = record.active {
        map.insert("active".into(), num(active as f64));
    }
    if let Some(split) = &record.split {
        map.insert("split".into(), split_to_value(split));
    }
    if record.update_restart && record.update_restart_last {
        map.insert("updateRestart".into(), Value::Bool(true));
    }
    Value::Object(map)
}

/// The snapshot as the TypeScript builds it: `tabs`, then `active`, `split`.
pub fn snapshot_to_value(snapshot: &SessionSnapshot) -> Value {
    let mut map = Map::new();
    map.insert("tabs".into(), tabs_to_value(&snapshot.tabs));
    if let Some(active) = snapshot.active {
        map.insert("active".into(), num(active as f64));
    }
    if let Some(split) = &snapshot.split {
        map.insert("split".into(), split_to_value(split));
    }
    Value::Object(map)
}

/// `JSON.stringify(record)`
fn snapshot_json(record: &SessionRecord) -> String {
    json_to_string(&record_to_value(record)).expect("a record prints")
}

/// `value[key]` of an object value; `None` is `undefined` (or not an object)
fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(key),
        _ => None,
    }
}

/// `raw !== null && typeof raw === 'object' && !Array.isArray(raw)`
fn is_plain_object(value: &JsonValue) -> bool {
    matches!(value, JsonValue::Object(_))
}

/// `isDocumentKind`
fn is_document_kind(value: Option<&JsonValue>) -> Option<&str> {
    match value {
        Some(JsonValue::String(kind)) if DOCUMENT_KINDS.contains(&kind.as_str()) => Some(kind),
        _ => None,
    }
}

/// `normalizeUntitled`
fn normalize_untitled(raw: &JsonValue) -> Option<SessionUntitledCopy> {
    if !is_plain_object(raw) {
        return None;
    }
    let Some(JsonValue::String(untitled_id)) = field(raw, "untitledId") else {
        return None;
    };
    if !untitled_id_re().test(untitled_id) {
        return None;
    }
    let Some(JsonValue::String(ext)) = field(raw, "ext") else {
        return None;
    };
    if !ext_re().test(ext) {
        return None;
    }
    Some(SessionUntitledCopy {
        untitled_id: untitled_id.clone(),
        ext: ext.clone(),
    })
}

/// `normalizeTab`: one tab entry, or `None` when it is unusable. `strict`
/// (reading the file) drops entries with a malformed optional field; building
/// a snapshot keeps the tab and drops only that field.
fn normalize_tab(raw: &JsonValue, strict: bool) -> Option<SessionRecordTab> {
    if !is_plain_object(raw) {
        return None;
    }
    let kind = is_document_kind(field(raw, "kind"))?;
    let Some(JsonValue::String(title)) = field(raw, "title") else {
        return None;
    };
    let mut tab = SessionRecordTab {
        kind: kind.to_owned(),
        title: title.clone(),
        file_path: None,
        untitled: None,
        detached: false,
    };
    if let Some(file_path) = field(raw, "filePath") {
        match file_path {
            JsonValue::String(path) if !path.is_empty() => tab.file_path = Some(path.clone()),
            _ if strict => return None,
            _ => {}
        }
    }
    if let Some(untitled) = field(raw, "untitled")
        && tab.file_path.is_none()
    {
        match normalize_untitled(untitled) {
            Some(copy) => tab.untitled = Some(copy),
            None if strict => return None,
            None => {}
        }
    }
    if matches!(field(raw, "detached"), Some(JsonValue::Bool(true))) {
        tab.detached = true;
    }
    Some(tab)
}

/// `normalizeSplit`: `a` and `b` are the JavaScript numbers (or `undefined`)
/// the caller worked out; the rest is read from the raw split.
fn normalize_split(
    a: Option<f64>,
    b: Option<f64>,
    orientation: Option<&JsonValue>,
    ratio: Option<&JsonValue>,
    focus: Option<&JsonValue>,
    tabs: &[SessionRecordTab],
) -> Option<SessionRecordSplit> {
    // `validIndex`: an integer index of a tab that is not detached
    let valid_index = |value: Option<f64>| -> Option<usize> {
        let x = value?;
        if x.fract() != 0.0 || x < 0.0 || x >= tabs.len() as f64 {
            return None;
        }
        let index = x as usize;
        (!tabs[index].detached).then_some(index)
    };
    let a = valid_index(a)?;
    let b = valid_index(b)?;
    if a == b {
        return None;
    }
    let orientation = match orientation {
        Some(JsonValue::String(text)) if text == "side" => "side",
        Some(JsonValue::String(text)) if text == "stack" => "stack",
        _ => return None,
    };
    let Some(JsonValue::Number(ratio)) = ratio else {
        return None;
    };
    if !ratio.is_finite() {
        return None;
    }
    let focus = match focus {
        Some(JsonValue::String(text)) if text == "a" => "a",
        Some(JsonValue::String(text)) if text == "b" => "b",
        _ => return None,
    };
    Some(SessionRecordSplit {
        a,
        b,
        orientation,
        ratio: math_min(MAX_RATIO, math_max(MIN_RATIO, *ratio)),
        focus,
    })
}

/// `typeof value === 'number'`
fn number_of(value: Option<&JsonValue>) -> Option<f64> {
    match value {
        Some(JsonValue::Number(x)) => Some(*x),
        _ => None,
    }
}

/// `Map<number, number>.get(key)` of the index map `parseSessionRecord`
/// builds: the keys are the integers 0..n (`-0` is `0` to a `Map`).
fn remap_get(remap: &HashMap<usize, usize>, key: f64) -> Option<usize> {
    if key.fract() != 0.0 || key < 0.0 {
        return None;
    }
    remap.get(&(key as usize)).copied()
}

/// `parseSessionRecord`: read a stored record. Inside a valid record, a
/// malformed tab entry is dropped (the indices pointing past it are
/// remapped) and a malformed active index or split is ignored.
pub fn parse_session_record(raw: &JsonValue) -> Option<SessionRecord> {
    if !is_plain_object(raw) {
        return None;
    }
    if !matches!(field(raw, "version"), Some(JsonValue::Number(x)) if *x == 1.0) {
        return None;
    }
    let Some(JsonValue::Bool(clean_exit)) = field(raw, "cleanExit") else {
        return None;
    };
    let started_at = match field(raw, "startedAt") {
        Some(JsonValue::Number(x)) if x.is_finite() => *x,
        _ => return None,
    };
    let Some(JsonValue::Bool(restore_run)) = field(raw, "restoreRun") else {
        return None;
    };
    let Some(JsonValue::Array(entries)) = field(raw, "tabs") else {
        return None;
    };

    let mut tabs: Vec<SessionRecordTab> = Vec::new();
    let mut remap: HashMap<usize, usize> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        let Some(tab) = normalize_tab(entry, true) else {
            continue;
        };
        remap.insert(index, tabs.len());
        tabs.push(tab);
    }

    let mut parsed = SessionRecord {
        clean_exit: *clean_exit,
        started_at,
        restore_run: *restore_run,
        past_startup: matches!(field(raw, "pastStartup"), Some(JsonValue::Bool(true))),
        tabs,
        active: None,
        split: None,
        update_restart: false,
        update_restart_last: false,
    };
    if matches!(field(raw, "updateRestart"), Some(JsonValue::Bool(true))) {
        parsed.update_restart = true;
    }
    if let Some(active) = number_of(field(raw, "active"))
        && let Some(active) = remap_get(&remap, active)
        && !parsed.tabs[active].detached
    {
        parsed.active = Some(active);
    }
    if let Some(split) = field(raw, "split").filter(|split| is_plain_object(split)) {
        let a = number_of(field(split, "a")).and_then(|x| remap_get(&remap, x));
        let b = number_of(field(split, "b")).and_then(|x| remap_get(&remap, x));
        if let Some(normalized) = normalize_split(
            a.map(|i| i as f64),
            b.map(|i| i as f64),
            field(split, "orientation"),
            field(split, "ratio"),
            field(split, "focus"),
            &parsed.tabs,
        ) {
            parsed.split = Some(normalized);
        }
    }
    Some(parsed)
}

/// `SessionRecordReadResult`
#[derive(Debug, Clone, PartialEq)]
pub enum SessionRecordReadResult {
    Missing,
    Corrupt,
    Ok(SessionRecord),
}

/// `sessionRecordPath`
pub fn session_record_path(user_data_dir: &str) -> String {
    join(&[user_data_dir, SESSION_RECORD_FILE])
}

/// `readSessionRecord`
pub fn read_session_record(file_path: &str) -> SessionRecordReadResult {
    let bytes = match fs::read(file_path) {
        Ok(bytes) => bytes,
        Err(error) => {
            let code = code_of(&error);
            return if code == Some("ENOENT") || code == Some("ENOTDIR") {
                SessionRecordReadResult::Missing
            } else {
                SessionRecordReadResult::Corrupt
            };
        }
    };
    // readFileSync(path, 'utf8'): ill-formed bytes become U+FFFD, a BOM stays
    let text = String::from_utf8_lossy(&bytes);
    let Ok(raw) = json_parse(&text) else {
        return SessionRecordReadResult::Corrupt;
    };
    match parse_session_record(&raw) {
        Some(record) => SessionRecordReadResult::Ok(record),
        None => SessionRecordReadResult::Corrupt,
    }
}

/// `PreviousExitJudgment.reason`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviousExitReason {
    /// first run, or the first run of a version with this feature
    NoRecord,
    /// the quit path completed and no undecided / restore-chosen copy is left
    Clean,
    /// the run never completed its quit (power loss, kill, crash, OS shutdown)
    NotClean,
    /// the quit completed but left undecided or restore-chosen copies
    UnresolvedCopies,
    /// the record was unreadable; abnormal only when undecided or
    /// restore-chosen copies are left
    CorruptRecord,
    /// the quit completed for "Restart & Install" (or the installer reopened
    /// the app after an update)
    UpdateRestart,
}

impl PreviousExitReason {
    /// the TypeScript's string
    pub fn as_str(self) -> &'static str {
        match self {
            PreviousExitReason::NoRecord => "noRecord",
            PreviousExitReason::Clean => "clean",
            PreviousExitReason::NotClean => "notClean",
            PreviousExitReason::UnresolvedCopies => "unresolvedCopies",
            PreviousExitReason::CorruptRecord => "corruptRecord",
            PreviousExitReason::UpdateRestart => "updateRestart",
        }
    }
}

/// `PreviousExitJudgment`: how the previous run ended (spec 4)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreviousExitJudgment {
    pub abnormal: bool,
    pub reason: PreviousExitReason,
    /// The previous run was itself a restore run and died within
    /// CRASH_LOOP_WINDOW_MS of its start: preload no tab and do not rebuild
    /// the split this time (spec 5.3).
    pub crash_loop: bool,
}

/// `judgePreviousExit(previous, store, options)`: `has_unresolved_copies` is
/// `store.hasUnresolvedCopies()`, `reopened_by_installer` is
/// `options.reopenedByInstaller === true`.
pub fn judge_previous_exit(
    previous: &SessionRecordReadResult,
    has_unresolved_copies: &mut dyn FnMut() -> bool,
    reopened_by_installer: bool,
) -> PreviousExitJudgment {
    let judgment = |abnormal, reason, crash_loop| PreviousExitJudgment {
        abnormal,
        reason,
        crash_loop,
    };
    let record = match previous {
        SessionRecordReadResult::Missing => {
            return judgment(false, PreviousExitReason::NoRecord, false);
        }
        SessionRecordReadResult::Corrupt => {
            return if has_unresolved_copies() {
                judgment(true, PreviousExitReason::CorruptRecord, false)
            } else {
                judgment(false, PreviousExitReason::CorruptRecord, false)
            };
        }
        SessionRecordReadResult::Ok(record) => record,
    };
    if !record.clean_exit {
        return judgment(
            true,
            PreviousExitReason::NotClean,
            record.restore_run && !record.past_startup,
        );
    }
    if record.update_restart || reopened_by_installer {
        return judgment(true, PreviousExitReason::UpdateRestart, false);
    }
    if has_unresolved_copies() {
        return judgment(true, PreviousExitReason::UnresolvedCopies, false);
    }
    judgment(false, PreviousExitReason::Clean, false)
}

/// `sessionRestoreLayout`: the tabs to rebuild after an abnormal exit, in the
/// index shape of TabManager.hydrateSession. A crash loop keeps the tabs but
/// drops the front tab and the split, so nothing preloads.
pub fn session_restore_layout(record: &SessionRecord, crash_loop: bool) -> SessionSnapshot {
    let mut layout = SessionSnapshot {
        tabs: record.tabs.clone(),
        active: None,
        split: None,
    };
    if crash_loop {
        return layout;
    }
    if record.active.is_some() {
        layout.active = record.active;
    }
    if let Some(split) = &record.split {
        layout.split = Some(split.clone());
    }
    layout
}

/// Builds the copy record for an untitled tab, `None` when it has none.
pub type UntitledCopyFor<'a> = dyn FnMut(&JsonValue) -> Option<JsonValue> + 'a;

/// `SessionStripState` and `SessionDetachedTab` are read as JavaScript
/// values: a tab is an object `{ id, kind, title, filePath? }`.
///
/// `sessionSnapshotFrom(source)`: only the fields the record keeps are
/// copied, so nothing else a caller hands over (and no document content) can
/// reach the file.
///
/// - `strip_tabs`: `source.strip?.tabs ?? []`
/// - `strip`: `source.strip` (`None` for `null`), whose `activeId` and `split`
///   are read
/// - `detached`: `source.detached ?? []`
/// - `untitled_copy_for`: `source.untitledCopyFor`, called with the tab as it
///   was handed over; `None` when the source has none. It answers
///   `Some(value)` where the TypeScript returns something other than
///   `undefined`.
///
/// A tab whose `id` is not a string never matches an `activeId` or a split id.
pub fn session_snapshot_from(
    strip: Option<&JsonValue>,
    detached: &[JsonValue],
    mut untitled_copy_for: Option<&mut UntitledCopyFor<'_>>,
) -> SessionSnapshot {
    let mut tabs: Vec<SessionRecordTab> = Vec::new();
    let mut index_by_id: HashMap<String, usize> = HashMap::new();
    let mut add = |tab: &JsonValue, is_detached: bool| {
        let mut raw: JsObject<JsonValue> = JsObject::new();
        if let Some(kind) = field(tab, "kind") {
            raw.set("kind", kind.clone());
        }
        if let Some(title) = field(tab, "title") {
            raw.set("title", title.clone());
        }
        let file_path = field(tab, "filePath");
        if let Some(file_path) = file_path {
            raw.set("filePath", file_path.clone());
        }
        // `tab.filePath ? undefined : source.untitledCopyFor?.(tab)`
        if !file_path.is_some_and(JsonValue::truthy)
            && let Some(copy_for) = untitled_copy_for.as_mut()
            && let Some(copy) = copy_for(tab)
        {
            raw.set("untitled", copy);
        }
        if is_detached {
            raw.set("detached", JsonValue::Bool(true));
        }
        let Some(entry) = normalize_tab(&JsonValue::Object(raw), false) else {
            return;
        };
        if let Some(JsonValue::String(id)) = field(tab, "id") {
            index_by_id.insert(id.clone(), tabs.len());
        }
        tabs.push(entry);
    };
    if let Some(JsonValue::Array(strip_tabs)) = strip.and_then(|s| field(s, "tabs")) {
        for tab in strip_tabs {
            add(tab, false);
        }
    }
    for tab in detached {
        add(tab, true);
    }

    let mut snapshot = SessionSnapshot {
        tabs,
        active: None,
        split: None,
    };
    let active = match strip.and_then(|s| field(s, "activeId")) {
        Some(JsonValue::String(id)) => index_by_id.get(id).copied(),
        _ => None,
    };
    if let Some(active) = active
        && !snapshot.tabs[active].detached
    {
        snapshot.active = Some(active);
    }
    if let Some(split) = strip
        .and_then(|s| field(s, "split"))
        .filter(|split| split.truthy())
    {
        let lookup = |key: &str| match field(split, key) {
            Some(JsonValue::String(id)) => index_by_id.get(id).map(|&i| i as f64),
            _ => None,
        };
        let (a, b) = (lookup("aTabId"), lookup("bTabId"));
        if let Some(candidate) = normalize_split(
            a,
            b,
            field(split, "orientation"),
            field(split, "ratio"),
            field(split, "focus"),
            &snapshot.tabs,
        ) {
            snapshot.split = Some(candidate);
        }
    }
    snapshot
}

/// The writer of `SessionRecorderOptions.writeJson` that is not injected:
/// `writeJsonAtomic`.
pub fn write_record_atomic(file_path: &str, record: &SessionRecord) -> Result<(), NodeError> {
    write_json_atomic(file_path, &json_value_from_serde(&record_to_value(record)))
}

/// What the recorder reads from, and tells, the outside: `options.now`,
/// `options.writeJson` and `console.warn`.
pub trait SessionRecorderEnv {
    /// `now()`: the clock of the run
    fn now(&mut self) -> f64;
    /// `writeJson(filePath, record)`; `Err` carries what `String(error)` of
    /// the thrown value gives
    fn write_json(&mut self, file_path: &str, record: &SessionRecord) -> Result<(), String>;
    /// `console.warn(label, error)`
    fn warn(&mut self, label: &str, error: &str);
}

/// `SessionRecorderOptions` without what the environment supplies.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionRecorderOptions {
    /// the app data folder (`app.getPath('userData')`)
    pub user_data_dir: String,
    /// `writeDelayMs ?? SESSION_RECORD_WRITE_DELAY_MS`
    pub write_delay_ms: Option<f64>,
    /// `crashLoopWindowMs ?? CRASH_LOOP_WINDOW_MS`
    pub crash_loop_window_ms: Option<f64>,
}

/// `SessionRecorder`
#[derive(Debug)]
pub struct SessionRecorder {
    file_path: String,
    write_delay: f64,
    loop_window: f64,
    /// the previous run's record as read at init; never re-read
    pub previous: SessionRecordReadResult,
    current: Option<SessionRecord>,
    last_written: Option<String>,
    write_timer_pending: bool,
    startup_timer_pending: bool,
    /// set once the run ended (quit or OS session end): nothing is written after
    ended: bool,
    /// the tabs when "Restart & Install" began its quit
    held_for_update: Option<SessionSnapshot>,
}

/// `createSessionRecorder`
pub fn create_session_recorder(options: &SessionRecorderOptions) -> SessionRecorder {
    let file_path = session_record_path(&options.user_data_dir);
    let previous = read_session_record(&file_path);
    SessionRecorder {
        write_delay: options
            .write_delay_ms
            .unwrap_or(SESSION_RECORD_WRITE_DELAY_MS),
        loop_window: options.crash_loop_window_ms.unwrap_or(CRASH_LOOP_WINDOW_MS),
        file_path,
        previous,
        current: None,
        last_written: None,
        write_timer_pending: false,
        startup_timer_pending: false,
        ended: false,
        held_for_update: None,
    }
}

impl SessionRecorder {
    /// the delay `scheduleWrite` gives its timer
    pub fn write_delay_ms(&self) -> f64 {
        self.write_delay
    }

    /// the delay `startRun` gives the crash-loop timer
    pub fn crash_loop_window_ms(&self) -> f64 {
        self.loop_window
    }

    /// whether the timer of a scheduled write is pending
    pub fn write_timer(&self) -> bool {
        self.write_timer_pending
    }

    /// whether the crash-loop timer is pending
    pub fn startup_timer(&self) -> bool {
        self.startup_timer_pending
    }

    fn clear_write_timer(&mut self) {
        self.write_timer_pending = false;
    }

    fn write_now(&mut self, env: &mut dyn SessionRecorderEnv) {
        self.clear_write_timer();
        let Some(current) = &self.current else {
            return;
        };
        let json = snapshot_json(current);
        if self.last_written.as_deref() == Some(json.as_str()) {
            return;
        }
        match env.write_json(&self.file_path, current) {
            Ok(()) => self.last_written = Some(json),
            // never let a full disk or a locked file break a tab change or the quit
            Err(error) => env.warn("[session-record] write failed:", &error),
        }
    }

    fn schedule_write(&mut self) {
        if self.write_timer_pending {
            return;
        }
        self.write_timer_pending = true;
    }

    fn finish(&mut self) {
        self.ended = true;
        self.startup_timer_pending = false;
    }

    /// The write timer fired.
    pub fn fire_write_timer(&mut self, env: &mut dyn SessionRecorderEnv) {
        if !self.write_timer_pending {
            return;
        }
        self.write_timer_pending = false;
        self.write_now(env);
    }

    /// The crash-loop timer fired.
    pub fn fire_startup_timer(&mut self, env: &mut dyn SessionRecorderEnv) {
        if !self.startup_timer_pending {
            return;
        }
        self.startup_timer_pending = false;
        if self.ended {
            return;
        }
        let Some(current) = &mut self.current else {
            return;
        };
        current.past_startup = true;
        self.write_now(env);
    }

    /// `startRun`: begin this run: write a record without the clean mark,
    /// with the start time and whether this run restores tabs. A restore run
    /// starts from the previous record's tabs, so a crash before the first
    /// tab change still finds them; any other run starts empty.
    pub fn start_run(&mut self, env: &mut dyn SessionRecorderEnv, restore_run: bool) {
        if self.current.is_some() || self.ended {
            return;
        }
        let carried = match &self.previous {
            SessionRecordReadResult::Ok(record) if restore_run => {
                session_restore_layout(record, false)
            }
            _ => SessionSnapshot::default(),
        };
        self.current = Some(SessionRecord {
            clean_exit: false,
            started_at: env.now(),
            restore_run,
            past_startup: false,
            tabs: carried.tabs,
            active: carried.active,
            split: carried.split,
            update_restart: false,
            update_restart_last: false,
        });
        self.write_now(env);
        self.startup_timer_pending = true;
    }

    /// `update(snapshot)`: the tabs changed (open, close, reorder, rename,
    /// path, front tab, split, detach). The snapshot is re-validated: only
    /// the recorded fields survive, indices stay consistent. `tabs`,
    /// `active` and `split` are `snapshot.tabs`, `.active` and `.split` as
    /// JavaScript values (`None` for `undefined`).
    pub fn update(
        &mut self,
        env: &mut dyn SessionRecorderEnv,
        tabs: Option<&JsonValue>,
        active: Option<&JsonValue>,
        split: Option<&JsonValue>,
    ) {
        if self.ended {
            return;
        }
        let Some(current) = &self.current else {
            return;
        };
        let mut input: JsObject<JsonValue> = JsObject::new();
        input.set("version", JsonValue::Number(1.0));
        input.set("cleanExit", JsonValue::Bool(false));
        input.set("startedAt", JsonValue::Number(current.started_at));
        input.set("restoreRun", JsonValue::Bool(current.restore_run));
        input.set("pastStartup", JsonValue::Bool(current.past_startup));
        for (key, value) in [("tabs", tabs), ("active", active), ("split", split)] {
            if let Some(value) = value {
                input.set(key, value.clone());
            }
        }
        let Some(parsed) = parse_session_record(&JsonValue::Object(input)) else {
            return;
        };
        let reopened = current.clean_exit;
        self.current = Some(parsed);
        if reopened {
            self.write_now(env);
        } else if self.current.as_ref().map(snapshot_json).as_deref()
            != self.last_written.as_deref()
        {
            self.schedule_write();
        }
    }

    /// `update` for a snapshot built by [`session_snapshot_from`]
    pub fn update_snapshot(
        &mut self,
        env: &mut dyn SessionRecorderEnv,
        snapshot: &SessionSnapshot,
    ) {
        let value = json_value_from_serde(&snapshot_to_value(snapshot));
        let field_of = |key: &str| field(&value, key).cloned();
        let (tabs, active, split) = (field_of("tabs"), field_of("active"), field_of("split"));
        self.update(env, tabs.as_ref(), active.as_ref(), split.as_ref());
    }

    /// `flush`: write a pending change now
    pub fn flush(&mut self, env: &mut dyn SessionRecorderEnv) {
        if self.current.is_none() || self.ended {
            return;
        }
        self.write_now(env);
    }

    /// `markCleanExit`: the quit path completed (`will-quit`): set the clean
    /// mark and stop recording. The tab list stays, since a quit that left
    /// undecided copies still counts as abnormal and rebuilds them.
    pub fn mark_clean_exit(&mut self, env: &mut dyn SessionRecorderEnv) {
        if self.ended {
            return;
        }
        let Some(current) = &mut self.current else {
            return;
        };
        current.clean_exit = true;
        self.write_now(env);
        self.finish();
    }

    /// `holdTabsForUpdateRestart`: "Restart & Install" began its quit: keep
    /// the tabs as they are now. Taken again by every such quit; an ordinary
    /// quit ignores it.
    pub fn hold_tabs_for_update_restart(&mut self) {
        if self.ended {
            return;
        }
        let Some(current) = &self.current else {
            return;
        };
        self.held_for_update = Some(SessionSnapshot {
            tabs: current.tabs.clone(),
            active: current.active,
            split: current.split.clone(),
        });
    }

    /// `markUpdateRestart`: the quit for "Restart & Install" completed: like
    /// `mark_clean_exit`, with the tabs held at its start and the update mark.
    pub fn mark_update_restart(&mut self, env: &mut dyn SessionRecorderEnv) {
        if self.ended {
            return;
        }
        let Some(current) = &self.current else {
            return;
        };
        let kept = self
            .held_for_update
            .clone()
            .unwrap_or_else(|| SessionSnapshot {
                tabs: current.tabs.clone(),
                active: current.active,
                split: current.split.clone(),
            });
        // `{ ...rest, ...kept, cleanExit: true, updateRestart: true }`
        let next = SessionRecord {
            clean_exit: true,
            started_at: current.started_at,
            restore_run: current.restore_run,
            past_startup: current.past_startup,
            tabs: kept.tabs,
            active: kept.active,
            split: kept.split,
            update_restart: true,
            update_restart_last: true,
        };
        self.current = Some(next);
        self.write_now(env);
        self.finish();
    }

    /// `markClosedToTray`: the main window finished closing while the app
    /// stays in the tray: empty the tab list and set the clean mark, so a
    /// later power loss does not bring back tabs the user closed. A window
    /// opened again from the tray clears the mark with its first tab change.
    pub fn mark_closed_to_tray(&mut self, env: &mut dyn SessionRecorderEnv) {
        if self.ended {
            return;
        }
        let Some(current) = &self.current else {
            return;
        };
        self.current = Some(SessionRecord {
            clean_exit: true,
            started_at: current.started_at,
            restore_run: current.restore_run,
            past_startup: current.past_startup,
            tabs: Vec::new(),
            active: None,
            split: None,
            update_restart: false,
            update_restart_last: false,
        });
        self.write_now(env);
    }

    /// `markOsSessionEnd`: the OS is ending the session (shutdown, restart,
    /// logout): write what is pending and stop recording without the clean
    /// mark, so the next run treats the exit as abnormal even when
    /// `will-quit` still runs.
    pub fn mark_os_session_end(&mut self, env: &mut dyn SessionRecorderEnv) {
        if self.current.is_none() || self.ended {
            return;
        }
        self.write_now(env);
        self.finish();
    }

    /// `dispose`: cancel timers
    pub fn dispose(&mut self) {
        self.clear_write_timer();
        self.finish();
    }
}

/// The process-wide recorder of the module (`activeRecorder`) and the
/// functions that reach it.
#[derive(Debug, Default)]
pub struct SessionRecordProcess {
    active: Option<SessionRecorder>,
}

impl SessionRecordProcess {
    pub fn new() -> Self {
        Self::default()
    }

    /// `initSessionRecord`: the one way in. Returns the same recorder when
    /// called again.
    pub fn init_session_record(
        &mut self,
        options: &SessionRecorderOptions,
    ) -> &mut SessionRecorder {
        self.active
            .get_or_insert_with(|| create_session_recorder(options))
    }

    /// `sessionRecorder`: the recorder of this run, or `None` when this
    /// process never initialized one
    pub fn session_recorder(&mut self) -> Option<&mut SessionRecorder> {
        self.active.as_mut()
    }

    /// `noteSessionChanged`: no-op unless initialized (the snapshot is not
    /// even built then, so `untitled_copy_for` is not called)
    pub fn note_session_changed(
        &mut self,
        env: &mut dyn SessionRecorderEnv,
        strip: Option<&JsonValue>,
        detached: &[JsonValue],
        untitled_copy_for: Option<&mut UntitledCopyFor<'_>>,
    ) {
        if let Some(recorder) = &mut self.active {
            let snapshot = session_snapshot_from(strip, detached, untitled_copy_for);
            recorder.update_snapshot(env, &snapshot);
        }
    }

    /// `markSessionCleanExit`: no-op unless initialized
    pub fn mark_session_clean_exit(&mut self, env: &mut dyn SessionRecorderEnv) {
        if let Some(recorder) = &mut self.active {
            recorder.mark_clean_exit(env);
        }
    }

    /// `holdSessionTabsForUpdateRestart`: no-op unless initialized
    pub fn hold_session_tabs_for_update_restart(&mut self) {
        if let Some(recorder) = &mut self.active {
            recorder.hold_tabs_for_update_restart();
        }
    }

    /// `markSessionUpdateRestart`: no-op unless initialized
    pub fn mark_session_update_restart(&mut self, env: &mut dyn SessionRecorderEnv) {
        if let Some(recorder) = &mut self.active {
            recorder.mark_update_restart(env);
        }
    }

    /// `markSessionClosedToTray`: no-op unless initialized
    pub fn mark_session_closed_to_tray(&mut self, env: &mut dyn SessionRecorderEnv) {
        if let Some(recorder) = &mut self.active {
            recorder.mark_closed_to_tray(env);
        }
    }

    /// `markSessionOsEnd`: no-op unless initialized
    pub fn mark_session_os_end(&mut self, env: &mut dyn SessionRecorderEnv) {
        if let Some(recorder) = &mut self.active {
            recorder.mark_os_session_end(env);
        }
    }

    /// `resetSessionRecordForTests`: forget the process-wide recorder
    pub fn reset_session_record_for_tests(&mut self) {
        if let Some(recorder) = &mut self.active {
            recorder.dispose();
        }
        self.active = None;
    }
}
