//! The Markdown editor (`apps/markdown/src/main/markdown-main.ts`, `seed-main.ts`, `note-append.ts`).
//!
//! The document state and the flows other areas call are the HTML editor's
//! [`TextDocs`] (the two apps keep the same shape); this module adds the
//! Markdown editor's own state: the wiki (index, fragments), the seed, the
//! note appends, and its save, image and export handlers ([`save`]). What is
//! not in Rust sits behind [`MarkdownEngine`] (odt-engine, the hidden print
//! window, the network) and [`MarkdownShell`] (the shell's hooks).

#[cfg(any(test, feature = "probe"))]
mod fake;
mod save;
#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jscompat::node_path::host::{dirname, resolve};
use jscompat::serde::Serialize;
use main_core::markdown::asset_lifecycle::{
    discard_pending_owned_assets, rename_owned_asset_document,
};
use main_core::markdown::image_host::{FetchFailure, FetchInit, FetchResponse};
use main_core::markdown::wiki_create::{CreateNoteOptions, create_wiki_note};
use main_core::markdown::wiki_fragment::WikiFragments;
use main_core::markdown::wiki_heads::wiki_heads;
use main_core::markdown::wiki_index::{WikiIndex, node_vault_fs};
use main_core::markdown::wiki_notes::list_wiki_notes;
use main_core::markdown::wiki_resolve::{ResolveOptions, node_fs, resolve_wiki_links};
use main_core::packages::electron_utils::print_html_pdf::PrintWindow;
use main_core::packages::electron_utils::safe_remote_url::{Fetcher, Resolver, Response};
use shell_contract::hosts::OsShellHost;
use shell_contract::ipc::{RegisterError, Target};
use shell_contract::runtime::Services;
use shell_contract::{Batch, DocumentEditors, IpcValue, Provided, ViewId};

use crate::html::odt_export::OdtConversion;
use crate::html::text_doc::{DocChannels, DocHooks, TextDocs, text_document_editors};
use crate::kit::{self, Entry, IntoIpc, ViewMap, field, obj};
use crate::text_recovery::ui::now_ms;

/// What the Markdown handlers call that is not in Rust. Every method may run
/// on a worker.
pub trait MarkdownEngine: Send + Sync {
    /// `printMarkdownPdf`'s hidden window: `new BrowserWindow({ show: false,
    /// webPreferences: { sandbox: true, javascript: false } })`
    fn print_window(&self) -> Box<dyn PrintWindow + Send>;
    /// `docxToOdt(docx)` (packages/odt-engine)
    fn docx_to_odt(&self, docx: Vec<u8>) -> Result<OdtConversion, String>;
    /// the DNS lookups `fetchRemoteImage` makes (Node's `dns.lookup`)
    fn resolver(&self) -> Box<dyn Resolver + Send>;
    /// the HTTP client `fetchRemoteImage` uses (Node's `fetch`/undici)
    fn fetcher(&self) -> Box<dyn Fetcher + Send>;
    /// Electron's `net.fetch(url)` that `saveImageFromUrl` uses, the app
    /// schemes (`md-asset://`) included; `Err` is what it throws
    fn net_fetch(&self, url: &str) -> Result<Box<dyn Response>, String>;
    /// the `fetch` `uploadImageToHost` sends its request with
    fn upload_fetch(&self, url: &str, init: &FetchInit<'_>) -> Result<FetchResponse, FetchFailure>;
}

pub type MarkdownEngineHost = Arc<dyn MarkdownEngine>;

/// The shell's side of the Markdown editor: its hooks and process state.
/// Called on the core thread.
pub trait MarkdownShell: Send + Sync {
    /// `isHeadlessMode()`
    fn is_headless(&self) -> bool;
    /// `getUiLang()`
    fn ui_lang(&self) -> String;
    /// `Date.now()` (recovery copies, image host keys)
    fn now_ms(&self) -> f64;
    /// `contents.reload()` (recovery's open decisions)
    fn reload(&self, view: ViewId);
    /// `isPathOpenElsewhere(path)`: the split-pane probe
    fn is_path_open_elsewhere(&self, path: &str) -> bool;
    /// `runtime.openGeneratedPath(path)`: true when a tab opened it
    fn open_generated_path(&self, path: &Path) -> bool;
    /// `runtime.newDocumentDir(webContentsId)`
    fn new_document_dir(&self, view: ViewId) -> Option<PathBuf>;
    /// `runtime.writeNewDocument(webContentsId, fileName, bytes)`
    fn write_new_document(&self, view: ViewId, file_name: &str, bytes: &[u8]) -> Option<PathBuf>;
    /// `fileSavedHook(contents, path)`
    fn file_saved(&self, view: ViewId, path: &Path);
    /// `docxExportedHook(path)`: a "convert and open in Docs" export landed
    fn docx_exported(&self, path: &Path);
}

pub type MarkdownShellHost = Arc<dyn MarkdownShell>;

/// The Markdown editor: its documents and the calls other areas make into it.
/// The calls both text editors share (view set-up, recovery contract) come
/// from [`text_document_editors!`].
pub struct MarkdownEditors {
    docs: Rc<TextDocs>,
    seeds: ViewMap<String>,
    /// `queueMarkdownNoteAppendFor`'s pending texts by view: the note and its texts
    notes: ViewMap<(String, Vec<String>)>,
    services: Services,
}

text_document_editors!(MarkdownEditors);

/// `samePath(a, b)`: case-folded where the file system usually is
fn same_path(a: &str, b: &str) -> bool {
    let key = |p: &str| {
        let full = resolve(&[p]);
        if cfg!(any(target_os = "windows", target_os = "macos")) {
            full.to_lowercase()
        } else {
            full
        }
    };
    key(a) == key(b)
}

impl MarkdownEditors {
    /// `queueMarkdownSeedFor(contents, text)`: text a new untitled tab starts with
    pub fn queue_seed(&self, view: ViewId, text: &str) {
        if !self.docs.is_destroyed(view) {
            self.seeds.insert(view, text.to_owned());
        }
    }

    /// `queueMarkdownNoteAppendFor(contents, notePath, text)`: text for the
    /// note the view shows (the PDF editor's "Add to note"); the renderer
    /// takes it after `markdown:note-append-ready`
    pub fn queue_note_append(&self, view: ViewId, note_path: &str, text: &str) {
        if self.docs.is_destroyed(view) {
            return;
        }
        let queued = match self.notes.remove(view) {
            Some((path, mut texts)) if same_path(&path, note_path) => {
                texts.push(text.to_owned());
                (path, texts)
            }
            _ => (note_path.to_owned(), vec![text.to_owned()]),
        };
        self.notes.insert(view, queued);
        self.services
            .events
            .emit(Target::View(view), "markdown:note-append-ready", Vec::new());
    }

    /// `exportMarkdownPdfHeadless(input, outPath, timeoutMs)` on the hidden
    /// view the shell made for it
    pub fn export_pdf_headless(
        &self,
        view: ViewId,
        input: &str,
        out_path: &str,
        timeout: Duration,
        then: Box<dyn FnOnce(Result<(), String>)>,
    ) {
        self.docs
            .headless_export(view, input, out_path.into_ipc(), timeout, then)
    }
}

const CHANNELS: DocChannels = DocChannels {
    app: "markdown",
    untitled_ext: ".md",
    read_file: "markdown:read-file",
    dirty_changed: "markdown:dirty-changed",
    close_save_result: "markdown:close-save-result",
    close_save_request: "markdown:close-save-request",
    save_request: "markdown:save-request",
    save_request_ack: "markdown:save-request-ack",
    read_text_request: "markdown:read-text-request",
    read_text_result: "markdown:read-text-result",
    file_renamed: "markdown:file-renamed",
    export_request: "markdown:export-request",
    recovery_flush_request: "markdown:recovery-flush-request",
    recovery_open: "markdown:recovery-open",
    recovery_write: "markdown:recovery-write",
    consume_headless_export: "markdown:consume-headless-export",
    headless_export_done: "markdown:headless-export-done",
};

/// `MAX_NOTES` of `wiki-notes.ts`
const MAX_NOTES: f64 = 2000.0;

/// a serializable answer as the renderer receives it
pub(crate) fn to_ipc(value: &impl Serialize) -> IpcValue {
    serde_json::to_value(value).map_or(IpcValue::Null, |v| kit::from_json(&v))
}

/// The wiki index of `wiki-index.ts` (module state, one index per root):
/// its builds run on workers one at a time, as the TypeScript's promise
/// chain ran them
type SharedIndex = Arc<Mutex<WikiIndex>>;

pub(crate) fn entries(
    services: &Services,
    provided: &Rc<Provided>,
) -> Result<Vec<Entry>, RegisterError> {
    let shell = services.hosts.need::<MarkdownShellHost>(Batch::D2)?;
    let engine = services.hosts.need::<MarkdownEngineHost>(Batch::D2)?;
    let os = services.hosts.need::<OsShellHost>(Batch::D2)?;
    let (s1, s2, s3, s4, s5) = (
        shell.clone(),
        shell.clone(),
        shell.clone(),
        shell.clone(),
        shell.clone(),
    );
    let docs = TextDocs::new(
        services,
        CHANNELS,
        DocHooks {
            lang: Box::new(move || s1.ui_lang()),
            is_headless: Box::new(move || s2.is_headless()),
            reload: Box::new(move |v| s3.reload(v)),
            now_ms: Box::new(move || s5.now_ms()),
            open_elsewhere: Box::new(move |p| s4.is_path_open_elsewhere(p)),
            discard_pending_assets: |path| discard_pending_owned_assets(path).errors,
            rename_assets: |old, new| rename_owned_asset_document(old, new).map_err(|e| e.message),
            presenting: Box::new(|_| false),
        },
        ("Untitled", "제목 없음"),
    )?;
    let editors = Rc::new(MarkdownEditors {
        docs: Rc::clone(&docs),
        seeds: ViewMap::new(services),
        notes: ViewMap::new(services),
        services: services.clone(),
    });
    provided.add::<dyn DocumentEditors>(editors.clone());
    // the app's own calls (seed, note append, headless export, tracking) for the shell
    provided.add::<MarkdownEditors>(editors.clone());

    let index: SharedIndex = Arc::new(Mutex::new(WikiIndex::new()));
    let fragments: Rc<RefCell<WikiFragments>> = Rc::default();
    let mut out = docs.entries();

    let (e, ix, sv) = (Rc::clone(&editors), Arc::clone(&index), services.clone());
    out.push(kit::invoke("markdown:consume-pending", move |cx, _| {
        let pending = e.docs.open_path(cx.sender.view);
        // the vault root is known from here on: start the index so the
        // backlinks panel and the graph usually find it already built
        if pending.is_some()
            && let Ok(root) = e.docs.default_save_dir()
        {
            let ix = Arc::clone(&ix);
            kit::on_worker(
                &sv,
                move || {
                    let mut fs = node_vault_fs(&now_ms);
                    lock(&ix).warm_wiki_index(&root, &mut fs)
                },
                |()| {},
            );
        }
        Ok(pending.into_ipc())
    }));
    let e = Rc::clone(&editors);
    out.push(kit::invoke("markdown:seed-take", move |cx, _| {
        let view = cx.sender.view;
        if e.docs.open_path(view).is_some() {
            return Ok(IpcValue::Null);
        }
        Ok(e.seeds.remove(view).into_ipc())
    }));
    let e = Rc::clone(&editors);
    out.push(kit::invoke("markdown:note-append-take", move |cx, _| {
        let view = cx.sender.view;
        let document = e.docs.save_path(view);
        let matches = match (e.notes.get(view), &document) {
            (Some((path, _)), Some(doc)) => same_path(&path, doc),
            _ => false,
        };
        if !matches {
            return Ok(IpcValue::Array(Vec::new()));
        }
        let texts = e.notes.remove(view).map(|(_, t)| t).unwrap_or_default();
        Ok(texts.into_ipc())
    }));

    let (e, sv) = (Rc::clone(&editors), services.clone());
    out.push(kit::invoke_later(
        "markdown:resolve-wiki-links",
        move |_, args, responder| {
            let request = args.get(0);
            let from_path = kit::as_str(field(request, "fromPath"))
                .unwrap_or("")
                .to_owned();
            let targets: Vec<String> = match field(request, "targets") {
                IpcValue::Array(items) => items
                    .iter()
                    .filter_map(|t| kit::as_str(t).map(str::to_owned))
                    .collect(),
                _ => Vec::new(),
            };
            let root = match e.docs.default_save_dir() {
                Ok(root) => root,
                Err(error) => return responder.reply(Err(error)),
            };
            kit::on_worker(
                &sv,
                move || {
                    let mut fs = node_fs(&now_ms);
                    let resolved = resolve_wiki_links(
                        &targets,
                        &ResolveOptions {
                            from_path: &from_path,
                            root: &root,
                        },
                        &mut fs,
                    );
                    // a Map arrives as an empty object: ship the shape the renderer asked for
                    IpcValue::Object(
                        resolved
                            .iter()
                            .map(|(target, link)| {
                                (
                                    target.to_owned(),
                                    obj([
                                        ("path", link.path.as_str().into_ipc()),
                                        ("fragment", link.fragment.as_str().into_ipc()),
                                        ("found", link.found.into_ipc()),
                                    ]),
                                )
                            })
                            .collect(),
                    )
                },
                move |resolved| responder.reply(Ok(resolved)),
            );
        },
    ));
    let fr = Rc::clone(&fragments);
    out.push(kit::invoke(
        "markdown:remember-wiki-fragment",
        move |_, args| {
            if let (Some(path), Some(fragment)) = (args.str(0), args.str(1)) {
                fr.borrow_mut().remember_wiki_fragment(path, fragment);
            }
            Ok(IpcValue::Undefined)
        },
    ));
    let fr = Rc::clone(&fragments);
    out.push(kit::invoke(
        "markdown:take-wiki-fragment",
        move |_, args| {
            Ok(match args.str(0) {
                Some(path) => fr.borrow_mut().take_wiki_fragment(path).into_ipc(),
                None => "".into_ipc(),
            })
        },
    ));
    let (e, sv) = (Rc::clone(&editors), services.clone());
    out.push(kit::invoke_later(
        "markdown:list-wiki-notes",
        move |_, _, responder| {
            let root = match e.docs.default_save_dir() {
                Ok(root) => root,
                Err(error) => return responder.reply(Err(error)),
            };
            kit::on_worker(
                &sv,
                move || to_ipc(&list_wiki_notes(&root, &mut node_fs(&now_ms), MAX_NOTES)),
                move |notes| responder.reply(Ok(notes)),
            );
        },
    ));
    let (e, sv) = (Rc::clone(&editors), services.clone());
    out.push(kit::invoke_later(
        "markdown:wiki-heads",
        move |_, args, responder| {
            let request = args.get(0);
            let target = kit::as_str(field(request, "target"))
                .unwrap_or("")
                .to_owned();
            let from_path = kit::as_str(field(request, "fromPath"))
                .unwrap_or("")
                .to_owned();
            let root = match e.docs.default_save_dir() {
                Ok(root) => root,
                Err(error) => return responder.reply(Err(error)),
            };
            kit::on_worker(
                &sv,
                move || {
                    to_ipc(&wiki_heads(
                        &target,
                        &from_path,
                        &root,
                        &mut node_fs(&now_ms),
                    ))
                },
                move |heads| responder.reply(Ok(heads)),
            );
        },
    ));
    let (e, sv) = (Rc::clone(&editors), services.clone());
    out.push(kit::invoke_later(
        "markdown:create-wiki-note",
        move |cx, args, responder| {
            let view = cx.sender.view;
            let target = kit::as_str(field(args.get(0), "target"))
                .unwrap_or("")
                .to_owned();
            if target.is_empty() {
                return responder.reply(Ok(obj([("ok", false.into_ipc())])));
            }
            // where a bare name lands follows the document this view holds: the
            // saved path wins (Save As moved it), the opened path is the fallback
            let from_path = e
                .docs
                .save_path(view)
                .or_else(|| e.docs.open_path(view))
                .unwrap_or_default();
            let root = match e.docs.default_save_dir() {
                Ok(root) => root,
                Err(error) => return responder.reply(Err(error)),
            };
            kit::on_worker(
                &sv,
                move || {
                    let from_dir = if from_path.is_empty() {
                        String::new()
                    } else {
                        dirname(&from_path)
                    };
                    let made = create_wiki_note(
                        &target,
                        &CreateNoteOptions {
                            root: &root,
                            from_dir: &from_dir,
                        },
                    );
                    match made {
                        Ok(Some(note)) => match to_ipc(&note) {
                            IpcValue::Object(mut fields) => {
                                fields.insert(0, ("ok".to_owned(), true.into_ipc()));
                                IpcValue::Object(fields)
                            }
                            other => other,
                        },
                        _ => obj([("ok", false.into_ipc())]),
                    }
                },
                move |made| responder.reply(Ok(made)),
            );
        },
    ));
    for (channel, op) in [
        ("markdown:wiki-backlinks", WikiOp::Backlinks),
        ("markdown:wiki-graph", WikiOp::Graph),
        ("markdown:wiki-tags", WikiOp::Tags),
    ] {
        let (e, ix, sv) = (Rc::clone(&editors), Arc::clone(&index), services.clone());
        out.push(kit::invoke_later(channel, move |_, args, responder| {
            let path = args.str(0).map(str::to_owned);
            if op == WikiOp::Backlinks && path.is_none() {
                return responder.reply(Ok(IpcValue::Array(Vec::new())));
            }
            let root = match e.docs.default_save_dir() {
                Ok(root) => root,
                Err(error) => return responder.reply(Err(error)),
            };
            let ix = Arc::clone(&ix);
            kit::on_worker(
                &sv,
                move || {
                    let mut fs = node_vault_fs(&now_ms);
                    let mut index = lock(&ix);
                    match op {
                        WikiOp::Backlinks => to_ipc(&index.wiki_backlinks(
                            &root,
                            path.as_deref().unwrap_or_default(),
                            &mut fs,
                        )),
                        WikiOp::Graph => to_ipc(&index.wiki_graph(&root, &mut fs)),
                        WikiOp::Tags => to_ipc(&index.wiki_tags(&root, &mut fs)),
                    }
                },
                move |answer| responder.reply(Ok(answer)),
            );
        }));
    }
    out.extend(save::entries(services, &editors, engine, os, shell)?);
    Ok(out)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WikiOp {
    Backlinks,
    Graph,
    Tags,
}

/// the index, also after a build that panicked on another worker
fn lock(index: &SharedIndex) -> std::sync::MutexGuard<'_, WikiIndex> {
    index.lock().unwrap_or_else(|e| e.into_inner())
}

/// This app's host fakes, answering from `case` (`hosts.d2.markdown`): see [`fake::FakeMarkdown`]
#[cfg(any(test, feature = "probe"))]
pub(crate) fn fakes(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    let probe = hosts.get::<crate::html::fake::ProbeLog>().cloned();
    let fake = Arc::new(fake::FakeMarkdown::new(case, probe));
    hosts.insert::<MarkdownEngineHost>(fake.clone());
    hosts.insert::<MarkdownShellHost>(fake.clone());
    hosts.insert::<Arc<fake::FakeMarkdown>>(fake);
}

/// tools/ipc-diff's `trigger` steps for this editor (`d2/markdown:<what>`):
/// the shell's and the other areas' calls into it. The TypeScript side of
/// groups/d2/markdown.ts maps the same names to `markdown-main.ts`'s and
/// `note-append.ts`'s exports. False for a name this editor does not know
/// (`then` is dropped).
#[cfg(any(test, feature = "probe"))]
pub(crate) fn probe_trigger(
    what: &str,
    view: ViewId,
    args: &serde_json::Value,
    _services: &Services,
    provided: &Rc<Provided>,
    then: shell_contract::editors::Then<IpcValue>,
) -> bool {
    let Some(editors) = provided.all::<MarkdownEditors>().into_iter().next() else {
        return false;
    };
    let arg = |i: usize| args.get(i).and_then(serde_json::Value::as_str);
    match what {
        // `queueMarkdownSeedFor(contents, text)`
        "queue-seed" => {
            editors.queue_seed(view, arg(0).unwrap_or_default());
            then(Ok(IpcValue::Undefined))
        }
        // `queueMarkdownNoteAppendFor(contents, notePath, text)`
        "queue-note-append" => {
            editors.queue_note_append(view, arg(0).unwrap_or_default(), arg(1).unwrap_or_default());
            then(Ok(IpcValue::Undefined))
        }
        // `exportMarkdownPdfHeadless(input, outPath, timeoutMs)`
        "export-pdf-headless" => {
            let timeout = args
                .get(2)
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(180_000);
            editors.export_pdf_headless(
                view,
                arg(0).unwrap_or_default(),
                arg(1).unwrap_or_default(),
                Duration::from_millis(timeout),
                Box::new(|r| then(r.map(|()| IpcValue::Undefined).map_err(kit::error))),
            )
        }
        _ => {
            return crate::html::text_doc::probe_trigger(&editors.docs, what, view, args, then);
        }
    }
    true
}
