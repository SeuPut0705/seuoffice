//! `packages/ai-provider/src/subscription/temp-dirs.ts`: temporary working
//! folders the two subscription bridges create (Codex's app-server thread
//! folder, Claude's per-turn folder). A normal end removes them; a
//! force-killed app cannot, and the Codex folder may still hold copies of
//! attached images.
//!
//! A folder is recorded next to the app's data when it is made, so the next
//! start can tell "a folder this app made" from any other folder in the
//! system's temporary directory. Only a recorded folder, directly under that
//! directory and carrying the app's prefix, is removed. A record whose owner
//! process is still running is left alone (a second window process).
//!
//! The module state of the TypeScript (`recordDir`) is
//! [`SubscriptionTempState`], which the caller owns ([`TempDirs`]). The two
//! things the TypeScript reads of its process that the runtime has no
//! command for are fields of it: the process's uptime (`process.uptime()`),
//! and whether a pid is alive (`process.kill(pid, 0)`).

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::node_path::host;
use jscompat::{JsonValue, json_parse, json_stringify, sha1_hex};

use super::jsval::{as_integer, as_str, number, object, prop, text};
use super::subscription_old_names::OLD_TRACKED_TEMP_PREFIXES;
use super::task::{FileKind, FileStat, FsAnswer, FsOp, JsError, Rt};

/// `TRACKED_TEMP_PREFIXES`: every temporary folder name this module creates
pub const TRACKED_TEMP_PREFIXES: [&str; 2] =
    ["seuoffice-codex-app-server-", "seuoffice-claude-code-"];

const RECORD_PREFIX: &str = "ai-temp-dir-";
const RECORD_VERSION: f64 = 1.0;
/// `OWNER_START_SLACK_MS`: a record and a run of this process are the same
/// run within this slack
const OWNER_START_SLACK_MS: f64 = 10_000.0;

/// `REMOVABLE_TEMP_PREFIXES`: every temporary folder name this module is
/// allowed to remove
fn removable_temp_prefixes() -> impl Iterator<Item = &'static str> {
    TRACKED_TEMP_PREFIXES
        .into_iter()
        .chain(OLD_TRACKED_TEMP_PREFIXES)
}

/// The module state of `temp-dirs.ts`.
pub struct SubscriptionTempState {
    /// `recordDir`: where records go; the app's userData
    pub record_dir: Option<String>,
    /// `process.uptime() * 1000`
    pub uptime_ms: Rc<dyn Fn() -> f64>,
    /// `processAlive(pid)`: whether a process of that id is running
    pub alive: Rc<dyn Fn(f64) -> bool>,
}

impl Default for SubscriptionTempState {
    /// Uptime counts from the moment the state is made (the caller makes it
    /// at start-up; a host that knows the real process uptime sets
    /// `uptime_ms`), and a pid is alive by the system's own answer.
    fn default() -> Self {
        let started = std::time::Instant::now();
        SubscriptionTempState {
            record_dir: None,
            uptime_ms: Rc::new(move || started.elapsed().as_secs_f64() * 1000.0),
            alive: Rc::new(process_alive),
        }
    }
}

/// The state, as the async functions take it
pub type TempDirs = Rc<RefCell<SubscriptionTempState>>;

/// the name the bridges' states hold it under
pub type SubscriptionTempDirsState = SubscriptionTempState;

/// `setSubscriptionTempRecordDir(dir)`: where records go; the app's userData.
/// Called by `initSubscriptionChildTracking`.
pub fn set_subscription_temp_record_dir(state: &mut SubscriptionTempState, dir: Option<&str>) {
    state.record_dir = dir.map(str::to_owned);
}

/// `TempDirRecord`
struct TempDirRecord {
    /// absolute path of the folder this app made
    path: String,
    owner_pid: f64,
    /// when the owner process started, so a reused pid is not mistaken for the owner
    owner_started_at: f64,
}

/// `ownerStartedAt()`: `Date.now() - process.uptime() * 1000`
fn owner_started_at(rt: &Rt, state: &TempDirs) -> f64 {
    let uptime = state.borrow().uptime_ms.clone();
    rt.now() - uptime()
}

/// `recordName(path)`
fn record_name(path: &str) -> String {
    let digest = sha1_hex(path.as_bytes());
    format!("{RECORD_PREFIX}{}.json", &digest[..16])
}

/// `comparable(path)`
fn comparable(rt: &Rt, path: &str) -> String {
    let full = host::resolve(&[path]);
    if rt.platform() == "win32" {
        full.to_lowercase()
    } else {
        full
    }
}

/// `isTrackedPath(path, tempRoot)`
fn is_tracked_path(rt: &Rt, path: &str, temp_root: &str) -> bool {
    let full = host::resolve(&[path]);
    if comparable(rt, &host::dirname(&full)) != comparable(rt, temp_root) {
        return false;
    }
    let base = host::basename(&full, None);
    removable_temp_prefixes().any(|prefix| base.starts_with(prefix))
}

/// `validRecord(text)`
fn valid_record(content: &str) -> Option<TempDirRecord> {
    let value = json_parse(content).ok()?;
    if !matches!(value, JsonValue::Object(_) | JsonValue::Array(_)) {
        return None;
    }
    let path = as_str(prop(&value, "path")).filter(|p| !p.is_empty())?;
    let owner_pid = as_integer(prop(&value, "ownerPid"))?;
    let owner_started_at = match prop(&value, "ownerStartedAt") {
        Some(JsonValue::Number(n)) if n.is_finite() => *n,
        _ => return None,
    };
    Some(TempDirRecord {
        path: path.to_owned(),
        owner_pid,
        owner_started_at,
    })
}

/// `processAlive(pid)`: a process owned by another user answers "not
/// permitted", which still means alive. A system without a way to ask is
/// answered "alive": a record is then kept, never a live folder removed.
fn process_alive(pid: f64) -> bool {
    if !pid.is_finite() || pid.fract() != 0.0 || pid <= 0.0 {
        return false;
    }
    #[cfg(unix)]
    {
        if pid > f64::from(i32::MAX) {
            return false;
        }
        // SAFETY: signal 0 only asks whether the process exists; nothing is sent
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// `TempDirOptions`
#[derive(Debug, Clone, Default)]
pub struct TempDirOptions {
    /// the system temporary directory; the real one when absent
    pub temp_root: Option<String>,
    /// where records are written; the module's record directory when absent
    pub record_dir: Option<String>,
    /// the owner recorded for the folder; this process when absent
    pub owner_pid: Option<f64>,
}

/// `CleanupTempDirsOptions`
#[derive(Default)]
pub struct CleanupTempDirsOptions {
    pub base: TempDirOptions,
    /// test seam: whether a pid is alive; the state's own answer when absent
    pub alive: Option<Rc<dyn Fn(f64) -> bool>>,
}

/// `options.recordDir ?? recordDir`, as `if (dir)` reads it
fn record_dir_of(state: &TempDirs, options: &TempDirOptions) -> Option<String> {
    options
        .record_dir
        .clone()
        .or_else(|| state.borrow().record_dir.clone())
        .filter(|dir| !dir.is_empty())
}

/// `createTrackedTempDir(prefix, options)`: make a temporary folder and
/// record that this app made it. Without a record directory (standalone
/// editors that never call the tracking init) the folder is made as before;
/// it just cannot be cleaned after a forced exit.
pub async fn create_tracked_temp_dir(
    rt: &Rt,
    state: &TempDirs,
    prefix: &str,
    options: &TempDirOptions,
) -> Result<String, JsError> {
    let root = options.temp_root.clone().unwrap_or_else(|| rt.tmpdir());
    let path = match rt
        .fs(FsOp::Mkdtemp {
            prefix: host::join(&[&root, prefix]),
        })
        .await?
    {
        FsAnswer::Path(path) => path,
        other => return Err(JsError::type_error(format!("mkdtemp answered {other:?}"))),
    };
    let Some(dir) = record_dir_of(state, options) else {
        return Ok(path);
    };
    // the folder is still usable; without a record it is left for the system's cleanup
    let _ = async {
        rt.fs(FsOp::Mkdir {
            path: dir.clone(),
            recursive: true,
            mode: None,
        })
        .await?;
        let record = object(vec![
            ("version", number(RECORD_VERSION)),
            ("path", text(path.clone())),
            (
                "ownerPid",
                number(options.owner_pid.unwrap_or_else(|| rt.pid())),
            ),
            ("ownerStartedAt", number(owner_started_at(rt, state))),
        ]);
        rt.fs(FsOp::WriteFile {
            path: host::join(&[&dir, &record_name(&path)]),
            data: json_stringify(&record).into_bytes(),
            mode: None,
            flag: None,
        })
        .await?;
        Ok::<(), JsError>(())
    }
    .await;
    Ok(path)
}

/// `rm(path, { force: true })` with its failure ignored
async fn remove_quietly(rt: &Rt, path: &str) {
    let _ = rt
        .fs(FsOp::Rm {
            path: path.to_owned(),
            recursive: false,
            force: true,
        })
        .await;
}

/// `removeTrackedTempDir(path, options)`: remove a folder made by
/// [`create_tracked_temp_dir`], and its record. Never fails.
pub async fn remove_tracked_temp_dir(
    rt: &Rt,
    state: &TempDirs,
    path: &str,
    options: &TempDirOptions,
) {
    let removed = rt
        .fs(FsOp::Rm {
            path: path.to_owned(),
            recursive: true,
            force: true,
        })
        .await
        .is_ok();
    // a locked folder keeps its record, so the next start tries again
    if !removed {
        return;
    }
    if let Some(dir) = record_dir_of(state, options) {
        remove_quietly(rt, &host::join(&[&dir, &record_name(path)])).await;
    }
}

/// `cleanupTrackedTempDirs(dir, options)`: remove folders a previous,
/// force-killed run recorded. Answers how many folders were removed. A folder
/// whose owner still runs is kept, record and all, so a second live process
/// is never disturbed.
pub async fn cleanup_tracked_temp_dirs(
    rt: &Rt,
    state: &TempDirs,
    dir: &str,
    options: &CleanupTempDirsOptions,
) -> f64 {
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
            .filter(|name| name.starts_with(RECORD_PREFIX) && name.ends_with(".json"))
            .collect(),
        _ => Vec::new(),
    };
    if names.is_empty() {
        return 0.0;
    }
    let temp_root = options
        .base
        .temp_root
        .clone()
        .unwrap_or_else(|| rt.tmpdir());
    let alive = options
        .alive
        .clone()
        .unwrap_or_else(|| state.borrow().alive.clone());
    let now = owner_started_at(rt, state);
    let mut removed = 0.0;
    for name in names {
        let file = host::join(&[dir, &name]);
        let content = match rt.fs(FsOp::ReadFile { path: file.clone() }).await {
            Ok(FsAnswer::Bytes(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
            _ => String::new(),
        };
        let Some(record) = valid_record(&content) else {
            remove_quietly(rt, &file).await;
            continue;
        };
        if !is_tracked_path(rt, &record.path, &temp_root) {
            // not something this module made: drop the record, leave the folder alone
            remove_quietly(rt, &file).await;
            continue;
        }
        if record.owner_pid == rt.pid()
            && (record.owner_started_at - now).abs() <= OWNER_START_SLACK_MS
        {
            continue;
        }
        if record.owner_pid != rt.pid() && alive(record.owner_pid) {
            continue;
        }
        let outcome = async {
            let info = rt
                .fs(FsOp::Lstat {
                    path: record.path.clone(),
                })
                .await?;
            // a link is removed as a link; recursive removal never follows it
            let is_directory = matches!(
                info,
                FsAnswer::Stat(FileStat {
                    kind: FileKind::Dir,
                    ..
                })
            );
            rt.fs(FsOp::Rm {
                path: record.path.clone(),
                recursive: is_directory,
                force: true,
            })
            .await?;
            removed += 1.0;
            rt.fs(FsOp::Rm {
                path: file.clone(),
                recursive: false,
                force: true,
            })
            .await?;
            Ok::<(), JsError>(())
        }
        .await;
        if outcome.is_err() {
            // gone already, or locked: keep the record and try again next start
            let still_there = rt
                .fs(FsOp::Lstat {
                    path: record.path.clone(),
                })
                .await
                .is_ok();
            if !still_there {
                remove_quietly(rt, &file).await;
            }
        }
    }
    removed
}
