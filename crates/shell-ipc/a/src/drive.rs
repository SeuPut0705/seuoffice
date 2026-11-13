//! Google Drive in the shell's main process (`apps/shell/src/main/drive/`,
//! decisions 0033, 0085): one connection, Google's picker for choosing files,
//! the local copies of opened Drive files, and the AI's read-only access. The
//! screens get state and file lists; tokens never leave this process.
//!
//! `drive-ipc.ts` is the port itself ([`DrivePort`]); its neighbours are
//! modules beside it: [`vault`] (the encrypted refresh token), [`consent`]
//! (free AI), [`attach`], [`ai`], [`files`] and [`strings`].
//! `packages/google-drive` is not in `main-core` on this branch, so the
//! connection, the Drive API and the file formats come through
//! [`client::DriveClient`], and the shell entry's tabs, parser and AI
//! settings through [`host::DriveShell`].
//!
//! Awaited network calls run on workers and answer from the core thread;
//! nothing here blocks the core thread.

pub mod ai;
pub mod attach;
pub mod client;
pub mod consent;
pub mod files;
pub mod host;
pub mod strings;
pub mod vault;

mod util;

#[cfg(test)]
mod testing;

use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};

use jscompat::{JsonValue, to_primitive, trim};
use main_core::node_fs::NodeError;
use main_core::packages::electron_utils::ai_run_guard::AiRunGuardInput;
use main_core::packages::electron_utils::safe_external_url::safe_external_url;
use main_core::packages::i18n::Lang;
use main_core::shell::app_settings::{read_app_settings, write_app_setting};
use shell_contract::hosts::{DialogsHost, MainWindowHost, MessageBox, OsShellHost};
use shell_contract::ipc::{CallContext, Reply, Responder, Target};
use shell_contract::runtime::{PathName, Services};
use shell_contract::{IpcError, IpcValue};

use crate::ports::Drive;
use crate::value::to_json;

use self::ai::{DriveAi, entry_type};
use self::attach::download_picks;
use self::client::{
    BrowserRound, ConnectionState, DriveClientHost, DriveFile, FOLDER_MIME, Listing, OpenPlan,
    SignInFailure, SignInPage,
};
use self::consent::{free_ai_in_use, is_free_ai};
use self::files::{
    DriveFiles, FilesConfig, OpenFailure, SyncAnswer, SyncNotice, SyncQuestion, SyncUi,
};
use self::host::DriveShellHost;
use self::strings::{copy_file_name, drive_text};
use self::util::{Clock, on_core, slice_utf16};

/// `DRIVE_AI_ACCESS_KEY`: the person lets the AI search and read Drive
pub const DRIVE_AI_ACCESS_KEY: &str = "driveAiAccess";
/// `DRIVE_TRAINING_ACK_KEY`: the person confirmed that the AI subscriptions
/// they use with Drive files do not train on what they receive (decision
/// 0085). Connecting, picking and the AI's Drive tools wait for it.
pub const DRIVE_TRAINING_ACK_KEY: &str = "driveTrainingAck";
/// `DRIVE_CHANNELS.stateChanged`
const STATE_CHANGED: &str = "drive:state-changed";

const SEARCH_LIMIT_MAX: f64 = 20.0;
/// What the AI's Drive tools answer while Drive is not usable by it
const NOT_AVAILABLE: &str = "Google Drive is not available now.";
/// What the AI's Drive tools answer while the AI in use is a free connection
/// that may use what it receives to train models (drive-consent.ts)
const FREE_AI_REFUSAL: &str = "Drive files are not given to the AI in use: it is a free connection that may use what it receives to train models. Tell the person to choose another AI to work with Drive files.";

/// What the shell entry installs as `setAiRunGuard`'s check and keeps for the
/// tabs: the `DriveService` of drive-ipc.ts. The port adds it to the
/// batches' provided table when it is built.
pub trait DriveService {
    /// A document opened from Drive goes out with every AI request of its
    /// tab: a free connection, which may train on it, does not get it
    /// (decision 0085). The refusal for a run, or none when it may go.
    fn ai_run_refusal(&self, input: &AiRunGuardInput) -> Option<String>;
    /// A local path is a copy of a Drive file: reopen through Drive so a
    /// stale copy is refreshed. False when `path` is not such a copy; else
    /// `done` is told, on the core thread, whether a tab opened.
    fn reopen(&self, path: &str, done: Box<dyn FnOnce(bool) + Send>) -> bool;
    fn stop(&self);
}

/// Why Google's picker did not run or came back with nothing
/// (`DriveConnectFailureReason | 'busy' | 'not-connected'`)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PickFailure {
    Busy,
    NotConnected,
    Training,
    Cancelled,
    Timeout,
    Denied,
    Scope,
    Network,
}

impl PickFailure {
    fn as_str(self) -> &'static str {
        match self {
            PickFailure::Busy => "busy",
            PickFailure::NotConnected => "not-connected",
            PickFailure::Training => "training",
            PickFailure::Cancelled => "cancelled",
            PickFailure::Timeout => "timeout",
            PickFailure::Denied => "denied",
            PickFailure::Scope => "scope",
            PickFailure::Network => "network",
        }
    }

    /// `result.reason === 'unavailable' ? 'network' : result.reason`
    fn of(failure: SignInFailure) -> PickFailure {
        match failure {
            SignInFailure::Cancelled => PickFailure::Cancelled,
            SignInFailure::Timeout => PickFailure::Timeout,
            SignInFailure::Denied => PickFailure::Denied,
            SignInFailure::Scope => PickFailure::Scope,
            SignInFailure::Network | SignInFailure::Unavailable => PickFailure::Network,
        }
    }
}

type PickOutcome = Result<Vec<String>, PickFailure>;

fn text(value: &str) -> IpcValue {
    IpcValue::String(value.to_owned())
}

fn object(entries: Vec<(&str, IpcValue)>) -> IpcValue {
    IpcValue::Object(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
    )
}

/// `{ ok: false, reason }`
fn refused(reason: &str) -> IpcValue {
    object(vec![
        ("ok", IpcValue::Bool(false)),
        ("reason", text(reason)),
    ])
}

/// `{ ok: false, kind }`
fn failed_kind(kind: &str) -> IpcValue {
    object(vec![("ok", IpcValue::Bool(false)), ("kind", text(kind))])
}

/// `{ ok: false, error }`
fn failed_error(error: &str) -> IpcValue {
    object(vec![("ok", IpcValue::Bool(false)), ("error", text(error))])
}

fn ok_only() -> IpcValue {
    object(vec![("ok", IpcValue::Bool(true))])
}

fn node_error(error: NodeError) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: error.message,
    }
}

/// The value of `key` of a plain object argument; none for anything else
/// (`(raw && typeof raw === 'object' ? raw : {}).key`)
fn field<'a>(raw: Option<&'a IpcValue>, key: &str) -> Option<&'a IpcValue> {
    match raw {
        Some(IpcValue::Object(entries)) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn string_of(value: Option<&IpcValue>) -> Option<&str> {
    match value {
        Some(IpcValue::String(s)) => Some(s),
        _ => None,
    }
}

/// `Number(value)`
fn js_number(value: Option<&IpcValue>) -> f64 {
    let json = value.and_then(to_json);
    to_primitive(json.as_ref()).map_or(f64::NAN, |p| p.to_number())
}

/// `/^[\w-]{1,200}$/.test(id)`
fn is_drive_id(id: &str) -> bool {
    (1..=200).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `listingOf(raw)`
fn listing_of(raw: Option<&IpcValue>) -> Option<Listing> {
    match string_of(field(raw, "kind")) {
        Some("recent") => Some(Listing::Recent),
        Some("search") => {
            let typed = trim(string_of(field(raw, "text"))?);
            (!typed.is_empty()).then(|| Listing::Search(slice_utf16(typed, 0, 200)))
        }
        _ => None,
    }
}

/// `toEntry(file)`
fn to_entry(client: &DriveClientHost, file: &DriveFile) -> IpcValue {
    let (shown_name, shown_mime, id) = match &file.shortcut_target {
        Some(target) => (
            file.name.as_str(),
            target.mime_type.as_str(),
            target.id.as_str(),
        ),
        None => (
            file.name.as_str(),
            file.mime_type.as_str(),
            file.id.as_str(),
        ),
    };
    let folder = shown_mime == FOLDER_MIME;
    let mut entry = vec![
        ("id", text(id)),
        ("name", text(&file.name)),
        ("type", text(entry_type(client, shown_name, shown_mime))),
        ("modifiedTime", text(&file.modified_time)),
        (
            "openable",
            IpcValue::Bool(!folder && client.open_plan(shown_name, shown_mime) != OpenPlan::None),
        ),
        ("canEdit", IpcValue::Bool(file.can_edit)),
        (
            "google",
            IpcValue::Bool(client.is_google_native(shown_mime) && !folder),
        ),
    ];
    if let Some(size) = file.size {
        entry.push(("size", IpcValue::Number(size as f64)));
    }
    object(entry)
}

/// The dialogs of the sync (`ask` and `notify` of drive-ipc.ts)
struct DialogUi {
    dialogs: DialogsHost,
    main_window: MainWindowHost,
    shell: DriveShellHost,
    services: Services,
}

impl DialogUi {
    fn t(&self, key: &str, params: &[(&str, &str)]) -> String {
        let shell = self.shell.clone();
        let lang = on_core(&*self.services.core, move || shell.lang());
        drive_text(lang, key, params)
    }
}

impl SyncUi for DialogUi {
    fn ask(&self, question: &SyncQuestion) -> SyncAnswer {
        let (message, answers): (String, &[SyncAnswer]) = match question {
            SyncQuestion::Changed { name } => (
                self.t("askChanged", &[("name", name)]),
                &[SyncAnswer::Overwrite, SyncAnswer::Copy, SyncAnswer::Local],
            ),
            SyncQuestion::ReadOnly { name } => (
                self.t("askReadOnly", &[("name", name)]),
                &[SyncAnswer::Copy, SyncAnswer::Local],
            ),
            SyncQuestion::Gone { name } => (
                self.t("askGone", &[("name", name)]),
                &[SyncAnswer::Copy, SyncAnswer::Local],
            ),
        };
        let buttons = answers
            .iter()
            .map(|a| match a {
                SyncAnswer::Overwrite => self.t("btnOverwrite", &[]),
                SyncAnswer::Copy => self.t("btnCopy", &[]),
                SyncAnswer::Local => self.t("btnLocal", &[]),
            })
            .collect();
        let options = MessageBox {
            kind: Some("warning".into()),
            title: Some(self.t("dialogTitle", &[])),
            message,
            detail: Some(self.t("askDetail", &[])),
            buttons,
            default_id: answers.iter().position(|a| *a == SyncAnswer::Copy),
            cancel_id: answers.iter().position(|a| *a == SyncAnswer::Local),
            checkbox_label: None,
        };
        let answered = self.dialogs.message(self.main_window.window(), &options);
        answers
            .get(answered.response)
            .copied()
            .unwrap_or(SyncAnswer::Local)
    }

    fn notify(&self, notice: &SyncNotice) {
        let (kind, message) = match notice {
            SyncNotice::SavedOfficeCopy { name, copy_name } => (
                "info",
                self.t(
                    "noticeOfficeCopy",
                    &[("name", name), ("copyName", copy_name)],
                ),
            ),
            SyncNotice::SavedCopy { copy_name, .. } => {
                ("info", self.t("noticeCopy", &[("copyName", copy_name)]))
            }
            SyncNotice::UploadFailed { name } => {
                ("warning", self.t("noticeUploadFailed", &[("name", name)]))
            }
        };
        let options = MessageBox {
            kind: Some(kind.into()),
            title: Some(self.t("dialogTitle", &[])),
            message,
            buttons: vec![self.t("ok", &[])],
            ..MessageBox::default()
        };
        let dialogs = self.dialogs.clone();
        let parent = self.main_window.window();
        // `void showMessageBox(...)`: nothing waits for it
        self.services.workers.spawn(Box::new(move || {
            dialogs.message(parent, &options);
        }));
    }

    fn copy_name(&self, name: &str) -> String {
        copy_file_name(name, &self.t("copySuffix", &[]))
    }
}

/// What the state of the connection shows to the browser round: the page
/// Google sends the person back to
#[derive(Clone, Copy)]
enum Round {
    SignIn,
    Pick,
}

struct Inner {
    services: Services,
    client: DriveClientHost,
    shell: DriveShellHost,
    os_shell: OsShellHost,
    files: Arc<DriveFiles>,
    ai: DriveAi,
    connecting: AtomicBool,
    picking: AtomicBool,
    was_connected: AtomicBool,
    attach_pruned: AtomicBool,
    /// `Date.now()`, as the sync and the attachments see it
    now: Clock,
}

impl Inner {
    /// `APP_SETTINGS_PATH()`
    fn settings_path(&self) -> String {
        self.services
            .paths
            .path(PathName::UserData)
            .join("app-settings.json")
            .to_string_lossy()
            .into_owned()
    }

    /// `aiAccess(settingsPath)`: on unless the person switched it off
    fn ai_access(&self) -> bool {
        read_app_settings(&self.settings_path()).get(DRIVE_AI_ACCESS_KEY)
            != Some(&JsonValue::Bool(false))
    }

    /// `trainingAck(settingsPath)`
    fn training_ack(&self) -> bool {
        read_app_settings(&self.settings_path()).get(DRIVE_TRAINING_ACK_KEY)
            == Some(&JsonValue::Bool(true))
    }

    fn lang(&self) -> Lang {
        let shell = self.shell.clone();
        on_core(&*self.services.core, move || shell.lang())
    }

    fn t(&self, key: &str, params: &[(&str, &str)]) -> String {
        drive_text(self.lang(), key, params)
    }

    /// `deps.freeAi()`: the AI the person chose is a free connection
    fn free_ai(&self) -> bool {
        let shell = self.shell.clone();
        let settings = on_core(&*self.services.core, move || shell.stored_ai_settings());
        free_ai_in_use(&settings)
    }

    /// `aiEnabled()`
    fn ai_enabled(&self) -> bool {
        self.client.connected() && self.ai_access() && self.training_ack()
    }

    /// `uiState()`
    fn ui_state(&self) -> IpcValue {
        let state = self.client.state();
        let ai = IpcValue::Bool(self.ai_access());
        let ack = IpcValue::Bool(self.training_ack());
        if state == ConnectionState::Unavailable {
            return object(vec![("state", text("unavailable"))]);
        }
        if self.connecting.load(Ordering::SeqCst) {
            return object(vec![
                ("state", text("connecting")),
                ("aiAccess", ai),
                ("trainingAck", ack),
            ]);
        }
        match state {
            ConnectionState::Disconnected { expired } => object(vec![
                ("state", text("disconnected")),
                ("expired", IpcValue::Bool(expired)),
                ("aiAccess", ai),
                ("trainingAck", ack),
            ]),
            ConnectionState::Connected { account, persisted } => {
                let account = account.unwrap_or_default();
                object(vec![
                    ("state", text("connected")),
                    ("name", text(&account.display_name)),
                    ("email", text(&account.email_address)),
                    ("persisted", IpcValue::Bool(persisted)),
                    ("aiAccess", ai),
                    ("trainingAck", ack),
                    (
                        "picking",
                        IpcValue::Bool(self.picking.load(Ordering::SeqCst)),
                    ),
                ])
            }
            ConnectionState::Unavailable => unreachable!("answered above"),
        }
    }

    /// `broadcast()`: every window learns the state; callable from any thread
    fn broadcast(&self) {
        self.services
            .events
            .emit(Target::All, STATE_CHANGED, vec![self.ui_state()]);
    }

    /// `connection.onChange(...)`
    fn on_connection_change(&self) {
        let now = self.client.connected();
        let was = self.was_connected.swap(now, Ordering::SeqCst);
        if now && !was {
            self.files.reconnected();
        }
        if !now {
            self.ai.clear();
        }
        self.broadcast();
    }

    /// Answers `reply` on the core thread
    fn answer(&self, reply: Responder, value: Reply) {
        self.services
            .core
            .post(Box::new(move || reply.reply(value)));
    }

    /// Google's page in the system browser, and what the browser shows once
    /// it is back here (`browserRound(done)`)
    fn browser_round(&self, round: Round) -> BrowserRound {
        let lang = self.lang().as_str().to_owned();
        let (done_title, done_body) = match round {
            Round::SignIn => ("pageDoneTitle", "pageDoneBody"),
            Round::Pick => ("pagePickedTitle", "pagePickedBody"),
        };
        let os_shell = self.os_shell.clone();
        BrowserRound {
            open_browser: Arc::new(move |url| {
                let Some(target) = safe_external_url(Some(url), None) else {
                    return false;
                };
                if !target.starts_with("https://accounts.google.com/") {
                    return false;
                }
                os_shell.open_external(&target).is_ok()
            }),
            done: SignInPage {
                lang: lang.clone(),
                title: self.t(done_title, &[]),
                body: self.t(done_body, &[]),
            },
            failed: SignInPage {
                lang,
                title: self.t("pageFailedTitle", &[]),
                body: self.t("pageFailedBody", &[]),
            },
        }
    }

    /// `pickFiles()`: Google's picker in the browser (decision 0085), one at
    /// a time, on a connection made after the person confirmed
    /// `DRIVE_TRAINING_ACK_KEY`. `then` runs on the core thread.
    fn pick_files(self: &Arc<Self>, then: impl FnOnce(PickOutcome) + Send + 'static) {
        if !self.client.connected() {
            return then(Err(PickFailure::NotConnected));
        }
        if !self.training_ack() {
            return then(Err(PickFailure::Training));
        }
        if self.picking.load(Ordering::SeqCst) || self.connecting.load(Ordering::SeqCst) {
            return then(Err(PickFailure::Busy));
        }
        self.picking.store(true, Ordering::SeqCst);
        self.broadcast();
        let round = self.browser_round(Round::Pick);
        let inner = self.clone();
        self.services.workers.spawn(Box::new(move || {
            let result = inner.client.pick(&round, true);
            let core = inner.services.core.clone();
            core.post(Box::new(move || {
                inner.picking.store(false, Ordering::SeqCst);
                inner.broadcast();
                then(result.map_err(PickFailure::of));
            }));
        }));
    }
}

/// `registerDriveIpc(deps)`'s handlers
pub struct DrivePort {
    inner: Arc<Inner>,
}

impl DrivePort {
    pub fn new(
        services: &Services,
        client: DriveClientHost,
        shell: DriveShellHost,
        os_shell: OsShellHost,
        ui: Arc<dyn SyncUi>,
        config: FilesConfig,
    ) -> DrivePort {
        let cache_dir = services.paths.path(PathName::UserData).join("drive-cache");
        let files = DriveFiles::new(
            client.clone(),
            shell.clone(),
            ui,
            services.core.clone(),
            services.workers.clone(),
            cache_dir,
            config.clone(),
        );
        let inner = Arc::new(Inner {
            services: services.clone(),
            ai: DriveAi::with_clock(client.clone(), shell.clone(), config.now.clone()),
            client,
            shell,
            os_shell,
            files,
            connecting: AtomicBool::new(false),
            picking: AtomicBool::new(false),
            was_connected: AtomicBool::new(false),
            attach_pruned: AtomicBool::new(false),
            now: config.now,
        });
        let weak: Weak<Inner> = Arc::downgrade(&inner);
        inner.client.on_change(Arc::new(move || {
            if let Some(inner) = weak.upgrade() {
                inner.on_connection_change();
            }
        }));
        DrivePort { inner }
    }

    /// `void connection.load().then(() => { if available, void files.start() })`
    pub fn start(&self) {
        let inner = self.inner.clone();
        self.inner.services.workers.spawn(Box::new(move || {
            inner.client.load();
            if inner.client.state() != ConnectionState::Unavailable {
                let _ = inner.files.start();
            }
        }));
    }

    /// `DRIVE_CHANNELS.setAiAccess` and `setTrainingAck`
    fn set_flag(&self, key: &str, args: &[IpcValue], reply: Responder) {
        let on = matches!(args.first(), Some(IpcValue::Bool(true)));
        let written =
            write_app_setting(&self.inner.settings_path(), key, Some(JsonValue::Bool(on)));
        reply.reply(match written {
            Ok(()) => {
                self.inner.broadcast();
                Ok(self.inner.ui_state())
            }
            Err(error) => Err(node_error(error)),
        })
    }

    /// The AI's tools refuse first when Drive is not usable by the AI, then
    /// when the AI in use is a free connection; none to let the call go
    fn ai_refusal(&self) -> Option<IpcValue> {
        if !self.inner.ai_enabled() {
            return Some(failed_error(NOT_AVAILABLE));
        }
        self.inner.free_ai().then(|| failed_error(FREE_AI_REFUSAL))
    }
}

impl Drive for DrivePort {
    fn drive_state(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        reply.reply(Ok(self.inner.ui_state()))
    }

    fn drive_connect(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let inner = &self.inner;
        if !inner.training_ack() {
            return reply.reply(Ok(refused("training")));
        }
        inner.connecting.store(true, Ordering::SeqCst);
        inner.broadcast();
        let round = inner.browser_round(Round::SignIn);
        let inner = inner.clone();
        self.inner.services.workers.spawn(Box::new(move || {
            let result = inner.client.connect(&round);
            let core = inner.services.core.clone();
            core.post(Box::new(move || {
                inner.connecting.store(false, Ordering::SeqCst);
                inner.broadcast();
                reply.reply(Ok(match result {
                    Ok(()) => ok_only(),
                    Err(failure) => refused(PickFailure::of(failure).as_str()),
                }));
            }));
        }));
    }

    fn drive_cancel_connect(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        self.inner.client.cancel_connect();
        reply.reply(Ok(IpcValue::Undefined))
    }

    fn drive_disconnect(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let inner = self.inner.clone();
        self.inner.services.workers.spawn(Box::new(move || {
            inner.client.disconnect();
            let core = inner.services.core.clone();
            core.post(Box::new(move || {
                inner.broadcast();
                reply.reply(Ok(IpcValue::Undefined));
            }));
        }));
    }

    fn drive_set_ai_access(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.set_flag(DRIVE_AI_ACCESS_KEY, &args, reply)
    }

    fn drive_set_training_ack(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.set_flag(DRIVE_TRAINING_ACK_KEY, &args, reply)
    }

    fn drive_list(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let Some(listing) = listing_of(args.first()) else {
            return reply.reply(Ok(failed_kind("not-found")));
        };
        let page_token = string_of(args.get(1))
            .filter(|token| token.encode_utf16().count() < 2000)
            .map(str::to_owned);
        let inner = self.inner.clone();
        self.inner.services.workers.spawn(Box::new(move || {
            let answer = match inner.client.list(&listing, page_token.as_deref(), None) {
                Err(error) => failed_kind(error.kind()),
                Ok(page) => {
                    let entries = page
                        .files
                        .iter()
                        .map(|file| to_entry(&inner.client, file))
                        .collect();
                    let mut out = vec![
                        ("ok", IpcValue::Bool(true)),
                        ("files", IpcValue::Array(entries)),
                    ];
                    if let Some(next) = page.next_page_token.filter(|t| !t.is_empty()) {
                        out.push(("nextPageToken", IpcValue::String(next)));
                    }
                    object(out)
                }
            };
            inner.answer(reply, Ok(answer));
        }));
    }

    fn drive_connected(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        reply.reply(Ok(IpcValue::Bool(self.inner.client.connected())))
    }

    fn drive_pick_attachments(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let inner = &self.inner;
        // asked before the picker opens, so nothing is fetched for an AI that may train on it
        if inner.client.connected() && inner.free_ai() {
            return reply.reply(Ok(refused("free-ai")));
        }
        let me = inner.clone();
        inner.pick_files(move |outcome| {
            let picked = match outcome {
                Err(failure) => {
                    let kept = matches!(
                        failure,
                        PickFailure::Busy
                            | PickFailure::NotConnected
                            | PickFailure::Training
                            | PickFailure::Cancelled
                    );
                    return reply.reply(Ok(refused(if kept {
                        failure.as_str()
                    } else {
                        "failed"
                    })));
                }
                Ok(picked) if picked.is_empty() => return reply.reply(Ok(refused("cancelled"))),
                Ok(picked) => picked,
            };
            let dir = me
                .services
                .paths
                .path(PathName::Temp)
                .join("seuoffice-drive-attach");
            let worker = me.clone();
            me.services.workers.spawn(Box::new(move || {
                let now = (worker.now)();
                let got =
                    download_picks(&*worker.client, &picked, &dir, now, &worker.attach_pruned);
                let answer = match got {
                    Ok(got) => Ok(object(vec![
                        ("ok", IpcValue::Bool(true)),
                        (
                            "paths",
                            IpcValue::Array(got.paths.iter().map(|p| text(p)).collect()),
                        ),
                        ("skipped", IpcValue::Number(got.skipped as f64)),
                        ("failed", IpcValue::Number(got.failed as f64)),
                    ])),
                    Err(error) => Err(node_error(error)),
                };
                worker.answer(reply, answer);
            }));
        });
    }

    fn drive_pick_open(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let me = self.inner.clone();
        self.inner.pick_files(move |outcome| {
            let picked = match outcome {
                Err(failure) => return reply.reply(Ok(refused(failure.as_str()))),
                Ok(picked) => picked,
            };
            let worker = me.clone();
            me.services.workers.spawn(Box::new(move || {
                let mut opened = 0usize;
                let mut problem: Option<OpenFailure> = None;
                for id in &picked {
                    match worker.files.open(id) {
                        Ok(()) => opened += 1,
                        Err(failure) => {
                            problem.get_or_insert(failure);
                        }
                    }
                }
                let mut out = vec![
                    ("ok", IpcValue::Bool(true)),
                    ("opened", IpcValue::Number(opened as f64)),
                ];
                if let Some(problem) = problem {
                    out.push(("problem", text(problem.kind())));
                }
                worker.answer(reply, Ok(object(out)));
            }));
        });
    }

    fn drive_open(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let Some(id) = string_of(args.first()).filter(|id| is_drive_id(id)) else {
            return reply.reply(Ok(failed_kind("not-found")));
        };
        let id = id.to_owned();
        let inner = self.inner.clone();
        self.inner.services.workers.spawn(Box::new(move || {
            let answer = match inner.files.open(&id) {
                Ok(()) => ok_only(),
                Err(failure) => failed_kind(failure.kind()),
            };
            inner.answer(reply, Ok(answer));
        }));
    }

    fn drive_ai_enabled(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        reply.reply(Ok(IpcValue::Bool(self.inner.ai_enabled())))
    }

    fn drive_ai_search(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        if let Some(refusal) = self.ai_refusal() {
            return reply.reply(Ok(refusal));
        }
        let raw = args.first();
        let limit = js_number(field(raw, "limit"));
        // `Number(r.limit) || 10`
        let limit = if limit.is_nan() || limit == 0.0 {
            10.0
        } else {
            limit
        };
        let limit = limit.floor().clamp(1.0, SEARCH_LIMIT_MAX) as usize;
        let query = string_of(field(raw, "q")).unwrap_or("").to_owned();
        let inner = self.inner.clone();
        self.inner.services.workers.spawn(Box::new(move || {
            let answer = match inner.ai.search(&query, limit) {
                Ok(hits) => object(vec![
                    ("ok", IpcValue::Bool(true)),
                    (
                        "hits",
                        IpcValue::Array(
                            hits.iter()
                                .map(|hit| {
                                    object(vec![
                                        ("id", text(&hit.id)),
                                        ("name", text(&hit.name)),
                                        ("type", text(hit.kind)),
                                        ("modified", text(&hit.modified)),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                ]),
                Err(error) => failed_error(&error),
            };
            inner.answer(reply, Ok(answer));
        }));
    }

    fn drive_ai_read(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        if let Some(refusal) = self.ai_refusal() {
            return reply.reply(Ok(refusal));
        }
        let raw = args.first();
        let id = string_of(field(raw, "id")).unwrap_or("");
        if !is_drive_id(id) {
            return reply.reply(Ok(failed_error("not a Drive file id")));
        }
        let id = id.to_owned();
        // `Number(r.offset) || 0`
        let offset = js_number(field(raw, "offset"));
        let offset = if offset.is_nan() { 0.0 } else { offset };
        let inner = self.inner.clone();
        self.inner.services.workers.spawn(Box::new(move || {
            let answer = match inner.ai.read(&id, offset) {
                Ok(page) => object(vec![
                    ("ok", IpcValue::Bool(true)),
                    (
                        "page",
                        object(vec![
                            ("name", text(&page.name)),
                            ("text", text(&page.text)),
                            ("totalChars", IpcValue::Number(page.total_chars as f64)),
                            ("offset", IpcValue::Number(page.offset as f64)),
                        ]),
                    ),
                ]),
                Err(error) => failed_error(&error),
            };
            inner.answer(reply, Ok(answer));
        }));
    }
}

impl DriveService for DrivePort {
    fn ai_run_refusal(&self, input: &AiRunGuardInput) -> Option<String> {
        if !is_free_ai(&input.provider, Some(&input.model)) {
            return None;
        }
        let path = self.inner.shell.document_of(input.sender_id)?;
        self.inner.files.entry_for(&path)?;
        Some(self.inner.t("freeAiDocRefusal", &[]))
    }

    fn reopen(&self, path: &str, done: Box<dyn FnOnce(bool) + Send>) -> bool {
        let Some(entry) = self.inner.files.entry_for(path) else {
            return false;
        };
        let inner = self.inner.clone();
        let path = path.to_owned();
        self.inner.services.workers.spawn(Box::new(move || {
            let opened = inner.files.open(&entry.source_id).is_ok() || {
                let shell = inner.shell.clone();
                on_core(&*inner.services.core, move || shell.open_path(&path))
            };
            inner.services.core.post(Box::new(move || done(opened)));
        }));
        true
    }

    fn stop(&self) {
        self.inner.files.stop();
        self.inner.client.cancel_connect();
    }
}

/// The host the shell inserts for this port. Building it starts loading the
/// kept token and adds the [`DriveService`] to what the batches provide.
pub fn factory() -> crate::Factory<dyn Drive> {
    factory_with(FilesConfig::default())
}

/// [`factory`] with the sync's clock and timings given (the probe pins the
/// clock so a run can be compared with the TypeScript's)
pub fn factory_with(config: FilesConfig) -> crate::Factory<dyn Drive> {
    crate::Factory::new(move |services, provided| {
        let hosts = &services.hosts;
        let batch = shell_contract::Batch::A;
        let shell = hosts.need::<DriveShellHost>(batch)?;
        let ui = Arc::new(DialogUi {
            dialogs: hosts.need::<DialogsHost>(batch)?,
            main_window: hosts.need::<MainWindowHost>(batch)?,
            shell: shell.clone(),
            services: services.clone(),
        });
        let port = Rc::new(DrivePort::new(
            services,
            hosts.need::<DriveClientHost>(batch)?,
            shell,
            hosts.need::<OsShellHost>(batch)?,
            ui,
            config.clone(),
        ));
        port.start();
        provided.add::<dyn DriveService>(port.clone());
        let port: Rc<dyn Drive> = port;
        Ok(port)
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::client::{DriveAccount, DriveError, ListPage, ShortcutTarget};
    use super::testing::{GOOGLE_DOC, Rig, b, call, n, obj, rig, s};
    use super::*;

    fn ready(r: &Rig) {
        r.client.connect_as("Dana");
        let _ = call(|cx, re| r.port.drive_set_training_ack(cx, vec![b(true)], re));
    }

    fn picked(ids: &[&str]) -> Result<Vec<String>, SignInFailure> {
        Ok(ids.iter().map(|id| id.to_string()).collect())
    }

    #[test]
    fn the_state_follows_the_connection_and_the_settings() {
        let r = rig("state");
        r.client.set_state(ConnectionState::Unavailable);
        assert_eq!(
            call(|cx, re| r.port.drive_state(cx, vec![], re)),
            Ok(obj(&[("state", s("unavailable"))]))
        );

        r.client
            .set_state(ConnectionState::Disconnected { expired: true });
        assert_eq!(
            call(|cx, re| r.port.drive_state(cx, vec![], re)),
            Ok(obj(&[
                ("state", s("disconnected")),
                ("expired", b(true)),
                ("aiAccess", b(true)),
                ("trainingAck", b(false)),
            ]))
        );

        r.client.set_state(ConnectionState::Connected {
            account: Some(DriveAccount {
                display_name: "Dana".into(),
                email_address: "dana@example.com".into(),
            }),
            persisted: false,
        });
        let _ = call(|cx, re| r.port.drive_set_ai_access(cx, vec![b(false)], re));
        assert_eq!(
            call(|cx, re| r.port.drive_state(cx, vec![], re)),
            Ok(obj(&[
                ("state", s("connected")),
                ("name", s("Dana")),
                ("email", s("dana@example.com")),
                ("persisted", b(false)),
                ("aiAccess", b(false)),
                ("trainingAck", b(false)),
                ("picking", b(false)),
            ]))
        );

        // an account Drive has not answered for yet shows empty
        r.client.set_state(ConnectionState::Connected {
            account: None,
            persisted: true,
        });
        let state = call(|cx, re| r.port.drive_state(cx, vec![], re)).unwrap();
        let IpcValue::Object(fields) = state else {
            panic!("{state:?}")
        };
        assert_eq!(fields[1], ("name".to_string(), s("")));
        assert_eq!(fields[2], ("email".to_string(), s("")));
    }

    #[test]
    fn a_busy_connection_shows_as_connecting() {
        let r = rig("connecting-state");
        r.port.inner.connecting.store(true, Ordering::SeqCst);
        assert_eq!(
            call(|cx, re| r.port.drive_state(cx, vec![], re)),
            Ok(obj(&[
                ("state", s("connecting")),
                ("aiAccess", b(true)),
                ("trainingAck", b(false)),
            ]))
        );
        r.client.set_state(ConnectionState::Unavailable);
        assert_eq!(
            call(|cx, re| r.port.drive_state(cx, vec![], re)),
            Ok(obj(&[("state", s("unavailable"))]))
        );
    }

    #[test]
    fn the_flags_are_written_broadcast_and_answered_as_the_new_state() {
        let r = rig("flags");
        // anything but `true` switches them off
        let state = call(|cx, re| r.port.drive_set_training_ack(cx, vec![s("yes")], re)).unwrap();
        let IpcValue::Object(fields) = &state else {
            panic!("{state:?}")
        };
        assert_eq!(
            fields.last().unwrap(),
            &("trainingAck".to_string(), b(false))
        );

        let state = call(|cx, re| r.port.drive_set_training_ack(cx, vec![b(true)], re)).unwrap();
        let IpcValue::Object(fields) = &state else {
            panic!("{state:?}")
        };
        assert_eq!(
            fields.last().unwrap(),
            &("trainingAck".to_string(), b(true))
        );
        let _ = call(|cx, re| r.port.drive_set_ai_access(cx, vec![b(false)], re));

        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(r.dir.join("app-settings.json")).unwrap())
                .unwrap();
        assert_eq!(saved["driveTrainingAck"], true);
        assert_eq!(saved["driveAiAccess"], false);
        assert_eq!(
            r.events.states(),
            vec!["disconnected"; 3],
            "every write tells every window"
        );
        assert!(
            r.events
                .0
                .lock()
                .unwrap()
                .iter()
                .all(|(target, ..)| *target == Target::All)
        );
    }

    #[test]
    fn a_failed_settings_write_rejects_and_tells_nobody() {
        let r = rig("flags-fail");
        // a folder where the settings file belongs
        std::fs::create_dir_all(r.dir.join("app-settings.json")).unwrap();
        let answer = call(|cx, re| r.port.drive_set_ai_access(cx, vec![b(true)], re));
        assert!(answer.is_err(), "{answer:?}");
        assert!(r.events.states().is_empty());
    }

    #[test]
    fn connecting_waits_for_the_training_confirmation() {
        let r = rig("connect-ack");
        assert_eq!(
            call(|cx, re| r.port.drive_connect(cx, vec![], re)),
            Ok(obj(&[("ok", b(false)), ("reason", s("training"))]))
        );
        assert!(r.client.rounds.lock().unwrap().is_empty());
        assert!(r.events.states().is_empty());
    }

    #[test]
    fn connecting_shows_connecting_then_the_result_and_opens_only_googles_pages() {
        let r = rig("connect");
        let _ = call(|cx, re| r.port.drive_set_training_ack(cx, vec![b(true)], re));
        r.events.0.lock().unwrap().clear();
        assert_eq!(
            call(|cx, re| r.port.drive_connect(cx, vec![], re)),
            Ok(obj(&[("ok", b(true))]))
        );
        let states = r.events.states();
        assert_eq!(states.first().map(String::as_str), Some("connecting"));
        assert_eq!(states.last().map(String::as_str), Some("connected"));

        let round = r.client.rounds.lock().unwrap()[0].clone();
        assert!((round.open_browser)(
            "https://accounts.google.com/o/oauth2/v2/auth?x=1"
        ));
        assert_eq!(
            r.os.opened.lock().unwrap().as_slice(),
            ["https://accounts.google.com/o/oauth2/v2/auth?x=1"]
        );
        for url in [
            "https://accounts.google.com.evil.example/",
            "http://accounts.google.com/",
            "https://evil.example/https://accounts.google.com/",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert!(!(round.open_browser)(url), "{url}");
        }
        assert_eq!(r.os.opened.lock().unwrap().len(), 1);
        assert_eq!(round.done.lang, "en");
        assert_ne!(round.done.title, round.failed.title);
    }

    #[test]
    fn a_sign_in_that_fails_says_why_and_leaves_the_connecting_state() {
        let r = rig("connect-fail");
        let _ = call(|cx, re| r.port.drive_set_training_ack(cx, vec![b(true)], re));
        for (failure, reason) in [
            (SignInFailure::Cancelled, "cancelled"),
            (SignInFailure::Timeout, "timeout"),
            (SignInFailure::Denied, "denied"),
            (SignInFailure::Scope, "scope"),
            (SignInFailure::Network, "network"),
            (SignInFailure::Unavailable, "network"),
        ] {
            *r.client.connect_result.lock().unwrap() = Err(failure);
            assert_eq!(
                call(|cx, re| r.port.drive_connect(cx, vec![], re)),
                Ok(obj(&[("ok", b(false)), ("reason", s(reason))]))
            );
            assert!(!r.port.inner.connecting.load(Ordering::SeqCst));
        }
        assert_eq!(
            r.events.states().last().map(String::as_str),
            Some("disconnected")
        );
    }

    #[test]
    fn cancel_reaches_the_connection_and_disconnect_tells_everyone() {
        let r = rig("cancel");
        ready(&r);
        assert_eq!(
            call(|cx, re| r.port.drive_cancel_connect(cx, vec![], re)),
            Ok(IpcValue::Undefined)
        );
        assert_eq!(r.client.cancels.load(Ordering::SeqCst), 1);
        assert_eq!(
            call(|cx, re| r.port.drive_connected(cx, vec![], re)),
            Ok(b(true))
        );
        assert_eq!(
            call(|cx, re| r.port.drive_disconnect(cx, vec![], re)),
            Ok(IpcValue::Undefined)
        );
        assert_eq!(r.client.disconnects.load(Ordering::SeqCst), 1);
        assert_eq!(
            r.events.states().last().map(String::as_str),
            Some("disconnected")
        );
        assert_eq!(
            call(|cx, re| r.port.drive_connected(cx, vec![], re)),
            Ok(b(false))
        );
    }

    #[test]
    fn the_ai_needs_a_connection_the_switch_and_the_confirmation() {
        let r = rig("ai-enabled");
        let enabled = |r: &Rig| call(|cx, re| r.port.drive_ai_enabled(cx, vec![], re));
        assert_eq!(enabled(&r), Ok(b(false)));
        r.client.connect_as("Dana");
        assert_eq!(enabled(&r), Ok(b(false)), "not confirmed yet");
        let _ = call(|cx, re| r.port.drive_set_training_ack(cx, vec![b(true)], re));
        assert_eq!(
            enabled(&r),
            Ok(b(true)),
            "the switch is on until it is turned off"
        );
        let _ = call(|cx, re| r.port.drive_set_ai_access(cx, vec![b(false)], re));
        assert_eq!(enabled(&r), Ok(b(false)));
        let _ = call(|cx, re| r.port.drive_set_ai_access(cx, vec![b(true)], re));
        assert_eq!(enabled(&r), Ok(b(true)));
        r.client
            .set_state(ConnectionState::Disconnected { expired: false });
        assert_eq!(enabled(&r), Ok(b(false)));
    }

    fn search(r: &Rig, raw: IpcValue) -> Result<IpcValue, IpcError> {
        call(|cx, re| r.port.drive_ai_search(cx, vec![raw], re))
    }

    fn not_available() -> Result<IpcValue, IpcError> {
        Ok(obj(&[("ok", b(false)), ("error", s(NOT_AVAILABLE))]))
    }

    #[test]
    fn the_ai_search_is_refused_until_allowed_and_for_a_free_ai() {
        let r = rig("ai-search-refused");
        assert_eq!(search(&r, obj(&[("q", s("budget"))])), not_available());
        ready(&r);
        r.shell
            .use_ai(r#"{"provider":"openrouter","providers":{"openrouter":{"model":"x:free"}}}"#);
        assert_eq!(
            search(&r, obj(&[("q", s("budget"))])),
            Ok(obj(&[("ok", b(false)), ("error", s(FREE_AI_REFUSAL))]))
        );
        assert!(r.client.lists.lock().unwrap().is_empty());
        r.shell.use_ai(r#"{"provider":"gemini","providers":{}}"#);
        assert_eq!(
            search(&r, obj(&[("q", s("budget"))])),
            Ok(obj(&[("ok", b(false)), ("error", s(FREE_AI_REFUSAL))]))
        );
        assert!(r.client.lists.lock().unwrap().is_empty());
    }

    #[test]
    fn the_ai_search_clamps_its_limit_and_lists_what_it_found() {
        let r = rig("ai-search");
        ready(&r);
        let found = r.client.add(
            "f1",
            "Budget.xlsx",
            "application/x",
            "2026-01-02T00:00:00Z",
            b"1",
        );
        let folder = DriveFile {
            id: "d1".into(),
            name: "Budgets".into(),
            mime_type: FOLDER_MIME.into(),
            modified_time: "2026-01-03T00:00:00Z".into(),
            ..DriveFile::default()
        };
        *r.client.list_answer.lock().unwrap() = Ok(ListPage {
            files: vec![found, folder],
            next_page_token: None,
        });

        let answer = search(&r, obj(&[("q", s("  budget  ")), ("limit", n(999.0))])).unwrap();
        assert_eq!(
            answer,
            obj(&[
                ("ok", b(true)),
                (
                    "hits",
                    IpcValue::Array(vec![
                        obj(&[
                            ("id", s("f1")),
                            ("name", s("Budget.xlsx")),
                            ("type", s("spreadsheet")),
                            ("modified", s("2026-01-02T00:00:00Z")),
                        ]),
                        obj(&[
                            ("id", s("d1")),
                            ("name", s("Budgets")),
                            ("type", s("folder")),
                            ("modified", s("2026-01-03T00:00:00Z")),
                        ]),
                    ])
                ),
            ])
        );
        for (limit, want) in [
            (n(999.0), 20),
            (s("3"), 3),
            (n(2.9), 2),
            (n(0.0), 10),
            (n(-4.0), 1),
            (IpcValue::Undefined, 10),
            (s("many"), 10),
            (n(f64::INFINITY), 20),
        ] {
            r.client.lists.lock().unwrap().clear();
            let _ = search(&r, obj(&[("q", s("budget")), ("limit", limit.clone())]));
            let lists = r.client.lists.lock().unwrap().clone();
            assert_eq!(
                lists,
                vec![(Listing::Search("budget".into()), None, Some(want))],
                "{limit:?}"
            );
        }
        assert_eq!(
            search(&r, obj(&[("q", s("   "))])),
            Ok(obj(&[
                ("ok", b(false)),
                ("error", s("query must not be empty"))
            ]))
        );
        assert_eq!(
            search(&r, IpcValue::Null),
            Ok(obj(&[
                ("ok", b(false)),
                ("error", s("query must not be empty"))
            ]))
        );
        *r.client.list_answer.lock().unwrap() = Err(DriveError::RateLimit);
        assert_eq!(
            search(&r, obj(&[("q", s("x"))])),
            Ok(obj(&[
                ("ok", b(false)),
                (
                    "error",
                    s("Google Drive asked to slow down; try again shortly.")
                ),
            ]))
        );
    }

    fn read(r: &Rig, id: &str, offset: IpcValue) -> Result<IpcValue, IpcError> {
        call(|cx, re| {
            r.port
                .drive_ai_read(cx, vec![obj(&[("id", s(id)), ("offset", offset)])], re)
        })
    }

    #[test]
    fn the_ai_reads_a_file_page_by_page_and_the_download_does_not_outlive_the_parse() {
        let r = rig("ai-read");
        ready(&r);
        r.client.add(
            "f1",
            "notes.docx",
            "application/x",
            "2026-01-02T00:00:00Z",
            b"bytes",
        );
        let long: String = "a😀".repeat(20_000);
        r.shell.parsed.lock().unwrap().text = Some(long);

        let first = read(&r, "f1", IpcValue::Undefined).unwrap();
        let IpcValue::Object(fields) = &first else {
            panic!("{first:?}")
        };
        let IpcValue::Object(page) = &fields[1].1 else {
            panic!("{first:?}")
        };
        assert_eq!(page[0], ("name".to_string(), s("notes.docx")));
        // UTF-16 units, as `String.length` counts them
        assert_eq!(page[2], ("totalChars".to_string(), n(60_000.0)));
        assert_eq!(page[3], ("offset".to_string(), n(0.0)));
        let IpcValue::String(first_text) = &page[1].1 else {
            panic!("{first:?}")
        };
        assert_eq!(first_text.encode_utf16().count(), 24_000);

        let tail = read(&r, "f1", s("48000")).unwrap();
        let IpcValue::Object(fields) = &tail else {
            panic!("{tail:?}")
        };
        let IpcValue::Object(page) = &fields[1].1 else {
            panic!("{tail:?}")
        };
        assert_eq!(page[3], ("offset".to_string(), n(48_000.0)));
        let IpcValue::String(tail_text) = &page[1].1 else {
            panic!("{tail:?}")
        };
        assert_eq!(tail_text.encode_utf16().count(), 12_000);

        // paging reuses the parsed text
        assert_eq!(r.client.downloads.load(Ordering::SeqCst), 1);
        let parses = r.shell.parses.lock().unwrap().clone();
        assert_eq!(parses.len(), 1);
        assert!(parses[0].1, "the file was on disk while it was parsed");
        assert!(!parses[0].0.exists(), "and gone after");
        assert!(!parses[0].0.parent().unwrap().exists());
    }

    #[test]
    fn the_ai_read_says_why_it_cannot() {
        let r = rig("ai-read-errors");
        ready(&r);
        let failed = |text: &str| Ok(obj(&[("ok", b(false)), ("error", s(text))]));
        assert_eq!(
            read(&r, "../etc/passwd", IpcValue::Undefined),
            failed("not a Drive file id")
        );
        assert_eq!(
            read(&r, "", IpcValue::Undefined),
            failed("not a Drive file id")
        );
        assert_eq!(
            read(&r, "missing", IpcValue::Undefined),
            failed("No such Drive file, or this account cannot see it.")
        );
        r.client
            .add("d1", "Folder", FOLDER_MIME, "2026-01-02T00:00:00Z", b"");
        assert_eq!(
            read(&r, "d1", IpcValue::Undefined),
            failed("That is a folder; search inside it with drive_search instead.")
        );
        r.client
            .add("f2", "photo.png", "image/png", "2026-01-02T00:00:00Z", b"x");
        assert_eq!(
            read(&r, "f2", IpcValue::Undefined),
            failed("That kind of Drive file cannot be read as text.")
        );
        r.client.add(
            "f3",
            "a.docx",
            "application/x",
            "2026-01-02T00:00:00Z",
            b"x",
        );
        *r.shell.parsed.lock().unwrap() = Default::default();
        assert_eq!(
            read(&r, "f3", IpcValue::Undefined),
            failed("The Drive file could not be read as text.")
        );
        // nothing a failed read made is left behind
        let parses = r.shell.parses.lock().unwrap().clone();
        assert!(parses.iter().all(|(path, _)| !path.exists()));
        // the AI's refusals come before any of it
        r.shell.use_ai(r#"{"provider":"gemini"}"#);
        assert_eq!(
            read(&r, "f3", IpcValue::Undefined),
            Ok(obj(&[("ok", b(false)), ("error", s(FREE_AI_REFUSAL))]))
        );
    }

    #[test]
    fn the_read_text_is_forgotten_when_drive_disconnects() {
        let r = rig("ai-forget");
        ready(&r);
        r.client.add(
            "f1",
            "a.docx",
            "application/x",
            "2026-01-02T00:00:00Z",
            b"x",
        );
        let _ = read(&r, "f1", IpcValue::Undefined);
        let _ = read(&r, "f1", IpcValue::Undefined);
        assert_eq!(r.client.downloads.load(Ordering::SeqCst), 1);
        let _ = call(|cx, re| r.port.drive_disconnect(cx, vec![], re));
        r.client.connect_as("Dana");
        let _ = read(&r, "f1", IpcValue::Undefined);
        assert_eq!(r.client.downloads.load(Ordering::SeqCst), 2);
    }

    fn list(r: &Rig, args: Vec<IpcValue>) -> Result<IpcValue, IpcError> {
        call(|cx, re| r.port.drive_list(cx, args, re))
    }

    #[test]
    fn the_listing_shows_each_file_as_a_screen_entry() {
        let r = rig("list");
        let doc = r.client.add(
            "f1",
            "Plan.docx",
            "application/x",
            "2026-01-02T00:00:00Z",
            b"12345",
        );
        let google = r
            .client
            .add("g1", "Notes", GOOGLE_DOC, "2026-01-03T00:00:00Z", b"");
        let folder = DriveFile {
            id: "d1".into(),
            name: "Reports".into(),
            mime_type: FOLDER_MIME.into(),
            modified_time: "2026-01-04T00:00:00Z".into(),
            can_edit: true,
            ..DriveFile::default()
        };
        let shortcut = DriveFile {
            id: "s1".into(),
            name: "Plan link.docx".into(),
            mime_type: "application/vnd.google-apps.shortcut".into(),
            modified_time: "2026-01-05T00:00:00Z".into(),
            can_edit: false,
            shortcut_target: Some(ShortcutTarget {
                id: "f1".into(),
                mime_type: "application/x".into(),
            }),
            ..DriveFile::default()
        };
        *r.client.list_answer.lock().unwrap() = Ok(ListPage {
            files: vec![doc, google, folder, shortcut],
            next_page_token: Some("next".into()),
        });
        let entry = |id: &str,
                     name: &str,
                     kind: &str,
                     modified: &str,
                     size: Option<f64>,
                     openable: bool,
                     can_edit: bool,
                     google: bool| {
            let mut fields = vec![
                ("id", s(id)),
                ("name", s(name)),
                ("type", s(kind)),
                ("modifiedTime", s(modified)),
                ("openable", b(openable)),
                ("canEdit", b(can_edit)),
                ("google", b(google)),
            ];
            if let Some(size) = size {
                fields.push(("size", n(size)));
            }
            obj(&fields)
        };
        assert_eq!(
            list(&r, vec![obj(&[("kind", s("recent"))]), s("tok")]),
            Ok(obj(&[
                ("ok", b(true)),
                (
                    "files",
                    IpcValue::Array(vec![
                        entry(
                            "f1",
                            "Plan.docx",
                            "document",
                            "2026-01-02T00:00:00Z",
                            Some(5.0),
                            true,
                            true,
                            false
                        ),
                        entry(
                            "g1",
                            "Notes",
                            "document",
                            "2026-01-03T00:00:00Z",
                            None,
                            true,
                            true,
                            true
                        ),
                        entry(
                            "d1",
                            "Reports",
                            "folder",
                            "2026-01-04T00:00:00Z",
                            None,
                            false,
                            true,
                            false
                        ),
                        // a shortcut shows its target's kind and id under its own name
                        entry(
                            "f1",
                            "Plan link.docx",
                            "document",
                            "2026-01-05T00:00:00Z",
                            None,
                            true,
                            false,
                            false
                        ),
                    ])
                ),
                ("nextPageToken", s("next")),
            ]))
        );
        assert_eq!(
            r.client.lists.lock().unwrap().as_slice(),
            [(Listing::Recent, Some("tok".to_string()), None)]
        );
    }

    #[test]
    fn a_listing_request_is_checked_before_drive_is_asked() {
        let r = rig("list-args");
        let not_found = Ok(obj(&[("ok", b(false)), ("kind", s("not-found"))]));
        assert_eq!(list(&r, vec![]), not_found);
        assert_eq!(list(&r, vec![obj(&[("kind", s("other"))])]), not_found);
        assert_eq!(
            list(&r, vec![obj(&[("kind", s("search")), ("text", s("  "))])]),
            not_found
        );
        assert_eq!(
            list(&r, vec![obj(&[("kind", s("search")), ("text", n(3.0))])]),
            not_found
        );
        assert!(r.client.lists.lock().unwrap().is_empty());

        let long = "é".repeat(300);
        let _ = list(
            &r,
            vec![
                obj(&[("kind", s("search")), ("text", s(&format!("  {long}  ")))]),
                s(&"t".repeat(2000)),
            ],
        );
        let _ = list(
            &r,
            vec![obj(&[("kind", s("search")), ("text", s("x"))]), n(5.0)],
        );
        let lists = r.client.lists.lock().unwrap().clone();
        assert_eq!(
            lists[0],
            (Listing::Search("é".repeat(200)), None, None),
            "trimmed, 200 units, token too long"
        );
        assert_eq!(lists[1], (Listing::Search("x".into()), None, None));

        *r.client.list_answer.lock().unwrap() = Err(DriveError::NotConnected);
        assert_eq!(
            list(&r, vec![obj(&[("kind", s("recent"))])]),
            Ok(obj(&[("ok", b(false)), ("kind", s("not-connected"))]))
        );
    }

    #[test]
    fn opening_makes_a_local_copy_once_and_refuses_what_is_not_an_id() {
        let r = rig("open");
        ready(&r);
        r.client.add(
            "f1",
            "Plan.docx",
            "application/x",
            "2026-01-02T00:00:00Z",
            b"v1",
        );
        let open = |r: &Rig, id: IpcValue| call(|cx, re| r.port.drive_open(cx, vec![id], re));

        let not_found = Ok(obj(&[("ok", b(false)), ("kind", s("not-found"))]));
        for bad in [
            s(""),
            s("a/b"),
            s(&"x".repeat(201)),
            n(1.0),
            IpcValue::Undefined,
        ] {
            assert_eq!(open(&r, bad), not_found);
        }
        assert_eq!(open(&r, s("missing")), not_found);

        assert_eq!(open(&r, s("f1")), Ok(obj(&[("ok", b(true))])));
        let opened = r.shell.opened.lock().unwrap().clone();
        assert_eq!(opened.len(), 1);
        assert_eq!(
            opened[0],
            r.dir
                .join("drive-cache")
                .join("f1")
                .join("Plan.docx")
                .to_string_lossy()
        );
        assert_eq!(std::fs::read(&opened[0]).unwrap(), b"v1");

        // the copy is current: the tab comes forward and nothing is fetched
        assert_eq!(open(&r, s("f1")), Ok(obj(&[("ok", b(true))])));
        assert_eq!(r.client.downloads.load(Ordering::SeqCst), 1);

        r.client
            .add("p1", "photo.png", "image/png", "2026-01-02T00:00:00Z", b"");
        assert_eq!(
            open(&r, s("p1")),
            Ok(obj(&[("ok", b(false)), ("kind", s("unsupported"))]))
        );
        r.shell.can_open.store(false, Ordering::SeqCst);
        r.client.add(
            "f2",
            "B.docx",
            "application/x",
            "2026-01-02T00:00:00Z",
            b"v1",
        );
        assert_eq!(
            open(&r, s("f2")),
            Ok(obj(&[("ok", b(false)), ("kind", s("disk"))]))
        );
    }

    #[test]
    fn pick_and_open_opens_each_picked_file_and_reports_the_first_problem() {
        let r = rig("pick-open");
        let pick = |r: &Rig| call(|cx, re| r.port.drive_pick_open(cx, vec![], re));
        assert_eq!(
            pick(&r),
            Ok(obj(&[("ok", b(false)), ("reason", s("not-connected"))]))
        );
        r.client.connect_as("Dana");
        assert_eq!(
            pick(&r),
            Ok(obj(&[("ok", b(false)), ("reason", s("training"))]))
        );
        assert!(r.client.rounds.lock().unwrap().is_empty());
        let _ = call(|cx, re| r.port.drive_set_training_ack(cx, vec![b(true)], re));

        r.client.add(
            "f1",
            "A.docx",
            "application/x",
            "2026-01-02T00:00:00Z",
            b"a",
        );
        r.client.add(
            "f2",
            "B.docx",
            "application/x",
            "2026-01-02T00:00:00Z",
            b"b",
        );
        r.client
            .add("f3", "C.png", "image/png", "2026-01-02T00:00:00Z", b"c");
        *r.client.pick_result.lock().unwrap() = picked(&["f1", "gone", "f3", "f2"]);
        assert_eq!(
            pick(&r),
            Ok(obj(&[
                ("ok", b(true)),
                ("opened", n(2.0)),
                // the first of the two that did not open
                ("problem", s("not-found")),
            ]))
        );
        assert_eq!(r.shell.opened.lock().unwrap().len(), 2);
        // the picker's own page after the browser round
        let round = r.client.rounds.lock().unwrap()[0].clone();
        assert_eq!(round.done.title, "Files chosen");

        *r.client.pick_result.lock().unwrap() = picked(&["f1"]);
        assert_eq!(pick(&r), Ok(obj(&[("ok", b(true)), ("opened", n(1.0))])));
        *r.client.pick_result.lock().unwrap() = Err(SignInFailure::Cancelled);
        assert_eq!(
            pick(&r),
            Ok(obj(&[("ok", b(false)), ("reason", s("cancelled"))]))
        );
        // the picker shows while it is open and goes away after
        let states = r.events.states();
        assert!(
            states
                .iter()
                .all(|s| s == "connected" || s == "disconnected"),
            "{states:?}"
        );
        assert!(!r.port.inner.picking.load(Ordering::SeqCst));
    }

    #[test]
    fn only_one_pick_or_sign_in_runs_at_a_time() {
        let r = rig("pick-busy");
        ready(&r);
        r.port.inner.connecting.store(true, Ordering::SeqCst);
        assert_eq!(
            call(|cx, re| r.port.drive_pick_open(cx, vec![], re)),
            Ok(obj(&[("ok", b(false)), ("reason", s("busy"))]))
        );
        r.port.inner.connecting.store(false, Ordering::SeqCst);
        r.port.inner.picking.store(true, Ordering::SeqCst);
        assert_eq!(
            call(|cx, re| r.port.drive_pick_attachments(cx, vec![], re)),
            Ok(obj(&[("ok", b(false)), ("reason", s("busy"))]))
        );
        assert!(r.client.rounds.lock().unwrap().is_empty());
    }

    #[test]
    fn attaching_refuses_a_free_ai_before_the_picker_opens() {
        let r = rig("attach-free");
        ready(&r);
        r.shell
            .use_ai(r#"{"provider":"openrouter","providers":{"openrouter":{"model":"m:free"}}}"#);
        assert_eq!(
            call(|cx, re| r.port.drive_pick_attachments(cx, vec![], re)),
            Ok(obj(&[("ok", b(false)), ("reason", s("free-ai"))]))
        );
        assert!(r.client.rounds.lock().unwrap().is_empty());
        // not connected, nothing to hide yet: the ordinary answer
        r.client
            .set_state(ConnectionState::Disconnected { expired: false });
        assert_eq!(
            call(|cx, re| r.port.drive_pick_attachments(cx, vec![], re)),
            Ok(obj(&[("ok", b(false)), ("reason", s("not-connected"))]))
        );
    }

    #[test]
    fn attaching_downloads_the_picks_and_names_why_it_could_not() {
        let r = rig("attach");
        let attach = |r: &Rig| call(|cx, re| r.port.drive_pick_attachments(cx, vec![], re));
        r.client.connect_as("Dana");
        // attaching does not need the AI switch, only the confirmation
        assert_eq!(
            attach(&r),
            Ok(obj(&[("ok", b(false)), ("reason", s("training"))]))
        );
        let _ = call(|cx, re| r.port.drive_set_training_ack(cx, vec![b(true)], re));
        let _ = call(|cx, re| r.port.drive_set_ai_access(cx, vec![b(false)], re));

        *r.client.pick_result.lock().unwrap() = Ok(Vec::new());
        assert_eq!(
            attach(&r),
            Ok(obj(&[("ok", b(false)), ("reason", s("cancelled"))]))
        );
        for failure in [
            SignInFailure::Timeout,
            SignInFailure::Denied,
            SignInFailure::Scope,
            SignInFailure::Network,
        ] {
            *r.client.pick_result.lock().unwrap() = Err(failure);
            assert_eq!(
                attach(&r),
                Ok(obj(&[("ok", b(false)), ("reason", s("failed"))]))
            );
        }
        *r.client.pick_result.lock().unwrap() = Err(SignInFailure::Cancelled);
        assert_eq!(
            attach(&r),
            Ok(obj(&[("ok", b(false)), ("reason", s("cancelled"))]))
        );

        r.client.add(
            "f1",
            "Plan.docx",
            "application/x",
            "2026-01-02T00:00:00Z",
            b"plan",
        );
        r.client
            .add("f2", "pic.png", "image/png", "2026-01-02T00:00:00Z", b"p");
        *r.client.pick_result.lock().unwrap() = picked(&["f1", "f2", "gone"]);
        let answer = attach(&r).unwrap();
        let IpcValue::Object(fields) = &answer else {
            panic!("{answer:?}")
        };
        assert_eq!(fields[0], ("ok".to_string(), b(true)));
        let IpcValue::Array(paths) = &fields[1].1 else {
            panic!("{answer:?}")
        };
        assert_eq!(paths.len(), 1);
        let IpcValue::String(path) = &paths[0] else {
            panic!("{answer:?}")
        };
        assert!(
            path.starts_with(
                &*r.dir
                    .join("tmp")
                    .join("seuoffice-drive-attach")
                    .to_string_lossy()
            )
        );
        assert_eq!(std::fs::read(path).unwrap(), b"plan");
        assert_eq!(fields[2], ("skipped".to_string(), n(1.0)));
        assert_eq!(fields[3], ("failed".to_string(), n(1.0)));
    }

    #[test]
    fn a_document_copied_from_drive_is_refused_to_a_free_ai_only() {
        let r = rig("guard");
        ready(&r);
        r.client.add(
            "f1",
            "Plan.docx",
            "application/x",
            "2026-01-02T00:00:00Z",
            b"plan",
        );
        let _ = call(|cx, re| r.port.drive_open(cx, vec![s("f1")], re));
        let copy = r.shell.opened.lock().unwrap()[0].clone();
        r.shell.documents.lock().unwrap().insert(7, copy);
        r.shell
            .documents
            .lock()
            .unwrap()
            .insert(8, "/home/me/own.docx".into());

        let run = |sender: f64, provider: &str, model: &str| {
            r.port.ai_run_refusal(&AiRunGuardInput {
                sender_id: sender,
                provider: provider.into(),
                model: model.into(),
            })
        };
        assert!(
            run(7.0, "gemini", "")
                .unwrap()
                .contains("Google Drive file")
        );
        assert!(run(7.0, "openrouter", "m:free").is_some());
        assert_eq!(run(7.0, "openrouter", "m"), None);
        assert_eq!(run(7.0, "anthropic", ""), None);
        assert_eq!(run(8.0, "gemini", ""), None, "a file of the person's own");
        assert_eq!(run(9.0, "gemini", ""), None, "a tab with no document");

        *r.shell.lang.lock().unwrap() = Lang::Ko;
        assert!(run(7.0, "gemini", "").unwrap().contains("드라이브"));
    }

    #[test]
    fn a_copy_of_a_drive_file_reopens_through_drive() {
        let r = rig("reopen");
        ready(&r);
        r.client.add(
            "f1",
            "Plan.docx",
            "application/x",
            "2026-01-02T00:00:00Z",
            b"v1",
        );
        let _ = call(|cx, re| r.port.drive_open(cx, vec![s("f1")], re));
        let copy = r.shell.opened.lock().unwrap()[0].clone();
        r.shell.tabs.lock().unwrap().clear();

        r.client.change("f1", b"v2", "2026-01-09T00:00:00Z");
        let done = Arc::new(std::sync::Mutex::new(None));
        let slot = done.clone();
        assert!(r.port.reopen(
            &copy,
            Box::new(move |opened| *slot.lock().unwrap() = Some(opened))
        ));
        assert_eq!(*done.lock().unwrap(), Some(true));
        assert_eq!(
            std::fs::read(&copy).unwrap(),
            b"v2",
            "a stale copy is refreshed"
        );
        assert!(!r.port.reopen("/elsewhere/x.docx", Box::new(|_| ())));
    }

    #[test]
    fn starting_loads_the_kept_token_and_stopping_closes_what_runs() {
        let r = rig("start");
        r.client
            .set_state(ConnectionState::Disconnected { expired: false });
        r.port.start();
        assert_eq!(r.client.loads.load(Ordering::SeqCst), 1);
        assert!(
            r.shell.watching.load(Ordering::SeqCst),
            "the cache folder is watched"
        );
        r.port.stop();
        assert!(!r.shell.watching.load(Ordering::SeqCst));
        assert_eq!(r.client.cancels.load(Ordering::SeqCst), 1);

        // a build with no Google client offers no Drive at all
        let none = rig("start-unavailable");
        none.client.set_state(ConnectionState::Unavailable);
        none.port.start();
        assert!(!none.shell.watching.load(Ordering::SeqCst));
    }
}
