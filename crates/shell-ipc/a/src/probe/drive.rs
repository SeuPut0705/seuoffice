//! The probe fakes of the `drive` port's batch hosts: the Drive connection of
//! `packages/google-drive` ([`DriveClient`]) and the shell entry's tabs and
//! parser ([`DriveShell`]), scripted by the case's `hosts.a.drive` (the
//! TypeScript half is tools/ipc-diff/groups/a/drive.ts, which reads the same
//! value and logs the same lines).
//!
//! `hosts.a.dir` is the case's folder (`$DIR`); `hosts.a.lang` the UI language
//! (`ko` by default). `hosts.a.drive` absent means a build without a Google
//! client: Drive is `unavailable` and nothing starts. Present:
//!
//! - `unavailable`: no Google client either
//! - `safeStorage`: `{available, backend, failEncrypt, failDecrypt}`; none is
//!   available by default, so no token is written. The cipher is a reversible
//!   byte transform (XOR 0x5a).
//! - `token` (`refresh-1`), `account` (`{displayName, emailAddress}`; without
//!   it Drive does not tell who is connected)
//! - `connects`, `picks`, `authUrls`: what each browser round gives, in order.
//!   A connect is `"ok"` or a failure name; a pick is a list of file ids or a
//!   failure name; the address Google's page is opened at.
//! - `files`: `{<id>: {name, mime, modified, size, md5, parents, canEdit,
//!   shortcut: {id, mime}, text | hex, fileError, downloadError, exportError}}`
//! - `lists`, `uploads`: one answer per `list` / `upload` call, in order:
//!   `{files: [spec], next}` or `{error: kind}`; `{error: kind}` or success
//! - `expireOnApi`: Google ends the grant at the first Drive call
//! - `parse`: `{<file name>: {ok, kind, text}}`; by default the file's text
//! - `openFiles`: the paths tabs show; `openPath`: false when a tab cannot open
//! - `step`, `now`: the clock (`Date.now()`) starts at `now` and moves `step`
//!   milliseconds at each Drive call, so no case depends on wall time
//!
//! The host log gets one line per call, named after the TypeScript call it
//! stands for.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, ThreadId};
use std::time::Duration;

use jscompat::{JsonValue, json_parse, trim};
use main_core::packages::ai_provider::legacy_settings::normalize_ai_settings;
use main_core::packages::ai_provider::settings_secrets::CodecThrow;
use main_core::packages::i18n::Lang;
use main_core::shell::ai_secrets::SafeStorageLike;
use serde_json::{Value, json};

use super::{Log, push};
use crate::drive::client::{
    BrowserRound, ConnectionState, DriveAccount, DriveClient, DriveClientHost, DriveError,
    DriveFile, DriveResult, ListPage, Listing, OpenPlan, ShortcutTarget, SignInFailure, SignInPage,
    UploadTarget,
};
use crate::drive::files::FilesConfig;
use crate::drive::host::{DriveShell, DriveShellHost, ParsedText, StopWatch};
use crate::drive::vault::{DriveVault, SafeStorageCipher, create_drive_vault};

const DEFAULT_NOW: u64 = 1_700_000_000_000;
const DEFAULT_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth?client_id=test";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

// ---- packages/google-drive/src/formats.ts ----

const DOCX_MIME: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME: &str = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const OPENABLE_EXTENSIONS: [&str; 19] = [
    ".docx",
    ".xlsx",
    ".xlsm",
    ".xls",
    ".csv",
    ".tsv",
    ".pptx",
    ".pdf",
    ".md",
    ".markdown",
    ".txt",
    ".json",
    ".html",
    ".htm",
    ".xmind",
    ".hwp",
    ".hwpx",
    ".epub",
    ".drawio",
];

/// `isGoogleNative(mimeType)`
fn is_google_native(mime_type: &str) -> bool {
    mime_type.starts_with("application/vnd.google-apps.")
}

/// `extensionOf(name)`
fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => name[dot..].to_lowercase(),
        _ => String::new(),
    }
}

/// `openPlan({ name, mimeType })`
fn open_plan(name: &str, mime_type: &str) -> OpenPlan {
    let exported = match mime_type {
        "application/vnd.google-apps.document" => Some((DOCX_MIME, ".docx")),
        "application/vnd.google-apps.spreadsheet" => Some((XLSX_MIME, ".xlsx")),
        "application/vnd.google-apps.presentation" => Some((PPTX_MIME, ".pptx")),
        _ => None,
    };
    if let Some((mime, extension)) = exported {
        return OpenPlan::Export {
            mime: mime.into(),
            extension: extension.into(),
        };
    }
    if is_google_native(mime_type) {
        return OpenPlan::None;
    }
    let extension = extension_of(name);
    if OPENABLE_EXTENSIONS.contains(&extension.as_str()) {
        OpenPlan::Download { extension }
    } else {
        OpenPlan::None
    }
}

/// `uploadMime(name)`
fn upload_mime(name: &str) -> String {
    match extension_of(name).as_str() {
        ".docx" => DOCX_MIME,
        ".xlsx" => XLSX_MIME,
        ".pptx" => PPTX_MIME,
        ".pdf" => "application/pdf",
        ".md" | ".markdown" => "text/markdown",
        ".txt" => "text/plain",
        ".csv" => "text/csv",
        ".html" | ".htm" => "text/html",
        _ => "application/octet-stream",
    }
    .into()
}

fn utf16_prefix(text: &str, units: usize) -> String {
    let all: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16_lossy(&all[..units.min(all.len())])
}

/// `localFileName(driveName, extension)`
fn local_file_name(drive_name: &str, extension: &str) -> String {
    let replaced: String = drive_name
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = trim(replaced.trim_end_matches(['.', ' '])).to_owned();
    let base = if extension_of(&cleaned) == extension {
        &cleaned[..cleaned.len() - extension.len()]
    } else {
        &cleaned
    };
    let lower = base.to_lowercase();
    let reserved = matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
        || ["com", "lpt"].iter().any(|p| {
            lower.len() == 4 && lower.starts_with(p) && lower.as_bytes()[3].is_ascii_digit()
        });
    let named = if reserved {
        format!("_{base}")
    } else {
        base.to_owned()
    };
    let safe = utf16_prefix(&named, 120);
    let safe = if safe.is_empty() {
        "document".to_owned()
    } else {
        safe
    };
    format!("{safe}{extension}")
}

/// `officeCopyName(driveName, extension)`
fn office_copy_name(drive_name: &str, extension: &str) -> String {
    if extension_of(drive_name) == extension {
        drive_name.to_owned()
    } else {
        format!("{drive_name}{extension}")
    }
}

// ---- safeStorage ----

/// Electron's `safeStorage` over a reversible byte transform; not available
/// unless the case says so
struct FakeSafeStorage {
    available: bool,
    backend: String,
    fail_encrypt: bool,
    fail_decrypt: bool,
}

impl FakeSafeStorage {
    fn new(case: &Value) -> Self {
        FakeSafeStorage {
            available: case["available"].as_bool().unwrap_or(false),
            backend: case["backend"]
                .as_str()
                .unwrap_or("gnome_libsecret")
                .to_owned(),
            fail_encrypt: case["failEncrypt"].as_bool().unwrap_or(false),
            fail_decrypt: case["failDecrypt"].as_bool().unwrap_or(false),
        }
    }
}

impl SafeStorageLike for FakeSafeStorage {
    fn is_encryption_available(&self) -> bool {
        self.available
    }

    fn encrypt_string(&self, plain: &str) -> Result<Vec<u8>, CodecThrow> {
        if self.fail_encrypt {
            return Err(CodecThrow("encrypt failed".into()));
        }
        Ok(plain.bytes().map(|b| b ^ 0x5a).collect())
    }

    fn decrypt_string(&self, sealed: &[u8]) -> Result<String, CodecThrow> {
        if self.fail_decrypt {
            return Err(CodecThrow("decrypt failed".into()));
        }
        let plain: Vec<u8> = sealed.iter().map(|b| b ^ 0x5a).collect();
        Ok(String::from_utf8_lossy(&plain).into_owned())
    }

    fn get_selected_storage_backend(&self) -> Option<String> {
        Some(self.backend.clone())
    }
}

/// `process.platform`
fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}

// ---- the Drive connection ----

fn failure_of(name: &str) -> SignInFailure {
    match name {
        "cancelled" => SignInFailure::Cancelled,
        "timeout" => SignInFailure::Timeout,
        "denied" => SignInFailure::Denied,
        "scope" => SignInFailure::Scope,
        "unavailable" => SignInFailure::Unavailable,
        _ => SignInFailure::Network,
    }
}

fn error_of(kind: &str) -> DriveError {
    match kind {
        "not-connected" => DriveError::NotConnected,
        "not-found" => DriveError::NotFound,
        "forbidden" => DriveError::Forbidden,
        "too-large" => DriveError::TooLarge,
        "rate-limit" => DriveError::RateLimit,
        _ => DriveError::Network,
    }
}

fn md5_of(bytes: &[u8]) -> String {
    format!(
        "md5-{}-{}",
        bytes.len(),
        bytes.iter().map(|b| *b as u64).sum::<u64>()
    )
}

/// A `files` / `lists` entry as `DriveFile`
fn file_of(spec: &Value) -> DriveFile {
    let text = |key: &str| spec[key].as_str().unwrap_or("").to_owned();
    DriveFile {
        id: text("id"),
        name: text("name"),
        mime_type: text("mime"),
        modified_time: text("modified"),
        size: spec["size"].as_u64(),
        md5_checksum: spec["md5"].as_str().map(str::to_owned),
        parents: spec["parents"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|p| p.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        can_edit: spec["canEdit"].as_bool().unwrap_or(true),
        shortcut_target: spec["shortcut"].is_object().then(|| ShortcutTarget {
            id: spec["shortcut"]["id"].as_str().unwrap_or("").to_owned(),
            mime_type: spec["shortcut"]["mime"].as_str().unwrap_or("").to_owned(),
        }),
    }
}

fn bytes_of(spec: &Value) -> Vec<u8> {
    if let Some(h) = spec["hex"].as_str() {
        unhex(h)
    } else {
        spec["text"].as_str().unwrap_or("").as_bytes().to_vec()
    }
}

#[derive(Default)]
struct Conn {
    refresh: Option<String>,
    account: Option<DriveAccount>,
    persisted: bool,
    expired: bool,
}

#[derive(Default)]
struct Script {
    connects: VecDeque<Value>,
    picks: VecDeque<Value>,
    auth_urls: VecDeque<Value>,
    lists: VecDeque<Value>,
    uploads: VecDeque<Value>,
    upload_calls: u64,
    new_files: u64,
}

fn queue(world: &Value, key: &str) -> VecDeque<Value> {
    world[key].as_array().cloned().unwrap_or_default().into()
}

struct FakeDrive {
    world: Value,
    log: Option<Log>,
    clock: Arc<AtomicU64>,
    step: u64,
    client: bool,
    vault: DriveVault,
    conn: Mutex<Conn>,
    script: Mutex<Script>,
    files: Mutex<HashMap<String, (DriveFile, Vec<u8>)>>,
    listeners: Mutex<Vec<Arc<dyn Fn() + Send + Sync>>>,
    expired_once: AtomicBool,
    /// `connection.load()` has finished; what asks for the state waits for it
    /// (the TypeScript's case waits for it before its first call)
    loaded: (Mutex<bool>, Condvar),
    loading: Mutex<Option<ThreadId>>,
}

impl FakeDrive {
    fn new(world: &Value, dir: &Path, log: Option<Log>, clock: Arc<AtomicU64>) -> FakeDrive {
        let storage = FakeSafeStorage::new(&world["safeStorage"]);
        let cipher = SafeStorageCipher::new(Arc::new(storage), platform());
        let files = world["files"]
            .as_object()
            .map(|files| {
                files
                    .iter()
                    .map(|(id, spec)| {
                        let mut file = file_of(spec);
                        file.id = id.clone();
                        (id.clone(), (file, bytes_of(spec)))
                    })
                    .collect()
            })
            .unwrap_or_default();
        FakeDrive {
            world: world.clone(),
            log,
            clock,
            step: world["step"].as_u64().unwrap_or(0),
            client: world.is_object() && world["unavailable"].as_bool() != Some(true),
            vault: create_drive_vault(
                dir.join("userData").join("google-drive.json"),
                Arc::new(cipher),
            ),
            conn: Mutex::default(),
            script: Mutex::new(Script {
                connects: queue(world, "connects"),
                picks: queue(world, "picks"),
                auth_urls: queue(world, "authUrls"),
                lists: queue(world, "lists"),
                uploads: queue(world, "uploads"),
                ..Script::default()
            }),
            files: Mutex::new(files),
            listeners: Mutex::default(),
            expired_once: AtomicBool::new(false),
            loaded: (Mutex::new(false), Condvar::new()),
            loading: Mutex::new(None),
        }
    }

    /// Waits for `load` unless this is the thread running it
    fn wait_loaded(&self) {
        if *self.loading.lock().unwrap() == Some(thread::current().id()) {
            return;
        }
        let (done, wake) = &self.loaded;
        let mut done = done.lock().unwrap();
        let mut waited = 0;
        while !*done && waited < 100 {
            done = wake
                .wait_timeout(done, Duration::from_millis(100))
                .unwrap()
                .0;
            waited += 1;
        }
    }

    fn emit(&self) {
        let listeners = self.listeners.lock().unwrap().clone();
        for listener in listeners {
            listener();
        }
    }

    /// `forget(expired)`
    fn forget(&self, expired: bool) {
        *self.conn.lock().unwrap() = Conn {
            expired,
            ..Conn::default()
        };
        self.emit();
    }

    fn account(&self) -> Option<DriveAccount> {
        self.world["account"].is_object().then(|| DriveAccount {
            display_name: self.world["account"]["displayName"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
            email_address: self.world["account"]["emailAddress"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
        })
    }

    /// `fetchAccount()`
    fn fetch_account(&self) {
        let Some(account) = self.account() else {
            return;
        };
        {
            let mut conn = self.conn.lock().unwrap();
            if conn.refresh.is_none() {
                return;
            }
            conn.account = Some(account);
        }
        self.emit();
    }

    /// What every Drive call starts with: its log line, the clock, and the
    /// connection it needs
    fn api(&self, line: Value) -> DriveResult<()> {
        push(&self.log, line);
        self.clock.fetch_add(self.step, Ordering::SeqCst);
        if self.conn.lock().unwrap().refresh.is_none() {
            return Err(DriveError::NotConnected);
        }
        if self.world["expireOnApi"].as_bool() == Some(true)
            && !self.expired_once.swap(true, Ordering::SeqCst)
        {
            self.forget(true);
            self.vault.clear();
            return Err(DriveError::NotConnected);
        }
        Ok(())
    }

    /// `signInOnce(options)`
    fn sign_in(
        &self,
        round: &BrowserRound,
        pick: Option<bool>,
    ) -> Result<Vec<String>, SignInFailure> {
        if !self.client {
            return Err(SignInFailure::Unavailable);
        }
        let (url, outcome) = {
            let mut script = self.script.lock().unwrap();
            let url = script
                .auth_urls
                .pop_front()
                .and_then(|u| u.as_str().map(str::to_owned))
                .unwrap_or_else(|| DEFAULT_AUTH_URL.to_owned());
            let outcome = match pick {
                Some(_) => script.picks.pop_front(),
                None => script.connects.pop_front(),
            };
            (url, outcome)
        };
        if !(round.open_browser)(&url) {
            return Err(SignInFailure::Network);
        }
        let picked = match (&outcome, pick) {
            (Some(Value::String(name)), _) if name != "ok" => {
                return Err(failure_of(name));
            }
            (Some(Value::Array(ids)), Some(_)) => ids
                .iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect(),
            _ => Vec::new(),
        };
        let token = self.world["token"]
            .as_str()
            .unwrap_or("refresh-1")
            .to_owned();
        let kept = {
            let conn = self.conn.lock().unwrap();
            if conn.refresh.is_some() {
                conn.account.clone()
            } else {
                None
            }
        };
        // `adopt(tokens)`
        let persisted = self.vault.save(&token);
        {
            let mut conn = self.conn.lock().unwrap();
            conn.refresh = Some(token);
            conn.account = None;
            conn.expired = false;
            conn.persisted = persisted;
            if let Some(account) = &kept {
                conn.account = Some(account.clone());
            }
        }
        if !persisted {
            self.vault.clear();
        }
        self.emit();
        if kept.is_none() {
            self.fetch_account();
        }
        Ok(picked)
    }
}

fn pages_json(round: &BrowserRound) -> Value {
    let page = |p: &SignInPage| json!({"lang": p.lang, "title": p.title, "body": p.body});
    json!({"done": page(&round.done), "failed": page(&round.failed)})
}

impl DriveClient for FakeDrive {
    fn state(&self) -> ConnectionState {
        self.wait_loaded();
        if !self.client {
            return ConnectionState::Unavailable;
        }
        let conn = self.conn.lock().unwrap();
        if conn.refresh.is_none() {
            return ConnectionState::Disconnected {
                expired: conn.expired,
            };
        }
        ConnectionState::Connected {
            account: conn.account.clone(),
            persisted: conn.persisted,
        }
    }

    fn connected(&self) -> bool {
        self.wait_loaded();
        self.client && self.conn.lock().unwrap().refresh.is_some()
    }

    fn load(&self) {
        *self.loading.lock().unwrap() = Some(thread::current().id());
        if self.client {
            if let Some(token) = self.vault.load() {
                let adopted = {
                    let mut conn = self.conn.lock().unwrap();
                    if conn.refresh.is_none() {
                        conn.refresh = Some(token);
                        conn.persisted = true;
                        true
                    } else {
                        false
                    }
                };
                if adopted {
                    self.emit();
                    self.fetch_account();
                }
            }
        }
        *self.loading.lock().unwrap() = None;
        let (done, wake) = &self.loaded;
        *done.lock().unwrap() = true;
        wake.notify_all();
    }

    fn on_change(&self, listener: Arc<dyn Fn() + Send + Sync>) {
        self.listeners.lock().unwrap().push(listener);
    }

    fn connect(&self, round: &BrowserRound) -> Result<(), SignInFailure> {
        push(&self.log, json!(["connection.connect", pages_json(round)]));
        self.sign_in(round, None).map(|_| ())
    }

    fn pick(&self, round: &BrowserRound, multiple: bool) -> Result<Vec<String>, SignInFailure> {
        push(
            &self.log,
            json!(["connection.pick", pages_json(round), multiple]),
        );
        self.sign_in(round, Some(multiple))
    }

    fn cancel_connect(&self) {
        push(&self.log, json!(["connection.cancelConnect"]));
    }

    fn disconnect(&self) {
        push(&self.log, json!(["connection.disconnect"]));
        self.forget(false);
        self.vault.clear();
    }

    fn list(
        &self,
        listing: &Listing,
        page_token: Option<&str>,
        page_size: Option<u32>,
    ) -> DriveResult<ListPage> {
        let listing = match listing {
            Listing::Recent => json!({"kind": "recent"}),
            Listing::Search(text) => json!({"kind": "search", "text": text}),
        };
        let mut options = serde_json::Map::new();
        if let Some(token) = page_token {
            options.insert("pageToken".into(), json!(token));
        }
        if let Some(size) = page_size {
            options.insert("pageSize".into(), json!(size));
        }
        self.api(json!(["api.list", listing, options]))?;
        let answer = self.script.lock().unwrap().lists.pop_front();
        let Some(answer) = answer else {
            return Ok(ListPage::default());
        };
        if let Some(kind) = answer["error"].as_str() {
            return Err(error_of(kind));
        }
        Ok(ListPage {
            files: answer["files"]
                .as_array()
                .map(|files| files.iter().map(file_of).collect())
                .unwrap_or_default(),
            next_page_token: answer["next"].as_str().map(str::to_owned),
        })
    }

    fn file(&self, id: &str) -> DriveResult<DriveFile> {
        self.api(json!(["api.file", id]))?;
        let found = self.files.lock().unwrap().get(id).map(|(f, _)| f.clone());
        if let Some(kind) = self.world["files"][id]["fileError"].as_str() {
            return Err(error_of(kind));
        }
        found.ok_or(DriveError::NotFound)
    }

    fn download(&self, id: &str, max_bytes: usize) -> DriveResult<Vec<u8>> {
        self.api(json!(["api.download", id, max_bytes]))?;
        self.bytes(id, max_bytes, "downloadError")
    }

    fn export(&self, id: &str, mime: &str, max_bytes: usize) -> DriveResult<Vec<u8>> {
        self.api(json!(["api.export", id, mime, max_bytes]))?;
        self.bytes(id, max_bytes, "exportError")
    }

    fn upload(&self, target: &UploadTarget, bytes: &[u8], mime: &str) -> DriveResult<DriveFile> {
        let target_json = match target {
            UploadTarget::Existing(id) => json!({"existingId": id}),
            UploadTarget::New { name, parent_id } => match parent_id {
                Some(parent) => json!({"name": name, "parentId": parent}),
                None => json!({"name": name}),
            },
        };
        self.api(json!(["api.upload", target_json, hex(bytes), mime]))?;
        let (call, made, answer) = {
            let mut script = self.script.lock().unwrap();
            script.upload_calls += 1;
            let call = script.upload_calls;
            let answer = script.uploads.pop_front();
            let failed = answer.as_ref().and_then(|a| a["error"].as_str()).is_some();
            let made = if matches!(target, UploadTarget::New { .. }) && !failed {
                script.new_files += 1;
                script.new_files
            } else {
                0
            };
            (call, made, answer)
        };
        if let Some(kind) = answer.as_ref().and_then(|a| a["error"].as_str()) {
            return Err(error_of(kind));
        }
        let modified = format!("2026-02-01T00:00:{call:02}Z");
        let mut files = self.files.lock().unwrap();
        match target {
            UploadTarget::Existing(id) => {
                let (file, content) = files.get_mut(id).ok_or(DriveError::NotFound)?;
                *content = bytes.to_vec();
                file.md5_checksum = Some(md5_of(bytes));
                file.size = Some(bytes.len() as u64);
                file.modified_time = modified;
                Ok(file.clone())
            }
            UploadTarget::New { name, parent_id } => {
                let file = DriveFile {
                    id: format!("made-{made}"),
                    name: name.clone(),
                    mime_type: mime.to_owned(),
                    modified_time: modified,
                    size: Some(bytes.len() as u64),
                    md5_checksum: Some(md5_of(bytes)),
                    parents: parent_id.iter().cloned().collect(),
                    can_edit: true,
                    shortcut_target: None,
                };
                files.insert(file.id.clone(), (file.clone(), bytes.to_vec()));
                Ok(file)
            }
        }
    }

    fn open_plan(&self, name: &str, mime_type: &str) -> OpenPlan {
        open_plan(name, mime_type)
    }

    fn is_google_native(&self, mime_type: &str) -> bool {
        is_google_native(mime_type)
    }

    fn local_file_name(&self, drive_name: &str, extension: &str) -> String {
        local_file_name(drive_name, extension)
    }

    fn office_copy_name(&self, drive_name: &str, extension: &str) -> String {
        office_copy_name(drive_name, extension)
    }

    fn upload_mime(&self, name: &str) -> String {
        upload_mime(name)
    }
}

impl FakeDrive {
    fn bytes(&self, id: &str, max_bytes: usize, error_key: &str) -> DriveResult<Vec<u8>> {
        let bytes = self.files.lock().unwrap().get(id).map(|(_, b)| b.clone());
        let bytes = bytes.ok_or(DriveError::NotFound)?;
        if let Some(kind) = self.world["files"][id][error_key].as_str() {
            return Err(error_of(kind));
        }
        if bytes.len() > max_bytes {
            return Err(DriveError::TooLarge);
        }
        Ok(bytes)
    }
}

// ---- the shell entry ----

struct FakeShell {
    world: Value,
    dir: PathBuf,
    lang: Lang,
    log: Option<Log>,
}

impl DriveShell for FakeShell {
    fn lang(&self) -> Lang {
        self.lang
    }

    fn open_path(&self, path: &str) -> bool {
        push(&self.log, json!(["routeDocumentPath", path]));
        self.world["openPath"].as_bool() != Some(false)
    }

    fn is_open(&self, path: &str) -> bool {
        self.world["openFiles"].as_array().is_some_and(|open| {
            open.iter()
                .filter_map(Value::as_str)
                .any(|o| o.to_lowercase() == path.to_lowercase())
        })
    }

    /// `readStoredAiSettings()`
    fn stored_ai_settings(&self) -> JsonValue {
        let stored = std::fs::read(self.dir.join("userData").join("ai-settings.json"))
            .ok()
            .and_then(|bytes| json_parse(&String::from_utf8_lossy(&bytes)).ok());
        normalize_ai_settings(None, stored.as_ref(), None)
    }

    fn document_of(&self, _web_contents_id: f64) -> Option<String> {
        None
    }

    fn parse_file_to_text(&self, path: &Path) -> ParsedText {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let bytes = std::fs::read(path).unwrap_or_default();
        push(&self.log, json!(["parseFileToText", name, hex(&bytes)]));
        let given = &self.world["parse"][name.as_str()];
        if given.is_object() {
            return ParsedText {
                ok: given["ok"].as_bool().unwrap_or(false),
                kind: given["kind"].as_str().map(str::to_owned),
                text: given["text"].as_str().map(str::to_owned),
            };
        }
        ParsedText {
            ok: true,
            kind: Some("text".into()),
            text: Some(String::from_utf8_lossy(&bytes).into_owned()),
        }
    }

    /// The watcher never reports: a save is not something a case waits for
    fn watch(&self, _dir: &Path, _on_change: Arc<dyn Fn(&Path) + Send + Sync>) -> StopWatch {
        Box::new(|| {})
    }
}

/// Inserts this port's factory and the fakes of its hosts, answering from
/// the case's `hosts.a` value; `log` is the case's host log
pub fn insert(hosts: &mut shell_contract::Hosts, case: &serde_json::Value, log: Option<Log>) {
    let world = &case["drive"];
    let dir = PathBuf::from(case["dir"].as_str().unwrap_or("."));
    let clock = Arc::new(AtomicU64::new(world["now"].as_u64().unwrap_or(DEFAULT_NOW)));
    let now = clock.clone();
    let config = FilesConfig {
        now: Arc::new(move || now.load(Ordering::SeqCst)),
        ..FilesConfig::default()
    };
    // the folders of downloaded attachments are counted, as the TypeScript's
    // stand-in for `randomBytes` counts them
    crate::drive::attach::COUNTED_FOLDERS.store(0, Ordering::SeqCst);
    hosts.insert(crate::drive::factory_with(config));
    hosts.insert::<DriveClientHost>(Arc::new(FakeDrive::new(world, &dir, log.clone(), clock)));
    hosts.insert::<DriveShellHost>(Arc::new(FakeShell {
        world: world.clone(),
        dir,
        lang: super::case_lang(case),
        log,
    }));
}
