//! Opening a document: `prepareDocumentForOpen` (a legacy .doc converted to
//! a .docx copy first), `loadDocx` (password, size, recovery copy, lazy
//! pictures, grants), the channels that open (`docs:open`, `docs:open-path`,
//! `docs:open-decrypt`, `docs:consume-*`), `docs:recent`, the headless
//! export's two channels, and the shell's calls that send `docs:opened`.
//!
//! `loadDocx` runs in three parts: a worker reads, sizes, decrypts and
//! archives the file; the core thread shows the errors and the recovery
//! prompt (a dialog); a worker decrypts or checks the restored copy and
//! hands the bytes off; the core thread records the grants.

use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};

use jscompat::JsonValue;
use jscompat::node_path::host::{dirname, join, resolve};
use main_core::docs::doc_format::{
    DocFormat, doc_format_of_path, is_odt_package, recovery_ext_for,
};
use main_core::packages::electron_utils::legacy_import_prefs::{
    read_legacy_import_skip, write_legacy_import_skip,
};
use main_core::packages::electron_utils::recovery_contract::RecoveryOpenDecision;
use main_core::packages::electron_utils::recovery_prompt::{
    RecoveryOpenResult, ResolveRecoveryOnOpenOptions, resolve_recovery_on_open,
};
use main_core::packages::electron_utils::recovery_store::{RecoveryCopyState, RecoveryIdentity};
use shell_contract::hosts::MessageBox;
use shell_contract::ipc::{Reply, Responder, Target};
use shell_contract::{IpcValue, ViewId, WindowId};

use super::adapters::{HostMessageBox, Parent, picked_path};
use super::hosts::{DecryptError, basename};
use super::passwords::{OpenKind, docx_open_kind};
use super::recovery::file_identity;
use super::{
    Docs, MAX_OPEN_BYTES, Obj, UntitledOpen, js_filters, js_obj, js_str, read_json, sha256_hex,
    stat,
};
use crate::kit::{self, Entry, IntoIpc};

/// `LEGACY_DOC_LIMITS.maxBytes` of `packages/doc2docx`
const LEGACY_DOC_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// `ORIGINALS_MAX_BYTES`: the cap of the originals archive
const ORIGINALS_MAX_BYTES: u64 = 500 * 1024 * 1024;

/// What `loadDocx` answers
pub(crate) enum Loaded {
    Null,
    NeedsPassword { path: String, name: String },
    Opened(IpcValue),
}

impl Loaded {
    fn into_ipc(self) -> IpcValue {
        match self {
            Loaded::Null => IpcValue::Null,
            Loaded::NeedsPassword { path, name } => Obj::new()
                .set("needsPassword", true)
                .set("path", path)
                .set("name", name)
                .done(),
            Loaded::Opened(v) => v,
        }
    }
}

/// What `loadDocx` throws: the decryption's refusal, or an `Error`'s message
pub(crate) enum LoadError {
    Decrypt(DecryptError),
    Thrown(String),
}

impl LoadError {
    fn message(&self) -> &str {
        match self {
            LoadError::Decrypt(e) => &e.message,
            LoadError::Thrown(m) => m,
        }
    }
}

type LoadThen = Box<dyn FnOnce(Result<Loaded, LoadError>)>;

/// The first part of `loadDocx`, on a worker
enum Read {
    Null,
    TooLarge,
    Damaged,
    NeedsPassword,
    Plain {
        encrypted: bool,
        plain: Vec<u8>,
        hash: String,
    },
}

/// `isWord97Path(filePath)`
fn is_word97_path(path: &str) -> bool {
    jscompat::js_regex!(r"\.(doc|dot)$", "i").test(path)
}

static PRUNE_RUNNING: AtomicBool = AtomicBool::new(false);

/// `archiveOriginal(filePath, hash, size)` and its `pruneOriginals`
fn archive_original(user_data: &str, path: &str, hash: &str, size: u64) -> Result<(), String> {
    if size > ORIGINALS_MAX_BYTES {
        return Ok(());
    }
    let dir = join(&[user_data, "originals"]);
    std::fs::create_dir_all(&dir).map_err(|e| super::fs_error(&e, "mkdir", &dir).message)?;
    let target = join(&[&dir, &format!("{hash}{}", recovery_ext_for(path))]);
    if !std::path::Path::new(&target).exists() {
        main_core::node_fs::copy_file(path, &target, false).map_err(|e| e.message)?;
    }
    prune_originals(&dir);
    Ok(())
}

fn prune_originals(dir: &str) {
    if PRUNE_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut files: Vec<(std::path::PathBuf, u64, std::time::SystemTime)> = entries
            .filter_map(Result::ok)
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                meta.is_file().then(|| {
                    (
                        e.path(),
                        meta.len(),
                        meta.modified().unwrap_or(std::time::UNIX_EPOCH),
                    )
                })
            })
            .collect();
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        files.sort_by_key(|f| f.2);
        for (p, size, _) in files {
            if total <= ORIGINALS_MAX_BYTES {
                break;
            }
            if std::fs::remove_file(p).is_ok() {
                total -= size;
            }
        }
    }
    PRUNE_RUNNING.store(false, Ordering::Release);
}

/// `canonicalPath(path)`: through symlinks; a missing name through its folder
fn canonical_path(path: &str) -> String {
    let absolute = resolve(&[path]);
    if let Ok(real) = std::fs::canonicalize(&absolute) {
        return real.to_string_lossy().into_owned();
    }
    match std::fs::canonicalize(dirname(&absolute)) {
        Ok(dir) => join(&[&dir.to_string_lossy(), &basename(&absolute)]),
        Err(_) => absolute,
    }
}

/// `sameFilePath(a, b)`: case is ignored on every platform
fn same_file_path(a: &str, b: &str) -> bool {
    canonical_path(a).to_lowercase() == canonical_path(b).to_lowercase()
}

impl Docs {
    /// `prepareDocumentForOpen(filePath, parent)`: `then(None)` cancels the open
    pub(crate) fn prepare_for_open(
        self: &Rc<Self>,
        view: ViewId,
        path: String,
        parent: Option<WindowId>,
        then: Box<dyn FnOnce(Option<String>)>,
    ) {
        if !is_word97_path(&path) {
            return then(Some(path));
        }
        if let Ok((_, size)) = stat(&path)
            && size as u64 > LEGACY_DOC_MAX_BYTES
        {
            let mb = (LEGACY_DOC_MAX_BYTES / 1024 / 1024).to_string();
            let detail = format!(
                "{}: {}",
                basename(&path),
                self.tm_with("errTooLarge", &[("mb", &mb)])
            );
            self.show_open_error(parent, detail);
            return then(None);
        }
        let extension = path[path.len().saturating_sub(3)..].to_lowercase();
        let settings = self.user_data(&["app-settings.json"]);
        if !read_legacy_import_skip(&settings, "word97") {
            let answer = self.dialogs.message(
                parent,
                &MessageBox {
                    kind: Some("warning".into()),
                    message: self.tm_with("docImportMsg", &[("ext", &extension)]),
                    detail: Some(self.tm("docImportDetail")),
                    buttons: vec![self.tm("docImportConvertBtn"), self.tm("btnCancel")],
                    default_id: Some(0),
                    cancel_id: Some(1),
                    checkbox_label: Some(self.tm("importSkipConfirm")),
                    ..Default::default()
                },
            );
            if answer.response != 0 {
                return then(None);
            }
            if answer.checkbox_checked {
                // unwritable settings: ask again next time
                let _ = write_legacy_import_skip(&settings, "word97", true);
            }
        }
        let Some(target) = self.pick_legacy_import_target(view, &path, parent) else {
            return then(None);
        };
        let engine = self.engine.clone();
        let docs = Rc::clone(self);
        let (source, dest) = (path.clone(), target.clone());
        kit::on_worker(
            &self.services,
            move || -> Result<(), String> {
                let bytes = std::fs::read(&source).map_err(|e| e.to_string())?;
                let docx = engine.convert_legacy_doc(bytes)?;
                main_core::docs::atomic_write::atomic_write_file(&dest, &docx)
                    .map_err(|e| e.message)
            },
            move |result| match result {
                Ok(()) => then(Some(target)),
                Err(_) => {
                    if parent.is_some() {
                        let detail = format!("{}: {}", basename(&path), docs.tm("errUnreadable"));
                        docs.show_open_error(parent, detail);
                    }
                    then(None)
                }
            },
        );
    }

    /// `pickLegacyImportTarget(sourcePath, parent)`
    fn pick_legacy_import_target(
        &self,
        view: ViewId,
        source: &str,
        parent: Option<WindowId>,
    ) -> Option<String> {
        let mut default_path = join(&[
            &dirname(source),
            &jscompat::js_regex!(r"\.(doc|dot)$", "i")
                .replace_all(&basename(source), |_| ".docx".to_owned()),
        ]);
        loop {
            let result = self.save_dialog_in_default_dir(
                view,
                js_obj(vec![
                    ("title", js_str(self.tm("dlgSaveAs"))),
                    ("defaultPath", js_str(default_path.clone())),
                    (
                        "filters",
                        js_filters(&[(self.tm("filterWord"), vec!["docx"])]),
                    ),
                ]),
            );
            let picked = picked_path(&result, "filePath")?;
            if same_file_path(&picked, source) {
                self.show_open_error(parent, self.tm("docImportOriginalTarget"));
                continue;
            }
            if doc_format_of_path(&picked) == Some(DocFormat::Docx) {
                return Some(picked);
            }
            let target = format!("{picked}.docx");
            if !std::path::Path::new(&target).exists() {
                return Some(target);
            }
            // offered under its full name, replacing the file there is the user's answer
            default_path = target;
        }
    }

    /// `loadDocx(filePath, wcId, password)`
    pub(crate) fn load_docx(
        self: &Rc<Self>,
        view: ViewId,
        path: String,
        password: Option<String>,
        then: LoadThen,
    ) {
        let Some(format) = doc_format_of_path(&path) else {
            return then(Ok(Loaded::Null));
        };
        let password = password.or_else(|| self.passwords.borrow().password_for(view, Some(&path)));
        let engine = self.engine.clone();
        let headless = self.shell.is_headless();
        let user_data = self.user_data(&[]);
        let docs = Rc::clone(self);
        let source = path.clone();
        let pw = password.clone();
        kit::on_worker(
            &self.services,
            move || -> Result<Read, LoadError> {
                if !std::path::Path::new(&source).exists() {
                    return Ok(Read::Null);
                }
                let size = stat(&source).map_err(|e| LoadError::Thrown(e.message))?.1 as u64;
                let lazy = (format == DocFormat::Docx)
                    .then(|| engine.open_lazy_docx(&source, view))
                    .flatten();
                if lazy.as_ref().map_or(size, |l| l.bytes.len() as u64) > MAX_OPEN_BYTES {
                    return Ok(Read::TooLarge);
                }
                let (original, lazy_hash) = match lazy {
                    Some(l) => (l.bytes, Some(l.hash)),
                    None => (
                        std::fs::read(&source).map_err(|e| {
                            LoadError::Thrown(super::fs_error(&e, "open", &source).message)
                        })?,
                        None,
                    ),
                };
                let kind = if format == DocFormat::Docx {
                    docx_open_kind(&original)
                } else {
                    OpenKind::Plain
                };
                if kind == OpenKind::Damaged {
                    return Ok(Read::Damaged);
                }
                let encrypted = kind == OpenKind::Encrypted;
                let hash = lazy_hash.unwrap_or_else(|| sha256_hex(&original));
                let plain = if encrypted {
                    let Some(pw) = pw else {
                        return Ok(Read::NeedsPassword);
                    };
                    engine
                        .decrypt_docx(&original, &pw)
                        .map_err(LoadError::Decrypt)?
                } else {
                    original
                };
                if !headless {
                    archive_original(&user_data, &source, &hash, size)
                        .map_err(LoadError::Thrown)?;
                }
                Ok(Read::Plain {
                    encrypted,
                    plain,
                    hash,
                })
            },
            move |read| match read {
                Err(e) => then(Err(e)),
                Ok(Read::Null) => then(Ok(Loaded::Null)),
                Ok(Read::TooLarge) => {
                    let mb = (MAX_OPEN_BYTES / 1024 / 1024).to_string();
                    let detail = format!(
                        "{}: {}",
                        basename(&path),
                        docs.tm_with("errTooLarge", &[("mb", &mb)])
                    );
                    docs.show_open_error(docs.parent(view), detail);
                    then(Ok(Loaded::Null))
                }
                Ok(Read::Damaged) => {
                    let detail = format!("{}: {}", basename(&path), docs.tm("errUnreadable"));
                    docs.show_open_error(docs.parent(view), detail);
                    then(Ok(Loaded::Null))
                }
                Ok(Read::NeedsPassword) => then(Ok(Loaded::NeedsPassword {
                    name: basename(&path),
                    path,
                })),
                Ok(Read::Plain {
                    encrypted,
                    plain,
                    hash,
                }) => {
                    let disk_password = if encrypted { password } else { None };
                    docs.passwords
                        .borrow_mut()
                        .remember(view, &path, disk_password.as_deref());
                    match docs.resolve_open(view, &path) {
                        Err(e) => then(Err(LoadError::Thrown(e))),
                        Ok(restored) => docs.finish_load(
                            view,
                            path,
                            format,
                            encrypted,
                            plain,
                            hash,
                            restored,
                            disk_password,
                            then,
                        ),
                    }
                }
            },
        );
    }

    /// `docsRecovery.resolveOpen`: the restored copy's bytes, or `None` for the file
    fn resolve_open(&self, view: ViewId, path: &str) -> Result<Option<Vec<u8>>, String> {
        if self.shell.is_headless() {
            return Ok(None);
        }
        let decision = self
            .open_decisions
            .get(view)
            .filter(|(p, _)| p == path)
            .map(|(_, d)| d);
        if decision.is_some() {
            self.open_decisions.remove(view);
        }
        let identity = file_identity(path);
        let parent = self.parent(view).map(Parent);
        let lang = self.lang();
        self.with_store(|store| {
            store.clear_discarded(&identity).map_err(|e| e.message)?;
            match decision {
                Some(RecoveryOpenDecision::Original) => Ok(None),
                Some(RecoveryOpenDecision::Restore) => {
                    let Some(bytes) = store.read_copy(&identity) else {
                        return Ok(None);
                    };
                    store.mark_copy_loaded(&identity).map_err(|e| e.message)?;
                    Ok(Some(bytes))
                }
                None => {
                    let name = basename(path);
                    let result = resolve_recovery_on_open(&ResolveRecoveryOnOpenOptions {
                        store,
                        identity: &identity,
                        dialog: &HostMessageBox(&self.dialogs),
                        parent: parent.as_ref(),
                        lang: lang.as_str(),
                        document_name: Some(&name),
                    })
                    .map_err(|e| e.message)?;
                    Ok(match result {
                        RecoveryOpenResult::Original => None,
                        RecoveryOpenResult::Restore { bytes, .. } => Some(bytes),
                    })
                }
            }
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_load(
        self: &Rc<Self>,
        view: ViewId,
        path: String,
        format: DocFormat,
        encrypted: bool,
        plain: Vec<u8>,
        hash: String,
        restored: Option<Vec<u8>>,
        disk_password: Option<String>,
        then: LoadThen,
    ) {
        let engine = self.engine.clone();
        let docs = Rc::clone(self);
        let source = path.clone();
        kit::on_worker(
            &self.services,
            move || {
                let mut recovered = restored.is_some();
                let mut failed = false;
                let mut bytes = restored.unwrap_or_else(|| plain.clone());
                // a copy of a protected document is encrypted too; an unreadable one falls back
                if encrypted && docx_open_kind(&bytes) != OpenKind::Plain {
                    let decrypted = match &disk_password {
                        Some(pw) => engine.decrypt_docx(&bytes, pw).ok(),
                        None => None,
                    };
                    match decrypted {
                        Some(b) => bytes = b,
                        None => {
                            bytes = plain.clone();
                            recovered = false;
                            failed = true;
                        }
                    }
                }
                // a copy under an ODT's path must be the ODT itself
                if recovered && format == DocFormat::Odt && !is_odt_package(&bytes) {
                    bytes = plain;
                    recovered = false;
                    failed = true;
                }
                if recovered && format == DocFormat::Docx {
                    engine.adopt_lazy_media_hashes(&bytes, &source, view);
                }
                let disk = stat(&source).ok();
                (engine.hand_off_bytes(bytes), recovered, failed, disk)
            },
            move |(data_url, recovered, failed, disk)| {
                if failed {
                    docs.with_store(|store| {
                        let _ =
                            store.set_copy_state(&file_identity(&path), RecoveryCopyState::Later);
                    });
                }
                docs.push_recent(&path);
                docs.allow_doc_write(view, &path);
                docs.remember_open_doc(view, &path);
                docs.shell.file_opened(view, &path);
                docs.passwords
                    .borrow_mut()
                    .mark_encrypted(view, &path, encrypted);
                docs.remember_disk(view, &path, hash.clone(), disk);
                then(Ok(Loaded::Opened(
                    Obj::new()
                        .set("name", basename(&path))
                        .set("dataUrl", data_url)
                        .set("hash", hash)
                        .set("encrypted", encrypted)
                        .set(
                            "recovered",
                            if recovered {
                                IpcValue::Bool(true)
                            } else {
                                IpcValue::Undefined
                            },
                        )
                        .prepend("path", path)
                        .done(),
                )))
            },
        );
    }

    /// `prepareDocumentForOpen` then `loadDocx`, answering the invoke
    fn open_into(self: &Rc<Self>, view: ViewId, path: String, responder: Responder) {
        let docs = Rc::clone(self);
        self.prepare_for_open(
            view,
            path,
            self.parent(view),
            Box::new(move |prepared| match prepared {
                None => responder.reply(Ok(IpcValue::Null)),
                Some(path) => docs.load_docx(
                    view,
                    path,
                    None,
                    Box::new(move |r| responder.reply(load_reply(r))),
                ),
            }),
        );
    }

    /// `openResultFor(contents, result)`
    fn send_opened(&self, view: ViewId, result: IpcValue) {
        if result == IpcValue::Null || !self.alive(view) {
            return;
        }
        self.services
            .events
            .emit(Target::View(view), "docs:opened", vec![result]);
    }

    /// `openDocsFileWithDecision(contents, request)`: the shell answered the
    /// recovery question already (launch list)
    pub(crate) fn open_file_with_decision(
        self: &Rc<Self>,
        view: ViewId,
        path: String,
        decision: RecoveryOpenDecision,
    ) {
        if !self.alive(view) || doc_format_of_path(&path).is_none() {
            return;
        }
        self.open_decisions.insert(view, (path.clone(), decision));
        if !self.booted.borrow().contains(&view) {
            self.window_opens.insert(view, path);
            return;
        }
        let docs = Rc::clone(self);
        self.load_docx(
            view,
            path,
            None,
            Box::new(move |r| match r {
                Ok(loaded) => docs.send_opened(view, loaded.into_ipc()),
                Err(e) => docs
                    .dialogs
                    .error(&docs.tm("dlgOpenDoc"), &super::error_text(e.message())),
            }),
        );
    }

    /// `openDocsUntitledCopy(contents, request)`: a copy loads as an untitled document
    pub(crate) fn open_untitled_copy(
        self: &Rc<Self>,
        view: ViewId,
        copy: RecoveryIdentity,
        title: String,
        save_as_default_path: Option<String>,
    ) {
        if !self.alive(view) || copy.kind() != "docs" {
            return;
        }
        let loading = self.take_untitled_copy(view, &copy, &title, save_as_default_path);
        if !self.booted.borrow().contains(&view) {
            // the renderer's first-document request takes it
            self.pending_untitled.insert(view, loading);
            return;
        }
        if let Some((fields, bytes)) = loading {
            let result = with_data_url(fields, self.engine.hand_off_bytes(bytes));
            self.send_opened(view, result);
        }
    }

    /// `takeDocsUntitledCopy(contents, request)`
    fn take_untitled_copy(
        &self,
        view: ViewId,
        copy: &RecoveryIdentity,
        title: &str,
        save_as_default_path: Option<String>,
    ) -> Option<UntitledOpen> {
        let ext = match copy {
            RecoveryIdentity::File(f) => recovery_ext_for(&f.file_path),
            RecoveryIdentity::Untitled(u) if u.ext == ".odt" => ".odt",
            RecoveryIdentity::Untitled(_) => ".docx",
        };
        self.with_store(|store| {
            let (bytes, identity) =
                self.book
                    .borrow_mut()
                    .take_untitled_copy(store, view, copy, title, ext, |b| {
                        docx_open_kind(b) == OpenKind::Plain
                    })?;
            if !self.alive(view) {
                return None;
            }
            let as_identity = RecoveryIdentity::Untitled(identity.clone());
            let info = store.copy_info(&as_identity).ok().flatten();
            let title = if !title.is_empty() {
                title.to_owned()
            } else if let Some(t) = info
                .as_ref()
                .map(|i| i.title.clone())
                .filter(|t| !t.is_empty())
            {
                t
            } else {
                identity.untitled_id.chars().take(8).collect()
            };
            let want = if ext == ".odt" {
                DocFormat::Odt
            } else {
                DocFormat::Docx
            };
            let named = |candidate: &str| -> String {
                let format = doc_format_of_path(candidate);
                if format == Some(want) {
                    return candidate.to_owned();
                }
                // the bytes are a docx draft of an ODT tab: never the .odt it came from
                let stem = match (format, candidate.rfind('.')) {
                    (Some(_), Some(dot)) => &candidate[..dot],
                    _ => candidate,
                };
                format!("{stem}{ext}")
            };
            let origin = save_as_default_path.or_else(|| info.and_then(|i| i.original_path));
            let name = named(&origin.as_deref().map_or(title, basename));
            let mut fields = Obj::new()
                .set("path", name.clone())
                .set("name", name)
                .set("dataUrl", "")
                .set("hash", "")
                .set("untitledCopy", true)
                .set("recovered", true);
            if let Some(origin) = origin {
                fields = fields.set("saveAsDefaultPath", origin);
            }
            Some((fields.0, bytes))
        })
    }
}

impl Obj {
    /// the key first, as the literal writes it
    fn prepend(mut self, key: &str, value: impl IntoIpc) -> Self {
        self.0.insert(0, (key.to_owned(), value.into_ipc()));
        self
    }
}

/// `{ ...result, dataUrl }`: the spread keeps the key where it was
fn with_data_url(mut fields: Vec<(String, IpcValue)>, url: String) -> IpcValue {
    for (k, v) in &mut fields {
        if k == "dataUrl" {
            *v = IpcValue::String(url.clone());
        }
    }
    IpcValue::Object(fields)
}

/// What an invoke that returned `loadDocx(...)` answers
fn load_reply(r: Result<Loaded, LoadError>) -> Reply {
    match r {
        Ok(loaded) => Ok(loaded.into_ipc()),
        Err(e) => Err(kit::error(e.message())),
    }
}

pub(super) fn entries(docs: &Rc<Docs>) -> Vec<Entry> {
    let mut all = Vec::new();

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:open",
        move |cx, _args, responder| {
            let view = cx.sender.view;
            let filters = js_filters(&[
                (d.tm("filterSupported"), vec!["docx", "odt", "doc", "dot"]),
                (d.tm("filterWord"), vec!["docx", "doc", "dot"]),
                (d.tm("filterOdt"), vec!["odt"]),
            ]);
            let result = d.open_dialog(
                view,
                js_obj(vec![
                    ("title", js_str(d.tm("dlgOpenDoc"))),
                    ("filters", filters),
                    ("properties", JsonValue::Array(vec![js_str("openFile")])),
                ]),
            );
            match picked_path(&result, "filePaths") {
                None => responder.reply(Ok(IpcValue::Null)),
                Some(path) => d.open_into(view, path, responder),
            }
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:open-path",
        move |cx, args, responder| {
            // no allowlist: the renderer names the file (loadDocx refuses other formats)
            match args.str(0) {
                Some(path) => d.open_into(cx.sender.view, path.to_owned(), responder),
                // loadDocx's `typeof filePath === 'string'` check
                None => responder.reply(Ok(IpcValue::Null)),
            }
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:open-decrypt",
        move |cx, args, responder| {
            let (Some(path), Some(password)) = (args.str(0), args.str(1).filter(|p| !p.is_empty()))
            else {
                return responder.reply(Ok(decrypt_failed("error", "invalid arguments")));
            };
            d.load_docx(
                cx.sender.view,
                path.to_owned(),
                Some(password.to_owned()),
                Box::new(move |r| {
                    responder.reply(Ok(match r {
                        Ok(Loaded::Null) => decrypt_failed("error", "file not found"),
                        // the file was swapped for a plain docx between prompt and submit
                        Ok(Loaded::NeedsPassword { .. }) => {
                            decrypt_failed("error", "not encrypted")
                        }
                        Ok(Loaded::Opened(result)) => {
                            Obj::new().set("ok", true).set("result", result).done()
                        }
                        Err(LoadError::Decrypt(e)) => decrypt_failed(e.reason, &e.message),
                        Err(LoadError::Thrown(m)) => {
                            decrypt_failed("error", &super::error_text(&m))
                        }
                    }))
                }),
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:consume-pending-open",
        move |cx, _args, responder| {
            let view = cx.sender.view;
            // in the shell every tab's document is queued for it (no argv fallback)
            match d.window_opens.remove(view) {
                None => responder.reply(Ok(IpcValue::Null)),
                Some(path) => d.open_into(view, path, responder),
            }
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke("docs:consume-new-blank", move |cx, _args| {
        Ok(d.new_blank.borrow_mut().remove(&cx.sender.view).into_ipc())
    }));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:consume-copy",
        move |cx, _args, responder| {
            let view = cx.sender.view;
            // from now on a document for this renderer goes out as docs:opened
            d.booted.borrow_mut().insert(view);
            if let Some(restoring) = d.pending_untitled.remove(view)
                && let Some((fields, bytes)) = restoring
                && d.alive(view)
            {
                let url = d.engine.hand_off_bytes(bytes);
                return responder.reply(Ok(with_data_url(fields, url)));
            }
            let copy = d.doc_copies.remove(view);
            let Some((path, name)) = copy.filter(|(_, name)| doc_format_of_path(name).is_some())
            else {
                return responder.reply(Ok(IpcValue::Null));
            };
            let engine = d.engine.clone();
            kit::on_worker(
                &d.services,
                move || {
                    let (_, size) = stat(&path).ok()?;
                    if size as u64 > MAX_OPEN_BYTES {
                        return None;
                    }
                    let bytes = std::fs::read(&path).ok()?;
                    Some(engine.hand_off_bytes(bytes))
                },
                move |url| {
                    responder.reply(Ok(match url {
                        None => IpcValue::Null,
                        Some(url) => Obj::new()
                            .set("path", name.clone())
                            .set("name", name)
                            .set("dataUrl", url)
                            .set("hash", "")
                            .set("untitledCopy", true)
                            .done(),
                    }))
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke(
        "docs:consume-headless-export",
        move |cx, _args| {
            Ok(match d.headless_targets.remove(cx.sender.view) {
                None => IpcValue::Null,
                Some((out_path, format)) => Obj::new()
                    .set("outPath", out_path)
                    .set("format", format)
                    .done(),
            })
        },
    ));

    let d = docs.clone();
    all.push(kit::send("docs:headless-export-done", move |cx, args| {
        let settle = d.headless_waiters.borrow_mut().remove(&cx.sender.view);
        if let Some(settle) = settle {
            let state = args.get(0);
            let ok = kit::field(state, "ok") == &IpcValue::Bool(true);
            let error = kit::as_str(kit::field(state, "error")).map(str::to_owned);
            settle(if ok {
                Ok(())
            } else {
                Err(error.unwrap_or_else(|| "docs export failed".into()))
            });
        }
        Ok(())
    }));

    let d = docs.clone();
    all.push(kit::invoke("docs:recent", move |_cx, _args| {
        Ok(match read_json(&d.recent_path()) {
            Some(v) => kit::from_js_json(&v),
            None => IpcValue::Array(Vec::new()),
        })
    }));

    all
}

/// `{ ok: false, reason, error }` of `docs:open-decrypt`
fn decrypt_failed(reason: &str, error: &str) -> IpcValue {
    Obj::new()
        .set("ok", false)
        .set("reason", reason)
        .set("error", error)
        .done()
}

impl Docs {
    /// `exportDocsHeadless(input, outPath, format, timeoutMs)` up to its
    /// window: the shell made the hidden view `view`; its renderer takes the
    /// document and the target from the queues, and `then` gets the report
    pub(crate) fn begin_headless_export(
        self: &Rc<Self>,
        view: ViewId,
        input: String,
        out_path: String,
        format: &str,
        timeout: std::time::Duration,
        then: Box<dyn FnOnce(Result<(), String>)>,
    ) {
        self.window_opens.insert(view, input);
        self.headless_targets
            .insert(view, (out_path.clone(), format.to_owned()));
        self.allow_pdf_write(view, &out_path);
        let docs = Rc::clone(self);
        let ms = timeout.as_millis();
        let timer = kit::after(&self.services, timeout, move || {
            let waiter = docs.headless_waiters.borrow_mut().remove(&view);
            if let Some(settle) = waiter {
                settle(Err(format!("docs export timed out after {ms}ms")));
            }
        });
        let docs = Rc::clone(self);
        self.headless_waiters.borrow_mut().insert(
            view,
            Box::new(move |report| {
                kit::clear(timer);
                docs.headless_targets.remove(view);
                docs.window_opens.remove(view);
                then(report)
            }),
        );
    }
}
