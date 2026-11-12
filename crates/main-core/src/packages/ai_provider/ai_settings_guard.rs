//! `packages/ai-provider/src/ai-settings-guard.ts`: the schema check for
//! renderer-supplied AI settings. A compromised renderer must not be able to
//! plant an arbitrary `cliPath` or a `baseUrl` that would receive the user's
//! API key.
//!
//! The TypeScript reads the home folder and stats a path; here a
//! [`GuardHost`] does.

use super::effort::{ai_effort_of, ai_model_efforts_of};
use super::jsval::{
    Obj, as_record, as_str, assign, js_string_or_empty_checked, number, prop, slice_to, text,
};
use super::local_profile::local_endpoint_fields_of;
use super::providers::{
    AI_PROVIDERS, AI_SUBSCRIPTION_PROVIDERS, provider_ids, read_url_settings_of,
    sanitize_subscription_off,
};
use super::registry::normalize_base_url;
use jscompat::node_path::host::join;
use jscompat::{JsTypeError, JsonValue, trim};

const MAX_API_KEY_LENGTH: usize = 8192;
const MAX_MODEL_LENGTH: usize = 256;
const MAX_CLI_PATH_LENGTH: usize = 1024;
const MAX_ENDPOINT_ID_LENGTH: usize = 64;
const MAX_ENDPOINT_NAME_LENGTH: usize = 128;
const MAX_ENDPOINT_MODELS: usize = 2000;

/// What the guard asks of the machine: `os.homedir()` and
/// `statSync(path).isFile()` (false where the stat throws).
pub trait GuardHost {
    fn home_dir(&self) -> String;
    fn is_file(&self, path: &str) -> bool;
}

/// `~` / `~/...` (`~\...` on Windows) expanded against the real home
/// directory. Non-`~` values pass through untouched.
fn expand_home(host: &dyn GuardHost, value: &str) -> String {
    if value == "~" {
        return host.home_dir();
    }
    if value.starts_with("~/") || value.starts_with("~\\") {
        let rest = jscompat::slice_utf16(value, 2.0, None);
        return join(&[host.home_dir().as_str(), rest.as_str()]);
    }
    value.to_owned()
}

/// `validCliPath(raw)`: an executable path accepted from the renderer. When
/// the value looks like a path (`/`, `\` or `.` anywhere, or a `~`) it must
/// exist as a file; a bare command name is kept. Empty means auto-detect.
pub fn valid_cli_path(host: &dyn GuardHost, raw: Option<&JsonValue>) -> bool {
    let Some(raw) = as_str(raw) else {
        return false;
    };
    let value = trim(raw);
    if value.is_empty() {
        return false;
    }
    if value.encode_utf16().count() > MAX_CLI_PATH_LENGTH {
        return false;
    }
    if value.chars().any(|c| matches!(c, '.' | '/' | '\\' | '~')) {
        // a path, not a bare command: it must be an existing file
        return host.is_file(&expand_home(host, value));
    }
    true
}

/// `sanitizeCliPath(raw)`: the spawnable form of a renderer-supplied cliPath
/// (trimmed, `~` expanded), or `None` when it fails `validCliPath`.
pub fn sanitize_cli_path(host: &dyn GuardHost, raw: Option<&JsonValue>) -> Option<String> {
    if !valid_cli_path(host, raw) {
        return None;
    }
    Some(expand_home(host, trim(as_str(raw)?)))
}

/// http(s) URL with no embedded credentials, normalized like request time.
fn sanitize_base_url(raw: &JsonValue) -> Option<String> {
    normalize_base_url(as_str(Some(raw)), "").ok()
}

struct ProviderConfig {
    api_key: String,
    model: String,
    base_url: Option<String>,
    cli_path: Option<String>,
    effort: Option<&'static str>,
    model_efforts: Option<JsonValue>,
}

impl ProviderConfig {
    fn to_obj(&self) -> Obj {
        let mut out = Obj::new();
        out.set("apiKey", text(self.api_key.as_str()));
        out.set("model", text(self.model.as_str()));
        if let Some(u) = &self.base_url {
            out.set("baseUrl", text(u.as_str()));
        }
        if let Some(p) = &self.cli_path {
            out.set("cliPath", text(p.as_str()));
        }
        if let Some(e) = self.effort {
            out.set("effort", text(e));
        }
        if let Some(m) = &self.model_efforts {
            out.set("modelEfforts", m.clone());
        }
        out
    }
}

fn sanitize_provider_config(
    host: &dyn GuardHost,
    input: &JsonValue,
) -> Result<ProviderConfig, JsTypeError> {
    let empty = JsonValue::Object(Obj::new());
    let raw = if as_record(input).is_some() {
        input
    } else {
        &empty
    };
    let api_key = slice_to(
        &js_string_or_empty_checked(prop(raw, "apiKey"))?,
        MAX_API_KEY_LENGTH,
    );
    let model = slice_to(
        &js_string_or_empty_checked(prop(raw, "model"))?,
        MAX_MODEL_LENGTH,
    );
    let mut base_url = None;
    match prop(raw, "baseUrl") {
        None | Some(JsonValue::Null) => {}
        Some(JsonValue::String(t)) if t.is_empty() => {}
        Some(url) => base_url = sanitize_base_url(url),
    }
    let cli_path = sanitize_cli_path(host, prop(raw, "cliPath"));
    // a level of the fixed list or nothing: the Claude bridge hands it to `--effort`
    let effort = ai_effort_of(prop(raw, "effort"));
    // known levels only
    let model_efforts = ai_model_efforts_of(prop(raw, "modelEfforts"));
    Ok(ProviderConfig {
        api_key,
        model,
        base_url,
        cli_path,
        effort,
        model_efforts,
    })
}

fn sanitize_media_settings(raw: &Obj) -> JsonValue {
    let mut media = raw.clone();
    let Some(JsonValue::Object(stored)) = raw.get("providers") else {
        return JsonValue::Object(media);
    };
    let mut providers = Obj::new();
    for (id, value) in stored.entries() {
        let JsonValue::Object(value) = value else {
            continue;
        };
        let mut config = value.clone();
        match config.get("baseUrl").cloned() {
            None | Some(JsonValue::Null) => remove(&mut config, "baseUrl"),
            Some(JsonValue::String(t)) if t.is_empty() => remove(&mut config, "baseUrl"),
            Some(url) => match sanitize_base_url(&url) {
                None => remove(&mut config, "baseUrl"),
                Some(u) => config.set("baseUrl", text(u)),
            },
        }
        assign(&mut providers, id, JsonValue::Object(config));
    }
    media.set("providers", JsonValue::Object(providers));
    JsonValue::Object(media)
}

/// `delete config[key]`
fn remove(config: &mut Obj, key: &str) {
    if config.get(key).is_some() {
        *config = super::jsval::without(config, &[key]);
    }
}

fn sanitize_custom_endpoints(
    host: &dyn GuardHost,
    raw: Option<&JsonValue>,
) -> Result<Vec<JsonValue>, JsTypeError> {
    let Some(JsonValue::Array(items)) = raw else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in items {
        let Some(e) = as_record(entry) else {
            continue;
        };
        let id = slice_to(
            trim(&js_string_or_empty_checked(e.get("id"))?),
            MAX_ENDPOINT_ID_LENGTH,
        );
        if id.is_empty() {
            continue;
        }
        let config = sanitize_provider_config(host, entry)?;
        let models: Option<Vec<String>> = match e.get("models") {
            Some(JsonValue::Array(list)) => Some(
                list.iter()
                    .filter_map(|m| match m {
                        JsonValue::String(t) => Some(t.as_str()),
                        _ => None,
                    })
                    .take(MAX_ENDPOINT_MODELS)
                    .map(|m| slice_to(m, MAX_MODEL_LENGTH))
                    .collect(),
            ),
            _ => None,
        };
        let mut item = Obj::new();
        item.set("id", text(id));
        item.set(
            "name",
            text(slice_to(
                &js_string_or_empty_checked(e.get("name"))?,
                MAX_ENDPOINT_NAME_LENGTH,
            )),
        );
        item.set("baseUrl", text(config.base_url.clone().unwrap_or_default()));
        item.set("apiKey", text(config.api_key.as_str()));
        item.set("model", text(config.model.as_str()));
        if let Some(models) = models.filter(|m| !m.is_empty()) {
            let refs: Vec<&str> = models.iter().map(String::as_str).collect();
            item.set("models", super::jsval::string_list(&refs));
        }
        if let Some(effort) = config.effort {
            item.set("effort", text(effort));
        }
        // local-only fields: bounded, and dropped rather than rejecting the endpoint
        item.assign(&local_endpoint_fields_of(entry));
        out.push(JsonValue::Object(item));
    }
    Ok(out)
}

/// `sanitizeAiSettings(input)`: a sanitized copy of `input`, or `None` when
/// the payload is not even the right shape (non-object, unknown provider).
/// Invalid individual fields are dropped rather than rejecting the whole
/// payload. `Err` is the `TypeError` of `String(value)` on an object that
/// converts to no primitive.
pub fn sanitize_ai_settings(
    host: &dyn GuardHost,
    input: &JsonValue,
) -> Result<Option<JsonValue>, JsTypeError> {
    let Some(raw) = as_record(input) else {
        return Ok(None);
    };
    let ids = provider_ids();
    // `auto` is the one selection that is not a provider id
    let provider = match raw.get("provider") {
        Some(JsonValue::String(p)) if p == "auto" || ids.contains(&p.as_str()) => p.clone(),
        _ => return Ok(None),
    };
    let Some(JsonValue::Object(raw_providers)) = raw.get("providers") else {
        return Ok(None);
    };
    let mut providers = Obj::new();
    for (id, config) in raw_providers.entries() {
        if !ids.contains(&id) {
            continue;
        }
        let mut clean = sanitize_provider_config(host, config)?.to_obj();
        // a per-request token is never a setting
        if AI_PROVIDERS.iter().any(|m| m.id == id && m.request_token) {
            clean.set("apiKey", text(""));
        }
        providers.set(id, JsonValue::Object(clean));
    }
    let mut settings = Obj::new();
    settings.set("provider", text(provider));
    settings.set("providers", JsonValue::Object(providers));
    // accepting a metered login lets the app spend the user's money: only the
    // two subscription ids and only real booleans get through
    if let Some(JsonValue::Object(metered)) = raw.get("meteredAccepted") {
        let mut accepted = Obj::new();
        for id in AI_SUBSCRIPTION_PROVIDERS {
            if let Some(JsonValue::Bool(b)) = metered.get(id) {
                accepted.set(id, JsonValue::Bool(*b));
            }
        }
        settings.set("meteredAccepted", JsonValue::Object(accepted));
    }
    // what a renderer read from the file rides on its run requests and can only stop more
    if let Some(off) = sanitize_subscription_off(raw.get("subscriptionOff")) {
        settings.set("subscriptionOff", off);
    }
    if let Some(JsonValue::Bool(b)) = raw.get("headlessSubscriptionEnabled") {
        settings.set("headlessSubscriptionEnabled", JsonValue::Bool(*b));
    }
    // without it a switch turned on reads as off again: kept, but only as a whole number
    if let Some(JsonValue::Number(x)) = raw.get("headlessSubscriptionConsentVersion")
        && x.is_finite()
        && x.trunc() == *x
        && *x >= 0.0
    {
        settings.set("headlessSubscriptionConsentVersion", number(*x));
    }
    if let Some(JsonValue::Bool(b)) = raw.get("subscriptionNoticeSeen") {
        settings.set("subscriptionNoticeSeen", JsonValue::Bool(*b));
    }
    if let Some(JsonValue::Number(x)) = raw.get("subscriptionNoticeVersion")
        && x.is_finite()
        && x.trunc() == *x
        && *x >= 0.0
    {
        settings.set("subscriptionNoticeVersion", number(*x));
    }
    if let Some(JsonValue::Number(x)) = raw.get("pdfSendNoticeSeen")
        && x.is_finite()
        && x.trunc() == *x
        && *x > 0.0
    {
        settings.set("pdfSendNoticeSeen", number(*x));
    }
    // only an explicit false is kept: anything else is the default, on
    if matches!(raw.get("internetTools"), Some(JsonValue::Bool(false))) {
        settings.set("internetTools", JsonValue::Bool(false));
    }
    // the read_url token is persisted in the settings file like the provider
    // keys; a blank or non-string token is left out (public pages only)
    if let Some(read_url) = read_url_settings_of(raw.get("readUrl"))
        && let Some(token) = as_str(prop(&read_url, "githubToken")).filter(|t| !t.is_empty())
    {
        let mut out = Obj::new();
        out.set("githubToken", text(slice_to(token, MAX_API_KEY_LENGTH)));
        settings.set("readUrl", JsonValue::Object(out));
    }
    let custom_endpoints = sanitize_custom_endpoints(host, raw.get("customEndpoints"))?;
    if !custom_endpoints.is_empty() {
        settings.set("customEndpoints", JsonValue::Array(custom_endpoints));
        if let Some(JsonValue::String(active)) = raw.get("customEndpoint") {
            settings.set(
                "customEndpoint",
                text(slice_to(active, MAX_ENDPOINT_ID_LENGTH)),
            );
        }
    }
    if let Some(JsonValue::Number(x)) = raw.get("maxOutputTokens")
        && x.is_finite()
        && *x > 0.0
    {
        settings.set("maxOutputTokens", number(x.floor()));
    }
    // media providers carry a baseUrl that receives their api key: same gate as
    // the chat providers; search carries only enums and api keys
    if let Some(JsonValue::Object(media)) = raw.get("media") {
        settings.set("media", sanitize_media_settings(media));
    }
    if let Some(search) = raw
        .get("search")
        .filter(|s| matches!(s, JsonValue::Object(_)))
    {
        settings.set("search", search.clone());
    }
    Ok(Some(JsonValue::Object(settings)))
}
