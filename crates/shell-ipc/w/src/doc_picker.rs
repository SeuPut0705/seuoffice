//! The "Attach from documents" window (`apps/shell/src/main/doc-picker/doc-picker-window.ts`,
//! `createDocPicker`): an editor's AI panel asks the shell for documents it
//! already knows (`doc:pick-attachments`), the person ticks some in the
//! picker window (`doc-picker:*`), and the paths go back as the answer of the
//! first call. One window at a time; closing it cancels. The same list
//! built for the asking editor answers the panel's `@` list (`doc:attach-list`).
//!
//! The window is the shell's ([`DocPickerWindow`]); the documents it lists are
//! the open tabs, detached windows, recent files and project files the shell
//! knows ([`DocPickerSources`]). What decides the list and checks the ids that
//! come back is `main_core::shell::doc_picker`.

#[cfg(feature = "probe")]
mod probe;

use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use main_core::packages::i18n::{Lang, product_name};
use main_core::shell::doc_picker::DocListItem;
use main_core::shell::doc_picker::asker::DocAsker;
use main_core::shell::doc_picker::doc_list::{
    DocListDeps, DocListOptions, doc_list, to_mention_items,
};
use main_core::shell::doc_picker::picker::paths_of;
use shell_contract::hosts::ContentsHost;
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::ipc::{CallContext, ChannelKind, Handler, RegisterError, Registry, Responder};
use shell_contract::runtime::{Services, Workers};
use shell_contract::{Batch, IpcValue};

use crate::handle;

/// What the shell knows that the picker lists: a [`DocListDeps`] and which
/// editor a view is
pub trait DocPickerSources: DocListDeps + Send + Sync {
    /// `deps.askerFor(webContentsId)`
    fn asker_for(&self, view: ViewId) -> DocAsker;
}

pub type DocPickerSourcesHost = Arc<dyn DocPickerSources>;

/// What `new BrowserWindow(...)` of the picker is given (the shell adds the
/// preload and the sandbox)
#[derive(Clone, Debug, PartialEq)]
pub struct DocPickerWindowOptions {
    pub width: u32,
    pub height: u32,
    pub min_width: u32,
    pub min_height: u32,
    /// the window it is modal to
    pub parent: Option<WindowId>,
    pub show: bool,
    pub center: bool,
    pub minimizable: bool,
    pub maximizable: bool,
    pub fullscreenable: bool,
    pub auto_hide_menu_bar: bool,
    pub title: String,
}

/// The picker window (a `BrowserWindow` loading `doc-picker.html`) and the
/// answers the app gives it (`DocPickerDeps.lang`, `.theme`). It reports
/// `ready-to-show` and its end to the control it was given, through
/// [`DocPickerControl::window_ready`] and [`DocPickerControl::window_closed`]
/// (both may be called from any thread, also from inside its own calls).
pub trait DocPickerWindow: Send + Sync {
    /// Given once at start
    fn attach(&self, control: DocPickerControl);
    fn lang(&self) -> Lang;
    /// `light`, `dark` or `system`
    fn theme(&self) -> String;
    /// Creates the window hidden, modal to its parent when given, and loads
    /// the page; its view
    fn create(&self, options: &DocPickerWindowOptions) -> ViewId;
    fn show(&self);
    fn focus(&self);
    /// `win.close()`: the window ends and reports `window_closed`
    fn close(&self);
}

pub type DocPickerWindowHost = Arc<dyn DocPickerWindow>;

#[derive(Default)]
struct State {
    /// the picker window's view; none while there is no window
    view: Option<ViewId>,
    /// the pending `doc:pick-attachments` answer (`settle`)
    settle: Option<Responder>,
    /// the items of the list the window last read; ids are validated against it
    last_items: Option<Vec<DocListItem>>,
    /// the editor that opened the window; its list is built for it while the window is open
    asker: DocAsker,
}

type Report = Box<dyn FnOnce(&Inner) + Send>;

#[derive(Default)]
struct Queue {
    jobs: VecDeque<Report>,
    /// a worker is running the jobs
    running: bool,
}

struct Inner {
    state: Mutex<State>,
    window: DocPickerWindowHost,
    sources: DocPickerSourcesHost,
    workers: Arc<dyn Workers>,
    queue: Mutex<Queue>,
    idle: Condvar,
}

/// The picker window's state. Cheap to clone; the window host reports to it
#[derive(Clone)]
pub struct DocPickerControl(Arc<Inner>);

/// `DocAttachResult` as the renderer receives it
fn picked(paths: Vec<String>) -> IpcValue {
    IpcValue::Object(vec![
        ("ok".into(), IpcValue::Bool(true)),
        (
            "paths".into(),
            IpcValue::Array(paths.into_iter().map(IpcValue::String).collect()),
        ),
    ])
}

fn failed(reason: &str) -> IpcValue {
    IpcValue::Object(vec![
        ("ok".into(), IpcValue::Bool(false)),
        ("reason".into(), IpcValue::String(reason.to_owned())),
    ])
}

/// `{ ok: false, kind: 'unavailable' }`
fn unavailable() -> IpcValue {
    IpcValue::Object(vec![
        ("ok".into(), IpcValue::Bool(false)),
        ("kind".into(), IpcValue::String("unavailable".into())),
    ])
}

fn ok() -> IpcValue {
    IpcValue::Object(vec![("ok".into(), IpcValue::Bool(true))])
}

fn item_ipc(item: &DocListItem) -> IpcValue {
    IpcValue::Object(vec![
        ("id".into(), IpcValue::String(item.id.clone())),
        ("title".into(), IpcValue::String(item.title.clone())),
        ("dir".into(), IpcValue::String(item.dir.clone())),
        (
            "state".into(),
            IpcValue::String(item.state.as_str().to_owned()),
        ),
        (
            "group".into(),
            IpcValue::String(item.group.as_str().to_owned()),
        ),
    ])
}

/// `docPickerText(lang, 'docPickTitle')` (renderer/src/i18n/doc-picker)
fn pick_title(lang: Lang) -> &'static str {
    match lang {
        Lang::En => "Attach from SeuOffice documents",
        Lang::Ko => "SeuOffice 문서에서 첨부",
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("the doc picker state")
    }
}

impl DocPickerControl {
    /// Runs a report of the window host on a worker, after the reports
    /// before it: the host's events are ordered, as the UI thread's were
    fn report(&self, job: impl FnOnce(&Inner) + Send + 'static) {
        let mut queue = self.0.queue.lock().expect("the report queue");
        queue.jobs.push_back(Box::new(job));
        if queue.running {
            return;
        }
        queue.running = true;
        drop(queue);
        let inner = self.0.clone();
        self.0.workers.spawn(Box::new(move || {
            loop {
                let mut queue = inner.queue.lock().expect("the report queue");
                let Some(job) = queue.jobs.pop_front() else {
                    queue.running = false;
                    inner.idle.notify_all();
                    return;
                };
                drop(queue);
                job(&inner);
            }
        }));
    }

    /// Waits until the window host's reports have all run (what a probe
    /// waits for before the first call)
    #[cfg(feature = "probe")]
    pub fn wait_idle(&self) {
        let mut queue = self.0.queue.lock().expect("the report queue");
        while queue.running {
            queue = self.0.idle.wait(queue).expect("the report queue");
        }
    }

    /// `fromWindow(event)`
    fn is_window_view(&self, view: ViewId) -> bool {
        self.0.lock().view == Some(view)
    }

    /// `finish(result)`: takes the pending pick, closes the window, then
    /// answers (a promise's callbacks run after the code that settled it)
    fn finish(&self, result: IpcValue) {
        let mut state = self.0.lock();
        let settle = state.settle.take();
        if state.view.is_some() {
            self.0.window.close();
        }
        drop(state);
        if let Some(settle) = settle {
            settle.reply(Ok(result));
        }
    }

    /// The picker window's page is ready to show (`ready-to-show`)
    pub fn window_ready(&self, view: ViewId) {
        self.report(move |inner| {
            if inner.lock().view == Some(view) {
                inner.window.show();
            }
        });
    }

    /// The picker window ended (`closed`): closing it is cancelling, unless a
    /// result already went out
    pub fn window_closed(&self, view: ViewId) {
        self.report(move |inner| {
            let mut state = inner.lock();
            if state.view == Some(view) {
                state.view = None;
            }
            state.last_items = None;
            state.asker = DocAsker::default();
            if let Some(settle) = state.settle.take() {
                settle.reply(Ok(failed("cancelled")));
            }
        });
    }

    /// `askerOf(event)`
    fn asker_of(&self, view: ViewId) -> DocAsker {
        self.0.sources.asker_for(view)
    }

    /// `open(parent, from)`: asks the person for documents; `reply` is
    /// answered when they attach or close the window
    fn open(&self, parent: Option<WindowId>, from: DocAsker, reply: Responder) {
        let inner = &self.0;
        let mut state = inner.lock();
        if state.view.is_some() {
            // a second asker: the open window stays, keeps the first asker, and comes forward
            inner.window.show();
            inner.window.focus();
            drop(state);
            return reply.reply(Ok(failed("busy")));
        }
        let lang = inner.window.lang();
        let view = inner.window.create(&DocPickerWindowOptions {
            width: 720,
            height: 640,
            min_width: 480,
            min_height: 420,
            parent,
            show: false,
            center: true,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            auto_hide_menu_bar: true,
            title: format!(
                "{} - {}",
                pick_title(lang),
                product_name(Some(lang.as_str()))
            ),
        });
        state.view = Some(view);
        state.last_items = None;
        state.asker = from;
        state.settle = Some(reply);
    }
}

/// `doc:pick-attachments`: answered when the window ends
struct Pick {
    control: DocPickerControl,
    contents: ContentsHost,
}

impl Handler for Pick {
    fn call(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        // a request whose sender is not a window cannot parent a modal picker
        let Some(parent) = self.contents.window_of(cx.sender.view) else {
            return reply.reply(Ok(failed("unavailable")));
        };
        let asker = self.control.asker_of(cx.sender.view);
        self.control.open(Some(parent), asker, reply);
    }
}

pub fn register(registry: &mut dyn Registry, services: &Services) -> Result<(), RegisterError> {
    let window: DocPickerWindowHost = services.hosts.need(Batch::W)?;
    let sources: DocPickerSourcesHost = services.hosts.need(Batch::W)?;
    let contents: ContentsHost = services.hosts.need(Batch::W)?;
    let control = DocPickerControl(Arc::new(Inner {
        state: Mutex::default(),
        window: window.clone(),
        sources: sources.clone(),
        workers: services.workers.clone(),
        queue: Mutex::default(),
        idle: Condvar::new(),
    }));
    window.attach(control.clone());

    let c = control.clone();
    handle(
        registry,
        "doc-picker:get-init",
        ChannelKind::Invoke,
        move |cx, _| {
            if !c.is_window_view(cx.sender.view) {
                return Ok(IpcValue::Null);
            }
            Ok(IpcValue::Object(vec![
                (
                    "lang".into(),
                    IpcValue::String(c.0.window.lang().as_str().to_owned()),
                ),
                ("theme".into(), IpcValue::String(c.0.window.theme())),
            ]))
        },
    )?;

    let c = control.clone();
    handle(
        registry,
        "doc-picker:list",
        ChannelKind::Invoke,
        move |cx, _| {
            if !c.is_window_view(cx.sender.view) {
                return Ok(unavailable());
            }
            let asker = c.0.lock().asker.clone();
            let items = doc_list(c.0.sources.as_ref(), &asker, DocListOptions::default());
            let value = IpcValue::Object(vec![
                ("ok".into(), IpcValue::Bool(true)),
                (
                    "items".into(),
                    IpcValue::Array(items.iter().map(item_ipc).collect()),
                ),
            ]);
            c.0.lock().last_items = Some(items);
            Ok(value)
        },
    )?;

    let c = control.clone();
    handle(
        registry,
        "doc-picker:choose",
        ChannelKind::Invoke,
        move |cx, args| {
            if !c.is_window_view(cx.sender.view) {
                return Ok(unavailable());
            }
            let raw: Option<Vec<Option<&str>>> = match args.first() {
                Some(IpcValue::Array(ids)) => Some(
                    ids.iter()
                        .map(|id| match id {
                            IpcValue::String(id) => Some(id.as_str()),
                            _ => None,
                        })
                        .collect(),
                ),
                _ => None,
            };
            let paths = paths_of(raw.as_deref(), c.0.lock().last_items.as_deref());
            // nothing survived validation: treat it as the person cancelling
            if paths.is_empty() {
                c.finish(failed("cancelled"));
            } else {
                c.finish(picked(paths));
            }
            Ok(ok())
        },
    )?;

    let c = control.clone();
    handle(
        registry,
        "doc-picker:cancel",
        ChannelKind::Invoke,
        move |cx, _| {
            if c.is_window_view(cx.sender.view) {
                c.finish(failed("cancelled"));
            }
            Ok(IpcValue::Undefined)
        },
    )?;

    handle(
        registry,
        "doc:attach-available",
        ChannelKind::Invoke,
        |_, _| Ok(IpcValue::Bool(true)),
    )?;

    registry.register(
        Batch::W,
        "doc:pick-attachments",
        ChannelKind::Invoke,
        Rc::new(Pick {
            control: control.clone(),
            contents,
        }),
    )?;

    let c = control;
    handle(
        registry,
        "doc:attach-list",
        ChannelKind::Invoke,
        move |cx, _| {
            // the `@` list alone shows the files of the asking panel's project (spec 5.13)
            let mut asker = c.asker_of(cx.sender.view);
            asker.web_contents_id = Some(cx.sender.view.0);
            let items = doc_list(
                c.0.sources.as_ref(),
                &asker,
                DocListOptions {
                    project_files: true,
                },
            );
            let items = to_mention_items(&items)
                .into_iter()
                .map(|item| {
                    IpcValue::Object(vec![
                        (
                            "path".into(),
                            item.path.map_or(IpcValue::Null, IpcValue::String),
                        ),
                        ("name".into(), IpcValue::String(item.name)),
                        ("dir".into(), IpcValue::String(item.dir)),
                        (
                            "group".into(),
                            IpcValue::String(item.group.as_str().to_owned()),
                        ),
                        (
                            "state".into(),
                            IpcValue::String(item.state.as_str().to_owned()),
                        ),
                    ])
                })
                .collect();
            Ok(IpcValue::Object(vec![
                ("ok".into(), IpcValue::Bool(true)),
                ("items".into(), IpcValue::Array(items)),
            ]))
        },
    )
}

#[cfg(feature = "probe")]
pub fn probe_hosts(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    probe::insert(hosts, case);
}
