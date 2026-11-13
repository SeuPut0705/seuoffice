//! Part `chatgpt` of group `b5-provider` (tools/main-diff/groups/b5-provider/chatgpt.ts):
//! `packages/ai-provider/src/chatgpt/{oauth,credentials,connection,responses,status}.ts`.
//!
//! The arguments are the case's JSON; the loopback sign-in is the world's
//! `requests` and `calls`. The ID token signature is a seam
//! ([`JwtSignatureVerifier`]): the scripted verifier below answers the
//! verdicts the case carries, which the TypeScript side proves against real
//! RS256 and ES256 checks.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde, number_to_string};
use serde_json::{Value, json};

use super::super::{Answer, CallError, Context, arg};
use super::world::{Sink, call_error, drive, error_line, note};
use crate::packages::ai_provider::chatgpt_connection::{
    ChatGptConnection, ChatGptConnectionDeps, ChatGptConnectionModuleState, ChatGptSignInOptions,
};
use crate::packages::ai_provider::chatgpt_credentials::{
    CHATGPT_CONNECTION_FILE, ChatGptConnectionFileStore, ChatGptConnectionMemoryStore,
    ChatGptConnectionRecord, ChatGptConnectionStore, ChatGptSession, StoreFuture,
    chatgpt_connection_of, new_chatgpt_host_id, stored_chatgpt_connection,
};
use crate::packages::ai_provider::chatgpt_oauth::{
    ChatGptAuthorizeParams, ChatGptCallbackOptions, ChatGptCodeRequest, ChatGptExpectedToken,
    ChatGptPages, JwtSignatureVerifier, chatgpt_attempt_values, chatgpt_authorize_url,
    chatgpt_pkce_pair, chatgpt_redirect_uri, exchange_chatgpt_code, fetch_chatgpt_signing_keys,
    refresh_chatgpt_tokens, revoke_chatgpt_session, verify_chatgpt_id_token,
    wait_for_chatgpt_callback,
};
use crate::packages::ai_provider::chatgpt_responses::{
    ChatGptBridgeDeps, ResponsesInputPart, chat_chatgpt, chatgpt_failure, chatgpt_input_parts,
    chatgpt_models_of, chatgpt_request_body, list_chatgpt_models, read_chatgpt_models,
    stream_chatgpt,
};
use crate::packages::ai_provider::chatgpt_status::detect_chatgpt_connection;
use crate::packages::ai_provider::claude_code_cli::ClaudeCodeContentBlock;
use crate::packages::ai_provider::fetch::{AiFetch, AiFetchState, KeyedFetchBase};
use crate::packages::ai_provider::free_connect::FreeConnectPage;
use crate::packages::ai_provider::protocols_shared::StreamCallbacks;
use crate::packages::ai_provider::settings_secrets::{AiSecretCodec, CodecThrow};
use crate::packages::ai_provider::task::{FsAnswer, FsOp, Id, JsError, LocalBoxFuture, Rt, Signal};

fn jv(v: Option<&Value>) -> JsonValue {
    v.map_or(JsonValue::Null, json_value_from_serde)
}

fn thrown(e: JsError) -> CallError {
    call_error(&e)
}

fn str_of(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn opt_str(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_owned)
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

fn flag(v: Option<&Value>) -> bool {
    v.and_then(Value::as_bool) == Some(true)
}

/// A thrown value as the answers write it (`thrown` of the spec)
fn threw(e: &JsError) -> Value {
    let mut out = match error_line(e) {
        Value::Object(o) => o,
        other => return json!({ "threw": other }),
    };
    // the legacy numeric `code` of a DOMException is not compared
    if e.class == "DOMException" {
        out.remove("code");
    }
    if let Some(kind) = e.props.get("kind") {
        out.insert("kind".into(), json_value_to_serde(kind));
    }
    if let Some(provider) = e.props.get("provider") {
        out.insert("provider".into(), json_value_to_serde(provider));
    }
    json!({ "threw": Value::Object(out) })
}

/// Runs `body` in the case's world; its value or what it threw.
fn in_world<F>(
    args: &[Value],
    cx: &mut Context,
    body: impl FnOnce(Rt, Signal, Sink, Vec<Value>) -> F,
) -> Answer
where
    F: Future<Output = Result<Value, JsError>> + 'static,
{
    let world = arg(args, 0).cloned();
    let owned = args.to_vec();
    match drive(world.as_ref(), cx, move |rt, signal, sink| {
        body(rt, signal, sink, owned)
    })? {
        Ok(v) => Ok(Some(v)),
        Err(e) => Err(thrown(e)),
    }
}

/// `prep(run, rescue)`: the fetch module's state of a case
fn fetch_state(rescue: bool) -> AiFetch {
    let mut state = AiFetchState::default();
    state.set_rescue_fetch(rescue.then_some(crate::packages::ai_provider::task::Fetcher::Net));
    Rc::new(RefCell::new(state))
}

fn array_of(items: Vec<JsonValue>) -> Value {
    json_value_to_serde(&JsonValue::Array(items))
}

fn pages() -> ChatGptPages {
    ChatGptPages {
        done: FreeConnectPage {
            lang: "en".into(),
            title: "Connected".into(),
            body: "Go back".into(),
        },
        failed: FreeConnectPage {
            lang: "en".into(),
            title: "Not connected".into(),
            body: "Try again".into(),
        },
    }
}

/// `now: () => constant` of a case, as the callee takes it
fn clock_of(now: Option<f64>) -> Option<impl Fn() -> f64> {
    now.map(|n| move || n)
}

// ---------------------------------------------------------------------------
// the fake codec and the scripted verifier
// ---------------------------------------------------------------------------

/// `codecOf(mode)`: 'rev' seals by reversing (and cannot open a value ending
/// in `!bad`), 'throw' throws, 'null' answers null
struct FakeCodec(&'static str);

impl AiSecretCodec for FakeCodec {
    fn seal(&self, plain: &str) -> Result<Option<String>, CodecThrow> {
        match self.0 {
            "rev" => Ok(Some(format!(
                "sealed:v1:{}",
                plain.chars().rev().collect::<String>()
            ))),
            "throw" => Err(CodecThrow("seal".into())),
            _ => Ok(None),
        }
    }

    fn open(&self, sealed: &str) -> Result<Option<String>, CodecThrow> {
        match self.0 {
            "rev" => {
                if sealed.ends_with("!bad") {
                    return Ok(None);
                }
                Ok(Some(sealed.get(10..).unwrap_or("").chars().rev().collect()))
            }
            "throw" => Err(CodecThrow("open".into())),
            _ => Ok(None),
        }
    }
}

fn codec_of(mode: Option<&Value>) -> Option<Rc<dyn AiSecretCodec>> {
    match mode.and_then(Value::as_str) {
        Some("rev") => Some(Rc::new(FakeCodec("rev"))),
        Some("throw") => Some(Rc::new(FakeCodec("throw"))),
        Some("null") => Some(Rc::new(FakeCodec("null"))),
        _ => None,
    }
}

/// The verdict of each signature check, in the order the checks run: true,
/// false, or "throw" for a key that does not load.
struct ScriptedVerifier {
    verdicts: RefCell<VecDeque<Value>>,
    /// checks that ran with no verdict left
    unscripted: Cell<usize>,
}

impl ScriptedVerifier {
    fn new(verdicts: Option<&Value>) -> Rc<ScriptedVerifier> {
        Rc::new(ScriptedVerifier {
            verdicts: RefCell::new(
                verdicts
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into(),
            ),
            unscripted: Cell::new(0),
        })
    }

    /// The TypeScript made exactly the checks the case scripts; a Rust run
    /// that made fewer or more is a difference.
    fn check(&self) -> Result<(), JsError> {
        if self.unscripted.get() > 0 || !self.verdicts.borrow().is_empty() {
            return Err(JsError::error(
                "the signature checks are not the ones the case scripts",
            ));
        }
        Ok(())
    }
}

impl JwtSignatureVerifier for ScriptedVerifier {
    fn signature_valid(
        &self,
        _alg: &str,
        _data: &[u8],
        _signature: &[u8],
        _jwk: &JsonValue,
    ) -> Result<bool, JsError> {
        match self.verdicts.borrow_mut().pop_front() {
            Some(Value::Bool(ok)) => Ok(ok),
            Some(_) => Err(JsError::error("the key could not be loaded")),
            None => {
                self.unscripted.set(self.unscripted.get() + 1);
                Err(JsError::error(
                    "the case scripted no verdict for this check",
                ))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

fn session_of(v: &Value) -> ChatGptSession {
    ChatGptSession {
        access_token: str_of(v.get("accessToken")),
        refresh_token: str_of(v.get("refreshToken")),
        expires_at: num(v.get("expiresAt")).unwrap_or(0.0),
        scopes: v
            .get("scopes")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        id_token: opt_str(v.get("idToken")),
    }
}

/// a record of a case, as the TypeScript holds it
fn record_of(v: &Value) -> ChatGptConnectionRecord {
    ChatGptConnectionRecord {
        host_id: str_of(v.get("hostId")),
        client_id: opt_str(v.get("clientId")),
        callback_path: opt_str(v.get("callbackPath")),
        subject: opt_str(v.get("subject")),
        session: v.get("session").map(session_of),
    }
}

fn record_json(record: &ChatGptConnectionRecord) -> Value {
    json_value_to_serde(&record.to_json())
}

// ---------------------------------------------------------------------------
// the connection scenarios
// ---------------------------------------------------------------------------

/// the memory store, which reads or writes fail on request
struct FlakyStore {
    inner: Rc<ChatGptConnectionMemoryStore>,
    fail_read: Cell<bool>,
    fail_write: Cell<bool>,
}

impl ChatGptConnectionStore for FlakyStore {
    fn read<'a>(&'a self, rt: &'a Rt) -> StoreFuture<'a, ChatGptConnectionRecord> {
        Box::pin(async move {
            if self.fail_read.get() {
                return Err(JsError::error("disk read"));
            }
            self.inner.read(rt).await
        })
    }

    fn write<'a>(&'a self, rt: &'a Rt, record: ChatGptConnectionRecord) -> StoreFuture<'a, ()> {
        Box::pin(async move {
            if self.fail_write.get() {
                return Err(JsError::error("disk full"));
            }
            self.inner.write(rt, record).await
        })
    }
}

/// `Made`: the connection of a scenario and what the case reads of it
#[derive(Clone)]
struct Made {
    memory: Rc<ChatGptConnectionMemoryStore>,
    flaky: Rc<FlakyStore>,
    connection: ChatGptConnection,
    fx: AiFetch,
    module: Rc<RefCell<ChatGptConnectionModuleState>>,
}

/// `connectionOf(run, spec)`
fn connection_of(rt: &Rt, spec: &Value, verifier: Rc<ScriptedVerifier>) -> Made {
    let fx = fetch_state(flag(spec.get("rescue")));
    let memory = Rc::new(ChatGptConnectionMemoryStore::new(
        rt,
        spec.get("record").map(record_of),
    ));
    let flaky = Rc::new(FlakyStore {
        inner: memory.clone(),
        fail_read: Cell::new(flag(spec.get("flaky").and_then(|f| f.get("failRead")))),
        fail_write: Cell::new(flag(spec.get("flaky").and_then(|f| f.get("failWrite")))),
    });
    let now = num(spec.get("now"));
    let connection = ChatGptConnection::new(ChatGptConnectionDeps {
        store: flaky.clone(),
        agent_name: opt_str(spec.get("agentName")).unwrap_or_else(|| "SeuOffice".into()),
        fx: fx.clone(),
        fetch: KeyedFetchBase::Ai,
        now: now.map(|n| Rc::new(move || n) as Rc<dyn Fn() -> f64>),
        verifier: verifier.clone(),
    });
    Made {
        memory,
        flaky,
        connection,
        fx,
        module: Rc::new(RefCell::new(ChatGptConnectionModuleState::default())),
    }
}

/// the state of one run of the ops
struct Ops {
    rt: Rt,
    signal: Signal,
    sink: Sink,
    made: Made,
    /// `offs`: the id `onChange` answered, by the listener's name, and whether
    /// its unsubscribe function ran
    offs: RefCell<BTreeMap<String, (Id, bool)>>,
}

/// one op: its answer, or `{ threw }`
fn one(ops: Rc<Ops>, op: Value) -> LocalBoxFuture<Value> {
    Box::pin(async move {
        let rt = &ops.rt;
        let connection = &ops.made.connection;
        let has = |key: &str| op.get(key).is_some();
        if has("state") {
            return match connection.state(rt).await {
                Ok(state) => json!({ "state": json_value_to_serde(&state.to_json()) }),
                Err(e) => threw(&e),
            };
        }
        if let Some(given) = op.get("signIn") {
            let options = ChatGptSignInOptions {
                pages: pages(),
                signal: Some(ops.signal.clone()),
                timeout_ms: num(given.get("timeoutMs")),
            };
            return match connection.sign_in(rt, &options).await {
                Ok(result) => json!({ "signIn": json_value_to_serde(&result.to_json()) }),
                Err(e) => threw(&e),
            };
        }
        if has("signOut") {
            return match connection.sign_out(rt).await {
                Ok(()) => json!({ "signOut": null }),
                Err(e) => threw(&e),
            };
        }
        if let Some(given) = op.get("accessToken") {
            let mode = given.get("signal").and_then(Value::as_str);
            let result = match mode {
                Some("aborted") => {
                    let controller = rt.controller();
                    controller.abort(None);
                    connection.access_token(rt, Some(&controller)).await
                }
                Some("world") => connection.access_token(rt, Some(&ops.signal)).await,
                _ => connection.access_token(rt, None).await,
            };
            return match result {
                Ok(token) => json!({ "accessToken": token }),
                Err(e) => threw(&e),
            };
        }
        if has("dropSession") {
            return match connection.drop_session(rt).await {
                Ok(()) => json!({ "dropSession": null }),
                Err(e) => threw(&e),
            };
        }
        if let Some(name) = op.get("onChange").and_then(Value::as_str) {
            let sink = ops.sink.clone();
            let label = name.to_owned();
            let id = connection.on_change(Rc::new(move || {
                note(&sink, json!(["change", label]));
            }));
            ops.offs.borrow_mut().insert(name.to_owned(), (id, false));
            return json!({ "onChange": null });
        }
        if let Some(name) = op.get("offChange").and_then(Value::as_str) {
            let entry = ops.offs.borrow().get(name).copied();
            return match entry {
                Some((id, removed)) => {
                    connection.remove_listener(id);
                    ops.offs.borrow_mut().insert(name.to_owned(), (id, true));
                    json!({ "offChange": !removed })
                }
                None => json!({ "offChange": null }),
            };
        }
        if let Some(list) = op.get("parallel").and_then(Value::as_array) {
            let futures: Vec<LocalBoxFuture<Value>> = list
                .iter()
                .map(|inner| one(ops.clone(), inner.clone()))
                .collect();
            return json!({ "parallel": rt.join_all(futures).await });
        }
        if let Some(set) = op.get("set") {
            if let Some(fail) = set.get("failRead").and_then(Value::as_bool) {
                ops.made.flaky.fail_read.set(fail);
            }
            if let Some(fail) = set.get("failWrite").and_then(Value::as_bool) {
                ops.made.flaky.fail_write.set(fail);
            }
            return json!({ "set": null });
        }
        if let Some(mode) = op.get("current").and_then(Value::as_str) {
            let mut module = ops.made.module.borrow_mut();
            return match mode {
                "set" => {
                    module.set_chatgpt_connection(Some(connection.clone()));
                    json!({ "current": null })
                }
                "clear" => {
                    module.set_chatgpt_connection(None);
                    json!({ "current": null })
                }
                _ => json!({
                    "current": module
                        .chatgpt_connection()
                        .is_some_and(|c| c.is_same(connection))
                }),
            };
        }
        if let Some(mode) = op.get("detect").and_then(Value::as_str) {
            let detected = match mode {
                "null" => detect_chatgpt_connection(rt, None).await,
                "module" => {
                    let current = ops.made.module.borrow().chatgpt_connection();
                    detect_chatgpt_connection(rt, current.as_ref()).await
                }
                _ => detect_chatgpt_connection(rt, Some(connection)).await,
            };
            return json!({ "detect": json_value_to_serde(&detected) });
        }
        threw(&JsError::error(format!("unknown op {op}")))
    })
}

/// Runs `body` in the world like [`in_world`], and then checks that the
/// signature checks the Rust made are the ones the case scripts: the world
/// has run to idle by then, so a check left to a background task counts.
fn checked<F>(
    args: &[Value],
    cx: &mut Context,
    body: impl FnOnce(Rt, Signal, Sink, Vec<Value>, Rc<ScriptedVerifier>) -> F,
) -> Answer
where
    F: Future<Output = Result<Value, JsError>> + 'static,
{
    let verifier = ScriptedVerifier::new(args.get(1).and_then(|s| s.get("verdicts")));
    let kept = verifier.clone();
    let answer = in_world(args, cx, move |rt, signal, sink, a| {
        body(rt, signal, sink, a, verifier)
    });
    match answer {
        Ok(value) => kept.check().map(|()| value).map_err(thrown),
        Err(e) => Err(e),
    }
}

/// What the TypeScript spec does between two ops: a real file system call
/// (`settle` of the spec) lets the work an op left running (an account read
/// after a refresh) go on, as microtasks do, before the next op reads.
async fn settle(rt: &Rt) {
    for _ in 0..12 {
        let _ = rt
            .fs(FsOp::Stat {
                path: "/nonexistent-settle".into(),
            })
            .await;
    }
}

/// `scenario(run, signal, cx, spec)`
async fn scenario(
    rt: Rt,
    signal: Signal,
    sink: Sink,
    spec: Value,
    verifier: Rc<ScriptedVerifier>,
) -> Result<Value, JsError> {
    let made = connection_of(&rt, &spec, verifier);
    let ops = Rc::new(Ops {
        rt: rt.clone(),
        signal,
        sink,
        made: made.clone(),
        offs: RefCell::new(BTreeMap::new()),
    });
    let mut results = Vec::new();
    for op in spec
        .get("ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        results.push(one(ops.clone(), op).await);
        settle(&ops.rt).await;
    }
    Ok(json!({ "results": results, "record": record_json(&made.memory.current()) }))
}

// ---------------------------------------------------------------------------
// the bridge
// ---------------------------------------------------------------------------

/// `bridgeDeps(made, o)`
fn bridge_deps(made: &Made, mode: Option<&str>) -> ChatGptBridgeDeps {
    let connection = match mode.unwrap_or("conn") {
        "null" => Some(None),
        "module" => {
            made.module
                .borrow_mut()
                .set_chatgpt_connection(Some(made.connection.clone()));
            None
        }
        "absent" => None,
        _ => Some(Some(made.connection.clone())),
    };
    ChatGptBridgeDeps {
        fx: made.fx.clone(),
        fetch: KeyedFetchBase::Ai,
        connection,
        module: made.module.clone(),
    }
}

fn default_config() -> JsonValue {
    json_value_from_serde(&json!({ "apiKey": "", "model": "gpt-5" }))
}

fn default_messages() -> Vec<JsonValue> {
    vec![json_value_from_serde(
        &json!({ "role": "user", "text": "Hello" }),
    )]
}

fn default_tools() -> Vec<JsonValue> {
    vec![
        json_value_from_serde(
            &json!({ "name": "read_doc", "description": "Read", "inputSchema": { "type": "object", "properties": {} } }),
        ),
        json_value_from_serde(
            &json!({ "name": "write_doc", "description": "Write", "inputSchema": { "type": "object", "properties": {} } }),
        ),
    ]
}

fn list_of(v: Option<&Value>, default: Vec<JsonValue>) -> Vec<JsonValue> {
    match v.and_then(Value::as_array) {
        Some(items) => items.iter().map(json_value_from_serde).collect(),
        None => default,
    }
}

/// `callbacksOf(cx, o, signal)`
fn callbacks_of(sink: &Sink, activity: bool, signal: &Signal) -> StreamCallbacks {
    let log = |name: &'static str| {
        let sink = sink.clone();
        move |value: JsonValue| {
            note(&sink, json!([name, json_value_to_serde(&value)]));
        }
    };
    let truncated = {
        let sink = sink.clone();
        Rc::new(move || note(&sink, json!(["truncated"]))) as Rc<dyn Fn()>
    };
    let activity_log = activity.then(|| {
        let sink = sink.clone();
        Rc::new(move || note(&sink, json!(["activity"]))) as Rc<dyn Fn()>
    });
    StreamCallbacks {
        on_delta: Rc::new(log("delta")),
        on_tool_call: Rc::new(log("tool")),
        on_reasoning_delta: None,
        on_stop_reason: Some(Rc::new(log("stop"))),
        on_usage: Some(Rc::new(log("usage"))),
        on_subscription_usage: None,
        on_input_truncated: Some(truncated),
        on_activity: activity_log,
        session_id: None,
        signal: signal.clone(),
    }
}

/// `bridgeTs(kind)`
async fn bridge(
    rt: Rt,
    signal: Signal,
    sink: Sink,
    args: Vec<Value>,
    chat: bool,
    verifier: Rc<ScriptedVerifier>,
) -> Result<Value, JsError> {
    let spec = args.get(1).cloned().unwrap_or(Value::Null);
    let o = args.get(2).cloned().unwrap_or(Value::Null);
    let made = connection_of(&rt, &spec, verifier);
    let deps = bridge_deps(&made, o.get("connection").and_then(Value::as_str));
    let config = o
        .get("config")
        .map(json_value_from_serde)
        .unwrap_or_else(default_config);
    let system = opt_str(o.get("system")).unwrap_or_else(|| "You are helpful.".into());
    let messages = list_of(o.get("messages"), default_messages());
    let outcome = if chat {
        let user = o
            .get("messages")
            .and_then(|m| m.get(0))
            .and_then(|m| m.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("Hello")
            .to_owned();
        match chat_chatgpt(&rt, &config, &system, &user, &signal, &deps).await {
            Ok(response) => json!({ "chat": json_value_to_serde(&response.to_json()) }),
            Err(e) => threw(&e),
        }
    } else {
        let cb = callbacks_of(&sink, flag(o.get("activity")), &signal);
        let tools = list_of(o.get("tools"), default_tools());
        let max_tokens = num(o.get("maxTokens")).unwrap_or(1000.0);
        match stream_chatgpt(
            &rt, &config, &system, &messages, &tools, max_tokens, &cb, &deps,
        )
        .await
        {
            Ok(()) => json!({ "done": true }),
            Err(e) => threw(&e),
        }
    };
    Ok(json!({ "outcome": outcome, "record": record_json(&made.memory.current()) }))
}

// ---------------------------------------------------------------------------
// the stores
// ---------------------------------------------------------------------------

async fn file_store_ops(rt: Rt, o: Value) -> Result<Value, JsError> {
    let data_dir = str_of(o.get("dataDir"));
    let store = ChatGptConnectionFileStore::new(&data_dir, codec_of(o.get("codec")));
    let mut results = Vec::new();
    for op in o
        .get("ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        if op.get("read").is_some() {
            let record = store.read(&rt).await?;
            results.push(json!({ "read": record_json(&record) }));
        } else {
            let record = record_of(op.get("write").unwrap_or(&Value::Null));
            match store.write(&rt, record).await {
                Ok(()) => results.push(json!({ "write": "ok" })),
                Err(e) => {
                    let code = match e.prop("code") {
                        Some(JsonValue::String(code)) => Value::String(code.clone()),
                        _ => Value::Null,
                    };
                    results.push(json!({ "write": { "error": code } }));
                }
            }
        }
    }
    let dir = match rt
        .fs(FsOp::Readdir {
            path: data_dir.clone(),
            with_types: false,
        })
        .await
    {
        Ok(FsAnswer::Entries(entries)) => {
            let mut names: Vec<String> = entries.into_iter().map(|e| e.name).collect();
            names.sort();
            json!(names)
        }
        _ => Value::Null,
    };
    let path = jscompat::node_path::host::join(&[&data_dir, CHATGPT_CONNECTION_FILE]);
    let file = match rt.fs(FsOp::ReadFile { path }).await {
        Ok(FsAnswer::Bytes(bytes)) => Value::String(String::from_utf8_lossy(&bytes).into_owned()),
        _ => Value::Null,
    };
    Ok(json!({ "results": results, "dir": dir, "file": file }))
}

async fn memory_store_ops(rt: Rt, o: Value) -> Result<Value, JsError> {
    let store = ChatGptConnectionMemoryStore::new(&rt, o.get("initial").map(record_of));
    let mut results = Vec::new();
    for op in o
        .get("ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        if op.get("read").is_some() {
            let record = store.read(&rt).await?;
            results.push(json!({ "read": record_json(&record) }));
        } else if op.get("current").is_some() {
            results.push(json!({ "current": record_json(&store.current()) }));
        } else {
            store
                .write(&rt, record_of(op.get("write").unwrap_or(&Value::Null)))
                .await?;
            results.push(json!({ "write": "ok" }));
        }
    }
    Ok(Value::Array(results))
}

// ---------------------------------------------------------------------------
// the dispatcher
// ---------------------------------------------------------------------------

fn parts_of(v: Option<&Value>) -> Vec<ResponsesInputPart> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|p| {
                    if p.get("type").and_then(Value::as_str) == Some("input_image") {
                        ResponsesInputPart::InputImage(str_of(p.get("image_url")))
                    } else {
                        ResponsesInputPart::InputText(str_of(p.get("text")))
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn blocks_of(v: Option<&Value>) -> Vec<ClaudeCodeContentBlock> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|b| {
                    if b.get("type").and_then(Value::as_str) == Some("text") {
                        ClaudeCodeContentBlock::Text(str_of(b.get("text")))
                    } else {
                        let source = b.get("source");
                        ClaudeCodeContentBlock::Image {
                            media_type: str_of(source.and_then(|s| s.get("media_type"))),
                            data: str_of(source.and_then(|s| s.get("data"))),
                        }
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn strings_of(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().map(|s| str_of(Some(s))).collect())
        .unwrap_or_default()
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let o = |i: usize| arg(args, i).cloned().unwrap_or(Value::Null);
    Some(match name {
        // ---- oauth.ts ----
        "chatgpt/oauth.chatGptPkcePair" => in_world(args, cx, |rt, _, _, a| async move {
            if let Some(skip) = num(a.get(1).and_then(|o| o.get("skip"))) {
                rt.random_bytes(skip as usize);
            }
            let (verifier, challenge) = chatgpt_pkce_pair(&rt);
            Ok(json!({ "verifier": verifier, "challenge": challenge }))
        }),
        "chatgpt/oauth.chatGptAttemptValues" => in_world(args, cx, |rt, _, _, a| async move {
            if let Some(skip) = num(a.get(1).and_then(|o| o.get("skip"))) {
                rt.random_bytes(skip as usize);
            }
            let (state, nonce) = chatgpt_attempt_values(&rt);
            Ok(json!({ "state": state, "nonce": nonce }))
        }),
        "chatgpt/oauth.chatGptRedirectUri" => {
            let port = num(arg(args, 0)).unwrap_or(f64::NAN);
            let path = arg(args, 1).and_then(Value::as_str);
            Ok(Some(Value::String(chatgpt_redirect_uri(port, path))))
        }
        "chatgpt/oauth.chatGptAuthorizeUrl" => {
            let p = o(0);
            let params = ChatGptAuthorizeParams {
                port: num(p.get("port")).unwrap_or(f64::NAN),
                challenge: str_of(p.get("challenge")),
                state: str_of(p.get("state")),
                nonce: str_of(p.get("nonce")),
                host_id: str_of(p.get("hostId")),
                client_id: opt_str(p.get("clientId")),
                callback_path: opt_str(p.get("callbackPath")),
                agent_name: str_of(p.get("agentName")),
            };
            Ok(Some(Value::String(chatgpt_authorize_url(&params))))
        }
        "chatgpt/oauth.waitForChatGptCallback" => {
            in_world(args, cx, |rt, signal, _, a| async move {
                let opts = a.get(1).cloned().unwrap_or(Value::Null);
                let state = str_of(opts.get("state"));
                let url_state = state.clone();
                let options = ChatGptCallbackOptions {
                    authorize_url: Rc::new(move |port| {
                        format!(
                            "https://auth.example/authorize?port={}&state={url_state}",
                            number_to_string(port)
                        )
                    }),
                    state,
                    callback_path: opt_str(opts.get("callbackPath")),
                    client_id: opt_str(opts.get("clientId")),
                    pages: pages(),
                    signal: Some(signal),
                    timeout_ms: num(opts.get("timeoutMs")),
                };
                let result = wait_for_chatgpt_callback(&rt, &options).await;
                Ok(json_value_to_serde(&result.to_json()))
            })
        }
        "chatgpt/oauth.exchangeChatGptCode" => in_world(args, cx, |rt, signal, _, a| async move {
            let opts = a.get(1).cloned().unwrap_or(Value::Null);
            let fx = fetch_state(flag(opts.get("rescue")));
            let r = opts.get("request").cloned().unwrap_or(Value::Null);
            let request = ChatGptCodeRequest {
                code: str_of(r.get("code")),
                client_id: str_of(r.get("clientId")),
                verifier: str_of(r.get("verifier")),
                port: num(r.get("port")).unwrap_or(f64::NAN),
                callback_path: opt_str(r.get("callbackPath")),
            };
            let clock = clock_of(num(opts.get("now")));
            let result = exchange_chatgpt_code(
                &rt,
                &fx,
                &request,
                &KeyedFetchBase::Ai,
                Some(&signal),
                clock.as_ref().map(|c| c as &dyn Fn() -> f64),
            )
            .await;
            Ok(json_value_to_serde(&result.to_json()))
        }),
        "chatgpt/oauth.refreshChatGptTokens" => in_world(args, cx, |rt, signal, _, a| async move {
            let opts = a.get(1).cloned().unwrap_or(Value::Null);
            let fx = fetch_state(flag(opts.get("rescue")));
            let clock = clock_of(num(opts.get("now")));
            let result = refresh_chatgpt_tokens(
                &rt,
                &fx,
                &str_of(opts.get("clientId")),
                &str_of(opts.get("refreshToken")),
                &KeyedFetchBase::Ai,
                Some(&signal),
                clock.as_ref().map(|c| c as &dyn Fn() -> f64),
            )
            .await;
            Ok(json_value_to_serde(&result.to_json()))
        }),
        "chatgpt/oauth.revokeChatGptSession" => in_world(args, cx, |rt, signal, _, a| async move {
            let opts = a.get(1).cloned().unwrap_or(Value::Null);
            let fx = fetch_state(false);
            let revoked = revoke_chatgpt_session(
                &rt,
                &fx,
                &str_of(opts.get("clientId")),
                &str_of(opts.get("refreshToken")),
                &KeyedFetchBase::Ai,
                Some(&signal),
            )
            .await;
            Ok(Value::Bool(revoked))
        }),
        "chatgpt/oauth.fetchChatGptSigningKeys" => {
            in_world(args, cx, |rt, signal, _, _| async move {
                let fx = fetch_state(false);
                let keys = fetch_chatgpt_signing_keys(&rt, &fx, &KeyedFetchBase::Ai, Some(&signal))
                    .await?;
                Ok(array_of(keys))
            })
        }
        "chatgpt/oauth.verifyChatGptIdToken" => {
            let expected = o(1);
            let keys: Vec<JsonValue> = o(2)
                .as_array()
                .map(|a| a.iter().map(json_value_from_serde).collect())
                .unwrap_or_default();
            let verifier = ScriptedVerifier::new(arg(args, 4));
            let identity = verify_chatgpt_id_token(
                &str_of(arg(args, 0)),
                &ChatGptExpectedToken {
                    client_id: str_of(expected.get("clientId")),
                    nonce: opt_str(expected.get("nonce")),
                },
                &keys,
                num(arg(args, 3)).unwrap_or(f64::NAN),
                verifier.as_ref(),
            );
            match verifier.check() {
                Ok(()) => {
                    Ok(Some(identity.map_or(Value::Null, |i| {
                        json_value_to_serde(&i.to_json())
                    })))
                }
                Err(e) => Err(thrown(e)),
            }
        }

        // ---- credentials.ts ----
        "chatgpt/credentials.newChatGptHostId" => in_world(args, cx, |rt, _, _, a| async move {
            let skip = num(a.get(1).and_then(|o| o.get("skip"))).unwrap_or(0.0) as usize;
            for _ in 0..skip {
                rt.random_uuid();
            }
            Ok(Value::String(new_chatgpt_host_id(&rt)))
        }),
        "chatgpt/credentials.chatGptConnectionOf" => in_world(args, cx, |rt, _, _, a| async move {
            let codec = codec_of(a.get(2));
            let value = jv(a.get(1));
            let record = chatgpt_connection_of(&rt, codec.as_deref(), &value);
            Ok(record_json(&record))
        }),
        "chatgpt/credentials.storedChatGptConnection" => {
            in_world(args, cx, |_, _, _, a| async move {
                let codec = codec_of(a.get(2));
                let record = record_of(a.get(1).unwrap_or(&Value::Null));
                Ok(json_value_to_serde(&stored_chatgpt_connection(
                    codec.as_deref(),
                    &record,
                )))
            })
        }
        "chatgpt/credentials.createChatGptConnectionFileStore" => {
            in_world(args, cx, |rt, _, _, a| {
                file_store_ops(rt, a.get(1).cloned().unwrap_or(Value::Null))
            })
        }
        "chatgpt/credentials.createChatGptConnectionMemoryStore" => {
            in_world(args, cx, |rt, _, _, a| {
                memory_store_ops(rt, a.get(1).cloned().unwrap_or(Value::Null))
            })
        }

        // ---- connection.ts and status.ts ----
        "chatgpt/connection.createChatGptConnection"
        | "chatgpt/connection.setChatGptConnection"
        | "chatgpt/connection.chatGptConnection"
        | "chatgpt/status.detectChatGptConnection" => {
            checked(args, cx, |rt, signal, sink, a, v| {
                scenario(
                    rt,
                    signal,
                    sink,
                    a.get(1).cloned().unwrap_or(Value::Null),
                    v,
                )
            })
        }

        // ---- responses.ts ----
        "chatgpt/responses.chatGptInputParts" => {
            let parts = chatgpt_input_parts(&strings_of(arg(args, 0)), &blocks_of(arg(args, 1)));
            Ok(Some(array_of(
                parts.iter().map(ResponsesInputPart::to_json).collect(),
            )))
        }
        "chatgpt/responses.chatGptRequestBody" => Ok(Some(Value::String(chatgpt_request_body(
            &str_of(arg(args, 0)),
            &parts_of(arg(args, 1)),
        )))),
        "chatgpt/responses.chatGptModelsOf" => {
            Ok(Some(array_of(chatgpt_models_of(&jv(arg(args, 0))))))
        }
        "chatgpt/responses.readChatGptModels" => {
            in_world(args, cx, |rt, signal, _, a| async move {
                let opts = a.get(1).cloned().unwrap_or(Value::Null);
                let fx = fetch_state(false);
                let signal = (!flag(opts.get("noSignal"))).then_some(signal);
                let models = read_chatgpt_models(
                    &rt,
                    &fx,
                    &str_of(opts.get("token")),
                    &KeyedFetchBase::Ai,
                    signal.as_ref(),
                )
                .await?;
                Ok(array_of(models))
            })
        }
        "chatgpt/responses.listChatGptModels" => {
            checked(args, cx, |rt, signal, _, a, verifier| async move {
                let spec = a.get(1).cloned().unwrap_or(Value::Null);
                let opts = a.get(2).cloned().unwrap_or(Value::Null);
                let made = connection_of(&rt, &spec, verifier);
                let deps = bridge_deps(&made, opts.get("connection").and_then(Value::as_str));
                let signal = (!flag(opts.get("noSignal"))).then_some(signal);
                let answer = match list_chatgpt_models(&rt, &deps, signal.as_ref()).await {
                    Ok(models) => json!({ "models": array_of(models) }),
                    Err(e) => threw(&e),
                };
                let mut out = match answer {
                    Value::Object(m) => m,
                    _ => serde_json::Map::new(),
                };
                out.insert("record".into(), record_json(&made.memory.current()));
                Ok(Value::Object(out))
            })
        }
        "chatgpt/responses.chatGptFailure" => in_world(args, cx, |rt, _, _, a| async move {
            let spec = a.get(1).cloned().unwrap_or(Value::Null);
            let opts = a.get(2).cloned().unwrap_or(Value::Null);
            let made = connection_of(&rt, &spec, ScriptedVerifier::new(None));
            let body = opts.get("body").map(json_value_from_serde);
            let with_connection = opts.get("connection").and_then(Value::as_bool) != Some(false);
            let error = chatgpt_failure(
                &rt,
                num(opts.get("status")).unwrap_or(f64::NAN),
                body.as_ref(),
                with_connection.then_some(&made.connection),
            )
            .await;
            let mut out = match threw(&error) {
                Value::Object(m) => m,
                _ => serde_json::Map::new(),
            };
            out.insert("record".into(), record_json(&made.memory.current()));
            Ok(Value::Object(out))
        }),
        "chatgpt/responses.streamChatGpt" => checked(args, cx, |rt, signal, sink, a, v| {
            bridge(rt, signal, sink, a, false, v)
        }),
        "chatgpt/responses.chatChatGpt" => checked(args, cx, |rt, signal, sink, a, v| {
            bridge(rt, signal, sink, a, true, v)
        }),
        _ => return None,
    })
}
