//! `packages/ai-provider/src/local-models.ts`: discovery and inspection of a
//! user-hosted local AI server, the probe behind the settings screen's local
//! AI card. Two wire shapes are understood: Ollama's own API (`/api/tags`,
//! `/api/show`, `/api/ps`) and the generic OpenAI-compatible `/v1/models`
//! route.
//!
//! Nothing here throws: "nothing is listening" is an ordinary answer. A
//! result carries a code and, for an HTTP failure, the status; the server's
//! body is never passed along.
//!
//! Not `aiFetch`: a probe of a server that is very often simply not running
//! must neither retry nor warn. The request goes through the global `fetch`
//! ([`Fetcher::Node`]) and [`with_user_agent`].
//!
//! The probes' addresses are parsed once by [`normalized_base_of`], so the
//! later `new URL(...)` and `endpointUrl(...)` of the TypeScript cannot throw
//! here; where the type system still has an `Err`, it is the TypeScript's
//! outer `catch`: `unreachable`.

use jscompat::{JsonValue, js_regex, json_parse, json_stringify, trim};

use super::effort::{ai_effort_of, ai_efforts_of};
use super::fetch::{AiFetch, Init, KeyedFetchBase, keyed_fetch, with_user_agent};
use super::jsval::{Obj, as_record, number, object, text};
use super::protocols_shared::{CappedReadOptions, endpoint_url, read_capped_response_text};
use super::task::{Fetcher, Request, RequestBody, Rt, Signal};
use super::watchdog::create_stream_watchdog;

/// `AiLocalServerKind`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiLocalServerKind {
    Ollama,
    OpenAiCompatible,
}

impl AiLocalServerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AiLocalServerKind::Ollama => "ollama",
            AiLocalServerKind::OpenAiCompatible => "openai-compatible",
        }
    }

    /// `'ollama'` or `'openai-compatible'`, anything else is `None`
    pub fn of(value: Option<&JsonValue>) -> Option<AiLocalServerKind> {
        match value {
            Some(JsonValue::String(s)) if s == "ollama" => Some(AiLocalServerKind::Ollama),
            Some(JsonValue::String(s)) if s == "openai-compatible" => {
                Some(AiLocalServerKind::OpenAiCompatible)
            }
            _ => None,
        }
    }
}

/// `AiLocalDiscoveryErrorCode`: why a probe produced nothing. `Unreachable`
/// nothing answered at the address, `Timeout` something is listening but did
/// not answer in time, `Http` a route refused the request, `Shape` a route
/// answered with something that is not this API.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiLocalDiscoveryErrorCode {
    Unreachable,
    Timeout,
    Http,
    Shape,
}

impl AiLocalDiscoveryErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            AiLocalDiscoveryErrorCode::Unreachable => "unreachable",
            AiLocalDiscoveryErrorCode::Timeout => "timeout",
            AiLocalDiscoveryErrorCode::Http => "http",
            AiLocalDiscoveryErrorCode::Shape => "shape",
        }
    }
}

/// `AiLocalFailure`: `{ ok: false, errorCode, status? }`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AiLocalFailure {
    pub error_code: AiLocalDiscoveryErrorCode,
    pub status: Option<f64>,
}

impl AiLocalFailure {
    pub fn to_json(&self) -> JsonValue {
        let mut entries = vec![
            ("ok", JsonValue::Bool(false)),
            ("errorCode", text(self.error_code.as_str())),
        ];
        if let Some(status) = self.status {
            entries.push(("status", number(status)));
        }
        object(entries)
    }
}

/// `failureOf(errorCode, status)`
fn failure_of(error_code: AiLocalDiscoveryErrorCode, status: Option<f64>) -> AiLocalFailure {
    AiLocalFailure { error_code, status }
}

/// `AiLocalModelSummary`: one model a local server advertises, as far as
/// discovery could tell
#[derive(Debug, Clone, PartialEq)]
pub struct AiLocalModelSummary {
    /// the id the server takes in a request; a colon (`qwen3:8b`) is part of it
    pub id: String,
    /// disk size in bytes, when Ollama reported it
    pub size_bytes: Option<f64>,
    /// parameter count label (`8.2B`), when Ollama reported it
    pub parameter_size: Option<String>,
    /// quantization label (`Q4_K_M`), when Ollama reported it
    pub quantization: Option<String>,
}

impl AiLocalModelSummary {
    fn of_id(id: String) -> AiLocalModelSummary {
        AiLocalModelSummary {
            id,
            size_bytes: None,
            parameter_size: None,
            quantization: None,
        }
    }

    pub fn to_json(&self) -> JsonValue {
        let mut entries = vec![("id", text(self.id.clone()))];
        if let Some(size) = self.size_bytes {
            entries.push(("sizeBytes", number(size)));
        }
        if let Some(size) = &self.parameter_size {
            entries.push(("parameterSize", text(size.clone())));
        }
        if let Some(quantization) = &self.quantization {
            entries.push(("quantization", text(quantization.clone())));
        }
        object(entries)
    }
}

/// `AiLocalDiscoveryResult`
#[derive(Debug, Clone, PartialEq)]
pub enum AiLocalDiscoveryResult {
    Ok {
        server: AiLocalServerKind,
        models: Vec<AiLocalModelSummary>,
    },
    Failed(AiLocalFailure),
}

impl AiLocalDiscoveryResult {
    pub fn to_json(&self) -> JsonValue {
        match self {
            AiLocalDiscoveryResult::Ok { server, models } => object(vec![
                ("ok", JsonValue::Bool(true)),
                ("server", text(server.as_str())),
                (
                    "models",
                    JsonValue::Array(models.iter().map(AiLocalModelSummary::to_json).collect()),
                ),
            ]),
            AiLocalDiscoveryResult::Failed(failure) => failure.to_json(),
        }
    }
}

/// `AiLocalInspection`: what one model's server-side profile says, when it
/// says anything at all. The fields are in the order the TypeScript sets them.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AiLocalInspection {
    /// absent when the server listed no capabilities at all
    pub tools: Option<bool>,
    /// absent when the server listed no capabilities at all
    pub vision: Option<bool>,
    /// the effort levels the model takes (`thinking.values`); empty when the
    /// server's capability list says the model does not think, absent when
    /// it says nothing
    pub efforts: Option<Vec<&'static str>>,
    pub default_effort: Option<&'static str>,
    /// the full window the model was built with (`model_info.*.context_length`)
    pub context_length: Option<f64>,
    /// the window the loaded instance is running with (`/api/ps`)
    pub running_context_length: Option<f64>,
}

impl AiLocalInspection {
    pub fn to_json(&self) -> JsonValue {
        let mut entries = Vec::new();
        if let Some(tools) = self.tools {
            entries.push(("tools", JsonValue::Bool(tools)));
        }
        if let Some(vision) = self.vision {
            entries.push(("vision", JsonValue::Bool(vision)));
        }
        if let Some(efforts) = &self.efforts {
            entries.push(("efforts", super::jsval::string_list(efforts)));
        }
        if let Some(effort) = self.default_effort {
            entries.push(("defaultEffort", text(effort)));
        }
        if let Some(length) = self.context_length {
            entries.push(("contextLength", number(length)));
        }
        if let Some(length) = self.running_context_length {
            entries.push(("runningContextLength", number(length)));
        }
        object(entries)
    }
}

/// `AiLocalInspectionResult`
#[derive(Debug, Clone, PartialEq)]
pub enum AiLocalInspectionResult {
    Ok { profile: AiLocalInspection },
    Failed(AiLocalFailure),
}

impl AiLocalInspectionResult {
    pub fn to_json(&self) -> JsonValue {
        match self {
            AiLocalInspectionResult::Ok { profile } => object(vec![
                ("ok", JsonValue::Bool(true)),
                ("profile", profile.to_json()),
            ]),
            AiLocalInspectionResult::Failed(failure) => failure.to_json(),
        }
    }
}

/// `AiLocalDiscoveryRequest`
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AiLocalDiscoveryRequest {
    /// the address the user saved; an OpenAI-compatible base normally ends in `/v1`
    pub base_url: String,
    /// sent as `Authorization: Bearer ...` only when non-empty
    pub api_key: Option<String>,
}

/// `AiLocalRequestOptions`: what a caller in the main process may add to a
/// request. Aborting the signal ends the request in flight and sends no
/// further one.
#[derive(Clone, Default)]
pub struct AiLocalRequestOptions {
    pub signal: Option<Signal>,
}

/// `AiLocalInspectionRequest`
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AiLocalInspectionRequest {
    pub base_url: String,
    pub api_key: Option<String>,
    /// the id the server listed
    pub model: String,
    /// the kind discovered earlier; probed once when absent
    pub server: Option<AiLocalServerKind>,
}

/// `REQUEST_TIMEOUT_MS`: a server this slow is not usable for chat either
const REQUEST_TIMEOUT_MS: f64 = 5000.0;

/// `MAX_MODELS`: ids past this are dropped
const MAX_MODELS: usize = 2000;

/// `MAX_BODY_BYTES`: past this the endpoint is not what it claims
const MAX_BODY_BYTES: f64 = 2.0 * 1024.0 * 1024.0;

/// `trimmedString(value)`
fn trimmed_string(value: Option<&JsonValue>) -> String {
    match value {
        Some(JsonValue::String(s)) => trim(s).to_owned(),
        _ => String::new(),
    }
}

/// `parseJson(text)`: a parse error is a `shape` answer
fn parse_json(body: &str) -> Option<JsonValue> {
    json_parse(body).ok()
}

/// `typeof value === 'number' && Number.isFinite(value) && value > 0`
fn positive_number(value: Option<&JsonValue>) -> Option<f64> {
    match value {
        Some(JsonValue::Number(x)) if x.is_finite() && *x > 0.0 => Some(*x),
        _ => None,
    }
}

/// `normalizedBaseOf(raw)`: the saved address with trailing slashes removed,
/// or `None` for anything that is not an `http(s)` URL.
pub fn normalized_base_of(raw: &str) -> Option<String> {
    let trimmed = js_regex!(r"/+$").replace_all(trim(raw), |_| String::new());
    if trimmed.is_empty() {
        return None;
    }
    let url = url::Url::parse(&trimmed).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    Some(trimmed)
}

/// `ollamaRootOf(base)`: the server root Ollama's own routes live under; the
/// saved base normally ends in `/v1`, which is not part of `/api/tags`.
fn ollama_root_of(base: &str) -> String {
    let Ok(mut url) = url::Url::parse(base) else {
        return base.to_owned();
    };
    let path = js_regex!(r"/+$").replace_all(url.path(), |_| String::new());
    let root = path.strip_suffix("/v1").unwrap_or(&path).to_owned();
    url.set_path(&root);
    url.to_string()
}

/// `requestHeadersOf(apiKey)`
fn request_headers_of(api_key: Option<&str>) -> Vec<(String, String)> {
    let mut headers = vec![("Accept".to_owned(), "application/json".to_owned())];
    let key = trim(api_key.unwrap_or(""));
    // an empty `Bearer ` is a malformed credential strict servers reject
    if !key.is_empty() {
        headers.push(("Authorization".to_owned(), format!("Bearer {key}")));
    }
    headers
}

/// `endpointUrl(...)` of an address the probe has already parsed
fn endpoint(base: &str, path: &str) -> Result<String, AiLocalFailure> {
    endpoint_url(base, path, None)
        .map_err(|_| failure_of(AiLocalDiscoveryErrorCode::Unreachable, None))
}

/// `requestText(url, init, signal)`: one request, capped and timed out. A
/// timeout surfaces from the watchdog as `AiTimeoutError`; everything else
/// that goes wrong at the network layer is `unreachable`. Body errors only
/// become `shape` when the body was too large.
async fn request_text(
    rt: &Rt,
    fx: &AiFetch,
    url: &str,
    request: Request,
    signal: Option<&Signal>,
) -> Result<String, AiLocalFailure> {
    // the caller's signal (a cancelled connection test) ends the request with it
    let watchdog = create_stream_watchdog(rt, signal, Some(REQUEST_TIMEOUT_MS), None);
    let outcome = watchdog
        .guard(async {
            let init = with_user_agent(
                fx,
                &Init {
                    request,
                    signal: Some(watchdog.signal.clone()),
                },
            );
            let response = keyed_fetch(
                rt,
                fx,
                url,
                &init,
                None,
                &KeyedFetchBase::Plain(Fetcher::Node),
            )
            .await?;
            if !response.ok() {
                // the refusal body is never read; only the status says anything
                response.cancel();
                return Ok(Err(failure_of(
                    AiLocalDiscoveryErrorCode::Http,
                    Some(response.status()),
                )));
            }
            let read = read_capped_response_text(
                &response,
                &CappedReadOptions {
                    max_bytes: Some(MAX_BODY_BYTES),
                    ..CappedReadOptions::default()
                },
            )
            .await;
            match read {
                Ok(body) => Ok(Ok(body)),
                Err(error) if error.is("ResponseBodyTooLargeError") => {
                    Ok(Err(failure_of(AiLocalDiscoveryErrorCode::Shape, None)))
                }
                Err(error) => Err(error),
            }
        })
        .await;
    match outcome {
        Ok(result) => result,
        Err(error) => Err(failure_of(
            if error.is("AiTimeoutError") {
                AiLocalDiscoveryErrorCode::Timeout
            } else {
                AiLocalDiscoveryErrorCode::Unreachable
            },
            None,
        )),
    }
}

/// A `GET` with the given headers
fn get_request(headers: &[(String, String)]) -> Request {
    Request {
        headers: headers.to_vec(),
        ..Request::default()
    }
}

/// `ollamaModelOf(id, entry)`: one Ollama model entry with every malformed
/// field dropped.
fn ollama_model_of(id: String, entry: &Obj) -> AiLocalModelSummary {
    let mut model = AiLocalModelSummary::of_id(id);
    if let Some(JsonValue::Number(size)) = entry.get("size")
        && size.is_finite()
        && *size >= 0.0
    {
        model.size_bytes = Some(*size);
    }
    let details = entry.get("details").and_then(as_record);
    let parameter_size = trimmed_string(details.and_then(|d| d.get("parameter_size")));
    if !parameter_size.is_empty() {
        model.parameter_size = Some(parameter_size);
    }
    let quantization = trimmed_string(details.and_then(|d| d.get("quantization_level")));
    if !quantization.is_empty() {
        model.quantization = Some(quantization);
    }
    model
}

/// `probeOllamaTags(base, headers, signal)`
async fn probe_ollama_tags(
    rt: &Rt,
    fx: &AiFetch,
    base: &str,
    headers: &[(String, String)],
    signal: Option<&Signal>,
) -> Result<Vec<AiLocalModelSummary>, AiLocalFailure> {
    let url = endpoint(&ollama_root_of(base), "api/tags")?;
    let body = request_text(rt, fx, &url, get_request(headers), signal).await?;
    let parsed = parse_json(&body);
    let Some(JsonValue::Array(entries)) = parsed
        .as_ref()
        .and_then(as_record)
        .and_then(|b| b.get("models"))
    else {
        return Err(failure_of(AiLocalDiscoveryErrorCode::Shape, None));
    };
    let mut models: Vec<AiLocalModelSummary> = Vec::new();
    for entry in entries {
        if models.len() >= MAX_MODELS {
            break;
        }
        // one unusable entry must not take the whole list down with it
        let Some(entry) = as_record(entry) else {
            continue;
        };
        let id = trimmed_string(entry.get("name"));
        if id.is_empty() || models.iter().any(|m| m.id == id) {
            continue;
        }
        models.push(ollama_model_of(id, entry));
    }
    Ok(models)
}

/// `probeOpenAiModels(base, headers, signal)`
async fn probe_open_ai_models(
    rt: &Rt,
    fx: &AiFetch,
    base: &str,
    headers: &[(String, String)],
    signal: Option<&Signal>,
) -> Result<Vec<AiLocalModelSummary>, AiLocalFailure> {
    let url = endpoint(base, "models")?;
    let body = request_text(rt, fx, &url, get_request(headers), signal).await?;
    let parsed = parse_json(&body);
    let Some(JsonValue::Array(entries)) = parsed
        .as_ref()
        .and_then(as_record)
        .and_then(|b| b.get("data"))
    else {
        return Err(failure_of(AiLocalDiscoveryErrorCode::Shape, None));
    };
    let mut models: Vec<AiLocalModelSummary> = Vec::new();
    for entry in entries {
        if models.len() >= MAX_MODELS {
            break;
        }
        let id = as_record(entry).map_or_else(String::new, |e| trimmed_string(e.get("id")));
        if id.is_empty() || models.iter().any(|m| m.id == id) {
            continue;
        }
        // the generic route carries ids only; capabilities are never guessed from it
        models.push(AiLocalModelSummary::of_id(id));
    }
    Ok(models)
}

/// `informativenessOf(failure)`: how much a failed probe says about the
/// address. A malformed answer proves something is there but is not this
/// API; a real refusal is nearly as telling; a timeout means something is
/// listening; a 404 only says the route does not exist, and silence says
/// nothing at all.
fn informativeness_of(failure: &AiLocalFailure) -> u8 {
    match failure.error_code {
        AiLocalDiscoveryErrorCode::Shape => 4,
        AiLocalDiscoveryErrorCode::Http => {
            if failure.status != Some(404.0) {
                3
            } else {
                1
            }
        }
        AiLocalDiscoveryErrorCode::Timeout => 2,
        AiLocalDiscoveryErrorCode::Unreachable => 0,
    }
}

/// `mostInformativeFailure(first, second)`: on a tie the second probe wins:
/// `/models` is the route of the address the user saved.
fn most_informative_failure(first: AiLocalFailure, second: AiLocalFailure) -> AiLocalFailure {
    if informativeness_of(&second) >= informativeness_of(&first) {
        second
    } else {
        first
    }
}

/// `listLocalModels(input, options)`: the models a local server advertises.
/// Ollama's `/api/tags` at the server root is tried first; the generic
/// `/models` route of the saved base is the fallback. The first well-formed
/// answer wins. Server order is preserved, duplicate and blank ids are
/// dropped, and the list is capped.
pub async fn list_local_models(
    rt: &Rt,
    fx: &AiFetch,
    input: &AiLocalDiscoveryRequest,
    options: Option<&AiLocalRequestOptions>,
) -> AiLocalDiscoveryResult {
    let Some(base) = normalized_base_of(&input.base_url) else {
        return AiLocalDiscoveryResult::Failed(failure_of(
            AiLocalDiscoveryErrorCode::Unreachable,
            None,
        ));
    };
    let headers = request_headers_of(input.api_key.as_deref());
    let signal = options.and_then(|o| o.signal.as_ref());

    let ollama = match probe_ollama_tags(rt, fx, &base, &headers, signal).await {
        Ok(models) => {
            return AiLocalDiscoveryResult::Ok {
                server: AiLocalServerKind::Ollama,
                models,
            };
        }
        Err(failure) => failure,
    };
    // a cancelled caller wants no second request
    if signal.is_some_and(Signal::aborted) {
        return AiLocalDiscoveryResult::Failed(ollama);
    }

    let generic = match probe_open_ai_models(rt, fx, &base, &headers, signal).await {
        Ok(models) => {
            return AiLocalDiscoveryResult::Ok {
                server: AiLocalServerKind::OpenAiCompatible,
                models,
            };
        }
        Err(failure) => failure,
    };

    AiLocalDiscoveryResult::Failed(most_informative_failure(ollama, generic))
}

/// `resolveServerKind(base, headers)`: the server kind, decided by one
/// `/api/tags` probe: a well-formed answer means Ollama; a 404/405 is how an
/// OpenAI-compatible server says it has no Ollama route; anything else leaves
/// the kind unknown and is returned as the failure it is.
async fn resolve_server_kind(
    rt: &Rt,
    fx: &AiFetch,
    base: &str,
    headers: &[(String, String)],
) -> Result<AiLocalServerKind, AiLocalFailure> {
    let url = endpoint(&ollama_root_of(base), "api/tags")?;
    let tags = match request_text(rt, fx, &url, get_request(headers), None).await {
        Ok(body) => body,
        Err(failure) => {
            let no_ollama_route = failure.error_code == AiLocalDiscoveryErrorCode::Http
                && (failure.status == Some(404.0) || failure.status == Some(405.0));
            return if no_ollama_route {
                Ok(AiLocalServerKind::OpenAiCompatible)
            } else {
                Err(failure)
            };
        }
    };
    let body = parse_json(&tags);
    if matches!(
        body.as_ref()
            .and_then(as_record)
            .and_then(|b| b.get("models")),
        Some(JsonValue::Array(_))
    ) {
        Ok(AiLocalServerKind::Ollama)
    } else {
        Err(failure_of(AiLocalDiscoveryErrorCode::Shape, None))
    }
}

/// `contextLengthOf(raw)`: the first `*.context_length` key in `model_info`,
/// when it carries a usable number.
fn context_length_of(raw: Option<&JsonValue>) -> Option<f64> {
    let raw = as_record(raw?)?;
    for (key, value) in raw.entries() {
        if !key.ends_with(".context_length") {
            continue;
        }
        return positive_number(Some(value));
    }
    None
}

/// `runningContextLengthOf(root, headers, model)`: the context window of the
/// loaded instance, when `/api/ps` names this model. Best effort.
async fn running_context_length_of(
    rt: &Rt,
    fx: &AiFetch,
    root: &str,
    headers: &[(String, String)],
    model: &str,
) -> Option<f64> {
    if model.is_empty() {
        return None;
    }
    let url = endpoint(root, "api/ps").ok()?;
    let body = request_text(rt, fx, &url, get_request(headers), None)
        .await
        .ok()?;
    let parsed = parse_json(&body)?;
    let JsonValue::Array(entries) = as_record(&parsed)?.get("models")? else {
        return None;
    };
    for entry in entries {
        let Some(entry) = as_record(entry) else {
            continue;
        };
        // old `/api/ps` answers name the model `name`, newer ones also carry `model`
        let names = [
            trimmed_string(entry.get("name")),
            trimmed_string(entry.get("model")),
        ];
        if !names.iter().any(|n| n == model) {
            continue;
        }
        return positive_number(entry.get("context_length"));
    }
    None
}

/// `inspectOllamaModel(base, headers, model)`
async fn inspect_ollama_model(
    rt: &Rt,
    fx: &AiFetch,
    base: &str,
    headers: &[(String, String)],
    model: &str,
) -> AiLocalInspectionResult {
    let root = ollama_root_of(base);
    let failed = AiLocalInspectionResult::Failed;
    let url = match endpoint(&root, "api/show") {
        Ok(url) => url,
        Err(failure) => return failed(failure),
    };
    let mut show_headers = headers.to_vec();
    show_headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
    let request = Request {
        method: Some("POST".to_owned()),
        headers: show_headers,
        body: Some(RequestBody::Text(json_stringify(&object(vec![(
            "model",
            text(model),
        )])))),
        ..Request::default()
    };
    let show = match request_text(rt, fx, &url, request, None).await {
        Ok(body) => body,
        Err(failure) => return failed(failure),
    };
    let parsed = parse_json(&show);
    let Some(body) = parsed.as_ref().and_then(as_record) else {
        return failed(failure_of(AiLocalDiscoveryErrorCode::Shape, None));
    };

    let mut profile = AiLocalInspection::default();
    // An explicit list is the server's complete statement: a missing entry is a
    // "no". With no list at all the server said nothing, so both stay unknown.
    if let Some(JsonValue::Array(capabilities)) = body.get("capabilities") {
        let has = |name: &str| {
            capabilities
                .iter()
                .any(|c| matches!(c, JsonValue::String(s) if s == name))
        };
        profile.tools = Some(has("tools"));
        profile.vision = Some(has("vision"));
        if !has("thinking") {
            profile.efforts = Some(Vec::new());
        }
    }
    // named levels (`think: "high"`); a model that only turns thinking on or off lists none
    let thinking = body.get("thinking").and_then(as_record);
    if let Some(efforts) = ai_efforts_of(thinking.and_then(|t| t.get("values"))) {
        let default_effort = ai_effort_of(thinking.and_then(|t| t.get("default")));
        profile.default_effort = default_effort.filter(|d| efforts.contains(d));
        profile.efforts = Some(efforts);
    }
    profile.context_length = context_length_of(body.get("model_info"));

    profile.running_context_length = running_context_length_of(rt, fx, &root, headers, model).await;

    AiLocalInspectionResult::Ok { profile }
}

/// `inspectLocalModel(input)`: what one model reports about itself. A generic
/// OpenAI-compatible server has no inspection route, so the profile is empty.
/// When the kind was not discovered earlier, `/api/tags` is probed once.
pub async fn inspect_local_model(
    rt: &Rt,
    fx: &AiFetch,
    input: &AiLocalInspectionRequest,
) -> AiLocalInspectionResult {
    let Some(base) = normalized_base_of(&input.base_url) else {
        return AiLocalInspectionResult::Failed(failure_of(
            AiLocalDiscoveryErrorCode::Unreachable,
            None,
        ));
    };
    let headers = request_headers_of(input.api_key.as_deref());
    let model = trim(&input.model);

    let empty = || AiLocalInspectionResult::Ok {
        profile: AiLocalInspection::default(),
    };
    match input.server {
        Some(AiLocalServerKind::OpenAiCompatible) => return empty(),
        Some(AiLocalServerKind::Ollama) => {
            return inspect_ollama_model(rt, fx, &base, &headers, model).await;
        }
        None => {}
    }

    match resolve_server_kind(rt, fx, &base, &headers).await {
        Err(failure) => AiLocalInspectionResult::Failed(failure),
        Ok(AiLocalServerKind::OpenAiCompatible) => empty(),
        Ok(AiLocalServerKind::Ollama) => inspect_ollama_model(rt, fx, &base, &headers, model).await,
    }
}
