//! The functions of group `update` (tools/main-diff/groups/update.ts).

use super::{Answer, CallError, Context, arg, str_arg};
use crate::shell::launch_paths::{
    self, LAUNCHABLE_DOUBLE_EXTS, LAUNCHABLE_EXTS, LAUNCHABLE_UNCLAIMED_EXTS,
};
use crate::shell::update_attempt::{self, INSTALL_ATTEMPT_FILE, InstallAttempt};
use crate::shell::update_build_channel;
use crate::shell::update_cache;
use crate::shell::update_log::{
    self, LogMessage, StepField, UPDATE_LOG_FILE, UPDATE_LOG_MAX_BYTES,
};
use jscompat::{JsNum, JsonValue, json_parse};
use serde_json::{Number, Value};
use std::cell::Cell;
use std::path::Path;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "update-attempt.INSTALL_ATTEMPT_FILE" => Ok(Some(Value::from(INSTALL_ATTEMPT_FILE))),
        "update-attempt.nextAttemptTries" => next_attempt_tries(args),
        "update-attempt.recordInstallAttempt" => record_install_attempt(args),
        "update-attempt.readInstallAttempt" => read_install_attempt(args),
        "update-attempt.clearInstallAttempt" => clear_install_attempt(args),
        "update-attempt.installDidNotApply" => install_did_not_apply(args),
        "update-attempt.installFailureLevel" => install_failure_level(args),
        "update-attempt.installDirWritable" => install_dir_writable(args),
        "update-cache.pruneUpdateCache" => prune_update_cache(args, cx),
        "update-build-channel.buildChannelFromAppUpdateYml" => str_arg(args, 0).map(|text| {
            let c = update_build_channel::build_channel_from_app_update_yml(text);
            Some(Value::from(c.as_str()))
        }),
        "update-build-channel.packagedUpdateChannel" => str_arg(args, 0).map(|dir| {
            Some(Value::from(
                update_build_channel::packaged_update_channel(dir).as_str(),
            ))
        }),
        "update-log.UPDATE_LOG_FILE" => Ok(Some(Value::from(UPDATE_LOG_FILE))),
        "update-log.UPDATE_LOG_MAX_BYTES" => Ok(Some(num(UPDATE_LOG_MAX_BYTES))),
        "update-log.createUpdateLog" => create_update_log(args, cx),
        "update-log.createUpdateSteps" => create_update_steps(args, cx),
        "update-log.fileBytes" => Ok(Some(
            update_log::file_bytes(arg(args, 0).and_then(Value::as_str))
                .map_or(Value::Null, |n| num(n as f64)),
        )),
        "launch-paths.LAUNCHABLE_EXTS" => Ok(Some(strings(LAUNCHABLE_EXTS))),
        "launch-paths.LAUNCHABLE_DOUBLE_EXTS" => Ok(Some(strings(LAUNCHABLE_DOUBLE_EXTS))),
        "launch-paths.LAUNCHABLE_UNCLAIMED_EXTS" => Ok(Some(strings(LAUNCHABLE_UNCLAIMED_EXTS))),
        "launch-paths.collectLaunchPaths" => collect_launch_paths(args),
        _ => return None,
    })
}

fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn strings(items: &[&str]) -> Value {
    Value::Array(items.iter().map(|s| Value::from(*s)).collect())
}

/// A JSON argument as `JSON.parse` would have made it.
fn js_value(value: &Value) -> JsonValue {
    json_parse(&value.to_string()).expect("a serde_json value prints as JSON")
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

/// An `InstallAttempt | null` argument: typed as the TypeScript types it, not
/// checked as `isInstallAttempt` does (the callers hand over any record).
fn attempt_arg(args: &[Value], i: usize) -> Result<Option<InstallAttempt>, CallError> {
    let v = match arg(args, i) {
        None | Some(Value::Null) => return Ok(None),
        Some(v) => v,
    };
    let string = |key: &str| {
        v.get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| bad(key))
    };
    Ok(Some(InstallAttempt {
        version: string("version")?,
        from_version: string("fromVersion")?,
        visible: v
            .get("visible")
            .and_then(Value::as_bool)
            .ok_or_else(|| bad("visible"))?,
        tries: v
            .get("tries")
            .map(|t| t.as_f64().map(JsNum).ok_or_else(|| bad("tries")))
            .transpose()?,
        started_at: v
            .get("startedAt")
            .map(|_| string("startedAt"))
            .transpose()?,
    }))
}

fn next_attempt_tries(args: &[Value]) -> Answer {
    let failed = attempt_arg(args, 0)?;
    let version = str_arg(args, 1)?;
    Ok(Some(num(update_attempt::next_attempt_tries(
        failed.as_ref(),
        version,
    ))))
}

fn record_install_attempt(args: &[Value]) -> Answer {
    let dir = str_arg(args, 0)?;
    let attempt = attempt_arg(args, 1)?.ok_or_else(|| bad("an install attempt"))?;
    update_attempt::record_install_attempt(dir, &attempt);
    Ok(None)
}

fn read_install_attempt(args: &[Value]) -> Answer {
    let dir = str_arg(args, 0)?;
    Ok(Some(match update_attempt::read_install_attempt_json(dir) {
        Some(v) => serde_json::to_value(&v).expect("a JSON value serializes"),
        None => Value::Null,
    }))
}

fn clear_install_attempt(args: &[Value]) -> Answer {
    update_attempt::clear_install_attempt(str_arg(args, 0)?);
    Ok(None)
}

fn install_did_not_apply(args: &[Value]) -> Answer {
    let attempt = attempt_arg(args, 0)?;
    let current = str_arg(args, 1)?;
    Ok(Some(Value::Bool(update_attempt::install_did_not_apply(
        attempt.as_ref(),
        current,
    ))))
}

fn install_failure_level(args: &[Value]) -> Answer {
    let failed = attempt_arg(args, 0)?;
    Ok(Some(Value::from(update_attempt::install_failure_level(
        failed.as_ref(),
    ))))
}

fn install_dir_writable(args: &[Value]) -> Answer {
    let dir = str_arg(args, 0)?;
    let probe = str_arg(args, 1)?;
    Ok(Some(Value::Bool(update_attempt::install_dir_writable(
        dir, probe,
    ))))
}

fn prune_update_cache(args: &[Value], cx: &mut Context) -> Answer {
    let options = arg(args, 0).ok_or_else(|| bad("options"))?;
    let field = |key: &str| {
        options
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| bad(key))
    };
    let (cache_dir, running) = (field("cacheDir")?, field("runningVersion")?);
    let mut log = |line: &[&str]| {
        cx.logs.push(line.iter().map(|s| Value::from(*s)).collect());
    };
    Ok(Some(Value::Bool(update_cache::prune_update_cache(
        cache_dir, running, &mut log,
    ))))
}

/// `[file, maxBytes | null, calls, nowMs | null]`, `calls` being `[level,
/// message]` pairs; a message is a JSON value, `{"$undefined":true}` or
/// `{"$error":{"stack":string|null,"message":string}}`.
fn create_update_log(args: &[Value], cx: &mut Context) -> Answer {
    let file = str_arg(args, 0)?;
    let max_bytes = arg(args, 1)
        .and_then(Value::as_f64)
        .unwrap_or(UPDATE_LOG_MAX_BYTES);
    let now_ms = arg(args, 3).and_then(Value::as_f64).unwrap_or(cx.now_ms);
    let calls = arg(args, 2)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("calls"))?;
    let mut log = update_log::create_update_log(file, max_bytes, || now_ms);
    for call in calls {
        let level = call
            .get(0)
            .and_then(Value::as_str)
            .ok_or_else(|| bad("level"))?;
        let spec = call.get(1).ok_or_else(|| bad("message"))?;
        let parsed;
        let message = if spec.get("$undefined").is_some() {
            LogMessage::Undefined
        } else if let Some(err) = spec.get("$error") {
            LogMessage::Error {
                stack: err.get("stack").and_then(Value::as_str),
                message: err
                    .get("message")
                    .and_then(Value::as_str)
                    .ok_or_else(|| bad("message"))?,
            }
        } else {
            parsed = js_value(spec);
            LogMessage::Value(&parsed)
        };
        match level {
            "info" => log.info(&message),
            "warn" => log.warn(&message),
            "error" => log.error(&message),
            "debug" => log.debug(&message),
            _ => return Err(bad("level")),
        }
    }
    Ok(None)
}

/// `[calls]`, each `[step, fields | null, now]`; every line written goes to
/// the logs.
fn create_update_steps(args: &[Value], cx: &mut Context) -> Answer {
    let calls = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("calls"))?;
    let clock = Cell::new(0.0);
    let mut steps = update_log::create_update_steps(
        |line| cx.logs.push(vec![Value::from(line)]),
        || clock.get(),
    );
    for call in calls {
        let step = call
            .get(0)
            .and_then(Value::as_str)
            .ok_or_else(|| bad("step"))?;
        clock.set(
            call.get(2)
                .and_then(Value::as_f64)
                .ok_or_else(|| bad("now"))?,
        );
        let object = match call.get(1) {
            None | Some(Value::Null) => JsonValue::Object(Default::default()),
            Some(v) => js_value(v),
        };
        let JsonValue::Object(object) = &object else {
            return Err(bad("fields"));
        };
        let mut fields: Vec<(&str, Option<StepField>)> = Vec::new();
        for (key, value) in object.entries() {
            let field = match value {
                JsonValue::Null => None,
                JsonValue::String(s) => Some(StepField::Str(s)),
                JsonValue::Number(x) => Some(StepField::Num(*x)),
                JsonValue::Bool(true) => Some(StepField::Str("true")),
                JsonValue::Bool(false) => Some(StepField::Str("false")),
                _ => return Err(bad("a field value")),
            };
            fields.push((key, field));
        }
        steps.step(step, &fields);
    }
    Ok(None)
}

fn collect_launch_paths(args: &[Value]) -> Answer {
    let argv: Vec<&str> = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("argv"))?
        .iter()
        .map(|v| v.as_str().ok_or_else(|| bad("an argv entry")))
        .collect::<Result<_, _>>()?;
    let additional = match arg(args, 1) {
        None => None,
        Some(v) => Some(js_value(v)),
    };
    let paths =
        launch_paths::collect_launch_paths(&argv, additional.as_ref(), &|p| Path::new(p).exists());
    Ok(Some(Value::Array(
        paths.into_iter().map(Value::String).collect(),
    )))
}
