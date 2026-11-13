//! The generate window ("make a new document from these files",
//! `apps/shell/src/main/generate/generate-window.ts`) and the ways into it:
//! the ten `generate:*` channels the window's own page calls, the two Home
//! calls (`generate:open-with-paths`, `generate:open-with-group`) and the
//! `generate:state` event the window is pushed.
//!
//! The module is in `main-core` (`main_core::shell::generate`); this is its
//! shell: [`GenerateWindowPort`] holds the module's window state and answers
//! the channels, and the Electron parts come through [`host::GenerateShell`]
//! (the window, the tabs and the engines `main-core` does not hold yet) and
//! the shared hosts (dialogs, the OS shell, the main window).
//!
//! The port uses the one hand-off store (`handoff.ts`: what "make" queues
//! for a new tab, taken once by its editor), shared with the skills channels
//! through `crate::user_skills::shared_handoff_store`, and owns the make
//! window entry an editor's File menu uses (`openGenerateWindowForDocument`):
//! [`GenerateWindowPort::handoff_store`] and
//! [`GenerateWindowPort::make_window_opener`] are what the shell hands to
//! the menus (`attach_make_window`).
//!
//! Nothing blocks the core thread on a renderer or a timer: the open tabs
//! (`deps.list()`) are asked for first and the call goes on when they are
//! known; "save" waits for the editor's answer and for the recheck timer as
//! resumable steps; the file picker of "add" runs on a worker.

mod bridge;
pub mod host;

#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use main_core::packages::electron_utils::generate_handoff::HandoffStore;
use main_core::packages::electron_utils::unsaved_files::{
    OpenFileState, OpenFilesHolder, OpenFilesSourceFailed,
};
use main_core::shell::document_links_shell::GenerateWindowRequest;
use main_core::shell::generate::convert::NoticeCache;
use main_core::shell::generate::generate_window::{
    GenerateWindow as WindowModule, WindowId as ModuleWindow, WindowStep,
};
use main_core::shell::generate::open_materials::{OpenDocumentTab, OpenSnapshot};
use main_core::shell::generate::session::{SessionAnswer, SessionNeed};
use main_core::shell::renderer_disposal::Failure;
use serde_json::Value;
use shell_contract::hosts::{DialogsHost, MainWindowHost, OsShellHost};
use shell_contract::ipc::{CallContext, Responder};
use shell_contract::runtime::Services;
use shell_contract::{IpcError, IpcValue, WindowId};

use self::bridge::{Bridge, DialogMode, dialog_result, file_dialog};
use self::host::GenerateShellHost;
use crate::ports::GenerateWindow as GenerateWindowChannels;

/// The state of the port every callback reaches: shared with the window's
/// listeners, which the host calls from any thread (they post to the core
/// thread, where the state is touched)
pub struct Inner {
    shell: GenerateShellHost,
    services: Services,
    dialogs: DialogsHost,
    os_shell: OsShellHost,
    main_window: MainWindowHost,
    /// the module state of generate-window.ts
    window: Mutex<WindowModule>,
    /// the notice cache of `markdownRedactionNotice`
    notices: Mutex<NoticeCache>,
}

/// What the TypeScript listens to on the generate window: the host calls
/// these (from any thread) when the event happens; each runs on the core thread
#[derive(Clone)]
pub struct GenerateWindowEvents {
    inner: Arc<Inner>,
}

impl GenerateWindowEvents {
    pub(crate) fn new(inner: Arc<Inner>) -> Self {
        GenerateWindowEvents { inner }
    }

    fn on_core(&self, job: impl FnOnce(&Arc<Inner>) + Send + 'static) {
        let inner = self.inner.clone();
        self.inner.services.core.post(Box::new(move || job(&inner)));
    }

    /// `next.once('ready-to-show', () => next.show())`
    pub fn ready_to_show(&self, window: WindowId) {
        self.on_core(move |inner| {
            inner.run(|w, b| w.on_ready_to_show(b, module_window(window)));
        });
    }

    /// `next.on('focus', ...)`: coming back from another window is when a
    /// material may have been saved there
    pub fn focus(&self, window: WindowId) {
        self.on_core(move |inner| {
            inner.snapshot(move |inner, snap| {
                inner.run(|w, b| w.on_focus(b, snap, module_window(window)));
            });
        });
    }

    /// `next.on('closed', ...)`
    pub fn closed(&self, window: WindowId) {
        self.on_core(move |inner| {
            inner.run(|w, b| w.on_closed(b, module_window(window)));
        });
    }

    /// `nativeTheme.on('updated', refreshTitleBar)`, while watched
    pub fn theme_updated(&self, window: WindowId) {
        self.on_core(move |inner| {
            inner.run(|w, b| w.on_theme_updated(b, module_window(window)));
        });
    }

    /// `setWindowOpenHandler`: the page asked to open this address
    pub fn open_link(&self, url: String) {
        self.on_core(move |inner| {
            inner.run(|w, b| w.window_open(b, &url));
        });
    }
}

fn module_window(window: WindowId) -> ModuleWindow {
    i64::from(window.0)
}

impl Inner {
    fn window(&self) -> MutexGuard<'_, WindowModule> {
        self.window.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `f` on the module state with the host of a call
    fn run<R>(self: &Arc<Self>, f: impl FnOnce(&mut WindowModule, &mut Bridge<'_>) -> R) -> R {
        self.run_with(DialogMode::Live, f)
    }

    fn run_with<R>(
        self: &Arc<Self>,
        dialog: DialogMode,
        f: impl FnOnce(&mut WindowModule, &mut Bridge<'_>) -> R,
    ) -> R {
        let mut bridge = Bridge::new(self);
        bridge.dialog = dialog;
        let mut window = self.window();
        f(&mut window, &mut bridge)
    }

    /// `deps.list()`, then `then` on the core thread with the open tabs and
    /// the open files (the same list) as the module reads them
    fn snapshot(
        self: &Arc<Self>,
        then: impl FnOnce(&Arc<Inner>, &OpenSnapshot<'_>) + Send + 'static,
    ) {
        let inner = self.clone();
        self.shell.open_documents(Box::new(move |tabs| {
            let core = inner.services.core.clone();
            let job = move || {
                let holder = open_files_of(&tabs);
                then(
                    &inner,
                    &OpenSnapshot {
                        files: &holder,
                        tabs: &tabs,
                    },
                );
            };
            if core.is_current() {
                job()
            } else {
                core.post(Box::new(job))
            }
        }));
    }

    /// `fromWindow(event)`
    fn from_window(self: &Arc<Self>, sender: f64) -> bool {
        self.run(|w, b| w.from_window(&*b, sender))
    }

    /// Carries a step of "save" out: the editor's save command, or the
    /// recheck timer; the answer resumes the module and the next step goes on
    fn carry_save(self: &Arc<Self>, step: WindowStep, reply: Responder) {
        match step {
            WindowStep::Done(result) => reply.reply(unit(result)),
            WindowStep::Need(need, run) => {
                let inner = self.clone();
                let resume = move |answer: SessionAnswer| {
                    inner.snapshot(move |inner, snap| {
                        let step = inner.run(|w, b| w.resume_save(b, snap, run, answer));
                        inner.carry_save(step, reply);
                    });
                };
                match need {
                    SessionNeed::Save(need) => self.shell.save(
                        need,
                        Box::new(move |answer| resume(SessionAnswer::Save(answer))),
                    ),
                    SessionNeed::Sleep(ms) => self
                        .shell
                        .set_timeout(ms, Box::new(move || resume(SessionAnswer::Slept))),
                }
            }
        }
    }

    /// `openGenerateWindowForDocument(request)`
    fn open_for_document(self: &Arc<Self>, request: GenerateWindowRequest<WindowId>) {
        self.snapshot(move |inner, snap| {
            let parent = request.parent.map(module_window);
            let result = inner.run(|w, b| {
                w.open_generate_window_for_document(
                    b,
                    snap,
                    request.web_contents_id,
                    request.file_path.as_deref(),
                    &request.title,
                    parent,
                )
            });
            if let Err(Failure(message)) = result {
                eprintln!("[generate] the make window did not open: {message}");
            }
        });
    }
}

/// The open files the module asks about: the open documents' paths and flags
fn open_files_of(tabs: &[OpenDocumentTab]) -> OpenFilesHolder {
    let files: Vec<OpenFileState> = tabs
        .iter()
        .map(|tab| OpenFileState {
            file_path: tab.file_path.clone(),
            dirty: tab.dirty,
        })
        .collect();
    let mut holder = OpenFilesHolder::new();
    holder.set_open_files_source(Some(Box::new(
        move || -> Result<Vec<OpenFileState>, OpenFilesSourceFailed> { Ok(files.clone()) },
    )));
    holder
}

/// `undefined` when it went well, else a throw
fn unit(result: Result<(), Failure>) -> Result<IpcValue, IpcError> {
    match result {
        Ok(()) => Ok(IpcValue::Undefined),
        Err(Failure(message)) => Err(IpcError {
            name: Some("Error".into()),
            message,
        }),
    }
}

/// An IPC argument as the module takes it (`None` for `undefined`)
fn json_of(value: &IpcValue) -> Option<Value> {
    Some(match value {
        IpcValue::Undefined | IpcValue::Bytes(..) | IpcValue::Date(_) => return None,
        IpcValue::Null => Value::Null,
        IpcValue::Bool(b) => Value::Bool(*b),
        IpcValue::Number(n) => serde_json::Number::from_f64(*n).map_or(Value::Null, Value::Number),
        IpcValue::String(s) => Value::String(s.clone()),
        IpcValue::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| json_of(item).unwrap_or(Value::Null))
                .collect(),
        ),
        IpcValue::Object(entries) => Value::Object(
            entries
                .iter()
                .filter_map(|(k, v)| Some((k.clone(), json_of(v)?)))
                .collect(),
        ),
    })
}

fn jarg(args: &[IpcValue], index: usize) -> Option<Value> {
    args.get(index).and_then(json_of)
}

/// What the module answered, as the renderer receives it
fn ipc_of(value: &Value) -> IpcValue {
    match value {
        Value::Null => IpcValue::Null,
        Value::Bool(b) => IpcValue::Bool(*b),
        Value::Number(n) => IpcValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => IpcValue::String(s.clone()),
        Value::Array(items) => IpcValue::Array(items.iter().map(ipc_of).collect()),
        Value::Object(map) => {
            IpcValue::Object(map.iter().map(|(k, v)| (k.clone(), ipc_of(v))).collect())
        }
    }
}

/// `event.sender.id`
fn sender_of(cx: &CallContext) -> f64 {
    f64::from(cx.sender.view.0)
}

pub struct GenerateWindowPort {
    inner: Arc<Inner>,
    store: Rc<RefCell<HandoffStore>>,
}

impl GenerateWindowPort {
    pub fn new(
        services: &Services,
        shell: GenerateShellHost,
        dialogs: DialogsHost,
        os_shell: OsShellHost,
        main_window: MainWindowHost,
        store: Rc<RefCell<HandoffStore>>,
    ) -> Self {
        let mut module = WindowModule::new();
        // `configureGenerateWindow(...)`: the handlers are the port's, so only the first call's answer is dropped
        let _ = module.configure();
        let ids = shell.clone();
        // `setGenerateTabIdResolver((id) => next.tabIdFor(id))`
        store
            .borrow_mut()
            .set_generate_tab_id_resolver(Some(Box::new(move |id| Ok(ids.tab_id_for(id)))));
        GenerateWindowPort {
            inner: Arc::new(Inner {
                shell,
                services: services.clone(),
                dialogs,
                os_shell,
                main_window,
                window: Mutex::new(module),
                notices: Mutex::new(NoticeCache::new()),
            }),
            store,
        }
    }

    /// The one hand-off store: what "make" queues for the new tab, which its
    /// editor takes once. The shell gives it to the menus and the tab manager.
    pub fn handoff_store(&self) -> Rc<RefCell<HandoffStore>> {
        self.store.clone()
    }

    /// `openGenerateWindowForDocument`: what an editor's File menu calls
    /// ("make another document from this one"). The window opens once the
    /// open tabs are known, so a caller must not hold a borrow of the store
    /// across it.
    pub fn make_window_opener(&self) -> Box<dyn Fn(GenerateWindowRequest<WindowId>)> {
        let inner = self.inner.clone();
        Box::new(move |request| inner.open_for_document(request))
    }

    /// `generate:open-with-paths` and `generate:open-with-group` take the
    /// open tabs first, then the module checks the sender
    fn open_from_home(
        &self,
        cx: &CallContext,
        reply: Responder,
        open: impl FnOnce(
            &mut WindowModule,
            &mut Bridge<'_>,
            &OpenSnapshot<'_>,
            f64,
        ) -> Result<(), Failure>
        + Send
        + 'static,
    ) {
        let sender = sender_of(cx);
        self.inner.snapshot(move |inner, snap| {
            let result = inner.run(|w, b| open(w, b, snap, sender));
            reply.reply(unit(result))
        });
    }
}

impl GenerateWindowChannels for GenerateWindowPort {
    fn generate_add_materials(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let sender = sender_of(cx);
        let inner = self.inner.clone();
        // what the module would ask the picker, without showing it
        let asked = {
            let holder = OpenFilesHolder::new();
            let snap = OpenSnapshot {
                files: &holder,
                tabs: &[],
            };
            let mut bridge = Bridge::new(&inner);
            bridge.dialog = DialogMode::Capture(None);
            let _ = inner
                .window()
                .handle_add_materials(&mut bridge, &snap, sender);
            bridge.dialog
        };
        let DialogMode::Capture(Some((window, options))) = asked else {
            return reply.reply(Ok(IpcValue::Undefined));
        };
        let options = file_dialog(&options);
        let dialogs = inner.dialogs.clone();
        let parent = WindowId(window as u32);
        let core = inner.services.core.clone();
        // the picker waits for the person: not on the core thread
        let workers = inner.services.workers.clone();
        workers.spawn(Box::new(move || {
            let picked = dialogs.open(Some(parent), &options);
            core.post(Box::new(move || {
                let answer = dialog_result(picked);
                inner.snapshot(move |inner, snap| {
                    let result = inner.run_with(DialogMode::Answer(answer), |w, b| {
                        w.handle_add_materials(b, snap, sender)
                    });
                    reply.reply(unit(result))
                });
            }));
        }));
    }

    fn generate_cancel(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let sender = sender_of(cx);
        self.inner.run(|w, b| w.handle_cancel(b, sender));
        reply.reply(Ok(IpcValue::Undefined))
    }

    fn generate_get_state(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let sender = sender_of(cx);
        let state = self.inner.run(|w, b| w.handle_get_state(b, sender));
        reply.reply(Ok(match state {
            Some(state) => serde_json::to_value(&state).map_or(IpcValue::Null, |v| ipc_of(&v)),
            None => IpcValue::Null,
        }))
    }

    fn generate_get_theme(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let sender = sender_of(cx);
        let theme = self.inner.run(|w, b| w.handle_get_theme(&*b, sender));
        reply.reply(Ok(IpcValue::String(theme)))
    }

    fn generate_make(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let sender = sender_of(cx);
        let text = jarg(&args, 0);
        if !self.inner.from_window(sender) {
            return reply.reply(Ok(IpcValue::Bool(false)));
        }
        self.inner.snapshot(move |inner, snap| {
            let made = inner.run(|w, b| w.handle_make(b, snap, sender, text.as_ref()));
            reply.reply(Ok(IpcValue::Bool(made)))
        });
    }

    fn generate_open_with_group(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let group = jarg(&args, 0);
        self.open_from_home(cx, reply, move |w, b, snap, sender| {
            w.handle_open_with_group(b, snap, sender, group.as_ref())
        })
    }

    fn generate_open_with_paths(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let paths = jarg(&args, 0);
        self.open_from_home(cx, reply, move |w, b, snap, sender| {
            w.handle_open_with_paths(b, snap, sender, paths.as_ref())
        })
    }

    fn generate_refresh(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let sender = sender_of(cx);
        if !self.inner.from_window(sender) {
            return reply.reply(Ok(IpcValue::Undefined));
        }
        self.inner.snapshot(move |inner, snap| {
            let result = inner.run(|w, b| w.handle_refresh(b, snap, sender));
            reply.reply(unit(result))
        });
    }

    fn generate_remove_material(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let sender = sender_of(cx);
        let key = jarg(&args, 0);
        self.inner
            .run(|w, b| w.handle_remove_material(b, sender, key.as_ref()));
        reply.reply(Ok(IpcValue::Undefined))
    }

    fn generate_save_material(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let sender = sender_of(cx);
        let key = jarg(&args, 0);
        if !self.inner.from_window(sender) {
            return reply.reply(Ok(IpcValue::Undefined));
        }
        self.inner.snapshot(move |inner, snap| {
            let step = inner.run(|w, b| w.handle_save_material(b, snap, sender, key.as_ref()));
            inner.carry_save(step, reply);
        });
    }

    fn generate_set_convert(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let sender = sender_of(cx);
        let kind = jarg(&args, 0);
        self.inner
            .run(|w, b| w.handle_set_convert(b, sender, kind.as_ref()));
        reply.reply(Ok(IpcValue::Undefined))
    }

    fn generate_set_kind(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let sender = sender_of(cx);
        let kind = jarg(&args, 0);
        self.inner
            .run(|w, b| w.handle_set_kind(b, sender, kind.as_ref()));
        reply.reply(Ok(IpcValue::Undefined))
    }
}

/// The host the shell inserts for this port. Building it takes the shared
/// hand-off store and adds the port to what the batches provide.
pub fn factory() -> crate::Factory<dyn GenerateWindowChannels> {
    crate::Factory::new(|services, provided| {
        let batch = shell_contract::Batch::A;
        let hosts = &services.hosts;
        let port = Rc::new(GenerateWindowPort::new(
            services,
            hosts.need::<GenerateShellHost>(batch)?,
            hosts.need::<DialogsHost>(batch)?,
            hosts.need::<OsShellHost>(batch)?,
            hosts.need::<MainWindowHost>(batch)?,
            crate::user_skills::shared_handoff_store(provided),
        ));
        provided.add::<GenerateWindowPort>(port.clone());
        let port: Rc<dyn GenerateWindowChannels> = port;
        Ok(port)
    })
}
