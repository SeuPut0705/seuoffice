//! What other areas call into the PDF editor: the functions pdf-main.ts
//! exported to the shell, as [`PdfEditors`]. The ones that waited on the
//! renderer keep a continuation and emit the request; the renderer's
//! `*-result` send (or the TypeScript's timeout) resumes it.

use std::cell::RefCell;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use jscompat::node_path::host::basename;
use main_core::packages::electron_utils::recovery_store::RecoveryIdentity;
use main_core::packages::electron_utils::safe_external_url::{
    SafeExternalUrlOptions, safe_external_url,
};
use shell_contract::editors::{DocumentEditors, SaveMode, Then};
use shell_contract::hosts::{FileDialog, FileFilter, MessageBox};
use shell_contract::{ViewId, WindowId};

use super::dialogs::{Dlg, tm};
use super::recovery::{Decision, WORK_FILE_MAX_AGE};
use super::{Editor, Waiting, resolve};
use crate::kit::{self, IntoIpc, error};

/// How long the main side waits for the renderer's save (`requestRendererSave`, Save As)
const RENDERER_SAVE_TIMEOUT: Duration = Duration::from_secs(120);
/// `COPY_FLUSH_TIMEOUT_MS`
const COPY_FLUSH_TIMEOUT: Duration = Duration::from_secs(8);

/// `PdfSaveAsOutcome`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SaveAsOutcome {
    Saved,
    Cancelled,
    Failed,
}

impl Editor {
    /// `requestRendererSave(contents, flushAll)`
    pub(super) fn request_renderer_save(
        &self,
        view: ViewId,
        flush_all: bool,
        then: Box<dyn FnOnce(bool)>,
    ) {
        let waiting: Waiting<bool> = Rc::new(RefCell::new(Some(then)));
        let me = self.me.clone();
        let mine = waiting.clone();
        let timer = kit::after(&self.services, RENDERER_SAVE_TIMEOUT, move || {
            if let Some(ed) = me.upgrade() {
                ed.with_view(view, |v| v.close_save = None);
            }
            resolve(&mine, false);
        });
        // a second request replaces the first in the table; the first still
        // ends with its own timeout, as the TypeScript's did
        self.with_view(view, |v| v.close_save = Some((waiting, timer)));
        self.emit(
            view,
            "pdf:close-save-request",
            vec![kit::obj([("flushAll", flush_all.into_ipc())])],
        );
    }

    /// `pdf:close-save-result`
    pub(super) fn close_save_result(&self, view: ViewId, ok: bool) {
        let waiter = self.with_view(view, |v| v.close_save.take());
        if let Some((waiting, timer)) = waiter {
            kit::clear(timer);
            resolve(&waiting, ok);
        }
    }

    /// `setPdfSaveAsInFlight(contents, inFlight)`
    pub(super) fn set_save_as_in_flight(&self, view: ViewId, in_flight: bool) {
        self.emit(view, "pdf:save-as-flow", vec![in_flight.into_ipc()]);
    }

    /// `requestPdfSaveAsOutcome(contents, targetPath)`
    pub(super) fn request_save_as_outcome(
        &self,
        view: ViewId,
        target: &str,
        then: Box<dyn FnOnce(SaveAsOutcome)>,
    ) {
        if self.services.views.sender_of(view).is_none() {
            return then(SaveAsOutcome::Failed);
        }
        self.with_view(view, |v| v.save_as_target = Some(target.to_owned()));
        let me = self.me.clone();
        let done: Box<dyn FnOnce(SaveAsOutcome)> = Box::new(move |outcome| {
            if let Some(ed) = me.upgrade() {
                ed.with_view(view, |v| v.save_as_target = None);
            }
            then(outcome)
        });
        let waiting: Waiting<SaveAsOutcome> = Rc::new(RefCell::new(Some(done)));
        let me = self.me.clone();
        let mine = waiting.clone();
        let timer = kit::after(&self.services, RENDERER_SAVE_TIMEOUT, move || {
            if let Some(ed) = me.upgrade() {
                ed.with_view(view, |v| v.save_as = None);
            }
            resolve(&mine, SaveAsOutcome::Failed);
        });
        self.with_view(view, |v| v.save_as = Some((waiting, timer)));
        self.emit(view, "pdf:save-as-request", vec![target.into_ipc()]);
    }

    /// `pdf:save-as-result`
    pub(super) fn save_as_result(&self, view: ViewId, outcome: SaveAsOutcome) {
        let waiter = self.with_view(view, |v| v.save_as.take());
        if let Some((waiting, timer)) = waiter {
            kit::clear(timer);
            resolve(&waiting, outcome);
        }
    }

    pub(super) fn save_as_waiting(&self, view: ViewId) -> bool {
        self.st
            .borrow()
            .views
            .get(&view)
            .is_some_and(|v| v.save_as.is_some())
    }

    /// `discardPdfRecovery(contents)`: "Don't Save"
    pub(super) fn discard_recovery(&self, view: ViewId) {
        let open = self.open_path(view);
        let untitled_copy = open.as_deref().is_some_and(|p| self.is_untitled_copy(p));
        self.rec
            .borrow_mut()
            .dont_save(view, open.as_deref(), untitled_copy);
        self.emit(view, "pdf:recovery-dropped", vec![true.into_ipc()]);
    }

    /// `pdf:recovery-flush-done`
    pub(super) fn copy_flush_done(&self, view: ViewId) {
        let waiter = self.with_view(view, |v| v.copy_flush.take());
        if let Some((waiting, timer)) = waiter {
            kit::clear(timer);
            resolve(&waiting, ());
        }
    }

    /// `reopenView(contents, filePath)`
    fn reopen_view(&self, view: ViewId, path: &str) {
        self.grants.0.with(view, |set| {
            if let Some(set) = set {
                set.insert(path.to_owned());
            }
        });
        self.with_view(view, |v| v.open_path = Some(path.to_owned()));
        if self.rec.borrow().has_consumed(view) {
            self.with_view(view, |v| v.dirty = false);
            self.shell.reload(view);
        }
    }
}

/// The PDF editor as the shell, the menus and MCP call it
pub(crate) struct PdfEditors(pub(super) Rc<Editor>);

impl PdfEditors {
    /// `createPdfView(openPath)`'s `grantAndTrack`: the view starts with its
    /// file (when it exists) as its only grant
    pub(crate) fn open_view(&self, view: ViewId, open_path: Option<&str>) {
        let ed = &self.0;
        let mut allowed = HashSet::new();
        if let Some(path) = open_path.filter(|p| !p.is_empty() && Path::new(p).exists()) {
            ed.with_view(view, |v| v.open_path = Some(path.to_owned()));
            allowed.insert(path.to_owned());
        }
        ed.grants.0.insert(view, allowed);
    }

    /// `setWindowOpenHandler` of the view: external links go to the system
    /// browser, nothing opens in the app; answers `deny` always
    pub(crate) fn window_open(&self, url: &str) {
        let options = SafeExternalUrlOptions {
            allowed_protocols: Some(vec!["http:".into(), "https:".into(), "mailto:".into()]),
        };
        if let Some(target) = safe_external_url(Some(url), Some(&options)) {
            let _ = self.0.os.open_external(&target);
        }
    }

    /// `render-process-gone`: a crashed renderer keeps its recovery copy
    pub(crate) fn render_gone(&self, view: ViewId) {
        self.0.rec.borrow_mut().mark_crashed(view);
    }

    /// `did-start-loading` (reload): the remount drops the edits and the watch
    pub(crate) fn start_loading(&self, view: ViewId) {
        self.0.with_view(view, |v| v.dirty = false);
        self.0.stop_view_watch(view);
    }

    /// `pdfIsDirty(wcId)`
    pub(crate) fn is_dirty(&self, view: ViewId) -> bool {
        self.0.is_dirty(view)
    }

    /// `clearPdfDirty(wcId)`
    pub(crate) fn clear_dirty(&self, view: ViewId) {
        self.0.with_view(view, |v| v.dirty = false);
    }

    /// `pdfPathGranted(wcId, path)`
    pub(crate) fn path_granted(&self, view: ViewId, path: &str) -> bool {
        self.0.grants.granted(view, path)
    }

    /// `markPdfUntitledPath(path)`: "New PDF" wrote a blank
    pub(crate) fn mark_untitled_path(&self, path: &str) {
        let mut st = self.0.st.borrow_mut();
        st.untitled.insert(path.to_owned());
        st.unsaved_blank.insert(path.to_owned());
    }

    /// `markPdfUntitledCopy(path)`
    pub(crate) fn mark_untitled_copy(&self, path: &str) {
        self.0.st.borrow_mut().untitled_copy.insert(path.to_owned());
    }

    /// `pdfRecoveryIdentity(wcId)`
    pub(crate) fn recovery_identity(&self, view: ViewId) -> Option<RecoveryIdentity> {
        self.0.rec.borrow().untitled_identity(view)
    }

    /// `writePdfCopiesNow()`: every dirty view writes its copy now; `then`
    /// runs once each answered or timed out
    pub(crate) fn write_copies_now(&self, then: Box<dyn FnOnce()>) {
        let ed = &self.0;
        let views: Vec<ViewId> = {
            let st = ed.st.borrow();
            st.views
                .iter()
                .filter(|(_, v)| v.dirty)
                .map(|(id, _)| *id)
                .collect()
        };
        let targets: Vec<ViewId> = views
            .into_iter()
            .filter(|v| {
                !ed.rec.borrow().is_unprotectable(*v) && ed.services.views.sender_of(*v).is_some()
            })
            .collect();
        let left = Rc::new(RefCell::new((targets.len(), Some(then))));
        let finish = {
            let left = left.clone();
            move || {
                let mut l = left.borrow_mut();
                l.0 = l.0.saturating_sub(1);
                if l.0 == 0
                    && let Some(then) = l.1.take()
                {
                    drop(l);
                    then()
                }
            }
        };
        if targets.is_empty() {
            let then = left.borrow_mut().1.take();
            if let Some(then) = then {
                then()
            }
            return;
        }
        for view in targets {
            let finish = finish.clone();
            let waiting: Waiting<()> = Rc::new(RefCell::new(Some(Box::new(move |()| finish()))));
            let me = ed.me.clone();
            let mine = waiting.clone();
            let timer = kit::after(&ed.services, COPY_FLUSH_TIMEOUT, move || {
                if let Some(ed) = me.upgrade() {
                    ed.with_view(view, |v| {
                        v.copy_flush.take_if(|(w, _)| Rc::ptr_eq(w, &mine));
                    });
                }
                resolve(&mine, ());
            });
            let previous = ed.with_view(view, |v| v.copy_flush.replace((waiting, timer)));
            if let Some((previous, timer)) = previous {
                kit::clear(timer);
                resolve(&previous, ());
            }
            ed.emit(view, "pdf:recovery-flush-request", vec![]);
        }
    }

    /// `pdfRecoveryEditor.openFileWithDecision(contents, request)`
    pub(crate) fn open_file_with_decision(&self, view: ViewId, path: &str, restore: bool) {
        let ed = &self.0;
        if ed.services.views.sender_of(view).is_none()
            || !ed.registered(view)
            || !Path::new(path).exists()
        {
            return;
        }
        let decision = if restore {
            Decision::Restore
        } else {
            Decision::Original
        };
        ed.rec.borrow_mut().set_decision(view, path, decision);
        ed.reopen_view(view, path);
    }

    /// `pdfRecoveryEditor.openUntitledCopy(contents, request)`
    pub(crate) fn open_untitled_copy(
        &self,
        view: ViewId,
        copy: &RecoveryIdentity,
        title: &str,
        save_as_default_path: Option<&str>,
    ) {
        let ed = &self.0;
        if ed.services.views.sender_of(view).is_none() || !ed.registered(view) {
            return;
        }
        let opened = ed
            .rec
            .borrow_mut()
            .open_untitled(view, copy, title, save_as_default_path);
        let path = match opened {
            Ok(Some(path)) => path,
            Ok(None) => return,
            Err(err) => {
                eprintln!("[pdf] recovery copy could not be opened: {err}");
                return;
            }
        };
        {
            let mut st = ed.st.borrow_mut();
            st.untitled_copy.insert(path.clone());
            st.unsaved_untitled_copy.insert(path.clone());
        }
        ed.reopen_view(view, &path);
    }

    /// `pdfRecoveryEditor.isUnprotectable(contents)`
    pub(crate) fn is_unprotectable(&self, view: ViewId) -> bool {
        self.0.rec.borrow().is_unprotectable(view)
    }

    /// `registerPdfRecoveryEditor()`'s sweep of a crash's working files
    pub(crate) fn sweep_work_files(&self) {
        self.0.rec.borrow().sweep_work_files(WORK_FILE_MAX_AGE);
    }

    /// `discardPdfRecovery(contents)`
    pub(crate) fn discard_recovery(&self, view: ViewId) {
        self.0.discard_recovery(view)
    }

    /// `pdfCloseCancelled(contents)`
    pub(crate) fn close_cancelled(&self, view: ViewId) {
        if self.0.rec.borrow_mut().close_cancelled(view) {
            self.0
                .emit(view, "pdf:recovery-dropped", vec![false.into_ipc()]);
        }
    }

    /// `flushPdfSave(contents, flushAll)`: clean views answer true at once
    pub(crate) fn flush_save(&self, view: ViewId, flush_all: bool, then: Box<dyn FnOnce(bool)>) {
        if self.0.services.views.sender_of(view).is_none() || !self.0.is_dirty(view) {
            return then(true);
        }
        self.0.request_renderer_save(view, flush_all, then)
    }

    /// `setPdfSaveAsInFlight(contents, inFlight)`
    pub(crate) fn set_save_as_in_flight(&self, view: ViewId, in_flight: bool) {
        self.0.set_save_as_in_flight(view, in_flight)
    }

    /// `requestPdfSaveAsOutcome(contents, targetPath)`
    pub(crate) fn request_save_as_outcome(
        &self,
        view: ViewId,
        target: &str,
        then: Box<dyn FnOnce(SaveAsOutcome)>,
    ) {
        self.0.request_save_as_outcome(view, target, then)
    }

    /// `requestPdfSaveAs(contents, targetPath)`
    pub(crate) fn request_save_as(&self, view: ViewId, target: &str, then: Box<dyn FnOnce(bool)>) {
        self.0.request_save_as_outcome(
            view,
            target,
            Box::new(move |o| then(o == SaveAsOutcome::Saved)),
        )
    }

    /// `requestPdfPageImages(contents, targetPath)`: false = not sent
    pub(crate) fn request_page_images(&self, view: ViewId, target: &str) -> bool {
        let ed = &self.0;
        if ed.services.views.sender_of(view).is_none()
            || !target.to_ascii_lowercase().ends_with(".png")
        {
            return false;
        }
        ed.with_view(view, |v| v.image_target = Some(target.to_owned()));
        ed.emit(view, "pdf:export-images-request", vec![]);
        true
    }
}

fn not_supported(what: &str) -> shell_contract::IpcError {
    error(format!("pdf: {what} is not supported by the PDF editor"))
}

impl DocumentEditors for PdfEditors {
    fn owns(&self, view: ViewId) -> bool {
        self.0.registered(view)
    }

    /// Save: `flushPdfSave(contents)` as the File menu did. Save As: the
    /// PDF copy of the shell's Save As (a save dialog with the PDF filter,
    /// then `requestPdfSaveAsOutcome`); the conversions stay the shell's.
    fn request_save(&self, view: ViewId, mode: SaveMode, then: Then<bool>) {
        match mode {
            SaveMode::Save => self.flush_save(view, false, Box::new(move |ok| then(Ok(ok)))),
            SaveMode::SaveAs => {
                let ed = &self.0;
                let Some(path) = ed.open_path(view) else {
                    return then(Ok(false));
                };
                ed.set_save_as_in_flight(view, true);
                let parent = ed.contents.window_of(view);
                let picked = ed.dialogs.save(
                    parent,
                    &FileDialog {
                        default_path: Some(PathBuf::from(&path)),
                        filters: vec![FileFilter {
                            name: tm(&ed.lang(), Dlg::FilterPdf).into(),
                            extensions: vec!["pdf".into()],
                        }],
                        ..Default::default()
                    },
                );
                let Some(target) = picked.map(|p| p.to_string_lossy().into_owned()) else {
                    ed.set_save_as_in_flight(view, false);
                    return then(Ok(false));
                };
                let me = ed.me.clone();
                ed.request_save_as_outcome(
                    view,
                    &target,
                    Box::new(move |outcome| {
                        if let Some(ed) = me.upgrade() {
                            ed.set_save_as_in_flight(view, false);
                        }
                        then(Ok(outcome == SaveAsOutcome::Saved))
                    }),
                );
            }
        }
    }

    /// `requestPdfClose(contents, parent)`
    fn request_close(&self, view: ViewId, parent: Option<WindowId>, then: Then<bool>) {
        let ed = &self.0;
        if !ed.is_dirty(view) || ed.services.views.sender_of(view).is_none() {
            return then(Ok(true));
        }
        let lang = ed.lang();
        let answer = ed.dialogs.message(
            parent,
            &MessageBox {
                kind: Some("warning".into()),
                message: tm(&lang, Dlg::CloseUnsavedMsg).into(),
                detail: Some(tm(&lang, Dlg::CloseUnsavedDetail).into()),
                buttons: vec![
                    tm(&lang, Dlg::BtnSave).into(),
                    tm(&lang, Dlg::BtnDontSave).into(),
                    tm(&lang, Dlg::BtnCancel).into(),
                ],
                default_id: Some(0),
                cancel_id: Some(2),
                ..Default::default()
            },
        );
        match answer.response {
            2 => then(Ok(false)),
            1 => {
                ed.discard_recovery(view);
                then(Ok(true))
            }
            _ => ed.request_renderer_save(view, true, Box::new(move |ok| then(Ok(ok)))),
        }
    }

    /// pdf-main.ts exported no text reader: MCP reads PDFs from the file
    fn read_text(&self, _view: ViewId, then: Then<String>) {
        then(Err(not_supported("reading the document's text")))
    }

    /// `requestPdfSaveAs(contents, path)`: the renderer writes its edits to `path`
    fn save_to_path(&self, view: ViewId, path: PathBuf, then: Then<()>) {
        let target = path.to_string_lossy().into_owned();
        let failed = format!("pdf: could not save to {target}");
        self.request_save_as(
            view,
            &target,
            Box::new(move |saved| then(if saved { Ok(()) } else { Err(error(failed)) })),
        )
    }

    /// `pdfFileRenamed(contents, oldPath, newPath)`
    fn file_renamed(&self, view: ViewId, old_path: &Path, new_path: &Path) {
        self.0.file_renamed(
            view,
            &old_path.to_string_lossy(),
            &new_path.to_string_lossy(),
        )
    }

    /// pdf-main.ts had no renderer export request (its exports are shell
    /// flows and `pdf:print-request` is M's): nothing to send
    fn export_request(&self, _view: ViewId, _format: &str) {}

    /// `openPathByWc.get(wc)`
    fn document_path(&self, view: ViewId) -> Option<PathBuf> {
        self.0.open_path(view).map(PathBuf::from)
    }
}

/// `basename(path)` without `.pdf`
pub(super) fn stem(path: &str) -> String {
    let name = basename(path, None);
    if name.to_ascii_lowercase().ends_with(".pdf") {
        name[..name.len() - 4].to_owned()
    } else {
        name
    }
}
