//! `packages/ai-provider/src/key-models.ts`: the live model list for the
//! API-key providers: the ids the vendor serves to the stored key right now,
//! and, for the vendors this app hands a level to, which effort levels each
//! model takes.
//!
//! One request per page to the vendor's own list endpoint, with the key the
//! chat would send there. A vendor without one (404), a refused key, a
//! timeout or an odd body all read as "no list".
//!
//! `fetchImpl` of the TypeScript is the [`KeyedFetchBase`] the request goes
//! through: `Plain(Fetcher::Node)` is the global `fetch` its default is.
//!
//! The provider id is a string. An id the registry does not know is "no
//! list"; a name `Object.prototype` holds (`toString`) reads `capabilities`
//! of nothing and throws, as the TypeScript's `adapter?.capabilities.auth`
//! does.

use jscompat::{
    JsMap, JsRegex, JsonValue, date_parse, encode_uri_component, js_regex, json_parse,
    number_to_string, sort_by_number, to_number, trim,
};

use super::effort::{AI_EFFORTS, AiModelEffort, ai_model_effort_of};
use super::fetch::{AiFetch, Init, KeyedFetchBase, keyed_fetch, with_user_agent};
use super::jsval::{Obj, as_record, assign, coalesce, length16, object, prop, string_list, text};
use super::key_effort::takes_key_effort;
use super::protocols_shared::{CappedReadOptions, endpoint_url, read_capped_response_text};
use super::providers::{current_model_id, opencode_session_headers};
use super::registry::{Adapter, get_provider_adapter, provider_auth, resolve_endpoint};
use super::task::{JsError, Request, Rt};
use super::watchdog::create_stream_watchdog;

/// `REQUEST_TIMEOUT_MS`: a list endpoint this slow is not worth waiting on
const REQUEST_TIMEOUT_MS: f64 = 10_000.0;

/// `MAX_BODY_BYTES`: a vendor's list is a few hundred KB; OpenRouter's about 1 MB
const MAX_BODY_BYTES: f64 = 8.0 * 1024.0 * 1024.0;

/// `MAX_PAGES`: pages followed per listing
const MAX_PAGES: usize = 5;

/// `MAX_KEY_PROVIDER_MODELS`: ids kept per provider
pub const MAX_KEY_PROVIDER_MODELS: usize = 2000;

/// `MAX_MODEL_ID_LENGTH`: the longest id kept
const MAX_MODEL_ID_LENGTH: usize = 256;

/// `NOT_CHAT`: ids that are not chat models: embeddings, speech, image and
/// video generation, live and realtime audio sessions, moderation, reranking
/// and the like.
fn not_chat() -> &'static JsRegex {
    js_regex!(
        r"(embed|(^|[-_/])tts|whisper|transcri|speech|audio|realtime|(^|[-_/])live([-_]|$)|dall-e|gpt-image|imagen|(^|[-_/])image([-_]|$)|-image-|veo|sora|video|moderation|rerank|robotics|(^|[-_/])aqa($|-)|nano-banana|lyria|computer-use|deep-research|(^|[-_/])ocr([-_]|$)|babbage|davinci)",
        "i"
    )
}

/// `UNSUPPORTED[provider]`: ids a provider lists but this app cannot drive
fn unsupported_of(provider: &str) -> Option<&'static JsRegex> {
    match provider {
        "openai" => Some(js_regex!(r"^(o\d+-pro|.*-pro($|-\d)|.*codex)", "i")),
        "opencode-zen" | "opencode-go" => Some(js_regex!(r"^(gpt-|grok|muse)", "i")),
        _ => None,
    }
}

/// `NON_CHAT_TYPES`: kinds some lists put in a `type` field
const NON_CHAT_TYPES: [&str; 10] = [
    "embedding",
    "embeddings",
    "image",
    "images",
    "audio",
    "tts",
    "stt",
    "video",
    "rerank",
    "moderation",
];

/// `COPY_SUFFIX`: a copy of another listed id: a dated snapshot or
/// OpenRouter's batch-priced `:batch` variant
fn copy_suffix() -> &'static JsRegex {
    js_regex!(r"^(.+?)(?:-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{6}|\d{4})|:batch)$")
}

/// `Listed`: one entry of a vendor's list
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Listed {
    pub id: String,
    /// seconds since the epoch, when the list says
    pub created: Option<f64>,
    /// the effort levels the list names for the model
    pub effort: Option<AiModelEffort>,
}

/// `Pick<AiProviderConfig, 'apiKey' | 'baseUrl'>`
#[derive(Debug, Clone, PartialEq, Default)]
pub struct KeyListConfig {
    pub api_key: String,
    pub base_url: Option<String>,
}

/// What a vendor's list says about one model's effort levels, in any of the
/// shapes the vendors use (`listedEffortOf`).
fn listed_effort_of(entry: &Obj) -> Option<AiModelEffort> {
    let capabilities = entry.get("capabilities").filter(|c| as_record(c).is_some());
    // Anthropic: `capabilities.effort.<level>.supported`
    let anthropic = capabilities
        .and_then(|c| prop(c, "effort"))
        .and_then(as_record);
    if let Some(anthropic) = anthropic
        && anthropic.get("supported") != Some(&JsonValue::Bool(false))
    {
        let levels: Vec<&str> = AI_EFFORTS
            .iter()
            .copied()
            .filter(|level| {
                anthropic
                    .get(level)
                    .and_then(as_record)
                    .is_some_and(|leaf| leaf.get("supported") == Some(&JsonValue::Bool(true)))
            })
            .collect();
        if !levels.is_empty() {
            return ai_model_effort_of(Some(&object(vec![("efforts", string_list(&levels))])));
        }
    }
    // OpenRouter: `reasoning.supported_efforts` (null means "any")
    let reasoning = entry.get("reasoning").and_then(as_record);
    if let Some(reasoning) = reasoning
        && let Some(efforts @ JsonValue::Array(_)) = reasoning.get("supported_efforts")
    {
        return model_effort_of(efforts, reasoning.get("default_effort"));
    }
    // DeepSeek: `effort.supported_levels`
    let effort = entry.get("effort").and_then(as_record);
    if let Some(effort) = effort
        && let Some(levels @ JsonValue::Array(_)) = effort.get("supported_levels")
    {
        return model_effort_of(levels, effort.get("default_level"));
    }
    // xAI: `capabilities.reasoning_effort`
    if let Some(capabilities) = capabilities.and_then(as_record)
        && let Some(efforts @ JsonValue::Array(_)) = capabilities.get("reasoning_effort")
    {
        return model_effort_of(efforts, capabilities.get("default_reasoning_effort"));
    }
    None
}

/// `aiModelEffortOf({ efforts, defaultEffort })`
fn model_effort_of(
    efforts: &JsonValue,
    default_effort: Option<&JsonValue>,
) -> Option<AiModelEffort> {
    let mut raw = Obj::new();
    raw.set("efforts", efforts.clone());
    if let Some(default_effort) = default_effort {
        raw.set("defaultEffort", default_effort.clone());
    }
    ai_model_effort_of(Some(&JsonValue::Object(raw)))
}

/// `includes(name)` of an array value
fn includes(value: &JsonValue, name: &str) -> bool {
    matches!(value, JsonValue::Array(items) if items.iter().any(|i| matches!(i, JsonValue::String(s) if s == name)))
}

/// `servesChat(entry)`: what an OpenAI-style entry says about itself, beyond
/// its id.
fn serves_chat(entry: &Obj) -> bool {
    let params = entry.get("supported_parameters");
    if let Some(params @ JsonValue::Array(_)) = params
        && !includes(params, "tools")
    {
        return false;
    }
    if let Some(architecture) = entry.get("architecture").and_then(as_record)
        && let Some(output @ JsonValue::Array(_)) = architecture.get("output_modalities")
        && !includes(output, "text")
    {
        return false;
    }
    if let Some(capabilities) = entry.get("capabilities").and_then(as_record) {
        if capabilities.get("completion_chat") == Some(&JsonValue::Bool(false)) {
            return false;
        }
        if capabilities.get("function_calling") == Some(&JsonValue::Bool(false)) {
            return false;
        }
    }
    !matches!(entry.get("type"), Some(JsonValue::String(kind)) if NON_CHAT_TYPES.contains(&kind.to_lowercase().as_str()))
}

/// `createdOf(value)`
fn created_of(value: Option<&JsonValue>) -> Option<f64> {
    match value {
        Some(JsonValue::Number(x)) if x.is_finite() && *x > 0.0 => {
            // seconds; a millisecond stamp is brought down to the same scale
            Some(if *x > 1e12 { (x / 1000.0).floor() } else { *x })
        }
        Some(JsonValue::String(s)) => {
            let ms = date_parse(s);
            ms.is_finite().then(|| (ms / 1000.0).floor())
        }
        _ => None,
    }
}

/// `getJson(url, headers, fetchImpl)`
async fn get_json(
    rt: &Rt,
    fx: &AiFetch,
    url: &str,
    headers: Vec<(String, String)>,
    fetch_impl: &KeyedFetchBase,
) -> Result<JsonValue, JsError> {
    let watchdog = create_stream_watchdog(rt, None, Some(REQUEST_TIMEOUT_MS), None);
    watchdog
        .guard(async {
            let mut all = vec![("Accept".to_owned(), "application/json".to_owned())];
            all.extend(headers);
            let init = with_user_agent(
                fx,
                &Init {
                    request: Request {
                        headers: all,
                        ..Request::default()
                    },
                    signal: Some(watchdog.signal.clone()),
                },
            );
            let response = keyed_fetch(rt, fx, url, &init, None, fetch_impl).await?;
            if !response.ok() {
                return Err(JsError::error(format!(
                    "HTTP {}",
                    number_to_string(response.status())
                )));
            }
            let body = read_capped_response_text(
                &response,
                &CappedReadOptions {
                    max_bytes: Some(MAX_BODY_BYTES),
                    ..CappedReadOptions::default()
                },
            )
            .await?;
            json_parse(&body).map_err(|e| JsError::new("SyntaxError", e.message()))
        })
        .await
}

fn pair(name: &str, value: &str) -> (String, String) {
    (name.to_owned(), value.to_owned())
}

/// `listAnthropic(base, apiKey, fetchImpl)`
async fn list_anthropic(
    rt: &Rt,
    fx: &AiFetch,
    base: &str,
    api_key: &str,
    fetch_impl: &KeyedFetchBase,
) -> Result<Vec<Listed>, JsError> {
    let mut out = Vec::new();
    let mut after = String::new();
    for _page in 0..MAX_PAGES {
        let query = format!(
            "limit=1000{}",
            if after.is_empty() {
                String::new()
            } else {
                format!("&after_id={}", encode_uri_component(&after))
            }
        );
        let url = endpoint_url(base, "v1/models", Some(&query))?;
        let body = get_json(
            rt,
            fx,
            &url,
            vec![
                pair("x-api-key", api_key),
                pair("anthropic-version", "2023-06-01"),
            ],
            fetch_impl,
        )
        .await?;
        let Some(JsonValue::Array(data)) = as_record(&body).and_then(|b| b.get("data")) else {
            break;
        };
        for entry in data {
            if let Some(entry) = as_record(entry)
                && let Some(JsonValue::String(id)) = entry.get("id")
            {
                out.push(Listed {
                    id: id.clone(),
                    created: created_of(entry.get("created_at")),
                    effort: listed_effort_of(entry),
                });
            }
        }
        let body = as_record(&body);
        let has_more = body.and_then(|b| b.get("has_more")) == Some(&JsonValue::Bool(true));
        let Some(JsonValue::String(last_id)) = body.and_then(|b| b.get("last_id")) else {
            break;
        };
        if !has_more {
            break;
        }
        after = last_id.clone();
    }
    Ok(out)
}

/// `geminiVersion(id)`: the release a Gemini id names; its list carries no dates
fn gemini_version(id: &str) -> f64 {
    match js_regex!(r"gemini-(\d+(?:\.\d+)?)", "i")
        .exec(id)
        .and_then(|m| m.get(1))
    {
        Some(version) => to_number(version),
        None => 0.0,
    }
}

/// `listGemini(base, apiKey, fetchImpl)`
async fn list_gemini(
    rt: &Rt,
    fx: &AiFetch,
    base: &str,
    api_key: &str,
    fetch_impl: &KeyedFetchBase,
) -> Result<Vec<Listed>, JsError> {
    let mut out: Vec<Listed> = Vec::new();
    let mut token = String::new();
    for _page in 0..MAX_PAGES {
        let query = format!(
            "pageSize=1000{}",
            if token.is_empty() {
                String::new()
            } else {
                format!("&pageToken={}", encode_uri_component(&token))
            }
        );
        let url = endpoint_url(base, "models", Some(&query))?;
        let body = get_json(
            rt,
            fx,
            &url,
            vec![pair("x-goog-api-key", api_key)],
            fetch_impl,
        )
        .await?;
        let Some(JsonValue::Array(models)) = as_record(&body).and_then(|b| b.get("models")) else {
            break;
        };
        for entry in models {
            let Some(entry) = as_record(entry) else {
                continue;
            };
            let Some(JsonValue::String(name)) = entry.get("name") else {
                continue;
            };
            let methods = entry.get("supportedGenerationMethods");
            // a model the chat cannot call: embeddings, the Live API, image-only
            if let Some(methods @ JsonValue::Array(_)) = methods
                && !includes(methods, "generateContent")
            {
                continue;
            }
            out.push(Listed {
                id: name.strip_prefix("models/").unwrap_or(name).to_owned(),
                ..Listed::default()
            });
        }
        let Some(JsonValue::String(next)) = as_record(&body).and_then(|b| b.get("nextPageToken"))
        else {
            break;
        };
        if next.is_empty() {
            break;
        }
        token = next.clone();
    }
    // newest release first; the list itself runs oldest first
    let mut indexed: Vec<(usize, Listed)> = out.into_iter().enumerate().collect();
    sort_by_number(&mut indexed, |a, b| {
        let by_version = gemini_version(&b.1.id) - gemini_version(&a.1.id);
        if by_version != 0.0 && !by_version.is_nan() {
            by_version
        } else {
            a.0 as f64 - b.0 as f64
        }
    });
    Ok(indexed.into_iter().map(|(_, entry)| entry).collect())
}

/// `listOpenAiCompatible(base, apiKey, fetchImpl)`
async fn list_open_ai_compatible(
    rt: &Rt,
    fx: &AiFetch,
    base: &str,
    api_key: &str,
    fetch_impl: &KeyedFetchBase,
) -> Result<Vec<Listed>, JsError> {
    let url = endpoint_url(base, "models", None)?;
    let mut headers = Vec::new();
    if !api_key.is_empty() {
        headers.push(("Authorization".to_owned(), format!("Bearer {api_key}")));
    }
    headers.extend(opencode_session_headers(rt, Some(base), None));
    let body = get_json(rt, fx, &url, headers, fetch_impl).await?;
    let Some(JsonValue::Array(data)) = as_record(&body).and_then(|b| b.get("data")) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in data {
        let Some(entry) = as_record(entry) else {
            continue;
        };
        let Some(JsonValue::String(id)) = entry.get("id") else {
            continue;
        };
        if !serves_chat(entry) {
            continue;
        }
        out.push(Listed {
            id: id.clone(),
            created: created_of(coalesce(entry.get("created"), entry.get("created_at"))),
            effort: listed_effort_of(entry),
        });
    }
    Ok(out)
}

/// `withXaiEfforts(base, apiKey, listed, fetchImpl)`: xAI's short list may
/// leave a model's capabilities out; its full list carries them. Filled in
/// where the short one said nothing; a failed read leaves the list as it was.
async fn with_xai_efforts(
    rt: &Rt,
    fx: &AiFetch,
    base: &str,
    api_key: &str,
    listed: Vec<Listed>,
    fetch_impl: &KeyedFetchBase,
) -> Vec<Listed> {
    if listed.iter().all(|entry| entry.effort.is_some()) {
        return listed;
    }
    let read = async {
        let url = endpoint_url(base, "language-models", None)?;
        get_json(
            rt,
            fx,
            &url,
            vec![("Authorization".to_owned(), format!("Bearer {api_key}"))],
            fetch_impl,
        )
        .await
    }
    .await;
    let Ok(body) = read else {
        return listed;
    };
    let mut by_id: JsMap<AiModelEffort> = JsMap::new();
    if let Some(JsonValue::Array(models)) = as_record(&body).and_then(|b| b.get("models")) {
        for entry in models {
            let Some(entry) = as_record(entry) else {
                continue;
            };
            let Some(JsonValue::String(id)) = entry.get("id") else {
                continue;
            };
            if let Some(effort) = listed_effort_of(entry) {
                by_id.set(id.clone(), effort);
            }
        }
    }
    listed
        .into_iter()
        .map(|entry| {
            if entry.effort.is_some() || !by_id.has(&entry.id) {
                entry
            } else {
                Listed {
                    effort: by_id.get(&entry.id).cloned(),
                    ..entry
                }
            }
        })
        .collect()
}

/// `keyModelIdsOf(provider, listed)`: the listed ids the pickers may offer,
/// newest first where the list dates them: chat models only, the provider's
/// own spelling for an id it lists under its wire name, and a dated snapshot
/// or `:batch` variant dropped when the id it copies is listed too.
pub fn key_model_ids_of(provider: &str, listed: &[Listed]) -> Vec<String> {
    let unsupported = unsupported_of(provider);
    let mut kept: Vec<(String, Option<f64>)> = Vec::new();
    let mut seen: JsMap<()> = JsMap::new();
    for entry in listed {
        let raw = trim(&entry.id);
        if raw.is_empty() || length16(raw) > MAX_MODEL_ID_LENGTH {
            continue;
        }
        if not_chat().test(raw) || unsupported.is_some_and(|re| re.test(raw)) {
            continue;
        }
        let id = current_model_id(provider, raw);
        if seen.has(&id) {
            continue;
        }
        seen.set(id.clone(), ());
        kept.push((id, entry.created));
    }
    let mut without_copies: Vec<(usize, (String, Option<f64>))> = kept
        .into_iter()
        .filter(|(id, _)| {
            let alias = copy_suffix()
                .exec(id)
                .and_then(|m| m.get(1))
                .map(str::to_owned);
            !alias.is_some_and(|alias| !alias.is_empty() && seen.has(&alias))
        })
        .enumerate()
        .collect();
    // a stable sort: undated entries keep the vendor's order among themselves
    sort_by_number(&mut without_copies, |a, b| {
        let by_date = b.1.1.unwrap_or(0.0) - a.1.1.unwrap_or(0.0);
        if by_date != 0.0 && !by_date.is_nan() {
            by_date
        } else {
            a.0 as f64 - b.0 as f64
        }
    });
    without_copies
        .into_iter()
        .map(|(_, (id, _))| id)
        .take(MAX_KEY_PROVIDER_MODELS)
        .collect()
}

/// `KeyModelListing`: the ids the pickers offer, and the levels of those
/// that take one
#[derive(Debug, Clone, PartialEq, Default)]
pub struct KeyModelListing {
    pub models: Vec<String>,
    /// by id; only for the providers this app hands a level to, and only
    /// ids in `models`
    pub efforts: Obj,
}

impl KeyModelListing {
    pub fn to_json(&self) -> JsonValue {
        object(vec![
            (
                "models",
                JsonValue::Array(self.models.iter().map(|m| text(m.clone())).collect()),
            ),
            ("efforts", JsonValue::Object(self.efforts.clone())),
        ])
    }
}

/// `keyModelListingOf(provider, listed)`
pub fn key_model_listing_of(provider: &str, listed: &[Listed]) -> KeyModelListing {
    let models = key_model_ids_of(provider, listed);
    let mut efforts = Obj::new();
    if takes_key_effort(Some(provider)) {
        for entry in listed {
            let Some(effort) = &entry.effort else {
                continue;
            };
            let id = current_model_id(provider, trim(&entry.id));
            if models.contains(&id) && efforts.get(&id).is_none() {
                // an id `__proto__` sets the prototype of the table: no own key
                assign(&mut efforts, &id, effort.to_json());
            }
        }
    }
    KeyModelListing { models, efforts }
}

/// `listsKeyProviderModels(provider)`: key providers whose models can be
/// listed: every one but the subscriptions and the user's own servers.
pub fn lists_key_provider_models(provider: &str) -> Result<bool, JsError> {
    match get_provider_adapter(provider) {
        // `AI_PROVIDER_ADAPTERS[provider]` is `undefined`
        Err(_) => Ok(false),
        // a name `Object.prototype` holds: `capabilities` is `undefined`
        Ok(Adapter::Inherited) => Err(JsError::type_error(
            "Cannot read properties of undefined (reading 'auth')",
        )),
        Ok(Adapter::Own(_)) => {
            Ok(provider_auth(provider)? == Some("api-key") && provider != "custom")
        }
    }
}

/// `listKeyProviderModels(provider, config, fetchImpl)`: the chat models a
/// key provider serves to this key, newest first where the vendor dates
/// them; `None` when there is no list to be had.
pub async fn list_key_provider_models(
    rt: &Rt,
    fx: &AiFetch,
    provider: &str,
    config: &KeyListConfig,
    fetch_impl: &KeyedFetchBase,
) -> Result<Option<Vec<String>>, JsError> {
    Ok(
        list_key_provider_model_listing(rt, fx, provider, config, fetch_impl)
            .await?
            .map(|listing| listing.models),
    )
}

/// `listKeyProviderModelListing(provider, config, fetchImpl)`:
/// `listKeyProviderModels` with the effort levels the same answer named.
pub async fn list_key_provider_model_listing(
    rt: &Rt,
    fx: &AiFetch,
    provider: &str,
    config: &KeyListConfig,
    fetch_impl: &KeyedFetchBase,
) -> Result<Option<KeyModelListing>, JsError> {
    let api_key = trim(&config.api_key).to_owned();
    if api_key.is_empty() || !lists_key_provider_models(provider)? {
        return Ok(None);
    }
    let listing = list_inner(rt, fx, provider, config, &api_key, fetch_impl).await;
    // `catch { return null }`
    Ok(listing.unwrap_or(None))
}

async fn list_inner(
    rt: &Rt,
    fx: &AiFetch,
    provider: &str,
    config: &KeyListConfig,
    api_key: &str,
    fetch_impl: &KeyedFetchBase,
) -> Result<Option<KeyModelListing>, JsError> {
    // the endpoint a chat with this key would use, stored base URL included
    let mut wanted = Obj::new();
    wanted.set("apiKey", text(api_key));
    wanted.set("model", text(""));
    if let Some(base_url) = config.base_url.as_deref().filter(|b| !b.is_empty()) {
        wanted.set("baseUrl", text(base_url));
    }
    let endpoint = resolve_endpoint(provider, &JsonValue::Object(wanted))?;
    let base = endpoint.base_url.as_str();
    let mut listed = match endpoint.protocol {
        "anthropic" => list_anthropic(rt, fx, base, api_key, fetch_impl).await?,
        "gemini" => list_gemini(rt, fx, base, api_key, fetch_impl).await?,
        "openai-compatible" => list_open_ai_compatible(rt, fx, base, api_key, fetch_impl).await?,
        _ => Vec::new(),
    };
    if provider == "xai" && !listed.is_empty() {
        listed = with_xai_efforts(rt, fx, base, api_key, listed, fetch_impl).await;
    }
    let listing = key_model_listing_of(provider, &listed);
    Ok((!listing.models.is_empty()).then_some(listing))
}
