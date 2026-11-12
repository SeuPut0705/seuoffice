//! `packages/ai-provider/src/provider-selection.ts`: which provider an AI
//! request runs on, from the stored selection and the connection status of
//! the subscription CLIs.
//!
//! The settings and the statuses are JSON values. Where the TypeScript calls
//! `.trim()` on a field typed `string | undefined`, a field of another type
//! reads as absent here, where the TypeScript would throw a `TypeError`; no
//! caller holds such a value (the settings pass `normalizeAiSettings`).

use super::jsval::{object, prop, prop2, str_trim, text, value_key};
use super::providers::{AI_PROVIDERS, AI_SUBSCRIPTION_PROVIDERS, is_subscription_cli};
use jscompat::JsonValue;

/// `AiProviderChoice`
#[derive(Debug, Clone, PartialEq)]
pub enum AiProviderChoice {
    Connected {
        provider: String,
        /// an accepted metered CLI login: usable, but the UI must mark it as costing money
        metered: bool,
    },
    NotConnected {
        /// the stored selection as understood (`auto` for removed or unknown ids)
        selection: String,
        /// the selected provider that cannot run; absent for `auto`
        provider: Option<String>,
        /// absent only for a status state no check writes
        reason: Option<&'static str>,
        /// the run error to report when a request is attempted anyway
        error_kind: Option<&'static str>,
        /// the status check's own error text, on reason `error`
        detail: Option<JsonValue>,
    },
}

impl AiProviderChoice {
    /// The object the TypeScript builds, its keys in the order it writes them.
    pub fn to_json(&self) -> JsonValue {
        match self {
            AiProviderChoice::Connected { provider, metered } => object(vec![
                ("connected", JsonValue::Bool(true)),
                ("provider", text(provider.as_str())),
                ("metered", JsonValue::Bool(*metered)),
            ]),
            AiProviderChoice::NotConnected {
                selection,
                provider,
                reason,
                error_kind,
                detail,
            } => {
                let mut entries = vec![
                    ("connected", JsonValue::Bool(false)),
                    ("selection", text(selection.as_str())),
                ];
                if let Some(p) = provider {
                    entries.push(("provider", text(p.as_str())));
                }
                if let Some(r) = reason {
                    entries.push(("reason", text(*r)));
                }
                if let Some(k) = error_kind {
                    entries.push(("errorKind", text(*k)));
                }
                if let Some(d) = detail {
                    entries.push(("detail", d.clone()));
                }
                object(entries)
            }
        }
    }
}

/// `isSubscriptionProvider(id)`
pub fn is_subscription_provider(id: Option<&JsonValue>) -> bool {
    matches!(id, Some(JsonValue::String(t)) if AI_SUBSCRIPTION_PROVIDERS.contains(&t.as_str()))
}

/// `subscriptionOffIn(settings, provider)`: the person turned this CLI off in
/// this app. The setting decides on its own, whatever a status says.
pub fn subscription_off_in(settings: &JsonValue, provider: Option<&JsonValue>) -> bool {
    is_subscription_cli(provider)
        && matches!(
            prop(settings, "subscriptionOff").and_then(|o| prop(o, &value_key(provider))),
            Some(JsonValue::Bool(true))
        )
}

/// `'subscription' | 'metered' | null`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscriptionConnection {
    Subscription,
    Metered,
}

/// `subscriptionConnection(settings, status)`: how a subscription provider
/// can be used right now: on its subscription, on a metered login the user
/// accepted, or not at all.
pub fn subscription_connection(
    settings: &JsonValue,
    status: Option<&JsonValue>,
) -> Option<SubscriptionConnection> {
    let status = status.filter(|s| s.truthy())?;
    if subscription_off_in(settings, prop(status, "provider")) {
        return None;
    }
    match prop(status, "state") {
        Some(JsonValue::String(state)) if state == "ready" => {
            Some(SubscriptionConnection::Subscription)
        }
        Some(JsonValue::String(state))
            if state == "metered"
                && matches!(prop(status, "meteredAccepted"), Some(JsonValue::Bool(true)))
                && matches!(
                    prop(settings, "meteredAccepted")
                        .and_then(|m| prop(m, &value_key(prop(status, "provider")))),
                    Some(JsonValue::Bool(true))
                ) =>
        {
            Some(SubscriptionConnection::Metered)
        }
        _ => None,
    }
}

/// `isKeyProviderConfigured(settings, provider)`: a key provider with enough
/// filled in to send a request.
pub fn is_key_provider_configured(settings: &JsonValue, provider: &str) -> bool {
    if AI_SUBSCRIPTION_PROVIDERS.contains(&provider) {
        return false;
    }
    let meta = AI_PROVIDERS.iter().find(|m| m.id == provider);
    let config = prop(settings, "providers").and_then(|p| prop(p, provider));
    let (Some(meta), Some(config)) = (meta, config.filter(|c| c.truthy())) else {
        return false;
    };
    let filled = |key: &str| !str_trim(prop(config, key)).is_empty();
    if meta.request_token {
        return filled("baseUrl");
    }
    if !filled("model") {
        return false;
    }
    if meta.needs_base_url {
        return filled("baseUrl");
    }
    filled("apiKey")
}

/// `providerSelectionOf(settings)`: the stored selection as understood:
/// unknown ids (a removed provider among them) read as `auto`.
pub fn provider_selection_of(settings: &JsonValue) -> String {
    match prop(settings, "provider") {
        Some(JsonValue::String(stored)) => AI_PROVIDERS
            .iter()
            .find(|m| m.id == stored)
            .map_or("auto", |m| m.id)
            .to_owned(),
        _ => "auto".to_owned(),
    }
}

/// `subscriptionStateOf(statuses, id)`: a provider's state as the choice
/// reads it. A missing ChatGPT status reads as signed out, a missing CLI
/// status as still being checked.
pub fn subscription_state_of(statuses: &JsonValue, id: &str) -> JsonValue {
    match prop2(Some(statuses), id, "state") {
        None | Some(JsonValue::Null) => text(if id == "chatgpt" {
            "signed-out"
        } else {
            "checking"
        }),
        Some(state) => state.clone(),
    }
}

/// `SUBSCRIPTION_BLOCKERS[state]`: the reason and the run error of a state
/// that is not `ready`; `None` for a state the table has no entry for.
fn blocker(state: Option<&str>) -> Option<(&'static str, &'static str)> {
    Some(match state? {
        "checking" => ("checking", "not-connected"),
        "not-installed" => ("not-installed", "not-installed"),
        "signed-out" => ("signed-out", "signed-out"),
        "metered" => ("metered-not-accepted", "metered-not-accepted"),
        "error" => ("error", "not-connected"),
        "off" => ("off-in-app", "off-in-app"),
        _ => return None,
    })
}

/// `selectAiProvider(settings, statuses)`: the provider to run on, or why
/// none can.
///
/// - `auto`: Claude Code when it is `ready`, else ChatGPT, else Codex, else
///   not connected. Key providers and metered logins are not candidates. A
///   provider is passed over only once its status check has answered.
/// - a selected provider is used when it can run and is reported as not
///   connected otherwise. There is no fallback from an explicit selection.
pub fn select_ai_provider(settings: &JsonValue, statuses: &JsonValue) -> AiProviderChoice {
    let selection = provider_selection_of(settings);
    if selection == "auto" {
        let mut ready: Option<&str> = None;
        for id in AI_SUBSCRIPTION_PROVIDERS {
            let state = if subscription_off_in(settings, Some(&text(id))) {
                text("off")
            } else {
                subscription_state_of(statuses, id)
            };
            let name = if let JsonValue::String(s) = &state {
                Some(s.as_str())
            } else {
                None
            };
            if name == Some("ready") {
                ready = Some(id);
            }
            if name == Some("ready") || name == Some("checking") {
                break;
            }
        }
        return match ready {
            Some(id) => AiProviderChoice::Connected {
                provider: id.to_owned(),
                metered: false,
            },
            None => AiProviderChoice::NotConnected {
                selection,
                provider: None,
                reason: Some("no-subscription"),
                error_kind: Some("not-connected"),
                detail: None,
            },
        };
    }
    if !AI_SUBSCRIPTION_PROVIDERS.contains(&selection.as_str()) {
        return if is_key_provider_configured(settings, &selection) {
            AiProviderChoice::Connected {
                provider: selection,
                metered: false,
            }
        } else {
            AiProviderChoice::NotConnected {
                provider: Some(selection.clone()),
                selection,
                reason: Some("not-configured"),
                error_kind: Some("not-connected"),
                detail: None,
            }
        };
    }
    let status = prop(statuses, &selection);
    if let Some(connection) = subscription_connection(settings, status) {
        return AiProviderChoice::Connected {
            provider: selection,
            metered: connection == SubscriptionConnection::Metered,
        };
    }
    // connection is null, so a present status is in a non-ready state, or the CLI is off
    let state: JsonValue = if subscription_off_in(settings, Some(&text(selection.as_str()))) {
        text("off")
    } else {
        match status.filter(|s| s.truthy()) {
            None => text("checking"),
            Some(s) => match prop(s, "state") {
                Some(JsonValue::String(t)) if t == "ready" => text("checking"),
                Some(other) => other.clone(),
                // `status.state` is `undefined`
                None => JsonValue::Null,
            },
        }
    };
    let state_name = match &state {
        JsonValue::String(t) => Some(t.as_str()),
        _ => None,
    };
    let (reason, error_kind) = match blocker(state_name) {
        Some((r, k)) => (Some(r), Some(k)),
        None => (None, None),
    };
    let detail = if state_name == Some("error") {
        status
            .and_then(|s| prop(s, "error"))
            .filter(|e| e.truthy())
            .cloned()
    } else {
        None
    };
    AiProviderChoice::NotConnected {
        provider: Some(selection.clone()),
        selection,
        reason,
        error_kind,
        detail,
    }
}
