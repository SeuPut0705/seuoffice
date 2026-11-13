//! The save family (`docs:save`, `docs:save-as-pick`, `docs:save-as`,
//! `docs:save-new`, `docs:save-into-project`, `docs:save-to`), the crash
//! recovery copy (`docs:write-recovery`, `docs:write-recovery-now-done`),
//! the password intents and the small dialogs around a save.
//!
//! The bytes are prepared (`prepareDocSave`: pictures put back, the open
//! password applied) and written on a worker. The TypeScript re-checked the
//! tab's teardown after each await of that work; here the work of one
//! worker is one step, so the checks fall where the worker comes back.

use std::rc::Rc;

use jscompat::node_path::host::{dirname, is_absolute, join};
use main_core::docs::atomic_write::atomic_write_file;
use main_core::docs::doc_format::{
    DocFormat, PreparedSave, RecoveryBytesDeps, SaveBytesDeps, doc_format_of_path,
    prepare_recovery_bytes, prepare_save_bytes,
};
use main_core::docs::external_change::is_externally_modified;
use main_core::docs::save_as_formats::{
    SaveAsKind, save_as_default_path, save_as_filters, save_as_target,
};
use main_core::packages::electron_utils::dialog_memory::save_as_suggestion;
use main_core::packages::electron_utils::marked_odt::{
    MarkedOdtText, marked_odt_box, marked_odt_choice,
};
use shell_contract::hosts::MessageBox;
use shell_contract::ipc::Responder;
use shell_contract::{IpcValue, ViewId};

use super::adapters::picked_path;
use super::hosts::{DocsEngineHost, basename};
use super::passwords::Snapshot;
use super::recovery::{CopyResult, CopyTarget, write_copy};
use super::{
    Docs, Obj, array_buffer, error_text, failed, js_filters, js_obj, js_str, node_text, not_ok,
    sha256_hex, stat,
};
use crate::kit::{self, Entry, IntoIpc};

const NOT_OPENED: &str = "save target is not an opened document";

/// What a write left: what landed, the plain document, the absorbed picture
/// hashes, and the disk state to remember
pub(crate) struct Written {
    hash: String,
    plain: Vec<u8>,
    hashes: Vec<String>,
    encrypted: bool,
    disk: Option<(f64, f64)>,
}

/// `Buffer.from(data)` of a value that is no buffer
fn bad_data(v: &IpcValue) -> String {
    let received = match v {
        IpcValue::Undefined => "undefined".to_owned(),
        IpcValue::Null => "null".to_owned(),
        IpcValue::Bool(b) => format!("type boolean ({b})"),
        IpcValue::Number(n) => format!("type number ({})", jscompat::number_to_string(*n)),
        _ => "an instance of Object".to_owned(),
    };
    format!(
        "TypeError [ERR_INVALID_ARG_TYPE]: The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received {received}"
    )
}

/// The bytes a save writes (`prepareDocSave` past its password snapshot);
/// `Err` is the thrown `Error`'s message
fn prepare(
    engine: &DocsEngineHost,
    format: DocFormat,
    data: &[u8],
    password: Option<&str>,
) -> Result<PreparedSave, String> {
    prepare_save_bytes(
        format,
        data,
        &mut SaveBytesDeps {
            materialize: &mut |b| engine.materialize_lazy_docx(b.to_vec()),
            encrypt: &mut |b, p| engine.encrypt_docx(b, p),
            password,
        },
    )
}

/// `atomicWriteFile` and the stat `rememberDiskState` takes after it
fn write(path: &str, prepared: PreparedSave) -> Result<Written, String> {
    atomic_write_file(path, &prepared.bytes).map_err(|e| node_text(&e))?;
    Ok(written(path, prepared))
}

fn written(path: &str, prepared: PreparedSave) -> Written {
    Written {
        hash: sha256_hex(&prepared.bytes),
        plain: prepared.plain,
        hashes: prepared.hashes,
        encrypted: prepared.encrypted,
        disk: stat(path).ok(),
    }
}

/// `uniquePathIn(dir, fileName)`
pub(crate) fn unique_path_in(dir: &str, file_name: &str) -> String {
    let dot = file_name.rfind('.').filter(|d| *d > 0);
    let base = dot.map_or(file_name, |d| &file_name[..d]);
    let ext = dot.map_or("", |d| &file_name[d..]);
    let mut candidate = join(&[dir, file_name]);
    let mut i = 2;
    while std::path::Path::new(&candidate).exists() {
        candidate = join(&[dir, &format!("{base}-{i}{ext}")]);
        i += 1;
    }
    candidate
}

/// `sanitizeAiDocFileBase(title)`
pub(crate) fn sanitize_file_base(title: &str) -> String {
    let replaced: String = title
        .chars()
        .map(|c| {
            if "/\\:*?\"<>|".contains(c) || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = jscompat::trim(&replaced);
    let cut: String =
        String::from_utf16_lossy(&trimmed.encode_utf16().take(80).collect::<Vec<_>>());
    let cleaned = jscompat::trim(&cut).to_owned();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "Untitled".into()
    } else {
        cleaned
    }
}

/// `text.slice(0, n)` in UTF-16 code units
fn slice_utf16(text: &str, n: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(n).collect::<Vec<_>>())
}

impl Docs {
    /// The password snapshot of `prepareDocSave` (docx only)
    fn snapshot_for(&self, view: ViewId, path: &str, source: Option<&str>) -> Option<Snapshot> {
        (doc_format_of_path(path).unwrap_or(DocFormat::Docx) == DocFormat::Docx)
            .then(|| self.passwords.borrow().snapshot(view, source))
    }

    /// `commitSavePassword(wcId, passwordState, filePath)`
    fn commit_password(&self, view: ViewId, snapshot: &Option<Snapshot>, path: &str) -> bool {
        let mut passwords = self.passwords.borrow_mut();
        match snapshot {
            Some(s) => passwords.commit_save(view, s, path),
            None => {
                passwords.remember(view, path, None);
                passwords.mark_encrypted(view, path, false);
                false
            }
        }
    }

    /// The bookkeeping every save does once its file landed: the disk state,
    /// the lazy pictures, the password; the answer's `passwordIntentPending`
    fn after_write(
        &self,
        view: ViewId,
        path: &str,
        w: &Written,
        snapshot: &Option<Snapshot>,
    ) -> bool {
        self.remember_disk(view, path, w.hash.clone(), w.disk);
        self.engine.point_lazy_media_at(
            &w.hashes,
            path,
            view,
            w.encrypted.then(|| w.plain.clone()),
        );
        self.commit_password(view, snapshot, path)
    }

    /// `{ ok: true, path?, passwordIntentPending, ...reissuedDoc(...) }`
    fn saved_reply(&self, path: Option<String>, pending: bool, w: Written) -> IpcValue {
        let mut reply = Obj::new().set("ok", true);
        if let Some(path) = path {
            reply = reply.set("path", path);
        }
        reply = reply.set("passwordIntentPending", pending);
        // an encrypted save leaves no plain file to serve lazy pictures from
        if w.encrypted && !w.hashes.is_empty() {
            reply = reply.set("dataUrl", self.engine.hand_off_bytes(w.plain));
        }
        reply.done()
    }

    fn note_saved(&self, view: ViewId, paths: &[&str]) {
        self.with_store(|store| self.book.borrow_mut().note_saved(store, view, paths));
    }

    /// `docs:save` past the external-modification check
    fn save_now(self: &Rc<Self>, view: ViewId, path: String, data: IpcValue, responder: Responder) {
        if self.is_torn_down(view) || !self.can_doc_write(view, &path) {
            return responder.reply(Ok(failed(NOT_OPENED)));
        }
        let snapshot = self.snapshot_for(view, &path, Some(&path));
        let password = snapshot.as_ref().and_then(|s| s.password.clone());
        let engine = self.engine.clone();
        let target = path.clone();
        let docs = Rc::clone(self);
        kit::on_worker(
            &self.services,
            move || {
                let bytes = kit::as_bytes(&data).ok_or_else(|| bad_data(&data))?;
                let format = doc_format_of_path(&target).unwrap_or(DocFormat::Docx);
                let prepared = prepare(&engine, format, bytes, password.as_deref())
                    .map_err(|m| error_text(&m))?;
                write(&target, prepared)
            },
            move |result| {
                let w = match result {
                    Err(e) => return responder.reply(Ok(failed(e))),
                    Ok(w) => w,
                };
                // teardown cleared the secrets meanwhile: never resurrect them
                if docs.is_torn_down(view) {
                    return responder.reply(Ok(failed(NOT_OPENED)));
                }
                let pending = docs.after_write(view, &path, &w, &snapshot);
                docs.note_saved(view, &[&path]);
                docs.push_recent(&path);
                responder.reply(Ok(docs.saved_reply(None, pending, w)))
            },
        );
    }
}

pub(super) fn entries(docs: &Rc<Docs>) -> Vec<Entry> {
    let mut all = Vec::new();

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:save",
        move |cx, mut args, responder| {
            let view = cx.sender.view;
            let Some(path) = args
                .str(0)
                .filter(|p| d.can_doc_write(view, p))
                .map(str::to_owned)
            else {
                return responder.reply(Ok(failed(NOT_OPENED)));
            };
            let auto = args.get(2) == &IpcValue::Bool(true);
            let data = args.take(1);
            let recorded = d
                .disk_states
                .with(view, |s| s.and_then(|s| s.get(&path).cloned()));
            let source = path.clone();
            let d2 = d.clone();
            kit::on_worker(
                &d.services,
                move || {
                    let current = stat(&source).ok();
                    is_externally_modified(recorded.as_ref(), current, &mut || {
                        Ok(std::fs::read(&source).ok().map(|b| sha256_hex(&b)))
                    })
                    .unwrap_or(false)
                },
                move |changed| {
                    if changed {
                        let external = Obj::new()
                            .set("ok", false)
                            .set("reason", "external-modified")
                            .done();
                        // autosave never clobbers another program's edits silently
                        if auto {
                            return responder.reply(Ok(external));
                        }
                        let response = d2.message(
                            d2.parent(view),
                            MessageBox {
                                kind: Some("warning".into()),
                                message: d2.tm("extModifiedMsg"),
                                detail: Some(d2.tm("extModifiedDetail")),
                                buttons: vec![d2.tm("btnOverwrite"), d2.tm("btnCancel")],
                                default_id: Some(0),
                                cancel_id: Some(1),
                                ..Default::default()
                            },
                        );
                        if response != 0 {
                            return responder.reply(Ok(external));
                        }
                    }
                    d2.save_now(view, path, data, responder)
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke("docs:save-as-pick", move |cx, args| {
        let view = cx.sender.view;
        if d.is_torn_down(view) {
            return Ok(IpcValue::Null);
        }
        let Some(default_name) = args.str(0) else {
            return Ok(IpcValue::Null);
        };
        let current = if args.str(2) == Some("odt") {
            DocFormat::Odt
        } else {
            DocFormat::Docx
        };
        let exports = args.get(3) == &IpcValue::Bool(true);
        let source = args.str(1);
        let project_dir = if source.is_some_and(|s| !s.is_empty()) || d.open_doc.contains(view) {
            None
        } else {
            d.shell.new_document_dir(view)
        };
        let suggestion = match project_dir.filter(|p| !p.is_empty()) {
            Some(dir) if basename(default_name) == default_name => join(&[&dir, default_name]),
            _ => save_as_suggestion(source, default_name),
        };
        let filters: Vec<(String, Vec<&str>)> = save_as_filters(current, exports, &mut |k| d.tm(k))
            .into_iter()
            .map(|f| (f.name, f.extensions))
            .collect();
        let result = d.save_dialog(
            view,
            js_obj(vec![
                ("title", js_str(d.tm("dlgSaveAs"))),
                (
                    "defaultPath",
                    js_str(save_as_default_path(&suggestion, exports)),
                ),
                ("filters", js_filters(&filters)),
            ]),
        );
        let Some(file_path) = picked_path(&result, "filePath") else {
            return Ok(IpcValue::Null);
        };
        if d.is_torn_down(view) {
            return Ok(IpcValue::Null);
        }
        let (path, kind) = save_as_target(&file_path, current, exports);
        let picked = Obj::new()
            .set("path", path.clone())
            .set("kind", kind.as_str());
        Ok(match kind {
            SaveAsKind::Docx | SaveAsKind::Odt => {
                d.save_as_picks.insert(view, path);
                picked.done()
            }
            SaveAsKind::Png => {
                // the PDF export writes a temp file that is rasterized beside the pick
                let dir = dirname(&path);
                let pdf_path = join(&[
                    &d.temp_dir(),
                    &format!("seuoffice-docs-images-{}.pdf", d.shell.random_uuid()),
                ]);
                d.add_image_export(view, &pdf_path, &dir);
                picked.set("dir", dir).set("pdfPath", pdf_path).done()
            }
            _ => {
                d.allow_pdf_write(view, &path);
                picked.done()
            }
        })
    }));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:save-as",
        move |cx, mut args, responder| {
            let view = cx.sender.view;
            if d.is_torn_down(view) {
                return responder.reply(Ok(not_ok()));
            }
            let Some(path) = args
                .str(0)
                .map(str::to_owned)
                .filter(|p| d.save_as_picks.get(view).as_ref() == Some(p))
            else {
                return responder.reply(Ok(failed("save target was not picked")));
            };
            d.save_as_picks.remove(view);
            let source = args.str(2).filter(|s| !s.is_empty()).map(str::to_owned);
            let snapshot = d.snapshot_for(view, &path, source.as_deref());
            let password = snapshot.as_ref().and_then(|s| s.password.clone());
            let data = args.take(1);
            let engine = d.engine.clone();
            let target = path.clone();
            let d2 = d.clone();
            kit::on_worker(
                &d.services,
                move || {
                    let bytes = kit::as_bytes(&data).ok_or_else(|| bad_data(&data))?;
                    let format = doc_format_of_path(&target).unwrap_or(DocFormat::Docx);
                    prepare(&engine, format, bytes, password.as_deref()).map_err(|m| error_text(&m))
                },
                move |prepared| {
                    let prepared = match prepared {
                        Err(e) => return responder.reply(Ok(failed(e))),
                        Ok(p) => p,
                    };
                    // the tab may have closed meanwhile: Save As may overwrite, so check first
                    if d2.is_torn_down(view) {
                        return responder.reply(Ok(not_ok()));
                    }
                    let target = path.clone();
                    let d3 = d2.clone();
                    kit::on_worker(
                        &d2.services,
                        move || write(&target, prepared),
                        move |result| {
                            let w = match result {
                                Err(e) => return responder.reply(Ok(failed(e))),
                                Ok(w) => w,
                            };
                            if d3.is_torn_down(view) {
                                return responder.reply(Ok(not_ok()));
                            }
                            d3.allow_doc_write(view, &path);
                            d3.remember_open_doc(view, &path);
                            let pending = d3.after_write(view, &path, &w, &snapshot);
                            match &source {
                                Some(s) => d3.note_saved(view, &[&path, s]),
                                None => d3.note_saved(view, &[&path]),
                            }
                            d3.push_recent(&path);
                            let saved = d3.notify_file_saved(view, &path);
                            responder.reply(Ok(d3.saved_reply(Some(saved), pending, w)))
                        },
                    );
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:save-new",
        move |cx, mut args, responder| {
            let view = cx.sender.view;
            if d.is_torn_down(view) {
                return responder.reply(Ok(not_ok()));
            }
            let Some(name) = args.str(0).map(str::to_owned) else {
                return responder.reply(Ok(failed(
                    "TypeError: fileName.lastIndexOf is not a function",
                )));
            };
            let dir = match d.default_save_dir() {
                Ok(dir) => dir,
                Err(e) => return responder.reply(Ok(failed(error_text(&e)))),
            };
            let path = unique_path_in(&dir, &name);
            let snapshot = d.snapshot_for(view, &path, None);
            let password = snapshot.as_ref().and_then(|s| s.password.clone());
            let data = args.take(1);
            let engine = d.engine.clone();
            let target = path.clone();
            let d2 = d.clone();
            kit::on_worker(
                &d.services,
                move || {
                    let bytes = kit::as_bytes(&data).ok_or_else(|| bad_data(&data))?;
                    let format = doc_format_of_path(&target).unwrap_or(DocFormat::Docx);
                    let prepared = prepare(&engine, format, bytes, password.as_deref())
                        .map_err(|m| error_text(&m))?;
                    write(&target, prepared)
                },
                move |result| {
                    let w = match result {
                        Err(e) => return responder.reply(Ok(failed(e))),
                        Ok(w) => w,
                    };
                    // the path is freshly created: rolling it back is safe
                    if d2.is_torn_down(view) {
                        let _ = std::fs::remove_file(&path);
                        return responder.reply(Ok(not_ok()));
                    }
                    d2.allow_doc_write(view, &path);
                    d2.remember_open_doc(view, &path);
                    let pending = d2.after_write(view, &path, &w, &snapshot);
                    d2.note_saved(view, &[&path]);
                    d2.push_recent(&path);
                    let saved = d2.notify_file_saved(view, &path);
                    responder.reply(Ok(d2.saved_reply(Some(saved), pending, w)))
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:save-into-project",
        move |cx, mut args, responder| {
            let view = cx.sender.view;
            let skipped = || Obj::new().set("ok", false).set("skipped", true).done();
            // an orphaned renderer, or a document that has its file already
            if d.is_torn_down(view) || d.open_doc.contains(view) {
                return responder.reply(Ok(skipped()));
            }
            let (Some(default_name), Some(_)) =
                (args.str(0).map(str::to_owned), array_buffer(args.get(2)))
            else {
                return responder.reply(Ok(failed("bad save request")));
            };
            let extension = if args.str(1) == Some("odt") {
                ".odt"
            } else {
                ".docx"
            };
            let named = jscompat::js_regex!(r"\.(docx|odt)$", "i")
                .replace_all(&basename(&default_name.replace('\\', "/")), |_| {
                    String::new()
                });
            let file_name = format!("{}{extension}", sanitize_file_base(&named));
            let snapshot = d.snapshot_for(view, &file_name, None);
            let password = snapshot.as_ref().and_then(|s| s.password.clone());
            let data = args.take(2);
            let engine = d.engine.clone();
            let name = file_name.clone();
            let d2 = d.clone();
            kit::on_worker(
                &d.services,
                move || {
                    let format = doc_format_of_path(&name).unwrap_or(DocFormat::Docx);
                    prepare(
                        &engine,
                        format,
                        kit::as_bytes(&data).unwrap_or_default(),
                        password.as_deref(),
                    )
                },
                move |prepared| {
                    let prepared = match prepared {
                        Err(e) => return responder.reply(Ok(failed(e))),
                        Ok(p) => p,
                    };
                    if d2.is_torn_down(view) {
                        return responder.reply(Ok(not_ok()));
                    }
                    let shell = d2.shell.clone();
                    let d3 = d2.clone();
                    kit::on_worker(
                        &d2.services,
                        move || {
                            let bytes = prepared.bytes.clone();
                            let placed = shell.write_new_document(view, &file_name, bytes)?;
                            Some(placed.map(|p| p.map(|path| (written(&path, prepared), path))))
                        },
                        move |placed| {
                            let (w, path) = match placed {
                                None | Some(Ok(None)) => return responder.reply(Ok(skipped())),
                                Some(Err(e)) => return responder.reply(Ok(failed(e))),
                                Some(Ok(Some(p))) => p,
                            };
                            // the file is freshly created: rolling it back is safe
                            if d3.is_torn_down(view) {
                                let _ = std::fs::remove_file(&path);
                                return responder.reply(Ok(not_ok()));
                            }
                            d3.allow_doc_write(view, &path);
                            d3.remember_open_doc(view, &path);
                            let pending = d3.after_write(view, &path, &w, &snapshot);
                            d3.note_saved(view, &[&path]);
                            d3.push_recent(&path);
                            let saved = d3.notify_file_saved(view, &path);
                            responder.reply(Ok(d3.saved_reply(Some(saved), pending, w)))
                        },
                    );
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:save-to",
        move |cx, mut args, responder| {
            let view = cx.sender.view;
            if d.is_torn_down(view) {
                return responder.reply(Ok(not_ok()));
            }
            let Some(path) = args.str(0).filter(|p| is_absolute(p)).map(str::to_owned) else {
                return responder.reply(Ok(failed("path must be absolute")));
            };
            if doc_format_of_path(&path).is_none() {
                return responder.reply(Ok(failed("path must point to a .docx or .odt file")));
            }
            if !d.can_doc_write(view, &path) {
                return responder.reply(Ok(failed("save target was not authorized")));
            }
            let existed = std::path::Path::new(&path).exists();
            if !kit::truthy(args.get(2)) && existed {
                return responder.reply(Ok(failed(format!(
                    "file already exists: {path} (pass overwrite:true to replace it)"
                ))));
            }
            let snapshot = d.snapshot_for(view, &path, None);
            let password = snapshot.as_ref().and_then(|s| s.password.clone());
            let data = args.take(1);
            let engine = d.engine.clone();
            let target = path.clone();
            let d2 = d.clone();
            kit::on_worker(
                &d.services,
                move || {
                    let dir = dirname(&target);
                    std::fs::create_dir_all(&dir)
                        .map_err(|e| node_text(&super::fs_error(&e, "mkdir", &dir)))?;
                    let bytes = kit::as_bytes(&data).ok_or_else(|| bad_data(&data))?;
                    let format = doc_format_of_path(&target).unwrap_or(DocFormat::Docx);
                    let prepared = prepare(&engine, format, bytes, password.as_deref())
                        .map_err(|m| error_text(&m))?;
                    write(&target, prepared)
                },
                move |result| {
                    let w = match result {
                        Err(e) => return responder.reply(Ok(failed(e))),
                        Ok(w) => w,
                    };
                    // only a file this handler created is safe to roll back
                    if d2.is_torn_down(view) {
                        if !existed {
                            let _ = std::fs::remove_file(&path);
                        }
                        return responder.reply(Ok(not_ok()));
                    }
                    let pending = d2.after_write(view, &path, &w, &snapshot);
                    let previous = d2.open_doc.get(view).filter(|p| *p != path);
                    match &previous {
                        Some(p) => d2.note_saved(view, &[&path, p]),
                        None => d2.note_saved(view, &[&path]),
                    }
                    d2.push_recent(&path);
                    d2.remember_open_doc(view, &path);
                    d2.notify_file_saved(view, &path);
                    responder.reply(Ok(d2.saved_reply(Some(path), pending, w)))
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:write-recovery",
        move |cx, mut args, responder| {
            let view = cx.sender.view;
            if d.is_torn_down(view) || array_buffer(args.get(1)).is_none() {
                return responder.reply(Ok(not_ok()));
            }
            let untitled = args.get(0) == &IpcValue::Null;
            let file_path = args.str(0).map(str::to_owned);
            if !untitled
                && !file_path
                    .as_deref()
                    .is_some_and(|p| d.can_doc_write(view, p))
            {
                return responder.reply(Ok(not_ok()));
            }
            let meta = args.get(2).clone();
            let format = if untitled {
                if kit::field(&meta, "format") == &IpcValue::String("odt".into()) {
                    DocFormat::Odt
                } else {
                    DocFormat::Docx
                }
            } else {
                file_path
                    .as_deref()
                    .and_then(doc_format_of_path)
                    .unwrap_or(DocFormat::Docx)
            };
            let title = kit::as_str(kit::field(&meta, "title"))
                .map_or(String::new(), |t| slice_utf16(t, 260));
            let original_path = kit::as_str(kit::field(&meta, "originalPath"))
                .filter(|p| untitled && !p.is_empty())
                .map(str::to_owned);
            // a headless export's hidden window keeps no copy
            if d.shell.is_headless() {
                return responder.reply(Ok(not_ok()));
            }
            let target = match (&file_path, format) {
                (Some(p), _) if !untitled => CopyTarget::File(p.clone()),
                (_, DocFormat::Odt) => CopyTarget::Untitled(".odt"),
                _ => CopyTarget::Untitled(".docx"),
            };
            let pending = match d.with_store(|store| {
                d.book
                    .borrow_mut()
                    .begin_copy(store, view, &target, &|| d.shell.random_uuid())
            }) {
                Ok(p) => p,
                Err(_) => {
                    return responder
                        .reply(Ok(Obj::new().set("ok", false).set("failed", true).done()));
                }
            };
            // the copy follows the disk's password, never the desired next one: an
            // encrypted file without its password, or a new document waiting for
            // its first password save, skips the tick
            let protect: Result<Option<String>, ()> = match &file_path {
                _ if untitled => {
                    if d.passwords.borrow().snapshot(view, None).password.is_none() {
                        Ok(None)
                    } else {
                        Err(())
                    }
                }
                Some(p) if d.passwords.borrow().is_encrypted(view, p) => d
                    .passwords
                    .borrow()
                    .password_for(view, Some(p))
                    .map(Some)
                    .ok_or(()),
                _ => Ok(None),
            };
            let copy_title = if untitled {
                title
            } else {
                basename(file_path.as_deref().unwrap_or(""))
            };
            let data = args.take(1);
            let engine = d.engine.clone();
            let shared = d.recovery_shared.clone();
            let shell = d.shell.clone();
            let user_data = d.user_data(&[]);
            let original = original_path.clone();
            let d2 = d.clone();
            kit::on_worker(
                &d.services,
                move || {
                    let bytes = prepare_recovery_bytes(
                        format,
                        kit::as_bytes(&data).unwrap_or_default(),
                        &mut RecoveryBytesDeps {
                            materialize: &mut |b| engine.materialize_lazy_docx(b.to_vec()),
                            protect: &mut |plain| match &protect {
                                Err(()) => Ok(None),
                                Ok(None) => Ok(Some(plain.to_vec())),
                                Ok(Some(pw)) => engine.encrypt_docx(plain, pw).map(Some),
                            },
                        },
                    )
                    .map_err(|_| ())?;
                    write_copy(
                        &shared, &user_data, &shell, &pending, bytes, copy_title, original,
                    )
                    .map(|r| (r, pending))
                    .map_err(|_| ())
                },
                move |result| {
                    responder.reply(Ok(match result {
                        Err(()) => Obj::new().set("ok", false).set("failed", true).done(),
                        Ok((CopyResult::Skipped, _)) => not_ok(),
                        Ok((CopyResult::Written, pending)) => {
                            d2.with_store(|store| {
                                d2.book.borrow_mut().copy_written(
                                    store,
                                    view,
                                    &pending.identity,
                                    original_path.as_deref(),
                                )
                            });
                            Obj::new().set("ok", true).done()
                        }
                    }))
                },
            );
        },
    ));

    let d = docs.clone();
    all.push(kit::send(
        "docs:write-recovery-now-done",
        move |_cx, args| {
            if let Some(token) = args.str(0) {
                d.close.recovery_now_done(token);
            }
            Ok(())
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke("docs:set-password", move |cx, args| {
        let view = cx.sender.view;
        if d.is_torn_down(view) {
            return Ok(not_ok());
        }
        let path = match args.get(0) {
            IpcValue::Null => None,
            IpcValue::String(p) => Some(p.as_str()),
            _ => return Ok(not_ok()),
        };
        let password = match args.get(1) {
            IpcValue::Null => None,
            IpcValue::String(p) if !p.is_empty() => Some(p.as_str()),
            _ => return Ok(not_ok()),
        };
        // only the document this renderer has open (the grant of a save)
        if let Some(p) = path.filter(|p| !p.is_empty())
            && !d.can_doc_write(view, p)
        {
            return Ok(not_ok());
        }
        d.passwords.borrow_mut().set(view, path, password);
        Ok(Obj::new().set("ok", true).done())
    }));

    let d = docs.clone();
    all.push(kit::invoke(
        "docs:password-intent-revision",
        move |cx, _args| {
            if d.is_torn_down(cx.sender.view) {
                return Ok((-1.0).into_ipc());
            }
            Ok((d.passwords.borrow().current_revision() as f64).into_ipc())
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke(
        "docs:discard-password-intents",
        move |cx, args| {
            let view = cx.sender.view;
            if d.is_torn_down(view) {
                return Ok(not_ok());
            }
            let Some(through) = args
                .num(0)
                .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 && *n >= 0.0)
            else {
                return Ok(not_ok());
            };
            d.passwords.borrow_mut().discard(view, through as u64);
            Ok(Obj::new().set("ok", true).done())
        },
    ));

    let d = docs.clone();
    all.push(kit::invoke("docs:confirm-marked-odt", move |cx, _args| {
        let view = cx.sender.view;
        if d.is_torn_down(view) {
            return Ok("cancel".into_ipc());
        }
        let b = marked_odt_box(&MarkedOdtText {
            title: d.tm("markedOdtTitle"),
            message: d.tm("markedOdtMessage"),
            detail: d.tm("markedOdtDetail"),
            save_docx: Some(d.tm("markedOdtDocx")),
            clear_marks: d.tm("markedOdtClear"),
            cancel: d.tm("btnCancel"),
        });
        let response = d.message(
            d.parent(view),
            MessageBox {
                kind: Some(b.kind.into()),
                title: Some(b.title),
                message: b.message,
                detail: Some(b.detail),
                buttons: b.buttons,
                default_id: Some(b.default_id as usize),
                cancel_id: Some(b.cancel_id),
                checkbox_label: None,
            },
        );
        let choice = match marked_odt_choice(response as f64, true) {
            main_core::packages::electron_utils::marked_odt::MarkedOdtChoice::Docx => "docx",
            main_core::packages::electron_utils::marked_odt::MarkedOdtChoice::Clear => "clear",
            main_core::packages::electron_utils::marked_odt::MarkedOdtChoice::Cancel => "cancel",
        };
        Ok(choice.into_ipc())
    }));

    let d = docs.clone();
    all.push(kit::invoke_later(
        "docs:materialize-docx",
        move |cx, mut args, responder| {
            if d.is_torn_down(cx.sender.view) || array_buffer(args.get(0)).is_none() {
                return responder.reply(Ok(IpcValue::Null));
            }
            let data = args.take(0);
            let engine = d.engine.clone();
            kit::on_worker(
                &d.services,
                move || {
                    let bytes = kit::as_bytes(&data).unwrap_or_default().to_vec();
                    engine
                        .materialize_lazy_docx(bytes)
                        .ok()
                        .map(|m| engine.hand_off_bytes(m.bytes))
                },
                move |url| {
                    responder.reply(Ok(match url {
                        Some(url) => Obj::new().set("dataUrl", url).done(),
                        None => IpcValue::Null,
                    }))
                },
            );
        },
    ));
    all
}
