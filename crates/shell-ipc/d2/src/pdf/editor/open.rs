//! Opening and reading the view's document, watching it, untitled names,
//! hand-offs to the shell (create document, PDF tools, notes), and the
//! dirty flag.

use std::rc::Rc;
use std::sync::Arc;

use jscompat::node_path::host::{basename, dirname, join};
use jscompat::{is_js_space, trim};
use main_core::packages::electron_utils::author_name::configured_author_name;
use main_core::packages::electron_utils::save_conflict::record_disk_state;
use main_core::pdf::note_link::{
    FoundNoteLink, NoteHost, NoteLink, NoteLinkDeps, NoteLinkStore, NoteLinks, NoteResult, Thrown,
    note_dialog_text, parse_note_insert_request, parse_note_open_request,
};
use shell_contract::hosts::{FileDialog, FileFilter};
use shell_contract::runtime::PathName;
use shell_contract::{BytesKind, IpcValue, ViewId};

use super::{Editor, NOT_GRANTED};
use crate::kit::{self, Entry, IntoIpc, as_str, error, obj, u8_array};

/// `PDF_READ_CHUNK_BYTES`: the largest slice `readFileChunk` hands over
const READ_CHUNK_BYTES: f64 = 8.0 * 1024.0 * 1024.0;

/// `PDF_TOOLS_HANDOFF`
const PDF_TOOLS_HANDOFF: [&str; 9] = [
    "blankPages",
    "duplex",
    "overlay",
    "stripAnnots",
    "toText",
    "compress",
    "encrypt",
    "decrypt",
    "repair",
];

const MAX_CREATE_DOCUMENT_TITLE_CHARS: usize = 200;
const MAX_CREATE_DOCUMENT_CONTENT_CHARS: usize = 2_000_000;

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `Number.isInteger(v) && v >= 0`
fn whole(v: &IpcValue) -> Option<f64> {
    kit::as_num(v).filter(|n| n.is_finite() && n.fract() == 0.0)
}

/// `parseCreateDocumentRequest(request)`
pub(super) fn parse_create_document_request(request: &IpcValue) -> Option<IpcValue> {
    if !kit::truthy(request) || !kit::is_object(request) {
        return None;
    }
    let kind = as_str(kit::field(request, "type"))?;
    if !matches!(kind, "docx" | "pdf" | "md") {
        return None;
    }
    let title = as_str(kit::field(request, "title"))?;
    if trim(title).is_empty() || utf16_len(title) > MAX_CREATE_DOCUMENT_TITLE_CHARS {
        return None;
    }
    let content = as_str(kit::field(request, "content"))?;
    if trim(content).is_empty() || utf16_len(content) > MAX_CREATE_DOCUMENT_CONTENT_CHARS {
        return None;
    }
    Some(obj([
        ("type", kind.into_ipc()),
        ("title", trim(title).into_ipc()),
        ("content", content.into_ipc()),
    ]))
}

/// `sanitizeAutoRenameBase(raw)`: a safe file name, or `None` when nothing
/// survives. The cap counts UTF-16 units as the TypeScript; a cut never
/// splits a surrogate pair here.
pub(super) fn sanitize_auto_rename_base(raw: &str) -> Option<String> {
    let replaced: String = raw
        .chars()
        .map(|c| {
            if "\\/:*?\"<>|".contains(c) || (c as u32) < 0x20 {
                ' '
            } else {
                c
            }
        })
        .collect();
    let mut collapsed = String::new();
    let mut in_space = false;
    for c in replaced.chars() {
        if is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let cleaned = trim(trim(&collapsed).trim_matches('.'));
    if cleaned.is_empty() {
        return None;
    }
    let lower = cleaned.to_ascii_lowercase();
    let device = matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
        || (lower.len() == 4
            && (lower.starts_with("com") || lower.starts_with("lpt"))
            && matches!(lower.as_bytes()[3], b'1'..=b'9'));
    let safe = if device {
        format!("{cleaned}_")
    } else {
        cleaned.to_owned()
    };
    if utf16_len(&safe) <= 40 {
        return Some(safe);
    }
    let mut cut = String::new();
    let mut units = 0;
    for c in safe.chars() {
        units += c.len_utf16();
        if units > 40 {
            break;
        }
        cut.push(c);
    }
    Some(trim(&cut).to_owned())
}

/// `NoClobberMoveResult`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NoClobber {
    Moved,
    Occupied,
    Failed,
}

/// The entry a path names: device and inode where the platform has them
fn identity(path: &str) -> std::io::Result<String> {
    let meta = std::fs::metadata(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{}:{}", meta.dev(), meta.ino()))
    }
    #[cfg(not(unix))]
    {
        Ok(format!("{:?}:{}", meta.created().ok(), meta.len()))
    }
}

/// `movePdfFileNoClobber(source, target)`: a same-folder move that never
/// replaces an existing file. A hard link reserves the name atomically
/// (an exclusive copy where links are unsupported), then the old name goes;
/// a failure afterwards restores what it can and never claims the target.
pub(crate) fn move_pdf_file_no_clobber(source: &str, target: &str) -> NoClobber {
    use std::io::{ErrorKind, Write};
    let Ok(source_bytes) = std::fs::read(source) else {
        return NoClobber::Failed;
    };
    if let Err(link_error) = std::fs::hard_link(source, target) {
        if link_error.kind() == ErrorKind::AlreadyExists {
            return NoClobber::Occupied;
        }
        let fallback = main_core::node_fs::code_of(&link_error)
            .is_some_and(|c| matches!(c, "ENOSYS" | "ENOTSUP" | "EOPNOTSUPP" | "EPERM" | "EXDEV"));
        if !fallback {
            return NoClobber::Failed;
        }
        let copied = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .and_then(|mut f| f.write_all(&source_bytes));
        if let Err(copy_error) = copied {
            return if copy_error.kind() == ErrorKind::AlreadyExists {
                NoClobber::Occupied
            } else {
                NoClobber::Failed
            };
        }
    }
    let Ok(created) = identity(target) else {
        return NoClobber::Failed;
    };
    let ours = || {
        identity(target).is_ok_and(|id| id == created)
            && std::fs::read(target).is_ok_and(|b| b == source_bytes)
    };
    if std::fs::remove_file(source).is_err() {
        if ours() {
            let _ = std::fs::remove_file(target);
        }
        return NoClobber::Failed;
    }
    if ours() {
        return NoClobber::Moved;
    }
    // someone replaced the target meanwhile: put the source back
    let _ = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(source)
        .and_then(|mut f| {
            f.write_all(&source_bytes)?;
            f.sync_all()
        });
    NoClobber::Failed
}

/// The result store the note links live in (`ResultStore` under userData)
struct Store(super::PdfEngineHost, String);

fn thrown(e: String) -> Thrown {
    Thrown(e)
}

impl NoteLinkStore for Store {
    fn read_note_links(&self) -> Result<NoteLinks, Thrown> {
        self.0.read_note_links(&self.1).map_err(thrown)
    }
    fn find_note_link(
        &self,
        pdf_path: &str,
        doc_hash: &str,
    ) -> Result<Option<FoundNoteLink>, Thrown> {
        self.0
            .find_note_link(&self.1, pdf_path, doc_hash)
            .map_err(thrown)
    }
    fn set_note_link(&self, pdf_path: &str, link: &NoteLink) -> Result<(), Thrown> {
        self.0
            .set_note_link(&self.1, pdf_path, link)
            .map_err(thrown)
    }
    fn update_note_link_doc_hash(&self, pdf_path: &str, doc_hash: &str) -> Result<bool, Thrown> {
        self.0
            .update_note_link_doc_hash(&self.1, pdf_path, doc_hash)
            .map_err(thrown)
    }
}

struct Hooks<'a>(&'a Editor);

impl NoteHost for Hooks<'_> {
    fn has_open_note(&self) -> bool {
        self.0.shell.has_note_hooks()
    }
    fn has_insert_into_note(&self) -> bool {
        self.0.shell.has_note_hooks()
    }
    fn open_note(&self, path: &str) -> Result<bool, Thrown> {
        self.0.shell.open_note(path).map_err(thrown)
    }
    fn insert_into_note(&self, path: &str, text: &str) -> Result<bool, Thrown> {
        self.0.shell.insert_into_note(path, text).map_err(thrown)
    }
}

/// The deps `createNoteLinkService` was given
pub(super) struct NoteDeps<'a> {
    ed: &'a Editor,
    store: Store,
    hooks: Hooks<'a>,
}

impl<'a> NoteDeps<'a> {
    pub fn new(ed: &'a Editor) -> Self {
        NoteDeps {
            ed,
            store: Store(ed.engine.clone(), ed.path(PathName::UserData)),
            hooks: Hooks(ed),
        }
    }
}

impl NoteLinkDeps for NoteDeps<'_> {
    fn store(&self) -> Result<&dyn NoteLinkStore, Thrown> {
        Ok(&self.store)
    }
    fn hash_file(&self, path: &str) -> Result<String, Thrown> {
        self.ed.engine.document_hash_of_file(path).map_err(thrown)
    }
    fn is_untitled(&self, pdf_path: &str) -> Result<bool, Thrown> {
        Ok(self.ed.st.borrow().unsaved_blank.contains(pdf_path))
    }
    fn pick_note_path(&self, owner: f64, default_path: &str) -> Result<Option<String>, Thrown> {
        let lang = self.ed.lang();
        let text = |key| note_dialog_text(&lang, key).unwrap_or_default().to_owned();
        let parent = self.ed.contents.window_of(ViewId(owner as u32));
        let picked = self.ed.dialogs.save(
            parent,
            &FileDialog {
                title: Some(text("dialogTitle")),
                default_path: Some(default_path.into()),
                filters: vec![FileFilter {
                    name: text("filterMarkdown"),
                    extensions: vec!["md".into()],
                }],
                properties: vec!["createDirectory".into()],
                ..Default::default()
            },
        );
        Ok(picked
            .map(|p| p.to_string_lossy().into_owned())
            .filter(|p| !p.is_empty()))
    }
    fn note_word(&self) -> Result<String, Thrown> {
        Ok(note_dialog_text(&self.ed.lang(), "noteWord")
            .unwrap_or_default()
            .to_owned())
    }
    fn host(&self) -> Result<&dyn NoteHost, Thrown> {
        Ok(&self.hooks)
    }
}

/// The deps `noteLinks.afterSave(path)` reaches, owned so it runs on a
/// worker: the result store and the file hash (it reads the whole PDF)
pub(super) struct AfterSaveDeps(Store);

impl AfterSaveDeps {
    pub fn new(ed: &Editor) -> Self {
        AfterSaveDeps(Store(ed.engine.clone(), ed.path(PathName::UserData)))
    }
}

/// No shell hooks: `afterSave` only touches the store
struct NoHooks;

impl NoteHost for NoHooks {
    fn has_open_note(&self) -> bool {
        false
    }
    fn has_insert_into_note(&self) -> bool {
        false
    }
    fn open_note(&self, _path: &str) -> Result<bool, Thrown> {
        Ok(false)
    }
    fn insert_into_note(&self, _path: &str, _text: &str) -> Result<bool, Thrown> {
        Ok(false)
    }
}

impl NoteLinkDeps for AfterSaveDeps {
    fn store(&self) -> Result<&dyn NoteLinkStore, Thrown> {
        Ok(&self.0)
    }
    fn hash_file(&self, path: &str) -> Result<String, Thrown> {
        self.0.0.document_hash_of_file(path).map_err(thrown)
    }
    fn is_untitled(&self, _pdf_path: &str) -> Result<bool, Thrown> {
        Ok(false)
    }
    fn pick_note_path(&self, _owner: f64, _default_path: &str) -> Result<Option<String>, Thrown> {
        Ok(None)
    }
    fn note_word(&self) -> Result<String, Thrown> {
        Ok(String::new())
    }
    fn host(&self) -> Result<&dyn NoteHost, Thrown> {
        Ok(&NoHooks)
    }
}

/// `PdfNoteResult`
fn note_result(result: Result<NoteResult, Thrown>) -> Result<IpcValue, shell_contract::IpcError> {
    match result {
        Ok(NoteResult::Ok) => Ok(obj([("ok", true.into_ipc())])),
        Ok(NoteResult::Refused { reason, message }) => {
            let mut out = vec![
                ("ok".to_owned(), false.into_ipc()),
                ("reason".to_owned(), reason.into_ipc()),
            ];
            if let Some(m) = message {
                out.push(("message".to_owned(), m.into_ipc()));
            }
            Ok(IpcValue::Object(out))
        }
        Err(Thrown(m)) => Err(error(m)),
    }
}

impl Editor {
    /// `pdfFileRenamed(contents, oldPath, newPath)`: the shell moved the
    /// view's file; every record follows and the renderer hears of it
    pub(super) fn file_renamed(&self, view: ViewId, old: &str, new: &str) {
        let watched = {
            let mut st = self.st.borrow_mut();
            let v = st.views.entry(view).or_default();
            if v.open_path.as_deref() == Some(old) {
                v.open_path = Some(new.to_owned());
            }
            if v.redaction_path.as_deref() == Some(old) {
                v.redaction_path = Some(new.to_owned());
            }
            if v.save_as_target.as_deref() == Some(old) {
                v.save_as_target = Some(new.to_owned());
            }
            if st.untitled.remove(old) {
                st.untitled.insert(new.to_owned());
            }
            if st.unsaved_blank.remove(old) {
                st.unsaved_blank.insert(new.to_owned());
            }
            st.views
                .get(&view)
                .and_then(|v| v.watch.as_ref())
                .map(|w| w.path() == old)
        };
        self.grants.0.with(view, |set| {
            if let Some(set) = set.filter(|s| s.contains(old)) {
                set.insert(new.to_owned());
            }
        });
        self.rec.borrow_mut().renamed(view, old, new);
        self.move_disk_state(view, old, new);
        let alive = self.services.views.sender_of(view).is_some();
        // the old name is gone because the app moved it: watch the new one, no notice
        if watched == Some(true) && alive {
            self.stop_view_watch(view);
            self.watch_view_file(view, new);
        }
        self.emit(view, "pdf:file-renamed", vec![new.into_ipc()]);
    }
}

pub(super) fn entries(ed: &Rc<Editor>) -> Vec<Entry> {
    let mut all = Vec::new();

    // the recovery question is answered before the renderer reads the file
    let e = ed.clone();
    all.push(kit::invoke("pdf:consume-pending", move |cx, _| {
        let view = cx.sender.view;
        let path = e.open_path(view);
        e.rec.borrow_mut().mark_consumed(view);
        let Some(path) = path else {
            return Ok(IpcValue::Null);
        };
        let untitled_copy = e.is_untitled_copy(&path);
        let now = e.rec.borrow_mut().resolved_now(view, &path, untitled_copy);
        if !now {
            let parent = e.contents.window_of(view);
            let lang = e.lang();
            e.rec.borrow_mut().resolve_on_open(
                view,
                &path,
                untitled_copy,
                &*e.dialogs,
                parent,
                &lang,
            );
        }
        Ok(path.into_ipc())
    }));

    let e = ed.clone();
    all.push(kit::invoke("pdf:get-username", move |_, _| {
        let user_data = e.path(PathName::UserData);
        Ok(configured_author_name(&user_data, e.shell.username().as_deref()).into_ipc())
    }));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:read-file",
        move |cx, args, reply| {
            let view = cx.sender.view;
            let Some(path) = e.granted(view, args.get(0)) else {
                return reply.reply(Err(error(NOT_GRANTED)));
            };
            let read = e.document_bytes(view, &path);
            let ed = e.clone();
            kit::on_worker(
                &e.services,
                {
                    let path = path.clone();
                    move || read().map(|bytes| (bytes, record_disk_state(&path)))
                },
                move |result| match result {
                    Ok((bytes, state)) => {
                        // the reader's copy: this view's save guard compares against it
                        ed.remember_disk_state(view, &path, state);
                        let bytes = Arc::try_unwrap(bytes).unwrap_or_else(|b| (*b).clone());
                        reply.reply(Ok(IpcValue::Bytes(BytesKind::ArrayBuffer, bytes)))
                    }
                    Err(m) => reply.reply(Err(error(m))),
                },
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:read-file-chunk",
        move |cx, args, reply| {
            let view = cx.sender.view;
            let Some(path) = e.granted(view, args.get(0)) else {
                return reply.reply(Err(error(NOT_GRANTED)));
            };
            let from = whole(args.get(1)).filter(|n| *n >= 0.0).unwrap_or(-1.0);
            let to = whole(args.get(2)).filter(|n| *n >= from).unwrap_or(-1.0);
            if from < 0.0 || to < 0.0 || to - from > READ_CHUNK_BYTES {
                return reply.reply(Err(error("pdf: invalid chunk range")));
            }
            let restored = e.view_bytes(view, &path);
            let ed = e.clone();
            let p = path.clone();
            kit::on_worker(
                &e.services,
                move || -> Result<(Vec<u8>, f64, Option<_>), String> {
                    let state = (from == 0.0).then(|| record_disk_state(&p)).flatten();
                    if let Some(bytes) = restored {
                        let len = bytes.len();
                        let a = (from as usize).min(len);
                        let b = (to as usize).min(len).max(a);
                        return Ok((bytes[a..b].to_vec(), len as f64, state));
                    }
                    use std::io::{Read, Seek, SeekFrom};
                    let open =
                        |e: std::io::Error| main_core::node_fs::node_error(&e, "open", &p).message;
                    let mut file =
                        std::fs::File::open(main_core::node_fs::namespaced(&p)).map_err(open)?;
                    let size = file.metadata().map_err(|e| e.to_string())?.len() as f64;
                    let mut buf = Vec::with_capacity((to - from) as usize);
                    file.seek(SeekFrom::Start(from as u64))
                        .map_err(|e| e.to_string())?;
                    file.take((to - from) as u64)
                        .read_to_end(&mut buf)
                        .map_err(|e| main_core::node_fs::node_error_fd(&e, "read").message)?;
                    Ok((buf, size, state))
                },
                move |result| match result {
                    Ok((data, size, state)) => {
                        ed.remember_disk_state(view, &path, state);
                        reply.reply(Ok(obj([
                            ("data", u8_array(data)),
                            ("fileSize", size.into_ipc()),
                        ])))
                    }
                    Err(m) => reply.reply(Err(error(m))),
                },
            );
        },
    ));

    // untitled working copies live in the app's temp folder and need no watch
    let e = ed.clone();
    all.push(kit::invoke("pdf:watch-disk-file", move |cx, args| {
        let view = cx.sender.view;
        let Some(path) = e
            .granted(view, args.get(0))
            .filter(|p| !e.is_untitled_copy(p))
        else {
            return Ok(false.into_ipc());
        };
        e.watch_view_file(view, &path);
        Ok(true.into_ipc())
    }));

    let e = ed.clone();
    all.push(kit::invoke(
        "pdf:discard-for-disk-reload",
        move |cx, args| {
            let view = cx.sender.view;
            let Some(path) = e.granted(view, args.get(0)) else {
                return Ok(false.into_ipc());
            };
            e.rec.borrow_mut().discarded_for_disk(view, &path);
            Ok(true.into_ipc())
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke("pdf:is-untitled", move |cx, args| {
        let yes = e
            .granted(cx.sender.view, args.get(0))
            .is_some_and(|p| e.st.borrow().untitled.contains(&p));
        Ok(yes.into_ipc())
    }));

    let e = ed.clone();
    all.push(kit::invoke("pdf:is-untitled-copy", move |cx, args| {
        let yes = e
            .granted(cx.sender.view, args.get(0))
            .is_some_and(|p| e.is_untitled_copy(&p));
        Ok(yes.into_ipc())
    }));

    let e = ed.clone();
    all.push(kit::invoke("pdf:auto-rename", move |cx, args| {
        let view = cx.sender.view;
        let not = || Ok(obj([("renamed", false.into_ipc())]));
        let Some(path) = e.granted(view, args.get(0)) else {
            return not();
        };
        // only shell-created blanks still carrying their untitled name
        if !e.st.borrow().untitled.contains(&path) {
            return not();
        }
        let Some(base) = args.str(1).and_then(sanitize_auto_rename_base) else {
            return not();
        };
        let dir = dirname(&path);
        let mut target = None;
        for suffix in 1..=10_000 {
            let name = if suffix == 1 {
                format!("{base}.pdf")
            } else {
                format!("{base}-{suffix}.pdf")
            };
            let candidate = join(&[&dir, &name]);
            // the file does not occupy its own name
            if candidate == path {
                return not();
            }
            match move_pdf_file_no_clobber(&path, &candidate) {
                NoClobber::Moved => {
                    target = Some(candidate);
                    break;
                }
                NoClobber::Failed => {
                    eprintln!("[pdf] auto-rename failed");
                    return not();
                }
                NoClobber::Occupied => {}
            }
        }
        let Some(target) = target else { return not() };
        e.grant_only(view, &target);
        {
            let mut st = e.st.borrow_mut();
            let v = st.views.entry(view).or_default();
            if v.open_path.as_deref() == Some(path.as_str()) {
                v.open_path = Some(target.clone());
            }
            st.untitled.remove(&path);
            if st.unsaved_blank.remove(&path) {
                st.unsaved_blank.insert(target.clone());
            }
        }
        e.rec.borrow_mut().renamed(view, &path, &target);
        e.move_disk_state(view, &path, &target);
        if let Err(err) = e.shell.renamed(view, &path, &target) {
            eprintln!("[pdf] auto-rename hook failed: {err}");
        }
        Ok(obj([
            ("renamed", true.into_ipc()),
            ("path", target.as_str().into_ipc()),
            ("name", basename(&target, None).into_ipc()),
        ]))
    }));

    // only the view's own file, and only a task the menu offers
    let e = ed.clone();
    all.push(kit::invoke("pdf:open-in-pdf-tools", move |cx, args| {
        let Some(path) = e.granted(cx.sender.view, args.get(0)) else {
            return Ok(false.into_ipc());
        };
        let Some(tool) = args.str(1).filter(|t| PDF_TOOLS_HANDOFF.contains(t)) else {
            return Ok(false.into_ipc());
        };
        Ok(e.shell
            .open_pdf_tools(&path, tool)
            .unwrap_or(false)
            .into_ipc())
    }));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:create-document",
        move |cx, args, reply| {
            let view = cx.sender.view;
            if !e.registered(view) {
                return reply.reply(Ok(super::failed(
                    "pdf: sender is not a registered PDF view",
                )));
            }
            let Some(parsed) = parse_create_document_request(args.get(0)) else {
                return reply.reply(Ok(super::failed("pdf: invalid create-document request")));
            };
            let shell = e.shell.clone();
            kit::on_worker(
                &e.services,
                move || shell.create_document(&parsed, view),
                move |created| {
                    reply.reply(Ok(match created {
                        None => super::failed("pdf: document creation is unavailable in this host"),
                        Some(Ok(result)) => result,
                        Some(Err(m)) => super::failed(m),
                    }))
                },
            );
        },
    ));

    // the request carries text parts, never a path (reading-assist 4.9)
    let e = ed.clone();
    all.push(kit::invoke("pdf:note-open", move |cx, args| {
        let view = cx.sender.view;
        if !e.registered(view) {
            return Ok(obj([
                ("ok", false.into_ipc()),
                ("reason", "failed".into_ipc()),
            ]));
        }
        let request = parse_note_open_request(kit::to_js_json(args.get(0)).as_ref());
        let path = e.open_path(view);
        note_result(
            e.notes
                .open(&NoteDeps::new(&e), view.0 as f64, path.as_deref(), &request),
        )
    }));

    let e = ed.clone();
    all.push(kit::invoke("pdf:note-unsaved", move |cx, _| {
        let unsaved = match e.open_path(cx.sender.view) {
            None => true,
            Some(p) => e.st.borrow().unsaved_blank.contains(&p),
        };
        Ok(unsaved.into_ipc())
    }));

    let e = ed.clone();
    all.push(kit::invoke("pdf:note-insert", move |cx, args| {
        let view = cx.sender.view;
        if !e.registered(view) {
            return Ok(obj([
                ("ok", false.into_ipc()),
                ("reason", "failed".into_ipc()),
            ]));
        }
        let Some(request) = parse_note_insert_request(kit::to_js_json(args.get(0)).as_ref()) else {
            return Ok(obj([
                ("ok", false.into_ipc()),
                ("reason", "failed".into_ipc()),
                ("message", "invalid request".into_ipc()),
            ]));
        };
        let path = e.open_path(view);
        note_result(
            e.notes
                .insert(&NoteDeps::new(&e), view.0 as f64, path.as_deref(), &request),
        )
    }));

    let e = ed.clone();
    all.push(kit::send("pdf:dirty-changed", move |cx, args| {
        let dirty = args.bool(0) == Some(true);
        e.with_view(cx.sender.view, |v| v.dirty = dirty);
        Ok(())
    }));

    all
}
