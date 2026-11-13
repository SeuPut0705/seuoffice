//! `apps/shell/src/main/updater.ts`: auto-update from the GitHub Releases of
//! the product's public repository.
//!
//! What stays with the caller (decision 0030: electron-updater stays in
//! Electron until stage 3): the electron-updater object, the update window,
//! `app`, `shell`, `dialog`, the timers and the process. They are the
//! [`UpdaterHost`] (methods that act) and the [`UpdaterEnv`] (the clock and
//! the console, which the logger shares). The judgment is here: what to show,
//! when to check, the transitions of the update flow, which files and records
//! are written.
//!
//! The module-level state of the TypeScript (`started`, `dismissedVersion`,
//! the flow state `initAutoUpdater` closes over, ...) is an [`Updater`] the
//! caller owns. Promises are plain calls, with these differences:
//!
//! - a check and a download are awaited for as long as the network takes, so
//!   they are [`UpdaterStep`]s the shell runs on a worker: the method that
//!   starts one answers [`UpdaterStep::StartCheck`] or
//!   [`UpdaterStep::StartDownload`], what electron-updater emits meanwhile
//!   (progress, `update-available`, errors) goes to [`Updater::on_event`] on
//!   the core thread as it happens, and the end of the call goes to
//!   [`Updater::resume_check`] or [`Updater::resume_download`];
//! - the timers are [`Timer`]s the host schedules and runs through
//!   [`Updater::check`], [`Updater::clear_installed_cache`],
//!   [`Updater::fake_show_again`] and [`Updater::fake_progress`];
//! - the `update-window` actions are [`Updater::on_action`], and `will-quit`
//!   is [`Updater::on_will_quit`];
//! - `clearInstalledCache` awaits the updater's download helper: its call is
//!   made where the TypeScript makes it and its continuation runs when
//!   [`Updater::init_auto_updater`] is about to return, where the
//!   microtask would.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use jscompat::node_path::host::{dirname, join};
use jscompat::{JsObject, JsonValue, date_parse, number_to_string, to_iso_string};
use serde::Serialize;
use serde_json::Value;

use crate::packages::electron_utils::github_menu::{
    GITHUB_LATEST_RELEASE_URL, github_release_tag_url,
};
use crate::packages::electron_utils::message_box::MessageBoxOptions;
use crate::packages::i18n::{I18n, Lang, create_i18n, html_lang};
use crate::shell::mac_update::{
    MacSelfUpdateBlock, SpawnOptions, StartMacSwap, SwapChild, default_writable,
    install_mac_staging, mac_app_bundle, mac_self_update_block, remove_mac_leftovers,
    stage_mac_update, staged_update_downloaded, start_mac_swap,
};
use crate::shell::update_attempt::{
    InstallAttempt, clear_install_attempt, install_did_not_apply, install_dir_writable,
    install_failure_level, next_attempt_tries, read_install_attempt, record_install_attempt,
};
use crate::shell::update_build_channel::BuildUpdateChannel;
use crate::shell::update_cache::prune_update_cache;
use crate::shell::update_log::{
    LogMessage, StepField, UPDATE_LOG_FILE, UPDATE_LOG_MAX_BYTES, UpdateLog, UpdateSteps,
    create_update_log, create_update_steps, file_bytes,
};
use crate::shell::update_notes::{UpdateReleaseNotes, normalize_release_notes};
use crate::shell::update_restart::UpdateRestart;

/// `FIRST_CHECK_DELAY_MS`
pub const FIRST_CHECK_DELAY_MS: f64 = 15_000.0;
/// `RECHECK_INTERVAL_MS`: hourly, the latest channel gets a release for every green push to main
pub const RECHECK_INTERVAL_MS: f64 = 60.0 * 60.0 * 1000.0;
/// `CACHE_RETRY_DELAY_MS`: a cache file the installer still held at the start is tried again this often
pub const CACHE_RETRY_DELAY_MS: f64 = 30_000.0;
/// `CACHE_RETRIES`: ...this many times
pub const CACHE_RETRIES: u32 = 4;
/// `MANUAL_FALLBACK_AFTER`: after this many failed attempts for the same
/// version the dialog stops offering "retry"
pub const MANUAL_FALLBACK_AFTER: f64 = 2.0;

fn dictionary(entries: &[(&str, &str)]) -> JsObject<String> {
    let mut dict = JsObject::new();
    for (key, text) in entries {
        dict.set(*key, (*text).to_owned());
    }
    dict
}

/// `tUpd`
pub fn updater_i18n() -> I18n {
    create_i18n(
        dictionary(&[
            ("updTitle", "Software Update"),
            ("updHeadline", "A new version is available"),
            (
                "updDesc",
                "This update includes performance improvements and bug fixes. We recommend updating now.",
            ),
            ("updDownload", "Update Now"),
            ("updLater", "Minimize"),
            ("updInstall", "Restart & Install"),
            ("updDownloading", "Downloading update…"),
            (
                "updFailed",
                "Update download failed. Check your network and try again.",
            ),
            ("updRetry", "Retry"),
            (
                "updManual",
                "Automatic update failed. Please get the latest version from the download page and install it manually.",
            ),
            ("updUpToDate", "You're up to date (version {version})."),
            (
                "updCheckFailed",
                "Couldn't check for updates. Check your network and try again.",
            ),
            ("updOpenDownload", "Open Download Page"),
            ("updNotesLabel", "What's new"),
            ("updNotesOnGitHub", "View full notes on GitHub"),
            ("updNotesTruncated", "Only part of the notes is shown."),
            (
                "updManualMac",
                "This Mac can't install the update automatically. Download the new version from the download page and put it in the Applications folder. If you opened the app straight from the disk image, move it to Applications and later updates install by themselves.",
            ),
            (
                "updInstallFailed",
                "The last update did not install. This time the installer opens in its own window so you can see its progress.",
            ),
            (
                "updVisibleInstall",
                "After the restart an installer window shows the progress. If Windows asks for administrator approval, choose Yes. When it finishes, the app and the documents you had open come back.",
            ),
            (
                "updRestartNote",
                "After the restart an installer window shows the progress. When it finishes, the app and the documents you had open come back.",
            ),
            (
                "updRestartNoteMac",
                "The app closes, is replaced with the new version and opens again, along with the documents you had open.",
            ),
        ]),
        dictionary(&[
            ("updTitle", "소프트웨어 업데이트"),
            ("updHeadline", "새 버전이 있습니다"),
            (
                "updDesc",
                "이 업데이트에는 성능 개선과 버그 수정이 포함되어 있습니다. 지금 업데이트하는 것을 권장합니다.",
            ),
            ("updDownload", "지금 업데이트"),
            ("updLater", "최소화"),
            ("updInstall", "다시 시작 및 설치"),
            ("updDownloading", "업데이트 다운로드 중…"),
            (
                "updFailed",
                "업데이트 다운로드에 실패했습니다. 네트워크를 확인한 후 다시 시도하세요.",
            ),
            ("updRetry", "다시 시도"),
            (
                "updManual",
                "자동 업데이트에 실패했습니다. 다운로드 페이지에서 최신 버전을 받아 직접 설치해 주세요.",
            ),
            ("updUpToDate", "최신 버전입니다 (버전 {version})."),
            (
                "updCheckFailed",
                "업데이트를 확인할 수 없습니다. 네트워크를 확인한 후 다시 시도하세요.",
            ),
            ("updOpenDownload", "다운로드 페이지 열기"),
            ("updNotesLabel", "업데이트 내용"),
            ("updNotesOnGitHub", "GitHub에서 전체 보기"),
            ("updNotesTruncated", "일부만 표시했습니다."),
            (
                "updManualMac",
                "이 Mac에서는 업데이트를 자동으로 설치할 수 없습니다. 다운로드 페이지에서 새 버전을 받아 응용 프로그램 폴더에 넣어 주세요. 디스크 이미지에서 앱을 바로 열었다면 응용 프로그램 폴더로 옮겨 두세요. 다음 업데이트부터는 저절로 설치됩니다.",
            ),
            (
                "updInstallFailed",
                "지난번 업데이트가 설치되지 않았습니다. 이번에는 설치 프로그램을 창으로 띄워 진행 상황을 보여 드립니다.",
            ),
            (
                "updVisibleInstall",
                "다시 시작하면 설치 진행 창이 뜹니다. 관리자 승인을 묻는 창이 나오면 '예'를 눌러 주세요. 설치가 끝나면 앱과 열려 있던 문서가 다시 열립니다.",
            ),
            (
                "updRestartNote",
                "다시 시작하면 설치 진행 창이 뜹니다. 설치가 끝나면 앱과 열려 있던 문서가 다시 열립니다.",
            ),
            (
                "updRestartNoteMac",
                "앱이 닫히고 새 버전으로 바뀐 뒤 다시 열립니다. 열어 두었던 문서도 다시 열립니다.",
            ),
        ]),
    )
}

/// `manualDownloadUrlFor`: where a manual install starts, the repository's own
/// release pages, never a URL taken from remotely fetched update metadata
pub fn manual_download_url_for(version: Option<&str>) -> String {
    match version {
        Some(version) => github_release_tag_url(version),
        None => GITHUB_LATEST_RELEASE_URL.to_owned(),
    }
}

/// `NO_RELEASE_ERROR_CODES`: the repository has nothing to offer this install
const NO_RELEASE_ERROR_CODES: [&str; 6] = [
    "ERR_XML_MISSED_ELEMENT",
    "ERR_UPDATER_NO_PUBLISHED_VERSIONS",
    "ERR_UPDATER_INVALID_RELEASE_FEED",
    "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
    "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    "HTTP_ERROR_404",
];

/// what electron-updater rejects with: its `code` (when a string) and `message`
#[derive(Debug, Clone, PartialEq)]
pub struct UpdateError {
    pub code: Option<String>,
    pub message: String,
}

/// `isNoReleaseError`
pub fn is_no_release_error(err: &UpdateError) -> bool {
    err.code
        .as_deref()
        .is_some_and(|code| NO_RELEASE_ERROR_CODES.contains(&code))
}

/// `UpdatePhase`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum UpdatePhase {
    #[serde(rename = "available")]
    Available,
    #[serde(rename = "downloading")]
    Downloading,
    #[serde(rename = "downloaded")]
    Downloaded,
    #[serde(rename = "error")]
    Error,
    #[serde(rename = "manual")]
    Manual,
    #[serde(rename = "install-failed")]
    InstallFailed,
}

impl UpdatePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            UpdatePhase::Available => "available",
            UpdatePhase::Downloading => "downloading",
            UpdatePhase::Downloaded => "downloaded",
            UpdatePhase::Error => "error",
            UpdatePhase::Manual => "manual",
            UpdatePhase::InstallFailed => "install-failed",
        }
    }
}

/// `UpdateUiStrings`, its keys in the order of the interface
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUiStrings {
    pub title: String,
    pub headline: String,
    pub desc: String,
    pub download: String,
    pub later: String,
    pub install: String,
    pub downloading: String,
    pub failed: String,
    pub retry: String,
    pub manual_desc: String,
    pub install_failed_desc: String,
    pub visible_install_desc: String,
    pub restart_desc: String,
    pub open_download: String,
    pub notes_label: String,
    pub notes_on_git_hub: String,
    pub notes_truncated: String,
}

/// `UpdateUiState`, its keys in the order `initialState` writes them
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUiState {
    pub phase: UpdatePhase,
    pub version: String,
    pub current_version: String,
    pub percent: f64,
    pub lang: String,
    pub strings: UpdateUiStrings,
    pub release_notes: Option<UpdateReleaseNotes>,
    pub visible_install: bool,
}

/// the `patch` of `pushUpdateState`, its keys in the order the literals write them
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatePatch {
    pub phase: UpdatePhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible_install: Option<bool>,
}

/// what electron-updater emits
#[derive(Debug, Clone, PartialEq)]
pub enum UpdaterEvent {
    /// `error`: `err?.message ?? err` as text
    Error(String),
    /// `update-available`
    UpdateAvailable {
        version: String,
        /// `info.releaseNotes` as JSON (`null` for `undefined`)
        release_notes: Value,
    },
    /// `download-progress`
    DownloadProgress { transferred: f64, percent: f64 },
    /// `updateDownloaded(fileInfo, event)` of the updater, the event it
    /// dispatches as `update-downloaded` once the Mac staging has run
    UpdateDownloaded {
        version: String,
        downloaded_file: Option<String>,
    },
}

/// `result?.isUpdateAvailable` and `result.updateInfo?.version` of `checkForUpdates()`
#[derive(Debug, Clone, PartialEq)]
pub struct CheckResult {
    pub is_update_available: bool,
    pub update_version: Option<String>,
}

/// What the shell does next: the awaits of the TypeScript that take time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdaterStep {
    /// nothing to run
    Idle,
    /// `await autoUpdater.checkForUpdates()`: run it on a worker. Whatever the
    /// updater emits meanwhile goes to [`Updater::on_event`], on the core
    /// thread, as it happens. Its end goes to [`Updater::resume_check`] with
    /// this `ticket`: `Ok(Some(result))`, `Ok(None)` for a `null` result,
    /// `Err` where it rejected.
    StartCheck { ticket: u32 },
    /// `new CancellationToken()` and `await autoUpdater.downloadUpdate(token)`:
    /// run it on a worker; the token belongs to this `generation` (a channel
    /// switch cancels the token of the running one). Its events go to
    /// [`Updater::on_event`], on the core thread, as they happen (progress
    /// included); its end goes to [`Updater::resume_download`] with this
    /// `generation`: `None` where it resolved, the rejection otherwise.
    StartDownload { generation: u64 },
}

/// each assignment `initAutoUpdater` makes on the updater, in order
#[derive(Debug, Clone, PartialEq)]
pub enum UpdaterSetting {
    /// `autoUpdater.logger = record`
    Logger,
    /// `autoUpdater.channel = 'stable'`
    Channel(&'static str),
    AllowDowngrade(bool),
    AllowPrerelease(bool),
    AutoDownload(bool),
    FullChangelog(bool),
    AutoInstallOnAppQuit(bool),
    DisableDifferentialDownload(bool),
}

/// the timers the TypeScript sets
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Timer {
    /// `check`
    Check,
    /// `clearInstalledCache(triesLeft)`
    ClearCache(u32),
    /// `fakeShowAgain?.()`
    FakeShow,
    /// the fake download's progress step
    FakeProgress,
}

/// the update window's callbacks
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateAction {
    Download,
    Install,
    Later,
    OpenDownload,
}

/// what `initAutoUpdater` and the update flow read and do outside this module
pub trait UpdaterHost {
    // the process and the app
    /// `process.platform`
    fn platform(&self) -> String;
    /// `process.env[name]`
    fn env(&self, name: &str) -> Option<String>;
    /// `app.isPackaged`
    fn is_packaged(&self) -> bool;
    /// `app.getVersion()`
    fn version(&self) -> String;
    /// `app.getPath('userData')`
    fn user_data_dir(&self) -> String;
    /// `process.execPath`
    fn exec_path(&self) -> String;
    /// `process.pid`
    fn pid(&self) -> f64;
    /// `process.uptime()`
    fn uptime_seconds(&self) -> f64;
    /// `reopenedByInstaller()`
    fn reopened_by_installer(&self) -> bool;
    /// `getUiLang()`
    fn ui_lang(&self) -> Lang;
    /// the `autoCheckEnabled` option
    fn auto_check_enabled(&self) -> bool;
    /// `setImmediate(() => app.quit())`
    fn quit_soon(&mut self);

    // Electron
    /// `dialog.showMessageBox(options)`: the pressed button
    fn show_message_box(&mut self, options: &MessageBoxOptions) -> f64;
    /// `shell.openExternal(url)`
    fn open_external(&mut self, url: &str);

    // the update window
    /// `setUpdateParentWindow(getWindow)`
    fn set_update_parent_window(&mut self);
    /// `showUpdateWindow(getWindow(), state, actions, options)`
    fn show_update_window(&mut self, state: &UpdateUiState, inactive: bool);
    /// `isUpdateWindowOpen()`
    fn is_update_window_open(&self) -> bool;
    /// `pushUpdateState(patch)`
    fn push_update_state(&mut self, patch: &UpdateStatePatch);
    /// `closeUpdateWindow()`
    fn close_update_window(&mut self);

    // timers
    fn set_timeout(&mut self, timer: Timer, ms: f64);
    fn set_interval(&mut self, timer: Timer, ms: f64) -> u32;
    fn clear_interval(&mut self, id: u32);

    // electron-updater
    /// one assignment on `autoUpdater`
    fn configure(&mut self, setting: UpdaterSetting);
    /// `installResumeDownload(autoUpdater)`
    fn install_resume_download(&mut self);
    /// whether `updateDownloaded` and `dispatchUpdateDownloaded` are both functions
    fn has_mac_staging_methods(&self) -> (bool, bool);
    /// `updater.install(isSilent, isForceRunAfter)`: `None` where the updater has no `install` function
    fn install(&mut self, silent: bool, force_run_after: bool) -> Option<bool>;
    /// `cacheOwner.getOrCreateDownloadHelper?.()` and its `cacheDir`: `Ok(None)`
    /// where it is not a string; `Err` is a throw
    fn download_cache_dir(&mut self) -> Result<Option<String>, String>;

    // child processes of the Mac install
    /// `runProgram` of mac-update.ts
    fn run_program(&mut self, file: &str, args: &[String]) -> Result<String, String>;
    /// `spawnProgram` of mac-update.ts
    fn spawn_program(
        &mut self,
        file: &str,
        args: &[String],
        options: &SpawnOptions,
    ) -> Result<Box<dyn SwapChild>, String>;
}

/// the clock and the console, which the logger shares with the host
pub trait UpdaterEnv {
    /// `console.log(...args)`
    fn console_log(&self, args: &[String]);
    /// `new Date()` and `Date.now()`, in milliseconds since the epoch
    fn now_ms(&self) -> f64;
    /// `performance.now()`
    fn perf_now(&self) -> f64;
}

type Clock = Box<dyn FnMut() -> f64>;

/// the step log of the update, writing each line through the env
type Steps = UpdateSteps<Box<dyn FnMut(&str)>, Clock>;

/// `log`, `updateLog` and `step`
struct Logger {
    env: Rc<dyn UpdaterEnv>,
    update_log: RefCell<Option<UpdateLog<Clock>>>,
    steps: RefCell<Option<Steps>>,
    step_lines: Rc<RefCell<Vec<String>>>,
}

impl Logger {
    /// `log(...args)`
    fn log(&self, args: &[&str]) {
        let mut shown = vec!["[updater]".to_owned()];
        shown.extend(args.iter().map(|a| (*a).to_owned()));
        self.env.console_log(&shown);
        if let Some(record) = self.update_log.borrow_mut().as_mut() {
            record.info(&LogMessage::Value(&JsonValue::String(args.join(" "))));
        }
    }

    /// `step(step, fields)`: a no-op until the updater runs
    fn step(&self, step: &str, fields: &[(&str, Option<StepField>)]) {
        if let Some(steps) = self.steps.borrow_mut().as_mut() {
            steps.step(step, fields);
        }
        let lines: Vec<String> = self.step_lines.borrow_mut().drain(..).collect();
        for line in lines {
            self.log(&[&line]);
        }
    }
}

/// what the unpacked new version of a Mac install is
#[derive(Debug, Clone, PartialEq)]
struct MacStaged {
    version: String,
    app: String,
}

/// the state `initAutoUpdater` closes over
struct Flow {
    data_dir: String,
    is_mac: bool,
    mac_bundle: Option<String>,
    /// bytes the running download has fetched so far
    transferred: Option<f64>,
    mac_staged: Option<MacStaged>,
    self_updates: bool,
    /// `installMacStaging` took the updater's `updateDownloaded`
    staging_hook: bool,
    latest_seen_version: Option<String>,
    latest_seen_notes: Option<UpdateReleaseNotes>,
    failed_attempts: f64,
    download_in_flight: bool,
    phase: UpdatePhase,
    percent: f64,
    download_gen: u64,
    /// the generation of the download that is running (`downloadUpdate` not yet settled)
    running_download: Option<u64>,
    /// what the Mac staging rejected with during that download: it ends there
    staging_error: Option<UpdateError>,
    failed_install: Option<InstallAttempt>,
    install_failures: u8,
    install_dir_ok: Option<bool>,
}

/// the dev preview of `initFakeUpdate`
struct FakeUpdate {
    version: String,
    notes: Option<UpdateReleaseNotes>,
    /// the interval of the last fake download, and the percent each interval is at
    timer: Option<u32>,
    pct: HashMap<u32, f64>,
}

/// which call a started check belongs to
enum PendingCheck {
    /// `checkNow`, with the `lang` it read before its `await`
    Manual(Lang),
    /// `check`
    Scheduled,
}

/// the module state of updater.ts
pub struct Updater {
    logger: Rc<Logger>,
    i18n: I18n,
    restart: UpdateRestart,
    started: bool,
    /// version the user declined this session
    dismissed_version: Option<String>,
    fake: Option<FakeUpdate>,
    manual_check_in_flight: bool,
    /// the checks that were started and have not ended, by ticket
    pending_checks: Vec<(u32, PendingCheck)>,
    next_check_ticket: u32,
    /// true once the packaged-run updater is configured
    updater_active: bool,
    flow: Option<Flow>,
}

/// `step(name, { key: value })` fields of one kind
fn text(value: &str) -> Option<StepField<'_>> {
    Some(StepField::Str(value))
}

fn number(value: Option<f64>) -> Option<StepField<'static>> {
    value.map(StepField::Num)
}

/// `x.toFixed(1)`
fn to_fixed_1(x: f64) -> String {
    if !x.is_finite() {
        return number_to_string(x);
    }
    // the exact decimal expansion, rounded half up as `toFixed` picks the larger n
    let exact = format!("{:.40}", x.abs());
    let (int, frac) = exact.split_once('.').unwrap_or((&exact, "0"));
    let mut digits: u128 = format!("{int}{}", &frac[..1]).parse().unwrap_or(0);
    if frac.as_bytes()[1] >= b'5' {
        digits += 1;
    }
    let sign = if x < 0.0 { "-" } else { "" };
    format!("{sign}{}.{}", digits / 10, digits % 10)
}

impl Updater {
    pub fn new(env: Rc<dyn UpdaterEnv>) -> Self {
        Updater {
            logger: Rc::new(Logger {
                env,
                update_log: RefCell::new(None),
                steps: RefCell::new(None),
                step_lines: Rc::new(RefCell::new(Vec::new())),
            }),
            i18n: updater_i18n(),
            restart: UpdateRestart::new(),
            started: false,
            dismissed_version: None,
            fake: None,
            manual_check_in_flight: false,
            pending_checks: Vec::new(),
            next_check_ticket: 0,
            updater_active: false,
            flow: None,
        }
    }

    /// `requestUpdateRestart()` and its kin: the restart flag of update-restart.ts
    pub fn restart(&self) -> &UpdateRestart {
        &self.restart
    }

    /// the logger electron-updater is given (`autoUpdater.logger = record`), as
    /// the lines it writes: `info`, `warn`, `error` and `debug`
    pub fn logger_write(&self, level: &str, message: &LogMessage) {
        if let Some(record) = self.logger.update_log.borrow_mut().as_mut() {
            match level {
                "warn" => record.warn(message),
                "error" => record.error(message),
                "debug" => record.debug(message),
                _ => record.info(message),
            }
        }
    }

    fn t(&self, lang: Lang, key: &str) -> String {
        self.i18n.t(lang, key, None)
    }

    /// `uiStrings()`
    fn ui_strings(&self, host: &dyn UpdaterHost) -> UpdateUiStrings {
        let lang = host.ui_lang();
        let platform = host.platform();
        UpdateUiStrings {
            title: self.t(lang, "updTitle"),
            headline: self.t(lang, "updHeadline"),
            desc: self.t(lang, "updDesc"),
            download: self.t(lang, "updDownload"),
            later: self.t(lang, "updLater"),
            install: self.t(lang, "updInstall"),
            downloading: self.t(lang, "updDownloading"),
            failed: self.t(lang, "updFailed"),
            retry: self.t(lang, "updRetry"),
            manual_desc: self.t(
                lang,
                if platform == "darwin" {
                    "updManualMac"
                } else {
                    "updManual"
                },
            ),
            install_failed_desc: self.t(lang, "updInstallFailed"),
            visible_install_desc: self.t(lang, "updVisibleInstall"),
            // Windows hands over to an installer window, macOS to the swap
            restart_desc: if platform == "win32" {
                self.t(lang, "updRestartNote")
            } else if platform == "darwin" {
                self.t(lang, "updRestartNoteMac")
            } else {
                String::new()
            },
            open_download: self.t(lang, "updOpenDownload"),
            notes_label: self.t(lang, "updNotesLabel"),
            notes_on_git_hub: self.t(lang, "updNotesOnGitHub"),
            notes_truncated: self.t(lang, "updNotesTruncated"),
        }
    }

    /// `initialState(version, releaseNotes, visibleInstall)`
    fn initial_state(
        &self,
        host: &dyn UpdaterHost,
        version: &str,
        release_notes: Option<UpdateReleaseNotes>,
        visible_install: bool,
    ) -> UpdateUiState {
        UpdateUiState {
            phase: UpdatePhase::Available,
            version: version.to_owned(),
            current_version: host.version(),
            percent: 0.0,
            lang: html_lang(host.ui_lang()).to_owned(),
            strings: self.ui_strings(host),
            release_notes,
            visible_install,
        }
    }

    /// `checkForUpdatesNow` up to its `await`: the user-triggered check; every
    /// outcome gets explicit feedback. [`Updater::resume_check`] has the rest.
    pub fn check_for_updates_now(&mut self, host: &mut dyn UpdaterHost) -> UpdaterStep {
        if self.manual_check_in_flight {
            return UpdaterStep::Idle;
        }
        self.manual_check_in_flight = true;
        let step = self.check_now(host);
        // the `finally`: a check that was started keeps the flag until it ends
        if step == UpdaterStep::Idle {
            self.manual_check_in_flight = false;
        }
        step
    }

    fn info_box(
        &self,
        lang: Lang,
        kind: &'static str,
        message: String,
        buttons: Vec<String>,
    ) -> MessageBoxOptions {
        MessageBoxOptions {
            kind,
            title: Some(self.t(lang, "updTitle")),
            message,
            detail: None,
            buttons,
            default_id: 0,
            cancel_id: Some(0),
            no_link: None,
        }
    }

    fn check_now(&mut self, host: &mut dyn UpdaterHost) -> UpdaterStep {
        let lang = host.ui_lang();
        if self.fake.is_some() {
            self.fake_show_again(host);
            return UpdaterStep::Idle;
        }
        if !self.updater_active {
            let options = self.info_box(
                lang,
                "info",
                self.t(lang, "updManual"),
                vec!["OK".to_owned(), self.t(lang, "updOpenDownload")],
            );
            let response = host.show_message_box(&options);
            if response == 1.0 {
                host.open_external(GITHUB_LATEST_RELEASE_URL);
            }
            return UpdaterStep::Idle;
        }
        self.dismissed_version = None;
        self.logger.step("check-start", &[("by", text("user"))]);
        self.start_check(PendingCheck::Manual(lang))
    }

    /// `autoUpdater.checkForUpdates()` is called: the check waits for its ticket
    fn start_check(&mut self, kind: PendingCheck) -> UpdaterStep {
        self.next_check_ticket += 1;
        let ticket = self.next_check_ticket;
        self.pending_checks.push((ticket, kind));
        UpdaterStep::StartCheck { ticket }
    }

    /// The end of a check [`UpdaterStep::StartCheck`] asked for: its result
    /// (`Ok(None)` is a `null` result), or its rejection. Everything the
    /// updater emitted meanwhile has gone to [`Updater::on_event`] already.
    pub fn resume_check(
        &mut self,
        host: &mut dyn UpdaterHost,
        ticket: u32,
        outcome: Result<Option<CheckResult>, UpdateError>,
    ) {
        let Some(at) = self.pending_checks.iter().position(|(t, _)| *t == ticket) else {
            return;
        };
        match self.pending_checks.remove(at).1 {
            PendingCheck::Manual(lang) => {
                self.finish_manual_check(host, lang, outcome);
                self.manual_check_in_flight = false;
            }
            PendingCheck::Scheduled => match outcome {
                Ok(answer) => self.logger.step("check-end", &check_end_fields(&answer)),
                Err(error) => {
                    self.logger.step("check-end", &[("found", text("failed"))]);
                    self.logger.log(&["check failed:", &error.message]);
                }
            },
        }
    }

    /// `checkNow` after `await autoUpdater.checkForUpdates()`
    fn finish_manual_check(
        &mut self,
        host: &mut dyn UpdaterHost,
        lang: Lang,
        outcome: Result<Option<CheckResult>, UpdateError>,
    ) {
        // `result` stays undefined (None) when the check threw
        let mut result: Option<Option<CheckResult>> = None;
        let mut failure: Option<UpdateError> = None;
        match outcome {
            Ok(answer) => {
                self.logger.step("check-end", &check_end_fields(&answer));
                if answer.is_none() {
                    failure = Some(UpdateError {
                        code: None,
                        message: "Update check was skipped".to_owned(),
                    });
                }
                result = Some(answer);
            }
            Err(error) => failure = Some(error),
        }
        if let Some(err) = failure {
            // `!result`: undefined (the call threw) or null (skipped)
            if !matches!(&result, Some(Some(_))) {
                self.logger.step("check-end", &[("found", text("failed"))]);
            }
            self.logger.log(&["manual check failed:", &err.message]);
            if !is_no_release_error(&err) {
                let options = self.info_box(
                    lang,
                    "warning",
                    self.t(lang, "updCheckFailed"),
                    vec!["OK".to_owned()],
                );
                host.show_message_box(&options);
                return;
            }
        }
        // an available update already opened the update window via the
        // 'update-available' handler; only "nothing new" needs a dialog here
        if matches!(&result, Some(Some(answer)) if answer.is_update_available) {
            return;
        }
        let mut params = JsObject::new();
        params.set("version", JsonValue::String(host.version()));
        let options = self.info_box(
            lang,
            "info",
            self.i18n.t(lang, "updUpToDate", Some(&params)),
            vec!["OK".to_owned()],
        );
        host.show_message_box(&options);
    }

    /// `initAutoUpdater`; `channel` is its `channel` argument (the caller
    /// resolves `packagedUpdateChannel()` where the TypeScript's default does)
    pub fn init_auto_updater(&mut self, host: &mut dyn UpdaterHost, channel: BuildUpdateChannel) {
        if self.started {
            return;
        }
        self.started = true;
        host.set_update_parent_window();

        let packaged = host.is_packaged();
        // dev preview of the update window with a simulated download
        if let Some(version) = host
            .env("SEUOFFICE_FAKE_UPDATE")
            .filter(|v| !v.is_empty())
            .filter(|_| !packaged)
        {
            self.init_fake_update(host, &version);
            return;
        }
        // Unpacked runs have no app-update.yml and must not ask GitHub with a dev version.
        if !packaged {
            return;
        }
        let platform = host.platform();
        let is_linux_app_image =
            platform == "linux" && host.env("APPIMAGE").is_some_and(|v| !v.is_empty());
        if platform != "win32" && platform != "darwin" && !is_linux_app_image {
            return;
        }

        self.updater_active = true;
        let data_dir = host.user_data_dir();
        let env = Rc::clone(&self.logger.env);
        let log_env = Rc::clone(&env);
        *self.logger.update_log.borrow_mut() = Some(create_update_log(
            &join(&[&data_dir, UPDATE_LOG_FILE]),
            UPDATE_LOG_MAX_BYTES,
            Box::new(move || log_env.now_ms()) as Clock,
        ));
        host.configure(UpdaterSetting::Logger);
        let step_env = Rc::clone(&env);
        let lines = Rc::clone(&self.logger.step_lines);
        *self.logger.steps.borrow_mut() = Some(create_update_steps(
            Box::new(move |line: &str| lines.borrow_mut().push(line.to_owned()))
                as Box<dyn FnMut(&str)>,
            Box::new(move || step_env.perf_now()) as Clock,
        ));
        // the installer passes --updated when it reopens the app after an update
        let launched_by = if host.reopened_by_installer() {
            ", reopened by the installer"
        } else {
            ""
        };
        let version = host.version();
        self.logger.log(&[
            "running",
            &version,
            "on the",
            channel.as_str(),
            &format!("channel{launched_by}"),
        ]);
        // selectChannel
        if channel == BuildUpdateChannel::Stable {
            host.configure(UpdaterSetting::Channel("stable"));
        }
        // the channel setter unconditionally flips allowDowngrade to true; force
        // it back off: an update never installs an older version
        host.configure(UpdaterSetting::AllowDowngrade(false));
        host.configure(UpdaterSetting::AllowPrerelease(
            channel == BuildUpdateChannel::Latest,
        ));
        host.configure(UpdaterSetting::AutoDownload(false));
        host.configure(UpdaterSetting::FullChangelog(true));
        host.configure(UpdaterSetting::AutoInstallOnAppQuit(false));
        host.configure(UpdaterSetting::DisableDifferentialDownload(false));
        host.install_resume_download();

        // macOS: Squirrel.Mac only installs into an app signed with a Developer ID,
        // which this product's Mac builds do not have (decision 0031)
        let is_mac = platform == "darwin";
        let exec_path = host.exec_path();
        let mac_bundle = if is_mac {
            mac_app_bundle(&exec_path)
        } else {
            None
        };
        let mut self_updates = true;
        let mut staging_hook = false;
        if is_mac {
            let block: Option<MacSelfUpdateBlock> =
                mac_self_update_block(&exec_path, host.pid(), &mut default_writable);
            if mac_bundle.is_some() && block.is_none() {
                remove_mac_leftovers(mac_bundle.as_deref().unwrap_or_default());
            }
            let staging = mac_bundle.is_some() && block.is_none() && {
                let (update_downloaded, dispatch) = host.has_mac_staging_methods();
                install_mac_staging(update_downloaded, dispatch)
            };
            staging_hook = staging;
            self_updates = staging;
            if !staging {
                self.logger.log(&[
                    "this Mac install cannot update itself:",
                    block.map_or("no staging hook", MacSelfUpdateBlock::as_str),
                ]);
            }
        }

        // An installer start that left the app at the old version is reported and
        // gets one more try; a second one that failed goes to the download page
        let previous_attempt = read_install_attempt(&data_dir);
        let failed_install = if install_did_not_apply(previous_attempt.as_ref(), &version) {
            previous_attempt.clone()
        } else {
            None
        };
        let install_failures = install_failure_level(failed_install.as_ref());
        if let Some(failed) = &failed_install {
            self.logger.log(&[
                "the installer started for",
                &failed.version,
                if failed.visible {
                    "in its own window"
                } else {
                    "silently"
                },
                "did not update",
                &version,
            ]);
        } else if let Some(previous) = &previous_attempt {
            self.logger.log(&[
                "the installer started for",
                &previous.version,
                "has run; now",
                &version,
            ]);
            let since = previous
                .started_at
                .as_deref()
                .filter(|s| !s.is_empty())
                .map_or(f64::NAN, date_parse);
            let since_text =
                (!since.is_nan()).then(|| to_fixed_1((self.logger.env.now_ms() - since) / 1000.0));
            let uptime = to_fixed_1(host.uptime_seconds());
            self.logger.step(
                "app-started",
                &[
                    ("version", text(&version)),
                    ("from", text(&previous.from_version)),
                    (
                        "since-install-start-s",
                        since_text.as_deref().and_then(text),
                    ),
                    ("uptime-s", text(&uptime)),
                ],
            );
            clear_install_attempt(&data_dir);
        }

        self.flow = Some(Flow {
            data_dir: data_dir.clone(),
            is_mac,
            mac_bundle,
            transferred: None,
            mac_staged: None,
            self_updates,
            staging_hook,
            latest_seen_version: None,
            latest_seen_notes: None,
            failed_attempts: 0.0,
            download_in_flight: false,
            // where latestSeenVersion got to, so re-opening the window for the
            // same version resumes there
            phase: UpdatePhase::Available,
            percent: 0.0,
            download_gen: 0,
            running_download: None,
            staging_error: None,
            failed_install,
            install_failures,
            install_dir_ok: None,
        });

        // What the last update left in electron-updater's download cache goes at a
        // start: the call is made here, its continuation runs below
        let lookup = host.download_cache_dir();
        host.set_timeout(Timer::Check, FIRST_CHECK_DELAY_MS);
        host.set_interval(Timer::Check, RECHECK_INTERVAL_MS);
        self.clear_installed_cache_after(host, CACHE_RETRIES, lookup);
    }

    fn flow(&self) -> &Flow {
        self.flow
            .as_ref()
            .expect("the updater runs only after initAutoUpdater set it up")
    }

    fn flow_mut(&mut self) -> &mut Flow {
        self.flow
            .as_mut()
            .expect("the updater runs only after initAutoUpdater set it up")
    }

    /// `adminPromptExpected`: an "all users" install needs administrator
    /// rights, so its installer window will ask for them; checked once
    fn admin_prompt_expected(&mut self, host: &dyn UpdaterHost) -> bool {
        if host.platform() != "win32" {
            return false;
        }
        if self.flow().install_dir_ok.is_none() {
            let probe = format!(".seuoffice-update-check-{}", number_to_string(host.pid()));
            let writable = install_dir_writable(&dirname(&host.exec_path()), &probe);
            self.flow_mut().install_dir_ok = Some(writable);
        }
        !self.flow().install_dir_ok.unwrap_or(false)
    }

    /// `startMacSwapFor`: the swap starts once the app's process is gone and
    /// reopens the app, the new version when it worked
    fn start_mac_swap_for(&mut self, host: &mut dyn UpdaterHost, version: &str) {
        let flow = self.flow();
        let staged = match (&flow.mac_bundle, &flow.mac_staged) {
            (Some(bundle), Some(staged)) if staged.version == version => {
                Some((bundle.clone(), staged.app.clone()))
            }
            _ => None,
        };
        let Some((bundle, staged_app)) = staged else {
            self.logger
                .log(&["no unpacked update for", version, "to install"]);
            return;
        };
        let data_dir = flow.data_dir.clone();
        let tries = next_attempt_tries(flow.failed_install.as_ref(), version);
        record_install_attempt(
            &data_dir,
            &InstallAttempt {
                version: version.to_owned(),
                from_version: host.version(),
                visible: false,
                tries: Some(jscompat::JsNum(tries)),
                started_at: to_iso_string(self.logger.env.now_ms()),
            },
        );
        self.logger
            .step("swap-scheduled", &[("version", text(version))]);
        self.logger.log(&[
            "replacing the app with",
            version,
            "once it has quit, try",
            &number_to_string(tries),
        ]);
        let log_file = join(&[&data_dir, UPDATE_LOG_FILE]);
        let started = start_mac_swap(
            &StartMacSwap {
                pid: host.pid(),
                bundle: &bundle,
                staged: &staged_app,
                log_file: &log_file,
                opener: None,
            },
            &mut |file, args, options| host.spawn_program(file, args, options),
        );
        if !started {
            self.logger.log(&["the swap did not start"]);
        }
    }

    /// `startInstaller`
    fn start_installer(&mut self, host: &mut dyn UpdaterHost, version: &str) {
        // Windows: the installer's own window, progress page only, which reopens
        // the app at the end (decision 0077)
        let visible = host.platform() == "win32";
        let data_dir = self.flow().data_dir.clone();
        let tries = next_attempt_tries(self.flow().failed_install.as_ref(), version);
        record_install_attempt(
            &data_dir,
            &InstallAttempt {
                version: version.to_owned(),
                from_version: host.version(),
                visible,
                tries: Some(jscompat::JsNum(tries)),
                started_at: to_iso_string(self.logger.env.now_ms()),
            },
        );
        self.logger
            .step("installer-start", &[("version", text(version))]);
        self.logger.log(&[
            "starting the installer for",
            version,
            if visible {
                "in its own window"
            } else {
                "silently"
            },
            "to reopen the app, try",
            &number_to_string(tries),
        ]);
        // BaseUpdater.install: the same call electron-updater's quit hook makes
        if host.install(!visible, true) != Some(true) {
            self.logger.log(&["the installer did not start"]);
        }
    }

    /// `app.on('will-quit')`: the right moment to hand over to the installer.
    /// Only "Restart & Install" installs.
    pub fn on_will_quit(&mut self, host: &mut dyn UpdaterHost) {
        let Some(flow) = &self.flow else {
            return;
        };
        let Some(version) = flow.latest_seen_version.clone() else {
            return;
        };
        if !flow.self_updates || flow.phase != UpdatePhase::Downloaded {
            return;
        }
        if !self.restart.update_restart_requested() {
            return;
        }
        self.logger
            .step("will-quit", &[("version", text(&version))]);
        if self.flow().is_mac {
            self.start_mac_swap_for(host, &version);
        } else {
            self.start_installer(host, &version);
        }
    }

    /// `setPhase`
    fn set_phase(&mut self, host: &mut dyn UpdaterHost, patch: UpdateStatePatch) {
        let flow = self.flow_mut();
        flow.phase = patch.phase;
        if let Some(percent) = patch.percent {
            flow.percent = percent;
        }
        host.push_update_state(&patch);
    }

    /// `windowState(version)`: the window state for `version` at the current phase
    fn window_state(&mut self, host: &dyn UpdaterHost, version: &str) -> UpdateUiState {
        let downloaded = self.flow().phase == UpdatePhase::Downloaded;
        let visible = downloaded && self.admin_prompt_expected(host);
        let notes = self.flow().latest_seen_notes.clone();
        let mut state = self.initial_state(host, version, notes, visible);
        state.phase = self.flow().phase;
        state.percent = self.flow().percent;
        state
    }

    /// `failDownload`
    fn fail_download(&mut self, host: &mut dyn UpdaterHost) {
        if !self.flow().download_in_flight {
            return;
        }
        let transferred = self.flow().transferred;
        self.flow_mut().download_in_flight = false;
        self.logger.step(
            "download-end",
            &[
                ("failed", text("yes")),
                ("transferred", number(transferred)),
            ],
        );
        let flow = self.flow_mut();
        flow.failed_attempts += 1.0;
        let phase = if flow.failed_attempts >= MANUAL_FALLBACK_AFTER {
            UpdatePhase::Manual
        } else {
            UpdatePhase::Error
        };
        self.set_phase(
            host,
            UpdateStatePatch {
                phase,
                percent: None,
                visible_install: None,
            },
        );
    }

    /// the window's callbacks (`actions`), or the fake preview's
    pub fn on_action(&mut self, host: &mut dyn UpdaterHost, action: UpdateAction) -> UpdaterStep {
        if self.flow.is_none() {
            self.on_fake_action(host, action);
            return UpdaterStep::Idle;
        }
        match action {
            UpdateAction::Download => return self.on_download(host),
            UpdateAction::Install => {
                host.close_update_window();
                let flow = self.flow();
                let Some(version) = flow.latest_seen_version.clone() else {
                    return UpdaterStep::Idle;
                };
                if flow.phase != UpdatePhase::Downloaded {
                    return UpdaterStep::Idle;
                }
                self.logger
                    .step("quit-requested", &[("version", text(&version))]);
                self.restart.request_update_restart();
                // let the window fully close before tearing the app down; the
                // installer starts at will-quit, after every save prompt
                host.quit_soon();
            }
            UpdateAction::Later => {
                self.dismissed_version = self.flow().latest_seen_version.clone();
                host.close_update_window();
            }
            UpdateAction::OpenDownload => {
                let url = manual_download_url_for(self.flow().latest_seen_version.as_deref());
                host.open_external(&url);
            }
        }
        UpdaterStep::Idle
    }

    /// `onDownload` up to its `await`
    fn on_download(&mut self, host: &mut dyn UpdaterHost) -> UpdaterStep {
        let flow = self.flow();
        if matches!(
            flow.phase,
            UpdatePhase::Downloading | UpdatePhase::Downloaded
        ) {
            return UpdaterStep::Idle;
        }
        if !flow.self_updates {
            let url = manual_download_url_for(flow.latest_seen_version.as_deref());
            host.open_external(&url);
            return UpdaterStep::Idle;
        }
        let version = flow.latest_seen_version.clone();
        let flow = self.flow_mut();
        flow.download_in_flight = true;
        flow.transferred = None;
        self.logger.step(
            "download-start",
            &[("version", version.as_deref().and_then(text))],
        );
        self.set_phase(
            host,
            UpdateStatePatch {
                phase: UpdatePhase::Downloading,
                percent: Some(0.0),
                visible_install: None,
            },
        );
        let flow = self.flow_mut();
        flow.download_gen += 1;
        let generation = flow.download_gen;
        flow.running_download = Some(generation);
        flow.staging_error = None;
        UpdaterStep::StartDownload { generation }
    }

    /// The end of a download [`UpdaterStep::StartDownload`] asked for:
    /// `None` where `downloadUpdate` resolved, its rejection otherwise. The
    /// events it emitted have gone to [`Updater::on_event`] already; one
    /// whose handler rejected (the Mac staging) is the rejection when it came
    /// first, as it ends the download there.
    pub fn resume_download(
        &mut self,
        host: &mut dyn UpdaterHost,
        generation: u64,
        rejection: Option<UpdateError>,
    ) {
        if self.flow.is_none() {
            return;
        }
        let flow = self.flow_mut();
        if flow.running_download == Some(generation) {
            flow.running_download = None;
        }
        let rejection = flow.staging_error.take().or(rejection);
        if let Some(error) = rejection {
            if generation != self.flow().download_gen {
                return;
            }
            self.logger.log(&["download failed:", &error.message]);
            self.fail_download(host);
        }
    }

    /// what electron-updater emits, when it does: during a check or a download
    /// or on its own
    pub fn on_event(&mut self, host: &mut dyn UpdaterHost, event: UpdaterEvent) {
        if self.flow.is_none() {
            return;
        }
        // a download that was rejected emits nothing more
        let flow = self.flow();
        if flow.running_download.is_some() && flow.staging_error.is_some() {
            return;
        }
        if let Err(error) = self.handle_event(host, event)
            && self.flow().running_download.is_some()
        {
            // the handler's rejection is the running download's
            self.flow_mut().staging_error = Some(error);
        }
    }

    /// the listeners of `autoUpdater.on(...)`; `Err` is what the Mac staging
    /// rejects with, which fails the download that is running
    fn handle_event(
        &mut self,
        host: &mut dyn UpdaterHost,
        event: UpdaterEvent,
    ) -> Result<(), UpdateError> {
        if self.flow.is_none() {
            return Ok(());
        }
        match event {
            UpdaterEvent::Error(message) => {
                // network failures during background checks are expected and shown
                // nowhere; a failed download is reported by its own rejection
                self.logger.log(&["error:", &message]);
            }
            UpdaterEvent::UpdateAvailable {
                version,
                release_notes,
            } => self.on_update_available(host, &version, &release_notes),
            UpdaterEvent::DownloadProgress {
                transferred,
                percent,
            } => {
                if !self.flow().download_in_flight {
                    return Ok(());
                }
                self.flow_mut().transferred = Some(transferred);
                self.set_phase(
                    host,
                    UpdateStatePatch {
                        phase: UpdatePhase::Downloading,
                        percent: Some(percent),
                        visible_install: None,
                    },
                );
            }
            UpdaterEvent::UpdateDownloaded {
                version,
                downloaded_file,
            } => {
                if self.flow().staging_hook {
                    self.stage_downloaded(host, &version, downloaded_file.as_deref())?;
                }
                self.on_update_downloaded(host, &version, downloaded_file.as_deref());
            }
        }
        Ok(())
    }

    /// the replacement `updateDownloaded` of `installMacStaging`, with its `stage`
    fn stage_downloaded(
        &mut self,
        host: &mut dyn UpdaterHost,
        version: &str,
        downloaded_file: Option<&str>,
    ) -> Result<(), UpdateError> {
        let mut event = serde_json::Map::new();
        event.insert(
            "downloadedFile".to_owned(),
            downloaded_file.map_or(Value::Null, Value::from),
        );
        event.insert("version".to_owned(), Value::from(version));
        let mut dispatched = false;
        staged_update_downloaded(
            &Value::Object(event),
            &mut |zip, version| self.mac_stage(host, zip, version),
            &mut |_| dispatched = true,
        )
        .map_err(|message| UpdateError {
            code: None,
            message,
        })?;
        debug_assert!(dispatched);
        Ok(())
    }

    /// the `stage` callback `initAutoUpdater` gives `installMacStaging`
    fn mac_stage(
        &mut self,
        host: &mut dyn UpdaterHost,
        zip: &Value,
        version: &Value,
    ) -> Result<(), String> {
        let version = version.as_str().unwrap_or_default();
        let zip_path = zip.as_str();
        let transferred = self.flow().transferred;
        self.flow_mut().mac_staged = None;
        self.logger.step(
            "download-end",
            &[
                ("version", text(version)),
                ("bytes", number(file_bytes(zip_path).map(|b| b as f64))),
                ("transferred", number(transferred)),
            ],
        );
        let bundle = self.flow().mac_bundle.clone().unwrap_or_default();
        self.logger.log(&["unpacking", version, "beside", &bundle]);
        let logger = Rc::clone(&self.logger);
        let staged_app = stage_mac_update(
            zip_path.unwrap_or_default(),
            &bundle,
            version,
            &mut |file, args| host.run_program(file, args),
            &mut |name| logger.step(name, &[]),
        )
        .map_err(|e| e.message)?;
        self.flow_mut().mac_staged = Some(MacStaged {
            version: version.to_owned(),
            app: staged_app,
        });
        self.logger.log(&["unpacked and checked", version]);
        Ok(())
    }

    fn on_update_available(
        &mut self,
        host: &mut dyn UpdaterHost,
        version: &str,
        release_notes: &Value,
    ) {
        if self.dismissed_version.as_deref() == Some(version) {
            return;
        }
        let same_version_recheck = self.flow().latest_seen_version.as_deref() == Some(version);
        // progress/downloaded/error events carry no version, so a newer release
        // landing while the previous one is downloading or already downloaded
        // stays out until that flow ends
        if !same_version_recheck
            && (self.flow().download_in_flight || self.flow().phase == UpdatePhase::Downloaded)
        {
            let latest = self.flow().latest_seen_version.clone();
            let phase = self.flow().phase;
            self.logger.log(&[
                "update available:",
                version,
                "ignored while",
                latest.as_deref().unwrap_or("null"),
                "is",
                phase.as_str(),
            ]);
            // an explicit check still owes feedback: bring back the flow in progress
            if self.manual_check_in_flight && !host.is_update_window_open() {
                let shown = latest.as_deref().unwrap_or(version).to_owned();
                let state = self.window_state(host, &shown);
                host.show_update_window(&state, false);
            }
            return;
        }
        if !same_version_recheck {
            let flow = self.flow_mut();
            flow.failed_attempts = 0.0;
            // a Mac swap that did not take is not retried: nothing about it would
            // change on a second try
            flow.phase = if !flow.self_updates
                || flow.install_failures >= 2
                || (flow.is_mac && flow.install_failures >= 1)
            {
                UpdatePhase::Manual
            } else if flow.install_failures == 1 {
                UpdatePhase::InstallFailed
            } else {
                UpdatePhase::Available
            };
            flow.percent = 0.0;
            flow.latest_seen_notes = normalize_release_notes(release_notes);
        } else {
            // a repeated event for the same version refreshes the notes only when
            // the feed carried some
            let flow = self.flow_mut();
            flow.latest_seen_notes =
                normalize_release_notes(release_notes).or_else(|| flow.latest_seen_notes.take());
        }
        self.flow_mut().latest_seen_version = Some(version.to_owned());
        self.logger.log(&["update available:", version]);
        // a periodic recheck resolving to the version the open dialog already
        // shows must not reset its phase
        if same_version_recheck && host.is_update_window_open() {
            return;
        }
        let state = self.window_state(host, version);
        host.show_update_window(&state, false);
    }

    fn on_update_downloaded(
        &mut self,
        host: &mut dyn UpdaterHost,
        version: &str,
        downloaded_file: Option<&str>,
    ) {
        if self.flow().latest_seen_version.as_deref() != Some(version) {
            self.logger.log(&[
                "downloaded:",
                version,
                "ignored (stale after channel switch)",
            ]);
            return;
        }
        // the Mac download ended where its zip was handed over to be unpacked
        if !self.flow().is_mac {
            let transferred = self.flow().transferred;
            self.logger.step(
                "download-end",
                &[
                    ("version", text(version)),
                    (
                        "bytes",
                        number(file_bytes(downloaded_file).map(|b| b as f64)),
                    ),
                    ("transferred", number(transferred)),
                ],
            );
        }
        self.logger.log(&["downloaded:", version]);
        let flow = self.flow_mut();
        flow.download_in_flight = false;
        flow.failed_attempts = 0.0;
        let visible = self.admin_prompt_expected(host);
        self.set_phase(
            host,
            UpdateStatePatch {
                phase: UpdatePhase::Downloaded,
                percent: Some(100.0),
                visible_install: Some(visible),
            },
        );
        // A download finished behind a minimized window would otherwise wait,
        // unseen, in Settings > About: bring "Restart & Install" back, without
        // taking the focus
        if !host.is_update_window_open() {
            let state = self.window_state(host, version);
            host.show_update_window(&state, true);
        }
    }

    /// `clearInstalledCache(triesLeft)` as a timer runs it
    pub fn clear_installed_cache(&mut self, host: &mut dyn UpdaterHost, tries_left: u32) {
        let lookup = host.download_cache_dir();
        self.clear_installed_cache_after(host, tries_left, lookup);
    }

    /// the part of `clearInstalledCache` after its `await`
    fn clear_installed_cache_after(
        &mut self,
        host: &mut dyn UpdaterHost,
        tries_left: u32,
        lookup: Result<Option<String>, String>,
    ) {
        let cache_dir = match lookup {
            Ok(Some(dir)) => dir,
            Ok(None) => {
                self.logger.log(&[
                    "the update cache was not looked at: the updater names no cache folder",
                ]);
                return;
            }
            Err(message) => {
                self.logger
                    .log(&["the update cache was not looked at:", &message]);
                return;
            }
        };
        if self.flow().download_in_flight || self.flow().phase == UpdatePhase::Downloaded {
            return;
        }
        let logger = Rc::clone(&self.logger);
        let cleared = prune_update_cache(&cache_dir, &host.version(), &mut |args| logger.log(args));
        if !cleared && tries_left > 0 {
            host.set_timeout(Timer::ClearCache(tries_left - 1), CACHE_RETRY_DELAY_MS);
        }
    }

    /// `check`: the scheduled background check
    pub fn check(&mut self, host: &mut dyn UpdaterHost) -> UpdaterStep {
        // turned off: only an explicit check asks the feed
        if !host.auto_check_enabled() {
            return UpdaterStep::Idle;
        }
        // a newer release found now would wait anyway, and the request only
        // competes with the download for the network
        if self.flow().download_in_flight || self.flow().phase == UpdatePhase::Downloaded {
            return UpdaterStep::Idle;
        }
        self.logger.step("check-start", &[("by", text("schedule"))]);
        self.start_check(PendingCheck::Scheduled)
    }

    // ---- the dev preview ----

    /// `initFakeUpdate`: unpacked-run simulation: real window + IPC, fake
    /// download that completes
    fn init_fake_update(&mut self, host: &mut dyn UpdaterHost, version: &str) {
        // two sections show the skipped-versions layout (per-version headings)
        let notes = normalize_release_notes(&serde_json::json!([
            {
                "version": version,
                "note": "<p>A simulated update for the preview.</p>\n<h2>What's new</h2>\n<ul>\n<li><strong>Update notes</strong>: the window shows what changed before you update.</li>\n<li><code>SEUOFFICE_FAKE_UPDATE</code> opens this preview.</li>\n</ul>",
            },
            {
                "version": "9.9.8",
                "note": "<p>Notes of the previous version.</p>\n<h2>Fixed</h2>\n<ul>\n<li>One older fix, shown when versions were skipped.</li>\n</ul>",
            },
        ]));
        self.fake = Some(FakeUpdate {
            version: version.to_owned(),
            notes,
            timer: None,
            pct: HashMap::new(),
        });
        host.set_timeout(Timer::FakeShow, 1500.0);
    }

    /// `fakeShowAgain`
    pub fn fake_show_again(&mut self, host: &mut dyn UpdaterHost) {
        let Some(fake) = &self.fake else {
            return;
        };
        let state = self.initial_state(host, &fake.version.clone(), fake.notes.clone(), false);
        host.show_update_window(&state, false);
    }

    fn on_fake_action(&mut self, host: &mut dyn UpdaterHost, action: UpdateAction) {
        match action {
            UpdateAction::Download => {
                host.push_update_state(&UpdateStatePatch {
                    phase: UpdatePhase::Downloading,
                    percent: Some(0.0),
                    visible_install: None,
                });
                let id = host.set_interval(Timer::FakeProgress, 100.0);
                if let Some(fake) = self.fake.as_mut() {
                    fake.pct.insert(id, 0.0);
                    fake.timer = Some(id);
                }
            }
            UpdateAction::Install => {
                self.logger.log(&["[fake] install requested"]);
                host.close_update_window();
            }
            UpdateAction::Later => {
                if let Some(id) = self.fake.as_ref().and_then(|f| f.timer) {
                    host.clear_interval(id);
                }
                host.close_update_window();
            }
            UpdateAction::OpenDownload => {
                self.logger.log(&["[fake] open download page requested"]);
            }
        }
    }

    /// the interval `id` of the fake download fired
    pub fn fake_progress(&mut self, host: &mut dyn UpdaterHost, id: u32) {
        let Some(fake) = self.fake.as_mut() else {
            return;
        };
        let pct = fake.pct.entry(id).or_insert(0.0);
        *pct += 4.0;
        let now = *pct;
        let timer = fake.timer;
        if now >= 100.0 {
            if timer.is_some() {
                host.clear_interval(timer.unwrap_or(id));
            }
            host.push_update_state(&UpdateStatePatch {
                phase: UpdatePhase::Downloaded,
                percent: Some(100.0),
                visible_install: None,
            });
        } else {
            host.push_update_state(&UpdateStatePatch {
                phase: UpdatePhase::Downloading,
                percent: Some(now),
                visible_install: None,
            });
        }
    }
}

/// `{ found: result?.isUpdateAvailable ? result.updateInfo?.version : 'none' }`
fn check_end_fields(result: &Option<CheckResult>) -> [(&'static str, Option<StepField<'_>>); 1] {
    match result {
        Some(r) if r.is_update_available => [("found", r.update_version.as_deref().and_then(text))],
        _ => [("found", text("none"))],
    }
}
