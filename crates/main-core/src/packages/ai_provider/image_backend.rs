//! `packages/ai-provider/src/image-backend.ts`: which backend a generate_image
//! request starts on, the Codex subscription or a key provider.
//!
//! The TypeScript keeps `codexImageAvailable` at module level; here the
//! caller owns an [`ImageBackendState`]. Where a function defaults a
//! parameter to `codexImageGenerationAvailable()`, it takes the state.

use super::jsval::{object, prop, prop2, str_trim, text};
use super::legacy_settings::DEFAULT_AI_IMAGE_PROVIDER;
use super::media::{
    AI_MEDIA_PROVIDERS, AiMediaProviderMeta, MediaCapability, get_media_provider_meta,
    provider_has_capability,
};
use super::media_active::media_config_usable;
use jscompat::JsonValue;

/// `let codexImageAvailable = false`
#[derive(Debug, Default)]
pub struct ImageBackendState {
    codex_image_available: bool,
}

impl ImageBackendState {
    pub fn new() -> Self {
        Self::default()
    }

    /// `setCodexImageGenerationAvailable(available)`: called by the Codex
    /// image backend when it loads, so the answer is "yes" exactly in the
    /// processes that can run it.
    pub fn set_codex_image_generation_available(&mut self, available: bool) {
        self.codex_image_available = available;
    }

    /// `codexImageGenerationAvailable()`
    pub fn codex_image_generation_available(&self) -> bool {
        self.codex_image_available
    }
}

/// `AiImageBackend`
#[derive(Debug, Clone, PartialEq)]
pub enum AiImageBackend {
    Codex,
    Key {
        provider: &'static str,
        config: JsonValue,
    },
    /// nothing can generate an image: the tool answers "unavailable"
    None,
}

impl AiImageBackend {
    /// The object the TypeScript builds, its keys in the order it writes them.
    pub fn to_json(&self) -> JsonValue {
        match self {
            AiImageBackend::Codex => object(vec![("kind", text("codex"))]),
            AiImageBackend::Key { provider, config } => object(vec![
                ("kind", text("key")),
                ("provider", text(*provider)),
                ("config", config.clone()),
            ]),
            AiImageBackend::None => object(vec![("kind", text("none"))]),
        }
    }
}

/// `usableKeyConfig(settings, id)`
fn usable_key_config(
    settings: Option<&JsonValue>,
    id: Option<&JsonValue>,
) -> Option<(&'static AiMediaProviderMeta, JsonValue)> {
    let meta = get_media_provider_meta(id?)?;
    if !provider_has_capability(meta, MediaCapability::Image) {
        return None;
    }
    let config = prop2(
        settings.and_then(|s| prop(s, "media")),
        "providers",
        meta.id,
    );
    if !media_config_usable(meta, config) {
        return None;
    }
    let config = config?;
    // custom endpoints ship no default image model: without one there is
    // nothing to request
    if str_trim(prop(config, "imageModel")).is_empty() && meta.default_image_model.is_empty() {
        return None;
    }
    Some((meta, config.clone()))
}

/// `configuredImageKeyProviders(settings)`: key providers able to generate an
/// image right now, in catalog order.
pub fn configured_image_key_providers(settings: Option<&JsonValue>) -> Vec<&'static str> {
    AI_MEDIA_PROVIDERS
        .iter()
        .filter(|meta| usable_key_config(settings, Some(&text(meta.id))).is_some())
        .map(|meta| meta.id)
        .collect()
}

/// `imageProviderSelection(settings, available)`: the image selection as the
/// UI shows it. A removed, unknown or image-less stored id reads as the
/// default, and the default (the Codex subscription) reads as `none` in a
/// build without Codex image generation.
pub fn image_provider_selection(settings: Option<&JsonValue>, available: bool) -> String {
    let stored = prop2(settings, "media", "imageProvider");
    if matches!(stored, Some(JsonValue::String(s)) if s == "none") {
        return "none".to_owned();
    }
    if let Some(key) = stored.and_then(get_media_provider_meta)
        && provider_has_capability(key, MediaCapability::Image)
    {
        return key.id.to_owned();
    }
    let selection = if matches!(stored, Some(JsonValue::String(s)) if s == "codex") {
        "codex"
    } else {
        DEFAULT_AI_IMAGE_PROVIDER
    };
    if selection == "codex" && !available {
        "none".to_owned()
    } else {
        selection.to_owned()
    }
}

/// `resolveImageBackend(settings, context)`: the backend for a request that
/// is about to start:
///
/// 1. the selected backend, when it can run;
/// 2. otherwise the other kind: a configured key provider for a selected
///    Codex, Codex for a selected key provider;
/// 3. otherwise any configured key provider; several are tried in catalog
///    order.
///
/// `codex` is the Codex connection status (`None` treats the subscription as
/// absent); `codex_image_available` defaults to the state's answer.
pub fn resolve_image_backend(
    state: &ImageBackendState,
    settings: Option<&JsonValue>,
    codex: Option<&JsonValue>,
    codex_image_available: Option<bool>,
) -> AiImageBackend {
    let available = codex_image_available.unwrap_or(state.codex_image_generation_available());
    let ready = matches!(
        codex.and_then(|c| prop(c, "state")),
        Some(JsonValue::String(s)) if s == "ready"
    );
    let codex_usable = available && ready;
    let selection = image_provider_selection(settings, true);
    if selection == "codex" && codex_usable {
        return AiImageBackend::Codex;
    }
    if selection != "codex"
        && selection != "none"
        && let Some((meta, config)) = usable_key_config(settings, Some(&text(selection.as_str())))
    {
        return AiImageBackend::Key {
            provider: meta.id,
            config,
        };
    }
    if selection != "codex" && codex_usable {
        return AiImageBackend::Codex;
    }
    let first = configured_image_key_providers(settings).into_iter().next();
    let fallback = first.and_then(|id| usable_key_config(settings, Some(&text(id))));
    match fallback {
        Some((meta, config)) => AiImageBackend::Key {
            provider: meta.id,
            config,
        },
        None => AiImageBackend::None,
    }
}
