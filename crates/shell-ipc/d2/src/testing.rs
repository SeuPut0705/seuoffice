//! A shell for the handlers' unit tests: one core thread (the test's own),
//! workers that run at once and post back, a recorded event stream, scripted
//! shared hosts, and a registry that enforces the contract's rules. Timers run
//! on a fake clock the test advances.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::thread::ThreadId;
use std::time::Duration;

use shell_contract::hosts::{
    Clipboard, ClipboardHost, Contents, ContentsHost, Dialogs, DialogsHost, FileDialog, MainWindow,
    MainWindowHost, MessageBox, MessageBoxAnswer, OsShell, OsShellHost,
};
use shell_contract::ipc::{
    CallContext, ChannelKind, EventSink, Handler, RegisterError, Registry, Reply, Responder,
    Sender, Target,
};
use shell_contract::runtime::{AppPaths, CancelToken, PathName, Services, Thread, Views, Workers};
use shell_contract::{
    Batch, CHANNELS, Hosts, IpcValue, Provided, RequestId, Surface, ViewId, WindowId,
};

use crate::kit::{self, Entry};

type Job = Box<dyn FnOnce() + Send>;

/// The core thread: the test's thread; posted jobs wait for [`Rt::drain`]
struct Core {
    thread: ThreadId,
    queue: Arc<Mutex<VecDeque<Job>>>,
}

impl Thread for Core {
    fn post(&self, job: Job) {
        self.queue.lock().unwrap().push_back(job)
    }
    fn is_current(&self) -> bool {
        std::thread::current().id() == self.thread
    }
}

/// The UI thread: runs a posted job at once (so `run_on` returns)
struct Ui;

impl Thread for Ui {
    fn post(&self, job: Job) {
        job()
    }
    fn is_current(&self) -> bool {
        false
    }
}

struct InlineWorkers;

impl Workers for InlineWorkers {
    fn spawn(&self, job: Job) {
        job()
    }
}

/// One event as the renderer would receive it
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub target: Target,
    pub channel: &'static str,
    pub args: Vec<IpcValue>,
}

#[derive(Default)]
struct Recorder(Mutex<Vec<Event>>);

impl EventSink for Recorder {
    fn emit(&self, target: Target, channel: &'static str, args: Vec<IpcValue>) {
        self.0.lock().unwrap().push(Event {
            target,
            channel,
            args,
        })
    }
}

type Listener = Box<dyn Fn(ViewId) + Send + Sync>;

#[derive(Default)]
struct FakeViews {
    views: Mutex<Vec<Sender>>,
    listeners: Mutex<Vec<Arc<Listener>>>,
}

impl Views for FakeViews {
    fn sender_of(&self, view: ViewId) -> Option<Sender> {
        self.views
            .lock()
            .unwrap()
            .iter()
            .find(|s| s.view == view)
            .copied()
    }
    fn all(&self) -> Vec<Sender> {
        self.views.lock().unwrap().clone()
    }
    fn on_destroyed(&self, listener: Listener) {
        self.listeners.lock().unwrap().push(Arc::new(listener))
    }
}

struct Paths(PathBuf);

impl AppPaths for Paths {
    fn path(&self, name: PathName) -> PathBuf {
        let sub = match name {
            PathName::Home => "home",
            PathName::AppData => "appData",
            PathName::UserData => "userData",
            PathName::Temp => "temp",
            PathName::Exe => "exe",
            PathName::Desktop => "desktop",
            PathName::Documents => "documents",
            PathName::Downloads => "downloads",
            PathName::Logs => "logs",
        };
        self.0.join(sub)
    }
}

/// What the scripted shared hosts were asked
#[derive(Clone, Debug, PartialEq)]
pub enum HostCall {
    Open(Option<WindowId>, FileDialog),
    Save(Option<WindowId>, FileDialog),
    Message(Option<WindowId>, MessageBox),
    ErrorBox(String, String),
    OpenExternal(String),
    OpenPath(PathBuf),
    ShowItemInFolder(PathBuf),
    Trash(PathBuf),
    WriteText(String),
    WriteHtml(String),
    WriteImage(usize),
    Capture(ViewId),
    PrintToPdf(ViewId),
    Print(ViewId),
    SetZoom(ViewId, f64),
    Focus(ViewId),
    CloseWindow(WindowId),
}

/// Answers the shared hosts give, queued by the test, and what they were asked
#[derive(Default)]
pub struct Script {
    pub calls: Vec<HostCall>,
    pub open: VecDeque<Option<Vec<PathBuf>>>,
    pub save: VecDeque<Option<PathBuf>>,
    pub message: VecDeque<usize>,
    pub clipboard_text: String,
    pub clipboard_html: String,
    pub clipboard_png: Vec<u8>,
    pub capture: Option<Vec<u8>>,
    pub pdf: Option<Vec<u8>>,
    pub zoom: HashMap<ViewId, f64>,
    pub main_view: Option<ViewId>,
}

#[derive(Clone, Default)]
pub struct Shared(pub Arc<Mutex<Script>>);

impl Shared {
    fn log(&self, call: HostCall) {
        self.0.lock().unwrap().calls.push(call)
    }
}

impl Dialogs for Shared {
    fn open(&self, parent: Option<WindowId>, options: &FileDialog) -> Option<Vec<PathBuf>> {
        self.log(HostCall::Open(parent, options.clone()));
        self.0.lock().unwrap().open.pop_front().flatten()
    }
    fn save(&self, parent: Option<WindowId>, options: &FileDialog) -> Option<PathBuf> {
        self.log(HostCall::Save(parent, options.clone()));
        self.0.lock().unwrap().save.pop_front().flatten()
    }
    fn message(&self, parent: Option<WindowId>, options: &MessageBox) -> MessageBoxAnswer {
        self.log(HostCall::Message(parent, options.clone()));
        let response = self.0.lock().unwrap().message.pop_front().unwrap_or(0);
        MessageBoxAnswer {
            response,
            checkbox_checked: false,
        }
    }
    fn error(&self, title: &str, content: &str) {
        self.log(HostCall::ErrorBox(title.into(), content.into()))
    }
}

impl OsShell for Shared {
    fn open_external(&self, url: &str) -> Result<(), String> {
        self.log(HostCall::OpenExternal(url.into()));
        Ok(())
    }
    fn open_path(&self, path: &std::path::Path) -> String {
        self.log(HostCall::OpenPath(path.into()));
        String::new()
    }
    fn show_item_in_folder(&self, path: &std::path::Path) {
        self.log(HostCall::ShowItemInFolder(path.into()))
    }
    fn trash_item(&self, path: &std::path::Path) -> Result<(), String> {
        self.log(HostCall::Trash(path.into()));
        Ok(())
    }
}

impl Clipboard for Shared {
    fn read_text(&self) -> String {
        self.0.lock().unwrap().clipboard_text.clone()
    }
    fn write_text(&self, text: &str) {
        self.log(HostCall::WriteText(text.into()));
        self.0.lock().unwrap().clipboard_text = text.into();
    }
    fn read_html(&self) -> String {
        self.0.lock().unwrap().clipboard_html.clone()
    }
    fn write_html(&self, html: &str, _text: Option<&str>) {
        self.log(HostCall::WriteHtml(html.into()));
        self.0.lock().unwrap().clipboard_html = html.into();
    }
    fn read_image_png(&self) -> Vec<u8> {
        self.0.lock().unwrap().clipboard_png.clone()
    }
    fn write_image_png(&self, png: &[u8]) {
        self.log(HostCall::WriteImage(png.len()));
        self.0.lock().unwrap().clipboard_png = png.to_vec();
    }
    fn available_formats(&self) -> Vec<String> {
        Vec::new()
    }
}

impl Contents for Shared {
    fn window_of(&self, view: ViewId) -> Option<WindowId> {
        Some(WindowId(view.0))
    }
    fn capture_png(&self, view: ViewId) -> Result<Vec<u8>, String> {
        self.log(HostCall::Capture(view));
        self.0
            .lock()
            .unwrap()
            .capture
            .clone()
            .ok_or_else(|| "capture failed".into())
    }
    fn print_to_pdf(&self, view: ViewId, _options: IpcValue) -> Result<Vec<u8>, String> {
        self.log(HostCall::PrintToPdf(view));
        self.0
            .lock()
            .unwrap()
            .pdf
            .clone()
            .ok_or_else(|| "printToPDF failed".into())
    }
    fn print(&self, view: ViewId, _options: IpcValue) -> Result<bool, String> {
        self.log(HostCall::Print(view));
        Ok(true)
    }
    fn zoom_factor(&self, view: ViewId) -> f64 {
        *self.0.lock().unwrap().zoom.get(&view).unwrap_or(&1.0)
    }
    fn set_zoom_factor(&self, view: ViewId, factor: f64) {
        self.log(HostCall::SetZoom(view, factor));
        self.0.lock().unwrap().zoom.insert(view, factor);
    }
    fn focus(&self, view: ViewId) {
        self.log(HostCall::Focus(view))
    }
    fn close_window(&self, window: WindowId) {
        self.log(HostCall::CloseWindow(window))
    }
}

impl MainWindow for Shared {
    fn view(&self) -> Option<ViewId> {
        self.0.lock().unwrap().main_view
    }
    fn window(&self) -> Option<WindowId> {
        self.view().map(|v| WindowId(v.0))
    }
}

/// The fake clock: now, and the timers due at each time
type Clock = (Duration, BTreeMap<(Duration, u64), ()>);

thread_local! {
    static CLOCK: RefCell<Clock> = RefCell::new(Default::default());
}

pub(crate) fn schedule(delay: Duration, id: u64) {
    CLOCK.with(|clock| {
        let mut clock = clock.borrow_mut();
        let due = clock.0 + delay;
        clock.1.insert((due, id), ());
    })
}

/// The registry the shell keeps, with the contract's start-up checks
#[derive(Default)]
struct Table {
    handlers: HashMap<&'static str, (ChannelKind, Rc<dyn Handler>)>,
    provided: Rc<Provided>,
}

impl Registry for Table {
    fn register(
        &mut self,
        by: Batch,
        channel: &'static str,
        kind: ChannelKind,
        handler: Rc<dyn Handler>,
    ) -> Result<(), RegisterError> {
        let spec = CHANNELS
            .iter()
            .find(|s| s.name == channel)
            .ok_or(RegisterError::Unknown(channel))?;
        if spec.batch != by {
            return Err(RegisterError::WrongBatch {
                channel,
                owner: spec.batch,
                by,
            });
        }
        if !spec.kinds.contains(&kind) {
            return Err(RegisterError::WrongKind { channel, kind });
        }
        if self.handlers.insert(channel, (kind, handler)).is_some() {
            return Err(RegisterError::Twice(channel));
        }
        Ok(())
    }

    fn provided(&self) -> Rc<Provided> {
        Rc::clone(&self.provided)
    }
}

/// A test's shell
pub struct Rt {
    pub services: Services,
    pub shared: Shared,
    pub dir: PathBuf,
    queue: Arc<Mutex<VecDeque<Job>>>,
    events: Arc<Recorder>,
    views: Arc<FakeViews>,
    table: Table,
    next_request: u64,
}

impl Rt {
    /// A shell with the shared hosts and whatever `hosts` inserts (a module's
    /// fakes); a fresh folder stands for every `app.getPath` root
    pub fn new(hosts: impl FnOnce(&mut Hosts)) -> Self {
        let shared = Shared::default();
        let mut map = Hosts::default();
        map.insert::<DialogsHost>(Arc::new(shared.clone()));
        map.insert::<OsShellHost>(Arc::new(shared.clone()));
        map.insert::<ClipboardHost>(Arc::new(shared.clone()));
        map.insert::<ContentsHost>(Arc::new(shared.clone()));
        map.insert::<MainWindowHost>(Arc::new(shared.clone()));
        hosts(&mut map);
        let dir = std::env::temp_dir().join(format!(
            "shell-ipc-d2-{}-{}",
            std::process::id(),
            kit::unique()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let queue: Arc<Mutex<VecDeque<Job>>> = Arc::default();
        let events: Arc<Recorder> = Arc::default();
        let views: Arc<FakeViews> = Arc::default();
        let services = Services {
            ui: Arc::new(Ui),
            core: Arc::new(Core {
                thread: std::thread::current().id(),
                queue: Arc::clone(&queue),
            }),
            workers: Arc::new(InlineWorkers),
            events: events.clone(),
            views: views.clone(),
            paths: Arc::new(Paths(dir.clone())),
            hosts: Arc::new(map),
        };
        Rt {
            services,
            shared,
            dir,
            queue,
            events,
            views,
            table: Table::default(),
            next_request: 0,
        }
    }

    /// Registers what a module's `entries` gives, as `register` does
    pub fn register(
        &mut self,
        entries: fn(&Services, &Rc<Provided>) -> Result<Vec<Entry>, RegisterError>,
    ) -> Result<(), RegisterError> {
        let provided = self.table.provided();
        for e in entries(&self.services, &provided)? {
            self.table
                .register(Batch::D2, e.channel, e.kind, e.handler)?;
        }
        Ok(())
    }

    pub fn registered(&self) -> Vec<(&'static str, ChannelKind)> {
        self.table
            .handlers
            .iter()
            .map(|(c, (k, _))| (*c, *k))
            .collect()
    }

    /// What the batches provided while registering
    pub fn provided(&self) -> Rc<Provided> {
        self.table.provided()
    }

    /// Adds a view (its window has the same number)
    pub fn view(&self, id: u32, surface: Surface) -> Sender {
        let sender = Sender {
            view: ViewId(id),
            window: WindowId(id),
            surface,
        };
        self.views.views.lock().unwrap().push(sender);
        sender
    }

    /// Destroys a view: its listeners run on the core thread
    pub fn destroy(&mut self, view: ViewId) {
        self.views.views.lock().unwrap().retain(|s| s.view != view);
        let listeners: Vec<_> = self.views.listeners.lock().unwrap().clone();
        for l in listeners {
            l(view)
        }
        self.drain();
    }

    /// Runs what was posted to the core thread, until nothing is
    pub fn drain(&mut self) {
        loop {
            let job = self.queue.lock().unwrap().pop_front();
            match job {
                Some(job) => job(),
                None => break,
            }
        }
    }

    /// Moves the fake clock on, firing the timers that come due, in order
    pub fn advance(&mut self, by: Duration) {
        let end = CLOCK.with(|c| c.borrow().0) + by;
        loop {
            let next = CLOCK.with(|c| {
                let mut c = c.borrow_mut();
                let first = c.1.keys().next().copied();
                match first {
                    Some((due, id)) if due <= end => {
                        c.1.remove(&(due, id));
                        c.0 = due;
                        Some(id)
                    }
                    _ => None,
                }
            });
            match next {
                Some(id) => {
                    kit::fire_timer(id);
                    self.drain();
                }
                None => break,
            }
        }
        CLOCK.with(|c| c.borrow_mut().0 = end);
    }

    fn call(
        &mut self,
        kind: ChannelKind,
        channel: &str,
        from: Sender,
        args: Vec<IpcValue>,
    ) -> Pending {
        let (registered, handler) = self
            .table
            .handlers
            .get(channel)
            .map(|(k, h)| (*k, Rc::clone(h)))
            .unwrap_or_else(|| panic!("no handler for {channel}"));
        assert_eq!(registered, kind, "{channel} is not registered as {kind:?}");
        let request = (kind == ChannelKind::Invoke).then(|| {
            self.next_request += 1;
            RequestId(self.next_request)
        });
        let cx = CallContext {
            sender: from,
            request,
            cancel: CancelToken::default(),
        };
        let slot: Arc<Mutex<Option<Reply>>> = Arc::default();
        let answer = Arc::clone(&slot);
        handler.call(
            &cx,
            args,
            Responder::new(move |reply| *answer.lock().unwrap() = Some(reply)),
        );
        self.drain();
        Pending(slot)
    }

    /// `ipcRenderer.invoke`; the reply may come later (see [`Pending`])
    pub fn invoke(&mut self, channel: &str, from: Sender, args: Vec<IpcValue>) -> Pending {
        self.call(ChannelKind::Invoke, channel, from, args)
    }

    /// `ipcRenderer.invoke` that must answer before the test goes on
    pub fn invoke_now(&mut self, channel: &str, from: Sender, args: Vec<IpcValue>) -> Reply {
        self.invoke(channel, from, args)
            .take()
            .unwrap_or_else(|| panic!("{channel} did not answer"))
    }

    /// `ipcRenderer.send`; panics when the listener threw
    pub fn send(&mut self, channel: &str, from: Sender, args: Vec<IpcValue>) {
        if let Some(Err(e)) = self.call(ChannelKind::Send, channel, from, args).take() {
            panic!("{channel} threw {e}")
        }
    }

    /// The events emitted since the last call
    pub fn events(&self) -> Vec<Event> {
        std::mem::take(&mut *self.events.0.lock().unwrap())
    }

    pub fn script(&self) -> std::sync::MutexGuard<'_, Script> {
        self.shared.0.lock().unwrap()
    }
}

impl Drop for Rt {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// An invoke's reply slot
pub struct Pending(Arc<Mutex<Option<Reply>>>);

impl Pending {
    /// the reply, once the handler answered
    pub fn take(&self) -> Option<Reply> {
        self.0.lock().unwrap().take()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use shell_contract::{Surface, ViewId};

    use super::Rt;
    use crate::kit::{ViewMap, after, clear};

    #[test]
    fn view_state_goes_with_its_view() {
        let mut rt = Rt::new(|_| {});
        let map: ViewMap<u32> = ViewMap::new(&rt.services);
        let a = rt.view(1, Surface::Docs);
        let b = rt.view(2, Surface::Docs);
        map.insert(a.view, 10);
        map.insert(b.view, 20);
        rt.destroy(ViewId(1));
        assert_eq!(map.get(ViewId(1)), None);
        assert_eq!(map.get(ViewId(2)), Some(20));
    }

    #[test]
    fn timers_fire_in_order_unless_cleared() {
        let mut rt = Rt::new(|_| {});
        let log = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let (l1, l2, l3) = (log.clone(), log.clone(), log.clone());
        after(&rt.services, Duration::from_millis(30), move || {
            l1.borrow_mut().push(30)
        });
        after(&rt.services, Duration::from_millis(10), move || {
            l2.borrow_mut().push(10)
        });
        let t = after(&rt.services, Duration::from_millis(20), move || {
            l3.borrow_mut().push(20)
        });
        clear(t);
        rt.advance(Duration::from_millis(15));
        assert_eq!(*log.borrow(), vec![10]);
        rt.advance(Duration::from_millis(15));
        assert_eq!(*log.borrow(), vec![10, 30]);
    }
}
