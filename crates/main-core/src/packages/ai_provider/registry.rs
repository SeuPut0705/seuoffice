//! `packages/ai-provider/src/registry.ts`: `normalizeBaseUrl`, the model
//! families the request path tells apart, and the adapters' endpoint
//! resolution (`getProviderAdapter(id).resolveEndpoint(config)`). The keys of
//! `AI_PROVIDER_ADAPTERS` are the ids of `AI_PROVIDERS`
//! (`providers::provider_ids`) and each adapter's `meta` is that catalog
//! entry; the `vision` capability is in `registry_vision.rs`.

use super::jsval::{Obj, as_str, js_string, length16, object, prop, text, value_key};
use super::providers::DEEPSEEK_V41_FLASH;
use super::task::JsError;
use jscompat::{JsonValue, js_regex, trim};

/// `normalizeBaseUrl(raw, fallback)`: stored provider settings are user data:
/// a custom base URL must be a bounded http(s) URL. A query string is kept,
/// the fragment is dropped, embedded credentials are refused. The error is
/// the message the TypeScript throws.
pub fn normalize_base_url(raw: Option<&str>, fallback: &str) -> Result<String, String> {
    let candidate = trim(raw.unwrap_or(fallback));
    if candidate.is_empty() || length16(candidate) > 2048 {
        return Err("Base URL must be a non-empty http(s) URL under 2048 characters".to_owned());
    }
    let mut parsed = url::Url::parse(candidate)
        .map_err(|_| "Base URL must be a valid http(s) URL".to_owned())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Base URL must use http or https".to_owned());
    }
    if !parsed.username().is_empty() || parsed.password().is_some_and(|p| !p.is_empty()) {
        return Err(
            "Base URL must not embed credentials; put the key in the API key field".to_owned(),
        );
    }
    parsed.set_fragment(None);
    Ok(parsed.to_string())
}

/// `AiProtocol`
pub type AiProtocol = &'static str;

/// `ResolvedEndpoint`: `None` is a key left out.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ResolvedEndpoint {
    pub protocol: AiProtocol,
    pub base_url: String,
    /// the endpoint fixes its sampling and rejects a temperature field
    pub omit_temperature: Option<bool>,
    /// the endpoint wants the output cap as `max_completion_tokens`
    pub use_max_completion_tokens: Option<bool>,
    /// vendor-specific request fields merged into the chat-completions body
    pub body_extras: Option<Obj>,
    /// id to put on the wire when the vendor spells the configured model differently
    pub model: Option<String>,
}

impl ResolvedEndpoint {
    /// The object the TypeScript builds, its keys in the order set.
    pub fn to_json(&self) -> JsonValue {
        let mut out = vec![
            ("protocol", text(self.protocol)),
            ("baseUrl", text(self.base_url.clone())),
        ];
        if let Some(b) = self.omit_temperature {
            out.push(("omitTemperature", JsonValue::Bool(b)));
        }
        if let Some(b) = self.use_max_completion_tokens {
            out.push(("useMaxCompletionTokens", JsonValue::Bool(b)));
        }
        if let Some(extras) = &self.body_extras {
            out.push(("bodyExtras", JsonValue::Object(extras.clone())));
        }
        if let Some(model) = &self.model {
            out.push(("model", text(model.clone())));
        }
        object(out)
    }
}

const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
/// `ANTHROPIC_BASE_URL` of protocols/anthropic.ts
const ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
/// `GEMINI_BASE_URL` of protocols/gemini.ts
const GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

/// `modelHasFixedSampling(model)`: families that fix sampling and reject a
/// temperature field.
pub fn model_has_fixed_sampling(model: &str) -> bool {
    js_regex!(
        r"(^|\/)(kimi-k3([^\w]|$)|gpt-[5-9]([^\w]|$)|gemini-[3-9]([^\w]|$)|o1(-mini|-preview)?([^\w]|$)|o3(-mini)?([^\w]|$)|o4-mini([^\w]|$))",
        "i"
    )
    .test(model)
}

/// `modelEchoesReasoning(model)`: interleaved-thinking families whose
/// vendors want the reasoning echoed back on assistant messages.
pub fn model_echoes_reasoning(model: &str) -> bool {
    js_regex!(
        r"(^|\/)(minimax-m|deep-?seek-(v4|flash)|hy-?[34]([^\w]|$))",
        "i"
    )
    .test(model)
}

/// `modelUsesResponsesApi(model)`: GPT-5.4+ and GPT-6 call tools only
/// through the Responses API.
pub fn model_uses_responses_api(model: &str) -> bool {
    js_regex!(r"^gpt-(5\.[4-9]|6(\.\d+)?)(-|$)", "i").test(model)
}

/// `normalizeBaseUrl` as a throw
fn normalized(raw: Option<&str>, fallback: &str) -> Result<String, JsError> {
    normalize_base_url(raw, fallback).map_err(JsError::error)
}

/// `stripTrailingV1(base)`: trailing slashes and a trailing /v1 of the path
/// (before any query) go.
fn strip_trailing_v1(base: &str) -> String {
    let q = base.find('?');
    let path = q.map_or(base, |q| &base[..q]);
    let path = js_regex!(r"\/+$").replace_all(path, |_| String::new());
    let path = js_regex!(r"\/v1$").replace_all(&path, |_| String::new());
    match q {
        None => path,
        Some(q) => format!("{path}{}", &base[q..]),
    }
}

/// `appendPath(base, path)`: before any query string
fn append_path(base: &str, path: &str) -> String {
    match base.find('?') {
        None => format!("{base}{path}"),
        Some(q) => format!("{}{path}{}", &base[..q], &base[q..]),
    }
}

/// `config.baseUrl` as `normalizeBaseUrl` reads it: `None` is nullish (the
/// fallback is used); a value that is no string throws where the TypeScript
/// calls `(raw ?? fallback).trim()`.
fn base_url_of(config: &JsonValue) -> Result<Option<String>, JsError> {
    match prop(config, "baseUrl") {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(JsError::type_error(
            "(raw ?? fallback).trim is not a function",
        )),
    }
}

/// `config.baseUrl` is truthy
fn has_base_url(config: &JsonValue) -> bool {
    prop(config, "baseUrl").is_some_and(JsonValue::truthy)
}

/// `opencodeEndpoint(root, routes)(config)`
fn opencode_endpoint(
    root: &str,
    anthropic: &jscompat::JsRegex,
    gemini: Option<&jscompat::JsRegex>,
    config: &JsonValue,
) -> Result<ResolvedEndpoint, JsError> {
    // a stored base URL replaces the gateway root; the documented `/v1` API base is tolerated
    let base = strip_trailing_v1(&normalized(base_url_of(config)?.as_deref(), root)?);
    let model = match prop(config, "model") {
        None | Some(JsonValue::Null) => String::new(),
        Some(m) => js_string(m),
    };
    // Kimi fixes sampling whether the gateway spells the id bare or lab-prefixed
    let omit = !model.is_empty()
        && (model_has_fixed_sampling(&model) || js_regex!(r"(^|\/)kimi-", "i").test(&model));
    let sampling = omit.then_some(true);
    if anthropic.test(&model) {
        return Ok(ResolvedEndpoint {
            protocol: "anthropic",
            base_url: base,
            omit_temperature: sampling,
            ..ResolvedEndpoint::default()
        });
    }
    if gemini.is_some_and(|g| g.test(&model)) {
        return Ok(ResolvedEndpoint {
            protocol: "gemini",
            base_url: append_path(&base, "/v1"),
            omit_temperature: sampling,
            ..ResolvedEndpoint::default()
        });
    }
    Ok(ResolvedEndpoint {
        protocol: "openai-compatible",
        base_url: append_path(&base, "/v1"),
        omit_temperature: sampling,
        ..ResolvedEndpoint::default()
    })
}

/// The `extras` of `fixedEndpoint`.
#[derive(Default)]
struct Extras {
    omit_temperature: bool,
    use_max_completion_tokens: bool,
}

/// `fixedEndpoint(protocol, baseUrl, extras)(config)`
fn fixed_endpoint(
    protocol: AiProtocol,
    base_url: &str,
    extras: Extras,
    config: &JsonValue,
) -> Result<ResolvedEndpoint, JsError> {
    let omit = extras.omit_temperature || model_has_fixed_sampling(&model_string(config));
    Ok(ResolvedEndpoint {
        protocol,
        base_url: if has_base_url(config) {
            normalized(base_url_of(config)?.as_deref(), base_url)?
        } else {
            base_url.to_owned()
        },
        omit_temperature: omit.then_some(true),
        use_max_completion_tokens: extras.use_max_completion_tokens.then_some(true),
        body_extras: None,
        model: None,
    })
}

/// `config.model` as a regex test reads it (`String(value)`)
fn model_string(config: &JsonValue) -> String {
    value_key(prop(config, "model"))
}

/// The names `AI_PROVIDER_ADAPTERS[id]` finds on `Object.prototype`: the
/// lookup is not limited to own keys, so such an id passes
/// `getProviderAdapter` and the adapter it answers has no `resolveEndpoint`.
const INHERITED_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// What `getProviderAdapter(id)` answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Adapter<'a> {
    /// an adapter of the registry
    Own(&'a str),
    /// a value `Object.prototype` holds under that name: no adapter fields
    Inherited,
}

/// `getProviderAdapter(provider)`: throws on ids not in the registry, `auto`
/// included.
pub fn get_provider_adapter(provider: &str) -> Result<Adapter<'_>, JsError> {
    if INHERITED_KEYS.contains(&provider) {
        return Ok(Adapter::Inherited);
    }
    if super::providers::provider_ids().contains(&provider) {
        return Ok(Adapter::Own(provider));
    }
    Err(JsError::error(format!("Unknown provider: {provider}")))
}

/// `getProviderAdapter(provider).capabilities.auth`; `Ok(None)` for an
/// inherited name, where `capabilities` is `undefined` (the caller's read of
/// `.auth` then throws a `TypeError` worded after its own expression).
pub fn provider_auth(provider: &str) -> Result<Option<&'static str>, JsError> {
    Ok(match get_provider_adapter(provider)? {
        Adapter::Inherited => None,
        Adapter::Own(id) => Some(match id {
            "claude-code" => "claude-subscription",
            "chatgpt" => "chatgpt-plan",
            "codex" => "codex-chatgpt",
            "gateway" => "gateway-token",
            _ => "api-key",
        }),
    })
}

/// `getProviderAdapter(provider).resolveEndpoint(config)`: an id that is not
/// in the registry throws, `auto` too. An inherited name throws the
/// `TypeError` of calling `undefined`, worded as chat.ts and stream.ts word
/// that expression.
pub fn resolve_endpoint(provider: &str, config: &JsonValue) -> Result<ResolvedEndpoint, JsError> {
    if get_provider_adapter(provider)? == Adapter::Inherited {
        return Err(JsError::type_error(
            "getProviderAdapter(...).resolveEndpoint is not a function",
        ));
    }
    let fixed = |base: &str| fixed_endpoint("openai-compatible", base, Extras::default(), config);
    match provider {
        "claude-code" => Ok(ResolvedEndpoint {
            protocol: "claude-code-cli",
            ..ResolvedEndpoint::default()
        }),
        "chatgpt" => Ok(ResolvedEndpoint {
            protocol: "chatgpt-responses",
            ..ResolvedEndpoint::default()
        }),
        "codex" => Ok(ResolvedEndpoint {
            protocol: "codex-app-server",
            ..ResolvedEndpoint::default()
        }),
        "anthropic" => fixed_endpoint("anthropic", ANTHROPIC_BASE_URL, Extras::default(), config),
        "gemini" => fixed_endpoint("gemini", GEMINI_BASE_URL, Extras::default(), config),
        "deepseek" => {
            // `DEEPSEEK_WIRE_IDS[config.model]`
            let wire = (as_str(prop(config, "model")) == Some(DEEPSEEK_V41_FLASH))
                .then(|| "deepseek-flash".to_owned());
            let mut endpoint = fixed("https://api.deepseek.com/v1")?;
            endpoint.model = wire;
            Ok(endpoint)
        }
        "openai" => {
            let base_url = if has_base_url(config) {
                normalized(base_url_of(config)?.as_deref(), OPENAI_BASE_URL)?
            } else {
                OPENAI_BASE_URL.to_owned()
            };
            if model_uses_responses_api(&model_string(config)) {
                return Ok(ResolvedEndpoint {
                    protocol: "openai-responses",
                    base_url,
                    ..ResolvedEndpoint::default()
                });
            }
            fixed_endpoint(
                "openai-compatible",
                OPENAI_BASE_URL,
                Extras {
                    use_max_completion_tokens: true,
                    ..Extras::default()
                },
                config,
            )
        }
        "kimi" => fixed_endpoint(
            "openai-compatible",
            "https://api.moonshot.ai/v1",
            Extras {
                omit_temperature: true,
                ..Extras::default()
            },
            config,
        ),
        "glm" => fixed("https://open.bigmodel.cn/api/paas/v4"),
        "qwen" => fixed("https://dashscope.aliyuncs.com/compatible-mode/v1"),
        "doubao" => fixed("https://ark.cn-beijing.volces.com/api/v3"),
        "mimo" => fixed("https://api.xiaomimimo.com/v1"),
        "hunyuan" => fixed("https://tokenhub.tencentcloudmaas.com/v1"),
        "ling" => fixed("https://api.ant-ling.com/v1"),
        "spark" => fixed("https://maas-api.cn-huabei-1.xf-yun.com/v2"),
        "longcat" => fixed("https://api.longcat.chat/openai/v1"),
        "minimax" => fixed("https://api.minimax.io/v1"),
        "xai" => fixed("https://api.x.ai/v1"),
        "mistral" => fixed("https://api.mistral.ai/v1"),
        "upstage" => fixed("https://api.upstage.ai/v1"),
        "exaone" => fixed("https://api.exaone.ai/v1"),
        "openrouter" => fixed("https://openrouter.ai/api/v1"),
        "requesty" => fixed("https://router.requesty.ai/v1"),
        "opper" => fixed("https://api.opper.ai/v3/compat"),
        "cheaperinference" => fixed("https://api.cheaperinference.com/v1"),
        "atlascloud" => fixed("https://api.atlascloud.ai/v1"),
        "runcrate" => fixed("https://api.runcrate.ai/v1"),
        "cloudgpu" => fixed("https://cloudgpu.app/v1"),
        "siliconflow" => fixed("https://api.siliconflow.cn/v1"),
        "ppio" => fixed("https://api.ppio.com/openai/v1"),
        // Claude and Qwen ride /v1/messages, Gemini its native generateContent path
        "opencode-zen" => opencode_endpoint(
            "https://opencode.ai/zen",
            js_regex!(r"^(claude-|qwen)"),
            Some(js_regex!(r"^gemini-")),
            config,
        ),
        // MiniMax and Qwen 3.8 Flash ride /v1/messages; the rest is chat-completions
        "opencode-go" => opencode_endpoint(
            "https://opencode.ai/zen/go",
            js_regex!(r"^(minimax-|qwen3\.8-flash$)"),
            None,
            config,
        ),
        // Claude ids answer only on /v1/messages
        "commandcode" => opencode_endpoint(
            "https://api.commandcode.ai/provider",
            js_regex!(r"^claude-"),
            None,
            config,
        ),
        "custom" => {
            if !has_base_url(config) {
                return Err(JsError::error("A custom provider requires a Base URL"));
            }
            Ok(ResolvedEndpoint {
                protocol: "openai-compatible",
                base_url: normalized(base_url_of(config)?.as_deref(), "")?,
                omit_temperature: model_has_fixed_sampling(&model_string(config)).then_some(true),
                ..ResolvedEndpoint::default()
            })
        }
        // no URL resolves to '' rather than throwing
        "gateway" => {
            // `config.baseUrl?.trim()`: a value that is no string has no `trim`
            let has = match prop(config, "baseUrl") {
                None | Some(JsonValue::Null) => false,
                Some(JsonValue::String(u)) => !trim(u).is_empty(),
                Some(_) => {
                    return Err(JsError::type_error(
                        "config.baseUrl?.trim is not a function",
                    ));
                }
            };
            Ok(ResolvedEndpoint {
                protocol: "gateway-complete",
                base_url: if has {
                    normalized(base_url_of(config)?.as_deref(), "")?
                } else {
                    String::new()
                },
                ..ResolvedEndpoint::default()
            })
        }
        _ => Err(JsError::error(format!("Unknown provider: {provider}"))),
    }
}
