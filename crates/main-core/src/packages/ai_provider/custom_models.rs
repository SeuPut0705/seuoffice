//! `packages/ai-provider/src/custom-models.ts`: the live model list for the
//! `custom` provider, a user-hosted OpenAI-compatible endpoint, over the one
//! endpoint they all implement: `GET {baseUrl}/models` returning
//! `{ data: [{ id }] }`.
//!
//! Not `aiFetch`: a background probe of a local server that is very often
//! simply not running must neither retry nor warn. The user agent is still
//! set.

use jscompat::{JsMap, JsonValue, js_regex, json_parse, trim};

use super::fetch::{AiFetch, Init, KeyedFetchBase, keyed_fetch, with_user_agent};
use super::jsval::{as_record, object, prop, text};
use super::protocols_shared::{CappedReadOptions, endpoint_url, read_capped_response_text};
use super::task::{Fetcher, JsError, Request, Rt};
use super::watchdog::create_stream_watchdog;

/// `REQUEST_TIMEOUT_MS`: a server this slow is not usable for chat either
const REQUEST_TIMEOUT_MS: f64 = 5000.0;

/// `MAX_MODELS`: ids past this are dropped
const MAX_MODELS: usize = 2000;

/// `MAX_BODY_BYTES`: past this the endpoint is not what it claims
const MAX_BODY_BYTES: f64 = 2.0 * 1024.0 * 1024.0;

/// `CodexModelCatalog`: the models and the default one (`''`: no default)
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CodexModelCatalog {
    pub models: Vec<String>,
    pub default_model: String,
}

impl CodexModelCatalog {
    pub fn to_json(&self) -> JsonValue {
        object(vec![
            (
                "models",
                JsonValue::Array(self.models.iter().map(|m| text(m.clone())).collect()),
            ),
            ("defaultModel", text(self.default_model.clone())),
        ])
    }
}

/// `emptyCatalog()`: "no list"; the caller leaves the free-text model box in place
fn empty_catalog() -> CodexModelCatalog {
    CodexModelCatalog::default()
}

/// The body of the guarded request, which throws on what the endpoint does
/// wrong and answers the catalog otherwise.
async fn catalog_of(
    rt: &Rt,
    fx: &AiFetch,
    base: &str,
    headers: Vec<(String, String)>,
    signal: &super::task::Signal,
) -> Result<CodexModelCatalog, JsError> {
    // the global fetch, not aiFetch: a local server that is down is not retried or rescued
    let url = endpoint_url(base, "models", None)?;
    let init = with_user_agent(
        fx,
        &Init {
            request: Request {
                headers,
                ..Request::default()
            },
            signal: Some(signal.clone()),
        },
    );
    let response = keyed_fetch(
        rt,
        fx,
        &url,
        &init,
        None,
        &KeyedFetchBase::Plain(Fetcher::Node),
    )
    .await?;
    if !response.ok() {
        return Ok(empty_catalog());
    }
    let body = read_capped_response_text(
        &response,
        &CappedReadOptions {
            max_bytes: Some(MAX_BODY_BYTES),
            ..CappedReadOptions::default()
        },
    )
    .await?;
    let body = json_parse(&body).map_err(|e| JsError::new("SyntaxError", e.message()))?;
    let Some(JsonValue::Array(data)) = prop(&body, "data") else {
        return Ok(empty_catalog());
    };
    let mut seen: JsMap<()> = JsMap::new();
    for entry in data {
        let Some(JsonValue::String(id)) = as_record(entry).and_then(|e| e.get("id")) else {
            continue;
        };
        let trimmed = trim(id);
        if !trimmed.is_empty() {
            seen.set(trimmed, ());
        }
        if seen.len() >= MAX_MODELS {
            break;
        }
    }
    Ok(CodexModelCatalog {
        models: seen.keys().map(str::to_owned).collect(),
        default_model: String::new(),
    })
}

/// `listCustomModels(baseUrl, apiKey)`: the model ids a user-hosted
/// OpenAI-compatible endpoint advertises. A refused, unreachable, slow,
/// oversized, non-JSON or unexpectedly shaped answer all return an empty
/// catalogue. The key is sent as `Authorization: Bearer ...` only when one is
/// given.
pub async fn list_custom_models(
    rt: &Rt,
    fx: &AiFetch,
    base_url: &str,
    api_key: Option<&str>,
) -> CodexModelCatalog {
    let base = js_regex!(r"/+$").replace_all(trim(base_url), |_| String::new());
    if base.is_empty() {
        return empty_catalog();
    }
    let key = trim(api_key.unwrap_or(""));
    let mut headers = vec![("Accept".to_owned(), "application/json".to_owned())];
    if !key.is_empty() {
        headers.push(("Authorization".to_owned(), format!("Bearer {key}")));
    }
    let watchdog = create_stream_watchdog(rt, None, Some(REQUEST_TIMEOUT_MS), None);
    watchdog
        .guard(catalog_of(rt, fx, &base, headers, &watchdog.signal))
        .await
        .unwrap_or_else(|_| empty_catalog())
}

/// `listCustomModelsForIpc(input)`: `listCustomModels` behind an `unknown`
/// IPC payload; anything but a string base URL is "no base URL" and an
/// `apiKey` that is no string is none.
pub async fn list_custom_models_for_ipc(
    rt: &Rt,
    fx: &AiFetch,
    input: &JsonValue,
) -> CodexModelCatalog {
    // `(input ?? {})`
    let base_url = match prop(input, "baseUrl") {
        Some(JsonValue::String(url)) => url.as_str(),
        _ => "",
    };
    let api_key = match prop(input, "apiKey") {
        Some(JsonValue::String(key)) => Some(key.as_str()),
        _ => None,
    };
    list_custom_models(rt, fx, base_url, api_key).await
}
