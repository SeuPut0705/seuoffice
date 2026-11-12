//! The pieces of `packages/pdf-structure/src/store` that the ported main-process
//! modules call: `StoreWriteError` (files.ts), `isTranslationMode` and
//! `jobKeyOf` (job-keys.ts, re-exported by store.ts).

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

/// the job kinds whose second key is the language
const LANG_KEYED_JOBS: [&str; 3] = ["translate", "translate-page", "summary"];

/// `jobKeyField(kind)`: the record field that holds a kind's second key, or
/// `None` for `ai-read` (and for a kind that is none of them).
fn job_key_field(kind: &str) -> Option<&'static str> {
    if LANG_KEYED_JOBS.contains(&kind) {
        return Some("lang");
    }
    (kind == "highlight").then_some("runId")
}

/// `jobKeyOf(job)`: a job's second key: its language, its run id, or `None`
/// for `ai-read`. `lang` and `run_id` are the fields of the record, `None`
/// where it has none.
pub fn job_key_of(kind: &str, lang: Option<&str>, run_id: Option<&str>) -> Option<String> {
    match job_key_field(kind)? {
        "lang" => lang.map(str::to_owned),
        _ => run_id.map(str::to_owned),
    }
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
