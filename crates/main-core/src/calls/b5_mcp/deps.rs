//! Group `b5-mcp`, slice `deps`: see tools/main-diff/groups/b5-mcp/deps.ts.
//!
//! The pieces of packages the MCP modules call: `redact-core`, the agent
//! session policy and its constants, the subscription CLI directory lists and
//! process registry, the Google sign-in page, the diagram ops table and the
//! Drive token check. The process calls of `killProcessTree` and the registry
//! are fakes the spec describes; each call of a fake is one `logs` line, as
//! the TypeScript writes it.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;

use serde_json::{Map, Value};

use super::super::{Answer, CallError, Context, arg, str_arg};
use crate::node_fs::namespaced;
use crate::packages::agent_core::redact_core::{
    MAX_LABEL_LENGTH, PlaceholderSpec, check_placeholders, collect_placeholders,
    is_whole_placeholder, placeholder_instruction, placeholder_source, read_placeholder_label,
    sanitize_label,
};
use crate::packages::ai_provider::agent_session_claude::{
    AGENT_APP_MCP_TOOLS, APP_MCP_SERVER_NAME,
};
use crate::packages::ai_provider::agent_session_policy::{
    AgentAction, AgentActionKind, AgentPermissionMode, AgentPolicyContext, AgentPolicyVerdict,
    AgentSessionAllowances, agent_policy_verdict, comparable_path, is_inside_path,
    process_platform, web_host_of,
};
use crate::packages::ai_provider::settings_secrets::CodecThrow;
use crate::packages::ai_provider::subscription_locate::{
    common_unix_bin_dirs, is_full_dir, path_dirs,
};
use crate::packages::ai_provider::subscription_process::{
    ChildTicket, KillHost, KillTreeOptions, KillerSpawn, SUBSCRIPTION_LEFTOVER_FILE_PREFIX, Signal,
    SubscriptionChildHost, SubscriptionChildRegistry, TrackedChildInfo, USER_MCP_CHILD_KIND,
    create_subscription_child_registry, kill_process_tree, leftover_record_file, on_kill_timeout,
    on_killer_error, windows_system_dir, windows_system_tool,
};
use crate::packages::drawio_model::ops::{DIAGRAM_OP_NAMES, DIAGRAM_OPS};
use crate::packages::google_drive::oauth::{SignInPage, sign_in_page_html};
use crate::shell::ai_secrets::SafeStorageLike;
use crate::shell::drive::drive_vault::drive_token_seals;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- agent-core/redact-core ----
        "agent-core/redact-core.MAX_LABEL_LENGTH" => Ok(Some(Value::from(MAX_LABEL_LENGTH as f64))),
        "agent-core/redact-core.sanitizeLabel" => str_arg(args, 0).map(|raw| {
            let for_comment = arg(args, 1).is_some_and(truthy);
            Some(Value::from(sanitize_label(raw, for_comment)))
        }),
        "agent-core/redact-core.placeholderSource" => {
            str_arg(args, 0).map(|label| Some(Value::from(placeholder_source(label))))
        }
        "agent-core/redact-core.isWholePlaceholder" => {
            str_arg(args, 0).map(|text| Some(Value::Bool(is_whole_placeholder(text))))
        }
        "agent-core/redact-core.readPlaceholderLabel" => str_arg(args, 0)
            .map(|text| Some(read_placeholder_label(text).map_or(Value::Null, Value::from))),
        "agent-core/redact-core.collectPlaceholders" => str_arg(args, 0).map(|text| {
            Some(Value::Array(
                collect_placeholders(text)
                    .into_iter()
                    .map(Value::from)
                    .collect(),
            ))
        }),
        "agent-core/redact-core.checkPlaceholders" => (|| {
            let before = str_arg(args, 0)?;
            let after = str_arg(args, 1)?;
            Ok(Some(Value::Array(
                check_placeholders(before, after)
                    .into_iter()
                    .map(|issue| {
                        object(vec![
                            ("found", Value::from(issue.found)),
                            ("expected", Value::from(issue.expected)),
                            ("reason", Value::from(issue.reason.as_str())),
                        ])
                    })
                    .collect(),
            )))
        })(),
        "agent-core/redact-core.placeholderInstruction" => {
            let labels = strings(arg(args, 0));
            let spec = arg(args, 1).unwrap_or(&Value::Null);
            let spec = PlaceholderSpec {
                subject: field_str(spec, "subject"),
                opening: field_str(spec, "opening"),
                boundary: field_str(spec, "boundary"),
                middle: strings(spec.get("middle")),
            };
            Ok(Some(Value::from(placeholder_instruction(&labels, &spec))))
        }

        // ---- ai-provider/agent-session/policy ----
        "ai-provider/agent-session/policy.comparablePath" => (|| {
            let path = str_arg(args, 0)?;
            let base = str_arg(args, 1)?;
            Ok(Some(Value::from(comparable_path(
                path,
                base,
                platform_arg(args, 2),
            ))))
        })(),
        "ai-provider/agent-session/policy.isInsidePath" => (|| {
            let child = str_arg(args, 0)?;
            let root = str_arg(args, 1)?;
            Ok(Some(Value::Bool(is_inside_path(
                child,
                root,
                platform_arg(args, 2),
            ))))
        })(),
        "ai-provider/agent-session/policy.webHostOf" => {
            Ok(web_host_of(arg(args, 0).and_then(Value::as_str)).map(Value::from))
        }
        "ai-provider/agent-session/policy.agentPolicyVerdict" => policy_call(args),

        // ---- ai-provider/agent-session/claude ----
        "ai-provider/agent-session/claude.AGENT_APP_MCP_TOOLS" => Ok(Some(Value::Array(
            AGENT_APP_MCP_TOOLS
                .iter()
                .map(|t| Value::from(*t))
                .collect(),
        ))),
        "ai-provider/agent-session/claude.APP_MCP_SERVER_NAME" => {
            Ok(Some(Value::from(APP_MCP_SERVER_NAME)))
        }

        // ---- ai-provider/subscription/locate ----
        "ai-provider/subscription/locate.isFullDir" => {
            str_arg(args, 0).map(|dir| Some(Value::Bool(is_full_dir(dir))))
        }
        "ai-provider/subscription/locate.pathDirs" => (|| {
            let env = env_of(arg(args, 0));
            let platform = str_arg(args, 1)?;
            Ok(Some(string_array(path_dirs(
                &|key: &str| env.get(key),
                platform,
            ))))
        })(),
        "ai-provider/subscription/locate.commonUnixBinDirs" => (|| {
            let home = str_arg(args, 0)?;
            let env = env_of(arg(args, 1));
            let platform = str_arg(args, 2)?;
            Ok(Some(string_array(common_unix_bin_dirs(
                home,
                &|key: &str| env.get(key),
                platform,
            ))))
        })(),

        // ---- ai-provider/subscription/process ----
        "ai-provider/subscription/process.USER_MCP_CHILD_KIND" => {
            Ok(Some(Value::from(USER_MCP_CHILD_KIND)))
        }
        "ai-provider/subscription/process.SUBSCRIPTION_LEFTOVER_FILE_PREFIX" => {
            Ok(Some(Value::from(SUBSCRIPTION_LEFTOVER_FILE_PREFIX)))
        }
        "ai-provider/subscription/process.leftoverRecordFile" => (|| {
            let dir = str_arg(args, 0)?;
            let pid = number_arg(args, 1)?;
            Ok(Some(Value::from(leftover_record_file(dir, pid))))
        })(),
        "ai-provider/subscription/process.windowsSystemDir" => {
            let env = env_of(arg(args, 0));
            Ok(Some(Value::from(windows_system_dir(&|key: &str| {
                env.get(key)
            }))))
        }
        "ai-provider/subscription/process.windowsSystemTool" => {
            let env = env_of(arg(args, 0));
            let segments = strings(arg(args, 1));
            let segments: Vec<&str> = segments.iter().map(String::as_str).collect();
            Ok(Some(Value::from(windows_system_tool(
                &|key: &str| env.get(key),
                &segments,
            ))))
        }
        "ai-provider/subscription/process.killProcessTree" => kill_call(args, cx),
        "ai-provider/subscription/process.registryScenario" => registry_call(args, cx),

        // ---- google-drive/oauth ----
        "google-drive/oauth.signInPageHtml" => {
            let page = arg(args, 0).unwrap_or(&Value::Null);
            Ok(Some(Value::from(sign_in_page_html(&SignInPage {
                lang: field_str(page, "lang"),
                title: field_str(page, "title"),
                body: field_str(page, "body"),
            }))))
        }

        // ---- drawio-model/ops ----
        "drawio-model/ops.DIAGRAM_OP_NAMES" => Ok(Some(Value::Array(
            DIAGRAM_OP_NAMES.iter().map(|n| Value::from(*n)).collect(),
        ))),
        "drawio-model/ops.DIAGRAM_OPS" => Ok(Some(
            serde_json::to_value(&*DIAGRAM_OPS).expect("the ops table serializes"),
        )),

        // ---- drive/drive-vault ----
        "drive-vault.driveTokenSeals" => (|| {
            let storage = FakeStorage::from_spec(arg(args, 0).unwrap_or(&Value::Null));
            let platform = str_arg(args, 1)?;
            Ok(Some(Value::Bool(drive_token_seals(&storage, platform))))
        })(),

        _ => return None,
    })
}

// ---- JSON helpers ----

fn object(entries: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// the strings of a JSON array (nothing else is in the specs' lists)
fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}

fn string_array(items: Vec<String>) -> Value {
    Value::Array(items.into_iter().map(Value::from).collect())
}

fn field_str(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn opt_field_str(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn number_arg(args: &[Value], i: usize) -> Result<f64, CallError> {
    arg(args, i)
        .and_then(Value::as_f64)
        .ok_or_else(|| CallError::plain(format!("argument {i} is not a number")))
}

/// the platform argument: `null` or left out is `undefined`
fn platform_arg(args: &[Value], i: usize) -> Option<&str> {
    arg(args, i).and_then(Value::as_str)
}

/// `{ NAME: value }`: a variable that is not there is left out
struct Env(Map<String, Value>);

impl Env {
    fn get(&self, key: &str) -> Option<String> {
        self.0.get(key).and_then(Value::as_str).map(str::to_owned)
    }
}

fn env_of(spec: Option<&Value>) -> Env {
    Env(spec.and_then(Value::as_object).cloned().unwrap_or_default())
}

// ---- agentPolicyVerdict ----

fn policy_call(args: &[Value]) -> Answer {
    let null = Value::Null;
    let action = arg(args, 0).unwrap_or(&null);
    let ctx = arg(args, 1).unwrap_or(&null);
    let kind = match field_str(action, "kind").as_str() {
        "read" => AgentActionKind::Read,
        "write" => AgentActionKind::Write,
        "command" => AgentActionKind::Command,
        "app-tool" => AgentActionKind::AppTool,
        "mcp-tool" => AgentActionKind::McpTool,
        "skill" => AgentActionKind::Skill,
        "web-search" => AgentActionKind::WebSearch,
        "web-fetch" => AgentActionKind::WebFetch,
        "other" => AgentActionKind::Other,
        other => return Err(CallError::plain(format!("no such action kind: {other}"))),
    };
    let action = AgentAction {
        kind,
        tool: field_str(action, "tool"),
        command: opt_field_str(action, "command"),
        summary: opt_field_str(action, "summary"),
        paths: strings(action.get("paths")),
        cwd: opt_field_str(action, "cwd"),
        reason: opt_field_str(action, "reason"),
        target: opt_field_str(action, "target"),
        host: opt_field_str(action, "host"),
        server: opt_field_str(action, "server"),
    };
    let mode = match field_str(ctx, "mode").as_str() {
        "ask-commands" => AgentPermissionMode::AskCommands,
        "ask-writes" => AgentPermissionMode::AskWrites,
        "trust-project" => AgentPermissionMode::TrustProject,
        other => return Err(CallError::plain(format!("no such mode: {other}"))),
    };
    let allowances =
        ctx.get("allowances")
            .filter(|a| a.is_object())
            .map(|a| AgentSessionAllowances {
                web_search: a.get("webSearch").is_some_and(truthy),
                web_hosts: strings(a.get("webHosts"))
                    .into_iter()
                    .collect::<HashSet<_>>(),
            });
    let project_root = field_str(ctx, "projectRoot");
    let open_documents = strings(ctx.get("openDocuments"));
    let protected_paths = strings(ctx.get("protectedPaths"));
    let skill_bundle_dir = opt_field_str(ctx, "skillBundleDir");
    let platform = opt_field_str(ctx, "platform");
    let verdict = agent_policy_verdict(
        &action,
        &AgentPolicyContext {
            mode,
            project_root: &project_root,
            open_documents: &open_documents,
            protected_paths: &protected_paths,
            skill_bundle_dir: skill_bundle_dir.as_deref(),
            allowances: allowances.as_ref(),
            platform: platform.as_deref(),
        },
    );
    Ok(Some(match verdict {
        AgentPolicyVerdict::Allow => object(vec![("decision", Value::from("allow"))]),
        AgentPolicyVerdict::Ask => object(vec![("decision", Value::from("ask"))]),
        AgentPolicyVerdict::Deny(reason) => object(vec![
            ("decision", Value::from("deny")),
            ("reason", Value::from(reason.as_str())),
        ]),
    }))
}

// ---- killProcessTree ----

#[derive(Clone, Copy, PartialEq, Eq)]
enum KillMode {
    Ok,
    AllThrow,
    GroupThrows,
    SingleThrows,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SpawnMode {
    Ok,
    Throws,
    NoUnref,
    UnrefThrows,
    ErrorEvent,
}

/// the `kill`, `spawn` and `setTimeout` fakes of the spec: each call is a log
/// line
struct FakeKillHost<'a> {
    cx: &'a mut Context,
    kill_mode: KillMode,
    spawn_mode: SpawnMode,
    /// the pids whose killer was started, for an `error` event after the call
    killers: Vec<f64>,
    /// the pids of the timers set, fired after the call in order
    timers: Vec<f64>,
}

impl KillHost for FakeKillHost<'_> {
    fn process_platform(&self) -> String {
        process_platform().to_owned()
    }

    fn env_var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }

    fn kill(&mut self, pid: f64, signal: Option<Signal>) -> Result<(), String> {
        self.cx.logs.push(vec![
            Value::from("kill"),
            Value::from(pid),
            signal.map_or(Value::Null, |s| Value::from(s.as_str())),
        ]);
        let throws = match self.kill_mode {
            KillMode::Ok => false,
            KillMode::AllThrow => true,
            KillMode::GroupThrows => pid < 0.0,
            KillMode::SingleThrows => pid > 0.0,
        };
        if throws {
            Err("ESRCH".to_owned())
        } else {
            Ok(())
        }
    }

    fn spawn_killer(
        &mut self,
        pid: f64,
        command: &str,
        args: &[String],
        options: &KillerSpawn,
    ) -> Result<u64, String> {
        self.cx.logs.push(vec![
            Value::from("spawn"),
            Value::from(command),
            Value::Array(args.iter().cloned().map(Value::from).collect()),
            object(vec![
                ("cwd", Value::from(options.cwd.as_str())),
                ("stdio", Value::from(options.stdio)),
                ("windowsHide", Value::Bool(options.windows_hide)),
            ]),
        ]);
        if self.spawn_mode == SpawnMode::Throws {
            return Err("spawn failed".to_owned());
        }
        self.cx
            .logs
            .push(vec![Value::from("once"), Value::from("error")]);
        self.killers.push(pid);
        Ok(1)
    }

    fn unref_killer(&mut self, _killer: u64) -> Result<(), String> {
        if self.spawn_mode == SpawnMode::NoUnref {
            return Ok(());
        }
        self.cx.logs.push(vec![Value::from("unref killer")]);
        if self.spawn_mode == SpawnMode::UnrefThrows {
            return Err("unref failed".to_owned());
        }
        Ok(())
    }

    fn set_kill_timeout(&mut self, ms: f64, pid: f64) -> u64 {
        self.cx
            .logs
            .push(vec![Value::from("setTimeout"), Value::from(ms)]);
        self.timers.push(pid);
        self.timers.len() as u64
    }

    fn unref_timer(&mut self, _timer: u64) {
        self.cx.logs.push(vec![Value::from("unref timer")]);
    }
}

fn kill_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 1).cloned().unwrap_or(Value::Null);
    let pid = match arg(args, 0) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::Object(o)) => o.get("pid").and_then(Value::as_f64),
        _ => None,
    };
    let mut host = FakeKillHost {
        cx,
        kill_mode: match opt_field_str(&spec, "kill").as_deref() {
            Some("allThrow") => KillMode::AllThrow,
            Some("groupThrows") => KillMode::GroupThrows,
            Some("singleThrows") => KillMode::SingleThrows,
            _ => KillMode::Ok,
        },
        spawn_mode: match opt_field_str(&spec, "spawn").as_deref() {
            Some("throws") => SpawnMode::Throws,
            Some("noUnref") => SpawnMode::NoUnref,
            Some("unrefThrows") => SpawnMode::UnrefThrows,
            Some("errorEvent") => SpawnMode::ErrorEvent,
            _ => SpawnMode::Ok,
        },
        killers: Vec::new(),
        timers: Vec::new(),
    };
    let platform = opt_field_str(&spec, "platform");
    let env = spec.get("env").map(|_| env_of(spec.get("env")));
    let env_get = |key: &str| env.as_ref().and_then(|e| e.get(key));
    let options = KillTreeOptions {
        force: spec.get("force").is_some_and(truthy),
        grace_ms: spec.get("graceMs").and_then(Value::as_f64),
        platform: platform.as_deref(),
        env: env
            .as_ref()
            .map(|_| &env_get as &dyn Fn(&str) -> Option<String>),
    };
    kill_process_tree(pid, &options, &mut host);
    if host.spawn_mode == SpawnMode::ErrorEvent {
        for pid in host.killers.clone() {
            on_killer_error(pid, &mut host);
        }
    }
    for pid in host.timers.clone() {
        on_kill_timeout(pid, &mut host);
    }
    Ok(None)
}

// ---- the registry ----

/// `process.pid` and the start time of the owner, fixed on both sides
const OWNER_PID: f64 = 4242.0;
const OWNER_STARTED_AT: f64 = 1_700_000_000_000.0;

/// the `killTree` fake and the file system of the case's folder
struct FakeChildHost<'a> {
    cx: &'a mut Context,
    now: f64,
    kill_throws: Vec<f64>,
}

/// `rm(path, { force: true })`: a file that is not there is fine
fn remove_forced(path: &str) -> Result<(), String> {
    match fs::remove_file(namespaced(path)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

impl SubscriptionChildHost for FakeChildHost<'_> {
    fn now_ms(&mut self) -> f64 {
        self.now
    }

    fn owner(&self) -> (f64, f64) {
        (OWNER_PID, OWNER_STARTED_AT)
    }

    fn kill_tree(&mut self, pid: f64) -> Result<(), String> {
        self.cx
            .logs
            .push(vec![Value::from("killTree"), Value::from(pid)]);
        if self.kill_throws.contains(&pid) {
            return Err("kill failed".to_owned());
        }
        Ok(())
    }

    fn mkdir_p(&mut self, dir: &str) -> Result<(), String> {
        fs::create_dir_all(namespaced(dir)).map_err(|e| e.to_string())
    }

    fn write_file(&mut self, path: &str, text: &str) -> Result<(), String> {
        fs::write(namespaced(path), text).map_err(|e| e.to_string())
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        fs::rename(namespaced(from), namespaced(to)).map_err(|e| e.to_string())
    }

    fn remove_sync(&mut self, path: &str) -> Result<(), String> {
        remove_forced(path)
    }

    fn remove(&mut self, path: &str) -> Result<(), String> {
        remove_forced(path)
    }
}

fn registry_call(args: &[Value], cx: &mut Context) -> Answer {
    let opts = arg(args, 0).cloned().unwrap_or(Value::Null);
    let steps = arg(args, 1)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let kill_throws: Vec<f64> = opts
        .get("killThrows")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_f64)
        .collect();
    let mut host = FakeChildHost {
        now: cx.now_ms,
        cx,
        kill_throws,
    };
    let mut registry: SubscriptionChildRegistry = create_subscription_child_registry();
    // name to the ticket `track` answered and whether the child's `exit`
    // listener is still there
    let mut children: HashMap<String, (Option<ChildTicket>, bool)> = HashMap::new();
    let mut answers: Vec<Value> = Vec::new();
    for step in &steps {
        if let Some(name) = step.get("track").and_then(Value::as_str) {
            let info = TrackedChildInfo {
                provider: field_str(step, "provider"),
                command: field_str(step, "command"),
                started_at: step.get("startedAt").and_then(Value::as_f64),
            };
            let pid = step.get("pid").and_then(Value::as_f64);
            let ticket = registry.track(pid, &info, &mut host);
            children.insert(name.to_owned(), (ticket, ticket.is_some()));
            answers.push(Value::Null);
        } else if let Some(name) = step.get("forget").and_then(Value::as_str) {
            if let Some((Some(ticket), _)) = children.get(name).copied() {
                registry.forget(ticket, &mut host);
            }
            answers.push(Value::Null);
        } else if let Some(name) = step.get("exit").and_then(Value::as_str) {
            if let Some((Some(ticket), true)) = children.get(name).copied() {
                children.insert(name.to_owned(), (Some(ticket), false));
                registry.forget(ticket, &mut host);
            }
            answers.push(Value::Null);
        } else if let Some(dir) = step.get("recordIn") {
            registry.record_in(dir.as_str(), &mut host);
            answers.push(Value::Null);
        } else if step.get("shutdown").is_some_and(truthy) {
            registry.shutdown(&mut host);
            answers.push(Value::Null);
        } else if step.get("size").is_some_and(truthy) {
            answers.push(Value::from(registry.size() as f64));
        }
    }
    Ok(Some(object(vec![
        ("answers", Value::Array(answers)),
        ("size", Value::from(registry.size() as f64)),
    ])))
}

// ---- driveTokenSeals ----

/// a fake `safeStorage` the spec describes: `{ available, backend? }`
struct FakeStorage {
    available: bool,
    backend: Option<Option<String>>,
}

impl FakeStorage {
    fn from_spec(spec: &Value) -> FakeStorage {
        FakeStorage {
            available: spec.get("available").is_some_and(truthy),
            backend: spec.get("backend").map(|b| b.as_str().map(str::to_owned)),
        }
    }
}

impl SafeStorageLike for FakeStorage {
    fn is_encryption_available(&self) -> bool {
        self.available
    }

    fn encrypt_string(&self, plain: &str) -> Result<Vec<u8>, CodecThrow> {
        Ok(format!("enc:{plain}").into_bytes())
    }

    fn decrypt_string(&self, sealed: &[u8]) -> Result<String, CodecThrow> {
        Ok(String::from_utf8_lossy(sealed).chars().skip(4).collect())
    }

    fn get_selected_storage_backend(&self) -> Option<String> {
        // `undefined`, `null` and a missing method read the same
        self.backend.clone().flatten()
    }
}
