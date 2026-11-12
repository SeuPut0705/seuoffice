//! `packages/ai-provider/src/providers.ts`: the provider catalog and the
//! settings a file or a renderer sends, merged over the defaults.
//!
//! Not here: `opencodeSessionHeaders`, `providerPickerModels`,
//! `withStoredUnknownFields`, `withStoredSubscriptionOff`, `currentModelId`
//! and the endpoint helpers; no ported module calls them.
//!
//! One thing differs from the TypeScript on purpose of the language: the
//! retired-model table is looked up for its own keys only. In JavaScript a
//! stored model id that is the name of a member of `Object.prototype`
//! (`constructor`, `toString`, `__proto__`, ...) under `deepseek`, `glm` or
//! `gemini` finds that member in the table and becomes a function; no Rust
//! value holds one.

use super::custom_endpoints::resolve_custom_endpoints;
use super::effort::ai_model_efforts_of;
use super::jsval::{
    Obj, as_integer, as_record, as_str, coalesce, number, object, prop, spread, str_trim,
    string_list, text,
};
use super::media::{default_ai_media_settings, resolve_ai_media_settings};
use super::search_settings::{default_ai_search_settings, resolve_ai_search_settings};
use super::settings_secrets::{AiSecretCodec, open_ai_secrets};
use jscompat::{JsonValue, trim};

/// `AiProviderMeta`
#[derive(Debug, Clone, Copy)]
pub struct AiProviderMeta {
    pub id: &'static str,
    pub label: &'static str,
    pub models: &'static [&'static str],
    pub default_model: &'static str,
    pub key_placeholder: &'static str,
    pub needs_base_url: bool,
    pub needs_cli_path: bool,
    pub request_token: bool,
}

impl AiProviderMeta {
    /// The object the TypeScript literal is: the optional flags are there
    /// only where the literal has them.
    pub fn to_json(&self) -> JsonValue {
        let mut entries = vec![
            ("id", text(self.id)),
            ("label", text(self.label)),
            ("models", string_list(self.models)),
            ("defaultModel", text(self.default_model)),
            ("keyPlaceholder", text(self.key_placeholder)),
        ];
        if self.needs_base_url {
            entries.push(("needsBaseUrl", JsonValue::Bool(true)));
        }
        if self.needs_cli_path {
            entries.push(("needsCliPath", JsonValue::Bool(true)));
        }
        if self.request_token {
            entries.push(("requestToken", JsonValue::Bool(true)));
        }
        object(entries)
    }
}

/// `DEEPSEEK_V41_FLASH`: DeepSeek V4.1 Flash under its old versioned
/// spelling.
pub const DEEPSEEK_V41_FLASH: &str = "deep-seek-v4.1-flash";

/// `AI_PROVIDERS` (the comments of the TypeScript catalog are in
/// `packages/ai-provider/src/providers.ts`)
pub const AI_PROVIDERS: &[AiProviderMeta] = &[
    AiProviderMeta {
        id: "claude-code",
        label: "Claude Code",
        models: &["opus", "sonnet", "haiku"],
        default_model: "",
        key_placeholder: "",
        needs_base_url: false,
        needs_cli_path: true,
        request_token: false,
    },
    AiProviderMeta {
        id: "chatgpt",
        label: "ChatGPT",
        models: &[],
        default_model: "",
        key_placeholder: "",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "codex",
        label: "Codex CLI",
        models: &[],
        default_model: "",
        key_placeholder: "",
        needs_base_url: false,
        needs_cli_path: true,
        request_token: false,
    },
    AiProviderMeta {
        id: "anthropic",
        label: "Claude",
        models: &[
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-fable-5-1",
            "claude-haiku-5-5",
            "claude-sonnet-5",
            "claude-opus-5",
            "claude-fable-5",
            "claude-sonnet-4-6",
        ],
        default_model: "claude-sonnet-5-5",
        key_placeholder: "sk-ant-api03-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "gemini",
        label: "Gemini",
        models: &[
            "gemini-3.8-flash",
            "gemini-4-argon",
            "gemini-3.1-pro-preview",
            "gemini-3.6-flash",
            "gemini-3.5-flash-lite",
            "gemini-3.1-flash-lite",
        ],
        default_model: "gemini-3.8-flash",
        key_placeholder: "AIza...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "deepseek",
        label: "DeepSeek",
        models: &["deepseek-v4-pro", "deepseek-flash"],
        default_model: "deepseek-v4-pro",
        key_placeholder: "sk-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "openai",
        label: "OpenAI",
        models: &[
            "gpt-6.1-terra",
            "gpt-6.1-sol",
            "gpt-6-astra",
            "gpt-6-sol",
            "gpt-6-luna",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
            "gpt-5.4",
            "gpt-5.4-mini",
        ],
        default_model: "gpt-6.1-terra",
        key_placeholder: "sk-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "kimi",
        label: "Kimi",
        models: &["kimi-k3.1-pro", "kimi-k3"],
        default_model: "kimi-k3.1-pro",
        key_placeholder: "sk-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "glm",
        label: "GLM",
        models: &["glm-5.3", "glm-5.3-flash", "glm-5.2"],
        default_model: "glm-5.3",
        key_placeholder: "xxxxxxxx.xxxxxxxx",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "qwen",
        label: "Qwen",
        models: &[
            "qwen3.8-max",
            "qwen3.8-flash",
            "qwen3.7-plus",
            "qwen3.7-flash",
        ],
        default_model: "qwen3.8-max",
        key_placeholder: "sk-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "doubao",
        label: "Doubao",
        models: &["doubao-seed-2-1-pro-260628", "doubao-seed-2-1-turbo-260628"],
        default_model: "doubao-seed-2-1-pro-260628",
        key_placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "mimo",
        label: "MiMo",
        models: &["mimo-v2.6-pro", "mimo-v2.6-flash"],
        default_model: "mimo-v2.6-pro",
        key_placeholder: "sk-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "hunyuan",
        label: "Hunyuan",
        models: &["hy4-preview", "hy3"],
        default_model: "hy4-preview",
        key_placeholder: "sk-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "ling",
        label: "Ling",
        models: &[
            "Ling-3.0-flash",
            "Ling-3.0-flash-VL",
            "Ling-3.0-tiny",
            "Ling-2.6-1T",
            "Ring-2.6-1T",
            "Ling-2.6-flash",
        ],
        default_model: "Ling-3.0-flash",
        key_placeholder: "API Key",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "spark",
        label: "Spark",
        models: &["spark-x2.5"],
        default_model: "spark-x2.5",
        key_placeholder: "ak-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "longcat",
        label: "LongCat",
        models: &["LongCat-2.5-Preview", "LongCat-2.0"],
        default_model: "LongCat-2.0",
        key_placeholder: "API Key",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "minimax",
        label: "MiniMax",
        models: &["MiniMax-M3.1-Flash", "MiniMax-M3"],
        default_model: "MiniMax-M3.1-Flash",
        key_placeholder: "eyJ...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "xai",
        label: "Grok",
        models: &["grok-4.7", "grok-4.6", "grok-4.5"],
        default_model: "grok-4.6",
        key_placeholder: "xai-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "mistral",
        label: "Mistral",
        models: &[
            "mistral-medium-latest",
            "mistral-large-latest",
            "mistral-small-latest",
        ],
        default_model: "mistral-medium-latest",
        key_placeholder: "API Key",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "upstage",
        label: "Solar",
        models: &["solar-pro4", "solar-pro3", "solar-mini4"],
        default_model: "solar-pro4",
        key_placeholder: "up_...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "exaone",
        label: "EXAONE",
        models: &["k-exaone_v2.5"],
        default_model: "k-exaone_v2.5",
        key_placeholder: "sk-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "openrouter",
        label: "OpenRouter",
        models: &[
            "openrouter/auto",
            "anthropic/claude-opus-5.5",
            "anthropic/claude-sonnet-5",
            "openai/gpt-6-astra",
            "openai/gpt-6-sol",
            "openai/gpt-6-luna",
            "openai/gpt-5.6-sol",
            "moonshotai/kimi-k3.1-pro",
            "moonshotai/kimi-k3",
            "minimax/minimax-m3",
        ],
        default_model: "openrouter/auto",
        key_placeholder: "sk-or-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "requesty",
        label: "Requesty",
        models: &[
            "claude-sonnet-5",
            "claude-opus-5-5",
            "claude-opus-4-8",
            "gpt-6-sol",
            "gpt-6-luna",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gemini-3.7-flash",
            "deepseek-v4-pro",
            "kimi-k3",
        ],
        default_model: "claude-sonnet-5",
        key_placeholder: "sk-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "opper",
        label: "Opper",
        models: &[
            "claude-sonnet-4-6",
            "claude-opus-5",
            "gpt-5.5",
            "gpt-5.4-mini",
            "gemini-3.8-flash",
            "deepseek-v4-pro",
            "kimi-k3",
            "mistral-large-2512",
        ],
        default_model: "claude-sonnet-4-6",
        key_placeholder: "API Key",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "cheaperinference",
        label: "Cheaper Inference",
        models: &[
            "gpt-5.4-mini",
            "gpt-5.4",
            "claude-sonnet-5",
            "gemini-3.1-pro",
        ],
        default_model: "gpt-5.4-mini",
        key_placeholder: "ci_live_...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "atlascloud",
        label: "Atlas Cloud",
        models: &[
            "deepseek-ai/deepseek-v4-pro",
            "deepseek-ai/deepseek-v4-flash",
            "moonshotai/kimi-k3",
            "moonshotai/kimi-k2.6",
            "zai-org/glm-5.3",
            "zai-org/glm-5.3-flash",
            "qwen/qwen3.8-max",
            "qwen/qwen3.5-flash",
            "minimaxai/minimax-m3",
        ],
        default_model: "deepseek-ai/deepseek-v4-pro",
        key_placeholder: "apikey-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "runcrate",
        label: "Runcrate",
        models: &[
            "deepseek-ai/DeepSeek-V4.1-Flash",
            "deepseek-ai/DeepSeek-V4.1-Flash-1017",
            "zai-org/GLM-5.3",
            "zai-org/GLM-5.3-Flash",
            "moonshotai/Kimi-K2.6",
            "Qwen/Qwen3.8-Flash",
            "openai/gpt-oss-120b",
        ],
        default_model: "deepseek-ai/DeepSeek-V4.1-Flash",
        key_placeholder: "rc_live_...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "cloudgpu",
        label: "CloudGPU",
        models: &[
            "deepseek-v4.1-flash",
            "deepseek-v4-pro",
            "glm-5.3-flash",
            "kimi-k2.6",
            "minimax-m3",
        ],
        default_model: "deepseek-v4.1-flash",
        key_placeholder: "sk-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "siliconflow",
        label: "SiliconFlow",
        models: &[
            "deepseek-ai/DeepSeek-V4.1-Flash",
            "deepseek-ai/DeepSeek-V4-Pro",
            "deepseek-ai/DeepSeek-V3.2",
            "zai-org/GLM-5.3",
            "zai-org/GLM-5.3-Flash",
            "moonshotai/Kimi-K2.7-Code",
            "Qwen/Qwen3.8-27B",
        ],
        default_model: "deepseek-ai/DeepSeek-V4-Pro",
        key_placeholder: "sk-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "ppio",
        label: "PPIO",
        models: &[
            "deepseek/deepseek-v4.1-flash",
            "deepseek/deepseek-v4-pro",
            "moonshotai/kimi-k3",
            "zai-org/glm-5.3",
            "qwen/qwen3.8-max",
            "minimax/minimax-m3.1-flash",
        ],
        default_model: "deepseek/deepseek-v4.1-flash",
        key_placeholder: "sk-...",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "opencode-zen",
        label: "OpenCode Zen",
        models: &[
            "claude-sonnet-5",
            "claude-opus-5-5",
            "claude-opus-5",
            "claude-fable-5-1",
            "claude-haiku-5-5",
            "gemini-3.7-flash",
            "gemini-3.1-pro",
            "kimi-k3",
            "kimi-k2.7-code",
            "deepseek-v4-pro",
            "deepseek-v4-flash",
            "glm-5.2",
            "minimax-m3.1-flash-free",
            "minimax-m3",
            "qwen3.6-plus",
        ],
        default_model: "claude-sonnet-5",
        key_placeholder: "API Key",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "opencode-go",
        label: "OpenCode Go",
        models: &[
            "kimi-k2.7-code",
            "kimi-k3",
            "kimi-k2.6",
            "glm-5.3",
            "glm-5.3-flash",
            "glm-5.2",
            "deepseek-v4-pro",
            "deepseek-v4-flash",
            "deepseek-v4.1-flash",
            "qwen3.8-max",
            "qwen3.8-flash",
            "minimax-m3",
            "mimo-v2.5-pro",
            "mimo-v2.6-pro",
            "mimo-v2.6-flash",
            "longcat-2.0",
            "longcat-2.5-preview-free",
            "hy4-preview",
            "hy3",
        ],
        default_model: "kimi-k2.7-code",
        key_placeholder: "API Key",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "commandcode",
        label: "Command Code",
        models: &[
            "zai-org/GLM-5.3",
            "zai-org/GLM-5.2",
            "deepseek/deepseek-v4-pro",
            "deepseek/deepseek-v4.1-flash",
            "deepseek/deepseek-v4-flash",
            "moonshotai/Kimi-K2.7-Code",
            "moonshotai/Kimi-K3",
            "Qwen/Qwen3.8-Max",
            "Qwen/Qwen3.8-27B",
            "MiniMaxAI/MiniMax-M3",
            "minimax/minimax-m3.1-flash",
            "tencent/hy3-paid",
            "google/gemini-3.8-flash",
            "google/gemini-3.7-flash",
        ],
        default_model: "zai-org/GLM-5.3",
        key_placeholder: "CMD API key",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "custom",
        label: "Custom",
        models: &[],
        default_model: "",
        key_placeholder: "API Key",
        needs_base_url: true,
        needs_cli_path: false,
        request_token: false,
    },
    AiProviderMeta {
        id: "gateway",
        label: "AI Gateway",
        models: &[],
        default_model: "",
        key_placeholder: "",
        needs_base_url: false,
        needs_cli_path: false,
        request_token: true,
    },
];

/// `AI_PROVIDERS` as the objects the TypeScript holds.
pub fn ai_providers_json() -> JsonValue {
    JsonValue::Array(AI_PROVIDERS.iter().map(AiProviderMeta::to_json).collect())
}

/// The ids of `AI_PROVIDERS`, in catalog order.
pub fn provider_ids() -> Vec<&'static str> {
    AI_PROVIDERS.iter().map(|m| m.id).collect()
}

/// `defaultAiSettings(defaultApiKeys)`: fresh settings with every provider's
/// default model and an empty key, except providers listed in
/// `default_api_keys`.
pub fn default_ai_settings(default_api_keys: Option<&JsonValue>) -> JsonValue {
    let mut providers = Obj::new();
    for meta in AI_PROVIDERS {
        let key = default_api_keys.and_then(|k| prop(k, meta.id));
        let api_key = coalesce(key, None).cloned().unwrap_or_else(|| text(""));
        let mut entries = vec![("apiKey", api_key), ("model", text(meta.default_model))];
        if meta.needs_base_url {
            entries.push(("baseUrl", text("")));
        }
        if meta.needs_cli_path {
            entries.push(("cliPath", text("")));
        }
        providers.set(meta.id, object(entries));
    }
    object(vec![
        ("provider", text("auto")),
        ("providers", JsonValue::Object(providers)),
        ("media", default_ai_media_settings()),
        ("search", default_ai_search_settings()),
        ("meteredAccepted", sanitize_metered_accepted(None)),
        ("headlessSubscriptionEnabled", JsonValue::Bool(false)),
        ("headlessSubscriptionConsentVersion", number(0.0)),
        ("subscriptionNoticeSeen", JsonValue::Bool(false)),
        ("subscriptionNoticeVersion", number(0.0)),
        ("pdfSendNoticeSeen", number(0.0)),
    ])
}

/// `AI_SUBSCRIPTION_NOTICE_VERSION`: the current wording of the
/// first-connection notice (version 2 added the PDF sentence).
pub const AI_SUBSCRIPTION_NOTICE_VERSION: f64 = 2.0;

/// the notice version an older settings file without one had acknowledged
const LEGACY_SUBSCRIPTION_NOTICE_VERSION: f64 = 1.0;

/// `subscriptionNoticeVersionOf(version, seen)`: a stored notice version, or
/// the version an old boolean-only file implies.
pub fn subscription_notice_version_of(
    version: Option<&JsonValue>,
    seen: Option<&JsonValue>,
) -> f64 {
    if let Some(v) = as_integer(version)
        && v >= 0.0
    {
        return v.min(AI_SUBSCRIPTION_NOTICE_VERSION);
    }
    if matches!(seen, Some(JsonValue::Bool(true))) {
        AI_SUBSCRIPTION_NOTICE_VERSION
    } else {
        0.0
    }
}

/// `LEGACY_NOTICE_VERSION_FOR_MIGRATION`
pub const LEGACY_NOTICE_VERSION_FOR_MIGRATION: f64 = LEGACY_SUBSCRIPTION_NOTICE_VERSION;

/// `withMigratedSubscriptionNoticeVersion(raw)`: the settings object a file
/// written before notice versions needs, or `None` when it already has one
/// (or is not a settings object).
pub fn with_migrated_subscription_notice_version(raw: &JsonValue) -> Option<JsonValue> {
    let value = as_record(raw)?;
    if !matches!(
        value.get("subscriptionNoticeSeen"),
        Some(JsonValue::Bool(true))
    ) {
        return None;
    }
    if let Some(version) = as_integer(value.get("subscriptionNoticeVersion"))
        && version >= 0.0
    {
        return None;
    }
    let mut out = value.clone();
    out.set(
        "subscriptionNoticeVersion",
        number(LEGACY_SUBSCRIPTION_NOTICE_VERSION),
    );
    Some(JsonValue::Object(out))
}

/// `HEADLESS_SUBSCRIPTION_CONSENT_VERSION`
pub const HEADLESS_SUBSCRIPTION_CONSENT_VERSION: f64 = 2.0;

/// `headlessConsentVersionOf(value)`: a stored consent version, or 0 when
/// there is none or it is not a whole number.
pub fn headless_consent_version_of(value: Option<&JsonValue>) -> f64 {
    match as_integer(value) {
        Some(v) if v > 0.0 => v,
        _ => 0.0,
    }
}

/// `headlessSubscriptionOn(settings)`: the switch as it takes effect: on only
/// with the consent of the current version.
pub fn headless_subscription_on(
    enabled: Option<&JsonValue>,
    consent_version: Option<&JsonValue>,
) -> bool {
    matches!(enabled, Some(JsonValue::Bool(true)))
        && headless_consent_version_of(consent_version) >= HEADLESS_SUBSCRIPTION_CONSENT_VERSION
}

/// `AI_SUBSCRIPTION_PROVIDERS`: the providers that run on the user's
/// subscription, in the order `auto` tries them.
pub const AI_SUBSCRIPTION_PROVIDERS: [&str; 3] = ["claude-code", "chatgpt", "codex"];

/// `AI_SUBSCRIPTION_CLIS`
pub const AI_SUBSCRIPTION_CLIS: [&str; 2] = ["claude-code", "codex"];

/// `isSubscriptionCli(id)`
pub fn is_subscription_cli(id: Option<&JsonValue>) -> bool {
    as_str(id).is_some_and(|id| AI_SUBSCRIPTION_CLIS.contains(&id))
}

/// `sanitizeMeteredAccepted(stored)`: one boolean per vendor CLI; anything
/// that is not `true` reads as not accepted.
pub fn sanitize_metered_accepted(stored: Option<&JsonValue>) -> JsonValue {
    let flag = |id: &str| {
        JsonValue::Bool(matches!(
            stored.and_then(|s| prop(s, id)),
            Some(JsonValue::Bool(true))
        ))
    };
    object(vec![
        ("claude-code", flag("claude-code")),
        ("codex", flag("codex")),
    ])
}

/// `sanitizeSubscriptionOff(stored)`: the vendor CLIs turned off in this app,
/// or `None` when none is.
pub fn sanitize_subscription_off(stored: Option<&JsonValue>) -> Option<JsonValue> {
    let stored = as_record(stored?)?;
    let mut off = Obj::new();
    for id in AI_SUBSCRIPTION_CLIS {
        if matches!(stored.get(id), Some(JsonValue::Bool(true))) {
            off.set(id, JsonValue::Bool(true));
        }
    }
    (!off.is_empty()).then_some(JsonValue::Object(off))
}

/// `readUrlSettingsOf(value)`: the read_url slot when it carries a usable
/// token.
pub fn read_url_settings_of(value: Option<&JsonValue>) -> Option<JsonValue> {
    let record = as_record(value?)?;
    let token = str_trim(record.get("githubToken"));
    (!token.is_empty()).then(|| object(vec![("githubToken", text(token))]))
}

/// Model ids a vendor has stopped serving, mapped to their replacement.
fn retired_model(provider: &str, model: &str) -> Option<&'static str> {
    let table: &[(&str, &str)] = match provider {
        "deepseek" => &[
            ("deepseek-chat", "deepseek-flash"),
            ("deepseek-reasoner", "deepseek-flash"),
            ("deepseek-v4-flash", "deepseek-flash"),
            ("deepseek-v4-flash-vision-exp", "deepseek-flash"),
            (DEEPSEEK_V41_FLASH, "deepseek-flash"),
        ],
        "glm" => &[("glm-5-turbo", "glm-5.3-flash")],
        "gemini" => &[("gemini-3.7-flash", "gemini-3.8-flash")],
        _ => return None,
    };
    table
        .iter()
        .find(|(old, _)| *old == model)
        .map(|(_, new)| *new)
}

/// ids at most this long are kept from a stored live list
const MAX_LISTED_MODEL_LENGTH: usize = 256;
/// entries kept from a stored live list
const MAX_LISTED_MODELS: usize = 2000;

/// `listedModelsOf(value)`: a stored live model list as the pickers may read
/// it: strings only, trimmed, bounded, without duplicates.
pub fn listed_models_of(value: Option<&JsonValue>) -> Option<Vec<String>> {
    let Some(JsonValue::Array(items)) = value else {
        return None;
    };
    let mut seen: Vec<String> = Vec::new();
    for entry in items {
        let JsonValue::String(t) = entry else {
            continue;
        };
        let id = trim(t);
        if !id.is_empty()
            && id.encode_utf16().count() <= MAX_LISTED_MODEL_LENGTH
            && !seen.iter().any(|s| s == id)
        {
            seen.push(id.to_owned());
        }
        if seen.len() >= MAX_LISTED_MODELS {
            break;
        }
    }
    (!seen.is_empty()).then_some(seen)
}

/// `DEFAULT_MAX_OUTPUT_TOKENS`
pub const DEFAULT_MAX_OUTPUT_TOKENS: f64 = 32768.0;
/// `MIN_MAX_OUTPUT_TOKENS`
pub const MIN_MAX_OUTPUT_TOKENS: f64 = 1024.0;
/// `MAX_MAX_OUTPUT_TOKENS`
pub const MAX_MAX_OUTPUT_TOKENS: f64 = 131072.0;

/// `clampMaxOutputTokens(value)`: out-of-range or non-finite input falls back
/// to a bound or the default.
pub fn clamp_max_output_tokens(value: Option<&JsonValue>) -> f64 {
    let n = match value {
        Some(JsonValue::Number(x)) => x.floor(),
        _ => f64::NAN,
    };
    if !n.is_finite() {
        return DEFAULT_MAX_OUTPUT_TOKENS;
    }
    MAX_MAX_OUTPUT_TOKENS.min(MIN_MAX_OUTPUT_TOKENS.max(n))
}

/// `maxOutputTokensOf(settings)`: the effective per-turn output cap of a
/// settings object (clamped; absent is the default). `settings` is `None`
/// for `null` and `undefined`.
pub fn max_output_tokens_of(settings: Option<&JsonValue>) -> f64 {
    match settings.and_then(|s| prop(s, "maxOutputTokens")) {
        None => DEFAULT_MAX_OUTPUT_TOKENS,
        some => clamp_max_output_tokens(some),
    }
}

fn merge_provider_configs(defaults: &Obj, stored: &Obj) -> Obj {
    let mut merged = defaults.clone();
    for (id, config) in stored.entries() {
        if as_record(config).is_some() {
            // `merged[id] = config`: `__proto__` makes no own key
            if id != "__proto__" {
                merged.set(id, config.clone());
            }
        }
    }
    merged
}

/// Each provider config with only the fields this build knows, typed as it
/// types them.
fn trim_configs(providers: &Obj) -> Obj {
    let mut trimmed = Obj::new();
    for (id, config) in providers.entries() {
        let Some(config) = as_record(config) else {
            continue;
        };
        let models = listed_models_of(config.get("models"));
        // a level this build does not know, from a newer build or a hand edit, is never listed
        let model_efforts = ai_model_efforts_of(config.get("modelEfforts"));
        let mut entry = Obj::new();
        if let Some(JsonValue::String(effort)) = config.get("effort") {
            entry.set("effort", text(effort.as_str()));
        }
        entry.set("apiKey", text(str_trim(config.get("apiKey"))));
        entry.set("model", text(str_trim(config.get("model"))));
        if let Some(url) = config.get("baseUrl") {
            entry.set("baseUrl", text(str_trim(Some(url))));
        }
        if let Some(path) = config.get("cliPath") {
            entry.set("cliPath", text(str_trim(Some(path))));
        }
        if let Some(models) = models {
            let refs: Vec<&str> = models.iter().map(String::as_str).collect();
            entry.set("models", string_list(&refs));
        }
        if let Some(efforts) = model_efforts {
            entry.set("modelEfforts", efforts);
        }
        if id != "__proto__" {
            trimmed.set(id, JsonValue::Object(entry));
        }
    }
    trimmed
}

fn migrate_retired_models(providers: &Obj) -> Obj {
    let mut migrated = providers.clone();
    for id in ["deepseek", "glm", "gemini"] {
        let Some(config) = migrated.get(id).cloned() else {
            continue;
        };
        let model = prop(&config, "model");
        let replacement = match as_str(model) {
            Some(m) if !m.is_empty() => retired_model(id, m),
            _ => None,
        };
        if let Some(replacement) = replacement {
            let mut next = spread(Some(&config));
            next.set("model", text(replacement));
            migrated.set(id, JsonValue::Object(next));
        }
    }
    migrated
}

/// `resolveAiSettings(stored, defaults)`: merge on-disk settings over freshly
/// computed defaults, migrating the pre-provider shape (a single
/// OpenAI-compatible endpoint) into the "custom" provider slot. `defaults` is
/// changed as the TypeScript changes it. `codec` opens the sealed keys.
pub fn resolve_ai_settings(
    codec: Option<&dyn AiSecretCodec>,
    stored: Option<&JsonValue>,
    defaults: &mut JsonValue,
) -> JsonValue {
    // sealed keys open here, so every reader of the file gets them plain
    let settings: JsonValue = match stored {
        Some(s) if as_record(s).is_some() => open_ai_secrets(codec, s),
        _ => JsonValue::Object(Obj::new()),
    };
    let defaults_view = defaults.clone();
    let read_url = read_url_settings_of(coalesce(
        prop(&settings, "readUrl"),
        prop(&defaults_view, "readUrl"),
    ));
    let subscription_off = sanitize_subscription_off(coalesce(
        prop(&settings, "subscriptionOff"),
        prop(&defaults_view, "subscriptionOff"),
    ));
    let stored_providers = prop(&settings, "providers").and_then(as_record).cloned();
    let Some(stored_providers) = stored_providers else {
        if prop(&settings, "apiKey").is_some_and(JsonValue::truthy) {
            let base_url = str_trim(prop(&settings, "baseUrl"));
            let custom = object(vec![
                ("apiKey", text(str_trim(prop(&settings, "apiKey")))),
                ("model", text(str_trim(prop(&settings, "model")))),
                (
                    "baseUrl",
                    text(if base_url.is_empty() {
                        "https://api.openai.com/v1".to_owned()
                    } else {
                        base_url
                    }),
                ),
            ]);
            if let JsonValue::Object(d) = defaults
                && let Some(JsonValue::Object(p)) = d.get_mut("providers")
            {
                p.set("custom", custom);
            }
        }
        // a CLI turned off stays off even here: losing it would start a program the person stopped
        let mut merged = spread(Some(&*defaults));
        if let Some(r) = read_url {
            merged.set("readUrl", r);
        }
        if let Some(o) = subscription_off {
            merged.set("subscriptionOff", o);
        }
        return JsonValue::Object(resolve_custom_endpoints(&merged));
    };
    let default_providers = prop(defaults, "providers")
        .and_then(as_record)
        .cloned()
        .unwrap_or_default();
    let get_or_null = |key: &str| prop(&settings, key).cloned();
    let mut next = Obj::new();
    next.set(
        "provider",
        coalesce(prop(&settings, "provider"), prop(defaults, "provider"))
            .cloned()
            .unwrap_or(JsonValue::Null),
    );
    // an undefined value stays out of the JSON; the placeholders keep the
    // keys' places for `resolve_custom_endpoints`, which sets or removes both
    next.set(
        "customEndpoints",
        get_or_null("customEndpoints").unwrap_or(JsonValue::Null),
    );
    next.set(
        "customEndpoint",
        get_or_null("customEndpoint").unwrap_or(JsonValue::Null),
    );
    if let Some(r) = read_url {
        next.set("readUrl", r);
    }
    // Trim before migrating: a pasted " deepseek-reasoner " must still hit
    // the retired-id remap instead of being sent to the API verbatim.
    next.set(
        "providers",
        JsonValue::Object(migrate_retired_models(&trim_configs(
            &merge_provider_configs(&default_providers, &stored_providers),
        ))),
    );
    next.set(
        "media",
        resolve_ai_media_settings(coalesce(prop(&settings, "media"), prop(defaults, "media"))),
    );
    next.set(
        "search",
        resolve_ai_search_settings(coalesce(
            prop(&settings, "search"),
            prop(defaults, "search"),
        )),
    );
    next.set(
        "meteredAccepted",
        sanitize_metered_accepted(coalesce(
            prop(&settings, "meteredAccepted"),
            prop(defaults, "meteredAccepted"),
        )),
    );
    if let Some(o) = subscription_off {
        next.set("subscriptionOff", o);
    }
    let enabled = coalesce(
        prop(&settings, "headlessSubscriptionEnabled"),
        prop(defaults, "headlessSubscriptionEnabled"),
    );
    let consent = coalesce(
        prop(&settings, "headlessSubscriptionConsentVersion"),
        prop(defaults, "headlessSubscriptionConsentVersion"),
    );
    next.set(
        "headlessSubscriptionEnabled",
        JsonValue::Bool(headless_subscription_on(enabled, consent)),
    );
    next.set(
        "headlessSubscriptionConsentVersion",
        number(headless_consent_version_of(consent)),
    );
    let seen = coalesce(
        prop(&settings, "subscriptionNoticeSeen"),
        prop(defaults, "subscriptionNoticeSeen"),
    );
    next.set(
        "subscriptionNoticeSeen",
        JsonValue::Bool(matches!(seen, Some(JsonValue::Bool(true)))),
    );
    next.set(
        "subscriptionNoticeVersion",
        number(subscription_notice_version_of(
            prop(&settings, "subscriptionNoticeVersion"),
            seen,
        )),
    );
    let pdf = match prop(&settings, "pdfSendNoticeSeen") {
        Some(JsonValue::Number(x)) if x.is_finite() && x.trunc() == *x && *x > 0.0 => *x,
        _ => 0.0,
    };
    next.set("pdfSendNoticeSeen", number(pdf));
    if matches!(
        coalesce(
            prop(&settings, "internetTools"),
            prop(defaults, "internetTools")
        ),
        Some(JsonValue::Bool(false))
    ) {
        next.set("internetTools", JsonValue::Bool(false));
    }
    // clamped on read: a hand-edited settings file with an absurd cap must not be
    // forwarded to the endpoint verbatim
    if prop(&settings, "maxOutputTokens").is_some() || prop(defaults, "maxOutputTokens").is_some() {
        let cap = coalesce(
            prop(&settings, "maxOutputTokens"),
            prop(defaults, "maxOutputTokens"),
        );
        next.set("maxOutputTokens", number(clamp_max_output_tokens(cap)));
    }
    JsonValue::Object(resolve_custom_endpoints(&next))
}
