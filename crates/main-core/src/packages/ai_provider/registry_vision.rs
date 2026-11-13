//! `packages/ai-provider/src/registry.ts`: what the media tool routing reads
//! of it: `modelLacksVision` and the `vision` capability of
//! `getProviderAdapter(id).capabilities`. The adapters' endpoint resolution
//! is not ported (see `registry.rs`).

use jscompat::js_regex;

/// `modelLacksVision(model)`: model ids that reject image input even under a
/// vision-capable provider.
pub fn model_lacks_vision(model: &str) -> bool {
    // MiniMax-M2.7 remains text-only when MiniMax-M3 enables provider vision.
    if js_regex!(r"(^|\/)minimax-m2\.7($|-)", "i").test(model) {
        return true;
    }
    // Atlas Cloud serves these text-only; matched on the full namespaced id
    if js_regex!(
        r"^(?:zai-org\/glm-5\.3|minimaxai\/minimax-m(?:3|2\.5))$",
        "i"
    )
    .test(model)
    {
        return true;
    }
    // Runcrate serves these text-only
    if js_regex!(r"^(?:qwen\/qwen3\.8-flash|openai\/gpt-oss-120b)$", "i").test(model) {
        return true;
    }
    js_regex!(r"(^|\/)deep-?seek-v4-(?:pro(?:$|-)|flash(?!-vision))", "i").test(model)
        || js_regex!(
            r"(^|\/)(?:ling-(?:3\.0-flash(?!-vl)|3\.0-tiny|2\.6-1t|2\.6-flash)|ring-2\.6-1t|longcat-2\.0(?:$|-))",
            "i"
        )
        .test(model)
}

/// the providers whose adapter says `vision: false`; every other provider of
/// the registry says `true`
const TEXT_ONLY_PROVIDERS: [&str; 7] = [
    "glm", "qwen", "hunyuan", "spark", "mistral", "upstage", "exaone",
];

/// The ids of `AI_PROVIDER_ADAPTERS`: the ids of `AI_PROVIDERS`, in order.
const ADAPTER_IDS: [&str; 35] = [
    "claude-code",
    "chatgpt",
    "codex",
    "anthropic",
    "gemini",
    "deepseek",
    "openai",
    "kimi",
    "glm",
    "qwen",
    "doubao",
    "mimo",
    "hunyuan",
    "ling",
    "spark",
    "longcat",
    "minimax",
    "xai",
    "mistral",
    "upstage",
    "exaone",
    "openrouter",
    "requesty",
    "opper",
    "cheaperinference",
    "atlascloud",
    "runcrate",
    "cloudgpu",
    "siliconflow",
    "ppio",
    "opencode-zen",
    "opencode-go",
    "commandcode",
    "custom",
    "gateway",
];

/// `getProviderAdapter(provider).capabilities.vision`: throws on an id that
/// is not in the registry (the settings files are user data and can carry
/// anything, `auto` included); the error is the message the TypeScript throws.
pub fn provider_vision(provider: &str) -> Result<bool, String> {
    if !ADAPTER_IDS.contains(&provider) {
        return Err(format!("Unknown provider: {provider}"));
    }
    Ok(!TEXT_ONLY_PROVIDERS.contains(&provider))
}
