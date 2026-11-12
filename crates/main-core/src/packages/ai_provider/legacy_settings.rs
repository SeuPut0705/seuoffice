//! `packages/ai-provider/src/legacy-settings.ts`: loading a settings file
//! written before the subscription providers existed. Every slot holding an
//! unknown id falls to its default, fields this build does not know are left
//! out of what the app works with, and nothing here throws.

use super::jsval::{Obj, as_record, as_str, assign, number, object, prop, spread, text};
use super::media::{
    AI_MEDIA_PROVIDERS, MediaCapability, media_provider_ids, provider_has_capability,
};
use super::providers::{
    AI_PROVIDERS, default_ai_settings, headless_consent_version_of, headless_subscription_on,
    provider_ids, read_url_settings_of, resolve_ai_settings, sanitize_metered_accepted,
    subscription_notice_version_of,
};
use super::search_settings::AI_SEARCH_PROVIDERS;
use super::settings_secrets::AiSecretCodec;
use jscompat::JsonValue;

pub const DEFAULT_AI_PROVIDER_SELECTION: &str = "auto";
/// Stored even in a build without Codex image generation: there it behaves
/// exactly like `none`.
pub const DEFAULT_AI_IMAGE_PROVIDER: &str = "codex";
pub const DEFAULT_AI_ANALYSIS_PROVIDER: &str = "chat";
pub const DEFAULT_AI_VIDEO_ANALYSIS_PROVIDER: &str = "none";
/// Parallel with an empty key is the keyless free route
pub const DEFAULT_AI_SEARCH_PROVIDER: &str = "parallel";

/// a key media provider that has the capability, by id
fn media_key_provider(id: Option<&JsonValue>, capability: MediaCapability) -> bool {
    match as_str(id) {
        Some(id) => AI_MEDIA_PROVIDERS
            .iter()
            .find(|m| m.id == id)
            .is_some_and(|meta| provider_has_capability(meta, capability)),
        None => false,
    }
}

/// `knownEntries(stored, known)`: entries of `stored` whose id is in `known`;
/// everything else is dropped.
fn known_entries(stored: Option<&JsonValue>, known: &[&str]) -> Obj {
    let mut out = Obj::new();
    if let Some(record) = stored.and_then(as_record) {
        for id in known {
            if let Some(v) = record.get(id) {
                assign(&mut out, id, v.clone());
            }
        }
    }
    out
}

fn normalize_media(media: &JsonValue) -> JsonValue {
    let pick = |key: &str, fixed: &[&str], capability: Option<MediaCapability>, default: &str| {
        let value = prop(media, key);
        match value {
            Some(JsonValue::String(t)) if fixed.contains(&t.as_str()) => text(t.as_str()),
            Some(JsonValue::String(t))
                if capability.is_some_and(|c| media_key_provider(value, c)) =>
            {
                text(t.as_str())
            }
            _ => text(default),
        }
    };
    object(vec![
        (
            "imageProvider",
            pick(
                "imageProvider",
                &["codex", "none"],
                Some(MediaCapability::Image),
                DEFAULT_AI_IMAGE_PROVIDER,
            ),
        ),
        (
            "analysisProvider",
            pick(
                "analysisProvider",
                &["chat"],
                Some(MediaCapability::Analysis),
                DEFAULT_AI_ANALYSIS_PROVIDER,
            ),
        ),
        (
            "videoAnalysisProvider",
            pick(
                "videoAnalysisProvider",
                &["none"],
                Some(MediaCapability::Video),
                DEFAULT_AI_VIDEO_ANALYSIS_PROVIDER,
            ),
        ),
        (
            "providers",
            JsonValue::Object(known_entries(
                prop(media, "providers"),
                &media_provider_ids(),
            )),
        ),
    ])
}

fn normalize_search(search: &JsonValue) -> JsonValue {
    let stored = prop(search, "provider");
    let known = as_str(stored).is_some_and(|s| AI_SEARCH_PROVIDERS.iter().any(|m| m.id == s));
    let mut entries = vec![(
        "provider",
        if known {
            stored.cloned().unwrap_or(JsonValue::Null)
        } else {
            text(DEFAULT_AI_SEARCH_PROVIDER)
        },
    )];
    // an `undefined` value is no key in the JSON
    if let Some(providers) = prop(search, "providers") {
        entries.push(("providers", providers.clone()));
    }
    object(entries)
}

/// `normalizeAiSettings(stored, defaults)`: the settings to work with, from
/// whatever the settings file held (already JSON-parsed; no file I/O). Runs
/// `resolveAiSettings`, then replaces unknown selections with their defaults
/// and leaves out every field this build does not know. Never throws.
/// `defaults` is `defaultAiSettings()` when `None`.
pub fn normalize_ai_settings(
    codec: Option<&dyn AiSecretCodec>,
    stored: Option<&JsonValue>,
    defaults: Option<&JsonValue>,
) -> JsonValue {
    let mut defaults = defaults
        .cloned()
        .unwrap_or_else(|| default_ai_settings(None));
    let resolved = resolve_ai_settings(codec, stored, &mut defaults);
    let provider = prop(&resolved, "provider");
    let selection = match as_str(provider) {
        Some(p) if p == "auto" || AI_PROVIDERS.iter().any(|m| m.id == p) => text(p),
        _ => text(DEFAULT_AI_PROVIDER_SELECTION),
    };
    let fallback = default_ai_settings(None);
    let read_url = read_url_settings_of(prop(&resolved, "readUrl"));
    let mut providers = spread(prop(&fallback, "providers"));
    providers.assign(&known_entries(
        prop(&resolved, "providers"),
        &provider_ids(),
    ));
    // a per-request token is never a setting: one put in the file is dropped
    for meta in AI_PROVIDERS {
        if meta.request_token {
            let mut config = spread(providers.get(meta.id));
            config.set("apiKey", text(""));
            providers.set(meta.id, JsonValue::Object(config));
        }
    }
    let null = JsonValue::Null;
    let media = super::jsval::coalesce(prop(&resolved, "media"), prop(&fallback, "media"));
    let search = super::jsval::coalesce(prop(&resolved, "search"), prop(&fallback, "search"));
    let mut out = spread(Some(&resolved));
    if let Some(r) = read_url {
        out.set("readUrl", r);
    }
    out.set("provider", selection);
    out.set("providers", JsonValue::Object(providers));
    out.set("media", normalize_media(media.unwrap_or(&null)));
    out.set("search", normalize_search(search.unwrap_or(&null)));
    out.set(
        "meteredAccepted",
        sanitize_metered_accepted(prop(&resolved, "meteredAccepted")),
    );
    out.set(
        "headlessSubscriptionEnabled",
        JsonValue::Bool(headless_subscription_on(
            prop(&resolved, "headlessSubscriptionEnabled"),
            prop(&resolved, "headlessSubscriptionConsentVersion"),
        )),
    );
    out.set(
        "headlessSubscriptionConsentVersion",
        number(headless_consent_version_of(prop(
            &resolved,
            "headlessSubscriptionConsentVersion",
        ))),
    );
    out.set(
        "subscriptionNoticeSeen",
        JsonValue::Bool(matches!(
            prop(&resolved, "subscriptionNoticeSeen"),
            Some(JsonValue::Bool(true))
        )),
    );
    out.set(
        "subscriptionNoticeVersion",
        number(subscription_notice_version_of(
            prop(&resolved, "subscriptionNoticeVersion"),
            prop(&resolved, "subscriptionNoticeSeen"),
        )),
    );
    let pdf = match prop(&resolved, "pdfSendNoticeSeen") {
        Some(JsonValue::Number(x)) if x.is_finite() && x.trunc() == *x && *x > 0.0 => *x,
        _ => 0.0,
    };
    out.set("pdfSendNoticeSeen", number(pdf));
    if matches!(
        prop(&resolved, "internetTools"),
        Some(JsonValue::Bool(false))
    ) {
        out.set("internetTools", JsonValue::Bool(false));
    }
    JsonValue::Object(out)
}
