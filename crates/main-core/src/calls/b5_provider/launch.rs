//! Part `launch` of group `b5-provider` (tools/main-diff/groups/b5-provider/launch.ts):
//! `packages/ai-provider/src/subscription/{launch,status,service,ipc}.ts`.
//! The names are `subscription/<file>.<export>`; the arguments are described
//! at the head of the TypeScript spec.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg};
use super::world::{Sink, call_error, drive, note};
use crate::packages::ai_provider::chatgpt_connection::{
    ChatGptConnection, ChatGptConnectionDeps, ChatGptConnectionModuleState,
};
use crate::packages::ai_provider::chatgpt_credentials::ChatGptConnectionMemoryStore;
use crate::packages::ai_provider::chatgpt_oauth::JwtSignatureVerifier;
use crate::packages::ai_provider::fetch::{AiFetchState, KeyedFetchBase};
use crate::packages::ai_provider::image_backend::ImageBackendState;
use crate::packages::ai_provider::jsval::Obj;
use crate::packages::ai_provider::subscription_contract::SUBSCRIPTION_IPC_CHANNELS;
use crate::packages::ai_provider::subscription_ipc::{
    Broadcast, HIDDEN_LOGIN_TIMEOUT_MS, LaunchLogin, SubscriptionIpc, SubscriptionIpcDeps,
    SubscriptionIpcSetup, SubscriptionIpcShared, create_subscription_ipc_deps,
    ensure_subscription_ipc, register_subscription_ipc, reset_shared_subscription_ipc,
    shared_subscription_statuses,
};
use crate::packages::ai_provider::subscription_launch::{
    LaunchState, LoginChangeListener, OffChangeListener, SUBSCRIPTION_CODEX_UPDATE_COMMAND_NPM,
    SUBSCRIPTION_CODEX_UPDATE_COMMAND_WINGET, SUBSCRIPTION_LOGIN_ARGS_ENV,
    SUBSCRIPTION_LOGIN_CLOSING_ENV, SUBSCRIPTION_LOGIN_EXE_ENV, SUBSCRIPTION_LOGIN_GUIDE_ENV,
    SUBSCRIPTION_LOGIN_TITLE_ENV, SUBSCRIPTION_LOGOUT_TIMEOUT_MS, SUBSCRIPTION_UPDATE_ARGS_ENV,
    SUBSCRIPTION_UPDATE_EXE_ENV, SubscriptionInstallOptions, SubscriptionLaunchResult,
    SubscriptionLaunchState, SubscriptionLoginOptions, SubscriptionLoginWindowText,
    SubscriptionLogoutOptions, SubscriptionOffChange, SubscriptionUpdateOptions,
    SubscriptionUpdatePlan, launch_subscription_install, launch_subscription_login,
    launch_subscription_logout, launch_subscription_update, notify_subscription_login_change,
    notify_subscription_off_change, on_subscription_login_change, on_subscription_off_change,
    subscription_install_command_line, subscription_update_command_line, subscription_update_plan,
};
use crate::packages::ai_provider::subscription_locate::{
    LocateState, SubscriptionLocateOptions, SubscriptionLocateState, SubscriptionLocator,
    SubscriptionProgram,
};
use crate::packages::ai_provider::subscription_metered::MeteredAcceptanceStore;
use crate::packages::ai_provider::subscription_models::{
    SubscriptionModelListOptions, SubscriptionModelLister, SubscriptionModelsState,
};
use crate::packages::ai_provider::subscription_process::{RegistryChoice, SharedChildRegistry};
use crate::packages::ai_provider::subscription_service::{
    SettingWriter, StatusListener, SubscriptionStatusService, SubscriptionStatusServiceDeps,
    create_subscription_status_service,
};
use crate::packages::ai_provider::subscription_status::{
    CodexAccountOption, CodexAccountSource, Fut, SUBSCRIPTION_LOGIN_KINDS,
    SUBSCRIPTION_STATUS_TIMEOUT_MS, StatusState, SubscriptionDetectAllOptions,
    SubscriptionDetectOptions, SubscriptionDetection, SubscriptionDetector, SubscriptionLogin,
    SubscriptionStatusState, codex_account_info, detect_subscription_login,
    detect_subscription_logins, parse_claude_auth_status, parse_codex_login_status,
    set_codex_account_source, start_now, subscription_login_kind, tick,
};
use crate::packages::ai_provider::task::{Child, JsError, LocalBoxFuture, Rt, Signal, Wait};

// ---------------------------------------------------------------------------
// reading the arguments
// ---------------------------------------------------------------------------

fn jnum(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn thrown(e: JsError) -> CallError {
    call_error(&e)
}

fn field<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    v.and_then(|v| v.get(key))
}

fn text_of(v: Option<&Value>, key: &str) -> Option<String> {
    field(v, key).and_then(Value::as_str).map(str::to_owned)
}

fn number_of(v: Option<&Value>, key: &str) -> Option<f64> {
    field(v, key).and_then(Value::as_f64)
}

fn flag(v: Option<&Value>, key: &str) -> bool {
    field(v, key).and_then(Value::as_bool) == Some(true)
}

/// A record of strings as its pairs, in the order written
fn pairs_of(v: Option<&Value>) -> Option<Vec<(String, String)>> {
    v.and_then(Value::as_object).map(|o| {
        o.iter()
            .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
            .collect()
    })
}

fn string_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn json_of(v: Option<&Value>) -> JsonValue {
    v.map_or(JsonValue::Null, json_value_from_serde)
}

/// `progOf(spec)`
fn program_of(p: &Value) -> SubscriptionProgram {
    let command = text_of(Some(p), "command").unwrap_or_default();
    SubscriptionProgram {
        provider: text_of(Some(p), "provider").unwrap_or_default(),
        prefix_args: string_list(p.get("prefixArgs")),
        env: pairs_of(p.get("env")).unwrap_or_default(),
        entry: text_of(Some(p), "entry").unwrap_or_else(|| command.clone()),
        source: text_of(Some(p), "source").unwrap_or_else(|| "path".to_owned()),
        command,
    }
}

/// What a `LocateSpec` answers
fn locate_answer(spec: &Value) -> Result<Option<SubscriptionProgram>, JsError> {
    if let Some(message) = spec.get("reject").and_then(Value::as_str) {
        let mut error = JsError::error(message);
        if let Some(code) = spec.get("code").and_then(Value::as_str) {
            error = error.with("code", JsonValue::String(code.to_owned()));
        }
        return Err(error);
    }
    Ok(spec.get("program").filter(|p| !p.is_null()).map(program_of))
}

/// `locatorOf(spec, cx)`
fn locator_of(spec: Option<&Value>, sink: &Sink) -> Option<SubscriptionLocator> {
    let spec = spec?.clone();
    let sink = sink.clone();
    Some(Rc::new(
        move |_rt: Rt, provider: String, options: SubscriptionLocateOptions| {
            note(&sink, json!(["locate", provider, options.configured_path]));
            let answer = locate_answer(&spec);
            Box::pin(async move { answer })
        },
    ))
}

/// `locatorBy(map, cx)`
fn locator_by(map: Option<&Value>, sink: &Sink) -> Option<SubscriptionLocator> {
    let map = map?.clone();
    let sink = sink.clone();
    Some(Rc::new(
        move |_rt: Rt, provider: String, options: SubscriptionLocateOptions| {
            note(&sink, json!(["locate", provider, options.configured_path]));
            let answer = match map.get(&provider) {
                Some(spec) => locate_answer(spec),
                None => Ok(None),
            };
            Box::pin(async move { answer })
        },
    ))
}

fn window_text_of(v: Option<&Value>) -> Option<SubscriptionLoginWindowText> {
    let v = v?.as_object()?;
    Some(SubscriptionLoginWindowText {
        title: v.get("title").and_then(Value::as_str).map(str::to_owned),
        guide: v.get("guide").and_then(Value::as_str).map(str::to_owned),
        closing: v.get("closing").and_then(Value::as_str).map(str::to_owned),
    })
}

/// The module state the cases start from, one per call
struct States {
    launch: LaunchState,
    status: StatusState,
}

fn states(rt_now: f64) -> States {
    let shared = SharedChildRegistry::new(rt_now);
    let locate: LocateState = Rc::new(RefCell::new(SubscriptionLocateState::new(shared.clone())));
    let chat = Rc::new(RefCell::new(ChatGptConnectionModuleState::default()));
    States {
        launch: Rc::new(RefCell::new(SubscriptionLaunchState::new(
            locate.clone(),
            shared.clone(),
        ))),
        status: Rc::new(RefCell::new(SubscriptionStatusState::new(
            locate, shared, chat,
        ))),
    }
}

/// Runs `body` in the case's world; its value or what it threw.
fn in_world<F>(args: &[Value], cx: &mut Context, body: impl FnOnce(Rt, Sink, Value) -> F) -> Answer
where
    F: Future<Output = Result<Value, JsError>> + 'static,
{
    let world = arg(args, 0).cloned();
    let o = arg(args, 1).cloned().unwrap_or(Value::Null);
    match drive(world.as_ref(), cx, move |rt, _signal, sink| {
        body(rt, sink, o)
    })? {
        Ok(v) => Ok(Some(v)),
        Err(e) => Err(thrown(e)),
    }
}

fn answer(v: Value) -> Answer {
    Ok(Some(v))
}

// ---------------------------------------------------------------------------
// launch.ts, the pure part
// ---------------------------------------------------------------------------

/// A sink that is not the world's: the pure functions log through it
fn flush(sink: &Sink, cx: &mut Context) {
    cx.logs.extend(sink.borrow_mut().drain(..));
}

fn listeners(kind: &str, args: &[Value], cx: &mut Context) -> Answer {
    let sink: Sink = Rc::new(RefCell::new(Vec::new()));
    let shared = SharedChildRegistry::new(0.0);
    let locate: LocateState = Rc::new(RefCell::new(SubscriptionLocateState::new(shared.clone())));
    let state: LaunchState = Rc::new(RefCell::new(SubscriptionLaunchState::new(locate, shared)));
    let login = kind == "login";
    let mut login_fns: Vec<(String, LoginChangeListener)> = Vec::new();
    let mut off_fns: Vec<(String, OffChangeListener)> = Vec::new();
    let mut removers: Vec<(String, Rc<dyn Fn()>)> = Vec::new();
    let ops = arg(args, 0)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for op in &ops {
        let what = op.get(0).and_then(Value::as_str).unwrap_or("");
        let a = op.get(1).and_then(Value::as_str).unwrap_or("").to_owned();
        let b = op.get(2);
        match what {
            "on" => {
                let throws = b.and_then(Value::as_str) == Some("throws");
                let remove = if login {
                    let known = login_fns
                        .iter()
                        .find(|(n, _)| *n == a)
                        .map(|(_, f)| f.clone());
                    let listener = known.unwrap_or_else(|| {
                        let (sink, name) = (sink.clone(), a.clone());
                        let listener: LoginChangeListener = Rc::new(move |provider| {
                            note(&sink, json!(["login", name, provider]));
                            if throws {
                                return Err(JsError::error("listener"));
                            }
                            Ok(())
                        });
                        login_fns.push((a.clone(), listener.clone()));
                        listener
                    });
                    on_subscription_login_change(&state, listener)
                } else {
                    let known = off_fns
                        .iter()
                        .find(|(n, _)| *n == a)
                        .map(|(_, f)| f.clone());
                    let listener = known.unwrap_or_else(|| {
                        let (sink, name) = (sink.clone(), a.clone());
                        let listener: OffChangeListener = Rc::new(move |change| {
                            note(
                                &sink,
                                json!(["off", name, { "provider": change.provider, "off": change.off }]),
                            );
                            if throws {
                                return Err(JsError::error("listener"));
                            }
                            Ok(())
                        });
                        off_fns.push((a.clone(), listener.clone()));
                        listener
                    });
                    on_subscription_off_change(&state, listener)
                };
                match removers.iter_mut().find(|(n, _)| *n == a) {
                    Some(slot) => slot.1 = remove,
                    None => removers.push((a.clone(), remove)),
                }
            }
            "off" => {
                if let Some((_, remove)) = removers.iter().find(|(n, _)| *n == a) {
                    remove();
                }
            }
            "notify" => notify_subscription_login_change(&state, &a),
            _ => notify_subscription_off_change(
                &state,
                &SubscriptionOffChange {
                    provider: a,
                    off: b.and_then(Value::as_bool) == Some(true),
                },
            ),
        }
    }
    for (_, remove) in &removers {
        remove();
    }
    flush(&sink, cx);
    answer(Value::Null)
}

fn env_getter(env: Option<&Value>) -> impl Fn(&str) -> Option<String> + '_ {
    move |key| {
        env.and_then(|e| e.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }
}

fn plan_of(v: Option<&Value>) -> SubscriptionUpdatePlan {
    if text_of(v, "kind").as_deref() == Some("program") {
        SubscriptionUpdatePlan::Program {
            args: string_list(field(v, "args")),
        }
    } else {
        SubscriptionUpdatePlan::Command {
            command: text_of(v, "command").unwrap_or_default(),
        }
    }
}

fn plan_json(plan: Option<SubscriptionUpdatePlan>) -> Value {
    match plan {
        None => Value::Null,
        Some(SubscriptionUpdatePlan::Program { args }) => {
            json!({ "kind": "program", "args": args })
        }
        Some(SubscriptionUpdatePlan::Command { command }) => {
            json!({ "kind": "command", "command": command })
        }
    }
}

// ---------------------------------------------------------------------------
// launch.ts, the launchers
// ---------------------------------------------------------------------------

fn login_listener(sink: &Sink) -> LoginChangeListener {
    let sink = sink.clone();
    Rc::new(move |provider| {
        note(&sink, json!(["login-change", provider]));
        Ok(())
    })
}

fn launch_login(args: &[Value], cx: &mut Context) -> Answer {
    in_world(args, cx, |rt, sink, o| async move {
        let st = states(rt.now());
        if flag(Some(&o), "listen") {
            on_subscription_login_change(&st.launch, login_listener(&sink));
        }
        let started = text_of(Some(&o), "started");
        let options = SubscriptionLoginOptions {
            configured_path: text_of(Some(&o), "configuredPath"),
            window: text_of(Some(&o), "window"),
            window_text: window_text_of(o.get("windowText")),
            platform: text_of(Some(&o), "platform"),
            base_env: pairs_of(o.get("baseEnv")),
            registry: if text_of(Some(&o), "registry").as_deref() == Some("none") {
                RegistryChoice::None
            } else {
                RegistryChoice::Shared
            },
            on_started: started.map(|mode| {
                let sink = sink.clone();
                Rc::new(move |stop: Rc<dyn Fn()>| {
                    note(&sink, json!(["started"]));
                    if mode == "stop" {
                        stop();
                    }
                }) as Rc<dyn Fn(Rc<dyn Fn()>)>
            }),
            on_exit: flag(Some(&o), "exit").then(|| {
                let sink = sink.clone();
                Rc::new(move || note(&sink, json!(["exit"]))) as Rc<dyn Fn()>
            }),
            kill_tree: flag(Some(&o), "killTree").then(|| {
                let sink = sink.clone();
                Rc::new(move |child: &Child| {
                    note(&sink, json!(["killtree", child.pid().map(jnum)]));
                }) as Rc<dyn Fn(&Child)>
            }),
            locate: locator_of(o.get("locate"), &sink),
        };
        let provider = text_of(Some(&o), "provider").unwrap_or_default();
        let result = launch_subscription_login(&rt, &st.launch, &provider, &options).await;
        Ok(json_value_to_serde(&result.to_json()))
    })
}

fn launch_logout(args: &[Value], cx: &mut Context) -> Answer {
    in_world(args, cx, |rt, sink, o| async move {
        let st = states(rt.now());
        if flag(Some(&o), "listen") {
            on_subscription_login_change(&st.launch, login_listener(&sink));
        }
        let options = SubscriptionLogoutOptions {
            configured_path: text_of(Some(&o), "configuredPath"),
            timeout_ms: number_of(Some(&o), "timeoutMs"),
            base_env: pairs_of(o.get("baseEnv")),
            locate: locator_of(o.get("locate"), &sink),
            run: None,
        };
        let provider = text_of(Some(&o), "provider").unwrap_or_default();
        let result = launch_subscription_logout(&rt, &st.launch, &provider, &options).await;
        Ok(json_value_to_serde(&result.to_json()))
    })
}

fn launch_install(args: &[Value], cx: &mut Context) -> Answer {
    in_world(args, cx, |rt, _sink, o| async move {
        let provider = text_of(Some(&o), "provider").unwrap_or_default();
        let result = launch_subscription_install(
            &rt,
            &provider,
            &SubscriptionInstallOptions {
                platform: text_of(Some(&o), "platform"),
                env: pairs_of(o.get("env")),
            },
        )
        .await;
        Ok(json_value_to_serde(&result.to_json()))
    })
}

fn launch_update(args: &[Value], cx: &mut Context) -> Answer {
    in_world(args, cx, |rt, sink, o| async move {
        let st = states(rt.now());
        let provider = text_of(Some(&o), "provider").unwrap_or_default();
        let result = launch_subscription_update(
            &rt,
            &st.launch,
            &provider,
            &SubscriptionUpdateOptions {
                install: SubscriptionInstallOptions {
                    platform: text_of(Some(&o), "platform"),
                    env: pairs_of(o.get("env")),
                },
                configured_path: text_of(Some(&o), "configuredPath"),
                locate: locator_of(o.get("locate"), &sink),
            },
        )
        .await;
        Ok(json_value_to_serde(&result.to_json()))
    })
}

// ---------------------------------------------------------------------------
// status.ts
// ---------------------------------------------------------------------------

fn login_json(login: Option<SubscriptionLogin>) -> Value {
    match login {
        None => Value::Null,
        Some(SubscriptionLogin::SignedOut) => json!({ "signedIn": false }),
        Some(SubscriptionLogin::SignedIn {
            login_method,
            plan_name,
            login_kind,
            account,
        }) => {
            let mut out = Map::new();
            out.insert("signedIn".into(), Value::Bool(true));
            out.insert("loginMethod".into(), Value::String(login_method));
            if let Some(plan) = plan_name {
                out.insert("planName".into(), Value::String(plan));
            }
            out.insert("loginKind".into(), Value::String(login_kind));
            if let Some(account) = account {
                out.insert("account".into(), Value::String(account));
            }
            Value::Object(out)
        }
    }
}

fn account_source(spec: &Value, sink: &Sink) -> CodexAccountSource {
    let (spec, sink) = (spec.clone(), sink.clone());
    Rc::new(
        move |_rt: Rt, configured: Option<String>, _signal: Signal| {
            note(&sink, json!(["account", configured]));
            let outcome = match spec.get("reject").and_then(Value::as_str) {
                Some(message) => Err(JsError::error(message)),
                None => Ok(json_of(spec.get("value"))),
            };
            Box::pin(async move { outcome })
        },
    )
}

fn detect_options(o: &Value, sink: &Sink) -> SubscriptionDetectOptions {
    let locate = if o.get("locateBy").is_some() {
        locator_by(o.get("locateBy"), sink)
    } else {
        locator_of(o.get("locate"), sink)
    };
    let codex_account = match o.get("account") {
        None => CodexAccountOption::Registered,
        Some(Value::String(s)) if s == "off" => CodexAccountOption::Off,
        Some(spec) => CodexAccountOption::Source(account_source(spec, sink)),
    };
    SubscriptionDetectOptions {
        configured_path: text_of(Some(o), "configuredPath"),
        timeout_ms: number_of(Some(o), "timeoutMs"),
        locate,
        run: None,
        codex_account,
    }
}

/// `detecting(call)`: the module state of the case, the registered Codex
/// account source
fn detecting<F>(
    args: &[Value],
    cx: &mut Context,
    call: impl FnOnce(Rt, Sink, Value, StatusState) -> F,
) -> Answer
where
    F: Future<Output = Result<Value, JsError>> + 'static,
{
    in_world(args, cx, |rt, sink, o| {
        let st = states(rt.now());
        if let Some(registered) = o.get("registered") {
            set_codex_account_source(&st.status, Some(account_source(registered, &sink)));
        }
        call(rt, sink, o, st.status)
    })
}

// ---------------------------------------------------------------------------
// service.ts and ipc.ts: the stand-ins a scenario builds
// ---------------------------------------------------------------------------

/// The stand-ins of the status service, each logging its call
struct Bench {
    opts: Value,
    settings: RefCell<Value>,
    record: RefCell<Value>,
    gets: Cell<usize>,
    detect_at: RefCell<BTreeMap<String, usize>>,
    models_at: RefCell<BTreeMap<String, usize>>,
    sink: Sink,
}

fn fail(msg: &str) -> JsError {
    JsError::error(msg)
}

impl Bench {
    fn new(opts: &Value, sink: &Sink) -> Rc<Bench> {
        Rc::new(Bench {
            opts: opts.clone(),
            settings: RefCell::new(opts.get("settings").cloned().unwrap_or_else(|| json!({}))),
            record: RefCell::new(opts.get("record").cloned().unwrap_or_else(|| json!({}))),
            gets: Cell::new(0),
            detect_at: RefCell::new(BTreeMap::new()),
            models_at: RefCell::new(BTreeMap::new()),
            sink: sink.clone(),
        })
    }

    fn flag(&self, key: &str) -> bool {
        flag(Some(&self.opts), key)
    }

    fn get_settings(&self) -> Result<JsonValue, JsError> {
        self.gets.set(self.gets.get() + 1);
        if !self.flag("quiet") {
            note(&self.sink, json!(["getSettings"]));
        }
        let failing = self
            .opts
            .get("failGet")
            .and_then(Value::as_array)
            .is_some_and(|l| l.iter().any(|n| n.as_u64() == Some(self.gets.get() as u64)));
        if failing {
            return Err(fail("settings"));
        }
        Ok(json_value_from_serde(&self.settings.borrow()))
    }

    /// `settings[group] = { ...settings[group], [key]: value }`
    fn set_nested(&self, group: &str, key: &str, value: Value) {
        let mut settings = self.settings.borrow_mut();
        let mut inner = settings
            .get(group)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        inner.insert(key.to_owned(), value);
        if let Some(map) = settings.as_object_mut() {
            map.insert(group.to_owned(), Value::Object(inner));
        }
    }

    fn set_metered(&self, provider: &str, accepted: bool) -> Result<(), JsError> {
        note(&self.sink, json!(["setMetered", provider, accepted]));
        if self.flag("failSet") {
            return Err(fail("write settings"));
        }
        self.set_nested("meteredAccepted", provider, Value::Bool(accepted));
        Ok(())
    }

    fn set_off(&self, provider: &str, off: bool) -> Result<(), JsError> {
        note(&self.sink, json!(["setOff", provider, off]));
        if self.flag("failOff") {
            return Err(fail("write off"));
        }
        self.set_nested("subscriptionOff", provider, Value::Bool(off));
        Ok(())
    }

    /// `sequence(list, index, key)`
    fn sequence(&self, kind: &str, provider: &str) -> Option<Value> {
        let counters = if kind == "detect" {
            &self.detect_at
        } else {
            &self.models_at
        };
        let at = {
            let mut counters = counters.borrow_mut();
            let slot = counters.entry(provider.to_owned()).or_insert(0);
            let at = *slot;
            *slot += 1;
            at
        };
        let list = self.opts.get(kind)?.get(provider)?.as_array()?;
        if list.is_empty() {
            return None;
        }
        Some(list[at.min(list.len() - 1)].clone())
    }

    fn detect(
        &self,
        provider: &str,
        options: &SubscriptionDetectOptions,
    ) -> Result<SubscriptionDetection, JsError> {
        if !self.flag("quiet") {
            note(
                &self.sink,
                json!([
                    "detect",
                    provider,
                    options.configured_path,
                    options.timeout_ms.map(jnum)
                ]),
            );
        }
        match self.sequence("detect", provider) {
            Some(next) if next.get("reject").is_some() => Err(fail(
                next.get("reject").and_then(Value::as_str).unwrap_or(""),
            )),
            Some(next) => Ok(detection_of(&next)),
            None => Ok(SubscriptionDetection::new(provider, "signed-out")),
        }
    }

    fn models(&self, provider: &str, options: &SubscriptionModelListOptions) -> Option<JsonValue> {
        note(
            &self.sink,
            json!(["models", provider, options.configured_path]),
        );
        let next = self.sequence("models", provider)?;
        if next.is_object() && next.get("reject").is_some() {
            return None;
        }
        Some(json_value_from_serde(&next))
    }
}

fn detection_of(v: &Value) -> SubscriptionDetection {
    let s = |key: &str| text_of(Some(v), key);
    SubscriptionDetection {
        provider: s("provider").unwrap_or_default(),
        state: s("state").unwrap_or_default(),
        version: s("version"),
        login_method: s("loginMethod"),
        plan_name: s("planName"),
        error: s("error"),
        program_path: s("programPath"),
        login_kind: s("loginKind"),
        account: s("account"),
    }
}

struct BenchStore(Rc<Bench>);

fn obj_of(v: &Value) -> Obj {
    match json_value_from_serde(v) {
        JsonValue::Object(o) => o,
        _ => Obj::new(),
    }
}

impl MeteredAcceptanceStore for BenchStore {
    fn read(&self) -> Fut<Result<Obj, JsError>> {
        let b = self.0.clone();
        Box::pin(async move {
            note(&b.sink, json!(["read"]));
            if b.flag("failRead") {
                return Err(fail("read record"));
            }
            Ok(obj_of(&b.record.borrow()))
        })
    }

    fn write(&self, record: Obj) -> Fut<Result<(), JsError>> {
        let b = self.0.clone();
        Box::pin(async move {
            let value = json_value_to_serde(&JsonValue::Object(record));
            note(&b.sink, json!(["write", value]));
            if b.flag("failWrite") {
                return Err(fail("write record"));
            }
            *b.record.borrow_mut() = value;
            Ok(())
        })
    }
}

fn metered_writer(b: &Rc<Bench>) -> SettingWriter {
    let b = b.clone();
    Rc::new(move |provider, accepted| {
        let b = b.clone();
        Box::pin(async move { b.set_metered(&provider, accepted) })
    })
}

fn off_writer(b: &Rc<Bench>) -> Option<SettingWriter> {
    if b.flag("noOff") {
        return None;
    }
    let b = b.clone();
    Some(Rc::new(move |provider, off| {
        let b = b.clone();
        Box::pin(async move { b.set_off(&provider, off) })
    }))
}

fn detector_of(b: &Rc<Bench>) -> SubscriptionDetector {
    let b = b.clone();
    Rc::new(
        move |_rt: Rt, provider: String, options: SubscriptionDetectOptions| {
            let b = b.clone();
            Box::pin(async move { b.detect(&provider, &options) })
        },
    )
}

fn lister_of(b: &Rc<Bench>) -> SubscriptionModelLister {
    let b = b.clone();
    Rc::new(
        move |_rt: Rt, provider: String, options: SubscriptionModelListOptions| {
            let b = b.clone();
            Box::pin(async move { b.models(&provider, &options) })
        },
    )
}

fn status_listener(sink: &Sink, label: &'static str, name: Option<String>) -> StatusListener {
    let sink = sink.clone();
    Rc::new(move |statuses| {
        let value = json_value_to_serde(statuses);
        match &name {
            Some(name) => note(&sink, json!([label, name, value])),
            None => note(&sink, json!([label, value])),
        }
        Ok(())
    })
}

fn deps_of(b: &Rc<Bench>, sink: &Sink) -> SubscriptionStatusServiceDeps {
    let reader = b.clone();
    SubscriptionStatusServiceDeps {
        get_settings: Rc::new(move || {
            let b = reader.clone();
            Box::pin(async move { b.get_settings() })
        }),
        set_metered_accepted: metered_writer(b),
        set_subscription_off: off_writer(b),
        acceptance_store: Rc::new(BenchStore(b.clone())),
        detect: Some(detector_of(b)),
        list_models: (!b.flag("noModels")).then(|| lister_of(b)),
        on_change: Some(status_listener(sink, "change", None)),
        timeout_ms: number_of(Some(&b.opts), "timeoutMs"),
    }
}

/// The functions that stop a listener, by its name
type Listeners = Rc<RefCell<Vec<(String, Rc<dyn Fn()>)>>>;

/// What one step of a scenario reaches
struct Steps {
    rt: Rt,
    service: SubscriptionStatusService,
    bench: Rc<Bench>,
    sink: Sink,
    listeners: Listeners,
    /// the registration, for the `invoke` of the ipc scenario
    ipc: Option<Rc<SubscriptionIpc>>,
    deps: Option<Rc<SubscriptionIpcDeps>>,
    launch: LaunchState,
}

fn channel_of(key: &str) -> String {
    SUBSCRIPTION_IPC_CHANNELS
        .iter()
        .find(|(name, _)| *name == key)
        .map_or_else(|| key.to_owned(), |(_, channel)| (*channel).to_owned())
}

fn launch_result_of(v: &Value) -> SubscriptionLaunchResult {
    SubscriptionLaunchResult {
        ok: v.get("ok").and_then(Value::as_bool) == Some(true),
        reason: text_of(Some(v), "reason"),
        error: text_of(Some(v), "error"),
        install_url: text_of(Some(v), "installUrl"),
    }
}

/// One step of a scenario, and then the turns the TypeScript's harness takes
/// before the next one (`await run(step)`, with the promises `run` returns)
fn step(ctx: Rc<Steps>, step: Value) -> LocalBoxFuture<Result<Value, JsError>> {
    Box::pin(async move {
        let what = step.get(0).and_then(Value::as_str).unwrap_or("").to_owned();
        let name = step.get(1).and_then(Value::as_str).unwrap_or("").to_owned();
        let value = step_body(ctx.clone(), step).await?;
        for _ in 0..turns(&ctx, &what, &name) {
            tick(&ctx.rt).await;
        }
        Ok(value)
    })
}

/// How many turns after its body a step's promise settles in the harness
fn turns(ctx: &Steps, what: &str, name: &str) -> usize {
    let run = ctx.ipc.is_some() || ctx.deps.is_some();
    // `serviceStep` returns a promise (two turns to adopt) or a plain value; `run`
    // returns what it returns, which adopts again
    let service_step = match what {
        "check" | "metered" | "off" | "isOff" => Some(2),
        "clear" | "settle" => Some(1),
        "signing" | "unfinished" | "statuses" | "settings" | "record" | "listen" | "unlisten" => {
            Some(0)
        }
        _ => None,
    };
    match what {
        _ if service_step.is_some() => service_step.unwrap_or(0) + if run { 2 } else { 0 },
        "par" => 3,
        "invoke" => {
            if SubscriptionIpc::channels().contains(&channel_of(name).as_str())
                && !matches!(name, "statuses" | "codexImage")
            {
                2
            } else {
                0
            }
        }
        "loginChange" | "sleep" => 1,
        "login" | "logout" | "install" | "update" | "cancel" => 2,
        _ => 0,
    }
}

/// The body of a step; `par` runs its steps at the same time
fn step_body(ctx: Rc<Steps>, step: Value) -> LocalBoxFuture<Result<Value, JsError>> {
    Box::pin(async move {
        let what = step.get(0).and_then(Value::as_str).unwrap_or("").to_owned();
        let a = step.get(1).cloned().unwrap_or(Value::Null);
        let x = step.get(2).cloned();
        let y = step.get(3).cloned();
        let name = a.as_str().unwrap_or("").to_owned();
        let service = &ctx.service;
        Ok(match what.as_str() {
            "check" => {
                let providers: Vec<String> = string_list(Some(&a));
                let fresh = x.as_ref().and_then(Value::as_bool) == Some(true);
                let statuses = service
                    .check(
                        if a.is_null() {
                            None
                        } else {
                            Some(&providers[..])
                        },
                        fresh,
                    )
                    .await;
                json_value_to_serde(&statuses)
            }
            "metered" => {
                let accepted = x.as_ref().and_then(Value::as_bool) == Some(true);
                json_value_to_serde(
                    &service
                        .set_metered_accepted(&name, accepted)
                        .await
                        .to_json(),
                )
            }
            "clear" => {
                service.clear_metered_acceptance(&name).await;
                Value::Null
            }
            "off" => {
                let off = x.as_ref().and_then(Value::as_bool) == Some(true);
                json_value_to_serde(&service.set_off(&name, off).await.to_json())
            }
            "isOff" => Value::Bool(service.is_off(&name).await),
            "signing" => {
                service.set_signing_in(&name, x.as_ref().and_then(Value::as_str));
                Value::Null
            }
            "unfinished" => {
                let failure = y.as_ref().map(json_value_from_serde);
                service.set_login_unfinished(
                    &name,
                    x.as_ref().and_then(Value::as_bool) == Some(true),
                    failure.as_ref(),
                );
                Value::Null
            }
            "statuses" => json_value_to_serde(&service.get_statuses()),
            "settings" => {
                if let (Some(patch), Some(map)) = (
                    a.as_object(),
                    ctx.bench.settings.borrow_mut().as_object_mut(),
                ) {
                    for (k, v) in patch {
                        map.insert(k.clone(), v.clone());
                    }
                }
                Value::Null
            }
            "record" => {
                *ctx.bench.record.borrow_mut() = a.clone();
                Value::Null
            }
            "listen" => {
                let remove =
                    service.on_change(status_listener(&ctx.sink, "listen", Some(name.clone())));
                ctx.listeners.borrow_mut().push((name, remove));
                Value::Null
            }
            "unlisten" => {
                let remove = ctx
                    .listeners
                    .borrow()
                    .iter()
                    .find(|(n, _)| *n == name)
                    .map(|(_, r)| r.clone());
                if let Some(remove) = remove {
                    remove();
                }
                Value::Null
            }
            "settle" => {
                ctx.rt.sleep(0.0).await;
                Value::Null
            }
            "par" => {
                // `Promise.all(steps.map(...))`: each call runs now, up to its first `await`
                let waits: Vec<Wait<Result<Value, JsError>>> = step_list(&ctx, &step)
                    .into_iter()
                    .map(|future| start_now(&ctx.rt, future))
                    .collect();
                let mut out = Vec::new();
                for wait in waits {
                    out.push(wait.await?);
                }
                Value::Array(out)
            }
            // ---- ipc: registerSubscriptionIpc ----
            "invoke" => {
                let Some(ipc) = &ctx.ipc else {
                    return Err(fail("no such step invoke"));
                };
                let payload = x.as_ref().map(json_value_from_serde);
                match ipc.handle(&channel_of(&name), payload.as_ref()).await {
                    Some(v) => json_value_to_serde(&v),
                    None => json!({ "noHandler": true }),
                }
            }
            "loginChange" => {
                notify_subscription_login_change(&ctx.launch, &name);
                ctx.rt.sleep(0.0).await;
                Value::Null
            }
            "unregister" => {
                if let Some(ipc) = &ctx.ipc {
                    ipc.unregister();
                }
                Value::Null
            }
            // ---- ipc: createSubscriptionIpcDeps ----
            "login" | "logout" | "install" | "update" | "cancel" => {
                let Some(deps) = &ctx.deps else {
                    return Err(fail(&format!("no such step {what}")));
                };
                let result = match what.as_str() {
                    "login" => {
                        (deps.launch_login)(
                            name,
                            x.as_ref().and_then(Value::as_str).map(str::to_owned),
                        )
                        .await?
                    }
                    "logout" => (deps.launch_logout)(name).await?,
                    "install" => (deps.launch_install)(name).await?,
                    "update" => (deps.launch_update)(name).await?,
                    _ => (deps.cancel_login)(name).await?,
                };
                json_value_to_serde(&result.to_json())
            }
            "sleep" => {
                ctx.rt.sleep(a.as_f64().unwrap_or(0.0)).await;
                Value::Null
            }
            other => return Err(fail(&format!("no such step {other}"))),
        })
    })
}

fn step_list(ctx: &Rc<Steps>, par: &Value) -> Vec<LocalBoxFuture<Result<Value, JsError>>> {
    par.as_array()
        .map(|list| {
            list.iter()
                .skip(1)
                .map(|s| step(ctx.clone(), s.clone()))
                .collect()
        })
        .unwrap_or_default()
}

async fn run_steps(ctx: &Rc<Steps>, o: &Value) -> Result<Vec<Value>, JsError> {
    let mut results = Vec::new();
    for s in o
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        results.push(step(ctx.clone(), s).await?);
        // `await run(step)`
        tick(&ctx.rt).await;
    }
    Ok(results)
}

fn service_scenario(args: &[Value], cx: &mut Context) -> Answer {
    in_world(args, cx, |rt, sink, o| async move {
        let st = states(rt.now());
        let bench = Bench::new(&o, &sink);
        let service =
            create_subscription_status_service(&rt, &st.launch, &st.status, deps_of(&bench, &sink));
        let off_sink = sink.clone();
        let remove_off = on_subscription_off_change(
            &st.launch,
            Rc::new(move |change: &SubscriptionOffChange| {
                note(
                    &off_sink,
                    json!(["off-change", { "provider": change.provider, "off": change.off }]),
                );
                Ok(())
            }),
        );
        let ctx = Rc::new(Steps {
            rt: rt.clone(),
            service: service.clone(),
            bench,
            sink,
            listeners: Rc::new(RefCell::new(Vec::new())),
            ipc: None,
            deps: None,
            launch: st.launch.clone(),
        });
        let outcome = run_steps(&ctx, &o).await;
        remove_off();
        let results = outcome?;
        Ok(json!({ "results": results, "statuses": json_value_to_serde(&service.get_statuses()) }))
    })
}

// ---------------------------------------------------------------------------
// ipc.ts
// ---------------------------------------------------------------------------

/// `stubLaunch(o, cx, name, label)`
fn stub_launch(o: &Value, sink: &Sink, name: &str, label: &'static str) -> LaunchLogin {
    let spec = o.get("launch").and_then(|l| l.get(name)).cloned();
    let sink = sink.clone();
    Rc::new(move |provider, mode| {
        note(&sink, json!([label, provider, mode]));
        let outcome = match &spec {
            Some(spec) if spec.get("reject").is_some() => Err(fail(
                spec.get("reject").and_then(Value::as_str).unwrap_or(""),
            )),
            Some(spec) => Ok(spec
                .get("result")
                .map_or_else(SubscriptionLaunchResult::ok, launch_result_of)),
            None => Ok(SubscriptionLaunchResult::ok()),
        };
        Box::pin(async move { outcome })
    })
}

fn stub_launcher(
    o: &Value,
    sink: &Sink,
    name: &str,
    label: &'static str,
) -> Rc<dyn Fn(String) -> Fut<Result<SubscriptionLaunchResult, JsError>>> {
    let stub = stub_launch(o, sink, name, label);
    Rc::new(move |provider| stub(provider, None))
}

fn broadcaster(o: &Value, sink: &Sink) -> Option<Broadcast> {
    flag(Some(o), "broadcast").then(|| {
        let sink = sink.clone();
        Rc::new(move |channel: &str, payload: &JsonValue| {
            note(
                &sink,
                json!(["broadcast", channel, json_value_to_serde(payload)]),
            );
        }) as Broadcast
    })
}

fn ipc_scenario(args: &[Value], cx: &mut Context) -> Answer {
    in_world(args, cx, |rt, sink, o| async move {
        let st = states(rt.now());
        let image = Rc::new(RefCell::new(ImageBackendState::new()));
        image
            .borrow_mut()
            .set_codex_image_generation_available(flag(Some(&o), "codexImage"));
        let bench = Bench::new(&o, &sink);
        let service =
            create_subscription_status_service(&rt, &st.launch, &st.status, deps_of(&bench, &sink));
        let deps = Rc::new(SubscriptionIpcDeps {
            service: service.clone(),
            launch_login: stub_launch(&o, &sink, "login", "launchLogin"),
            launch_logout: stub_launcher(&o, &sink, "logout", "launchLogout"),
            launch_install: stub_launcher(&o, &sink, "install", "launchInstall"),
            launch_update: stub_launcher(&o, &sink, "update", "launchUpdate"),
            cancel_login: stub_launcher(&o, &sink, "cancel", "cancelLogin"),
            broadcast: broadcaster(&o, &sink),
        });
        let ipc = Rc::new(register_subscription_ipc(
            &rt,
            &st.launch,
            deps.clone(),
            &image,
        ));
        let ctx = Rc::new(Steps {
            rt: rt.clone(),
            service: service.clone(),
            bench,
            sink,
            listeners: Rc::new(RefCell::new(Vec::new())),
            ipc: Some(ipc.clone()),
            deps: None,
            launch: st.launch.clone(),
        });
        let outcome = run_steps(&ctx, &o).await;
        ipc.unregister();
        let results = outcome?;
        let channels: Vec<Value> = SubscriptionIpc::channels()
            .into_iter()
            .map(|c| Value::String(c.to_owned()))
            .collect();
        Ok(json!({
            "channels": channels,
            "results": results,
            "statuses": json_value_to_serde(&service.get_statuses()),
        }))
    })
}

/// The ChatGPT connection over a memory store, which the TypeScript builds
/// with `createChatGptConnection`
struct NoVerifier;

impl JwtSignatureVerifier for NoVerifier {
    fn signature_valid(&self, _: &str, _: &[u8], _: &[u8], _: &JsonValue) -> Result<bool, JsError> {
        Err(JsError::error("no verifier"))
    }
}

fn chat_gpt_connection(rt: &Rt) -> ChatGptConnection {
    ChatGptConnection::new(ChatGptConnectionDeps {
        store: Rc::new(ChatGptConnectionMemoryStore::new(rt, None)),
        agent_name: "SeuOffice".to_owned(),
        fx: Rc::new(RefCell::new(AiFetchState::default())),
        fetch: KeyedFetchBase::Ai,
        now: None,
        verifier: Rc::new(NoVerifier),
    })
}

fn ipc_setup(rt: &Rt, o: &Value, b: &Rc<Bench>, sink: &Sink) -> SubscriptionIpcSetup {
    let reader = b.clone();
    let words = o.get("windowText").cloned();
    SubscriptionIpcSetup {
        get_settings: Rc::new(move || reader.get_settings()),
        set_metered_accepted: metered_writer(b),
        set_subscription_off: off_writer(b),
        data_dir: text_of(Some(o), "dataDir").unwrap_or_default(),
        broadcast: broadcaster(o, sink),
        detect: Some(detector_of(b)),
        list_models: (!flag(Some(o), "noModels")).then(|| lister_of(b)),
        models_state: Rc::new(RefCell::new(SubscriptionModelsState::default())),
        locate: locator_of(o.get("locate"), sink),
        platform: text_of(Some(o), "platform"),
        kill_tree: flag(Some(o), "killTree").then(|| {
            let sink = sink.clone();
            Rc::new(move |child: &Child| {
                note(&sink, json!(["killtree", child.pid().map(jnum)]));
            }) as Rc<dyn Fn(&Child)>
        }),
        hidden_login_timeout_ms: number_of(Some(o), "hiddenMs"),
        login_window_text: words.map(|words| {
            let sink = sink.clone();
            Rc::new(move |provider: &str| {
                note(&sink, json!(["windowText", provider]));
                if words.as_str() == Some("throws") {
                    return Err(JsError::error("words"));
                }
                Ok(window_text_of(Some(&words)).unwrap_or_default())
            }) as Rc<dyn Fn(&str) -> Result<SubscriptionLoginWindowText, JsError>>
        }),
        chat_gpt_sign_in: None,
        chat_gpt_connection: chat_gpt_connection(rt),
    }
}

fn deps_scenario(args: &[Value], cx: &mut Context) -> Answer {
    in_world(args, cx, |rt, sink, o| async move {
        let st = states(rt.now());
        let bench = Bench::new(&o, &sink);
        let deps = Rc::new(create_subscription_ipc_deps(
            &rt,
            &st.launch,
            &st.status,
            ipc_setup(&rt, &o, &bench, &sink),
        ));
        let ctx = Rc::new(Steps {
            rt: rt.clone(),
            service: deps.service.clone(),
            bench,
            sink,
            listeners: Rc::new(RefCell::new(Vec::new())),
            ipc: None,
            deps: Some(deps.clone()),
            launch: st.launch.clone(),
        });
        let results = run_steps(&ctx, &o).await?;
        Ok(json!({
            "results": results,
            "statuses": json_value_to_serde(&deps.service.get_statuses()),
        }))
    })
}

fn shared_scenario(args: &[Value], cx: &mut Context) -> Answer {
    in_world(args, cx, |rt, sink, o| async move {
        let st = states(rt.now());
        let shared = Rc::new(RefCell::new(SubscriptionIpcShared::default()));
        let image = Rc::new(RefCell::new(ImageBackendState::new()));
        let bench = Bench::new(&o, &sink);
        let listeners = Rc::new(RefCell::new(Vec::new()));
        let mut first: Option<Rc<SubscriptionIpcDeps>> = None;
        let mut current: Option<Rc<SubscriptionIpcDeps>> = None;
        let mut results: Vec<Value> = Vec::new();
        for s in o
            .get("steps")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let what = s.get(0).and_then(Value::as_str).unwrap_or("").to_owned();
            match what.as_str() {
                "ensure" => {
                    let registered = shared.borrow().ipc().is_some();
                    let setup = ipc_setup(&rt, &o, &bench, &sink);
                    let create_sink = sink.clone();
                    let (create_rt, launch, status) =
                        (rt.clone(), st.launch.clone(), st.status.clone());
                    let deps = ensure_subscription_ipc(
                        &rt,
                        &shared,
                        &st.launch,
                        &image,
                        setup,
                        move |setup| {
                            note(&create_sink, json!(["createDeps"]));
                            create_subscription_ipc_deps(&create_rt, &launch, &status, setup)
                        },
                    );
                    if !registered {
                        for channel in SubscriptionIpc::channels() {
                            note(&sink, json!(["handle", channel]));
                        }
                    }
                    let same = match &first {
                        Some(first) => Rc::ptr_eq(first, &deps),
                        None => true,
                    };
                    if first.is_none() {
                        first = Some(deps.clone());
                    }
                    current = Some(deps);
                    results.push(json!({ "same": same }));
                }
                "shared" => {
                    results.push(json_value_to_serde(&shared_subscription_statuses(&shared)))
                }
                "reset" => {
                    reset_shared_subscription_ipc(&shared);
                    results.push(Value::Null);
                }
                "forget" => {
                    first = None;
                    results.push(Value::Null);
                }
                _ => {
                    let Some(current) = &current else {
                        return Err(fail("no registration"));
                    };
                    let ctx = Rc::new(Steps {
                        rt: rt.clone(),
                        service: current.service.clone(),
                        bench: bench.clone(),
                        sink: sink.clone(),
                        listeners: listeners.clone(),
                        ipc: None,
                        deps: None,
                        launch: st.launch.clone(),
                    });
                    results.push(step(ctx, s.clone()).await?);
                }
            }
        }
        reset_shared_subscription_ipc(&shared);
        Ok(Value::Array(results))
    })
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "subscription/launch.constants" => answer(json!({
            "logoutTimeout": jnum(SUBSCRIPTION_LOGOUT_TIMEOUT_MS),
            "loginExe": SUBSCRIPTION_LOGIN_EXE_ENV,
            "loginArgs": SUBSCRIPTION_LOGIN_ARGS_ENV,
            "loginTitle": SUBSCRIPTION_LOGIN_TITLE_ENV,
            "loginGuide": SUBSCRIPTION_LOGIN_GUIDE_ENV,
            "loginClosing": SUBSCRIPTION_LOGIN_CLOSING_ENV,
            "updateExe": SUBSCRIPTION_UPDATE_EXE_ENV,
            "updateArgs": SUBSCRIPTION_UPDATE_ARGS_ENV,
            "codexUpdate": {
                "npm": SUBSCRIPTION_CODEX_UPDATE_COMMAND_NPM,
                "winget": SUBSCRIPTION_CODEX_UPDATE_COMMAND_WINGET,
            },
        })),
        "subscription/launch.onSubscriptionLoginChange"
        | "subscription/launch.notifySubscriptionLoginChange" => listeners("login", args, cx),
        "subscription/launch.onSubscriptionOffChange"
        | "subscription/launch.notifySubscriptionOffChange" => listeners("off", args, cx),
        "subscription/launch.subscriptionInstallCommandLine" => {
            let provider = arg(args, 0).and_then(Value::as_str).unwrap_or_default();
            let get = env_getter(arg(args, 1));
            answer(Value::String(subscription_install_command_line(
                provider, &get,
            )))
        }
        "subscription/launch.subscriptionUpdatePlan" => {
            let program = program_of(arg(args, 0).unwrap_or(&Value::Null));
            answer(plan_json(subscription_update_plan(&program)))
        }
        "subscription/launch.subscriptionUpdateCommandLine" => {
            let plan = plan_of(arg(args, 0));
            let get = env_getter(arg(args, 1));
            answer(Value::String(subscription_update_command_line(&plan, &get)))
        }
        "subscription/launch.launchSubscriptionLogin" => launch_login(args, cx),
        "subscription/launch.launchSubscriptionLogout" => launch_logout(args, cx),
        "subscription/launch.launchSubscriptionInstall" => launch_install(args, cx),
        "subscription/launch.launchSubscriptionUpdate" => launch_update(args, cx),

        "subscription/status.constants" => answer(json!({
            "timeout": jnum(SUBSCRIPTION_STATUS_TIMEOUT_MS),
            "kinds": SUBSCRIPTION_LOGIN_KINDS.iter().collect::<Vec<_>>(),
        })),
        "subscription/status.subscriptionLoginKind" => answer(Value::String(
            subscription_login_kind(arg(args, 0).and_then(Value::as_str)),
        )),
        "subscription/status.parseClaudeAuthStatus" => answer(login_json(
            parse_claude_auth_status(arg(args, 0).and_then(Value::as_str).unwrap_or("")),
        )),
        "subscription/status.parseCodexLoginStatus" => answer(login_json(
            parse_codex_login_status(arg(args, 0).and_then(Value::as_str).unwrap_or("")),
        )),
        "subscription/status.codexAccountInfo" => {
            answer(login_json(codex_account_info(&json_of(arg(args, 0)))))
        }
        "subscription/status.detectSubscriptionLogin"
        | "subscription/status.setCodexAccountSource" => {
            detecting(args, cx, |rt, sink, o, status| async move {
                let provider = text_of(Some(&o), "provider").unwrap_or_default();
                let detection =
                    detect_subscription_login(&rt, &status, &provider, &detect_options(&o, &sink))
                        .await;
                Ok(json_value_to_serde(&detection.to_json()))
            })
        }
        "subscription/status.detectSubscriptionLogins" => {
            detecting(args, cx, |rt, sink, o, status| async move {
                let stubs = o.get("stubs").cloned();
                let detect: Option<SubscriptionDetector> = stubs.map(|stubs| {
                    let sink = sink.clone();
                    Rc::new(
                        move |_rt: Rt, provider: String, own: SubscriptionDetectOptions| {
                            note(&sink, json!(["stub", provider, own.configured_path]));
                            let detection = match stubs.get(&provider) {
                                Some(v) => detection_of(v),
                                None => SubscriptionDetection::new(&provider, "signed-out"),
                            };
                            Box::pin(async move { Ok(detection) })
                                as Fut<Result<SubscriptionDetection, JsError>>
                        },
                    ) as SubscriptionDetector
                });
                let configured_paths =
                    o.get("configuredPaths")
                        .and_then(Value::as_object)
                        .map(|m| {
                            let mut out = jscompat::JsObject::new();
                            for (k, v) in m {
                                out.set(k.clone(), v.as_str().map(str::to_owned));
                            }
                            out
                        });
                let all = SubscriptionDetectAllOptions {
                    options: detect_options(&o, &sink),
                    configured_paths,
                    detect,
                };
                let out = detect_subscription_logins(&rt, &status, &all).await?;
                let mut map = Map::new();
                for (provider, detection) in out.entries() {
                    map.insert(
                        provider.to_owned(),
                        json_value_to_serde(&detection.to_json()),
                    );
                }
                Ok(Value::Object(map))
            })
        }

        "subscription/service.createSubscriptionStatusService" => service_scenario(args, cx),
        "subscription/ipc.HIDDEN_LOGIN_TIMEOUT_MS" => answer(jnum(HIDDEN_LOGIN_TIMEOUT_MS)),
        "subscription/ipc.registerSubscriptionIpc" => ipc_scenario(args, cx),
        "subscription/ipc.createSubscriptionIpcDeps" => deps_scenario(args, cx),
        "subscription/ipc.ensureSubscriptionIpc"
        | "subscription/ipc.sharedSubscriptionStatuses"
        | "subscription/ipc.resetSharedSubscriptionIpc" => shared_scenario(args, cx),
        _ => return None,
    })
}
