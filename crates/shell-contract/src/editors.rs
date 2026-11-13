//! The document editors as other areas call them: tabs and windows (W) ask
//! an editor to save before a close, menus (M) to save or export, MCP (A) to
//! read or save a document. In the Electron build these were the functions
//! each app's main module exported (`requestHtmlSave`, `requestHtmlClose`,
//! `htmlReadText`, `htmlSaveToPath`, `htmlFileRenamed`,
//! `sendHtmlExportRequest`, and their twins in the other apps).
//!
//! The document batches (D1, D2) implement [`DocumentEditors`] once per app
//! and add it to [`crate::provided::Provided`] while they register; a caller
//! finds the editor of a view with [`editor_for`]. Every call that waited on
//! the renderer in TypeScript takes a continuation the editor runs on the
//! core thread when the renderer answered: nothing blocks the core thread.

use std::path::{Path, PathBuf};
use std::rc::Rc;

use crate::error::IpcError;
use crate::ids::{ViewId, WindowId};
use crate::provided::Provided;

/// What a waiting call does with its outcome; runs once, on the core thread.
/// An `Err` is the TypeScript promise's rejection.
pub type Then<T> = Box<dyn FnOnce(Result<T, IpcError>)>;

/// The apps' `SaveMode`
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SaveMode {
    /// `'save'`: write to the document's file, asking for one if it has none
    Save,
    /// `'saveAs'`: always ask for a file
    SaveAs,
}

/// One app's editors, all its views
pub trait DocumentEditors {
    /// The view shows a document of this app
    fn owns(&self, view: ViewId) -> bool;

    /// `request<App>Save(contents, mode)`: `true` when the document is saved
    /// (or had nothing to save), `false` when the user cancelled or it failed
    fn request_save(&self, view: ViewId, mode: SaveMode, then: Then<bool>);

    /// `request<App>Close(contents, parent)`: asks about unsaved changes
    /// (modal to `parent`) and saves when told; `true` when the view may close
    fn request_close(&self, view: ViewId, parent: Option<WindowId>, then: Then<bool>);

    /// `<app>ReadText(contents)`: the document's text as the renderer gives it
    fn read_text(&self, view: ViewId, then: Then<String>);

    /// `<app>SaveToPath(contents, path)`: saves the document to `path`
    /// without a dialog
    fn save_to_path(&self, view: ViewId, path: PathBuf, then: Then<()>);

    /// `<app>FileRenamed(contents, oldPath, newPath)`: the document's file was
    /// renamed or moved outside the editor
    fn file_renamed(&self, view: ViewId, old_path: &Path, new_path: &Path);

    /// `send<App>ExportRequest(contents, format)`: the File > Export menu;
    /// the renderer runs the export. `format` is the app's own name for it
    /// (`"pdf"`, `"docx"`, ...)
    fn export_request(&self, view: ViewId, format: &str);

    /// The document's file (`savePathByWc.get(contents)`), `None` while it
    /// is unsaved
    fn document_path(&self, view: ViewId) -> Option<PathBuf>;

    /// hwp only: the PDF file this view chose in Save As or was handed in a
    /// headless run (`pdfSaveAsByWc ?? headlessPdfByWc`), taken once
    fn take_pdf_grant(&self, _view: ViewId) -> Option<PathBuf> {
        None
    }

    /// docs only: the view's writer is gone (`tornDownWcIds`)
    fn torn_down(&self, _view: ViewId) -> bool {
        false
    }
}

/// The editor of the app that shows `view`, if any
pub fn editor_for(provided: &Provided, view: ViewId) -> Option<Rc<dyn DocumentEditors>> {
    provided
        .all::<dyn DocumentEditors>()
        .into_iter()
        .find(|editor| editor.owns(view))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    /// An app that owns some views and records what it was asked
    struct Fake {
        views: Vec<u32>,
        asked: RefCell<Vec<String>>,
    }

    impl DocumentEditors for Fake {
        fn owns(&self, view: ViewId) -> bool {
            self.views.contains(&view.0)
        }
        fn request_save(&self, view: ViewId, mode: SaveMode, then: Then<bool>) {
            self.asked
                .borrow_mut()
                .push(format!("save {} {mode:?}", view.0));
            then(Ok(true))
        }
        fn request_close(&self, view: ViewId, _parent: Option<WindowId>, then: Then<bool>) {
            self.asked.borrow_mut().push(format!("close {}", view.0));
            then(Ok(false))
        }
        fn read_text(&self, view: ViewId, then: Then<String>) {
            then(Err(IpcError {
                name: Some("Error".into()),
                message: format!("no text in {}", view.0),
            }))
        }
        fn save_to_path(&self, _view: ViewId, _path: PathBuf, then: Then<()>) {
            then(Ok(()))
        }
        fn file_renamed(&self, view: ViewId, old_path: &Path, new_path: &Path) {
            self.asked.borrow_mut().push(format!(
                "renamed {} {} {}",
                view.0,
                old_path.display(),
                new_path.display()
            ));
        }
        fn export_request(&self, view: ViewId, format: &str) {
            self.asked
                .borrow_mut()
                .push(format!("export {} {format}", view.0));
        }
        fn document_path(&self, view: ViewId) -> Option<PathBuf> {
            self.owns(view)
                .then(|| PathBuf::from(format!("/doc/{}", view.0)))
        }
    }

    fn fake(views: &[u32]) -> Rc<Fake> {
        Rc::new(Fake {
            views: views.to_vec(),
            asked: RefCell::default(),
        })
    }

    #[test]
    fn a_view_reaches_the_editor_that_owns_it() {
        let provided = Provided::default();
        let docs = fake(&[1, 2]);
        let pdf = fake(&[3]);
        provided.add::<dyn DocumentEditors>(docs.clone());
        provided.add::<dyn DocumentEditors>(pdf.clone());

        let answer = Rc::new(RefCell::new(None));
        let got = answer.clone();
        editor_for(&provided, ViewId(3)).unwrap().request_save(
            ViewId(3),
            SaveMode::SaveAs,
            Box::new(move |r| *got.borrow_mut() = Some(r)),
        );
        assert_eq!(*answer.borrow(), Some(Ok(true)));
        assert_eq!(*pdf.asked.borrow(), vec!["save 3 SaveAs"]);
        assert!(docs.asked.borrow().is_empty());

        editor_for(&provided, ViewId(2))
            .unwrap()
            .export_request(ViewId(2), "pdf");
        assert_eq!(*docs.asked.borrow(), vec!["export 2 pdf"]);

        assert!(editor_for(&provided, ViewId(9)).is_none());
    }

    #[test]
    fn types_do_not_mix() {
        let provided = Provided::default();
        provided.add::<dyn DocumentEditors>(fake(&[1]));
        provided.add::<u32>(Rc::new(7));
        assert_eq!(provided.all::<dyn DocumentEditors>().len(), 1);
        assert_eq!(provided.all::<u32>().iter().map(|n| **n).sum::<u32>(), 7);
        assert!(provided.all::<String>().is_empty());
    }
}
