//! The functions of part `index-store` of group `b3b4-rest`
//! (tools/main-diff/groups/b3b4-rest/index-store.ts): the file index's
//! decision-model client, its store, its reranker and its indexer. A scenario
//! plays the part of the caller: it owns the state struct, carries out what
//! the host traits ask for on a fake world, and writes each call of the fake as
//! one `logs` line, exactly as the TypeScript fakes of the spec write it.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

use jscompat::json_value_from_serde;
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg, str_arg};
use crate::packages::electron_utils::unsaved_files::{
    OpenFileState, OpenFilesHolder, OpenFilesSourceFailed,
};
use crate::shell::file_index::decider::{
    DecisionCallOptions, FetchRequest, JevDocument, JevJudgement, JevResponse, JevTransport,
    MAX_DOCS, body_model, endpoint_url, evaluate, fetch_transport, is_local_endpoint, prepare,
    validate,
};
use crate::shell::file_index::extract::Extracted;
use crate::shell::file_index::extract_worker::{WorkerRequest, WorkerResponse};
use crate::shell::file_index::indexer::{
    FileIndexer, IndexerConfig, IndexerHost, NameOnlyCall, TimerKind, WorkerId,
};
use crate::shell::file_index::rerank::{
    RerankStart, SearchReranker, Sendable, default_file_search_settings,
    normalize_file_search_settings, probe_decision,
};
use crate::shell::file_index::scan::ScannedFile;
use crate::shell::file_index::store::{FileIndexStore, IndexStatus, SearchOptions, StoreError};
use crate::shell::home_api::{
    DecisionEndpoint, EndpointKeys, FileSearchSettings, is_cloudflare_endpoint,
};

/// the modification time the spec's corpus counts from
const NOW: f64 = 1_700_000_000_000.0;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "home-api.isCloudflareEndpoint" => endpoint_arg(args, 0)
            .map(|endpoint| Some(Value::Bool(is_cloudflare_endpoint(endpoint)))),
        "decider.isLocalEndpoint" => {
            endpoint_arg(args, 0).map(|endpoint| Some(Value::Bool(is_local_endpoint(endpoint))))
        }
        "decider.endpointUrl" => (|| {
            let opts = opts_of(arg(args, 0))?;
            endpoint_url(&opts)
                .map(|url| Some(Value::from(url)))
                .map_err(|e| CallError::plain(e.0))
        })(),
        "decider.bodyModel" => (|| {
            let opts = opts_of(arg(args, 0))?;
            body_model(&opts)
                .map(|model| Some(Value::from(model)))
                .map_err(|e| CallError::plain(e.0))
        })(),
        "decider.MAX_DOCS" => Ok(Some(Value::from(MAX_DOCS as f64))),
        "decider.prepare" => (|| {
            let query = str_arg(args, 0)?;
            let docs = docs_of(arg(args, 1));
            let opts = opts_of(arg(args, 2))?;
            prepare(query, &docs, &opts)
                .map(|p| Some(json!({ "body": p.body, "count": p.count as f64 })))
                .map_err(|e| CallError::plain(e.0))
        })(),
        "decider.validate" => (|| {
            let raw = json_value_from_serde(arg(args, 0).unwrap_or(&Value::Null));
            let count = arg(args, 1).and_then(Value::as_f64).unwrap_or(0.0) as usize;
            let endpoint = endpoint_arg(args, 2)?;
            validate(&raw, count, endpoint)
                .map(|j| Some(judgement_json(&j)))
                .map_err(|e| CallError::plain(e.0))
        })(),
        "decider.fetchTransport" => fetch_transport_call(args, cx),
        "decider.evaluate" => evaluate_call(args, cx),
        "rerank.DEFAULT_FILE_SEARCH_SETTINGS" => Ok(Some(default_file_search_settings().to_json())),
        "rerank.normalizeFileSearchSettings" => {
            let raw = json_value_from_serde(arg(args, 0).unwrap_or(&Value::Null));
            Ok(Some(normalize_file_search_settings(&raw).to_json()))
        }
        "rerank.probeDecision" => probe_call(args, cx),
        "rerank.SearchReranker" => rerank_scenario(args, cx),
        "store.FileIndexStore" => store_scenario(args, cx),
        "indexer.FileIndexer" => indexer_scenario(args, cx),
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// reading the spec
// ---------------------------------------------------------------------------

fn endpoint_arg(args: &[Value], i: usize) -> Result<DecisionEndpoint, CallError> {
    let id = str_arg(args, i)?;
    DecisionEndpoint::from_id(id).ok_or_else(|| CallError::plain(format!("no endpoint {id}")))
}

fn string_of(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn opts_of(spec: Option<&Value>) -> Result<DecisionCallOptions, CallError> {
    let v = spec.ok_or_else(|| CallError::plain("options"))?;
    let id = v
        .get("endpoint")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Ok(DecisionCallOptions {
        endpoint: DecisionEndpoint::from_id(id)
            .ok_or_else(|| CallError::plain(format!("no endpoint {id}")))?,
        key: string_of(v, "key"),
        custom_base_url: string_of(v, "customBaseUrl"),
        custom_model: string_of(v, "customModel"),
        cloudflare_account_id: string_of(v, "cloudflareAccountId"),
        cloudflare_model: string_of(v, "cloudflareModel"),
    })
}

fn docs_of(spec: Option<&Value>) -> Vec<JevDocument> {
    spec.and_then(Value::as_array)
        .map(|docs| {
            docs.iter()
                .map(|d| JevDocument {
                    title: string_of(d, "title"),
                    heading: string_of(d, "heading"),
                    text: string_of(d, "text"),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn settings_of(spec: Option<&Value>) -> Result<FileSearchSettings, CallError> {
    let v = spec.ok_or_else(|| CallError::plain("settings"))?;
    let id = v
        .get("endpoint")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut keys = EndpointKeys::empty();
    for endpoint in DecisionEndpoint::ALL {
        let key = v
            .get("keys")
            .and_then(|k| k.get(endpoint.id()))
            .and_then(Value::as_str)
            .unwrap_or_default();
        keys.set(endpoint, key.to_owned());
    }
    Ok(FileSearchSettings {
        rerank: v.get("rerank") == Some(&Value::Bool(true)),
        endpoint: DecisionEndpoint::from_id(id)
            .ok_or_else(|| CallError::plain(format!("no endpoint {id}")))?,
        keys,
        custom_base_url: string_of(v, "customBaseUrl"),
        custom_model: string_of(v, "customModel"),
        cloudflare_account_id: string_of(v, "cloudflareAccountId"),
        cloudflare_model: string_of(v, "cloudflareModel"),
    })
}

fn judgement_json(j: &JevJudgement) -> Value {
    let number = |n: Option<f64>| n.map_or(Value::Null, Value::from);
    json!({
        "scores": j.scores.iter().map(|s| Value::from(*s)).collect::<Vec<_>>(),
        "inputTokens": number(j.input_tokens),
        "cost": number(j.cost),
    })
}

fn strings_of(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|p| p.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

type Log = Rc<RefCell<Vec<Vec<Value>>>>;

fn log_line(log: &Log, line: Vec<Value>) {
    log.borrow_mut().push(line);
}

// ---------------------------------------------------------------------------
// the scripted transport
// ---------------------------------------------------------------------------

/// a transport that logs each call and answers from the script: a step is
/// `{ status, body, retryAfter? }`, `{ throws }` or `{ always: step }`
struct Scripted {
    log: Log,
    script: Rc<RefCell<Vec<Value>>>,
    clock: Rc<Cell<f64>>,
}

impl JevTransport for Scripted {
    fn now_ms(&mut self) -> f64 {
        self.clock.get()
    }

    fn send(
        &mut self,
        url: &str,
        body: &str,
        key: &str,
        _abort_at_ms: f64,
    ) -> Result<JevResponse, String> {
        log_line(
            &self.log,
            vec!["send".into(), url.into(), body.into(), key.into()],
        );
        let mut script = self.script.borrow_mut();
        let Some(first) = script.first().cloned() else {
            return Err("script exhausted".to_owned());
        };
        let mut next = first;
        if next.get("always").is_some() {
            while let Some(inner) = next.get("always").cloned() {
                next = inner;
            }
        } else {
            script.remove(0);
        }
        if let Some(message) = next.get("throws").and_then(Value::as_str) {
            return Err(message.to_owned());
        }
        Ok(JevResponse {
            status: next
                .get("status")
                .and_then(Value::as_f64)
                .unwrap_or(f64::NAN),
            retry_after: next
                .get("retryAfter")
                .and_then(Value::as_str)
                .map(str::to_owned),
            body: string_of(&next, "body"),
        })
    }

    fn sleep(
        &mut self,
        _ms: f64,
        _abort_at_ms: f64,
    ) -> Result<(), crate::shell::file_index::decider::Aborted> {
        Ok(())
    }
}

fn scripted(log: &Log, script: &Value, now: f64) -> Scripted {
    Scripted {
        log: log.clone(),
        script: Rc::new(RefCell::new(script.as_array().cloned().unwrap_or_default())),
        clock: Rc::new(Cell::new(now)),
    }
}

fn new_log() -> Log {
    Rc::new(RefCell::new(Vec::new()))
}

fn flush(cx: &mut Context, log: &Log) {
    cx.logs.extend(log.borrow_mut().drain(..));
}

// ---------------------------------------------------------------------------
// decider
// ---------------------------------------------------------------------------

fn evaluate_call(args: &[Value], cx: &mut Context) -> Answer {
    let query = str_arg(args, 0)?;
    let docs = docs_of(arg(args, 1));
    let opts = opts_of(arg(args, 2))?;
    let log = new_log();
    let mut transport = scripted(&log, arg(args, 3).unwrap_or(&Value::Null), cx.now_ms);
    let answer = evaluate(query, &docs, &opts, &mut transport);
    flush(cx, &log);
    answer
        .map(|j| Some(judgement_json(&j)))
        .map_err(|e| CallError::plain(e.0))
}

fn fetch_transport_call(args: &[Value], cx: &mut Context) -> Answer {
    let url = str_arg(args, 0)?;
    let body = str_arg(args, 1)?;
    let key = str_arg(args, 2)?;
    let reply = arg(args, 3).ok_or_else(|| CallError::plain("reply"))?;
    let mut fetch = |request: &FetchRequest| -> Result<JevResponse, String> {
        let mut headers = Map::new();
        for (name, value) in &request.headers {
            headers.insert(name.clone(), Value::from(value.as_str()));
        }
        cx.logs.push(vec![
            "fetch".into(),
            request.url.as_str().into(),
            json!({
                "method": request.method,
                "headers": Value::Object(headers),
                "body": request.body,
            }),
        ]);
        if let Some(message) = reply.get("reject").and_then(Value::as_str) {
            return Err(message.to_owned());
        }
        Ok(JevResponse {
            status: reply
                .get("status")
                .and_then(Value::as_f64)
                .unwrap_or(f64::NAN),
            retry_after: reply
                .get("retryAfter")
                .and_then(Value::as_str)
                .map(str::to_owned),
            body: string_of(reply, "body"),
        })
    };
    match fetch_transport(url, body, key, &mut fetch) {
        Ok(r) => {
            let mut out = Map::new();
            out.insert("status".into(), Value::from(r.status));
            if let Some(retry_after) = r.retry_after {
                out.insert("retryAfter".into(), Value::from(retry_after));
            }
            out.insert("body".into(), Value::from(r.body));
            Ok(Some(Value::Object(out)))
        }
        Err(message) => Err(CallError::plain(message)),
    }
}

fn probe_call(args: &[Value], cx: &mut Context) -> Answer {
    let settings = settings_of(arg(args, 0))?;
    let log = new_log();
    let mut transport = scripted(&log, arg(args, 1).unwrap_or(&Value::Null), cx.now_ms);
    let result = probe_decision(&settings, &mut transport);
    flush(cx, &log);
    Ok(Some(result.to_json()))
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

fn store_error(e: StoreError) -> String {
    e.0
}

/// `Text` of the spec: a string, `null` or `{ repeat, times, then? }`
fn text_of(spec: Option<&Value>) -> Option<String> {
    match spec {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Object(o)) => {
            let repeat = o.get("repeat").and_then(Value::as_str).unwrap_or_default();
            let times = o.get("times").and_then(Value::as_f64).unwrap_or(0.0) as usize;
            let then = o.get("then").and_then(Value::as_str).unwrap_or_default();
            Some(format!("{}{then}", repeat.repeat(times)))
        }
        _ => None,
    }
}

fn status_of(text: &str) -> IndexStatus {
    match text {
        "name-only" => IndexStatus::NameOnly,
        "error" => IndexStatus::Error,
        "cloud" => IndexStatus::Cloud,
        _ => IndexStatus::Ok,
    }
}

fn scanned_of(spec: &Value) -> ScannedFile {
    ScannedFile {
        path: string_of(spec, "path"),
        mtime_ms: spec
            .get("mtimeMs")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN),
        size_bytes: spec
            .get("sizeBytes")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN),
    }
}

fn indexed_json(file: &crate::shell::file_index::store::IndexedFile) -> Value {
    json!({
        "path": file.path,
        "mtimeMs": file.mtime_ms,
        "sizeBytes": file.size_bytes,
        "status": file.status.as_str(),
    })
}

fn list_all_json(store: &FileIndexStore) -> Result<Value, String> {
    let all = store.list_all().map_err(store_error)?;
    Ok(Value::Array(all.values().map(indexed_json).collect()))
}

fn remove_database(path: &str) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{path}{suffix}"));
    }
}

fn store_scenario(args: &[Value], _cx: &mut Context) -> Answer {
    let steps = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| CallError::plain("steps"))?;
    let mut out = Vec::new();
    let mut opened: Vec<String> = Vec::new();
    let mut store: Option<FileIndexStore> = None;
    for step in steps {
        out.push(match store_step(step, &mut store, &mut opened) {
            Ok(value) => value,
            Err(message) => json!({ "error": message }),
        });
    }
    drop(store);
    for path in &opened {
        remove_database(path);
    }
    Ok(Some(Value::Array(out)))
}

fn store_step(
    step: &Value,
    store: &mut Option<FileIndexStore>,
    opened: &mut Vec<String>,
) -> Result<Value, String> {
    let op = string_of(step, "op");
    match op.as_str() {
        "open" => {
            if let Some(previous) = store.take() {
                previous.close().map_err(store_error)?;
            }
            let path = string_of(step, "path");
            opened.push(path.clone());
            *store = Some(FileIndexStore::new(&path).map_err(store_error)?);
            return Ok(Value::Null);
        }
        "setMeta" => {
            let db =
                rusqlite::Connection::open(string_of(step, "path")).map_err(|e| e.to_string())?;
            let key = string_of(step, "key");
            match step.get("value").and_then(Value::as_str) {
                None => db
                    .execute("DELETE FROM meta WHERE key = ?", [key.as_str()])
                    .map_err(|e| e.to_string())?,
                Some(value) => db
                    .execute(
                        "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                        [key.as_str(), value],
                    )
                    .map_err(|e| e.to_string())?,
            };
            return Ok(Value::Null);
        }
        "close" => {
            if let Some(previous) = store.take() {
                previous.close().map_err(store_error)?;
            }
            return Ok(Value::Null);
        }
        _ => {}
    }
    let Some(store) = store.as_ref() else {
        return Err("no store".to_owned());
    };
    match op.as_str() {
        "upsert" => {
            let text = text_of(step.get("text"));
            store
                .upsert(
                    &scanned_of(step),
                    text.as_deref(),
                    status_of(&string_of(step, "status")),
                )
                .map_err(store_error)?;
            Ok(Value::Null)
        }
        "remove" => {
            store
                .remove(&strings_of(step.get("paths")))
                .map_err(store_error)?;
            Ok(Value::Null)
        }
        "search" => {
            let q = string_of(step, "q");
            let o = step.get("opts").cloned().unwrap_or_else(|| json!({}));
            let number = |key: &str| o.get(key).and_then(Value::as_f64);
            let prefix = o
                .get("within")
                .and_then(|w| w.get("prefix"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let within = prefix.map(|p| move |path: &str| path.starts_with(p.as_str()));
            let opts = SearchOptions {
                exts: o
                    .get("exts")
                    .and_then(Value::as_array)
                    .map(|_| strings_of(o.get("exts"))),
                offset: number("offset"),
                limit: number("limit"),
                excerpt_chars: number("excerptChars"),
                within: within.as_ref().map(|f| f as &dyn Fn(&str) -> bool),
            };
            let result = store.search(&q, &opts).map_err(store_error)?;
            Ok(serde_json::to_value(&result).expect("a result prints"))
        }
        "listAll" => list_all_json(store),
        "count" => Ok(Value::from(store.count().map_err(store_error)? as f64)),
        "excerptsFor" => {
            let hits = store
                .excerpts_for(
                    &strings_of(step.get("paths")),
                    &string_of(step, "q"),
                    step.get("chars")
                        .and_then(Value::as_f64)
                        .unwrap_or(f64::NAN),
                )
                .map_err(store_error)?;
            Ok(serde_json::to_value(&hits).expect("hits print"))
        }
        "pathsIndexedAsOnDisk" => {
            let paths = store
                .paths_indexed_as_on_disk(&strings_of(step.get("paths")))
                .map_err(store_error)?;
            Ok(Value::from(paths))
        }
        other => Err(format!("no such step: {other}")),
    }
}

// ---------------------------------------------------------------------------
// rerank: SearchReranker
// ---------------------------------------------------------------------------

/// the pieces of one `SearchReranker` scenario a request needs
struct RerankWorld {
    store: FileIndexStore,
    holder: OpenFilesHolder,
    reranker: SearchReranker,
    log: Log,
    sendable: bool,
    dropped: Vec<String>,
}

impl RerankWorld {
    /// `reranker.rerank(...)` up to where it leaves the work to the caller
    fn start(
        &mut self,
        transport: &mut Scripted,
        q: &str,
        paths: &[String],
        settings: &FileSearchSettings,
    ) -> Result<RerankStart, CallError> {
        let log = self.log.clone();
        let dropped = self.dropped.clone();
        let mut keep = move |paths: &[String]| -> Result<Vec<String>, String> {
            log_line(&log, vec!["sendable".into(), Value::from(paths.to_vec())]);
            Ok(paths
                .iter()
                .filter(|p| !dropped.contains(p))
                .cloned()
                .collect())
        };
        let sendable: Option<Sendable<'_>> = if self.sendable { Some(&mut keep) } else { None };
        self.reranker
            .rerank(
                &self.store,
                &self.holder,
                sendable,
                transport,
                q,
                paths,
                settings,
            )
            .map_err(|e| CallError::plain(e.0))
    }

    /// one request, run to its answer as an awaited call does
    fn run(
        &mut self,
        transport: &mut Scripted,
        q: &str,
        paths: &[String],
        settings: &FileSearchSettings,
    ) -> Result<Value, CallError> {
        match self.start(transport, q, paths, settings)? {
            RerankStart::Ready(result) => Ok(result.map_or(Value::Null, |r| r.to_json())),
            RerankStart::Judge(job) => Ok(self
                .reranker
                .judge(job, transport)
                .map_or(Value::Null, |r| r.to_json())),
            RerankStart::Join(_) => Err(CallError::plain("joined a request that is not out")),
        }
    }
}

fn rerank_scenario(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("spec"))?;
    let db = string_of(spec, "db");
    let log = new_log();
    let store = FileIndexStore::new(&db).map_err(|e| CallError::plain(e.0))?;
    let mut world = RerankWorld {
        store,
        holder: OpenFilesHolder::new(),
        reranker: SearchReranker::new(),
        log: log.clone(),
        sendable: spec.get("sendable") == Some(&Value::Bool(true)),
        dropped: Vec::new(),
    };
    let answer = rerank_steps(spec, &mut world, &log, cx.now_ms);
    world.holder.set_open_files_source(None);
    let RerankWorld { store, .. } = world;
    drop(store);
    remove_database(&db);
    flush(cx, &log);
    answer
}

fn rerank_steps(spec: &Value, world: &mut RerankWorld, log: &Log, now: f64) -> Answer {
    let steps = spec
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| CallError::plain("steps"))?;
    let mut transport = scripted(log, &Value::Null, now);
    let mut out = Vec::new();
    for step in steps {
        let op = string_of(step, "op");
        match op.as_str() {
            "index" => {
                let text = string_of(step, "text");
                let file = ScannedFile {
                    path: string_of(step, "path"),
                    mtime_ms: NOW + step.get("age").and_then(Value::as_f64).unwrap_or(0.0),
                    size_bytes: text.encode_utf16().count() as f64,
                };
                world
                    .store
                    .upsert(&file, Some(&text), IndexStatus::Ok)
                    .map_err(|e| CallError::plain(e.0))?;
            }
            "clock" => transport
                .clock
                .set(now + step.get("ms").and_then(Value::as_f64).unwrap_or(0.0)),
            "drop" => world.dropped = strings_of(step.get("paths")),
            "unsaved" => match step.get("paths") {
                Some(Value::Array(_)) => {
                    let paths = strings_of(step.get("paths"));
                    world.holder.set_open_files_source(Some(Box::new(move || {
                        Ok(paths
                            .iter()
                            .map(|p| OpenFileState {
                                file_path: Some(p.clone()),
                                dirty: true,
                            })
                            .collect())
                    })));
                }
                Some(Value::String(_)) => world
                    .holder
                    .set_open_files_source(Some(Box::new(|| Err(OpenFilesSourceFailed)))),
                _ => world.holder.set_open_files_source(None),
            },
            "rerank" => {
                *transport.script.borrow_mut() = step
                    .get("script")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let settings = settings_of(step.get("settings"))?;
                let paths = strings_of(step.get("paths"));
                out.push(world.run(&mut transport, &string_of(step, "q"), &paths, &settings)?);
            }
            "repeat" => {
                *transport.script.borrow_mut() = step
                    .get("script")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let settings = settings_of(step.get("settings"))?;
                let paths = strings_of(step.get("paths"));
                let times = step.get("times").and_then(Value::as_f64).unwrap_or(0.0) as usize;
                for i in 0..times {
                    let q = format!("{}{i}", string_of(step, "q"));
                    world.run(&mut transport, &q, &paths, &settings)?;
                }
                out.push(Value::Null);
            }
            "both" => {
                *transport.script.borrow_mut() = step
                    .get("script")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let settings = settings_of(step.get("settings"))?;
                let calls = step
                    .get("calls")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                out.push(rerank_both(world, &mut transport, &calls, &settings)?);
            }
            other => return Err(CallError::plain(format!("no such step: {other}"))),
        }
    }
    Ok(Some(Value::Array(out)))
}

/// Two requests started before either settles: each asks for its excerpts in
/// turn, then each judge runs in turn, and a request whose key is out joins
/// the answer of the request that started it.
fn rerank_both(
    world: &mut RerankWorld,
    transport: &mut Scripted,
    calls: &[Value],
    settings: &FileSearchSettings,
) -> Result<Value, CallError> {
    let mut starts = Vec::new();
    for call in calls {
        let paths = strings_of(call.get("paths"));
        starts.push(world.start(transport, &string_of(call, "q"), &paths, settings)?);
    }
    let mut answers: Vec<(String, Value)> = Vec::new();
    let mut results = Vec::new();
    // the judges run in the order the requests were made
    let mut pending: Vec<Option<Value>> = vec![None; starts.len()];
    for (at, start) in starts.iter().enumerate() {
        match start {
            RerankStart::Ready(result) => {
                pending[at] = Some(result.as_ref().map_or(Value::Null, |r| r.to_json()));
            }
            RerankStart::Judge(job) => {
                let key = job.cache_key().to_owned();
                let result = world
                    .reranker
                    .judge(job.clone(), transport)
                    .map_or(Value::Null, |r| r.to_json());
                answers.push((key, result.clone()));
                pending[at] = Some(result);
            }
            RerankStart::Join(_) => {}
        }
    }
    for (at, start) in starts.iter().enumerate() {
        results.push(match start {
            RerankStart::Join(key) => answers
                .iter()
                .find(|(known, _)| known == key)
                .map_or(Value::Null, |(_, result)| result.clone()),
            _ => pending[at].take().unwrap_or(Value::Null),
        });
    }
    Ok(Value::Array(results))
}

// ---------------------------------------------------------------------------
// indexer: FileIndexer
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum NameOnlyMode {
    Pending,
    Throws,
    Answer(Vec<String>),
}

fn name_only_mode(spec: &Value) -> NameOnlyMode {
    match spec {
        Value::String(_) => NameOnlyMode::Pending,
        other
            if other
                .get("throws")
                .is_some_and(|t| t != &Value::Bool(false)) =>
        {
            NameOnlyMode::Throws
        }
        other => NameOnlyMode::Answer(strings_of(other.get("answer"))),
    }
}

/// the fake worker, timers, clock and sources of one `FileIndexer` scenario
struct World {
    log: Vec<Vec<Value>>,
    clock: f64,
    roots: Vec<String>,
    extra: Vec<String>,
    /// `sources.nameOnly` exists
    has_name_only: bool,
    name_only: NameOnlyMode,
    pending_name_only: bool,
    spawned: u64,
    next_timer: u64,
    /// timers set and not yet fired or cleared, with their kind
    timers: Vec<(u64, TimerKind)>,
    /// the number each kind was last set with
    last: Vec<(TimerKind, u64)>,
    immediates: usize,
    next_spawn_error: Option<String>,
    next_post_error: Option<String>,
}

impl World {
    fn log(&mut self, line: Vec<Value>) {
        self.log.push(line);
    }

    fn number_of(&self, kind: TimerKind) -> u64 {
        self.last
            .iter()
            .rev()
            .find(|(known, _)| *known == kind)
            .map_or(0, |(_, n)| *n)
    }
}

fn request_json(request: &WorkerRequest) -> Value {
    match request {
        WorkerRequest::Extract { id, path } => json!({ "id": id, "type": "extract", "path": path }),
        WorkerRequest::Scan { id, root } => json!({ "id": id, "type": "scan", "root": root }),
    }
}

impl IndexerHost for World {
    fn now_ms(&mut self) -> f64 {
        self.clock
    }

    fn roots(&mut self) -> Vec<String> {
        self.log(vec!["roots".into()]);
        self.roots.clone()
    }

    fn extra_paths(&mut self) -> Vec<String> {
        self.log(vec!["extraPaths".into()]);
        self.extra.clone()
    }

    fn name_only(&mut self, paths: &[String]) -> Option<NameOnlyCall> {
        if !self.has_name_only {
            return None;
        }
        self.log(vec!["nameOnly".into(), Value::from(paths.to_vec())]);
        Some(match self.name_only.clone() {
            NameOnlyMode::Pending => {
                self.pending_name_only = true;
                NameOnlyCall::Pending
            }
            NameOnlyMode::Throws => NameOnlyCall::Done(Err(())),
            NameOnlyMode::Answer(list) => NameOnlyCall::Done(Ok(list.into_iter().collect())),
        })
    }

    fn set_timer(&mut self, kind: TimerKind, ms: f64) {
        let n = self.next_timer;
        self.next_timer += 1;
        self.log(vec![
            "setTimeout".into(),
            Value::from(n as f64),
            Value::from(ms),
        ]);
        self.timers.push((n, kind));
        self.last.push((kind, n));
    }

    fn clear_timer(&mut self, kind: TimerKind) {
        let n = self.number_of(kind);
        self.log(vec!["clearTimeout".into(), Value::from(n as f64)]);
        self.timers.retain(|(known, _)| *known != n);
    }

    fn set_immediate(&mut self) {
        self.log(vec!["setImmediate".into()]);
        self.immediates += 1;
    }

    fn spawn_worker(&mut self, heap_limit_mb: f64) -> Result<WorkerId, String> {
        let n = self.spawned + 1;
        self.log(vec![
            "spawn".into(),
            Value::from(n as f64),
            Value::from(heap_limit_mb),
        ]);
        if let Some(message) = self.next_spawn_error.take() {
            return Err(message);
        }
        self.spawned = n;
        Ok(n)
    }

    fn post(&mut self, worker: WorkerId, request: &WorkerRequest) -> Result<(), String> {
        self.log(vec![
            "post".into(),
            Value::from(worker as f64),
            request_json(request),
        ]);
        match self.next_post_error.take() {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    fn terminate(&mut self, worker: WorkerId) {
        self.log(vec!["terminate".into(), Value::from(worker as f64)]);
    }
}

fn extracted_of(spec: &Value) -> Extracted {
    match spec.get("kind").and_then(Value::as_str) {
        Some("text") => Extracted::Text(string_of(spec, "text")),
        Some("name-only") => Extracted::NameOnly,
        _ => Extracted::Error(string_of(spec, "error")),
    }
}

fn worker_response_of(spec: &Value) -> Option<WorkerResponse> {
    let id = spec.get("id").and_then(Value::as_f64)?;
    match spec.get("type").and_then(Value::as_str) {
        Some("extract") => Some(WorkerResponse::Extract {
            id,
            result: extracted_of(spec.get("result")?),
        }),
        Some("scan") => Some(WorkerResponse::Scan {
            id,
            files: spec
                .get("files")
                .and_then(Value::as_array)
                .map(|files| files.iter().map(scanned_of).collect())
                .unwrap_or_default(),
            truncated: spec.get("truncated") == Some(&Value::Bool(true)),
        }),
        _ => None,
    }
}

fn indexer_scenario(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("spec"))?;
    let db = string_of(spec, "db");
    let store = FileIndexStore::new(&db).map_err(|e| CallError::plain(e.0))?;
    let mut world = World {
        log: Vec::new(),
        clock: cx.now_ms,
        roots: strings_of(spec.get("roots")),
        extra: strings_of(spec.get("extra")),
        has_name_only: spec.get("nameOnly").is_some(),
        name_only: spec
            .get("nameOnly")
            .map_or(NameOnlyMode::Answer(Vec::new()), name_only_mode),
        pending_name_only: false,
        spawned: 0,
        next_timer: 1,
        timers: Vec::new(),
        last: Vec::new(),
        immediates: 0,
        next_spawn_error: None,
        next_post_error: None,
    };
    let defaults = IndexerConfig::default();
    let mut indexer = FileIndexer::new(IndexerConfig {
        request_timeout_ms: spec
            .get("requestTimeoutMs")
            .and_then(Value::as_f64)
            .unwrap_or(defaults.request_timeout_ms),
        worker_heap_limit_mb: defaults.worker_heap_limit_mb,
        worker_idle_ms: spec
            .get("workerIdleMs")
            .and_then(Value::as_f64)
            .unwrap_or(defaults.worker_idle_ms),
    });
    let answer = indexer_steps(spec, &mut indexer, &mut world, &store, cx.now_ms);
    indexer.stop(&mut world);
    drop(store);
    remove_database(&db);
    cx.logs.append(&mut world.log);
    answer
}

fn indexer_steps(
    spec: &Value,
    indexer: &mut FileIndexer,
    world: &mut World,
    store: &FileIndexStore,
    now: f64,
) -> Answer {
    let steps = spec
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| CallError::plain("steps"))?;
    let fail = |e: StoreError| CallError::plain(e.0);
    let mut out = Vec::new();
    for step in steps {
        let op = string_of(step, "op");
        let worker = step.get("worker").and_then(Value::as_f64).unwrap_or(0.0) as u64;
        let mut result = Value::Null;
        match op.as_str() {
            "refresh" => indexer.refresh(world),
            "refreshIfStale" => indexer
                .refresh_if_stale(
                    world,
                    store,
                    step.get("maxAgeMs")
                        .and_then(Value::as_f64)
                        .unwrap_or(f64::NAN),
                )
                .map_err(fail)?,
            "scan" => indexer.scan(world, store).map_err(fail)?,
            "stop" => indexer.stop(world),
            "clock" => world.clock = now + step.get("ms").and_then(Value::as_f64).unwrap_or(0.0),
            "timer" => {
                let n = step.get("n").and_then(Value::as_f64).unwrap_or(0.0) as u64;
                if let Some(at) = world.timers.iter().position(|(known, _)| *known == n) {
                    let (_, kind) = world.timers.remove(at);
                    indexer.on_timer(world, store, kind).map_err(fail)?;
                }
            }
            "immediate" => {
                let pending = std::mem::take(&mut world.immediates);
                for _ in 0..pending {
                    indexer.on_immediate(world, store).map_err(fail)?;
                }
            }
            "message" => {
                if (1..=world.spawned).contains(&worker)
                    && let Some(message) = step.get("msg").and_then(worker_response_of)
                {
                    indexer
                        .on_worker_message(world, store, message)
                        .map_err(fail)?;
                }
            }
            "error" | "exit" => {
                if (1..=world.spawned).contains(&worker) {
                    indexer.on_worker_drop(world, store, worker).map_err(fail)?;
                }
            }
            "failNext" => {
                if let Some(message) = step.get("spawn").and_then(Value::as_str) {
                    world.next_spawn_error = Some(message.to_owned());
                }
                if let Some(message) = step.get("post").and_then(Value::as_str) {
                    world.next_post_error = Some(message.to_owned());
                }
            }
            "nameOnlyMode" => {
                world.name_only = step
                    .get("mode")
                    .map_or(NameOnlyMode::Answer(Vec::new()), name_only_mode);
            }
            "nameOnly" => {
                if std::mem::take(&mut world.pending_name_only) {
                    let answer: HashSet<String> =
                        strings_of(step.get("answer")).into_iter().collect();
                    indexer
                        .on_name_only(world, store, Ok(answer))
                        .map_err(fail)?;
                }
            }
            "roots" => world.roots = strings_of(step.get("roots")),
            "progress" => {
                let progress = indexer.progress(store).map_err(fail)?;
                result = serde_json::to_value(&progress).expect("progress prints");
            }
            "running" => result = Value::Bool(indexer.worker_is_running()),
            "listAll" => result = list_all_json(store).map_err(CallError::plain)?,
            other => return Err(CallError::plain(format!("no such step: {other}"))),
        }
        out.push(result);
    }
    Ok(Some(Value::Array(out)))
}
