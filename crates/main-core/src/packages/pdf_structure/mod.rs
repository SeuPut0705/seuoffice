//! `packages/pdf-structure/src/store`, the result store (spec §6): AI-read
//! pages, translations and unfinished job records kept on this PC. One file
//! per TypeScript file: `files` (the file primitives), `keys`, `note_links`,
//! `reading`, `sentence_ends` and `store` (the `ResultStore`), with the pieces
//! of `tree/` and `highlight/` they import (`tree_hash`, `tree_inline`,
//! `highlight_run_id`). This file holds `job-keys.ts` (re-exported by
//! `store.ts`) and `StoreWriteError` (`files.ts`), which the ported
//! main-process modules call.

pub mod files;
pub mod highlight_run_id;
pub mod keys;
pub mod note_links;
pub mod reading;
pub mod sentence_ends;
pub mod store;
pub mod tree_hash;
pub mod tree_inline;

use serde_json::Value;

/// `TRANSLATION_MODES`: a plain translation, or an easy explanation.
pub const TRANSLATION_MODES: [&str; 2] = ["translate", "easy"];

/// `TranslationMode`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranslationMode {
    Translate,
    Easy,
}

impl TranslationMode {
    pub fn as_str(self) -> &'static str {
        match self {
            TranslationMode::Translate => "translate",
            TranslationMode::Easy => "easy",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "translate" => Some(TranslationMode::Translate),
            "easy" => Some(TranslationMode::Easy),
            _ => None,
        }
    }
}

/// `isTranslationMode(v)`: `TRANSLATION_MODES.includes(v)`, so only a string is one.
pub fn is_translation_mode(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| TranslationMode::parse(text).is_some())
}

/// `JobKind`: every job kind
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobKind {
    AiRead,
    Translate,
    TranslatePage,
    Highlight,
    Summary,
}

/// `JOB_KINDS`
pub const JOB_KINDS: [JobKind; 5] = [
    JobKind::AiRead,
    JobKind::Translate,
    JobKind::TranslatePage,
    JobKind::Highlight,
    JobKind::Summary,
];

impl JobKind {
    /// the TypeScript's string
    pub fn as_str(self) -> &'static str {
        match self {
            JobKind::AiRead => "ai-read",
            JobKind::Translate => "translate",
            JobKind::TranslatePage => "translate-page",
            JobKind::Highlight => "highlight",
            JobKind::Summary => "summary",
        }
    }

    /// the kind a string names (`isJobKind`)
    pub fn parse(text: &str) -> Option<Self> {
        JOB_KINDS.into_iter().find(|kind| kind.as_str() == text)
    }
}

/// the record field that holds a kind's second key
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyField {
    Lang,
    RunId,
}

impl KeyField {
    /// the field's name in a record
    pub fn as_str(self) -> &'static str {
        match self {
            KeyField::Lang => "lang",
            KeyField::RunId => "runId",
        }
    }
}

/// the job kinds whose second key is the language
const LANG_KEYED_JOBS: [JobKind; 3] =
    [JobKind::Translate, JobKind::TranslatePage, JobKind::Summary];

/// `jobKeyField(kind)`: the record field that holds a kind's second key, or
/// `None` for `ai-read`.
pub fn job_key_field(kind: JobKind) -> Option<KeyField> {
    if LANG_KEYED_JOBS.contains(&kind) {
        return Some(KeyField::Lang);
    }
    (kind == JobKind::Highlight).then_some(KeyField::RunId)
}

/// `jobKeyOf(job)`: a job's second key: its language, its run id, or `None`
/// for `ai-read` (and for a kind that is none of them). `lang` and `run_id`
/// are the fields of the record, `None` where it has none.
pub fn job_key_of(kind: &str, lang: Option<&str>, run_id: Option<&str>) -> Option<String> {
    match job_key_field(JobKind::parse(kind)?)? {
        KeyField::Lang => lang.map(str::to_owned),
        KeyField::RunId => run_id.map(str::to_owned),
    }
}

/// `MODE_JOB_KINDS`: the job kinds an easy explanation runs as
pub const MODE_JOB_KINDS: [JobKind; 2] = [JobKind::Translate, JobKind::TranslatePage];

/// `jobModeAllowed(kind, mode)`: a job of `kind` may be recorded in `mode`
pub fn job_mode_allowed(kind: JobKind, mode: TranslationMode) -> bool {
    mode == TranslationMode::Translate || MODE_JOB_KINDS.contains(&kind)
}

/// `StoreWriteError`: a store write failed (disk full, permissions, a file in
/// the way).
#[derive(Debug, Clone, PartialEq)]
pub struct StoreWriteError {
    /// `err.message`
    pub message: String,
    /// Node error code of the cause (ENOSPC, EACCES, ...), `unknown` without one
    pub errno: String,
    pub path: String,
}

impl StoreWriteError {
    /// `err.code`
    pub const CODE: &'static str = "store-write-failed";
    /// `err.name`
    pub const NAME: &'static str = "StoreWriteError";

    /// `new StoreWriteError(path, cause)`; `cause_code` is `cause?.code`, an
    /// empty string kept as it is (`??` only replaces `undefined` and `null`).
    pub fn new(path: &str, cause_code: Option<&str>) -> Self {
        let errno = cause_code.unwrap_or("unknown");
        StoreWriteError {
            message: format!("result store write failed ({errno}): {path}"),
            errno: errno.to_owned(),
            path: path.to_owned(),
        }
    }
}
