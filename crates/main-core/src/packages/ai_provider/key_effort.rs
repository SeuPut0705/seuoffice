//! `packages/ai-provider/src/key-effort.ts`: how hard a key provider's model
//! thinks. Only the vendors whose model list tells which levels each model
//! takes are given one, and only a level that list names for the configured
//! model.
//!
//! The provider config is a JSON value, as everywhere in this folder. A
//! `model` that is no string throws the `TypeError` the TypeScript's
//! `model.trim()` throws.

use super::effort::{AiModelEffort, ai_effort_of, ai_model_effort_of};
use super::jsval::{object, prop, text};
use super::task::JsError;
use jscompat::{JsonValue, inherited_string, trim};

/// `EffortField`: where each vendor takes the level
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EffortField {
    OutputConfig,
    Reasoning,
    ReasoningEffort,
}

/// `EFFORT_FIELDS[provider]` for an own key of the table
fn effort_field(provider: &str) -> Option<EffortField> {
    match provider {
        "anthropic" => Some(EffortField::OutputConfig),
        "openrouter" => Some(EffortField::Reasoning),
        "deepseek" | "xai" => Some(EffortField::ReasoningEffort),
        // a local server; only Ollama's model profile reports levels
        "custom" => Some(EffortField::ReasoningEffort),
        _ => None,
    }
}

/// `takesKeyEffort(provider)`: the key providers this app hands a level to.
/// A name `Object.prototype` holds is `!== undefined` in the table lookup
/// too.
pub fn takes_key_effort(provider: Option<&str>) -> bool {
    provider.is_some_and(|p| effort_field(p).is_some() || inherited_string(p).is_some())
}

/// The `TypeError` of `value.trim()` where `value` is no string.
fn trim_error(name: &str, value: Option<&JsonValue>) -> JsError {
    match value {
        None => JsError::type_error("Cannot read properties of undefined (reading 'trim')"),
        Some(JsonValue::Null) => {
            JsError::type_error("Cannot read properties of null (reading 'trim')")
        }
        Some(_) => JsError::type_error(format!("{name}.trim is not a function")),
    }
}

/// `keyModelEffort(config, model)`: what the stored table says about one
/// model, or `None` when it says nothing. `config` is `undefined` for `None`.
pub fn key_model_effort(
    config: Option<&JsonValue>,
    model: Option<&JsonValue>,
) -> Result<Option<AiModelEffort>, JsError> {
    // `config?.modelEfforts`
    let table = config.and_then(|c| prop(c, "modelEfforts"));
    let id = match model {
        Some(JsonValue::String(m)) => trim(m),
        other => return Err(trim_error("model", other)),
    };
    let Some(table) = table.filter(|t| t.truthy()) else {
        return Ok(None);
    };
    if id.is_empty() {
        return Ok(None);
    }
    // `Object.prototype.hasOwnProperty.call(table, id)`
    let Some(entry) = table.get(id) else {
        return Ok(None);
    };
    Ok(ai_model_effort_of(Some(&entry)))
}

/// `keyProviderEffort(provider, config)`: the configured level when the
/// provider takes one and the configured model is listed with it.
pub fn key_provider_effort(
    provider: &str,
    config: &JsonValue,
) -> Result<Option<&'static str>, JsError> {
    if !takes_key_effort(Some(provider)) {
        return Ok(None);
    }
    let Some(effort) = ai_effort_of(prop(config, "effort")) else {
        return Ok(None);
    };
    let listed = key_model_effort(Some(config), prop(config, "model"))?;
    Ok(listed
        .filter(|entry| entry.efforts.contains(&effort))
        .map(|_| effort))
}

/// `keyEffortBody(provider, config, protocol)`: the request fields that carry
/// the level on the route the request takes, or `None` when nothing is to be
/// sent. A gateway route of another protocol gets nothing.
pub fn key_effort_body(
    provider: &str,
    config: &JsonValue,
    protocol: &str,
) -> Result<Option<JsonValue>, JsError> {
    let Some(effort) = key_provider_effort(provider, config)? else {
        return Ok(None);
    };
    let field = effort_field(provider);
    if protocol == "anthropic" {
        return Ok((field == Some(EffortField::OutputConfig)).then(|| {
            object(vec![(
                "output_config",
                object(vec![("effort", text(effort))]),
            )])
        }));
    }
    if protocol != "openai-compatible" {
        return Ok(None);
    }
    if field == Some(EffortField::Reasoning) {
        return Ok(Some(object(vec![(
            "reasoning",
            object(vec![("effort", text(effort))]),
        )])));
    }
    Ok((field == Some(EffortField::ReasoningEffort))
        .then(|| object(vec![("reasoning_effort", text(effort))])))
}
