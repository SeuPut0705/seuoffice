//! The `diagram` channels of batch D1: `apps/diagram/src/main/`
//! (`diagram-main.ts`, `export-main.ts`, `headless-main.ts`, `mcp-queries.ts`,
//! `ai-attachments.ts`, `recovery-main.ts`).
//!
//! All state sits in one [`DiagramViews`] handle created by [`routes`] and
//! captured by every handler. The shell reaches it through [`views`] to do
//! what the TypeScript's exported functions did: [`DiagramViews::open_view`]
//! when it creates a tab (`grantAndTrack`), the close guard, the menu's save,
//! the in-app MCP server's questions. What the TypeScript awaited on a
//! renderer's reply is a continuation stored in the state and resumed by the
//! channel that carries the reply; waits that ended on a timer end on a timer
//! thread that posts back to the core thread.

mod attachments;
mod editors;
mod engine;
mod export;
#[cfg(any(test, feature = "probe"))]
mod fakes;
mod files;
mod formats;
mod headless;
mod lifecycle;
mod queries;
mod recovery;
mod shell;
mod state;
mod strings;
#[cfg(test)]
mod tests;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jscompat::random_uuid;
use main_core::packages::electron_utils::recovery_store::{
    RecoveryStore, RecoveryStoreOptions, create_recovery_store,
};
use main_core::packages::i18n::Lang;
use shell_contract::editors::DocumentEditors;
use shell_contract::hosts::{DialogsHost, OsShellHost};
use shell_contract::ipc::{RegisterError, Target};
use shell_contract::provided::Provided;
use shell_contract::runtime::{PathName, Services};
use shell_contract::{Batch, IpcValue, ViewId, WindowId};

use crate::host::{LocaleHost, RecoveryStateHost, Shared, path_string};
use crate::route::{self, Route};

pub use attachments::{
    ATTACHMENT_IMAGE_MAX_BYTES, ATTACHMENT_MAX_BYTES, ATTACHMENT_READ_MAX_CHARS,
};
pub use engine::{DiagramEngine, DiagramEngineHost, DiagramFile, OpenFailure, ParsedText};
pub use formats::{DiagramFormat, openable_link};
pub use lifecycle::TabIdentity;
pub use shell::{DiagramShell, DiagramShellHost};
pub use state::PageRead;

use state::{State, WaitEnd};

/// Everything the handlers and the shell's calls share. Core thread only.
pub(crate) struct Inner {
    id: u64,
    services: Services,
    engine: DiagramEngineHost,
    shell: DiagramShellHost,
    dialogs: DialogsHost,
    os_shell: OsShellHost,
    locale: LocaleHost,
    shared: Arc<Shared>,
    recovery_state: RecoveryStateHost,
    state: RefCell<State>,
    text_cache: Arc<Mutex<attachments::TextCache>>,
}

/// The diagram editor's per-view state and what the shell asks of it. Cheap
/// to clone; use it on the core thread.
#[derive(Clone)]
pub struct DiagramViews(Rc<Inner>);

thread_local! {
    static INSTANCES: RefCell<HashMap<u64, Weak<Inner>>> = RefCell::new(HashMap::new());
    static LAST: Cell<u64> = const { Cell::new(0) };
}

/// The handle [`routes`] made last, for the shell that creates diagram tabs.
/// Core thread only; none before the batch registered.
pub fn views() -> Option<DiagramViews> {
    lookup(LAST.with(Cell::get))
}

fn lookup(id: u64) -> Option<DiagramViews> {
    INSTANCES
        .with(|all| all.borrow().get(&id).and_then(Weak::upgrade))
        .map(DiagramViews)
}

impl DiagramViews {
    fn new(services: &Services) -> Result<DiagramViews, RegisterError> {
        let hosts = &services.hosts;
        let id = LAST.with(|last| {
            last.set(last.get() + 1);
            last.get()
        });
        let inner = Rc::new(Inner {
            id,
            services: services.clone(),
            engine: hosts.need::<DiagramEngineHost>(Batch::D1)?,
            shell: hosts.need::<DiagramShellHost>(Batch::D1)?,
            dialogs: hosts.need::<DialogsHost>(Batch::D1)?,
            os_shell: hosts.need::<OsShellHost>(Batch::D1)?,
            locale: hosts.need::<LocaleHost>(Batch::D1)?,
            shared: hosts.need::<Arc<Shared>>(Batch::D1)?,
            recovery_state: hosts.need::<RecoveryStateHost>(Batch::D1)?,
            state: RefCell::new(State::default()),
            text_cache: Arc::default(),
        });
        INSTANCES.with(|all| all.borrow_mut().insert(id, Rc::downgrade(&inner)));
        Ok(DiagramViews(inner))
    }

    fn with_state<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut self.0.state.borrow_mut())
    }

    fn lang(&self) -> Lang {
        self.0.locale.ui_lang()
    }

    /// `tm(key)`
    fn tm(&self, key: &str) -> String {
        strings::tm(self.lang(), key)
    }

    /// `!contents.isDestroyed()`
    fn alive(&self, view: ViewId) -> bool {
        self.0.services.views.sender_of(view).is_some()
    }

    /// `contents.send(channel, ...args)`
    fn emit(&self, view: ViewId, channel: &'static str, args: Vec<IpcValue>) {
        self.0
            .services
            .events
            .emit(Target::View(view), channel, args);
    }

    /// `BrowserWindow.fromWebContents(contents)`
    fn window_of(&self, view: ViewId) -> Option<WindowId> {
        self.0.services.views.sender_of(view).map(|s| s.window)
    }

    fn user_data_dir(&self) -> String {
        path_string(self.0.services.paths.path(PathName::UserData))
    }

    /// Runs `job` on the core thread after `delay` (`setTimeout`). The timer
    /// is a thread that only sleeps and posts; `job` finds this handle again
    /// by its id, so nothing non-`Send` crosses.
    fn after(&self, delay: Duration, job: impl FnOnce(&DiagramViews) + Send + 'static) {
        let id = self.0.id;
        let core = self.0.services.core.clone();
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            core.post(Box::new(move || {
                if let Some(views) = lookup(id) {
                    job(&views);
                }
            }));
        });
    }

    /// The shared recovery store over this app's data folder
    /// (`diagramRecoveryStore()`)
    fn with_store<R>(&self, f: impl FnOnce(&RecoveryStore<'_>) -> R) -> R {
        let shared = self
            .0
            .recovery_state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let dir = self.user_data_dir();
        let user_data_dir = move || dir.clone();
        let now_ms = || {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0.0, |d| d.as_millis() as f64)
        };
        let uuid = random_uuid;
        let store = create_recovery_store(
            RecoveryStoreOptions {
                user_data_dir: &user_data_dir,
                now_ms: &now_ms,
                random_uuid: &uuid,
            },
            &shared,
        );
        f(&store)
    }

    /// The views and the headless job a probe case starts with
    #[cfg(any(test, feature = "probe"))]
    fn apply_probe(&self, probe: &fakes::ProbeOpen) {
        for entry in &probe.open {
            self.open_view(entry.view, entry.path.as_deref());
            if let Some(decision) = entry.decision {
                self.set_view_open_decision(entry.view, decision);
            }
            if let Some(seed) = &entry.seed {
                self.queue_seed(entry.view, seed);
            }
        }
        if let Some((view, path)) = &probe.headless {
            self.open_hidden_view(*view, path);
            let job = crate::value::obj([
                ("kind", crate::value::string("export")),
                ("format", crate::value::string("png")),
            ]);
            self.run_headless_job(*view, job, Box::new(|_| {}));
        }
    }

    /// `e.sender` gone: what `grantAndTrack`'s `destroyed` listener did
    fn view_gone(&self, view: ViewId) {
        let removed = self.with_state(|state| state.views.remove(&view));
        let dirty = removed.as_ref().is_some_and(|v| v.dirty);
        self.recovery_view_gone(view, dirty);
        // a question to the renderer that can no longer be answered
        self.fail_queries_of(view);
        let Some(mut gone) = removed else { return };
        if let Some(copy_now) = gone.copy_now.take() {
            (copy_now.finish)();
        }
        if let Some(waiter) = gone.close_save.take() {
            (waiter.resume)(WaitEnd::Answer(false));
        }
        if let Some(waiter) = gone.save.take() {
            (waiter.resume)(WaitEnd::Answer(false));
        }
    }
}

/// `registerDiagramIpc()`: the 27 channels the renderer calls
pub fn routes(services: &Services, provided: &Rc<Provided>) -> Result<Vec<Route>, RegisterError> {
    let views = DiagramViews::new(services)?;
    provided.add::<dyn DocumentEditors>(Rc::new(editors::DiagramEditors(views.clone())));
    #[cfg(any(test, feature = "probe"))]
    if let Some(probe) = services.hosts.get::<fakes::ProbeOpen>() {
        views.apply_probe(probe);
    }
    let gone = views.clone();
    crate::host::on_view_gone(services, move |view| gone.view_gone(view));

    macro_rules! invoke {
        ($channel:literal, $method:ident) => {{
            let views = views.clone();
            route::invoke($channel, move |cx, args| views.$method(cx, args))
        }};
    }
    macro_rules! later {
        ($channel:literal, $method:ident) => {{
            let views = views.clone();
            route::invoke_later($channel, move |cx, args, reply| {
                views.$method(cx, args, reply)
            })
        }};
    }
    macro_rules! send {
        ($channel:literal, $method:ident) => {{
            let views = views.clone();
            route::send($channel, move |cx, args| views.$method(cx, args))
        }};
    }

    Ok(vec![
        invoke!("diagram:consume-pending", consume_pending),
        invoke!("diagram:open-file", open_file),
        invoke!("diagram:save-target", save_target),
        invoke!("diagram:save", save),
        invoke!("diagram:save-into-project", save_into_project),
        invoke!("diagram:open-link", open_link),
        send!("diagram:open-help", open_help),
        invoke!("diagram:open-failed", open_failed),
        send!("diagram:dirty-changed", dirty_changed),
        send!("diagram:close-save-result", close_save_result),
        send!("diagram:save-request-ack", save_request_ack),
        invoke!("diagram:recovery-copy", recovery_copy),
        send!("diagram:recovery-copy-now-done", recovery_copy_now_done),
        invoke!("diagram:seed-take", seed_take),
        invoke!("diagram:export-images", export_images),
        later!("diagram:export-pdf", export_pdf),
        invoke!("diagram:files-pick", files_pick),
        invoke!("diagram:files-add", files_add),
        invoke!("diagram:files-add-pasted-image", files_add_pasted_image),
        later!("diagram:files-read", files_read),
        invoke!("diagram:files-read-image", files_read_image),
        send!("diagram:provisional-title", provisional_title),
        send!("diagram:read-result", read_result),
        send!("diagram:apply-result", apply_result),
        send!("diagram:bytes-result", bytes_result),
        invoke!("diagram:headless-job", headless_job),
        send!("diagram:headless-done", headless_done),
    ])
}

/// This app's fake hosts for [`crate::testkit::Kit`] and the probe; `case` is
/// the case's `hosts.d1` value (see [`fakes`])
#[cfg(any(test, feature = "probe"))]
pub fn insert_fakes(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    fakes::insert(hosts, case);
}

/// This app's triggers for [`crate::probe_trigger`]: `name` without its
/// `d1/` prefix; false when it is not one of them
#[cfg(feature = "probe")]
pub fn probe_trigger(
    _name: &str,
    _view: shell_contract::ViewId,
    _args: &serde_json::Value,
    _services: &Services,
    _provided: &std::rc::Rc<shell_contract::provided::Provided>,
    _then: shell_contract::editors::Then<shell_contract::IpcValue>,
) -> bool {
    false
}
