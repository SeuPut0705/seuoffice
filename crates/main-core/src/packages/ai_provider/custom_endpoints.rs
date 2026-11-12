//! `packages/ai-provider/src/custom-endpoints.ts`: `resolveCustomEndpoints`
//! and what it calls. The editing helpers of the settings screen
//! (`upsertCustomEndpoint`, `removeCustomEndpoint`, ...) are not here.

use super::effort::{ai_effort_of, ai_model_effort_of};
use super::jsval::{
    Obj, as_str, coalesce, object, prop, spread, str_trim, string_list, text, without,
};
use super::local_profile::{local_endpoint_fields_of, local_model_profiles_proto};
use jscompat::{JsonValue, math_random, trim};

const ID_ALPHABET: &str = "abcdefghijklmnopqrstuvwxyz0123456789";

/// `newCustomEndpointId()`: `ep-` and eight random characters.
pub fn new_custom_endpoint_id() -> String {
    let alphabet: Vec<char> = ID_ALPHABET.chars().collect();
    let mut id = String::new();
    for _ in 0..8 {
        let at = (math_random() * alphabet.len() as f64).floor() as usize;
        id.push(alphabet[at]);
    }
    format!("ep-{id}")
}

fn configured_slot(config: Option<&JsonValue>) -> bool {
    let field = |key: &str| str_trim(config.and_then(|c| prop(c, key)));
    !field("baseUrl").is_empty() || !field("model").is_empty() || !field("apiKey").is_empty()
}

/// Each endpoint with the prototype its `modelProfiles` table got (see
/// `local_model_profiles_proto`).
fn normalize_endpoints(raw: Option<&JsonValue>) -> Vec<(JsonValue, Option<JsonValue>)> {
    let Some(JsonValue::Array(items)) = raw else {
        return Vec::new();
    };
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for entry in items {
        // `typeof entry !== 'object' || entry === null`; an array has no id
        if !matches!(entry, JsonValue::Object(_) | JsonValue::Array(_)) {
            continue;
        }
        let id = str_trim(prop(entry, "id"));
        if id.is_empty() || seen.contains(&id) {
            continue;
        }
        seen.push(id.clone());
        let models: Option<Vec<String>> = match prop(entry, "models") {
            Some(JsonValue::Array(list)) => {
                let mut uniq: Vec<String> = Vec::new();
                for m in list {
                    if let JsonValue::String(t) = m {
                        let t = trim(t).to_owned();
                        if !uniq.contains(&t) {
                            uniq.push(t);
                        }
                    }
                }
                Some(uniq.into_iter().filter(|m| !m.is_empty()).collect())
            }
            _ => None,
        };
        let mut e = Obj::new();
        e.set("id", text(id));
        e.set("name", text(str_trim(prop(entry, "name"))));
        e.set("baseUrl", text(str_trim(prop(entry, "baseUrl"))));
        e.set("apiKey", text(str_trim(prop(entry, "apiKey"))));
        e.set("model", text(str_trim(prop(entry, "model"))));
        if let Some(models) = models.filter(|m| !m.is_empty()) {
            let refs: Vec<&str> = models.iter().map(String::as_str).collect();
            e.set("models", string_list(&refs));
        }
        if let Some(effort) = ai_effort_of(prop(entry, "effort")) {
            e.set("effort", text(effort));
        }
        // local-only fields survive a read/write round trip; malformed ones are dropped
        e.assign(&local_endpoint_fields_of(entry));
        out.push((
            JsonValue::Object(e),
            local_model_profiles_proto(prop(entry, "modelProfiles")),
        ));
    }
    out
}

/// The active server's level and what its model profile says the model
/// takes, in the shape the request path reads from `providers.custom`.
fn effort_of(endpoint: &JsonValue, proto: Option<&JsonValue>) -> Obj {
    let mut out = Obj::new();
    if let Some(effort) = ai_effort_of(prop(endpoint, "effort")) {
        out.set("effort", text(effort));
    }
    let model = prop(endpoint, "model");
    let profile = prop(endpoint, "modelProfiles").and_then(|profiles| {
        as_str(model).and_then(|m| {
            // `profiles["__proto__"]` reads the prototype the table was given
            if m == "__proto__" {
                proto
            } else {
                prop(profiles, m)
            }
        })
    });
    let taken = ai_model_effort_of(Some(&object(vec![
        // `{ efforts: profile?.efforts, defaultEffort: profile?.defaultEffort }`
        (
            "efforts",
            profile
                .and_then(|p| prop(p, "efforts"))
                .cloned()
                .unwrap_or(JsonValue::Null),
        ),
        (
            "defaultEffort",
            profile
                .and_then(|p| prop(p, "defaultEffort"))
                .cloned()
                .unwrap_or(JsonValue::Null),
        ),
    ])));
    if let (Some(taken), Some(model)) = (taken, as_str(model).filter(|m| !m.is_empty())) {
        let mut table = Obj::new();
        // a computed key in an object literal: `__proto__` is an own key here
        table.set(model, taken.to_json());
        out.set("modelEfforts", JsonValue::Object(table));
    }
    out
}

/// `resolveCustomEndpoints(settings)`: the endpoint list and the `custom`
/// slot made consistent. Pure: returns a new object.
pub fn resolve_custom_endpoints(settings: &Obj) -> Obj {
    let settings_value = JsonValue::Object(settings.clone());
    let normalized = normalize_endpoints(settings.get("customEndpoints"));
    let protos: Vec<Option<JsonValue>> = normalized.iter().map(|(_, p)| p.clone()).collect();
    let mut endpoints: Vec<JsonValue> = normalized.into_iter().map(|(e, _)| e).collect();
    let slot = prop(&settings_value, "providers").and_then(|p| prop(p, "custom"));
    if endpoints.is_empty() && configured_slot(slot) {
        endpoints = vec![object(vec![
            ("id", text(new_custom_endpoint_id())),
            ("name", text("")),
            (
                "baseUrl",
                text(str_trim(slot.and_then(|s| prop(s, "baseUrl")))),
            ),
            (
                "apiKey",
                text(str_trim(slot.and_then(|s| prop(s, "apiKey")))),
            ),
            ("model", text(str_trim(slot.and_then(|s| prop(s, "model"))))),
        ])];
    }
    if endpoints.is_empty() {
        let mut rest = without(settings, &["customEndpoints", "customEndpoint"]);
        // an explicit "no active server" survives an empty list
        if as_str(settings.get("customEndpoint")) == Some("") {
            rest.set("customEndpoint", text(""));
        }
        return rest;
    }
    let stored_active = settings.get("customEndpoint");
    let no_active_server = as_str(stored_active).is_some_and(|t| trim(t).is_empty());
    let active_at: Option<usize> = if no_active_server {
        None
    } else {
        let wanted = str_trim(stored_active);
        endpoints
            .iter()
            .position(|e| as_str(prop(e, "id")) == Some(wanted.as_str()))
            .or(Some(0))
    };
    let active: Option<&JsonValue> = active_at.and_then(|at| endpoints.get(at));
    // the seeded entry (from the slot) has no profiles
    let active_proto: Option<&JsonValue> = active_at
        .and_then(|at| protos.get(at))
        .and_then(Option::as_ref);
    let mut next = settings.clone();
    let list = JsonValue::Array(endpoints.clone());
    let providers = spread(coalesce(settings.get("providers"), None));
    let mut providers = providers;
    let Some(active) = active else {
        next.set("customEndpoints", list);
        next.set("customEndpoint", text(""));
        // clear the mirror: isKeyProviderConfigured must read false
        providers.set(
            "custom",
            object(vec![
                ("apiKey", text("")),
                ("model", text("")),
                ("baseUrl", text("")),
            ]),
        );
        next.set("providers", JsonValue::Object(providers));
        return next;
    };
    let field = |key: &str| prop(active, key).cloned().unwrap_or(JsonValue::Null);
    let mut custom = Obj::new();
    custom.set("apiKey", field("apiKey"));
    custom.set("model", field("model"));
    custom.set("baseUrl", field("baseUrl"));
    custom.assign(&effort_of(active, active_proto));
    next.set("customEndpoints", list);
    next.set("customEndpoint", field("id"));
    providers.set("custom", JsonValue::Object(custom));
    next.set("providers", JsonValue::Object(providers));
    next
}
