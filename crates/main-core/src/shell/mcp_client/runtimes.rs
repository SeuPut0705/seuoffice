//! `apps/shell/src/main/mcp-client/runtimes.ts`: runtimes for the person's own
//! MCP servers (spec 5.3, 5.4): which runtime a command needs, finding that
//! runtime on the PC first, and otherwise downloading the pinned one into
//! `<userData>/mcp-runtimes/` after asking.
//!
//! Nothing here changes the PC's PATH or registry. What a launch needs on top
//! of its environment (the runtime's directory first on the child's PATH,
//! uv's data folders) is returned for the launcher to add to the child alone.
//!
//! Every `async` function of the TypeScript awaits only host work (the file
//! system, a question to the person, a download, a run of uv), so each is a
//! plain call. The file system is `std::fs`; the rest is [`RuntimeKitHost`].
//! Consequences:
//!
//! - The kit's queue (`serial`: one question and one download at a time, so
//!   two servers never fetch the same file) is the caller's one thread of
//!   control: a second `resolve_command` runs after the first returned, and
//!   finds the download in place, as the queued task does.
//! - A host callback that throws (the store read of `isRuntimeAllowed`, the
//!   write of `recordRuntimeAllowed`, the run of uv outside the download) makes
//!   `resolveCommand` reject in the TypeScript. [`McpRuntimeKit`] answers a
//!   [`RuntimeResolution`] and cannot reject: the answer is `offline` and
//!   [`RuntimeKit::take_lookup_failure`] is true once, which
//!   `local::LocalMcpHost::take_lookup_failure` reports to the launcher.
//! - `AbortSignal`s have no counterpart (a plain call is not cancelled).
//!
//! [`McpRuntimeKit`]: super::local_launch::McpRuntimeKit

use std::cell::Cell;
use std::fs;

use jscompat::node_path::host;
use jscompat::{JsObject, js_regex, number_to_string, trim};

use super::local_launch::{
    LaunchSource, McpRuntimeId, McpRuntimeKit, ResolveOptions, ResolvedLaunch, RuntimeDownloadItem,
    RuntimeMissing, RuntimeMissingDetail, RuntimeResolution, process_env, process_platform,
};
use super::runtime_archive::{
    DownloadError, RuntimeArchiveFailure, RuntimeFetch, download_verified_archive,
    extract_runtime_archive,
};
use super::runtime_pins::{
    McpRuntimePins, McpRuntimePlatformKey, mcp_runtime_pins, mcp_runtime_platform_key,
};
use crate::node_fs::{NodeError, namespaced, node_error, node_error2};
use crate::packages::ai_provider::subscription_locate::{
    common_unix_bin_dirs, is_full_dir, path_dirs,
};

/// The folder under the app data folder that holds downloaded runtimes
pub const MCP_RUNTIMES_DIR_NAME: &str = "mcp-runtimes";

/// `mcpRuntimesRoot(userDataDir)`
pub fn mcp_runtimes_root(user_data_dir: &str) -> String {
    host::join(&[user_data_dir, MCP_RUNTIMES_DIR_NAME])
}

/// The runtimes that are unpacked into a folder of their own: `'node' | 'uv'`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallId {
    Node,
    Uv,
}

impl InstallId {
    pub fn as_str(self) -> &'static str {
        match self {
            InstallId::Node => "node",
            InstallId::Uv => "uv",
        }
    }

    fn runtime(self) -> McpRuntimeId {
        match self {
            InstallId::Node => McpRuntimeId::Node,
            InstallId::Uv => McpRuntimeId::Uv,
        }
    }
}

/// `runtimeInstallDir(runtimesRoot, id, version)`: where a downloaded Node or
/// uv of `version` is unpacked
pub fn runtime_install_dir(runtimes_root: &str, id: InstallId, version: &str) -> String {
    host::join(&[runtimes_root, &format!("{}-{version}", id.as_str())])
}

/// `UvDataEnv`
#[derive(Debug, Clone, PartialEq)]
pub struct UvDataEnv {
    pub uv_python_install_dir: String,
    pub uv_cache_dir: String,
}

/// `uvDataEnv(runtimesRoot)`: variables a launch adds when it runs the app's own uv (spec 5.3)
pub fn uv_data_env(runtimes_root: &str) -> UvDataEnv {
    let data = host::join(&[runtimes_root, "uv-data"]);
    UvDataEnv {
        uv_python_install_dir: host::join(&[&data, "python"]),
        uv_cache_dir: host::join(&[&data, "cache"]),
    }
}

const WINDOWS_EXTENSIONS: [&str; 4] = [".exe", ".com", ".cmd", ".bat"];

/// `bareName(command, platform)`: a bare command name as the pairing table
/// sees it, or `None` for a path
fn bare_name(command: &str, platform: &str) -> Option<String> {
    let trimmed = trim(command);
    if trimmed.is_empty() || trimmed.contains(['\\', '/']) {
        return None;
    }
    if platform != "win32" {
        return Some(trimmed.to_owned());
    }
    let lower = trimmed.to_lowercase();
    let extension = host::extname(&lower);
    if WINDOWS_EXTENSIONS.contains(&extension.as_str()) {
        Some(lower[..lower.len() - extension.len()].to_owned())
    } else {
        Some(lower)
    }
}

/// `runtimeForCommand(command, platform)`: the runtime a command is paired
/// with (spec 5.3): `node`/`npx`/`npm` use Node, `uv`/`uvx` use uv,
/// `python`/`python3` use the PC's Python or else the one uv manages. Any
/// other command, and any path, is only looked up.
pub fn runtime_for_command(command: &str, platform: &str) -> Option<McpRuntimeId> {
    let name = bare_name(command, platform)?;
    match name.as_str() {
        "node" | "npx" | "npm" => Some(McpRuntimeId::Node),
        "uv" | "uvx" => Some(McpRuntimeId::Uv),
        "python" | "python3" => Some(McpRuntimeId::Python),
        _ => None,
    }
}

// ── finding a runtime on the PC ──

/// `PcLookupOptions`
#[derive(Debug, Clone, Default)]
pub struct PcLookupOptions {
    /// `process.env` when `None`
    pub env: Option<JsObject<String>>,
    /// `process.platform` when `None`
    pub platform: Option<String>,
    /// Directories searched after PATH. When `None`: on macOS and Linux the
    /// usual bin folders a Finder- or menu-started app does not inherit on
    /// PATH; on Windows the per-runtime install folders.
    pub fallback_dirs: Option<Vec<String>>,
}

/// What `findProgramOnPath` takes besides `PcLookupOptions`
#[derive(Default)]
pub struct ProgramSearch<'a> {
    /// Windows: the extensions tried in order (`['.exe']` when `None`)
    pub extensions: Option<Vec<String>>,
    /// directories to leave out
    pub skip_dir: Option<&'a dyn Fn(&str) -> bool>,
    /// extra fallback directories (after the defaults)
    pub extra_dirs: Vec<String>,
}

struct Lookup {
    env: JsObject<String>,
    platform: String,
    fallback_dirs: Option<Vec<String>>,
}

fn lookup_of(options: &PcLookupOptions) -> Lookup {
    Lookup {
        env: options.env.clone().unwrap_or_else(process_env),
        platform: options
            .platform
            .clone()
            .unwrap_or_else(|| process_platform().to_owned()),
        fallback_dirs: options.fallback_dirs.clone(),
    }
}

/// `homedir()`
fn home_dir() -> String {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|v| v.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn home_of(lookup: &Lookup) -> String {
    let value = if lookup.platform == "win32" {
        lookup
            .env
            .get("USERPROFILE")
            .or_else(|| lookup.env.get("HOME"))
    } else {
        lookup.env.get("HOME")
    };
    match value {
        Some(v) if !v.is_empty() => v.clone(),
        _ => home_dir(),
    }
}

/// `isFile(path)`: `stat` follows links, and any failure is "no"
fn is_file(path: &str) -> bool {
    fs::metadata(namespaced(path)).is_ok_and(|m| m.is_file())
}

/// `access(path, X_OK)` as a yes or no
#[cfg(unix)]
fn executable(path: &str) -> bool {
    match std::ffi::CString::new(path) {
        // SAFETY: `c_path` is a valid NUL-terminated string for the call
        Ok(c_path) => unsafe { libc::access(c_path.as_ptr(), libc::X_OK) == 0 },
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn executable(_path: &str) -> bool {
    true
}

fn is_runnable_file(path: &str, platform: &str) -> bool {
    if !is_file(path) {
        return false;
    }
    if platform == "win32" {
        return true;
    }
    executable(path)
}

/// `realpath(path)`
fn real_path(path: &str) -> Option<String> {
    let real = fs::canonicalize(namespaced(path)).ok()?;
    let text = real.to_string_lossy().into_owned();
    #[cfg(windows)]
    if let Some(plain) = text.strip_prefix(r"\\?\")
        && !plain.starts_with("UNC\\")
    {
        return Some(plain.to_owned());
    }
    Some(text)
}

/// `rm(path, { recursive: true, force: true })`, a failure ignored
fn remove_all(path: &str) {
    let path = namespaced(path);
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_dir() => {
            let _ = fs::remove_dir_all(&path);
        }
        Ok(_) => {
            let _ = fs::remove_file(&path);
        }
        Err(_) => {}
    }
}

/// `readdir(path).catch(() => [])`: libuv sorts the names by bytes
fn read_dir_names(path: &str) -> Vec<String> {
    let Ok(reader) = fs::read_dir(namespaced(path)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = Vec::new();
    for entry in reader {
        let Ok(entry) = entry else {
            return Vec::new();
        };
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    names
}

/// `mkdir(path, { recursive: true })`
fn make_dirs(path: &str) -> Result<(), NodeError> {
    fs::create_dir_all(namespaced(path)).map_err(|e| node_error(&e, "mkdir", path))
}

fn windows_apps_dir(dir: &str) -> bool {
    js_regex!(r"[\\/]microsoft[\\/]windowsapps[\\/]?$", "i").test(dir)
}

/// `searchDirs(lookup, extra)`
fn search_dirs(lookup: &Lookup, extra: &[String]) -> Vec<String> {
    let env_get = |key: &str| lookup.env.get(key).cloned();
    let mut dirs = path_dirs(&env_get, &lookup.platform);
    let fallback: Vec<String> = match &lookup.fallback_dirs {
        Some(dirs) => dirs.clone(),
        None if lookup.platform == "win32" => extra.to_vec(),
        None => {
            let mut dirs = common_unix_bin_dirs(&home_of(lookup), &env_get, &lookup.platform);
            dirs.extend(extra.iter().cloned());
            dirs
        }
    };
    for dir in fallback {
        if is_full_dir(&dir) && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// `findProgramOnPath(name, options)`: the first runnable `name` in PATH
/// (empty and relative entries skipped, so a same-named file in the document's
/// folder is never taken), then the fallback directories. On Windows
/// `extensions` are tried in order unless the name already carries one of them.
pub fn find_program_on_path(
    name: &str,
    options: &PcLookupOptions,
    search: &ProgramSearch<'_>,
) -> Option<String> {
    let lookup = lookup_of(options);
    if name.is_empty() || name.contains(['\\', '/']) {
        return None;
    }
    let candidates: Vec<String> = if lookup.platform == "win32" {
        let extensions = search
            .extensions
            .clone()
            .unwrap_or_else(|| vec![".exe".to_owned()]);
        let lower = name.to_lowercase();
        if extensions.iter().any(|ext| lower.ends_with(ext.as_str())) {
            vec![name.to_owned()]
        } else {
            extensions
                .iter()
                .map(|ext| format!("{name}{ext}"))
                .collect()
        }
    } else {
        vec![name.to_owned()]
    };
    for dir in search_dirs(&lookup, &search.extra_dirs) {
        if search.skip_dir.is_some_and(|skip| skip(&dir)) {
            continue;
        }
        for candidate in &candidates {
            let path = host::join(&[&dir, candidate]);
            if is_runnable_file(&path, &lookup.platform) {
                return Some(path);
            }
        }
    }
    None
}

/// `NodeInstall`
#[derive(Debug, Clone, PartialEq)]
pub struct NodeInstall {
    pub node: String,
    /// npm's `npm-cli.js`, or `None` when this Node has no npm
    pub npm_cli: Option<String>,
    /// npm's `npx-cli.js`, or `None` when this Node has no npm
    pub npx_cli: Option<String>,
}

fn windows_node_dirs(lookup: &Lookup) -> Vec<String> {
    let program_files = lookup
        .env
        .get("ProgramFiles")
        .or_else(|| lookup.env.get("PROGRAMFILES"));
    match program_files {
        Some(dir) if !dir.is_empty() => vec![host::join(&[dir, "nodejs"])],
        _ => Vec::new(),
    }
}

/// `npmScriptBeside(node, script)`: npm's CLI script beside a Node:
/// `<dir>/node_modules/npm` (Windows) or `<prefix>/lib/node_modules/npm`
fn npm_script_beside(node: &str, script: &str) -> Option<String> {
    let mut nodes = vec![node.to_owned()];
    let real = real_path(node).unwrap_or_else(|| node.to_owned());
    if real != node {
        nodes.push(real);
    }
    for path in nodes {
        let dir = host::dirname(&path);
        let parent = host::dirname(&dir);
        for candidate in [
            host::join(&[&dir, "node_modules", "npm", "bin", script]),
            host::join(&[&parent, "lib", "node_modules", "npm", "bin", script]),
        ] {
            if is_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// `findPcNode(options)`: the PC's Node and npm's CLI scripts, or `None` when
/// no Node is found
pub fn find_pc_node(options: &PcLookupOptions) -> Option<NodeInstall> {
    let lookup = lookup_of(options);
    let extra_dirs = if lookup.platform == "win32" {
        windows_node_dirs(&lookup)
    } else {
        Vec::new()
    };
    let node = find_program_on_path(
        "node",
        options,
        &ProgramSearch {
            extra_dirs,
            ..ProgramSearch::default()
        },
    )?;
    let mut npm_cli = npm_script_beside(&node, "npm-cli.js");
    let mut npx_cli = npm_script_beside(&node, "npx-cli.js");
    if lookup.platform != "win32" {
        // a POSIX `npx`/`npm` on PATH is a link to the script itself
        for (name, script) in [("npm", "npm-cli.js"), ("npx", "npx-cli.js")] {
            let have = if name == "npm" { &npm_cli } else { &npx_cli };
            if have.is_some() {
                continue;
            }
            let found = find_program_on_path(name, options, &ProgramSearch::default());
            let real = found.map(|f| real_path(&f).unwrap_or(f));
            if let Some(real) = real
                && host::basename(&real, None) == script
            {
                if name == "npm" {
                    npm_cli = Some(real);
                } else {
                    npx_cli = Some(real);
                }
            }
        }
    }
    Some(NodeInstall {
        node,
        npm_cli,
        npx_cli,
    })
}

/// `UvInstall`
#[derive(Debug, Clone, PartialEq)]
pub struct UvInstall {
    pub uv: String,
    pub uvx: Option<String>,
}

fn uv_installer_dirs(lookup: &Lookup) -> Vec<String> {
    let home = home_of(lookup);
    if home.is_empty() {
        Vec::new()
    } else {
        vec![
            host::join(&[&home, ".local", "bin"]),
            host::join(&[&home, ".cargo", "bin"]),
        ]
    }
}

/// `findPcUv(options)`: the PC's uv (and its `uvx`), or `None` when none is found
pub fn find_pc_uv(options: &PcLookupOptions) -> Option<UvInstall> {
    let lookup = lookup_of(options);
    let uv = find_program_on_path(
        "uv",
        options,
        &ProgramSearch {
            extra_dirs: uv_installer_dirs(&lookup),
            ..ProgramSearch::default()
        },
    )?;
    let sibling = host::join(&[
        &host::dirname(&uv),
        if lookup.platform == "win32" {
            "uvx.exe"
        } else {
            "uvx"
        },
    ]);
    let uvx = is_runnable_file(&sibling, &lookup.platform).then_some(sibling);
    Some(UvInstall { uv, uvx })
}

/// `macStubWithoutTools(path)`: macOS ships `/usr/bin/python3` as a stub that
/// asks to install the developer tools; it is a Python only once those tools
/// are there.
fn mac_stub_without_tools(path: &str) -> bool {
    if path != "/usr/bin/python3" && path != "/usr/bin/python" {
        return false;
    }
    for real in [
        "/Library/Developer/CommandLineTools/usr/bin/python3",
        "/Applications/Xcode.app/Contents/Developer/usr/bin/python3",
    ] {
        if is_file(real) {
            return false;
        }
    }
    true
}

/// `findPcPython(command, options)`: the PC's Python for `python`/`python3`,
/// or `None`. Windows' store stubs and the macOS stub are not taken: they open
/// an installer instead of running.
pub fn find_pc_python(command: &str, options: &PcLookupOptions) -> Option<String> {
    let lookup = lookup_of(options);
    let names: &[&str] = if lookup.platform == "win32" {
        &["python"]
    } else if command == "python3" {
        &["python3", "python"]
    } else {
        &["python", "python3"]
    };
    let windows = lookup.platform == "win32";
    let skip = move |dir: &str| windows && windows_apps_dir(dir);
    for name in names {
        let found = find_program_on_path(
            name,
            options,
            &ProgramSearch {
                skip_dir: Some(&skip),
                ..ProgramSearch::default()
            },
        );
        let Some(found) = found else {
            continue;
        };
        if lookup.platform == "darwin" && mac_stub_without_tools(&found) {
            continue;
        }
        return Some(found);
    }
    None
}

// ── resolving a command ──

/// `RuntimeDownloadQuestion`: what the question before a download shows (spec 5.4)
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeDownloadQuestion {
    /// the server's command, e.g. `npx`
    pub command: String,
    /// the runtime the command needs
    pub runtime: McpRuntimeId,
    /// everything this launch would download, in order (uv before its Python)
    pub downloads: Vec<RuntimeDownloadItem>,
    pub total_bytes: f64,
}

/// `UvRunResult`
#[derive(Debug, Clone, PartialEq)]
pub struct UvRunResult {
    pub code: f64,
    pub stdout: String,
}

/// What the kit asks of the app. Every method that is a promise in the
/// TypeScript answers `Err` with the message where it rejects.
pub trait RuntimeKitHost {
    /// `isRuntimeAllowed(id)`: whether `runtimes[id].allowed` is set in `mcp-servers.json`
    fn is_runtime_allowed(&self, id: McpRuntimeId) -> Result<bool, String>;
    /// `recordRuntimeAllowed(id)`: set `runtimes[id].allowed`; called after the person says yes
    fn record_runtime_allowed(&self, id: McpRuntimeId) -> Result<(), String>;
    /// `askDownload(question)`: shown by the UI; `true` only when the person pressed "download"
    fn ask_download(&self, question: &RuntimeDownloadQuestion) -> Result<bool, String>;
    /// `options.fetch`: Electron's `net.fetch` in the app
    fn fetcher(&self) -> &dyn RuntimeFetch;
    /// `runUv(uv, args, { env, cwd })`: runs uv without a shell
    fn run_uv(
        &self,
        uv: &str,
        args: &[String],
        env: &JsObject<String>,
        cwd: &str,
    ) -> Result<UvRunResult, String>;
    /// `sleep(ms)`
    fn sleep(&self, ms: f64);
    /// `rename(from, to)`
    fn rename(&self, from: &str, to: &str) -> Result<(), NodeError>;
    /// `randomBytes(4).toString('hex')`
    fn random_hex4(&self) -> String;
}

/// `McpRuntimeKitOptions` without the callbacks (they are [`RuntimeKitHost`])
#[derive(Debug, Clone, Default)]
pub struct McpRuntimeKitOptions {
    /// `<userData>/mcp-runtimes` (see [`mcp_runtimes_root`])
    pub runtimes_root: String,
    pub env: Option<JsObject<String>>,
    pub platform: Option<String>,
    pub arch: Option<String>,
    /// see [`PcLookupOptions::fallback_dirs`]
    pub fallback_dirs: Option<Vec<String>>,
    pub pins: Option<McpRuntimePins>,
}

/// Variables passed to uv itself; nothing of the app's or the subscriptions'
const UV_BASE_ENV: [&str; 19] = [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
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
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];

const RETRYABLE_RENAME: [&str; 3] = ["EPERM", "EACCES", "EBUSY"];

/// `process.arch`
fn process_arch() -> String {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        "x86" => "ia32",
        other => other,
    }
    .to_owned()
}

/// `ArchiveLayout`
struct Layout {
    /// the program, relative to the unpacked folder
    main: Vec<String>,
    /// further files the install must have, relative to the unpacked folder
    required: Vec<Vec<String>>,
    /// npm's CLI script (Node)
    npm: Vec<String>,
    /// npx's CLI script (Node), or uv's `uvx`
    npx: Vec<String>,
}

fn strings(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|p| (*p).to_owned()).collect()
}

fn node_layout(platform: &str) -> Layout {
    if platform == "win32" {
        let npm = strings(&["node_modules", "npm", "bin", "npm-cli.js"]);
        let npx = strings(&["node_modules", "npm", "bin", "npx-cli.js"]);
        return Layout {
            main: strings(&["node.exe"]),
            required: vec![npm.clone(), npx.clone()],
            npm,
            npx,
        };
    }
    let npm = strings(&["lib", "node_modules", "npm", "bin", "npm-cli.js"]);
    let npx = strings(&["lib", "node_modules", "npm", "bin", "npx-cli.js"]);
    Layout {
        main: strings(&["bin", "node"]),
        required: vec![npm.clone(), npx.clone()],
        npm,
        npx,
    }
}

fn uv_layout(platform: &str) -> Layout {
    let exe = if platform == "win32" { ".exe" } else { "" };
    let uvx = vec![format!("uvx{exe}")];
    Layout {
        main: vec![format!("uv{exe}")],
        required: vec![uvx.clone()],
        npm: Vec::new(),
        npx: uvx,
    }
}

/// `join(dir, ...parts)`
fn join_in(dir: &str, parts: &[String]) -> String {
    let mut all: Vec<&str> = vec![dir];
    all.extend(parts.iter().map(String::as_str));
    host::join(&all)
}

fn missing(
    detail: RuntimeMissingDetail,
    runtime: Option<McpRuntimeId>,
    message: &str,
    downloads: Vec<RuntimeDownloadItem>,
) -> RuntimeMissing {
    RuntimeMissing {
        detail,
        runtime,
        downloads,
        message: message.to_owned(),
    }
}

/// `DownloadFailure`
struct DownloadFailure {
    detail: RuntimeMissingDetail,
    message: String,
}

impl DownloadFailure {
    fn new(detail: RuntimeMissingDetail, message: impl Into<String>) -> Self {
        DownloadFailure {
            detail,
            message: message.into(),
        }
    }

    /// any other `Error`: `obtain` reports it as `offline` with its message
    fn other(message: impl Into<String>) -> Self {
        DownloadFailure::new(RuntimeMissingDetail::Offline, message)
    }
}

fn failure_detail(kind: RuntimeArchiveFailure) -> RuntimeMissingDetail {
    match kind {
        RuntimeArchiveFailure::Offline => RuntimeMissingDetail::Offline,
        RuntimeArchiveFailure::HashMismatch => RuntimeMissingDetail::HashMismatch,
        RuntimeArchiveFailure::ExtractFailed => RuntimeMissingDetail::ExtractFailed,
    }
}

/// a host callback threw: `resolveCommand` rejects in the TypeScript
struct Thrown;

/// uv's side of a resolution
enum UvSide {
    Missing(RuntimeMissing),
    Ready {
        uv: String,
        uvx: Option<String>,
        app_uv: bool,
        python: Option<String>,
    },
}

/// `createMcpRuntimeKit(options)`
pub struct RuntimeKit<'h> {
    host: &'h dyn RuntimeKitHost,
    root: String,
    platform: String,
    arch: String,
    pins: McpRuntimePins,
    platform_key: Option<McpRuntimePlatformKey>,
    lookup: PcLookupOptions,
    uv_env: UvDataEnv,
    env: JsObject<String>,
    failed: Cell<bool>,
}

impl<'h> RuntimeKit<'h> {
    pub fn new(options: McpRuntimeKitOptions, host: &'h dyn RuntimeKitHost) -> Self {
        let platform = options
            .platform
            .unwrap_or_else(|| process_platform().to_owned());
        let arch = options.arch.unwrap_or_else(process_arch);
        let env = options.env.unwrap_or_else(process_env);
        let pins = options.pins.unwrap_or_else(mcp_runtime_pins);
        let platform_key = mcp_runtime_platform_key(&platform, &arch);
        let lookup = PcLookupOptions {
            env: Some(env.clone()),
            platform: Some(platform.clone()),
            fallback_dirs: options.fallback_dirs,
        };
        let uv_env = uv_data_env(&options.runtimes_root);
        RuntimeKit {
            host,
            root: options.runtimes_root,
            platform,
            arch,
            pins,
            platform_key,
            lookup,
            uv_env,
            env,
            failed: Cell::new(false),
        }
    }

    /// whether the last `resolve_command` hit a host callback that threw (the
    /// TypeScript's rejection); reading it clears it
    pub fn take_lookup_failure(&self) -> bool {
        self.failed.replace(false)
    }

    fn install_dir(&self, id: InstallId) -> String {
        let version = match id {
            InstallId::Node => &self.pins.node.version,
            InstallId::Uv => &self.pins.uv.version,
        };
        runtime_install_dir(&self.root, id, version)
    }

    fn layout_of(&self, id: InstallId) -> Layout {
        match id {
            InstallId::Node => node_layout(&self.platform),
            InstallId::Uv => uv_layout(&self.platform),
        }
    }

    /// `installed(id)`
    fn installed(&self, id: InstallId) -> bool {
        let dir = self.install_dir(id);
        let layout = self.layout_of(id);
        std::iter::once(&layout.main)
            .chain(layout.required.iter())
            .all(|parts| is_file(&join_in(&dir, parts)))
    }

    fn download_item(&self, id: McpRuntimeId) -> RuntimeDownloadItem {
        let Some(key) = self.platform_key else {
            return RuntimeDownloadItem {
                runtime: id,
                version: String::new(),
                bytes: 0.0,
            };
        };
        match id {
            McpRuntimeId::Python => RuntimeDownloadItem {
                runtime: id,
                version: self.pins.python.version.clone(),
                bytes: *self.pins.python.bytes.get(key) as f64,
            },
            McpRuntimeId::Node => RuntimeDownloadItem {
                runtime: id,
                version: self.pins.node.version.clone(),
                bytes: self.pins.node.archives.get(key).bytes as f64,
            },
            McpRuntimeId::Uv => RuntimeDownloadItem {
                runtime: id,
                version: self.pins.uv.version.clone(),
                bytes: self.pins.uv.archives.get(key).bytes as f64,
            },
        }
    }

    /// `prune(id, keepCurrent)`: older pinned versions and leftovers of
    /// interrupted downloads of `id`
    fn prune(&self, id: InstallId, keep_current: bool) {
        let current = host::basename(&self.install_dir(id), None);
        let name = id.as_str();
        for entry in read_dir_names(&self.root) {
            let versioned = entry
                .strip_prefix(&format!("{name}-"))
                .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()));
            let old = versioned && !(keep_current && entry == current);
            let leftover = entry.starts_with(&format!(".download-{name}-"))
                || entry.starts_with(&format!(".staging-{name}-"));
            if old || leftover {
                remove_all(&host::join(&[&self.root, &entry]));
            }
        }
    }

    /// `renameWithRetry(from, to)`: antivirus scanners briefly hold freshly
    /// unpacked programs on Windows
    fn rename_with_retry(&self, from: &str, to: &str) -> Result<(), NodeError> {
        let mut attempt: u32 = 0;
        loop {
            match self.host.rename(from, to) {
                Ok(()) => return Ok(()),
                Err(error) => {
                    let code = error.code.unwrap_or("");
                    if !RETRYABLE_RENAME.contains(&code) || attempt >= 5 {
                        return Err(error);
                    }
                    self.host.sleep(100.0 * f64::from(1u32 << attempt));
                    attempt += 1;
                }
            }
        }
    }

    /// `installArchive(id)`
    fn install_archive(&self, id: InstallId) -> Result<(), DownloadFailure> {
        let Some(key) = self.platform_key else {
            return Err(DownloadFailure::new(
                RuntimeMissingDetail::UnsupportedPlatform,
                format!("no pinned {} here", id.as_str()),
            ));
        };
        let (version, archive) = match id {
            InstallId::Node => (&self.pins.node.version, self.pins.node.archives.get(key)),
            InstallId::Uv => (&self.pins.uv.version, self.pins.uv.archives.get(key)),
        };
        make_dirs(&self.root).map_err(|e| DownloadFailure::other(e.message))?;
        self.prune(id, false);
        let tag = format!("{}-{version}-{}", id.as_str(), self.host.random_hex4());
        let download = host::join(&[&self.root, &format!(".download-{tag}")]);
        let staging = host::join(&[&self.root, &format!(".staging-{tag}")]);
        let result = (|| -> Result<(), DownloadFailure> {
            download_verified_archive(archive, &download, self.host.fetcher()).map_err(
                |error| match error {
                    DownloadError::Archive(e) => {
                        DownloadFailure::new(failure_detail(e.kind), e.message)
                    }
                    DownloadError::Io(e) => {
                        DownloadFailure::new(RuntimeMissingDetail::ExtractFailed, e.message)
                    }
                },
            )?;
            extract_runtime_archive(&download, archive.format, &archive.root, &staging)
                .map_err(|e| DownloadFailure::new(failure_detail(e.kind), e.message))?;
            let layout = self.layout_of(id);
            for parts in std::iter::once(&layout.main).chain(layout.required.iter()) {
                if !is_file(&join_in(&staging, parts)) {
                    return Err(DownloadFailure::new(
                        RuntimeMissingDetail::ExtractFailed,
                        format!("{} archive lacks {}", id.as_str(), parts.join("/")),
                    ));
                }
            }
            self.rename_with_retry(&staging, &self.install_dir(id))
                .map_err(|e| DownloadFailure::new(RuntimeMissingDetail::ExtractFailed, e.message))
        })();
        remove_all(&download);
        remove_all(&staging);
        result?;
        self.prune(id, true);
        Ok(())
    }

    /// `uvRunEnv(appUv)`
    fn uv_run_env(&self, app_uv: bool) -> JsObject<String> {
        let mut base = JsObject::new();
        for name in UV_BASE_ENV {
            if let Some(value) = self.env.get(name) {
                base.set(name, value.clone());
            }
        }
        if app_uv {
            base.set(
                "UV_PYTHON_INSTALL_DIR",
                self.uv_env.uv_python_install_dir.clone(),
            );
            base.set("UV_CACHE_DIR", self.uv_env.uv_cache_dir.clone());
        }
        base
    }

    /// `appPythonPresent()`: any `cpython-<pinned>-...` folder in the app's uv Python folder
    fn app_python_present(&self) -> bool {
        let prefix = format!("cpython-{}-", self.pins.python.version);
        read_dir_names(&self.uv_env.uv_python_install_dir)
            .iter()
            .any(|entry| entry.starts_with(&prefix))
    }

    /// `findUvPython(uv, appUv)`: the pinned Python, as uv reports it, or `None`
    fn find_uv_python(&self, uv: &str, app_uv: bool) -> Result<Option<String>, Thrown> {
        if app_uv && !self.app_python_present() {
            return Ok(None);
        }
        make_dirs(&self.root).map_err(|_| Thrown)?;
        let args = vec![
            "python".to_owned(),
            "find".to_owned(),
            self.pins.python.version.clone(),
        ];
        let result = self
            .host
            .run_uv(uv, &args, &self.uv_run_env(app_uv), &self.root)
            .map_err(|_| Thrown)?;
        let first = result.stdout.split('\n').next().unwrap_or("");
        let first = first.strip_suffix('\r').unwrap_or(first);
        let path = trim(first);
        Ok(
            (result.code == 0.0 && host::is_absolute(path) && is_file(path))
                .then(|| path.to_owned()),
        )
    }

    /// `installUvPython(uv, appUv)`
    fn install_uv_python(&self, uv: &str, app_uv: bool) -> Result<(), DownloadFailure> {
        make_dirs(&self.root).map_err(|e| DownloadFailure::other(e.message))?;
        let args = vec![
            "python".to_owned(),
            "install".to_owned(),
            self.pins.python.version.clone(),
        ];
        let result = self
            .host
            .run_uv(uv, &args, &self.uv_run_env(app_uv), &self.root)
            .map_err(DownloadFailure::other)?;
        if result.code != 0.0 {
            return Err(DownloadFailure::new(
                RuntimeMissingDetail::PythonInstallFailed,
                format!(
                    "uv could not install Python {} (exit {})",
                    self.pins.python.version,
                    number_to_string(result.code)
                ),
            ));
        }
        Ok(())
    }

    /// `obtain(command, runtime, plan, resolve, pythonInstall)`: ask (unless
    /// every download is allowed already), record the permission, then download
    /// in order. `None` when everything is in place.
    fn obtain(
        &self,
        command: &str,
        runtime: McpRuntimeId,
        needs: &[McpRuntimeId],
        resolve: &ResolveOptions,
        python_uv: Option<(&str, bool)>,
    ) -> Result<Option<RuntimeMissing>, Thrown> {
        if needs.is_empty() {
            return Ok(None);
        }
        let downloads: Vec<RuntimeDownloadItem> =
            needs.iter().map(|id| self.download_item(*id)).collect();
        if self.platform_key.is_none() {
            return Ok(Some(missing(
                RuntimeMissingDetail::UnsupportedPlatform,
                Some(runtime),
                &format!(
                    "no pinned {} for {}-{}",
                    runtime.as_str(),
                    self.platform,
                    self.arch
                ),
                downloads,
            )));
        }
        if !resolve.offer_download {
            return Ok(Some(missing(
                RuntimeMissingDetail::DownloadNeeded,
                Some(runtime),
                &format!("{} must be downloaded first", runtime.as_str()),
                downloads,
            )));
        }
        // `Promise.all`: every question is asked, the first rejection wins
        let answers: Vec<Result<bool, String>> = needs
            .iter()
            .map(|id| self.host.is_runtime_allowed(*id))
            .collect();
        let mut allowed: Vec<bool> = Vec::new();
        for answer in answers {
            allowed.push(answer.map_err(|_| Thrown)?);
        }
        if allowed.contains(&false) {
            let question = RuntimeDownloadQuestion {
                command: command.to_owned(),
                runtime,
                total_bytes: downloads.iter().map(|item| item.bytes).sum(),
                downloads: downloads.clone(),
            };
            let yes = self.host.ask_download(&question).unwrap_or(false);
            if !yes {
                return Ok(Some(missing(
                    RuntimeMissingDetail::Declined,
                    Some(runtime),
                    &format!("downloading {} was declined", runtime.as_str()),
                    downloads,
                )));
            }
            for (index, id) in needs.iter().enumerate() {
                if !allowed[index] {
                    self.host.record_runtime_allowed(*id).map_err(|_| Thrown)?;
                }
            }
        }
        for id in needs {
            let done = match id {
                McpRuntimeId::Python => match python_uv {
                    Some((uv, app_uv)) => self.install_uv_python(uv, app_uv),
                    None => Ok(()),
                },
                McpRuntimeId::Node => self.install_archive(InstallId::Node),
                McpRuntimeId::Uv => self.install_archive(InstallId::Uv),
            };
            if let Err(failure) = done {
                return Ok(Some(missing(
                    failure.detail,
                    Some(runtime),
                    &failure.message,
                    downloads,
                )));
            }
        }
        Ok(None)
    }

    fn resolve_node(
        &self,
        command: &str,
        name: &str,
        resolve: &ResolveOptions,
    ) -> Result<RuntimeResolution, Thrown> {
        let pc = find_pc_node(&self.lookup);
        let pc_script = match (&pc, name) {
            (Some(pc), "npx") => pc.npx_cli.clone(),
            (Some(pc), "npm") => pc.npm_cli.clone(),
            _ => None,
        };
        if let Some(pc) = &pc
            && (name == "node" || pc_script.is_some())
        {
            return Ok(RuntimeResolution::Resolved(ResolvedLaunch {
                command: pc.node.clone(),
                prefix_args: pc_script.into_iter().collect(),
                env: JsObject::new(),
                path_prepend: vec![host::dirname(&pc.node)],
                source: LaunchSource::Pc,
                runtime: Some(McpRuntimeId::Node),
            }));
        }
        // the queue's one task
        if self.installed(InstallId::Node) {
            self.prune(InstallId::Node, true);
        } else if let Some(failed) = self.obtain(
            command,
            McpRuntimeId::Node,
            &[McpRuntimeId::Node],
            resolve,
            None,
        )? {
            return Ok(RuntimeResolution::Missing(failed));
        }
        let dir = self.install_dir(InstallId::Node);
        let layout = node_layout(&self.platform);
        let node = join_in(&dir, &layout.main);
        let script = match name {
            "npx" => Some(&layout.npx),
            "npm" => Some(&layout.npm),
            _ => None,
        };
        Ok(RuntimeResolution::Resolved(ResolvedLaunch {
            prefix_args: script.map(|s| join_in(&dir, s)).into_iter().collect(),
            path_prepend: vec![host::dirname(&node)],
            command: node,
            env: JsObject::new(),
            source: LaunchSource::App,
            runtime: Some(McpRuntimeId::Node),
        }))
    }

    /// `resolveUvSide(...)`: uv itself (PC first, else the app's) and whether
    /// its pinned Python must be installed: only when the PC has no Python and
    /// uv has none either
    fn resolve_uv_side(
        &self,
        command: &str,
        runtime: McpRuntimeId,
        want_uvx: bool,
        python_command: &str,
        resolve: &ResolveOptions,
    ) -> Result<UvSide, Thrown> {
        let pc_uv = find_pc_uv(&self.lookup);
        let use_pc_uv = pc_uv
            .as_ref()
            .is_some_and(|uv| !want_uvx || uv.uvx.is_some());
        let pc_python = find_pc_python(python_command, &self.lookup);
        // the queue's one task
        let mut needs: Vec<McpRuntimeId> = Vec::new();
        let app_uv = !use_pc_uv;
        if app_uv && !self.installed(InstallId::Uv) {
            needs.push(McpRuntimeId::Uv);
        } else if app_uv {
            self.prune(InstallId::Uv, true);
        }
        let layout = uv_layout(&self.platform);
        let (uv, uvx) = match (&pc_uv, app_uv) {
            (Some(pc), false) => (pc.uv.clone(), pc.uvx.clone()),
            _ => {
                let dir = self.install_dir(InstallId::Uv);
                (
                    join_in(&dir, &layout.main),
                    Some(join_in(&dir, &layout.npx)),
                )
            }
        };
        let mut python: Option<String> = None;
        if pc_python.is_none() {
            if needs.contains(&McpRuntimeId::Uv) {
                // a new uv version finds the Python an older one installed in the same folder
                if !self.app_python_present() {
                    needs.push(McpRuntimeId::Python);
                }
            } else {
                python = self.find_uv_python(&uv, app_uv)?;
                if python.is_none() {
                    needs.push(McpRuntimeId::Python);
                }
            }
        }
        if let Some(failed) = self.obtain(
            command,
            runtime,
            &needs,
            resolve,
            Some((uv.as_str(), app_uv)),
        )? {
            return Ok(UvSide::Missing(failed));
        }
        if pc_python.is_none() && python.is_none() {
            python = self.find_uv_python(&uv, app_uv)?;
            if python.is_none() {
                return Ok(UvSide::Missing(missing(
                    RuntimeMissingDetail::PythonInstallFailed,
                    Some(runtime),
                    &format!(
                        "uv did not report Python {} after installing it",
                        self.pins.python.version
                    ),
                    Vec::new(),
                )));
            }
        }
        Ok(UvSide::Ready {
            uv,
            uvx,
            app_uv,
            python: pc_python.or(python),
        })
    }

    fn resolve_uv(
        &self,
        command: &str,
        name: &str,
        resolve: &ResolveOptions,
    ) -> Result<RuntimeResolution, Thrown> {
        let side =
            self.resolve_uv_side(command, McpRuntimeId::Uv, name == "uvx", "python3", resolve)?;
        let (uv, uvx, app_uv) = match side {
            UvSide::Missing(missing) => return Ok(RuntimeResolution::Missing(missing)),
            UvSide::Ready {
                uv, uvx, app_uv, ..
            } => (uv, uvx, app_uv),
        };
        let program = if name == "uvx" { uvx } else { Some(uv) };
        let Some(program) = program else {
            return Ok(RuntimeResolution::Missing(missing(
                RuntimeMissingDetail::NotFound,
                Some(McpRuntimeId::Uv),
                "uvx was not found beside uv",
                Vec::new(),
            )));
        };
        let mut env = JsObject::new();
        if app_uv {
            env.set(
                "UV_PYTHON_INSTALL_DIR",
                self.uv_env.uv_python_install_dir.clone(),
            );
            env.set("UV_CACHE_DIR", self.uv_env.uv_cache_dir.clone());
        }
        Ok(RuntimeResolution::Resolved(ResolvedLaunch {
            path_prepend: vec![host::dirname(&program)],
            command: program,
            prefix_args: Vec::new(),
            env,
            source: if app_uv {
                LaunchSource::App
            } else {
                LaunchSource::Pc
            },
            runtime: Some(McpRuntimeId::Uv),
        }))
    }

    fn resolve_python(
        &self,
        command: &str,
        name: &str,
        resolve: &ResolveOptions,
    ) -> Result<RuntimeResolution, Thrown> {
        if let Some(pc) = find_pc_python(name, &self.lookup) {
            return Ok(RuntimeResolution::Resolved(ResolvedLaunch {
                path_prepend: vec![host::dirname(&pc)],
                command: pc,
                prefix_args: Vec::new(),
                env: JsObject::new(),
                source: LaunchSource::Pc,
                runtime: Some(McpRuntimeId::Python),
            }));
        }
        let side = self.resolve_uv_side(command, McpRuntimeId::Python, false, name, resolve)?;
        match side {
            UvSide::Missing(missing) => Ok(RuntimeResolution::Missing(missing)),
            UvSide::Ready { python, .. } => {
                let python = python.unwrap_or_default();
                Ok(RuntimeResolution::Resolved(ResolvedLaunch {
                    path_prepend: vec![host::dirname(&python)],
                    command: python,
                    prefix_args: Vec::new(),
                    env: JsObject::new(),
                    source: LaunchSource::App,
                    runtime: Some(McpRuntimeId::Python),
                }))
            }
        }
    }

    fn resolve_other(&self, command: &str) -> RuntimeResolution {
        let trimmed = trim(command);
        let found = if trimmed.contains(['\\', '/']) {
            // a path: only a full one, never completed from a working folder
            if host::is_absolute(trimmed)
                && is_full_dir(&host::dirname(trimmed))
                && is_file(trimmed)
            {
                Some(trimmed.to_owned())
            } else {
                return RuntimeResolution::Missing(missing(
                    RuntimeMissingDetail::NotFound,
                    None,
                    "the program was not found",
                    Vec::new(),
                ));
            }
        } else {
            let search = ProgramSearch {
                extensions: Some(WINDOWS_EXTENSIONS.iter().map(|e| (*e).to_owned()).collect()),
                ..ProgramSearch::default()
            };
            match find_program_on_path(trimmed, &self.lookup, &search) {
                Some(found) => Some(found),
                None => {
                    return RuntimeResolution::Missing(missing(
                        RuntimeMissingDetail::NotFound,
                        None,
                        "the program was not found on PATH",
                        Vec::new(),
                    ));
                }
            }
        };
        RuntimeResolution::Resolved(ResolvedLaunch {
            command: found.unwrap_or_default(),
            prefix_args: Vec::new(),
            env: JsObject::new(),
            path_prepend: Vec::new(),
            source: LaunchSource::Pc,
            runtime: None,
        })
    }
}

impl McpRuntimeKit for RuntimeKit<'_> {
    /// The program to start for a server's `command`: the PC's runtime first,
    /// else the app's downloaded one (asked for unless already allowed, and
    /// fetched again without asking when the pinned version changed).
    fn resolve_command(&self, command: &str, options: &ResolveOptions) -> RuntimeResolution {
        let runtime = runtime_for_command(command, &self.platform);
        let name = bare_name(command, &self.platform);
        let (Some(runtime), Some(name)) = (runtime, name) else {
            return self.resolve_other(command);
        };
        let resolved = match runtime {
            McpRuntimeId::Node => self.resolve_node(command, &name, options),
            McpRuntimeId::Uv => self.resolve_uv(command, &name, options),
            McpRuntimeId::Python => self.resolve_python(command, &name, options),
        };
        match resolved {
            Ok(resolution) => resolution,
            Err(Thrown) => {
                self.failed.set(true);
                RuntimeResolution::Missing(missing(
                    RuntimeMissingDetail::Offline,
                    None,
                    "the runtime lookup failed",
                    Vec::new(),
                ))
            }
        }
    }
}

/// `rename(from, to)` as the default host does it
pub fn rename_path(from: &str, to: &str) -> Result<(), NodeError> {
    fs::rename(namespaced(from), namespaced(to)).map_err(|e| node_error2(&e, "rename", from, to))
}
