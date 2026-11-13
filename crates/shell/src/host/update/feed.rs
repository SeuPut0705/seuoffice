//! What electron-updater did for `updater.ts`, which the CEF build has no
//! Node for: read the feed the release publishes, decide whether it is newer,
//! download its file with the feed's sha512, and start the installer.
//!
//! The feed is the one the Electron build reads (so one release serves both):
//! `resources/app-update.yml` names the provider (`github` with `owner` and
//! `repo`, or `generic` with `url`), the channel file is `<channel>.yml`
//! (`latest`, `stable`) with `-mac` on macOS, its `files` the installer
//! (`.exe`) or the zips (`-arm64-mac.zip`, `-mac.zip`). On the GitHub
//! provider the release is the newest of `releases.atom` when pre-releases
//! count (the latest channel), else the one `/releases/latest` redirects to;
//! the release notes are every newer release's body, as `fullChangelog`.
//!
//! The download goes to `<cache>/<updaterCacheDirName>/pending/<file>`, the
//! folder electron-updater used, with its `update-info.json`, so
//! `update_cache` prunes what either left. A file already there with the
//! right sha512 is not downloaded again.
//!
//! As electron-updater did, the download is differential first
//! (`differential.rs`): the old file is the installer the last install kept
//! (`<cache>/<updaterCacheDirName>/installer.exe`, which `hooks.nsh` copies
//! there as electron-builder's installer did) or the zip the last macOS
//! update downloaded (`update.zip`), its block map `current.blockmap` beside
//! it, else the old version's `.blockmap` from the release. Unchanged blocks
//! are copied from the old file, the others downloaded one range request each
//! (the GitHub provider's way, no multipart ranges), and the result must match
//! the feed's sha512. Anything that goes wrong falls back to the whole file,
//! whose partial download (`<file>.part`) is resumed with a range request.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine;
use reqwest::header::{RANGE, USER_AGENT};
use tauri::async_runtime::block_on;

use super::differential::{BlockMap, Op, plan};
use main_core::shell::updater::{CheckResult, UpdateError, UpdaterEvent, UpdaterSetting};
use serde_json::{Value, json};
use sha2::{Digest, Sha512};

/// `app-update.yml`
#[derive(Clone, Debug, PartialEq)]
pub struct FeedConfig {
    pub provider: Provider,
    /// `updaterCacheDirName`
    pub cache_name: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Provider {
    GitHub {
        owner: String,
        repo: String,
    },
    /// `url` ends with `/`
    Generic {
        url: String,
    },
}

impl FeedConfig {
    pub fn read(path: &Path) -> Option<Self> {
        Self::parse(&fs::read_to_string(path).ok()?)
    }

    fn parse(text: &str) -> Option<Self> {
        let map = top_level(text);
        let get = |k: &str| map.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
        let provider = match get("provider")?.as_str() {
            "github" => Provider::GitHub {
                owner: get("owner")?,
                repo: get("repo")?,
            },
            "generic" => {
                let mut url = get("url")?;
                if !url.ends_with('/') {
                    url.push('/');
                }
                Provider::Generic { url }
            }
            _ => return None,
        };
        Some(FeedConfig {
            provider,
            cache_name: get("updaterCacheDirName").unwrap_or_else(|| "seuoffice-updater".into()),
        })
    }
}

/// One file of a release, as the channel file lists it
#[derive(Clone, Debug, PartialEq)]
pub struct ReleaseFile {
    pub url: String,
    pub sha512: String,
    pub size: Option<u64>,
}

/// The release a check found newer, kept for the download
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub version: String,
    /// where the files are: the release's tag folder, or the generic url
    pub base: String,
    pub file: ReleaseFile,
    /// the running version, whose release has the old block map
    pub current: String,
}

/// The new file's block map beside it in `pending`, and the old file's in the cache
const BLOCK_MAP_FILE: &str = "current.blockmap";
/// What the next differential download copies from: the file the last
/// install or update left in the cache folder
const OLD_FILE: &str = if cfg!(target_os = "macos") {
    "update.zip"
} else {
    "installer.exe"
};

/// Why a differential download did not give the file
enum Differential {
    Cancelled,
    Failed(String),
}

impl From<std::io::Error> for Differential {
    fn from(error: std::io::Error) -> Self {
        Differential::Failed(error.to_string())
    }
}

impl From<&str> for Differential {
    fn from(reason: &str) -> Self {
        Differential::Failed(reason.to_owned())
    }
}

impl From<String> for Differential {
    fn from(reason: String) -> Self {
        Differential::Failed(reason)
    }
}

/// What a check did: the events it emitted, its end, and the release to download
pub struct CheckOutcome {
    pub events: Vec<UpdaterEvent>,
    pub result: Result<Option<CheckResult>, UpdateError>,
    pub found: Option<Found>,
}

#[derive(Clone)]
pub struct Feed {
    config: FeedConfig,
    /// `autoUpdater.channel`; `None` is `latest`
    channel: Option<String>,
    allow_prerelease: bool,
    allow_downgrade: bool,
    found: Option<Found>,
}

impl Feed {
    pub fn new(config: FeedConfig) -> Self {
        Feed {
            config,
            channel: None,
            allow_prerelease: false,
            allow_downgrade: false,
            found: None,
        }
    }

    /// One assignment `initAutoUpdater` made on `autoUpdater`
    pub fn configure(&mut self, setting: &UpdaterSetting) {
        match setting {
            UpdaterSetting::Channel(channel) => self.channel = Some((*channel).to_owned()),
            UpdaterSetting::AllowPrerelease(on) => self.allow_prerelease = *on,
            UpdaterSetting::AllowDowngrade(on) => self.allow_downgrade = *on,
            // the rest is how this file works anyway: no automatic download,
            // the full changelog, no install at quit of its own
            _ => {}
        }
    }

    pub fn cache_dir(&self) -> PathBuf {
        dirs::cache_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join(&self.config.cache_name)
    }

    /// The core thread keeps what a check found, for the download
    pub fn remember(&mut self, outcome: &CheckOutcome) {
        if outcome.found.is_some() {
            self.found = outcome.found.clone();
        }
    }

    fn channel_file(&self) -> String {
        let channel = self.channel.as_deref().unwrap_or("latest");
        if cfg!(target_os = "macos") {
            format!("{channel}-mac.yml")
        } else {
            format!("{channel}.yml")
        }
    }

    /// `autoUpdater.checkForUpdates()`
    pub fn check(&self, current: &str) -> CheckOutcome {
        match self.check_inner(current) {
            Ok((result, found, notes)) => {
                let mut events = Vec::new();
                if let Some(found) = &found {
                    events.push(UpdaterEvent::UpdateAvailable {
                        version: found.version.clone(),
                        release_notes: notes,
                    });
                }
                CheckOutcome {
                    events,
                    result: Ok(Some(result)),
                    found,
                }
            }
            Err(error) => CheckOutcome {
                // electron-updater emits `error` and rejects
                events: vec![UpdaterEvent::Error(error.message.clone())],
                result: Err(error),
                found: None,
            },
        }
    }

    fn check_inner(
        &self,
        current: &str,
    ) -> Result<(CheckResult, Option<Found>, Value), UpdateError> {
        let (base, entries) = match &self.config.provider {
            Provider::Generic { url } => (url.clone(), Vec::new()),
            Provider::GitHub { owner, repo } => {
                let site = format!("https://github.com/{owner}/{repo}");
                let atom = get_text(&format!("{site}/releases.atom"))?;
                let entries = atom_entries(&atom);
                let tag = if self.allow_prerelease {
                    entries
                        .first()
                        .map(|e| e.tag.clone())
                        .ok_or_else(|| no_release("no release in the feed"))?
                } else {
                    latest_release_tag(&site)?
                };
                (format!("{site}/releases/download/{tag}/"), entries)
            }
        };
        let yml = get_text(&format!("{base}{}", self.channel_file()))?;
        let info = ChannelFile::parse(&yml).ok_or_else(|| {
            coded(
                "ERR_UPDATER_INVALID_RELEASE_FEED",
                "the channel file has no version",
            )
        })?;
        let newer = compare(&info.version, current) == std::cmp::Ordering::Greater
            || (self.allow_downgrade
                && compare(&info.version, current) == std::cmp::Ordering::Less);
        let pre = info.version.contains('-');
        let available = newer && (self.allow_prerelease || !pre);
        let result = CheckResult {
            is_update_available: available,
            update_version: Some(info.version.clone()),
        };
        if !available {
            return Ok((result, None, Value::Null));
        }
        let file = info.pick().ok_or_else(|| {
            coded(
                "ERR_UPDATER_INVALID_RELEASE_FEED",
                "no file for this platform",
            )
        })?;
        let notes = if entries.is_empty() {
            info.release_notes.map_or(Value::Null, Value::String)
        } else {
            // fullChangelog: every release newer than this one, up to the found one, newest first
            Value::Array(
                entries
                    .iter()
                    .filter(|e| {
                        let v = e.tag.trim_start_matches('v');
                        compare(v, current) == std::cmp::Ordering::Greater
                            && compare(v, &info.version) != std::cmp::Ordering::Greater
                    })
                    .map(|e| json!({ "version": e.tag.trim_start_matches('v'), "note": e.content }))
                    .collect(),
            )
        };
        let found = Found {
            version: info.version,
            base,
            file,
            current: current.to_owned(),
        };
        Ok((result, Some(found), notes))
    }

    /// `autoUpdater.downloadUpdate(token)`: emits progress and, at the end,
    /// `UpdateDownloaded`; answers its rejection, if any
    pub fn download(
        &self,
        cancel: &AtomicBool,
        emit: &dyn Fn(UpdaterEvent),
    ) -> Option<UpdateError> {
        let found = match &self.found {
            Some(found) => found.clone(),
            None => return Some(plain("no update to download: check first")),
        };
        match self.download_inner(&found, cancel, emit) {
            Ok(path) => {
                emit(UpdaterEvent::UpdateDownloaded {
                    version: found.version,
                    downloaded_file: Some(path.to_string_lossy().into_owned()),
                });
                None
            }
            Err(error) => Some(error),
        }
    }

    fn download_inner(
        &self,
        found: &Found,
        cancel: &AtomicBool,
        emit: &dyn Fn(UpdaterEvent),
    ) -> Result<PathBuf, UpdateError> {
        let name = found.file.url.rsplit('/').next().unwrap_or(&found.file.url);
        let pending = self.cache_dir().join("pending");
        fs::create_dir_all(&pending).map_err(io)?;
        let target = pending.join(name);
        if target.is_file()
            && sha512_of(&target).ok().as_deref() == Some(found.file.sha512.as_str())
        {
            return Ok(target);
        }
        // a block map an earlier round left belongs to another file
        let _ = fs::remove_file(pending.join(BLOCK_MAP_FILE));
        let part = pending.join(format!("{name}.part"));
        // a partial whole download resumes; otherwise the blocks come first
        if !part.exists() {
            let diff = pending.join(format!("{name}.diff"));
            match self.download_differential(found, &pending, &diff, cancel, emit) {
                Ok(()) => {
                    fs::rename(&diff, &part).map_err(io)?;
                    return self.keep(found, &pending, &part, &target);
                }
                Err(Differential::Cancelled) => {
                    let _ = fs::remove_file(&diff);
                    return Err(cancelled());
                }
                Err(Differential::Failed(reason)) => {
                    let _ = fs::remove_file(&diff);
                    eprintln!(
                        "shell: cannot download differentially, downloading the whole file: {reason}"
                    );
                }
            }
        }
        let url = format!("{}{}", found.base, found.file.url);
        let have = fs::metadata(&part).map_or(0, |m| m.len());
        let range = (have > 0).then(|| format!("bytes={have}-"));
        let mut response = send(&url, range).map_err(io)?;
        let status = response.status().as_u16();
        if status >= 400 {
            return Err(http(status));
        }
        let resumed = status == 206;
        let mut out = OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(&part)
            .map_err(io)?;
        let total = found
            .file
            .size
            .or_else(|| {
                response
                    .content_length()
                    .map(|l| l + if resumed { have } else { 0 })
            })
            .unwrap_or(0);
        let mut transferred = if resumed { have } else { 0 };
        let mut last_percent = -1.0;
        loop {
            if cancel.load(Ordering::Acquire) {
                return Err(cancelled());
            }
            let Some(chunk) = next_chunk(&mut response).map_err(io)? else {
                break;
            };
            out.write_all(&chunk).map_err(io)?;
            transferred += chunk.len() as u64;
            progress(emit, transferred, total, &mut last_percent);
        }
        out.sync_all().map_err(io)?;
        drop(out);
        let sum = sha512_of(&part).map_err(io)?;
        if sum != found.file.sha512 {
            let _ = fs::remove_file(&part);
            return Err(plain(&format!(
                "sha512 checksum mismatch, expected {}, got {sum}",
                found.file.sha512
            )));
        }
        self.keep(found, &pending, &part, &target)
    }

    /// The checked file becomes the pending update: only it, its block map
    /// and its `update-info.json` stay in `pending`. On macOS the zip and its
    /// block map are also what the next update copies blocks from; on Windows
    /// the installer puts itself there once it installed (`hooks.nsh`).
    fn keep(
        &self,
        found: &Found,
        pending: &Path,
        part: &Path,
        target: &Path,
    ) -> Result<PathBuf, UpdateError> {
        let block_map = pending.join(BLOCK_MAP_FILE);
        for entry in fs::read_dir(pending).map_err(io)?.flatten() {
            let path = entry.path();
            if path != part && path != block_map {
                let _ = fs::remove_file(path);
            }
        }
        fs::rename(part, target).map_err(io)?;
        let file_name = target.file_name().map(|n| n.to_string_lossy().into_owned());
        // electron-updater's DownloadedUpdateHelper record, which update_cache reads
        let info = json!({
            "fileName": file_name,
            "sha512": found.file.sha512,
            "isAdminRightsRequired": false,
        });
        fs::write(pending.join("update-info.json"), info.to_string()).map_err(io)?;
        if cfg!(target_os = "macos") {
            let cache = self.cache_dir();
            if fs::copy(target, cache.join(OLD_FILE)).is_err()
                || fs::copy(&block_map, cache.join(BLOCK_MAP_FILE)).is_err()
            {
                // a stale block map beside a fresh zip would only fail later
                let _ = fs::remove_file(cache.join(BLOCK_MAP_FILE));
            }
        }
        Ok(target.to_path_buf())
    }

    /// `differentialDownloadInstaller`: writes `out` from the old file's
    /// blocks and range requests; the new block map stays in `pending`
    fn download_differential(
        &self,
        found: &Found,
        pending: &Path,
        out: &Path,
        cancel: &AtomicBool,
        emit: &dyn Fn(UpdaterEvent),
    ) -> Result<(), Differential> {
        let cache = self.cache_dir();
        let old_path = cache.join(OLD_FILE);
        if !old_path.is_file() {
            return Err(format!("no {OLD_FILE} in the cache (a first update)").into());
        }
        let size = found
            .file
            .size
            .ok_or("the feed lists no size for the file")?;
        let url = format!("{}{}", found.base, found.file.url);
        let new_bytes = get_bytes(&format!("{url}.blockmap"))?;
        let new_map = BlockMap::parse(&new_bytes)?;
        fs::write(pending.join(BLOCK_MAP_FILE), &new_bytes)?;
        let cached = fs::read(cache.join(BLOCK_MAP_FILE))
            .ok()
            .and_then(|b| BlockMap::parse(&b).ok());
        let old_map = match cached {
            Some(map) => map,
            // the old version's file is named as the new one with its version
            None => BlockMap::parse(&get_bytes(&format!(
                "{}.blockmap",
                url.replace(&found.version, &found.current)
            ))?)?,
        };
        let ops = plan(&old_map, &new_map)?;
        let planned: u64 = ops.iter().map(Op::len).sum();
        if planned != size {
            return Err(
                format!("the block map covers {planned} bytes, the file has {size}").into(),
            );
        }
        let to_download: u64 = ops
            .iter()
            .filter(|op| matches!(op, Op::Download(_)))
            .map(Op::len)
            .sum();
        let mut old = File::open(&old_path)?;
        let mut writer = Hashing {
            out: std::io::BufWriter::with_capacity(1 << 20, File::create(out)?),
            hash: Sha512::new(),
        };
        // the redirect target of the first request serves the rest, as
        // electron-updater kept it
        let mut actual = url;
        let mut requests = 0u32;
        let mut transferred = 0u64;
        let mut last_percent = -1.0;
        for op in &ops {
            if cancel.load(Ordering::Acquire) {
                return Err(Differential::Cancelled);
            }
            match op {
                Op::Copy(range) => {
                    old.seek(SeekFrom::Start(range.start))?;
                    let copied = std::io::copy(&mut (&mut old).take(op.len()), &mut writer)?;
                    if copied != op.len() {
                        return Err(format!("{OLD_FILE} is shorter than its block map").into());
                    }
                }
                Op::Download(range) => {
                    let bytes = format!("bytes={}-{}", range.start, range.end - 1);
                    let mut response = send(&actual, Some(bytes))?;
                    if response.status().as_u16() != 206 {
                        return Err(format!(
                            "a range request was answered {}",
                            response.status().as_u16()
                        )
                        .into());
                    }
                    actual = response.url().to_string();
                    let mut got = 0u64;
                    loop {
                        if cancel.load(Ordering::Acquire) {
                            return Err(Differential::Cancelled);
                        }
                        let Some(chunk) = next_chunk(&mut response)? else {
                            break;
                        };
                        writer.write_all(&chunk)?;
                        got += chunk.len() as u64;
                        transferred += chunk.len() as u64;
                        progress(emit, transferred, to_download, &mut last_percent);
                    }
                    if got != op.len() {
                        return Err(format!("a range gave {got} bytes of {}", op.len()).into());
                    }
                    // electron-updater rests a second every 100 ranges
                    requests += 1;
                    if requests.is_multiple_of(100) {
                        std::thread::sleep(Duration::from_secs(1));
                    }
                }
            }
        }
        writer.out.flush()?;
        writer.out.get_ref().sync_all()?;
        let sum = base64::engine::general_purpose::STANDARD.encode(writer.hash.finalize());
        if sum != found.file.sha512 {
            return Err(format!(
                "sha512 checksum mismatch after the differential download: {OLD_FILE} and its block map disagree"
            )
            .into());
        }
        Ok(())
    }

    /// `updater.install(isSilent, isForceRunAfter)` of electron-updater's
    /// NsisUpdater: the installer with `--updated`, `/S` when silent and
    /// `--force-run`, detached, as the app is about to end. macOS installs by
    /// the bundle swap instead.
    pub fn start_installer(&self, silent: bool, force_run_after: bool) -> bool {
        if !cfg!(windows) {
            return false;
        }
        let Some(found) = &self.found else {
            return false;
        };
        let name = found.file.url.rsplit('/').next().unwrap_or(&found.file.url);
        let installer = self.cache_dir().join("pending").join(name);
        if !installer.is_file() {
            return false;
        }
        let mut command = std::process::Command::new(&installer);
        // `--updated` as electron-updater passed it (hooks.nsh reads it),
        // `/UPDATE` for Tauri's own pages: an update never offers to uninstall
        command.arg("--updated").arg("/UPDATE");
        if silent {
            command.arg("/S");
        }
        if force_run_after {
            command.arg("--force-run");
        }
        detach(&mut command);
        command.spawn().is_ok()
    }
}

#[cfg(windows)]
fn detach(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: it outlives the app
    command.creation_flags(0x0000_0008 | 0x0000_0200);
}

#[cfg(not(windows))]
fn detach(_: &mut std::process::Command) {}

// ---- HTTP ----

/// How long a request may wait for its answer, or a body for its next piece
const STALL: Duration = Duration::from_secs(60);

/// A GET through the shell's one HTTP client (`host/net/http.rs`): the
/// system proxy and TLS, a loopback feed direct, redirects followed. The
/// download runs on a thread of its own, which waits for the async client.
fn send(url: &str, range: Option<String>) -> std::io::Result<reqwest::Response> {
    let mut request = crate::host::net::http::client(url, true)
        .get(url)
        .header(USER_AGENT, format!("SeuOffice/{}", super::app_version()));
    if let Some(range) = range {
        request = request.header(RANGE, range);
    }
    // the timer belongs to the runtime: made inside it
    match block_on(async { tokio::time::timeout(STALL, request.send()).await }) {
        Ok(response) => response.map_err(std::io::Error::other),
        Err(_) => Err(stalled(url)),
    }
}

/// The next piece of a body, `None` at its end
fn next_chunk(response: &mut reqwest::Response) -> std::io::Result<Option<bytes::Bytes>> {
    let url = response.url().to_string();
    match block_on(async { tokio::time::timeout(STALL, response.chunk()).await }) {
        Ok(chunk) => chunk.map_err(std::io::Error::other),
        Err(_) => Err(stalled(&url)),
    }
}

fn stalled(url: &str) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        format!("{url} sent nothing for {} s", STALL.as_secs()),
    )
}

/// A whole small file (the feed, a block map)
fn get_whole(url: &str) -> std::io::Result<(u16, Vec<u8>)> {
    let mut response = send(url, None)?;
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while let Some(chunk) = next_chunk(&mut response)? {
        body.extend_from_slice(&chunk);
    }
    Ok((status, body))
}

fn get_text(url: &str) -> Result<String, UpdateError> {
    let (status, body) = get_whole(url).map_err(io)?;
    if status >= 400 {
        return Err(http(status));
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

fn get_bytes(url: &str) -> Result<Vec<u8>, String> {
    let (status, body) = get_whole(url).map_err(|e| e.to_string())?;
    if status >= 400 {
        return Err(format!("{url} answered {status}"));
    }
    Ok(body)
}

/// The file being written, hashed as it goes
struct Hashing {
    out: std::io::BufWriter<File>,
    hash: Sha512,
}

impl Write for Hashing {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let n = self.out.write(data)?;
        self.hash.update(&data[..n]);
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.out.flush()
    }
}

/// `download-progress` once per whole percent of `total`
fn progress(emit: &dyn Fn(UpdaterEvent), transferred: u64, total: u64, last_percent: &mut f64) {
    if total == 0 {
        return;
    }
    let percent = transferred as f64 * 100.0 / total as f64;
    if percent.floor() > *last_percent {
        *last_percent = percent.floor();
        emit(UpdaterEvent::DownloadProgress {
            transferred: transferred as f64,
            percent,
        });
    }
}

fn cancelled() -> UpdateError {
    coded("ERR_UPDATER_DOWNLOAD_CANCELLED", "cancelled")
}

/// The tag `/releases/latest` redirects to (`.../releases/tag/<tag>`)
fn latest_release_tag(site: &str) -> Result<String, UpdateError> {
    let response = send(&format!("{site}/releases/latest"), None).map_err(io)?;
    let status = response.status().as_u16();
    if status >= 400 {
        return Err(http(status));
    }
    let path = response.url().path().to_owned();
    path.rsplit_once("/releases/tag/")
        .map(|(_, tag)| tag.to_owned())
        .ok_or_else(|| no_release("no latest release"))
}

fn plain(message: &str) -> UpdateError {
    UpdateError {
        code: None,
        message: message.to_owned(),
    }
}

fn coded(code: &str, message: &str) -> UpdateError {
    UpdateError {
        code: Some(code.to_owned()),
        message: message.to_owned(),
    }
}

fn no_release(message: &str) -> UpdateError {
    coded("ERR_UPDATER_LATEST_VERSION_NOT_FOUND", message)
}

/// electron-updater's HttpError: its code names the status
fn http(status: u16) -> UpdateError {
    coded(
        &format!("HTTP_ERROR_{status}"),
        &format!("HttpError: {status}"),
    )
}

fn io(error: std::io::Error) -> UpdateError {
    plain(&error.to_string())
}

fn sha512_of(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha512::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(hasher.finalize()))
}

// ---- the feed's formats ----

/// `key: value` lines at the top level of a YAML file, quotes taken off
fn top_level(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter(|l| !l.starts_with(' ') && !l.starts_with('-') && !l.starts_with('#'))
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), unquote(v.trim())))
        .collect()
}

fn unquote(value: &str) -> String {
    let v = value.trim();
    if v.len() >= 2
        && ((v.starts_with('\'') && v.ends_with('\'')) || (v.starts_with('"') && v.ends_with('"')))
    {
        v[1..v.len() - 1].to_owned()
    } else {
        v.to_owned()
    }
}

/// `latest.yml` and its kin, as electron-builder writes them
#[derive(Debug, PartialEq)]
struct ChannelFile {
    version: String,
    files: Vec<ReleaseFile>,
    release_notes: Option<String>,
}

impl ChannelFile {
    fn parse(text: &str) -> Option<Self> {
        let mut version = None;
        let mut release_notes = None;
        let mut files: Vec<ReleaseFile> = Vec::new();
        let mut in_files = false;
        for line in text.lines() {
            if !line.starts_with(' ') && !line.starts_with('-') {
                in_files = line.starts_with("files:");
                if let Some((k, v)) = line.split_once(':') {
                    match k.trim() {
                        "version" => version = Some(unquote(v)),
                        "releaseNotes" => {
                            release_notes = Some(unquote(v)).filter(|s| !s.is_empty())
                        }
                        _ => {}
                    }
                }
                continue;
            }
            if !in_files {
                continue;
            }
            let item = line.trim_start();
            let (fresh, field) = match item.strip_prefix("- ") {
                Some(rest) => (true, rest),
                None => (false, item),
            };
            if fresh {
                files.push(ReleaseFile {
                    url: String::new(),
                    sha512: String::new(),
                    size: None,
                });
            }
            let (Some(file), Some((k, v))) = (files.last_mut(), field.split_once(':')) else {
                continue;
            };
            match k.trim() {
                "url" => file.url = unquote(v),
                "sha512" => file.sha512 = unquote(v),
                "size" => file.size = unquote(v).parse().ok(),
                _ => {}
            }
        }
        Some(ChannelFile {
            version: version.filter(|v| !v.is_empty())?,
            files: files.into_iter().filter(|f| !f.url.is_empty()).collect(),
            release_notes,
        })
    }

    /// The file this platform installs
    fn pick(&self) -> Option<ReleaseFile> {
        let fits = |url: &str| {
            if cfg!(target_os = "macos") {
                // MacUpdater's findFile(files, "zip") after filterFilesForArch;
                // the stable build's zip ends in -mac-stable.zip
                let arm = url.contains("arm64");
                url.ends_with(".zip") && arm == cfg!(target_arch = "aarch64")
            } else {
                url.ends_with(".exe")
            }
        };
        self.files.iter().find(|f| fits(&f.url)).cloned()
    }
}

/// One release of `releases.atom`
#[derive(Debug, PartialEq)]
struct AtomEntry {
    tag: String,
    /// the release body, HTML
    content: String,
}

fn atom_entries(atom: &str) -> Vec<AtomEntry> {
    atom.split("<entry>")
        .skip(1)
        .filter_map(|entry| {
            let tag = entry.split("/releases/tag/").nth(1)?.split('"').next()?;
            let content = entry
                .split_once("<content type=\"html\">")
                .and_then(|(_, rest)| rest.split_once("</content>"))
                .map_or("", |(c, _)| c);
            Some(AtomEntry {
                tag: tag.to_owned(),
                content: xml_unescape(content),
            })
        })
        .collect()
}

fn xml_unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// semver order: numbers first, then a pre-release below its release
fn compare(a: &str, b: &str) -> std::cmp::Ordering {
    let split = |v: &str| {
        let v = v.trim_start_matches('v');
        let (core, pre) = v
            .split_once('-')
            .map_or((v, None), |(c, p)| (c, Some(p.to_owned())));
        let nums: Vec<u64> = core.split('.').map(|n| n.parse().unwrap_or(0)).collect();
        (nums, pre)
    };
    let (an, ap) = split(a);
    let (bn, bp) = split(b);
    an.cmp(&bn).then_with(|| match (ap, bp) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(x), Some(y)) => x.cmp(&y),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LATEST_YML: &str = "version: 0.13.0
files:
  - url: SeuOffice-Setup-0.13.0.exe
    sha512: AAA==
    size: 165000000
  - url: SeuOffice-0.13.0-arm64-mac.zip
    sha512: BBB==
    size: 180000000
  - url: SeuOffice-0.13.0-mac.zip
    sha512: CCC==
    size: 190000000
path: SeuOffice-Setup-0.13.0.exe
sha512: AAA==
releaseDate: '2026-11-14T00:00:00.000Z'
";

    #[test]
    fn the_channel_file_names_the_version_and_this_platforms_file() {
        let file = ChannelFile::parse(LATEST_YML).unwrap();
        assert_eq!(file.version, "0.13.0");
        assert_eq!(file.files.len(), 3);
        let picked = file.pick().unwrap();
        if cfg!(windows) {
            assert_eq!(picked.url, "SeuOffice-Setup-0.13.0.exe");
            assert_eq!(picked.size, Some(165_000_000));
        } else if cfg!(target_arch = "aarch64") {
            assert_eq!(picked.url, "SeuOffice-0.13.0-arm64-mac.zip");
        } else {
            assert_eq!(picked.url, "SeuOffice-0.13.0-mac.zip");
        }
        assert!(ChannelFile::parse("files:\n").is_none());
        // the stable build's zip carries the channel in its name
        let stable = ChannelFile::parse(
            "version: 0.13.0\nfiles:\n  - url: SeuOffice-0.13.0-arm64-mac-stable.zip\n    sha512: DDD==\n  - url: SeuOffice-0.13.0-arm64-stable.dmg\n    sha512: EEE==\n",
        )
        .unwrap();
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert_eq!(
                stable.pick().unwrap().url,
                "SeuOffice-0.13.0-arm64-mac-stable.zip"
            );
        }
    }

    #[test]
    fn app_update_yml_as_electron_builder_and_the_migration_test_write_it() {
        let github = FeedConfig::parse(
            "owner: SeuPut0705\nrepo: seuoffice\nprovider: github\nupdaterCacheDirName: seuoffice-updater\nchannel: latest\n",
        )
        .unwrap();
        assert_eq!(
            github.provider,
            Provider::GitHub {
                owner: "SeuPut0705".into(),
                repo: "seuoffice".into()
            }
        );
        let generic =
            FeedConfig::parse("provider: generic\nurl: http://127.0.0.1:8765\nchannel: stable\n")
                .unwrap();
        assert_eq!(
            generic.provider,
            Provider::Generic {
                url: "http://127.0.0.1:8765/".into()
            }
        );
        assert_eq!(generic.cache_name, "seuoffice-updater");
        assert!(FeedConfig::parse("provider: s3\n").is_none());
    }

    #[test]
    fn versions_order_as_semver() {
        use std::cmp::Ordering::*;
        assert_eq!(compare("0.13.0", "0.12.41"), Greater);
        assert_eq!(compare("0.12.10", "0.12.9"), Greater);
        assert_eq!(compare("v0.13.0", "0.13.0"), Equal);
        assert_eq!(compare("0.13.0-beta.1", "0.13.0"), Less);
        assert_eq!(compare("0.13.0", "0.13.0-beta.1"), Greater);
    }

    #[test]
    fn the_atom_feed_gives_tags_and_bodies_newest_first() {
        let atom = r#"<feed><entry><link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/v0.13.1"/><content type="html">&lt;p&gt;fix &amp;amp; more&lt;/p&gt;</content></entry><entry><link href="https://github.com/o/r/releases/tag/v0.13.0"/><content type="html">&lt;h2&gt;new&lt;/h2&gt;</content></entry></feed>"#;
        let entries = atom_entries(atom);
        assert_eq!(
            entries,
            vec![
                AtomEntry {
                    tag: "v0.13.1".into(),
                    content: "<p>fix &amp; more</p>".into()
                },
                AtomEntry {
                    tag: "v0.13.0".into(),
                    content: "<h2>new</h2>".into()
                },
            ]
        );
    }

    #[test]
    fn a_check_on_a_generic_feed_finds_a_newer_release_once() {
        let dir = std::env::temp_dir().join(format!("seuoffice-feed-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let channel = if cfg!(target_os = "macos") {
            "latest-mac.yml"
        } else {
            "latest.yml"
        };
        std::thread::spawn(move || {
            for stream in listener.incoming().take(2).flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let (status, body) = if request.starts_with(&format!("GET /{channel} ")) {
                    ("200 OK", LATEST_YML)
                } else {
                    ("404 Not Found", "")
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        let feed = Feed::new(FeedConfig {
            provider: Provider::Generic {
                url: format!("http://127.0.0.1:{port}/"),
            },
            cache_name: "unused".into(),
        });
        let newer = feed.check("0.12.41");
        assert_eq!(
            newer.result,
            Ok(Some(CheckResult {
                is_update_available: true,
                update_version: Some("0.13.0".into())
            }))
        );
        assert!(
            matches!(&newer.events[..], [UpdaterEvent::UpdateAvailable { version, .. }] if version == "0.13.0")
        );
        let same = feed.check("0.13.0");
        assert_eq!(
            same.result,
            Ok(Some(CheckResult {
                is_update_available: false,
                update_version: Some("0.13.0".into())
            }))
        );
        assert!(same.events.is_empty() && same.found.is_none());
        let _ = fs::remove_dir_all(dir);
    }

    /// A release server: the new file (ranges too) and both block maps;
    /// answers the request lines it got
    fn release_server(
        new_file: Vec<u8>,
        maps: Vec<(&'static str, Vec<u8>)>,
    ) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).to_lowercase();
                let path = head.split(' ').nth(1).unwrap_or("").to_owned();
                let range = head
                    .lines()
                    .find_map(|l| l.strip_prefix("range: bytes="))
                    .and_then(|r| r.split_once('-'))
                    .map(|(a, b)| a.parse::<usize>().unwrap()..b.parse::<usize>().unwrap() + 1);
                log.lock().unwrap().push(match &range {
                    Some(r) => format!("{path} {}-{}", r.start, r.end),
                    None => path.clone(),
                });
                let (status, body) = if path == "/seuoffice-setup-0.13.0.exe" {
                    match range {
                        Some(r) => ("206 Partial Content", new_file[r].to_vec()),
                        None => ("200 OK", new_file.clone()),
                    }
                } else if let Some((_, map)) =
                    maps.iter().find(|(name, _)| path == format!("/{name}"))
                {
                    ("200 OK", map.clone())
                } else {
                    ("404 Not Found", Vec::new())
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(&body);
            }
        });
        (port, seen)
    }

    fn gzip_map(blocks: &[(&str, usize)]) -> Vec<u8> {
        let files = json!([{
            "name": "file",
            "offset": 0,
            "checksums": blocks.iter().map(|b| b.0).collect::<Vec<_>>(),
            "sizes": blocks.iter().map(|b| b.1).collect::<Vec<_>>(),
        }]);
        let text = json!({ "version": "2", "files": files }).to_string();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(text.as_bytes()).unwrap();
        gz.finish().unwrap()
    }

    fn block(seed: u8, len: usize) -> Vec<u8> {
        (0..len)
            .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
            .collect()
    }

    #[test]
    fn an_update_downloads_only_the_changed_blocks_and_falls_back_to_the_whole_file() {
        let (a, b, c, x, y) = (
            block(1, 5000),
            block(2, 3000),
            block(3, 4000),
            block(4, 1000),
            block(5, 2000),
        );
        let old_file = [a.clone(), b, c.clone()].concat();
        let new_file = [a, x, c, y].concat();
        let (port, seen) = release_server(
            new_file.clone(),
            vec![
                (
                    "seuoffice-setup-0.13.0.exe.blockmap",
                    gzip_map(&[("A", 5000), ("X", 1000), ("C", 4000), ("Y", 2000)]),
                ),
                (
                    "seuoffice-setup-0.12.41.exe.blockmap",
                    gzip_map(&[("A", 5000), ("B", 3000), ("C", 4000)]),
                ),
            ],
        );
        let cache = std::env::temp_dir().join(format!("seuoffice-diff-{}", std::process::id()));
        let _ = fs::remove_dir_all(&cache);
        fs::create_dir_all(&cache).unwrap();
        let mut feed = Feed::new(FeedConfig {
            provider: Provider::Generic {
                url: format!("http://127.0.0.1:{port}/"),
            },
            // an absolute name replaces the cache folder
            cache_name: cache.to_string_lossy().into_owned(),
        });
        let sha512 = base64::engine::general_purpose::STANDARD.encode(Sha512::digest(&new_file));
        feed.found = Some(Found {
            version: "0.13.0".into(),
            base: format!("http://127.0.0.1:{port}/"),
            file: ReleaseFile {
                url: "seuoffice-setup-0.13.0.exe".into(),
                sha512,
                size: Some(new_file.len() as u64),
            },
            current: "0.12.41".into(),
        });
        let events = std::sync::Mutex::new(Vec::new());
        let emit = |e: UpdaterEvent| events.lock().unwrap().push(e);
        let target = cache.join("pending").join("seuoffice-setup-0.13.0.exe");

        // the old file and no cached block map: the old one comes from the release
        fs::write(cache.join(OLD_FILE), &old_file).unwrap();
        assert_eq!(feed.download(&AtomicBool::new(false), &emit), None);
        assert_eq!(fs::read(&target).unwrap(), new_file);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                "/seuoffice-setup-0.13.0.exe.blockmap",
                "/seuoffice-setup-0.12.41.exe.blockmap",
                "/seuoffice-setup-0.13.0.exe 5000-6000",
                "/seuoffice-setup-0.13.0.exe 10000-12000",
            ]
        );
        assert!(cache.join("pending").join(BLOCK_MAP_FILE).is_file());
        let info: Value =
            serde_json::from_slice(&fs::read(cache.join("pending/update-info.json")).unwrap())
                .unwrap();
        assert_eq!(info["fileName"], "seuoffice-setup-0.13.0.exe");
        assert!(matches!(
            events.lock().unwrap().last(),
            Some(UpdaterEvent::UpdateDownloaded { version, .. }) if version == "0.13.0"
        ));
        if cfg!(target_os = "macos") {
            // the next update copies from this zip and its block map
            assert_eq!(fs::read(cache.join(OLD_FILE)).unwrap(), new_file);
            assert!(cache.join(BLOCK_MAP_FILE).is_file());
        }

        // an old file that does not match its block map: the whole file
        fs::remove_dir_all(cache.join("pending")).unwrap();
        let _ = fs::remove_file(cache.join(BLOCK_MAP_FILE));
        let mut broken = old_file.clone();
        broken[0] ^= 0xff;
        fs::write(cache.join(OLD_FILE), &broken).unwrap();
        seen.lock().unwrap().clear();
        assert_eq!(feed.download(&AtomicBool::new(false), &emit), None);
        assert_eq!(fs::read(&target).unwrap(), new_file);
        assert_eq!(
            seen.lock().unwrap().last().map(String::as_str),
            Some("/seuoffice-setup-0.13.0.exe")
        );
        let _ = fs::remove_dir_all(&cache);
    }
}
