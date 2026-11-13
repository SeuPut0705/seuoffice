//! Fakes for the tests of the Drive module: the Drive client over files held
//! in memory, the shell entry's tabs and parser, the dialogs, and threads
//! that run every job on the spot (so a test sees a handler's whole effect
//! when the call returns).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use jscompat::JsonValue;
use main_core::packages::i18n::Lang;
use shell_contract::hosts::Hosts;
use shell_contract::ipc::{CallContext, EventSink, Responder, Sender, Target};
use shell_contract::runtime::{AppPaths, CancelToken, PathName, Services, Thread, Views, Workers};
use shell_contract::{IpcError, IpcValue, Surface, ViewId, WindowId};

use super::DrivePort;
use super::client::{
    BrowserRound, ConnectionState, DriveAccount, DriveClient, DriveError, DriveFile, DriveResult,
    ListPage, Listing, OpenPlan, SignInFailure, UploadTarget,
};
use super::files::{FilesConfig, SyncAnswer, SyncNotice, SyncQuestion, SyncUi};
use super::host::{DriveShell, ParsedText, StopWatch};

const DOCX: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
pub const GOOGLE_DOC: &str = "application/vnd.google-apps.document";

/// Runs every job at once, on the calling thread
pub struct Inline;

impl Thread for Inline {
    fn post(&self, job: Box<dyn FnOnce() + Send>) {
        job()
    }
    fn is_current(&self) -> bool {
        false
    }
}

impl Workers for Inline {
    fn spawn(&self, job: Box<dyn FnOnce() + Send>) {
        job()
    }
}

impl Views for Inline {
    fn sender_of(&self, _: ViewId) -> Option<Sender> {
        None
    }
    fn all(&self) -> Vec<Sender> {
        Vec::new()
    }
    fn on_destroyed(&self, _: Box<dyn Fn(ViewId) + Send + Sync>) {}
}

pub struct Dir(pub PathBuf);

impl AppPaths for Dir {
    fn path(&self, name: PathName) -> PathBuf {
        match name {
            PathName::Temp => self.0.join("tmp"),
            _ => self.0.clone(),
        }
    }
}

#[derive(Default)]
pub struct Events(pub Mutex<Vec<(Target, &'static str, Vec<IpcValue>)>>);

impl EventSink for Events {
    fn emit(&self, target: Target, channel: &'static str, args: Vec<IpcValue>) {
        self.0.lock().unwrap().push((target, channel, args));
    }
}

impl Events {
    /// the `state` field of each `drive:state-changed` sent so far
    pub fn states(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, channel, _)| *channel == "drive:state-changed")
            .map(|(_, _, args)| match &args[0] {
                IpcValue::Object(entries) => match &entries[0].1 {
                    IpcValue::String(s) => s.clone(),
                    other => panic!("{other:?}"),
                },
                other => panic!("{other:?}"),
            })
            .collect()
    }
}

/// A cheap stand-in for the content hash Drive gives
pub fn md5_of(bytes: &[u8]) -> String {
    format!(
        "md5-{}-{}",
        bytes.len(),
        bytes.iter().map(|b| *b as u64).sum::<u64>()
    )
}

/// one `list` call: the listing, its page token and page size
pub type ListCall = (Listing, Option<String>, Option<u32>);
/// the `fs.watch` listener the port installed
pub type WatchListener = Arc<dyn Fn(&Path) + Send + Sync>;

pub struct FakeClient {
    pub state: Mutex<ConnectionState>,
    listener: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    pub files: Mutex<HashMap<String, (DriveFile, Vec<u8>)>>,
    pub connect_result: Mutex<Result<(), SignInFailure>>,
    pub pick_result: Mutex<Result<Vec<String>, SignInFailure>>,
    pub rounds: Mutex<Vec<BrowserRound>>,
    pub list_answer: Mutex<DriveResult<ListPage>>,
    pub lists: Mutex<Vec<ListCall>>,
    pub uploads: Mutex<Vec<(UploadTarget, Vec<u8>)>>,
    pub upload_error: Mutex<Option<DriveError>>,
    /// an upload into a folder is refused (a shared folder)
    pub refuse_parents: AtomicBool,
    pub downloads: AtomicUsize,
    pub cancels: AtomicUsize,
    pub disconnects: AtomicUsize,
    pub loads: AtomicUsize,
    made: AtomicUsize,
}

impl FakeClient {
    pub fn new() -> Arc<FakeClient> {
        Arc::new(FakeClient {
            state: Mutex::new(ConnectionState::Disconnected { expired: false }),
            listener: Mutex::new(None),
            files: Mutex::default(),
            connect_result: Mutex::new(Ok(())),
            pick_result: Mutex::new(Ok(Vec::new())),
            rounds: Mutex::default(),
            list_answer: Mutex::new(Ok(ListPage::default())),
            lists: Mutex::default(),
            uploads: Mutex::default(),
            upload_error: Mutex::new(None),
            refuse_parents: AtomicBool::new(false),
            downloads: AtomicUsize::new(0),
            cancels: AtomicUsize::new(0),
            disconnects: AtomicUsize::new(0),
            loads: AtomicUsize::new(0),
            made: AtomicUsize::new(0),
        })
    }

    /// what the connection does when its state changes
    pub fn set_state(&self, state: ConnectionState) {
        *self.state.lock().unwrap() = state;
        let listener = self.listener.lock().unwrap().clone();
        if let Some(listener) = listener {
            listener();
        }
    }

    pub fn connect_as(&self, name: &str) {
        self.set_state(ConnectionState::Connected {
            account: Some(DriveAccount {
                display_name: name.into(),
                email_address: format!("{}@example.com", name.to_lowercase()),
            }),
            persisted: true,
        });
    }

    pub fn add(&self, id: &str, name: &str, mime: &str, modified: &str, bytes: &[u8]) -> DriveFile {
        let google = mime.starts_with("application/vnd.google-apps.");
        let file = DriveFile {
            id: id.into(),
            name: name.into(),
            mime_type: mime.into(),
            modified_time: modified.into(),
            size: (!google).then_some(bytes.len() as u64),
            md5_checksum: (!google).then(|| md5_of(bytes)),
            parents: vec!["folder-1".into()],
            can_edit: true,
            shortcut_target: None,
        };
        self.files
            .lock()
            .unwrap()
            .insert(id.into(), (file.clone(), bytes.to_vec()));
        file
    }

    pub fn change(&self, id: &str, bytes: &[u8], modified: &str) {
        let mut files = self.files.lock().unwrap();
        let (file, content) = files.get_mut(id).unwrap();
        *content = bytes.to_vec();
        file.md5_checksum = Some(md5_of(bytes));
        file.modified_time = modified.into();
    }

    pub fn bytes_of(&self, id: &str) -> Vec<u8> {
        self.files.lock().unwrap()[id].1.clone()
    }
}

fn extension(name: &str) -> String {
    name.rfind('.')
        .filter(|dot| *dot > 0)
        .map_or(String::new(), |dot| name[dot..].to_lowercase())
}

impl DriveClient for FakeClient {
    fn state(&self) -> ConnectionState {
        self.state.lock().unwrap().clone()
    }

    fn connected(&self) -> bool {
        matches!(
            *self.state.lock().unwrap(),
            ConnectionState::Connected { .. }
        )
    }

    fn load(&self) {
        self.loads.fetch_add(1, Ordering::SeqCst);
    }

    fn on_change(&self, listener: Arc<dyn Fn() + Send + Sync>) {
        *self.listener.lock().unwrap() = Some(listener);
    }

    fn connect(&self, round: &BrowserRound) -> Result<(), SignInFailure> {
        self.rounds.lock().unwrap().push(round.clone());
        let result = *self.connect_result.lock().unwrap();
        if result.is_ok() {
            self.connect_as("Dana");
        }
        result
    }

    fn pick(&self, round: &BrowserRound, _multiple: bool) -> Result<Vec<String>, SignInFailure> {
        self.rounds.lock().unwrap().push(round.clone());
        self.pick_result.lock().unwrap().clone()
    }

    fn cancel_connect(&self) {
        self.cancels.fetch_add(1, Ordering::SeqCst);
    }

    fn disconnect(&self) {
        self.disconnects.fetch_add(1, Ordering::SeqCst);
        self.set_state(ConnectionState::Disconnected { expired: false });
    }

    fn list(
        &self,
        listing: &Listing,
        page_token: Option<&str>,
        page_size: Option<u32>,
    ) -> DriveResult<ListPage> {
        self.lists.lock().unwrap().push((
            listing.clone(),
            page_token.map(str::to_owned),
            page_size,
        ));
        self.list_answer.lock().unwrap().clone()
    }

    fn file(&self, id: &str) -> DriveResult<DriveFile> {
        self.files
            .lock()
            .unwrap()
            .get(id)
            .map(|(file, _)| file.clone())
            .ok_or(DriveError::NotFound)
    }

    fn download(&self, id: &str, max_bytes: usize) -> DriveResult<Vec<u8>> {
        self.downloads.fetch_add(1, Ordering::SeqCst);
        let bytes = self
            .files
            .lock()
            .unwrap()
            .get(id)
            .ok_or(DriveError::NotFound)?
            .1
            .clone();
        if bytes.len() > max_bytes {
            return Err(DriveError::TooLarge);
        }
        Ok(bytes)
    }

    fn export(&self, id: &str, _mime: &str, max_bytes: usize) -> DriveResult<Vec<u8>> {
        self.download(id, max_bytes)
    }

    fn upload(&self, target: &UploadTarget, bytes: &[u8], mime: &str) -> DriveResult<DriveFile> {
        self.uploads
            .lock()
            .unwrap()
            .push((target.clone(), bytes.to_vec()));
        if let Some(error) = *self.upload_error.lock().unwrap() {
            return Err(error);
        }
        let n = self.made.fetch_add(1, Ordering::SeqCst) + 1;
        let modified = format!("2026-02-01T00:00:{n:02}Z");
        match target {
            UploadTarget::Existing(id) => {
                self.change(id, bytes, &modified);
                self.file(id)
            }
            UploadTarget::New { name, parent_id } => {
                if parent_id.is_some() && self.refuse_parents.load(Ordering::SeqCst) {
                    return Err(DriveError::Forbidden);
                }
                let id = format!("made-{n}");
                let mut file = self.add(&id, name, mime, &modified, bytes);
                file.parents = parent_id.iter().cloned().collect();
                Ok(file)
            }
        }
    }

    fn open_plan(&self, name: &str, mime_type: &str) -> OpenPlan {
        if mime_type == GOOGLE_DOC {
            return OpenPlan::Export {
                mime: DOCX.into(),
                extension: ".docx".into(),
            };
        }
        if mime_type.starts_with("application/vnd.google-apps.") {
            return OpenPlan::None;
        }
        let extension = extension(name);
        if [".docx", ".xlsx", ".pdf", ".md", ".txt", ".hwp"].contains(&extension.as_str()) {
            OpenPlan::Download { extension }
        } else {
            OpenPlan::None
        }
    }

    fn is_google_native(&self, mime_type: &str) -> bool {
        mime_type.starts_with("application/vnd.google-apps.")
    }

    fn local_file_name(&self, drive_name: &str, extension_: &str) -> String {
        if extension(drive_name) == extension_ {
            drive_name.to_owned()
        } else {
            format!("{drive_name}{extension_}")
        }
    }

    fn office_copy_name(&self, drive_name: &str, extension_: &str) -> String {
        self.local_file_name(drive_name, extension_)
    }

    fn upload_mime(&self, _name: &str) -> String {
        "application/octet-stream".into()
    }
}

pub struct FakeShell {
    pub lang: Mutex<Lang>,
    pub opened: Mutex<Vec<String>>,
    pub can_open: AtomicBool,
    /// the paths a tab shows
    pub tabs: Mutex<HashSet<String>>,
    pub ai_settings: Mutex<JsonValue>,
    pub documents: Mutex<HashMap<i64, String>>,
    pub parsed: Mutex<ParsedText>,
    /// the files the parser was handed, and whether each was on disk then
    pub parses: Mutex<Vec<(PathBuf, bool)>>,
    pub watch: Mutex<Option<WatchListener>>,
    pub watching: Arc<AtomicBool>,
}

impl FakeShell {
    pub fn new() -> Arc<FakeShell> {
        Arc::new(FakeShell {
            lang: Mutex::new(Lang::En),
            opened: Mutex::default(),
            can_open: AtomicBool::new(true),
            tabs: Mutex::default(),
            ai_settings: Mutex::new(
                jscompat::json_parse(r#"{"provider":"auto","providers":{}}"#).unwrap(),
            ),
            documents: Mutex::default(),
            parsed: Mutex::new(ParsedText {
                ok: true,
                kind: Some("text".into()),
                text: Some("parsed".into()),
            }),
            parses: Mutex::default(),
            watch: Mutex::new(None),
            watching: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn use_ai(&self, settings: &str) {
        *self.ai_settings.lock().unwrap() = jscompat::json_parse(settings).unwrap();
    }
}

impl DriveShell for FakeShell {
    fn lang(&self) -> Lang {
        *self.lang.lock().unwrap()
    }

    fn open_path(&self, path: &str) -> bool {
        if self.can_open.load(Ordering::SeqCst) {
            self.opened.lock().unwrap().push(path.to_owned());
            self.tabs.lock().unwrap().insert(path.to_owned());
            true
        } else {
            false
        }
    }

    fn is_open(&self, path: &str) -> bool {
        self.tabs.lock().unwrap().contains(path)
    }

    fn stored_ai_settings(&self) -> JsonValue {
        self.ai_settings.lock().unwrap().clone()
    }

    fn document_of(&self, web_contents_id: f64) -> Option<String> {
        self.documents
            .lock()
            .unwrap()
            .get(&(web_contents_id as i64))
            .cloned()
    }

    fn parse_file_to_text(&self, path: &Path) -> ParsedText {
        self.parses
            .lock()
            .unwrap()
            .push((path.to_path_buf(), path.exists()));
        self.parsed.lock().unwrap().clone()
    }

    fn watch(&self, _dir: &Path, on_change: Arc<dyn Fn(&Path) + Send + Sync>) -> StopWatch {
        *self.watch.lock().unwrap() = Some(on_change);
        self.watching.store(true, Ordering::SeqCst);
        let flag = self.watching.clone();
        Box::new(move || flag.store(false, Ordering::SeqCst))
    }
}

/// The dialogs: answers come from a queue (`Local` when it is empty)
#[derive(Default)]
pub struct FakeUi {
    pub answers: Mutex<Vec<SyncAnswer>>,
    pub asked: Mutex<Vec<SyncQuestion>>,
    pub notices: Mutex<Vec<SyncNotice>>,
}

impl SyncUi for FakeUi {
    fn ask(&self, question: &SyncQuestion) -> SyncAnswer {
        self.asked.lock().unwrap().push(question.clone());
        let mut answers = self.answers.lock().unwrap();
        if answers.is_empty() {
            SyncAnswer::Local
        } else {
            answers.remove(0)
        }
    }

    fn notify(&self, notice: &SyncNotice) {
        self.notices.lock().unwrap().push(notice.clone());
    }

    fn copy_name(&self, name: &str) -> String {
        format!("{name} (copy)")
    }
}

pub struct FakeOs {
    pub opened: Mutex<Vec<String>>,
}

impl shell_contract::hosts::OsShell for FakeOs {
    fn open_external(&self, url: &str) -> Result<(), String> {
        self.opened.lock().unwrap().push(url.to_owned());
        Ok(())
    }
    fn open_path(&self, _path: &Path) -> String {
        String::new()
    }
    fn show_item_in_folder(&self, _path: &Path) {}
    fn trash_item(&self, _path: &Path) -> Result<(), String> {
        Ok(())
    }
}

pub struct Rig {
    pub dir: PathBuf,
    pub events: Arc<Events>,
    pub client: Arc<FakeClient>,
    pub shell: Arc<FakeShell>,
    pub os: Arc<FakeOs>,
    pub port: DrivePort,
}

pub fn config() -> FilesConfig {
    FilesConfig {
        // a test does not wait for a timer
        debounce_ms: 3_600_000,
        retry_delays_ms: vec![3_600_000, 7_200_000],
        ..FilesConfig::default()
    }
}

pub fn rig(name: &str) -> Rig {
    let dir = std::env::temp_dir().join(format!("shell-a-drive-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let inline = Arc::new(Inline);
    let events = Arc::new(Events::default());
    let services = Services {
        ui: inline.clone(),
        core: inline.clone(),
        workers: inline.clone(),
        events: events.clone(),
        views: inline,
        paths: Arc::new(Dir(dir.clone())),
        hosts: Arc::new(Hosts::default()),
    };
    let client = FakeClient::new();
    let shell = FakeShell::new();
    let ui = Arc::new(FakeUi::default());
    let os = Arc::new(FakeOs {
        opened: Mutex::default(),
    });
    let port = DrivePort::new(
        &services,
        client.clone(),
        shell.clone(),
        os.clone(),
        ui.clone(),
        config(),
    );
    Rig {
        dir,
        events,
        client,
        shell,
        os,
        port,
    }
}

pub fn context() -> CallContext {
    CallContext {
        sender: Sender {
            view: ViewId(5),
            window: WindowId(2),
            surface: Surface::Shell,
        },
        request: None,
        cancel: CancelToken::default(),
    }
}

/// Calls a handler and returns its answer; the fakes run every job at once,
/// so the answer is there when the call returns
pub fn call(f: impl FnOnce(&CallContext, Responder)) -> Result<IpcValue, IpcError> {
    let out = Arc::new(Mutex::new(None));
    let slot = out.clone();
    f(
        &context(),
        Responder::new(move |r| *slot.lock().unwrap() = Some(r)),
    );
    out.lock().unwrap().take().expect("answered")
}

pub fn obj(entries: &[(&str, IpcValue)]) -> IpcValue {
    IpcValue::Object(
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
    )
}

pub fn s(text: &str) -> IpcValue {
    IpcValue::String(text.into())
}

pub fn b(on: bool) -> IpcValue {
    IpcValue::Bool(on)
}

pub fn n(value: f64) -> IpcValue {
    IpcValue::Number(value)
}
