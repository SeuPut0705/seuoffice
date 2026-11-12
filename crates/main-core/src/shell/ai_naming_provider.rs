//! `apps/shell/src/main/ai-naming-provider.ts`: which provider answers a
//! file-naming request. The same rule as every other AI request
//! (`selectAiProvider`) and the same gate as every AI panel: nothing goes to a
//! subscription provider before the first-connection notice was acknowledged
//! in its current wording.

use crate::packages::ai_provider::jsval::{coalesce, object, prop, text};
use crate::packages::ai_provider::legacy_settings::normalize_ai_settings;
use crate::packages::ai_provider::provider_selection::{
    AiProviderChoice, is_subscription_provider, select_ai_provider,
};
use crate::packages::ai_provider::providers::{
    AI_SUBSCRIPTION_NOTICE_VERSION, with_migrated_subscription_notice_version,
};
use crate::packages::ai_provider::settings_secrets::AiSecretCodec;
use jscompat::JsonValue;

/// `NamingTarget`: the provider to call and the credentials to call it with,
/// or why none is called.
#[derive(Debug, Clone, PartialEq)]
pub enum NamingTarget {
    Ok {
        provider: String,
        config: JsonValue,
    },
    /// no provider can run: none connected, signed out, half configured
    NotConnected {
        /// absent only for a status state no check writes
        error_kind: Option<&'static str>,
        provider: Option<String>,
    },
    /// a subscription would run, and its first-connection notice is still unread
    Notice,
}

impl NamingTarget {
    /// The object the TypeScript builds, its keys in the order it writes them.
    pub fn to_json(&self) -> JsonValue {
        match self {
            NamingTarget::Ok { provider, config } => object(vec![
                ("ok", JsonValue::Bool(true)),
                ("provider", text(provider.as_str())),
                ("config", config.clone()),
            ]),
            NamingTarget::NotConnected {
                error_kind,
                provider,
            } => {
                let mut entries = vec![
                    ("ok", JsonValue::Bool(false)),
                    ("reason", text("not-connected")),
                ];
                if let Some(k) = error_kind {
                    entries.push(("errorKind", text(*k)));
                }
                if let Some(p) = provider {
                    entries.push(("provider", text(p.as_str())));
                }
                object(entries)
            }
            NamingTarget::Notice => object(vec![
                ("ok", JsonValue::Bool(false)),
                ("reason", text("notice")),
            ]),
        }
    }
}

/// `resolveNamingProvider(stored, statuses)`: the provider a naming request
/// goes to, or the reason it goes nowhere. `stored` is the parsed
/// `ai-settings.json`, or anything else when there is no readable file; sealed
/// keys are opened by the same read (`codec`).
pub fn resolve_naming_provider(
    codec: Option<&dyn AiSecretCodec>,
    stored: Option<&JsonValue>,
    statuses: &JsonValue,
) -> NamingTarget {
    // A file from before the notice had versions acknowledged its first
    // wording; normalizing it as it is would read the bare flag as the
    // current one.
    let migrated = stored.and_then(with_migrated_subscription_notice_version);
    let source = migrated.as_ref().or(stored);
    let settings = normalize_ai_settings(codec, source, None);
    let choice = select_ai_provider(&settings, statuses);
    let provider = match choice {
        AiProviderChoice::Connected { provider, .. } => provider,
        AiProviderChoice::NotConnected {
            error_kind,
            provider,
            ..
        } => {
            return NamingTarget::NotConnected {
                error_kind,
                provider: provider.filter(|p| !p.is_empty()),
            };
        }
    };
    let notice = coalesce(prop(&settings, "subscriptionNoticeVersion"), None);
    let notice_version = match notice {
        Some(JsonValue::Number(x)) => *x,
        _ => 0.0,
    };
    if is_subscription_provider(Some(&text(provider.as_str())))
        && notice_version < AI_SUBSCRIPTION_NOTICE_VERSION
    {
        return NamingTarget::Notice;
    }
    // a subscription provider needs no stored entry: an empty model is the CLI's default
    let config = prop(&settings, "providers")
        .and_then(|p| prop(p, &provider))
        .cloned()
        .unwrap_or_else(|| object(vec![("apiKey", text("")), ("model", text(""))]));
    NamingTarget::Ok { provider, config }
}
