//! `apps/shell/src/main/generate/open-materials.ts`: the generate window's
//! view of the open tabs: which tab holds a material, saving that tab in
//! place (8.4 "a button that saves it"), and following a never-saved document
//! until it gets a path.
//!
//! Saving reuses what each editor already offers the shell for a dialog-free
//! save of an open document. A tab whose format cannot be written that way is
//! brought forward instead.
//!
//! `deps.list()` (`tabManager.openDocuments()`) is not a host call: every
//! function is handed the snapshot of the open tabs the shell gathered (see
//! [`OpenSnapshot`]). The editors' save commands are renderer round trips, so
//! `saveMaterial` is a step: [`save_material_begin`] answers a
//! [`SaveMaterialStep`], and [`SaveMaterialRun::resume`] goes on with the
//! editor's answer.

use std::fs;

use jscompat::node_path::host::{extname, resolve};

use super::generate_api::SaveAction;
use crate::packages::electron_utils::unsaved_files::OpenFilesHolder;
use crate::shell::app_routing::DocumentTabKind;
use crate::shell::renderer_disposal::Failure;

/// `OpenDocumentTab` of `apps/shell/src/shared/tabs-api.ts`
#[derive(Debug, Clone, PartialEq)]
pub struct OpenDocumentTab {
    pub id: String,
    pub kind: DocumentTabKind,
    pub title: String,
    pub file_path: Option<String>,
    pub active: bool,
    pub dirty: bool,
}

/// What the shell hands over with a call: the open files (the shell's
/// `OpenFilesSource`, read once) and the open tabs (`deps.list()`).
pub struct OpenSnapshot<'a> {
    pub files: &'a OpenFilesHolder,
    pub tabs: &'a [OpenDocumentTab],
}

/// the part of an Electron webContents this module needs
pub trait MaterialContents {
    fn id(&self) -> f64;
    fn is_destroyed(&self) -> bool;
}

/// What `save_material` answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveOutcome {
    Saved,
    Shown,
    Failed,
}

impl SaveOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            SaveOutcome::Saved => "saved",
            SaveOutcome::Shown => "shown",
            SaveOutcome::Failed => "failed",
        }
    }
}

/// `OpenMaterialsDeps` without `list` (the snapshot answers it) and without
/// the save commands (the steps of [`save_material_begin`]); `has_save` is
/// `!!deps.save[kind]`
pub trait OpenMaterialsDeps {
    type Contents: MaterialContents;
    fn web_contents_for(&mut self, tab_id: &str) -> Option<Self::Contents>;
    /// bring a tab (and its window) forward
    fn reveal(&mut self, tab_id: &str);
    /// whether the host gave a save for this kind of tab
    fn has_save(&self, kind: DocumentTabKind) -> bool;
    /// `console.warn('[generate] saving a material failed:', error)`
    fn warn_save_failed(&mut self, error: &Failure);
}

/// An editor's save command the caller carries out and answers with a
/// [`SaveAnswer`]. The webContents is the tab's, by id.
#[derive(Debug, Clone, PartialEq)]
pub enum SaveNeed {
    /// `save.docs` / `save.sheets` / `save.slides`: save to a path
    ToPath {
        kind: DocumentTabKind,
        web_contents_id: f64,
        path: String,
    },
    /// `save.markdown` / `save.html` / `save.mindmap`: the editor's own Save
    Editor {
        kind: DocumentTabKind,
        web_contents_id: f64,
    },
}

/// What the caller answers a [`SaveNeed`] with; a rejection is a [`Failure`].
#[derive(Debug, Clone, PartialEq)]
pub enum SaveAnswer {
    ToPath(Result<(), Failure>),
    Editor(Result<bool, Failure>),
}

/// The continuation of `saveMaterial` while an editor saves.
#[derive(Debug)]
pub struct SaveMaterialRun(());

/// One step of `saveMaterial`.
#[derive(Debug)]
pub enum SaveMaterialStep {
    Done(SaveOutcome),
    Need(SaveNeed, SaveMaterialRun),
}

/// one spelling per file, resolved and through links (case-folded where the disk is)
fn path_key(path: &str) -> String {
    let mut resolved = resolve(&[path]);
    if let Ok(real) = fs::canonicalize(&resolved) {
        let real = real.to_string_lossy().into_owned();
        // std adds the verbatim prefix on Windows; realpath does not
        resolved = match real.strip_prefix(r"\\?\") {
            Some(rest) if !rest.starts_with(r"UNC\") => rest.to_owned(),
            _ => real,
        };
    }
    if cfg!(windows) {
        resolved.to_lowercase()
    } else {
        resolved
    }
}

/// `IN_PLACE_EXTS`: formats each bridge writes; anything else is shown, not written
fn in_place_exts(kind: DocumentTabKind) -> &'static [&'static str] {
    match kind {
        DocumentTabKind::Docs => &["docx"],
        DocumentTabKind::Sheets => &["xlsx"],
        DocumentTabKind::Slides => &["pptx"],
        _ => &[],
    }
}

fn tab_of_path(tabs: &[OpenDocumentTab], path: &str) -> Option<OpenDocumentTab> {
    let wanted = path_key(path);
    tabs.iter()
        .find(|tab| {
            tab.file_path
                .as_deref()
                .filter(|file| !file.is_empty())
                .is_some_and(|file| path_key(file) == wanted)
        })
        .cloned()
}

fn can_save_in_place<D: OpenMaterialsDeps>(deps: &D, tab: &OpenDocumentTab) -> bool {
    let Some(file) = tab.file_path.as_deref().filter(|file| !file.is_empty()) else {
        return false;
    };
    let ext = extname(file).get(1..).unwrap_or_default().to_lowercase();
    match tab.kind {
        DocumentTabKind::Docs | DocumentTabKind::Sheets | DocumentTabKind::Slides => {
            deps.has_save(tab.kind) && in_place_exts(tab.kind).contains(&ext.as_str())
        }
        DocumentTabKind::Markdown | DocumentTabKind::Html | DocumentTabKind::Mindmap => {
            deps.has_save(tab.kind)
        }
        _ => false,
    }
}

/// `saveActionFor(path)`
pub fn save_action_for<D: OpenMaterialsDeps>(
    deps: &D,
    tabs: &[OpenDocumentTab],
    path: &str,
) -> SaveAction {
    match tab_of_path(tabs, path) {
        Some(tab) if can_save_in_place(deps, &tab) => SaveAction::Save,
        _ => SaveAction::Show,
    }
}

/// `saveMaterial(path)`, up to the editor's save command
pub fn save_material_begin<D: OpenMaterialsDeps>(
    deps: &mut D,
    tabs: &[OpenDocumentTab],
    path: &str,
) -> SaveMaterialStep {
    // closed meanwhile, or already clean: nothing left to save
    let Some(tab) = tab_of_path(tabs, path).filter(|tab| tab.dirty) else {
        return SaveMaterialStep::Done(SaveOutcome::Saved);
    };
    let contents = match deps.web_contents_for(&tab.id) {
        Some(contents) if !contents.is_destroyed() => contents,
        _ => return SaveMaterialStep::Done(SaveOutcome::Saved),
    };
    if !can_save_in_place(deps, &tab) {
        deps.reveal(&tab.id);
        return SaveMaterialStep::Done(SaveOutcome::Shown);
    }
    let path = tab.file_path.as_deref().unwrap_or_default();
    match tab.kind {
        DocumentTabKind::Docs | DocumentTabKind::Sheets | DocumentTabKind::Slides => {
            SaveMaterialStep::Need(
                SaveNeed::ToPath {
                    kind: tab.kind,
                    web_contents_id: contents.id(),
                    path: path.to_owned(),
                },
                SaveMaterialRun(()),
            )
        }
        DocumentTabKind::Markdown | DocumentTabKind::Html | DocumentTabKind::Mindmap => {
            SaveMaterialStep::Need(
                SaveNeed::Editor {
                    kind: tab.kind,
                    web_contents_id: contents.id(),
                },
                SaveMaterialRun(()),
            )
        }
        _ => SaveMaterialStep::Done(SaveOutcome::Failed),
    }
}

impl SaveMaterialRun {
    /// the editor answered
    pub fn resume<D: OpenMaterialsDeps>(self, deps: &mut D, answer: SaveAnswer) -> SaveOutcome {
        match answer {
            SaveAnswer::ToPath(Ok(())) | SaveAnswer::Editor(Ok(true)) => SaveOutcome::Saved,
            SaveAnswer::Editor(Ok(false)) => SaveOutcome::Failed,
            SaveAnswer::ToPath(Err(error)) | SaveAnswer::Editor(Err(error)) => {
                deps.warn_save_failed(&error);
                SaveOutcome::Failed
            }
        }
    }
}

/// `pathOfUntitled(webContentsId)`
pub fn path_of_untitled<D: OpenMaterialsDeps>(
    deps: &mut D,
    tabs: &[OpenDocumentTab],
    web_contents_id: f64,
) -> Option<String> {
    for tab in tabs {
        let id = deps.web_contents_for(&tab.id).map(|c| c.id());
        if id == Some(web_contents_id) {
            return tab.file_path.clone();
        }
    }
    None
}

/// `showUntitled(webContentsId)`
pub fn show_untitled<D: OpenMaterialsDeps>(
    deps: &mut D,
    tabs: &[OpenDocumentTab],
    web_contents_id: f64,
) {
    for tab in tabs {
        let id = deps.web_contents_for(&tab.id).map(|c| c.id());
        if id == Some(web_contents_id) {
            deps.reveal(&tab.id);
            return;
        }
    }
}
