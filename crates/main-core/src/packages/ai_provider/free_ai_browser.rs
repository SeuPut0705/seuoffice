//! `packages/ai-provider/src/free-ai.ts`: the screens' helpers of the file
//! that `free_ai.rs` leaves out, as `browser.ts` re-exports them (the
//! connection card, the writers of a connection, the readers of an answer).
//! `browser.ts` itself holds only re-exports: nothing of it is ported under
//! its own name.
//!
//! Settings are JSON values. Where the TypeScript reads
//! `settings.providers[provider]` on settings whose `providers` is missing it
//! throws a `TypeError`; the settings every caller passes went through
//! `normalizeAiSettings`, so a missing table reads as empty here.

use super::jsval::{as_str, number, object, prop, spread, str_trim, text};
use super::providers::{AI_PROVIDERS, listed_models_of};
use jscompat::{JsObject, JsonValue};

/// `FREE_AI_PROVIDERS`: key providers offered as a free connection, in the
/// order the screens list them.
pub const FREE_AI_PROVIDERS: [&str; 2] = ["openrouter", "gemini"];

/// `isFreeAiProvider(id)`
pub fn is_free_ai_provider(id: Option<&JsonValue>) -> bool {
    matches!(id, Some(JsonValue::String(s)) if FREE_AI_PROVIDERS.contains(&s.as_str()))
}

/// `OPENROUTER_FREE_MODELS`: the free models that ran the Word editor's tool
/// loop end to end, best first.
pub const OPENROUTER_FREE_MODELS: [&str; 5] = [
    "nvidia/nemotron-3-super-120b-a12b:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "google/gemma-4-31b-it:free",
    "nvidia/nemotron-3.5-lightning:free",
    "dots-studio/dots-3-note-preview:free",
];

/// `GEMINI_FREE_MODEL`: the Gemini model a free connection starts on.
pub const GEMINI_FREE_MODEL: &str = "gemini-3.5-flash-lite";

/// `FREE_AI_KEY_PAGES[provider]`: where a key for each free connection is
/// made; opened in the system browser.
pub fn free_ai_key_page(provider: &str) -> Option<&'static str> {
    match provider {
        "openrouter" => Some("https://openrouter.ai/settings/keys"),
        "gemini" => Some("https://aistudio.google.com/apikey"),
        _ => None,
    }
}

/// `isOpenRouterFreeModel(model)`: OpenRouter bills nothing for a model id
/// with this suffix.
pub fn is_open_router_free_model(model: Option<&JsonValue>) -> bool {
    matches!(model, Some(JsonValue::String(m)) if jscompat::trim(m).ends_with(":free"))
}

/// `freeAiConnected(settings, provider)`: whether the free card shows the
/// provider as connected. OpenRouter counts only on a free model; Gemini has
/// no free marker in its model ids, so a key is enough.
pub fn free_ai_connected(settings: &JsonValue, provider: &str) -> bool {
    let config = prop(settings, "providers").and_then(|p| prop(p, provider));
    let Some(config) = config.filter(|c| c.truthy()) else {
        return false;
    };
    if str_trim(prop(config, "apiKey")).is_empty() || str_trim(prop(config, "model")).is_empty() {
        return false;
    }
    if provider == "openrouter" {
        is_open_router_free_model(prop(config, "model"))
    } else {
        true
    }
}

/// `keyProviderModels(provider, stored, listed)`: the models a picker lists
/// for a key provider: the fixed catalog, then what the vendor listed for the
/// key and the catalog lacks, with the stored one kept in the list.
pub fn key_provider_models(
    provider: &str,
    stored: &str,
    listed: Option<&JsonValue>,
) -> Vec<String> {
    let model = jscompat::trim(stored);
    // an OpenRouter free connection lists the free models only
    let free = provider == "openrouter" && is_open_router_free_model(Some(&text(model)));
    let catalog: Vec<&str> = if free {
        OPENROUTER_FREE_MODELS.to_vec()
    } else {
        AI_PROVIDERS
            .iter()
            .find(|meta| meta.id == provider)
            .map(|meta| meta.models.to_vec())
            .unwrap_or_default()
    };
    let added: Vec<String> = if free {
        Vec::new()
    } else {
        listed_models_of(listed)
            .unwrap_or_default()
            .into_iter()
            .filter(|id| !catalog.contains(&id.as_str()))
            .collect()
    };
    let mut models: Vec<String> = catalog.iter().map(|id| (*id).to_owned()).collect();
    models.extend(added);
    if model.is_empty() || models.iter().any(|m| m == model) {
        return models;
    }
    let mut with_stored = vec![model.to_owned()];
    with_stored.extend(models);
    with_stored
}

/// `providers` of the settings as a table to copy
fn providers_of(settings: &JsonValue) -> JsObject<JsonValue> {
    spread(prop(settings, "providers"))
}

/// `withFreeAiConnection(settings, provider, connection)`: settings once a
/// free connection is made: its key and model stored, and it is the AI in use.
pub fn with_free_ai_connection(
    settings: &JsonValue,
    provider: &str,
    api_key: &str,
    model: &str,
) -> JsonValue {
    let mut out = spread(Some(settings));
    out.set("provider", text(provider));
    let mut providers = providers_of(settings);
    let mut config = spread(providers.get(provider));
    config.set("apiKey", text(api_key));
    config.set("model", text(model));
    providers.set(provider, JsonValue::Object(config));
    out.set("providers", JsonValue::Object(providers));
    JsonValue::Object(out)
}

/// `withoutFreeAiConnection(settings, provider)`: settings once a free
/// connection is removed: the key is gone, the model is the provider's
/// default again, and a selection of it falls back to `auto`.
pub fn without_free_ai_connection(settings: &JsonValue, provider: &str) -> JsonValue {
    let default_model = AI_PROVIDERS
        .iter()
        .find(|m| m.id == provider)
        .map_or("", |m| m.default_model);
    let mut out = spread(Some(settings));
    let current = prop(settings, "provider");
    if matches!(current, Some(JsonValue::String(s)) if s == provider) {
        out.set("provider", text("auto"));
    }
    let mut providers = providers_of(settings);
    let mut config = spread(providers.get(provider));
    config.set("apiKey", text(""));
    config.set("model", text(default_model));
    providers.set(provider, JsonValue::Object(config));
    out.set("providers", JsonValue::Object(providers));
    JsonValue::Object(out)
}

/// `FREE_AI_IPC_CHANNELS.connect`
pub const FREE_AI_CONNECT_CHANNEL: &str = "ai:free-connect";
/// `FREE_AI_IPC_CHANNELS.cancel`
pub const FREE_AI_CANCEL_CHANNEL: &str = "ai:free-connect-cancel";
/// `FREE_AI_IPC_CHANNELS.disconnect`
pub const FREE_AI_DISCONNECT_CHANNEL: &str = "ai:free-disconnect";
/// `FREE_AI_IPC_CHANNELS.quota`
pub const FREE_AI_QUOTA_CHANNEL: &str = "ai:free-quota";
/// `FREE_AI_IPC_CHANNELS.openKeyPage`
pub const FREE_AI_OPEN_KEY_PAGE_CHANNEL: &str = "ai:free-open-key-page";

/// `FAILURES`: why connecting did not work, in the words the screen translates
const FAILURES: [&str; 5] = ["cancelled", "timeout", "denied", "invalid", "network"];

/// `freeAiConnectResultOf(raw)`: a connect answer as the renderer reads it;
/// anything malformed is a network failure.
pub fn free_ai_connect_result_of(raw: Option<&JsonValue>) -> JsonValue {
    // `raw ?? {}`: null and undefined read as an empty object, and a property
    // of any other non-object is undefined as well
    let raw = raw.filter(|r| !matches!(r, JsonValue::Null));
    let field = |key: &str| raw.and_then(|r| prop(r, key));
    if matches!(field("ok"), Some(JsonValue::Bool(true)))
        && is_free_ai_provider(field("provider"))
        && let Some(model) = as_str(field("model"))
    {
        return object(vec![
            ("ok", JsonValue::Bool(true)),
            (
                "provider",
                field("provider").cloned().unwrap_or(JsonValue::Null),
            ),
            ("model", text(model)),
        ]);
    }
    let reason = FAILURES
        .iter()
        .find(|f| as_str(field("reason")) == Some(**f))
        .copied()
        .unwrap_or("network");
    object(vec![
        ("ok", JsonValue::Bool(false)),
        ("reason", text(reason)),
    ])
}

/// `freeAiQuotaOf(raw)`: a quota answer as the renderer reads it.
pub fn free_ai_quota_of(raw: Option<&JsonValue>) -> Option<JsonValue> {
    let raw = raw.filter(|r| !matches!(r, JsonValue::Null));
    let count = |key: &str| match raw.and_then(|r| prop(r, key)) {
        Some(JsonValue::Number(n)) if n.is_finite() && *n >= 0.0 => Some(*n),
        _ => None,
    };
    let (used, limit, remaining) = (count("used")?, count("limit")?, count("remaining")?);
    Some(object(vec![
        ("used", number(used)),
        ("limit", number(limit)),
        ("remaining", number(remaining)),
    ]))
}
