//! `packages/ai-provider/src/local-profile.ts`: the readers of the stored
//! profile fields (`localEndpointFieldsOf` and what it calls). The merge of
//! two profiles and the two answers of the request path
//! (`localModelCapabilities`, `localContextLimit`) are not here.

use super::effort::{ai_effort_of, ai_efforts_of};
use super::jsval::{
    Obj, as_record, as_str, assign, length16, number, slice_to, str_trim, string_list, text,
};
use jscompat::JsonValue;

/// context assumed when a local model's window is unknown
pub const DEFAULT_LOCAL_CONTEXT_TOKENS: f64 = 4096.0;
/// first-response limit used when an endpoint carries none
pub const DEFAULT_LOCAL_TIMEOUT_MS: f64 = 300_000.0;
pub const MIN_LOCAL_TIMEOUT_MS: f64 = 60_000.0;
pub const MAX_LOCAL_TIMEOUT_MS: f64 = 600_000.0;
pub const MAX_LOCAL_CONTEXT_TOKENS: f64 = 10_000_000.0;
pub const MAX_LOCAL_MODEL_PROFILES: usize = 2_000;
pub const MAX_LOCAL_MODEL_ID_LENGTH: usize = 256;
pub const MAX_LOCAL_NOTES_LENGTH: usize = 500;

/// an integer inside `[min, max]`, or `None` when the value is not one
fn integer_in_range(value: Option<&JsonValue>, min: f64, max: f64) -> Option<f64> {
    match value {
        Some(JsonValue::Number(x))
            if x.is_finite() && x.trunc() == *x && *x >= min && *x <= max =>
        {
            Some(*x)
        }
        _ => None,
    }
}

/// `localValueSourceOf(raw)`
pub fn local_value_source_of(raw: Option<&JsonValue>) -> Option<&'static str> {
    match as_str(raw) {
        Some("server") => Some("server"),
        Some("user") => Some("user"),
        Some("test") => Some("test"),
        _ => None,
    }
}

/// `localContextTokensOf(raw)`
pub fn local_context_tokens_of(raw: Option<&JsonValue>) -> Option<f64> {
    integer_in_range(raw, 1.0, MAX_LOCAL_CONTEXT_TOKENS)
}

/// `localTimeoutMsOf(raw)`
pub fn local_timeout_ms_of(raw: Option<&JsonValue>) -> Option<f64> {
    integer_in_range(raw, MIN_LOCAL_TIMEOUT_MS, MAX_LOCAL_TIMEOUT_MS)
}

/// `localModelProfileOf(raw)`: one model profile with every malformed field
/// dropped; `None` when nothing survives.
pub fn local_model_profile_of(raw: &JsonValue) -> Option<JsonValue> {
    let raw = as_record(raw)?;
    let mut profile = Obj::new();
    if let Some(x) = local_context_tokens_of(raw.get("contextLength")) {
        profile.set("contextLength", number(x));
    }
    if let Some(x) = local_context_tokens_of(raw.get("maxContextLength")) {
        profile.set("maxContextLength", number(x));
    }
    if let Some(JsonValue::Bool(b)) = raw.get("tools") {
        profile.set("tools", JsonValue::Bool(*b));
    }
    if let Some(JsonValue::Bool(b)) = raw.get("vision") {
        profile.set("vision", JsonValue::Bool(*b));
    }
    for key in ["contextSource", "toolsSource", "visionSource"] {
        if let Some(source) = local_value_source_of(raw.get(key)) {
            profile.set(key, text(source));
        }
    }
    if let Some(JsonValue::Number(x)) = raw.get("checkedAt")
        && x.is_finite()
        && x.trunc() == *x
        && *x > 0.0
    {
        profile.set("checkedAt", number(*x));
    }
    // notes are free text: trimmed, bounded, and left out when blank
    let notes = slice_to(&str_trim(raw.get("notes")), MAX_LOCAL_NOTES_LENGTH);
    if !notes.is_empty() {
        profile.set("notes", text(notes));
    }
    // the levels the server named; a default counts only as one of them
    if let Some(efforts) = ai_efforts_of(raw.get("efforts")) {
        profile.set("efforts", string_list(&efforts));
        if let Some(default_effort) = ai_effort_of(raw.get("defaultEffort"))
            && efforts.contains(&default_effort)
        {
            profile.set("defaultEffort", text(default_effort));
        }
    }
    (!profile.is_empty()).then_some(JsonValue::Object(profile))
}

/// `localModelProfilesOf(raw)`: the profile map with malformed entries
/// dropped and the entry count capped.
pub fn local_model_profiles_of(raw: Option<&JsonValue>) -> Option<JsonValue> {
    let raw = as_record(raw?)?;
    let mut profiles = Obj::new();
    let mut count = 0;
    for (key, value) in raw.entries() {
        if count >= MAX_LOCAL_MODEL_PROFILES {
            break;
        }
        let model_id = str_trim(Some(&text(key)));
        if model_id.is_empty() || length16(&model_id) > MAX_LOCAL_MODEL_ID_LENGTH {
            continue;
        }
        let Some(profile) = local_model_profile_of(value) else {
            continue;
        };
        // an id `__proto__` sets the prototype: counted, no key
        assign(&mut profiles, &model_id, profile);
        count += 1;
    }
    (count > 0).then_some(JsonValue::Object(profiles))
}

/// The prototype `localModelProfilesOf` gives its table: `profiles["__proto__"] =
/// profile` sets the prototype of the table instead of an own key, and
/// `table["__proto__"]` reads it back. The last such profile wins.
pub fn local_model_profiles_proto(raw: Option<&JsonValue>) -> Option<JsonValue> {
    let raw = as_record(raw?)?;
    let mut proto = None;
    let mut count = 0;
    for (key, value) in raw.entries() {
        if count >= MAX_LOCAL_MODEL_PROFILES {
            break;
        }
        let model_id = str_trim(Some(&text(key)));
        if model_id.is_empty() || length16(&model_id) > MAX_LOCAL_MODEL_ID_LENGTH {
            continue;
        }
        let Some(profile) = local_model_profile_of(value) else {
            continue;
        };
        if model_id == "__proto__" {
            proto = Some(profile);
        }
        count += 1;
    }
    proto
}

/// `localEndpointFieldsOf(raw)`: the local-only fields of one endpoint, in
/// the order `kind`, `modelProfiles`, `timeoutMs`.
pub fn local_endpoint_fields_of(raw: &JsonValue) -> Obj {
    let mut out = Obj::new();
    let Some(raw) = as_record(raw) else {
        return out;
    };
    if as_str(raw.get("kind")) == Some("local") {
        out.set("kind", text("local"));
    }
    if let Some(profiles) = local_model_profiles_of(raw.get("modelProfiles")) {
        out.set("modelProfiles", profiles);
    }
    if let Some(ms) = local_timeout_ms_of(raw.get("timeoutMs")) {
        out.set("timeoutMs", number(ms));
    }
    out
}

/// `localEndpointTimeoutMs(endpoint)`: the endpoint's first-response limit,
/// or the default when it carries none.
pub fn local_endpoint_timeout_ms(endpoint: Option<&JsonValue>) -> f64 {
    let timeout = endpoint.and_then(|e| super::jsval::prop(e, "timeoutMs"));
    local_timeout_ms_of(timeout).unwrap_or(DEFAULT_LOCAL_TIMEOUT_MS)
}
