//! `apps/shell/src/main/mac-update.ts`.
//!
//! The child processes (`ditto`, `PlistBuddy`, `codesign`, the swap script)
//! go through closures, so the caller (or the harness) decides what runs.

use std::fs;
use std::process::{Command, Stdio};

use jscompat::node_path::host::{basename, dirname, join};
use jscompat::{number_to_string, trim};
use serde_json::Value;

use crate::node_fs::{NodeError, code_of, node_error};
use crate::shell::update_attempt::install_dir_writable;

/// `macAppBundle`
pub fn mac_app_bundle(exec_path: &str) -> Option<String> {
    let macos = dirname(exec_path);
    let contents = dirname(&macos);
    let bundle = dirname(&contents);
    if basename(&macos, None) != "MacOS" || basename(&contents, None) != "Contents" {
        return None;
    }
    if !bundle.ends_with(".app") || basename(&bundle, None) == ".app" {
        return None;
    }
    Some(bundle)
}

/// `macStagingDir`
pub fn mac_staging_dir(bundle: &str) -> String {
    join(&[
        &dirname(bundle),
        &format!(".{}.update", basename(bundle, None)),
    ])
}

/// `macPreviousDir`
pub fn mac_previous_dir(bundle: &str) -> String {
    join(&[
        &dirname(bundle),
        &format!(".{}.previous", basename(bundle, None)),
    ])
}

/// `MacSelfUpdateBlock`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacSelfUpdateBlock {
    NotAnAppBundle,
    Translocated,
    ReadOnly,
}

impl MacSelfUpdateBlock {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotAnAppBundle => "not-an-app-bundle",
            Self::Translocated => "translocated",
            Self::ReadOnly => "read-only",
        }
    }
}

/// `macSelfUpdateBlock`; `pid` is `process.pid`, `writable` defaults to
/// [`install_dir_writable`] in the TypeScript (pass that function for it).
pub fn mac_self_update_block(
    exec_path: &str,
    pid: f64,
    writable: &mut dyn FnMut(&str, &str) -> bool,
) -> Option<MacSelfUpdateBlock> {
    let Some(bundle) = mac_app_bundle(exec_path) else {
        return Some(MacSelfUpdateBlock::NotAnAppBundle);
    };
    if bundle.contains("/AppTranslocation/") {
        return Some(MacSelfUpdateBlock::Translocated);
    }
    let probe = format!(".seuoffice-update-check-{}", number_to_string(pid));
    if !writable(&dirname(&bundle), &probe) {
        return Some(MacSelfUpdateBlock::ReadOnly);
    }
    None
}

/// The default `writable` of `macSelfUpdateBlock`.
pub fn default_writable(dir: &str, probe_name: &str) -> bool {
    install_dir_writable(dir, probe_name)
}

/// `rmSync(path, { recursive: true, force: true })`
fn rm_rf(path: &str) -> Result<(), NodeError> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if code_of(&e) == Some("ENOENT") => return Ok(()),
        Err(e) => return Err(node_error(&e, "lstat", path)),
    };
    let result = if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    match result {
        Err(e) if code_of(&e) != Some("ENOENT") => Err(node_error(&e, "rm", path)),
        _ => Ok(()),
    }
}

/// `removeMacLeftovers`: never fails.
pub fn remove_mac_leftovers(bundle: &str) {
    for dir in [mac_staging_dir(bundle), mac_previous_dir(bundle)] {
        let _ = rm_rf(&dir);
    }
}

/// `RunProgram`: the file and its arguments, the standard output or the
/// message of the `Error` the promise rejects with.
pub type RunProgram<'a> = &'a mut dyn FnMut(&str, &[String]) -> Result<String, String>;

/// `runProgram`: `execFile` without a shell, 4 MiB of output at most.
pub fn run_program(file: &str, args: &[String]) -> Result<String, String> {
    const MAX_BUFFER: usize = 4 * 1024 * 1024;
    let output = Command::new(file)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("spawn {file} {}", spawn_code(&e)))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if output.stdout.len() > MAX_BUFFER || output.stderr.len() > MAX_BUFFER {
        return Err("stdout maxBuffer length exceeded".to_string());
    }
    if output.status.success() {
        return Ok(stdout);
    }
    let mut cmd = file.to_string();
    if !args.is_empty() {
        cmd.push(' ');
        cmd.push_str(&args.join(" "));
    }
    let message = format!("Command failed: {cmd}\n{stderr}");
    let detail = trim(&stderr);
    Err(if detail.is_empty() {
        message
    } else {
        format!("{message}: {detail}")
    })
}

/// The Node name of a failed spawn (`ENOENT`, `EACCES`)
fn spawn_code(e: &std::io::Error) -> String {
    code_of(e).unwrap_or("UNKNOWN").to_string()
}

/// `plistValue`
fn plist_value(run: RunProgram, bundle: &str, key: &str) -> Result<String, String> {
    let plist = join(&[bundle, "Contents", "Info.plist"]);
    let out = run(
        "/usr/libexec/PlistBuddy",
        &["-c".to_string(), format!("Print :{key}"), plist],
    )?;
    Ok(trim(&out).to_string())
}

fn plain(message: String) -> NodeError {
    NodeError {
        code: None,
        message,
    }
}

/// `stageMacUpdate`; `step` is the `step` option (`() => {}` when absent).
pub fn stage_mac_update(
    zip: &str,
    bundle: &str,
    version: &str,
    run: RunProgram,
    step: &mut dyn FnMut(&str),
) -> Result<String, NodeError> {
    let staging = mac_staging_dir(bundle);
    rm_rf(&staging)?;
    if let Err(e) = fs::create_dir(&staging) {
        return Err(node_error(&e, "mkdir", &staging));
    }
    let attempt = (|| -> Result<String, NodeError> {
        step("unpack-start");
        run(
            "/usr/bin/ditto",
            &[
                "-x".to_string(),
                "-k".to_string(),
                zip.to_string(),
                staging.clone(),
            ],
        )
        .map_err(plain)?;
        step("unpack-end");
        step("verify-start");
        let entries = fs::read_dir(&staging).map_err(|e| node_error(&e, "scandir", &staging))?;
        let mut apps = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| node_error(&e, "scandir", &staging))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".app") {
                apps.push(name);
            }
        }
        if apps.len() != 1 {
            return Err(plain(format!(
                "the update holds {} apps, not one",
                apps.len()
            )));
        }
        let staged = join(&[&staging, &apps[0]]);
        let staged_version =
            plist_value(&mut *run, &staged, "CFBundleShortVersionString").map_err(plain)?;
        if staged_version != version {
            return Err(plain(format!(
                "the update holds version {staged_version}, not {version}"
            )));
        }
        // Promise.all: both calls start, the first rejection in call order wins
        let installed_id = plist_value(&mut *run, bundle, "CFBundleIdentifier");
        let staged_id = plist_value(&mut *run, &staged, "CFBundleIdentifier");
        let installed_id = installed_id.map_err(plain)?;
        let staged_id = staged_id.map_err(plain)?;
        if staged_id != installed_id {
            return Err(plain(format!(
                "the update is {staged_id}, not {installed_id}"
            )));
        }
        run(
            "/usr/bin/codesign",
            &[
                "--verify".to_string(),
                "--deep".to_string(),
                "--strict".to_string(),
                staged.clone(),
            ],
        )
        .map_err(plain)?;
        step("verify-end");
        Ok(staged)
    })();
    match attempt {
        Ok(staged) => Ok(staged),
        Err(err) => {
            rm_rf(&staging)?;
            Err(err)
        }
    }
}

/// `installMacStaging`, the check: does the updater still have the two
/// methods (`updateDownloaded` and `dispatchUpdateDownloaded`, both functions)?
/// When it does, the caller replaces `updateDownloaded` by a call of
/// [`staged_update_downloaded`].
pub fn install_mac_staging(
    update_downloaded_is_function: bool,
    dispatch_is_function: bool,
) -> bool {
    update_downloaded_is_function && dispatch_is_function
}

/// The replacement `updateDownloaded` of `installMacStaging`: `event` is
/// `{ downloadedFile, version }` (a field it lacks is `undefined`, `null`
/// here). Stages the zip, then dispatches `event`; answers `[]`.
pub fn staged_update_downloaded(
    event: &Value,
    stage: &mut dyn FnMut(&Value, &Value) -> Result<(), String>,
    dispatch: &mut dyn FnMut(&Value),
) -> Result<Vec<String>, String> {
    let field = |key: &str| event.get(key).cloned().unwrap_or(Value::Null);
    stage(&field("downloadedFile"), &field("version"))?;
    dispatch(event);
    Ok(Vec::new())
}

/// `MAC_SWAP_SCRIPT`
pub const MAC_SWAP_SCRIPT: &str = r#"pid=$1 app=$2 staged=$3 staging=$4 previous=$5 log=$6 opener=$7
note() { printf '%s info [swap] %s\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$log" 2>/dev/null; }
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 600 ]; then
    note 'the app did not quit within a minute; the update was not installed'
    exit 1
  fi
  /bin/sleep 0.1
done
note 'phase swap-start'
/bin/rm -rf "$previous"
installed=0
if /bin/mv "$app" "$previous"; then
  if /bin/mv "$staged" "$app"; then
    note 'installed the new version'
    installed=1
  else
    note 'could not move the new version in; putting the previous one back'
    /bin/mv "$previous" "$app" || note "could not put the previous version back from $previous"
  fi
else
  note 'could not move the running version aside; the update was not installed'
fi
note 'phase relaunch'
"$opener" "$app" --args --updated
# the old bundle goes once the new one is opening, not before
if [ "$installed" = 1 ]; then /bin/rm -rf "$previous" "$staging"; fi
"#;

/// The options `spawn` is given.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpawnOptions {
    pub detached: bool,
    /// `'ignore'`
    pub stdio: &'static str,
}

/// The `ChildProcess` methods `startMacSwap` calls.
pub trait SwapChild {
    /// `child.on('error', () => {})`
    fn on_error_ignore(&mut self) -> Result<(), String>;
    /// `child.unref()`
    fn unref(&mut self) -> Result<(), String>;
    /// `child.pid !== undefined`
    fn has_pid(&self) -> bool;
}

/// `startMacSwap`'s options; `opener` `None` is `undefined`.
pub struct StartMacSwap<'a> {
    pub pid: f64,
    pub bundle: &'a str,
    pub staged: &'a str,
    pub log_file: &'a str,
    pub opener: Option<&'a str>,
}

/// `spawnProgram`: starts the swap child, `Err` is a throw.
pub type SpawnProgram<'a> =
    dyn FnMut(&str, &[String], &SpawnOptions) -> Result<Box<dyn SwapChild>, String> + 'a;

/// `startMacSwap`: `spawn` is `spawnProgram`; an `Err` is a throw.
pub fn start_mac_swap(options: &StartMacSwap, spawn: &mut SpawnProgram<'_>) -> bool {
    let opener = options.opener.unwrap_or("/usr/bin/open");
    let args = [
        "-c".to_string(),
        MAC_SWAP_SCRIPT.to_string(),
        "seuoffice-update".to_string(),
        number_to_string(options.pid),
        options.bundle.to_string(),
        options.staged.to_string(),
        mac_staging_dir(options.bundle),
        mac_previous_dir(options.bundle),
        options.log_file.to_string(),
        opener.to_string(),
    ];
    let mut run = || -> Result<bool, String> {
        let mut child = spawn(
            "/bin/sh",
            &args,
            &SpawnOptions {
                detached: true,
                stdio: "ignore",
            },
        )?;
        child.on_error_ignore()?;
        child.unref()?;
        Ok(child.has_pid())
    };
    run().unwrap_or(false)
}
