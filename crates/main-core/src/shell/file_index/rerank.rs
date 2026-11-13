//! `apps/shell/src/main/file-index/rerank.ts`: the home-search reranker over
//! the decision models of `decider`.
//!
//! The class `SearchReranker` is [`SearchReranker`], a struct the caller owns.
//! What its constructor took (the store, the transport, the `sendable`
//! callback) is passed to each call. A promise is a plain call, except where
//! the TypeScript's behavior is the promise itself: a second request for the
//! key of one still out joins it, so [`SearchReranker::rerank`] answers
//! [`RerankStart::Join`] there and the caller, which drives the first
//! request's [`SearchReranker::judge`], hands its answer to the joiner.

use jscompat::node_path::host::{basename, dirname};
use jscompat::{
    JsObject, JsonValue, inherited_string, js_regex, slice_utf16, sort_by_number, trim,
};
use serde_json::{Map, Value};

use super::decider::{
    DecisionCallOptions, JevDocument, JevTransport, MAX_DOCS, evaluate, is_local_endpoint,
};
use super::store::{ExcerptHit, FileIndexStore};
use crate::packages::electron_utils::unsaved_files::{OpenFilesHolder, without_unsaved_files};
use crate::shell::home_api::{
    DecisionEndpoint, EndpointKeys, FileSearchRerank, FileSearchSettings, is_cloudflare_endpoint,
};

const EXCERPT_CHARS: f64 = 1200.0;
const CACHE_TTL_MS: f64 = 30.0 * 60.0 * 1000.0;
const CACHE_MAX: usize = 200;

/// `DEFAULT_FILE_SEARCH_SETTINGS`
pub fn default_file_search_settings() -> FileSearchSettings {
    FileSearchSettings {
        rerank: false,
        endpoint: DecisionEndpoint::Openrouter,
        keys: EndpointKeys::empty(),
        custom_base_url: String::new(),
        custom_model: String::new(),
        cloudflare_account_id: String::new(),
        cloudflare_model: "@cf/cloudflare/clef".to_owned(),
    }
}

/// `r.name` of an object, `None` where it is absent (`undefined`)
fn read<'a>(r: &'a JsonValue, key: &str) -> Option<std::borrow::Cow<'a, JsonValue>> {
    r.get(key)
}

/// `typeof v === 'string' ? v.trim().slice(0, n) : ''`, the slice in UTF-16 units
fn text(v: Option<&JsonValue>, n: f64) -> String {
    match v {
        Some(JsonValue::String(s)) => slice_utf16(trim(s), 0.0, Some(n)),
        _ => String::new(),
    }
}

/// `a ?? b`: `b` where `a` is `undefined` or `null`
fn first_set<'a>(
    a: Option<std::borrow::Cow<'a, JsonValue>>,
    b: Option<std::borrow::Cow<'a, JsonValue>>,
) -> Option<std::borrow::Cow<'a, JsonValue>> {
    match a {
        Some(v) if !matches!(*v, JsonValue::Null) => Some(v),
        _ => match b {
            Some(v) if !matches!(*v, JsonValue::Null) => Some(v),
            other => other,
        },
    }
}

/// Accepts the current settings shape and the pre-decision-model one
/// (`jevEndpoint`/`jevKeys` with only the two hosted Jev routes) so existing
/// app-settings.json files keep working; anything unknown falls back to the
/// OpenRouter default.
pub fn normalize_file_search_settings(raw: &JsonValue) -> FileSearchSettings {
    // `raw && typeof raw === 'object' ? raw : {}`: an array is an object here
    let empty = JsonValue::Object(JsObject::new());
    let r = match raw {
        JsonValue::Object(_) | JsonValue::Array(_) => raw,
        _ => &empty,
    };
    // `r.keys ?? r.jevKeys ?? {}`: an array has no own `keys`, and its inherited
    // `keys` is a function that holds no key of an endpoint
    let keys_raw = first_set(read(r, "keys"), read(r, "jevKeys"));
    let key = |v: Option<&JsonValue>| match v {
        Some(JsonValue::String(s)) => slice_utf16(trim(s), 0.0, Some(512.0)),
        _ => String::new(),
    };
    let endpoint_raw = first_set(read(r, "endpoint"), read(r, "jevEndpoint"));
    let endpoint = match endpoint_raw.as_deref() {
        Some(JsonValue::String(id)) => DecisionEndpoint::from_id(id),
        _ => None,
    }
    .unwrap_or(DecisionEndpoint::Openrouter);
    let mut keys = EndpointKeys::empty();
    for id in DecisionEndpoint::ALL {
        let value = keys_raw.as_deref().and_then(|k| match k {
            JsonValue::Object(o) => o.get(id.id()),
            _ => None,
        });
        keys.set(id, key(value));
    }
    let cloudflare_model = text(read(r, "cloudflareModel").as_deref(), 256.0);
    FileSearchSettings {
        rerank: matches!(read(r, "rerank").as_deref(), Some(JsonValue::Bool(true))),
        endpoint,
        keys,
        custom_base_url: text(read(r, "customBaseUrl").as_deref(), 512.0),
        custom_model: text(read(r, "customModel").as_deref(), 128.0),
        cloudflare_account_id: text(read(r, "cloudflareAccountId").as_deref(), 128.0),
        cloudflare_model: if cloudflare_model.is_empty() {
            default_file_search_settings().cloudflare_model
        } else {
            cloudflare_model
        },
    }
}

/// Per-call view of the settings the decision client needs.
fn call_options(s: &FileSearchSettings) -> DecisionCallOptions {
    DecisionCallOptions {
        endpoint: s.endpoint,
        key: s.keys.get(s.endpoint).to_owned(),
        custom_base_url: s.custom_base_url.clone(),
        custom_model: s.custom_model.clone(),
        cloudflare_account_id: s.cloudflare_account_id.clone(),
        cloudflare_model: s.cloudflare_model.clone(),
    }
}

/// What a request that throws throws: the message of its error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RerankError(pub String);

/// `this.sendable`: narrows the candidates whose excerpts may leave the
/// machine; `Err` is what its promise rejects with.
pub type Sendable<'a> = &'a mut dyn FnMut(&[String]) -> Result<Vec<String>, String>;

struct CacheEntry {
    at: f64,
    result: FileSearchRerank,
}

/// What `rerank` leaves to the caller.
#[derive(Debug, Clone, PartialEq)]
pub enum RerankStart {
    /// settled without a call: the answer (`null` is `None`)
    Ready(Option<FileSearchRerank>),
    /// a request for this key is out: its answer is this request's
    Join(String),
    /// run [`SearchReranker::judge`] on it
    Judge(JudgeJob),
}

/// The request `judge` runs.
#[derive(Debug, Clone, PartialEq)]
pub struct JudgeJob {
    cache_key: String,
    q: String,
    hits: Vec<ExcerptHit>,
    opts: DecisionCallOptions,
}

impl JudgeJob {
    /// the key a joining request names
    pub fn cache_key(&self) -> &str {
        &self.cache_key
    }
}

/// Reranks the hits the home screen is showing with a decision model; the
/// caller names the candidates so the judged set is exactly the displayed
/// one. Judgements are cached per query and candidate set for half an hour so
/// retyping the same words does not bill twice. Any failure yields `None` and
/// the caller keeps the local order.
pub struct SearchReranker {
    cache: jscompat::JsMap<CacheEntry>,
    /// the keys of the requests that are out
    inflight: Vec<String>,
}

impl Default for SearchReranker {
    fn default() -> Self {
        SearchReranker::new()
    }
}

impl SearchReranker {
    pub fn new() -> SearchReranker {
        SearchReranker {
            cache: jscompat::JsMap::new(),
            inflight: Vec::new(),
        }
    }

    pub fn rerank(
        &mut self,
        store: &FileIndexStore,
        holder: &OpenFilesHolder,
        sendable: Option<Sendable<'_>>,
        transport: &mut dyn JevTransport,
        q: &str,
        paths: &[String],
        settings: &FileSearchSettings,
    ) -> Result<RerankStart, RerankError> {
        let opts = call_options(settings);
        // local servers (Kev, Rizzo Flow, a custom URL) run without credentials
        if !settings.rerank || (!is_local_endpoint(settings.endpoint) && opts.key.is_empty()) {
            return Ok(RerankStart::Ready(None));
        }
        if settings.endpoint == DecisionEndpoint::Custom
            && trim(&settings.custom_base_url).is_empty()
        {
            return Ok(RerankStart::Ready(None));
        }
        if is_cloudflare_endpoint(settings.endpoint)
            && trim(&settings.cloudflare_account_id).is_empty()
        {
            return Ok(RerankStart::Ready(None));
        }
        // the index holds a file as it was last saved; one being edited may carry a
        // withholding mark that has not reached the disk, so its excerpt stays here
        let saved_only = without_unsaved_files(holder, paths, |path| path.clone());
        let saved = match sendable {
            Some(sendable) => sendable(&saved_only).map_err(RerankError)?,
            None => saved_only,
        };
        let hits = store
            .excerpts_for(&saved[..saved.len().min(MAX_DOCS)], q, EXCERPT_CHARS)
            .map_err(|e| RerankError(e.0))?;
        if hits.len() < 2 {
            return Ok(RerankStart::Ready(None));
        }
        let mut parts = vec![
            settings.endpoint.id().to_owned(),
            settings.custom_base_url.clone(),
            settings.custom_model.clone(),
            settings.cloudflare_account_id.clone(),
            settings.cloudflare_model.clone(),
            q.to_owned(),
        ];
        parts.extend(hits.iter().map(|h| h.path.clone()));
        let cache_key = parts.join("\n");
        if let Some(cached) = self.cache.get(&cache_key)
            && transport.now_ms() - cached.at < CACHE_TTL_MS
        {
            return Ok(RerankStart::Ready(Some(cached.result.clone())));
        }
        if self.inflight.contains(&cache_key) {
            return Ok(RerankStart::Join(cache_key));
        }
        self.inflight.push(cache_key.clone());
        Ok(RerankStart::Judge(JudgeJob {
            cache_key,
            q: q.to_owned(),
            hits,
            opts,
        }))
    }

    /// `judge`, then the `finally` that takes the request out of the flight.
    pub fn judge(
        &mut self,
        job: JudgeJob,
        transport: &mut dyn JevTransport,
    ) -> Option<FileSearchRerank> {
        let result = self.judged(&job, transport);
        self.inflight.retain(|key| *key != job.cache_key);
        result
    }

    fn judged(
        &mut self,
        job: &JudgeJob,
        transport: &mut dyn JevTransport,
    ) -> Option<FileSearchRerank> {
        let docs: Vec<JevDocument> = job
            .hits
            .iter()
            .map(|h| JevDocument {
                title: h.name.clone(),
                heading: basename(&dirname(&h.path), None),
                text: h.excerpt.clone(),
            })
            .collect();
        let scores = match evaluate(&job.q, &docs, &job.opts, transport) {
            Ok(judgement) => judgement.scores,
            Err(_) => return None,
        };
        let judged = &job.hits[..scores.len().min(job.hits.len())];
        let mut order: Vec<(&str, f64, usize)> = judged
            .iter()
            .enumerate()
            .map(|(i, h)| (h.path.as_str(), scores[i], i))
            .collect();
        // b.score - a.score || a.i - b.i
        sort_by_number(&mut order, |a, b| {
            let by_score = b.1 - a.1;
            if by_score != 0.0 && !by_score.is_nan() {
                by_score
            } else {
                a.2 as f64 - b.2 as f64
            }
        });
        let mut scores_by_path = JsObject::new();
        for (path, score, _) in &order {
            scores_by_path.set(*path, *score);
        }
        let result = FileSearchRerank {
            order: order
                .iter()
                .map(|(path, _, _)| (*path).to_owned())
                .collect(),
            scores: scores_by_path,
        };
        if self.cache.len() >= CACHE_MAX
            && let Some(oldest) = self.cache.keys().next().map(str::to_owned)
        {
            self.cache.delete(&oldest);
        }
        self.cache.set(
            job.cache_key.clone(),
            CacheEntry {
                at: transport.now_ms(),
                result: result.clone(),
            },
        );
        Some(result)
    }
}

fn probe_docs() -> Vec<JevDocument> {
    vec![
        JevDocument {
            title: "a.md".to_owned(),
            heading: String::new(),
            text: "The connection test document.".to_owned(),
        },
        JevDocument {
            title: "b.md".to_owned(),
            heading: String::new(),
            text: "An unrelated note.".to_owned(),
        },
    ]
}

/// what the settings UI shows for each failure the decision client can report
fn probe_error(code: &str) -> Option<&'static str> {
    Some(match code {
        "missing-key" => "Enter an API key",
        "missing-url" => "Enter the server URL",
        "missing-account" => "Enter the Cloudflare account ID",
        "bad-url" => "Server URL is not a valid address",
        "insecure-url" => "Server URL must be https:// (http:// only for this machine)",
        "unsupported-model" => "Cloudflare only serves clef, clef-flash and clef-omni",
        "empty-request" => "Nothing to judge",
        "rate-limit" => "Rate limited \u{2014} try again shortly",
        "response-too-large" => "The reply was too large",
        "invalid-response" => "The endpoint returned an unexpected reply",
        "model-mismatch" => "The endpoint answered with a different model",
        "provider-warning" => "The provider reported a warning",
        "cancelled" => "The call timed out",
        _ => return None,
    })
}

/// `{ ok: boolean; error?: string }`
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeResult {
    pub ok: bool,
    /// `None` leaves the key out. A message the lookup finds on
    /// `Object.prototype` (a table `PROBE_ERRORS[code]` that does not own
    /// `code`) is a function there, which `JSON.stringify` leaves out, or for
    /// `__proto__` the prototype object itself, which it writes as `{}`.
    pub error: Option<Value>,
}

impl ProbeResult {
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("ok".into(), Value::Bool(self.ok));
        if let Some(error) = &self.error {
            out.insert("error".into(), error.clone());
        }
        Value::Object(out)
    }
}

/// the settings-UI connection test: one two-document judgement against the given settings
pub fn probe_decision(
    settings: &FileSearchSettings,
    transport: &mut dyn JevTransport,
) -> ProbeResult {
    let opts = call_options(settings);
    if !is_local_endpoint(settings.endpoint) && trim(&opts.key).is_empty() {
        return ProbeResult {
            ok: false,
            error: probe_error("missing-key").map(Value::from),
        };
    }
    match evaluate("connection test", &probe_docs(), &opts, transport) {
        Ok(_) => ProbeResult {
            ok: true,
            error: None,
        },
        Err(e) => {
            let code = e.0;
            let http = js_regex!(r"^http-(\d+)$").exec(&code);
            let error = match probe_error(&code) {
                Some(message) => Some(Value::from(message)),
                // the lookup answers from Object.prototype before the fallbacks
                None if code == "__proto__" => Some(Value::Object(Map::new())),
                None if inherited_string(&code).is_some() => None,
                None => Some(match http {
                    Some(m) => Value::from(format!("HTTP {}", m.get(1).unwrap_or(""))),
                    None => Value::from(code.clone()),
                }),
            };
            ProbeResult { ok: false, error }
        }
    }
}
