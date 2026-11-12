//! `apps/docs/src/main/ai-run.ts`: the rules behind the shared `ai:*`
//! handlers of the Docs, PDF, Markdown and HTML editors: which provider a
//! request runs on, and how a refusal or a failure is reported to the
//! renderer.
//!
//! A request never falls back to another provider. `auto` resolves to a ready
//! subscription only; anything that costs money runs only when it is the
//! stored selection (see `select_ai_provider`).
//!
//! The settings, the statuses and a thrown value are JSON values (see
//! `packages::ai_provider::jsval` for how a thrown value is written).

use crate::packages::ai_provider::ai_settings_guard::{GuardHost, sanitize_ai_settings};
use crate::packages::ai_provider::jsval::{
    Obj, error_class, object, prop, spread, text, thrown_message, thrown_to_string, without,
};
use crate::packages::ai_provider::legacy_settings::normalize_ai_settings;
use crate::packages::ai_provider::overload_error::is_ai_overloaded_error;
use crate::packages::ai_provider::provider_selection::{
    AiProviderChoice, is_subscription_provider, select_ai_provider,
};
use crate::packages::ai_provider::providers::AI_PROVIDERS;
use crate::packages::ai_provider::run_error::ai_stream_error_fields;
use crate::packages::ai_provider::settings_secrets::AiSecretCodec;
use jscompat::{JsTypeError, JsonValue, trim};

pub const AI_INVALID_SETTINGS_ERROR: &str = "invalid AI settings payload";

/// `AiRunTexts`: localized texts the main process already has for a key
/// provider that is not filled in.
pub trait AiRunTexts {
    fn no_api_key(&self, provider: &str) -> String;
    fn no_model(&self) -> String;
}

/// `AiRunTarget`
#[derive(Debug, Clone, PartialEq)]
pub enum AiRunTarget {
    Ok {
        /// the request's settings as normalised
        settings: JsonValue,
        provider: String,
        config: JsonValue,
        /// an accepted metered CLI login
        metered: bool,
    },
    /// the error fields to answer with instead of calling any provider
    Refused { refusal: JsonValue },
}

impl AiRunTarget {
    pub fn to_json(&self) -> JsonValue {
        match self {
            AiRunTarget::Ok {
                settings,
                provider,
                config,
                metered,
            } => object(vec![
                ("ok", JsonValue::Bool(true)),
                ("settings", settings.clone()),
                ("provider", text(provider.as_str())),
                ("config", config.clone()),
                ("metered", JsonValue::Bool(*metered)),
            ]),
            AiRunTarget::Refused { refusal } => object(vec![
                ("ok", JsonValue::Bool(false)),
                ("refusal", refusal.clone()),
            ]),
        }
    }
}

fn provider_label(provider: &str) -> String {
    AI_PROVIDERS
        .iter()
        .find(|meta| meta.id == provider)
        .map_or(provider, |meta| meta.label)
        .to_owned()
}

/// The text carried by a refusal. Renderers word a refusal themselves from
/// its `errorCode`; this English sentence is only what a caller without that
/// wording shows.
fn not_connected_text(
    choice: &AiProviderChoice,
    settings: &JsonValue,
    texts: &dyn AiRunTexts,
) -> JsonValue {
    let AiProviderChoice::NotConnected {
        provider,
        reason,
        detail,
        ..
    } = choice
    else {
        return text("");
    };
    let Some(provider) = provider else {
        return text("No AI is connected. Connect a Claude or ChatGPT subscription first.");
    };
    if *reason == Some("not-configured") {
        let model = prop(settings, "providers")
            .and_then(|p| prop(p, provider))
            .and_then(|c| prop(c, "model"));
        return text(match model {
            Some(JsonValue::String(m)) if !trim(m).is_empty() => texts.no_api_key(provider),
            _ => texts.no_model(),
        });
    }
    let name = provider_label(provider);
    match *reason {
        Some("not-installed") => text(format!("The {name} program was not found on this PC.")),
        Some("signed-out") => text(format!("{name} is not signed in.")),
        Some("metered-not-accepted") => text(format!(
            "The {name} login is charged by usage and has not been allowed."
        )),
        Some("checking") => text(format!("The {name} connection is still being checked.")),
        _ => match detail {
            Some(d) if !matches!(d, JsonValue::Null) => d.clone(),
            _ => text(format!("The {name} connection cannot be used right now.")),
        },
    }
}

/// `resolveAiRun(requestSettings, statuses, texts)`: the provider a request
/// runs on, from the settings the renderer sent and the connection statuses of
/// the subscription CLIs, or the refusal to answer with. The settings pass the
/// same schema check as the stored ones, and a removed or unknown selection
/// reads as `auto`.
pub fn resolve_ai_run(
    host: &dyn GuardHost,
    codec: Option<&dyn AiSecretCodec>,
    request_settings: &JsonValue,
    statuses: &JsonValue,
    texts: &dyn AiRunTexts,
) -> Result<AiRunTarget, JsTypeError> {
    let Some(sanitized) = sanitize_ai_settings(host, request_settings)? else {
        return Ok(AiRunTarget::Refused {
            refusal: object(vec![("error", text(AI_INVALID_SETTINGS_ERROR))]),
        });
    };
    let settings = normalize_ai_settings(codec, Some(&sanitized), None);
    let choice = select_ai_provider(&settings, statuses);
    match &choice {
        AiProviderChoice::NotConnected {
            provider,
            error_kind,
            ..
        } => {
            let mut refusal = vec![("error", not_connected_text(&choice, &settings, texts))];
            if let Some(kind) = error_kind {
                refusal.push(("errorCode", text(*kind)));
            }
            let provider_value = provider.as_deref().map(text);
            if is_subscription_provider(provider_value.as_ref()) {
                refusal.push(("errorProvider", provider_value.unwrap_or(JsonValue::Null)));
            }
            Ok(AiRunTarget::Refused {
                refusal: object(refusal),
            })
        }
        AiProviderChoice::Connected { provider, metered } => {
            // a subscription provider needs no stored entry: an empty model is the CLI's default
            let config = prop(&settings, "providers")
                .and_then(|p| prop(p, provider))
                .cloned()
                .unwrap_or_else(|| object(vec![("apiKey", text("")), ("model", text(""))]));
            Ok(AiRunTarget::Ok {
                settings,
                provider: provider.clone(),
                config,
                metered: *metered,
            })
        }
    }
}

/// `subscriptionStreamCallbacks(requestId, send)`: the stream callbacks that
/// pass what a subscription CLI reports on to the renderer.
pub struct SubscriptionStreamCallbacks<'a> {
    request_id: String,
    send: &'a mut dyn FnMut(JsonValue),
}

pub fn subscription_stream_callbacks<'a>(
    request_id: &str,
    send: &'a mut dyn FnMut(JsonValue),
) -> SubscriptionStreamCallbacks<'a> {
    SubscriptionStreamCallbacks {
        request_id: request_id.to_owned(),
        send,
    }
}

impl SubscriptionStreamCallbacks<'_> {
    /// `onSubscriptionUsage(usage)`
    pub fn on_subscription_usage(&mut self, usage: &JsonValue) {
        (self.send)(object(vec![
            ("requestId", text(self.request_id.as_str())),
            ("type", text("subscription-usage")),
            ("subscriptionUsage", usage.clone()),
        ]));
    }

    /// `onInputTruncated()`
    pub fn on_input_truncated(&mut self) {
        (self.send)(object(vec![
            ("requestId", text(self.request_id.as_str())),
            ("type", text("input-truncated")),
        ]));
    }
}

/// `aiStreamErrorChunk(requestId, err)`: the error chunk for a failed stream:
/// the message plus the cause the renderer acts on. `now_ms` is the clock
/// `aiStreamErrorFields` reads.
pub fn ai_stream_error_chunk(
    request_id: &str,
    err: &JsonValue,
    now_ms: f64,
) -> Result<JsonValue, JsTypeError> {
    let message = if error_class(err).is_error() {
        thrown_message(err).unwrap_or(JsonValue::Null)
    } else {
        text(thrown_to_string(err)?)
    };
    let mut chunk = Obj::new();
    chunk.set("requestId", text(request_id));
    chunk.set("type", text("error"));
    chunk.set("error", message);
    chunk.assign(&ai_stream_error_fields(err, now_ms));
    Ok(JsonValue::Object(chunk))
}

/// `aiChatFailure(err, busyText)`: the answer of a failed one-shot chat. A
/// capacity failure keeps its localized "busy" text; the cause fields ride
/// along so a renderer can word the subscription kinds itself.
pub fn ai_chat_failure(
    err: &JsonValue,
    busy_text: impl FnOnce() -> String,
    now_ms: f64,
) -> Result<JsonValue, JsTypeError> {
    let mut out = Obj::new();
    out.set("ok", JsonValue::Bool(false));
    let error = if is_ai_overloaded_error(err) {
        busy_text()
    } else {
        thrown_to_string(err)?
    };
    out.set("error", text(error));
    out.assign(&ai_stream_error_fields(err, now_ms));
    Ok(JsonValue::Object(out))
}

/// `withMeteredAccepted(stored, provider, accepted)`: the stored settings with
/// one provider's "use anyway" answer recorded.
pub fn with_metered_accepted(
    codec: Option<&dyn AiSecretCodec>,
    stored: Option<&JsonValue>,
    provider: &str,
    accepted: bool,
) -> JsonValue {
    let settings = normalize_ai_settings(codec, stored, None);
    let mut metered = spread(prop(&settings, "meteredAccepted"));
    // a computed key: `__proto__` is an own key here
    metered.set(provider, JsonValue::Bool(accepted));
    let mut out = spread(Some(&settings));
    out.set("meteredAccepted", JsonValue::Object(metered));
    JsonValue::Object(out)
}

/// `withSubscriptionOff(stored, provider, off)`: the stored settings with one
/// vendor CLI turned off in this app, or back on.
pub fn with_subscription_off(
    codec: Option<&dyn AiSecretCodec>,
    stored: Option<&JsonValue>,
    provider: &str,
    off: bool,
) -> JsonValue {
    let normalized = normalize_ai_settings(codec, stored, None);
    let JsonValue::Object(all) = &normalized else {
        return normalized;
    };
    let mut settings = without(all, &["subscriptionOff"]);
    let mut next = spread(all.get("subscriptionOff"));
    if off {
        next.set(provider, JsonValue::Bool(true));
    } else {
        next = without(&next, &[provider]);
    }
    if next.is_empty() {
        JsonValue::Object(settings)
    } else {
        settings.set("subscriptionOff", JsonValue::Object(next));
        JsonValue::Object(settings)
    }
}
