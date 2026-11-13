//! `packages/ai-provider/src/subscription/locate.ts`: where the subscription
//! CLIs are looked for. Only the directory lists the lookups use are here:
//! `commonUnixBinDirs`, `isFullDir`, `pathDirs` and what they reach
//! (`cleanCliPath`, `expandHome`, `npmPrefixDirs`, the nvm order).
//!
//! `env` is `NodeJS.ProcessEnv` as a lookup: the value of a variable, `None`
//! where it is `undefined` (the adapter decides how `process.env` answers,
//! case-insensitively on Windows). `platform` is `NodeJS.Platform` as a
//! string. The `node:path` functions `join`, `isAbsolute`, `sep` and
//! `delimiter` are the HOST's, as the TypeScript imports them
//! (`jscompat::node_path::host`), whatever `platform` says. The reads are
//! `std::fs`, in the order of the TypeScript's.

use std::fs;

use jscompat::node_path::host;
use jscompat::{js_regex, sort_by_number, string_less_than, to_number, trim, truthy};

use crate::node_fs::namespaced;
use crate::packages::ai_provider::jsval::length16;

/// `NodeJS.ProcessEnv` as a lookup
pub type EnvGet<'a> = &'a dyn Fn(&str) -> Option<String>;

/// `cleanCliPath(value)`: trimmed, and one pair of matching quotes taken off.
pub fn clean_cli_path(value: Option<&str>) -> String {
    let trimmed = trim(value.unwrap_or(""));
    if length16(trimmed) >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        // both ends are one-unit quotes: slice(1, -1)
        return trimmed[1..trimmed.len() - 1].to_owned();
    }
    trimmed.to_owned()
}

/// `expandHome(value, home)`
fn expand_home(value: &str, home: &str) -> String {
    if value == "~" {
        return home.to_owned();
    }
    if value.starts_with("~/") || value.starts_with("~\\") {
        return host::join(&[home, &value[2..]]);
    }
    value.to_owned()
}

/// `isFullDir(dir)`: a directory named in full. A relative one (`.`, `tools`)
/// would be completed from the working directory, which is the document's
/// folder when the app was started by opening a file. `\tools` is absolute to
/// Node, yet Windows completes it from the drive of the working directory.
pub fn is_full_dir(dir: &str) -> bool {
    host::is_absolute(dir) && !(host::SEP == "\\" && js_regex!(r"^[\\/](?![\\/])").test(dir))
}

/// `pathDirs(env, platform)`: the PATH directories a lookup may use: empty
/// and relative entries are left out (see [`is_full_dir`]).
pub fn path_dirs(env: EnvGet<'_>, platform: &str) -> Vec<String> {
    let value = env("PATH")
        .or_else(|| env("Path"))
        .or_else(|| env("path"))
        .unwrap_or_default();
    if value.is_empty() {
        return Vec::new();
    }
    value
        .split(if platform == "win32" {
            ";"
        } else {
            host::DELIMITER
        })
        .map(|dir| clean_cli_path(Some(dir)))
        .filter(|dir| is_full_dir(dir))
        .collect()
}

/// `compareNvmVersionDirsNewestFirst(a, b)`: nvm installs under
/// `~/.nvm/versions/node/vX.Y.Z`. Prefer higher X.Y.Z first.
fn compare_nvm_version_dirs_newest_first(a: &str, b: &str) -> f64 {
    let parts = |name: &str| -> [f64; 3] {
        match js_regex!(r"^v?(\d+)\.(\d+)\.(\d+)", "i").exec(trim(name)) {
            Some(m) => [
                to_number(m.get(1).unwrap_or("")),
                to_number(m.get(2).unwrap_or("")),
                to_number(m.get(3).unwrap_or("")),
            ],
            None => [-1.0, -1.0, -1.0],
        }
    };
    let pa = parts(a);
    let pb = parts(b);
    for (x, y) in pa.iter().zip(pb.iter()) {
        if x != y {
            return y - x;
        }
    }
    // Equal numeric triples (or both unparsable): keep a stable string order.
    if string_less_than(a, b) {
        -1.0
    } else if string_less_than(b, a) {
        1.0
    } else {
        0.0
    }
}

/// `readdir(dir).catch(() => [])`: libuv sorts the names by bytes.
fn read_dir_names(dir: &str) -> Vec<String> {
    let Ok(reader) = fs::read_dir(namespaced(dir)) else {
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

/// `commonUnixBinDirs(home, env, platform)`: Finder/Dock-launched Electron
/// inherits a minimal PATH, so the directories npm, Homebrew, version managers
/// and the Claude installer (`~/.local/bin`) install into are probed
/// explicitly.
pub fn common_unix_bin_dirs(home: &str, env: EnvGet<'_>, platform: &str) -> Vec<String> {
    let mut dirs: Vec<String> = vec![
        "/opt/homebrew/bin".to_owned(),
        "/usr/local/bin".to_owned(),
        "/opt/local/bin".to_owned(),
    ];
    if !home.is_empty() {
        // Tool managers that keep their data outside the home directory's dotfiles
        let data_home = non_empty(clean_cli_path(env("XDG_DATA_HOME").as_deref()))
            .unwrap_or_else(|| host::join(&[home, ".local", "share"]));
        let fnm_root = non_empty(clean_cli_path(env("FNM_DIR").as_deref())).unwrap_or_else(|| {
            if platform == "darwin" {
                host::join(&[home, "Library", "Application Support", "fnm"])
            } else {
                host::join(&[&data_home, "fnm"])
            }
        });
        let pnpm_home =
            non_empty(clean_cli_path(env("PNPM_HOME").as_deref())).unwrap_or_else(|| {
                if platform == "darwin" {
                    host::join(&[home, "Library", "pnpm"])
                } else {
                    host::join(&[&data_home, "pnpm"])
                }
            });
        dirs.push(host::join(&[home, ".local", "bin"]));
        dirs.push(host::join(&[home, ".npm-global", "bin"]));
        dirs.push(host::join(&[home, ".volta", "bin"]));
        dirs.push(host::join(&[home, ".bun", "bin"]));
        dirs.push(host::join(&[home, ".yarn", "bin"]));
        dirs.push(host::join(&[home, ".asdf", "shims"]));
        dirs.push(host::join(&[&data_home, "mise", "shims"]));
        dirs.push(pnpm_home);
        // the version fnm's `default` alias points at; its per-shell directories
        // live under a process id and are gone by the next sign-in
        dirs.push(host::join(&[&fnm_root, "aliases", "default", "bin"]));
        dirs.extend(npm_prefix_dirs(env, platform, home));
        let nvm_root = host::join(&[home, ".nvm", "versions", "node"]);
        let mut versions = read_dir_names(&nvm_root);
        // Newest first: String.sort is lexicographic, so "v8.x" sorts ahead of "v20.x".
        sort_by_number(&mut versions, |a, b| {
            compare_nvm_version_dirs_newest_first(a, b)
        });
        for version in versions {
            dirs.push(host::join(&[&nvm_root, &version, "bin"]));
        }
    }
    dirs
}

/// `a || b` on a string: `Some` when the text is not empty
fn non_empty(text: String) -> Option<String> {
    truthy(Some(&text)).map(str::to_owned)
}

/// `npmPrefixDirs(env, platform, home)`: the bin directory of a global npm
/// prefix the user moved (`npm config set prefix`, `NPM_CONFIG_PREFIX`), which
/// PATH may not list for a GUI app. npm is not run to read it: `npm config
/// set` writes the value to `~/.npmrc`.
fn npm_prefix_dirs(env: EnvGet<'_>, platform: &str, home: &str) -> Vec<String> {
    let mut values: Vec<Option<String>> = vec![env("npm_config_prefix"), env("NPM_CONFIG_PREFIX")];
    if !home.is_empty() {
        let npmrc = fs::read(namespaced(&host::join(&[home, ".npmrc"])))
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
        for line in js_regex!(r"\r?\n").split(&npmrc) {
            if let Some(m) = js_regex!(r"^\s*prefix\s*=\s*(.*)$").exec(line) {
                values.push(m.get(1).map(str::to_owned));
            }
        }
    }
    let mut dirs: Vec<String> = Vec::new();
    for value in values {
        let prefix = expand_home(&clean_cli_path(value.as_deref()), home);
        if !is_full_dir(&prefix) {
            continue;
        }
        // npm links a global command into `<prefix>/bin`; on Windows into the prefix itself
        let dir = if platform == "win32" {
            prefix
        } else {
            host::join(&[&prefix, "bin"])
        };
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

// ── Finding the program to start: the async part of `locate.ts` ──
//
// What `locate.ts` awaits is `rt.fs` (the file system) and the version run of
// `process.ts`; its module state (the cache of reported versions) is
// [`SubscriptionLocateState`], which the caller owns. `process.arch` is
// Node's name of the architecture this build runs on. `process.execPath` and
// `process.versions.electron`, which only the default Node runtime of a JS
// entry reads, are asked of the caller as the function `nodeRuntime`
// (`{ command, electron }`) unless `nodeRuntime` is given in the options.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use jscompat::{JsMap, JsonValue, json_stringify};

use crate::packages::ai_provider::jsval::{as_str, number, prop, text};
use crate::packages::ai_provider::run_error::ai_run_error;
use crate::packages::ai_provider::subscription_contract::{
    subscription_min_version, subscription_version_at_least, subscription_version_of,
};
use crate::packages::ai_provider::subscription_process::{
    SharedChildRegistry, SubscriptionRunOptions, run_subscription_program,
};
use crate::packages::ai_provider::task::{
    FileKind, FileStat, FsAnswer, FsOp, JsError, LocalBoxFuture, Rt, Wait,
};

/// `SubscriptionProgram`: a CLI resolved to something `spawn` can start directly
#[derive(Debug, Clone, PartialEq)]
pub struct SubscriptionProgram {
    /// `AiSubscriptionCliId`
    pub provider: String,
    /// absolute path of the file to start; never a `.cmd` shim
    pub command: String,
    /// arguments that go before the CLI's own (the JS entry, when `command` is a Node runtime)
    pub prefix_args: Vec<String>,
    /// variables the launch needs on top of the sanitised environment
    pub env: Vec<(String, String)>,
    /// the CLI itself: `command`, or the JS entry it runs
    pub entry: String,
    /// `SubscriptionProgramSource`: `configured`, `managed`, `path`, `npm`,
    /// `native-installer` or `winget`
    pub source: String,
}

/// `SubscriptionNodeRuntime`: a Node runtime for a CLI that ships as a JS entry
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionNodeRuntime {
    pub command: String,
    /// the runtime is Electron and needs `ELECTRON_RUN_AS_NODE=1` to act as Node
    pub electron: bool,
}

/// `SubscriptionVersionReader`: the version a found Claude Code reports
pub type SubscriptionVersionReader =
    Rc<dyn Fn(SubscriptionProgram) -> LocalBoxFuture<Option<String>>>;

/// `SubscriptionLocateOptions`
#[derive(Clone, Default)]
pub struct SubscriptionLocateOptions {
    /// the user's own path (the Codex `cliPath` setting); wins over the automatic lookup
    pub configured_path: Option<String>,
    pub env: Option<Vec<(String, String)>>,
    pub platform: Option<String>,
    pub arch: Option<String>,
    /// runtime for a JS entry; this process (Electron as Node, or Node) when absent
    pub node_runtime: Option<SubscriptionNodeRuntime>,
    /// override of the Codex desktop bin tree, for tests and portable distributions
    pub managed_install_root: Option<String>,
    /// macOS application folders checked for the ChatGPT/Codex app's own CLI
    pub application_dirs: Option<Vec<String>>,
    /// extra POSIX bin directories searched after PATH; the usual ones when absent
    pub common_dirs: Option<Vec<String>>,
    /// the version a found Claude Code reports; its own `--version` when absent
    pub read_version: Option<SubscriptionVersionReader>,
}

/// `SubscriptionLocator`
pub type SubscriptionLocator = Rc<
    dyn Fn(
        Rt,
        String,
        SubscriptionLocateOptions,
    ) -> LocalBoxFuture<Result<Option<SubscriptionProgram>, JsError>>,
>;

/// The module state of `locate.ts`: `reportedVersions`, and the registry the
/// version runs register their children in (`process.ts`'s shared one).
pub struct SubscriptionLocateState {
    pub shared: SharedChildRegistry,
    /// `reportedVersions`: the (possibly still running) answer by program file
    reported_versions: JsMap<Wait<Option<String>>>,
}

impl SubscriptionLocateState {
    pub fn new(shared: SharedChildRegistry) -> Self {
        SubscriptionLocateState {
            shared,
            reported_versions: JsMap::new(),
        }
    }
}

/// The state, as the async functions take it
pub type LocateState = Rc<RefCell<SubscriptionLocateState>>;

/// `ProviderLayout`
struct ProviderLayout {
    /// command name, without extension
    name: &'static str,
    /// package directory under an npm prefix's node_modules
    npm_package: [&'static str; 2],
    /// the package's bin file, relative to the package
    npm_entry: [&'static str; 2],
}

/// `LAYOUTS[provider]`
fn layout_of(provider: &str) -> Option<ProviderLayout> {
    match provider {
        "claude-code" => Some(ProviderLayout {
            name: "claude",
            npm_package: ["@anthropic-ai", "claude-code"],
            npm_entry: ["bin", "claude.exe"],
        }),
        "codex" => Some(ProviderLayout {
            name: "codex",
            npm_package: ["@openai", "codex"],
            npm_entry: ["bin", "codex.js"],
        }),
        _ => None,
    }
}

const SHIM_READ_LIMIT: usize = 64 * 1024;
const VERSION_TIMEOUT_MS: f64 = 5_000.0;

fn is_js_extension(extension: &str) -> bool {
    matches!(extension, ".js" | ".cjs" | ".mjs")
}

/// `process.arch` of the architecture this build runs on
fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// `Context`
struct Ctx<'a> {
    rt: &'a Rt,
    state: &'a LocateState,
    provider: String,
    layout: ProviderLayout,
    env: Option<&'a [(String, String)]>,
    platform: String,
    arch: String,
    node_runtime: Option<&'a SubscriptionNodeRuntime>,
    application_dirs: Option<&'a [String]>,
    common_dirs: Option<&'a [String]>,
    read_version: Option<&'a SubscriptionVersionReader>,
}

impl Ctx<'_> {
    /// `env[key]`
    fn env(&self, key: &str) -> Option<String> {
        match self.env {
            Some(vars) => vars.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()),
            None => self.rt.env(key),
        }
    }

    /// `homeOf(env, platform)`
    fn home(&self, platform: &str) -> String {
        let from_env = if platform == "win32" {
            self.env("USERPROFILE").or_else(|| self.env("HOME"))
        } else {
            self.env("HOME")
        };
        from_env
            .filter(|home| !home.is_empty())
            .unwrap_or_else(|| self.rt.homedir())
    }

    /// `native(context, command, source, env)`
    fn native(&self, command: &str, source: &str, env: &[(&str, &str)]) -> SubscriptionProgram {
        SubscriptionProgram {
            provider: self.provider.clone(),
            command: command.to_owned(),
            prefix_args: Vec::new(),
            env: env
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
            entry: command.to_owned(),
            source: source.to_owned(),
        }
    }
}

async fn stat_of(rt: &Rt, path: &str) -> Option<FileStat> {
    match rt
        .fs(FsOp::Stat {
            path: path.to_owned(),
        })
        .await
    {
        Ok(FsAnswer::Stat(stat)) => Some(stat),
        _ => None,
    }
}

/// `fileExists(path)`
async fn file_exists(rt: &Rt, path: &str) -> bool {
    stat_of(rt, path)
        .await
        .is_some_and(|stat| stat.kind == FileKind::File)
}

/// `isDirectory(path)`
async fn is_directory(rt: &Rt, path: &str) -> bool {
    stat_of(rt, path)
        .await
        .is_some_and(|stat| stat.kind == FileKind::Dir)
}

/// `realpath(path).catch(() => path)`
async fn realpath_or_self(rt: &Rt, path: &str) -> String {
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

/// `readdir(path).catch(() => [])`
async fn read_dir_names_rt(rt: &Rt, path: &str) -> Vec<String> {
    match rt
        .fs(FsOp::Readdir {
            path: path.to_owned(),
            with_types: false,
        })
        .await
    {
        Ok(FsAnswer::Entries(entries)) => entries.into_iter().map(|e| e.name).collect(),
        _ => Vec::new(),
    }
}

/// `wingetLinkTarget(file)`: the file behind a winget Links entry. The
/// entries are symlinks into the package that created them; a link that
/// cannot be resolved stays as it is.
async fn winget_link_target(cx: &Ctx<'_>, file: &str) -> String {
    if !js_regex!(r"[\\/]microsoft[\\/]winget[\\/]links[\\/]", "i").test(file) {
        return file.to_owned();
    }
    realpath_or_self(cx.rt, file).await
}

/// `isInside(path, root, platform)`
fn is_inside(path: &str, root: &str, platform: &str) -> bool {
    let normalized_path = host::resolve(&[path]);
    let normalized_root = host::resolve(&[root]);
    let (path_value, root_value) = if platform == "win32" {
        (
            normalized_path.to_lowercase(),
            normalized_root.to_lowercase(),
        )
    } else {
        (normalized_path, normalized_root)
    };
    path_value == root_value || path_value.starts_with(&format!("{root_value}{}", host::SEP))
}

/// `a.localeCompare(b)`, in the root collation
fn locale_compare(a: &str, b: &str) -> f64 {
    static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
        Collator::try_new(CollatorPreferences::default(), CollatorOptions::default())
            .expect("the compiled root collation")
    });
    match COLLATOR.compare(a, b) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    }
}

// ── Codex: the desktop app's managed copy (ported from codex-app-server.ts) ──

/// `managedCodexRoot(platform, env)`
fn managed_codex_root(cx: &Ctx<'_>) -> Option<String> {
    if cx.platform != "win32" {
        return None;
    }
    let local_app_data = cx.env("LOCALAPPDATA").or_else(|| cx.env("LocalAppData"));
    local_app_data
        .filter(|dir| !dir.is_empty())
        .map(|dir| host::join(&[&dir, "OpenAI", "Codex", "bin"]))
}

/// `newestManagedCodex(root, platform)`
async fn newest_managed_codex(cx: &Ctx<'_>, root: &str) -> Option<String> {
    let entries = match cx
        .rt
        .fs(FsOp::Readdir {
            path: root.to_owned(),
            with_types: true,
        })
        .await
    {
        Ok(FsAnswer::Entries(entries)) => entries,
        _ => return None,
    };
    let executable = if cx.platform == "win32" {
        "codex.exe"
    } else {
        "codex"
    };
    // path, modified, companion
    let mut found: Vec<(String, f64, bool)> = Vec::new();
    for entry in entries
        .iter()
        .filter(|entry| entry.kind == Some(FileKind::Dir))
    {
        let path = host::join(&[root, &entry.name, executable]);
        let directory = host::join(&[root, &entry.name]);
        let (Some(info), Some(directory_info)) = (
            stat_of(cx.rt, &path).await,
            stat_of(cx.rt, &directory).await,
        ) else {
            continue;
        };
        if info.kind != FileKind::File {
            continue;
        }
        let companion = cx.platform != "win32"
            || file_exists(
                cx.rt,
                &host::join(&[root, &entry.name, "codex-code-mode-host.exe"]),
            )
            .await;
        found.push((path, info.mtime_ms.max(directory_info.mtime_ms), companion));
    }
    let complete: Vec<(String, f64, bool)> = found.iter().filter(|c| c.2).cloned().collect();
    let mut pool = if complete.is_empty() { found } else { complete };
    sort_by_number(&mut pool, |a, b| {
        let difference = b.1 - a.1;
        if difference != 0.0 && !difference.is_nan() {
            difference
        } else {
            locale_compare(&b.0, &a.0)
        }
    });
    pool.into_iter().next().map(|candidate| candidate.0)
}

// ── macOS: the CLI bundled with the ChatGPT/Codex desktop app ──

/// `MAC_CODEX_BUNDLES`
const MAC_CODEX_BUNDLES: [&str; 2] = ["Codex.app", "ChatGPT.app"];

/// `newestMacBundledCodex(context)`: the ChatGPT desktop app keeps its own
/// Codex build, which can be newer than the `codex` on PATH. Only an app copy
/// newer than the PATH one is taken, so updating the CLI yourself still wins.
async fn newest_mac_bundled_codex(cx: &Ctx<'_>) -> Option<String> {
    let home = cx.home("darwin");
    let roots: Vec<String> = match cx.application_dirs {
        Some(dirs) => dirs.to_vec(),
        None => vec![
            "/Applications".to_owned(),
            host::join(&[&home, "Applications"]),
        ],
    };
    let mut found: Vec<(String, f64)> = Vec::new();
    for root in &roots {
        for bundle in MAC_CODEX_BUNDLES {
            let path = host::join(&[root, bundle, "Contents", "Resources", "codex"]);
            // no such app, or no bundled CLI: the next place is asked
            let Some(info) = stat_of(cx.rt, &path).await else {
                continue;
            };
            if info.kind != FileKind::File {
                continue;
            }
            // `constants.X_OK`
            let executable = cx
                .rt
                .fs(FsOp::Access {
                    path: path.clone(),
                    mode: 1.0,
                })
                .await;
            if executable.is_err() {
                continue;
            }
            found.push((path, info.mtime_ms));
        }
    }
    // stable sort: an equal time keeps the earlier bundle (Codex.app before ChatGPT.app)
    sort_by_number(&mut found, |a, b| b.1 - a.1);
    found.into_iter().next().map(|bundled| bundled.0)
}

/// `isNewerFile(candidate, current)`: whether `candidate` was written more
/// recently than `current`. An unreadable time loses.
async fn is_newer_file(rt: &Rt, candidate: &str, current: Option<&str>) -> bool {
    let Some(current) = current.filter(|current| !current.is_empty()) else {
        return true;
    };
    let candidate_time = stat_of(rt, candidate)
        .await
        .map_or(f64::NEG_INFINITY, |info| info.mtime_ms);
    let current_time = stat_of(rt, current)
        .await
        .map_or(f64::NEG_INFINITY, |info| info.mtime_ms);
    candidate_time >= current_time
}

// ── Codex: the native binary behind the npm package's JS launcher ──

/// `codexTargetTriple(platform, arch)`
fn codex_target_triple(platform: &str, arch: &str) -> Option<String> {
    let cpu = match arch {
        "x64" => "x86_64",
        "arm64" => "aarch64",
        _ => return None,
    };
    match platform {
        "win32" => Some(format!("{cpu}-pc-windows-msvc")),
        "darwin" => Some(format!("{cpu}-apple-darwin")),
        "linux" | "android" => Some(format!("{cpu}-unknown-linux-musl")),
        _ => None,
    }
}

/// `codexVendorBinDirs(platform)`: where a vendor tree keeps the binary,
/// under `vendor/<triple>/`: `bin/` from 0.133, `codex/` up to 0.137. On
/// Windows the older one is started directly too.
fn codex_vendor_bin_dirs(platform: &str) -> &'static [&'static str] {
    if platform == "win32" {
        &["bin", "codex"]
    } else {
        &["bin"]
    }
}

/// `codexNativeBehindEntry(context, entry, source)`: `@openai/codex/bin/codex.js`
/// only picks the platform package's native binary and starts it with two
/// variables set. Doing the same here leaves no Node process between the app
/// and Codex. `None` when the layout is not the known one.
async fn codex_native_behind_entry(
    cx: &Ctx<'_>,
    entry: &str,
    source: &str,
) -> Option<SubscriptionProgram> {
    let package_root = host::dirname(&host::dirname(entry));
    if host::basename(entry, None) != "codex.js"
        || host::basename(&host::dirname(entry), None) != "bin"
        || host::basename(&package_root, None) != "codex"
        || host::basename(&host::dirname(&package_root), None) != "@openai"
    {
        return None;
    }
    let triple = codex_target_triple(&cx.platform, &cx.arch)?;
    let os = if cx.platform == "android" {
        "linux"
    } else {
        cx.platform.as_str()
    };
    let platform_package = format!("codex-{os}-{}", cx.arch);
    let executable = if cx.platform == "win32" {
        "codex.exe"
    } else {
        "codex"
    };
    let vendor_roots = [
        host::join(&[
            &package_root,
            "node_modules",
            "@openai",
            &platform_package,
            "vendor",
        ]),
        host::join(&[&host::dirname(&package_root), &platform_package, "vendor"]),
        host::join(&[&package_root, "vendor"]),
    ];
    for vendor_root in &vendor_roots {
        for bin_dir in codex_vendor_bin_dirs(&cx.platform) {
            let candidate = host::join(&[vendor_root, &triple, bin_dir, executable]);
            if file_exists(cx.rt, &candidate).await {
                return Some(cx.native(
                    &candidate,
                    source,
                    &[
                        ("CODEX_MANAGED_BY_NPM", "1"),
                        ("CODEX_MANAGED_PACKAGE_ROOT", &package_root),
                    ],
                ));
            }
        }
    }
    None
}

/// `defaultNodeRuntime()`: this process, asked of the caller
async fn default_node_runtime(rt: &Rt) -> SubscriptionNodeRuntime {
    let answer = rt
        .call("nodeRuntime", JsonValue::Null)
        .await
        .unwrap_or(JsonValue::Null);
    SubscriptionNodeRuntime {
        command: as_str(prop(&answer, "command")).unwrap_or("").to_owned(),
        electron: matches!(prop(&answer, "electron"), Some(JsonValue::Bool(true))),
    }
}

/// `jsEntryProgram(context, entry, source, shimDir)`
async fn js_entry_program(
    cx: &Ctx<'_>,
    entry: &str,
    source: &str,
    shim_dir: Option<&str>,
) -> SubscriptionProgram {
    if cx.provider == "codex"
        && let Some(direct) = codex_native_behind_entry(cx, entry, source).await
    {
        return direct;
    }
    // npm's shim prefers a node.exe sitting next to it
    let adjacent = shim_dir.filter(|dir| !dir.is_empty()).map(|dir| {
        host::join(&[
            dir,
            if cx.platform == "win32" {
                "node.exe"
            } else {
                "node"
            },
        ])
    });
    if let Some(adjacent) = adjacent
        && file_exists(cx.rt, &adjacent).await
    {
        return SubscriptionProgram {
            provider: cx.provider.clone(),
            command: adjacent,
            prefix_args: vec![entry.to_owned()],
            env: Vec::new(),
            entry: entry.to_owned(),
            source: source.to_owned(),
        };
    }
    let runtime = match cx.node_runtime {
        Some(runtime) => runtime.clone(),
        None => default_node_runtime(cx.rt).await,
    };
    SubscriptionProgram {
        provider: cx.provider.clone(),
        command: runtime.command,
        prefix_args: vec![entry.to_owned()],
        env: if runtime.electron {
            vec![("ELECTRON_RUN_AS_NODE".to_owned(), "1".to_owned())]
        } else {
            Vec::new()
        },
        entry: entry.to_owned(),
        source: source.to_owned(),
    }
}

// ── Windows: the program behind a `.cmd` shim ──

/// `shimTargets(shim)`: targets a cmd-shim names relative to its own
/// directory (`%dp0%\…` or `%~dp0\…`)
async fn shim_targets(rt: &Rt, shim: &str) -> Vec<String> {
    let mut bytes = match rt
        .fs(FsOp::ReadFile {
            path: shim.to_owned(),
        })
        .await
    {
        Ok(FsAnswer::Bytes(bytes)) => bytes,
        _ => return Vec::new(),
    };
    bytes.truncate(SHIM_READ_LIMIT);
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let mut targets: Vec<String> = Vec::new();
    for found in js_regex!(r#""%(?:~dp0|dp0%)[\\/]?([^"\r\n%]+)""#, "gi").find_iter(&content) {
        let relative: Vec<&str> = js_regex!(r"[\\/]+")
            .split(found.get(1).unwrap_or(""))
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect();
        if relative.is_empty() || relative.contains(&"..") {
            continue;
        }
        let directory = host::dirname(shim);
        let mut parts: Vec<&str> = vec![directory.as_str()];
        parts.extend(relative);
        targets.push(host::join(&parts));
    }
    targets
}

/// `programBehindShim(context, shim, source)`
async fn program_behind_shim(
    cx: &Ctx<'_>,
    shim: &str,
    source: &str,
) -> Option<SubscriptionProgram> {
    let shim_dir = host::dirname(shim);
    let mut candidates = shim_targets(cx.rt, shim).await;
    candidates.push(host::join(&[
        &shim_dir,
        "node_modules",
        cx.layout.npm_package[0],
        cx.layout.npm_package[1],
        cx.layout.npm_entry[0],
        cx.layout.npm_entry[1],
    ]));
    for candidate in candidates {
        let extension = host::extname(&candidate).to_lowercase();
        let name = host::basename(&candidate, None).to_lowercase();
        // the shim's own Node runtime is not the CLI
        if name == "node.exe" || name == "node" {
            continue;
        }
        if !file_exists(cx.rt, &candidate).await {
            continue;
        }
        if extension == ".exe" {
            let target = winget_link_target(cx, &candidate).await;
            return Some(cx.native(&target, source, &[]));
        }
        if is_js_extension(&extension) {
            return Some(js_entry_program(cx, &candidate, source, Some(&shim_dir)).await);
        }
    }
    None
}

/// `programFromFile(context, file, source)`: turn an existing file into
/// something spawnable, or `None` when it is not a program we can start.
async fn program_from_file(cx: &Ctx<'_>, file: &str, source: &str) -> Option<SubscriptionProgram> {
    let extension = host::extname(file).to_lowercase();
    if cx.platform == "win32" {
        if extension == ".exe" {
            let target = winget_link_target(cx, file).await;
            return Some(cx.native(&target, source, &[]));
        }
        if extension == ".cmd" || extension == ".bat" {
            return program_behind_shim(cx, file, source).await;
        }
        if is_js_extension(&extension) {
            return Some(js_entry_program(cx, file, source, None).await);
        }
        // npm also writes a `.ps1` and an extension-less sh shim next to the `.cmd` one
        let original_extension = host::extname(file);
        let sibling = host::join(&[
            &host::dirname(file),
            &format!(
                "{}.cmd",
                host::basename(file, Some(original_extension.as_str()))
            ),
        ]);
        if (extension == ".ps1" || extension.is_empty()) && file_exists(cx.rt, &sibling).await {
            return program_behind_shim(cx, &sibling, source).await;
        }
        return None;
    }
    // POSIX: a global npm install links the command to the package's JS entry
    let real = realpath_or_self(cx.rt, file).await;
    if cx.provider == "codex"
        && is_js_extension(&host::extname(&real).to_lowercase())
        && let Some(direct) = codex_native_behind_entry(cx, &real, source).await
    {
        return Some(direct);
    }
    Some(cx.native(file, source, &[]))
}

/// `programInDir(context, dir, name, source)`
async fn program_in_dir(
    cx: &Ctx<'_>,
    dir: &str,
    name: &str,
    source: &str,
) -> Option<SubscriptionProgram> {
    if cx.platform == "win32" {
        for extension in [".exe", ".cmd"] {
            let candidate = host::join(&[dir, &format!("{name}{extension}")]);
            if !file_exists(cx.rt, &candidate).await {
                continue;
            }
            if let Some(program) = program_from_file(cx, &candidate, source).await {
                return Some(program);
            }
        }
        return None;
    }
    let candidate = host::join(&[dir, name]);
    if !file_exists(cx.rt, &candidate).await {
        return None;
    }
    // `constants.X_OK`
    cx.rt
        .fs(FsOp::Access {
            path: candidate.clone(),
            mode: 1.0,
        })
        .await
        .ok()?;
    program_from_file(cx, &candidate, source).await
}

/// `wingetCodexPackage(localAppData, arch)`: `winget install OpenAI.Codex`
/// unpacks the release archive here when it cannot link it into Links. The
/// archive also holds helper programs whose names begin with `codex-`; only
/// the CLI is taken: the alias `codex.exe` winget writes, or the platform's
/// `codex-<triple>.exe`.
async fn winget_codex_package(rt: &Rt, local_app_data: &str, arch: &str) -> Option<String> {
    let packages = host::join(&[local_app_data, "Microsoft", "WinGet", "Packages"]);
    let entries = read_dir_names_rt(rt, &packages).await;
    let triple = codex_target_triple("win32", arch);
    let mut names: Vec<String> = vec!["codex.exe".to_owned()];
    if let Some(triple) = triple {
        names.push(format!("codex-{triple}.exe"));
    }
    let mut matching: Vec<String> = entries
        .into_iter()
        .filter(|name| js_regex!(r"^OpenAI\.Codex_", "i").test(name))
        .collect();
    matching.sort();
    for entry in matching {
        for name in &names {
            let candidate = host::join(&[&packages, &entry, name]);
            if file_exists(rt, &candidate).await {
                return Some(candidate);
            }
        }
    }
    None
}

/// `windowsFallbackDirs(context)`: places a CLI can be on Windows without
/// being on the PATH the app inherited (directory, source)
fn windows_fallback_dirs(cx: &Ctx<'_>) -> Vec<(String, String)> {
    let home = cx.home("win32");
    let app_data = cx
        .env("APPDATA")
        .or_else(|| (!home.is_empty()).then(|| host::join(&[&home, "AppData", "Roaming"])));
    let local_app_data = cx.env("LOCALAPPDATA").or_else(|| cx.env("LocalAppData"));
    let mut dirs: Vec<(String, String)> = Vec::new();
    // where `irm https://claude.ai/install.ps1 | iex` (`claude install`) puts claude.exe
    if cx.provider == "claude-code" && !home.is_empty() {
        dirs.push((
            host::join(&[&home, ".local", "bin"]),
            "native-installer".to_owned(),
        ));
    }
    if let Some(app_data) = app_data.filter(|dir| !dir.is_empty()) {
        dirs.push((host::join(&[&app_data, "npm"]), "npm".to_owned()));
    }
    let env_get = |key: &str| cx.env(key);
    for dir in npm_prefix_dirs(&env_get, "win32", &home) {
        dirs.push((dir, "npm".to_owned()));
    }
    if let Some(local_app_data) = local_app_data.filter(|dir| !dir.is_empty()) {
        dirs.push((
            host::join(&[&local_app_data, "Microsoft", "WinGet", "Links"]),
            "winget".to_owned(),
        ));
    }
    dirs
}

/// `programsByName(context, name, pathSource, fallbackSource)`: the async
/// generator of the TypeScript, pulled one program at a time (what it has not
/// been asked for is not probed).
struct ProgramStream {
    name: String,
    fallback_source: Option<String>,
    /// the directories still to probe, and the source of a program found there
    queue: VecDeque<(String, String)>,
    fallback_loaded: bool,
}

impl ProgramStream {
    fn new(cx: &Ctx<'_>, name: &str, path_source: &str, fallback_source: Option<&str>) -> Self {
        let env_get = |key: &str| cx.env(key);
        ProgramStream {
            name: name.to_owned(),
            fallback_source: fallback_source.map(str::to_owned),
            queue: path_dirs(&env_get, &cx.platform)
                .into_iter()
                .map(|dir| (dir, path_source.to_owned()))
                .collect(),
            fallback_loaded: false,
        }
    }

    async fn next(&mut self, cx: &Ctx<'_>) -> Option<SubscriptionProgram> {
        loop {
            if let Some((dir, source)) = self.queue.pop_front() {
                if let Some(program) = program_in_dir(cx, &dir, &self.name, &source).await {
                    return Some(program);
                }
                continue;
            }
            if self.fallback_loaded {
                return None;
            }
            self.fallback_loaded = true;
            if cx.platform == "win32" {
                for (dir, source) in windows_fallback_dirs(cx) {
                    self.queue
                        .push_back((dir, self.fallback_source.clone().unwrap_or(source)));
                }
                continue;
            }
            let dirs = match cx.common_dirs {
                Some(dirs) => dirs.to_vec(),
                None => {
                    let env_get = |key: &str| cx.env(key);
                    common_unix_bin_dirs(&cx.home(&cx.platform), &env_get, &cx.platform)
                }
            };
            for dir in dirs {
                self.queue.push_back((
                    dir,
                    self.fallback_source
                        .clone()
                        .unwrap_or_else(|| "path".to_owned()),
                ));
            }
        }
    }
}

/// `searchByName(context, name, pathSource, fallbackSource)`
async fn search_by_name(
    cx: &Ctx<'_>,
    name: &str,
    path_source: &str,
    fallback_source: Option<&str>,
) -> Option<SubscriptionProgram> {
    ProgramStream::new(cx, name, path_source, fallback_source)
        .next(cx)
        .await
}

/// `reportedVersion(program)`: the version a program reports for
/// `--version`, remembered by its file, size and time while it answers.
async fn reported_version(cx: &Ctx<'_>, program: &SubscriptionProgram) -> Option<String> {
    let info = stat_of(cx.rt, &program.entry).await?;
    let key = json_stringify(&JsonValue::Array(vec![
        text(program.command.clone()),
        text(program.entry.clone()),
        number(info.size),
        number(info.mtime_ms),
    ]));
    let known = cx.state.borrow().reported_versions.get(&key).cloned();
    if let Some(known) = known {
        return known.await;
    }
    let rt = cx.rt.clone();
    let shared = cx.state.borrow().shared.clone();
    let run_program = program.clone();
    let answer = cx.rt.share(async move {
        let options = SubscriptionRunOptions {
            signal: rt.controller(),
            timeout_ms: VERSION_TIMEOUT_MS,
            base_env: None,
            cwd: None,
        };
        match run_subscription_program(
            &rt,
            &shared,
            &run_program,
            &["--version".to_owned()],
            &options,
        )
        .await
        {
            Ok(result) => subscription_version_of(&result.stdout),
            Err(_) => None,
        }
    });
    cx.state
        .borrow_mut()
        .reported_versions
        .set(key.clone(), answer.clone());
    let version = answer.await;
    if version.is_none() {
        cx.state.borrow_mut().reported_versions.delete(&key);
    }
    version
}

/// `context.readVersion(program)`
async fn read_version(cx: &Ctx<'_>, program: &SubscriptionProgram) -> Option<String> {
    match cx.read_version {
        Some(reader) => reader(program.clone()).await,
        None => reported_version(cx, program).await,
    }
}

/// `distinctFiles(programs)`: one program per file: PATH and the common
/// directories can lead to the same one
struct DistinctFiles {
    programs: ProgramStream,
    files: Vec<String>,
}

impl DistinctFiles {
    async fn next(&mut self, cx: &Ctx<'_>) -> Option<SubscriptionProgram> {
        loop {
            let program = self.programs.next(cx).await?;
            let file = realpath_or_self(cx.rt, &program.entry).await;
            if self.files.contains(&file) {
                continue;
            }
            self.files.push(file);
            return Some(program);
        }
    }
}

/// `firstUsableClaude(context, programs)`: a PC can hold several copies
/// (Homebrew, npm, the vendor installer's `~/.local/bin`), and the one
/// `claude update` refreshes is often not the first in the search order.
async fn first_usable_claude(cx: &Ctx<'_>, programs: ProgramStream) -> Option<SubscriptionProgram> {
    let minimum = subscription_min_version("claude-code");
    let mut copies = DistinctFiles {
        programs,
        files: Vec::new(),
    };
    let first = copies.next(cx).await?;
    let second = copies.next(cx).await;
    let (Some(second), Some(minimum)) = (second, minimum) else {
        return Some(first);
    };
    let new_enough = |version: Option<String>| {
        version
            .filter(|version| !version.is_empty())
            .is_some_and(|version| subscription_version_at_least(&version, minimum))
    };
    for program in [&first, &second] {
        if new_enough(read_version(cx, program).await) {
            return Some(program.clone());
        }
    }
    while let Some(program) = copies.next(cx).await {
        if new_enough(read_version(cx, &program).await) {
            return Some(program);
        }
    }
    Some(first)
}

/// `locateSubscriptionProgram(provider, options)`: the CLI of `provider` as a
/// directly spawnable program, or `None` when none is installed. Order: the
/// configured path, the Codex desktop app's copy (its bin tree on Windows; on
/// macOS the newer of its bundle and the PATH copy), PATH, then the install
/// locations PATH may not list yet (`%APPDATA%\npm`, the vendor installers'
/// own directories). Of several Claude Code copies, the first one new enough
/// for the app wins.
///
/// A configured path may name the executable, its directory, an npm shim or
/// a bare command. One that points into the Codex desktop tree (its
/// directories carry a release hash) or no longer exists is treated as
/// automatic.
pub async fn locate_subscription_program(
    rt: &Rt,
    state: &LocateState,
    provider: &str,
    options: &SubscriptionLocateOptions,
) -> Result<Option<SubscriptionProgram>, JsError> {
    let platform = options.platform.clone().unwrap_or_else(|| rt.platform());
    let layout = layout_of(provider).ok_or_else(|| {
        JsError::type_error(
            "Cannot destructure property 'name' of 'context.layout' as it is undefined.",
        )
    })?;
    let cx = Ctx {
        rt,
        state,
        provider: provider.to_owned(),
        layout,
        env: options.env.as_deref(),
        platform: platform.clone(),
        arch: options
            .arch
            .clone()
            .unwrap_or_else(|| node_arch().to_owned()),
        node_runtime: options.node_runtime.as_ref(),
        application_dirs: options.application_dirs.as_deref(),
        common_dirs: options.common_dirs.as_deref(),
        read_version: options.read_version.as_ref(),
    };
    let name = cx.layout.name;
    let managed_root = (if provider == "codex" {
        options
            .managed_install_root
            .clone()
            .or_else(|| managed_codex_root(&cx))
    } else {
        None
    })
    .filter(|root| !root.is_empty());

    let configured = expand_home(
        &clean_cli_path(options.configured_path.as_deref()),
        &cx.home(&platform),
    );
    if !configured.is_empty() {
        if host::is_absolute(&configured) || js_regex!(r"[\\/]").test(&configured) {
            let absolute = host::resolve(&[&configured]);
            let managed = managed_root
                .as_deref()
                .is_some_and(|root| is_inside(&absolute, root, &platform));
            if !managed {
                let program = if is_directory(rt, &absolute).await {
                    program_in_dir(&cx, &absolute, name, "configured").await
                } else if file_exists(rt, &absolute).await {
                    program_from_file(&cx, &absolute, "configured").await
                } else {
                    None
                };
                if program.is_some() {
                    return Ok(program);
                }
            }
        } else {
            let bare = if js_regex!(r"\.(exe|cmd|bat)$", "i").test(&configured) {
                &configured[..configured.len() - host::extname(&configured).len()]
            } else {
                configured.as_str()
            };
            let program = search_by_name(&cx, bare, "configured", Some("configured")).await;
            if program.is_some() {
                return Ok(program);
            }
        }
    }

    if let Some(root) = &managed_root
        && let Some(managed) = newest_managed_codex(&cx, root).await
    {
        return Ok(Some(cx.native(&managed, "managed", &[])));
    }
    let found = if provider == "claude-code" {
        first_usable_claude(&cx, ProgramStream::new(&cx, name, "path", None)).await
    } else {
        search_by_name(&cx, name, "path", None).await
    };
    if provider == "codex"
        && platform == "darwin"
        && let Some(bundled) = newest_mac_bundled_codex(&cx).await
        && is_newer_file(rt, &bundled, found.as_ref().map(|f| f.entry.as_str())).await
    {
        return Ok(Some(cx.native(&bundled, "managed", &[])));
    }
    if found.is_some() {
        return Ok(found);
    }
    if provider == "codex" && platform == "win32" {
        let local_app_data = cx.env("LOCALAPPDATA").or_else(|| cx.env("LocalAppData"));
        let packaged = match local_app_data.filter(|dir| !dir.is_empty()) {
            Some(dir) => winget_codex_package(rt, &dir, &cx.arch).await,
            None => None,
        };
        if let Some(packaged) = packaged {
            return Ok(Some(cx.native(&packaged, "winget", &[])));
        }
    }
    Ok(None)
}

/// `subscriptionProviderLabel(provider)`: display name of a subscription
/// provider, for messages
pub fn subscription_provider_label(provider: &str) -> &'static str {
    match provider {
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        "chatgpt" => "ChatGPT",
        _ => "",
    }
}

/// `resolveSubscriptionProgram(provider, options)`: `locateSubscriptionProgram`,
/// with a missing program reported as the `not-installed` run error
pub async fn resolve_subscription_program(
    rt: &Rt,
    state: &LocateState,
    provider: &str,
    options: &SubscriptionLocateOptions,
) -> Result<SubscriptionProgram, JsError> {
    if let Some(program) = locate_subscription_program(rt, state, provider, options).await? {
        return Ok(program);
    }
    Err(ai_run_error(
        "not-installed",
        format!(
            "{} CLI was not found",
            subscription_provider_label(provider)
        ),
        Some(provider),
        None,
    ))
}
