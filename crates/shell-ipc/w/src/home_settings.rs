//! home's settings and app facts: `home:get-*`/`home:set-*`, onboarding, the
//! MCP status and logs, the default app, the PDF result store, help links.
//! Their handlers are `registerHomeIpc` of `apps/shell/src/main/index.ts`
//! (with the helpers it calls, `currentAutoSaveDefault`, `currentMcpSettings`,
//! `readHomeKinds`, ...) and `registerResultStoreIpc`.
//!
//! The settings live in userData/app-settings.json (`main_core::shell::app_settings`).
//! What reaches beyond the file (the MCP server, the updater's toggle, the
//! menus, the help tab, the decision endpoint of the search settings) goes
//! through [`HomeApp`], the one host of this module.

use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use jscompat::node_path::host::{is_absolute, join};
use jscompat::{JsObject, JsonValue, slice_utf16, trim};
use main_core::node_fs::node_error as io_node_error;
use main_core::packages::ai_provider::settings_secrets::AiSecretCodec;
use main_core::packages::electron_utils::default_save_dir::{
    DEFAULT_SAVE_DIR_KEY, PathProvider, SaveDirState, Thrown, configured_default_save_dir,
    is_usable_save_dir,
};
use main_core::packages::electron_utils::github_menu::GITHUB_REPO_URL;
use main_core::packages::electron_utils::hwp_default_format::{
    HWP_DEFAULT_FORMAT_KEY, HwpDefaultFormat, normalize_hwp_default_format, read_hwp_default_format,
};
use main_core::packages::electron_utils::legacy_import_prefs::{
    read_legacy_import_prompt, write_legacy_import_prompt,
};
use main_core::packages::i18n::{Lang, PRODUCT_NAME, install_lang, normalize_lang};
use main_core::shell::ai_secrets::{open_file_search_keys, seal_file_search_keys};
use main_core::shell::app_settings::{
    Settings, read_app_settings, write_app_setting, write_app_settings,
};
use main_core::shell::csv_import_limit::{CSV_IMPORT_LIMIT_CHOICES_MB, csv_import_limit_mb};
use main_core::shell::default_app::{
    DefaultAppDeps, DefaultAppHost, DefaultAppState, DefaultAppStatus, create_default_app_service,
    exec_file_runner,
};
use main_core::shell::feedback::{
    FEEDBACK_SURVEY_URL, FeedbackEnvironment, feedback_details, feedback_text, platform_label,
};
use shell_contract::error::IpcError;
use shell_contract::hosts::{FileDialog, MessageBox};
use shell_contract::ids::WindowId;
use shell_contract::ipc::{
    CallContext, ChannelKind, Handler, RegisterError, Registry, Responder, Target,
};
use shell_contract::runtime::{AppPaths, PathName, Services};
use shell_contract::{Batch, ClipboardHost, DialogsHost, IpcValue, MainWindowHost, OsShellHost};

use crate::convert::{field, node_error};

// ---- the host ----

/// `DEFAULT_MCP_PORT` of `apps/shell/src/main/mcp/mcp-server.ts`
pub const DEFAULT_MCP_PORT: u32 = 3093;

/// `McpSettings` of `mcp/app-mcp.ts`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct McpSettings {
    pub enabled: bool,
    pub port: u32,
    /// headless create_docx is exposed to clients
    pub background: bool,
    /// server activity is written to the log file
    pub logging: bool,
}

/// `McpStatus` of `mcp/app-mcp.ts`
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpStatus {
    pub running: bool,
    pub settings: McpSettings,
    pub url: Option<String>,
    /// capability families the current build exposes
    pub capabilities: Vec<String>,
}

/// What the shell does for these channels beyond the settings file. Called on
/// the core thread, except `probe_decision` and `mcp_apply`, which block and
/// run on a worker (they awaited in TypeScript).
pub trait HomeApp: Send + Sync {
    /// `app.getVersion()`
    fn version(&self) -> String;
    /// `app.isPackaged`
    fn is_packaged(&self) -> bool;
    /// `app.getLocale()`
    fn locale(&self) -> String;
    /// `os.release()`
    fn os_release(&self) -> String;
    /// `Date.now()`
    fn now_ms(&self) -> f64;
    /// THIRD-PARTY-NOTICES.txt: in the resources folder when packaged, else under the app's `build`
    fn third_party_notices_path(&self) -> PathBuf;
    /// the tab manager's `openHelpTab(topic)`
    fn open_help(&self, topic: Option<&str>);
    /// the updater reads the toggle (`autoUpdateCheckEnabled`) after this
    fn auto_update_check_changed(&self, on: bool);
    /// `setDelimitedImportLimit(bytes)`
    fn delimited_import_limit_changed(&self, bytes: f64);
    /// the home menu and the Dock menu list the new-document kinds (`applyMenuFor('home')`, `installDockMenu()`)
    fn home_kinds_changed(&self);
    /// `ensureFolderWatchers()`: the save folder moved
    fn folder_watchers_changed(&self);
    /// the safeStorage codec of the keys in the search settings; `None` where this PC cannot seal
    fn secrets(&self) -> Option<&dyn AiSecretCodec>;
    /// `evaluate(...)` of the decision client against `settings`: the error code it throws
    fn probe_decision(&self, settings: &FileSearchSettings) -> Result<(), String>;
    /// `mcpStatus()`
    fn mcp_status(&self) -> McpStatus;
    /// `applyMcpSettings(settings)`: the message it throws
    fn mcp_apply(&self, settings: McpSettings) -> Result<McpStatus, String>;
    /// `getMcpRecentLogs()`
    fn mcp_logs(&self) -> Vec<String>;
    /// `clearMcpLogs()`
    fn mcp_clear_logs(&self);
    /// `revealMcpLogFile()`: creates the log file when missing
    fn mcp_reveal_log_file(&self);
    /// `mcpLogFilePath()`
    fn mcp_log_file(&self) -> Option<PathBuf>;
}

pub type HomeAppHost = Arc<dyn HomeApp>;

// ---- JavaScript values ----

fn json_to_ipc(value: &JsonValue) -> IpcValue {
    match value {
        JsonValue::Null => IpcValue::Null,
        JsonValue::Bool(b) => IpcValue::Bool(*b),
        JsonValue::Number(n) => IpcValue::Number(*n),
        JsonValue::String(s) => IpcValue::String(s.clone()),
        JsonValue::Array(items) => IpcValue::Array(items.iter().map(json_to_ipc).collect()),
        JsonValue::Object(o) => IpcValue::Object(
            o.entries()
                .into_iter()
                .map(|(k, v)| (k.to_owned(), json_to_ipc(v)))
                .collect(),
        ),
    }
}

/// A value the renderer sent, read as the settings code reads `unknown`;
/// `undefined` is `None`. Bytes and dates are objects without the keys the
/// settings look for, which reads as an empty object.
fn ipc_to_json(value: &IpcValue) -> Option<JsonValue> {
    Some(match value {
        IpcValue::Undefined => return None,
        IpcValue::Null => JsonValue::Null,
        IpcValue::Bool(b) => JsonValue::Bool(*b),
        IpcValue::Number(n) => JsonValue::Number(*n),
        IpcValue::String(s) => JsonValue::String(s.clone()),
        IpcValue::Bytes(..) | IpcValue::Date(_) => JsonValue::Object(JsObject::new()),
        IpcValue::Array(items) => JsonValue::Array(
            items
                .iter()
                .map(|v| ipc_to_json(v).unwrap_or(JsonValue::Null))
                .collect(),
        ),
        IpcValue::Object(entries) => {
            let mut object = JsObject::new();
            for (key, v) in entries {
                if let Some(v) = ipc_to_json(v) {
                    object.set(key.as_str(), v);
                }
            }
            JsonValue::Object(object)
        }
    })
}

fn without_key(object: &JsObject<JsonValue>, key: &str) -> JsObject<JsonValue> {
    object
        .entries()
        .into_iter()
        .filter(|(k, _)| *k != key)
        .map(|(k, v)| (k.to_owned(), v.clone()))
        .collect()
}

/// `typeof x === 'object' && x`: what `x ?? {}` spreads own keys of
fn is_object(value: &IpcValue) -> bool {
    matches!(
        value,
        IpcValue::Object(_) | IpcValue::Array(_) | IpcValue::Bytes(..) | IpcValue::Date(_)
    )
}

fn flag(value: Option<&JsonValue>) -> Option<bool> {
    match value {
        Some(JsonValue::Bool(b)) => Some(*b),
        _ => None,
    }
}

/// `Number.isInteger(n) && n > 0 && n < 65536`
fn valid_port(n: f64) -> Option<u32> {
    (n.is_finite() && n.fract() == 0.0 && n > 0.0 && n < 65536.0).then_some(n as u32)
}

fn error(message: impl Into<String>) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: message.into(),
    }
}

// ---- the file search settings (`rerank.ts`) ----

/// `ENDPOINT_IDS`
const ENDPOINT_IDS: [&str; 13] = [
    "openrouter",
    "direct",
    "perplexity",
    "perplexity-v12",
    "perplexity-flash",
    "liquid",
    "liquid-ultra",
    "openai",
    "cloudflare",
    "cloudflare-flash",
    "kev",
    "rizzo",
    "custom",
];

const DEFAULT_CLOUDFLARE_MODEL: &str = "@cf/cloudflare/clef";

/// `FileSearchSettings`
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileSearchSettings {
    pub rerank: bool,
    pub endpoint: &'static str,
    /// one key per `ENDPOINT_IDS` entry, in that order
    pub keys: Vec<(&'static str, String)>,
    pub custom_base_url: String,
    pub custom_model: String,
    pub cloudflare_account_id: String,
    pub cloudflare_model: String,
}

impl FileSearchSettings {
    /// the key of the chosen endpoint
    pub fn key(&self) -> &str {
        self.keys
            .iter()
            .find(|(id, _)| *id == self.endpoint)
            .map_or("", |(_, key)| key)
    }

    fn keys_json(&self) -> JsObject<JsonValue> {
        self.keys
            .iter()
            .map(|(id, key)| ((*id).to_owned(), JsonValue::String(key.clone())))
            .collect()
    }

    /// the object as `normalizeFileSearchSettings` builds it, keys in its order
    fn to_json(&self) -> JsonValue {
        let mut o = JsObject::new();
        o.set("rerank", JsonValue::Bool(self.rerank));
        o.set("endpoint", JsonValue::String(self.endpoint.to_owned()));
        o.set("keys", JsonValue::Object(self.keys_json()));
        o.set(
            "customBaseUrl",
            JsonValue::String(self.custom_base_url.clone()),
        );
        o.set("customModel", JsonValue::String(self.custom_model.clone()));
        o.set(
            "cloudflareAccountId",
            JsonValue::String(self.cloudflare_account_id.clone()),
        );
        o.set(
            "cloudflareModel",
            JsonValue::String(self.cloudflare_model.clone()),
        );
        JsonValue::Object(o)
    }
}

/// `a ?? b`
fn nullish<'a>(a: Option<&'a JsonValue>, b: Option<&'a JsonValue>) -> Option<&'a JsonValue> {
    match a {
        None | Some(JsonValue::Null) => b,
        other => other,
    }
}

/// `typeof v === 'string' ? v.trim().slice(0, n) : ''`
fn trimmed(value: Option<&JsonValue>, n: usize) -> String {
    match value {
        Some(JsonValue::String(s)) => slice_utf16(trim(s), 0.0, Some(n as f64)),
        _ => String::new(),
    }
}

/// `normalizeFileSearchSettings(raw)`: accepts the current shape and the one
/// before it (`jevEndpoint`/`jevKeys`)
fn normalize_file_search(raw: Option<&JsonValue>) -> FileSearchSettings {
    let empty = JsObject::new();
    let r = match raw {
        Some(JsonValue::Object(o)) => o,
        _ => &empty,
    };
    let keys_raw = nullish(r.get("keys"), r.get("jevKeys"));
    let endpoint_raw = nullish(r.get("endpoint"), r.get("jevEndpoint"));
    let endpoint = ENDPOINT_IDS
        .iter()
        .find(|id| matches!(endpoint_raw, Some(JsonValue::String(s)) if s == *id))
        .copied()
        .unwrap_or("openrouter");
    let keys = ENDPOINT_IDS
        .iter()
        .map(|id| {
            let raw = match keys_raw {
                Some(JsonValue::Object(o)) => o.get(id),
                _ => None,
            };
            (*id, trimmed(raw, 512))
        })
        .collect();
    let cloudflare_model = trimmed(r.get("cloudflareModel"), 256);
    FileSearchSettings {
        rerank: flag(r.get("rerank")) == Some(true),
        endpoint,
        keys,
        custom_base_url: trimmed(r.get("customBaseUrl"), 512),
        custom_model: trimmed(r.get("customModel"), 128),
        cloudflare_account_id: trimmed(r.get("cloudflareAccountId"), 128),
        cloudflare_model: if cloudflare_model.is_empty() {
            DEFAULT_CLOUDFLARE_MODEL.to_owned()
        } else {
            cloudflare_model
        },
    }
}

/// `PROBE_ERRORS`: what the settings screen shows for each failure the decision client reports
const PROBE_ERRORS: [(&str, &str); 13] = [
    ("missing-key", "Enter an API key"),
    ("missing-url", "Enter the server URL"),
    ("missing-account", "Enter the Cloudflare account ID"),
    ("bad-url", "Server URL is not a valid address"),
    (
        "insecure-url",
        "Server URL must be https:// (http:// only for this machine)",
    ),
    (
        "unsupported-model",
        "Cloudflare only serves clef, clef-flash and clef-omni",
    ),
    ("empty-request", "Nothing to judge"),
    ("rate-limit", "Rate limited \u{2014} try again shortly"),
    ("response-too-large", "The reply was too large"),
    (
        "invalid-response",
        "The endpoint returned an unexpected reply",
    ),
    (
        "model-mismatch",
        "The endpoint answered with a different model",
    ),
    ("provider-warning", "The provider reported a warning"),
    ("cancelled", "The call timed out"),
];

/// the failure text for a decision client's error code
fn probe_error_text(code: &str) -> String {
    if let Some((_, text)) = PROBE_ERRORS.iter().find(|(known, _)| *known == code) {
        return (*text).to_owned();
    }
    match code.strip_prefix("http-") {
        Some(digits) if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) => {
            format!("HTTP {digits}")
        }
        _ => code.to_owned(),
    }
}

// ---- which new-document kinds home shows (`shared/home-kinds.ts`) ----

/// `HOME_KINDS`
const HOME_KINDS: [&str; 10] = [
    "docx", "xlsx", "pptx", "md", "html", "xmind", "drawio", "hwp", "pdf", "pdfTools",
];

#[derive(Clone, Debug, PartialEq, Eq)]
struct HomeKinds {
    order: Vec<&'static str>,
    hidden: Vec<&'static str>,
}

/// `knownKinds(raw)`: the known ids of an array, each once
fn known_kinds(raw: Option<&JsonValue>) -> Vec<&'static str> {
    let mut kinds: Vec<&'static str> = Vec::new();
    if let Some(JsonValue::Array(items)) = raw {
        for item in items {
            if let JsonValue::String(s) = item
                && let Some(kind) = HOME_KINDS.iter().find(|k| **k == s)
                && !kinds.contains(kind)
            {
                kinds.push(kind);
            }
        }
    }
    kinds
}

/// `normalizeHomeKinds(raw)`: a kind missing from a saved order goes right
/// after the nearest kind before it in the first order, or first
fn normalize_home_kinds(raw: Option<&JsonValue>) -> HomeKinds {
    let empty = JsObject::new();
    let obj = match raw {
        Some(JsonValue::Object(o)) => o,
        _ => &empty,
    };
    let mut order = known_kinds(obj.get("order"));
    for (index, kind) in HOME_KINDS.iter().enumerate() {
        if order.contains(kind) {
            continue;
        }
        let at = (0..index)
            .rev()
            .find_map(|before| order.iter().position(|k| *k == HOME_KINDS[before]))
            .map_or(0, |found| found + 1);
        order.insert(at, kind);
    }
    let hidden = known_kinds(obj.get("hidden"));
    let hidden = order
        .iter()
        .copied()
        .filter(|kind| hidden.contains(kind))
        .collect();
    HomeKinds { order, hidden }
}

impl HomeKinds {
    /// `storedHomeKinds`: only what differs from the first state
    fn stored(&self) -> JsonValue {
        let list = |kinds: &[&str]| {
            JsonValue::Array(
                kinds
                    .iter()
                    .map(|k| JsonValue::String((*k).to_owned()))
                    .collect(),
            )
        };
        let mut stored = JsObject::new();
        if self.order.iter().zip(HOME_KINDS).any(|(a, b)| *a != b) {
            stored.set("order", list(&self.order));
        }
        if !self.hidden.is_empty() {
            stored.set("hidden", list(&self.hidden));
        }
        JsonValue::Object(stored)
    }

    fn to_ipc(&self) -> IpcValue {
        let list = |kinds: &[&str]| {
            IpcValue::Array(
                kinds
                    .iter()
                    .map(|k| IpcValue::String((*k).to_owned()))
                    .collect(),
            )
        };
        IpcValue::Object(vec![
            ("order".into(), list(&self.order)),
            ("hidden".into(), list(&self.hidden)),
        ])
    }
}

// ---- the PDF result store (`result-store-ipc.ts`, `ResultStore` of packages/pdf-structure) ----

fn type_error(message: impl Into<String>) -> IpcError {
    IpcError {
        name: Some("TypeError".into()),
        message: message.into(),
    }
}

/// `new ResultStore(userDataDir).dir`: the store's folder, or what the constructor throws
fn result_store_dir(user_data_dir: &str) -> Result<String, IpcError> {
    if !is_absolute(user_data_dir) {
        return Err(type_error(format!(
            "result store: the user-data folder must be absolute: {user_data_dir}"
        )));
    }
    if user_data_dir
        .split(['/', '\\'])
        .any(|part| part.to_lowercase() == ".genoffice")
    {
        return Err(type_error(
            "result store: ~/.genoffice belongs to the upstream program",
        ));
    }
    Ok(join(&[user_data_dir, "pdf-store"]))
}

/// `folderSize(dir)`: regular files only, 0 for a folder that cannot be read
fn folder_size(dir: &str) -> f64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0.0;
    };
    let mut total = 0.0;
    for entry in entries.flatten() {
        let path = join(&[dir, &entry.file_name().to_string_lossy()]);
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            total += folder_size(&path);
        } else if kind.is_file() {
            total += fs::metadata(&path).map_or(0.0, |m| m.len() as f64);
        }
    }
    total
}

/// `removeFolder(dir)`: `rm(dir, { recursive: true, force: true })`
fn remove_folder(dir: &str) -> Result<(), IpcError> {
    let removed = match fs::symlink_metadata(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(dir),
        Ok(_) => fs::remove_file(dir),
    };
    removed.map_err(|e| {
        let errno = io_node_error(&e, "rm", dir).code.unwrap_or("unknown");
        IpcError {
            name: Some("StoreWriteError".into()),
            message: format!("result store write failed ({errno}): {dir}"),
        }
    })
}

// ---- the table of plain flags ----

/// How a flag reads its saved value
#[derive(Clone, Copy)]
enum Reads {
    /// `saved === true`: off unless set
    IsTrue,
    /// `saved !== false`: on unless switched off
    NotFalse,
}

/// The get channels that answer one boolean of app-settings.json
const FLAGS: [(&str, &str, Reads); 2] = [
    ("home:onboarding-seen", "onboardingSeen", Reads::IsTrue),
    (
        "home:get-auto-update-check",
        "autoUpdateCheck",
        Reads::NotFalse,
    ),
];

// ---- the languages of the two messages this module shows ----

fn pick_dir_title(lang: Lang) -> &'static str {
    match lang {
        Lang::En => "Choose Default Save Location",
        Lang::Ko => "\u{AE30}\u{BCF8} \u{C800}\u{C7A5} \u{C704}\u{CE58} \u{C120}\u{D0DD}",
    }
}

fn save_dir_unusable(lang: Lang) -> &'static str {
    match lang {
        Lang::En => {
            "The selected folder is not writable and cannot be used as the default save location"
        }
        Lang::Ko => {
            "\u{C120}\u{D0DD}\u{D55C} \u{D3F4}\u{B354}\u{C5D0} \u{C4F8} \u{C218} \u{C5C6}\u{C5B4} \u{AE30}\u{BCF8} \u{C800}\u{C7A5} \u{C704}\u{CE58}\u{B85C} \u{C0AC}\u{C6A9}\u{D560} \u{C218} \u{C5C6}\u{C2B5}\u{B2C8}\u{B2E4}"
        }
    }
}

/// `process.platform` of this build
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

// ---- what every handler shares ----

struct PathsOf(Arc<dyn AppPaths>);

impl PathProvider for PathsOf {
    fn get_path(&self, name: &str) -> Result<String, Thrown> {
        let name = match name {
            "userData" => PathName::UserData,
            "documents" => PathName::Documents,
            "home" => PathName::Home,
            other => return Err(Thrown(format!("Failed to get '{other}' path"))),
        };
        Ok(self.0.path(name).to_string_lossy().into_owned())
    }
}

struct Ctx {
    services: Services,
    app: HomeAppHost,
    os_shell: OsShellHost,
    clipboard: ClipboardHost,
    dialogs: DialogsHost,
    main_window: MainWindowHost,
    settings_path: String,
    save_dir_state: RefCell<SaveDirState>,
    /// `cachedAutoSaveDefault`
    auto_save: RefCell<Option<(bool, f64)>>,
}

impl Ctx {
    fn settings(&self) -> Settings {
        read_app_settings(&self.settings_path)
    }

    fn write(&self, key: &str, value: JsonValue) -> Result<(), IpcError> {
        write_app_setting(&self.settings_path, key, Some(value)).map_err(node_error)
    }

    fn write_all(&self, updates: &[(&str, Option<JsonValue>)]) -> Result<(), IpcError> {
        write_app_settings(&self.settings_path, updates).map_err(node_error)
    }

    fn paths(&self) -> PathsOf {
        PathsOf(self.services.paths.clone())
    }

    /// `currentLang()`
    fn lang(&self) -> Lang {
        if let Ok(env) = std::env::var("SEUOFFICE_LANG") {
            return normalize_lang(Some(&env));
        }
        install_lang(self.settings().get("language"), Some(&self.app.locale()))
    }

    /// `defaultSaveDir()`
    fn save_dir(&self) -> Result<String, IpcError> {
        configured_default_save_dir(
            &self.paths(),
            &mut self.save_dir_state.borrow_mut(),
            self.app.now_ms(),
        )
        .map_err(|Thrown(message)| error(message))
    }

    /// `readFileSearchSettings()`
    fn file_search(&self) -> FileSearchSettings {
        let stored = self.settings().get("fileSearch").cloned();
        let opened = open_file_search_keys(self.app.secrets(), &stored.unwrap_or(JsonValue::Null));
        normalize_file_search(Some(&opened))
    }

    /// `currentMcpSettings()`
    fn mcp_settings(&self) -> McpSettings {
        let saved = self.settings();
        McpSettings {
            enabled: flag(saved.get("mcpEnabled")) == Some(true),
            port: match saved.get("mcpPort") {
                Some(JsonValue::Number(n)) => valid_port(*n),
                _ => None,
            }
            .unwrap_or(DEFAULT_MCP_PORT),
            background: flag(saved.get("mcpBackground")) == Some(true),
            logging: flag(saved.get("mcpLogging")) == Some(true),
        }
    }

    /// `currentAutoSaveDefault()`: read once, then kept
    fn auto_save_default(&self) -> (bool, f64) {
        *self.auto_save.borrow_mut().get_or_insert_with(|| {
            let saved = self.settings();
            let updated_at = match saved.get("autoSaveDefaultUpdatedAt") {
                Some(JsonValue::Number(n)) if *n > 0.0 => *n,
                _ => 0.0,
            };
            (flag(saved.get("autoSaveDefault")) == Some(true), updated_at)
        })
    }

    /// a home handler's dialog parent: the shell window, else the window in use
    fn focused_window(&self, cx: &CallContext) -> Option<WindowId> {
        self.main_window.window().or(Some(cx.sender.window))
    }
}

fn auto_save_ipc((on, updated_at): (bool, f64)) -> IpcValue {
    IpcValue::Object(vec![
        ("on".into(), IpcValue::Bool(on)),
        ("updatedAt".into(), IpcValue::Number(updated_at)),
    ])
}

fn mcp_status_ipc(status: &McpStatus) -> Vec<(String, IpcValue)> {
    vec![
        ("running".into(), IpcValue::Bool(status.running)),
        ("enabled".into(), IpcValue::Bool(status.settings.enabled)),
        (
            "port".into(),
            IpcValue::Number(f64::from(status.settings.port)),
        ),
        (
            "background".into(),
            IpcValue::Bool(status.settings.background),
        ),
        ("logging".into(), IpcValue::Bool(status.settings.logging)),
        (
            "url".into(),
            status.url.clone().map_or(IpcValue::Null, IpcValue::String),
        ),
        (
            "capabilities".into(),
            IpcValue::Array(
                status
                    .capabilities
                    .iter()
                    .cloned()
                    .map(IpcValue::String)
                    .collect(),
            ),
        ),
    ]
}

fn default_app_ipc(status: &DefaultAppStatus) -> IpcValue {
    let state = match status.state {
        DefaultAppState::Unsupported => "unsupported",
        DefaultAppState::Unknown => "unknown",
        DefaultAppState::Default => "default",
        DefaultAppState::Other => "other",
    };
    IpcValue::Object(vec![
        ("state".into(), IpcValue::String(state.into())),
        (
            "others".into(),
            IpcValue::Array(status.others.iter().map(json_to_ipc).collect()),
        ),
        ("manualOnly".into(), IpcValue::Bool(status.manual_only)),
    ])
}

/// Runs the status commands of the default app service: processes through
/// `execFile`, the Windows settings page through the OS shell
struct Commands(OsShellHost);

impl DefaultAppHost for Commands {
    fn run(&mut self, cmd: &str, args: &[String]) -> Result<String, String> {
        exec_file_runner(cmd, args).map_err(|e| e.message)
    }

    fn open_external(&mut self, url: &str) -> Result<(), String> {
        self.0.open_external(url)
    }
}

// ---- handlers that answer later ----

/// A handler that keeps its `Responder` and answers from a worker
struct Later<F>(F);

impl<F> Handler for Later<F>
where
    F: Fn(&CallContext, Vec<IpcValue>, Responder),
{
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        (self.0)(cx, args, reply)
    }
}

fn handle_later(
    registry: &mut dyn Registry,
    channel: &'static str,
    f: impl Fn(&CallContext, Vec<IpcValue>, Responder) + 'static,
) -> Result<(), RegisterError> {
    registry.register(Batch::W, channel, ChannelKind::Invoke, Rc::new(Later(f)))
}

fn invoke(
    registry: &mut dyn Registry,
    channel: &'static str,
    f: impl Fn(&CallContext, Vec<IpcValue>) -> Result<IpcValue, IpcError> + 'static,
) -> Result<(), RegisterError> {
    crate::handle(registry, channel, ChannelKind::Invoke, f)
}

// ---- registration ----

pub fn register(registry: &mut dyn Registry, services: &Services) -> Result<(), RegisterError> {
    let cx = Rc::new(Ctx {
        services: services.clone(),
        app: services.hosts.need(Batch::W)?,
        os_shell: services.hosts.need(Batch::W)?,
        clipboard: services.hosts.need(Batch::W)?,
        dialogs: services.hosts.need(Batch::W)?,
        main_window: services.hosts.need(Batch::W)?,
        settings_path: services
            .paths
            .path(PathName::UserData)
            .join("app-settings.json")
            .to_string_lossy()
            .into_owned(),
        save_dir_state: RefCell::new(SaveDirState::new()),
        auto_save: RefCell::new(None),
    });
    flags(registry, &cx)?;
    auto_save(registry, &cx)?;
    csv_limit(registry, &cx)?;
    save_dir(registry, &cx)?;
    formats(registry, &cx)?;
    file_search(registry, &cx)?;
    home_kinds(registry, &cx)?;
    mcp(registry, &cx)?;
    default_app(registry, &cx)?;
    result_store(registry, &cx)?;
    links(registry, &cx)
}

/// onboarding, the update check, the app version
fn flags(registry: &mut dyn Registry, cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    for (channel, key, reads) in FLAGS {
        let cx = cx.clone();
        invoke(registry, channel, move |_, _| {
            let saved = cx.settings();
            let value = match reads {
                Reads::IsTrue => flag(saved.get(key)) == Some(true),
                Reads::NotFalse => flag(saved.get(key)) != Some(false),
            };
            Ok(IpcValue::Bool(value))
        })?;
    }
    let c = cx.clone();
    invoke(registry, "home:set-onboarding-seen", move |_, _| {
        Ok(IpcValue::Bool(
            c.write("onboardingSeen", JsonValue::Bool(true)).is_ok(),
        ))
    })?;
    let c = cx.clone();
    invoke(registry, "home:set-auto-update-check", move |_, args| {
        let Some(IpcValue::Bool(on)) = args.first() else {
            return Ok(IpcValue::Undefined);
        };
        c.write("autoUpdateCheck", JsonValue::Bool(*on))?;
        c.app.auto_update_check_changed(*on);
        Ok(IpcValue::Undefined)
    })?;
    let c = cx.clone();
    invoke(registry, "home:get-app-version", move |_, _| {
        Ok(IpcValue::String(c.app.version()))
    })
}

fn auto_save(registry: &mut dyn Registry, cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    let c = cx.clone();
    invoke(registry, "home:get-auto-save-default", move |_, _| {
        Ok(auto_save_ipc(c.auto_save_default()))
    })?;
    let c = cx.clone();
    invoke(registry, "home:set-auto-save-default", move |_, args| {
        let Some(IpcValue::Bool(on)) = args.first() else {
            return Ok(IpcValue::Undefined);
        };
        if *on == c.auto_save_default().0 {
            return Ok(IpcValue::Undefined);
        }
        let next = (*on, c.app.now_ms());
        // the TypeScript keeps the new value before it writes: a failed write leaves it in memory
        *c.auto_save.borrow_mut() = Some(next);
        c.write_all(&[
            ("autoSaveDefault", Some(JsonValue::Bool(next.0))),
            ("autoSaveDefaultUpdatedAt", Some(JsonValue::Number(next.1))),
        ])?;
        c.services.events.emit(
            Target::All,
            "app:auto-save-default-changed",
            vec![auto_save_ipc(next)],
        );
        Ok(IpcValue::Undefined)
    })
}

fn csv_limit(registry: &mut dyn Registry, cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    let c = cx.clone();
    invoke(registry, "home:get-csv-import-limit", move |_, _| {
        Ok(IpcValue::Number(csv_import_limit_mb(&c.settings())))
    })?;
    let c = cx.clone();
    invoke(registry, "home:set-csv-import-limit", move |_, args| {
        let Some(IpcValue::Number(mb)) = args.first() else {
            return Ok(IpcValue::Undefined);
        };
        let mb = *mb;
        if !(mb.is_finite() && mb.fract() == 0.0) || !CSV_IMPORT_LIMIT_CHOICES_MB.contains(&mb) {
            return Ok(IpcValue::Undefined);
        }
        if mb == csv_import_limit_mb(&c.settings()) {
            return Ok(IpcValue::Undefined);
        }
        c.write_all(&[("csvImportLimitMb", Some(JsonValue::Number(mb)))])?;
        c.app.delimited_import_limit_changed(mb * 1024.0 * 1024.0);
        Ok(IpcValue::Undefined)
    })
}

/// the default save folder: where it is, and choosing another
fn save_dir(registry: &mut dyn Registry, cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    let c = cx.clone();
    invoke(registry, "home:get-default-save-dir", move |_, _| {
        c.save_dir().map(IpcValue::String)
    })?;
    let c = cx.clone();
    invoke(registry, "home:pick-default-save-dir", move |_, _| {
        let lang = c.lang();
        let parent = c.main_window.window();
        let picked = c.dialogs.open(
            parent,
            &FileDialog {
                title: Some(pick_dir_title(lang).to_owned()),
                default_path: Some(PathBuf::from(c.save_dir()?)),
                properties: vec!["openDirectory".into(), "createDirectory".into()],
                ..FileDialog::default()
            },
        );
        let Some(picked) = picked.and_then(|paths| paths.into_iter().next()) else {
            return Ok(IpcValue::Null);
        };
        let picked = picked.to_string_lossy().into_owned();
        if picked.is_empty() {
            return Ok(IpcValue::Null);
        }
        if !is_usable_save_dir(&picked) {
            c.dialogs.message(
                parent,
                &MessageBox {
                    kind: Some("error".into()),
                    message: save_dir_unusable(lang).to_owned(),
                    detail: Some(picked),
                    ..MessageBox::default()
                },
            );
            return Ok(IpcValue::Null);
        }
        c.write(DEFAULT_SAVE_DIR_KEY, JsonValue::String(picked.clone()))?;
        c.app.folder_watchers_changed();
        Ok(IpcValue::String(picked))
    })
}

/// the Hangul save format and the legacy import prompt
fn formats(registry: &mut dyn Registry, cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    let format_text = |format: HwpDefaultFormat| {
        IpcValue::String(
            match format {
                HwpDefaultFormat::Hwp => "hwp",
                HwpDefaultFormat::Hwpx => "hwpx",
            }
            .into(),
        )
    };
    let c = cx.clone();
    invoke(registry, "home:get-hwp-default-format", move |_, _| {
        Ok(format_text(read_hwp_default_format(&c.paths())))
    })?;
    let c = cx.clone();
    invoke(registry, "home:set-hwp-default-format", move |_, args| {
        let value = args.first().and_then(ipc_to_json);
        let next = normalize_hwp_default_format(value.as_ref());
        c.write(
            HWP_DEFAULT_FORMAT_KEY,
            JsonValue::String(
                match next {
                    HwpDefaultFormat::Hwp => "hwp",
                    HwpDefaultFormat::Hwpx => "hwpx",
                }
                .into(),
            ),
        )?;
        Ok(format_text(next))
    })?;
    let c = cx.clone();
    invoke(registry, "home:get-legacy-import-prompt", move |_, _| {
        Ok(IpcValue::Bool(read_legacy_import_prompt(&c.settings_path)))
    })?;
    let c = cx.clone();
    invoke(registry, "home:set-legacy-import-prompt", move |_, args| {
        // `prompt !== false`
        let prompt = !matches!(args.first(), Some(IpcValue::Bool(false)));
        write_legacy_import_prompt(&c.settings_path, prompt).map_err(node_error)?;
        Ok(IpcValue::Bool(read_legacy_import_prompt(&c.settings_path)))
    })
}

fn file_search(registry: &mut dyn Registry, cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    let c = cx.clone();
    invoke(registry, "home:get-file-search-settings", move |_, _| {
        Ok(json_to_ipc(&c.file_search().to_json()))
    })?;
    let c = cx.clone();
    invoke(registry, "home:set-file-search-settings", move |_, args| {
        let current = c.file_search();
        // `{ ...current, ...p, keys: { ...current.keys, ...(p.keys ?? {}) } }`: a key the
        // patch holds as `undefined` reads as missing, which `normalize` turns to its default
        let patch = args.first().filter(|p| is_object(p));
        let patch_entries: &[(String, IpcValue)] = match patch {
            Some(IpcValue::Object(entries)) => entries,
            _ => &[],
        };
        let mut merged = match current.to_json() {
            JsonValue::Object(o) => o,
            _ => JsObject::new(),
        };
        for (key, value) in patch_entries {
            merged = match ipc_to_json(value) {
                Some(v) => {
                    merged.set(key.as_str(), v);
                    merged
                }
                None => without_key(&merged, key),
            };
        }
        let mut keys = current.keys_json();
        if let Some(IpcValue::Object(entries)) = patch.and_then(|p| field(p, "keys")) {
            for (id, value) in entries {
                keys = match ipc_to_json(value) {
                    Some(v) => {
                        keys.set(id.as_str(), v);
                        keys
                    }
                    None => without_key(&keys, id),
                };
            }
        }
        merged.set("keys", JsonValue::Object(keys));
        let next = normalize_file_search(Some(&JsonValue::Object(merged)));
        let sealed = seal_file_search_keys(c.app.secrets(), &next.to_json());
        c.write("fileSearch", sealed)?;
        Ok(json_to_ipc(&next.to_json()))
    })?;
    let c = cx.clone();
    handle_later(
        registry,
        "home:test-file-search-rerank",
        move |_, args, reply| {
            let input = args.first().and_then(ipc_to_json);
            let settings = normalize_file_search(input.as_ref());
            let local = matches!(settings.endpoint, "kev" | "rizzo" | "custom");
            if !local && trim(settings.key()).is_empty() {
                return reply.reply(Ok(probe_result(Err("missing-key".to_owned()))));
            }
            let app = c.app.clone();
            c.services.workers.spawn(Box::new(move || {
                reply.reply(Ok(probe_result(app.probe_decision(&settings))))
            }));
        },
    )
}

/// `{ ok: true }` or `{ ok: false, error }` for the code the decision client threw
fn probe_result(outcome: Result<(), String>) -> IpcValue {
    match outcome {
        Ok(()) => IpcValue::Object(vec![("ok".into(), IpcValue::Bool(true))]),
        Err(code) => IpcValue::Object(vec![
            ("ok".into(), IpcValue::Bool(false)),
            ("error".into(), IpcValue::String(probe_error_text(&code))),
        ]),
    }
}

fn home_kinds(registry: &mut dyn Registry, cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    let read = |c: &Ctx| normalize_home_kinds(c.settings().get("homeKinds"));
    let c = cx.clone();
    invoke(registry, "home:get-home-kinds", move |_, _| {
        Ok(read(&c).to_ipc())
    })?;
    let c = cx.clone();
    invoke(registry, "home:set-home-kinds", move |_, args| {
        let raw = args.first().and_then(ipc_to_json);
        c.write("homeKinds", normalize_home_kinds(raw.as_ref()).stored())?;
        let next = read(&c).to_ipc();
        c.app.home_kinds_changed();
        c.services
            .events
            .emit(Target::All, "home:home-kinds-changed", vec![next.clone()]);
        Ok(next)
    })
}

fn mcp(registry: &mut dyn Registry, cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    let c = cx.clone();
    invoke(registry, "home:get-mcp-status", move |_, _| {
        Ok(IpcValue::Object(mcp_status_ipc(&c.app.mcp_status())))
    })?;
    let c = cx.clone();
    handle_later(registry, "home:set-mcp-settings", move |_, args, reply| {
        let status = |c: &Ctx| IpcValue::Object(mcp_status_ipc(&c.app.mcp_status()));
        let Some(patch) = args.first().filter(|p| is_object(p)) else {
            return reply.reply(Ok(status(&c)));
        };
        let current = c.mcp_settings();
        let flag_of = |key: &str, current: bool| match field(patch, key) {
            Some(IpcValue::Bool(b)) => *b,
            _ => current,
        };
        let next = McpSettings {
            enabled: flag_of("enabled", current.enabled),
            port: match field(patch, "port") {
                Some(IpcValue::Number(n)) => valid_port(*n),
                _ => None,
            }
            .unwrap_or(current.port),
            background: flag_of("background", current.background),
            logging: flag_of("logging", current.logging),
        };
        if let Err(e) = c.write_all(&[
            ("mcpEnabled", Some(JsonValue::Bool(next.enabled))),
            ("mcpPort", Some(JsonValue::Number(f64::from(next.port)))),
            ("mcpBackground", Some(JsonValue::Bool(next.background))),
            ("mcpLogging", Some(JsonValue::Bool(next.logging))),
        ]) {
            return reply.reply(Err(e));
        }
        let app = c.app.clone();
        c.services.workers.spawn(Box::new(move || {
            reply.reply(Ok(match app.mcp_apply(next) {
                Ok(applied) => IpcValue::Object(mcp_status_ipc(&applied)),
                Err(message) => {
                    let mut with_error = mcp_status_ipc(&app.mcp_status());
                    with_error.push(("error".into(), IpcValue::String(message)));
                    IpcValue::Object(with_error)
                }
            }))
        }));
    })?;
    let c = cx.clone();
    invoke(registry, "home:get-mcp-logs", move |_, _| {
        Ok(IpcValue::Array(
            c.app.mcp_logs().into_iter().map(IpcValue::String).collect(),
        ))
    })?;
    let c = cx.clone();
    invoke(registry, "home:clear-mcp-logs", move |_, _| {
        c.app.mcp_clear_logs();
        Ok(IpcValue::Undefined)
    })?;
    let c = cx.clone();
    invoke(registry, "home:open-mcp-log-file", move |_, _| {
        c.app.mcp_reveal_log_file();
        if let Some(path) = c.app.mcp_log_file() {
            c.os_shell.show_item_in_folder(&path);
        }
        Ok(IpcValue::Undefined)
    })
}

fn default_app(registry: &mut dyn Registry, cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    for (channel, set) in [
        ("home:get-default-app-status", false),
        ("home:set-default-app", true),
    ] {
        let c = cx.clone();
        handle_later(registry, channel, move |_, _, reply| {
            let deps = DefaultAppDeps {
                platform: node_platform().to_owned(),
                packaged: c.app.is_packaged(),
                exe_path: c
                    .services
                    .paths
                    .path(PathName::Exe)
                    .to_string_lossy()
                    .into_owned(),
                registered_app_name: PRODUCT_NAME.to_owned(),
                home_dir: c
                    .services
                    .paths
                    .path(PathName::Home)
                    .to_string_lossy()
                    .into_owned(),
            };
            let os_shell = c.os_shell.clone();
            c.services.workers.spawn(Box::new(move || {
                let mut service = create_default_app_service(deps, Commands(os_shell));
                let status = if set { service.set() } else { service.status() };
                reply.reply(Ok(default_app_ipc(&status)))
            }));
        })?;
    }
    Ok(())
}

fn result_store(registry: &mut dyn Registry, cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    for (channel, delete) in [
        ("home:result-store-size", false),
        ("home:result-store-delete-all", true),
    ] {
        let c = cx.clone();
        handle_later(registry, channel, move |_, _, reply| {
            let user_data = c
                .services
                .paths
                .path(PathName::UserData)
                .to_string_lossy()
                .into_owned();
            let dir = match result_store_dir(&user_data) {
                Ok(dir) => dir,
                Err(e) => return reply.reply(Err(e)),
            };
            c.services.workers.spawn(Box::new(move || {
                reply.reply(if delete {
                    remove_folder(&dir).map(|()| IpcValue::Undefined)
                } else {
                    Ok(IpcValue::Number(folder_size(&dir)))
                })
            }));
        })?;
    }
    Ok(())
}

/// help, the repository, the survey and the notices
fn links(registry: &mut dyn Registry, cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    let c = cx.clone();
    invoke(registry, "home:open-help", move |_, args| {
        // the tab manager keeps only an id-shaped topic; anything else opens as F1
        let topic = match args.first() {
            Some(IpcValue::String(topic)) => Some(topic.as_str()),
            _ => None,
        };
        c.app.open_help(topic);
        Ok(IpcValue::Undefined)
    })?;
    let c = cx.clone();
    invoke(registry, "home:open-github-repo", move |_, _| {
        // no browser handler available: nothing actionable for the user
        let _ = c.os_shell.open_external(GITHUB_REPO_URL);
        Ok(IpcValue::Undefined)
    })?;
    let c = cx.clone();
    invoke(registry, "home:open-license-notices", move |_, _| {
        c.os_shell.open_path(&c.app.third_party_notices_path());
        Ok(IpcValue::Undefined)
    })?;
    let c = cx.clone();
    invoke(registry, "home:open-feedback-survey", move |cx, _| {
        let lang = c.lang();
        let detail = feedback_details(
            lang,
            &FeedbackEnvironment {
                version: c.app.version(),
                os: format!("{} {}", platform_label(node_platform()), c.app.os_release()),
                language: lang.as_str().to_owned(),
            },
        );
        let text = |key: &str| feedback_text(lang, key, None);
        let answer = c.dialogs.message(
            c.focused_window(cx),
            &MessageBox {
                kind: Some("info".into()),
                title: Some(text("dialogTitle")),
                message: text("dialogTitle"),
                detail: Some(format!("{}\n\n{detail}", text("dialogBody"))),
                buttons: vec![text("btnOpen"), text("btnCancel")],
                default_id: Some(0),
                cancel_id: Some(1),
                checkbox_label: None,
            },
        );
        if answer.response == 0 {
            c.clipboard.write_text(&detail);
            // the survey is only offered: a missing browser handler is not reported
            let _ = c.os_shell.open_external(FEEDBACK_SURVEY_URL);
        }
        Ok(IpcValue::Undefined)
    })
}

// ---- the probe ----

/// The fakes of this module for the comparison, answering from the case's
/// `hosts.w.homeApp` (tools/ipc-diff/groups/w/home-settings*.ts):
/// `version`, `osRelease`, `nowMs`, `noticesPath`, `decision` (`{code}`, none
/// for success), `mcpLogFile` (the MCP runtime is configured with a log file
/// when it is there)
#[cfg(feature = "probe")]
mod probe {
    use std::sync::Mutex;

    use super::*;

    pub struct ProbeApp {
        case: serde_json::Value,
        mcp: Mutex<McpSettings>,
    }

    impl ProbeApp {
        pub fn new(case: &serde_json::Value) -> Self {
            let app = ProbeApp {
                case: case["homeApp"].clone(),
                mcp: Mutex::new(McpSettings {
                    enabled: false,
                    port: DEFAULT_MCP_PORT,
                    background: false,
                    logging: false,
                }),
            };
            // the runtime's logger makes its file when the app is ready, keeping nothing of an old run
            // (the comparison's TypeScript puts the case's own lines back)
            if let Some(path) = app.mcp_log_file()
                && !path.exists()
            {
                let _ = fs::write(path, "");
            }
            app
        }

        fn text(&self, key: &str, default: &str) -> String {
            self.case[key].as_str().unwrap_or(default).to_owned()
        }
    }

    impl HomeApp for ProbeApp {
        fn version(&self) -> String {
            self.text("version", "0.13.0")
        }

        fn is_packaged(&self) -> bool {
            false
        }

        fn locale(&self) -> String {
            "ko".into()
        }

        fn os_release(&self) -> String {
            self.text("osRelease", "")
        }

        fn now_ms(&self) -> f64 {
            self.case["nowMs"].as_f64().unwrap_or(1_700_000_000_000.0)
        }

        fn third_party_notices_path(&self) -> PathBuf {
            PathBuf::from(self.text("noticesPath", ""))
        }

        fn open_help(&self, _: Option<&str>) {}

        fn auto_update_check_changed(&self, _: bool) {}

        fn delimited_import_limit_changed(&self, _: f64) {}

        fn home_kinds_changed(&self) {}

        fn folder_watchers_changed(&self) {}

        fn secrets(&self) -> Option<&dyn AiSecretCodec> {
            None
        }

        fn probe_decision(&self, _: &FileSearchSettings) -> Result<(), String> {
            match self.case["decision"]["code"].as_str() {
                Some(code) => Err(code.to_owned()),
                None => Ok(()),
            }
        }

        fn mcp_status(&self) -> McpStatus {
            McpStatus {
                running: false,
                settings: *self.mcp.lock().unwrap(),
                url: None,
                capabilities: vec!["docs".into(), "pdf".into(), "hwp".into()],
            }
        }

        fn mcp_apply(&self, settings: McpSettings) -> Result<McpStatus, String> {
            *self.mcp.lock().unwrap() = settings;
            if settings.enabled {
                // starting needs the runtime the entry module configures once the app is ready
                return Err("MCP runtime not configured".into());
            }
            Ok(self.mcp_status())
        }

        fn mcp_logs(&self) -> Vec<String> {
            let Some(path) = self.mcp_log_file() else {
                return Vec::new();
            };
            let text = fs::read_to_string(path).unwrap_or_default();
            let lines: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
            lines[lines.len().saturating_sub(200)..]
                .iter()
                .map(|l| (*l).to_owned())
                .collect()
        }

        fn mcp_clear_logs(&self) {
            if let Some(path) = self.mcp_log_file()
                && path.exists()
            {
                let _ = fs::write(path, "");
            }
        }

        fn mcp_reveal_log_file(&self) {
            if let Some(path) = self.mcp_log_file()
                && !path.exists()
            {
                let _ = fs::write(path, "");
            }
        }

        fn mcp_log_file(&self) -> Option<PathBuf> {
            self.case["mcpLogFile"].as_str().map(PathBuf::from)
        }
    }
}

#[cfg(feature = "probe")]
pub fn probe_hosts(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    let app: HomeAppHost = Arc::new(probe::ProbeApp::new(case));
    hosts.insert(app);
}
