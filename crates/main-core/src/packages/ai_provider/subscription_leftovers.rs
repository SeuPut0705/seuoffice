//! `packages/ai-provider/src/subscription/leftovers.ts`: cleaning up after an
//! app that was force-killed. No handler runs in that case, so the registry
//! keeps a record of what it started (`process.ts`), and the next start ends
//! whatever is still alive from it.
//!
//! Only a process that is verifiably the recorded one is ended: same pid,
//! same program file, and a start time that matches the moment this app
//! started it. A pid that was reused, by anything at all, fails that check. A
//! Claude or Codex the user runs on their own was never recorded and is never
//! looked at. The same holds for the MCP servers the person approved for the
//! app to start (`USER_MCP_CHILD_KIND`).
//!
//! `SUBSCRIPTION_OWNER_STARTED_AT` is
//! [`SharedChildRegistry::owner_started_at`]. `process.ppid`, which the
//! runtime has no way to read, is `LeftoverCleanupDeps::parent_pid`. The
//! `spawn` stand-in of `ProcessInspectionDeps` is the runtime itself.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use jscompat::node_path::host;
use jscompat::{
    JsObject, JsonValue, date_parse, js_regex, json_parse, number_to_string, to_number, trim,
};

use super::jsval::{as_str, prop};
use super::providers::AI_SUBSCRIPTION_PROVIDERS;
use super::subscription_process::{
    LeftoverChildRecord, SUBSCRIPTION_LEFTOVER_FILE_PREFIX, SharedChildRegistry,
    USER_MCP_CHILD_KIND, kill_process_tree_rt, windows_system_dir, windows_system_tool,
};
use super::subscription_temp_dirs::{
    CleanupTempDirsOptions, TempDirs, cleanup_tracked_temp_dirs, set_subscription_temp_record_dir,
};
use super::task::{
    ChildEvent, FsAnswer, FsOp, Id, JsError, LocalBoxFuture, Rt, SpawnRequest, Stdio,
};

/// `ProcessInfo`: what the system says about a live process
#[derive(Debug, Clone, PartialEq)]
pub struct ProcessInfo {
    /// creation time, epoch ms; NaN when it could not be read
    pub started_at: f64,
    /// full path of the program file; empty when it could not be read
    pub image: String,
}

/// The `Map<number, ProcessInfo>` of an inspection, in the order set
pub type ProcessMap = Vec<(f64, ProcessInfo)>;

/// `map.set(pid, info)`
fn set_info(map: &mut ProcessMap, pid: f64, info: ProcessInfo) {
    match map.iter_mut().find(|(known, _)| *known == pid) {
        Some(slot) => slot.1 = info,
        None => map.push((pid, info)),
    }
}

/// `map.get(pid)`
fn info_of(map: &ProcessMap, pid: f64) -> Option<&ProcessInfo> {
    map.iter()
        .find(|(known, _)| *known == pid)
        .map(|(_, info)| info)
}

/// `ProcessInspector`: looks up live processes by pid; a pid that is not
/// running is absent from the result
pub type ProcessInspector = Rc<dyn Fn(Vec<f64>) -> LocalBoxFuture<Result<ProcessMap, JsError>>>;

/// `LeftoverCleanupDeps`
#[derive(Clone, Default)]
pub struct LeftoverCleanupDeps {
    pub inspect: Option<ProcessInspector>,
    pub kill_tree: Option<Rc<dyn Fn(f64)>>,
    pub platform: Option<String>,
    /// pid of the calling app process; this process when absent
    pub owner_pid: Option<f64>,
    /// `process.ppid`: never ended
    pub parent_pid: Option<f64>,
}

/// `LeftoverCleanupResult`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LeftoverCleanupResult {
    /// recorded processes that were verified and ended
    pub killed: Vec<f64>,
    /// recorded pids that are alive but are not (verifiably) the recorded process
    pub skipped: Vec<f64>,
}

/// `LeftoverRecord.owner`
#[derive(Debug, Clone, PartialEq)]
pub struct LeftoverOwner {
    pub pid: f64,
    pub started_at: f64,
}

/// `LeftoverRecord`: nothing here identifies the user or the conversation
#[derive(Debug, Clone, PartialEq)]
pub struct LeftoverRecord {
    pub owner: LeftoverOwner,
    pub children: Vec<LeftoverChildRecord>,
}

/// `STARTED_BEFORE_RECORD_MS`: the recorded start is taken right after spawn
/// returns, so the real one is a little earlier
const STARTED_BEFORE_RECORD_MS: f64 = 10_000.0;
/// `STARTED_AFTER_RECORD_MS`: slack for clocks and for `ps`, which reports whole seconds
const STARTED_AFTER_RECORD_MS: f64 = 1_500.0;
/// `OWNER_START_SLACK_MS`: an owner's start is recorded from its own uptime
const OWNER_START_SLACK_MS: f64 = 10_000.0;
const INSPECT_TIMEOUT_MS: f64 = 15_000.0;
const MAX_TOOL_OUTPUT_BYTES: usize = 1024 * 1024;

/// `validPid(pid)`
fn valid_pid(pid: f64) -> bool {
    pid.is_finite() && pid.fract() == 0.0 && pid > 0.0
}

/// `validPid(value)` of a JSON value
fn valid_pid_value(value: Option<&JsonValue>) -> Option<f64> {
    match value {
        Some(JsonValue::Number(pid)) if valid_pid(*pid) => Some(*pid),
        _ => None,
    }
}

/// `isTrackedChildKind(kind)`: a record line of any other kind is not this
/// app's to end
fn is_tracked_child_kind(kind: Option<&JsonValue>) -> Option<&str> {
    as_str(kind)
        .filter(|kind| *kind == USER_MCP_CHILD_KIND || AI_SUBSCRIPTION_PROVIDERS.contains(kind))
}

/// `parseRecord(text)`
fn parse_record(content: &str) -> Option<LeftoverRecord> {
    let value = json_parse(content).ok()?;
    if !matches!(value, JsonValue::Object(_) | JsonValue::Array(_)) {
        return None;
    }
    let owner = prop(&value, "owner")?;
    let owner_pid = valid_pid_value(prop(owner, "pid"))?;
    let owner_started_at = match prop(owner, "startedAt") {
        Some(JsonValue::Number(started_at)) => *started_at,
        _ => return None,
    };
    let mut children: Vec<LeftoverChildRecord> = Vec::new();
    if let Some(JsonValue::Array(items)) = prop(&value, "children") {
        for child in items {
            let Some(pid) = valid_pid_value(prop(child, "pid")) else {
                continue;
            };
            let Some(command) = as_str(prop(child, "command")).filter(|c| !c.is_empty()) else {
                continue;
            };
            let started_at = match prop(child, "startedAt") {
                Some(JsonValue::Number(started_at)) if started_at.is_finite() => *started_at,
                _ => continue,
            };
            let Some(provider) = is_tracked_child_kind(prop(child, "provider")) else {
                continue;
            };
            children.push(LeftoverChildRecord {
                pid,
                provider: provider.to_owned(),
                command: command.to_owned(),
                started_at,
            });
        }
    }
    Some(LeftoverRecord {
        owner: LeftoverOwner {
            pid: owner_pid,
            started_at: owner_started_at,
        },
        children,
    })
}

/// `comparable(path, platform)`
fn comparable(path: &str, platform: &str) -> String {
    if platform == "win32" {
        path.replace('/', "\\").to_lowercase()
    } else {
        path.to_owned()
    }
}

/// `realpath(path).catch(() => path)`
async fn real_or_self(rt: &Rt, path: &str) -> String {
    match rt
        .fs(FsOp::Realpath {
            path: path.to_owned(),
        })
        .await
    {
        Ok(FsAnswer::Path(real)) => real,
        _ => path.to_owned(),
    }
}

/// `sameImage(image, command, platform)`: same program file, allowing for a
/// command that was started through a link
async fn same_image(rt: &Rt, image: &str, command: &str, platform: &str) -> bool {
    if image.is_empty() || command.is_empty() {
        return false;
    }
    let names =
        |path: &str, real: String| [comparable(path, platform), comparable(&real, platform)];
    let left = names(image, real_or_self(rt, image).await);
    let right = names(command, real_or_self(rt, command).await);
    left.iter().any(|name| right.contains(name))
}

/// `isRecordedProcess(info, recorded, platform)`
async fn is_recorded_process(
    rt: &Rt,
    info: &ProcessInfo,
    recorded: &LeftoverChildRecord,
    platform: &str,
) -> bool {
    if !info.started_at.is_finite() {
        return false;
    }
    let delta = info.started_at - recorded.started_at;
    if delta > STARTED_AFTER_RECORD_MS || delta < -STARTED_BEFORE_RECORD_MS {
        return false;
    }
    same_image(rt, &info.image, &recorded.command, platform).await
}

/// `rm(file, { force: true }).catch(() => undefined)`
async fn remove_quietly(rt: &Rt, file: &str) {
    let _ = rt
        .fs(FsOp::Rm {
            path: file.to_owned(),
            recursive: false,
            force: true,
        })
        .await;
}

/// `cleanupLeftoverSubscriptionChildren(dir, deps)`: end what a previous,
/// force-killed run of the app left behind in `dir`, and remove its records.
/// Records of an app process that is still running (a second window process,
/// a terminal command) are left alone, children included.
pub async fn cleanup_leftover_subscription_children(
    rt: &Rt,
    shared: &SharedChildRegistry,
    dir: &str,
    deps: &LeftoverCleanupDeps,
) -> LeftoverCleanupResult {
    let mut result = LeftoverCleanupResult::default();
    let platform = deps.platform.clone().unwrap_or_else(|| rt.platform());
    let self_pid = deps.owner_pid.unwrap_or_else(|| rt.pid());
    let names: Vec<String> = match rt
        .fs(FsOp::Readdir {
            path: dir.to_owned(),
            with_types: false,
        })
        .await
    {
        Ok(FsAnswer::Entries(entries)) => entries
            .into_iter()
            .map(|entry| entry.name)
            .filter(|name| {
                name.starts_with(SUBSCRIPTION_LEFTOVER_FILE_PREFIX)
                    && js_regex!(r"^\d+\.json$")
                        .test(&name[SUBSCRIPTION_LEFTOVER_FILE_PREFIX.len()..])
            })
            .collect(),
        _ => Vec::new(),
    };
    if names.is_empty() {
        return result;
    }

    let mut records: Vec<(String, LeftoverRecord)> = Vec::new();
    for name in names {
        let file = host::join(&[dir, &name]);
        let content = match rt.fs(FsOp::ReadFile { path: file.clone() }).await {
            Ok(FsAnswer::Bytes(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
            _ => String::new(),
        };
        match parse_record(&content) {
            Some(record) => records.push((file, record)),
            None => remove_quietly(rt, &file).await,
        }
    }
    // this process's own live record is not a leftover
    let stale: Vec<&(String, LeftoverRecord)> = records
        .iter()
        .filter(|(_, record)| {
            !(record.owner.pid == self_pid
                && (record.owner.started_at - shared.owner_started_at()).abs()
                    <= OWNER_START_SLACK_MS)
        })
        .collect();
    if stale.is_empty() {
        return result;
    }

    let mut pids: Vec<f64> = Vec::new();
    for (_, record) in &stale {
        if record.owner.pid != self_pid && !pids.contains(&record.owner.pid) {
            pids.push(record.owner.pid);
        }
        for child in &record.children {
            if !pids.contains(&child.pid) {
                pids.push(child.pid);
            }
        }
    }
    let inspected = match &deps.inspect {
        Some(inspect) => inspect(pids).await,
        None => inspect_processes(rt, &pids, &ProcessInspectionDeps::default()).await,
    };
    let Ok(processes) = inspected else {
        // nothing can be verified, so nothing is ended; the records stay for the next start
        for (_, record) in &stale {
            result
                .skipped
                .extend(record.children.iter().map(|child| child.pid));
        }
        return result;
    };

    let untouchable: Vec<f64> = [Some(self_pid), Some(rt.pid()), deps.parent_pid]
        .into_iter()
        .flatten()
        .collect();
    for (file, record) in &stale {
        let owner = if record.owner.pid == self_pid {
            None
        } else {
            info_of(&processes, record.owner.pid)
        };
        if let Some(owner) = owner
            && (owner.started_at - record.owner.started_at).abs() <= OWNER_START_SLACK_MS
        {
            continue;
        }
        for child in &record.children {
            let Some(info) = info_of(&processes, child.pid) else {
                continue;
            };
            if !untouchable.contains(&child.pid)
                && is_recorded_process(rt, info, child, &platform).await
            {
                match &deps.kill_tree {
                    Some(kill_tree) => kill_tree(child.pid),
                    None => kill_process_tree_rt(rt, Some(child.pid), true),
                }
                result.killed.push(child.pid);
            } else {
                result.skipped.push(child.pid);
            }
        }
        remove_quietly(rt, file).await;
    }
    result
}

/// `initSubscriptionChildTracking(dir, deps)`: for the app's start-up: end
/// the leftovers of a previous run recorded in `dir` (the app's userData
/// directory), then keep this run's own record there.
pub async fn init_subscription_child_tracking(
    rt: &Rt,
    shared: &SharedChildRegistry,
    temp: &TempDirs,
    dir: &str,
    deps: &LeftoverCleanupDeps,
) -> LeftoverCleanupResult {
    set_subscription_temp_record_dir(&mut temp.borrow_mut(), Some(dir));
    let result = cleanup_leftover_subscription_children(rt, shared, dir, deps).await;
    // the same forced exit may have left the bridges' temporary folders behind
    cleanup_tracked_temp_dirs(rt, temp, dir, &CleanupTempDirsOptions::default()).await;
    shared.record_in(rt, Some(dir));
    result
}

// ── Asking the system about processes ──

/// `ProcessInspectionDeps`: stand-ins for the tests; the system this process
/// runs on when absent
#[derive(Debug, Clone, Default)]
pub struct ProcessInspectionDeps {
    pub platform: Option<String>,
    pub env: Option<Vec<(String, String)>>,
}

/// `runTool(command, args, env, options)`: the exit code and the output of a
/// system tool, which is ended when it does not finish in time
async fn run_tool(
    rt: &Rt,
    command: &str,
    args: Vec<String>,
    env: Vec<(String, String)>,
    cwd: Option<String>,
) -> Result<(Option<f64>, String), JsError> {
    let child = rt
        .spawn(SpawnRequest {
            command: command.to_owned(),
            args,
            cwd,
            env: Some(env),
            stdio: [Stdio::Ignore, Stdio::Pipe, Stdio::Ignore],
            detached: false,
            windows_hide: true,
            shell: None,
        })
        .await?;
    let (settle, wait) = rt.deferred::<Result<(Option<f64>, String), JsError>>();
    let chunks: Rc<RefCell<(Vec<u8>, usize)>> = Rc::new(RefCell::new((Vec::new(), 0)));
    let timer: Rc<Cell<Option<Id>>> = Rc::new(Cell::new(None));
    let on_timeout = (child.clone(), settle.clone());
    timer.set(Some(rt.set_timeout(INSPECT_TIMEOUT_MS, move || {
        on_timeout.0.kill(None);
        on_timeout
            .1
            .settle(Err(JsError::error("The process query did not finish")));
    })));
    let rt_event = rt.clone();
    child.on(move |event| match event {
        ChildEvent::Stdout(chunk) => {
            let mut collected = chunks.borrow_mut();
            if collected.1 >= MAX_TOOL_OUTPUT_BYTES {
                return;
            }
            collected.1 += chunk.len();
            collected.0.extend_from_slice(chunk);
        }
        ChildEvent::Error(error) => {
            rt_event.clear_timeout(timer.get());
            settle.settle(Err(error.clone()));
        }
        ChildEvent::Close { code, .. } => {
            rt_event.clear_timeout(timer.get());
            let collected = chunks.borrow();
            settle.settle(Ok((
                *code,
                String::from_utf8_lossy(&collected.0).into_owned(),
            )));
        }
        ChildEvent::Stderr(_) | ChildEvent::Exit { .. } => {}
    });
    wait.await
}

/// `inspectWindows(pids, deps)`: Windows has no process tool that reports a
/// creation time, so this asks CIM through PowerShell, started by full path
/// with an argument list. The script is fixed; the only variable part is the
/// list of pids, which are integers. It starts in the system directory: the
/// folder the app was started in may be a document's, and nothing is to be
/// looked up there.
async fn inspect_windows(
    rt: &Rt,
    pids: &[f64],
    deps: &ProcessInspectionDeps,
) -> Result<ProcessMap, JsError> {
    let env_pairs = deps.env.clone().unwrap_or_else(|| rt.env_all());
    let env_get = |key: &str| match &deps.env {
        Some(vars) => vars.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()),
        None => rt.env(key),
    };
    let filter = pids
        .iter()
        .map(|pid| format!("ProcessId={}", number_to_string(*pid)))
        .collect::<Vec<_>>()
        .join(" OR ");
    let script = [
        "$ErrorActionPreference='SilentlyContinue'".to_owned(),
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8".to_owned(),
        format!(
            r#"Get-CimInstance Win32_Process -Filter "{filter}" | ForEach-Object {{ $t=''; if ($_.CreationDate) {{ $t=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }}; '{{0}}|{{1}}|{{2}}' -f $_.ProcessId,$t,$_.ExecutablePath }}"#
        ),
    ]
    .join("; ");
    let (_, stdout) = run_tool(
        rt,
        &windows_system_tool(&env_get, &["WindowsPowerShell", "v1.0", "powershell.exe"]),
        vec![
            "-NoProfile".to_owned(),
            "-NonInteractive".to_owned(),
            "-NoLogo".to_owned(),
            "-Command".to_owned(),
            script,
        ],
        env_pairs,
        Some(windows_system_dir(&env_get)),
    )
    .await?;
    let mut found: ProcessMap = Vec::new();
    for line in js_regex!(r"\r?\n").split(&stdout) {
        let mut parts = trim(line).split('|');
        let pid_text = parts.next().unwrap_or("");
        let started_text = parts.next();
        let rest: Vec<&str> = parts.collect();
        let pid = to_number(pid_text);
        if pid_text.is_empty() || !valid_pid(pid) {
            continue;
        }
        set_info(
            &mut found,
            pid,
            ProcessInfo {
                started_at: match started_text {
                    Some(started) if !started.is_empty() => to_number(started),
                    _ => f64::NAN,
                },
                image: rest.join("|"),
            },
        );
    }
    Ok(found)
}

/// `inspectLinux(pids)`: the kernel's own view under /proc
async fn inspect_linux(rt: &Rt, pids: &[f64]) -> ProcessMap {
    let mut found: ProcessMap = Vec::new();
    let read_text = |path: String| async move {
        match rt.fs(FsOp::ReadFile { path }).await {
            Ok(FsAnswer::Bytes(bytes)) => Some(String::from_utf8_lossy(&bytes).into_owned()),
            _ => None,
        }
    };
    let boot = read_text("/proc/stat".to_owned()).await.unwrap_or_default();
    let boot_line = boot.split('\n').find(|line| line.starts_with("btime "));
    let boot_seconds = match boot_line {
        Some(line) => js_regex!(r"\s+")
            .split(line)
            .get(1)
            .map_or(f64::NAN, |seconds| to_number(seconds)),
        None => f64::NAN,
    };
    for pid in pids {
        let id = number_to_string(*pid);
        let Some(stat) = read_text(format!("/proc/{id}/stat")).await else {
            continue;
        };
        // the command name may itself contain spaces and parentheses; fields resume after the last ')'
        let after_name = match stat.rfind(')') {
            Some(at) => &stat[at + 1..],
            None => stat.as_str(),
        };
        let mut skipped = after_name.chars();
        skipped.next();
        // field 22 (start time in clock ticks since boot) is the 20th after the name; ticks are 1/100 s
        let ticks = skipped
            .as_str()
            .split(' ')
            .nth(19)
            .map_or(f64::NAN, to_number);
        let image = match rt
            .fs(FsOp::Readlink {
                path: format!("/proc/{id}/exe"),
            })
            .await
        {
            Ok(FsAnswer::Path(image)) => image,
            _ => String::new(),
        };
        set_info(
            &mut found,
            *pid,
            ProcessInfo {
                started_at: (boot_seconds + ticks / 100.0) * 1000.0,
                image,
            },
        );
    }
    found
}

/// `inspectWithPs(pids)`: macOS and the rest: `ps`, in the C locale so the
/// start time parses
async fn inspect_with_ps(rt: &Rt, pids: &[f64]) -> Result<ProcessMap, JsError> {
    let mut env: JsObject<String> = JsObject::new();
    for (name, value) in rt.env_all() {
        env.set(name, value);
    }
    env.set("LC_ALL", "C".to_owned());
    env.set("LANG", "C".to_owned());
    let (_, stdout) = run_tool(
        rt,
        "/bin/ps",
        vec![
            "-p".to_owned(),
            pids.iter()
                .map(|pid| number_to_string(*pid))
                .collect::<Vec<_>>()
                .join(","),
            "-o".to_owned(),
            "pid=".to_owned(),
            "-o".to_owned(),
            "lstart=".to_owned(),
            "-o".to_owned(),
            "comm=".to_owned(),
        ],
        env.entries()
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value.clone()))
            .collect(),
        None,
    )
    .await?;
    let mut found: ProcessMap = Vec::new();
    for line in stdout.split('\n') {
        let Some(matched) =
            js_regex!(r"^\s*(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$").exec(line)
        else {
            continue;
        };
        set_info(
            &mut found,
            to_number(matched.get(1).unwrap_or("")),
            ProcessInfo {
                started_at: date_parse(matched.get(2).unwrap_or("")),
                image: trim(matched.get(3).unwrap_or("")).to_owned(),
            },
        );
    }
    Ok(found)
}

/// `inspectProcesses(pids, deps)`: start time and program file of each of
/// `pids` that is running
pub async fn inspect_processes(
    rt: &Rt,
    pids: &[f64],
    deps: &ProcessInspectionDeps,
) -> Result<ProcessMap, JsError> {
    let mut valid: Vec<f64> = Vec::new();
    for pid in pids {
        if valid_pid(*pid) && !valid.contains(pid) {
            valid.push(*pid);
        }
    }
    if valid.is_empty() {
        return Ok(Vec::new());
    }
    let platform = deps.platform.clone().unwrap_or_else(|| rt.platform());
    if platform == "win32" {
        return inspect_windows(rt, &valid, deps).await;
    }
    if platform == "linux" {
        return Ok(inspect_linux(rt, &valid).await);
    }
    inspect_with_ps(rt, &valid).await
}
