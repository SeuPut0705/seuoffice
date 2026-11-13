//! Part `claude` of group `b5-provider` (tools/main-diff/groups/b5-provider/claude.ts):
//! `packages/ai-provider/src/claude-code-cli.ts`.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg};
use super::world::{Sink, call_error, drive, note};
use crate::packages::ai_provider::claude_code_cli::{
    ClaudeCodeCliDeps, ClaudeCodeModelsRequest, ClaudeCodeParseError, MAX_CLAUDE_CODE_IMAGES,
    ResolveProgram, TurnTextScanner, build_claude_code_input, chat_claude_code_cli,
    claude_code_cli_launch_args, claude_code_effort, claude_code_models, claude_code_output_schema,
    claude_code_structure_error, claude_code_usage, direct_call_input, exit_failure, is_model_name,
    list_claude_code_models, parse_claude_code_turn, read_lines, reported_failure, start_failure,
    stream_claude_code_cli,
};
use crate::packages::ai_provider::jsval::length16;
use crate::packages::ai_provider::protocols_shared::StreamCallbacks;
use crate::packages::ai_provider::subscription_locate::{
    SubscriptionLocateState, SubscriptionProgram,
};
use crate::packages::ai_provider::subscription_process::SharedChildRegistry;
use crate::packages::ai_provider::subscription_temp_dirs::SubscriptionTempState;
use crate::packages::ai_provider::task::{ChildEvent, JsError, Rt, Signal, SpawnRequest, Stdio};
use crate::packages::ai_provider::watchdog::create_stream_watchdog;

fn jv(args: &[Value], i: usize) -> JsonValue {
    arg(args, i).map_or(JsonValue::Null, json_value_from_serde)
}

fn s(args: &[Value], i: usize) -> String {
    arg(args, i)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn thrown(e: JsError) -> CallError {
    call_error(&e)
}

/// `describe(e)` of the spec: the error as the answer carries it.
fn describe(e: &JsError) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), json!(e.name));
    out.insert("message".into(), json!(e.message));
    for key in ["kind", "provider", "resetsAt", "code"] {
        if let Some(v) = e.props.get(key) {
            out.insert(key.into(), json_value_to_serde(v));
        }
    }
    out.insert("cause".into(), json!(e.props.get("cause").is_some()));
    Value::Object(out)
}

fn json_list(v: &[JsonValue]) -> Value {
    Value::Array(v.iter().map(json_value_to_serde).collect())
}

/// `toolsOf(names)` of the spec
fn tools_of(names: Option<&Value>) -> Vec<JsonValue> {
    names
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|n| {
                    let name = n.as_str().unwrap_or_default();
                    json_value_from_serde(&json!({
                        "name": name,
                        "description": format!("the {name} tool"),
                        "inputSchema": { "type": "object" },
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn list_of(v: Option<&Value>) -> Vec<JsonValue> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().map(json_value_from_serde).collect())
        .unwrap_or_default()
}

/// A random temporary folder name is shown as the spec shows it.
fn scrub_text(text: &str) -> String {
    const PREFIX: &str = "seuoffice-claude-code-";
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find(PREFIX) {
        let end = at + PREFIX.len();
        out.push_str(&rest[..end]);
        let tail = &rest[end..];
        let name: String = tail.chars().take(6).collect();
        if name.chars().count() == 6 && name.chars().all(|c| c.is_ascii_alphanumeric()) {
            out.push_str("XXXXXX");
            rest = &tail[name.len()..];
        } else {
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

fn scrub(value: &mut Value) {
    match value {
        Value::String(text) => *text = scrub_text(text),
        Value::Array(items) => items.iter_mut().for_each(scrub),
        Value::Object(map) => map.values_mut().for_each(scrub),
        _ => {}
    }
}

/// The options of a case (`Opts` of the spec).
struct Opts {
    config: JsonValue,
    system: String,
    tools: Vec<JsonValue>,
    messages: Vec<JsonValue>,
    max_tokens: f64,
    user: String,
    cli_path: Option<String>,
    timeout_ms: Option<f64>,
    grace_ms: Option<f64>,
    resolve_error: Option<String>,
    pre_aborted: bool,
    base_env: Vec<(String, String)>,
}

fn opts(v: Option<&Value>) -> Opts {
    let get = |k: &str| v.and_then(|v| v.get(k));
    Opts {
        config: get("config").map_or(JsonValue::Null, json_value_from_serde),
        system: get("system")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        tools: list_of(get("tools")),
        messages: list_of(get("messages")),
        max_tokens: get("maxTokens").and_then(Value::as_f64).unwrap_or(f64::NAN),
        user: get("user")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        cli_path: get("cliPath").and_then(Value::as_str).map(str::to_owned),
        timeout_ms: get("timeoutMs").and_then(Value::as_f64),
        grace_ms: get("graceMs").and_then(Value::as_f64),
        resolve_error: get("resolveError")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
            .map(str::to_owned),
        pre_aborted: get("preAborted").and_then(Value::as_bool) == Some(true),
        base_env: match get("baseEnv").and_then(Value::as_object) {
            Some(o) => o
                .iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
                .collect(),
            None => vec![
                ("PATH".to_owned(), "/usr/bin".to_owned()),
                ("HOME".to_owned(), "/home/u".to_owned()),
                ("ANTHROPIC_API_KEY".to_owned(), "secret".to_owned()),
            ],
        },
    }
}

/// `PROGRAM` of the spec
fn program() -> SubscriptionProgram {
    SubscriptionProgram {
        provider: "claude-code".to_owned(),
        command: "/opt/claude/bin/claude".to_owned(),
        prefix_args: Vec::new(),
        env: Vec::new(),
        entry: "/opt/claude/bin/claude".to_owned(),
        source: "path".to_owned(),
    }
}

/// `depsOf(o, cx)` of the spec: the program finder is a stand-in.
fn deps_of(rt: &Rt, o: &Opts, sink: &Sink) -> ClaudeCodeCliDeps {
    let shared = SharedChildRegistry::new(rt.now());
    let temp_dirs = Rc::new(RefCell::new(SubscriptionTempState::default()));
    let locate = Rc::new(RefCell::new(SubscriptionLocateState::new(shared.clone())));
    let mut deps = ClaudeCodeCliDeps::new(shared, temp_dirs, locate);
    let sink = sink.clone();
    let resolve_error = o.resolve_error.clone();
    let resolve: ResolveProgram = Rc::new(move |cli_path| {
        note(&sink, json!(["resolve", cli_path]));
        let resolve_error = resolve_error.clone();
        Box::pin(async move {
            match resolve_error {
                Some(message) => Err(JsError::error(message)),
                None => Ok(program()),
            }
        })
    });
    deps.resolve_program = Some(resolve);
    deps.base_env = Some(o.base_env.clone());
    deps.exit_grace_ms = o.grace_ms;
    deps
}

/// `callbacksOf(cx, signal)` of the spec
fn callbacks(sink: &Sink, signal: Signal) -> StreamCallbacks {
    let log = |name: &'static str| {
        let sink = sink.clone();
        move |value: Value| note(&sink, json!([name, value]))
    };
    let delta = log("delta");
    let tool = log("tool");
    let reasoning = log("reasoning");
    let stop = log("stop");
    let usage = log("usage");
    let sub_usage = log("subusage");
    let truncated = sink.clone();
    let activity = sink.clone();
    StreamCallbacks {
        on_delta: Rc::new(move |t: JsonValue| delta(json_value_to_serde(&t))),
        on_tool_call: Rc::new(move |c: JsonValue| tool(json_value_to_serde(&c))),
        on_reasoning_delta: Some(Rc::new(move |t: JsonValue| {
            reasoning(json_value_to_serde(&t))
        })),
        on_stop_reason: Some(Rc::new(move |r: JsonValue| stop(json_value_to_serde(&r)))),
        on_usage: Some(Rc::new(move |u: JsonValue| usage(json_value_to_serde(&u)))),
        on_subscription_usage: Some(Rc::new(move |u: JsonValue| {
            sub_usage(json_value_to_serde(&u))
        })),
        on_input_truncated: Some(Rc::new(move || note(&truncated, json!(["truncated"])))),
        on_activity: Some(Rc::new(move || note(&activity, json!(["activity"])))),
        session_id: None,
        signal,
    }
}

/// Runs `body` in the case's world; its answer. The random name of the
/// temporary folder is scrubbed from the log.
fn in_world<F>(
    args: &[Value],
    cx: &mut Context,
    body: impl FnOnce(Rt, Signal, Sink, Opts) -> F,
) -> Answer
where
    F: Future<Output = Value> + 'static,
{
    let world = arg(args, 0).cloned();
    let o = opts(arg(args, 1));
    let before = cx.logs.len();
    let out = drive(world.as_ref(), cx, move |rt, signal, sink| {
        body(rt, signal, sink, o)
    })?;
    for line in cx.logs.iter_mut().skip(before) {
        line.iter_mut().for_each(scrub);
    }
    Ok(Some(out))
}

fn threw(e: &JsError) -> Value {
    json!({ "threw": describe(e) })
}

/// `{ ok: true }` or `{ threw }`
fn outcome(result: Result<(), JsError>) -> Value {
    match result {
        Ok(()) => json!({ "ok": true }),
        Err(e) => threw(&e),
    }
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- the pure part ----
        "claude-code-cli.MAX_CLAUDE_CODE_IMAGES" => Ok(Some(json!(MAX_CLAUDE_CODE_IMAGES))),
        "claude-code-cli.MODEL_NAME" => Ok(Some(json!(is_model_name(&s(args, 0))))),
        "claude-code-cli.claudeCodeCliLaunchArgs" => {
            let schema = jv(args, 1);
            let effort = jv(args, 2);
            claude_code_cli_launch_args(
                &s(args, 0),
                (!matches!(schema, JsonValue::Null)).then_some(&schema),
                (!matches!(effort, JsonValue::Null)).then_some(&effort),
            )
            .map(|list| Some(json!(list)))
            .map_err(thrown)
        }
        "claude-code-cli.claudeCodeEffort" => {
            Ok(claude_code_effort(Some(&jv(args, 0))).map(|e| json!(e)))
        }
        "claude-code-cli.claudeCodeOutputSchema" => {
            claude_code_output_schema(&tools_of(arg(args, 0)))
                .map(|schema| Some(json_value_to_serde(&schema)))
                .map_err(thrown)
        }
        "claude-code-cli.buildClaudeCodeInput" => build_claude_code_input(
            &s(args, 0),
            &list_of(arg(args, 1)),
            &list_of(arg(args, 2)),
            arg(args, 3).and_then(Value::as_f64).unwrap_or(f64::NAN),
        )
        .map(|input| {
            Some(json!({
                "initialize": json_value_to_serde(&input.initialize_json()),
                "user": json_value_to_serde(&input.user_json()),
                "truncated": input.truncated,
            }))
        })
        .map_err(thrown),
        "claude-code-cli.ClaudeCodeStructureError" => {
            let e = claude_code_structure_error("x");
            Ok(Some(
                json!({ "name": e.name, "message": e.message, "isError": e.is_error() }),
            ))
        }
        "claude-code-cli.claudeCodeUsage" => {
            Ok(Some(json_list(&claude_code_usage(Some(&jv(args, 0))))))
        }
        "claude-code-cli.reportedFailure" => {
            let code = arg(args, 0).and_then(Value::as_str);
            let status = jv(args, 1);
            let info = match jv(args, 3) {
                JsonValue::Object(o) => Some(o),
                _ => None,
            };
            Ok(Some(describe(&reported_failure(
                code,
                Some(&status),
                &s(args, 2),
                info.as_ref(),
            ))))
        }
        "claude-code-cli.exitFailure" => Ok(Some(describe(&exit_failure(
            arg(args, 0).and_then(Value::as_f64),
            &s(args, 1),
        )))),
        "claude-code-cli.startFailure" => {
            let spec = arg(args, 0);
            let error = match spec.and_then(|s| s.get("raw")) {
                Some(raw) => JsError::value(json_value_from_serde(raw)),
                None => {
                    let message = spec
                        .and_then(|s| s.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let error = JsError::error(message);
                    match spec
                        .and_then(|s| s.get("code"))
                        .and_then(Value::as_str)
                        .filter(|c| !c.is_empty())
                    {
                        Some(code) => error.with("code", JsonValue::String(code.to_owned())),
                        None => error,
                    }
                }
            };
            Ok(Some(describe(&start_failure(&error))))
        }
        "claude-code-cli.directCallInput" => {
            let tool = jv(args, 0);
            let input = jv(args, 1);
            Ok(Some(json_value_to_serde(
                &direct_call_input(
                    (!matches!(tool, JsonValue::Null)).then_some(&tool),
                    Some(&input),
                )
                .to_json(),
            )))
        }
        "claude-code-cli.claudeCodeModels" => {
            Ok(Some(json_list(&claude_code_models(Some(&jv(args, 0))))))
        }
        "claude-code-cli.TurnTextScanner" => {
            let mut scanner = TurnTextScanner::new();
            let out: Vec<Value> = arg(args, 0)
                .and_then(Value::as_array)
                .map(|chunks| {
                    chunks
                        .iter()
                        .map(|chunk| {
                            let piece = scanner.push(chunk.as_str().unwrap_or_default());
                            json!([piece, scanner.started(), scanner.complete()])
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(Some(Value::Array(out)))
        }

        // ---- parseClaudeCodeTurn, in a world for the ids ----
        "claude-code-cli.parseClaudeCodeTurn" => {
            let world = arg(args, 0).cloned();
            let raw = s(args, 1);
            let tools = tools_of(arg(args, 2));
            let prefix = arg(args, 3)
                .and_then(Value::as_str)
                .map_or_else(|| "claude".to_owned(), str::to_owned);
            drive(world.as_ref(), cx, move |rt, _signal, _sink| async move {
                match parse_claude_code_turn(&rt, &raw, &tools, &prefix) {
                    Ok(turn) => json!({
                        "turn": { "text": turn.text, "toolCalls": json_list(&turn.tool_calls) }
                    }),
                    Err(ClaudeCodeParseError::Structure(message)) => {
                        let mut e = claude_code_structure_error(message.as_str());
                        // only an answer that was not JSON at all has the parse error as its cause
                        if message.starts_with("the answer is not valid JSON") {
                            e = e.with("cause", JsonValue::Null);
                        }
                        json!({ "threw": describe(&e), "structure": true })
                    }
                    Err(ClaudeCodeParseError::Other(e)) => {
                        json!({ "threw": describe(&e), "structure": false })
                    }
                }
            })
            .map(Some)
        }

        // ---- readLines ----
        "claude-code-cli.readLines" => {
            let world = arg(args, 0).cloned();
            match drive(world.as_ref(), cx, move |rt, _signal, sink| async move {
                let child = rt
                    .spawn(SpawnRequest {
                        command: "reader".to_owned(),
                        args: Vec::new(),
                        cwd: None,
                        env: None,
                        stdio: [Stdio::Pipe; 3],
                        detached: false,
                        windows_hide: false,
                    })
                    .await?;
                child.end_stdin();
                let seen: Rc<RefCell<Vec<Value>>> = Rc::new(RefCell::new(Vec::new()));
                let overflow = Rc::new(Cell::new(0.0_f64));
                let shown = |line: &str| {
                    if length16(line) > 100 {
                        format!("<{}>", length16(line))
                    } else {
                        line.to_owned()
                    }
                };
                read_lines(
                    &child,
                    {
                        let seen = seen.clone();
                        let sink = sink.clone();
                        move |line| {
                            seen.borrow_mut().push(json!(shown(line)));
                            note(&sink, json!(["line", shown(line)]));
                        }
                    },
                    {
                        let overflow = overflow.clone();
                        let sink = sink.clone();
                        move || {
                            overflow.set(overflow.get() + 1.0);
                            note(&sink, json!(["overflow"]));
                        }
                    },
                );
                let (settle, wait) = rt.deferred::<()>();
                child.on(move |event| {
                    if matches!(event, ChildEvent::Close { .. }) {
                        settle.settle(());
                    }
                });
                wait.await;
                Ok::<Value, JsError>(json!({
                    "lines": Value::Array(seen.borrow().clone()),
                    "overflow": overflow.get(),
                }))
            }) {
                Ok(Ok(v)) => Ok(Some(v)),
                Ok(Err(e)) => Err(thrown(e)),
                Err(e) => Err(e),
            }
        }

        // ---- the turn, the chat, the model list ----
        "claude-code-cli.streamClaudeCodeCli" => {
            in_world(args, cx, |rt, signal, sink, o| async move {
                if o.pre_aborted {
                    signal.abort(None);
                }
                let cb = callbacks(&sink, signal);
                let deps = deps_of(&rt, &o, &sink);
                outcome(
                    stream_claude_code_cli(
                        &rt,
                        &o.config,
                        &o.system,
                        &o.messages,
                        &o.tools,
                        o.max_tokens,
                        &cb,
                        &deps,
                    )
                    .await,
                )
            })
        }
        "claude-code-cli.chatClaudeCodeCli" => {
            in_world(args, cx, |rt, signal, sink, o| async move {
                if o.pre_aborted {
                    signal.abort(None);
                }
                let wd = create_stream_watchdog(&rt, Some(&signal), None, None);
                let deps = deps_of(&rt, &o, &sink);
                match wd
                    .guard(chat_claude_code_cli(
                        &rt, &wd, &o.config, &o.system, &o.user, &deps,
                    ))
                    .await
                {
                    Ok(response) => json!({ "response": json_value_to_serde(&response.to_json()) }),
                    Err(e) => threw(&e),
                }
            })
        }
        "claude-code-cli.listClaudeCodeModels" => {
            in_world(args, cx, |rt, signal, sink, o| async move {
                if o.pre_aborted {
                    signal.abort(None);
                }
                let deps = deps_of(&rt, &o, &sink);
                let request = ClaudeCodeModelsRequest {
                    cli_path: o.cli_path.clone(),
                    signal,
                    timeout_ms: o.timeout_ms,
                };
                match list_claude_code_models(&rt, &request, &deps).await {
                    Ok(models) => json!({ "models": json_list(&models) }),
                    Err(e) => threw(&e),
                }
            })
        }
        _ => return None,
    })
}
