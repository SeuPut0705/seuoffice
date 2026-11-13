//! Part `subscription` of group `b5-provider`
//! (tools/main-diff/groups/b5-provider/subscription.ts):
//! `packages/ai-provider/src/subscription/{contract,env,models,old-names,
//! temp-dirs,leftovers,metered,locate,process}.ts`, by `subscription/<file>.<export>`.
//!
//! The pure functions take their arguments as given. The ones that touch the
//! machine run in the scripted world (the first argument); `o`, the second,
//! is what the spec documents. What the TypeScript reads of its own process
//! and a case cannot set is fixed the same way on both sides: the process
//! uptime is 5 s, `SUBSCRIPTION_OWNER_STARTED_AT` is `OWNER_STARTED_AT` here
//! (a record file writes `"$OWNER"` where it means it, and the number is put
//! back as the token after the call), and the module state is made fresh for
//! each call.

use std::cell::RefCell;
use std::fs;
use std::rc::Rc;

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg};
use super::world::{Sink, call_error, drive, note};
use crate::packages::ai_provider::jsval::Obj;
use crate::packages::ai_provider::subscription_contract::{
    SUBSCRIPTION_ACCOUNT_MAX_LENGTH, SUBSCRIPTION_CHATGPT_USAGE_URL, SUBSCRIPTION_INSTALL_COMMANDS,
    SUBSCRIPTION_INSTALL_URLS, SUBSCRIPTION_IPC_CHANNELS, SUBSCRIPTION_MIN_VERSIONS,
    SUBSCRIPTION_MODELS_MAX, SUBSCRIPTION_UPDATE_COMMANDS, checking_subscription_status,
    checking_subscription_statuses, is_subscription_provider_id, off_subscription_status,
    subscription_account_of, subscription_launch_result_of, subscription_login_error_code_test,
    subscription_login_failure_of, subscription_metered_result_of, subscription_models_of,
    subscription_needs_update, subscription_off_result_of, subscription_program_path_of,
    subscription_status_error_kind, subscription_status_error_text, subscription_status_map_of,
    subscription_version_at_least, subscription_version_of,
};
use crate::packages::ai_provider::subscription_env::{
    SUBSCRIPTION_STRIPPED_ENV_VARS, SubscriptionEnvOptions, subscription_child_env,
};
use crate::packages::ai_provider::subscription_leftovers::{
    LeftoverCleanupDeps, ProcessInfo, ProcessInspectionDeps, ProcessInspector,
    cleanup_leftover_subscription_children, init_subscription_child_tracking, inspect_processes,
};
use crate::packages::ai_provider::subscription_locate::{
    LocateState, SubscriptionLocateOptions, SubscriptionLocateState, SubscriptionNodeRuntime,
    SubscriptionProgram, SubscriptionVersionReader, locate_subscription_program,
    resolve_subscription_program, subscription_provider_label,
};
use crate::packages::ai_provider::subscription_metered::{
    METERED_LOGIN_FINGERPRINTS, SUBSCRIPTION_METERED_FILE, create_metered_acceptance_file_store,
    metered_login_fingerprint, reconcile_metered_acceptance,
};
use crate::packages::ai_provider::subscription_models::{
    SUBSCRIPTION_MODELS_TIMEOUT_MS, SubscriptionModelListOptions, SubscriptionModelSource,
    SubscriptionModelsState, list_subscription_models, set_subscription_model_source,
};
use crate::packages::ai_provider::subscription_old_names::OLD_TRACKED_TEMP_PREFIXES;
use crate::packages::ai_provider::subscription_process::{
    ChildTicket, RegistryChoice, SharedChildRegistry, SubscriptionRunOptions,
    SubscriptionSpawnOptions, TrackedChildInfo, run_subscription_program,
    spawn_subscription_program, track_subscription_child,
};
use crate::packages::ai_provider::subscription_status::SubscriptionDetection;
use crate::packages::ai_provider::subscription_temp_dirs::{
    CleanupTempDirsOptions, SubscriptionTempState, TRACKED_TEMP_PREFIXES, TempDirOptions, TempDirs,
    cleanup_tracked_temp_dirs, create_tracked_temp_dir, remove_tracked_temp_dir,
};
use crate::packages::ai_provider::task::{
    Child, ChildEvent, JsError, LocalBoxFuture, Rt, Signal, SpawnRequest, Stdio,
};

/// `SUBSCRIPTION_OWNER_STARTED_AT` of this side
const OWNER_STARTED_AT: f64 = 1_794_452_390_000.0;
const OWNER_TOKEN: &str = "\"$OWNER\"";
const OWNER_TEXT: &str = "1794452390000";

// ---------------------------------------------------------------------------
// reading the arguments
// ---------------------------------------------------------------------------

fn jv(args: &[Value], i: usize) -> Option<JsonValue> {
    arg(args, i).map(json_value_from_serde)
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

fn num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn out(value: JsonValue) -> Answer {
    Ok(Some(json_value_to_serde(&value)))
}

fn opt_out(value: Option<JsonValue>) -> Answer {
    Ok(Some(
        value.as_ref().map_or(Value::Null, json_value_to_serde),
    ))
}

/// `value` as `undefined` when it is `None`
fn or_undefined(value: Option<JsonValue>) -> Answer {
    Ok(value.as_ref().map(json_value_to_serde))
}

fn table(pairs: &[(&str, &str)]) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        map.insert((*key).to_owned(), Value::String((*value).to_owned()));
    }
    Value::Object(map)
}

fn optional_table(pairs: &[(&str, Option<&str>)]) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        map.insert(
            (*key).to_owned(),
            value.map_or(Value::Null, |v| Value::String(v.to_owned())),
        );
    }
    Value::Object(map)
}

fn constant(value: Value) -> Answer {
    Ok(Some(value))
}

/// `{ name: value }` pairs of a JSON object whose values are strings
fn pairs(value: Option<&Value>) -> Vec<(String, String)> {
    value
        .and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
                .collect()
        })
        .unwrap_or_default()
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|v| v.as_str().unwrap_or_default().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn key_str(o: Option<&Value>, key: &str) -> Option<String> {
    o.and_then(|o| o.get(key))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn key_f64(o: Option<&Value>, key: &str) -> Option<f64> {
    o.and_then(|o| o.get(key)).and_then(Value::as_f64)
}

fn key_flag(o: Option<&Value>, key: &str) -> bool {
    o.and_then(|o| o.get(key)).and_then(Value::as_bool) == Some(true)
}

fn pairs_json(list: &[(String, String)]) -> Value {
    Value::Array(list.iter().map(|(k, v)| json!([k, v])).collect())
}

fn object_json(list: &[(String, String)]) -> Value {
    let mut map = Map::new();
    for (key, value) in list {
        map.insert(key.clone(), Value::String(value.clone()));
    }
    Value::Object(map)
}

/// Runs `body` in the case's world; its value (`None`: `undefined`) or what it threw.
fn in_world<F>(
    args: &[Value],
    cx: &mut Context,
    body: impl FnOnce(Rt, Signal, Sink, Value) -> F,
) -> Answer
where
    F: Future<Output = Result<Option<Value>, JsError>> + 'static,
{
    let world = arg(args, 0).cloned();
    let o = arg(args, 1).cloned().unwrap_or(Value::Null);
    match drive(world.as_ref(), cx, move |rt, signal, sink| {
        body(rt, signal, sink, o)
    })? {
        Ok(v) => Ok(v),
        Err(e) => Err(thrown(e)),
    }
}

/// `$OWNER` is this side's number while `body` runs
fn with_owner(dir: Option<&str>, body: impl FnOnce() -> Answer) -> Answer {
    swap_in_files(dir, OWNER_TOKEN, OWNER_TEXT);
    let answer = body();
    swap_in_files(dir, OWNER_TEXT, OWNER_TOKEN);
    answer
}

/// The files of the folder `dir`: `from` is put back as `to` in each (a flat folder)
fn swap_in_files(dir: Option<&str>, from: &str, to: &str) {
    let Some(dir) = dir else {
        return;
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Ok(text) = fs::read_to_string(&path)
            && text.contains(from)
        {
            let _ = fs::write(&path, text.replace(from, to));
        }
    }
}

/// The temp-dir records of `dir`, read and removed (their names carry the folder's real path)
fn take_temp_records(dir: Option<&str>) -> Vec<Value> {
    let Some(dir) = dir else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| {
            name.len() == "ai-temp-dir-".len() + 16 + ".json".len()
                && name.starts_with("ai-temp-dir-")
                && name.ends_with(".json")
                && name["ai-temp-dir-".len()..name.len() - ".json".len()]
                    .chars()
                    .all(|c| matches!(c, '0'..='9' | 'a'..='f'))
        })
        .collect();
    names.sort();
    let mut records = Vec::new();
    for name in &names {
        let path = std::path::Path::new(dir).join(name);
        if let Ok(text) = fs::read_to_string(&path)
            && let Ok(value) = serde_json::from_str::<Value>(&text)
        {
            records.push(value);
        }
        let _ = fs::remove_file(&path);
    }
    records
}

/// The state of the temp-dir module: the record directory the case sets, an
/// uptime of 5 s, and a pid that is alive as the world's `process.kill` says
/// (it logs `['killpid', pid, 0]` and answers that it is).
fn temp_state(module_dir: Option<String>, sink: &Sink) -> TempDirs {
    let sink = sink.clone();
    Rc::new(RefCell::new(SubscriptionTempState {
        record_dir: module_dir,
        uptime_ms: Rc::new(|| 5000.0),
        alive: Rc::new(move |pid: f64| {
            if !(pid.is_finite() && pid.fract() == 0.0 && pid > 0.0) {
                return false;
            }
            note(&sink, json!(["killpid", num(pid), 0]));
            true
        }),
    }))
}

// ---------------------------------------------------------------------------
// the programs
// ---------------------------------------------------------------------------

fn program_json(program: &SubscriptionProgram) -> Value {
    json!({
        "provider": program.provider,
        "command": program.command,
        "prefixArgs": program.prefix_args,
        "env": object_json(&program.env),
        "entry": program.entry,
        "source": program.source,
    })
}

fn program_of(v: &Value) -> SubscriptionProgram {
    let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    SubscriptionProgram {
        provider: text("provider"),
        command: text("command"),
        prefix_args: strings(v.get("prefixArgs")),
        env: pairs(v.get("env")),
        entry: text("entry"),
        source: text("source"),
    }
}

/// `{ ...PROGRAM, ...o.program }`
fn merged_program(extra: Option<&Value>) -> SubscriptionProgram {
    let mut base = json!({
        "provider": "claude-code",
        "command": "/opt/claude/bin/claude",
        "prefixArgs": [],
        "env": {},
        "entry": "/opt/claude/bin/claude",
        "source": "path",
    });
    if let Some(Value::Object(extra)) = extra {
        for (key, value) in extra {
            base[key.as_str()] = value.clone();
        }
    }
    program_of(&base)
}

fn stdio_of(name: &str) -> Stdio {
    match name {
        "ignore" => Stdio::Ignore,
        "inherit" => Stdio::Inherit,
        _ => Stdio::Pipe,
    }
}

fn detection_of(v: &Value) -> SubscriptionDetection {
    let mut detection = SubscriptionDetection::new(
        v.get("provider")
            .and_then(Value::as_str)
            .unwrap_or("claude-code"),
        v.get("state").and_then(Value::as_str).unwrap_or(""),
    );
    detection.login_method = v
        .get("loginMethod")
        .and_then(Value::as_str)
        .map(str::to_owned);
    detection.login_kind = v
        .get("loginKind")
        .and_then(Value::as_str)
        .map(str::to_owned);
    detection
}

/// `locateOptions(o, cx)` of the spec
fn locate_options(o: &Value, sink: &Sink) -> SubscriptionLocateOptions {
    let versions: Option<Vec<(String, String)>> =
        o.get("versions").and_then(Value::as_array).map(|list| {
            list.iter()
                .map(|pair| {
                    (
                        pair.get(0)
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        pair.get(1)
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    )
                })
                .collect()
        });
    let sink = sink.clone();
    let read_version: Option<SubscriptionVersionReader> = versions.map(|versions| {
        Rc::new(
            move |program: SubscriptionProgram| -> LocalBoxFuture<Option<String>> {
                note(&sink, json!(["version", program.entry]));
                let found = versions
                    .iter()
                    .find(|(entry, _)| *entry == program.entry)
                    .map(|(_, version)| version.clone());
                Box::pin(async move { found })
            },
        ) as SubscriptionVersionReader
    });
    SubscriptionLocateOptions {
        configured_path: key_str(Some(o), "configured"),
        env: Some(pairs(o.get("env"))),
        platform: key_str(Some(o), "platform"),
        arch: key_str(Some(o), "arch"),
        node_runtime: o.get("node").map(|node| SubscriptionNodeRuntime {
            command: key_str(Some(node), "command").unwrap_or_default(),
            electron: key_flag(Some(node), "electron"),
        }),
        managed_install_root: key_str(Some(o), "managed"),
        application_dirs: Some(strings(o.get("apps"))),
        common_dirs: Some(strings(o.get("common"))),
        read_version,
    }
}

fn locate_state() -> LocateState {
    Rc::new(RefCell::new(SubscriptionLocateState::new(
        SharedChildRegistry::new(OWNER_STARTED_AT),
    )))
}

/// `leftoverDeps(o, cx)` of the spec
fn leftover_deps(o: &Value, sink: &Sink) -> LeftoverCleanupDeps {
    let default_inspect = key_flag(Some(o), "defaultInspect");
    let throws = o.get("inspect").and_then(Value::as_str) == Some("throws");
    let rows: Vec<(f64, f64, String)> = o
        .get("inspect")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|row| {
                    (
                        row.get(0).and_then(Value::as_f64).unwrap_or(f64::NAN),
                        row.get(1).and_then(Value::as_f64).unwrap_or(f64::NAN),
                        row.get(2)
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let inspect: Option<ProcessInspector> = if default_inspect {
        None
    } else {
        let sink = sink.clone();
        Some(Rc::new(
            move |pids: Vec<f64>| -> LocalBoxFuture<Result<Vec<(f64, ProcessInfo)>, JsError>> {
                note(
                    &sink,
                    json!(["inspect", pids.iter().map(|p| num(*p)).collect::<Vec<_>>()]),
                );
                let rows = rows.clone();
                Box::pin(async move {
                    if throws {
                        return Err(JsError::error("boom"));
                    }
                    let mut found: Vec<(f64, ProcessInfo)> = Vec::new();
                    for (pid, started_at, image) in rows {
                        if pids.contains(&pid) {
                            found.push((pid, ProcessInfo { started_at, image }));
                        }
                    }
                    Ok(found)
                })
            },
        ))
    };
    let kill_sink = sink.clone();
    LeftoverCleanupDeps {
        inspect,
        kill_tree: Some(Rc::new(move |pid: f64| {
            note(&kill_sink, json!(["killTree", num(pid)]));
        })),
        platform: key_str(Some(o), "platform"),
        owner_pid: key_f64(Some(o), "ownerPid"),
        parent_pid: None,
    }
}

fn cleanup_result_json(
    result: &crate::packages::ai_provider::subscription_leftovers::LeftoverCleanupResult,
) -> Value {
    json!({
        "killed": result.killed.iter().map(|p| num(*p)).collect::<Vec<_>>(),
        "skipped": result.skipped.iter().map(|p| num(*p)).collect::<Vec<_>>(),
    })
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- contract.ts ----
        "subscription/contract.SUBSCRIPTION_IPC_CHANNELS" => {
            constant(table(&SUBSCRIPTION_IPC_CHANNELS))
        }
        "subscription/contract.SUBSCRIPTION_INSTALL_COMMANDS" => {
            constant(table(&SUBSCRIPTION_INSTALL_COMMANDS))
        }
        "subscription/contract.SUBSCRIPTION_MIN_VERSIONS" => {
            constant(optional_table(&SUBSCRIPTION_MIN_VERSIONS))
        }
        "subscription/contract.SUBSCRIPTION_UPDATE_COMMANDS" => {
            constant(optional_table(&SUBSCRIPTION_UPDATE_COMMANDS))
        }
        "subscription/contract.SUBSCRIPTION_INSTALL_URLS" => {
            constant(table(&SUBSCRIPTION_INSTALL_URLS))
        }
        "subscription/contract.SUBSCRIPTION_CHATGPT_USAGE_URL" => {
            constant(Value::String(SUBSCRIPTION_CHATGPT_USAGE_URL.to_owned()))
        }
        "subscription/contract.SUBSCRIPTION_ACCOUNT_MAX_LENGTH" => {
            constant(json!(SUBSCRIPTION_ACCOUNT_MAX_LENGTH))
        }
        "subscription/contract.SUBSCRIPTION_MODELS_MAX" => constant(json!(SUBSCRIPTION_MODELS_MAX)),
        "subscription/contract.SUBSCRIPTION_LOGIN_ERROR_CODE" => Ok(Some(Value::Bool(
            subscription_login_error_code_test(&s(args, 0)),
        ))),
        "subscription/contract.subscriptionVersionOf" => {
            Ok(subscription_version_of(&s(args, 0)).map(Value::String))
        }
        "subscription/contract.subscriptionVersionAtLeast" => Ok(Some(Value::Bool(
            subscription_version_at_least(&s(args, 0), &s(args, 1)),
        ))),
        "subscription/contract.checkingSubscriptionStatus" => {
            out(checking_subscription_status(&s(args, 0)))
        }
        "subscription/contract.offSubscriptionStatus" => out(off_subscription_status(&s(args, 0))),
        "subscription/contract.subscriptionStatusErrorText" => Ok(Some(Value::String(
            subscription_status_error_text(&s(args, 0), &s(args, 1)),
        ))),
        "subscription/contract.subscriptionStatusErrorKind" => {
            let status = arg(args, 0);
            let state = key_str(status, "state").unwrap_or_default();
            let error = key_str(status, "error");
            Ok(Some(
                subscription_status_error_kind(&state, error.as_deref())
                    .map_or(Value::Null, |kind| Value::String(kind.to_owned())),
            ))
        }
        "subscription/contract.subscriptionNeedsUpdate" => {
            let status = jv(args, 0).unwrap_or(JsonValue::Null);
            opt_out(subscription_needs_update(&status))
        }
        "subscription/contract.subscriptionProgramPathOf" => {
            Ok(subscription_program_path_of(jv(args, 0).as_ref()).map(Value::String))
        }
        "subscription/contract.checkingSubscriptionStatuses" => {
            out(checking_subscription_statuses())
        }
        "subscription/contract.isSubscriptionProviderId" => Ok(Some(Value::Bool(
            is_subscription_provider_id(jv(args, 0).as_ref()),
        ))),
        "subscription/contract.subscriptionAccountOf" => {
            Ok(subscription_account_of(jv(args, 0).as_ref()).map(Value::String))
        }
        "subscription/contract.subscriptionModelsOf" => {
            or_undefined(subscription_models_of(jv(args, 0).as_ref()).map(JsonValue::Array))
        }
        "subscription/contract.subscriptionLoginFailureOf" => {
            or_undefined(subscription_login_failure_of(jv(args, 0).as_ref()))
        }
        "subscription/contract.subscriptionStatusMapOf" => {
            out(subscription_status_map_of(jv(args, 0).as_ref()))
        }
        "subscription/contract.subscriptionLaunchResultOf" => {
            out(subscription_launch_result_of(jv(args, 0).as_ref()))
        }
        "subscription/contract.subscriptionMeteredResultOf" => {
            out(subscription_metered_result_of(jv(args, 0).as_ref()))
        }
        "subscription/contract.subscriptionOffResultOf" => {
            out(subscription_off_result_of(jv(args, 0).as_ref()))
        }

        // ---- env.ts, old-names.ts ----
        "subscription/env.SUBSCRIPTION_STRIPPED_ENV_VARS" => constant(Value::Array(
            SUBSCRIPTION_STRIPPED_ENV_VARS
                .iter()
                .map(|name| Value::String((*name).to_owned()))
                .collect(),
        )),
        "subscription/old-names.OLD_TRACKED_TEMP_PREFIXES" => constant(Value::Array(
            OLD_TRACKED_TEMP_PREFIXES
                .iter()
                .map(|name| Value::String((*name).to_owned()))
                .collect(),
        )),
        "subscription/env.subscriptionChildEnv" => in_world(args, cx, |rt, _, _, o| async move {
            let options = SubscriptionEnvOptions {
                base: o.get("base").map(|base| pairs(Some(base))),
                platform: key_str(Some(&o), "platform"),
                command: key_str(Some(&o), "command"),
                extra: pairs(o.get("extra")),
            };
            Ok(Some(pairs_json(&subscription_child_env(&rt, &options))))
        }),

        // ---- models.ts ----
        "subscription/models.SUBSCRIPTION_MODELS_TIMEOUT_MS" => {
            constant(num(SUBSCRIPTION_MODELS_TIMEOUT_MS))
        }
        "subscription/models.listSubscriptionModels" => {
            in_world(args, cx, |rt, _, sink, o| async move {
                let provider = key_str(Some(&o), "provider").unwrap_or_default();
                let source_kind = key_str(Some(&o), "source").unwrap_or_else(|| "ok".to_owned());
                let mut state = SubscriptionModelsState::default();
                if source_kind != "none" {
                    let hang = source_kind == "hang";
                    let source_rt = rt.clone();
                    let source: SubscriptionModelSource = Rc::new(
                        move |configured: Option<String>, signal: Signal| -> LocalBoxFuture<Result<Vec<JsonValue>, JsError>> {
                            let sink = sink.clone();
                            let rt = source_rt.clone();
                            signal.on_abort(move |_| note(&sink, json!(["aborted"])));
                            Box::pin(async move {
                                if hang {
                                    return std::future::pending::<Result<Vec<JsonValue>, JsError>>()
                                        .await;
                                }
                                let answer = rt
                                    .call(
                                        "modelSource",
                                        JsonValue::Array(vec![
                                            configured.map_or(JsonValue::Null, JsonValue::String),
                                        ]),
                                    )
                                    .await?;
                                Ok(match answer {
                                    JsonValue::Array(items) => items,
                                    _ => Vec::new(),
                                })
                            })
                        },
                    );
                    let registered = if source_kind == "other" {
                        "codex"
                    } else {
                        provider.as_str()
                    };
                    set_subscription_model_source(&mut state, registered, Some(source));
                    if source_kind == "removed" {
                        set_subscription_model_source(&mut state, &provider, None);
                    }
                }
                let options = SubscriptionModelListOptions {
                    configured_path: key_str(Some(&o), "configuredPath"),
                    timeout_ms: key_f64(Some(&o), "timeoutMs"),
                };
                let listed = list_subscription_models(
                    &rt,
                    &Rc::new(RefCell::new(state)),
                    &provider,
                    &options,
                )
                .await;
                Ok(listed.as_ref().map(json_value_to_serde))
            })
        }

        // ---- temp-dirs.ts ----
        "subscription/temp-dirs.TRACKED_TEMP_PREFIXES" => constant(Value::Array(
            TRACKED_TEMP_PREFIXES
                .iter()
                .map(|name| Value::String((*name).to_owned()))
                .collect(),
        )),
        "subscription/temp-dirs.createTrackedTempDir" => {
            in_world(args, cx, |rt, _, sink, o| async move {
                let state = temp_state(key_str(Some(&o), "moduleDir"), &sink);
                let record_dir = key_str(Some(&o), "recordDir");
                let options = TempDirOptions {
                    temp_root: key_str(Some(&o), "tempRoot"),
                    record_dir: record_dir.clone(),
                    owner_pid: key_f64(Some(&o), "ownerPid"),
                };
                let path = create_tracked_temp_dir(
                    &rt,
                    &state,
                    &key_str(Some(&o), "prefix").unwrap_or_default(),
                    &options,
                )
                .await?;
                let records_in = record_dir.or_else(|| key_str(Some(&o), "moduleDir"));
                Ok(Some(
                    json!({ "path": path, "records": take_temp_records(records_in.as_deref()) }),
                ))
            })
        }
        "subscription/temp-dirs.removeTrackedTempDir" => {
            in_world(args, cx, |rt, _, sink, o| async move {
                let state = temp_state(key_str(Some(&o), "moduleDir"), &sink);
                let record_dir = key_str(Some(&o), "recordDir");
                let temp_root = key_str(Some(&o), "tempRoot");
                let options = TempDirOptions {
                    temp_root: temp_root.clone(),
                    record_dir: record_dir.clone(),
                    owner_pid: None,
                };
                let path = create_tracked_temp_dir(
                    &rt,
                    &state,
                    &key_str(Some(&o), "prefix").unwrap_or_default(),
                    &options,
                )
                .await?;
                fs::write(std::path::Path::new(&path).join("inner.txt"), "x")
                    .map_err(|e| JsError::error(e.to_string()))?;
                let remove = key_str(Some(&o), "remove");
                let target = if remove.as_deref() == Some("missing") {
                    format!("{}/does-not-exist", temp_root.clone().unwrap_or_default())
                } else {
                    path.clone()
                };
                remove_tracked_temp_dir(&rt, &state, &target, &options).await;
                if remove.as_deref() == Some("twice") {
                    remove_tracked_temp_dir(&rt, &state, &target, &options).await;
                }
                let records_in = record_dir.or_else(|| key_str(Some(&o), "moduleDir"));
                Ok(Some(json!({
                    "existsAfter": std::path::Path::new(&path).exists(),
                    "records": take_temp_records(records_in.as_deref()).len(),
                })))
            })
        }
        "subscription/temp-dirs.cleanupTrackedTempDirs" => {
            in_world(args, cx, |rt, _, sink, o| async move {
                let state = temp_state(key_str(Some(&o), "moduleDir"), &sink);
                let alive_pids: Vec<f64> = o
                    .get("alive")
                    .and_then(Value::as_array)
                    .map(|list| list.iter().filter_map(Value::as_f64).collect())
                    .unwrap_or_default();
                let calls: Rc<RefCell<Vec<f64>>> = Rc::new(RefCell::new(Vec::new()));
                let recorded = calls.clone();
                let options = CleanupTempDirsOptions {
                    base: TempDirOptions {
                        temp_root: key_str(Some(&o), "tempRoot"),
                        record_dir: None,
                        owner_pid: None,
                    },
                    alive: Some(Rc::new(move |pid| {
                        recorded.borrow_mut().push(pid);
                        alive_pids.contains(&pid)
                    })),
                };
                let removed = cleanup_tracked_temp_dirs(
                    &rt,
                    &state,
                    &key_str(Some(&o), "dir").unwrap_or_default(),
                    &options,
                )
                .await;
                let mut asked = calls.borrow().clone();
                asked.sort_by(f64::total_cmp);
                Ok(Some(json!({
                    "removed": num(removed),
                    "aliveCalls": asked.iter().map(|p| num(*p)).collect::<Vec<_>>(),
                })))
            })
        }

        // ---- metered.ts ----
        "subscription/metered.SUBSCRIPTION_METERED_FILE" => {
            constant(Value::String(SUBSCRIPTION_METERED_FILE.to_owned()))
        }
        "subscription/metered.METERED_LOGIN_FINGERPRINTS" => constant(Value::Array(
            METERED_LOGIN_FINGERPRINTS
                .iter()
                .map(|f| Value::String(f.clone()))
                .collect(),
        )),
        "subscription/metered.meteredLoginFingerprint" => Ok(Some(
            arg(args, 0)
                .and_then(|d| metered_login_fingerprint(&detection_of(d)))
                .map_or(Value::Null, Value::String),
        )),
        "subscription/metered.reconcileMeteredAcceptance" => {
            let detection = arg(args, 0).map(detection_of);
            let stored = arg(args, 1);
            let outcome = detection.map(|d| {
                reconcile_metered_acceptance(
                    &d,
                    key_flag(stored, "accepted"),
                    key_str(stored, "fingerprint").as_deref(),
                )
            });
            Ok(outcome.map(|o| json!({ "meteredAccepted": o.metered_accepted, "clear": o.clear })))
        }
        "subscription/metered.createMeteredAcceptanceFileStore" => {
            in_world(args, cx, |rt, _, _, o| async move {
                let store = create_metered_acceptance_file_store(
                    &rt,
                    &key_str(Some(&o), "dir").unwrap_or_default(),
                );
                let mut results: Vec<Value> = Vec::new();
                for step in o
                    .get("steps")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                {
                    if step.get(0).and_then(Value::as_str) == Some("read") {
                        let record = store.read().await?;
                        results.push(json_value_to_serde(&JsonValue::Object(record)));
                    } else {
                        let record: Obj = match step.get(1).map(json_value_from_serde) {
                            Some(JsonValue::Object(record)) => record,
                            _ => Obj::new(),
                        };
                        store.write(record).await?;
                        results.push(Value::Null);
                    }
                }
                Ok(Some(Value::Array(results)))
            })
        }

        // ---- locate.ts ----
        "subscription/locate.locateSubscriptionProgram" => {
            in_world(args, cx, |rt, _, sink, o| async move {
                let options = locate_options(&o, &sink);
                let program = locate_subscription_program(
                    &rt,
                    &locate_state(),
                    &key_str(Some(&o), "provider").unwrap_or_default(),
                    &options,
                )
                .await?;
                Ok(Some(program.as_ref().map_or(Value::Null, program_json)))
            })
        }
        "subscription/locate.resolveSubscriptionProgram" => {
            in_world(args, cx, |rt, _, sink, o| async move {
                let options = locate_options(&o, &sink);
                let program = resolve_subscription_program(
                    &rt,
                    &locate_state(),
                    &key_str(Some(&o), "provider").unwrap_or_default(),
                    &options,
                )
                .await?;
                Ok(Some(program_json(&program)))
            })
        }
        "subscription/locate.subscriptionProviderLabel" => {
            let label = subscription_provider_label(&s(args, 0));
            Ok((!label.is_empty()).then(|| Value::String(label.to_owned())))
        }

        // ---- process.ts ----
        "subscription/process.runSubscriptionProgram" => {
            in_world(args, cx, |rt, signal, _, o| async move {
                let shared = SharedChildRegistry::new(OWNER_STARTED_AT);
                let program = merged_program(o.get("program"));
                let run_args = o
                    .get("args")
                    .map(|a| strings(Some(a)))
                    .unwrap_or_else(|| vec!["--version".to_owned()]);
                let run_signal = if key_flag(Some(&o), "preAborted") {
                    let aborted = rt.controller();
                    aborted.abort(None);
                    aborted
                } else if key_flag(Some(&o), "worldSignal") {
                    signal
                } else {
                    rt.controller()
                };
                let result = run_subscription_program(
                    &rt,
                    &shared,
                    &program,
                    &run_args,
                    &SubscriptionRunOptions {
                        signal: run_signal,
                        timeout_ms: key_f64(Some(&o), "timeoutMs").unwrap_or(5000.0),
                        base_env: o.get("baseEnv").map(|env| pairs(Some(env))),
                        cwd: key_str(Some(&o), "cwd"),
                    },
                )
                .await?;
                let code = result.code.map_or(Value::Null, num);
                if key_flag(Some(&o), "slim") {
                    let head: String = result.stdout.chars().take(3).collect();
                    let tail: Vec<char> = result.stdout.chars().rev().take(3).collect();
                    let tail: String = tail.into_iter().rev().collect();
                    return Ok(Some(json!({
                        "code": code,
                        "length": result.stdout.encode_utf16().count(),
                        "head": head,
                        "tail": tail,
                        "stderr": result.stderr,
                    })));
                }
                Ok(Some(json!({
                    "code": code,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                })))
            })
        }
        "subscription/process.spawnSubscriptionProgram" => {
            let record = key_str(arg(args, 1), "record");
            with_owner(record.as_deref(), || {
                in_world(args, cx, |rt, _, _, o| async move {
                    let shared = SharedChildRegistry::new(OWNER_STARTED_AT);
                    let record = key_str(Some(&o), "record");
                    if let Some(dir) = &record {
                        shared.record_in(&rt, Some(dir.as_str()));
                    }
                    let options = o.get("options");
                    let registry_kind = key_str(options, "registry");
                    let own = (registry_kind.as_deref() == Some("own"))
                        .then(|| SharedChildRegistry::new(OWNER_STARTED_AT));
                    let registry = match (&own, registry_kind.as_deref()) {
                        (Some(own), _) => RegistryChoice::Custom(own.clone()),
                        (None, Some("none")) => RegistryChoice::None,
                        _ => RegistryChoice::Shared,
                    };
                    let stdio = options
                        .and_then(|o| o.get("stdio"))
                        .and_then(Value::as_array)
                        .map(|list| {
                            let name = |i: usize| {
                                stdio_of(list.get(i).and_then(Value::as_str).unwrap_or("pipe"))
                            };
                            [name(0), name(1), name(2)]
                        });
                    let program = merged_program(o.get("program"));
                    let spawn_args = o
                        .get("args")
                        .map(|a| strings(Some(a)))
                        .unwrap_or_else(|| vec!["--version".to_owned()]);
                    let child = spawn_subscription_program(
                        &rt,
                        &shared,
                        &program,
                        &spawn_args,
                        &SubscriptionSpawnOptions {
                            cwd: key_str(options, "cwd"),
                            stdio,
                            base_env: options
                                .and_then(|o| o.get("baseEnv"))
                                .map(|env| pairs(Some(env))),
                            env: pairs(options.and_then(|o| o.get("env"))),
                            platform: key_str(options, "platform"),
                            registry,
                        },
                    )
                    .await?;
                    let mut answer = Map::new();
                    answer.insert("pid".into(), child.pid().map_or(Value::Null, num));
                    answer.insert("size".into(), json!(shared.size()));
                    answer.insert(
                        "ownSize".into(),
                        own.as_ref().map_or(Value::Null, |own| json!(own.size())),
                    );
                    if key_flag(Some(&o), "exit") {
                        let (settle, wait) = rt.deferred::<()>();
                        child.on(move |event| {
                            if matches!(event, ChildEvent::Close { .. }) {
                                settle.settle(());
                            }
                        });
                        wait.await;
                        answer.insert("sizeAfterExit".into(), json!(shared.size()));
                        answer.insert(
                            "ownSizeAfterExit".into(),
                            own.as_ref().map_or(Value::Null, |own| json!(own.size())),
                        );
                    }
                    shared.flushed(&rt).await;
                    Ok(Some(Value::Object(answer)))
                })
            })
        }
        "subscription/process.trackSubscriptionChild" => {
            let dir = key_str(arg(args, 1), "dir");
            with_owner(dir.as_deref(), || {
                in_world(args, cx, |rt, _, _, o| async move {
                    let shared = SharedChildRegistry::new(OWNER_STARTED_AT);
                    let mut kids: Vec<Child> = Vec::new();
                    let mut tickets: Vec<Option<ChildTicket>> = Vec::new();
                    let mut answers: Vec<Value> = Vec::new();
                    for step in o
                        .get("steps")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                    {
                        if let Some(spawn) = step.get("spawn") {
                            let command = key_str(Some(spawn), "command")
                                .unwrap_or_else(|| "/opt/mcp/server".to_owned());
                            let kid = rt
                                .spawn(SpawnRequest {
                                    command,
                                    args: Vec::new(),
                                    cwd: None,
                                    env: None,
                                    stdio: [Stdio::Pipe; 3],
                                    detached: false,
                                    windows_hide: false,
                                    shell: None,
                                })
                                .await?;
                            answers.push(kid.pid().map_or(Value::Null, num));
                            kids.push(kid);
                        } else if let Some(track) = step.get("track") {
                            let index = key_f64(Some(track), "child").unwrap_or(0.0) as usize;
                            let info = TrackedChildInfo {
                                provider: key_str(Some(track), "provider")
                                    .unwrap_or_else(|| "user-mcp".to_owned()),
                                command: key_str(Some(track), "command")
                                    .unwrap_or_else(|| "/opt/mcp/server".to_owned()),
                                started_at: key_f64(Some(track), "startedAt"),
                            };
                            let ticket = kids
                                .get(index)
                                .and_then(|kid| track_subscription_child(&rt, &shared, kid, &info));
                            tickets.push(ticket);
                            answers.push(json!(shared.size()));
                        } else if let Some(index) = step.get("forget").and_then(Value::as_f64) {
                            if let Some(Some(ticket)) = tickets.get(index as usize) {
                                shared.forget(&rt, *ticket);
                            }
                            answers.push(json!(shared.size()));
                        } else if key_flag(Some(&step), "wait") {
                            rt.sleep(0.0).await;
                            answers.push(json!(shared.size()));
                        } else if key_flag(Some(&step), "shutdown") {
                            shared.shutdown(&rt);
                            answers.push(json!(shared.size()));
                        } else if key_flag(Some(&step), "flush") {
                            shared.flushed(&rt).await;
                            answers.push(Value::Null);
                        } else if let Some(record) = step.get("record") {
                            shared.record_in(&rt, record.as_str());
                            answers.push(Value::Null);
                        } else {
                            answers.push(json!(shared.size()));
                        }
                    }
                    shared.flushed(&rt).await;
                    Ok(Some(Value::Array(answers)))
                })
            })
        }

        // ---- leftovers.ts ----
        "subscription/leftovers.cleanupLeftoverSubscriptionChildren" => {
            let dir = key_str(arg(args, 1), "dir");
            with_owner(dir.as_deref(), || {
                in_world(args, cx, |rt, _, sink, o| async move {
                    let shared = SharedChildRegistry::new(OWNER_STARTED_AT);
                    let result = cleanup_leftover_subscription_children(
                        &rt,
                        &shared,
                        &key_str(Some(&o), "dir").unwrap_or_default(),
                        &leftover_deps(&o, &sink),
                    )
                    .await;
                    Ok(Some(cleanup_result_json(&result)))
                })
            })
        }
        "subscription/leftovers.initSubscriptionChildTracking" => {
            let dir = key_str(arg(args, 1), "dir");
            with_owner(dir.as_deref(), || {
                in_world(args, cx, |rt, _, sink, o| async move {
                    let shared = SharedChildRegistry::new(OWNER_STARTED_AT);
                    let temp = temp_state(None, &sink);
                    let dir = key_str(Some(&o), "dir").unwrap_or_default();
                    let result = init_subscription_child_tracking(
                        &rt,
                        &shared,
                        &temp,
                        &dir,
                        &leftover_deps(&o, &sink),
                    )
                    .await;
                    // the record directory is the one the init set
                    let made = create_tracked_temp_dir(
                        &rt,
                        &temp,
                        "seuoffice-claude-code-",
                        &TempDirOptions::default(),
                    )
                    .await?;
                    let records = take_temp_records(Some(&dir));
                    shared.flushed(&rt).await;
                    Ok(Some(json!({
                        "result": cleanup_result_json(&result),
                        "made": made,
                        "records": records,
                        "size": shared.size(),
                    })))
                })
            })
        }
        "subscription/leftovers.inspectProcesses" => in_world(args, cx, |rt, _, _, o| async move {
            let pids: Vec<f64> = o
                .get("pids")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_f64).collect())
                .unwrap_or_default();
            let deps = ProcessInspectionDeps {
                platform: key_str(Some(&o), "platform"),
                env: o.get("env").map(|env| pairs(Some(env))),
            };
            let found = inspect_processes(&rt, &pids, &deps).await?;
            Ok(Some(Value::Array(
                found
                    .iter()
                    .map(|(pid, info)| {
                        json!([num(*pid), {
                            "startedAt": num(info.started_at),
                            "image": info.image,
                        }])
                    })
                    .collect(),
            )))
        }),
        _ => return None,
    })
}
