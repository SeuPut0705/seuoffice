//! Part `agent` of group `b5-provider` (tools/main-diff/groups/b5-provider/agent.ts):
//! `packages/ai-provider/src/agent-session/{codex,codex-sandbox-probe,messages,types}.ts`
//! (`agent-session.ts` only re-exports them). Names are
//! `agent-session/<file>.<export>`; the arguments are described in the spec.
//!
//! A session event, a step's outcome, the sandbox check's and the kill's
//! stand-ins are log lines `['log', 'info', ...]` written through
//! `Rt::log`, which is what `console.info` is in the TypeScript, so they come
//! in the order of the world's other lines.

use std::rc::Rc;

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Value, json};

use super::super::{Answer, CallError, Context, arg};
use super::world::{call_error, drive};
use crate::packages::ai_provider::agent_session_codex::{
    CODEX_AGENT_PROFILE, CodexAgentDeps, CodexAgentSessionOptions, ProbeSandbox,
    THREAD_START_TIMEOUT_MS, agent_sandbox_unavailable_error, codex_agent_action,
    codex_agent_approval_policy, codex_agent_filesystem, codex_agent_launch_args,
    codex_agent_readable_dirs, codex_agent_thread_params, codex_app_mcp_extra_tools,
    codex_decline_decision, codex_elicitation_answer, codex_profile_paths_literal,
    start_codex_agent_session,
};
use crate::packages::ai_provider::agent_session_codex_sandbox_probe::{
    CodexSandboxProbeDeps, CodexSandboxProbeResult, codex_sandbox_probe_args,
    codex_sandbox_probe_verdict, probe_codex_sandbox, toml_inline_table,
};
use crate::packages::ai_provider::agent_session_messages::{DECLINED_BY_PERSON, deny_message};
use crate::packages::ai_provider::agent_session_types::{
    AGENT_CODEX_WEB_SEARCH, AGENT_PERMISSION_MODES, AgentAppMcp, AgentDenyReason, AgentMcpRelay,
    AgentPermissionAnswer, AgentPermissionMode, AgentSession, AgentSessionEvent,
    AgentSessionOptions, DEFAULT_AGENT_PERMISSION_MODE, StringTable, agent_action_to_json,
    agent_permission_mode_of, is_agent_permission_mode,
};
use crate::packages::ai_provider::jsval::{Obj, as_record, as_str, number, object, text};
use crate::packages::ai_provider::subscription_locate::{
    LocateState, SubscriptionLocateOptions, SubscriptionLocateState, resolve_subscription_program,
};
use crate::packages::ai_provider::subscription_process::SharedChildRegistry;
use crate::packages::ai_provider::task::{JsError, LocalBoxFuture, Rt};
use jscompat::JsMap;
use std::cell::RefCell;

/// The module state of `locate.ts` and the shared child registry, one per call
fn locate_state(rt: &Rt) -> (LocateState, SharedChildRegistry) {
    let shared = SharedChildRegistry::new(rt.now());
    (
        Rc::new(RefCell::new(SubscriptionLocateState::new(shared.clone()))),
        shared,
    )
}

fn jv(args: &[Value], i: usize) -> JsonValue {
    arg(args, i).map_or(JsonValue::Null, json_value_from_serde)
}

fn out(value: JsonValue) -> Answer {
    Ok(Some(json_value_to_serde(&value)))
}

fn strings(value: Option<&JsonValue>) -> Vec<String> {
    match value {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|item| as_str(Some(item)).map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

fn string_list(items: &[String]) -> JsonValue {
    JsonValue::Array(items.iter().map(text).collect())
}

/// a `Record<string, string>`
fn table_of(value: &JsonValue) -> StringTable {
    let mut table = StringTable::new();
    if let Some(record) = as_record(value) {
        for (key, item) in record.entries() {
            if let Some(item) = as_str(Some(item)) {
                table.set(key, item.to_owned());
            }
        }
    }
    table
}

fn table_json(table: &StringTable) -> JsonValue {
    let mut out = Obj::new();
    for (key, value) in table.entries() {
        out.set(key, text(value));
    }
    JsonValue::Object(out)
}

fn relays_of(value: Option<&JsonValue>) -> Vec<AgentMcpRelay> {
    let Some(JsonValue::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let item = as_record(item)?;
            Some(AgentMcpRelay {
                name: as_str(item.get("name"))?.to_owned(),
                url: as_str(item.get("url")).unwrap_or("").to_owned(),
                token: as_str(item.get("token")).unwrap_or("").to_owned(),
                tools: strings(item.get("tools")),
            })
        })
        .collect()
}

/// the session options a case gives; what it leaves out is empty
fn session_options(value: &JsonValue) -> AgentSessionOptions {
    let empty = Obj::new();
    let o = as_record(value).unwrap_or(&empty);
    let get_str = |key: &str| as_str(o.get(key)).map(str::to_owned);
    AgentSessionOptions {
        project_root: get_str("projectRoot").unwrap_or_default(),
        mode: as_str(o.get("mode"))
            .and_then(agent_permission_mode_of)
            .unwrap_or(AgentPermissionMode::AskCommands),
        model: get_str("model").unwrap_or_default(),
        effort: get_str("effort"),
        cli_path: get_str("cliPath"),
        instructions: get_str("instructions").unwrap_or_default(),
        open_documents: strings(o.get("openDocuments")),
        protected_paths: strings(o.get("protectedPaths")),
        skill_bundle_dir: get_str("skillBundleDir"),
        app_mcp: as_record_of(o.get("appMcp")).map(|app| AgentAppMcp {
            url: as_str(app.get("url")).unwrap_or("").to_owned(),
            token: as_str(app.get("token")).unwrap_or("").to_owned(),
        }),
        user_mcp_relays: o.get("userMcpRelays").map(|relays| relays_of(Some(relays))),
        session_dir: get_str("sessionDir").unwrap_or_default(),
    }
}

fn as_record_of(value: Option<&JsonValue>) -> Option<&Obj> {
    value.and_then(as_record)
}

fn codex_options(value: &JsonValue) -> CodexAgentSessionOptions {
    let empty = Obj::new();
    let o = as_record(value).unwrap_or(&empty);
    CodexAgentSessionOptions {
        session: session_options(value),
        metered_accepted: o.get("meteredAccepted") == Some(&JsonValue::Bool(true)),
        web_search: as_str(o.get("webSearch")).map(str::to_owned),
        network: match o.get("network") {
            Some(JsonValue::Bool(network)) => Some(*network),
            _ => None,
        },
    }
}

fn record_or_empty(value: &JsonValue) -> Obj {
    as_record(value).cloned().unwrap_or_default()
}

/// `{ name, message, kind, problem, code, provider }`, what is there
fn error_info(error: &JsError) -> JsonValue {
    let mut info = Obj::new();
    info.set("name", text(&error.name));
    info.set("message", text(&error.message));
    for key in ["kind", "problem", "code", "provider"] {
        if let Some(value) = error.prop(key) {
            info.set(key, value.clone());
        }
    }
    JsonValue::Object(info)
}

fn thrown(error: JsError) -> CallError {
    call_error(&error)
}

fn probe_result(word: &str) -> CodexSandboxProbeResult {
    match word {
        "contained" => CodexSandboxProbeResult::Contained,
        "not-contained" => CodexSandboxProbeResult::NotContained,
        _ => CodexSandboxProbeResult::Unavailable,
    }
}

/// `killTreeLog`: `console.info('killtree', child.pid ?? null)`
fn kill_tree_log(rt: &Rt) -> Rc<dyn Fn(Option<f64>)> {
    let rt = rt.clone();
    Rc::new(move |pid| {
        rt.log(
            "info",
            vec![text("killtree"), pid.map_or(JsonValue::Null, number)],
        );
    })
}

/// `depsOf(d)`
fn deps_of(rt: &Rt, deps: &Value) -> CodexAgentDeps {
    let mut out = CodexAgentDeps::default();
    if let Some(platform) = deps.get("platform").and_then(Value::as_str) {
        out.platform = Some(platform.to_owned());
    }
    out.idle_ms = deps.get("idleMs").and_then(Value::as_f64);
    out.thread_start_timeout_ms = deps.get("threadStartTimeoutMs").and_then(Value::as_f64);
    if deps.get("killTree").and_then(Value::as_str) == Some("log") {
        out.kill_tree = Some(kill_tree_log(rt));
    }
    if let Some(word) = deps.get("probe").and_then(Value::as_str) {
        let verdict = probe_result(word);
        let rt = rt.clone();
        let probe: ProbeSandbox = Rc::new(
            move |filesystem: StringTable,
                  probe_dir: String,
                  network: bool|
                  -> LocalBoxFuture<Result<CodexSandboxProbeResult, JsError>> {
                rt.log(
                    "info",
                    vec![
                        text("probe"),
                        table_json(&filesystem),
                        text(probe_dir),
                        JsonValue::Bool(network),
                    ],
                );
                Box::pin(async move { Ok(verdict) })
            },
        );
        out.probe_sandbox = Some(probe);
    }
    out
}

fn in_world<F>(args: &[Value], cx: &mut Context, body: impl FnOnce(Rt, Value) -> F) -> Answer
where
    F: Future<Output = Result<Value, JsError>> + 'static,
{
    let world = arg(args, 0).cloned();
    let second = arg(args, 1).cloned().unwrap_or(Value::Null);
    match drive(world.as_ref(), cx, move |rt, _signal, _sink| {
        body(rt, second)
    })? {
        Ok(value) => Ok(Some(value)),
        Err(error) => Err(thrown(error)),
    }
}

/// `scenario(world, sc)`
fn run_scenario(args: &[Value], cx: &mut Context) -> Answer {
    in_world(args, cx, |rt, sc| async move {
        let empty = Value::Null;
        let options = codex_options(&json_value_from_serde(sc.get("options").unwrap_or(&empty)));
        let deps = deps_of(&rt, sc.get("deps").unwrap_or(&empty));
        let on_event: Rc<dyn Fn(&AgentSessionEvent)> = {
            let rt = rt.clone();
            Rc::new(move |event| rt.log("info", vec![text("event"), event.to_json()]))
        };
        let (locate, _shared) = locate_state(&rt);
        let session = match start_codex_agent_session(&rt, &locate, &options, on_event, &deps).await
        {
            Ok(session) => session,
            Err(error) => {
                rt.log("info", vec![text("start-failed"), error_info(&error)]);
                return Ok(json!({ "started": false }));
            }
        };
        let steps: Vec<Value> = sc
            .get("steps")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for step in &steps {
            if let Some(message) = step.get("send").and_then(Value::as_str) {
                match session.send(message).await {
                    Ok(()) => rt.log("info", vec![text("sent")]),
                    Err(error) => {
                        rt.log("info", vec![text("send-failed"), error_info(&error)]);
                    }
                }
            } else if let Some(id) = step.get("answer").and_then(Value::as_str) {
                let answer = if step.get("allow").and_then(Value::as_bool) == Some(true) {
                    AgentPermissionAnswer::Allow { scope: None }
                } else {
                    AgentPermissionAnswer::Deny {
                        message: Some("no".to_owned()),
                    }
                };
                session.answer(id, &answer);
            } else if let Some(docs) = step.get("docs") {
                session.set_open_documents(&strings(Some(&json_value_from_serde(docs))));
            } else if let Some(ms) = step.get("sleep").and_then(Value::as_f64) {
                rt.sleep(ms).await;
            } else if step.get("stop").is_some() {
                session.stop();
            }
        }
        Ok(json!({ "started": true }))
    })
}

/// `probeCodexSandbox(program, filesystem, probeDir, deps)` in a world
fn run_probe(args: &[Value], cx: &mut Context) -> Answer {
    in_world(args, cx, |rt, o| async move {
        let cli_path = o.get("cliPath").and_then(Value::as_str).map(str::to_owned);
        let (locate, shared) = locate_state(&rt);
        let program = resolve_subscription_program(
            &rt,
            &locate,
            "codex",
            &SubscriptionLocateOptions {
                configured_path: cli_path,
                ..SubscriptionLocateOptions::default()
            },
        )
        .await?;
        let filesystem = match o.get("filesystem") {
            Some(filesystem) => table_of(&json_value_from_serde(filesystem)),
            None => {
                let mut table = StringTable::new();
                table.set(":minimal", "read".to_owned());
                table
            }
        };
        let probe_dir = o
            .get("probeDir")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let deps = CodexSandboxProbeDeps {
            base_env: None,
            kill_tree: (o.get("killTree").and_then(Value::as_str) == Some("log"))
                .then(|| kill_tree_log(&rt)),
            timeout_ms: o.get("timeoutMs").and_then(Value::as_f64),
            network: o.get("network").and_then(Value::as_bool),
        };
        let result =
            probe_codex_sandbox(&rt, &shared, &program, &filesystem, &probe_dir, &deps).await?;
        Ok(Value::String(result.as_str().to_owned()))
    })
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "agent-session/codex.codexAgentLaunchArgs" => {
            let web_search = arg(args, 0).and_then(Value::as_str);
            out(string_list(&codex_agent_launch_args(web_search)))
        }
        "agent-session/codex.codexAgentApprovalPolicy" => {
            let mode = arg(args, 0)
                .and_then(Value::as_str)
                .and_then(agent_permission_mode_of);
            match mode {
                Some(mode) => Ok(Some(Value::String(
                    codex_agent_approval_policy(mode).to_owned(),
                ))),
                None => Ok(None),
            }
        }
        "agent-session/codex.codexAgentFilesystem" => {
            let readable = strings(Some(&jv(args, 1)));
            out(table_json(&codex_agent_filesystem(
                &session_options(&jv(args, 0)),
                &readable,
            )))
        }
        "agent-session/codex.codexProfilePathsLiteral" => Ok(Some(Value::Bool(
            codex_profile_paths_literal(&table_of(&jv(args, 0))),
        ))),
        "agent-session/codex.codexAgentReadableDirs" => {
            let path_value = match arg(args, 0) {
                Some(Value::String(path)) => Some(path.as_str()),
                _ => None,
            };
            let platform = arg(args, 2).and_then(Value::as_str);
            let existing = strings(Some(&jv(args, 3)));
            out(string_list(&codex_agent_readable_dirs(
                path_value,
                &session_options(&jv(args, 1)),
                platform,
                &|dir: &str| existing.iter().any(|known| known == dir),
            )))
        }
        "agent-session/codex.codexAgentThreadParams" => {
            let options = jv(args, 0);
            let network =
                as_record(&options).map(|o| o.get("network") == Some(&JsonValue::Bool(true)));
            let model = arg(args, 1).and_then(Value::as_str).unwrap_or("");
            let user_mcp = record_or_empty(&jv(args, 2));
            let readable = strings(Some(&jv(args, 3)));
            out(codex_agent_thread_params(
                &session_options(&options),
                network,
                model,
                &user_mcp,
                &readable,
            ))
        }
        "agent-session/codex.codexAgentAction" => {
            let method = arg(args, 0).and_then(Value::as_str).unwrap_or("");
            let params = record_or_empty(&jv(args, 1));
            let mut paths: JsMap<Vec<String>> = JsMap::new();
            if let JsonValue::Object(record) = jv(args, 2) {
                for (key, value) in record.entries() {
                    paths.set(key, strings(Some(value)));
                }
            }
            out(agent_action_to_json(&codex_agent_action(
                method, &params, &paths,
            )))
        }
        "agent-session/codex.codexDeclineDecision" => Ok(Some(Value::String(
            codex_decline_decision(&record_or_empty(&jv(args, 0))).to_owned(),
        ))),
        "agent-session/codex.codexAppMcpExtraTools" => {
            let relays = relays_of(Some(&jv(args, 1)));
            out(string_list(&codex_app_mcp_extra_tools(
                &jv(args, 0),
                &relays,
            )))
        }
        "agent-session/codex.codexElicitationAnswer" => {
            let relays = relays_of(Some(&jv(args, 1)));
            out(codex_elicitation_answer(
                &record_or_empty(&jv(args, 0)),
                &relays,
            ))
        }
        "agent-session/codex.THREAD_START_TIMEOUT_MS" => out(number(THREAD_START_TIMEOUT_MS)),
        "agent-session/codex.CODEX_AGENT_PROFILE" => out(text(CODEX_AGENT_PROFILE)),
        "agent-session/codex.AgentSandboxUnavailableError" => {
            let error = agent_sandbox_unavailable_error();
            out(object(vec![
                ("name", text(&error.name)),
                ("message", text(&error.message)),
                (
                    "kind",
                    error.prop("kind").cloned().unwrap_or(JsonValue::Null),
                ),
                ("isError", JsonValue::Bool(error.is_error())),
            ]))
        }
        "agent-session/codex-sandbox-probe.tomlInlineTable" => Ok(Some(Value::String(
            toml_inline_table(&table_of(&jv(args, 0))),
        ))),
        "agent-session/codex-sandbox-probe.codexSandboxProbeArgs" => {
            let network = arg(args, 2).and_then(Value::as_bool) == Some(true);
            let dir = arg(args, 1).and_then(Value::as_str).unwrap_or("");
            let probe = codex_sandbox_probe_args(&table_of(&jv(args, 0)), dir, network);
            out(object(vec![
                ("args", string_list(&probe.args)),
                ("readable", text(&probe.readable)),
                ("denied", text(&probe.denied)),
            ]))
        }
        "agent-session/codex-sandbox-probe.codexSandboxProbeVerdict" => {
            let stdout = arg(args, 0).and_then(Value::as_str).unwrap_or("");
            Ok(Some(Value::String(
                codex_sandbox_probe_verdict(stdout).as_str().to_owned(),
            )))
        }
        "agent-session/messages.DECLINED_BY_PERSON" => {
            Ok(Some(Value::String(DECLINED_BY_PERSON.to_owned())))
        }
        "agent-session/messages.denyMessage" => {
            let reason = match arg(args, 0).and_then(Value::as_str) {
                Some("open-document") => AgentDenyReason::OpenDocument,
                Some("outside-project") => AgentDenyReason::OutsideProject,
                _ => AgentDenyReason::ProtectedPath,
            };
            Ok(Some(Value::String(deny_message(reason).to_owned())))
        }
        "agent-session/types.AGENT_PERMISSION_MODES" => Ok(Some(json!(AGENT_PERMISSION_MODES))),
        "agent-session/types.DEFAULT_AGENT_PERMISSION_MODE" => Ok(Some(Value::String(
            DEFAULT_AGENT_PERMISSION_MODE.to_owned(),
        ))),
        "agent-session/types.AGENT_CODEX_WEB_SEARCH" => Ok(Some(json!(AGENT_CODEX_WEB_SEARCH))),
        "agent-session/types.isAgentPermissionMode" => Ok(Some(Value::Bool(
            is_agent_permission_mode(Some(&jv(args, 0))),
        ))),
        "agent-session/codex-sandbox-probe.probeCodexSandbox" => run_probe(args, cx),
        "agent-session/codex.startCodexAgentSession" => run_scenario(args, cx),
        _ => return None,
    })
}
