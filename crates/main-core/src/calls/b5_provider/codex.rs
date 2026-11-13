//! Part `codex` of group `b5-provider` (tools/main-diff/groups/b5-provider/codex.ts):
//! `packages/ai-provider/src/codex-app-server.ts`. The spec describes the
//! scenario (`steps`), the scripted children and the log lines.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg};
use super::world::{Sink, call_error, drive, note};
use crate::packages::ai_provider::codex_app_server::{
    BoundedRpcStdout, CODEX_CONFIG_OVERRIDES, CodexApp, CodexAppServerState, CodexTurnTransport,
    MAX_RPC_LINE_BYTES, RpcMessage, active_permission_profile_id, build_codex_app_server_prompt,
    chat_codex_app_server, codex_app_server_launch_args, codex_app_server_output_schema,
    codex_attached_mcp_servers, codex_hooks, codex_listed_effort, codex_mcp_server_overrides,
    codex_run_error, codex_subscription_models, codex_subscription_usage,
    codex_thread_start_params, list_codex_models, list_codex_subscription_models,
    parse_codex_app_server_turn, read_codex_account, shutdown_codex_app_servers,
    stream_codex_app_server, wait_for_turn,
};
use crate::packages::ai_provider::jsval::Obj;
use crate::packages::ai_provider::protocols_shared::StreamCallbacks;
use crate::packages::ai_provider::subscription_locate::{
    SubscriptionLocateOptions, SubscriptionProgram,
};
use crate::packages::ai_provider::task::{JsError, LocalBoxFuture, Rt, Signal};

const ENTRY: &str = "/opt/codex/bin/codex";

fn jv(args: &[Value], i: usize) -> JsonValue {
    arg(args, i).map_or(JsonValue::Null, json_value_from_serde)
}

fn s(args: &[Value], i: usize) -> String {
    arg(args, i)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn list(args: &[Value], i: usize) -> Vec<JsonValue> {
    match jv(args, i) {
        JsonValue::Array(items) => items,
        _ => Vec::new(),
    }
}

fn thrown(e: &JsError) -> CallError {
    call_error(e)
}

fn value(v: &JsonValue) -> Answer {
    Ok(Some(json_value_to_serde(v)))
}

/// `err(error)` of the spec: the name, the message and the run-error fields
/// the error has.
fn err_json(e: &JsError) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), Value::String(e.name.clone()));
    out.insert("message".into(), Value::String(e.message.clone()));
    for key in ["kind", "provider", "resetsAt"] {
        if let Some(v) = e.props.get(key) {
            out.insert(key.into(), json_value_to_serde(v));
        }
    }
    Value::Object(out)
}

/// `threw(error)` of the spec
fn threw(e: &JsError) -> Value {
    json!({ "threw": err_json(e) })
}

fn chunk_bytes(chunk: &Value) -> Vec<u8> {
    match chunk {
        Value::String(s) => s.as_bytes().to_vec(),
        Value::Object(o) if o.contains_key("fill") => {
            let byte = o.get("fill").and_then(Value::as_u64).unwrap_or(0) as u8;
            let size = o.get("size").and_then(Value::as_u64).unwrap_or(0) as usize;
            vec![byte; size]
        }
        Value::Object(o) => o
            .get("hex")
            .and_then(Value::as_str)
            .map(|h| {
                (0..h.len() / 2)
                    .filter_map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).ok())
                    .collect()
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// `callbacks(cx, signal, sessionId)` of the spec
fn callbacks(sink: &Sink, signal: &Signal, session_id: Option<String>) -> StreamCallbacks {
    let log = |sink: &Sink, label: &'static str| {
        let sink = sink.clone();
        move |v: JsonValue| note(&sink, json!([label, json_value_to_serde(&v)]))
    };
    let activity = sink.clone();
    StreamCallbacks {
        on_delta: Rc::new(log(sink, "delta")),
        on_tool_call: Rc::new(log(sink, "tool")),
        on_reasoning_delta: Some(Rc::new(log(sink, "reasoning"))),
        on_stop_reason: None,
        on_usage: None,
        on_subscription_usage: Some(Rc::new(log(sink, "usage"))),
        on_input_truncated: None,
        on_activity: Some(Rc::new(move || note(&activity, json!(["activity"])))),
        session_id,
        signal: signal.clone(),
    }
}

// ---------------------------------------------------------------------------
// the bounded stdout reader
// ---------------------------------------------------------------------------

fn attach(args: &[Value], cx: &mut Context) -> Answer {
    let throw_on: Vec<String> = arg(args, 1)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let sink: Sink = Rc::new(RefCell::new(Vec::new()));
    let (kill_sink, line_sink, overflow_sink) = (sink.clone(), sink.clone(), sink.clone());
    let mut reader = BoundedRpcStdout::new(
        move || note(&kill_sink, json!(["kill"])),
        move |line| {
            note(&line_sink, json!(["line", line]));
            if throw_on.iter().any(|t| t == line) {
                return Err(JsError::error("write failed"));
            }
            if throw_on.iter().any(|t| *t == format!("!{line}")) {
                return Err(JsError::value(JsonValue::String("plain".into())));
            }
            Ok(())
        },
        move |error| note(&overflow_sink, json!(["overflow", error.message])),
    );
    for event in arg(args, 0)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        if let Some(data) = event.get("data") {
            reader.data(&chunk_bytes(data));
        } else {
            // `end` and `close` both end the stream
            reader.end();
        }
    }
    cx.logs.extend(sink.borrow_mut().drain(..));
    Ok(Some(Value::Null))
}

// ---------------------------------------------------------------------------
// waitForTurn over a scripted transport
// ---------------------------------------------------------------------------

type Notify = Rc<dyn Fn(&RpcMessage)>;
type Closer = Rc<dyn Fn(&JsError)>;

struct FakeTransport {
    sink: Sink,
    answers: Value,
    no_close: bool,
    listeners: Rc<RefCell<Vec<(u64, Notify)>>>,
    closers: Rc<RefCell<Vec<(u64, Closer)>>>,
    next: Cell<u64>,
}

impl CodexTurnTransport for FakeTransport {
    fn request(
        &self,
        method: &str,
        params: Option<JsonValue>,
    ) -> LocalBoxFuture<Result<JsonValue, JsError>> {
        note(
            &self.sink,
            json!([
                "request",
                method,
                params.as_ref().map_or(Value::Null, json_value_to_serde)
            ]),
        );
        let answer = self.answers.get(method).cloned();
        Box::pin(async move {
            match answer {
                Some(Value::String(hang)) if hang == "hang" => {
                    std::future::pending::<Result<JsonValue, JsError>>().await
                }
                Some(Value::Object(o)) if o.contains_key("reject") => Err(JsError::error(
                    o.get("reject").and_then(Value::as_str).unwrap_or_default(),
                )),
                Some(Value::Null) | None => Ok(JsonValue::Object(Obj::new())),
                Some(v) => Ok(json_value_from_serde(&v)),
            }
        })
    }

    fn on_notification(&self, listener: Notify) -> Rc<dyn Fn()> {
        let id = self.next.get() + 1;
        self.next.set(id);
        self.listeners.borrow_mut().push((id, listener));
        let listeners = self.listeners.clone();
        Rc::new(move || listeners.borrow_mut().retain(|(l, _)| *l != id))
    }

    fn on_close(&self, listener: Closer) -> Option<Rc<dyn Fn()>> {
        if self.no_close {
            return None;
        }
        let id = self.next.get() + 1;
        self.next.set(id);
        self.closers.borrow_mut().push((id, listener));
        let closers = self.closers.clone();
        Some(Rc::new(move || {
            closers.borrow_mut().retain(|(l, _)| *l != id)
        }))
    }
}

fn wait(args: &[Value], cx: &mut Context) -> Answer {
    let world = arg(args, 0).cloned();
    let script = arg(args, 1).cloned().unwrap_or(Value::Null);
    drive(world.as_ref(), cx, move |rt, signal, sink| async move {
        let thread_id = script
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or("thread-1")
            .to_owned();
        let listeners: Rc<RefCell<Vec<(u64, Notify)>>> = Rc::new(RefCell::new(Vec::new()));
        let closers: Rc<RefCell<Vec<(u64, Closer)>>> = Rc::new(RefCell::new(Vec::new()));
        let transport = Rc::new(FakeTransport {
            sink: sink.clone(),
            answers: script.get("answers").cloned().unwrap_or(Value::Null),
            no_close: script.get("noClose").and_then(Value::as_bool) == Some(true),
            listeners: listeners.clone(),
            closers: closers.clone(),
            next: Cell::new(0),
        });
        for event in script
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let at = event.get("at").and_then(Value::as_f64).unwrap_or(0.0);
            let listeners = listeners.clone();
            let closers = closers.clone();
            rt.set_timeout(at, move || {
                if let Some(notify) = event.get("notify") {
                    let message = RpcMessage {
                        method: notify.get("method").map(json_value_from_serde),
                        params: notify.get("params").map(json_value_from_serde),
                        ..RpcMessage::default()
                    };
                    let current: Vec<Notify> =
                        listeners.borrow().iter().map(|(_, l)| l.clone()).collect();
                    for listener in current {
                        listener(&message);
                    }
                } else {
                    let error = JsError::error(
                        event
                            .get("close")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    );
                    let current: Vec<Closer> =
                        closers.borrow().iter().map(|(_, l)| l.clone()).collect();
                    for listener in current {
                        listener(&error);
                    }
                }
            });
        }
        let cb = callbacks(&sink, &signal, None);
        let started = transport.clone();
        let start_params = jv_object(vec![("threadId", JsonValue::String(thread_id.clone()))]);
        let outcome = wait_for_turn(
            &rt,
            transport.clone(),
            &thread_id,
            Box::new(move || started.request("turn/start", Some(start_params))),
            &signal,
            &cb,
        )
        .await;
        match outcome {
            Ok(text) => json!({ "text": text }),
            Err(e) => threw(&e),
        }
    })
    .map(Some)
}

fn jv_object(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    crate::packages::ai_provider::jsval::object(entries)
}

// ---------------------------------------------------------------------------
// the scenario
// ---------------------------------------------------------------------------

/// `program(entry)` of the spec: what the resolver finds.
fn program(entry: &str) -> SubscriptionProgram {
    SubscriptionProgram {
        provider: "codex".into(),
        command: entry.into(),
        prefix_args: Vec::new(),
        env: Default::default(),
        entry: entry.into(),
        source: "configured".into(),
    }
}

/// `configOf(config)`: `{ model: 'gpt-5', ...config }`
fn config_of(config: Option<&Value>) -> JsonValue {
    let mut out = Obj::new();
    out.set("model", JsonValue::String("gpt-5".into()));
    if let Some(Value::Object(o)) = config {
        for (k, v) in o {
            out.set(k.clone(), json_value_from_serde(v));
        }
    }
    JsonValue::Object(out)
}

fn field_list(step: &Value, key: &str) -> Option<Vec<JsonValue>> {
    step.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().map(json_value_from_serde).collect())
}

async fn run_step(rt: &Rt, app: &CodexApp, signal: &Signal, sink: &Sink, step: &Value) -> Value {
    let hooks = codex_hooks(app);
    let given = |s: &Value| -> Option<Signal> {
        if s.get("aborted").and_then(Value::as_bool) == Some(true) {
            let aborted = rt.controller();
            aborted.abort(None);
            Some(aborted)
        } else if s.get("signal").and_then(Value::as_bool) == Some(true) {
            Some(signal.clone())
        } else {
            None
        }
    };
    if let Some(Value::Array(steps)) = step.get("all") {
        // started together, as `Promise.all` starts them
        let futures: Vec<LocalBoxFuture<Value>> = steps
            .iter()
            .map(|one| {
                let (rt, app, signal, sink, one) = (
                    rt.clone(),
                    app.clone(),
                    signal.clone(),
                    sink.clone(),
                    one.clone(),
                );
                Box::pin(async move { run_step(&rt, &app, &signal, &sink, &one).await })
                    as LocalBoxFuture<Value>
            })
            .collect();
        return Value::Array(rt.join_all(futures).await);
    }
    if let Some(s) = step.get("stream") {
        let user = jv_object(vec![
            ("role", JsonValue::String("user".into())),
            ("text", JsonValue::String("hi".into())),
        ]);
        let messages = field_list(s, "messages").unwrap_or_else(|| vec![user]);
        let tools = field_list(s, "tools").unwrap_or_default();
        let cb = callbacks(
            sink,
            signal,
            s.get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_owned),
        );
        return match stream_codex_app_server(
            rt,
            app,
            &config_of(s.get("config")),
            s.get("system").and_then(Value::as_str).unwrap_or("sys"),
            &messages,
            &tools,
            s.get("maxTokens").and_then(Value::as_f64).unwrap_or(4096.0),
            &cb,
        )
        .await
        {
            Ok(()) => json!({ "ok": true }),
            Err(e) => threw(&e),
        };
    }
    if let Some(s) = step.get("chat") {
        return match chat_codex_app_server(
            rt,
            app,
            &config_of(s.get("config")),
            s.get("system").and_then(Value::as_str).unwrap_or("sys"),
            s.get("user").and_then(Value::as_str).unwrap_or("hi"),
            signal,
        )
        .await
        {
            Ok(response) => json!({ "result": json_value_to_serde(&response.to_json()) }),
            Err(e) => threw(&e),
        };
    }
    if let Some(s) = step.get("account") {
        let given = given(s);
        return match read_codex_account(
            rt,
            app,
            s.get("cliPath").and_then(Value::as_str),
            given.as_ref(),
        )
        .await
        {
            Ok(account) => json!({ "result": json_value_to_serde(&account) }),
            Err(e) => threw(&e),
        };
    }
    if let Some(s) = step.get("models") {
        return match list_codex_models(rt, app, s.get("cliPath").and_then(Value::as_str)).await {
            Ok(catalog) => json!({ "result": json_value_to_serde(&catalog) }),
            Err(e) => threw(&e),
        };
    }
    if let Some(s) = step.get("subModels") {
        let given = given(s);
        return match list_codex_subscription_models(
            rt,
            app,
            s.get("cliPath").and_then(Value::as_str),
            given.as_ref(),
        )
        .await
        {
            Ok(models) => json!({ "result": json_value_to_serde(&models) }),
            Err(e) => threw(&e),
        };
    }
    if step.get("login").is_some() {
        (hooks.login_change)("codex");
    } else if let Some(off) = step.get("off") {
        (hooks.off_change)("codex", off.as_bool() == Some(true));
    } else if let Some(ms) = step.get("sleep") {
        rt.sleep(ms.as_f64().unwrap_or(0.0)).await;
    } else {
        shutdown_codex_app_servers(app);
    }
    Value::Null
}

fn scenario(args: &[Value], cx: &mut Context) -> Answer {
    let world = arg(args, 0).cloned();
    let o = arg(args, 1).cloned().unwrap_or(Value::Null);
    drive(world.as_ref(), cx, move |rt, signal, sink| async move {
        let app: CodexApp = Rc::new(RefCell::new(CodexAppServerState::default()));
        let resolve_error = o
            .get("resolveError")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let entry = o
            .get("entry")
            .and_then(Value::as_str)
            .unwrap_or(ENTRY)
            .to_owned();
        {
            let mut state = app.borrow_mut();
            state.runtime.resolve = Some(Rc::new(
                move |_rt: &Rt, _provider: &str, options: &SubscriptionLocateOptions| {
                    let error = resolve_error.clone();
                    let entry = options
                        .configured_path
                        .clone()
                        .unwrap_or_else(|| entry.clone());
                    let found: LocalBoxFuture<Result<SubscriptionProgram, JsError>> =
                        Box::pin(async move {
                            match error {
                                Some(message) => Err(JsError::error(message)),
                                None => Ok(program(&entry)),
                            }
                        });
                    found
                },
            ));
            if o.get("hookKill").and_then(Value::as_bool) == Some(true) {
                let kill_sink = sink.clone();
                state.runtime.kill_tree = Some(Rc::new(move |_rt: &Rt, child| {
                    let pid = child
                        .pid()
                        .map_or(Value::Null, |p| json_value_to_serde(&JsonValue::Number(p)));
                    note(&kill_sink, json!(["killTree", pid]));
                }));
            }
        }
        let mut out = Vec::new();
        let steps = o
            .get("steps")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for step in &steps {
            out.push(run_step(&rt, &app, &signal, &sink, step).await);
        }
        shutdown_codex_app_servers(&app);
        Value::Array(out)
    })
    .map(Some)
}

fn parse(args: &[Value], cx: &mut Context) -> Answer {
    let world = arg(args, 0).cloned();
    let o = arg(args, 1).cloned().unwrap_or(Value::Null);
    drive(world.as_ref(), cx, move |rt, _signal, _sink| async move {
        let raw = o.get("raw").and_then(Value::as_str).unwrap_or_default();
        let tools: Vec<JsonValue> = o
            .get("tools")
            .and_then(Value::as_array)
            .map(|names| {
                names
                    .iter()
                    .map(|n| jv_object(vec![("name", json_value_from_serde(n))]))
                    .collect()
            })
            .unwrap_or_default();
        match parse_codex_app_server_turn(&rt, raw, &tools) {
            Ok((text, tool_calls)) => json!({
                "text": text,
                "toolCalls": json_value_to_serde(&JsonValue::Array(tool_calls)),
            }),
            Err(e) => threw(&e),
        }
    })
    .map(Some)
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "codex.MAX_RPC_LINE_BYTES" => Ok(Some(json!(MAX_RPC_LINE_BYTES))),
        "codex.CODEX_CONFIG_OVERRIDES" => Ok(Some(json!(CODEX_CONFIG_OVERRIDES))),
        "codex.codexAppServerLaunchArgs" => Ok(Some(json!(codex_app_server_launch_args()))),
        "codex.codexAppServerOutputSchema" => {
            value(&codex_app_server_output_schema(&list(args, 0)))
        }
        "codex.buildCodexAppServerPrompt" => {
            Ok(Some(Value::String(build_codex_app_server_prompt(
                &s(args, 0),
                &list(args, 1),
                &list(args, 2),
                arg(args, 3).and_then(Value::as_f64).unwrap_or(f64::NAN),
            ))))
        }
        "codex.codexThreadStartParams" => {
            let mcp = match jv(args, 3) {
                JsonValue::Object(o) => o,
                _ => Obj::new(),
            };
            codex_thread_start_params(&jv(args, 0), &s(args, 1), &s(args, 2), &mcp)
                .map(|v| Some(json_value_to_serde(&v)))
                .map_err(|e| thrown(&e))
        }
        "codex.activePermissionProfileId" => Ok(Some(
            active_permission_profile_id(&jv(args, 0)).map_or(Value::Null, Value::String),
        )),
        "codex.codexMcpServerOverrides" => codex_mcp_server_overrides(&jv(args, 0))
            .map(|o| Some(json_value_to_serde(&JsonValue::Object(o))))
            .map_err(|e| thrown(&e)),
        "codex.codexAttachedMcpServers" => codex_attached_mcp_servers(&jv(args, 0))
            .map(|names| Some(json!(names)))
            .map_err(|e| thrown(&e)),
        "codex.codexSubscriptionUsage" => value(&JsonValue::Array(codex_subscription_usage(Some(
            &jv(args, 0),
        )))),
        "codex.codexRunError" => Ok(Some(err_json(&codex_run_error(
            Some(&jv(args, 0)),
            Some(&jv(args, 1)),
        )))),
        "codex.codexListedEffort" => Ok(Some(
            codex_listed_effort(&jv(args, 0), &s(args, 1), Some(&jv(args, 2)))
                .map_or(Value::Null, |e| Value::String(e.into())),
        )),
        "codex.codexSubscriptionModels" => {
            value(&JsonValue::Array(codex_subscription_models(&jv(args, 0))))
        }
        "codex.attachBoundedRpcStdout" => attach(args, cx),
        "codex.waitForTurn" => wait(args, cx),
        "codex.parseCodexAppServerTurn" => parse(args, cx),
        "codex.streamCodexAppServer"
        | "codex.chatCodexAppServer"
        | "codex.readCodexAccount"
        | "codex.listCodexModels"
        | "codex.listCodexSubscriptionModels"
        | "codex.shutdownCodexAppServers"
        | "codex.setCodexAppServerRuntime" => scenario(args, cx),
        _ => return None,
    })
}
