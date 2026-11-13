//! `packages/ai-provider/src/agent-session/codex-sandbox-probe.ts`: before a
//! Codex agent session opens, the app checks on this PC that Codex's sandbox
//! starts and keeps a denied folder out of reach, with no model call:
//! `codex sandbox` runs `findstr` on two marker files under the session's own
//! profile, one in a folder the probe may read and one in a folder it denies.
//!
//! - both found: the deny is not enforced, the session does not start;
//! - only the readable one: contained;
//! - neither: the sandbox did not start, the session does not start.
//!
//! Windows only; elsewhere Codex's own sandbox is not checked this way.
//!
//! The TypeScript's `spawn` and `registry` dependencies are not options here:
//! the child goes through `Rt::spawn` and the shared registry the caller
//! passes (`SharedChildRegistry`). The default `killTree`
//! (`killProcessTree(target, { force: true })`) is [`default_kill_tree`].

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use jscompat::node_path::host;
use jscompat::{js_regex, json_quote, text_decoder_decode, trim};

use super::agent_session_types::StringTable;
use super::subscription_locate::SubscriptionProgram;
use super::subscription_process::{
    SharedChildRegistry, SubscriptionSpawnOptions, kill_process_tree_rt, spawn_subscription_program,
};
use super::task::{ChildEvent, Id, JsError, Rt, Stdio};

/// `CodexSandboxProbeResult`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexSandboxProbeResult {
    Contained,
    NotContained,
    Unavailable,
}

impl CodexSandboxProbeResult {
    /// the word the TypeScript writes
    pub fn as_str(self) -> &'static str {
        match self {
            CodexSandboxProbeResult::Contained => "contained",
            CodexSandboxProbeResult::NotContained => "not-contained",
            CodexSandboxProbeResult::Unavailable => "unavailable",
        }
    }
}

const PROBE_PROFILE: &str = "seuoffice-probe";
const MARKER: &str = "seuoffice-sandbox-probe";
/// ASCII names: `findstr` prints paths in the console code page, so only the names are compared
const READABLE_NAME: &str = "seuoffice-probe-readable.txt";
const DENIED_NAME: &str = "seuoffice-probe-denied.txt";
const PROBE_TIMEOUT_MS: f64 = 60_000.0;
const OUTPUT_LIMIT: usize = 16_000;

/// `tomlInlineTable(values)`: a TOML inline table of the profile; JSON strings
/// are valid TOML basic strings
pub fn toml_inline_table(values: &StringTable) -> String {
    let entries: Vec<String> = values
        .entries()
        .into_iter()
        .map(|(key, value)| format!("{} = {}", json_quote(key), json_quote(value)))
        .collect();
    format!("{{{}}}", entries.join(", "))
}

/// What `codexSandboxProbeArgs` answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexSandboxProbeArgs {
    pub args: Vec<String>,
    pub readable: String,
    pub denied: String,
}

/// `codexSandboxProbeArgs(filesystem, probeDir, network)`
pub fn codex_sandbox_probe_args(
    filesystem: &StringTable,
    probe_dir: &str,
    network: bool,
) -> CodexSandboxProbeArgs {
    let readable = host::join(&[probe_dir, READABLE_NAME]);
    let denied_dir = host::join(&[probe_dir, "denied"]);
    let denied = host::join(&[&denied_dir, DENIED_NAME]);
    // { ...filesystem, [probeDir]: 'read', [deniedDir]: 'deny' }
    let mut profile = filesystem.clone();
    profile.set(probe_dir, "read".to_owned());
    profile.set(denied_dir.as_str(), "deny".to_owned());
    let mut args: Vec<String> = vec![
        "sandbox".into(),
        "-c".into(),
        "windows.sandbox=\"mxc\"".into(),
        "-c".into(),
        format!("default_permissions=\"{PROBE_PROFILE}\""),
        "-c".into(),
        format!(
            "permissions.{PROBE_PROFILE}.filesystem={}",
            toml_inline_table(&profile)
        ),
    ];
    if network {
        args.push("-c".into());
        args.push(format!("permissions.{PROBE_PROFILE}.network.enabled=true"));
    }
    args.extend(
        [
            "--",
            "findstr.exe",
            "/m",
            MARKER,
            readable.as_str(),
            denied.as_str(),
        ]
        .map(str::to_owned),
    );
    CodexSandboxProbeArgs {
        args,
        readable,
        denied,
    }
}

/// `codexSandboxProbeVerdict(stdout)`: what the probe's output says, by the
/// marker files `findstr` could open
pub fn codex_sandbox_probe_verdict(stdout: &str) -> CodexSandboxProbeResult {
    let found: Vec<String> = js_regex!(r"\r?\n")
        .split(stdout)
        .into_iter()
        .map(|line| trim(line).to_lowercase())
        .filter(|line| !line.is_empty())
        .collect();
    let named = |name: &str| -> bool {
        found
            .iter()
            .any(|line| line.ends_with(&format!("\\{name}")) || line.ends_with(&format!("/{name}")))
    };
    if named(DENIED_NAME) {
        return CodexSandboxProbeResult::NotContained;
    }
    if named(READABLE_NAME) {
        CodexSandboxProbeResult::Contained
    } else {
        CodexSandboxProbeResult::Unavailable
    }
}

/// The default `killTree` of the agent session runners:
/// `killProcessTree(target, { force: true })`, taking the child's pid.
pub fn default_kill_tree(rt: &Rt) -> Rc<dyn Fn(Option<f64>)> {
    let rt = rt.clone();
    Rc::new(move |pid| kill_process_tree_rt(&rt, pid, true))
}

/// `CodexSandboxProbeDeps`
#[derive(Clone, Default)]
pub struct CodexSandboxProbeDeps {
    /// `NodeJS.ProcessEnv` the child's environment is made from; the app's own when absent
    pub base_env: Option<Vec<(String, String)>>,
    /// ends the child's process tree, given its pid
    pub kill_tree: Option<Rc<dyn Fn(Option<f64>)>>,
    pub timeout_ms: Option<f64>,
    /// probe the profile with the network open, as the session will run it
    pub network: Option<bool>,
}

/// `probeCodexSandbox(program, filesystem, probeDir, deps)`
pub async fn probe_codex_sandbox(
    rt: &Rt,
    shared: &SharedChildRegistry,
    program: &SubscriptionProgram,
    filesystem: &StringTable,
    probe_dir: &str,
    deps: &CodexSandboxProbeDeps,
) -> Result<CodexSandboxProbeResult, JsError> {
    use super::task::FsOp;
    let probe = codex_sandbox_probe_args(filesystem, probe_dir, deps.network == Some(true));
    rt.fs(FsOp::Mkdir {
        path: host::join(&[probe_dir, "denied"]),
        recursive: true,
        mode: None,
    })
    .await?;
    for path in [&probe.readable, &probe.denied] {
        rt.fs(FsOp::WriteFile {
            path: path.clone(),
            data: format!("{MARKER}\n").into_bytes(),
            mode: None,
            flag: None,
        })
        .await?;
    }
    let kill_tree = deps
        .kill_tree
        .clone()
        .unwrap_or_else(|| default_kill_tree(rt));
    let (settle, wait) = rt.deferred::<CodexSandboxProbeResult>();
    let stdout = Rc::new(RefCell::new(String::new()));
    let timer: Rc<Cell<Option<Id>>> = Rc::new(Cell::new(None));
    let finish: Rc<dyn Fn(CodexSandboxProbeResult)> = {
        let settle = settle.clone();
        let timer = timer.clone();
        let rt = rt.clone();
        Rc::new(move |result| {
            if settle.settled() {
                return;
            }
            rt.clear_timeout(timer.get());
            settle.settle(result);
        })
    };
    let child = match spawn_subscription_program(
        rt,
        shared,
        program,
        &probe.args,
        &SubscriptionSpawnOptions {
            cwd: Some(probe_dir.to_owned()),
            stdio: Some([Stdio::Ignore, Stdio::Pipe, Stdio::Pipe]),
            base_env: deps.base_env.clone(),
            platform: Some("win32".to_owned()),
            ..SubscriptionSpawnOptions::default()
        },
    )
    .await
    {
        Ok(child) => child,
        Err(_) => return Ok(CodexSandboxProbeResult::Unavailable),
    };
    {
        let finish = finish.clone();
        let pid = child.pid();
        timer.set(Some(rt.set_timeout(
            deps.timeout_ms.unwrap_or(PROBE_TIMEOUT_MS),
            move || {
                kill_tree(pid);
                finish(CodexSandboxProbeResult::Unavailable);
            },
        )));
    }
    {
        let stdout = stdout.clone();
        let finish = finish.clone();
        child.on(move |event| match event {
            ChildEvent::Stdout(chunk) => {
                let mut out = stdout.borrow_mut();
                if out.encode_utf16().count() < OUTPUT_LIMIT {
                    out.push_str(&text_decoder_decode(chunk));
                }
            }
            // stderr is drained so a chatty failure cannot block the process on a full pipe
            ChildEvent::Stderr(_) | ChildEvent::Exit { .. } => {}
            ChildEvent::Error(_) => finish(CodexSandboxProbeResult::Unavailable),
            ChildEvent::Close { .. } => {
                let verdict = codex_sandbox_probe_verdict(&stdout.borrow());
                finish(verdict);
            }
        });
    }
    Ok(wait.await)
}
