//! `projectFolder:*` and `project:*`: the project folder bridge of the AI
//! panels and the home project screen (decision 0088).
//!
//! `projectFolder:*` is `registerProjectFolderChannels` of
//! `apps/shell/src/main/index.ts` over `main-core`'s
//! [`ProjectIpc`](main_core::shell::projects::project_ipc::ProjectIpc): every
//! request is judged by the window that sent it. [`Projects`] is the state of
//! this area on the core thread; the project guide, the chat store and the
//! tools it serves the requests with are made on the first request, as
//! `projectFolderServices()` made them (see [`services`]).
//!
//! Five requests reach the first-time trust prompt in the middle of the
//! guide's call. [`ProjectIpc`](main_core::shell::projects::project_ipc::ProjectIpc)
//! answers them as steps, and this file carries the steps out without ever
//! waiting for a renderer: the prompt is a message box over the asking window
//! (`DialogsHost`), and [view all]'s wait for the person to come back to the
//! page is a [`PageEvent`] the host reports later, answered while other
//! requests are served meanwhile.
//!
//! `project:*` is the per-document chat of the app-data project store, in
//! [`legacy`]. What the shell must provide is in [`host`].

pub mod host;
mod legacy;
#[cfg(feature = "probe")]
mod probe;
mod services;

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::{Rc, Weak};
use std::sync::Arc;

use jscompat::JsonValue;
use main_core::packages::electron_utils::default_save_dir::Thrown;
use main_core::packages::project_store::{
    PROJECT_FOLDER_CHANNELS, PROJECT_FOLDER_LISTEN_CHANNEL, ProjectId,
};
use main_core::shell::projects::new_documents::NewDocumentPlacer;
use main_core::shell::projects::project_guide::ProjectGuide;
use main_core::shell::projects::project_ipc::{
    IpcStep, PageReturnWatch, ProjectIpc, ProjectIpcDeps, TRUST_RETURN_ARM_MS,
};
use serde_json::Value;
use shell_contract::error::IpcError;
use shell_contract::ids::ViewId;
use shell_contract::ipc::{CallContext, ChannelKind, Handler, RegisterError, Registry, Responder};
use shell_contract::runtime::{Services as ShellServices, Thread};
use shell_contract::value::IpcValue;
use shell_contract::{Batch, DialogsHost, OsShellHost};

pub use host::{
    LegacyProjectStore, LegacyProjectStoreHost, PageEvent, PageEvents, ProjectFiles,
    ProjectFilesHost, ProjectTimer, ProjectsHost, ProjectsHostRef,
};
#[cfg(feature = "probe")]
pub use probe::{probe_hosts, probe_trigger};

use self::services::{GuidePending, Services, Shell};

/// A JSON value as the structured clone would carry it
pub(crate) fn to_ipc(value: &Value) -> IpcValue {
    match value {
        Value::Null => IpcValue::Null,
        Value::Bool(b) => IpcValue::Bool(*b),
        Value::Number(n) => IpcValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => IpcValue::String(s.clone()),
        Value::Array(items) => IpcValue::Array(items.iter().map(to_ipc).collect()),
        Value::Object(map) => {
            IpcValue::Object(map.iter().map(|(k, v)| (k.clone(), to_ipc(v))).collect())
        }
    }
}

/// What an `unknown` the renderer sent is to a handler that reads it as JSON:
/// `None` is `undefined`; an `undefined` member is a member that is not there
pub(crate) fn json_of(value: &IpcValue) -> Option<JsonValue> {
    Some(match value {
        IpcValue::Undefined => return None,
        IpcValue::Null => JsonValue::Null,
        IpcValue::Bool(flag) => JsonValue::Bool(*flag),
        IpcValue::Number(number) => JsonValue::Number(*number),
        IpcValue::String(text) => JsonValue::String(text.clone()),
        IpcValue::Array(items) => JsonValue::Array(
            items
                .iter()
                .map(|item| json_of(item).unwrap_or(JsonValue::Null))
                .collect(),
        ),
        IpcValue::Object(entries) => {
            let mut object = jscompat::JsObject::new();
            for (key, item) in entries {
                if let Some(item) = json_of(item) {
                    object.set(key.clone(), item);
                }
            }
            JsonValue::Object(object)
        }
        // a byte buffer or a date has no member a handler reads
        IpcValue::Bytes(..) | IpcValue::Date(_) => JsonValue::Object(jscompat::JsObject::new()),
    })
}

fn error_of(thrown: Thrown) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: thrown.0,
    }
}

/// A request that waits for the person to come back to the page [view all]
/// left: what it was answering, and its reply
struct Wait {
    id: u64,
    view: ViewId,
    /// whether the host reports the page's focus and blur for it
    watching: bool,
    watch: PageReturnWatch,
    pending: main_core::shell::projects::project_ipc::AwaitingReturn<GuidePending>,
    reply: Responder,
}

struct Inner {
    ipc: ProjectIpc,
    /// made on the first request, as `projectFolderServices()` was
    services: Option<Services>,
    waits: Vec<Wait>,
    next_wait: u64,
    /// whether the host holds the timer of the guide's use times
    touch_timer: bool,
}

/// The state of the project folder requests on the core thread
pub struct Projects {
    shell: Shell,
    inner: RefCell<Inner>,
    /// `projectTrackedContents`
    tracked: Rc<RefCell<HashSet<ViewId>>>,
    this: Weak<Projects>,
}

thread_local! {
    /// The state of this core thread: the host reports its page events to it
    static CURRENT: RefCell<Option<Rc<Projects>>> = const { RefCell::new(None) };
}

/// Where the host's page events go: onto the core thread, into
/// [`Projects::page_event`]
struct Reporter {
    core: Arc<dyn Thread>,
}

impl PageEvents for Reporter {
    fn send(&self, event: PageEvent) {
        self.core.post(Box::new(move || {
            if let Some(projects) = CURRENT.with(|current| current.borrow().clone()) {
                projects.page_event(event);
            }
        }));
    }
}

impl Projects {
    fn new(shell: Shell) -> Rc<Projects> {
        Rc::new_cyclic(|this| Projects {
            shell,
            inner: RefCell::new(Inner {
                ipc: ProjectIpc::new(None),
                services: None,
                waits: Vec::new(),
                next_wait: 1,
                touch_timer: false,
            }),
            tracked: Rc::default(),
            this: this.clone(),
        })
    }

    /// Calls `f` with the request layer and the services it is served with
    fn serve<R>(
        &self,
        f: impl FnOnce(&mut ProjectIpc, &mut ProjectIpcDeps<'_, GuidePending>) -> R,
    ) -> R {
        let mut guard = self.inner.borrow_mut();
        let Inner { ipc, services, .. } = &mut *guard;
        let services = services.get_or_insert_with(|| {
            Services::new(&self.shell, self.tracked.clone(), self.this.clone())
        });
        let mut deps = ProjectIpcDeps {
            guide: &mut services.guide,
            chats: &mut services.chats,
            tools: &mut services.tools,
            scopes: &mut services.scopes,
            dialogs: &mut services.dialogs,
            host: &mut services.host,
        };
        f(ipc, &mut deps)
    }

    /// `trackProjectContents(contents)`: follow the view's close and reloads
    fn track(&self, view: ViewId) {
        if self.tracked.borrow_mut().insert(view) {
            self.shell.host.track(view);
        }
    }

    /// One request of the bridge: `handlers[name](sender, raw)`
    fn request(
        &self,
        name: &'static str,
        sender: ViewId,
        raw: Option<JsonValue>,
        reply: Responder,
    ) {
        self.track(sender);
        let step =
            self.serve(|ipc, deps| ipc.handle(deps, name, i64::from(sender.0), raw.as_ref()));
        self.advance(step, reply);
        self.sync_touch_timer();
    }

    /// `ipcMain.on(PROJECT_FOLDER_LISTEN_CHANNEL)`: a bridge started or
    /// stopped listening to one event
    fn listen(&self, sender: ViewId, message: Option<JsonValue>) {
        self.track(sender);
        let (method, listening) = match &message {
            Some(JsonValue::Object(object)) => (object.get("method"), object.get("listening")),
            _ => (None, None),
        };
        self.serve(|ipc, deps| ipc.listen(&mut *deps.host, i64::from(sender.0), method, listening));
    }

    /// Carries out the steps of a request until it is answered or waits for
    /// the person to come back to the page
    fn advance(&self, mut step: Result<IpcStep<GuidePending>, Thrown>, reply: Responder) {
        loop {
            match step {
                Err(thrown) => return reply.reply(Err(error_of(thrown))),
                Ok(IpcStep::Done(value)) => {
                    return reply.reply(Ok(value.as_ref().map_or(IpcValue::Undefined, to_ipc)));
                }
                Ok(IpcStep::AskTrust {
                    owner,
                    prompt,
                    pending,
                }) => {
                    // a modal message box over the asking window
                    let choice = self.shell.ask_trust(owner, &prompt);
                    step = self.serve(|ipc, deps| ipc.resume_trust(deps, pending, choice));
                }
                Ok(IpcStep::WaitForReturn { owner, pending }) => {
                    let page = u32::try_from(owner)
                        .ok()
                        .map(ViewId)
                        .filter(|view| self.shell.views.sender_of(*view).is_some());
                    let Some(view) = page else {
                        // `webContents.fromId(owner)` is none: the page is gone
                        step = self.serve(|ipc, deps| ipc.resume_return(deps, pending, false));
                        continue;
                    };
                    // `waitForPageReturn(page)`: the timer is set, then the
                    // page's listeners added
                    let destroyed = self.shell.host.page_destroyed(view);
                    let id = {
                        let mut inner = self.inner.borrow_mut();
                        let id = inner.next_wait;
                        inner.next_wait += 1;
                        id
                    };
                    if !destroyed {
                        self.shell
                            .host
                            .set_timer(ProjectTimer::ReturnArm(id), TRUST_RETURN_ARM_MS);
                        self.shell.host.watch_return(view);
                    }
                    self.inner.borrow_mut().waits.push(Wait {
                        id,
                        view,
                        watching: !destroyed,
                        watch: PageReturnWatch::new(destroyed),
                        pending,
                        reply,
                    });
                    return self.settle();
                }
            }
        }
    }

    /// Answers the waits whose page came back or went away
    fn settle(&self) {
        loop {
            let done = {
                let mut inner = self.inner.borrow_mut();
                let at = inner
                    .waits
                    .iter()
                    .position(|wait| wait.watch.outcome().is_some());
                at.map(|at| inner.waits.remove(at))
            };
            let Some(wait) = done else {
                return;
            };
            let back = wait.watch.outcome().unwrap_or(false);
            if wait.watching {
                self.shell
                    .host
                    .clear_timer(ProjectTimer::ReturnArm(wait.id));
                self.shell.host.stop_return(wait.view);
            }
            let step = self.serve(|ipc, deps| ipc.resume_return(deps, wait.pending, back));
            self.advance(step, wait.reply);
        }
    }

    /// What the host reports of a page or a timer
    fn page_event(&self, event: PageEvent) {
        match event {
            PageEvent::Navigated(view) => {
                if self.tracked.borrow().contains(&view) {
                    self.inner.borrow_mut().ipc.reset(i64::from(view.0));
                }
            }
            PageEvent::Destroyed(view) => {
                if self.tracked.borrow_mut().remove(&view) {
                    self.inner.borrow_mut().ipc.forget(i64::from(view.0));
                }
                for wait in &mut self.inner.borrow_mut().waits {
                    if wait.view == view {
                        wait.watch.destroyed();
                    }
                }
            }
            PageEvent::Blur(view) => {
                for wait in &mut self.inner.borrow_mut().waits {
                    if wait.view == view {
                        wait.watch.blur();
                    }
                }
            }
            PageEvent::Focus(view) => {
                for wait in &mut self.inner.borrow_mut().waits {
                    if wait.view == view {
                        wait.watch.focus();
                    }
                }
            }
            PageEvent::Timer(ProjectTimer::ReturnArm(id)) => {
                for wait in &mut self.inner.borrow_mut().waits {
                    if wait.id == id {
                        // the timer fired: its clear is still asked at the end, as `finish` does
                        wait.watch.arm();
                    }
                }
            }
            PageEvent::Timer(ProjectTimer::Touches) => {
                let guide = {
                    let mut inner = self.inner.borrow_mut();
                    inner.touch_timer = false;
                    inner
                        .services
                        .as_ref()
                        .map(|services| services.guide.0.clone())
                };
                if let Some(guide) = guide {
                    let _ = guide.flush_touches();
                }
            }
        }
        self.settle();
        self.sync_touch_timer();
    }

    /// The guide records when it would have armed `setTimeout` for a use
    /// time; the host runs that timer
    fn sync_touch_timer(&self) {
        let (armed, guide) = {
            let inner = self.inner.borrow();
            let guide = inner
                .services
                .as_ref()
                .map(|services| services.guide.0.clone());
            (inner.touch_timer, guide)
        };
        let Some(guide) = guide else {
            return;
        };
        match (armed, guide.touch_timer()) {
            (false, Some(timer)) => {
                self.shell
                    .host
                    .set_timer(ProjectTimer::Touches, timer.delay);
                self.inner.borrow_mut().touch_timer = true;
            }
            (true, None) => {
                self.shell.host.clear_timer(ProjectTimer::Touches);
                self.inner.borrow_mut().touch_timer = false;
            }
            _ => {}
        }
    }

    // ---- what the rest of the shell asks of this area ----

    /// `projectFolderIpc.windowProject(id)`: the project this window's AI
    /// panel has chosen now (the panel's last answer, else the starting
    /// selection); `None` for "no project" and for a window that is no AI window
    pub fn window_project(&self, sender: i64) -> Option<ProjectId> {
        self.serve(|ipc, deps| ipc.window_project(deps, sender))
    }

    /// `projectFolderIpc.untitledProject(id)`: the project an untitled
    /// document's panel chose
    pub fn untitled_project(&self, sender: i64) -> Option<ProjectId> {
        self.inner.borrow().ipc.untitled_project(sender)
    }

    /// `projectFolderServices().guide`
    pub fn guide(&self) -> Rc<ProjectGuide> {
        self.serve(|_, deps| {
            let _ = deps;
        });
        self.inner
            .borrow()
            .services
            .as_ref()
            .map(|services| services.guide.0.clone())
            .expect("the services were made")
    }

    /// `newDocuments`: where a window's new documents go
    pub fn new_documents(&self) -> Rc<RefCell<NewDocumentPlacer<Rc<ProjectGuide>>>> {
        self.serve(|_, deps| {
            let _ = deps;
        });
        self.inner
            .borrow()
            .services
            .as_ref()
            .map(|services| services.placer.clone())
            .expect("the services were made")
    }

    /// `projectFolderRuntime?.guide.flushTouches()` at quit
    pub fn flush_touches(&self) {
        let guide = self
            .inner
            .borrow()
            .services
            .as_ref()
            .map(|services| services.guide.0.clone());
        if let Some(guide) = guide {
            let _ = guide.flush_touches();
        }
        self.sync_touch_timer();
    }
}

/// One `PROJECT_FOLDER_CHANNELS` request
struct Request {
    projects: Rc<Projects>,
    name: &'static str,
}

impl Handler for Request {
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let raw = args.first().and_then(json_of);
        self.projects.request(self.name, cx.sender.view, raw, reply);
    }
}

/// `ipcMain.on(PROJECT_FOLDER_LISTEN_CHANNEL)`
struct Listen {
    projects: Rc<Projects>,
}

impl Handler for Listen {
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.projects
            .listen(cx.sender.view, args.first().and_then(json_of));
        reply.reply(Ok(IpcValue::Undefined));
    }
}

pub fn register(
    registry: &mut dyn Registry,
    services: &ShellServices,
) -> Result<(), RegisterError> {
    let hosts = &services.hosts;
    let shell = Shell {
        host: hosts.need::<ProjectsHostRef>(Batch::W)?,
        home: hosts.need(Batch::W)?,
        search: hosts.need(Batch::W)?,
        files: hosts.need::<ProjectFilesHost>(Batch::W)?,
        legacy: hosts.need::<LegacyProjectStoreHost>(Batch::W)?,
        dialogs: hosts.need::<DialogsHost>(Batch::W)?,
        os: hosts.need::<OsShellHost>(Batch::W)?,
        events: services.events.clone(),
        views: services.views.clone(),
        paths: services.paths.clone(),
        provided: registry.provided(),
    };
    legacy::register(registry, &shell.legacy, &shell.home)?;
    let projects = Projects::new(shell);
    projects.shell.host.attach(Arc::new(Reporter {
        core: services.core.clone(),
    }));
    CURRENT.with(|current| *current.borrow_mut() = Some(projects.clone()));
    registry.provided().add::<Projects>(projects.clone());
    for (name, channel) in PROJECT_FOLDER_CHANNELS {
        registry.register(
            Batch::W,
            channel,
            ChannelKind::Invoke,
            Rc::new(Request {
                projects: projects.clone(),
                name,
            }),
        )?;
    }
    registry.register(
        Batch::W,
        PROJECT_FOLDER_LISTEN_CHANNEL,
        ChannelKind::Send,
        Rc::new(Listen { projects }),
    )
}
