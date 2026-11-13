//! `packages/ai-provider/src/media.ts`: the readers of the stored media block
//! that `media.rs` leaves out (`mediaConfigUsable`, `activeMediaProvider`,
//! `activeMediaConfig`).
//!
//! Where the TypeScript calls `.trim()` on a field typed `string | undefined`,
//! a field of another type reads as absent here, where the TypeScript would
//! throw a `TypeError`; no caller holds such a value (the settings pass
//! `normalizeAiSettings`).

use super::jsval::{prop, prop2, str_trim};
use super::media::{
    AiMediaProviderMeta, MediaCapability, get_media_provider_meta, provider_has_capability,
};
use jscompat::JsonValue;

/// `mediaConfigUsable(meta, config)`: key (or base URL for custom) present,
/// the minimum for a BYOK media provider to be honored.
pub fn media_config_usable(meta: &AiMediaProviderMeta, config: Option<&JsonValue>) -> bool {
    let Some(config) = config.filter(|c| c.truthy()) else {
        return false;
    };
    // trim-aware like isKeyProviderConfigured: whitespace-only survivors of
    // in-memory settings are not usable configs
    if meta.needs_base_url {
        return !str_trim(prop(config, "baseUrl")).is_empty();
    }
    !str_trim(prop(config, "apiKey")).is_empty()
}

/// `activeMediaProvider(settings, capability)`: the stored key provider for
/// one capability, honored only when it exists, has that capability and is
/// usable; `None` otherwise, which includes the selections that name no key
/// provider (`codex`, `chat`, `none`).
pub fn active_media_provider(
    settings: &JsonValue,
    capability: MediaCapability,
) -> Option<&'static str> {
    let media = prop(settings, "media").filter(|m| m.truthy())?;
    let key = match capability {
        MediaCapability::Image => "imageProvider",
        MediaCapability::Video => "videoAnalysisProvider",
        MediaCapability::Analysis => "analysisProvider",
    };
    let id = prop(media, key).filter(|id| id.truthy())?;
    let meta = get_media_provider_meta(id)?;
    if !provider_has_capability(meta, capability) {
        return None;
    }
    if !media_config_usable(meta, prop2(Some(media), "providers", meta.id)) {
        return None;
    }
    Some(meta.id)
}

/// `activeMediaConfig(settings, capability)`: the active BYOK config for one
/// capability, or `None` when no key provider is selected and usable.
pub fn active_media_config(
    settings: &JsonValue,
    capability: MediaCapability,
) -> Option<(&'static str, JsonValue)> {
    let provider = active_media_provider(settings, capability)?;
    let config = prop2(prop(settings, "media"), "providers", provider)?;
    Some((provider, config.clone()))
}
