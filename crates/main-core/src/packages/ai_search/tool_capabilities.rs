//! `packages/ai-search/src/tool-capabilities.ts`: what the search and media
//! tools can do right now, and through which kind of route. It asks the same
//! routing functions the tools start a request with.

use super::search_tools::{keyless_search_backend, selected_search_key};
use super::tool_routing::{
    AiImageAnalysisRoute, AiToolCallContext, AiVideoAnalysisRoute, ToolRoutingState,
    image_generation_unavailable_message, resolve_image_analysis_route, resolve_image_route,
    resolve_video_analysis_route,
};
use crate::packages::ai_provider::image_backend::AiImageBackend;
use crate::packages::ai_provider::jsval::{object, text};
use crate::packages::ai_provider::legacy_settings::normalize_ai_settings;
use jscompat::JsonValue;

/// `unavailable(message)`
fn unavailable(message: &str) -> JsonValue {
    object(vec![
        ("available", JsonValue::Bool(false)),
        ("route", JsonValue::Null),
        ("provider", JsonValue::Null),
        ("message", text(message)),
    ])
}

/// `via(route, provider)`: `route` is `free`, `key` or `subscription`
fn via(route: &str, provider: &str) -> JsonValue {
    object(vec![
        ("available", JsonValue::Bool(true)),
        ("route", text(route)),
        ("provider", text(provider)),
    ])
}

/// `{ ...via('key', provider), metered: true }`
fn via_metered(provider: &str) -> JsonValue {
    object(vec![
        ("available", JsonValue::Bool(true)),
        ("route", text("key")),
        ("provider", text(provider)),
        ("metered", JsonValue::Bool(true)),
    ])
}

/// `aiToolCapabilities(settings, context)`: `settings` may be anything a
/// settings file held: removed and unknown selections read as their defaults.
/// `Err` is the `Error` of `getProviderAdapter` for an id the registry lacks.
pub fn ai_tool_capabilities(
    state: &ToolRoutingState,
    settings: Option<&JsonValue>,
    context: &AiToolCallContext,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<JsonValue, String> {
    // `settings ?? undefined`
    let settings = settings.filter(|s| !matches!(s, JsonValue::Null));
    let resolved = normalize_ai_settings(None, settings, None);

    // the same answer the search tools route on: the selected key provider,
    // or the keyless chain
    let search = selected_search_key(&resolved, env).map(|(provider, _)| provider);
    // only Serper, Serply and SearchApi have an image endpoint; every other
    // selection searches images for free
    let image_search_keyed = matches!(search, Some("serper" | "serply" | "searchapi"));

    let image = resolve_image_route(state, &resolved, context);
    let analysis = resolve_image_analysis_route(&resolved, context)?;
    let video = resolve_video_analysis_route(&resolved);

    let web_search = match search {
        Some(provider) => via("key", provider),
        None => via("free", keyless_search_backend(&resolved)),
    };
    let image_search = match search {
        Some(provider) if image_search_keyed => via("key", provider),
        _ => via("free", "duckduckgo"),
    };
    let image_generation = match &image {
        AiImageBackend::None => unavailable(&image_generation_unavailable_message(
            state, &resolved, context,
        )),
        AiImageBackend::Codex => via("subscription", "codex"),
        AiImageBackend::Key { provider, .. } => via("key", provider),
    };
    let image_analysis = match &analysis {
        AiImageAnalysisRoute::None { message } => unavailable(message),
        AiImageAnalysisRoute::Key(route) => via("key", route.provider),
        AiImageAnalysisRoute::Chat { provider, billing } => {
            if *billing == "subscription" {
                via("subscription", provider)
            } else if *billing == "metered" {
                via_metered(provider)
            } else {
                via("key", provider)
            }
        }
    };
    let video_analysis = match &video {
        AiVideoAnalysisRoute::None { message } => unavailable(message),
        AiVideoAnalysisRoute::Key(route) => via("key", route.provider),
    };
    Ok(object(vec![
        ("webSearch", web_search),
        ("imageSearch", image_search),
        ("imageGeneration", image_generation),
        // analyze_media on images
        ("imageAnalysis", image_analysis),
        // analyze_media on video and audio
        ("videoAnalysis", video_analysis),
    ]))
}
