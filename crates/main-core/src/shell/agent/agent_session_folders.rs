//! `apps/shell/src/main/agent/agent-session-folders.ts`: the session folders
//! of agent mode (decision 0032) in the system's temporary folder. Each carries
//! a mark naming the process that made it, so that the folders an app left when
//! it did not quit normally can be removed at the next start without touching
//! the folders of another SeuOffice that runs now.
//!
//! What the TypeScript takes from Node (`tmpdir`, `process`, `Date.now`,
//! `execFile`, the random letters of `mkdtemp`) the caller gives through
//! [`FolderHost`]. File work goes through `std::fs` with Node's error text.

use std::fs;

use jscompat::node_path::host::join;
use jscompat::{JsonValue, base64, js_regex, json_parse, number_to_string, to_number, trim};

use crate::markdown::fs_util::{rm_recursive_force, write_file_excl};
use crate::node_fs::{NodeError, mkdtemp, namespaced};
use crate::shell::recent_files::StatInfo;

const PREFIX: &str = "ieum-agent-";
const OWNER_FILE: &str = "owner.json";

/// An unmarked folder (from a version before the mark) goes once nothing in it changed for this long
const UNMARKED_MAX_AGE_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
/// How much later than its folder a process may seem to have started and still be taken for its
/// owner: the two times come from the clock at different moments, and the clock can be set back
/// between them. A process that started later than this is another one that got the same number
const START_SLACK_MS: f64 = 5.0 * 60.0 * 1000.0;
const MAX_FOLDERS_PER_SWEEP: usize = 100;
/// a session folder holds a few files; one holding more is not one this app left, and is kept
const MAX_ENTRIES_PER_FOLDER: usize = 256;
pub const PROCESS_QUERY_TIMEOUT_MS: u32 = 10_000;
/// `maxBuffer` of the process queries
pub const PROCESS_QUERY_MAX_BUFFER: u32 = 1 << 20;

/// One `execFile` of the process queries: the options are `{ cwd, timeout, windowsHide: true,
/// maxBuffer }`
#[derive(Debug, Clone, PartialEq)]
pub struct ExecRequest {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub timeout_ms: u32,
    pub max_buffer: u32,
}

/// What this module takes from Node and the system
pub trait FolderHost {
    /// `os.tmpdir()`
    fn tmpdir(&self) -> String;
    /// `Date.now()`
    fn now_ms(&self) -> f64;
    /// `process.pid`
    fn pid(&self) -> f64;
    /// `process.uptime()`, in seconds
    fn uptime_secs(&self) -> f64;
    /// `process.platform`
    fn platform(&self) -> String;
    /// `windowsSystemDir(process.env)`
    fn windows_system_dir(&self) -> String;
    /// `windowsSystemTool(process.env, ...segments)`
    fn windows_system_tool(&self, segments: &[&str]) -> String;
    /// the six letters or digits `mkdtemp` adds to its prefix
    fn random_suffix(&mut self) -> String;
    /// `process.kill(pid, 0)` did not throw, or threw `EPERM`
    fn process_alive(&mut self, pid: f64) -> bool;
    /// `execFile` to its end: what the program wrote to stdout, empty where it failed
    fn exec_file(&mut self, request: &ExecRequest) -> String;
}

struct FolderOwner {
    pid: f64,
    /// when the folder was made, in milliseconds since 1970
    created_at: f64,
}

/// Make a session folder in `parent` (the system's temporary folder when `None`), marked with
/// this process as its owner
pub fn make_agent_session_folder<H: FolderHost + ?Sized>(
    host: &mut H,
    parent: Option<&str>,
) -> Result<String, NodeError> {
    let parent = match parent {
        Some(parent) => parent.to_owned(),
        None => host.tmpdir(),
    };
    let dir = mkdtemp(&join(&[&parent, PREFIX]), &mut || host.random_suffix())?;
    let owner = format!(
        "{{\"pid\":{},\"createdAt\":{}}}",
        number_to_string(host.pid()),
        number_to_string(host.now_ms())
    );
    if let Err(error) = write_file_excl(&join(&[&dir, OWNER_FILE]), owner.as_bytes()) {
        let _ = rm_recursive_force(&dir);
        return Err(error);
    }
    Ok(dir)
}

/// the lookup of when processes started: process numbers in, pairs of number and time out
pub type StartTimes<'a> = dyn Fn(&[f64]) -> Vec<(f64, f64)> + 'a;

/// `AgentFolderSweepOptions`: what is `None` is the default of the TypeScript
#[derive(Default)]
pub struct SweepOptions<'a> {
    /// where the session folders are made; the system's temporary folder by default
    pub parent: Option<String>,
    pub now: Option<f64>,
    /// whether a process with this number runs
    pub alive: Option<&'a dyn Fn(f64) -> bool>,
    /// when running processes started, in milliseconds since 1970, as pairs of a process number
    /// and a time; a process left out is unknown
    pub start_times: Option<&'a StartTimes<'a>>,
}

/// What a session folder holds, as listed without following a link
struct FolderListing {
    /// every entry inside, deepest first: its path and whether it is a folder
    entries: Vec<(String, bool)>,
    /// the latest change to the folder or anything in it
    changed_at: f64,
}

struct Running {
    listing: FolderListing,
    dir: String,
    owner: FolderOwner,
}

/// Remove the session folders whose owner process is gone, and the unmarked ones nothing changed
/// in for a day. A folder that is, or holds, a link is left, and so is one that cannot be listed
/// or judged. Never fails.
pub fn sweep_agent_session_folders<H: FolderHost + ?Sized>(host: &mut H, options: &SweepOptions) {
    let parent = match &options.parent {
        Some(parent) => parent.clone(),
        None => host.tmpdir(),
    };
    let now = match options.now {
        Some(now) => now,
        None => host.now_ms(),
    };
    // the system's temporary-file cleanup takes what is left
    let _ = sweep(host, options, &parent, now);
}

/// `readdir(dir)`: libuv sorts the names by bytes; `None` where it throws
fn read_dir_names(dir: &str) -> Option<Vec<String>> {
    let mut names: Vec<String> = fs::read_dir(namespaced(dir))
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    Some(names)
}

fn sweep<H: FolderHost + ?Sized>(
    host: &mut H,
    options: &SweepOptions,
    parent: &str,
    now: f64,
) -> Option<()> {
    // `mkdtemp` adds six letters or digits to the prefix
    let folder_name = js_regex!(r"^ieum-agent-[A-Za-z0-9]{6}$");
    let names: Vec<String> = read_dir_names(parent)?
        .into_iter()
        .filter(|name| folder_name.test(name))
        .take(MAX_FOLDERS_PER_SWEEP)
        .collect();
    let mut running: Vec<Running> = Vec::new();
    for name in names {
        let dir = join(&[parent, &name]);
        let Some(listing) = list_folder(&dir) else {
            continue;
        };
        match read_owner(&dir) {
            None => {
                if now - listing.changed_at > UNMARKED_MAX_AGE_MS {
                    remove_listed(&dir, &listing);
                }
            }
            Some(owner) => {
                let alive = match options.alive {
                    Some(alive) => alive(owner.pid),
                    None => host.process_alive(owner.pid),
                };
                if !alive {
                    remove_listed(&dir, &listing);
                } else {
                    running.push(Running {
                        listing,
                        dir,
                        owner,
                    });
                }
            }
        }
    }
    if running.is_empty() {
        return Some(());
    }
    let mut pids: Vec<f64> = Vec::new();
    for folder in &running {
        if !pids.contains(&folder.owner.pid) {
            pids.push(folder.owner.pid);
        }
    }
    let started = match options.start_times {
        Some(start_times) => start_times(&pids),
        None => process_start_times(host, &pids),
    };
    for folder in &running {
        let started_at = started
            .iter()
            .find(|(pid, _)| *pid == folder.owner.pid)
            .map(|(_, at)| *at);
        // a process can make a folder only after it started: one started later has the number of
        // an owner that is gone
        if let Some(started_at) = started_at
            && started_at > folder.owner.created_at + START_SLACK_MS
        {
            remove_listed(&folder.dir, &folder.listing);
        }
    }
    Some(())
}

/// `listFolder(dir)`
fn list_folder(dir: &str) -> Option<FolderListing> {
    let mut entries: Vec<(String, bool)> = Vec::new();
    let mut changed_at = 0.0;
    match visit(dir, &mut entries, &mut changed_at) {
        Some(true) => Some(FolderListing {
            entries,
            changed_at,
        }),
        _ => None,
    }
}

/// `visit(path)` of `listFolder`: `Some(false)` is the `false` it returns, `None` a throw
fn visit(path: &str, entries: &mut Vec<(String, bool)>, changed_at: &mut f64) -> Option<bool> {
    let info = fs::symlink_metadata(namespaced(path)).ok()?;
    if info.file_type().is_symlink() || !info.is_dir() {
        return Some(false);
    }
    *changed_at = jscompat::math_max(*changed_at, StatInfo::of(&info).mtime_ms);
    let mut children: Vec<(String, fs::FileType)> = Vec::new();
    for child in fs::read_dir(namespaced(path)).ok()? {
        let child = child.ok()?;
        children.push((
            child.file_name().to_string_lossy().into_owned(),
            child.file_type().ok()?,
        ));
    }
    children.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, kind) in children {
        let full = join(&[path, &name]);
        if entries.len() >= MAX_ENTRIES_PER_FOLDER {
            return Some(false);
        }
        if kind.is_dir() {
            if !visit(&full, entries, changed_at)? {
                return Some(false);
            }
            entries.push((full, true));
            continue;
        }
        // a link, or anything other than a plain file (a Windows junction lists as a link)
        if !kind.is_file() {
            return Some(false);
        }
        let file = fs::symlink_metadata(namespaced(&full)).ok()?;
        if !file.is_file() {
            return Some(false);
        }
        *changed_at = jscompat::math_max(*changed_at, StatInfo::of(&file).mtime_ms);
        entries.push((full, false));
    }
    Some(true)
}

/// `readOwner(dir)`
fn read_owner(dir: &str) -> Option<FolderOwner> {
    let bytes = fs::read(namespaced(&join(&[dir, OWNER_FILE]))).ok()?;
    let raw = json_parse(&String::from_utf8_lossy(&bytes)).ok()?;
    let JsonValue::Object(object) = &raw else {
        return None;
    };
    let pid = match object.get("pid") {
        Some(JsonValue::Number(pid))
            if pid.is_finite() && pid.fract() == 0.0 && pid.abs() <= 9_007_199_254_740_991.0 =>
        {
            *pid
        }
        _ => return None,
    };
    if pid <= 0.0 {
        return None;
    }
    let created_at = match object.get("createdAt") {
        Some(JsonValue::Number(created_at)) if created_at.is_finite() => *created_at,
        _ => return None,
    };
    Some(FolderOwner { pid, created_at })
}

/// Remove what the listing found, entry by entry: a file is unlinked and a folder removed only
/// when empty, so a link put in place meanwhile is removed itself and never followed, and anything
/// added meanwhile keeps its folder
fn remove_listed(dir: &str, listing: &FolderListing) {
    for (path, folder) in &listing.entries {
        let removed = if *folder {
            fs::remove_dir(namespaced(path))
        } else {
            fs::remove_file(namespaced(path))
        };
        if removed.is_err() {
            // in use, or changed since it was listed: left for a later start
            return;
        }
    }
    let _ = fs::remove_dir(namespaced(dir));
}

/// `map.set(key, value)`: a key that is there keeps its place
fn set_time(times: &mut Vec<(f64, f64)>, pid: f64, at: f64) {
    match times.iter_mut().find(|(known, _)| *known == pid) {
        Some(entry) => entry.1 = at,
        None => times.push((pid, at)),
    }
}

/// This process from its own clock; the others from the system, in one program run
fn process_start_times<H: FolderHost + ?Sized>(host: &mut H, pids: &[f64]) -> Vec<(f64, f64)> {
    let mut out: Vec<(f64, f64)> = Vec::new();
    let mut others: Vec<f64> = Vec::new();
    for &pid in pids {
        if pid == host.pid() {
            set_time(&mut out, pid, host.now_ms() - host.uptime_secs() * 1000.0);
        } else {
            others.push(pid);
        }
    }
    if others.is_empty() {
        return out;
    }
    let listed = if host.platform() == "win32" {
        windows_start_times(host, &others)
    } else {
        posix_start_times(host, &others)
    };
    for (pid, started_at) in listed {
        set_time(&mut out, pid, started_at);
    }
    out
}

/// `run(file, args, { cwd })`
fn run<H: FolderHost + ?Sized>(
    host: &mut H,
    file: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> String {
    host.exec_file(&ExecRequest {
        file,
        args,
        cwd,
        timeout_ms: PROCESS_QUERY_TIMEOUT_MS,
        max_buffer: PROCESS_QUERY_MAX_BUFFER,
    })
}

/// Windows PowerShell started by full path, without a shell; the numbers are the only input
fn windows_start_times<H: FolderHost + ?Sized>(host: &mut H, pids: &[f64]) -> Vec<(f64, f64)> {
    let ids: Vec<String> = pids.iter().map(|pid| number_to_string(*pid)).collect();
    let script = [
        "$ErrorActionPreference = 'SilentlyContinue'".to_owned(),
        format!("foreach ($id in @({})) {{", ids.join(",")),
        "  $p = Get-Process -Id $id".to_owned(),
        "  if ($p -and $p.StartTime) { \"$id \" + ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() }"
            .to_owned(),
        "}".to_owned(),
        // a number not found fails its own line only
        "exit 0".to_owned(),
    ]
    .join("\n");
    let bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    let file = host.windows_system_tool(&["WindowsPowerShell", "v1.0", "powershell.exe"]);
    let cwd = host.windows_system_dir();
    let stdout = run(
        host,
        file,
        vec![
            "-NoLogo".to_owned(),
            "-NoProfile".to_owned(),
            "-NonInteractive".to_owned(),
            "-EncodedCommand".to_owned(),
            base64(&bytes),
        ],
        Some(cwd),
    );
    let mut out: Vec<(f64, f64)> = Vec::new();
    for line in js_regex!(r"\r?\n").split(&stdout) {
        if let Some(found) = js_regex!(r"^(\d+) (\d+)$").exec(trim(line)) {
            set_time(
                &mut out,
                to_number(found.get(1).unwrap_or("")),
                to_number(found.get(2).unwrap_or("")),
            );
        }
    }
    out
}

/// `ps` gives how long each has run (`[[dd-]hh:]mm:ss`), in the same words on every locale
fn posix_start_times<H: FolderHost + ?Sized>(host: &mut H, pids: &[f64]) -> Vec<(f64, f64)> {
    let ids: Vec<String> = pids.iter().map(|pid| number_to_string(*pid)).collect();
    let stdout = run(
        host,
        "/bin/ps".to_owned(),
        vec![
            "-o".to_owned(),
            "pid=".to_owned(),
            "-o".to_owned(),
            "etime=".to_owned(),
            "-p".to_owned(),
            ids.join(","),
        ],
        None,
    );
    let now = host.now_ms();
    let mut out: Vec<(f64, f64)> = Vec::new();
    for line in stdout.split('\n') {
        let Some(found) =
            js_regex!(r"^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$").exec(line)
        else {
            continue;
        };
        let number = |at: usize| found.get(at).map_or(0.0, to_number);
        let elapsed = ((number(2) * 24.0 + number(3)) * 60.0 + number(4)) * 60.0 + number(5);
        set_time(&mut out, number(1), now - elapsed * 1000.0);
    }
    out
}
