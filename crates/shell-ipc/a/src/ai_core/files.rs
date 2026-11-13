//! `ai-settings.json` as docs-main reads and writes it (`readJson`,
//! `storedAiSettings`, `writeAiSettingsFile`, `broadcastAiSettingsChanged`):
//! keys and tokens go to disk sealed with the shell's codec, and fields a
//! newer build wrote stay as they are.

use std::path::PathBuf;
use std::sync::Arc;

use jscompat::{JsonValue, json_parse};
use main_core::node_fs::NodeError;
use main_core::packages::ai_provider::ai_settings_guard::GuardHost;
use main_core::packages::ai_provider::jsval::{Obj, text};
use main_core::packages::ai_provider::legacy_settings::normalize_ai_settings;
use main_core::packages::ai_provider::providers::{
    default_ai_settings, resolve_ai_settings, with_migrated_subscription_notice_version,
};
use main_core::packages::ai_provider::settings_secrets::{AiSecretCodec, seal_ai_secrets};
use main_core::packages::ai_provider::stored_settings::with_stored_unknown_fields;
use main_core::packages::ai_provider::task::JsError;
use main_core::packages::electron_utils::atomic_write::write_json_atomic;
use shell_contract::ipc::{EventSink, Target};
use shell_contract::runtime::{AppPaths, PathName};

use super::host::AiCoreHostHandle;
use crate::ai_naming::Codec;

const SETTINGS_CHANGED: &str = "ai:settings-changed";

/// What `sanitizeAiSettings` checks a path against: the home folder and the
/// files on disk
pub struct FsGuard {
    pub home: String,
}

impl GuardHost for FsGuard {
    fn home_dir(&self) -> String {
        self.home.clone()
    }

    fn is_file(&self, path: &str) -> bool {
        std::path::Path::new(path).is_file()
    }
}

/// The error a failed write throws: Node's message, with its code
pub fn node_error(error: NodeError) -> JsError {
    let thrown = JsError::error(error.message);
    match error.code {
        Some(code) => thrown.with("code", text(code)),
        None => thrown,
    }
}

pub struct Files {
    path: PathBuf,
    codec: Codec,
    host: AiCoreHostHandle,
    events: Arc<dyn EventSink>,
    pub guard: FsGuard,
}

impl Files {
    pub fn new(
        paths: &dyn AppPaths,
        events: Arc<dyn EventSink>,
        codec: Codec,
        host: AiCoreHostHandle,
    ) -> Files {
        Files {
            path: paths.path(PathName::UserData).join("ai-settings.json"),
            codec,
            host,
            events,
            guard: FsGuard {
                home: paths.path(PathName::Home).to_string_lossy().into_owned(),
            },
        }
    }

    /// `SETTINGS_PATH()`
    pub fn path(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    pub fn codec(&self) -> &dyn AiSecretCodec {
        &*self.codec
    }

    /// The codec, for a worker that opens the keys itself
    pub fn codec_handle(&self) -> Codec {
        self.codec.clone()
    }

    /// `readJson(SETTINGS_PATH(), {})`: a missing or damaged file is `{}`
    fn read_json(&self) -> JsonValue {
        let parsed = std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| json_parse(&String::from_utf8_lossy(&bytes)).ok());
        parsed.unwrap_or_else(|| JsonValue::Object(Obj::new()))
    }

    /// `storedAiSettings()`: the file as every reader gets it: a file written
    /// before the notice carried a version is migrated on disk, removed and
    /// unknown selections read as their defaults
    pub fn stored(&self) -> Result<JsonValue, JsError> {
        let raw = self.read_json();
        let raw = match with_migrated_subscription_notice_version(&raw) {
            Some(next) => {
                self.write(&next)?;
                next
            }
            None => raw,
        };
        Ok(normalize_ai_settings(Some(self.codec()), Some(&raw), None))
    }

    /// `readAiSettingsFile(SETTINGS_PATH())` of `@seuoffice/ai-search`: the
    /// settings merged over the defaults, keys opened, nothing normalized
    pub fn resolved(&self) -> JsonValue {
        let stored = self.read_json();
        resolve_ai_settings(
            Some(self.codec()),
            Some(&stored),
            &mut default_ai_settings(None),
        )
    }

    /// `writeAiSettingsFile(settings)`
    pub fn write(&self, settings: &JsonValue) -> Result<(), JsError> {
        if self.host.is_headless_mode() {
            return Ok(());
        }
        let stored = self.read_json();
        let merged = with_stored_unknown_fields(settings, &stored);
        write_json_atomic(&self.path(), &seal_ai_secrets(Some(self.codec()), &merged))
            .map_err(node_error)
    }

    /// `broadcastAiSettingsChanged()`: every renderer re-reads the file
    pub fn broadcast(&self) {
        self.events.emit(Target::All, SETTINGS_CHANGED, Vec::new());
    }
}
