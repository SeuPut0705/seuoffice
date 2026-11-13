//! A shell without Tauri for this crate's tests: the registry checks every
//! registration as the shell's start-up check does, threads and workers run
//! jobs inline, events are recorded, and userData is a fresh folder.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use shell_contract::channels::{Batch, CHANNELS, Surface};
use shell_contract::ipc::{
    CallContext, ChannelKind, EventSink, Handler, RegisterError, Registry, Reply, Responder,
    Sender, Target,
};
use shell_contract::runtime::{
    AppPaths, CancelToken, PathName, Services, Thread, Views, Workers,
};
use shell_contract::hosts::{
    Contents, ContentsHost, Dialogs, DialogsHost, FileDialog, MainWindow,
    MainWindowHost, MessageBox, MessageBoxAnswer, OsShell, OsShellHost,
};
use shell_contract::provided::Provided;
use shell_contract::{Hosts, IpcValue, RequestId, ViewId, WindowId};
use serde_json::Value;

use crate::probe::{self, Fake};

/// The shared hosts (batch W's in the shell), faked from the same config:
/// `savePath` answers a save dialog (null cancels), `contentsPrint`
/// `{ "ok": bool, "error": string }` and `pdf` the sender's own print calls,
/// `mainView` the shell window's view
struct Shared {
    config: Value,
    calls: Arc<Mutex<Vec<String>>>,
}

impl Shared {
    fn log(&self, line: String) {
        self.calls.lock().unwrap().push(line)
    }
}

impl Dialogs for Shared {
    fn open(&self, _parent: Option<WindowId>, _options: &FileDialog) -> Option<Vec<PathBuf>> {
        None
    }

    fn save(&self, _parent: Option<WindowId>, options: &FileDialog) -> Option<PathBuf> {
        self.log(format!(
            "saveDialog {}",
            options
                .default_path
                .as_deref()
                .map(|p| p.display().to_string())
                .unwrap_or_default()
        ));
        self.config
            .get("savePath")
            .and_then(Value::as_str)
            .map(PathBuf::from)
    }

    fn message(&self, _parent: Option<WindowId>, options: &MessageBox) -> MessageBoxAnswer {
        self.log(format!("messageBox {}", options.message));
        MessageBoxAnswer {
            response: 0,
            checkbox_checked: false,
        }
    }

    fn error(&self, title: &str, content: &str) {
        self.log(format!("errorBox {title} {content}"))
    }
}

impl OsShell for Shared {
    fn open_external(&self, url: &str) -> Result<(), String> {
        self.log(format!("openExternal {url}"));
        Ok(())
    }

    fn open_path(&self, path: &Path) -> String {
        self.log(format!("openPath {}", path.display()));
        String::new()
    }

    fn show_item_in_folder(&self, path: &Path) {
        self.log(format!("showItemInFolder {}", path.display()))
    }

    fn trash_item(&self, _path: &Path) -> Result<(), String> {
        Ok(())
    }
}

impl Contents for Shared {
    fn window_of(&self, view: ViewId) -> Option<WindowId> {
        Some(WindowId(view.0))
    }

    fn capture_png(&self, _view: ViewId) -> Result<Vec<u8>, String> {
        Ok(Vec::new())
    }

    fn print_to_pdf(&self, view: ViewId, options: IpcValue) -> Result<Vec<u8>, String> {
        self.log(format!("contentsPrintToPDF {} {options:?}", view.0));
        match self.config.get("pdfError").and_then(Value::as_str) {
            Some(error) => Err(error.to_owned()),
            None => Ok(b"%PDF-fake".to_vec()),
        }
    }

    fn print(&self, view: ViewId, options: IpcValue) -> Result<bool, String> {
        self.log(format!("contentsPrint {} {options:?}", view.0));
        let print = self.config.get("print");
        let success = print
            .and_then(|p| p.get("success"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let reason = print
            .and_then(|p| p.get("failureReason"))
            .and_then(Value::as_str)
            .unwrap_or("");
        match (success, reason) {
            (true, _) => Ok(true),
            (false, "") => Ok(false),
            (false, reason) => Err(reason.to_owned()),
        }
    }

    fn zoom_factor(&self, _view: ViewId) -> f64 {
        1.0
    }

    fn set_zoom_factor(&self, _view: ViewId, _factor: f64) {}

    fn focus(&self, view: ViewId) {
        self.log(format!("focus {}", view.0))
    }

    fn close_window(&self, _window: WindowId) {}
}

impl MainWindow for Shared {
    fn view(&self) -> Option<ViewId> {
        self.config
            .get("mainView")
            .and_then(Value::as_u64)
            .map(|v| ViewId(v as u32))
    }

    fn window(&self) -> Option<WindowId> {
        self.view().map(|v| WindowId(v.0))
    }
}

#[derive(Default)]
pub struct FakeRegistry {
    pub handlers: HashMap<&'static str, (ChannelKind, Rc<dyn Handler>)>,
    pub provided: Rc<Provided>,
}

impl Registry for FakeRegistry {
    fn register(
        &mut self,
        by: Batch,
        channel: &'static str,
        kind: ChannelKind,
        handler: Rc<dyn Handler>,
    ) -> Result<(), RegisterError> {
        let spec = CHANNELS
            .iter()
            .find(|spec| spec.name == channel)
            .ok_or(RegisterError::Unknown(channel))?;
        if spec.batch != by {
            return Err(RegisterError::WrongBatch {
                channel,
                owner: spec.batch,
                by,
            });
        }
        if kind == ChannelKind::Event || !spec.kinds.contains(&kind) {
            return Err(RegisterError::WrongKind { channel, kind });
        }
        if self.handlers.insert(channel, (kind, handler)).is_some() {
            return Err(RegisterError::Twice(channel));
        }
        Ok(())
    }

    fn provided(&self) -> Rc<Provided> {
        self.provided.clone()
    }
}

/// Runs a posted job at once on the calling thread; `is_current` answers
/// as the fake says
struct Inline {
    current: bool,
    queue: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
}

impl Thread for Inline {
    fn post(&self, job: Box<dyn FnOnce() + Send>) {
        if self.current {
            // the core thread: run after the current job, as a queue would
            self.queue.lock().unwrap().push(job);
        } else {
            job()
        }
    }

    fn is_current(&self) -> bool {
        self.current
    }
}

impl Inline {
    fn drain(&self) {
        loop {
            let jobs = std::mem::take(&mut *self.queue.lock().unwrap());
            if jobs.is_empty() {
                return;
            }
            for job in jobs {
                job()
            }
        }
    }
}

struct InlineWorkers;

impl Workers for InlineWorkers {
    fn spawn(&self, job: Box<dyn FnOnce() + Send>) {
        job()
    }
}

#[derive(Default)]
pub struct Recorder(pub Mutex<Vec<(Target, &'static str, Vec<IpcValue>)>>);

impl EventSink for Recorder {
    fn emit(&self, target: Target, channel: &'static str, args: Vec<IpcValue>) {
        self.0.lock().unwrap().push((target, channel, args))
    }
}

struct FakeViews(Vec<Sender>);

impl Views for FakeViews {
    fn sender_of(&self, view: ViewId) -> Option<Sender> {
        self.0.iter().copied().find(|s| s.view == view)
    }

    fn all(&self) -> Vec<Sender> {
        self.0.clone()
    }

    fn on_destroyed(&self, _listener: Box<dyn Fn(ViewId) + Send + Sync>) {}
}

struct Folder(PathBuf);

impl AppPaths for Folder {
    fn path(&self, name: PathName) -> PathBuf {
        let sub = match name {
            PathName::UserData => "userData",
            PathName::Temp => "temp",
            PathName::Home => "home",
            PathName::AppData => "appData",
            PathName::Exe => "exe",
            PathName::Desktop => "desktop",
            PathName::Documents => "documents",
            PathName::Downloads => "downloads",
            PathName::Logs => "logs",
        };
        self.0.join(sub)
    }
}

/// One test's shell with batch M registered
pub struct Probe {
    pub registry: FakeRegistry,
    pub events: Arc<Recorder>,
    pub services: Services,
    /// the M hosts' fake: its `calls`, and the shared hosts' calls too
    pub fake: Arc<Fake>,
    core: Arc<Inline>,
    dir: PathBuf,
}

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// The sender of a call: view `n` in window `n`, of `surface`
pub fn sender(n: u32, surface: Surface) -> Sender {
    Sender {
        view: ViewId(n),
        window: WindowId(n),
        surface,
    }
}

impl Probe {
    /// A shell whose M hosts answer from `config` (the `hosts.m` object of
    /// probe.rs), with these views open, and batch M registered
    pub fn new(config: Value, views: Vec<Sender>) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "shell-ipc-m-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        for sub in ["userData", "temp", "home", "documents"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        let mut hosts = Hosts::default();
        let fake = probe::insert(&mut hosts, &config);
        let shared = Arc::new(Shared {
            config,
            calls: fake.calls.clone(),
        });
        hosts.insert::<DialogsHost>(shared.clone());
        hosts.insert::<OsShellHost>(shared.clone());
        hosts.insert::<ContentsHost>(shared.clone());
        hosts.insert::<MainWindowHost>(shared);
        let core = Arc::new(Inline {
            current: true,
            queue: Mutex::default(),
        });
        let events = Arc::new(Recorder::default());
        let services = Services {
            ui: Arc::new(Inline {
                current: false,
                queue: Mutex::default(),
            }),
            core: core.clone(),
            workers: Arc::new(InlineWorkers),
            events: events.clone(),
            views: Arc::new(FakeViews(views)),
            paths: Arc::new(Folder(dir.clone())),
            hosts: Arc::new(hosts),
        };
        let mut registry = FakeRegistry::default();
        crate::register(&mut registry, &services).expect("batch M registers");
        Probe {
            registry,
            events,
            services,
            fake,
            core,
            dir,
        }
    }

    /// The host calls so far, and forget them
    pub fn take_calls(&self) -> Vec<String> {
        std::mem::take(&mut *self.fake.calls.lock().unwrap())
    }

    pub fn user_data(&self) -> PathBuf {
        self.dir.join("userData")
    }

    pub fn root(&self) -> &Path {
        &self.dir
    }

    /// Calls `channel` as `from` would and returns the answer once every job
    /// the call posted has run. A handler that never answered panics.
    pub fn call(&self, from: Sender, channel: &str, args: Vec<IpcValue>) -> Reply {
        let (_, handler) = self
            .registry
            .handlers
            .get(channel)
            .unwrap_or_else(|| panic!("no handler for {channel}"));
        let cx = CallContext {
            sender: from,
            request: Some(RequestId(1)),
            cancel: CancelToken::default(),
        };
        let slot: Arc<Mutex<Option<Reply>>> = Arc::default();
        let answer = slot.clone();
        handler.call(
            &cx,
            args,
            Responder::new(move |reply| {
                let previous = answer.lock().unwrap().replace(reply);
                assert!(previous.is_none(), "answered twice");
            }),
        );
        self.core.drain();
        let reply = slot.lock().unwrap().take();
        reply.unwrap_or_else(|| panic!("{channel} did not answer"))
    }

    /// The events emitted so far, and forget them
    pub fn take_events(&self) -> Vec<(Target, &'static str, Vec<IpcValue>)> {
        std::mem::take(&mut *self.events.0.lock().unwrap())
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
