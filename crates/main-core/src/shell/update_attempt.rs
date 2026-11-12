//! `apps/shell/src/main/update-attempt.ts`.

use std::fs::{self, OpenOptions};

use jscompat::node_path::host::join;
use jscompat::{JsNum, JsonValue, json_parse, json_to_string};
use serde::Serialize;

use crate::node_fs::code_of;

/// data-folder file holding the last installer start
pub const INSTALL_ATTEMPT_FILE: &str = "update-install-attempt.json";

/// `InstallAttempt`; the fields serialize in the order of the TypeScript
/// literals that write it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstallAttempt {
    pub version: String,
    #[serde(rename = "fromVersion")]
    pub from_version: String,
    pub visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tries: Option<JsNum>,
    #[serde(rename = "startedAt", skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}

/// `isInstallAttempt`
fn is_install_attempt(value: &JsonValue) -> bool {
    // an array passes `typeof value === 'object'` and fails on `version`
    let JsonValue::Object(v) = value else {
        return false;
    };
    matches!(v.get("version"), Some(JsonValue::String(s)) if !s.is_empty())
        && matches!(v.get("fromVersion"), Some(JsonValue::String(s)) if !s.is_empty())
        && matches!(v.get("visible"), Some(JsonValue::Bool(_)))
        && match v.get("tries") {
            None => true,
            Some(JsonValue::Number(x)) => x.is_finite() && x.trunc() == *x && *x >= 1.0,
            Some(_) => false,
        }
        && matches!(v.get("startedAt"), None | Some(JsonValue::String(_)))
}

/// The typed fields of a value `isInstallAttempt` accepts (what the record
/// holds besides them is dropped; see [`read_install_attempt_json`]).
pub fn parse_install_attempt(value: &JsonValue) -> Option<InstallAttempt> {
    if !is_install_attempt(value) {
        return None;
    }
    let JsonValue::Object(v) = value else {
        return None;
    };
    let string = |key: &str| match v.get(key) {
        Some(JsonValue::String(s)) => Some(s.clone()),
        _ => None,
    };
    Some(InstallAttempt {
        version: string("version")?,
        from_version: string("fromVersion")?,
        visible: matches!(v.get("visible"), Some(JsonValue::Bool(true))),
        tries: match v.get("tries") {
            Some(JsonValue::Number(x)) => Some(JsNum(*x)),
            _ => None,
        },
        started_at: string("startedAt"),
    })
}

/// `attemptTries`
fn attempt_tries(attempt: &InstallAttempt) -> f64 {
    attempt
        .tries
        .map_or(if attempt.visible { 2.0 } else { 1.0 }, |t| t.0)
}

/// `nextAttemptTries`
pub fn next_attempt_tries(failed: Option<&InstallAttempt>, version: &str) -> f64 {
    match failed {
        Some(f) if f.version == version => attempt_tries(f) + 1.0,
        _ => 1.0,
    }
}

/// `recordInstallAttempt`: a failed write is swallowed.
pub fn record_install_attempt(data_dir: &str, attempt: &InstallAttempt) {
    let Ok(text) = json_to_string(attempt) else {
        return;
    };
    let _ = fs::write(join(&[data_dir, INSTALL_ATTEMPT_FILE]), text);
}

/// `readInstallAttempt` as the TypeScript returns it: the parsed record
/// itself, so keys beyond the typed ones stay, in the order JavaScript has.
pub fn read_install_attempt_json(data_dir: &str) -> Option<JsonValue> {
    let bytes = fs::read(join(&[data_dir, INSTALL_ATTEMPT_FILE])).ok()?;
    let parsed = json_parse(&String::from_utf8_lossy(&bytes)).ok()?;
    is_install_attempt(&parsed).then_some(parsed)
}

/// `readInstallAttempt`, typed.
pub fn read_install_attempt(data_dir: &str) -> Option<InstallAttempt> {
    parse_install_attempt(&read_install_attempt_json(data_dir)?)
}

/// `clearInstallAttempt`
pub fn clear_install_attempt(data_dir: &str) {
    let _ = fs::remove_file(join(&[data_dir, INSTALL_ATTEMPT_FILE]));
}

/// `installDidNotApply`
pub fn install_did_not_apply(attempt: Option<&InstallAttempt>, current_version: &str) -> bool {
    matches!(attempt, Some(a) if a.version != current_version && a.from_version == current_version)
}

/// `installFailureLevel`: 0, 1 or 2.
pub fn install_failure_level(failed: Option<&InstallAttempt>) -> u8 {
    match failed {
        None => 0,
        Some(f) if attempt_tries(f) >= 2.0 => 2,
        Some(_) => 1,
    }
}

/// `installDirWritable`
pub fn install_dir_writable(install_dir: &str, probe_name: &str) -> bool {
    let probe = join(&[install_dir, probe_name]);
    // openSync(probe, 'wx'): O_WRONLY | O_CREAT | O_EXCL
    if let Err(err) = OpenOptions::new().write(true).create_new(true).open(&probe) {
        // EEXIST: a probe left behind by a crash; the folder was writable then
        return code_of(&err) == Some("EEXIST");
    }
    let _ = fs::remove_file(&probe);
    true
}
