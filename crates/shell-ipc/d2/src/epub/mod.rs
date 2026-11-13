//! The EPUB editor (`apps/epub/src/main/epub-main.ts`, `ai-attachments.ts`).
//!
//! The book lives here, one session per view ([`session`]); the renderer
//! reads chapters, sends edits and asks for saves. Decided here, not by the
//! renderer: a file that did not open is never written; an edit is refused
//! while the tab's book translation runs and for read-only chapters; an
//! unchanged book is not written; a result book goes only to a path this
//! side's dialog picked for the view, never over the book or a file open in
//! a tab; the result store is reached only with document hashes this side
//! computed for the view; a link is opened only after `safeExternalUrl`.
//!
//! The TypeScript's fourteen per-view maps are one [`ViewState`] per view,
//! dropped (and its waiters answered `false`) when the view is destroyed, as
//! `forgetView`. A view is tracked from its first message (`grantAndTrack`
//! without an open path) or from [`EpubEditors::create_view`] (with one).

mod attachments;
pub(crate) mod hosts;
mod session;
#[cfg(test)]
mod tests;

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::time::Duration;

use jscompat::node_path::host::{basename, dirname, extname, is_absolute, join};
use jscompat::{JsObject, JsonValue, js_regex};
use main_core::epub::reading_state::{ReadingState, ReadingStateDeps, read_position_of};
use main_core::epub::result_paths::{
    ResultPathCheck, ResultPathContext, check_result_path, path_key, same_path,
};
use main_core::epub::store_handlers::{
    self, EpubStore, EpubStoreHandlerDeps, StoreError, StoredTranslation,
};
use main_core::node_fs::NodeError;
use main_core::packages::electron_utils::atomic_write::atomic_write_file;
use main_core::packages::electron_utils::default_save_dir::{
    PathProvider, Thrown, documents_dir_or_fallback,
};
use main_core::packages::electron_utils::dialog_memory::{
    Dialog, DialogMemory, show_save_dialog_with_memory,
};
use main_core::packages::electron_utils::message_box::{
    MessageBox as BoxDialog, MessageBoxOptions, ParentWindow,
};
use main_core::packages::electron_utils::safe_external_url::{
    SafeExternalUrlOptions, safe_external_url,
};
use main_core::packages::electron_utils::save_conflict::{
    SaveConflictAnswer, SaveConflictOptions, SaveDiskState, confirm_overwrite_if_conflicted,
    record_disk_state, should_defer_auto_save,
};
use main_core::packages::i18n::Lang;
use main_core::packages::pdf_structure::TranslationMode;
use serde_json::Value;
use shell_contract::hosts::{Dialogs, FileDialog, FileFilter, MessageBox};
use shell_contract::ipc::{CallContext, RegisterError, Reply, Responder, Target};
use shell_contract::runtime::{AppPaths, PathName, Services};
use shell_contract::{
    Batch, ContentsHost, DialogsHost, DocumentEditors, IpcError, IpcValue, OsShellHost, Provided,
    Surface, ViewId, WindowId,
};

use hosts::{
    Bytes, EpubEngine, EpubEngineHost, EpubShell, EpubShellHost, OpenedBook, Replacement,
    SavedBytes, Translated, TranslatedRequest,
};
use session::{Session, failure, object, safe_integer};

use crate::kit::{self, Args, Entry, IntoIpc, Timer, field, from_json, to_js_json, to_json};

const BOOK_EXTENSION: &str = ".epub";
/// `saveWaiters` and `closeSaveWaiters`: how long the renderer may take
const SAVE_WAIT: Duration = Duration::from_secs(120);
/// `flushWaiters`
const FLUSH_WAIT: Duration = Duration::from_secs(10);

/// `tm(key)` of `i18n-main.ts`
fn tm(lang: Lang, key: &str) -> &'static str {
    let ko = lang == Lang::Ko;
    match key {
        "dlgSaveTitle" if ko => "전자책 저장",
        "dlgSaveTitle" => "Save E-book",
        "filterEpub" if ko => "EPUB 전자책",
        "filterEpub" => "EPUB E-books",
        "dlgSaveTranslatedTitle" if ko => "번역본 저장",
        "dlgSaveTranslatedTitle" => "Save Translated Book",
        "dlgSaveBilingualTitle" if ko => "대역본 저장",
        "dlgSaveBilingualTitle" => "Save Bilingual Book",
        "closeUnsavedMsg" if ko => "이 문서에 저장하지 않은 변경 사항이 있습니다.",
        "closeUnsavedMsg" => "This document has unsaved changes.",
        "closeUnsavedDetail" if ko => "닫기 전에 저장하시겠습니까?",
        "closeUnsavedDetail" => "Do you want to save them before closing?",
        "btnSave" if ko => "저장",
        "btnSave" => "Save",
        "btnDontSave" if ko => "저장 안 함",
        "btnDontSave" => "Don't Save",
        "btnCancel" if ko => "취소",
        "btnCancel" => "Cancel",
        _ => unreachable!("an i18n-main key"),
    }
}

/// A renderer's answer the main side waits for (`saveWaiters`,
/// `closeSaveWaiters`): called with the renderer's `ok`
type Waiter = Box<dyn FnOnce(bool)>;

/// `flushWaiters`' result: `true`, `'composing'`, or anything else
#[derive(Clone, Copy, Debug, PartialEq)]
enum Flush {
    Done,
    Composing,
    Failed,
}

type FlushWaiter = Box<dyn FnOnce(Flush)>;

/// What one view holds: the TypeScript's per-view maps, by name
#[derive(Default)]
struct ViewState {
    /// `openPathByWc`: queued at tab creation, consumed again on reload
    open_path: Option<String>,
    /// `allowedByWc`
    allowed: HashSet<String>,
    /// `savePathByWc`: absent until this side opened the file
    save_path: Option<String>,
    /// `unopenedByWc`: not opened here yet, or failed; nothing is written
    unopened: bool,
    /// `sessionByWc`
    session: Option<Rc<RefCell<Session>>>,
    /// `tokenByWc` (and `wcByToken`)
    token: Option<String>,
    /// `rendererDirtyByWc`
    renderer_dirty: bool,
    /// `knownHashesByWc`
    known_hashes: HashSet<String>,
    /// `resultTargetsByWc`: path keys
    result_targets: HashSet<String>,
    close_waiter: Option<Waiter>,
    save_waiter: Option<Waiter>,
    /// by request id, in the order they were asked
    flush_waiters: Vec<(String, FlushWaiter)>,
    /// `saveChainByWc`: a save runs; the next ones wait in order
    saving: bool,
    queued_saves: VecDeque<Box<dyn FnOnce()>>,
    /// `docDiskStates`
    disk_states: HashMap<String, SaveDiskState>,
}

/// `createReadingState({ dir: userDataDir, write: atomicWriteFile })`
struct ReadingDeps {
    dir: String,
    shell: EpubShellHost,
}

impl ReadingStateDeps for ReadingDeps {
    fn dir(&mut self) -> String {
        self.dir.clone()
    }
    fn write(&mut self, path: &str, text: &str) -> Result<(), NodeError> {
        atomic_write_file(path, text.as_bytes())
    }
    fn now(&mut self) -> f64 {
        self.shell.now()
    }
}

#[derive(Default)]
struct State {
    /// `contentsByWc` and the rest; ordered by view so a broadcast has one order
    views: BTreeMap<ViewId, ViewState>,
    /// `readingState`, made on first use
    reading: Option<ReadingState<ReadingDeps>>,
    /// `dialog-memory`'s last folder
    dialog_memory: DialogMemory,
    attach: attachments::AttachState,
}

struct Epub {
    services: Services,
    engine: EpubEngineHost,
    shell: EpubShellHost,
    dialogs: DialogsHost,
    contents: ContentsHost,
    os: OsShellHost,
    state: RefCell<State>,
    /// `wc.once('destroyed', () => forgetView(wcId))`
    _destroyed: Rc<dyn Fn(ViewId)>,
}

pub(crate) fn entries(
    services: &Services,
    provided: &Rc<Provided>,
) -> Result<Vec<Entry>, RegisterError> {
    let engine = services.hosts.need::<EpubEngineHost>(Batch::D2)?;
    let shell = services.hosts.need::<EpubShellHost>(Batch::D2)?;
    let dialogs = services.hosts.need::<DialogsHost>(Batch::D2)?;
    let contents = services.hosts.need::<ContentsHost>(Batch::D2)?;
    let os = services.hosts.need::<OsShellHost>(Batch::D2)?;
    let epub = Rc::new_cyclic(|weak: &Weak<Epub>| {
        let weak = weak.clone();
        Epub {
            _destroyed: kit::on_view_destroyed(services, move |view| {
                if let Some(epub) = weak.upgrade() {
                    epub.forget_view(view)
                }
            }),
            services: services.clone(),
            engine,
            shell,
            dialogs,
            contents,
            os,
            state: RefCell::default(),
        }
    });
    // the concrete type too: the calls that are not `DocumentEditors`
    // (`createEpubView`, `sendEpubMenuCommand`, the asset scheme) find it so
    let editors = Rc::new(EpubEditors(epub.clone()));
    provided.add::<dyn DocumentEditors>(editors.clone());
    provided.add::<EpubEditors>(editors);

    let e = &epub;
    Ok(vec![
        invoke(e, "epub:consume-pending", |epub, view, _| {
            Ok(epub
                .view(view, |v| v.open_path.clone())
                .flatten()
                .into_ipc())
        }),
        later(e, "epub:open-file", Epub::open_file),
        later(e, "epub:read-chapter", Epub::read_chapter),
        later(e, "epub:apply-edits", Epub::apply_edits),
        later(e, "epub:replace-ranges", Epub::replace_ranges),
        invoke(e, "epub:set-translation-lock", |epub, view, args| {
            let Some(session) = epub.session(view) else {
                return Ok(false.into_ipc());
            };
            let mut session = session.borrow_mut();
            session.locked = args.get(0) == &IpcValue::Bool(true);
            Ok(session.locked.into_ipc())
        }),
        later(e, "epub:save", Epub::save),
        invoke(e, "epub:open-link", Epub::open_link),
        send(e, "epub:dirty-changed", |epub, view, args| {
            let dirty = args.get(0) == &IpcValue::Bool(true) && epub.may_write(view);
            epub.with_view(view, |v| v.renderer_dirty = dirty);
        }),
        send(e, "epub:flush-result", |epub, view, args| {
            let Some(id) = args.str(0) else { return };
            let result = match args.get(1) {
                IpcValue::String(s) if s == "composing" => Flush::Composing,
                IpcValue::Bool(true) => Flush::Done,
                _ => Flush::Failed,
            };
            let waiter = epub
                .with_view(view, |v| {
                    let at = v.flush_waiters.iter().position(|(w, _)| w == id)?;
                    Some(v.flush_waiters.remove(at).1)
                })
                .flatten();
            if let Some(waiter) = waiter {
                waiter(result)
            }
        }),
        send(e, "epub:close-save-result", |epub, view, args| {
            let waiter = epub.with_view(view, |v| v.close_waiter.take()).flatten();
            if let Some(waiter) = waiter {
                waiter(args.get(0) == &IpcValue::Bool(true))
            }
        }),
        // safety net for menu saves the renderer declined without invoking save()
        send(e, "epub:save-request-ack", |epub, view, args| {
            let waiter = epub.with_view(view, |v| v.save_waiter.take()).flatten();
            if let Some(waiter) = waiter {
                waiter(args.get(0) == &IpcValue::Bool(true))
            }
        }),
        invoke(e, "epub:get-reading-state", |epub, view, _| {
            let path = epub
                .view(view, |v| v.session.as_ref().and(v.save_path.clone()))
                .flatten();
            let answer = epub.reading(|r| r.get(path.as_deref()));
            Ok(from_json(&answer.to_json()))
        }),
        send(e, "epub:set-read-position", |epub, view, args| {
            let (path, session) = epub
                .view(view, |v| (v.save_path.clone(), v.session.clone()))
                .unwrap_or_default();
            let checked = read_position_of(to_js_json(args.get(0)).as_ref());
            let (Some(path), Some(session), Some(checked)) = (path, session, checked) else {
                return;
            };
            if checked.spine_index >= session.borrow().spine.len() as f64 {
                return;
            }
            // the TypeScript only warns when the position was not saved
            let _ = epub.reading(|r| r.set_position(&path, &checked));
        }),
        invoke(e, "epub:set-view-prefs", Epub::set_view_prefs),
        invoke(e, "epub:document-hash", |epub, view, _| {
            let Some(session) = epub.session(view) else {
                return Ok(failure("not-open", None));
            };
            let doc_hash = session.borrow().doc_hash.clone();
            epub.know(view, &doc_hash);
            Ok(object(vec![
                ("ok", true.into_ipc()),
                ("docHash", doc_hash.into_ipc()),
            ]))
        }),
        later(e, "epub:translation-units", Epub::translation_units),
        invoke(e, "epub:pick-result-path", |epub, view, args| {
            let picked = epub.pick_result_target(view, args.get(0));
            Ok(match field(&picked, "ok") {
                IpcValue::Bool(true) => field(&picked, "path").clone(),
                _ => IpcValue::Null,
            })
        }),
        invoke(e, "epub:pick-result-target", |epub, view, args| {
            Ok(epub.pick_result_target(view, args.get(0)))
        }),
        invoke(e, "epub:check-result-path", |epub, view, args| {
            Ok(from_json(
                &epub.result_path_check(view, args.str(0)).to_json(),
            ))
        }),
        later(e, "epub:write-translated", Epub::write_translated),
        invoke(e, "epub:store-translations", |epub, view, args| {
            let answer = store_handlers::translations(
                &mut epub.store_deps(view),
                f64::from(view.0),
                to_json(args.get(0)).as_ref(),
                to_json(args.get(1)).as_ref(),
            );
            Ok(from_json(&answer))
        }),
        invoke(e, "epub:store-translation", |epub, view, args| {
            let answer = store_handlers::translation(
                &mut epub.store_deps(view),
                f64::from(view.0),
                to_json(args.get(0)).as_ref(),
                to_json(args.get(1)).as_ref(),
                to_json(args.get(2)).as_ref(),
            );
            Ok(from_json(&answer))
        }),
        invoke(e, "epub:store-unfinished-jobs", |epub, view, args| {
            let answer = store_handlers::unfinished_jobs(
                &mut epub.store_deps(view),
                f64::from(view.0),
                to_json(args.get(0)).as_ref(),
            );
            Ok(from_json(&answer))
        }),
        invoke(e, "epub:store-write", |epub, view, args| {
            store_handlers::write(
                &mut epub.store_deps(view),
                f64::from(view.0),
                to_json(args.get(0)).as_ref(),
            )
            .map(|answer| from_json(&answer))
            .map_err(|err| store_thrown(&err))
        }),
        later(e, "epub:files-pick", |epub, view, _, reply| {
            reply.reply(Ok(epub.files_pick(view)))
        }),
        invoke(e, "epub:files-add", |epub, _, args| {
            let paths = match args.get(0) {
                IpcValue::Array(paths) => paths.as_slice(),
                _ => &[],
            };
            Ok(epub.collect_attachments(paths))
        }),
        invoke(e, "epub:files-add-pasted-image", |epub, _, args| {
            epub.files_add_pasted_image(args.get(0), args.get(1))
        }),
        later(e, "epub:files-read", |epub, _, args, reply| {
            epub.read_attachment_page(args, reply)
        }),
        invoke(e, "epub:files-read-image", |epub, _, args| {
            Ok(epub.read_attachment_image(args.get(0)))
        }),
    ])
}

/// What a thrown store error reaches the renderer as
fn store_thrown(err: &StoreError) -> IpcError {
    match err {
        StoreError::Write(e) => kit::named_error("StoreWriteError", e.message.clone()),
        StoreError::Type(message) => kit::named_error("TypeError", message.clone()),
        StoreError::Other(message) => kit::error(message.clone()),
    }
}

/// `err instanceof Error ? err.message : String(err)` of a store error
fn store_message(err: &StoreError) -> String {
    match err {
        StoreError::Write(e) => e.message.clone(),
        StoreError::Type(m) | StoreError::Other(m) => m.clone(),
    }
}

fn invoke(
    epub: &Rc<Epub>,
    channel: &'static str,
    f: impl Fn(&Rc<Epub>, ViewId, Args) -> Reply + 'static,
) -> Entry {
    let epub = epub.clone();
    kit::invoke(channel, move |cx: &CallContext, args| {
        let view = epub.track(cx);
        f(&epub, view, args)
    })
}

fn later(
    epub: &Rc<Epub>,
    channel: &'static str,
    f: impl Fn(&Rc<Epub>, ViewId, Args, Responder) + 'static,
) -> Entry {
    let epub = epub.clone();
    kit::invoke_later(channel, move |cx: &CallContext, args, reply| {
        let view = epub.track(cx);
        f(&epub, view, args, reply)
    })
}

fn send(
    epub: &Rc<Epub>,
    channel: &'static str,
    f: impl Fn(&Rc<Epub>, ViewId, Args) + 'static,
) -> Entry {
    let epub = epub.clone();
    kit::send(channel, move |cx: &CallContext, args| {
        let view = epub.track(cx);
        f(&epub, view, args);
        Ok(())
    })
}

/// `{ ok: false, error }` of a save
fn save_failure(message: impl Into<String>) -> IpcValue {
    object(vec![
        ("ok", false.into_ipc()),
        ("error", message.into().into_ipc()),
    ])
}

/// `withBookExtension(path)`
fn with_book_extension(path: &str) -> String {
    if extname(path).to_lowercase() == BOOK_EXTENSION {
        path.to_owned()
    } else {
        format!("{path}{BOOK_EXTENSION}")
    }
}

/// `defaultResultName(sourcePath, lang, kind)` of `shared/asset-url.ts`
fn default_result_name(source_path: &str, lang: &str, kind: &str) -> String {
    let name = &source_path[source_path.rfind(['/', '\\']).map_or(0, |i| i + 1)..];
    let stem = if js_regex!(r"\.epub$", "i").test(name) {
        &name[..name.len() - BOOK_EXTENSION.len()]
    } else {
        name
    };
    let stem = if stem.is_empty() { "book" } else { stem };
    let bilingual = if kind == "bilingual" {
        ".bilingual"
    } else {
        ""
    };
    format!("{stem}.{lang}{bilingual}.epub")
}

/// `LANGUAGE_TAG.test(lang)`
fn language_tag(lang: &str) -> bool {
    js_regex!(r"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$").test(lang)
}

/// `chaptersOf(value, count)`: `Ok(None)` when left out, `Err` when bad
fn chapters_of(value: &IpcValue, count: usize) -> Result<Option<Vec<usize>>, ()> {
    let items = match value {
        IpcValue::Undefined => return Ok(None),
        IpcValue::Array(items) if items.len() <= count => items,
        _ => return Err(()),
    };
    items
        .iter()
        .map(|i| match safe_integer(i) {
            Some(n) if n >= 0.0 && n < count as f64 => Ok(n as usize),
            _ => Err(()),
        })
        .collect::<Result<Vec<_>, ()>>()
        .map(Some)
}

/// `new ResultStore(dir)`'s refusals, before any store call
fn store_dir(dir: &str) -> Result<(), StoreError> {
    if !is_absolute(dir) {
        return Err(StoreError::Type(format!(
            "result store: the user-data folder must be absolute: {dir}"
        )));
    }
    if dir
        .split(['\\', '/'])
        .any(|part| part.to_lowercase() == ".genoffice")
    {
        return Err(StoreError::Type(
            "result store: ~/.genoffice belongs to the upstream program".into(),
        ));
    }
    Ok(())
}

/// `ResultStore` at `<dir>/pdf-store`, as the store handlers call it
struct FolderStore {
    engine: EpubEngineHost,
    dir: String,
}

impl EpubStore for FolderStore {
    fn list_translations(
        &mut self,
        doc_hash: &str,
        mode: Option<TranslationMode>,
    ) -> Result<Vec<String>, StoreError> {
        self.engine
            .store_list_translations(&self.dir, doc_hash, mode)
    }
    fn read_translation(
        &mut self,
        doc_hash: &str,
        lang: &str,
        mode: Option<TranslationMode>,
    ) -> Result<Option<StoredTranslation>, StoreError> {
        self.engine
            .store_read_translation(&self.dir, doc_hash, lang, mode)
    }
    fn unfinished_jobs(&mut self, doc_hash: &str) -> Result<Vec<Value>, StoreError> {
        self.engine.store_unfinished_jobs(&self.dir, doc_hash)
    }
    fn write_translation_meta(
        &mut self,
        doc_hash: &str,
        lang: &str,
        provider: &str,
        model: &str,
        mode: Option<TranslationMode>,
    ) -> Result<(), StoreError> {
        self.engine
            .store_write_translation_meta(&self.dir, doc_hash, lang, provider, model, mode)
    }
    fn write_translation_blocks(
        &mut self,
        doc_hash: &str,
        lang: &str,
        blocks: &[Value],
        mode: Option<TranslationMode>,
    ) -> Result<(), StoreError> {
        self.engine
            .store_write_translation_blocks(&self.dir, doc_hash, lang, blocks, mode)
    }
    fn delete_translation(
        &mut self,
        doc_hash: &str,
        lang: &str,
        mode: Option<TranslationMode>,
    ) -> Result<(), StoreError> {
        self.engine
            .store_delete_translation(&self.dir, doc_hash, lang, mode)
    }
    fn delete_translation_except_edited(
        &mut self,
        doc_hash: &str,
        lang: &str,
        mode: Option<TranslationMode>,
    ) -> Result<f64, StoreError> {
        self.engine
            .store_delete_translation_except_edited(&self.dir, doc_hash, lang, mode)
    }
    fn write_job(&mut self, doc_hash: &str, job: &Value) -> Result<(), StoreError> {
        self.engine.store_write_job(&self.dir, doc_hash, job)
    }
    fn heartbeat_job(
        &mut self,
        doc_hash: &str,
        kind: &str,
        key: Option<&str>,
        mode: Option<TranslationMode>,
    ) -> Result<bool, StoreError> {
        self.engine
            .store_heartbeat_job(&self.dir, doc_hash, kind, key, mode)
    }
}

/// `createEpubStoreHandlers({ store, knows })` for one call
struct StoreDeps<'a> {
    epub: &'a Epub,
    view: ViewId,
    store: Option<FolderStore>,
}

impl EpubStoreHandlerDeps for StoreDeps<'_> {
    fn store(&mut self) -> Result<&mut dyn EpubStore, StoreError> {
        if self.store.is_none() {
            let dir = self.epub.user_data_dir();
            store_dir(&dir)?;
            self.store = Some(FolderStore {
                engine: self.epub.engine.clone(),
                dir,
            });
        }
        Ok(self.store.as_mut().expect("made above"))
    }
    fn knows(&mut self, _owner: f64, doc_hash: &str) -> bool {
        self.epub
            .view(self.view, |v| v.known_hashes.contains(doc_hash))
            .unwrap_or(false)
    }
}

/// Electron's `dialog` as `dialog-memory` calls it
struct DialogAdapter<'a>(&'a dyn Dialogs);

fn js_str<'a>(options: &'a JsObject<JsonValue>, key: &str) -> Option<&'a str> {
    match options.get(key) {
        Some(JsonValue::String(s)) => Some(s),
        _ => None,
    }
}

fn js_strings(v: Option<&JsonValue>) -> Vec<String> {
    match v {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|i| match i {
                JsonValue::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn file_dialog_of(options: &JsObject<JsonValue>) -> FileDialog {
    let filters = match options.get("filters") {
        Some(JsonValue::Array(filters)) => filters
            .iter()
            .filter_map(|f| match f {
                JsonValue::Object(f) => Some(FileFilter {
                    name: js_str(f, "name").unwrap_or("").to_owned(),
                    extensions: js_strings(f.get("extensions")),
                }),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    FileDialog {
        title: js_str(options, "title").map(str::to_owned),
        default_path: js_str(options, "defaultPath").map(PathBuf::from),
        button_label: js_str(options, "buttonLabel").map(str::to_owned),
        filters,
        properties: js_strings(options.get("properties")),
    }
}

fn js_object(entries: Vec<(&str, JsonValue)>) -> JsObject<JsonValue> {
    entries
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect()
}

fn js_path(path: &Path) -> JsonValue {
    JsonValue::String(path.to_string_lossy().into_owned())
}

impl Dialog for DialogAdapter<'_> {
    type Window = WindowId;
    fn show_open_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let picked = self.0.open(parent.copied(), &file_dialog_of(options));
        JsonValue::Object(js_object(vec![
            ("canceled", JsonValue::Bool(picked.is_none())),
            (
                "filePaths",
                JsonValue::Array(
                    picked
                        .unwrap_or_default()
                        .iter()
                        .map(|p| js_path(p))
                        .collect(),
                ),
            ),
        ]))
    }
    fn show_save_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let picked = self.0.save(parent.copied(), &file_dialog_of(options));
        JsonValue::Object(js_object(vec![
            ("canceled", JsonValue::Bool(picked.is_none())),
            (
                "filePath",
                picked.map_or(JsonValue::String(String::new()), |p| js_path(&p)),
            ),
        ]))
    }
}

/// a save dialog's answer: the picked path, `None` when cancelled
fn picked_file(result: &JsonValue) -> Option<String> {
    let JsonValue::Object(result) = result else {
        return None;
    };
    if result.get("canceled").is_some_and(JsonValue::truthy) {
        return None;
    }
    match result.get("filePath") {
        Some(JsonValue::String(path)) if !path.is_empty() => Some(path.clone()),
        _ => None,
    }
}

/// The window a save-conflict prompt sits over; a window the shell names is open
struct Parent(WindowId);

impl ParentWindow for Parent {
    fn is_destroyed(&self) -> bool {
        false
    }
}

/// `dialog.showMessageBox` as `save-conflict` calls it
struct Boxes<'a>(&'a dyn Dialogs);

fn message_box_of(options: &MessageBoxOptions) -> MessageBox {
    MessageBox {
        kind: Some(options.kind.to_owned()),
        title: options.title.clone(),
        message: options.message.clone(),
        detail: options.detail.clone(),
        buttons: options.buttons.clone(),
        default_id: Some(options.default_id as usize),
        cancel_id: options.cancel_id.map(|id| id as usize),
        checkbox_label: None,
    }
}

impl BoxDialog<Parent> for Boxes<'_> {
    fn show_message_box_over(&self, parent: &Parent, options: &MessageBoxOptions) -> f64 {
        self.0
            .message(Some(parent.0), &message_box_of(options))
            .response as f64
    }
    fn show_message_box(&self, options: &MessageBoxOptions) -> f64 {
        self.0.message(None, &message_box_of(options)).response as f64
    }
}

/// `app.getPath(name)` for `documentsDirOrFallback`
struct AppPathProvider<'a>(&'a dyn AppPaths);

impl PathProvider for AppPathProvider<'_> {
    fn get_path(&self, name: &str) -> Result<String, Thrown> {
        let name = match name {
            "documents" => PathName::Documents,
            "home" => PathName::Home,
            "userData" => PathName::UserData,
            other => return Err(Thrown(format!("Failed to get '{other}' path"))),
        };
        Ok(self.0.path(name).to_string_lossy().into_owned())
    }
}

/// What a save's work off the core thread ended with
enum SaveRun {
    /// what `saveView`'s `catch` or a refused save answers
    Failed(String),
    /// nothing changed and the target is the book's own file
    NotWritten,
    /// nothing changed; the opened bytes were written to a new path
    Copied(Option<SaveDiskState>),
    /// the saved bytes, opened, become the session's
    Rebased {
        bytes: Bytes,
        opened: OpenedBook,
        disk: Option<SaveDiskState>,
    },
}

/// What the work of `epub:open-file` ended with
enum OpenRun {
    Unreadable,
    Refused(String),
    Opened(Bytes, OpenedBook, Option<SaveDiskState>),
}

impl Epub {
    /// `grantAndTrack(wc)` for a view that reaches the editor before the
    /// shell set it up ([`EpubEditors::open_view`]): tracked, nothing granted
    fn track(&self, cx: &CallContext) -> ViewId {
        let view = cx.sender.view;
        self.state
            .borrow_mut()
            .views
            .entry(view)
            .or_insert_with(|| ViewState {
                unopened: true,
                ..ViewState::default()
            });
        view
    }

    fn with_view<R>(&self, view: ViewId, f: impl FnOnce(&mut ViewState) -> R) -> Option<R> {
        self.state.borrow_mut().views.get_mut(&view).map(f)
    }

    fn view<R>(&self, view: ViewId, f: impl FnOnce(&ViewState) -> R) -> Option<R> {
        self.state.borrow().views.get(&view).map(f)
    }

    fn session(&self, view: ViewId) -> Option<Rc<RefCell<Session>>> {
        self.view(view, |v| v.session.clone()).flatten()
    }

    /// `mayWrite(wcId)`
    fn may_write(&self, view: ViewId) -> bool {
        self.view(view, |v| !v.unopened && v.session.is_some())
            .unwrap_or(false)
    }

    /// `epubIsDirty(wcId)`
    fn is_dirty(&self, view: ViewId) -> bool {
        if !self.may_write(view) {
            return false;
        }
        let (renderer, session) = self
            .view(view, |v| (v.renderer_dirty, v.session.clone()))
            .unwrap_or_default();
        renderer || session.is_some_and(|s| s.borrow().is_dirty())
    }

    /// `!contents.isDestroyed()`
    fn alive(&self, view: ViewId) -> bool {
        self.services.views.sender_of(view).is_some()
    }

    fn emit(&self, view: ViewId, channel: &'static str, args: Vec<IpcValue>) {
        self.services.events.emit(Target::View(view), channel, args)
    }

    /// `know(wcId, docHash)`
    fn know(&self, view: ViewId, doc_hash: &str) {
        self.with_view(view, |v| v.known_hashes.insert(doc_hash.to_owned()));
    }

    fn lang(&self) -> Lang {
        self.shell.ui_lang()
    }

    /// `userDataDir()`
    fn user_data_dir(&self) -> String {
        self.services
            .paths
            .path(PathName::UserData)
            .to_string_lossy()
            .into_owned()
    }

    /// `reading()`: the reading state, made on first use
    fn reading<R>(&self, f: impl FnOnce(&mut ReadingState<ReadingDeps>) -> R) -> R {
        let dir = self.user_data_dir();
        let shell = self.shell.clone();
        let mut state = self.state.borrow_mut();
        f(state
            .reading
            .get_or_insert_with(|| ReadingState::new(ReadingDeps { dir, shell })))
    }

    /// `parentOf(contents)`
    fn parent(&self, view: ViewId) -> Option<WindowId> {
        self.contents.window_of(view)
    }

    fn store_deps(&self, view: ViewId) -> StoreDeps<'_> {
        StoreDeps {
            epub: self,
            view,
            store: None,
        }
    }

    /// `forgetView(wcId)`: the view's state goes, its waiters answer `false`
    fn forget_view(&self, view: ViewId) {
        let gone = self.state.borrow_mut().views.remove(&view);
        let Some(gone) = gone else { return };
        for (_, waiter) in gone.flush_waiters {
            waiter(Flush::Failed)
        }
        if let Some(waiter) = gone.close_waiter {
            waiter(false)
        }
        if let Some(waiter) = gone.save_waiter {
            waiter(false)
        }
    }

    /// `isPathOpenInTab(path)`: this editor's views, then the shell's probe
    fn is_path_open_in_tab(&self, path: &str) -> bool {
        let own = self.state.borrow().views.values().any(|v| {
            v.save_path
                .iter()
                .chain(v.open_path.iter())
                .any(|open| same_path(open, path, None))
        });
        // a broken probe must not let a result overwrite an open file
        own || self.shell.is_path_open_in_tab(path).unwrap_or(true)
    }

    /// `resultPathCheck(wcId, path)`
    fn result_path_check(&self, view: ViewId, path: Option<&str>) -> ResultPathCheck {
        let source = self
            .view(view, |v| {
                v.save_path.clone().or_else(|| v.open_path.clone())
            })
            .flatten()
            .unwrap_or_default();
        let mut open_in_tab = |p: &str| self.is_path_open_in_tab(p);
        check_result_path(
            path,
            &mut ResultPathContext {
                source_path: &source,
                is_open_in_tab: &mut open_in_tab,
                case_insensitive: None,
            },
        )
    }

    /// `assetTokenOf(wcId)`
    fn asset_token(&self, view: ViewId) -> String {
        if let Some(token) = self.view(view, |v| v.token.clone()).flatten() {
            return token;
        }
        let token = self.shell.random_token();
        self.with_view(view, |v| v.token = Some(token.clone()));
        token
    }

    /// `refuseWrites(wcId)`: the view's file did not open
    fn refuse_writes(&self, view: ViewId) {
        self.with_view(view, |v| {
            v.unopened = true;
            v.save_path = None;
            v.session = None;
            v.renderer_dirty = false;
        });
    }

    /// `state(path)`: runs `then` with the chapter, read on a worker the
    /// first time
    fn with_chapter(
        &self,
        session: Rc<RefCell<Session>>,
        path: String,
        then: impl FnOnce(&mut Session, usize) + 'static,
    ) {
        let known = session.borrow().chapter_index(&path);
        if let Some(i) = known {
            let mut s = session.borrow_mut();
            return then(&mut s, i);
        }
        let bytes = session.borrow().bytes.clone();
        let engine = self.engine.clone();
        kit::on_worker(
            &self.services,
            move || session::load_chapter(&*engine, bytes, path),
            move |state| {
                let mut s = session.borrow_mut();
                let i = s.insert_chapter(state);
                then(&mut s, i)
            },
        );
    }

    fn open_file(self: &Rc<Self>, view: ViewId, args: Args, reply: Responder) {
        let path = args.str(0).map(str::to_owned);
        let granted = path
            .as_ref()
            .is_some_and(|p| self.view(view, |v| v.allowed.contains(p)).unwrap_or(false));
        let Some(path) = path.filter(|_| granted) else {
            return reply.reply(Err(kit::error("epub: path not granted to this view")));
        };
        // A reload of a view whose book holds unsaved edits gets that book back, edits and all.
        let (held, save_path) = self
            .view(view, |v| (v.session.clone(), v.save_path.clone()))
            .unwrap_or_default();
        if let Some(held) = held
            && held.borrow().is_dirty()
            && save_path.as_deref() == Some(path.as_str())
        {
            return reply.reply(Ok(self.opened(view, &path, &held)));
        }
        let engine = self.engine.clone();
        let read_path = path.clone();
        let epub = self.clone();
        kit::on_worker(
            &self.services,
            move || {
                let Ok(bytes) = std::fs::read(main_core::node_fs::namespaced(&read_path)) else {
                    return OpenRun::Unreadable;
                };
                let bytes: Bytes = Arc::new(bytes);
                match engine.open(bytes.clone()) {
                    Err(reason) => OpenRun::Refused(reason),
                    Ok(opened) => OpenRun::Opened(bytes, opened, record_disk_state(&read_path)),
                }
            },
            move |run| {
                let refused = |reason: &str| {
                    object(vec![
                        ("status", "refused".into_ipc()),
                        ("reason", reason.into_ipc()),
                    ])
                };
                match run {
                    OpenRun::Unreadable => {
                        epub.refuse_writes(view);
                        reply.reply(Ok(refused("unreadable")))
                    }
                    OpenRun::Refused(reason) => {
                        epub.refuse_writes(view);
                        reply.reply(Ok(refused(&reason)))
                    }
                    OpenRun::Opened(bytes, opened, disk) => {
                        let session = Rc::new(RefCell::new(Session::new(bytes, opened)));
                        epub.with_view(view, |v| {
                            v.session = Some(session.clone());
                            if let Some(disk) = disk {
                                v.disk_states.insert(path.clone(), disk);
                            }
                        });
                        reply.reply(Ok(epub.opened(view, &path, &session)))
                    }
                }
            },
        );
    }

    /// the end of `epub:open-file`: seen open here, the path is a save target
    fn opened(&self, view: ViewId, path: &str, session: &Rc<RefCell<Session>>) -> IpcValue {
        let session = session.borrow();
        self.with_view(view, |v| {
            v.unopened = false;
            v.save_path = Some(path.to_owned());
        });
        self.know(view, &session.doc_hash);
        object(vec![
            ("status", "ok".into_ipc()),
            ("book", session.summary_ipc()),
            (
                "assetBase",
                format!("epub-asset://{}/", self.asset_token(view)).into_ipc(),
            ),
            ("docHash", session.doc_hash.as_str().into_ipc()),
            ("readOnly", session.book_read_only().into_ipc()),
        ])
    }

    fn read_chapter(self: &Rc<Self>, view: ViewId, args: Args, reply: Responder) {
        let Some(session) = self.session(view) else {
            return reply.reply(Ok(failure("not-open", None)));
        };
        let item = session
            .borrow()
            .spine_item(args.get(0))
            .map(|i| (i.index, i.path.clone()));
        let Some((index, path)) = item else {
            return reply.reply(Ok(failure("invalid-request", Some("no such chapter"))));
        };
        self.with_chapter(session, path, move |s, i| {
            reply.reply(Ok(s.chapter_result(index, i)))
        });
    }

    fn apply_edits(self: &Rc<Self>, view: ViewId, args: Args, reply: Responder) {
        let session = self.session(view).filter(|_| self.may_write(view));
        let Some(session) = session else {
            return reply.reply(Ok(failure("not-open", None)));
        };
        let request = args.get(0);
        let raw = match field(request, "edits") {
            IpcValue::Array(raw) if !raw.is_empty() => raw,
            _ => {
                return reply.reply(Ok(failure(
                    "invalid-request",
                    Some("edits must be a non-empty list"),
                )));
            }
        };
        let Some(edits) = raw
            .iter()
            .map(session::block_edit_of)
            .collect::<Option<Vec<_>>>()
        else {
            return reply.reply(Ok(failure("invalid-request", Some("not a block edit"))));
        };
        let target = session.borrow().edit_target(field(request, "spineIndex"));
        let target = match target {
            Ok(target) => target,
            Err(refusal) => return reply.reply(Ok(refusal)),
        };
        let engine = self.engine.clone();
        self.with_chapter(session, target.path, move |s, i| {
            reply.reply(Ok(s.apply_edits(&*engine, i, target.index, &edits)))
        });
    }

    fn replace_ranges(self: &Rc<Self>, view: ViewId, args: Args, reply: Responder) {
        let session = self.session(view).filter(|_| self.may_write(view));
        let Some(session) = session else {
            return reply.reply(Ok(failure("not-open", None)));
        };
        let request = args.get(0);
        let replacements = session::replacements_of(field(request, "replacements"));
        let version = safe_integer(field(request, "version"));
        let (Some(replacements), Some(version)) = (replacements, version) else {
            return reply.reply(Ok(failure("invalid-request", Some("bad replacements"))));
        };
        let target = session.borrow().edit_target(field(request, "spineIndex"));
        let target = match target {
            Ok(target) => target,
            Err(refusal) => return reply.reply(Ok(refusal)),
        };
        let engine = self.engine.clone();
        self.with_chapter(session, target.path, move |s, i| {
            reply.reply(Ok(s.replace_ranges(
                &*engine,
                i,
                target.index,
                version,
                replacements,
            )))
        });
    }

    /// `epub:save`: one save at a time per view; a second one starts from
    /// the bytes the first wrote
    fn save(self: &Rc<Self>, view: ViewId, args: Args, reply: Responder) {
        let waiter = self.with_view(view, |v| v.save_waiter.take()).flatten();
        let request = args.get(0).clone();
        let epub = self.clone();
        let job: Box<dyn FnOnce()> = Box::new(move || {
            let done = epub.clone();
            epub.save_view(
                view,
                &request,
                Box::new(move |result: IpcValue| {
                    let ok = field(&result, "ok") == &IpcValue::Bool(true)
                        && field(&result, "canceled") == &IpcValue::Undefined;
                    if let Some(waiter) = waiter {
                        waiter(ok)
                    }
                    reply.reply(Ok(result));
                    done.save_finished(view);
                }),
            )
        });
        let run_now = self
            .with_view(view, |v| {
                if v.saving {
                    v.queued_saves.push_back(job);
                    None
                } else {
                    v.saving = true;
                    Some(job)
                }
            })
            .flatten();
        if let Some(job) = run_now {
            job()
        }
    }

    fn save_finished(&self, view: ViewId) {
        let next = self
            .with_view(view, |v| {
                let next = v.queued_saves.pop_front();
                v.saving = next.is_some();
                next
            })
            .flatten();
        if let Some(next) = next {
            next()
        }
    }

    /// `conflictStopsSave(contents, path, auto)`
    fn conflict_stops_save(&self, view: ViewId, path: &str, auto: bool) -> bool {
        if !self.shell.open_elsewhere(path) {
            return false;
        }
        let recorded = self
            .view(view, |v| v.disk_states.get(path).cloned())
            .flatten();
        let probe = |p: &str| Ok(self.shell.open_elsewhere(p));
        if auto {
            return should_defer_auto_save(Some(&probe), path, recorded.as_ref());
        }
        let parent = self.parent(view).map(Parent);
        let lang = self.lang();
        confirm_overwrite_if_conflicted(&SaveConflictOptions {
            probe: Some(&probe),
            dialog: &Boxes(&*self.dialogs),
            parent: parent.as_ref(),
            path,
            recorded: recorded.as_ref(),
            lang: lang.as_str(),
        }) == SaveConflictAnswer::Cancel
    }

    /// `showSaveDialogWithMemory(dialog, parentOf(contents), options)`: the
    /// picked path
    fn save_dialog(&self, view: ViewId, options: JsObject<JsonValue>) -> Option<String> {
        let parent = self.parent(view);
        let result = show_save_dialog_with_memory(
            &mut self.state.borrow_mut().dialog_memory,
            &mut DialogAdapter(&*self.dialogs),
            parent.as_ref(),
            &options,
            None,
        );
        picked_file(&result)
    }

    /// `resolveSaveTarget(contents, mode)`: `None` when cancelled
    fn resolve_save_target(
        &self,
        view: ViewId,
        save_as: bool,
        current: Option<&str>,
    ) -> Option<String> {
        if let Some(current) = current.filter(|_| !save_as) {
            return Some(current.to_owned());
        }
        let default_path = match current {
            Some(current) => join(&[&dirname(current), &basename(current, None)]),
            None => {
                let documents = documents_dir_or_fallback(&AppPathProvider(&*self.services.paths))
                    .unwrap_or_default();
                join(&[&documents, &format!("book{BOOK_EXTENSION}")])
            }
        };
        let lang = self.lang();
        let options = js_object(vec![
            ("title", JsonValue::String(tm(lang, "dlgSaveTitle").into())),
            ("defaultPath", JsonValue::String(default_path)),
            ("filters", self.epub_filters(lang)),
        ]);
        self.save_dialog(view, options)
            .map(|picked| with_book_extension(&picked))
    }

    fn epub_filters(&self, lang: Lang) -> JsonValue {
        JsonValue::Array(vec![JsonValue::Object(js_object(vec![
            ("name", JsonValue::String(tm(lang, "filterEpub").into())),
            (
                "extensions",
                JsonValue::Array(vec![JsonValue::String("epub".into())]),
            ),
        ]))])
    }

    /// `saveView(contents, request)`, answering through `done`
    fn save_view(
        self: &Rc<Self>,
        view: ViewId,
        request: &IpcValue,
        done: Box<dyn FnOnce(IpcValue)>,
    ) {
        let session = self.session(view).filter(|_| self.may_write(view));
        let Some(session) = session else {
            return done(save_failure(
                "epub: the file did not open, nothing is written",
            ));
        };
        let save_as = field(request, "mode") == &IpcValue::String("saveAs".into());
        // Request input is untrusted: only an explicit automatic-save flag counts
        let auto = field(request, "auto") == &IpcValue::Bool(true);
        let current = self.view(view, |v| v.save_path.clone()).flatten();
        if !save_as
            && let Some(current) = &current
            && self.conflict_stops_save(view, current, auto)
        {
            return done(save_failure("external-modified"));
        }
        let Some(target) = self.resolve_save_target(view, save_as, current.as_deref()) else {
            return done(object(vec![
                ("ok", true.into_ipc()),
                ("canceled", true.into_ipc()),
            ]));
        };
        let same_file = current
            .as_deref()
            .is_some_and(|c| same_path(c, &target, None));
        let (edits, snapshot, bytes, old_hash) = {
            let s = session.borrow();
            (
                s.edits_for_save(),
                s.snapshot(),
                s.bytes.clone(),
                s.doc_hash.clone(),
            )
        };
        let engine = self.engine.clone();
        let shell = self.shell.clone();
        let dir = self.user_data_dir();
        let write_to = target.clone();
        let epub = self.clone();
        kit::on_worker(
            &self.services,
            move || {
                save_book(
                    &*engine, &*shell, &dir, bytes, &edits, same_file, &write_to, &old_hash,
                )
            },
            move |run| {
                let disk = match run {
                    SaveRun::Failed(message) => return done(save_failure(message)),
                    SaveRun::NotWritten => None,
                    SaveRun::Copied(disk) => Some(disk),
                    SaveRun::Rebased {
                        bytes,
                        opened,
                        disk,
                    } => {
                        session.borrow_mut().rebase(bytes, opened, &snapshot);
                        Some(disk)
                    }
                };
                let doc_hash = session.borrow().doc_hash.clone();
                epub.know(view, &doc_hash);
                epub.with_view(view, |v| v.renderer_dirty = false);
                let answer = |written: bool| {
                    object(vec![
                        ("ok", true.into_ipc()),
                        ("path", target.as_str().into_ipc()),
                        ("written", written.into_ipc()),
                        ("docHash", doc_hash.as_str().into_ipc()),
                    ])
                };
                let Some(disk) = disk else {
                    return done(answer(false));
                };
                epub.with_view(view, |v| {
                    v.save_path = Some(target.clone());
                    // keep the reload path in sync: a stale open path would reopen the old file
                    v.open_path = Some(target.clone());
                    v.allowed.insert(target.clone());
                    if let Some(disk) = disk {
                        v.disk_states.insert(target.clone(), disk);
                    }
                    if let Some(current) = current.as_ref().filter(|_| !same_file) {
                        v.disk_states.remove(current);
                    }
                });
                if !same_file {
                    epub.shell.file_saved(view, &target);
                }
                done(answer(true))
            },
        );
    }

    fn open_link(self: &Rc<Self>, _view: ViewId, args: Args) -> Reply {
        let options = SafeExternalUrlOptions {
            allowed_protocols: Some(vec!["http:".into(), "https:".into(), "mailto:".into()]),
        };
        let Some(target) = safe_external_url(args.str(0), Some(&options)) else {
            return Ok(false.into_ipc());
        };
        Ok(self.os.open_external(&target).is_ok().into_ipc())
    }

    fn set_view_prefs(self: &Rc<Self>, view: ViewId, args: Args) -> Reply {
        let prefs = self
            .reading(|r| r.set_view_prefs(to_js_json(args.get(0)).as_ref()))
            .map_err(|e| kit::error(e.message))?;
        let prefs = from_json(&prefs.to_json());
        // every EPUB view but the sender (`contentsByWc`), whether or not it
        // has reached the editor yet
        for other in self.services.views.all() {
            if other.surface == Surface::Epub && other.view != view {
                self.emit(other.view, "epub:view-prefs-changed", vec![prefs.clone()]);
            }
        }
        Ok(prefs)
    }

    fn translation_units(self: &Rc<Self>, view: ViewId, args: Args, reply: Responder) {
        let Some(session) = self.session(view) else {
            return reply.reply(Ok(failure("not-open", None)));
        };
        let (bytes, doc_hash, count) = {
            let s = session.borrow();
            (s.bytes.clone(), s.doc_hash.clone(), s.spine.len())
        };
        let Ok(chapters) = chapters_of(field(args.get(0), "chapters"), count) else {
            return reply.reply(Ok(failure("invalid-request", Some("bad chapters"))));
        };
        self.know(view, &doc_hash);
        let engine = self.engine.clone();
        kit::on_worker(
            &self.services,
            move || engine.translation_units(bytes, chapters.as_deref()),
            move |result| {
                reply.reply(Ok(match result {
                    Ok(found) => object(vec![
                        ("ok", true.into_ipc()),
                        ("docHash", doc_hash.into_ipc()),
                        (
                            "units",
                            found.get("units").map_or(IpcValue::Undefined, from_json),
                        ),
                        (
                            "skipped",
                            found.get("skipped").map_or(IpcValue::Undefined, from_json),
                        ),
                    ]),
                    Err(message) => failure("failed", Some(&message)),
                }))
            },
        );
    }

    /// `pickResultTarget(contents, request)`: the result book's save dialog;
    /// a refused pick says why and is not granted
    fn pick_result_target(&self, view: ViewId, request: &IpcValue) -> IpcValue {
        let source = self.view(view, |v| v.session.as_ref().and(v.save_path.clone()));
        let Some(source) = source.flatten() else {
            return IpcValue::Null;
        };
        let kind = match kit::as_str(field(request, "kind")) {
            Some(kind @ ("translated" | "bilingual")) => kind,
            _ => return IpcValue::Null,
        };
        let Some(lang) = kit::as_str(field(request, "lang")).filter(|l| language_tag(l)) else {
            return IpcValue::Null;
        };
        let suggested = match kit::as_str(field(request, "defaultName")) {
            Some(name) if (1..=255).contains(&session::len16(name)) => {
                let clean: String = basename(name, None)
                    .chars()
                    .map(|c| {
                        if "\\/:*?\"<>|".contains(c) || (c as u32) < 0x20 {
                            '_'
                        } else {
                            c
                        }
                    })
                    .collect();
                with_book_extension(&clean)
            }
            _ => default_result_name(&source, lang, kind),
        };
        let lang_ui = self.lang();
        let title = if kind == "bilingual" {
            "dlgSaveBilingualTitle"
        } else {
            "dlgSaveTranslatedTitle"
        };
        let options = js_object(vec![
            ("title", JsonValue::String(tm(lang_ui, title).into())),
            (
                "defaultPath",
                JsonValue::String(join(&[&dirname(&source), &suggested])),
            ),
            ("filters", self.epub_filters(lang_ui)),
        ]);
        let Some(picked) = self.save_dialog(view, options) else {
            return IpcValue::Null;
        };
        let target = with_book_extension(&picked);
        if let ResultPathCheck::Refused(reason) = self.result_path_check(view, Some(&target)) {
            return object(vec![
                ("ok", false.into_ipc()),
                ("path", target.into_ipc()),
                ("reason", reason.as_str().into_ipc()),
            ]);
        }
        self.with_view(view, |v| v.result_targets.insert(path_key(&target, None)));
        object(vec![("ok", true.into_ipc()), ("path", target.into_ipc())])
    }

    /// `writeTranslated(wcId, request)`
    fn write_translated(self: &Rc<Self>, view: ViewId, args: Args, reply: Responder) {
        let answer = |v: IpcValue| reply.reply(Ok(v));
        let session = self.session(view).filter(|_| self.may_write(view));
        let Some(session) = session else {
            return answer(failure("not-open", None));
        };
        let request = args.get(0);
        if !kit::is_object(request) {
            return answer(failure(
                "invalid-request",
                Some("request must be an object"),
            ));
        }
        let kind = match kit::as_str(field(request, "kind")) {
            Some(kind @ ("translated" | "bilingual")) => kind.to_owned(),
            _ => return answer(failure("invalid-request", Some("bad kind"))),
        };
        // left out it is a translation; 'easy' builds the easy explanation's book
        let easy = match field(request, "mode") {
            IpcValue::Undefined => false,
            IpcValue::String(m) if m == "translate" => false,
            IpcValue::String(m) if m == "easy" => true,
            _ => return answer(failure("invalid-request", Some("bad mode"))),
        };
        let lang = kit::as_str(field(request, "lang"))
            .filter(|l| language_tag(l) && session::len16(l) <= 128);
        let Some(lang) = lang.map(str::to_owned) else {
            return answer(failure("invalid-request", Some("bad language")));
        };
        let (bytes, doc_hash_now, count) = {
            let s = session.borrow();
            (s.bytes.clone(), s.doc_hash.clone(), s.spine.len())
        };
        let Ok(chapters) = chapters_of(field(request, "chapters"), count) else {
            return answer(failure("invalid-request", Some("bad chapters")));
        };
        let path = kit::as_str(field(request, "path")).filter(|p| {
            self.view(view, |v| v.result_targets.contains(&path_key(p, None)))
                .unwrap_or(false)
        });
        let Some(path) = path.map(str::to_owned) else {
            return answer(failure(
                "not-granted",
                Some("the path was not picked for this view"),
            ));
        };
        if let ResultPathCheck::Refused(reason) = self.result_path_check(view, Some(&path)) {
            return answer(failure("invalid-target", Some(reason.as_str())));
        }
        let doc_hash = kit::as_str(field(request, "docHash")).filter(|h| {
            self.view(view, |v| v.known_hashes.contains(*h))
                .unwrap_or(false)
        });
        let Some(doc_hash) = doc_hash.map(str::to_owned) else {
            return answer(failure("not-granted", Some("unknown document hash")));
        };
        if doc_hash != doc_hash_now {
            return answer(failure("stale", Some("the book was saved since")));
        }
        let engine = self.engine.clone();
        let dir = self.user_data_dir();
        let epub = self.clone();
        kit::on_worker(
            &self.services,
            move || -> Result<Translated, String> {
                store_dir(&dir).map_err(|e| store_message(&e))?;
                let mode = easy.then_some(TranslationMode::Easy);
                let stored = engine
                    .store_read_translation(&dir, &doc_hash, &lang, mode)
                    .map_err(|e| store_message(&e))?;
                engine.build_translated(
                    bytes,
                    TranslatedRequest {
                        kind,
                        lang,
                        chapters,
                        results: stored.map(|s| s.blocks).unwrap_or_default(),
                        easy,
                    },
                )
            },
            move |built| {
                let (bytes, report, identifier) = match built {
                    Err(message) => return answer(failure("failed", Some(&message))),
                    Ok(Translated::Refused { reason, detail }) => {
                        return answer(failure("refused", Some(&format!("{reason}: {detail}"))));
                    }
                    Ok(Translated::Built {
                        bytes,
                        report,
                        identifier,
                    }) => (bytes, report, identifier),
                };
                // checked again right before the write: a tab may have opened the file meanwhile
                if let ResultPathCheck::Refused(reason) = epub.result_path_check(view, Some(&path))
                {
                    return answer(failure("invalid-target", Some(reason.as_str())));
                }
                let write_to = path.clone();
                let done = epub.clone();
                kit::on_worker(
                    &epub.services,
                    move || atomic_write_file(&write_to, &bytes),
                    move |written| match written {
                        Err(e) => answer(failure("failed", Some(&e.message))),
                        Ok(()) => {
                            done.with_view(view, |v| {
                                v.result_targets.remove(&path_key(&path, None))
                            });
                            answer(object(vec![
                                ("ok", true.into_ipc()),
                                ("path", path.into_ipc()),
                                ("report", from_json(&report)),
                                ("identifier", identifier.into_ipc()),
                            ]))
                        }
                    },
                );
            },
        );
    }

    /// `session.readText()`: the book's text in spine order, unsaved edits
    /// included; unread chapters are read on a worker
    fn book_text(&self, session: Rc<RefCell<Session>>, then: Box<dyn FnOnce(String)>) {
        let (paths, bytes) = {
            let s = session.borrow();
            let paths: Vec<(String, Option<String>)> = s
                .text_paths()
                .into_iter()
                .map(|p| {
                    let source = s.source_of(&p);
                    (p, source)
                })
                .collect();
            (paths, s.bytes.clone())
        };
        let engine = self.engine.clone();
        kit::on_worker(
            &self.services,
            move || {
                let mut loaded = Vec::new();
                let mut parts = Vec::new();
                for (path, source) in paths {
                    let source = match source {
                        Some(source) => source,
                        None => {
                            let state = session::load_chapter(&*engine, bytes.clone(), path);
                            let source = state.map.source.clone();
                            loaded.push(state);
                            source
                        }
                    };
                    let text = jscompat::trim(&engine.extract_chapter_text(&source)).to_owned();
                    if !text.is_empty() {
                        parts.push(text);
                    }
                }
                (loaded, parts.join("\n\n"))
            },
            move |(loaded, text)| {
                let mut s = session.borrow_mut();
                for state in loaded {
                    s.insert_chapter(state);
                }
                drop(s);
                then(text)
            },
        );
    }
}

/// `saveBook(session, target, sameFile, deps)` with `migrateStoredResults`,
/// off the core thread: the session's change (`rebase`) is the caller's
#[allow(clippy::too_many_arguments)]
fn save_book(
    engine: &dyn EpubEngine,
    shell: &dyn EpubShell,
    dir: &str,
    bytes: Bytes,
    edits: &[(String, Vec<Replacement>)],
    same_file: bool,
    target: &str,
    old_hash: &str,
) -> SaveRun {
    let saved = match engine.save(bytes.clone(), edits) {
        Err(message) => return SaveRun::Failed(message),
        Ok(saved) => saved,
    };
    match saved {
        SavedBytes::Refused { reason, detail } => {
            SaveRun::Failed(format!("epub: the save was refused ({reason}): {detail}"))
        }
        SavedBytes::Unchanged if same_file => SaveRun::NotWritten,
        SavedBytes::Unchanged => match atomic_write_file(target, &bytes) {
            Err(e) => SaveRun::Failed(e.message),
            Ok(()) => SaveRun::Copied(record_disk_state(target)),
        },
        SavedBytes::Changed(new) => {
            if let Err(e) = atomic_write_file(target, &new) {
                return SaveRun::Failed(e.message);
            }
            let new: Bytes = Arc::new(new);
            let opened = match engine.open(new.clone()) {
                Ok(opened) => opened,
                Err(reason) => {
                    return SaveRun::Failed(format!("the saved book does not open ({reason})"));
                }
            };
            // A failed migration does not undo the save; the TypeScript only logs it.
            if opened.doc_hash != old_hash && store_dir(dir).is_ok() {
                let info = engine.migration_info(new.clone(), old_hash, &opened.doc_hash);
                if engine.store_migrate_document(dir, info).is_ok() {
                    let _ = shell.migrate_job_records(dir, old_hash, &opened.doc_hash);
                }
            }
            SaveRun::Rebased {
                disk: record_disk_state(target),
                bytes: new,
                opened,
            }
        }
    }
}

/// The calls other areas make into the EPUB editor (the functions
/// `epub-main.ts` exported): [`DocumentEditors`] and the methods below
pub struct EpubEditors(Rc<Epub>);

/// A continuation that settles once, whichever of the renderer's answer or
/// its timer comes first, as a promise does
type Once<T> = Rc<RefCell<Option<T>>>;

fn once<T>(value: T) -> Once<T> {
    Rc::new(RefCell::new(Some(value)))
}

fn settle<T>(slot: &Once<T>) -> Option<T> {
    slot.borrow_mut().take()
}

impl EpubEditors {
    /// `createEpubView(openPath)`'s `grantAndTrack(wc, openPath)`: the shell
    /// made `view` for `open_path`; the view may open it when it exists
    pub fn open_view(&self, view: ViewId, open_path: Option<&Path>) {
        let open = open_path
            .filter(|p| p.exists())
            .map(|p| p.to_string_lossy().into_owned());
        let mut state = self.0.state.borrow_mut();
        let v = state.views.entry(view).or_default();
        v.unopened = true;
        if let Some(open) = open {
            v.open_path = Some(open.clone());
            v.allowed = HashSet::from([open]);
        }
    }

    /// `epubIsTranslationLocked(wcId)`
    pub fn is_translation_locked(&self, view: ViewId) -> bool {
        self.0.session(view).is_some_and(|s| s.borrow().locked)
    }

    /// `epubIsDirty(wcId)`
    pub fn is_dirty(&self, view: ViewId) -> bool {
        self.0.is_dirty(view)
    }

    /// `sendEpubMenuCommand(contents, command)`
    pub fn menu_command(&self, view: ViewId, command: &str) {
        if self.0.alive(view) {
            self.0
                .emit(view, "epub:menu-command", vec![command.into_ipc()])
        }
    }

    /// what `epub-asset://<token>/` serves from (`registerEpubAssetProtocol`):
    /// the open book's bytes of the view the token names
    pub fn asset_book(&self, token: &str) -> Option<Bytes> {
        let state = self.0.state.borrow();
        let view = state
            .views
            .values()
            .find(|v| v.token.as_deref() == Some(token))?;
        view.session.as_ref().map(|s| s.borrow().bytes.clone())
    }
}

/// `setTimeout(f, delay)` whose handle the settled continuation clears
fn timer_slot() -> Rc<Cell<Option<Timer>>> {
    Rc::new(Cell::new(None))
}

impl DocumentEditors for EpubEditors {
    fn owns(&self, view: ViewId) -> bool {
        self.0
            .services
            .views
            .sender_of(view)
            .is_some_and(|s| s.surface == Surface::Epub)
    }

    /// `requestEpubSave(contents, mode)`
    fn request_save(
        &self,
        view: ViewId,
        mode: shell_contract::editors::SaveMode,
        then: shell_contract::editors::Then<bool>,
    ) {
        use shell_contract::editors::SaveMode;
        let epub = &self.0;
        if !epub.alive(view) || !epub.may_write(view) {
            return then(Ok(false));
        }
        let has_path = epub.view(view, |v| v.save_path.is_some()).unwrap_or(false);
        if mode == SaveMode::Save && !epub.is_dirty(view) && has_path {
            return then(Ok(true));
        }
        let then = once(then);
        let on_timeout = then.clone();
        let weak = Rc::downgrade(epub);
        let timer = kit::after(&epub.services, SAVE_WAIT, move || {
            if let Some(epub) = weak.upgrade() {
                epub.with_view(view, |v| v.save_waiter = None);
            }
            if let Some(then) = settle(&on_timeout) {
                then(Ok(false))
            }
        });
        epub.with_view(view, |v| {
            v.save_waiter = Some(Box::new(move |ok| {
                kit::clear(timer);
                if let Some(then) = settle(&then) {
                    then(Ok(ok))
                }
            }))
        });
        let mode = if mode == SaveMode::SaveAs {
            "saveAs"
        } else {
            "save"
        };
        epub.emit(view, "epub:save-request", vec![mode.into_ipc()]);
    }

    /// `requestEpubClose(contents, parent)`: true means the view may close
    fn request_close(
        &self,
        view: ViewId,
        parent: Option<WindowId>,
        then: shell_contract::editors::Then<bool>,
    ) {
        let epub = &self.0;
        if !epub.alive(view) || !epub.is_dirty(view) {
            return then(Ok(true));
        }
        let lang = epub.lang();
        let answer = epub.dialogs.message(
            parent,
            &MessageBox {
                kind: Some("warning".into()),
                title: None,
                message: tm(lang, "closeUnsavedMsg").into(),
                detail: Some(tm(lang, "closeUnsavedDetail").into()),
                buttons: vec![
                    tm(lang, "btnSave").into(),
                    tm(lang, "btnDontSave").into(),
                    tm(lang, "btnCancel").into(),
                ],
                default_id: Some(0),
                cancel_id: Some(2),
                checkbox_label: None,
            },
        );
        match answer.response {
            2 => return then(Ok(false)),
            1 => return then(Ok(true)),
            _ => {}
        }
        let then = once(then);
        let on_timeout = then.clone();
        let weak = Rc::downgrade(epub);
        let timer = kit::after(&epub.services, SAVE_WAIT, move || {
            if let Some(epub) = weak.upgrade() {
                epub.with_view(view, |v| v.close_waiter = None);
            }
            if let Some(then) = settle(&on_timeout) {
                then(Ok(false))
            }
        });
        epub.with_view(view, |v| {
            v.close_waiter = Some(Box::new(move |ok| {
                kit::clear(timer);
                if let Some(then) = settle(&then) {
                    then(Ok(ok))
                }
            }))
        });
        epub.emit(view, "epub:close-save-request", Vec::new());
    }

    /// `epubReadText(contents)`: the renderer sends what it holds first
    fn read_text(&self, view: ViewId, then: shell_contract::editors::Then<String>) {
        let epub = &self.0;
        if !epub.alive(view) {
            return then(Err(kit::error("the book is no longer open")));
        }
        let Some(session) = epub.session(view) else {
            return then(Err(kit::error(
                "the file did not open, so there is no book to read",
            )));
        };
        let request_id = epub.shell.random_token();
        let then = once(then);
        let timer = timer_slot();
        let weak = Rc::downgrade(epub);
        let finish: Rc<dyn Fn(Option<&'static str>)> = {
            let (timer, id, then) = (timer.clone(), request_id.clone(), then.clone());
            Rc::new(move |error| {
                if let Some(t) = timer.take() {
                    kit::clear(t)
                }
                let Some(epub) = weak.upgrade() else { return };
                epub.with_view(view, |v| v.flush_waiters.retain(|(w, _)| *w != id));
                let Some(then) = settle(&then) else { return };
                if let Some(error) = error {
                    return then(Err(kit::error(error)));
                }
                let current = epub.session(view);
                if !epub.alive(view) || !current.is_some_and(|c| Rc::ptr_eq(&c, &session)) {
                    return then(Err(kit::error("the book is no longer open")));
                }
                epub.book_text(session.clone(), Box::new(move |text| then(Ok(text))));
            })
        };
        let on_timeout = finish.clone();
        timer.set(Some(kit::after(&epub.services, FLUSH_WAIT, move || {
            on_timeout(Some("timed out flushing the book"))
        })));
        epub.with_view(view, |v| {
            v.flush_waiters.push((
                request_id.clone(),
                Box::new(move |result| {
                    finish(match result {
                        Flush::Done => None,
                        Flush::Composing => Some("typing in progress, try again shortly"),
                        Flush::Failed => Some("could not flush the book"),
                    })
                }),
            ))
        });
        epub.emit(view, "epub:flush-request", vec![request_id.into_ipc()]);
    }

    /// `epubSaveToPath(contents, filePath)`: the view's save target becomes
    /// `path` first, so the renderer's normal save runs without a dialog
    fn save_to_path(&self, view: ViewId, path: PathBuf, then: shell_contract::editors::Then<()>) {
        let epub = &self.0;
        if !epub.alive(view) {
            return then(Err(kit::error("the book is no longer open")));
        }
        if !epub.may_write(view) {
            return then(Err(kit::error(
                "the file did not open, so there is no book to save",
            )));
        }
        let file_path = path.to_string_lossy().into_owned();
        let previous = epub
            .with_view(view, |v| {
                let previous = (v.save_path.clone(), v.open_path.clone());
                v.save_path = Some(file_path.clone());
                v.allowed.insert(file_path.clone());
                previous
            })
            .unwrap_or_default();
        let weak = Rc::downgrade(epub);
        let restore = Rc::new(move || {
            if let Some(epub) = weak.upgrade() {
                epub.with_view(view, |v| {
                    v.save_path = previous.0.clone();
                    v.open_path = previous.1.clone();
                });
            }
        });
        let then = once(then);
        let (on_timeout, restore_on_timeout) = (then.clone(), restore.clone());
        let weak = Rc::downgrade(epub);
        let timer = kit::after(&epub.services, SAVE_WAIT, move || {
            if let Some(epub) = weak.upgrade() {
                epub.with_view(view, |v| v.save_waiter = None);
            }
            restore_on_timeout();
            if let Some(then) = settle(&on_timeout) {
                then(Err(kit::error("timed out saving the book")))
            }
        });
        epub.with_view(view, |v| {
            v.save_waiter = Some(Box::new(move |ok| {
                kit::clear(timer);
                if !ok {
                    restore();
                }
                if let Some(then) = settle(&then) {
                    then(if ok {
                        Ok(())
                    } else {
                        Err(kit::error("could not save the book"))
                    })
                }
            }))
        });
        epub.emit(view, "epub:save-request", vec!["save".into_ipc()]);
    }

    /// `epubFileRenamed(contents, oldPath, newPath)`: re-grant the new path
    /// and tell the renderer
    fn file_renamed(&self, view: ViewId, old_path: &Path, new_path: &Path) {
        let epub = &self.0;
        let old = old_path.to_string_lossy().into_owned();
        let new = new_path.to_string_lossy().into_owned();
        epub.with_view(view, |v| {
            if v.save_path.as_deref() == Some(old.as_str()) {
                v.save_path = Some(new.clone());
            }
            if v.open_path.as_deref() == Some(old.as_str()) {
                v.open_path = Some(new.clone());
            }
            if v.allowed.contains(&old) {
                v.allowed.insert(new.clone());
            }
            if let Some(recorded) = v.disk_states.remove(&old) {
                v.disk_states.insert(new.clone(), recorded);
            }
        });
        // the TypeScript ignores a position that did not move
        let _ = epub.reading(|r| r.move_position(&old, &new));
        if epub.alive(view) {
            epub.emit(view, "epub:file-renamed", vec![new.into_ipc()]);
        }
    }

    /// The EPUB editor has no export menu (`epub-main.ts` exports no
    /// `sendEpubExportRequest`): nothing to send
    fn export_request(&self, _view: ViewId, _format: &str) {}

    /// `epubFilePath(wcId)`
    fn document_path(&self, view: ViewId) -> Option<PathBuf> {
        self.0
            .view(view, |v| v.save_path.clone())
            .flatten()
            .map(PathBuf::from)
    }
}

/// This app's host fakes, answering from `case` (`hosts.d2.epub`): the
/// engine from its `engine` member ([`hosts::FakeEngine`]), the shell from
/// its `shell` member ([`hosts::FakeShell`]); both log to the case's log
/// when ipc-probe inserted one
#[cfg(any(test, feature = "probe"))]
pub(crate) fn fakes(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    let member = |name: &str| case.get(name).cloned().unwrap_or(Value::Null);
    let log = hosts.get::<hosts::Log>().cloned().unwrap_or_default();
    hosts.insert::<EpubEngineHost>(Arc::new(hosts::FakeEngine::new(
        &member("engine"),
        log.clone(),
    )));
    hosts.insert::<EpubShellHost>(Arc::new(hosts::FakeShell::new(&member("shell"), log)));
}

#[cfg(any(test, feature = "probe"))]
thread_local! {
    /// The outcome of the last waiting trigger: `None` while it waits
    static OUTCOME: RefCell<Option<Reply>> = const { RefCell::new(None) };
}

/// A `trigger` step of tools/ipc-diff (`d2/epub:<what>`): what the shell
/// calls on the editor, by the TypeScript function's name in kebab case.
/// `args` are that function's arguments after `contents`. A call that waits
/// for the renderer (`request-save`, `request-close`, `read-text`,
/// `save-to-path`) answers `undefined` at once; the `outcome` trigger then
/// answers `null` while it waits, `{value}` or `{error}` once it settled.
/// False for a name it does not know.
#[cfg(any(test, feature = "probe"))]
pub(crate) fn probe_trigger(
    what: &str,
    view: ViewId,
    args: &Value,
    _services: &Services,
    provided: &Rc<Provided>,
    then: shell_contract::editors::Then<IpcValue>,
) -> bool {
    use shell_contract::editors::SaveMode;
    let what = what.strip_prefix("d2/epub:").unwrap_or(what);
    let Some(editors) = provided.all::<EpubEditors>().into_iter().next() else {
        return false;
    };
    let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
    let text = |i: usize| arg(i).as_str().unwrap_or("").to_owned();
    /// starts a waiting call: its outcome lands in `OUTCOME`
    fn wait<T: 'static>(
        into: impl Fn(T) -> IpcValue + 'static,
    ) -> shell_contract::editors::Then<T> {
        OUTCOME.with(|o| *o.borrow_mut() = None);
        Box::new(move |r| OUTCOME.with(|o| *o.borrow_mut() = Some(r.map(into))))
    }
    match what {
        // createEpubView(openPath)
        "open-view" => editors.open_view(view, arg(0).as_str().map(Path::new)),
        // requestEpubSave(contents, mode)
        "request-save" => {
            let mode = if arg(0).as_str() == Some("saveAs") {
                SaveMode::SaveAs
            } else {
                SaveMode::Save
            };
            editors.request_save(view, mode, wait(IpcValue::Bool))
        }
        // requestEpubClose(contents, parent)
        "request-close" => {
            let parent = arg(0).as_u64().map(|w| WindowId(w as u32));
            editors.request_close(view, parent, wait(IpcValue::Bool))
        }
        // epubReadText(contents)
        "read-text" => editors.read_text(view, wait(IpcValue::String)),
        // epubSaveToPath(contents, filePath)
        "save-to-path" => {
            editors.save_to_path(view, PathBuf::from(text(0)), wait(|()| IpcValue::Undefined))
        }
        "outcome" => {
            let value = match OUTCOME.with(|o| o.borrow().clone()) {
                None => IpcValue::Null,
                Some(Ok(value)) => kit::obj([("value", value)]),
                Some(Err(e)) => kit::obj([("error", e.to_string().into_ipc())]),
            };
            return answer(then, value);
        }
        // epubFileRenamed(contents, oldPath, newPath)
        "file-renamed" => editors.file_renamed(view, Path::new(&text(0)), Path::new(&text(1))),
        // sendEpubMenuCommand(contents, command)
        "menu-command" => editors.menu_command(view, &text(0)),
        // epubIsDirty(wcId)
        "is-dirty" => return answer(then, IpcValue::Bool(editors.is_dirty(view))),
        // epubIsTranslationLocked(wcId)
        "is-translation-locked" => {
            return answer(then, IpcValue::Bool(editors.is_translation_locked(view)));
        }
        // epubFilePath(wcId)
        "file-path" => {
            let path = editors.document_path(view);
            return answer(
                then,
                path.map_or(IpcValue::Undefined, |p| p.as_path().into_ipc()),
            );
        }
        _ => return false,
    }
    answer(then, IpcValue::Undefined)
}

#[cfg(any(test, feature = "probe"))]
fn answer(then: shell_contract::editors::Then<IpcValue>, value: IpcValue) -> bool {
    then(Ok(value));
    true
}
