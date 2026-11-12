//! The functions of group `b5-ai` (tools/main-diff/groups/b5-ai.ts): the AI
//! settings layer of `packages/ai-provider/src` and the AI modules of
//! `apps/{docs,sheets,slides,shell}/src/main`.
//!
//! Names are `<ts-file>.<export>`; the files of `packages/ai-provider/src` are
//! `ai-provider/<ts-file>.<export>`, and `ai-run` (docs and sheets both have
//! one) is `docs/ai-run` and `sheets/ai-run`. A settings object, a status
//! table or a stored file is the JSON value, read as JavaScript would hold it;
//! a top-level JSON `null` is `undefined` (left out). A thrown value is the
//! object `jsval::error_class` describes (`{"$class":"AiRunError",...}`).
//!
//! The codec of `settings-secrets.ts` is a module variable there: a spec names
//! it as its first argument, `"none"` (no codec registered) or `"fake"`, which
//! seals `x` as `sealed:v1:` + `encodeURIComponent(x)` (a value starting with
//! `!` stays plain, one starting with `?` throws) and opens by
//! `decodeURIComponent` (`null` opens to nothing, `throw` throws).

use std::cell::RefCell;
use std::fs;

use jscompat::{
    JsonValue, decode_uri_component, encode_uri_component, json_value_from_serde,
    json_value_to_serde,
};
use serde_json::Value;

use super::{Answer, CallError, Context, arg, str_arg};
use crate::docs::ai_keepalive::{
    AI_KEEPALIVE_INTERVAL_MS, AiKeepalive, FirstChunkKeepalive, Interval, start_ai_keepalive,
    start_first_chunk_keepalive,
};
use crate::docs::ai_run as docs_ai_run;
use crate::docs::free_ai_strings::FREE_AI_PAGE_STRINGS;
use crate::packages::ai_provider::ai_settings_guard::{
    GuardHost, sanitize_ai_settings, sanitize_cli_path, valid_cli_path,
};
use crate::packages::ai_provider::custom_endpoints::resolve_custom_endpoints;
use crate::packages::ai_provider::effort::{
    ai_effort_of, ai_efforts_of, ai_model_effort_of, ai_model_efforts_of,
};
use crate::packages::ai_provider::free_ai::{
    free_limit_of, is_free_tier_model_refusal, next_pacific_midnight,
};
use crate::packages::ai_provider::jsval::{
    Obj, as_record, as_str, number, object, prop, string_list, text,
};
use crate::packages::ai_provider::legacy_settings::{
    DEFAULT_AI_ANALYSIS_PROVIDER, DEFAULT_AI_IMAGE_PROVIDER, DEFAULT_AI_PROVIDER_SELECTION,
    DEFAULT_AI_SEARCH_PROVIDER, DEFAULT_AI_VIDEO_ANALYSIS_PROVIDER, normalize_ai_settings,
};
use crate::packages::ai_provider::local_profile::local_endpoint_fields_of;
use crate::packages::ai_provider::media::{default_ai_media_settings, resolve_ai_media_settings};
use crate::packages::ai_provider::network_error::is_ai_network_error;
use crate::packages::ai_provider::overload_error::is_ai_overloaded_error;
use crate::packages::ai_provider::provider_selection::{
    SubscriptionConnection, is_key_provider_configured, is_subscription_provider,
    provider_selection_of, select_ai_provider, subscription_connection, subscription_off_in,
    subscription_state_of,
};
use crate::packages::ai_provider::providers::{
    AI_SUBSCRIPTION_NOTICE_VERSION, ai_providers_json, clamp_max_output_tokens,
    default_ai_settings, headless_consent_version_of, headless_subscription_on, listed_models_of,
    max_output_tokens_of, read_url_settings_of, sanitize_metered_accepted,
    sanitize_subscription_off, subscription_notice_version_of,
    with_migrated_subscription_notice_version,
};
use crate::packages::ai_provider::registry::normalize_base_url;
use crate::packages::ai_provider::run_error::ai_stream_error_fields;
use crate::packages::ai_provider::search_settings::{
    default_ai_search_settings, resolve_ai_search_settings,
};
use crate::packages::ai_provider::settings_secrets::{
    AiSecretCodec, CodecThrow, SEALED_PREFIX, is_sealed_secret, map_ai_secrets, open_ai_secrets,
    open_secret_value, seal_ai_secrets, seal_secret_value, sealed_ai_secrets_in,
};
use crate::packages::ai_provider::watchdog::normalize_watchdog_timeout;
use crate::packages::electron_utils::ai_run_guard::{AiRunGuardInput, AiRunGuardSlot};
use crate::packages::electron_utils::drive_ai_channels::{
    DRIVE_AI_CHANNELS, drive_ai_on, drive_connected_of,
};
use crate::packages::ui::{
    SLIDES_AI_FONTS_KEY, default_slides_ai_fonts, normalize_slides_ai_fonts,
};
use crate::sheets::ai_run as sheets_ai_run;
use crate::shell::ai_naming::{build_naming_instruction, excerpt_for_naming, sanitize_file_stem};
use crate::shell::ai_naming_provider::resolve_naming_provider;
use crate::shell::ai_secrets::{
    MAX_REVEAL_VALUES, REVEAL_FLAG, SafeStorageCodec, SafeStorageLike, StdinEvent,
    file_search_holds_plain_keys, holds_plain_secrets, linux_keyring_seals, open_file_search_keys,
    platform_seals, reveal_answer, reveal_request_of, run_reveal_entry, seal_file_search_keys,
    seal_stored_ai_settings, sealing_key_on_disk,
};
use crate::slides::ai_default_fonts::{
    SettingsPathProvider, TITLE_ROLE_MIN_PT, fill_missing_run_fonts, parse_font_roles,
    read_slides_ai_fonts,
};

// ---- the arguments ----

/// The argument at `i` as a JavaScript value; a top-level `null` is `undefined`.
fn jv(args: &[Value], i: usize) -> Option<JsonValue> {
    match arg(args, i) {
        None | Some(Value::Null) => None,
        Some(v) => Some(json_value_from_serde(v)),
    }
}

/// The argument at `i` with `null` kept.
fn jv_exact(args: &[Value], i: usize) -> JsonValue {
    arg(args, i).map_or(JsonValue::Null, json_value_from_serde)
}

fn out(value: JsonValue) -> Answer {
    Ok(Some(json_value_to_serde(&value)))
}

fn out_bool(b: bool) -> Answer {
    Ok(Some(Value::Bool(b)))
}

fn out_num(x: f64) -> Answer {
    out(number(x))
}

/// `null` where the TypeScript returns `null`
fn out_opt(value: Option<JsonValue>) -> Answer {
    out(value.unwrap_or(JsonValue::Null))
}

/// `undefined` where the TypeScript returns `undefined`
fn out_undef(value: Option<JsonValue>) -> Answer {
    match value {
        Some(v) => out(v),
        None => Ok(None),
    }
}

fn type_error(e: jscompat::JsTypeError) -> CallError {
    CallError::plain(e.0)
}

fn f64_arg(args: &[Value], i: usize) -> f64 {
    arg(args, i).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// A random endpoint id differs on each side: `ep-<8 characters>` reads as
/// `ep-<rand>` in an answer.
fn mask_ids(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::String(t) => {
            let masked = t.len() == 11
                && t.starts_with("ep-")
                && t[3..]
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
            if masked {
                JsonValue::String("ep-<rand>".to_owned())
            } else {
                JsonValue::String(t)
            }
        }
        JsonValue::Array(items) => JsonValue::Array(items.into_iter().map(mask_ids).collect()),
        JsonValue::Object(object) => {
            let mut out = Obj::new();
            for (key, v) in object.entries() {
                out.set(key, mask_ids(v.clone()));
            }
            JsonValue::Object(out)
        }
        other => other,
    }
}

// ---- the fakes ----

/// the codec a spec names (see the module)
struct FakeCodec;

impl AiSecretCodec for FakeCodec {
    fn seal(&self, plain: &str) -> Result<Option<String>, CodecThrow> {
        if plain.starts_with('!') {
            return Ok(None);
        }
        if plain.starts_with('?') {
            return Err(CodecThrow("seal failed".to_owned()));
        }
        Ok(Some(format!(
            "{SEALED_PREFIX}{}",
            encode_uri_component(plain)
        )))
    }

    fn open(&self, sealed: &str) -> Result<Option<String>, CodecThrow> {
        let rest = jscompat::slice_utf16(sealed, SEALED_PREFIX.len() as f64, None);
        let rest = rest.as_str();
        if rest == "null" {
            return Ok(None);
        }
        if rest == "throw" {
            return Err(CodecThrow("open failed".to_owned()));
        }
        decode_uri_component(rest)
            .map(Some)
            .map_err(|_| CodecThrow("URI malformed".to_owned()))
    }
}

fn codec_mode(args: &[Value], i: usize) -> Result<Option<FakeCodec>, CallError> {
    match str_arg(args, i)? {
        "none" => Ok(None),
        "fake" => Ok(Some(FakeCodec)),
        other => Err(CallError::plain(format!("no such codec: {other}"))),
    }
}

/// `os.homedir()` and `statSync(path).isFile()`
struct RealHost;

impl GuardHost for RealHost {
    #[allow(deprecated)]
    fn home_dir(&self) -> String {
        std::env::home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    fn is_file(&self, path: &str) -> bool {
        fs::metadata(path).map(|m| m.is_file()).unwrap_or(false)
    }
}

/// `AiRunTexts` of the specs
struct Texts;

impl docs_ai_run::AiRunTexts for Texts {
    fn no_api_key(&self, provider: &str) -> String {
        format!("no key for {provider}")
    }

    fn no_model(&self) -> String {
        "no model".to_owned()
    }
}

/// a fake `safeStorage` the spec describes: `{ available, backend?,
/// encryptThrows?, decryptThrows? }`. It encrypts `x` as the bytes of
/// `enc:x` and decrypts bytes that start with `enc:`.
struct FakeStorage {
    available: bool,
    backend: Option<Option<String>>,
    encrypt_throws: bool,
    decrypt_throws: bool,
}

impl FakeStorage {
    fn from_spec(spec: &JsonValue) -> FakeStorage {
        let flag = |key: &str| matches!(prop(spec, key), Some(JsonValue::Bool(true)));
        FakeStorage {
            available: flag("available"),
            backend: prop(spec, "backend").map(|b| as_str(Some(b)).map(str::to_owned)),
            encrypt_throws: flag("encryptThrows"),
            decrypt_throws: flag("decryptThrows"),
        }
    }
}

impl SafeStorageLike for FakeStorage {
    fn is_encryption_available(&self) -> bool {
        self.available
    }

    fn encrypt_string(&self, plain: &str) -> Result<Vec<u8>, CodecThrow> {
        if self.encrypt_throws {
            return Err(CodecThrow("encrypt failed".to_owned()));
        }
        Ok(format!("enc:{plain}").into_bytes())
    }

    fn decrypt_string(&self, sealed: &[u8]) -> Result<String, CodecThrow> {
        let text = String::from_utf8_lossy(sealed).into_owned();
        match text.strip_prefix("enc:") {
            Some(plain) if !self.decrypt_throws => Ok(plain.to_owned()),
            _ => Err(CodecThrow("decrypt failed".to_owned())),
        }
    }

    fn get_selected_storage_backend(&self) -> Option<String> {
        // `undefined` and a missing method read the same
        self.backend.clone().flatten()
    }
}

/// `setInterval` and `clearInterval` of the keepalive specs: each call is one
/// log line.
struct LoggedInterval<'a> {
    cx: &'a mut Context,
    active: bool,
}

impl Interval for LoggedInterval<'_> {
    fn set_interval(&mut self, interval_ms: f64) -> u64 {
        self.cx.logs.push(vec![
            Value::from("setInterval"),
            json_value_to_serde(&number(interval_ms)),
        ]);
        self.active = true;
        1
    }

    fn clear_interval(&mut self, handle: u64) {
        self.cx
            .logs
            .push(vec![Value::from("clearInterval"), Value::from(handle)]);
        self.active = false;
    }
}

struct UserData(String);

impl SettingsPathProvider for UserData {
    fn user_data_path(&self) -> String {
        self.0.clone()
    }
}

// ---- the dispatcher ----

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let answer = match name {
        // ai-provider/providers
        "ai-provider/providers.AI_PROVIDERS" => out(ai_providers_json()),
        "ai-provider/providers.AI_SUBSCRIPTION_NOTICE_VERSION" => {
            out_num(AI_SUBSCRIPTION_NOTICE_VERSION)
        }
        "ai-provider/providers.withMigratedSubscriptionNoticeVersion" => {
            out_opt(jv(args, 0).and_then(|raw| with_migrated_subscription_notice_version(&raw)))
        }
        "ai-provider/providers.maxOutputTokensOf" => {
            out_num(max_output_tokens_of(jv(args, 0).as_ref()))
        }
        "ai-provider/providers.clampMaxOutputTokens" => {
            out_num(clamp_max_output_tokens(jv(args, 0).as_ref()))
        }
        "ai-provider/providers.defaultAiSettings" => out(default_ai_settings(jv(args, 0).as_ref())),
        "ai-provider/providers.subscriptionNoticeVersionOf" => out_num(
            subscription_notice_version_of(jv(args, 0).as_ref(), jv(args, 1).as_ref()),
        ),
        "ai-provider/providers.headlessConsentVersionOf" => {
            out_num(headless_consent_version_of(jv(args, 0).as_ref()))
        }
        "ai-provider/providers.headlessSubscriptionOn" => {
            let settings = jv_exact(args, 0);
            out_bool(headless_subscription_on(
                prop(&settings, "headlessSubscriptionEnabled"),
                prop(&settings, "headlessSubscriptionConsentVersion"),
            ))
        }
        "ai-provider/providers.sanitizeMeteredAccepted" => {
            out(sanitize_metered_accepted(jv(args, 0).as_ref()))
        }
        "ai-provider/providers.sanitizeSubscriptionOff" => {
            out_undef(sanitize_subscription_off(jv(args, 0).as_ref()))
        }
        "ai-provider/providers.readUrlSettingsOf" => {
            out_undef(read_url_settings_of(jv(args, 0).as_ref()))
        }
        "ai-provider/providers.listedModelsOf" => {
            out_undef(listed_models_of(jv(args, 0).as_ref()).map(|list| {
                let refs: Vec<&str> = list.iter().map(String::as_str).collect();
                string_list(&refs)
            }))
        }

        // ai-provider/provider-selection
        "ai-provider/provider-selection.isSubscriptionProvider" => {
            out_bool(is_subscription_provider(jv(args, 0).as_ref()))
        }
        "ai-provider/provider-selection.selectAiProvider" => {
            out(select_ai_provider(&jv_exact(args, 0), &jv_exact(args, 1)).to_json())
        }
        "ai-provider/provider-selection.providerSelectionOf" => {
            out(text(provider_selection_of(&jv_exact(args, 0))))
        }
        "ai-provider/provider-selection.isKeyProviderConfigured" => out_bool(
            is_key_provider_configured(&jv_exact(args, 0), str_arg(args, 1).unwrap_or("")),
        ),
        "ai-provider/provider-selection.subscriptionStateOf" => out(subscription_state_of(
            &jv_exact(args, 0),
            str_arg(args, 1).unwrap_or(""),
        )),
        "ai-provider/provider-selection.subscriptionOffIn" => out_bool(subscription_off_in(
            &jv_exact(args, 0),
            jv(args, 1).as_ref(),
        )),
        "ai-provider/provider-selection.subscriptionConnection" => out_opt(
            subscription_connection(&jv_exact(args, 0), jv(args, 1).as_ref()).map(|c| match c {
                SubscriptionConnection::Subscription => text("subscription"),
                SubscriptionConnection::Metered => text("metered"),
            }),
        ),

        // ai-provider/legacy-settings
        "ai-provider/legacy-settings.DEFAULT_AI_PROVIDER_SELECTION" => {
            out(text(DEFAULT_AI_PROVIDER_SELECTION))
        }
        "ai-provider/legacy-settings.DEFAULT_AI_IMAGE_PROVIDER" => {
            out(text(DEFAULT_AI_IMAGE_PROVIDER))
        }
        "ai-provider/legacy-settings.DEFAULT_AI_ANALYSIS_PROVIDER" => {
            out(text(DEFAULT_AI_ANALYSIS_PROVIDER))
        }
        "ai-provider/legacy-settings.DEFAULT_AI_VIDEO_ANALYSIS_PROVIDER" => {
            out(text(DEFAULT_AI_VIDEO_ANALYSIS_PROVIDER))
        }
        "ai-provider/legacy-settings.DEFAULT_AI_SEARCH_PROVIDER" => {
            out(text(DEFAULT_AI_SEARCH_PROVIDER))
        }
        "ai-provider/legacy-settings.normalizeAiSettings" => match codec_mode(args, 0) {
            Ok(codec) => out(mask_ids(normalize_ai_settings(
                codec.as_ref().map(|c| c as &dyn AiSecretCodec),
                jv(args, 1).as_ref(),
                jv(args, 2).as_ref(),
            ))),
            Err(e) => Err(e),
        },

        // ai-provider/ai-settings-guard
        "ai-provider/ai-settings-guard.sanitizeAiSettings" => {
            match sanitize_ai_settings(&RealHost, &jv_exact(args, 0)) {
                Ok(settings) => out_opt(settings),
                Err(e) => Err(type_error(e)),
            }
        }
        "ai-provider/ai-settings-guard.validCliPath" => {
            out_bool(valid_cli_path(&RealHost, jv(args, 0).as_ref()))
        }
        "ai-provider/ai-settings-guard.sanitizeCliPath" => {
            out_undef(sanitize_cli_path(&RealHost, jv(args, 0).as_ref()).map(text))
        }

        // ai-provider/settings-secrets
        "ai-provider/settings-secrets.SEALED_PREFIX" => out(text(SEALED_PREFIX)),
        "ai-provider/settings-secrets.isSealedSecret" => {
            out_bool(is_sealed_secret(&jv_exact(args, 0)))
        }
        "ai-provider/settings-secrets.mapAiSecrets" => {
            let mode = str_arg(args, 1).unwrap_or("wrap");
            let mut f = |v: &str| match mode {
                "empty" => String::new(),
                _ => format!("<{v}>"),
            };
            out(map_ai_secrets(&jv_exact(args, 0), &mut f))
        }
        "ai-provider/settings-secrets.sealedAiSecretsIn" => {
            let found = sealed_ai_secrets_in(&jv_exact(args, 0));
            let refs: Vec<&str> = found.iter().map(String::as_str).collect();
            out(string_list(&refs))
        }
        "ai-provider/settings-secrets.openSecretValue" => match codec_mode(args, 0) {
            Ok(codec) => out(text(open_secret_value(
                codec.as_ref().map(|c| c as &dyn AiSecretCodec),
                str_arg(args, 1).unwrap_or(""),
            ))),
            Err(e) => Err(e),
        },
        "ai-provider/settings-secrets.sealSecretValue" => match codec_mode(args, 0) {
            Ok(codec) => out(text(seal_secret_value(
                codec.as_ref().map(|c| c as &dyn AiSecretCodec),
                str_arg(args, 1).unwrap_or(""),
            ))),
            Err(e) => Err(e),
        },
        "ai-provider/settings-secrets.openAiSecrets" => match codec_mode(args, 0) {
            Ok(codec) => out(open_ai_secrets(
                codec.as_ref().map(|c| c as &dyn AiSecretCodec),
                &jv_exact(args, 1),
            )),
            Err(e) => Err(e),
        },
        "ai-provider/settings-secrets.sealAiSecrets" => match codec_mode(args, 0) {
            Ok(codec) => out(seal_ai_secrets(
                codec.as_ref().map(|c| c as &dyn AiSecretCodec),
                &jv_exact(args, 1),
            )),
            Err(e) => Err(e),
        },

        // ai-provider/run-error, overload-error, network-error, free-ai, watchdog
        "ai-provider/run-error.aiStreamErrorFields" => out(JsonValue::Object(
            ai_stream_error_fields(&jv_exact(args, 0), cx.now_ms),
        )),
        "ai-provider/overload-error.isAiOverloadedError" => {
            out_bool(is_ai_overloaded_error(&jv_exact(args, 0)))
        }
        "ai-provider/network-error.isAiNetworkError" => {
            out_bool(is_ai_network_error(&jv_exact(args, 0)))
        }
        "ai-provider/free-ai.isFreeTierModelRefusal" => {
            out_bool(is_free_tier_model_refusal(&jv_exact(args, 0)))
        }
        "ai-provider/free-ai.freeLimitOf" => {
            let limit = free_limit_of(&jv_exact(args, 0), f64_arg(args, 1));
            out_opt(limit.map(|l| match l.resets_at {
                Some(at) => object(vec![("resetsAt", number(at))]),
                None => object(Vec::new()),
            }))
        }
        "ai-provider/free-ai.nextPacificMidnight" => {
            out_num(next_pacific_midnight(f64_arg(args, 0)))
        }
        "ai-provider/watchdog.normalizeWatchdogTimeout" => out_num(normalize_watchdog_timeout(
            f64_arg(args, 0),
            f64_arg(args, 1),
        )),

        // ai-provider/registry, effort, search-settings, media, local-profile, custom-endpoints
        "ai-provider/registry.normalizeBaseUrl" => {
            match normalize_base_url(str_arg(args, 0).ok(), str_arg(args, 1).unwrap_or("")) {
                Ok(url) => out(text(url)),
                Err(message) => Err(CallError::plain(message)),
            }
        }
        "ai-provider/effort.aiEffortOf" => out_undef(ai_effort_of(jv(args, 0).as_ref()).map(text)),
        "ai-provider/effort.aiEffortsOf" => {
            out_undef(ai_efforts_of(jv(args, 0).as_ref()).map(|e| string_list(&e)))
        }
        "ai-provider/effort.aiModelEffortOf" => {
            out_undef(ai_model_effort_of(jv(args, 0).as_ref()).map(|e| e.to_json()))
        }
        "ai-provider/effort.aiModelEffortsOf" => {
            out_undef(ai_model_efforts_of(jv(args, 0).as_ref()))
        }
        "ai-provider/search-settings.defaultAiSearchSettings" => out(default_ai_search_settings()),
        "ai-provider/search-settings.resolveAiSearchSettings" => {
            out(resolve_ai_search_settings(jv(args, 0).as_ref()))
        }
        "ai-provider/media.defaultAiMediaSettings" => out(default_ai_media_settings()),
        "ai-provider/media.resolveAiMediaSettings" => {
            out(resolve_ai_media_settings(jv(args, 0).as_ref()))
        }
        "ai-provider/local-profile.localEndpointFieldsOf" => out(JsonValue::Object(
            local_endpoint_fields_of(&jv_exact(args, 0)),
        )),
        "ai-provider/custom-endpoints.resolveCustomEndpoints" => {
            match as_record(&jv_exact(args, 0)).cloned() {
                Some(settings) => out(mask_ids(JsonValue::Object(resolve_custom_endpoints(
                    &settings,
                )))),
                None => Err(CallError::plain("settings is not an object")),
            }
        }

        // docs/ai-run
        "docs/ai-run.AI_INVALID_SETTINGS_ERROR" => {
            out(text(docs_ai_run::AI_INVALID_SETTINGS_ERROR))
        }
        "docs/ai-run.resolveAiRun" => match codec_mode(args, 0) {
            Ok(codec) => match docs_ai_run::resolve_ai_run(
                &RealHost,
                codec.as_ref().map(|c| c as &dyn AiSecretCodec),
                &jv_exact(args, 1),
                &jv_exact(args, 2),
                &Texts,
            ) {
                Ok(target) => out(mask_ids(target.to_json())),
                Err(e) => Err(type_error(e)),
            },
            Err(e) => Err(e),
        },
        "docs/ai-run.subscriptionStreamCallbacks" => {
            stream_callbacks(args, cx, docs_ai_run::subscription_stream_callbacks)
        }
        "docs/ai-run.aiStreamErrorChunk" => {
            match docs_ai_run::ai_stream_error_chunk(
                str_arg(args, 0).unwrap_or(""),
                &jv_exact(args, 1),
                cx.now_ms,
            ) {
                Ok(chunk) => out(chunk),
                Err(e) => Err(type_error(e)),
            }
        }
        "docs/ai-run.aiChatFailure" => {
            let busy = str_arg(args, 1).unwrap_or("").to_owned();
            match docs_ai_run::ai_chat_failure(&jv_exact(args, 0), || busy, cx.now_ms) {
                Ok(failure) => out(failure),
                Err(e) => Err(type_error(e)),
            }
        }
        "docs/ai-run.withMeteredAccepted" => match codec_mode(args, 0) {
            Ok(codec) => out(mask_ids(docs_ai_run::with_metered_accepted(
                codec.as_ref().map(|c| c as &dyn AiSecretCodec),
                jv(args, 1).as_ref(),
                str_arg(args, 2).unwrap_or(""),
                matches!(arg(args, 3), Some(Value::Bool(true))),
            ))),
            Err(e) => Err(e),
        },
        "docs/ai-run.withSubscriptionOff" => match codec_mode(args, 0) {
            Ok(codec) => out(mask_ids(docs_ai_run::with_subscription_off(
                codec.as_ref().map(|c| c as &dyn AiSecretCodec),
                jv(args, 1).as_ref(),
                str_arg(args, 2).unwrap_or(""),
                matches!(arg(args, 3), Some(Value::Bool(true))),
            ))),
            Err(e) => Err(e),
        },

        // sheets/ai-run
        "sheets/ai-run.aiSettingsFromStored" => match codec_mode(args, 0) {
            Ok(codec) => out(mask_ids(sheets_ai_run::ai_settings_from_stored(
                codec.as_ref().map(|c| c as &dyn AiSecretCodec),
                jv(args, 1).as_ref(),
            ))),
            Err(e) => Err(e),
        },
        "sheets/ai-run.resolveAiRunTarget" => match codec_mode(args, 0) {
            Ok(codec) => out(mask_ids(
                sheets_ai_run::resolve_ai_run_target(
                    codec.as_ref().map(|c| c as &dyn AiSecretCodec),
                    jv(args, 1).as_ref(),
                    &jv_exact(args, 2),
                )
                .to_json(),
            )),
            Err(e) => Err(e),
        },
        "sheets/ai-run.aiRunBlockChunk" => {
            let block = jv_exact(args, 1);
            let block = sheets_ai_run::AiRunBlock {
                error: as_str(prop(&block, "error")).unwrap_or("").to_owned(),
                error_code: match as_str(prop(&block, "errorCode")) {
                    Some("not-connected") => Some("not-connected"),
                    Some("not-installed") => Some("not-installed"),
                    Some("signed-out") => Some("signed-out"),
                    Some("metered-not-accepted") => Some("metered-not-accepted"),
                    Some("off-in-app") => Some("off-in-app"),
                    _ => None,
                },
                error_provider: as_str(prop(&block, "errorProvider")).map(str::to_owned),
            };
            out(sheets_ai_run::ai_run_block_chunk(
                str_arg(args, 0).unwrap_or(""),
                &block,
            ))
        }
        "sheets/ai-run.aiStreamErrorChunk" => {
            match sheets_ai_run::ai_stream_error_chunk(
                str_arg(args, 0).unwrap_or(""),
                &jv_exact(args, 1),
                cx.now_ms,
            ) {
                Ok(chunk) => out(chunk),
                Err(e) => Err(type_error(e)),
            }
        }
        "sheets/ai-run.subscriptionStreamCallbacks" => {
            stream_callbacks(args, cx, sheets_ai_run::subscription_stream_callbacks)
        }
        "sheets/ai-run.withMeteredAccepted" => match codec_mode(args, 0) {
            Ok(codec) => out(mask_ids(sheets_ai_run::with_metered_accepted(
                codec.as_ref().map(|c| c as &dyn AiSecretCodec),
                jv(args, 1).as_ref(),
                str_arg(args, 2).unwrap_or(""),
                matches!(arg(args, 3), Some(Value::Bool(true))),
            ))),
            Err(e) => Err(e),
        },

        // ai-keepalive
        "ai-keepalive.AI_KEEPALIVE_INTERVAL_MS" => out_num(AI_KEEPALIVE_INTERVAL_MS),
        "ai-keepalive.startAiKeepalive" => keepalive_scenario(args, cx, false),
        "ai-keepalive.startFirstChunkKeepalive" => keepalive_scenario(args, cx, true),

        // free-ai-strings
        "free-ai-strings.FREE_AI_PAGE_STRINGS" => {
            let mut en = Obj::new();
            let mut ko = Obj::new();
            for (key, en_text, ko_text) in FREE_AI_PAGE_STRINGS {
                en.set(*key, text(*en_text));
                ko.set(*key, text(*ko_text));
            }
            out(object(vec![
                ("en", JsonValue::Object(en)),
                ("ko", JsonValue::Object(ko)),
            ]))
        }

        // ai-default-fonts and slides-ai-fonts
        "ai-default-fonts.readSlidesAiFonts" => out(read_slides_ai_fonts(
            &UserData(str_arg(args, 0).unwrap_or("").to_owned()),
            str_arg(args, 1).unwrap_or(""),
        )
        .to_json()),
        "ai-default-fonts.TITLE_ROLE_MIN_PT" => out_num(TITLE_ROLE_MIN_PT),
        "ai-default-fonts.fillMissingRunFonts" => {
            let roles = jv_exact(args, 1);
            match parse_font_roles(&roles) {
                Some(roles) => out(fill_missing_run_fonts(&jv_exact(args, 0), &roles)),
                None => Err(CallError::plain("roles are not two family names")),
            }
        }
        "ai-default-fonts.parseFontRoles" => out_opt(
            parse_font_roles(&jv_exact(args, 0))
                .map(|r| object(vec![("title", text(r.title)), ("body", text(r.body))])),
        ),
        "slides-ai-fonts.SLIDES_AI_FONTS_KEY" => out(text(SLIDES_AI_FONTS_KEY)),
        "slides-ai-fonts.defaultSlidesAiFonts" => {
            out(default_slides_ai_fonts(str_arg(args, 0).unwrap_or("")).to_json())
        }
        "slides-ai-fonts.normalizeSlidesAiFonts" => out(normalize_slides_ai_fonts(
            jv(args, 0).as_ref(),
            str_arg(args, 1).unwrap_or(""),
        )
        .to_json()),

        // ai-naming-provider, ai-naming
        "ai-naming-provider.resolveNamingProvider" => match codec_mode(args, 0) {
            Ok(codec) => out(mask_ids(
                resolve_naming_provider(
                    codec.as_ref().map(|c| c as &dyn AiSecretCodec),
                    jv(args, 1).as_ref(),
                    &jv_exact(args, 2),
                )
                .to_json(),
            )),
            Err(e) => Err(e),
        },
        "ai-naming.sanitizeFileStem" => {
            out(text(sanitize_file_stem(str_arg(args, 0).unwrap_or(""))))
        }
        "ai-naming.buildNamingInstruction" => out(text(build_naming_instruction(
            str_arg(args, 0).unwrap_or(""),
            str_arg(args, 1).unwrap_or(""),
        ))),
        "ai-naming.excerptForNaming" => out(text(excerpt_for_naming(
            str_arg(args, 0).unwrap_or(""),
            arg(args, 1).and_then(Value::as_f64),
        ))),

        // ai-secrets
        "ai-secrets.linuxKeyringSeals" => out_bool(linux_keyring_seals(&FakeStorage::from_spec(
            &jv_exact(args, 0),
        ))),
        "ai-secrets.platformSeals" => out_bool(platform_seals(
            &FakeStorage::from_spec(&jv_exact(args, 0)),
            str_arg(args, 1).unwrap_or(""),
        )),
        "ai-secrets.sealingKeyOnDisk" => {
            out_bool(sealing_key_on_disk(str_arg(args, 0).unwrap_or("")))
        }
        "ai-secrets.safeStorageCodec" => safe_storage_codec(args),
        "ai-secrets.holdsPlainSecrets" => out_bool(holds_plain_secrets(&jv_exact(args, 0))),
        "ai-secrets.sealStoredAiSettings" => match codec_mode(args, 0) {
            Ok(codec) => match seal_stored_ai_settings(
                codec.as_ref().map(|c| c as &dyn AiSecretCodec),
                str_arg(args, 1).unwrap_or(""),
            ) {
                Ok(rewrote) => out_bool(rewrote),
                Err(e) => Err(e.into()),
            },
            Err(e) => Err(e),
        },
        "ai-secrets.openFileSearchKeys" => match codec_mode(args, 0) {
            Ok(codec) => out(open_file_search_keys(
                codec.as_ref().map(|c| c as &dyn AiSecretCodec),
                &jv_exact(args, 1),
            )),
            Err(e) => Err(e),
        },
        "ai-secrets.sealFileSearchKeys" => match codec_mode(args, 0) {
            Ok(codec) => out(seal_file_search_keys(
                codec.as_ref().map(|c| c as &dyn AiSecretCodec),
                &jv_exact(args, 1),
            )),
            Err(e) => Err(e),
        },
        "ai-secrets.fileSearchHoldsPlainKeys" => {
            out_bool(file_search_holds_plain_keys(&jv_exact(args, 0)))
        }
        "ai-secrets.REVEAL_FLAG" => out(text(REVEAL_FLAG)),
        "ai-secrets.MAX_REVEAL_VALUES" => out_num(MAX_REVEAL_VALUES as f64),
        "ai-secrets.revealRequestOf" => out_opt(
            reveal_request_of(str_arg(args, 0).unwrap_or("")).map(|values| {
                let refs: Vec<&str> = values.iter().map(String::as_str).collect();
                string_list(&refs)
            }),
        ),
        "ai-secrets.revealAnswer" => match codec_mode(args, 0) {
            Ok(codec) => {
                let values = match jv(args, 1) {
                    Some(JsonValue::Array(items)) => Some(
                        items
                            .iter()
                            .filter_map(|v| as_str(Some(v)).map(str::to_owned))
                            .collect::<Vec<String>>(),
                    ),
                    _ => None,
                };
                let codec_ref: &dyn AiSecretCodec = match &codec {
                    Some(c) => c,
                    None => &NoCodec,
                };
                match reveal_answer(values.as_deref(), codec_ref) {
                    Ok(line) => out(text(line)),
                    Err(e) => Err(CallError::plain(e.0)),
                }
            }
            Err(e) => Err(e),
        },
        "ai-secrets.runRevealEntry" => match codec_mode(args, 0) {
            Ok(codec) => {
                let events = stdin_events(&jv_exact(args, 1));
                let codec_ref: &dyn AiSecretCodec = match &codec {
                    Some(c) => c,
                    None => &NoCodec,
                };
                match run_reveal_entry(codec_ref, events) {
                    Ok((line, code)) => out(object(vec![
                        ("line", text(line)),
                        ("code", number(f64::from(code))),
                    ])),
                    Err(e) => Err(CallError::plain(e.0)),
                }
            }
            Err(e) => Err(e),
        },

        // ai-run-guard
        "ai-run-guard.aiRunRefusal" => {
            let mut slot = AiRunGuardSlot::new();
            slot.set_ai_run_guard(guard_of(str_arg(args, 0).unwrap_or("none")));
            out_opt(
                slot.ai_run_refusal(&guard_input(&jv_exact(args, 1)))
                    .map(text),
            )
        }
        "ai-run-guard.setAiRunGuard" => {
            // steps: `{ set: mode }` or `{ ask: input }`; the answers of the asks
            let mut slot = AiRunGuardSlot::new();
            let mut answers: Vec<JsonValue> = Vec::new();
            if let Some(JsonValue::Array(steps)) = jv(args, 0) {
                for step in &steps {
                    if let Some(mode) = as_str(prop(step, "set")) {
                        slot.set_ai_run_guard(guard_of(mode));
                    } else if let Some(input) = prop(step, "ask") {
                        answers.push(
                            slot.ai_run_refusal(&guard_input(input))
                                .map_or(JsonValue::Null, text),
                        );
                    }
                }
            }
            out(JsonValue::Array(answers))
        }

        // drive-ai-channels
        "drive-ai-channels.DRIVE_AI_CHANNELS" => {
            let mut channels = Obj::new();
            for (key, channel) in DRIVE_AI_CHANNELS {
                channels.set(key, text(channel));
            }
            out(JsonValue::Object(channels))
        }
        "drive-ai-channels.driveConnectedOf" => out_bool(drive_connected_of(&jv_exact(args, 0))),
        "drive-ai-channels.driveAiOn" => out_bool(drive_ai_on(&jv_exact(args, 0))),

        _ => return None,
    };
    Some(answer)
}

/// "no codec registered", for the functions that take a codec as a value
struct NoCodec;

impl AiSecretCodec for NoCodec {
    fn seal(&self, _plain: &str) -> Result<Option<String>, CodecThrow> {
        Ok(None)
    }

    fn open(&self, _sealed: &str) -> Result<Option<String>, CodecThrow> {
        Ok(None)
    }
}

/// `subscriptionStreamCallbacks(requestId, send)` with `send` logging each
/// chunk; the callbacks are called once each: usage first, then the cut.
fn stream_callbacks<'a>(
    args: &[Value],
    cx: &'a mut Context,
    make: for<'s> fn(
        &str,
        &'s mut dyn FnMut(JsonValue),
    ) -> docs_ai_run::SubscriptionStreamCallbacks<'s>,
) -> Answer {
    let request_id = str_arg(args, 0).unwrap_or("").to_owned();
    let usage = jv_exact(args, 1);
    let logs = RefCell::new(Vec::new());
    {
        let mut send = |chunk: JsonValue| {
            logs.borrow_mut()
                .push(vec![Value::from("send"), json_value_to_serde(&chunk)]);
        };
        let mut callbacks = make(&request_id, &mut send);
        callbacks.on_subscription_usage(&usage);
        callbacks.on_input_truncated();
    }
    cx.logs.extend(logs.into_inner());
    Ok(None)
}

/// A keepalive driven by steps: `"stop"`, `"firstChunk"`, `"tick"` (the
/// interval fires: `send` logs `send` while the timer is active).
fn keepalive_scenario(args: &[Value], cx: &mut Context, first_chunk: bool) -> Answer {
    let interval = arg(args, 0).and_then(Value::as_f64);
    let steps: Vec<String> = match arg(args, 1) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|s| s.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    };
    let mut timer = LoggedInterval { cx, active: false };
    enum Handle {
        Plain(AiKeepalive),
        First(FirstChunkKeepalive),
    }
    let mut handle = if first_chunk {
        Handle::First(start_first_chunk_keepalive(&mut timer, interval))
    } else {
        Handle::Plain(start_ai_keepalive(&mut timer, interval))
    };
    for step in steps {
        match (step.as_str(), &mut handle) {
            ("tick", _) => {
                if timer.active {
                    timer.cx.logs.push(vec![Value::from("send")]);
                }
            }
            ("stop", Handle::Plain(h)) => h.stop(&mut timer),
            ("stop", Handle::First(h)) => h.stop(&mut timer),
            ("firstChunk", Handle::First(h)) => h.first_chunk(&mut timer),
            _ => {}
        }
    }
    Ok(None)
}

/// `safeStorageCodec(storage, platform, keyOnDisk)` driven by one operation:
/// `[storage, platform, keyOnDisk, "seal" | "open", value]`.
fn safe_storage_codec(args: &[Value]) -> Answer {
    let storage = FakeStorage::from_spec(&jv_exact(args, 0));
    let platform = str_arg(args, 1).unwrap_or("").to_owned();
    let key_on_disk = matches!(arg(args, 2), Some(Value::Bool(true)));
    let on_disk = move || key_on_disk;
    let codec = SafeStorageCodec {
        storage: &storage,
        platform: &platform,
        key_on_disk: &on_disk,
    };
    let value = str_arg(args, 4).unwrap_or("");
    let result = match str_arg(args, 3).unwrap_or("") {
        "seal" => codec.seal(value),
        _ => codec.open(value),
    };
    match result {
        Ok(v) => out(v.map_or(JsonValue::Null, text)),
        Err(e) => Err(CallError::plain(e.0)),
    }
}

/// the stdin events of a spec: `{ data: "text" }`, `{ hex: "..." }`, `"end"`,
/// `"error"`, `"timeout"`
fn stdin_events(spec: &JsonValue) -> Vec<StdinEvent> {
    let JsonValue::Array(items) = spec else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| match item {
            JsonValue::String(s) if s == "end" => Some(StdinEvent::End),
            JsonValue::String(s) if s == "error" => Some(StdinEvent::Error),
            JsonValue::String(s) if s == "timeout" => Some(StdinEvent::Timeout),
            other => {
                if let Some(t) = as_str(prop(other, "data")) {
                    Some(StdinEvent::Data(t.as_bytes().to_vec()))
                } else if let Some(JsonValue::Number(n)) = prop(other, "bytes") {
                    // a chunk of `bytes` letters `a`
                    Some(StdinEvent::Data(vec![b'a'; *n as usize]))
                } else {
                    as_str(prop(other, "hex")).map(|h| StdinEvent::Data(unhex(h)))
                }
            }
        })
        .collect()
}

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2)
        .filter_map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).ok())
        .collect()
}

/// the guard a spec names: `none` (no check), `always` (refuses every run),
/// `free` (refuses a free model or the `openrouter` provider, naming the
/// sender), `allow` (a check that lets everything go)
fn guard_of(mode: &str) -> Option<crate::packages::electron_utils::ai_run_guard::AiRunGuard> {
    match mode {
        "always" => Some(Box::new(|_: &AiRunGuardInput| Some("no".to_owned()))),
        "free" => Some(Box::new(|input: &AiRunGuardInput| {
            (input.provider == "openrouter" || input.model.ends_with(":free")).then(|| {
                format!(
                    "refused for {}",
                    jscompat::number_to_string(input.sender_id)
                )
            })
        })),
        "allow" => Some(Box::new(|_: &AiRunGuardInput| None)),
        _ => None,
    }
}

fn guard_input(input: &JsonValue) -> AiRunGuardInput {
    AiRunGuardInput {
        sender_id: match prop(input, "senderId") {
            Some(JsonValue::Number(x)) => *x,
            _ => f64::NAN,
        },
        provider: as_str(prop(input, "provider")).unwrap_or("").to_owned(),
        model: as_str(prop(input, "model")).unwrap_or("").to_owned(),
    }
}
