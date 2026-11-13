//! `packages/pdf-structure/src/store/store.ts`: the result store (spec §6):
//! AI-read pages, translations and unfinished job records kept on this PC
//! until the user deletes them. Layout under `<userData>/pdf-store/`:
//!
//! ```text
//! docs/<docHash>/ai-read/<pageFp>.json
//! docs/<docHash>/translations/<lang>/translation.json
//! docs/<docHash>/translations/<lang>/blocks/<pageFp>/<textHash>.<occurrence>.json
//! docs/<docHash>/easy/<lang>/...            easy explanations, laid out as translations/
//! docs/<docHash>/jobs/ai-read.json | translate.<lang>.json | ...
//! docs/<docHash>/passages/, highlights/, insights/
//! note-links.json
//! ```
//!
//! Every file is one entry, written whole and atomically (`files`); the same
//! entry is last-writer-wins. An entry that cannot be read or does not have
//! the expected shape counts as absent.
//!
//! The TypeScript's async methods are one synchronous method each here. Its
//! `inTurn` (in-process turns of a read-modify-write, by entry path) has
//! nothing to take turns with: the calls of one store do not overlap, so a
//! change runs where it is called. Methods that can throw return
//! [`StoreResult`]; the ones that never throw return their value.

use std::collections::HashSet;

use jscompat::node_path::host::{is_absolute, join};
use jscompat::{
    JsMap, JsObject, JsonValue, js_regex, json_quote, number_to_string, sort_by_number, to_number,
};

use super::files::{
    EntryKind, StoreEnv, file_exists, folder_size, list_names, read_json, remove_entry,
    remove_folder, system_now_ms, write_json_atomic,
};
use super::keys::{TranslationBlockKey, block_key_string};
use super::note_links::{
    FoundNoteLink, MatchedBy, NOTE_LINKS_FILE, NoteLink, NoteLinks, as_note_links, note_link_key,
};
use super::reading::{
    HighlightBlockEntry, HighlightBlockInput, HighlightRun, HighlightSuggestion,
    HighlightSuggestionState, InsightsEntry, PassageCard, PassageCardInput, as_highlight_block,
    as_highlight_run, as_insights, as_passage_card, is_segment_str, key_value, num, object,
    opt_string, record, string,
};
use super::sentence_ends::{SentenceEnds, sentence_ends_pair};
use super::{JobKind, KeyField, StoreWriteError, TranslationMode, job_key_field, job_mode_allowed};

/// `STORE_DIR_NAME`: the store's folder inside the user-data folder
pub const STORE_DIR_NAME: &str = "pdf-store";

/// `JOB_RUNNING_WINDOW_MS`: a job record refreshed this recently counts as running (spec §10)
pub const JOB_RUNNING_WINDOW_MS: f64 = 30_000.0;

/// the upstream app's home folder
const UPSTREAM_HOME_DIR: &str = ".genoffice";

/// `RUN_FILE`
const RUN_FILE: &str = "run.json";

/// What a store call throws.
#[derive(Debug, Clone, PartialEq)]
pub enum StoreError {
    /// a `TypeError`, by its message
    Type(String),
    /// a `StoreWriteError`
    Write(StoreWriteError),
}

impl StoreError {
    /// `err.message`
    pub fn message(&self) -> &str {
        match self {
            StoreError::Type(message) => message,
            StoreError::Write(error) => &error.message,
        }
    }
}

impl From<StoreWriteError> for StoreError {
    fn from(error: StoreWriteError) -> Self {
        StoreError::Write(error)
    }
}

pub type StoreResult<T> = Result<T, StoreError>;

fn type_error<T>(message: impl Into<String>) -> StoreResult<T> {
    Err(StoreError::Type(message.into()))
}

// ---- entry types ----

/// `AiReadPageEntry`: the AI's reading of one page; `payload` is opaque
/// here (an object with a numeric `version`)
#[derive(Debug, Clone, PartialEq)]
pub struct AiReadPageEntry {
    pub page_fingerprint: String,
    pub payload: JsonValue,
    pub provider: Option<String>,
    pub model: Option<String>,
    /// epoch ms of the write
    pub saved_at: f64,
}

impl AiReadPageEntry {
    /// the entry as `asAiRead` builds it
    pub fn to_value(&self) -> JsonValue {
        let mut entries = vec![
            (
                "pageFingerprint",
                JsonValue::String(self.page_fingerprint.clone()),
            ),
            ("payload", self.payload.clone()),
            ("savedAt", JsonValue::Number(self.saved_at)),
        ];
        if let Some(provider) = &self.provider {
            entries.push(("provider", JsonValue::String(provider.clone())));
        }
        if let Some(model) = &self.model {
            entries.push(("model", JsonValue::String(model.clone())));
        }
        object(entries)
    }
}

/// the `meta` of `writeAiReadPage`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AiReadMeta {
    pub provider: Option<String>,
    pub model: Option<String>,
}

/// `TranslationMetaInput`: who translates this document into the language
#[derive(Debug, Clone, PartialEq)]
pub struct TranslationMetaInput {
    pub provider: String,
    pub model: String,
}

/// `TranslationBlockStatus`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranslationBlockStatus {
    /// `text` (and optionally `runs`) replace the source
    Translated,
    /// the source stays
    Failed,
}

impl TranslationBlockStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TranslationBlockStatus::Translated => "translated",
            TranslationBlockStatus::Failed => "failed",
        }
    }
}

/// `TranslationBlockInput`
#[derive(Debug, Clone, PartialEq)]
pub struct TranslationBlockInput {
    pub key: TranslationBlockKey,
    pub status: TranslationBlockStatus,
    /// translated text; required when the status is `Translated`
    pub text: Option<String>,
    /// translated text with its marks restored (a JSON array of runs)
    pub runs: Option<JsonValue>,
    /// why the block stayed in the source language
    pub reason: Option<String>,
    /// `edited?: true`: `Some(flag)` where the caller wrote the field (only
    /// `true` is a valid edit)
    pub edited: Option<bool>,
    /// where each source sentence ends (a JSON array of numbers)
    pub source_sentence_ends: Option<JsonValue>,
    /// where each translated sentence ends (a JSON array of numbers)
    pub sentence_ends: Option<JsonValue>,
}

/// `TranslationBlockEntry`: a block as it is read
#[derive(Debug, Clone, PartialEq)]
pub struct TranslationBlockEntry {
    pub key: TranslationBlockKey,
    pub status: TranslationBlockStatus,
    pub text: Option<String>,
    pub runs: Option<JsonValue>,
    pub reason: Option<String>,
    pub edited: bool,
    pub sentence_ends: Option<SentenceEnds>,
    pub saved_at: f64,
}

fn numbers_value(items: &[f64]) -> JsonValue {
    JsonValue::Array(items.iter().map(|x| JsonValue::Number(*x)).collect())
}

impl TranslationBlockEntry {
    /// the entry as `asBlock` builds it
    pub fn to_value(&self) -> JsonValue {
        let mut entries = vec![
            ("key", key_value(&self.key)),
            ("status", JsonValue::String(self.status.as_str().to_owned())),
            ("savedAt", JsonValue::Number(self.saved_at)),
        ];
        if let Some(text) = &self.text {
            entries.push(("text", JsonValue::String(text.clone())));
        }
        if let Some(runs) = &self.runs {
            entries.push(("runs", runs.clone()));
        }
        if let Some(reason) = &self.reason {
            entries.push(("reason", JsonValue::String(reason.clone())));
        }
        if self.edited {
            entries.push(("edited", JsonValue::Bool(true)));
        }
        if let Some(ends) = &self.sentence_ends {
            entries.push((
                "sourceSentenceEnds",
                numbers_value(&ends.source_sentence_ends),
            ));
            entries.push(("sentenceEnds", numbers_value(&ends.sentence_ends)));
        }
        object(entries)
    }
}

/// `StoredTranslation`
#[derive(Debug, Clone)]
pub struct StoredTranslation {
    pub lang: String,
    /// `None` (`null`) when the translation's own record is missing or unreadable
    pub provider: Option<String>,
    pub model: Option<String>,
    /// keyed by `blockKeyString(key)`
    pub blocks: JsMap<TranslationBlockEntry>,
}

/// `JobState`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobState {
    Idle,
    Running,
    Stopped,
    Complete,
}

impl JobState {
    pub fn as_str(self) -> &'static str {
        match self {
            JobState::Idle => "idle",
            JobState::Running => "running",
            JobState::Stopped => "stopped",
            JobState::Complete => "complete",
        }
    }
}

/// `JobProgress`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JobProgress {
    pub done: f64,
    pub total: f64,
}

impl JobProgress {
    fn to_value(self) -> JsonValue {
        object(vec![
            ("done", JsonValue::Number(self.done)),
            ("total", JsonValue::Number(self.total)),
        ])
    }
}

/// `JobRecordInput`: `state` is `Exclude<JobState, 'idle'>` (anything but
/// `Idle` is refused with a `TypeError`)
#[derive(Debug, Clone, PartialEq)]
pub struct JobRecordInput {
    pub kind: JobKind,
    /// target language; required for `translate`, `translate-page` and `summary`
    pub lang: Option<String>,
    /// the highlight run; required for `highlight`
    pub run_id: Option<String>,
    /// `easy` keeps an easy explanation in its own record file; left out or
    /// `translate`: a plain record, written without the field
    pub mode: Option<TranslationMode>,
    pub state: JobState,
    pub last_error: Option<String>,
    /// epoch ms when a rate limit lifts
    pub resets_at: Option<f64>,
    /// result files the job wrote
    pub outputs: Option<Vec<String>>,
    pub progress: Option<JobProgress>,
}

/// `JobStatus`
#[derive(Debug, Clone, PartialEq)]
pub struct JobStatus {
    pub kind: JobKind,
    pub lang: Option<String>,
    pub run_id: Option<String>,
    /// `easy` on an easy explanation's record; absent on every plain one
    pub mode_easy: bool,
    pub state: JobState,
    pub last_error: Option<String>,
    pub resets_at: Option<f64>,
    pub outputs: Vec<String>,
    pub progress: Option<JobProgress>,
    /// epoch ms of the last write (the heartbeat)
    pub updated_at: Option<f64>,
}

impl JobStatus {
    /// the status as `resolveJob` and `readJob` build it
    pub fn to_value(&self) -> JsonValue {
        let mut entries = vec![
            ("kind", JsonValue::String(self.kind.as_str().to_owned())),
            ("state", JsonValue::String(self.state.as_str().to_owned())),
            (
                "outputs",
                JsonValue::Array(
                    self.outputs
                        .iter()
                        .map(|o| JsonValue::String(o.clone()))
                        .collect(),
                ),
            ),
        ];
        if let Some(updated_at) = self.updated_at {
            entries.push(("updatedAt", JsonValue::Number(updated_at)));
        }
        if let Some(lang) = &self.lang {
            entries.push(("lang", JsonValue::String(lang.clone())));
        }
        if let Some(run_id) = &self.run_id {
            entries.push(("runId", JsonValue::String(run_id.clone())));
        }
        if self.mode_easy {
            entries.push(("mode", JsonValue::String("easy".to_owned())));
        }
        if let Some(last_error) = &self.last_error {
            entries.push(("last_error", JsonValue::String(last_error.clone())));
        }
        if let Some(resets_at) = self.resets_at {
            entries.push(("resetsAt", JsonValue::Number(resets_at)));
        }
        if let Some(progress) = self.progress {
            entries.push(("progress", progress.to_value()));
        }
        object(entries)
    }
}

/// `MigrateInput`
#[derive(Debug, Clone, PartialEq)]
pub struct MigrateInput {
    /// hash of the file bytes before the in-app save
    pub old_doc_hash: String,
    /// hash of the saved file bytes
    pub new_doc_hash: String,
    /// page fingerprints of the saved document, any order
    pub page_fingerprints: Vec<String>,
    /// when given, only the translation blocks with one of these keys move
    pub keep_block_keys: Option<Vec<TranslationBlockKey>>,
}

/// `MigrateResult`: the counts are JavaScript numbers; a count after
/// `languages` is present only when it is above 0
#[derive(Debug, Clone, PartialEq)]
pub struct MigrateResult {
    pub ai_read_pages: f64,
    /// plain translation blocks moved (easy explanations are counted apart)
    pub translation_blocks: f64,
    /// plain translation languages that received anything
    pub languages: Vec<String>,
    pub easy_blocks: Option<f64>,
    pub easy_languages: Option<Vec<String>>,
    pub passages: Option<f64>,
    pub highlight_blocks: Option<f64>,
    pub insights: Option<f64>,
}

impl MigrateResult {
    /// `{ aiReadPages, translationBlocks, languages, easyBlocks?, ... }`
    pub fn to_value(&self) -> JsonValue {
        let strings = |items: &[String]| {
            JsonValue::Array(items.iter().map(|s| JsonValue::String(s.clone())).collect())
        };
        let mut entries = vec![
            ("aiReadPages", JsonValue::Number(self.ai_read_pages)),
            (
                "translationBlocks",
                JsonValue::Number(self.translation_blocks),
            ),
            ("languages", strings(&self.languages)),
        ];
        if let Some(n) = self.easy_blocks {
            entries.push(("easyBlocks", JsonValue::Number(n)));
        }
        if let Some(languages) = &self.easy_languages {
            entries.push(("easyLanguages", strings(languages)));
        }
        if let Some(n) = self.passages {
            entries.push(("passages", JsonValue::Number(n)));
        }
        if let Some(n) = self.highlight_blocks {
            entries.push(("highlightBlocks", JsonValue::Number(n)));
        }
        if let Some(n) = self.insights {
            entries.push(("insights", JsonValue::Number(n)));
        }
        object(entries)
    }
}

/// `ResultStoreOptions`
#[derive(Default)]
pub struct ResultStoreOptions {
    /// clock for `savedAt` and heartbeats, epoch ms (`Date.now` when left out)
    pub now: Option<Box<dyn FnMut() -> f64>>,
    /// `JOB_RUNNING_WINDOW_MS` when left out
    pub running_window_ms: Option<f64>,
}

// ---- validation ----

/// `seg(value, what)`: a key used as a path segment
fn seg<'a>(value: &'a str, what: &str) -> StoreResult<&'a str> {
    if !is_segment_str(value) {
        return type_error(format!(
            "result store: invalid {what} {}",
            json_quote(value)
        ));
    }
    Ok(value)
}

/// `isValidSeg(value)`
fn is_valid_seg(value: &str) -> bool {
    is_segment_str(value)
}

/// `modeFolder(mode)`: the folder of a mode's results inside the document folder
fn mode_folder(mode: TranslationMode) -> &'static str {
    if mode == TranslationMode::Easy {
        "easy"
    } else {
        "translations"
    }
}

/// `Number.isInteger(n) && n >= 0`
fn valid_occurrence(occurrence: f64) -> bool {
    occurrence.is_finite() && occurrence.trunc() == occurrence && occurrence >= 0.0
}

/// `keyedFile(key)`: `<pageFp>`, `<textHash>.<occurrence>.json`
fn keyed_file(key: &TranslationBlockKey) -> StoreResult<[String; 2]> {
    if !valid_occurrence(key.occurrence) {
        return type_error(format!(
            "result store: invalid block occurrence {}",
            number_to_string(key.occurrence)
        ));
    }
    Ok([
        seg(&key.page_fingerprint, "page fingerprint")?.to_owned(),
        format!(
            "{}.{}.json",
            seg(&key.text_hash, "text hash")?,
            number_to_string(key.occurrence)
        ),
    ])
}

/// `raw.format === FORMAT`
fn has_format(object: &JsObject<JsonValue>) -> bool {
    object.get("format") == Some(&JsonValue::Number(1.0))
}

/// `{ format: FORMAT, ...entry }`
fn with_format(entry: &JsonValue) -> JsObject<JsonValue> {
    let mut out = JsObject::new();
    out.set("format", JsonValue::Number(1.0));
    if let JsonValue::Object(fields) = entry {
        out.assign(fields);
    }
    out
}

fn as_ai_read(raw: Option<&JsonValue>, page_fp: &str) -> Option<AiReadPageEntry> {
    let r = record(raw)?;
    if !has_format(r) || string(r.get("pageFingerprint")) != Some(page_fp) {
        return None;
    }
    let payload = record(r.get("payload"))?;
    num(payload.get("version"))?;
    let saved_at = num(r.get("savedAt"))?;
    if !opt_string(r.get("provider")) || !opt_string(r.get("model")) {
        return None;
    }
    Some(AiReadPageEntry {
        page_fingerprint: page_fp.to_owned(),
        payload: r.get("payload").cloned()?,
        provider: string(r.get("provider")).map(str::to_owned),
        model: string(r.get("model")).map(str::to_owned),
        saved_at,
    })
}

/// the translation's own record, as `asMeta` reads it
struct StoredMeta {
    provider: String,
    model: String,
    saved_at: f64,
}

fn as_meta(raw: Option<&JsonValue>, lang: &str) -> Option<StoredMeta> {
    let r = record(raw)?;
    if !has_format(r) || string(r.get("lang")) != Some(lang) {
        return None;
    }
    Some(StoredMeta {
        provider: string(r.get("provider"))?.to_owned(),
        model: string(r.get("model"))?.to_owned(),
        saved_at: num(r.get("savedAt"))?,
    })
}

/// `blockSentenceEnds(b)`: the sentence ends a block may keep: a translated,
/// unedited block with its text, and a valid pair. Anything else keeps none.
fn block_sentence_ends(
    status: TranslationBlockStatus,
    text: Option<&str>,
    edited: bool,
    source_sentence_ends: Option<&JsonValue>,
    sentence_ends: Option<&JsonValue>,
) -> Option<SentenceEnds> {
    let text = text?;
    if status != TranslationBlockStatus::Translated || edited {
        return None;
    }
    if source_sentence_ends.is_none() && sentence_ends.is_none() {
        return None;
    }
    sentence_ends_pair(
        source_sentence_ends,
        sentence_ends,
        text.encode_utf16().count() as f64,
    )
}

fn as_block(
    raw: Option<&JsonValue>,
    expect: &TranslationBlockKey,
) -> Option<TranslationBlockEntry> {
    let r = record(raw)?;
    if !has_format(r) {
        return None;
    }
    let k = record(r.get("key"))?;
    let saved_at = num(r.get("savedAt"))?;
    if string(k.get("pageFingerprint")) != Some(expect.page_fingerprint.as_str())
        || string(k.get("textHash")) != Some(expect.text_hash.as_str())
        || !matches!(k.get("occurrence"), Some(JsonValue::Number(x)) if *x == expect.occurrence)
    {
        return None;
    }
    let status = match string(r.get("status")) {
        Some("translated") => TranslationBlockStatus::Translated,
        Some("failed") => TranslationBlockStatus::Failed,
        _ => return None,
    };
    if status == TranslationBlockStatus::Translated && string(r.get("text")).is_none() {
        return None;
    }
    if !opt_string(r.get("text")) || !opt_string(r.get("reason")) {
        return None;
    }
    let runs = r.get("runs");
    if runs.is_some_and(|runs| !matches!(runs, JsonValue::Array(_))) {
        return None;
    }
    // an edit is plain text: marks left beside it do not belong to it
    let edited = r.get("edited") == Some(&JsonValue::Bool(true))
        && status == TranslationBlockStatus::Translated;
    let text = string(r.get("text")).map(str::to_owned);
    // invalid sentence ends are dropped; the entry itself stays
    let sentence_ends = block_sentence_ends(
        status,
        text.as_deref(),
        r.get("edited") == Some(&JsonValue::Bool(true)),
        r.get("sourceSentenceEnds"),
        r.get("sentenceEnds"),
    );
    Some(TranslationBlockEntry {
        key: expect.clone(),
        status,
        text,
        runs: if edited { None } else { runs.cloned() },
        reason: string(r.get("reason")).map(str::to_owned),
        edited,
        sentence_ends,
        saved_at,
    })
}

/// `StoredJob`: a job record as it is read
struct StoredJob {
    kind: JobKind,
    lang: Option<String>,
    run_id: Option<String>,
    easy: bool,
    state: JobState,
    last_error: Option<String>,
    resets_at: Option<f64>,
    outputs: Vec<String>,
    progress: Option<JobProgress>,
    updated_at: f64,
}

/// `field === 'x' ? raw.x !== key : raw.x !== undefined` negated: the record's
/// own field holds the key, any other key field is absent
fn key_field_ok(raw: Option<&JsonValue>, is_key_field: bool, key: Option<&str>) -> bool {
    if !is_key_field {
        return raw.is_none();
    }
    match raw {
        None => key.is_none(),
        Some(JsonValue::String(text)) => key == Some(text.as_str()),
        Some(_) => false,
    }
}

fn as_job(
    raw: Option<&JsonValue>,
    kind: JobKind,
    key: Option<&str>,
    mode: TranslationMode,
) -> Option<StoredJob> {
    let r = record(raw)?;
    if !has_format(r) || string(r.get("kind")) != Some(kind.as_str()) {
        return None;
    }
    let field = job_key_field(kind);
    if !key_field_ok(r.get("lang"), field == Some(KeyField::Lang), key)
        || !key_field_ok(r.get("runId"), field == Some(KeyField::RunId), key)
    {
        return None;
    }
    // a plain record has no mode field; an easy one says so
    let easy_ok = if mode == TranslationMode::Easy {
        string(r.get("mode")) == Some("easy")
    } else {
        r.get("mode").is_none()
    };
    if !easy_ok {
        return None;
    }
    let state = match string(r.get("state")) {
        Some("running") => JobState::Running,
        Some("stopped") => JobState::Stopped,
        Some("complete") => JobState::Complete,
        _ => return None,
    };
    let updated_at = num(r.get("updatedAt"))?;
    let outputs = match r.get("outputs") {
        Some(JsonValue::Array(items)) => items
            .iter()
            .map(|item| string(Some(item)).map(str::to_owned))
            .collect::<Option<Vec<String>>>()?,
        _ => return None,
    };
    if !opt_string(r.get("last_error")) {
        return None;
    }
    if r.get("resetsAt").is_some() && num(r.get("resetsAt")).is_none() {
        return None;
    }
    let progress = r.get("progress");
    let progress = match progress {
        None => None,
        Some(p) => {
            let p = record(Some(p))?;
            Some(JobProgress {
                done: num(p.get("done"))?,
                total: num(p.get("total"))?,
            })
        }
    };
    Some(StoredJob {
        kind,
        lang: if field == Some(KeyField::Lang) {
            key.map(str::to_owned)
        } else {
            None
        },
        run_id: if field == Some(KeyField::RunId) {
            key.map(str::to_owned)
        } else {
            None
        },
        easy: mode == TranslationMode::Easy,
        state,
        last_error: string(r.get("last_error")).map(str::to_owned),
        resets_at: num(r.get("resetsAt")),
        outputs,
        progress,
        updated_at,
    })
}

/// a block as `putBlock` writes it: the entry's fields, the sentence ends
/// still as the caller gave them
struct BlockWrite<'a> {
    key: &'a TranslationBlockKey,
    status: TranslationBlockStatus,
    text: Option<&'a str>,
    runs: Option<&'a JsonValue>,
    reason: Option<&'a str>,
    edited: Option<bool>,
    source_sentence_ends: Option<JsonValue>,
    sentence_ends: Option<JsonValue>,
    saved_at: f64,
}

/// `BLOCK_FILE`: `<textHash>.<occurrence>.json`; the key of a block file
fn block_file_key(page_fp: &str, name: &str) -> Option<TranslationBlockKey> {
    let m = js_regex!(r"^([A-Za-z0-9_-]{1,128})\.(\d{1,9})\.json$").exec(name)?;
    Some(TranslationBlockKey {
        page_fingerprint: page_fp.to_owned(),
        text_hash: m.get(1)?.to_owned(),
        occurrence: to_number(m.get(2)?),
    })
}

/// `PASSAGE_FILE`: `<id>.json`; the id of a card or the language of insights
fn id_of_json_name(name: &str) -> Option<String> {
    js_regex!(r"^([A-Za-z0-9_-]{1,128})\.json$")
        .exec(name)
        .and_then(|m| m.get(1).map(str::to_owned))
}

/// what a `JOB_FILE` name says: the kind, the key and whether it is an easy record
fn job_file(name: &str) -> Option<(JobKind, Option<String>, bool)> {
    // ai-read.json | <kind>.<key>.json | <kind>.<lang>.easy.json
    let m = js_regex!(
        r"^(?:ai-read|(translate|translate-page|highlight|summary)\.([A-Za-z0-9_-]{1,128})|(translate|translate-page)\.([A-Za-z0-9_-]{1,128})\.easy)\.json$"
    )
    .exec(name)?;
    let easy = m.get(3).is_some();
    let kind = if easy { m.get(3) } else { m.get(1) };
    let kind = kind.map_or(Some(JobKind::AiRead), JobKind::parse)?;
    let key = if easy { m.get(4) } else { m.get(2) };
    Some((kind, key.map(str::to_owned), easy))
}

// ---- the store ----

/// `ResultStore`. Pass the user-data folder of THIS program. The store lives
/// in one subfolder (`STORE_DIR_NAME`); `delete_all` removes only that
/// subfolder, never the user-data folder around it.
pub struct ResultStore {
    /// absolute path of the store folder
    pub dir: String,
    now: Box<dyn FnMut() -> f64>,
    running_window_ms: f64,
    env: Box<dyn StoreEnv>,
}

impl ResultStore {
    /// `new ResultStore(userDataDir, options)`; `env` is what the file
    /// primitives take from the process
    pub fn new(
        user_data_dir: &str,
        options: ResultStoreOptions,
        env: Box<dyn StoreEnv>,
    ) -> StoreResult<ResultStore> {
        if !is_absolute(user_data_dir) {
            return type_error(format!(
                "result store: the user-data folder must be absolute: {user_data_dir}"
            ));
        }
        if user_data_dir
            .split(['/', '\\'])
            .any(|part| part.to_lowercase() == UPSTREAM_HOME_DIR)
        {
            return type_error(format!(
                "result store: ~/{UPSTREAM_HOME_DIR} belongs to the upstream program"
            ));
        }
        Ok(ResultStore {
            dir: join(&[user_data_dir, STORE_DIR_NAME]),
            now: options.now.unwrap_or_else(|| Box::new(system_now_ms)),
            running_window_ms: options.running_window_ms.unwrap_or(JOB_RUNNING_WINDOW_MS),
            env,
        })
    }

    fn now(&mut self) -> f64 {
        (self.now)()
    }

    // ---- paths ----

    /// `documentDir(docHash)`
    pub fn document_dir(&self, doc_hash: &str) -> StoreResult<String> {
        Ok(join(&[&self.dir, "docs", seg(doc_hash, "document hash")?]))
    }

    /// `aiReadPagePath(docHash, pageFp)`
    pub fn ai_read_page_path(&self, doc_hash: &str, page_fp: &str) -> StoreResult<String> {
        let dir = self.document_dir(doc_hash)?;
        Ok(join(&[
            &dir,
            "ai-read",
            &format!("{}.json", seg(page_fp, "page fingerprint")?),
        ]))
    }

    /// `translationDir(docHash, lang, mode)`: with `Easy`, the easy
    /// explanation's folder `easy/<lang>`, laid out the same way
    pub fn translation_dir(
        &self,
        doc_hash: &str,
        lang: &str,
        mode: TranslationMode,
    ) -> StoreResult<String> {
        let dir = self.document_dir(doc_hash)?;
        Ok(join(&[&dir, mode_folder(mode), seg(lang, "language")?]))
    }

    /// `translationMetaPath(docHash, lang, mode)`
    pub fn translation_meta_path(
        &self,
        doc_hash: &str,
        lang: &str,
        mode: TranslationMode,
    ) -> StoreResult<String> {
        Ok(join(&[
            &self.translation_dir(doc_hash, lang, mode)?,
            "translation.json",
        ]))
    }

    /// `translationBlockPath(docHash, lang, key, mode)`
    pub fn translation_block_path(
        &self,
        doc_hash: &str,
        lang: &str,
        key: &TranslationBlockKey,
        mode: TranslationMode,
    ) -> StoreResult<String> {
        if !valid_occurrence(key.occurrence) {
            return type_error(format!(
                "result store: invalid block occurrence {}",
                number_to_string(key.occurrence)
            ));
        }
        let dir = self.translation_dir(doc_hash, lang, mode)?;
        let page = seg(&key.page_fingerprint, "page fingerprint")?;
        let name = format!(
            "{}.{}.json",
            seg(&key.text_hash, "text hash")?,
            number_to_string(key.occurrence)
        );
        Ok(join(&[&dir, "blocks", page, &name]))
    }

    /// `jobPath(docHash, kind, key, mode)`: `key` is the language, or the run
    /// id of a `highlight` job; none for `ai-read`. `Easy` (translate and
    /// translate-page only) names the record `<kind>.<lang>.easy.json`.
    pub fn job_path(
        &self,
        doc_hash: &str,
        kind: JobKind,
        key: Option<&str>,
        mode: TranslationMode,
    ) -> StoreResult<String> {
        if !job_mode_allowed(kind, mode) {
            return type_error(format!(
                "result store: a {} job has no mode {}",
                kind.as_str(),
                json_quote(mode.as_str())
            ));
        }
        let name = match job_key_field(kind) {
            None => kind.as_str().to_owned(),
            Some(field) => format!(
                "{}.{}",
                kind.as_str(),
                seg(
                    key.unwrap_or(""),
                    if field == KeyField::Lang {
                        "language"
                    } else {
                        "run id"
                    }
                )?
            ),
        };
        let suffix = if mode == TranslationMode::Easy {
            ".easy"
        } else {
            ""
        };
        Ok(join(&[
            &self.document_dir(doc_hash)?,
            "jobs",
            &format!("{name}{suffix}.json"),
        ]))
    }

    /// `passagePath(docHash, id)`
    pub fn passage_path(&self, doc_hash: &str, id: &str) -> StoreResult<String> {
        let dir = self.document_dir(doc_hash)?;
        Ok(join(&[
            &dir,
            "passages",
            &format!("{}.json", seg(id, "card id")?),
        ]))
    }

    /// `highlightRunDir(docHash, runId)`
    pub fn highlight_run_dir(&self, doc_hash: &str, run_id: &str) -> StoreResult<String> {
        let dir = self.document_dir(doc_hash)?;
        Ok(join(&[&dir, "highlights", seg(run_id, "run id")?]))
    }

    /// `highlightBlockPath(docHash, runId, key)`
    pub fn highlight_block_path(
        &self,
        doc_hash: &str,
        run_id: &str,
        key: &TranslationBlockKey,
    ) -> StoreResult<String> {
        let dir = self.highlight_run_dir(doc_hash, run_id)?;
        let [page, name] = keyed_file(key)?;
        Ok(join(&[&dir, "blocks", &page, &name]))
    }

    /// `insightsPath(docHash, lang)`
    pub fn insights_path(&self, doc_hash: &str, lang: &str) -> StoreResult<String> {
        let dir = self.document_dir(doc_hash)?;
        Ok(join(&[
            &dir,
            "insights",
            &format!("{}.json", seg(lang, "language")?),
        ]))
    }

    /// `noteLinksPath()`
    pub fn note_links_path(&self) -> String {
        join(&[&self.dir, NOTE_LINKS_FILE])
    }

    // ---- reading a JSON entry ----

    fn read(&mut self, path: &str) -> Option<JsonValue> {
        read_json(self.env.as_mut(), path)
    }

    fn write(&mut self, path: &str, value: JsObject<JsonValue>) -> StoreResult<()> {
        Ok(write_json_atomic(
            self.env.as_mut(),
            path,
            &JsonValue::Object(value),
        )?)
    }

    fn remove(&mut self, path: &str) -> StoreResult<()> {
        Ok(remove_entry(self.env.as_mut(), path)?)
    }

    fn remove_dir(&mut self, dir: &str) -> StoreResult<()> {
        Ok(remove_folder(self.env.as_mut(), dir)?)
    }
}

// After `is_valid_seg` has passed on every key a path is built from, the path
// builders below cannot fail: such a read treats a failure as an absent entry.
impl ResultStore {
    // ---- AI-read pages ----

    /// `writeAiReadPage(docHash, pageFp, payload, meta)`. The entry is
    /// written as `{ pageFingerprint, payload, ...meta, savedAt }`; `meta`
    /// is `{ provider, model }` here, in that order.
    pub fn write_ai_read_page(
        &mut self,
        doc_hash: &str,
        page_fp: &str,
        payload: &JsonValue,
        meta: &AiReadMeta,
    ) -> StoreResult<()> {
        let numeric_version =
            record(Some(payload)).is_some_and(|p| num(p.get("version")).is_some());
        if !numeric_version {
            return type_error("result store: an AI-read payload needs a numeric version");
        }
        let mut entries = vec![
            ("pageFingerprint", JsonValue::String(page_fp.to_owned())),
            ("payload", payload.clone()),
        ];
        if let Some(provider) = &meta.provider {
            entries.push(("provider", JsonValue::String(provider.clone())));
        }
        if let Some(model) = &meta.model {
            entries.push(("model", JsonValue::String(model.clone())));
        }
        entries.push(("savedAt", JsonValue::Number(self.now())));
        self.put_ai_read(doc_hash, page_fp, &object(entries))
    }

    /// `readAiReadPage(docHash, pageFp)`
    pub fn read_ai_read_page(&mut self, doc_hash: &str, page_fp: &str) -> Option<AiReadPageEntry> {
        if !is_valid_seg(doc_hash) || !is_valid_seg(page_fp) {
            return None;
        }
        let path = self.ai_read_page_path(doc_hash, page_fp).ok()?;
        let raw = self.read(&path);
        as_ai_read(raw.as_ref(), page_fp)
    }

    /// `readAiReadPages(docHash)`: every readable AI-read page of the
    /// document, keyed by page fingerprint
    pub fn read_ai_read_pages(&mut self, doc_hash: &str) -> JsMap<AiReadPageEntry> {
        let mut out = JsMap::new();
        if !is_valid_seg(doc_hash) {
            return out;
        }
        let Ok(doc_dir) = self.document_dir(doc_hash) else {
            return out;
        };
        for name in list_names(&join(&[&doc_dir, "ai-read"]), EntryKind::File) {
            let fp = name.strip_suffix(".json").unwrap_or("");
            if !is_valid_seg(fp) {
                continue;
            }
            if let Some(entry) = self.read_ai_read_page(doc_hash, fp) {
                out.set(fp, entry);
            }
        }
        out
    }

    /// `putAiRead(docHash, entry)`: `{ format: FORMAT, ...entry }`; the entry
    /// keeps the key order it was given
    fn put_ai_read(&mut self, doc_hash: &str, page_fp: &str, entry: &JsonValue) -> StoreResult<()> {
        let path = self.ai_read_page_path(doc_hash, page_fp)?;
        self.write(&path, with_format(entry))
    }

    // ---- translations ----

    /// `writeTranslationMeta(docHash, lang, meta, mode)`: record (or replace)
    /// who translates this document into `lang`
    pub fn write_translation_meta(
        &mut self,
        doc_hash: &str,
        lang: &str,
        meta: &TranslationMetaInput,
        mode: TranslationMode,
    ) -> StoreResult<()> {
        let saved_at = self.now();
        self.put_meta(doc_hash, lang, &meta.provider, &meta.model, saved_at, mode)
    }

    /// `writeTranslationBlock(docHash, lang, block, mode)`
    pub fn write_translation_block(
        &mut self,
        doc_hash: &str,
        lang: &str,
        block: &TranslationBlockInput,
        mode: TranslationMode,
    ) -> StoreResult<()> {
        if block.status == TranslationBlockStatus::Translated && block.text.is_none() {
            return type_error("result store: a translated block needs its text");
        }
        if let Some(edited) = block.edited {
            if !edited || block.status != TranslationBlockStatus::Translated || block.runs.is_some()
            {
                return type_error(
                    "result store: an edited block is translated plain text without runs",
                );
            }
            if block
                .text
                .as_deref()
                .is_none_or(|text| jscompat::trim(text).is_empty())
            {
                return type_error("result store: an edited block needs its text");
            }
        }
        let saved_at = self.now();
        let write = BlockWrite {
            key: &block.key,
            status: block.status,
            text: block.text.as_deref(),
            runs: block.runs.as_ref(),
            reason: block.reason.as_deref(),
            edited: block.edited,
            source_sentence_ends: block.source_sentence_ends.clone(),
            sentence_ends: block.sentence_ends.clone(),
            saved_at,
        };
        self.put_block(doc_hash, lang, &write, mode)
    }

    /// `writeEditedTranslationBlock(docHash, lang, key, text, mode)`: store a
    /// person's edit of a block: plain text that replaces the translation
    pub fn write_edited_translation_block(
        &mut self,
        doc_hash: &str,
        lang: &str,
        key: &TranslationBlockKey,
        text: &str,
        mode: TranslationMode,
    ) -> StoreResult<()> {
        let block = TranslationBlockInput {
            key: key.clone(),
            status: TranslationBlockStatus::Translated,
            text: Some(text.to_owned()),
            runs: None,
            reason: None,
            edited: Some(true),
            source_sentence_ends: None,
            sentence_ends: None,
        };
        self.write_translation_block(doc_hash, lang, &block, mode)
    }

    /// `writeTranslationBlocks(docHash, lang, blocks, mode)`: each block is
    /// its own entry; on failure the earlier ones stay written
    pub fn write_translation_blocks(
        &mut self,
        doc_hash: &str,
        lang: &str,
        blocks: &[TranslationBlockInput],
        mode: TranslationMode,
    ) -> StoreResult<()> {
        for block in blocks {
            self.write_translation_block(doc_hash, lang, block, mode)?;
        }
        Ok(())
    }

    /// `readTranslation(docHash, lang, mode)`: the stored translation into
    /// `lang`, or `None` when there is none
    pub fn read_translation(
        &mut self,
        doc_hash: &str,
        lang: &str,
        mode: TranslationMode,
    ) -> StoreResult<Option<StoredTranslation>> {
        if !is_valid_seg(doc_hash) || !is_valid_seg(lang) {
            return Ok(None);
        }
        if !self
            .list_translations(doc_hash, mode)
            .iter()
            .any(|l| l == lang)
        {
            return Ok(None);
        }
        let meta_path = self.translation_meta_path(doc_hash, lang, mode)?;
        let raw = self.read(&meta_path);
        let meta = as_meta(raw.as_ref(), lang);
        let mut blocks = JsMap::new();
        for b in self.read_blocks(doc_hash, lang, None, mode)? {
            blocks.set(block_key_string(&b.key), b);
        }
        Ok(Some(StoredTranslation {
            lang: lang.to_owned(),
            provider: meta.as_ref().map(|m| m.provider.clone()),
            model: meta.map(|m| m.model),
            blocks,
        }))
    }

    /// `listTranslations(docHash, mode)`: languages this document has a
    /// stored translation for; with `Easy`, the languages of its easy
    /// explanations (never part of the plain list)
    pub fn list_translations(&mut self, doc_hash: &str, mode: TranslationMode) -> Vec<String> {
        if !is_valid_seg(doc_hash) {
            return Vec::new();
        }
        let Ok(doc_dir) = self.document_dir(doc_hash) else {
            return Vec::new();
        };
        list_names(&join(&[&doc_dir, mode_folder(mode)]), EntryKind::Dir)
            .into_iter()
            .filter(|name| is_valid_seg(name))
            .collect()
    }

    /// `deleteTranslation(docHash, lang, mode)`: drop the translation into `lang`
    pub fn delete_translation(
        &mut self,
        doc_hash: &str,
        lang: &str,
        mode: TranslationMode,
    ) -> StoreResult<()> {
        let dir = self.translation_dir(doc_hash, lang, mode)?;
        self.remove_dir(&dir)
    }

    /// `deleteTranslationExceptEdited(docHash, lang, mode)`: every block
    /// entry of the translation into `lang` except the edited ones is
    /// removed (unreadable entries too); the provider record stays. Returns
    /// the number of entries removed.
    pub fn delete_translation_except_edited(
        &mut self,
        doc_hash: &str,
        lang: &str,
        mode: TranslationMode,
    ) -> StoreResult<f64> {
        let dir = self.translation_dir(doc_hash, lang, mode)?;
        let root = join(&[&dir, "blocks"]);
        let mut removed = 0.0;
        for fp in list_names(&root, EntryKind::Dir) {
            if !is_valid_seg(&fp) {
                continue;
            }
            let fp_dir = join(&[&root, &fp]);
            for name in list_names(&fp_dir, EntryKind::File) {
                let Some(key) = block_file_key(&fp, &name) else {
                    continue;
                };
                let path = join(&[&fp_dir, &name]);
                // an edit written meanwhile is read before the removal, never after it
                let raw = self.read(&path);
                if as_block(raw.as_ref(), &key).is_some_and(|b| b.edited) {
                    continue;
                }
                self.remove(&path)?;
                removed += 1.0;
            }
        }
        Ok(removed)
    }

    /// `countEditedTranslationBlocks(docHash, lang, mode)`: blocks a person
    /// edited, in one language or in all of them
    pub fn count_edited_translation_blocks(
        &mut self,
        doc_hash: &str,
        lang: Option<&str>,
        mode: TranslationMode,
    ) -> StoreResult<f64> {
        if !is_valid_seg(doc_hash) {
            return Ok(0.0);
        }
        let langs = match lang {
            None => self.list_translations(doc_hash, mode),
            Some(l) => vec![l.to_owned()],
        };
        let mut count = 0.0;
        for l in langs {
            if !is_valid_seg(&l) {
                continue;
            }
            count += self
                .read_blocks(doc_hash, &l, None, mode)?
                .iter()
                .filter(|b| b.edited)
                .count() as f64;
        }
        Ok(count)
    }

    /// `putMeta(docHash, lang, meta, mode)`
    fn put_meta(
        &mut self,
        doc_hash: &str,
        lang: &str,
        provider: &str,
        model: &str,
        saved_at: f64,
        mode: TranslationMode,
    ) -> StoreResult<()> {
        let path = self.translation_meta_path(doc_hash, lang, mode)?;
        let mut entry = JsObject::new();
        entry.set("format", JsonValue::Number(1.0));
        entry.set("lang", JsonValue::String(lang.to_owned()));
        entry.set("provider", JsonValue::String(provider.to_owned()));
        entry.set("model", JsonValue::String(model.to_owned()));
        entry.set("savedAt", JsonValue::Number(saved_at));
        self.write(&path, entry)
    }

    /// `putBlock(docHash, lang, b, mode)`
    fn put_block(
        &mut self,
        doc_hash: &str,
        lang: &str,
        b: &BlockWrite<'_>,
        mode: TranslationMode,
    ) -> StoreResult<()> {
        let path = self.translation_block_path(doc_hash, lang, b.key, mode)?;
        let edited = b.edited == Some(true);
        let mut entry = JsObject::new();
        entry.set("format", JsonValue::Number(1.0));
        entry.set("key", key_value(b.key));
        entry.set("status", JsonValue::String(b.status.as_str().to_owned()));
        entry.set("savedAt", JsonValue::Number(b.saved_at));
        if let Some(text) = b.text {
            entry.set("text", JsonValue::String(text.to_owned()));
        }
        if let Some(runs) = b.runs.filter(|_| !edited) {
            entry.set("runs", runs.clone());
        }
        if let Some(reason) = b.reason {
            entry.set("reason", JsonValue::String(reason.to_owned()));
        }
        if edited {
            entry.set("edited", JsonValue::Bool(true));
        }
        // written only as a valid pair on a translated, unedited block; else dropped
        if let Some(ends) = block_sentence_ends(
            b.status,
            b.text,
            edited,
            b.source_sentence_ends.as_ref(),
            b.sentence_ends.as_ref(),
        ) {
            entry.set(
                "sourceSentenceEnds",
                numbers_value(&ends.source_sentence_ends),
            );
            entry.set("sentenceEnds", numbers_value(&ends.sentence_ends));
        }
        self.write(&path, entry)
    }

    /// `readBlocks(docHash, lang, onlyPages, mode)`
    fn read_blocks(
        &mut self,
        doc_hash: &str,
        lang: &str,
        only_pages: Option<&HashSet<String>>,
        mode: TranslationMode,
    ) -> StoreResult<Vec<TranslationBlockEntry>> {
        let mut out = Vec::new();
        let dir = self.translation_dir(doc_hash, lang, mode)?;
        let root = join(&[&dir, "blocks"]);
        for fp in list_names(&root, EntryKind::Dir) {
            if !is_valid_seg(&fp) || only_pages.is_some_and(|pages| !pages.contains(&fp)) {
                continue;
            }
            let fp_dir = join(&[&root, &fp]);
            for name in list_names(&fp_dir, EntryKind::File) {
                let Some(key) = block_file_key(&fp, &name) else {
                    continue;
                };
                let raw = self.read(&join(&[&fp_dir, &name]));
                if let Some(entry) = as_block(raw.as_ref(), &key) {
                    out.push(entry);
                }
            }
        }
        Ok(out)
    }

    // ---- job records ----

    /// `writeJob(docHash, job)`: write the job's record; every write is also
    /// its heartbeat
    pub fn write_job(&mut self, doc_hash: &str, job: &JobRecordInput) -> StoreResult<()> {
        let field = job_key_field(job.kind);
        if field == Some(KeyField::Lang) && !job.lang.as_deref().is_some_and(is_valid_seg) {
            return type_error(format!(
                "result store: a {} job needs a valid language",
                job.kind.as_str()
            ));
        }
        if field == Some(KeyField::RunId) && !job.run_id.as_deref().is_some_and(is_valid_seg) {
            return type_error(format!(
                "result store: a {} job needs a valid run id",
                job.kind.as_str()
            ));
        }
        let mode = job.mode.unwrap_or(TranslationMode::Translate);
        if !job_mode_allowed(job.kind, mode) {
            return type_error(format!(
                "result store: a {} job has no mode {}",
                job.kind.as_str(),
                json_quote(mode.as_str())
            ));
        }
        if job.state == JobState::Idle {
            return type_error(format!(
                "result store: invalid job state {}",
                job.state.as_str()
            ));
        }
        let key = match field {
            None => None,
            Some(KeyField::Lang) => job.lang.as_deref(),
            Some(KeyField::RunId) => job.run_id.as_deref(),
        };
        let mut record = JsObject::new();
        record.set("format", JsonValue::Number(1.0));
        record.set("kind", JsonValue::String(job.kind.as_str().to_owned()));
        record.set("state", JsonValue::String(job.state.as_str().to_owned()));
        record.set(
            "outputs",
            JsonValue::Array(
                job.outputs
                    .iter()
                    .flatten()
                    .map(|o| JsonValue::String(o.clone()))
                    .collect(),
            ),
        );
        record.set("updatedAt", JsonValue::Number(self.now()));
        if let (Some(field), Some(key)) = (field, key) {
            record.set(field.as_str(), JsonValue::String(key.to_owned()));
        }
        // a plain record keeps its earlier shape: no mode field
        if mode == TranslationMode::Easy {
            record.set("mode", JsonValue::String("easy".to_owned()));
        }
        if let Some(last_error) = &job.last_error {
            record.set("last_error", JsonValue::String(last_error.clone()));
        }
        if let Some(resets_at) = job.resets_at {
            record.set("resetsAt", JsonValue::Number(resets_at));
        }
        if let Some(progress) = job.progress {
            record.set("progress", progress.to_value());
        }
        let path = self.job_path(doc_hash, job.kind, key, mode)?;
        self.write(&path, record)
    }

    /// `heartbeatJob(docHash, kind, key, mode)`: refresh a running job's
    /// heartbeat. `false` (and nothing written) when the record is missing,
    /// unreadable or not running.
    pub fn heartbeat_job(
        &mut self,
        doc_hash: &str,
        kind: JobKind,
        key: Option<&str>,
        mode: TranslationMode,
    ) -> StoreResult<bool> {
        let Some(stored) = self.read_stored_job(doc_hash, kind, key, mode) else {
            return Ok(false);
        };
        if stored.state != JobState::Running {
            return Ok(false);
        }
        let rest = JobRecordInput {
            kind: stored.kind,
            lang: stored.lang,
            run_id: stored.run_id,
            mode: stored.easy.then_some(TranslationMode::Easy),
            state: stored.state,
            last_error: stored.last_error,
            resets_at: stored.resets_at,
            outputs: Some(stored.outputs),
            progress: stored.progress,
        };
        self.write_job(doc_hash, &rest)?;
        Ok(true)
    }

    /// `readJob(docHash, kind, key, mode)`: `key` is the language, or the run
    /// id of a `highlight` job; none for `ai-read`
    pub fn read_job(
        &mut self,
        doc_hash: &str,
        kind: JobKind,
        key: Option<&str>,
        mode: TranslationMode,
    ) -> JobStatus {
        if let Some(stored) = self.read_stored_job(doc_hash, kind, key, mode) {
            return self.resolve_job(stored);
        }
        let field = job_key_field(kind);
        let key = key.map(str::to_owned);
        JobStatus {
            kind,
            lang: key.clone().filter(|_| field == Some(KeyField::Lang)),
            run_id: key.filter(|_| field == Some(KeyField::RunId)),
            mode_easy: mode == TranslationMode::Easy && job_mode_allowed(kind, mode),
            state: JobState::Idle,
            last_error: None,
            resets_at: None,
            outputs: Vec::new(),
            progress: None,
            updated_at: None,
        }
    }

    /// `listJobs(docHash)`: every readable job record of the document, easy
    /// explanations' included
    pub fn list_jobs(&mut self, doc_hash: &str) -> Vec<JobStatus> {
        let mut out = Vec::new();
        if !is_valid_seg(doc_hash) {
            return out;
        }
        let Ok(doc_dir) = self.document_dir(doc_hash) else {
            return out;
        };
        for name in list_names(&join(&[&doc_dir, "jobs"]), EntryKind::File) {
            let Some((kind, key, easy)) = job_file(&name) else {
                continue;
            };
            let mode = if easy {
                TranslationMode::Easy
            } else {
                TranslationMode::Translate
            };
            if let Some(stored) = self.read_stored_job(doc_hash, kind, key.as_deref(), mode) {
                out.push(self.resolve_job(stored));
            }
        }
        out
    }

    /// `unfinishedJobs(docHash)`: jobs not complete (running elsewhere, or
    /// stopped); the source of the resume offer
    pub fn unfinished_jobs(&mut self, doc_hash: &str) -> Vec<JobStatus> {
        self.list_jobs(doc_hash)
            .into_iter()
            .filter(|j| j.state != JobState::Complete)
            .collect()
    }

    /// `readStoredJob(docHash, kind, key, mode)`
    fn read_stored_job(
        &mut self,
        doc_hash: &str,
        kind: JobKind,
        key: Option<&str>,
        mode: TranslationMode,
    ) -> Option<StoredJob> {
        if !is_valid_seg(doc_hash) || !job_mode_allowed(kind, mode) {
            return None;
        }
        let field = job_key_field(kind);
        if field.is_some() && !key.is_some_and(is_valid_seg) {
            return None;
        }
        let effective_key = key.filter(|_| field.is_some());
        let path = self.job_path(doc_hash, kind, effective_key, mode).ok()?;
        let raw = self.read(&path);
        as_job(raw.as_ref(), kind, effective_key, mode)
    }

    /// `resolveJob(stored)`: a running record gone stale is a job whose
    /// process ended without saying so: stopped, last_error `interrupted`
    fn resolve_job(&mut self, stored: StoredJob) -> JobStatus {
        let mut status = JobStatus {
            kind: stored.kind,
            lang: stored.lang,
            run_id: stored.run_id,
            mode_easy: stored.easy,
            state: stored.state,
            last_error: stored.last_error,
            resets_at: stored.resets_at,
            outputs: stored.outputs,
            progress: stored.progress,
            updated_at: Some(stored.updated_at),
        };
        if stored.state == JobState::Running
            && self.now() - stored.updated_at > self.running_window_ms
        {
            status.state = JobState::Stopped;
            if status.last_error.is_none() {
                status.last_error = Some("interrupted".to_owned());
            }
        }
        status
    }

    // ---- passage cards ----

    /// `writePassage(docHash, card)`: write (or replace) a card; `savedAt` is
    /// the time of this write
    pub fn write_passage(&mut self, doc_hash: &str, card: &PassageCardInput) -> StoreResult<()> {
        let saved_at = self.now();
        let Some(entry) = as_passage_card(Some(&card.with_saved_at(saved_at))) else {
            return type_error("result store: invalid passage card");
        };
        self.put_passage(doc_hash, &entry)
    }

    /// `readPassage(docHash, id)`
    pub fn read_passage(&mut self, doc_hash: &str, id: &str) -> Option<PassageCard> {
        if !is_valid_seg(doc_hash) || !is_valid_seg(id) {
            return None;
        }
        let path = self.passage_path(doc_hash, id).ok()?;
        let raw = self.read(&path);
        if !record(raw.as_ref()).is_some_and(has_format) {
            return None;
        }
        as_passage_card(raw.as_ref()).filter(|card| card.id == id)
    }

    /// `readPassages(docHash)`: every readable card of the document
    pub fn read_passages(&mut self, doc_hash: &str) -> Vec<PassageCard> {
        let mut out = Vec::new();
        if !is_valid_seg(doc_hash) {
            return out;
        }
        let Ok(doc_dir) = self.document_dir(doc_hash) else {
            return out;
        };
        for name in list_names(&join(&[&doc_dir, "passages"]), EntryKind::File) {
            let Some(id) = id_of_json_name(&name) else {
                continue;
            };
            if let Some(card) = self.read_passage(doc_hash, &id) {
                out.push(card);
            }
        }
        out
    }

    /// `deletePassage(docHash, id)`
    pub fn delete_passage(&mut self, doc_hash: &str, id: &str) -> StoreResult<()> {
        let path = self.passage_path(doc_hash, id)?;
        self.remove(&path)
    }

    /// `countPassages(docHash)`: readable cards of the document
    pub fn count_passages(&mut self, doc_hash: &str) -> f64 {
        self.read_passages(doc_hash).len() as f64
    }

    /// `putPassage(docHash, card)`
    fn put_passage(&mut self, doc_hash: &str, card: &PassageCard) -> StoreResult<()> {
        let path = self.passage_path(doc_hash, &card.id)?;
        self.write(&path, with_format(&card.to_value()))
    }

    // ---- AI highlights ----

    /// `writeHighlightRun(docHash, run)`: write (or replace) a run's record
    pub fn write_highlight_run(&mut self, doc_hash: &str, run: &HighlightRun) -> StoreResult<()> {
        let Some(entry) = as_highlight_run(Some(&run.to_value())) else {
            return type_error("result store: invalid highlight run");
        };
        let saved_at = self.now();
        self.put_run(doc_hash, &entry, saved_at)
    }

    /// `readHighlightRun(docHash, runId)`
    pub fn read_highlight_run(&mut self, doc_hash: &str, run_id: &str) -> Option<HighlightRun> {
        self.read_stored_run(doc_hash, run_id)
            .map(|stored| stored.0)
    }

    /// `listHighlightRuns(docHash)`: every readable run of the document
    pub fn list_highlight_runs(&mut self, doc_hash: &str) -> Vec<HighlightRun> {
        let mut out = Vec::new();
        for run_id in self.list_highlight_run_ids(doc_hash) {
            if let Some(run) = self.read_highlight_run(doc_hash, &run_id) {
                out.push(run);
            }
        }
        out
    }

    /// `writeHighlightBlock(docHash, runId, block)`
    pub fn write_highlight_block(
        &mut self,
        doc_hash: &str,
        run_id: &str,
        block: &HighlightBlockInput,
    ) -> StoreResult<()> {
        let saved_at = self.now();
        let Some(entry) = as_highlight_block(Some(&block.with_saved_at(saved_at)), &block.key)
        else {
            return type_error("result store: invalid highlight block");
        };
        self.highlight_block_path(doc_hash, run_id, &block.key)?;
        self.put_highlight_block(doc_hash, run_id, &entry)
    }

    /// `writeHighlightBlocks(docHash, runId, blocks)`: each block is its own
    /// entry; on failure the earlier ones stay written
    pub fn write_highlight_blocks(
        &mut self,
        doc_hash: &str,
        run_id: &str,
        blocks: &[HighlightBlockInput],
    ) -> StoreResult<()> {
        for block in blocks {
            self.write_highlight_block(doc_hash, run_id, block)?;
        }
        Ok(())
    }

    /// `readHighlightBlock(docHash, runId, key)`
    pub fn read_highlight_block(
        &mut self,
        doc_hash: &str,
        run_id: &str,
        key: &TranslationBlockKey,
    ) -> Option<HighlightBlockEntry> {
        if !is_valid_seg(doc_hash) || !is_valid_seg(run_id) {
            return None;
        }
        if !is_valid_seg(&key.page_fingerprint) || !is_valid_seg(&key.text_hash) {
            return None;
        }
        if !valid_occurrence(key.occurrence) {
            return None;
        }
        let path = self.highlight_block_path(doc_hash, run_id, key).ok()?;
        let raw = self.read(&path);
        if record(raw.as_ref()).is_some_and(has_format) {
            as_highlight_block(raw.as_ref(), key)
        } else {
            None
        }
    }

    /// `readHighlightBlocks(docHash, runId)`: every readable block of the
    /// run, keyed by `blockKeyString(key)`
    pub fn read_highlight_blocks(
        &mut self,
        doc_hash: &str,
        run_id: &str,
    ) -> JsMap<HighlightBlockEntry> {
        let mut out = JsMap::new();
        for b in self.read_highlight_block_list(doc_hash, run_id, None) {
            out.set(block_key_string(&b.key), b);
        }
        out
    }

    /// `setHighlightSuggestionStates(docHash, runId, key, states)`: change
    /// the state of suggestions of one block (accepted after a save, dismissed
    /// at once). Unknown ids are ignored. `false` when the block is missing
    /// or unreadable.
    pub fn set_highlight_suggestion_states(
        &mut self,
        doc_hash: &str,
        run_id: &str,
        key: &TranslationBlockKey,
        states: &JsObject<HighlightSuggestionState>,
    ) -> StoreResult<bool> {
        // also checks the key: an invalid one has no entry path
        if self.read_highlight_block(doc_hash, run_id, key).is_none() {
            return Ok(false);
        }
        let Some(current) = self.read_highlight_block(doc_hash, run_id, key) else {
            return Ok(false);
        };
        let suggestions: Vec<HighlightSuggestion> = current
            .suggestions
            .iter()
            .map(|s| match states.get(&s.id) {
                Some(state) => HighlightSuggestion {
                    state: *state,
                    ..s.clone()
                },
                None => s.clone(),
            })
            .collect();
        let input = HighlightBlockInput {
            key: key.clone(),
            status: current.status,
            suggestions,
        };
        let saved_at = self.now();
        let Some(entry) = as_highlight_block(Some(&input.with_saved_at(saved_at)), key) else {
            return type_error("result store: invalid highlight block");
        };
        self.put_highlight_block(doc_hash, run_id, &entry)?;
        Ok(true)
    }

    /// `deleteHighlightRun(docHash, runId)`: remove a run: its folder and its
    /// job record `highlight.<runId>.json`
    pub fn delete_highlight_run(&mut self, doc_hash: &str, run_id: &str) -> StoreResult<()> {
        let dir = self.highlight_run_dir(doc_hash, run_id)?;
        self.remove_dir(&dir)?;
        let job = self.job_path(
            doc_hash,
            JobKind::Highlight,
            Some(run_id),
            TranslationMode::Translate,
        )?;
        self.remove(&job)
    }

    /// `listHighlightRunIds(docHash)`
    fn list_highlight_run_ids(&mut self, doc_hash: &str) -> Vec<String> {
        if !is_valid_seg(doc_hash) {
            return Vec::new();
        }
        let Ok(doc_dir) = self.document_dir(doc_hash) else {
            return Vec::new();
        };
        list_names(&join(&[&doc_dir, "highlights"]), EntryKind::Dir)
            .into_iter()
            .filter(|name| is_valid_seg(name))
            .collect()
    }

    /// `readStoredRun(docHash, runId)`: the run and its `savedAt`
    fn read_stored_run(&mut self, doc_hash: &str, run_id: &str) -> Option<(HighlightRun, f64)> {
        if !is_valid_seg(doc_hash) || !is_valid_seg(run_id) {
            return None;
        }
        let dir = self.highlight_run_dir(doc_hash, run_id).ok()?;
        let raw = self.read(&join(&[&dir, RUN_FILE]));
        let r = record(raw.as_ref())?;
        if !has_format(r) {
            return None;
        }
        let saved_at = num(r.get("savedAt"))?;
        as_highlight_run(raw.as_ref())
            .filter(|run| run.run_id == run_id)
            .map(|run| (run, saved_at))
    }

    /// `putRun(docHash, run, savedAt)`: `{ format, ...run, savedAt }`
    fn put_run(&mut self, doc_hash: &str, run: &HighlightRun, saved_at: f64) -> StoreResult<()> {
        let dir = self.highlight_run_dir(doc_hash, &run.run_id)?;
        let mut entry = with_format(&run.to_value());
        entry.set("savedAt", JsonValue::Number(saved_at));
        self.write(&join(&[&dir, RUN_FILE]), entry)
    }

    /// `putHighlightBlock(docHash, runId, b)`
    fn put_highlight_block(
        &mut self,
        doc_hash: &str,
        run_id: &str,
        b: &HighlightBlockEntry,
    ) -> StoreResult<()> {
        let path = self.highlight_block_path(doc_hash, run_id, &b.key)?;
        self.write(&path, with_format(&b.to_value()))
    }

    /// `readHighlightBlockList(docHash, runId, onlyPages)`
    fn read_highlight_block_list(
        &mut self,
        doc_hash: &str,
        run_id: &str,
        only_pages: Option<&HashSet<String>>,
    ) -> Vec<HighlightBlockEntry> {
        let mut out = Vec::new();
        if !is_valid_seg(doc_hash) || !is_valid_seg(run_id) {
            return out;
        }
        let Ok(run_dir) = self.highlight_run_dir(doc_hash, run_id) else {
            return out;
        };
        let root = join(&[&run_dir, "blocks"]);
        for fp in list_names(&root, EntryKind::Dir) {
            if !is_valid_seg(&fp) || only_pages.is_some_and(|pages| !pages.contains(&fp)) {
                continue;
            }
            let fp_dir = join(&[&root, &fp]);
            for name in list_names(&fp_dir, EntryKind::File) {
                let Some(key) = block_file_key(&fp, &name) else {
                    continue;
                };
                let raw = self.read(&join(&[&fp_dir, &name]));
                let entry = if record(raw.as_ref()).is_some_and(has_format) {
                    as_highlight_block(raw.as_ref(), &key)
                } else {
                    None
                };
                if let Some(entry) = entry {
                    out.push(entry);
                }
            }
        }
        out
    }

    // ---- insights ----

    /// `writeInsights(docHash, entry)`: write (or replace) the overview in its language
    pub fn write_insights(&mut self, doc_hash: &str, entry: &InsightsEntry) -> StoreResult<()> {
        let Some(checked) = as_insights(Some(&entry.to_value())) else {
            return type_error("result store: invalid insights entry");
        };
        let saved_at = self.now();
        self.put_insights(doc_hash, &checked, saved_at)
    }

    /// `readInsights(docHash, lang)`
    pub fn read_insights(&mut self, doc_hash: &str, lang: &str) -> Option<InsightsEntry> {
        self.read_stored_insights(doc_hash, lang)
            .map(|stored| stored.0)
    }

    /// `listInsights(docHash)`: languages this document has insights in
    pub fn list_insights(&mut self, doc_hash: &str) -> Vec<String> {
        if !is_valid_seg(doc_hash) {
            return Vec::new();
        }
        let Ok(doc_dir) = self.document_dir(doc_hash) else {
            return Vec::new();
        };
        list_names(&join(&[&doc_dir, "insights"]), EntryKind::File)
            .iter()
            .filter_map(|name| id_of_json_name(name))
            .collect()
    }

    /// `deleteInsights(docHash, lang)`
    pub fn delete_insights(&mut self, doc_hash: &str, lang: &str) -> StoreResult<()> {
        let path = self.insights_path(doc_hash, lang)?;
        self.remove(&path)
    }

    /// `readStoredInsights(docHash, lang)`: the entry and its `savedAt`
    fn read_stored_insights(&mut self, doc_hash: &str, lang: &str) -> Option<(InsightsEntry, f64)> {
        if !is_valid_seg(doc_hash) || !is_valid_seg(lang) {
            return None;
        }
        let path = self.insights_path(doc_hash, lang).ok()?;
        let raw = self.read(&path);
        let r = record(raw.as_ref())?;
        if !has_format(r) {
            return None;
        }
        let saved_at = num(r.get("savedAt"))?;
        as_insights(raw.as_ref())
            .filter(|entry| entry.lang == lang)
            .map(|entry| (entry, saved_at))
    }

    /// `putInsights(docHash, entry, savedAt)`: `{ format, ...entry, savedAt }`
    fn put_insights(
        &mut self,
        doc_hash: &str,
        entry: &InsightsEntry,
        saved_at: f64,
    ) -> StoreResult<()> {
        let path = self.insights_path(doc_hash, &entry.lang)?;
        let mut out = with_format(&entry.to_value());
        out.set("savedAt", JsonValue::Number(saved_at));
        self.write(&path, out)
    }

    // ---- note links ----

    /// `readNoteLinks()`: every readable link; none when the file is missing
    /// or unreadable
    pub fn read_note_links(&mut self) -> NoteLinks {
        let path = self.note_links_path();
        let raw = self.read(&path);
        as_note_links(raw.as_ref())
    }

    /// `findNoteLink(pdfPath, docHash)`: the note of a PDF: the link of its
    /// path, else the most recent link of the same document hash. A link
    /// whose note file is gone counts as absent.
    pub fn find_note_link(&mut self, pdf_path: &str, doc_hash: &str) -> Option<FoundNoteLink> {
        let links = self.read_note_links().links;
        let platform = self.env.platform();
        let pdf_key = note_link_key(pdf_path, platform);
        if let Some(by_path) = links.get(&pdf_key)
            && file_exists(&by_path.note_path)
        {
            return Some(FoundNoteLink {
                link: by_path.clone(),
                pdf_key,
                matched_by: MatchedBy::Path,
            });
        }
        if !is_valid_seg(doc_hash) {
            return None;
        }
        let mut same_doc: Vec<(String, NoteLink)> = links
            .entries()
            .into_iter()
            .filter(|(key, link)| *key != pdf_key && link.doc_hash == doc_hash)
            .map(|(key, link)| (key.to_owned(), link.clone()))
            .collect();
        sort_by_number(&mut same_doc, |a, b| b.1.updated_at - a.1.updated_at);
        for (key, link) in same_doc {
            if file_exists(&link.note_path) {
                return Some(FoundNoteLink {
                    link,
                    pdf_key: key,
                    matched_by: MatchedBy::DocHash,
                });
            }
        }
        None
    }

    /// `setNoteLink(pdfPath, link)`: link a PDF to the note the person chose
    /// in a save dialog (`link` is `{ notePath, docHash }`)
    pub fn set_note_link(
        &mut self,
        pdf_path: &str,
        note_path: &str,
        doc_hash: &str,
    ) -> StoreResult<()> {
        if !is_absolute(note_path) {
            return type_error("result store: a note path must be absolute");
        }
        seg(doc_hash, "document hash")?;
        let platform = self.env.platform();
        let pdf_key = note_link_key(pdf_path, platform);
        self.change_note_links(|links, now| {
            links.set(
                pdf_key,
                NoteLink {
                    note_path: note_path.to_owned(),
                    doc_hash: doc_hash.to_owned(),
                    updated_at: now(),
                },
            );
            true
        })?;
        Ok(())
    }

    /// `updateNoteLinkDocHash(pdfPath, docHash)`: after a save changed the
    /// PDF's hash; `false` when the path has no link
    pub fn update_note_link_doc_hash(
        &mut self,
        pdf_path: &str,
        doc_hash: &str,
    ) -> StoreResult<bool> {
        seg(doc_hash, "document hash")?;
        let platform = self.env.platform();
        let pdf_key = note_link_key(pdf_path, platform);
        self.change_note_links(|links, now| {
            let Some(link) = links.get(&pdf_key) else {
                return false;
            };
            let changed = NoteLink {
                note_path: link.note_path.clone(),
                doc_hash: doc_hash.to_owned(),
                updated_at: now(),
            };
            links.set(pdf_key, changed);
            true
        })
    }

    /// `changeNoteLinks(change)`: read, change and write the links; `change`
    /// gets the links and the clock and says whether to write
    fn change_note_links(
        &mut self,
        change: impl FnOnce(&mut JsObject<NoteLink>, &mut dyn FnMut() -> f64) -> bool,
    ) -> StoreResult<bool> {
        let path = self.note_links_path();
        let mut current = self.read_note_links();
        if !change(&mut current.links, &mut *self.now) {
            return Ok(false);
        }
        write_json_atomic(self.env.as_mut(), &path, &current.to_value())?;
        Ok(true)
    }

    // ---- migration on in-app save ----

    /// `migrateDocument(input)`: after an in-app save changed the file hash,
    /// copy the AI-read pages and translation blocks whose page fingerprint
    /// the saved document still has. Matching is by fingerprint, so reordered
    /// pages carry over too; with `keep_block_keys`, a translation block must
    /// also be listed there. Easy explanations move by the same rules into
    /// `easy/`. An entry already in the new document is replaced only by a
    /// newer one. Old entries stay; job records are not copied.
    pub fn migrate_document(&mut self, input: &MigrateInput) -> StoreResult<MigrateResult> {
        let mut result = MigrateResult {
            ai_read_pages: 0.0,
            translation_blocks: 0.0,
            languages: Vec::new(),
            easy_blocks: None,
            easy_languages: None,
            passages: None,
            highlight_blocks: None,
            insights: None,
        };
        let old_doc_hash = input.old_doc_hash.as_str();
        let new_doc_hash = input.new_doc_hash.as_str();
        seg(new_doc_hash, "document hash")?;
        if !is_valid_seg(old_doc_hash) || old_doc_hash == new_doc_hash {
            return Ok(result);
        }
        let pages: HashSet<String> = input
            .page_fingerprints
            .iter()
            .filter(|fp| is_valid_seg(fp))
            .cloned()
            .collect();
        let keep: Option<HashSet<String>> = input
            .keep_block_keys
            .as_ref()
            .map(|keys| keys.iter().map(block_key_string).collect());

        let old_pages = self.read_ai_read_pages(old_doc_hash);
        for (fp, entry) in old_pages.iter() {
            if !pages.contains(fp) {
                continue;
            }
            if let Some(current) = self.read_ai_read_page(new_doc_hash, fp)
                && current.saved_at >= entry.saved_at
            {
                continue;
            }
            self.put_ai_read(new_doc_hash, &entry.page_fingerprint, &entry.to_value())?;
            result.ai_read_pages += 1.0;
        }

        let (blocks, languages) = self.migrate_translations(
            old_doc_hash,
            new_doc_hash,
            &pages,
            keep.as_ref(),
            TranslationMode::Translate,
        )?;
        result.translation_blocks = blocks;
        result.languages = languages;
        let (blocks, languages) = self.migrate_translations(
            old_doc_hash,
            new_doc_hash,
            &pages,
            keep.as_ref(),
            TranslationMode::Easy,
        )?;
        if blocks > 0.0 {
            result.easy_blocks = Some(blocks);
        }
        if !languages.is_empty() {
            result.easy_languages = Some(languages);
        }

        let (passages, highlight_blocks, insights) =
            self.migrate_reading(old_doc_hash, new_doc_hash, &pages)?;
        if passages > 0.0 {
            result.passages = Some(passages);
        }
        if highlight_blocks > 0.0 {
            result.highlight_blocks = Some(highlight_blocks);
        }
        if insights > 0.0 {
            result.insights = Some(insights);
        }
        Ok(result)
    }

    /// `migrateTranslations(...)`: the translations of one mode in
    /// `migrateDocument`: the provider record and the blocks of surviving
    /// pages (and, with `keep`, of kept keys). Returns the blocks moved and
    /// the languages that received anything.
    fn migrate_translations(
        &mut self,
        old_doc_hash: &str,
        new_doc_hash: &str,
        pages: &HashSet<String>,
        keep: Option<&HashSet<String>>,
        mode: TranslationMode,
    ) -> StoreResult<(f64, Vec<String>)> {
        let mut blocks_moved = 0.0;
        let mut languages = Vec::new();
        for lang in self.list_translations(old_doc_hash, mode) {
            let mut touched = false;
            let old_meta_path = self.translation_meta_path(old_doc_hash, &lang, mode)?;
            let old_meta = self.read(&old_meta_path);
            if let Some(meta) = as_meta(old_meta.as_ref(), &lang) {
                let new_meta_path = self.translation_meta_path(new_doc_hash, &lang, mode)?;
                let new_meta = self.read(&new_meta_path);
                let current = as_meta(new_meta.as_ref(), &lang);
                if current.is_none_or(|c| c.saved_at < meta.saved_at) {
                    self.put_meta(
                        new_doc_hash,
                        &lang,
                        &meta.provider,
                        &meta.model,
                        meta.saved_at,
                        mode,
                    )?;
                    touched = true;
                }
            }
            for block in self.read_blocks(old_doc_hash, &lang, Some(pages), mode)? {
                if keep.is_some_and(|keep| !keep.contains(&block_key_string(&block.key))) {
                    continue;
                }
                let path = self.translation_block_path(new_doc_hash, &lang, &block.key, mode)?;
                let raw = self.read(&path);
                if let Some(current) = as_block(raw.as_ref(), &block.key)
                    && current.saved_at >= block.saved_at
                {
                    continue;
                }
                let write = BlockWrite {
                    key: &block.key,
                    status: block.status,
                    text: block.text.as_deref(),
                    runs: block.runs.as_ref(),
                    reason: block.reason.as_deref(),
                    edited: block.edited.then_some(true),
                    source_sentence_ends: block
                        .sentence_ends
                        .as_ref()
                        .map(|e| numbers_value(&e.source_sentence_ends)),
                    sentence_ends: block
                        .sentence_ends
                        .as_ref()
                        .map(|e| numbers_value(&e.sentence_ends)),
                    saved_at: block.saved_at,
                };
                self.put_block(new_doc_hash, &lang, &write, mode)?;
                blocks_moved += 1.0;
                touched = true;
            }
            if touched {
                languages.push(lang);
            }
        }
        Ok((blocks_moved, languages))
    }

    /// `migrateReading(...)`: the reading entries of `migrateDocument`: cards
    /// of surviving pages, every highlight run with the blocks of surviving
    /// pages, and insights whose pages all survive. The newer entry wins.
    /// Returns the passages, highlight blocks and insights moved.
    fn migrate_reading(
        &mut self,
        old_doc_hash: &str,
        new_doc_hash: &str,
        pages: &HashSet<String>,
    ) -> StoreResult<(f64, f64, f64)> {
        let mut passages = 0.0;
        let mut highlight_blocks = 0.0;
        let mut insights = 0.0;

        for card in self.read_passages(old_doc_hash) {
            if !pages.contains(&card.page_fingerprint) {
                continue;
            }
            if let Some(current) = self.read_passage(new_doc_hash, &card.id)
                && current.saved_at >= card.saved_at
            {
                continue;
            }
            self.put_passage(new_doc_hash, &card)?;
            passages += 1.0;
        }

        for run_id in self.list_highlight_run_ids(old_doc_hash) {
            if let Some((run, saved_at)) = self.read_stored_run(old_doc_hash, &run_id) {
                let current = self.read_stored_run(new_doc_hash, &run_id);
                if current.is_none_or(|(_, current_saved_at)| current_saved_at < saved_at) {
                    self.put_run(new_doc_hash, &run, saved_at)?;
                }
            }
            for block in self.read_highlight_block_list(old_doc_hash, &run_id, Some(pages)) {
                let path = self.highlight_block_path(new_doc_hash, &run_id, &block.key)?;
                let raw = self.read(&path);
                if let Some(current) = as_highlight_block(raw.as_ref(), &block.key)
                    && current.saved_at >= block.saved_at
                {
                    continue;
                }
                self.put_highlight_block(new_doc_hash, &run_id, &block)?;
                highlight_blocks += 1.0;
            }
        }

        for lang in self.list_insights(old_doc_hash) {
            let Some((entry, saved_at)) = self.read_stored_insights(old_doc_hash, &lang) else {
                continue;
            };
            if !entry.page_fingerprints.iter().all(|fp| pages.contains(fp)) {
                continue;
            }
            if let Some((_, current_saved_at)) = self.read_stored_insights(new_doc_hash, &lang)
                && current_saved_at >= saved_at
            {
                continue;
            }
            self.put_insights(new_doc_hash, &entry, saved_at)?;
            insights += 1.0;
        }
        Ok((passages, highlight_blocks, insights))
    }

    // ---- delete and size ----

    /// `deleteDocument(docHash)`: remove everything stored for one document
    pub fn delete_document(&mut self, doc_hash: &str) -> StoreResult<()> {
        let dir = self.document_dir(doc_hash)?;
        self.remove_dir(&dir)
    }

    /// `deleteAll()`: remove the whole store folder (and nothing outside it)
    pub fn delete_all(&mut self) -> StoreResult<()> {
        let dir = self.dir.clone();
        self.remove_dir(&dir)
    }

    /// `size(docHash)`: bytes on disk, for one document or for the whole store
    pub fn size(&mut self, doc_hash: Option<&str>) -> f64 {
        match doc_hash {
            None => folder_size(&self.dir),
            Some(doc_hash) if is_valid_seg(doc_hash) => self
                .document_dir(doc_hash)
                .map_or(0.0, |dir| folder_size(&dir)),
            Some(_) => 0.0,
        }
    }
}
