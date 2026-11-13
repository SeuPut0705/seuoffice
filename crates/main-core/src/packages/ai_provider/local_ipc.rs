//! `packages/ai-provider/src/local-ipc.ts`: the three `ai:local-*` calls of
//! the local AI card, behind one entry point. The main process registers them
//! (`ipcMain.handle`, which stays TypeScript plumbing); this file owns the
//! validation of payloads that arrive from the renderer. A malformed payload
//! is an ordinary answer: discovery and inspection report `shape`, the
//! connection test reports every check skipped with `inputError: 'shape'`,
//! and no request is sent either way.
//!
//! A connection test may carry a `testId`; `ai:local-test-cancel` with the
//! same id (from the same window) aborts it in this process. The tests in
//! flight are [`LocalIpcState`] (the TypeScript's `runningTests`), which the
//! caller owns.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsMap, JsonValue, js_regex, json_stringify, trim};

use super::fetch::AiFetch;
use super::jsval::{as_record, length16, number, object, prop, text};
use super::local_models::{
    AiLocalDiscoveryErrorCode, AiLocalDiscoveryRequest, AiLocalDiscoveryResult, AiLocalFailure,
    AiLocalInspectionRequest, AiLocalInspectionResult, AiLocalServerKind, inspect_local_model,
    list_local_models,
};
use super::local_profile::{
    DEFAULT_LOCAL_TIMEOUT_MS, MAX_LOCAL_MODEL_ID_LENGTH, local_timeout_ms_of,
};
use super::local_test::{AiLocalTestOptions, AiLocalTestResult, test_local_model};
use super::protocols_openai_compatible::OpenAiCompatibleState;
use super::task::{Rt, Signal};

/// the IPC layer's string limits, repeated here so a direct caller gets the same answer
const MAX_BASE_URL_LENGTH: usize = 2048;
const MAX_API_KEY_LENGTH: usize = 8192;

/// `AiLocalTestIpcInput`: a validated connection-test payload, with the
/// budget already resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct AiLocalTestIpcInput {
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    /// `typed: true` only when the payload said so
    pub typed: bool,
    pub timeout_ms: f64,
    /// the renderer's handle for cancelling this test; absent means it
    /// cannot be cancelled by id
    pub test_id: Option<String>,
}

impl AiLocalTestIpcInput {
    /// `test` of `{ testId, ...test } = parsed`: the payload without the
    /// `testId`, as `testLocalModel` takes it.
    fn test_payload(&self) -> JsonValue {
        let mut entries = vec![("baseUrl", text(self.base_url.clone()))];
        if let Some(key) = &self.api_key {
            entries.push(("apiKey", text(key.clone())));
        }
        entries.push(("model", text(self.model.clone())));
        if self.typed {
            entries.push(("typed", JsonValue::Bool(true)));
        }
        entries.push(("timeoutMs", number(self.timeout_ms)));
        object(entries)
    }
}

/// `TEST_ID_RE`: a test id: short and plain, so it is only ever a lookup key
fn test_id_of(raw: Option<&JsonValue>) -> Option<String> {
    match raw {
        Some(JsonValue::String(id)) if js_regex!(r"^[A-Za-z0-9_-]{1,128}$").test(id) => {
            Some(id.clone())
        }
        _ => None,
    }
}

/// `baseUrlOf(raw)`: the address the user typed, with trailing slashes
/// intact (the probe normalizes them): a bounded `http(s)` URL, or `None`
/// for anything else. `localhost:11434` is not a URL and is rejected rather
/// than guessed at.
fn base_url_of(raw: Option<&JsonValue>) -> Option<String> {
    let JsonValue::String(raw) = raw? else {
        return None;
    };
    let trimmed = trim(raw);
    if trimmed.is_empty() || length16(trimmed) > MAX_BASE_URL_LENGTH {
        return None;
    }
    let url = url::Url::parse(trimmed).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    Some(trimmed.to_owned())
}

/// `apiKeyOf(raw)`: the optional key: absent and blank are both "no key",
/// anything not a string is invalid. `None` is invalid, `Some(None)` no key.
fn api_key_of(raw: &JsonValue) -> Option<Option<String>> {
    let key = match prop(raw, "apiKey") {
        None => "",
        Some(JsonValue::String(value)) => trim(value),
        Some(_) => return None,
    };
    if length16(key) > MAX_API_KEY_LENGTH {
        return None;
    }
    Some((!key.is_empty()).then(|| key.to_owned()))
}

/// `modelIdOf(raw)`: the exact string the server listed, trimmed and bounded
fn model_id_of(raw: Option<&JsonValue>) -> Option<String> {
    let JsonValue::String(raw) = raw? else {
        return None;
    };
    let model = trim(raw);
    if model.is_empty() || length16(model) > MAX_LOCAL_MODEL_ID_LENGTH {
        return None;
    }
    Some(model.to_owned())
}

/// `baseFieldsOf(raw)`: the address and key every local call shares, or
/// `None` when either is bad.
fn base_fields_of(raw: &JsonValue) -> Option<(String, Option<String>)> {
    let base_url = base_url_of(prop(raw, "baseUrl"))?;
    let api_key = api_key_of(raw)?;
    Some((base_url, api_key))
}

/// `parseLocalDiscoveryInput(raw)`: a validated `{ baseUrl, apiKey? }`, or
/// `None` when the payload is not one.
pub fn parse_local_discovery_input(raw: &JsonValue) -> Option<AiLocalDiscoveryRequest> {
    as_record(raw)?;
    let (base_url, api_key) = base_fields_of(raw)?;
    Some(AiLocalDiscoveryRequest { base_url, api_key })
}

/// `parseLocalInspectionInput(raw)`: a validated `{ baseUrl, apiKey?, model,
/// server? }`, or `None`.
pub fn parse_local_inspection_input(raw: &JsonValue) -> Option<AiLocalInspectionRequest> {
    as_record(raw)?;
    let (base_url, api_key) = base_fields_of(raw)?;
    let model = model_id_of(prop(raw, "model"))?;
    // an explicit but unknown kind is invalid; an absent one means "probe once"
    let server = prop(raw, "server");
    if server.is_some() && AiLocalServerKind::of(server).is_none() {
        return None;
    }
    Some(AiLocalInspectionRequest {
        base_url,
        api_key,
        model,
        server: AiLocalServerKind::of(server),
    })
}

/// `parseLocalTestInput(raw)`: a validated `{ baseUrl, apiKey?, model,
/// timeoutMs }`, or `None`. The timeout is a whole number of milliseconds
/// inside 60s-600s; absent takes the default 300s. It is not clamped.
pub fn parse_local_test_input(raw: &JsonValue) -> Option<AiLocalTestIpcInput> {
    as_record(raw)?;
    let (base_url, api_key) = base_fields_of(raw)?;
    let model = model_id_of(prop(raw, "model"))?;
    let typed = prop(raw, "typed");
    if typed.is_some() && !matches!(typed, Some(JsonValue::Bool(_))) {
        return None;
    }
    let timeout_ms = match prop(raw, "timeoutMs") {
        None => DEFAULT_LOCAL_TIMEOUT_MS,
        given => local_timeout_ms_of(given)?,
    };
    let raw_test_id = prop(raw, "testId");
    if raw_test_id.is_some() && test_id_of(raw_test_id).is_none() {
        return None;
    }
    Some(AiLocalTestIpcInput {
        base_url,
        api_key,
        model,
        typed: typed == Some(&JsonValue::Bool(true)),
        timeout_ms,
        test_id: test_id_of(raw_test_id),
    })
}

/// `listLocalModelsForIpc(input)`: `ai:local-models` behind an `unknown` IPC
/// payload.
pub async fn list_local_models_for_ipc(
    rt: &Rt,
    fx: &AiFetch,
    input: &JsonValue,
) -> AiLocalDiscoveryResult {
    let Some(parsed) = parse_local_discovery_input(input) else {
        return AiLocalDiscoveryResult::Failed(AiLocalFailure {
            error_code: AiLocalDiscoveryErrorCode::Shape,
            status: None,
        });
    };
    list_local_models(rt, fx, &parsed, None).await
}

/// `inspectLocalModelForIpc(input)`: `ai:local-inspect` behind an `unknown`
/// IPC payload.
pub async fn inspect_local_model_for_ipc(
    rt: &Rt,
    fx: &AiFetch,
    input: &JsonValue,
) -> AiLocalInspectionResult {
    let Some(parsed) = parse_local_inspection_input(input) else {
        return AiLocalInspectionResult::Failed(AiLocalFailure {
            error_code: AiLocalDiscoveryErrorCode::Shape,
            status: None,
        });
    };
    inspect_local_model(rt, fx, &parsed).await
}

/// `AiLocalTestOwner`: who started a test (the sender's id), a string or a
/// number: one window cannot cancel another's test.
pub type AiLocalTestOwner = JsonValue;

/// `AiLocalTestIpcOptions`
#[derive(Clone, Default)]
pub struct AiLocalTestIpcOptions {
    /// the sender; tests are cancelled by owner and id together
    pub owner: Option<AiLocalTestOwner>,
    /// aborted by the main process itself (the window that asked was closed)
    pub signal: Option<Signal>,
}

/// The module state of `local-ipc.ts`: the tests in flight in this process,
/// by owner and test id (`runningTests`).
#[derive(Default)]
pub struct LocalIpcState {
    running_tests: JsMap<Signal>,
}

/// `testKeyOf(owner, testId)`
fn test_key_of(owner: Option<&AiLocalTestOwner>, test_id: &str) -> String {
    json_stringify(&JsonValue::Array(vec![
        owner.cloned().unwrap_or(JsonValue::Null),
        text(test_id),
    ]))
}

/// `testLocalModelForIpc(input, options)`: `ai:local-test` behind an
/// `unknown` IPC payload.
pub async fn test_local_model_for_ipc(
    rt: &Rt,
    fx: &AiFetch,
    openai: &Rc<RefCell<OpenAiCompatibleState>>,
    ipc: &Rc<RefCell<LocalIpcState>>,
    input: &JsonValue,
    options: Option<&AiLocalTestIpcOptions>,
) -> AiLocalTestResult {
    let Some(parsed) = parse_local_test_input(input) else {
        return AiLocalTestResult::skipped(rt);
    };
    let controller = rt.controller();
    let outer = options.and_then(|o| o.signal.clone());
    let on_outer_abort = match &outer {
        Some(outer) if outer.aborted() => {
            controller.abort(None);
            None
        }
        Some(outer) => {
            let controller = controller.clone();
            Some(outer.on_abort(move |_| controller.abort(None)))
        }
        None => None,
    };
    let key = parsed
        .test_id
        .as_deref()
        .map(|id| test_key_of(options.and_then(|o| o.owner.as_ref()), id));
    if let Some(key) = &key {
        // the same id again replaces the earlier test, which then has no handle left
        let earlier = ipc.borrow().running_tests.get(key).cloned();
        if let Some(earlier) = earlier {
            earlier.abort(None);
        }
        ipc.borrow_mut()
            .running_tests
            .set(key.clone(), controller.clone());
    }
    let result = test_local_model(
        rt,
        fx,
        openai,
        &parsed.test_payload(),
        Some(&AiLocalTestOptions {
            signal: Some(controller.clone()),
        }),
    )
    .await;
    if let (Some(outer), Some(listener)) = (&outer, on_outer_abort) {
        outer.off(listener);
    }
    if let Some(key) = &key {
        let mine = ipc
            .borrow()
            .running_tests
            .get(key)
            .is_some_and(|running| running.id() == controller.id());
        if mine {
            ipc.borrow_mut().running_tests.delete(key);
        }
    }
    result
}

/// `cancelLocalTestForIpc(input, owner)`: `ai:local-test-cancel`: abort the
/// test this owner started with this id. True when a running test was found;
/// an unknown, finished or malformed id is false and does nothing.
pub fn cancel_local_test_for_ipc(
    ipc: &Rc<RefCell<LocalIpcState>>,
    input: &JsonValue,
    owner: Option<&AiLocalTestOwner>,
) -> bool {
    let raw = match as_record(input) {
        Some(record) => record.get("testId"),
        None => Some(input),
    };
    let Some(test_id) = test_id_of(raw) else {
        return false;
    };
    let key = test_key_of(owner, &test_id);
    let controller = ipc.borrow_mut().running_tests.delete(&key);
    let Some(controller) = controller else {
        return false;
    };
    controller.abort(None);
    true
}
