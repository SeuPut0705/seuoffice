//! `packages/ai-search/src/tool-routing.ts`: which route a generate_image /
//! analyze_media request starts on. Pure: the tools and the capability report
//! ask the same functions, so what is reported as available is what would run.
//!
//! The TypeScript keeps two module-level slots this decides on: the build's
//! `codexImageAvailable` (`image-backend.ts`) and the registered Codex image
//! generator (`codex-image-generator.ts`). Here the caller owns a
//! [`ToolRoutingState`].
//!
//! Settings and statuses are JSON values.

use crate::packages::ai_provider::image_backend::{
    AiImageBackend, ImageBackendState, resolve_image_backend,
};
use crate::packages::ai_provider::jsval::{
    Obj, as_str, object, prop, prop2, spread, str_trim, text,
};
use crate::packages::ai_provider::media::{MediaCapability, get_media_provider_meta};
use crate::packages::ai_provider::media_active::active_media_config;
use crate::packages::ai_provider::provider_selection::{
    AiProviderChoice, is_subscription_provider, select_ai_provider, subscription_off_in,
};
use crate::packages::ai_provider::providers::headless_subscription_on;
use crate::packages::ai_provider::registry_vision::{model_lacks_vision, provider_vision};
use crate::packages::ai_provider::subscription_contract::off_subscription_status;
use jscompat::JsonValue;

/// `AiToolCallPath`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiToolCallPath {
    Screen,
    Headless,
}

/// `AiToolCallContext`: who is asking
#[derive(Debug, Clone, PartialEq)]
pub struct AiToolCallContext {
    pub path: AiToolCallPath,
    /// connection status of the subscription CLIs as the caller last checked
    /// it; `None` = none connected
    pub statuses: Option<JsonValue>,
    /// directory of the headless lock and ledger; a headless caller without
    /// one never uses a subscription
    pub data_dir: Option<String>,
}

impl AiToolCallContext {
    /// `SCREEN_TOOL_CONTEXT`: the screen path with no subscription status
    pub fn screen() -> Self {
        AiToolCallContext {
            path: AiToolCallPath::Screen,
            statuses: None,
            data_dir: None,
        }
    }
}

/// `let codexImageAvailable` of `image-backend.ts` and `let generator` of
/// `codex-image-generator.ts`
#[derive(Debug, Default)]
pub struct ToolRoutingState {
    pub image_backend: ImageBackendState,
    /// `registerCodexImageGenerator(fn)` was called with a function
    pub codex_generator_registered: bool,
}

const HEADLESS_SETTING_HINT: &str = " Command-line and integration requests use a subscription login only after that is turned on under Settings > AI > Advanced.";

/// `headlessSubscriptionBlocked(settings, context)`: true when this request
/// is on the automatic-call path and may not use a subscription login.
pub fn headless_subscription_blocked(settings: &JsonValue, context: &AiToolCallContext) -> bool {
    if context.path != AiToolCallPath::Headless {
        return false;
    }
    // without a directory for the lock, one request at a time could not be
    // kept, so the answer is no
    let data_dir = context.data_dir.as_deref().is_some_and(|d| !d.is_empty());
    !(headless_subscription_on(
        prop(settings, "headlessSubscriptionEnabled"),
        prop(settings, "headlessSubscriptionConsentVersion"),
    ) && data_dir)
}

/// `routingStatuses(settings, context)`: the statuses routing may look at. A
/// blocked headless request behaves as if no subscription existed, so
/// `ready` logins are left out; a metered login stays. A CLI turned off in
/// this app reads as off whatever its status says.
fn routing_statuses(settings: &JsonValue, context: &AiToolCallContext) -> JsonValue {
    let mut statuses = spread(context.statuses.as_ref());
    for id in ["claude-code", "codex"] {
        if subscription_off_in(settings, Some(&text(id))) {
            statuses.set(id, off_subscription_status(id));
        }
    }
    if !headless_subscription_blocked(settings, context) {
        return JsonValue::Object(statuses);
    }
    let mut visible = Obj::new();
    for id in ["claude-code", "chatgpt", "codex"] {
        let status = statuses.get(id);
        if let Some(status) = status.filter(|s| s.truthy())
            && !matches!(prop(status, "state"), Some(JsonValue::String(s)) if s == "ready")
        {
            visible.set(id, status.clone());
        }
    }
    JsonValue::Object(visible)
}

/// `codexImageRouteOffered()`: Codex image generation exists in this process:
/// the build announces it and a generator is registered.
pub fn codex_image_route_offered(state: &ToolRoutingState) -> bool {
    state.image_backend.codex_image_generation_available() && state.codex_generator_registered
}

/// `resolveImageRoute(settings, context)`: the backend a generate_image
/// request starts on (chosen once, never changed midway).
pub fn resolve_image_route(
    state: &ToolRoutingState,
    settings: &JsonValue,
    context: &AiToolCallContext,
) -> AiImageBackend {
    let statuses = routing_statuses(settings, context);
    resolve_image_backend(
        &state.image_backend,
        Some(settings),
        prop(&statuses, "codex"),
        Some(codex_image_route_offered(state)),
    )
}

/// `imageGenerationUnavailableMessage(settings, context)`
pub fn image_generation_unavailable_message(
    state: &ToolRoutingState,
    settings: &JsonValue,
    context: &AiToolCallContext,
) -> String {
    let offered = codex_image_route_offered(state);
    let blocked = headless_subscription_blocked(settings, context);
    let connect = if offered && !blocked {
        "connect Codex with a subscription login under Settings > AI, or "
    } else {
        ""
    };
    let hint = if offered && blocked {
        HEADLESS_SETTING_HINT
    } else {
        ""
    };
    format!(
        "Image generation is unavailable: {connect}add an image provider key under Settings > AI > Advanced.{hint} Use image search for imagery instead."
    )
}

/// `AiKeyMediaRoute`: `{ kind: 'key', provider, config }`
#[derive(Debug, Clone, PartialEq)]
pub struct AiKeyMediaRoute {
    pub provider: &'static str,
    pub config: JsonValue,
}

/// `AiImageAnalysisRoute`
#[derive(Debug, Clone, PartialEq)]
pub enum AiImageAnalysisRoute {
    Key(AiKeyMediaRoute),
    /// the AI provider the chat runs on is shown the image; `billing` is
    /// `subscription`, `metered` or `key`
    Chat {
        provider: String,
        billing: &'static str,
    },
    None {
        message: String,
    },
}

impl AiImageAnalysisRoute {
    /// The object the TypeScript builds, its keys in the order it writes them.
    pub fn to_json(&self) -> JsonValue {
        match self {
            AiImageAnalysisRoute::Key(route) => route.to_json(),
            AiImageAnalysisRoute::Chat { provider, billing } => object(vec![
                ("kind", text("chat")),
                ("provider", text(provider.as_str())),
                ("billing", text(*billing)),
            ]),
            AiImageAnalysisRoute::None { message } => none_json(message),
        }
    }
}

impl AiKeyMediaRoute {
    pub fn to_json(&self) -> JsonValue {
        object(vec![
            ("kind", text("key")),
            ("provider", text(self.provider)),
            ("config", self.config.clone()),
        ])
    }
}

fn none_json(message: &str) -> JsonValue {
    object(vec![("kind", text("none")), ("message", text(message))])
}

/// `AiVideoAnalysisRoute`
#[derive(Debug, Clone, PartialEq)]
pub enum AiVideoAnalysisRoute {
    Key(AiKeyMediaRoute),
    None { message: String },
}

impl AiVideoAnalysisRoute {
    pub fn to_json(&self) -> JsonValue {
        match self {
            AiVideoAnalysisRoute::Key(route) => route.to_json(),
            AiVideoAnalysisRoute::None { message } => none_json(message),
        }
    }
}

/// `keyMediaRoute(settings, capability)`: the selected key provider for one
/// analysis capability, when it has a key and a model to ask.
fn key_media_route(settings: &JsonValue, capability: MediaCapability) -> Option<AiKeyMediaRoute> {
    let (provider, config) = active_media_config(settings, capability)?;
    // a custom endpoint ships no default model: without one there is nothing
    // to ask
    let configured = str_trim(prop(&config, "analysisModel"));
    let has_model = !configured.is_empty()
        || get_media_provider_meta(&text(provider))
            .is_some_and(|meta| !meta.default_analysis_model.is_empty());
    has_model.then_some(AiKeyMediaRoute { provider, config })
}

/// `resolveImageAnalysisRoute(settings, context)`: the selected key analysis
/// provider when it is filled in, otherwise the AI provider the chat runs on,
/// resolved the way the chat resolves it. `Err` is the `Error` of
/// `getProviderAdapter` for an id the registry lacks.
pub fn resolve_image_analysis_route(
    settings: &JsonValue,
    context: &AiToolCallContext,
) -> Result<AiImageAnalysisRoute, String> {
    if let Some(key) = key_media_route(settings, MediaCapability::Analysis) {
        return Ok(AiImageAnalysisRoute::Key(key));
    }
    let blocked = headless_subscription_blocked(settings, context);
    let choice = select_ai_provider(settings, &routing_statuses(settings, context));
    let (provider, metered) = match choice {
        AiProviderChoice::Connected { provider, metered } => (provider, metered),
        AiProviderChoice::NotConnected { .. } => {
            let message = if blocked {
                format!(
                    "Image analysis is unavailable: select an image analysis provider key under Settings > AI > Advanced.{HEADLESS_SETTING_HINT}"
                )
            } else {
                "Image analysis is unavailable: no AI provider is connected. Connect Claude Code or Codex under Settings > AI, or select an image analysis provider key under Settings > AI > Advanced.".to_owned()
            };
            return Ok(AiImageAnalysisRoute::None { message });
        }
    };
    let model = as_str(prop2(prop(settings, "providers"), &provider, "model")).unwrap_or("");
    if !provider_vision(&provider)? || model_lacks_vision(model) {
        return Ok(AiImageAnalysisRoute::None {
            message: "Image analysis is unavailable: the selected AI model cannot read images. Select a model that can, or an image analysis provider key under Settings > AI > Advanced.".to_owned(),
        });
    }
    let billing = if !is_subscription_provider(Some(&text(provider.as_str()))) {
        "key"
    } else if metered {
        "metered"
    } else {
        "subscription"
    };
    Ok(AiImageAnalysisRoute::Chat { provider, billing })
}

/// `resolveVideoAnalysisRoute(settings)`: video and audio analysis: a key
/// provider that reads video, or nothing.
pub fn resolve_video_analysis_route(settings: &JsonValue) -> AiVideoAnalysisRoute {
    match key_media_route(settings, MediaCapability::Video) {
        Some(route) => AiVideoAnalysisRoute::Key(route),
        None => AiVideoAnalysisRoute::None {
            message: "Video and audio analysis is unavailable: it needs a key provider that reads video (for example Gemini), selected as the video analysis provider under Settings > AI > Advanced.".to_owned(),
        },
    }
}
