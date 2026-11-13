//! The hosts of the Drive port (`shell_ipc_a::drive`): what the shell entry
//! hands `registerDriveIpc` (`DriveShell`) and the Drive connection itself
//! (`DriveClient`).
//!
//! The connection is `main_core::packages::google_drive`'s `DriveConnection`,
//! which lives on a runtime driver of the core thread (it holds `Rc`s and
//! awaits the AI runtime's `Net`, here `HttpNet`). A `DriveClient` method is
//! called from a worker and blocks: it posts its future to the core thread
//! and waits for the answer on a channel, the way the port's contract says.
//! The methods that must not block (`state`, `connected`, `on_change`,
//! `cancel_connect`) read or touch a mirror of the connection's state that
//! the core thread keeps.
//!
//! The token vault (`google-drive.json`) is read and written on a worker too:
//! the keychain read it starts with may stop to ask. The Google client is the
//! one the build was made with (`SEUOFFICE_GOOGLE_CLIENT_ID` and
//! `SEUOFFICE_GOOGLE_CLIENT_SECRET` at compile time); a build without one has
//! no Drive.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};

use jscompat::JsonValue;
use main_core::packages::ai_provider::task::{Fetcher, JsError, LocalBoxFuture, Rt};
use main_core::packages::ai_search::media_tools::read_routing_settings;
use main_core::packages::google_drive::connection::{
    ConnectFailure, DriveConnection, DriveConnectionOptions, DriveConnectionState,
};
use main_core::packages::google_drive::drive_api::{
    self as api, DriveErrorKind, DriveFailure, DriveListing, ListOptions,
};
use main_core::packages::google_drive::formats;
use main_core::packages::google_drive::oauth::{
    GoogleClient, GoogleSignInFailure, SignInPage as GooglePage, SignInPages,
};
use main_core::packages::i18n::Lang;
use shell_contract::runtime::{AppPaths, PathName, Services};
use shell_contract::{Batch, Hosts};
use shell_ipc_a::drive::client::{
    BrowserRound, ConnectionState, DriveAccount, DriveClient, DriveClientHost, DriveError,
    DriveFile, DriveResult, ListPage, Listing, OpenPlan, ShortcutTarget, SignInFailure,
    UploadTarget,
};
use shell_ipc_a::drive::host::{DriveShell, DriveShellHost, ParsedText, StopWatch};
use shell_ipc_a::drive::vault::{DriveVault, SafeStorageCipher, create_drive_vault};
use shell_ipc_a::runtime::{CallReply, Driver, NetHost};
use shell_ipc_a::secrets::SafeStorageHost;

use super::{current_lang, unbuilt};
use crate::host::HostContext;
use crate::host::w::post_core;
use crate::paths::ShellPaths;

pub(super) fn install(hosts: &mut Hosts, _cx: &HostContext) {
    let shell: DriveShellHost = Arc::new(ShellDrive);
    hosts.insert(shell);
    let client: DriveClientHost = Arc::new(ShellDriveClient::new());
    hosts.insert(client);
    hosts.insert(shell_ipc_a::drive::factory());
}

// ---- DriveShell ----

/// `DriveIpcDeps` of drive-ipc.ts: the language and the stored AI settings
/// are real, the rest waits for the tab manager, the file parser and a
/// folder watcher
struct ShellDrive;

impl DriveShell for ShellDrive {
    fn lang(&self) -> Lang {
        current_lang()
    }

    fn open_path(&self, _: &str) -> bool {
        unbuilt("DriveShell::open_path");
        false
    }

    fn is_open(&self, _: &str) -> bool {
        unbuilt("DriveShell::is_open");
        false
    }

    /// `readStoredAiSettings()`: `userData/ai-settings.json` as every reader gets it
    fn stored_ai_settings(&self) -> JsonValue {
        let file = ShellPaths::new()
            .path(PathName::UserData)
            .join("ai-settings.json");
        let text = std::fs::read_to_string(file).ok();
        read_routing_settings(text.as_deref())
    }

    fn document_of(&self, _: f64) -> Option<String> {
        unbuilt("DriveShell::document_of");
        None
    }

    fn parse_file_to_text(&self, _: &Path) -> ParsedText {
        unbuilt("DriveShell::parse_file_to_text");
        ParsedText::default()
    }

    fn watch(&self, _: &Path, _: Arc<dyn Fn(&Path) + Send + Sync>) -> StopWatch {
        unbuilt("DriveShell::watch");
        Box::new(|| {})
    }
}

// ---- DriveClient ----

/// `buildGoogleClient()`: the client this build was made with
fn google_client() -> Option<GoogleClient> {
    let id = option_env!("SEUOFFICE_GOOGLE_CLIENT_ID")?;
    let secret = option_env!("SEUOFFICE_GOOGLE_CLIENT_SECRET")?;
    let name = id.strip_suffix(".apps.googleusercontent.com")?;
    let plain = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    (plain && !secret.is_empty()).then(|| GoogleClient {
        client_id: id.to_owned(),
        client_secret: secret.to_owned(),
    })
}

type Listener = Arc<dyn Fn() + Send + Sync>;
/// Opens Google's page in the system browser
type OpenBrowser = Arc<dyn Fn(&str) -> bool + Send + Sync>;
type BrowserSlot = Rc<RefCell<Option<OpenBrowser>>>;

/// What every thread may read of the connection without waiting for the core
/// thread: its state, and who wants to hear of a change
struct Shared {
    state: Mutex<ConnectionState>,
    listeners: Mutex<Vec<Listener>>,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Shared {
    /// The connection changed (core thread): keep its state, tell the listeners
    fn changed(&self, state: &DriveConnectionState) {
        *locked(&self.state) = state_of(state);
        let listeners = locked(&self.listeners).clone();
        for listener in listeners {
            listener();
        }
    }
}

fn state_of(state: &DriveConnectionState) -> ConnectionState {
    match state {
        DriveConnectionState::Unavailable => ConnectionState::Unavailable,
        DriveConnectionState::Disconnected { expired } => {
            ConnectionState::Disconnected { expired: *expired }
        }
        DriveConnectionState::Connected { account, persisted } => ConnectionState::Connected {
            account: account.as_ref().map(|account| DriveAccount {
                display_name: account.display_name.clone(),
                email_address: account.email_address.clone(),
            }),
            persisted: persisted.as_ref().is_some_and(JsonValue::truthy),
        },
    }
}

/// The connection and the driver it runs on: made once, on the core thread
struct Rig {
    driver: Driver,
    rt: Rt,
    connection: DriveConnection,
    /// opens Google's page for the sign-in in progress (`openBrowser`)
    browser: BrowserSlot,
}

thread_local! {
    static RIG: RefCell<Option<Rc<Rig>>> = const { RefCell::new(None) };
    /// calls of the connection waiting for a worker (the vault)
    static REPLIES: RefCell<HashMap<u64, CallReply>> = RefCell::new(HashMap::new());
}

static NEXT_REPLY: AtomicU64 = AtomicU64::new(1);

/// Answers `reply` with what `work` makes on a worker: the answer is posted
/// back, since a reply is given on the core thread
fn offload(
    services: &Services,
    reply: CallReply,
    work: impl FnOnce() -> Option<JsonValue> + Send + 'static,
) {
    let id = NEXT_REPLY.fetch_add(1, Ordering::Relaxed);
    REPLIES.with(|replies| replies.borrow_mut().insert(id, reply));
    let core = services.core.clone();
    services.workers.spawn(Box::new(move || {
        let answer = work();
        core.post(Box::new(move || {
            let Some(reply) = REPLIES.with(|replies| replies.borrow_mut().remove(&id)) else {
                return;
            };
            match answer {
                Some(value) => reply.value(value),
                None => reply.unit(),
            }
        }));
    }));
}

/// The rig of this thread, made on first use. `None` when a host it stands on is missing.
fn rig(services: &Services, shared: &Arc<Shared>) -> Option<Rc<Rig>> {
    if let Some(rig) = RIG.with(|slot| slot.borrow().clone()) {
        return Some(rig);
    }
    let net = services.hosts.need::<NetHost>(Batch::A).ok()?;
    let storage = services.hosts.need::<SafeStorageHost>(Batch::A).ok()?;
    let vault = Arc::new(create_drive_vault(
        services.paths.path(PathName::UserData).join("google-drive.json"),
        Arc::new(SafeStorageCipher::over_os(storage)),
    ));
    let driver = Driver::new(services, net);
    let browser = BrowserSlot::default();

    {
        let (vault, services) = (vault.clone(), services.clone());
        driver.on_call("vault.load", move |_, reply| {
            let vault: Arc<DriveVault> = vault.clone();
            offload(&services, reply, move || {
                Some(vault.load().map_or(JsonValue::Null, JsonValue::String))
            });
        });
    }
    {
        let (vault, services) = (vault.clone(), services.clone());
        driver.on_call("vault.save", move |args, reply| {
            let token = match &args {
                JsonValue::Array(items) => match items.first() {
                    Some(JsonValue::String(token)) => Some(token.clone()),
                    _ => None,
                },
                _ => None,
            };
            let vault: Arc<DriveVault> = vault.clone();
            offload(&services, reply, move || {
                Some(JsonValue::Bool(
                    token.is_some_and(|token| vault.save(&token)),
                ))
            });
        });
    }
    {
        let (vault, services) = (vault, services.clone());
        driver.on_call("vault.clear", move |_, reply| {
            let vault: Arc<DriveVault> = vault.clone();
            offload(&services, reply, move || {
                vault.clear();
                None
            });
        });
    }
    {
        let browser = browser.clone();
        driver.on_call("openBrowser", move |args, reply| {
            let address = match &args {
                JsonValue::Array(items) => match items.first() {
                    Some(JsonValue::String(address)) => Some(address.clone()),
                    _ => None,
                },
                _ => None,
            };
            let open = browser.borrow().clone();
            match (open, address) {
                (Some(open), Some(address)) => reply.value(JsonValue::Bool(open(&address))),
                _ => reply.fail(JsError::error("no browser round is waiting")),
            }
        });
    }

    let connection = DriveConnection::new(DriveConnectionOptions {
        client: google_client(),
        // neither follows a redirect by hand: reqwest drops the credential
        // headers when a redirect leaves the origin
        fetch: Fetcher::Net,
        download: Some(Fetcher::Net),
        now: None,
    });
    let mirror = shared.clone();
    connection.on_change(Rc::new(move |state| mirror.changed(state)));
    let rig = Rc::new(Rig {
        rt: driver.rt(),
        driver,
        connection,
        browser,
    });
    RIG.with(|slot| *slot.borrow_mut() = Some(rig.clone()));
    Some(rig)
}

/// `DriveError` of a failed call: a rejected promise is a network failure
fn error_of(failure: DriveFailure) -> DriveError {
    match failure.kind() {
        Some(DriveErrorKind::NotConnected) => DriveError::NotConnected,
        Some(DriveErrorKind::NotFound) => DriveError::NotFound,
        Some(DriveErrorKind::Forbidden) => DriveError::Forbidden,
        Some(DriveErrorKind::TooLarge) => DriveError::TooLarge,
        Some(DriveErrorKind::RateLimit) => DriveError::RateLimit,
        Some(DriveErrorKind::Network) | None => DriveError::Network,
    }
}

fn file_of(file: api::DriveFile) -> DriveFile {
    DriveFile {
        id: file.id,
        name: file.name,
        mime_type: file.mime_type,
        modified_time: file.modified_time,
        size: file.size.map(|size| size as u64),
        md5_checksum: file.md5_checksum,
        parents: file.parents.unwrap_or_default(),
        can_edit: file.can_edit,
        shortcut_target: file.shortcut_target.map(|target| ShortcutTarget {
            id: target.id,
            mime_type: target.mime_type,
        }),
    }
}

fn sign_in_failure(failure: ConnectFailure) -> SignInFailure {
    match failure {
        ConnectFailure::Google(GoogleSignInFailure::Cancelled) => SignInFailure::Cancelled,
        ConnectFailure::Google(GoogleSignInFailure::Timeout) => SignInFailure::Timeout,
        ConnectFailure::Google(GoogleSignInFailure::Denied) => SignInFailure::Denied,
        ConnectFailure::Google(GoogleSignInFailure::Scope) => SignInFailure::Scope,
        ConnectFailure::Google(GoogleSignInFailure::Network) => SignInFailure::Network,
        ConnectFailure::Unavailable => SignInFailure::Unavailable,
    }
}

fn pages_of(round: &BrowserRound) -> SignInPages {
    let page = |page: &shell_ipc_a::drive::client::SignInPage| GooglePage {
        lang: page.lang.clone(),
        title: page.title.clone(),
        body: page.body.clone(),
    };
    SignInPages {
        done: page(&round.done),
        failed: page(&round.failed),
    }
}

/// The Drive connection of the shell
struct ShellDriveClient {
    shared: Arc<Shared>,
}

impl ShellDriveClient {
    fn new() -> Self {
        let state = if google_client().is_some() {
            ConnectionState::Disconnected { expired: false }
        } else {
            ConnectionState::Unavailable
        };
        ShellDriveClient {
            shared: Arc::new(Shared {
                state: Mutex::new(state),
                listeners: Mutex::new(Vec::new()),
            }),
        }
    }

    /// Runs the future `make` builds on the core thread's driver and waits
    /// for its output. `None` when it could not run (the batches have not
    /// registered, or a host is missing) or never answered.
    fn on_core<O: Send + 'static>(
        &self,
        make: impl FnOnce(&Rig) -> LocalBoxFuture<O> + Send + 'static,
    ) -> Option<O> {
        let (answer, answered) = mpsc::channel();
        let shared = self.shared.clone();
        post_core(move |_, services| {
            let Some(rig) = rig(services, &shared) else {
                return;
            };
            rig.driver.run(make(&rig), move |output| {
                let _ = answer.send(output);
            });
        });
        answered.recv().ok()
    }

    /// An `api` call: its failure is a `DriveError`
    fn api<O: Send + 'static>(
        &self,
        make: impl FnOnce(&Rig) -> LocalBoxFuture<Result<O, DriveFailure>> + Send + 'static,
    ) -> DriveResult<O> {
        self.on_core(move |rig| -> LocalBoxFuture<DriveResult<O>> {
            let call = make(rig);
            Box::pin(async move { call.await.map_err(error_of) })
        })
        .unwrap_or(Err(DriveError::Network))
    }
}

impl DriveClient for ShellDriveClient {
    fn state(&self) -> ConnectionState {
        locked(&self.shared.state).clone()
    }

    fn connected(&self) -> bool {
        matches!(*locked(&self.shared.state), ConnectionState::Connected { .. })
    }

    fn load(&self) {
        let _ = self.on_core(|rig| -> LocalBoxFuture<()> {
            let (connection, rt) = (rig.connection.clone(), rig.rt.clone());
            Box::pin(async move {
                connection.load(&rt).await;
            })
        });
    }

    fn on_change(&self, listener: Arc<dyn Fn() + Send + Sync>) {
        locked(&self.shared.listeners).push(listener);
    }

    fn connect(&self, round: &BrowserRound) -> Result<(), SignInFailure> {
        let pages = pages_of(round);
        let open = round.open_browser.clone();
        self.on_core(move |rig| -> LocalBoxFuture<Result<(), SignInFailure>> {
            *rig.browser.borrow_mut() = Some(open);
            let (connection, rt) = (rig.connection.clone(), rig.rt.clone());
            Box::pin(async move {
                connection
                    .connect(&rt, &pages)
                    .await
                    .map_err(sign_in_failure)
            })
        })
        .unwrap_or(Err(SignInFailure::Network))
    }

    fn pick(&self, round: &BrowserRound, multiple: bool) -> Result<Vec<String>, SignInFailure> {
        let pages = pages_of(round);
        let open = round.open_browser.clone();
        self.on_core(move |rig| -> LocalBoxFuture<Result<Vec<String>, SignInFailure>> {
            *rig.browser.borrow_mut() = Some(open);
            let (connection, rt) = (rig.connection.clone(), rig.rt.clone());
            Box::pin(async move {
                connection
                    .pick(&rt, &pages, multiple)
                    .await
                    .map_err(sign_in_failure)
            })
        })
        .unwrap_or(Err(SignInFailure::Network))
    }

    fn cancel_connect(&self) {
        post_core(|_, _| {
            let connection = RIG.with(|slot| slot.borrow().as_ref().map(|r| r.connection.clone()));
            if let Some(connection) = connection {
                connection.cancel_connect();
            }
        });
    }

    fn disconnect(&self) {
        let _ = self.on_core(|rig| -> LocalBoxFuture<()> {
            let (connection, rt) = (rig.connection.clone(), rig.rt.clone());
            Box::pin(async move { connection.disconnect(&rt).await })
        });
    }

    fn list(
        &self,
        listing: &Listing,
        page_token: Option<&str>,
        page_size: Option<u32>,
    ) -> DriveResult<ListPage> {
        let listing = match listing {
            Listing::Recent => DriveListing::Recent,
            Listing::Search(text) => DriveListing::Search { text: text.clone() },
        };
        let options = ListOptions {
            page_token: page_token.map(str::to_owned),
            page_size: page_size.map(f64::from),
        };
        self.api(move |rig| {
            let (connection, rt) = (rig.connection.clone(), rig.rt.clone());
            Box::pin(async move {
                let list = connection.api.list(&rt, &listing, &options, None).await?;
                Ok(ListPage {
                    files: list.files.into_iter().map(file_of).collect(),
                    next_page_token: list.next_page_token,
                })
            })
        })
    }

    fn file(&self, id: &str) -> DriveResult<DriveFile> {
        let id = id.to_owned();
        self.api(move |rig| {
            let (connection, rt) = (rig.connection.clone(), rig.rt.clone());
            Box::pin(async move { connection.api.file(&rt, &id, None).await.map(file_of) })
        })
    }

    fn download(&self, id: &str, max_bytes: usize) -> DriveResult<Vec<u8>> {
        let id = id.to_owned();
        self.api(move |rig| {
            let (connection, rt) = (rig.connection.clone(), rig.rt.clone());
            Box::pin(async move {
                connection
                    .api
                    .download(&rt, &id, max_bytes as f64, None)
                    .await
            })
        })
    }

    fn export(&self, id: &str, mime: &str, max_bytes: usize) -> DriveResult<Vec<u8>> {
        let (id, mime) = (id.to_owned(), mime.to_owned());
        self.api(move |rig| {
            let (connection, rt) = (rig.connection.clone(), rig.rt.clone());
            Box::pin(async move {
                connection
                    .api
                    .export(&rt, &id, &mime, max_bytes as f64, None)
                    .await
            })
        })
    }

    fn upload(&self, target: &UploadTarget, bytes: &[u8], mime: &str) -> DriveResult<DriveFile> {
        let target = match target {
            UploadTarget::Existing(id) => api::UploadTarget::Existing { id: id.clone() },
            UploadTarget::New { name, parent_id } => api::UploadTarget::New {
                name: name.clone(),
                parent_id: parent_id.clone(),
            },
        };
        let (bytes, mime) = (bytes.to_vec(), mime.to_owned());
        self.api(move |rig| {
            let (connection, rt) = (rig.connection.clone(), rig.rt.clone());
            Box::pin(async move {
                connection
                    .api
                    .upload(&rt, &target, &bytes, &mime, None)
                    .await
                    .map(file_of)
            })
        })
    }

    fn open_plan(&self, name: &str, mime_type: &str) -> OpenPlan {
        match formats::open_plan(name, mime_type) {
            formats::OpenPlan::Download { extension } => OpenPlan::Download { extension },
            formats::OpenPlan::Export {
                mime: Some(mime),
                extension: Some(extension),
            } => OpenPlan::Export { mime, extension },
            // a mime type that names a property of `Object.prototype`
            formats::OpenPlan::Export { .. } | formats::OpenPlan::None => OpenPlan::None,
        }
    }

    fn is_google_native(&self, mime_type: &str) -> bool {
        formats::is_google_native(mime_type)
    }

    fn local_file_name(&self, drive_name: &str, extension: &str) -> String {
        formats::local_file_name(drive_name, extension)
    }

    fn office_copy_name(&self, drive_name: &str, extension: &str) -> String {
        formats::office_copy_name(drive_name, extension)
    }

    fn upload_mime(&self, name: &str) -> String {
        formats::upload_mime(name)
    }
}
