//! Saving: in place, Save As copies, redaction copies, untitled copies,
//! restores of a kept copy, the renderer's answers to the main side's
//! requests, and the recovery channels.

use std::rc::Rc;
use std::sync::Arc;

use jscompat::node_path::host::{basename, dirname, join, resolve as path_resolve};
use main_core::packages::electron_utils::save_conflict::{
    SaveConflictAnswer, SaveConflictOptions, confirm_overwrite_if_conflicted, record_disk_state,
    should_defer_auto_save,
};
use main_core::pdf::atomic_write::write_pdf_atomically;
use main_core::pdf::redaction::validate_redaction_regions;
use main_core::shell::recent_files::StatInfo;
use shell_contract::hosts::{FileDialog, FileFilter};
use shell_contract::{BytesKind, IpcError, IpcValue, ViewId};

use super::dialogs::{Boxes, Dlg, Parent, tm};
use super::editors::{SaveAsOutcome, stem};
use super::hosts::{DecryptError, SaveSkips};
use super::recovery::{CopyResult, PendingCopy, pdf_looks_encrypted};
use super::{Editor, NOT_GRANTED, failed, read_file, refused};
use crate::kit::{self, Entry, IntoIpc, field, named_error, obj, truthy, u8_array};
use shell_contract::ipc::Responder;

/// `carriesProtection(request)`
pub(super) fn carries_protection(request: &IpcValue) -> bool {
    field(request, "encryption") != &IpcValue::Undefined
        || field(request, "decryption") != &IpcValue::Undefined
}

/// `{ ...value, key: v }`: an existing key keeps its place
pub(super) fn with_field(value: &IpcValue, key: &str, v: IpcValue) -> IpcValue {
    let mut entries = match value {
        IpcValue::Object(e) => e.clone(),
        _ => Vec::new(),
    };
    match entries.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = v,
        None => entries.push((key.to_owned(), v)),
    }
    IpcValue::Object(entries)
}

/// `isSameRedactionCopyPath(source, target)`: the same file through a
/// symlink, `.`/`..`, or an existing hard link. A new destination is
/// compared through its canonical parent folder.
pub(super) fn is_same_redaction_copy_path(source: &str, target: &str) -> bool {
    let canonical = |path: &str| -> Option<std::path::PathBuf> {
        let absolute = path_resolve(&[path]);
        std::fs::canonicalize(&absolute).ok().or_else(|| {
            let parent = std::fs::canonicalize(dirname(&absolute)).ok()?;
            Some(parent.join(basename(&absolute, None)))
        })
    };
    if canonical(source) == canonical(target) {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(a), Ok(b)) = (std::fs::metadata(source), std::fs::metadata(target)) {
            return a.dev() == b.dev() && a.ino() == b.ino();
        }
    }
    false
}

/// `.length` of a value the TypeScript reads without `?.`: `undefined` and
/// `null` throw as V8 does
fn length(v: &IpcValue, key: &str) -> Result<usize, IpcError> {
    match field(v, key) {
        IpcValue::Undefined | IpcValue::Null => Err(named_error(
            "TypeError",
            format!(
                "Cannot read properties of {} (reading 'length')",
                if field(v, key) == &IpcValue::Null {
                    "null"
                } else {
                    "undefined"
                }
            ),
        )),
        IpcValue::Array(items) => Ok(items.len()),
        IpcValue::String(s) => Ok(s.encode_utf16().count()),
        _ => Ok(0),
    }
}

/// `value?.length` truthy
fn some(v: &IpcValue, key: &str) -> bool {
    match field(v, key) {
        IpcValue::Array(items) => !items.is_empty(),
        IpcValue::String(s) => !s.is_empty(),
        _ => false,
    }
}

/// The edits a redaction save refuses to carry along
fn other_edits(request: &IpcValue) -> Result<bool, IpcError> {
    Ok(length(request, "markups")? > 0
        || some(request, "annotDeletes")
        || length(request, "drawings")? > 0
        || some(request, "noteEdits")
        || length(request, "formValues")? > 0
        || length(request, "stamps")? > 0
        || some(request, "textEdits")
        || some(request, "textInserts")
        || some(request, "imageEdits")
        || some(request, "rotations")
        || some(request, "deletedPages")
        || some(request, "pageOrder")
        || truthy(field(request, "metadata")))
}

/// `{ ok: true, skippedTextEdits?, skippedTextInserts?, skippedImageEdits? }`
fn saved(skips: SaveSkips) -> IpcValue {
    let mut out = vec![("ok".to_owned(), true.into_ipc())];
    for (key, list) in [
        ("skippedTextEdits", skips.text_edits),
        ("skippedTextInserts", skips.text_inserts),
        ("skippedImageEdits", skips.image_edits),
    ] {
        if !list.is_empty() {
            out.push((key.to_owned(), IpcValue::Array(list)));
        }
    }
    IpcValue::Object(out)
}

impl Editor {
    /// `conflictStopsSave(contents, path, auto)`
    fn conflict_stops_save(&self, view: ViewId, path: &str, auto: bool) -> bool {
        if !self.shell.is_path_open_elsewhere(path) {
            return false;
        }
        let recorded = self
            .st
            .borrow()
            .views
            .get(&view)
            .and_then(|v| v.disk_states.get(path).cloned());
        let shell = self.shell.clone();
        let probe = move |p: &str| Ok(shell.is_path_open_elsewhere(p));
        if auto {
            return should_defer_auto_save(Some(&probe), path, recorded.as_ref());
        }
        let parent = self.contents.window_of(view).map(Parent);
        let lang = self.lang();
        confirm_overwrite_if_conflicted(&SaveConflictOptions {
            probe: Some(&probe),
            dialog: &Boxes(&*self.dialogs),
            parent: parent.as_ref(),
            path,
            recorded: recorded.as_ref(),
            lang: &lang,
        }) == SaveConflictAnswer::Cancel
    }

    /// `holdsOwnLastWrite(wcId, path)`: `path` still holds this view's last write
    fn holds_own_last_write(&self, view: ViewId, path: &str) -> bool {
        let Some(left) = self
            .st
            .borrow()
            .views
            .get(&view)
            .and_then(|v| v.own_writes.get(path).cloned())
        else {
            return false;
        };
        let Ok(now) = std::fs::metadata(main_core::node_fs::namespaced(path)) else {
            return false;
        };
        // the same time and size skip the reread, otherwise the bytes decide
        if StatInfo::of(&now).mtime_ms == left.mtime_ms && now.len() as f64 == left.size {
            return true;
        }
        record_disk_state(path).is_some_and(|s| s.hash == left.hash)
    }

    /// Writes a copy the recovery store asked for on a worker, then answers
    fn land_copy(
        self: &Rc<Self>,
        view: ViewId,
        pending: PendingCopy,
        bytes: Vec<u8>,
        then: impl FnOnce(CopyResult) + 'static,
    ) {
        let store = self.rec.borrow().store.clone();
        let ed = self.clone();
        let identity = pending.identity.clone();
        kit::on_worker(
            &self.services,
            move || store.write(&pending.identity, &bytes, pending.title, pending.ticket),
            move |result| then(ed.rec.borrow_mut().copy_landed(view, identity, result)),
        );
    }

    /// The end of a successful `pdf:save`
    fn after_save(
        self: &Rc<Self>,
        view: ViewId,
        path: String,
        target: String,
        redacting: bool,
        skips: SaveSkips,
        reply: Responder,
    ) {
        if target == path && !redacting {
            // `void noteLinks.afterSave(path)`: the hash reads the whole file
            let deps = super::open::AfterSaveDeps::new(self);
            let platform = self.shell.platform();
            let saved = path.clone();
            kit::on_worker(
                &self.services,
                move || {
                    main_core::pdf::note_link::NoteLinkService::new(platform).after_save(
                        &deps,
                        &saved,
                        &mut |what, err| eprintln!("{what} {}", err.0),
                    )
                },
                |()| {},
            );
        }
        if target == path {
            self.st.borrow_mut().unsaved_blank.remove(&path);
        }
        if redacting {
            self.grant_only(view, &target);
            self.with_view(view, |v| {
                v.open_path = Some(target.clone());
                v.redaction_path = Some(target.clone());
            });
            self.forget_disk_state(view, &path);
            self.st.borrow_mut().unsaved_untitled_copy.remove(&path);
            // never carry the old copy over: restoring it would undo the redaction
            self.rec
                .borrow_mut()
                .moved_to_new_file(view, &path, &target);
            if let Err(err) = self.shell.redaction_saved(view, &target) {
                eprintln!("[pdf] redaction saved hook failed: {err}");
            }
            return reply.reply(Ok(saved(skips)));
        }
        if target != path {
            return reply.reply(Ok(saved(skips)));
        }
        // saved in place: the copy is done with (an untitled one is refreshed)
        let Some(pending) = self.rec.borrow_mut().saved_in_place(view, &path) else {
            return reply.reply(Ok(saved(skips)));
        };
        let ed = self.clone();
        kit::on_worker(
            &self.services,
            move || read_file(&path),
            move |written| match written {
                // the save wrote a password-protected file: no copy of it
                Ok(bytes) if !pdf_looks_encrypted(&bytes) => {
                    ed.land_copy(view, pending, bytes, move |_| reply.reply(Ok(saved(skips))))
                }
                Ok(_) => reply.reply(Ok(saved(skips))),
                Err(err) => {
                    eprintln!("[pdf] recovery copy failed: {err}");
                    reply.reply(Ok(saved(skips)))
                }
            },
        );
    }
}

fn save(e: &Rc<Editor>, view: ViewId, request: IpcValue, reply: Responder) {
    let Some(path) = e.granted(view, field(&request, "path")) else {
        return reply.reply(Ok(failed(NOT_GRANTED)));
    };
    // Save As targets must have been granted by a main-process dialog pick
    let target = kit::as_str(field(&request, "targetPath")).map_or(path.clone(), str::to_owned);
    let granted_target =
        e.st.borrow()
            .views
            .get(&view)
            .and_then(|v| v.save_as_target.clone());
    if target != path && granted_target.as_deref() != Some(target.as_str()) {
        return reply.reply(Ok(failed("pdf: target path not granted to this view")));
    }
    let annotations = match field(&request, "annotations") {
        IpcValue::Undefined | IpcValue::Null => "keep",
        IpcValue::String(s) if matches!(s.as_str(), "keep" | "flatten" | "strip") => s.as_str(),
        _ => return reply.reply(Ok(failed("pdf: invalid annotation handling"))),
    };
    if annotations != "keep" && target == path {
        return reply.reply(Ok(failed("pdf: annotation handling requires Save As")));
    }
    if annotations != "keep" && carries_protection(&request) {
        return reply.reply(Ok(failed(
            "pdf: annotation handling needs a document without a password",
        )));
    }
    let redactions = field(&request, "redactions").clone();
    if field(&request, "copyOnly") == &IpcValue::Bool(true) {
        if target == path {
            return reply.reply(Ok(failed("pdf: copyOnly requires Save As")));
        }
        if redactions != IpcValue::Undefined {
            return reply.reply(Ok(failed("pdf: copyOnly cannot carry redactions")));
        }
        // a view restored from a recovery copy shows the copy, not the file on disk
        let restored = e.view_bytes(view, &path);
        let engine = e.engine.clone();
        let plain = with_field(&request, "copyOnly", false.into_ipc());
        let ed = e.clone();
        let written = target.clone();
        return kit::on_worker(
            &e.services,
            move || {
                match restored {
                    Some(bytes) => engine
                        .save_pdf_bytes_to_path(&bytes, &written, &plain)
                        .map(|_| ()),
                    None => engine.copy_pdf_to_path(&path, &written),
                }?;
                Ok(record_disk_state(&written))
            },
            move |result: Result<_, String>| match result {
                Ok(state) => {
                    ed.remember_disk_state(view, &target, state);
                    reply.reply(Ok(obj([("ok", true.into_ipc())])))
                }
                Err(m) => reply.reply(Ok(failed(m))),
            },
        );
    }
    // a copy pair saving onto the document's own path settles the conflict first
    if target == path {
        let auto = field(&request, "auto") == &IpcValue::Bool(true);
        if e.conflict_stops_save(view, &path, auto) {
            return reply.reply(Ok(failed("external-modified")));
        }
    }
    let redacting = redactions != IpcValue::Undefined;
    let mut request = request;
    if redacting {
        let regions = match kit::to_js_json(&redactions)
            .as_ref()
            .map(validate_redaction_regions)
        {
            Some(Ok(regions)) => regions,
            Some(Err(err)) => return reply.reply(Ok(failed(err.0))),
            None => unreachable!("redactions is not undefined"),
        };
        let own_copy = {
            let st = e.st.borrow();
            let v = st.views.get(&view);
            target == path
                && v.and_then(|v| v.redaction_path.as_deref()) == Some(path.as_str())
                && v.and_then(|v| v.save_as_target.as_deref()) == Some(path.as_str())
        };
        if is_same_redaction_copy_path(&path, &target) && !own_copy {
            return reply.reply(Ok(failed("pdf: permanent redaction requires Save As copy")));
        }
        // a redaction is its own irreversible transaction: other changes first
        match other_edits(&request) {
            Err(thrown) => return reply.reply(Err(thrown)),
            Ok(true) => {
                return reply.reply(Ok(failed(
                    "pdf: save other pending edits before applying redactions",
                )));
            }
            Ok(false) => {}
        }
        // a restored copy is not on disk yet: it is saved like any pending edit first
        if e.view_bytes(view, &path).is_some() {
            return reply.reply(Ok(failed(
                "pdf: save other pending edits before applying redactions",
            )));
        }
        let regions = IpcValue::Array(
            regions
                .iter()
                .map(|r| {
                    obj([
                        ("pageIndex", r.page_index.into_ipc()),
                        ("rect", r.rect.to_vec().into_ipc()),
                    ])
                })
                .collect(),
        );
        request = with_field(&request, "redactions", regions);
    }
    let restored = e.view_bytes(view, &path);
    let engine = e.engine.clone();
    let ed = e.clone();
    let (source, written) = (path.clone(), target.clone());
    e.write_own_file(
        view,
        &target.clone(),
        move || match restored {
            Some(bytes) => engine.save_pdf_bytes_to_path(&bytes, &written, &request),
            None => engine.save_pdf_to_path(&source, &written, &request),
        },
        move |result| match result {
            Ok(skips) => ed.after_save(view, path, target, redacting, skips, reply),
            Err(m) => reply.reply(Ok(failed(m))),
        },
    );
}

pub(super) fn entries(ed: &Rc<Editor>) -> Vec<Entry> {
    let mut all = Vec::new();

    let e = ed.clone();
    all.push(kit::invoke_later("pdf:save", move |cx, mut args, reply| {
        save(&e, cx.sender.view, args.take(0), reply)
    }));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:request-redaction-copy",
        move |cx, args, reply| {
            let view = cx.sender.view;
            let Some(path) = e.granted(view, args.get(0)) else {
                return reply.reply(Ok(false.into_ipc()));
            };
            let busy =
                e.st.borrow()
                    .views
                    .get(&view)
                    .is_some_and(|v| v.redaction_flow);
            if busy || e.save_as_waiting(view) {
                return reply.reply(Ok(false.into_ipc()));
            }
            e.with_view(view, |v| v.redaction_flow = true);
            e.set_save_as_in_flight(view, true);
            let me = e.me.clone();
            let finish = move |ok: bool| {
                if let Some(ed) = me.upgrade() {
                    ed.with_view(view, |v| v.redaction_flow = false);
                    ed.set_save_as_in_flight(view, false);
                }
                reply.reply(Ok(ok.into_ipc()))
            };
            let own =
                e.st.borrow()
                    .views
                    .get(&view)
                    .and_then(|v| v.redaction_path.clone());
            if own.as_deref() == Some(path.as_str()) {
                return e.request_save_as_outcome(
                    view,
                    &path,
                    Box::new(move |o| finish(o == SaveAsOutcome::Saved)),
                );
            }
            let picked = e.dialogs.save(
                e.contents.window_of(view),
                &FileDialog {
                    title: Some(tm(&e.lang(), Dlg::RedactCopy).into()),
                    default_path: Some(
                        join(&[&dirname(&path), &format!("{}-redacted.pdf", stem(&path))]).into(),
                    ),
                    filters: vec![FileFilter {
                        name: "PDF".into(),
                        extensions: vec!["pdf".into()],
                    }],
                    ..Default::default()
                },
            );
            let Some(target) = picked
                .map(|p| p.to_string_lossy().into_owned())
                .filter(|p| !p.is_empty())
            else {
                return finish(false);
            };
            if is_same_redaction_copy_path(&path, &target) {
                return finish(false);
            }
            e.request_save_as_outcome(
                view,
                &target,
                Box::new(move |o| finish(o == SaveAsOutcome::Saved)),
            );
        },
    ));

    // the document with its pending edits, for a skill's template: nothing is written
    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:template-bytes",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let Some(path) = e.granted(view, field(&request, "path")) else {
                return reply.reply(Ok(IpcValue::Null));
            };
            if carries_protection(&request) {
                return reply.reply(Ok(IpcValue::Null));
            }
            let restored = e.view_bytes(view, &path);
            let engine = e.engine.clone();
            kit::on_worker(
                &e.services,
                move || match restored {
                    Some(bytes) => engine.pdf_bytes_with_edits_from(&bytes, &request),
                    None => engine.pdf_bytes_with_edits(&path, &request),
                },
                move |result| match result {
                    Ok(bytes) => reply.reply(Ok(u8_array(bytes))),
                    Err(err) => {
                        eprintln!("[pdf] template copy failed: {err}");
                        reply.reply(Ok(IpcValue::Null))
                    }
                },
            );
        },
    ));

    // the first explicit save of an untitled copy, step one: where it goes
    let e = ed.clone();
    all.push(kit::invoke(
        "pdf:pick-untitled-copy-target",
        move |cx, args| {
            let view = cx.sender.view;
            let Some(path) = e
                .granted(view, args.get(0))
                .filter(|p| e.is_untitled_copy(p))
            else {
                return Ok(false.into_ipc());
            };
            e.with_view(view, |v| v.untitled_copy_target = None);
            let name = args
                .str(1)
                .filter(|n| {
                    n.to_ascii_lowercase().ends_with(".pdf") && n.encode_utf16().count() < 256
                })
                .map_or_else(|| basename(&path, None), str::to_owned);
            let default_path = match e.rec.borrow().save_as_default_path(view, &path) {
                Some(p) => p,
                None => {
                    let dir = match e.shell.new_document_dir(view) {
                        Some(dir) => dir,
                        None => e.default_save_dir().map_err(kit::error)?,
                    };
                    join(&[&dir, &name])
                }
            };
            let picked = e.dialogs.save(
                e.contents.window_of(view),
                &FileDialog {
                    default_path: Some(default_path.into()),
                    filters: vec![FileFilter {
                        name: "PDF".into(),
                        extensions: vec!["pdf".into()],
                    }],
                    ..Default::default()
                },
            );
            let Some(picked) = picked
                .map(|p| p.to_string_lossy().into_owned())
                .filter(|p| !p.is_empty())
            else {
                return Ok(false.into_ipc());
            };
            let target = if picked.to_ascii_lowercase().ends_with(".pdf") {
                picked
            } else {
                format!("{picked}.pdf")
            };
            e.with_view(view, |v| v.untitled_copy_target = Some((path, target)));
            Ok(true.into_ipc())
        },
    ));

    // step two: copy the saved temp copy to the picked place; it becomes the document
    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:adopt-untitled-copy",
        move |cx, args, reply| {
            let view = cx.sender.view;
            let Some(path) = e.granted(view, args.get(0)) else {
                return reply.reply(Ok(failed(NOT_GRANTED)));
            };
            if !e.is_untitled_copy(&path) {
                return reply.reply(Ok(failed("pdf: not an untitled document")));
            }
            let picked = e.with_view(view, |v| v.untitled_copy_target.take());
            let Some((_, target)) = picked.filter(|(p, _)| *p == path) else {
                return reply.reply(Ok(failed("pdf: no place was picked for this document")));
            };
            let ed = e.clone();
            let (from, to) = (path.clone(), target.clone());
            e.write_own_file(
                view,
                &target.clone(),
                move || main_core::node_fs::copy_file(&from, &to, false).map_err(|e| e.message),
                move |result| {
                    if let Err(m) = result {
                        return reply.reply(Ok(failed(m)));
                    }
                    {
                        let mut st = ed.st.borrow_mut();
                        st.untitled_copy.remove(&path);
                        st.unsaved_untitled_copy.remove(&path);
                    }
                    ed.grant_only(view, &target);
                    ed.with_view(view, |v| v.open_path = Some(target.clone()));
                    ed.rec.borrow_mut().adopted(view, &path, &target);
                    if target != path {
                        ed.forget_disk_state(view, &path);
                    }
                    if let Err(err) = ed.shell.redaction_saved(view, &target) {
                        eprintln!("[pdf] untitled copy saved hook failed: {err}");
                    }
                    reply.reply(Ok(obj([
                        ("ok", true.into_ipc()),
                        ("path", target.as_str().into_ipc()),
                    ])))
                },
            );
        },
    ));

    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:restore-file",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let path = e.granted(view, field(&request, "path"));
            let bytes = match field(&request, "bytes") {
                IpcValue::Bytes(BytesKind::ArrayBuffer, b) => Some(b.clone()),
                _ => None,
            };
            let (Some(path), Some(bytes)) = (path, bytes) else {
                return reply.reply(Ok(failed(NOT_GRANTED)));
            };
            // another program's change (or a sibling pane's) is not overwritten
            if !e.holds_own_last_write(view, &path) {
                return reply.reply(Ok(failed("external-modified")));
            }
            let p = path.clone();
            e.write_own_file(
                view,
                &path,
                move || write_pdf_atomically(&p, &bytes).map_err(|e| e.message),
                move |result| {
                    reply.reply(Ok(match result {
                        Ok(()) => obj([("ok", true.into_ipc())]),
                        Err(m) => failed(m),
                    }))
                },
            );
        },
    ));

    // pdf.js already accepted `password`; a failure means the standard handler refused it
    let e = ed.clone();
    all.push(kit::invoke_later("pdf:decrypt", move |_, args, reply| {
        let (Some(IpcValue::Bytes(BytesKind::Uint8Array, bytes)), Some(password)) =
            (Some(args.get(0)), args.str(1))
        else {
            return reply.reply(Ok(refused("pdf: malformed decrypt request")));
        };
        let (bytes, password) = (bytes.clone(), password.to_owned());
        let engine = e.engine.clone();
        kit::on_worker(
            &e.services,
            move || engine.decrypt_document(&bytes, &password),
            move |result| {
                reply.reply(Ok(match result {
                    Ok(d) => obj([
                        ("ok", true.into_ipc()),
                        ("bytes", u8_array(d.bytes)),
                        ("permissions", d.permissions),
                        ("neededPassword", d.needed_password.into_ipc()),
                        ("unlockedAs", d.unlocked_as.into_ipc()),
                    ]),
                    Err(DecryptError::WrongPassword) => refused("wrong-password"),
                    Err(DecryptError::CertificateEncryption) => refused("certificate-encryption"),
                    Err(DecryptError::Other(m)) => refused(m),
                }))
            },
        );
    }));

    let e = ed.clone();
    all.push(kit::send("pdf:close-save-result", move |cx, args| {
        e.close_save_result(cx.sender.view, args.bool(0) == Some(true));
        Ok(())
    }));

    let e = ed.clone();
    all.push(kit::send("pdf:save-as-result", move |cx, args| {
        let outcome = match args.get(0) {
            IpcValue::Bool(true) => SaveAsOutcome::Saved,
            IpcValue::String(s) if s == "cancelled" => SaveAsOutcome::Cancelled,
            _ => SaveAsOutcome::Failed,
        };
        e.save_as_result(cx.sender.view, outcome);
        Ok(())
    }));

    // unsaved with nothing pending in the renderer: from a copy, or an untitled document
    let e = ed.clone();
    all.push(kit::invoke("pdf:recovery-state", move |cx, args| {
        let view = cx.sender.view;
        let unsaved = e.granted(view, args.get(0)).is_some_and(|p| {
            e.rec.borrow().unsaved_from_copy(view, &p)
                || e.st.borrow().unsaved_untitled_copy.contains(&p)
        });
        Ok(obj([("unsaved", unsaved.into_ipc())]))
    }));

    // what a save of these edits would write, into the app data folder only
    let e = ed.clone();
    all.push(kit::invoke_later(
        "pdf:recovery-write-copy",
        move |cx, mut args, reply| {
            let view = cx.sender.view;
            let request = args.take(0);
            let answer = |r: CopyResult| r.as_str().into_ipc();
            let path = e.granted(view, field(&request, "path"));
            let Some(path) = path.filter(|_| field(&request, "targetPath") == &IpcValue::Undefined)
            else {
                return reply.reply(Ok(answer(CopyResult::Skipped)));
            };
            if carries_protection(&request) {
                return reply.reply(Ok(answer(CopyResult::Skipped)));
            }
            let restored = e.view_bytes(view, &path);
            let untitled_copy = e.is_untitled_copy(&path);
            let pending = match e.rec.borrow_mut().begin_copy(view, &path, untitled_copy) {
                Ok(p) => p,
                Err(r) => return reply.reply(Ok(answer(r))),
            };
            let engine = e.engine.clone();
            let ed = e.clone();
            kit::on_worker(
                &e.services,
                move || -> Result<Option<Vec<u8>>, String> {
                    // read once; an encrypted PDF gets no copy whatever the renderer reported
                    let source: Arc<Vec<u8>> = match &restored {
                        Some(b) => b.clone(),
                        None => Arc::new(read_file(&path)?),
                    };
                    if pdf_looks_encrypted(&source) {
                        return Ok(None);
                    }
                    match restored {
                        Some(r) => engine.pdf_bytes_with_edits_from(&r, &request),
                        None => engine.pdf_bytes_with_edits_of(&source, &request),
                    }
                    .map(Some)
                },
                move |serialized| {
                    let bytes = match serialized {
                        Ok(bytes) => bytes,
                        Err(err) => {
                            eprintln!("[pdf] recovery copy failed: {err}");
                            return reply.reply(Ok(answer(CopyResult::Failed)));
                        }
                    };
                    if let Err(r) = ed.rec.borrow_mut().serialized(view, bytes.is_some()) {
                        return reply.reply(Ok(answer(r)));
                    }
                    ed.land_copy(view, pending, bytes.unwrap_or_default(), move |r| {
                        reply.reply(Ok(answer(r)))
                    });
                },
            );
        },
    ));

    // the user edits again after "Don't Save": that close was cancelled
    let e = ed.clone();
    all.push(kit::invoke("pdf:recovery-resume", move |cx, _| {
        e.rec.borrow_mut().close_cancelled(cx.sender.view);
        Ok(IpcValue::Undefined)
    }));

    let e = ed.clone();
    all.push(kit::invoke(
        "pdf:recovery-unprotectable",
        move |cx, args| {
            let lang = e.lang();
            let notice = e.rec.borrow_mut().report_unprotectable(
                cx.sender.view,
                args.bool(0) == Some(true),
                &lang,
            );
            Ok(notice.into_ipc())
        },
    ));

    let e = ed.clone();
    all.push(kit::send("pdf:recovery-flush-done", move |cx, _| {
        e.copy_flush_done(cx.sender.view);
        Ok(())
    }));

    all
}
