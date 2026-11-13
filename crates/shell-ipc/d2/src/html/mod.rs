//! The HTML editor (`apps/html/src/main/html-main.ts`, `seed-main.ts`, `generate-handoff-ipc.ts`).
//!
//! The document state and the flows other areas call live in
//! [`text_doc::TextDocs`] (the Markdown editor keeps the same shape); this
//! module adds the HTML editor's own state (the preview text, the present
//! views, the seed and the chat attachments) and its save and export
//! handlers ([`save`], [`attach`]). What is not in Rust sits behind
//! [`HtmlEngine`] (html2docx, odt-engine, file-parse, the hidden print window,
//! the network) and [`HtmlShell`] (the shell's hooks).

mod attach;
pub(crate) mod odt_export;
pub(crate) mod save;
#[cfg(test)]
mod tests;
pub(crate) mod text_doc;

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use main_core::html::asset_lifecycle::{discard_pending_owned_assets, rename_owned_asset_document};
use main_core::html::preview_document::preview_url_for;
use main_core::packages::electron_utils::safe_remote_url::{Fetcher, Resolver};
use shell_contract::hosts::{ContentsHost, OsShellHost};
use shell_contract::ipc::RegisterError;
use shell_contract::runtime::Services;
use shell_contract::{Batch, DocumentEditors, IpcValue, Provided, ViewId, WindowId};

use crate::kit::{self, Entry, IntoIpc, Timer, ViewMap, obj};
use odt_export::OdtConversion;
use text_doc::{DocChannels, DocHooks, TextDocs, text_document_editors};

/// `parseFileToText(path)`'s answer, the fields the handlers read
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParsedFile {
    pub ok: bool,
    /// `'text'` or `'image'`
    pub kind: Option<String>,
    pub text: Option<String>,
    pub damaged: bool,
    pub error: Option<String>,
}

/// What the HTML handlers call that is not in Rust. Every method may run on
/// a worker.
pub trait HtmlEngine: Send + Sync {
    /// `renderPrintPdf`'s window: a hidden `BrowserWindow({ show: false,
    /// webPreferences: { sandbox: true, javascript: false } })` that loads
    /// `html_file` and answers `printToPDF({ pageSize: 'A4', printBackground:
    /// true, margins: 0.6in on every side })`
    fn print_pdf(&self, html_file: &Path) -> Result<Vec<u8>, String>;
    /// `convertHtmlToDocx({ url: pathToFileURL(html_file) }, driver)` over an
    /// `ElectronBrowserDriver` at `HTML2DOCX_VIEWPORT` (packages/html2docx);
    /// the host closes its hidden window, and destroys it when the handler's
    /// 180 s watchdog has given up
    fn html_to_docx(&self, html_file: &Path) -> Result<Vec<u8>, String>;
    /// `docxToOdt(docx)` (packages/odt-engine)
    fn docx_to_odt(&self, docx: Vec<u8>) -> Result<OdtConversion, String>;
    /// `parseFileToText(path)` (packages/file-parse)
    fn parse_file_to_text(&self, path: &Path) -> ParsedFile;
    /// `diagramPictureExtOf(path)` (packages/file-parse, drawio-model)
    fn diagram_picture_ext_of(&self, path: &Path) -> Option<String>;
    /// the DNS lookups `fetchImageBytes` makes (Node's `dns.lookup`)
    fn resolver(&self) -> Box<dyn Resolver + Send>;
    /// the HTTP client `fetchImageBytes` uses (Node's `fetch`/undici)
    fn fetcher(&self) -> Box<dyn Fetcher + Send>;
}

pub type HtmlEngineHost = Arc<dyn HtmlEngine>;

/// A generate hand-off the shell queued for a new tab (`HtmlGenerateHandoff`)
#[derive(Clone, Debug, PartialEq)]
pub struct Handoff {
    pub id: String,
    pub text: String,
    /// `(path, name)` of each material
    pub materials: Vec<(String, String)>,
}

/// The shell's side of the HTML editor: its hooks and process state. Called
/// on the core thread.
pub trait HtmlShell: Send + Sync {
    /// `isHeadlessMode()`
    fn is_headless(&self) -> bool;
    /// `getUiLang()`
    fn ui_lang(&self) -> String;
    /// `Date.now()` (recovery copies, pasted picture names)
    fn now_ms(&self) -> f64;
    /// `contents.reload()` (recovery's open decisions)
    fn reload(&self, view: ViewId);
    /// `isPathOpenElsewhere(path)`: the split-pane probe
    fn is_path_open_elsewhere(&self, path: &str) -> bool;
    /// `assertFileSaved(path)`: `Err` is the message it throws
    fn assert_file_saved(&self, path: &str) -> Result<(), String>;
    /// `runtime.openGeneratedPath(path)`: true when a tab opened it
    fn open_generated_path(&self, path: &Path) -> bool;
    /// `runtime.newDocumentDir(webContentsId)`
    fn new_document_dir(&self, view: ViewId) -> Option<PathBuf>;
    /// `runtime.writeNewDocument(webContentsId, fileName, bytes)`
    fn write_new_document(&self, view: ViewId, file_name: &str, bytes: &[u8]) -> Option<PathBuf>;
    /// `fileSavedHook(contents, path)`
    fn file_saved(&self, view: ViewId, path: &Path);
    /// `provisionalTitleHook(contents, title)`
    fn provisional_title(&self, view: ViewId, title: &str);
    /// `docxExportedHook(path)`: false when no hook is set (the file is then revealed)
    fn docx_exported(&self, path: &Path) -> bool;
    /// `docxExportPrepareHook(path)`: `then(true)` when no hook is set
    fn docx_export_prepare(&self, path: &Path, then: Box<dyn FnOnce(bool)>);
    /// `takeGenerateHandoff('html', webContentsId)`
    fn take_generate_handoff(&self, view: ViewId) -> Option<Handoff>;
    /// `reportGenerateRunStarted('html', webContentsId, paths) !== null`
    fn report_generate_run_started(&self, view: ViewId, paths: &[String]) -> bool;
    /// `presentHooks.openTab(owner, title)`: false opens a window instead
    fn present_open_tab(&self, owner: ViewId, title: &str) -> bool;
    /// `presentHooks.hostWindow(contents)`
    fn present_host_window(&self, view: ViewId) -> Option<WindowId>;
    /// `presentHooks.setBleed(contents, on)`
    fn present_set_bleed(&self, view: ViewId, on: bool);
    /// macOS: `setFullScreenable(false)` and `setSimpleFullScreen(true)`
    /// unless the window is already full screen; nothing elsewhere
    fn present_enter_full_screen(&self, window: WindowId);
    /// macOS: leave simple full screen, `setFullScreenable(true)`
    fn present_leave_full_screen(&self, window: WindowId);
    /// `win.isDestroyed()`
    fn is_window_destroyed(&self, window: WindowId) -> bool;
    /// A present window: `new BrowserWindow` with the editor's preload, the
    /// size of `parent`'s content bounds (1200×850 without one), the external
    /// link opener, loading the renderer with `?present=<owner>&title=<title>`.
    /// The new window's view.
    fn open_present_window(
        &self,
        owner: ViewId,
        title: &str,
        parent: Option<WindowId>,
    ) -> Option<ViewId>;
    /// `closePresentViewsOf`'s close: `presentHooks.closeTab`, else the
    /// view's window, else the view itself
    fn close_present_view(&self, view: ViewId);
}

pub type HtmlShellHost = Arc<dyn HtmlShell>;

/// The HTML editor's own module state besides the documents
#[derive(Default)]
struct HtmlState {
    /// present views → the editing view whose preview they show
    present_owner: HashMap<ViewId, ViewId>,
    /// `presentFsRelease`
    present_fs_release: Option<Timer>,
}

/// The HTML editor: its documents and the calls other areas make into it.
/// The calls both text editors share (view set-up, recovery contract) come
/// from [`text_document_editors!`].
pub struct HtmlEditors {
    docs: Rc<TextDocs>,
    state: Rc<RefCell<HtmlState>>,
    seeds: ViewMap<String>,
    previews: ViewMap<String>,
    shell: HtmlShellHost,
}

text_document_editors!(HtmlEditors);

impl HtmlEditors {
    /// `queueHtmlSeedFor(contents, text)`: text a new untitled tab starts with
    pub fn queue_seed(&self, view: ViewId, text: &str) {
        if !self.docs.is_destroyed(view) {
            self.seeds.insert(view, text.to_owned());
        }
    }

    /// The preview protocol (`html-preview://`) reads what the renderer
    /// pushed last, with the document's base
    pub fn preview_text(&self, view: ViewId) -> Option<String> {
        self.previews.get(view)
    }

    /// `exportHtmlHeadless(input, outPath, format, timeoutMs)` on the hidden
    /// view the shell made for it
    pub fn export_headless(
        &self,
        view: ViewId,
        input: &str,
        out_path: &str,
        format: &str,
        timeout: Duration,
        then: Box<dyn FnOnce(Result<(), String>)>,
    ) {
        self.docs.headless_export(
            view,
            input,
            obj([
                ("outPath", out_path.into_ipc()),
                ("format", format.into_ipc()),
            ]),
            timeout,
            then,
        )
    }
}

/// The channels of the HTML editor that the document state serves
const CHANNELS: DocChannels = DocChannels {
    app: "html",
    untitled_ext: ".html",
    read_file: "html:read-file",
    dirty_changed: "html:dirty-changed",
    close_save_result: "html:close-save-result",
    close_save_request: "html:close-save-request",
    save_request: "html:save-request",
    save_request_ack: "html:save-request-ack",
    read_text_request: "html:read-text-request",
    read_text_result: "html:read-text-result",
    file_renamed: "html:file-renamed",
    export_request: "html:export-request",
    recovery_flush_request: "html:recovery-flush-request",
    recovery_open: "html:recovery-open",
    recovery_write: "html:recovery-write",
    consume_headless_export: "html:consume-headless-export",
    headless_export_done: "html:headless-export-done",
};

/// how long the present window waits before it leaves full screen
const PRESENT_FS_RELEASE: Duration = Duration::from_millis(150);
/// the second focus after the snap to full screen
const PRESENT_REFOCUS: Duration = Duration::from_millis(50);

pub(crate) fn entries(
    services: &Services,
    provided: &Rc<Provided>,
) -> Result<Vec<Entry>, RegisterError> {
    let shell = services.hosts.need::<HtmlShellHost>(Batch::D2)?;
    let engine = services.hosts.need::<HtmlEngineHost>(Batch::D2)?;
    let os = services.hosts.need::<OsShellHost>(Batch::D2)?;
    let contents = services.hosts.need::<ContentsHost>(Batch::D2)?;
    let state: Rc<RefCell<HtmlState>> = Rc::default();
    let (s1, s2, s3, s4, s5, s6) = (
        shell.clone(),
        shell.clone(),
        shell.clone(),
        shell.clone(),
        Rc::clone(&state),
        shell.clone(),
    );
    let docs = TextDocs::new(
        services,
        CHANNELS,
        DocHooks {
            lang: Box::new(move || s1.ui_lang()),
            is_headless: Box::new(move || s2.is_headless()),
            reload: Box::new(move |v| s3.reload(v)),
            now_ms: Box::new(move || s6.now_ms()),
            open_elsewhere: Box::new(move |p| s4.is_path_open_elsewhere(p)),
            discard_pending_assets: |path| discard_pending_owned_assets(path).errors,
            rename_assets: |old, new| rename_owned_asset_document(old, new).map_err(|e| e.message),
            presenting: Box::new(move |v| s5.borrow().present_owner.contains_key(&v)),
        },
        ("Untitled", "제목 없음"),
    )?;
    let editors = Rc::new(HtmlEditors {
        docs: Rc::clone(&docs),
        state: Rc::clone(&state),
        seeds: ViewMap::new(services),
        previews: ViewMap::new(services),
        shell: shell.clone(),
    });
    // the owner view is gone, so is its preview: close every present view
    // showing it; a present view that ends drops its own entry
    {
        let (state, shell) = (Rc::clone(&state), shell.clone());
        let docs_weak = Rc::downgrade(&docs);
        docs.on_destroyed(move |view| {
            let shown: Vec<ViewId> = {
                let mut st = state.borrow_mut();
                st.present_owner.remove(&view);
                let shown: Vec<ViewId> = st
                    .present_owner
                    .iter()
                    .filter(|(_, owner)| **owner == view)
                    .map(|(id, _)| *id)
                    .collect();
                for id in &shown {
                    st.present_owner.remove(id);
                }
                shown
            };
            for id in shown {
                if docs_weak.upgrade().is_some_and(|d| !d.is_destroyed(id)) {
                    shell.close_present_view(id)
                }
            }
        });
    }
    provided.add::<dyn DocumentEditors>(editors.clone());
    // the app's own calls (seed, headless export, view tracking) for the shell
    provided.add::<HtmlEditors>(editors.clone());

    let mut out = docs.entries();
    let e = Rc::clone(&editors);
    out.push(kit::invoke("html:consume-pending", move |cx, _| {
        Ok(e.docs.open_path(cx.sender.view).into_ipc())
    }));
    // a view opened on a file never takes a seed or a hand-off
    let e = Rc::clone(&editors);
    out.push(kit::invoke("html:seed-take", move |cx, _| {
        let view = cx.sender.view;
        if e.docs.open_path(view).is_some() {
            return Ok(IpcValue::Null);
        }
        Ok(e.seeds.remove(view).into_ipc())
    }));
    let e = Rc::clone(&editors);
    out.push(kit::invoke("html:handoff-take", move |cx, _| {
        let view = cx.sender.view;
        if e.docs.open_path(view).is_some() {
            return Ok(IpcValue::Null);
        }
        Ok(match e.shell.take_generate_handoff(view) {
            None => IpcValue::Null,
            Some(h) => obj([
                ("id", h.id.into_ipc()),
                ("text", h.text.into_ipc()),
                (
                    "materials",
                    IpcValue::Array(
                        h.materials
                            .into_iter()
                            .map(|(path, name)| {
                                obj([("path", path.into_ipc()), ("name", name.into_ipc())])
                            })
                            .collect(),
                    ),
                ),
            ]),
        })
    }));
    let e = Rc::clone(&editors);
    out.push(kit::invoke("html:handoff-run-started", move |cx, args| {
        let IpcValue::Array(items) = args.get(0) else {
            return Ok(false.into_ipc());
        };
        let paths: Vec<String> = items
            .iter()
            .filter_map(|p| kit::as_str(p).map(str::to_owned))
            .collect();
        Ok(e.shell
            .report_generate_run_started(cx.sender.view, &paths)
            .into_ipc())
    }));
    let e = Rc::clone(&editors);
    out.push(kit::send("html:preview-update", move |cx, args| {
        if let Some(text) = args.str(0) {
            e.previews.insert(cx.sender.view, text.to_owned());
        }
        Ok(())
    }));
    let e = Rc::clone(&editors);
    out.push(kit::invoke("html:preview-info", move |cx, _| {
        let view = cx.sender.view;
        let shown = e
            .state
            .borrow()
            .present_owner
            .get(&view)
            .copied()
            .unwrap_or(view);
        Ok(obj([(
            "url",
            preview_url_for(f64::from(shown.0)).into_ipc(),
        )]))
    }));
    out.push(present_full_screen(services, &editors, contents.clone()));
    let e = Rc::clone(&editors);
    let c = contents.clone();
    out.push(kit::invoke("html:present-new-tab", move |cx, args| {
        let owner = cx.sender.view;
        let label = args.str(0).unwrap_or("").to_owned();
        if e.shell.present_open_tab(owner, &label) {
            return Ok(true.into_ipc());
        }
        let parent = c
            .window_of(owner)
            .or_else(|| e.shell.present_host_window(owner))
            .filter(|w| !e.shell.is_window_destroyed(*w));
        if let Some(view) = e.shell.open_present_window(owner, &label, parent) {
            e.state.borrow_mut().present_owner.insert(view, owner);
        }
        Ok(true.into_ipc())
    }));
    let e = Rc::clone(&editors);
    out.push(kit::send("html:provisional-title", move |cx, args| {
        let view = cx.sender.view;
        let Some(title) = args.str(0) else {
            return Ok(());
        };
        if e.docs.save_path(view).is_some() {
            return Ok(());
        }
        let clean = collapse_title(title);
        if !clean.is_empty() {
            e.docs.recovery().set_title(view, &clean);
            e.shell.provisional_title(view, &clean);
        }
        Ok(())
    }));
    out.extend(save::entries(
        services,
        &editors,
        engine.clone(),
        os.clone(),
    )?);
    out.extend(attach::entries(services, &editors, engine));
    Ok(out)
}

/// `title.replace(/\s+/g, ' ').trim().slice(0, 80)`
fn collapse_title(title: &str) -> String {
    let collapsed = title
        .split(jscompat::is_js_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    jscompat::slice_utf16(&collapsed, 0.0, Some(80.0))
}

/// `html:present-fullscreen`: the renderer asks for the screen in one call so
/// the macOS snap skips the Space animation
fn present_full_screen(
    services: &Services,
    editors: &Rc<HtmlEditors>,
    contents: ContentsHost,
) -> Entry {
    let e = Rc::clone(editors);
    let services = services.clone();
    kit::invoke("html:present-fullscreen", move |cx, args| {
        let view = cx.sender.view;
        let Some(win) = contents
            .window_of(view)
            .or_else(|| e.shell.present_host_window(view))
            .filter(|w| !e.shell.is_window_destroyed(*w))
        else {
            return Ok(IpcValue::Undefined);
        };
        if let Some(timer) = e.state.borrow_mut().present_fs_release.take() {
            kit::clear(timer);
        }
        if args.bool(0) == Some(true) {
            e.shell.present_set_bleed(view, true);
            e.shell.present_enter_full_screen(win);
            // the snap can hand the first responder to the shell chrome; Esc
            // must keep landing in the tab
            contents.focus(view);
            let (c, d) = (contents.clone(), Rc::downgrade(&e.docs));
            kit::after(&services, PRESENT_REFOCUS, move || {
                if d.upgrade().is_some_and(|d| !d.is_destroyed(view)) {
                    c.focus(view)
                }
            });
            return Ok(IpcValue::Undefined);
        }
        let weak = Rc::downgrade(&e);
        let timer = kit::after(&services, PRESENT_FS_RELEASE, move || {
            let Some(e) = weak.upgrade() else { return };
            e.state.borrow_mut().present_fs_release = None;
            if !e.docs.is_destroyed(view) {
                e.shell.present_set_bleed(view, false);
            }
            if !e.shell.is_window_destroyed(win) {
                e.shell.present_leave_full_screen(win);
            }
        });
        e.state.borrow_mut().present_fs_release = Some(timer);
        Ok(IpcValue::Undefined)
    })
}

/// This app's host fakes, answering from `case` (`hosts.d2.html`): see [`fake::FakeHtml`]
#[cfg(any(test, feature = "probe"))]
pub(crate) fn fakes(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    let probe = hosts.get::<fake::ProbeLog>().cloned();
    let fake = Arc::new(fake::FakeHtml::new(case, probe));
    hosts.insert::<HtmlEngineHost>(fake.clone());
    hosts.insert::<HtmlShellHost>(fake.clone());
    hosts.insert::<Arc<fake::FakeHtml>>(fake);
}

#[cfg(any(test, feature = "probe"))]
pub(crate) mod fake;

/// tools/ipc-diff's `trigger` steps for this editor (`d2/html:<what>`):
/// the shell's and the other areas' calls into it. The TypeScript side of
/// groups/d2/html.ts maps the same names to `html-main.ts`'s exports. False
/// for a name this editor does not know (`then` is dropped).
#[cfg(any(test, feature = "probe"))]
pub(crate) fn probe_trigger(
    what: &str,
    view: ViewId,
    args: &serde_json::Value,
    _services: &Services,
    provided: &Rc<Provided>,
    then: shell_contract::editors::Then<IpcValue>,
) -> bool {
    let Some(editors) = provided.all::<HtmlEditors>().into_iter().next() else {
        return false;
    };
    text_doc::probe_trigger_begun(what, view, args, then, |what, then| {
        run_trigger(&editors, what, view, args, then)
    })
}

#[cfg(any(test, feature = "probe"))]
fn run_trigger(
    editors: &HtmlEditors,
    what: &str,
    view: ViewId,
    args: &serde_json::Value,
    then: shell_contract::editors::Then<IpcValue>,
) -> bool {
    let arg = |i: usize| args.get(i).and_then(serde_json::Value::as_str);
    match what {
        // `queueHtmlSeedFor(contents, text)`
        "queue-seed" => {
            editors.queue_seed(view, arg(0).unwrap_or_default());
            then(Ok(IpcValue::Undefined))
        }
        // `exportHtmlHeadless(input, outPath, format, timeoutMs)`
        "export-headless" => {
            let timeout = args
                .get(3)
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(180_000);
            editors.export_headless(
                view,
                arg(0).unwrap_or_default(),
                arg(1).unwrap_or_default(),
                arg(2).unwrap_or("pdf"),
                Duration::from_millis(timeout),
                Box::new(|r| then(r.map(|()| IpcValue::Undefined).map_err(kit::error))),
            )
        }
        _ => return text_doc::probe_trigger(&editors.docs, what, view, args, then),
    }
    true
}
