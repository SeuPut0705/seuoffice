//! `packages/ai-provider/src/media.ts`: the catalog and the settings
//! block; what only the request path reads (`activeMediaProvider`,
//! `mediaConfigUsable`) is not here.

use super::jsval::{Obj, as_str, assign, coalesce, entries_of, object, prop, text};
use jscompat::{JsonValue, trim};

/// `AiMediaProviderMeta`
#[derive(Debug, Clone, Copy)]
pub struct AiMediaProviderMeta {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub key_placeholder: &'static str,
    pub needs_base_url: bool,
    pub default_base_url: &'static str,
    /// `None`: the provider does not generate images
    pub image_protocol: Option<&'static str>,
    pub image_models: &'static [&'static str],
    pub default_image_model: &'static str,
    /// `None`: the provider does not analyze media
    pub analysis_protocol: Option<&'static str>,
    pub analysis_models: &'static [&'static str],
    pub default_analysis_model: &'static str,
    pub video_analysis: bool,
}

pub const OPENAI_IMAGES_BASE_URL: &str = "https://api.openai.com/v1";
pub const GEMINI_MEDIA_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
pub const ARK_BASE_URL: &str = "https://ark.cn-beijing.volces.com/api/v3";
pub const ZHIPU_BASE_URL: &str = "https://open.bigmodel.cn/api/paas/v4";
pub const XAI_BASE_URL: &str = "https://api.x.ai/v1";
/// DashScope root: images ride /api/v1/services/aigc/..., understanding rides /compatible-mode/v1
pub const DASHSCOPE_BASE_URL: &str = "https://dashscope.aliyuncs.com";
pub const MINIMAX_BASE_URL: &str = "https://api.minimax.io/v1";
pub const STABILITY_BASE_URL: &str = "https://api.stability.ai";
pub const BFL_BASE_URL: &str = "https://api.bfl.ai";
/// DeepSeek's OpenAI-compatible root
pub const DEEPSEEK_MEDIA_BASE_URL: &str = "https://api.deepseek.com/v1";

/// `AI_MEDIA_PROVIDERS` (the comments of the TypeScript catalog are in
/// `packages/ai-provider/src/media.ts`)
pub const AI_MEDIA_PROVIDERS: &[AiMediaProviderMeta] = &[
    AiMediaProviderMeta {
        id: "openai",
        label: "OpenAI",
        description: "GPT Image for generation and editing; GPT chat models for image analysis",
        key_placeholder: "sk-...",
        needs_base_url: false,
        default_base_url: "https://api.openai.com/v1",
        image_protocol: Some("openai-images"),
        image_models: &[
            "gpt-image-2.5-sunburst",
            "gpt-image-2.5-flare",
            "gpt-image-2",
            "gpt-image-1.5",
            "gpt-image-1",
            "gpt-image-1-mini",
        ],
        default_image_model: "gpt-image-2",
        analysis_protocol: Some("openai-chat"),
        analysis_models: &[
            "gpt-6.1-terra",
            "gpt-6-sol",
            "gpt-6-luna",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
            "gpt-5.4-mini",
        ],
        default_analysis_model: "gpt-5.6-luna",
        video_analysis: false,
    },
    AiMediaProviderMeta {
        id: "gemini",
        label: "Gemini",
        description: "Gemini native image output (the Nano Banana family); Gemini reads images, video and audio",
        key_placeholder: "AIza...",
        needs_base_url: false,
        default_base_url: "https://generativelanguage.googleapis.com/v1beta",
        image_protocol: Some("gemini"),
        image_models: &[
            "gemini-nano-banana-2.1",
            "gemini-3.1-flash-image",
            "gemini-3-pro-image",
            "gemini-3.1-flash-lite-image",
            "gemini-2.5-flash-image",
        ],
        default_image_model: "gemini-nano-banana-2.1",
        analysis_protocol: Some("gemini"),
        analysis_models: &[
            "gemini-4-argon",
            "gemini-3.8-flash",
            "gemini-3.7-flash",
            "gemini-3.1-pro-preview",
            "gemini-3.6-flash",
        ],
        default_analysis_model: "gemini-3.8-flash",
        video_analysis: true,
    },
    AiMediaProviderMeta {
        id: "doubao",
        label: "Doubao (Volcengine Ark)",
        description: "Seedream image generation and editing; Doubao Seed reads images and video",
        key_placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        needs_base_url: false,
        default_base_url: "https://ark.cn-beijing.volces.com/api/v3",
        image_protocol: Some("openai-images"),
        image_models: &[
            "doubao-seedream-5-0-pro-260628",
            "doubao-seedream-5-0-flash-260915",
            "doubao-seedream-5-0-260128",
        ],
        default_image_model: "doubao-seedream-5-0-pro-260628",
        analysis_protocol: Some("openai-chat"),
        analysis_models: &[
            "doubao-seed-2-1-pro-260915",
            "doubao-seed-2-1-pro-260628",
            "doubao-seed-2-1-turbo-260628",
        ],
        default_analysis_model: "doubao-seed-2-1-pro-260915",
        video_analysis: true,
    },
    AiMediaProviderMeta {
        id: "glm",
        label: "GLM (Zhipu)",
        description: "CogView image generation; GLM-V reads images and video",
        key_placeholder: "xxxxxxxx.xxxxxxxx",
        needs_base_url: false,
        default_base_url: "https://open.bigmodel.cn/api/paas/v4",
        image_protocol: Some("openai-images"),
        image_models: &["glm-image", "cogview-4-250304", "cogview-3-flash"],
        default_image_model: "glm-image",
        analysis_protocol: Some("openai-chat"),
        analysis_models: &["glm-4.6v", "glm-4.6v-flash"],
        default_analysis_model: "glm-4.6v",
        video_analysis: true,
    },
    AiMediaProviderMeta {
        id: "xai",
        label: "Grok (xAI)",
        description: "Grok Imagine image generation; Grok reads images",
        key_placeholder: "xai-...",
        needs_base_url: false,
        default_base_url: "https://api.x.ai/v1",
        image_protocol: Some("openai-images"),
        image_models: &["grok-imagine-image-2.0", "grok-2-image-1212"],
        default_image_model: "grok-imagine-image-2.0",
        analysis_protocol: Some("openai-chat"),
        analysis_models: &["grok-4.6", "grok-4.5"],
        default_analysis_model: "grok-4.6",
        video_analysis: false,
    },
    AiMediaProviderMeta {
        id: "qwen",
        label: "Qwen (Alibaba Cloud)",
        description: "Qwen-Image generation; Qwen-VL reads images and video (DashScope)",
        key_placeholder: "sk-...",
        needs_base_url: false,
        default_base_url: "https://dashscope.aliyuncs.com",
        image_protocol: Some("dashscope"),
        image_models: &[
            "qwen-image-3.0-pro",
            "qwen-image-3.0",
            "qwen-image-2.0-pro",
            "qwen-image-2.0",
            "qwen-image-plus",
            "qwen-image",
        ],
        default_image_model: "qwen-image-3.0-pro",
        analysis_protocol: Some("openai-chat"),
        analysis_models: &[
            "qwen3-vl-plus",
            "qwen3-vl-flash",
            "qwen3.8-max",
            "qwen3.7-plus",
        ],
        default_analysis_model: "qwen3-vl-plus",
        video_analysis: true,
    },
    AiMediaProviderMeta {
        id: "minimax",
        label: "MiniMax",
        description: "Image generation; MiniMax-M3 reads images and video (use api.minimaxi.com/v1 for CN)",
        key_placeholder: "eyJ...",
        needs_base_url: false,
        default_base_url: "https://api.minimax.io/v1",
        image_protocol: Some("minimax"),
        image_models: &["image-01"],
        default_image_model: "image-01",
        analysis_protocol: Some("openai-chat"),
        analysis_models: &["MiniMax-M3"],
        default_analysis_model: "MiniMax-M3",
        video_analysis: true,
    },
    AiMediaProviderMeta {
        id: "stability",
        label: "Stability AI",
        description: "Stable Image Ultra/Core and Stable Diffusion 3.5 through the Stability REST API",
        key_placeholder: "sk-...",
        needs_base_url: false,
        default_base_url: "https://api.stability.ai",
        image_protocol: Some("stability"),
        image_models: &[
            "stable-image-ultra",
            "stable-image-core",
            "sd3.5-large",
            "sd3.5-medium",
        ],
        default_image_model: "stable-image-ultra",
        analysis_protocol: None,
        analysis_models: &[],
        default_analysis_model: "",
        video_analysis: false,
    },
    AiMediaProviderMeta {
        id: "bfl",
        label: "FLUX (Black Forest Labs)",
        description: "FLUX image generation through the Black Forest Labs API",
        key_placeholder: "API key",
        needs_base_url: false,
        default_base_url: "https://api.bfl.ai",
        image_protocol: Some("bfl"),
        image_models: &["flux-2-pro", "flux-3-image", "flux-pro-1.1"],
        default_image_model: "flux-2-pro",
        analysis_protocol: None,
        analysis_models: &[],
        default_analysis_model: "",
        video_analysis: false,
    },
    AiMediaProviderMeta {
        id: "microsoft",
        label: "Microsoft (MAI-Image)",
        description: "MAI-Image generation and editing through Microsoft Foundry; base URL is your resource endpoint (https://<resource>.services.ai.azure.com)",
        key_placeholder: "API key",
        needs_base_url: true,
        default_base_url: "",
        image_protocol: Some("mai"),
        image_models: &[
            "MAI-Image-2.6",
            "MAI-Image-2.6-Flash",
            "MAI-Image-2.5-Pro",
            "MAI-Image-2.5-Flash",
            "MAI-Image-2.5",
        ],
        default_image_model: "MAI-Image-2.6",
        analysis_protocol: None,
        analysis_models: &[],
        default_analysis_model: "",
        video_analysis: false,
    },
    AiMediaProviderMeta {
        id: "deepseek",
        label: "DeepSeek",
        description: "DeepSeek V4.1 Flash reads images (native multimodal); no image generation",
        key_placeholder: "sk-...",
        needs_base_url: false,
        default_base_url: "https://api.deepseek.com/v1",
        image_protocol: None,
        image_models: &[],
        default_image_model: "",
        analysis_protocol: Some("openai-chat"),
        analysis_models: &["deepseek-flash"],
        default_analysis_model: "deepseek-flash",
        video_analysis: false,
    },
    AiMediaProviderMeta {
        id: "custom",
        label: "Custom",
        description: "Any OpenAI-compatible endpoint: /images/generations and /chat/completions",
        key_placeholder: "API Key",
        needs_base_url: true,
        default_base_url: "",
        image_protocol: Some("openai-images"),
        image_models: &[],
        default_image_model: "",
        analysis_protocol: Some("openai-chat"),
        analysis_models: &[],
        default_analysis_model: "",
        video_analysis: false,
    },
];

/// `MediaCapability`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaCapability {
    Image,
    Analysis,
    Video,
}

/// `getMediaProviderMeta(id)`: `None` for the selection values that name no
/// catalog entry (`codex`, `chat`, `none`).
pub fn get_media_provider_meta(id: &JsonValue) -> Option<&'static AiMediaProviderMeta> {
    let id = as_str(Some(id))?;
    AI_MEDIA_PROVIDERS.iter().find(|m| m.id == id)
}

/// `providerHasCapability(meta, capability)`
pub fn provider_has_capability(meta: &AiMediaProviderMeta, capability: MediaCapability) -> bool {
    match capability {
        MediaCapability::Image => meta.image_protocol.is_some(),
        MediaCapability::Video => meta.analysis_protocol.is_some() && meta.video_analysis,
        MediaCapability::Analysis => meta.analysis_protocol.is_some(),
    }
}

/// `defaultAiMediaSettings()`
pub fn default_ai_media_settings() -> JsonValue {
    let mut providers = Obj::new();
    for meta in AI_MEDIA_PROVIDERS {
        let mut entries = vec![
            ("apiKey", text("")),
            ("imageModel", text(meta.default_image_model)),
            ("analysisModel", text(meta.default_analysis_model)),
        ];
        if meta.needs_base_url {
            entries.push(("baseUrl", text("")));
        }
        providers.set(meta.id, object(entries));
    }
    object(vec![
        ("imageProvider", text("codex")),
        ("analysisProvider", text("chat")),
        ("videoAnalysisProvider", text("none")),
        ("providers", JsonValue::Object(providers)),
    ])
}

/// `str(v, fallback)` of `resolveAiMediaSettings`
fn str_or(value: Option<&JsonValue>, fallback: &str) -> String {
    match as_str(value) {
        Some(t) => trim(t).to_owned(),
        None => fallback.to_owned(),
    }
}

/// `resolveAiMediaSettings(stored)`: a stored media block over the defaults,
/// pasted whitespace trimmed. `stored` is anything the file held, `None` for
/// `undefined`.
pub fn resolve_ai_media_settings(stored: Option<&JsonValue>) -> JsonValue {
    let defaults = default_ai_media_settings();
    // `if (!stored)`
    let Some(stored) = stored.filter(|s| s.truthy()) else {
        return defaults;
    };
    let mut providers = match prop(&defaults, "providers") {
        Some(JsonValue::Object(p)) => p.clone(),
        _ => Obj::new(),
    };
    let stored_providers = coalesce(prop(stored, "providers"), None);
    let entries = stored_providers.map(entries_of).unwrap_or_default();
    for (id, config) in entries {
        // `!config || typeof config !== 'object'`
        if !matches!(config, JsonValue::Object(_) | JsonValue::Array(_)) {
            continue;
        }
        let base = providers.get(&id).cloned();
        let base_ref = base.as_ref();
        let base_str = |key: &str| -> String {
            as_str(base_ref.and_then(|b| prop(b, key)))
                .unwrap_or_default()
                .to_owned()
        };
        let mut entry = vec![
            (
                "apiKey",
                text(str_or(prop(&config, "apiKey"), &base_str("apiKey"))),
            ),
            (
                "imageModel",
                text(str_or(prop(&config, "imageModel"), &base_str("imageModel"))),
            ),
            (
                "analysisModel",
                text(str_or(
                    prop(&config, "analysisModel"),
                    &base_str("analysisModel"),
                )),
            ),
        ];
        if let Some(url) = prop(&config, "baseUrl") {
            entry.push(("baseUrl", text(str_or(Some(url), &base_str("baseUrl")))));
        } else if let Some(url) = base_ref.and_then(|b| prop(b, "baseUrl")) {
            entry.push(("baseUrl", url.clone()));
        }
        assign(&mut providers, &id, object(entry));
    }
    let legacy = prop(stored, "provider");
    let default_analysis = prop(&defaults, "analysisProvider");
    let analysis_provider = coalesce(
        prop(stored, "analysisProvider"),
        coalesce(legacy, default_analysis),
    )
    .cloned()
    .unwrap_or(JsonValue::Null);
    let image_provider = coalesce(
        prop(stored, "imageProvider"),
        coalesce(legacy, prop(&defaults, "imageProvider")),
    )
    .cloned()
    .unwrap_or(JsonValue::Null);
    let video_fallback = if as_str(Some(&analysis_provider)) == Some("chat") {
        text("none")
    } else {
        analysis_provider.clone()
    };
    let video = coalesce(prop(stored, "videoAnalysisProvider"), Some(&video_fallback))
        .cloned()
        .unwrap_or(JsonValue::Null);
    object(vec![
        ("imageProvider", image_provider),
        ("analysisProvider", analysis_provider),
        ("videoAnalysisProvider", video),
        ("providers", JsonValue::Object(providers)),
    ])
}

/// The ids of `AI_MEDIA_PROVIDERS`, in catalog order.
pub fn media_provider_ids() -> Vec<&'static str> {
    AI_MEDIA_PROVIDERS.iter().map(|m| m.id).collect()
}
