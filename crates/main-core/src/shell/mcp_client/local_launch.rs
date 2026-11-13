//! `apps/shell/src/main/mcp-client/local-launch.ts`: the exact command a "my
//! PC" MCP server runs as (user MCP spec 4.5, 5.3). `planned_launch` is what
//! the confirmation shows; `prepare_local_launch` is the one computation both
//! it and the launcher come through. Nothing here runs a shell.
//!
//! `await kit.resolveCommand(...)` is one synchronous call over the
//! [`McpRuntimeKit`] trait. The `AbortSignal` the TypeScript passes through to
//! the kit has no counterpart: a plain call is not cancelled. The types of
//! `runtimes.ts` the kit answers with ([`McpRuntimeId`], [`RuntimeMissing`],
//! [`ResolvedLaunch`]...) are defined here, where the trait needs them; the
//! `runtimes` module of the client_proc slice uses these definitions.
//!
//! `process.env` and `process.platform`, when the options leave them out, are
//! read by [`process_env`] and [`process_platform`].

use jscompat::node_path::{host, posix, win32};
use jscompat::{JsMap, JsObject, JsonValue};

use crate::packages::ai_provider::jsval::{object, text};
use crate::packages::i18n::{ENV_PREFIX, OLD_ENV_PREFIX};

/// `MCP_LOCAL_SYSTEM_ENV`: the system variables a server gets from the app's
/// environment (5.3)
pub const MCP_LOCAL_SYSTEM_ENV: [&str; 15] = [
    "PATH",
    "SystemRoot",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
];

/// `MCP_LOCAL_WINDOWS_ENV`: what Node's process library copies into every
/// child on Windows
pub const MCP_LOCAL_WINDOWS_ENV: [&str; 7] = [
    "HOMEDRIVE",
    "HOMEPATH",
    "LOGONSERVER",
    "SYSTEMDRIVE",
    "USERDOMAIN",
    "USERNAME",
    "WINDIR",
];

/// `neverPassed(name)`: registered names the app never passes on
fn never_passed(name: &str) -> bool {
    let upper = name.to_uppercase();
    [ENV_PREFIX, OLD_ENV_PREFIX]
        .iter()
        .any(|prefix| upper.starts_with(prefix))
}

/// `process.platform`
pub fn process_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// `process.env`
pub fn process_env() -> JsObject<String> {
    std::env::vars_os()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

/// `McpRuntimeId`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpRuntimeId {
    Node,
    Uv,
    Python,
}

impl McpRuntimeId {
    pub fn as_str(self) -> &'static str {
        match self {
            McpRuntimeId::Node => "node",
            McpRuntimeId::Uv => "uv",
            McpRuntimeId::Python => "python",
        }
    }
}

/// `RuntimeDownloadItem`
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeDownloadItem {
    pub runtime: McpRuntimeId,
    pub version: String,
    /// download size in bytes, for the question
    pub bytes: f64,
}

impl RuntimeDownloadItem {
    pub fn to_json(&self) -> JsonValue {
        object(vec![
            ("runtime", text(self.runtime.as_str())),
            ("version", text(self.version.as_str())),
            ("bytes", JsonValue::Number(self.bytes)),
        ])
    }
}

/// `ResolvedLaunch['source']`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchSource {
    Pc,
    App,
}

impl LaunchSource {
    pub fn as_str(self) -> &'static str {
        match self {
            LaunchSource::Pc => "pc",
            LaunchSource::App => "app",
        }
    }
}

/// `ResolvedLaunch`
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedLaunch {
    /// absolute path of the program to start, without a shell
    pub command: String,
    /// arguments before the server's own (npm's CLI script for `npx`/`npm`)
    pub prefix_args: Vec<String>,
    /// variables the launch adds
    pub env: JsObject<String>,
    /// directories to put first on the child's PATH
    pub path_prepend: Vec<String>,
    pub source: LaunchSource,
    pub runtime: Option<McpRuntimeId>,
}

/// `RuntimeMissingDetail`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeMissingDetail {
    NotFound,
    UnsupportedPlatform,
    Declined,
    DownloadNeeded,
    Offline,
    HashMismatch,
    ExtractFailed,
    PythonInstallFailed,
}

impl RuntimeMissingDetail {
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeMissingDetail::NotFound => "not-found",
            RuntimeMissingDetail::UnsupportedPlatform => "unsupported-platform",
            RuntimeMissingDetail::Declined => "declined",
            RuntimeMissingDetail::DownloadNeeded => "download-needed",
            RuntimeMissingDetail::Offline => "offline",
            RuntimeMissingDetail::HashMismatch => "hash-mismatch",
            RuntimeMissingDetail::ExtractFailed => "extract-failed",
            RuntimeMissingDetail::PythonInstallFailed => "python-install-failed",
        }
    }
}

/// `RuntimeMissing`
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeMissing {
    pub detail: RuntimeMissingDetail,
    pub runtime: Option<McpRuntimeId>,
    /// what a download would bring, when one is involved
    pub downloads: Vec<RuntimeDownloadItem>,
    /// English, for the log and the "why" view; never holds secrets
    pub message: String,
}

impl RuntimeMissing {
    pub fn to_json(&self) -> JsonValue {
        object(vec![
            ("ok", JsonValue::Bool(false)),
            ("reason", text("runtime-missing")),
            ("detail", text(self.detail.as_str())),
            (
                "runtime",
                self.runtime.map_or(JsonValue::Null, |r| text(r.as_str())),
            ),
            (
                "downloads",
                JsonValue::Array(
                    self.downloads
                        .iter()
                        .map(RuntimeDownloadItem::to_json)
                        .collect(),
                ),
            ),
            ("message", text(self.message.as_str())),
        ])
    }
}

/// `RuntimeResolution`
#[derive(Debug, Clone, PartialEq)]
pub enum RuntimeResolution {
    Resolved(ResolvedLaunch),
    Missing(RuntimeMissing),
}

/// `ResolveOptions` without the signal
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ResolveOptions {
    /// false: report `download-needed` instead of asking (e.g. for a preview)
    pub offer_download: bool,
}

/// `Pick<McpRuntimeKit, 'resolveCommand'>`: the program to start for a
/// server's `command`
pub trait McpRuntimeKit {
    fn resolve_command(&self, command: &str, options: &ResolveOptions) -> RuntimeResolution;
}

/// `PlannedEnvOrigin`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlannedEnvOrigin {
    System,
    Registered,
    App,
}

impl PlannedEnvOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            PlannedEnvOrigin::System => "system",
            PlannedEnvOrigin::Registered => "registered",
            PlannedEnvOrigin::App => "app",
        }
    }
}

/// `PlannedEnvVar`
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedEnvVar {
    pub name: String,
    pub origin: PlannedEnvOrigin,
}

/// `PlannedLaunchReady`
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedLaunchReady {
    /// absolute path of the program, started directly
    pub command: String,
    /// every argument, in order
    pub args: Vec<String>,
    /// the arguments the app added
    pub added_args: Vec<String>,
    /// the variable names the program gets; values are never part of the plan
    pub env: Vec<PlannedEnvVar>,
    /// registered names the app does not pass on
    pub dropped_env: Vec<String>,
    pub source: LaunchSource,
    pub runtime: Option<McpRuntimeId>,
}

/// `LocalLaunchProblem`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalLaunchProblem {
    EmptyCommand,
    RuntimeMissing,
    NeedsCommandWindow,
    NotAProgram,
}

impl LocalLaunchProblem {
    pub fn as_str(self) -> &'static str {
        match self {
            LocalLaunchProblem::EmptyCommand => "empty-command",
            LocalLaunchProblem::RuntimeMissing => "runtime-missing",
            LocalLaunchProblem::NeedsCommandWindow => "needs-command-window",
            LocalLaunchProblem::NotAProgram => "not-a-program",
        }
    }
}

/// `PlannedLaunchBlocked`
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedLaunchBlocked {
    pub problem: LocalLaunchProblem,
    /// what the runtime lookup reported, for `runtime-missing`
    pub runtime: Option<RuntimeMissing>,
    /// English, for the "why" view; holds no secret
    pub message: String,
}

/// `PlannedLaunch`
#[derive(Debug, Clone, PartialEq)]
pub enum PlannedLaunch {
    Ready(PlannedLaunchReady),
    Blocked(PlannedLaunchBlocked),
}

fn string_array(items: &[String]) -> JsonValue {
    JsonValue::Array(items.iter().map(|s| text(s.as_str())).collect())
}

impl PlannedLaunch {
    /// The plan as it crosses to a screen, keys in the interface's order
    pub fn to_json(&self) -> JsonValue {
        match self {
            PlannedLaunch::Ready(ready) => object(vec![
                ("ok", JsonValue::Bool(true)),
                ("command", text(ready.command.as_str())),
                ("args", string_array(&ready.args)),
                ("addedArgs", string_array(&ready.added_args)),
                (
                    "env",
                    JsonValue::Array(
                        ready
                            .env
                            .iter()
                            .map(|v| {
                                object(vec![
                                    ("name", text(v.name.as_str())),
                                    ("origin", text(v.origin.as_str())),
                                ])
                            })
                            .collect(),
                    ),
                ),
                ("droppedEnv", string_array(&ready.dropped_env)),
                ("source", text(ready.source.as_str())),
                (
                    "runtime",
                    ready.runtime.map_or(JsonValue::Null, |r| text(r.as_str())),
                ),
            ]),
            PlannedLaunch::Blocked(blocked) => object(vec![
                ("ok", JsonValue::Bool(false)),
                ("problem", text(blocked.problem.as_str())),
                (
                    "runtime",
                    blocked
                        .runtime
                        .as_ref()
                        .map_or(JsonValue::Null, RuntimeMissing::to_json),
                ),
                ("message", text(blocked.message.as_str())),
            ]),
        }
    }
}

/// `PlanOptions` without the signal
#[derive(Debug, Clone, Default)]
pub struct PlanOptions {
    /// the app's environment the system variables are read from; this process's when `None`
    pub base_env: Option<JsObject<String>>,
    /// `process.platform` when `None`
    pub platform: Option<String>,
    /// see `MCP_LOCAL_SYSTEM_ENV`
    pub system_env: Option<Vec<String>>,
    /// false (the default here): report a needed download instead of asking for it
    pub offer_download: Option<bool>,
}

/// `Pick<McpServerConfig, 'command' | 'args' | 'env'>`
#[derive(Debug, Clone)]
pub struct LaunchServer {
    pub command: String,
    pub args: Vec<String>,
    pub env: JsObject<String>,
}

/// `PreparedLaunch`: a plan together with the variable values the launcher
/// passes; never leaves the main process
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedLaunch {
    pub plan: PlannedLaunch,
    /// exactly the names of `plan.env`, with their values; `None` when the plan is blocked
    pub env: Option<JsObject<String>>,
}

fn blocked(
    problem: LocalLaunchProblem,
    message: &str,
    runtime: Option<RuntimeMissing>,
) -> PreparedLaunch {
    PreparedLaunch {
        plan: PlannedLaunch::Blocked(PlannedLaunchBlocked {
            problem,
            runtime,
            message: message.to_owned(),
        }),
        env: None,
    }
}

/// `bareCommand(command, platform)`: the bare command name without a Windows
/// program extension, or `None` for a path
fn bare_command(command: &str, platform: &str) -> Option<String> {
    let trimmed = jscompat::trim(command);
    if trimmed.is_empty() || trimmed.contains(['\\', '/']) {
        return None;
    }
    if platform != "win32" {
        return Some(trimmed.to_owned());
    }
    let lower = trimmed.to_lowercase();
    let ext = host::extname(&lower);
    if [".exe", ".com", ".cmd", ".bat"].contains(&ext.as_str()) {
        Some(lower[..lower.len() - ext.len()].to_owned())
    } else {
        Some(lower)
    }
}

/// `npxNeedsYes(args)`: npx asks before installing a package and waits on
/// standard input, which is the MCP channel. Unless npx's own leading options
/// already say yes, `--yes` goes first.
fn npx_needs_yes(args: &[String]) -> bool {
    for arg in args {
        if arg == "--" || !arg.starts_with('-') {
            break;
        }
        if arg == "-y" || arg == "--yes" || arg == "--yes=true" {
            return false;
        }
    }
    true
}

/// `windowsExtension(path)`: Windows drops trailing dots and spaces from a
/// file name, so `x.cmd. ` is `x.cmd`
fn windows_extension(path: &str) -> String {
    win32::extname(path.trim_end_matches(['.', ' '])).to_lowercase()
}

/// `findName(env, name, platform)`
fn find_name(env: &JsObject<String>, name: &str, platform: &str) -> Option<String> {
    if env.get(name).is_some() {
        return Some(name.to_owned());
    }
    if platform != "win32" {
        return None;
    }
    let upper = name.to_uppercase();
    env.entries()
        .into_iter()
        .map(|(key, _)| key)
        .find(|key| key.to_uppercase() == upper)
        .map(str::to_owned)
}

/// `key(name)`: names match without regard to case on Windows
fn env_key(name: &str, platform: &str) -> String {
    if platform == "win32" {
        name.to_uppercase()
    } else {
        name.to_owned()
    }
}

/// `put(name, origin, value)`: the entry goes to the end of the map
fn put_env(
    entries: &mut JsMap<EnvEntry>,
    platform: &str,
    name: &str,
    origin: PlannedEnvOrigin,
    value: &str,
) {
    entries.delete(&env_key(name, platform));
    entries.set(
        env_key(name, platform),
        EnvEntry {
            name: name.to_owned(),
            origin,
            value: value.to_owned(),
        },
    );
}

struct EnvEntry {
    name: String,
    origin: PlannedEnvOrigin,
    value: String,
}

/// `prepareLocalLaunch(server, kit, options)`: resolve a stored local server
/// into the program, arguments and environment that start it
pub fn prepare_local_launch(
    server: &LaunchServer,
    kit: &dyn McpRuntimeKit,
    options: &PlanOptions,
) -> PreparedLaunch {
    let platform = options
        .platform
        .clone()
        .unwrap_or_else(|| process_platform().to_owned());
    let base_env = options.base_env.clone().unwrap_or_else(process_env);
    let command = jscompat::trim(&server.command);
    if command.is_empty() {
        return blocked(
            LocalLaunchProblem::EmptyCommand,
            "the server has no command",
            None,
        );
    }

    let resolved = match kit.resolve_command(
        command,
        &ResolveOptions {
            offer_download: options.offer_download.unwrap_or(false),
        },
    ) {
        RuntimeResolution::Resolved(resolved) => resolved,
        RuntimeResolution::Missing(missing) => {
            let message = missing.message.clone();
            return blocked(LocalLaunchProblem::RuntimeMissing, &message, Some(missing));
        }
    };
    let absolute = if platform == "win32" {
        win32::is_absolute(&resolved.command)
    } else {
        posix::is_absolute(&resolved.command)
    };
    if !absolute {
        return blocked(
            LocalLaunchProblem::NotAProgram,
            "the program was not found by its full path",
            None,
        );
    }
    if platform == "win32" {
        let ext = windows_extension(&resolved.command);
        if ext == ".cmd" || ext == ".bat" {
            return blocked(
                LocalLaunchProblem::NeedsCommandWindow,
                "this command cannot run without a command window",
                None,
            );
        }
        if ext != ".exe" && ext != ".com" {
            return blocked(
                LocalLaunchProblem::NotAProgram,
                "the file is not a program that starts on its own",
                None,
            );
        }
    }

    let added_args: Vec<String> = if bare_command(command, &platform).as_deref() == Some("npx")
        && npx_needs_yes(&server.args)
    {
        vec!["--yes".to_owned()]
    } else {
        Vec::new()
    };
    let args: Vec<String> = resolved
        .prefix_args
        .iter()
        .chain(&added_args)
        .chain(&server.args)
        .cloned()
        .collect();

    // later origins replace earlier ones of the same name (without regard to case on Windows)
    let mut entries: JsMap<EnvEntry> = JsMap::new();
    let mut system: Vec<String> = match &options.system_env {
        Some(names) => names.clone(),
        None => MCP_LOCAL_SYSTEM_ENV
            .iter()
            .map(|s| (*s).to_owned())
            .collect(),
    };
    if platform == "win32" {
        system.extend(MCP_LOCAL_WINDOWS_ENV.iter().map(|s| (*s).to_owned()));
    }
    for wanted in &system {
        if entries.has(&env_key(wanted, &platform)) {
            continue;
        }
        let found = find_name(&base_env, wanted, &platform);
        let value = found.and_then(|f| base_env.get(&f).cloned());
        if let Some(value) = value {
            put_env(
                &mut entries,
                &platform,
                wanted,
                PlannedEnvOrigin::System,
                &value,
            );
        }
    }
    let mut dropped_env: Vec<String> = Vec::new();
    for (name, value) in server.env.entries() {
        if never_passed(name) {
            dropped_env.push(name.to_owned());
        } else {
            put_env(
                &mut entries,
                &platform,
                name,
                PlannedEnvOrigin::Registered,
                value,
            );
        }
    }
    for (name, value) in resolved.env.entries() {
        put_env(&mut entries, &platform, name, PlannedEnvOrigin::App, value);
    }

    // the runtime's own folder first on the child's PATH, never on the app's or the PC's
    if !resolved.path_prepend.is_empty() {
        let delimiter = if platform == "win32" { ";" } else { ":" };
        let current = entries
            .get(&env_key("PATH", &platform))
            .map(|e| (e.name.clone(), e.origin, e.value.clone()));
        let rest: Vec<&str> = match &current {
            Some((_, _, value)) if !value.is_empty() => vec![value.as_str()],
            _ => Vec::new(),
        };
        let joined = resolved
            .path_prepend
            .iter()
            .map(String::as_str)
            .chain(rest)
            .collect::<Vec<_>>()
            .join(delimiter);
        let (name, origin) = match &current {
            Some((name, origin, _)) => (name.clone(), *origin),
            None => ("PATH".to_owned(), PlannedEnvOrigin::App),
        };
        put_env(&mut entries, &platform, &name, origin, &joined);
    }

    let mut env = JsObject::new();
    let mut planned = Vec::new();
    for entry in entries.values() {
        env.set(entry.name.as_str(), entry.value.clone());
        planned.push(PlannedEnvVar {
            name: entry.name.clone(),
            origin: entry.origin,
        });
    }
    PreparedLaunch {
        plan: PlannedLaunch::Ready(PlannedLaunchReady {
            command: resolved.command.clone(),
            args,
            added_args,
            env: planned,
            dropped_env,
            source: resolved.source,
            runtime: resolved.runtime,
        }),
        env: Some(env),
    }
}

/// `plannedLaunch(server, kit, options)`: the command a local server will
/// run, for the confirmation screen (4.5)
pub fn planned_launch(
    server: &LaunchServer,
    kit: &dyn McpRuntimeKit,
    options: &PlanOptions,
) -> PlannedLaunch {
    prepare_local_launch(server, kit, options).plan
}
