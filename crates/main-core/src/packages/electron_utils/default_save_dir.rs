//! `packages/electron-utils/src/default-save-dir.ts`: the default folder where
//! new files land on their first save.
//!
//! The process-wide state of the TypeScript (the folders that failed lately,
//! the fallback in use) is a [`SaveDirState`] the caller holds, and
//! `Date.now()` is a parameter (`now_ms`).

use std::collections::HashMap;
use std::fs;

use jscompat::node_path::host::{dirname, is_absolute, join, resolve};
use jscompat::{JsonValue, json_parse};

use crate::node_fs::{NodeError, node_error};
use crate::packages::i18n::PRODUCT_NAME;

/// `DEFAULT_SAVE_DIR_KEY`
pub const DEFAULT_SAVE_DIR_KEY: &str = "defaultSaveDir";

/// `UNUSABLE_RETRY_MS`
const UNUSABLE_RETRY_MS: f64 = 30_000.0;

/// What an `Error` the TypeScript throws says (`error.message`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thrown(pub String);

/// `PathProvider`: `app.getPath(name)` for `userData`, `documents` and
/// `home`. `Err` is what Electron throws when the OS cannot report a folder.
pub trait PathProvider {
    fn get_path(&self, name: &str) -> Result<String, Thrown>;
}

/// `SaveDirState.fallback`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveDirFallback {
    pub blocked: String,
    pub using: String,
}

/// `SaveDirState`
#[derive(Debug, Default)]
pub struct SaveDirState {
    unusable_until: HashMap<String, f64>,
    fallback: Option<SaveDirFallback>,
}

impl SaveDirState {
    pub fn new() -> Self {
        Self::default()
    }
}

/// `readDefaultSaveDirSetting(settingsPath)`
pub fn read_default_save_dir_setting(settings_path: &str) -> Option<String> {
    let bytes = fs::read(settings_path).ok()?;
    let raw = json_parse(&String::from_utf8_lossy(&bytes)).ok()?;
    let JsonValue::Object(raw) = raw else {
        return None;
    };
    match raw.get(DEFAULT_SAVE_DIR_KEY) {
        Some(JsonValue::String(value)) if is_absolute(value) => Some(value.clone()),
        _ => None,
    }
}

fn is_directory(dir: &str) -> bool {
    fs::metadata(dir).is_ok_and(|m| m.is_dir())
}

/// `createDirLevels(dir)`
pub fn create_dir_levels(dir: &str) -> Result<(), NodeError> {
    let mut missing: Vec<String> = Vec::new();
    let mut current = resolve(&[dir]);
    while !is_directory(&current) {
        missing.push(current.clone());
        let parent = dirname(&current);
        if parent == current {
            break;
        }
        current = parent;
    }
    for level in missing.iter().rev() {
        fs::create_dir(level).map_err(|e| node_error(&e, "mkdir", level))?;
    }
    Ok(())
}

/// `accessSync(dir, constants.W_OK)` as a yes or no
#[cfg(unix)]
fn writable(dir: &str) -> bool {
    match std::ffi::CString::new(dir) {
        // SAFETY: `c_path` is a valid NUL-terminated string for the call
        Ok(c_path) => unsafe { libc::access(c_path.as_ptr(), libc::W_OK) == 0 },
        Err(_) => false,
    }
}

/// libuv refuses write access only to a read-only file, never to a folder
#[cfg(windows)]
fn writable(dir: &str) -> bool {
    fs::metadata(dir).is_ok_and(|m| m.is_dir() || !m.permissions().readonly())
}

/// `isUsableSaveDir(dir)`
pub fn is_usable_save_dir(dir: &str) -> bool {
    if !is_directory(dir) && create_dir_levels(dir).is_err() {
        return false;
    }
    writable(dir)
}

/// `usableNow(dir)`
fn usable_now(state: &mut SaveDirState, dir: &str, now_ms: f64) -> bool {
    let key = resolve(&[dir]);
    if let Some(until) = state.unusable_until.get(&key)
        && now_ms < *until
    {
        return false;
    }
    if is_usable_save_dir(dir) {
        state.unusable_until.remove(&key);
        return true;
    }
    state.unusable_until.insert(key, now_ms + UNUSABLE_RETRY_MS);
    false
}

/// `resolveDefaultSaveDir(configured, fallbackDir)`
pub fn resolve_default_save_dir(
    state: &mut SaveDirState,
    configured: Option<&str>,
    fallbacks: &[String],
    now_ms: f64,
) -> Result<String, Thrown> {
    if let Some(configured) = configured.filter(|c| !c.is_empty())
        && usable_now(state, configured, now_ms)
    {
        state.fallback = None;
        return Ok(configured.to_owned());
    }
    let first = fallbacks.first();
    for dir in fallbacks {
        if !usable_now(state, dir, now_ms) {
            continue;
        }
        state.fallback = if first.is_none() || Some(dir) == first {
            None
        } else {
            Some(SaveDirFallback {
                blocked: first.cloned().unwrap_or_default(),
                using: dir.clone(),
            })
        };
        return Ok(dir.clone());
    }
    Err(Thrown(format!(
        "default save dir not usable: {}",
        fallbacks.join(", ")
    )))
}

/// `defaultSaveDirFallback()`
pub fn default_save_dir_fallback(state: &SaveDirState) -> Option<SaveDirFallback> {
    state.fallback.clone()
}

/// `pathOrNull(app, name)`
fn path_or_null(app: &dyn PathProvider, name: &str) -> Option<String> {
    app.get_path(name).ok().filter(|path| !path.is_empty())
}

/// `documentsDirOrFallback(app)`
pub fn documents_dir_or_fallback(app: &dyn PathProvider) -> Result<String, Thrown> {
    if let Some(documents) = path_or_null(app, "documents") {
        return Ok(documents);
    }
    if let Some(home) = path_or_null(app, "home") {
        return Ok(home);
    }
    app.get_path("userData")
}

/// `configuredDefaultSaveDir(app)`
pub fn configured_default_save_dir(
    app: &dyn PathProvider,
    state: &mut SaveDirState,
    now_ms: f64,
) -> Result<String, Thrown> {
    let settings_path = join(&[&app.get_path("userData")?, "app-settings.json"]);
    let documents = path_or_null(app, "documents");
    let home = path_or_null(app, "home");
    let mut fallbacks = Vec::new();
    if let Some(documents) = documents {
        fallbacks.push(join(&[&documents, PRODUCT_NAME]));
    }
    if let Some(home) = home {
        fallbacks.push(join(&[&home, PRODUCT_NAME]));
    }
    fallbacks.push(join(&[&app.get_path("userData")?, PRODUCT_NAME]));
    let configured = read_default_save_dir_setting(&settings_path);
    resolve_default_save_dir(state, configured.as_deref(), &fallbacks, now_ms)
}
