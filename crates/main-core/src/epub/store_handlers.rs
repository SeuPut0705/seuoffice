//! `apps/epub/src/main/store-handlers.ts`.
//!
//! The result-store channels of the EPUB editor (`epub:store-*`), without
//! Electron. Every handler answers an outcome (`{ ok: true, ... }` or
//! `{ ok: false, error, message? }`) and never throws, except `write` when the
//! store itself cannot be made, which is outside its `try`.
//!
//! The store is a trait with the methods the handlers call; the trailing mode
//! argument of the TypeScript (`...modeArgs(mode)`) is `Some(Easy)` for an
//! easy explanation and `None` for a plain translation, as the TypeScript
//! passes either `['easy']` or nothing. What the store reads and writes
//! (blocks, job records, job statuses) is opaque here and travels as JSON.

use jscompat::js_regex;
use serde_json::{Map, Value};

use crate::packages::pdf_structure::{
    StoreWriteError, TranslationMode, is_translation_mode, job_key_of,
};

/// What a store call throws, as `storeFailure(err)` tells it apart.
#[derive(Debug, Clone, PartialEq)]
pub enum StoreError {
    /// `StoreWriteError`
    Write(StoreWriteError),
    /// a `TypeError` with its message
    Type(String),
    /// any other thrown value, as `err instanceof Error ? err.message : String(err)`
    Other(String),
}

/// `StoredTranslation`, as the handler reads it: the blocks are the values of
/// the store's `Map`, in order.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredTranslation {
    pub lang: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub blocks: Vec<Value>,
}

/// `EpubStore`: the part of the result store the handlers call.
pub trait EpubStore {
    fn list_translations(
        &mut self,
        doc_hash: &str,
        mode: Option<TranslationMode>,
    ) -> Result<Vec<String>, StoreError>;
    fn read_translation(
        &mut self,
        doc_hash: &str,
        lang: &str,
        mode: Option<TranslationMode>,
    ) -> Result<Option<StoredTranslation>, StoreError>;
    fn unfinished_jobs(&mut self, doc_hash: &str) -> Result<Vec<Value>, StoreError>;
    fn write_translation_meta(
        &mut self,
        doc_hash: &str,
        lang: &str,
        provider: &str,
        model: &str,
        mode: Option<TranslationMode>,
    ) -> Result<(), StoreError>;
    fn write_translation_blocks(
        &mut self,
        doc_hash: &str,
        lang: &str,
        blocks: &[Value],
        mode: Option<TranslationMode>,
    ) -> Result<(), StoreError>;
    fn delete_translation(
        &mut self,
        doc_hash: &str,
        lang: &str,
        mode: Option<TranslationMode>,
    ) -> Result<(), StoreError>;
    fn delete_translation_except_edited(
        &mut self,
        doc_hash: &str,
        lang: &str,
        mode: Option<TranslationMode>,
    ) -> Result<f64, StoreError>;
    fn write_job(&mut self, doc_hash: &str, job: &Value) -> Result<(), StoreError>;
    fn heartbeat_job(
        &mut self,
        doc_hash: &str,
        kind: &str,
        key: Option<&str>,
        mode: Option<TranslationMode>,
    ) -> Result<bool, StoreError>;
}

/// `EpubStoreHandlerDeps`
pub trait EpubStoreHandlerDeps {
    /// created on first use; `Err` is a store that cannot be made
    fn store(&mut self) -> Result<&mut dyn EpubStore, StoreError>;
    /// whether the main process hashed `docHash` for this view
    fn knows(&mut self, owner: f64, doc_hash: &str) -> bool;
}

const MAX_META: usize = 200;
/// blocks written in one call
const MAX_BLOCKS: usize = 10_000;

/// `fail(error, message)`: a failure; an empty message is left out, as
/// `message ? { message } : {}`.
fn fail(error: &str, message: Option<&str>) -> Value {
    let mut out = Map::new();
    out.insert("ok".into(), Value::Bool(false));
    out.insert("error".into(), Value::from(error));
    if let Some(message) = message.filter(|message| !message.is_empty()) {
        out.insert("message".into(), Value::from(message));
    }
    Value::Object(out)
}

/// `{ ok: true }` with more keys after it
fn ok_with(entries: Vec<(&str, Value)>) -> Value {
    let mut out = Map::new();
    out.insert("ok".into(), Value::Bool(true));
    for (key, value) in entries {
        out.insert(key.to_owned(), value);
    }
    Value::Object(out)
}

fn is_record(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_)))
}

/// `isKey(v)`: the store's segment rule
fn as_key(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
        .filter(|text| js_regex!(r"^[A-Za-z0-9_-]{1,128}$").test(text))
}

fn is_meta(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
        .filter(|text| text.encode_utf16().count() <= MAX_META)
}

/// `modeOf(v)`: left out is `translate`; `None` when it is not a mode
fn mode_of(v: Option<&Value>) -> Option<TranslationMode> {
    match v {
        None => Some(TranslationMode::Translate),
        Some(value) if is_translation_mode(value) => {
            value.as_str().and_then(TranslationMode::parse)
        }
        Some(_) => None,
    }
}

/// `modeArgs(mode)`: the trailing mode argument, none for a plain translation
fn mode_args(mode: TranslationMode) -> Option<TranslationMode> {
    (mode == TranslationMode::Easy).then_some(mode)
}

/// `storeFailure(err)`
fn store_failure(err: &StoreError) -> Value {
    match err {
        StoreError::Write(error) => fail("store-write-failed", Some(&error.message)),
        StoreError::Type(message) => fail("invalid-request", Some(message)),
        StoreError::Other(message) => fail("failed", Some(message)),
    }
}

/// `granted(owner, docHash)`
fn granted<'a>(
    deps: &mut dyn EpubStoreHandlerDeps,
    owner: f64,
    doc_hash: Option<&'a Value>,
) -> Option<&'a str> {
    let key = as_key(doc_hash)?;
    deps.knows(owner, key).then_some(key)
}

/// `translations(owner, docHash, modeArg)`
pub fn translations(
    deps: &mut dyn EpubStoreHandlerDeps,
    owner: f64,
    doc_hash: Option<&Value>,
    mode_arg: Option<&Value>,
) -> Value {
    let Some(doc_hash) = granted(deps, owner, doc_hash) else {
        return fail("not-granted", Some("unknown document hash"));
    };
    let Some(mode) = mode_of(mode_arg) else {
        return fail("invalid-request", Some("bad mode"));
    };
    let outcome = deps
        .store()
        .and_then(|store| store.list_translations(doc_hash, mode_args(mode)));
    match outcome {
        Ok(langs) => ok_with(vec![(
            "langs",
            Value::Array(langs.into_iter().map(Value::String).collect()),
        )]),
        Err(err) => store_failure(&err),
    }
}

/// `translation(owner, docHash, lang, modeArg)`
pub fn translation(
    deps: &mut dyn EpubStoreHandlerDeps,
    owner: f64,
    doc_hash: Option<&Value>,
    lang: Option<&Value>,
    mode_arg: Option<&Value>,
) -> Value {
    let Some(doc_hash) = granted(deps, owner, doc_hash) else {
        return fail("not-granted", Some("unknown document hash"));
    };
    let Some(lang) = as_key(lang) else {
        return fail("invalid-request", Some("bad language"));
    };
    let Some(mode) = mode_of(mode_arg) else {
        return fail("invalid-request", Some("bad mode"));
    };
    let outcome = deps
        .store()
        .and_then(|store| store.read_translation(doc_hash, lang, mode_args(mode)));
    match outcome {
        Ok(stored) => {
            let translation = match stored {
                None => Value::Null,
                Some(stored) => {
                    let mut out = Map::new();
                    out.insert("lang".into(), Value::String(stored.lang));
                    out.insert(
                        "provider".into(),
                        stored.provider.map_or(Value::Null, Value::String),
                    );
                    out.insert(
                        "model".into(),
                        stored.model.map_or(Value::Null, Value::String),
                    );
                    out.insert("blocks".into(), Value::Array(stored.blocks));
                    Value::Object(out)
                }
            };
            ok_with(vec![("translation", translation)])
        }
        Err(err) => store_failure(&err),
    }
}

/// `unfinishedJobs(owner, docHash)`
pub fn unfinished_jobs(
    deps: &mut dyn EpubStoreHandlerDeps,
    owner: f64,
    doc_hash: Option<&Value>,
) -> Value {
    let Some(doc_hash) = granted(deps, owner, doc_hash) else {
        return fail("not-granted", Some("unknown document hash"));
    };
    match deps
        .store()
        .and_then(|store| store.unfinished_jobs(doc_hash))
    {
        Ok(jobs) => ok_with(vec![("jobs", Value::Array(jobs))]),
        Err(err) => store_failure(&err),
    }
}

/// `write(owner, req)`: `Err` is what the TypeScript lets reject (the store
/// that cannot be made).
pub fn write(
    deps: &mut dyn EpubStoreHandlerDeps,
    owner: f64,
    req: Option<&Value>,
) -> Result<Value, StoreError> {
    let Some(Value::Object(req)) = req else {
        return Ok(fail("invalid-request", Some("request must be an object")));
    };
    let Some(doc_hash) = granted(deps, owner, req.get("docHash")) else {
        return Ok(fail("not-granted", Some("unknown document hash")));
    };
    let Some(lang) = as_key(req.get("lang")) else {
        return Ok(fail("invalid-request", Some("bad language")));
    };
    let Some(mode) = mode_of(req.get("mode")) else {
        return Ok(fail("invalid-request", Some("bad mode")));
    };
    let store = deps.store()?;
    let outcome = write_kind(store, req, doc_hash, lang, mode);
    Ok(match outcome {
        Ok(Some(answer)) => answer,
        Ok(None) => fail("invalid-request", Some("bad store write")),
        Err(err) => store_failure(&err),
    })
}

/// The `switch (req.kind)` of `write`: `Ok(None)` is a `break`, which ends in
/// `bad store write`.
fn write_kind(
    store: &mut dyn EpubStore,
    req: &Map<String, Value>,
    doc_hash: &str,
    lang: &str,
    mode: TranslationMode,
) -> Result<Option<Value>, StoreError> {
    let kind = req.get("kind").and_then(Value::as_str);
    match kind {
        Some("translationMeta") => {
            let (Some(provider), Some(model)) =
                (is_meta(req.get("provider")), is_meta(req.get("model")))
            else {
                return Ok(None);
            };
            store.write_translation_meta(doc_hash, lang, provider, model, mode_args(mode))?;
            Ok(Some(ok_with(vec![])))
        }
        Some("translationBlocks") => {
            let Some(Value::Array(blocks)) = req.get("blocks") else {
                return Ok(None);
            };
            if blocks.len() > MAX_BLOCKS {
                return Ok(None);
            }
            if !blocks.iter().all(|block| is_record(Some(block))) {
                return Ok(None);
            }
            store.write_translation_blocks(doc_hash, lang, blocks, mode_args(mode))?;
            Ok(Some(ok_with(vec![])))
        }
        Some("deleteTranslation") => {
            store.delete_translation(doc_hash, lang, mode_args(mode))?;
            Ok(Some(ok_with(vec![])))
        }
        Some("deleteTranslationExceptEdited") => {
            let removed =
                store.delete_translation_except_edited(doc_hash, lang, mode_args(mode))?;
            Ok(Some(ok_with(vec![(
                "removed",
                serde_json::Number::from_f64(removed).map_or(Value::Null, Value::Number),
            )])))
        }
        Some("job") => {
            // a book translation writes `translate` records only, under its own
            // language and the request's mode
            let Some(Value::Object(job)) = req.get("job") else {
                return Ok(None);
            };
            if job.get("kind").and_then(Value::as_str) != Some("translate")
                || job.get("lang").and_then(Value::as_str) != Some(lang)
            {
                return Ok(None);
            }
            if mode_of(job.get("mode")) != Some(mode) {
                return Ok(None);
            }
            store.write_job(doc_hash, &Value::Object(job.clone()))?;
            Ok(Some(ok_with(vec![])))
        }
        Some("heartbeat") => {
            if req.get("job").and_then(Value::as_str) != Some("translate") {
                return Ok(None);
            }
            let key = job_key_of("translate", Some(lang), None);
            let alive =
                store.heartbeat_job(doc_hash, "translate", key.as_deref(), mode_args(mode))?;
            Ok(Some(if alive {
                ok_with(vec![])
            } else {
                fail("failed", Some("no running job record"))
            }))
        }
        _ => Ok(None),
    }
}
