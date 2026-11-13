//! `apps/shell/src/main/drive/drive-files.ts`: Drive files on this PC
//! (decision 0033). A Drive file opens as a local copy in the data folder's
//! `drive-cache`, any editor saves it like a normal file, and a watcher on
//! that folder uploads each save back to Drive.
//!
//! - The watcher is the one place that learns of saves, so no editor needs to
//!   know about Drive: every editor writes the file by path.
//! - Before replacing a Drive file the service checks that it still holds what
//!   this copy was made from (its content hash). If someone changed it, or the
//!   account may not edit it, the person chooses: overwrite, save a copy to
//!   Drive, or keep the change on this PC only.
//! - A Google document is never overwritten. Its first save makes an Office
//!   file beside it, and later saves of that copy go there.
//! - A save that could not go up stays on this PC and is retried: later in
//!   this run, when Drive reconnects, and at the next start.
//!
//! The TypeScript awaits network and dialogs on the main thread; here that
//! work runs on workers, and the tabs are asked on the core thread
//! ([`DriveShell`](super::host::DriveShell)).

use std::collections::HashMap;
use std::fs;
use std::path::{MAIN_SEPARATOR_STR, Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};

use jscompat::{JsObject, JsonValue, json_parse, json_stringify_pretty};
use main_core::markdown::fs_util::sha256_hex;
use main_core::shell::atomic_write::atomic_write_file;
use shell_contract::runtime::{Thread, Workers};

use super::client::{
    DriveClientHost, DriveError, DriveFile, MAX_OPEN_BYTES, OpenPlan, UploadTarget,
};
use super::host::{DriveShellHost, StopWatch};
use super::util::{Clock, is_inside, on_core, same_path, system_clock};

const INDEX_FILE: &str = "index.json";
const PRUNE_AFTER_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_DEBOUNCE_MS: u64 = 2_500;
const DEFAULT_RETRIES_MS: [u64; 3] = [30_000, 2 * 60_000, 10 * 60_000];

/// `CacheEntry`
#[derive(Clone, Debug, PartialEq)]
pub struct CacheEntry {
    /// the Drive file the person opened
    pub source_id: String,
    /// the source is a Google document (opened as an Office export)
    pub google: bool,
    /// the source's Drive name
    pub name: String,
    /// the folder the source sits in, where a new Office file or a copy goes
    pub parent_id: Option<String>,
    pub local_path: String,
    /// hash of the bytes Drive holds for the target as of the last download or upload
    pub synced_sha: String,
    /// where saves go; none for a Google document not saved yet
    pub target_id: Option<String>,
    /// the target's Drive content hash as last seen; none when Drive gives none
    pub target_md5: Option<String>,
    /// the target's Drive change time as last seen: the check when there is no hash
    pub target_modified: Option<String>,
    /// the source's Drive change time when the copy was made
    pub source_modified: String,
    /// the person chose to keep this copy's changes on this PC only
    pub detached: bool,
    /// epoch ms of the last open, for pruning
    pub opened_at: u64,
}

impl CacheEntry {
    fn to_json(&self) -> JsonValue {
        let text = |v: &Option<String>| v.clone().map_or(JsonValue::Null, JsonValue::String);
        let mut o = JsObject::new();
        o.set("sourceId", JsonValue::String(self.source_id.clone()));
        o.set("google", JsonValue::Bool(self.google));
        o.set("name", JsonValue::String(self.name.clone()));
        o.set("parentId", text(&self.parent_id));
        o.set("localPath", JsonValue::String(self.local_path.clone()));
        o.set("syncedSha", JsonValue::String(self.synced_sha.clone()));
        o.set("targetId", text(&self.target_id));
        o.set("targetMd5", text(&self.target_md5));
        o.set("targetModified", text(&self.target_modified));
        o.set(
            "sourceModified",
            JsonValue::String(self.source_modified.clone()),
        );
        o.set("detached", JsonValue::Bool(self.detached));
        o.set("openedAt", JsonValue::Number(self.opened_at as f64));
        JsonValue::Object(o)
    }

    /// An entry of `index.json`; none unless it names its source and a local path
    fn from_json(value: &JsonValue) -> Option<CacheEntry> {
        let field = |key: &str| value.get(key).map(|v| v.into_owned());
        let string = |key: &str| match field(key) {
            Some(JsonValue::String(s)) => Some(s),
            _ => None,
        };
        Some(CacheEntry {
            source_id: string("sourceId")?,
            google: matches!(field("google"), Some(JsonValue::Bool(true))),
            name: string("name").unwrap_or_default(),
            parent_id: string("parentId"),
            local_path: string("localPath")?,
            synced_sha: string("syncedSha").unwrap_or_default(),
            target_id: string("targetId"),
            target_md5: string("targetMd5"),
            target_modified: string("targetModified"),
            source_modified: string("sourceModified").unwrap_or_default(),
            detached: matches!(field("detached"), Some(JsonValue::Bool(true))),
            opened_at: match field("openedAt") {
                Some(JsonValue::Number(n)) if n.is_finite() && n > 0.0 => n as u64,
                _ => 0,
            },
        })
    }
}

/// `SyncQuestion`
#[derive(Clone, Debug, PartialEq)]
pub enum SyncQuestion {
    Changed { name: String },
    ReadOnly { name: String },
    Gone { name: String },
}

/// `SyncAnswer`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncAnswer {
    Overwrite,
    Copy,
    Local,
}

/// `SyncNotice`
#[derive(Clone, Debug, PartialEq)]
pub enum SyncNotice {
    SavedOfficeCopy { name: String, copy_name: String },
    SavedCopy { name: String, copy_name: String },
    UploadFailed { name: String },
}

/// `DriveFilesDeps.ask`, `notify` and `copyName`: the dialogs. `ask` blocks
/// until the person answers, so it is called on a worker.
pub trait SyncUi: Send + Sync {
    fn ask(&self, question: &SyncQuestion) -> SyncAnswer;
    fn notify(&self, notice: &SyncNotice);
    /// "{name} (copy)" in the UI language
    fn copy_name(&self, name: &str) -> String;
}

/// `OpenOutcome`'s failure
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenFailure {
    Drive(DriveError),
    Unsupported,
    Disk,
}

impl OpenFailure {
    pub fn kind(self) -> &'static str {
        match self {
            OpenFailure::Drive(error) => error.kind(),
            OpenFailure::Unsupported => "unsupported",
            OpenFailure::Disk => "disk",
        }
    }
}

/// `DriveFilesDeps.debounceMs`, `retryDelaysMs` and `now`
#[derive(Clone)]
pub struct FilesConfig {
    pub debounce_ms: u64,
    pub retry_delays_ms: Vec<u64>,
    pub now: Clock,
}

impl Default for FilesConfig {
    fn default() -> Self {
        FilesConfig {
            debounce_ms: DEFAULT_DEBOUNCE_MS,
            retry_delays_ms: DEFAULT_RETRIES_MS.to_vec(),
            now: system_clock(),
        }
    }
}

type Job = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct TimerState {
    due: HashMap<String, (Instant, Job)>,
    thread_running: bool,
    closed: bool,
}

#[derive(Default)]
struct TimerShared {
    state: Mutex<TimerState>,
    wake: Condvar,
}

/// `setTimeout` and `clearTimeout` per key: scheduling a key again replaces
/// its timer. One thread of its own runs the due jobs, which only hand work
/// to a worker.
struct Timers {
    shared: Arc<TimerShared>,
}

impl Timers {
    fn new() -> Self {
        Timers {
            shared: Arc::default(),
        }
    }

    fn schedule(&self, key: &str, delay: Duration, job: Job) {
        let mut state = self.shared.state.lock().unwrap();
        if state.closed {
            return;
        }
        state
            .due
            .insert(key.to_owned(), (Instant::now() + delay, job));
        if !state.thread_running {
            let shared = self.shared.clone();
            let spawned = std::thread::Builder::new()
                .name("drive-timers".into())
                .spawn(move || Self::run(&shared));
            state.thread_running = spawned.is_ok();
        }
        self.shared.wake.notify_all();
    }

    fn close(&self) {
        let mut state = self.shared.state.lock().unwrap();
        state.closed = true;
        state.due.clear();
        self.shared.wake.notify_all();
    }

    fn run(shared: &TimerShared) {
        let mut state = shared.state.lock().unwrap();
        loop {
            if state.closed {
                return;
            }
            let next = state
                .due
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(key, (at, _))| (key.clone(), *at));
            match next {
                None => state = shared.wake.wait(state).unwrap(),
                Some((key, at)) => {
                    let now = Instant::now();
                    if at <= now {
                        let (_, job) = state.due.remove(&key).expect("a due timer");
                        drop(state);
                        job();
                        state = shared.state.lock().unwrap();
                    } else {
                        state = shared.wake.wait_timeout(state, at - now).unwrap().0;
                    }
                }
            }
        }
    }
}

impl Drop for Timers {
    fn drop(&mut self) {
        self.close();
    }
}

/// `DriveFiles`
pub struct DriveFiles {
    client: DriveClientHost,
    shell: DriveShellHost,
    ui: Arc<dyn SyncUi>,
    core: Arc<dyn Thread>,
    workers: Arc<dyn Workers>,
    cache_dir: PathBuf,
    config: FilesConfig,
    /// a `Map` in insertion order: a replaced key keeps its place
    entries: Mutex<Vec<CacheEntry>>,
    /// held while the index is written, so the last write is the newest
    index_lock: Mutex<()>,
    timers: Timers,
    /// the sources with an upload running, and whether another pass is wanted
    running: Mutex<HashMap<String, bool>>,
    failures: Mutex<HashMap<String, usize>>,
    unwatch: Mutex<Option<StopWatch>>,
    /// held during `start`, so a second caller waits for the first to finish
    started: Mutex<bool>,
    me: Weak<DriveFiles>,
}

/// `extensionOfPath(path)`
fn extension_of_path(path: &str) -> String {
    match path.rfind('.') {
        Some(dot) if path.rfind(MAIN_SEPARATOR_STR).is_none_or(|sep| dot > sep) => {
            path[dot..].to_lowercase()
        }
        _ => String::new(),
    }
}

/// `changedSince(entry, remote)`: Drive holds something other than what this
/// copy was last in step with
fn changed_since(entry: &CacheEntry, remote: &DriveFile) -> bool {
    if let (Some(known), Some(now)) = (&entry.target_md5, &remote.md5_checksum)
        && !known.is_empty()
        && !now.is_empty()
    {
        return now != known;
    }
    if let Some(known) = &entry.target_modified
        && !known.is_empty()
        && !remote.modified_time.is_empty()
    {
        return remote.modified_time != *known;
    }
    false
}

fn non_empty(text: &str) -> Option<String> {
    (!text.is_empty()).then(|| text.to_owned())
}

impl DriveFiles {
    pub fn new(
        client: DriveClientHost,
        shell: DriveShellHost,
        ui: Arc<dyn SyncUi>,
        core: Arc<dyn Thread>,
        workers: Arc<dyn Workers>,
        cache_dir: PathBuf,
        config: FilesConfig,
    ) -> Arc<DriveFiles> {
        Arc::new_cyclic(|me| DriveFiles {
            client,
            shell,
            ui,
            core,
            workers,
            cache_dir,
            config,
            entries: Mutex::new(Vec::new()),
            index_lock: Mutex::new(()),
            timers: Timers::new(),
            running: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),
            unwatch: Mutex::new(None),
            started: Mutex::new(false),
            me: me.clone(),
        })
    }

    fn now(&self) -> u64 {
        (self.config.now)()
    }

    // ---- the tabs, on the core thread ----

    fn is_open(&self, path: &str) -> bool {
        let shell = self.shell.clone();
        let path = path.to_owned();
        on_core(&*self.core, move || shell.is_open(&path))
    }

    fn open_path(&self, path: &str) -> bool {
        let shell = self.shell.clone();
        let path = path.to_owned();
        on_core(&*self.core, move || shell.open_path(&path))
    }

    // ---- the entries ----

    fn entry(&self, source_id: &str) -> Option<CacheEntry> {
        let entries = self.entries.lock().unwrap();
        entries.iter().find(|e| e.source_id == source_id).cloned()
    }

    fn put(&self, entry: CacheEntry) {
        let mut entries = self.entries.lock().unwrap();
        match entries.iter_mut().find(|e| e.source_id == entry.source_id) {
            Some(slot) => *slot = entry,
            None => entries.push(entry),
        }
    }

    fn update(&self, source_id: &str, change: impl FnOnce(&mut CacheEntry)) {
        let mut entries = self.entries.lock().unwrap();
        if let Some(entry) = entries.iter_mut().find(|e| e.source_id == source_id) {
            change(entry);
        }
    }

    fn all(&self) -> Vec<CacheEntry> {
        self.entries.lock().unwrap().clone()
    }

    /// The cache entry a local path belongs to
    pub fn entry_for(&self, path: &str) -> Option<CacheEntry> {
        let entries = self.entries.lock().unwrap();
        entries
            .iter()
            .find(|e| same_path(Path::new(&e.local_path), Path::new(path)))
            .cloned()
    }

    /// A path inside the cache folder (anything else is never touched). Only
    /// a whole `..` step leads out, so `..x` is inside.
    pub fn in_cache(&self, path: &str) -> bool {
        !path.is_empty() && is_inside(&self.cache_dir, Path::new(path))
    }

    fn save_index(&self) {
        let _writing = self.index_lock.lock().unwrap();
        let mut index = JsObject::new();
        index.set(
            "entries",
            JsonValue::Array(self.all().iter().map(CacheEntry::to_json).collect()),
        );
        let body = json_stringify_pretty(&JsonValue::Object(index), 2);
        let path = self.cache_dir.join(INDEX_FILE);
        let _ = atomic_write_file(&path.to_string_lossy(), body.as_bytes());
    }

    fn local_sha(entry: &CacheEntry) -> Option<String> {
        fs::read(&entry.local_path)
            .ok()
            .map(|bytes| sha256_hex(&bytes))
    }

    fn read_index(&self) {
        let Ok(bytes) = fs::read(self.cache_dir.join(INDEX_FILE)) else {
            return;
        };
        let Ok(raw) = json_parse(&String::from_utf8_lossy(&bytes)) else {
            return;
        };
        let Some(items) = raw.get("entries") else {
            return;
        };
        let JsonValue::Array(items) = items.as_ref() else {
            return;
        };
        for item in items {
            if let Some(entry) = CacheEntry::from_json(item)
                && self.in_cache(&entry.local_path)
            {
                self.put(entry);
            }
        }
    }

    /// Copies not opened for a month and holding nothing unsent are removed
    fn prune(&self) {
        let cutoff = self.now().saturating_sub(PRUNE_AFTER_MS);
        for entry in self.all() {
            let exists = Path::new(&entry.local_path).exists();
            let stale = entry.opened_at < cutoff && !self.is_open(&entry.local_path);
            if exists && !stale {
                continue;
            }
            if exists
                && Self::local_sha(&entry).as_deref() != Some(entry.synced_sha.as_str())
                && !entry.detached
            {
                continue;
            }
            self.entries
                .lock()
                .unwrap()
                .retain(|e| e.source_id != entry.source_id);
            if let Some(folder) = Path::new(&entry.local_path).parent() {
                let _ = fs::remove_dir_all(folder);
            }
        }
        self.save_index();
    }

    /// Read the index, drop what is gone, start watching, queue saves left
    /// from last time. Blocks: call it on a worker.
    pub fn start(&self) -> std::io::Result<()> {
        let mut started = self.started.lock().unwrap();
        if *started {
            return Ok(());
        }
        fs::create_dir_all(&self.cache_dir)?;
        self.read_index();
        self.prune();
        let me = self.me.clone();
        let shell = self.shell.clone();
        let dir = self.cache_dir.clone();
        let stop = on_core(&*self.core, move || {
            shell.watch(
                &dir,
                Arc::new(move |path| {
                    if let Some(files) = me.upgrade() {
                        files.changed(&path.to_string_lossy());
                    }
                }),
            )
        });
        *self.unwatch.lock().unwrap() = Some(stop);
        *started = true;
        drop(started);
        for entry in self.all() {
            self.sync_if_changed(&entry.source_id);
        }
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(stop) = self.unwatch.lock().unwrap().take() {
            stop();
        }
        self.timers.close();
    }

    /// Drive came back: try every save that is still waiting
    pub fn reconnected(&self) {
        self.failures.lock().unwrap().clear();
        for entry in self.all() {
            self.sync_if_changed(&entry.source_id);
        }
    }

    fn file_behind_shortcut(&self, id: &str) -> Result<DriveFile, DriveError> {
        let file = self.client.file(id)?;
        match &file.shortcut_target {
            Some(target) => self.client.file(&target.id),
            None => Ok(file),
        }
    }

    /// Open a Drive file: fetch it unless the local copy is current or holds
    /// unsent changes. Blocks: call it on a worker.
    pub fn open(&self, file_id: &str) -> Result<(), OpenFailure> {
        self.start().map_err(|_| OpenFailure::Disk)?;
        let file = self
            .file_behind_shortcut(file_id)
            .map_err(OpenFailure::Drive)?;
        let plan = self.client.open_plan(&file.name, &file.mime_type);
        if plan == OpenPlan::None {
            return Err(OpenFailure::Unsupported);
        }

        let existing = self.entry(&file.id);
        if let Some(existing) = &existing
            && Path::new(&existing.local_path).exists()
        {
            let dirty = Self::local_sha(existing).as_deref() != Some(existing.synced_sha.as_str());
            let current = file.modified_time == existing.source_modified;
            if self.is_open(&existing.local_path) || dirty || current {
                let now = self.now();
                self.update(&file.id, |e| e.opened_at = now);
                self.save_index();
                if dirty && !existing.detached {
                    self.sync_if_changed(&existing.source_id);
                }
                return self.open_local(&existing.local_path);
            }
        }

        let (google, extension, got) = match &plan {
            OpenPlan::Export { mime, extension } => (
                true,
                extension,
                self.client.export(&file.id, mime, MAX_OPEN_BYTES),
            ),
            OpenPlan::Download { extension } => (
                false,
                extension,
                self.client.download(&file.id, MAX_OPEN_BYTES),
            ),
            OpenPlan::None => unreachable!("refused above"),
        };
        let bytes = got.map_err(OpenFailure::Drive)?;
        let folder_name: String = file
            .id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let folder = self.cache_dir.join(folder_name);
        let local_path = folder.join(self.client.local_file_name(&file.name, extension));
        let local = local_path.to_string_lossy().into_owned();
        let stored = (|| -> Result<(), ()> {
            fs::create_dir_all(&folder).map_err(|_| ())?;
            if let Some(existing) = &existing
                && !same_path(Path::new(&existing.local_path), &local_path)
            {
                let _ = fs::remove_file(&existing.local_path);
            }
            atomic_write_file(&local, &bytes).map_err(|_| ())
        })();
        stored.map_err(|()| OpenFailure::Disk)?;
        self.put(CacheEntry {
            source_id: file.id.clone(),
            google,
            name: file.name.clone(),
            parent_id: file.parents.first().cloned(),
            local_path: local.clone(),
            synced_sha: sha256_hex(&bytes),
            // every open of a Google document starts over: its first save makes a new Office file
            target_id: (!google).then(|| file.id.clone()),
            target_md5: if google {
                None
            } else {
                file.md5_checksum.clone()
            },
            target_modified: if google {
                None
            } else {
                Some(file.modified_time.clone())
            },
            source_modified: file.modified_time.clone(),
            detached: false,
            opened_at: self.now(),
        });
        self.save_index();
        self.open_local(&local)
    }

    fn open_local(&self, path: &str) -> Result<(), OpenFailure> {
        if self.open_path(path) {
            Ok(())
        } else {
            Err(OpenFailure::Disk)
        }
    }

    /// The watcher's callback: a save waits a moment, so a burst of writes
    /// uploads once
    fn changed(&self, path: &str) {
        let Some(entry) = self.entry_for(path) else {
            return;
        };
        if entry.detached {
            return;
        }
        self.timer_for(&entry.source_id, self.config.debounce_ms);
    }

    fn timer_for(&self, source_id: &str, delay_ms: u64) {
        let me = self.me.clone();
        let id = source_id.to_owned();
        self.timers.schedule(
            source_id,
            Duration::from_millis(delay_ms),
            Box::new(move || {
                if let Some(files) = me.upgrade() {
                    files.sync_if_changed(&id);
                }
            }),
        );
    }

    /// One upload at a time per file; a save during an upload runs another
    /// pass after it. The work is queued on a worker.
    pub fn sync_if_changed(&self, source_id: &str) {
        {
            let mut running = self.running.lock().unwrap();
            if let Some(again) = running.get_mut(source_id) {
                *again = true;
                return;
            }
            running.insert(source_id.to_owned(), false);
        }
        let Some(files) = self.me.upgrade() else {
            return;
        };
        let id = source_id.to_owned();
        self.workers.spawn(Box::new(move || {
            loop {
                files.sync_once(&id);
                let mut running = files.running.lock().unwrap();
                if running.insert(id.clone(), false) == Some(true) {
                    continue;
                }
                running.remove(&id);
                break;
            }
        }));
    }

    fn retry_later(&self, entry: &CacheEntry) {
        let delays = &self.config.retry_delays_ms;
        let count = {
            let mut failures = self.failures.lock().unwrap();
            let count = failures.entry(entry.source_id.clone()).or_insert(0);
            *count += 1;
            *count
        };
        if count == delays.len() {
            self.ui.notify(&SyncNotice::UploadFailed {
                name: entry.name.clone(),
            });
        }
        let Some(delay) = delays.get(count - 1).or(delays.last()) else {
            return;
        };
        self.timer_for(&entry.source_id, *delay);
    }

    fn retry_or_stop(&self, entry: &CacheEntry, error: DriveError) {
        // not-connected waits for reconnected(); everything else is tried again later
        match error {
            DriveError::NotConnected => {}
            DriveError::Forbidden | DriveError::TooLarge => {
                self.ui.notify(&SyncNotice::UploadFailed {
                    name: entry.name.clone(),
                })
            }
            _ => self.retry_later(entry),
        }
    }

    /// What a successful upload says about the target
    fn record_upload(&self, source_id: &str, file: &DriveFile, hash: &str) {
        self.update(source_id, |e| {
            e.target_md5 = file.md5_checksum.clone();
            e.target_modified = non_empty(&file.modified_time);
            e.synced_sha = hash.to_owned();
        });
        self.failures.lock().unwrap().remove(source_id);
        self.save_index();
    }

    fn create(
        &self,
        entry: &CacheEntry,
        name: &str,
        bytes: &[u8],
        mime: &str,
    ) -> Option<DriveFile> {
        let mut made = self.client.upload(
            &UploadTarget::New {
                name: name.to_owned(),
                parent_id: entry.parent_id.clone(),
            },
            bytes,
            mime,
        );
        // no right to add to that folder (a shared folder), or the folder is not one the app may
        // see (drive.file covers picked files, not the folders they sit in): My Drive instead
        if matches!(made, Err(DriveError::Forbidden | DriveError::NotFound))
            && entry.parent_id.is_some()
        {
            made = self.client.upload(
                &UploadTarget::New {
                    name: name.to_owned(),
                    parent_id: None,
                },
                bytes,
                mime,
            );
        }
        match made {
            Ok(file) => Some(file),
            Err(error) => {
                self.retry_or_stop(entry, error);
                None
            }
        }
    }

    /// One pass over one file
    pub fn sync_once(&self, source_id: &str) {
        let Some(entry) = self.entry(source_id) else {
            return;
        };
        if entry.detached {
            return;
        }
        let Ok(info) = fs::metadata(&entry.local_path) else {
            return;
        };
        if !info.is_file() {
            return;
        }
        let Ok(bytes) = fs::read(&entry.local_path) else {
            return;
        };
        let hash = sha256_hex(&bytes);
        if hash == entry.synced_sha {
            return;
        }
        // not connected: wait for reconnected()
        if !self.client.connected() {
            return;
        }
        let mime = self.client.upload_mime(&entry.local_path);

        let Some(target_id) = entry.target_id.clone() else {
            // a Google document's first save: an Office file beside it
            let copy_name = self
                .client
                .office_copy_name(&entry.name, &extension_of_path(&entry.local_path));
            let Some(made) = self.create(&entry, &copy_name, &bytes, &mime) else {
                return;
            };
            self.update(source_id, |e| e.target_id = Some(made.id.clone()));
            self.record_upload(source_id, &made, &hash);
            self.ui.notify(&SyncNotice::SavedOfficeCopy {
                name: entry.name.clone(),
                copy_name,
            });
            return;
        };

        let meta = self.client.file(&target_id);
        let question = match &meta {
            Err(DriveError::NotFound) => Some(SyncQuestion::Gone {
                name: entry.name.clone(),
            }),
            Err(other) => return self.retry_or_stop(&entry, *other),
            Ok(file) if !file.can_edit => Some(SyncQuestion::ReadOnly {
                name: entry.name.clone(),
            }),
            Ok(file) if changed_since(&entry, file) => Some(SyncQuestion::Changed {
                name: entry.name.clone(),
            }),
            Ok(_) => None,
        };

        let mut answer = SyncAnswer::Overwrite;
        if let Some(question) = &question {
            answer = self.ui.ask(question);
            // "overwrite" is only offered for a changed file
            if answer == SyncAnswer::Overwrite && !matches!(question, SyncQuestion::Changed { .. })
            {
                answer = SyncAnswer::Local;
            }
        }
        match answer {
            SyncAnswer::Local => {
                self.update(source_id, |e| e.detached = true);
                self.save_index();
            }
            SyncAnswer::Copy => {
                let shown = meta
                    .as_ref()
                    .map_or(entry.name.as_str(), |f| f.name.as_str());
                let copy_name = self.ui.copy_name(shown);
                let Some(made) = self.create(&entry, &copy_name, &bytes, &mime) else {
                    return;
                };
                self.update(source_id, |e| e.target_id = Some(made.id.clone()));
                self.record_upload(source_id, &made, &hash);
                self.ui.notify(&SyncNotice::SavedCopy {
                    name: entry.name.clone(),
                    copy_name,
                });
            }
            SyncAnswer::Overwrite => {
                match self
                    .client
                    .upload(&UploadTarget::Existing(target_id), &bytes, &mime)
                {
                    Ok(put) => self.record_upload(source_id, &put, &hash),
                    Err(error) => self.retry_or_stop(&entry, error),
                }
            }
        }
    }

    /// test seam: the entries as stored
    #[cfg(test)]
    pub fn snapshot(&self) -> Vec<CacheEntry> {
        self.all()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn the_extension_is_the_last_dot_of_the_file_name_only() {
        let sep = MAIN_SEPARATOR_STR;
        assert_eq!(
            extension_of_path(&format!("a{sep}b{sep}Report.DOCX")),
            ".docx"
        );
        assert_eq!(extension_of_path(&format!("a.d{sep}notes")), "");
        assert_eq!(extension_of_path("noext"), "");
    }

    #[test]
    fn a_timer_replaced_by_the_same_key_fires_once() {
        let timers = Timers::new();
        let fired = Arc::new(AtomicUsize::new(0));
        for _ in 0..3 {
            let fired = fired.clone();
            timers.schedule(
                "a",
                Duration::from_millis(30),
                Box::new(move || {
                    fired.fetch_add(1, Ordering::SeqCst);
                }),
            );
        }
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(fired.load(Ordering::SeqCst), 1);
        timers.close();
        let late = fired.clone();
        timers.schedule(
            "b",
            Duration::from_millis(1),
            Box::new(move || {
                late.fetch_add(10, Ordering::SeqCst);
            }),
        );
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(fired.load(Ordering::SeqCst), 1);
    }
}

#[cfg(test)]
mod sync_tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::super::client::{ConnectionState, DriveError, UploadTarget};
    use super::super::testing::{FakeClient, FakeShell, FakeUi, GOOGLE_DOC, Inline};
    use super::*;

    struct Rig {
        dir: PathBuf,
        cache: PathBuf,
        client: Arc<FakeClient>,
        shell: Arc<FakeShell>,
        ui: Arc<FakeUi>,
        clock: Arc<AtomicU64>,
        files: Arc<DriveFiles>,
    }

    fn rig_with(name: &str, debounce_ms: u64) -> Rig {
        let dir = std::env::temp_dir().join(format!("shell-a-files-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let client = FakeClient::new();
        client.connect_as("Dana");
        let shell = FakeShell::new();
        let ui = Arc::new(FakeUi::default());
        let clock = Arc::new(AtomicU64::new(1_000_000));
        let cache = dir.join("drive-cache");
        let files = build(&client, &shell, &ui, &clock, &cache, debounce_ms);
        Rig {
            dir,
            cache,
            client,
            shell,
            ui,
            clock,
            files,
        }
    }

    fn build(
        client: &Arc<FakeClient>,
        shell: &Arc<FakeShell>,
        ui: &Arc<FakeUi>,
        clock: &Arc<AtomicU64>,
        cache: &Path,
        debounce_ms: u64,
    ) -> Arc<DriveFiles> {
        let clock = clock.clone();
        DriveFiles::new(
            client.clone(),
            shell.clone(),
            ui.clone(),
            Arc::new(Inline),
            Arc::new(Inline),
            cache.to_path_buf(),
            FilesConfig {
                debounce_ms,
                retry_delays_ms: vec![3_600_000, 7_200_000],
                now: Arc::new(move || clock.load(Ordering::SeqCst)),
            },
        )
    }

    impl Rig {
        /// the app started again over the same folder
        fn restarted(&self) -> Arc<DriveFiles> {
            let files = build(
                &self.client,
                &self.shell,
                &self.ui,
                &self.clock,
                &self.cache,
                3_600_000,
            );
            files.start().unwrap();
            files
        }
    }

    fn rig(name: &str) -> Rig {
        rig_with(name, 3_600_000)
    }

    const T1: &str = "2026-01-02T00:00:00Z";

    /// opens `id` and returns the local copy's path
    fn opened(r: &Rig, id: &str) -> String {
        r.files.open(id).unwrap();
        r.files
            .snapshot()
            .into_iter()
            .find(|e| e.source_id == id)
            .unwrap()
            .local_path
    }

    fn edit(path: &str, bytes: &[u8]) {
        fs::write(path, bytes).unwrap();
    }

    fn uploads(r: &Rig) -> Vec<(UploadTarget, Vec<u8>)> {
        r.client.uploads.lock().unwrap().clone()
    }

    #[test]
    fn opening_keeps_a_local_copy_and_an_index_that_survives_a_restart() {
        let r = rig("index");
        r.client.add("f1", "Plan.docx", "application/x", T1, b"v1");
        let path = opened(&r, "f1");
        assert_eq!(fs::read(&path).unwrap(), b"v1");
        let entry = r.files.snapshot().remove(0);
        assert_eq!(
            entry,
            CacheEntry {
                source_id: "f1".into(),
                google: false,
                name: "Plan.docx".into(),
                parent_id: Some("folder-1".into()),
                local_path: path.clone(),
                synced_sha: sha256_hex(b"v1"),
                target_id: Some("f1".into()),
                target_md5: Some(crate::drive::testing::md5_of(b"v1")),
                target_modified: Some(T1.into()),
                source_modified: T1.into(),
                detached: false,
                opened_at: 1_000_000,
            }
        );
        // the Electron build wrote the same file
        let index: serde_json::Value =
            serde_json::from_slice(&fs::read(r.cache.join("index.json")).unwrap()).unwrap();
        assert_eq!(index["entries"][0]["sourceId"], "f1");
        assert_eq!(index["entries"][0]["parentId"], "folder-1");
        assert_eq!(index["entries"][0]["syncedSha"], sha256_hex(b"v1"));

        let again = r.restarted();
        assert_eq!(again.snapshot(), vec![entry]);
        assert!(again.entry_for(&path).is_some());
        assert!(again.entry_for("/not/a/copy.docx").is_none());
    }

    #[test]
    fn an_index_entry_pointing_outside_the_cache_is_never_trusted() {
        let r = rig("index-outside");
        fs::create_dir_all(&r.cache).unwrap();
        let outside = r.dir.join("precious.docx");
        fs::write(&outside, b"mine").unwrap();
        let inside = r.cache.join("x").join("a.docx");
        fs::create_dir_all(inside.parent().unwrap()).unwrap();
        fs::write(&inside, b"a").unwrap();
        let entry = |id: &str, path: &Path| {
            format!(
                r#"{{"sourceId":"{id}","google":false,"name":"n","parentId":null,"localPath":{},"syncedSha":"{}","targetId":"{id}","targetMd5":null,"targetModified":null,"sourceModified":"","detached":false,"openedAt":1000000}}"#,
                serde_json::to_string(&path.to_string_lossy()).unwrap(),
                sha256_hex(&fs::read(path).unwrap()),
            )
        };
        let sneaky = r.cache.join("..").join("precious.docx");
        fs::write(
            r.cache.join("index.json"),
            format!(
                r#"{{"entries":[{},{},{},5,null,{{"sourceId":7}}]}}"#,
                entry("keep", &inside),
                entry("outside", &outside),
                entry("sneaky", &sneaky),
            ),
        )
        .unwrap();
        let files = r.restarted();
        let ids: Vec<_> = files.snapshot().into_iter().map(|e| e.source_id).collect();
        assert_eq!(ids, ["keep"]);
        assert!(outside.exists(), "prune never touches what is outside");
    }

    #[test]
    fn a_save_goes_up_over_the_drive_file_and_an_unchanged_copy_does_not() {
        let r = rig("overwrite");
        r.client.add("f1", "Plan.docx", "application/x", T1, b"v1");
        let path = opened(&r, "f1");
        r.files.sync_once("f1");
        assert!(uploads(&r).is_empty(), "nothing changed");

        edit(&path, b"v2");
        r.files.sync_once("f1");
        assert_eq!(
            uploads(&r),
            vec![(UploadTarget::Existing("f1".into()), b"v2".to_vec())]
        );
        assert_eq!(r.client.bytes_of("f1"), b"v2");
        assert!(r.ui.asked.lock().unwrap().is_empty());
        let entry = r.files.snapshot().remove(0);
        assert_eq!(entry.synced_sha, sha256_hex(b"v2"));
        assert_eq!(entry.target_md5, Some(crate::drive::testing::md5_of(b"v2")));

        // the next save is still in step with what Drive holds
        edit(&path, b"v3");
        r.files.sync_once("f1");
        assert_eq!(uploads(&r).len(), 2);
        assert!(r.ui.asked.lock().unwrap().is_empty());
    }

    fn changed_in_drive(name: &str) -> (Rig, String) {
        let r = rig(name);
        r.client.add("f1", "Plan.docx", "application/x", T1, b"v1");
        let path = opened(&r, "f1");
        r.client.change("f1", b"theirs", "2026-01-09T00:00:00Z");
        edit(&path, b"mine");
        (r, path)
    }

    #[test]
    fn a_file_someone_changed_asks_and_overwrites_only_when_told_to() {
        let (r, _) = changed_in_drive("changed-overwrite");
        r.ui.answers.lock().unwrap().push(SyncAnswer::Overwrite);
        r.files.sync_once("f1");
        assert_eq!(
            r.ui.asked.lock().unwrap().as_slice(),
            [SyncQuestion::Changed {
                name: "Plan.docx".into()
            }]
        );
        assert_eq!(r.client.bytes_of("f1"), b"mine");
    }

    #[test]
    fn a_file_someone_changed_can_be_saved_as_a_copy_beside_it() {
        let (r, _) = changed_in_drive("changed-copy");
        r.ui.answers.lock().unwrap().push(SyncAnswer::Copy);
        r.files.sync_once("f1");
        assert_eq!(r.client.bytes_of("f1"), b"theirs", "theirs is left alone");
        assert_eq!(
            uploads(&r),
            vec![(
                UploadTarget::New {
                    name: "Plan.docx (copy)".into(),
                    parent_id: Some("folder-1".into())
                },
                b"mine".to_vec()
            )]
        );
        assert_eq!(
            r.ui.notices.lock().unwrap().as_slice(),
            [SyncNotice::SavedCopy {
                name: "Plan.docx".into(),
                copy_name: "Plan.docx (copy)".into()
            }]
        );
        // later saves go to the copy
        let entry = r.files.snapshot().remove(0);
        assert_eq!(entry.target_id.as_deref(), Some("made-1"));
        edit(&entry.local_path, b"mine again");
        r.files.sync_once("f1");
        assert_eq!(r.client.bytes_of("made-1"), b"mine again");
        assert_eq!(
            r.ui.asked.lock().unwrap().len(),
            1,
            "the copy is ours: no question"
        );
    }

    #[test]
    fn keeping_a_change_on_this_pc_detaches_the_copy_for_good() {
        let (r, path) = changed_in_drive("changed-local");
        r.files.sync_once("f1");
        assert!(uploads(&r).is_empty());
        let entry = r.files.snapshot().remove(0);
        assert!(entry.detached);
        edit(&path, b"later");
        r.files.sync_once("f1");
        assert!(uploads(&r).is_empty());
        // and it stays detached across a restart
        assert!(r.restarted().snapshot()[0].detached);
    }

    #[test]
    fn a_read_only_or_vanished_file_never_offers_to_overwrite() {
        let r = rig("read-only");
        r.client.add("f1", "Plan.docx", "application/x", T1, b"v1");
        let path = opened(&r, "f1");
        r.client
            .files
            .lock()
            .unwrap()
            .get_mut("f1")
            .unwrap()
            .0
            .can_edit = false;
        edit(&path, b"mine");
        r.ui.answers.lock().unwrap().push(SyncAnswer::Overwrite);
        r.files.sync_once("f1");
        assert_eq!(
            r.ui.asked.lock().unwrap().as_slice(),
            [SyncQuestion::ReadOnly {
                name: "Plan.docx".into()
            }]
        );
        assert!(uploads(&r).is_empty());
        assert!(
            r.files.snapshot()[0].detached,
            "overwrite is downgraded to keeping it here"
        );

        let gone = rig("gone");
        gone.client
            .add("f1", "Plan.docx", "application/x", T1, b"v1");
        let path = opened(&gone, "f1");
        gone.client.files.lock().unwrap().remove("f1");
        edit(&path, b"mine");
        gone.ui.answers.lock().unwrap().push(SyncAnswer::Copy);
        gone.files.sync_once("f1");
        assert_eq!(
            gone.ui.asked.lock().unwrap().as_slice(),
            [SyncQuestion::Gone {
                name: "Plan.docx".into()
            }]
        );
        assert_eq!(uploads(&gone).len(), 1);
        assert!(
            matches!(&uploads(&gone)[0].0, UploadTarget::New { name, .. } if name == "Plan.docx (copy)")
        );
    }

    #[test]
    fn a_google_document_is_never_overwritten_its_first_save_makes_an_office_file() {
        let r = rig("google");
        r.client.add("g1", "Notes", GOOGLE_DOC, T1, b"exported");
        let path = opened(&r, "g1");
        assert!(path.ends_with("Notes.docx"), "{path}");
        let entry = r.files.snapshot().remove(0);
        assert!(entry.google);
        assert_eq!(entry.target_id, None);

        edit(&path, b"edited");
        r.files.sync_once("g1");
        assert_eq!(
            uploads(&r),
            vec![(
                UploadTarget::New {
                    name: "Notes.docx".into(),
                    parent_id: Some("folder-1".into())
                },
                b"edited".to_vec()
            )]
        );
        assert_eq!(r.client.bytes_of("g1"), b"exported");
        assert_eq!(
            r.ui.notices.lock().unwrap().as_slice(),
            [SyncNotice::SavedOfficeCopy {
                name: "Notes".into(),
                copy_name: "Notes.docx".into()
            }]
        );
        edit(&path, b"edited twice");
        r.files.sync_once("g1");
        assert_eq!(r.client.bytes_of("made-1"), b"edited twice");
        assert_eq!(uploads(&r).len(), 2);
    }

    #[test]
    fn a_folder_the_account_cannot_add_to_falls_back_to_my_drive() {
        let r = rig("parent");
        r.client.add("g1", "Notes", GOOGLE_DOC, T1, b"exported");
        let path = opened(&r, "g1");
        r.client.refuse_parents.store(true, Ordering::SeqCst);
        edit(&path, b"edited");
        r.files.sync_once("g1");
        let made = uploads(&r);
        assert_eq!(made.len(), 2);
        assert!(matches!(
            &made[0].0,
            UploadTarget::New {
                parent_id: Some(_),
                ..
            }
        ));
        assert!(matches!(
            &made[1].0,
            UploadTarget::New {
                parent_id: None,
                ..
            }
        ));
        assert_eq!(r.files.snapshot()[0].target_id.as_deref(), Some("made-2"));
    }

    #[test]
    fn a_save_that_cannot_go_up_waits_and_the_person_is_told_after_the_last_try() {
        let r = rig("retry");
        r.client.add("f1", "Plan.docx", "application/x", T1, b"v1");
        let path = opened(&r, "f1");
        edit(&path, b"v2");
        *r.client.upload_error.lock().unwrap() = Some(DriveError::Network);
        r.files.sync_once("f1");
        assert!(
            r.ui.notices.lock().unwrap().is_empty(),
            "the first failure is quiet"
        );
        r.files.sync_once("f1");
        assert_eq!(
            r.ui.notices.lock().unwrap().as_slice(),
            [SyncNotice::UploadFailed {
                name: "Plan.docx".into()
            }]
        );
        assert_eq!(
            r.files.snapshot()[0].synced_sha,
            sha256_hex(b"v1"),
            "still unsent"
        );

        // Drive coming back tries again, from the first delay
        *r.client.upload_error.lock().unwrap() = None;
        r.files.reconnected();
        assert_eq!(r.client.bytes_of("f1"), b"v2");
        assert_eq!(r.files.snapshot()[0].synced_sha, sha256_hex(b"v2"));
    }

    #[test]
    fn an_upload_drive_refuses_outright_is_reported_at_once_and_not_connected_waits() {
        let r = rig("refused");
        r.client.add("f1", "Plan.docx", "application/x", T1, b"v1");
        let path = opened(&r, "f1");
        edit(&path, b"v2");
        *r.client.upload_error.lock().unwrap() = Some(DriveError::TooLarge);
        r.files.sync_once("f1");
        assert_eq!(r.ui.notices.lock().unwrap().len(), 1);

        r.ui.notices.lock().unwrap().clear();
        *r.client.upload_error.lock().unwrap() = Some(DriveError::NotConnected);
        r.files.sync_once("f1");
        assert!(r.ui.notices.lock().unwrap().is_empty());

        *r.client.upload_error.lock().unwrap() = None;
        r.client
            .set_state(ConnectionState::Disconnected { expired: false });
        let before = uploads(&r).len();
        r.files.sync_once("f1");
        assert_eq!(uploads(&r).len(), before, "no connection, no attempt");
        r.client.connect_as("Dana");
        r.files.reconnected();
        assert_eq!(r.client.bytes_of("f1"), b"v2");
    }

    #[test]
    fn opening_a_copy_with_unsent_changes_keeps_them_and_a_stale_clean_copy_is_refreshed() {
        let r = rig("reopen");
        r.client.add("f1", "Plan.docx", "application/x", T1, b"v1");
        let path = opened(&r, "f1");
        r.shell.tabs.lock().unwrap().clear();
        r.client.change("f1", b"v2", "2026-01-09T00:00:00Z");

        // unsent changes win over a newer Drive file: they go through the ordinary check
        edit(&path, b"mine");
        r.ui.answers.lock().unwrap().push(SyncAnswer::Local);
        r.files.open("f1").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"mine");
        assert_eq!(r.client.downloads.load(Ordering::SeqCst), 1);
        assert_eq!(r.ui.asked.lock().unwrap().len(), 1);

        // clean and out of date: fetched again
        let r = rig("refresh");
        r.client.add("f1", "Plan.docx", "application/x", T1, b"v1");
        let path = opened(&r, "f1");
        r.shell.tabs.lock().unwrap().clear();
        r.client.change("f1", b"v2", "2026-01-09T00:00:00Z");
        r.files.open("f1").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"v2");
        // a tab already showing the copy is only brought forward
        r.client.change("f1", b"v3", "2026-01-10T00:00:00Z");
        r.files.open("f1").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"v2");
    }

    #[test]
    fn prune_removes_old_clean_copies_and_keeps_what_is_open_or_unsent() {
        let r = rig("prune");
        let mut paths = Vec::new();
        for id in ["f1", "f2", "f3", "f4"] {
            r.client.add(
                id,
                &format!("{id}.docx"),
                "application/x",
                T1,
                id.as_bytes(),
            );
            paths.push(opened(&r, id));
        }
        r.shell.tabs.lock().unwrap().clear();
        r.shell.tabs.lock().unwrap().insert(paths[2].clone());
        edit(&paths[1], b"unsent");
        fs::remove_file(&paths[3]).unwrap();
        r.clock
            .fetch_add(31 * 24 * 60 * 60 * 1000, Ordering::SeqCst);

        let again = r.restarted();
        let kept: Vec<_> = again.snapshot().into_iter().map(|e| e.source_id).collect();
        assert_eq!(kept, ["f2", "f3"]);
        assert!(
            !Path::new(&paths[0]).exists(),
            "an old clean copy goes with its folder"
        );
        assert!(!Path::new(&paths[0]).parent().unwrap().exists());
        assert!(Path::new(&paths[1]).exists());
        assert!(Path::new(&paths[2]).exists());
        // a copy that went missing is forgotten
        assert!(!Path::new(&paths[3]).parent().unwrap().exists());
    }

    #[test]
    fn a_new_copy_is_not_pruned_and_a_start_sends_what_was_left_unsent() {
        let r = rig("restart");
        r.client.add("f1", "Plan.docx", "application/x", T1, b"v1");
        let path = opened(&r, "f1");
        edit(&path, b"while closed");
        let again = r.restarted();
        assert_eq!(again.snapshot().len(), 1);
        assert_eq!(r.client.bytes_of("f1"), b"while closed");
    }

    #[test]
    fn one_upload_runs_at_a_time_for_a_file() {
        struct Queue(Mutex<Vec<Job>>);
        impl Workers for Queue {
            fn spawn(&self, job: Job) {
                self.0.lock().unwrap().push(job);
            }
        }
        let r = rig("single");
        r.client.add("f1", "Plan.docx", "application/x", T1, b"v1");
        let path = opened(&r, "f1");
        edit(&path, b"v2");
        let queue = Arc::new(Queue(Mutex::default()));
        let files = DriveFiles::new(
            r.client.clone(),
            r.shell.clone(),
            r.ui.clone(),
            Arc::new(Inline),
            queue.clone(),
            r.cache.clone(),
            FilesConfig::default(),
        );
        files.start().unwrap();
        let queued = |q: &Queue| q.0.lock().unwrap().len();
        // start queued the unsent save; two more saves join it
        assert_eq!(queued(&queue), 1);
        files.sync_if_changed("f1");
        files.sync_if_changed("f1");
        assert_eq!(queued(&queue), 1);
        let job = queue.0.lock().unwrap().remove(0);
        job();
        assert_eq!(r.client.bytes_of("f1"), b"v2");
        assert_eq!(
            uploads(&r).len(),
            1,
            "the extra requests found nothing new to send"
        );
        // once it ended, a new request starts a new run
        files.sync_if_changed("f1");
        assert_eq!(queued(&queue), 1);
    }

    #[test]
    fn a_save_seen_by_the_watcher_goes_up_after_the_debounce() {
        let r = rig_with("watch", 20);
        r.client.add("f1", "Plan.docx", "application/x", T1, b"v1");
        let path = opened(&r, "f1");
        let notify = r
            .shell
            .watch
            .lock()
            .unwrap()
            .clone()
            .expect("the cache folder is watched");
        edit(&path, b"v2");
        notify(Path::new("/elsewhere/other.docx"));
        notify(Path::new(&path));
        notify(Path::new(&path));
        let deadline = Instant::now() + Duration::from_secs(5);
        while r.client.bytes_of("f1") != b"v2" && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(r.client.bytes_of("f1"), b"v2");
        assert_eq!(uploads(&r).len(), 1, "a burst of writes uploads once");
        r.files.stop();
        assert!(!r.shell.watching.load(Ordering::SeqCst));
    }
}
