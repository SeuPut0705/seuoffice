//! `apps/sheets/src/main/ai-run.ts`: the parts of an AI request the sheets
//! main process decides without Electron: which provider a request runs on,
//! and the stream chunks that carry what the subscription providers report.

use crate::docs::ai_run::{
    ai_stream_error_chunk as docs_error_chunk, subscription_stream_callbacks as docs_callbacks,
};
use crate::packages::ai_provider::jsval::{Obj, object, prop, spread, text};
use crate::packages::ai_provider::legacy_settings::normalize_ai_settings;
use crate::packages::ai_provider::provider_selection::{
    AiProviderChoice, is_subscription_provider, select_ai_provider,
};
use crate::packages::ai_provider::settings_secrets::AiSecretCodec;
use jscompat::{JsTypeError, JsonValue};

pub use crate::docs::ai_run::SubscriptionStreamCallbacks;

/// `AiRunBlock`: the error fields of a request that was not started because
/// no provider can run. `error_code` is absent only for a status state no
/// check writes.
#[derive(Debug, Clone, PartialEq)]
pub struct AiRunBlock {
    /// English fallback; the renderer words the cause from `errorCode`
    pub error: String,
    pub error_code: Option<&'static str>,
    /// the selected subscription provider that cannot run
    pub error_provider: Option<String>,
}

impl AiRunBlock {
    pub fn to_json(&self) -> JsonValue {
        let mut entries = vec![("error", text(self.error.as_str()))];
        if let Some(code) = self.error_code {
            entries.push(("errorCode", text(code)));
        }
        if let Some(provider) = &self.error_provider {
            entries.push(("errorProvider", text(provider.as_str())));
        }
        object(entries)
    }
}

/// `AiRunTarget`
#[derive(Debug, Clone, PartialEq)]
pub enum AiRunTarget {
    Ok {
        settings: JsonValue,
        provider: String,
        config: JsonValue,
    },
    Blocked {
        settings: JsonValue,
        block: AiRunBlock,
    },
}

impl AiRunTarget {
    pub fn to_json(&self) -> JsonValue {
        match self {
            AiRunTarget::Ok {
                settings,
                provider,
                config,
            } => object(vec![
                ("ok", JsonValue::Bool(true)),
                ("settings", settings.clone()),
                ("provider", text(provider.as_str())),
                ("config", config.clone()),
            ]),
            AiRunTarget::Blocked { settings, block } => object(vec![
                ("ok", JsonValue::Bool(false)),
                ("settings", settings.clone()),
                ("block", block.to_json()),
            ]),
        }
    }
}

/// `aiSettingsFromStored(stored)`: the settings to work with, from whatever
/// the settings file or a renderer held.
pub fn ai_settings_from_stored(
    codec: Option<&dyn AiSecretCodec>,
    stored: Option<&JsonValue>,
) -> JsonValue {
    normalize_ai_settings(codec, stored, None)
}

/// `resolveAiRunTarget(stored, statuses)`: the provider a request runs on,
/// from the settings it carries and the connection statuses of this process.
/// `auto` only lands on a ready subscription; a selected provider that cannot
/// run is reported, never replaced by another one.
pub fn resolve_ai_run_target(
    codec: Option<&dyn AiSecretCodec>,
    stored: Option<&JsonValue>,
    statuses: &JsonValue,
) -> AiRunTarget {
    let settings = ai_settings_from_stored(codec, stored);
    let choice = select_ai_provider(&settings, statuses);
    match choice {
        AiProviderChoice::Connected { provider, .. } => {
            let config = prop(&settings, "providers").and_then(|p| prop(p, &provider));
            match config.filter(|c| c.truthy()) {
                Some(config) => AiRunTarget::Ok {
                    config: config.clone(),
                    settings,
                    provider,
                },
                None => AiRunTarget::Blocked {
                    settings,
                    block: AiRunBlock {
                        error: "AI is not connected (not-configured)".to_owned(),
                        error_code: Some("not-connected"),
                        error_provider: None,
                    },
                },
            }
        }
        AiProviderChoice::NotConnected {
            provider,
            reason,
            error_kind,
            ..
        } => {
            let provider_value = provider.as_deref().map(text);
            let error_provider = if is_subscription_provider(provider_value.as_ref()) {
                provider.clone()
            } else {
                None
            };
            AiRunTarget::Blocked {
                settings,
                block: AiRunBlock {
                    error: format!("AI is not connected ({})", reason.unwrap_or("undefined")),
                    error_code: error_kind,
                    error_provider,
                },
            }
        }
    }
}

/// `aiRunBlockChunk(requestId, block)`: the chunk that answers a request no
/// provider can run.
pub fn ai_run_block_chunk(request_id: &str, block: &AiRunBlock) -> JsonValue {
    let mut chunk = Obj::new();
    chunk.set("requestId", text(request_id));
    chunk.set("type", text("error"));
    if let JsonValue::Object(fields) = block.to_json() {
        chunk.assign(&fields);
    }
    JsonValue::Object(chunk)
}

/// `aiStreamErrorChunk(requestId, err)`: the chunk for a run that failed: its
/// message plus the machine-readable cause, when it has one.
pub fn ai_stream_error_chunk(
    request_id: &str,
    err: &JsonValue,
    now_ms: f64,
) -> Result<JsonValue, JsTypeError> {
    docs_error_chunk(request_id, err, now_ms)
}

/// `subscriptionStreamCallbacks(requestId, send)`: forwards what a
/// subscription provider reports during a turn as stream chunks.
pub fn subscription_stream_callbacks<'a>(
    request_id: &str,
    send: &'a mut dyn FnMut(JsonValue),
) -> SubscriptionStreamCallbacks<'a> {
    docs_callbacks(request_id, send)
}

/// `withMeteredAccepted(stored, provider, accepted)`: the settings to write
/// after the user accepted (or took back) a metered login, written as
/// complete settings.
pub fn with_metered_accepted(
    codec: Option<&dyn AiSecretCodec>,
    stored: Option<&JsonValue>,
    provider: &str,
    accepted: bool,
) -> JsonValue {
    let settings = ai_settings_from_stored(codec, stored);
    let mut metered = spread(prop(&settings, "meteredAccepted"));
    // a computed key: `__proto__` is an own key here
    metered.set(provider, JsonValue::Bool(accepted));
    let mut out = spread(Some(&settings));
    out.set("meteredAccepted", JsonValue::Object(metered));
    JsonValue::Object(out)
}
