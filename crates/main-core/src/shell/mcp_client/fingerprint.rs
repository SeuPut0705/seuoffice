//! `apps/shell/src/main/mcp-client/fingerprint.ts`: approval fingerprints for
//! user MCP servers (spec 6.2): SHA-256 over normalized text, so the same
//! content always gives the same fingerprint whatever order a server lists
//! object keys in.
//!
//! A stored server is a [`JsonValue`] (it comes from the store file): the
//! launch functions read `kind`, `command`, `args`, `env`, `approvedLaunch`
//! and `approvedPlan` of it as the store guarantees them (`command` a string,
//! `args` strings, `env` an object); what is not a string in `args` is left
//! out and a missing `command` reads as the empty text.

use jscompat::{JsObject, JsonValue, json_stringify};
use sha2::{Digest, Sha256};

/// JSON with object keys sorted at every level (UTF-16 order, `Array.sort`
/// without a comparator), an object then listing integer-like keys first as
/// `Object.fromEntries` does. `None` is `undefined`, which gives `null`.
pub fn stable_json(value: Option<&JsonValue>) -> String {
    match value {
        None => "null".to_owned(),
        Some(value) => json_stringify(&sort_keys(value)),
    }
}

fn sort_keys(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::Array(items) => JsonValue::Array(items.iter().map(sort_keys).collect()),
        JsonValue::Object(object) => {
            let mut entries = object.entries();
            entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            // `__proto__` stays an ordinary member
            let mut sorted = JsObject::new();
            for (key, member) in entries {
                sorted.set(key, sort_keys(member));
            }
            JsonValue::Object(sorted)
        }
        other => other.clone(),
    }
}

/// `text.normalize('NFC')`
fn nfc(text: &str) -> String {
    icu_normalizer::ComposingNormalizerBorrowed::new_nfc()
        .normalize(text)
        .into_owned()
}

/// Line endings and Unicode composition do not count as a change
fn normalize_text(text: &str) -> String {
    let mut lines = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            lines.push('\n');
        } else {
            lines.push(c);
        }
    }
    nfc(&lines)
}

pub fn fingerprint_of(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("sha256:{hex}")
}

fn object_of(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut object = JsObject::new();
    for (key, value) in entries {
        object.set(key, value);
    }
    JsonValue::Object(object)
}

fn strings(items: &[String]) -> JsonValue {
    JsonValue::Array(items.iter().cloned().map(JsonValue::String).collect())
}

/// A tool's name, description and input schema; annotations are display
/// hints and left out. `None` and `null` read as the defaults (`''`, `{}`).
pub fn tool_fingerprint(
    name: &str,
    description: Option<&str>,
    input_schema: Option<&JsonValue>,
) -> String {
    let schema = match input_schema {
        None | Some(JsonValue::Null) => JsonValue::Object(JsObject::new()),
        Some(schema) => schema.clone(),
    };
    fingerprint_of(&stable_json(Some(&object_of(vec![
        ("name", JsonValue::String(name.to_owned())),
        (
            "description",
            JsonValue::String(normalize_text(description.unwrap_or(""))),
        ),
        ("inputSchema", schema),
    ]))))
}

pub fn instructions_fingerprint(text: &str) -> String {
    fingerprint_of(&normalize_text(text))
}

/// `LaunchShape`
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchShape {
    pub command: String,
    pub args: Vec<String>,
    /// the names only: a changed value is not asked about again (4.5)
    pub env_names: Vec<String>,
}

/// What a person approves before a local server first runs: command, arguments, env names
pub fn launch_fingerprint(launch: &LaunchShape) -> String {
    let mut env_names = launch.env_names.clone();
    env_names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    fingerprint_of(&stable_json(Some(&object_of(vec![
        ("command", JsonValue::String(launch.command.clone())),
        ("args", strings(&launch.args)),
        ("envNames", strings(&env_names)),
    ]))))
}

/// `PlanShape.env`: a variable name with where it comes from
#[derive(Debug, Clone, PartialEq)]
pub struct PlanEnv {
    pub name: String,
    pub origin: String,
}

/// `PlanShape`: the resolved launch the confirmation shows, as far as approval reads it
#[derive(Debug, Clone, PartialEq)]
pub struct PlanShape {
    /// the full path of the program
    pub command: String,
    /// every argument, the app's own included
    pub args: Vec<String>,
    /// the variable names with where each comes from; values are never part of it
    pub env: Vec<PlanEnv>,
}

/// What the person saw and allowed (4.5): the resolved program, every argument
/// and the variable names with their origins. The launcher compares it before
/// every start, so a program that resolves elsewhere since is asked about again.
pub fn plan_fingerprint(plan: &PlanShape) -> String {
    let mut env: Vec<&PlanEnv> = plan.env.iter().collect();
    // `a.name < b.name ? -1 : a.name > b.name ? 1 : 0`, a stable sort
    env.sort_by(|a, b| a.name.encode_utf16().cmp(b.name.encode_utf16()));
    let env = JsonValue::Array(
        env.into_iter()
            .map(|e| {
                object_of(vec![
                    ("name", JsonValue::String(e.name.clone())),
                    ("origin", JsonValue::String(e.origin.clone())),
                ])
            })
            .collect(),
    );
    fingerprint_of(&stable_json(Some(&object_of(vec![
        ("command", JsonValue::String(plan.command.clone())),
        ("args", strings(&plan.args)),
        ("env", env),
    ]))))
}

/// The launch fields of a stored server (see the module)
fn launch_of(server: &JsonValue) -> LaunchShape {
    let text = |key: &str| match server.get(key).as_deref() {
        Some(JsonValue::String(text)) => text.clone(),
        _ => String::new(),
    };
    let args = match server.get("args").as_deref() {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsonValue::String(text) => Some(text.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let env_names = match server.get("env").as_deref() {
        Some(JsonValue::Object(env)) => env
            .entries()
            .into_iter()
            .map(|(name, _)| name.to_owned())
            .collect(),
        _ => Vec::new(),
    };
    LaunchShape {
        command: text("command"),
        args,
        env_names,
    }
}

/// `serverLaunchFingerprint(server)`
pub fn server_launch_fingerprint(server: &JsonValue) -> String {
    launch_fingerprint(&launch_of(server))
}

/// A local server must not start until the person approves its launch: never
/// approved yet, or the command, arguments or env names changed since (12.1).
/// Whether the resolved plan still is the approved one needs the plan itself;
/// the launcher checks that (`plan_fingerprint`) before every start.
pub fn launch_review_needed(server: &JsonValue) -> bool {
    if !matches!(server.get("kind").as_deref(), Some(JsonValue::String(kind)) if kind == "local") {
        return false;
    }
    let approved = server.get("approvedLaunch");
    let same = matches!(
        approved.as_deref(),
        Some(JsonValue::String(text)) if *text == server_launch_fingerprint(server)
    );
    !same || matches!(server.get("approvedPlan").as_deref(), Some(JsonValue::Null))
}
