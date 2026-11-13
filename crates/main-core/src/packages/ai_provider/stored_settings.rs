//! `packages/ai-provider/src/providers.ts` (`withStoredUnknownFields`,
//! `withStoredSubscriptionOff`) and `key-model-refresh.ts`
//! (`withStoredKeyModels`, `withStoredMainFields`): what a save of the
//! settings keeps from the file as it is on disk.
//!
//! The settings are JSON values, as in the other settings files of this folder.

use super::effort::ai_model_efforts_of;
use super::jsval::{Obj, as_record, assign, entries_of, prop, spread, without};
use super::providers::listed_models_of;
use jscompat::{JsonValue, inherited_string};

/// `KNOWN_SETTINGS_FIELDS`: every top-level field this build reads, with the
/// pre-provider ones it migrates.
const KNOWN_SETTINGS_FIELDS: &[&str] = &[
    "provider",
    "providers",
    "customEndpoints",
    "customEndpoint",
    "media",
    "search",
    "readUrl",
    "maxOutputTokens",
    "meteredAccepted",
    "subscriptionOff",
    "headlessSubscriptionEnabled",
    "headlessSubscriptionConsentVersion",
    "subscriptionNoticeSeen",
    "subscriptionNoticeVersion",
    "pdfSendNoticeSeen",
    "internetTools",
    "apiKey",
    "model",
    "baseUrl",
];

/// `KNOWN_PROVIDER_FIELDS`: every field of a provider config this build reads.
const KNOWN_PROVIDER_FIELDS: &[&str] = &[
    "apiKey",
    "model",
    "baseUrl",
    "cliPath",
    "models",
    "effort",
    "modelEfforts",
];

/// `unknownFieldsOf(stored, known, next)`: the fields of `stored` this build
/// does not know and `next` does not carry. `key in next` also finds the
/// names `Object.prototype` has.
fn unknown_fields_of(stored: Option<&JsonValue>, known: &[&str], next: &Obj) -> Obj {
    let mut out = Obj::new();
    let Some(stored) = stored.filter(|value| as_record(value).is_some()) else {
        return out;
    };
    for (key, value) in entries_of(stored) {
        if known.contains(&key.as_str())
            || next.get(&key).is_some()
            || inherited_string(&key).is_some()
        {
            continue;
        }
        out.set(key, value);
    }
    out
}

/// `withStoredUnknownFields(next, stored)`: `next` with the fields of the
/// settings file that this build does not know put back, at the top and in
/// each provider config `next` carries.
pub fn with_stored_unknown_fields(next: &JsonValue, stored: &JsonValue) -> JsonValue {
    let (Some(next_object), Some(_)) = (as_record(next), as_record(stored)) else {
        return next.clone();
    };
    let mut merged = next_object.clone();
    merged.assign(&unknown_fields_of(
        Some(stored),
        KNOWN_SETTINGS_FIELDS,
        next_object,
    ));
    if let (Some(JsonValue::Object(next_providers)), Some(JsonValue::Object(stored_providers))) =
        (next_object.get("providers"), prop(stored, "providers"))
    {
        let mut providers = Obj::new();
        for (id, config) in next_providers.entries() {
            let value = match config {
                JsonValue::Object(config_object) => {
                    let mut with_unknown = config_object.clone();
                    with_unknown.assign(&unknown_fields_of(
                        stored_providers.get(id),
                        KNOWN_PROVIDER_FIELDS,
                        config_object,
                    ));
                    JsonValue::Object(with_unknown)
                }
                other => other.clone(),
            };
            providers.set(id, value);
        }
        merged.set("providers", JsonValue::Object(providers));
    }
    JsonValue::Object(merged)
}

/// `withStoredSubscriptionOff(next, stored)`: `next` with the CLIs turned off
/// as `stored` has them. Only the switch on the Settings card changes them.
pub fn with_stored_subscription_off(next: &JsonValue, stored: &JsonValue) -> JsonValue {
    let settings = without(&spread(Some(next)), &["subscriptionOff"]);
    match prop(stored, "subscriptionOff").filter(|off| off.truthy()) {
        Some(off) => {
            let mut with_off = settings;
            with_off.set("subscriptionOff", off.clone());
            JsonValue::Object(with_off)
        }
        None => JsonValue::Object(settings),
    }
}

/// `withStoredKeyModels(next, stored)`: `next` with every provider's live
/// model list taken from `stored`: the list a renderer sends is never
/// written, and one it does not send is not lost.
pub fn with_stored_key_models(next: &JsonValue, stored: &JsonValue) -> JsonValue {
    let mut providers = spread(prop(next, "providers"));
    let listed = entries_of(&JsonValue::Object(providers.clone()));
    for (id, config) in listed {
        if !config.truthy() {
            continue;
        }
        let rest = without(&spread(Some(&config)), &["models", "modelEfforts"]);
        let stored_config = prop(stored, "providers").and_then(|all| prop(all, &id));
        let models = listed_models_of(stored_config.and_then(|c| prop(c, "models")));
        // the custom slot's table is a mirror of the active server, rebuilt from the server list
        let efforts = if id == "custom" {
            ai_model_efforts_of(prop(&config, "modelEfforts"))
        } else {
            ai_model_efforts_of(stored_config.and_then(|c| prop(c, "modelEfforts")))
        };
        let mut rebuilt = rest;
        if let Some(models) = models {
            rebuilt.set(
                "models",
                JsonValue::Array(models.into_iter().map(JsonValue::String).collect()),
            );
        }
        if let Some(efforts) = efforts {
            rebuilt.set("modelEfforts", efforts);
        }
        assign(&mut providers, &id, JsonValue::Object(rebuilt));
    }
    let mut out = spread(Some(next));
    out.set("providers", JsonValue::Object(providers));
    JsonValue::Object(out)
}

/// `withStoredMainFields(next, stored)`: the settings to write when a
/// renderer saves `next`. Every field only the main process writes comes from
/// `stored`: the key providers' live model lists and the CLIs turned off.
pub fn with_stored_main_fields(next: &JsonValue, stored: &JsonValue) -> JsonValue {
    with_stored_subscription_off(&with_stored_key_models(next, stored), stored)
}
