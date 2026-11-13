//! `packages/cli/src/install.ts` (and the names of `names.ts` it re-exports):
//! making `seuoffice` reachable from a terminal.
//!
//! The launcher ships inside the app; the link into a PATH directory, or the
//! Windows PATH entry, is best effort and never prompts. [`inspect_cli_link`]
//! reports the same states without writing anything.
//!
//! What the TypeScript reads from the process arrives as parameters: the
//! environment is an [`Env`] lookup (`process.env[name]`), the platform is the
//! text `process.platform` holds, and the PowerShell run of the Windows PATH
//! edit is a [`PowerShell`] (`runPowerShell`, with [`run_power_shell`] as the
//! process it defaults to). The file system is read and written here, as the
//! TypeScript does, through Node's own error texts.

use std::fs;
use std::io::Read;
use std::time::{Duration, Instant};

use jscompat::node_path::host::{basename, dirname, is_absolute, join, resolve};
use jscompat::node_path::win32;
use jscompat::{js_regex, trim, truthy};
use serde::Serialize;

use crate::node_fs::{NodeError, namespaced, node_error};
use crate::packages::i18n::{OLD_CLI_BUNDLE_FILES, OLD_CLI_COMMANDS};

/// `process.env`: the value of a variable, `None` where it is `undefined`
pub type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

/// `existsSync`, as a parameter of the functions that take one
pub type Exists<'a> = &'a dyn Fn(&str) -> bool;

/// `CLI_COMMAND`: the terminal command, and the launcher file in `<resources>/cli`
pub const CLI_COMMAND: &str = "seuoffice";

/// `CLI_BUNDLE_FILE`: the bundled CLI entry beside the launchers
pub const CLI_BUNDLE_FILE: &str = "seuoffice.cjs";

/// `HOME_DIR_NAME`: per-user folder under the home directory
pub const HOME_DIR_NAME: &str = ".seuoffice";

/// `launcherFileName`: the launcher file for a platform
pub fn launcher_file_name(platform: &str) -> String {
    if platform == "win32" {
        format!("{CLI_COMMAND}.cmd")
    } else {
        CLI_COMMAND.to_owned()
    }
}

/// `{ ok, stdout }` of the `runPowerShell` seam
#[derive(Debug, Clone, PartialEq)]
pub struct PowerShellRun {
    pub ok: bool,
    pub stdout: String,
}

/// `runPowerShell`: runs a script, answers whether it succeeded and what it
/// printed
pub type PowerShell<'a> = &'a dyn Fn(&str) -> PowerShellRun;

/// `InstallOptions`. `platform` is `process.platform` where the TypeScript
/// leaves it out; `env` is `process.env` where it leaves that out; the
/// PowerShell seam is [`run_power_shell`] where it leaves that out.
pub struct InstallOptions<'a> {
    /// absolute path of the launcher to expose
    pub launcher: &'a str,
    pub platform: &'a str,
    /// directories to try, first writable wins (defaults per platform)
    pub candidate_dirs: Option<&'a [String]>,
    pub env: Env<'a>,
    pub run_power_shell: PowerShell<'a>,
}

/// `InstallStatus`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallStatus {
    Linked,
    Present,
    Missing,
    Unwritable,
    Occupied,
    Unsupported,
}

/// `InstallOutcome`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstallOutcome {
    pub status: InstallStatus,
    /// where the link or PATH entry lives (or would live)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// what a person can run to finish the job when the app could not
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual: Option<String>,
    /// the link landed in a directory the current shell does not search; this line adds it
    #[serde(rename = "pathHint", skip_serializing_if = "Option::is_none")]
    pub path_hint: Option<String>,
}

impl InstallOutcome {
    fn of(status: InstallStatus, location: Option<String>, manual: Option<String>) -> Self {
        InstallOutcome {
            status,
            location,
            manual,
            path_hint: None,
        }
    }
}

fn our_commands() -> Vec<&'static str> {
    let mut commands = vec![CLI_COMMAND];
    commands.extend(OLD_CLI_COMMANDS);
    commands
}

fn our_bundles() -> Vec<&'static str> {
    let mut bundles = vec![CLI_BUNDLE_FILE];
    bundles.extend(OLD_CLI_BUNDLE_FILES);
    bundles
}

/// `existsSync(path)`: follows links, so a dangling link does not exist
pub fn exists_sync(path: &str) -> bool {
    fs::metadata(namespaced(path)).is_ok()
}

/// `defaultCandidateDirs`: `/usr/local/bin`, then the user's own bin
/// directories, without the Homebrew prefix
pub fn default_candidate_dirs(platform: &str, env: Env, exists: Exists) -> Vec<String> {
    if platform != "darwin" && platform != "linux" {
        return Vec::new();
    }
    let brew = homebrew_bin_dirs(platform, env, exists);
    let mut dirs = vec!["/usr/local/bin".to_owned()];
    dirs.extend(user_bin_dirs(env));
    dirs.retain(|dir| !brew.contains(dir));
    dirs
}

/// `HOMEBREW_ROOTS[platform]`
fn homebrew_roots(platform: &str) -> &'static [&'static str] {
    match platform {
        "darwin" => &["/opt/homebrew", "/usr/local"],
        "linux" => &["/home/linuxbrew/.linuxbrew"],
        _ => &[],
    }
}

/// `String.prototype.replace(/\/+$/, '')`
fn without_trailing_slashes(text: &str) -> String {
    js_regex!(r"\/+$").replace_all(text, |_| String::new())
}

/// `homebrewBinDirs`: `<prefix>/bin` for every Homebrew install this machine
/// has: `$HOMEBREW_PREFIX` plus any usual root holding `bin/brew`
pub fn homebrew_bin_dirs(platform: &str, env: Env, exists: Exists) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    let from_env = env("HOMEBREW_PREFIX").map(|prefix| without_trailing_slashes(&prefix));
    if let Some(prefix) = truthy(from_env.as_deref())
        && is_absolute(prefix)
        && !roots.iter().any(|root| root == prefix)
    {
        roots.push(prefix.to_owned());
    }
    for &root in homebrew_roots(platform) {
        if exists(&join(&[root, "bin", "brew"])) && !roots.iter().any(|seen| seen == root) {
            roots.push(root.to_owned());
        }
    }
    roots.iter().map(|root| join(&[root, "bin"])).collect()
}

/// `userBinDirs`: `$XDG_BIN_HOME`, then `~/.local/bin`
pub fn user_bin_dirs(env: Env) -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();
    let xdg = env("XDG_BIN_HOME");
    if let Some(dir) = truthy(xdg.as_deref())
        && is_absolute(dir)
    {
        dirs.push(dir.to_owned());
    }
    let home = env("HOME");
    if let Some(home) = truthy(home.as_deref()) {
        dirs.push(join(&[home, ".local", "bin"]));
    }
    let mut unique: Vec<String> = Vec::new();
    for dir in dirs {
        if !unique.contains(&dir) {
            unique.push(dir);
        }
    }
    unique
}

/// `pathHint`: the shell line that puts `dir` on PATH, or `None` when the
/// current environment already searches it
pub fn path_hint(dir: &str, env: Env) -> Option<String> {
    let path = env("PATH").unwrap_or_default();
    let entries: Vec<String> = path.split(':').map(without_trailing_slashes).collect();
    if entries.contains(&without_trailing_slashes(dir)) {
        return None;
    }
    let home = env("HOME").map(|home| without_trailing_slashes(&home));
    let shown = match truthy(home.as_deref()) {
        Some(home) if dir.starts_with(&format!("{home}/")) => {
            format!("$HOME{}", &dir[home.len()..])
        }
        _ => dir.to_owned(),
    };
    Some(format!("export PATH=\"{shown}:$PATH\""))
}

/// `installCliLink`. An `Err` is what the TypeScript throws (the `readlink`
/// of a link that was just read).
pub fn install_cli_link(opts: &InstallOptions) -> Result<InstallOutcome, NodeError> {
    let platform = opts.platform;
    if platform == "win32" {
        return Ok(install_windows_path(opts));
    }
    if platform != "darwin" && platform != "linux" {
        return Ok(InstallOutcome::of(InstallStatus::Unsupported, None, None));
    }
    let env = opts.env;
    let dirs: Vec<String> = match opts.candidate_dirs {
        Some(dirs) => dirs.to_vec(),
        None => default_candidate_dirs(platform, env, &exists_sync),
    };
    let user_dirs = user_bin_dirs(env);
    let manual = manual_command(opts.launcher);
    let mut occupied: Option<String> = None;
    for dir in &dirs {
        let link = join(&[dir, CLI_COMMAND]);
        let state = link_state(&link, opts.launcher);
        if state == LinkState::Ours && read_link(&link)? == opts.launcher {
            return Ok(with_path_hint(
                InstallOutcome::of(InstallStatus::Present, Some(link), None),
                dir,
                &user_dirs,
                env,
            ));
        }
        if state == LinkState::File || state == LinkState::Foreign {
            // somebody else's seuoffice (a file, or npm's symlink): never clobber it
            occupied = Some(link);
            continue;
        }
        if user_dirs.contains(dir)
            && !exists_sync(dir)
            && fs::create_dir_all(namespaced(dir)).is_err()
        {
            continue;
        }
        if !writable(dir) {
            continue;
        }
        // ours from another install dir, or a dead link nobody can run
        if state != LinkState::Missing && fs::remove_file(namespaced(&link)).is_err() {
            continue;
        }
        if symlink(opts.launcher, &link).is_err() {
            continue;
        }
        return Ok(with_path_hint(
            InstallOutcome::of(InstallStatus::Linked, Some(link), None),
            dir,
            &user_dirs,
            env,
        ));
    }
    Ok(not_linked(occupied, &dirs, manual))
}

/// `inspectCliLink`: what a fresh terminal would find, without changing anything
pub fn inspect_cli_link(opts: &InstallOptions) -> Result<InstallOutcome, NodeError> {
    let platform = opts.platform;
    if platform == "win32" {
        return Ok(inspect_windows_path(opts));
    }
    if platform != "darwin" && platform != "linux" {
        return Ok(InstallOutcome::of(InstallStatus::Unsupported, None, None));
    }
    let env = opts.env;
    let dirs: Vec<String> = match opts.candidate_dirs {
        Some(dirs) => dirs.to_vec(),
        None => default_candidate_dirs(platform, env, &exists_sync),
    };
    let user_dirs = user_bin_dirs(env);
    let manual = manual_command(opts.launcher);
    let mut occupied: Option<String> = None;
    // same walk installCliLink does: an occupied name is skipped, the first free writable dir wins
    for dir in &dirs {
        let link = join(&[dir, CLI_COMMAND]);
        let state = link_state(&link, opts.launcher);
        if state == LinkState::Ours && read_link(&link)? == opts.launcher {
            return Ok(with_path_hint(
                InstallOutcome::of(InstallStatus::Present, Some(link), None),
                dir,
                &user_dirs,
                env,
            ));
        }
        if state == LinkState::File || state == LinkState::Foreign {
            if occupied.is_none() {
                occupied = Some(link);
            }
            continue;
        }
        if writable(dir) || (user_dirs.contains(dir) && creatable(dir)) {
            return Ok(with_path_hint(
                InstallOutcome::of(InstallStatus::Missing, Some(link), Some(manual)),
                dir,
                &user_dirs,
                env,
            ));
        }
    }
    Ok(not_linked(occupied, &dirs, manual))
}

/// the end of both walks: an occupied name, else no directory to write to
fn not_linked(occupied: Option<String>, dirs: &[String], manual: String) -> InstallOutcome {
    if let Some(link) = occupied {
        return InstallOutcome::of(InstallStatus::Occupied, Some(link), Some(manual));
    }
    let first = dirs.first().map_or("/usr/local/bin", String::as_str);
    InstallOutcome::of(
        InstallStatus::Unwritable,
        Some(join(&[first, CLI_COMMAND])),
        Some(manual),
    )
}

fn manual_command(launcher: &str) -> String {
    format!(
        "sudo mkdir -p /usr/local/bin && sudo ln -sf \"{launcher}\" /usr/local/bin/{CLI_COMMAND}"
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinkState {
    Missing,
    Ours,
    Dangling,
    File,
    Foreign,
}

/// `readlinkSync(path)`: the text of the link, ill-formed bytes as U+FFFD
fn read_link(path: &str) -> Result<String, NodeError> {
    fs::read_link(namespaced(path))
        .map(|target| target.to_string_lossy().into_owned())
        .map_err(|e| node_error(&e, "readlink", path))
}

/// `linkState`: any throw is a missing link
fn link_state(path: &str, launcher: &str) -> LinkState {
    let Ok(meta) = fs::symlink_metadata(namespaced(path)) else {
        return LinkState::Missing;
    };
    if !meta.file_type().is_symlink() {
        return LinkState::File;
    }
    let Ok(target) = read_link(path) else {
        return LinkState::Missing;
    };
    if target == launcher {
        return LinkState::Ours;
    }
    let resolved = if is_absolute(&target) {
        target
    } else {
        resolve(&[&dirname(path), &target])
    };
    if !exists_sync(&resolved) {
        return LinkState::Dangling;
    }
    if is_our_launcher(&resolved, launcher) {
        LinkState::Ours
    } else {
        LinkState::Foreign
    }
}

/// `realpathSync(path)`; `None` where it throws
fn realpath(path: &str) -> Option<String> {
    let real = fs::canonicalize(namespaced(path)).ok()?;
    let text = real.to_string_lossy().into_owned();
    // the verbatim form std gives on Windows is not what Node's realpath answers
    #[cfg(windows)]
    if let Some(plain) = text.strip_prefix(r"\\?\")
        && !plain.starts_with("UNC\\")
    {
        return Some(plain.to_owned());
    }
    Some(text)
}

/// `isOurLauncher`: a link is ours when it resolves to the launcher being
/// installed, or to a launcher shipped by another copy of the app (under the
/// current command name or one it had before) with our CLI bundle or a
/// Windows twin beside it
pub fn is_our_launcher(target: &str, launcher: &str) -> bool {
    let Some(real) = realpath(target) else {
        return false;
    };
    if let Some(launcher_real) = realpath(launcher)
        && real == launcher_real
    {
        return true;
    }
    let commands = our_commands();
    if !commands.contains(&basename(&real, None).as_str()) {
        return false;
    }
    let dir = dirname(&real);
    our_bundles()
        .iter()
        .any(|bundle| exists_sync(&join(&[&dir, bundle])))
        || commands
            .iter()
            .any(|command| exists_sync(&join(&[&dir, &format!("{command}.cmd")])))
}

/// `accessSync(dir, constants.W_OK)` as a test
#[cfg(unix)]
fn writable(dir: &str) -> bool {
    match std::ffi::CString::new(dir) {
        // SAFETY: the pointer is a NUL-terminated string that lives through the call
        Ok(path) => unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 },
        // a path with a NUL makes Node throw inside the try
        Err(_) => false,
    }
}

/// `accessSync(dir, constants.W_OK)` as a test: on Windows only the read-only
/// attribute of a file refuses
#[cfg(windows)]
fn writable(dir: &str) -> bool {
    match fs::metadata(namespaced(dir)) {
        Ok(meta) => meta.is_dir() || !meta.permissions().readonly(),
        Err(_) => false,
    }
}

/// `creatable`: a missing dir that `mkdir -p` could create: its nearest
/// existing ancestor is writable
fn creatable(dir: &str) -> bool {
    let mut probe = dir.to_owned();
    while !exists_sync(&probe) {
        let parent = dirname(&probe);
        if parent == probe {
            return false;
        }
        probe = parent;
    }
    writable(&probe)
}

#[cfg(unix)]
fn symlink(target: &str, link: &str) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, namespaced(link))
}

#[cfg(windows)]
fn symlink(target: &str, link: &str) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, namespaced(link))
}

/// `withPathHint`: system dirs are on PATH by construction; only a per-user
/// dir may need the shell told about it
fn with_path_hint(
    mut outcome: InstallOutcome,
    dir: &str,
    user_dirs: &[String],
    env: Env,
) -> InstallOutcome {
    let hint = if user_dirs.iter().any(|user| user == dir) {
        path_hint(dir, env)
    } else {
        None
    };
    outcome.path_hint = hint;
    outcome
}

/// `WIN_PATH_READ`
const WIN_PATH_READ: &str = concat!(
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); ",
    "$p = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); "
);

/// `WIN_BROADCAST`: best effort, a locked-down PowerShell may refuse Add-Type
const WIN_BROADCAST: &str = concat!(
    "try { ",
    "Add-Type -Namespace SeuOfficePath -Name Native -MemberDefinition '[DllImport(\"user32.dll\", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'; ",
    "$r = [UIntPtr]::Zero; ",
    "[void][SeuOfficePath.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r) ",
    "} catch {}; "
);

/// `psQuote`
fn ps_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// the `manual` line of both Windows walks
fn windows_manual(dir: &str) -> String {
    format!(
        "[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';{dir}', 'User')"
    )
}

/// `installWindowsPath`
fn install_windows_path(opts: &InstallOptions) -> InstallOutcome {
    let dir = win32::dirname(opts.launcher);
    let manual = windows_manual(&dir);
    let script = [
        format!("$dir = {}; ", ps_quote(&dir)),
        WIN_PATH_READ.to_owned(),
        "if (($p -split ';') -contains $dir) { 'present'; exit 0 }; ".to_owned(),
        "$next = (@($p, $dir) | Where-Object { $_ }) -join ';'; ".to_owned(),
        "$key.SetValue('Path', $next, [Microsoft.Win32.RegistryValueKind]::ExpandString); "
            .to_owned(),
        WIN_BROADCAST.to_owned(),
        "'linked'".to_owned(),
    ]
    .concat();
    let run = (opts.run_power_shell)(&script);
    if !run.ok {
        return InstallOutcome::of(InstallStatus::Unwritable, Some(dir), Some(manual));
    }
    let status = if trim(&run.stdout) == "present" {
        InstallStatus::Present
    } else {
        InstallStatus::Linked
    };
    InstallOutcome::of(status, Some(dir), None)
}

/// `inspectWindowsPath`
fn inspect_windows_path(opts: &InstallOptions) -> InstallOutcome {
    let dir = win32::dirname(opts.launcher);
    let manual = windows_manual(&dir);
    let script = [
        format!("$dir = {}; ", ps_quote(&dir)),
        "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); ".to_owned(),
        "$p = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); ".to_owned(),
        "if (($p -split ';') -contains $dir) { 'present' } else { 'missing' }".to_owned(),
    ]
    .concat();
    let run = (opts.run_power_shell)(&script);
    if !run.ok {
        return InstallOutcome::of(InstallStatus::Unwritable, Some(dir), Some(manual));
    }
    let status = if trim(&run.stdout) == "present" {
        InstallStatus::Present
    } else {
        InstallStatus::Missing
    };
    InstallOutcome::of(status, Some(dir), Some(manual))
}

/// `runPowerShell`: `powershell.exe -NoProfile -NonInteractive -Command <script>`,
/// stopped after 15 seconds; `ok` is an exit status of 0
pub fn run_power_shell(script: &str) -> PowerShellRun {
    use std::process::{Command, Stdio};

    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command"])
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // windowsHide: true (CREATE_NO_WINDOW)
        command.creation_flags(0x0800_0000);
    }
    let Ok(mut child) = command.spawn() else {
        return PowerShellRun {
            ok: false,
            stdout: String::new(),
        };
    };
    let stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = stdout {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    });
    // stderr is not read: the script writes nothing there that matters, and
    // a full pipe is cut off by the timeout
    let deadline = Instant::now() + Duration::from_millis(15_000);
    let ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let bytes = reader.join().unwrap_or_default();
    PowerShellRun {
        ok,
        stdout: String::from_utf8_lossy(&bytes).into_owned(),
    }
}
