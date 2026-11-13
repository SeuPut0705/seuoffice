//! `apps/shell/src/main/generate/open-materials.ts`: the generate window's
//! view of the open tabs: which tab holds a material, saving that tab in
//! place (8.4 "a button that saves it"), and following a never-saved document
//! until it gets a path.
//!
//! Saving reuses what each editor already offers the shell for a dialog-free
//! save of an open document. A tab whose format cannot be written that way is
//! brought forward instead. `createOpenMaterials(deps)` is [`OpenMaterials`]
//! over the caller's deps; its promises are plain calls and a rejection is a
//! [`Failure`].

use std::fs;

use jscompat::node_path::host::{extname, resolve};

use super::generate_api::SaveAction;
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

/// `OpenMaterialsDeps`; `has_save` is `!!deps.save[kind]`
pub trait OpenMaterialsDeps {
    type Contents: MaterialContents;
    /// every open document (shell tabs and detached windows), dirty state resolved
    fn list(&mut self) -> Result<Vec<OpenDocumentTab>, Failure>;
    fn web_contents_for(&mut self, tab_id: &str) -> Option<Self::Contents>;
    /// bring a tab (and its window) forward
    fn reveal(&mut self, tab_id: &str);
    /// whether the host gave a save for this kind of tab
    fn has_save(&self, kind: DocumentTabKind) -> bool;
    /// `save.docs` / `save.sheets` / `save.slides`: save to a path
    fn save_to_path(
        &mut self,
        kind: DocumentTabKind,
        web_contents_id: f64,
        path: &str,
    ) -> Result<(), Failure>;
    /// `save.markdown` / `save.html` / `save.mindmap`: the editor's own Save
    fn save_editor(
        &mut self,
        kind: DocumentTabKind,
        contents: &Self::Contents,
    ) -> Result<bool, Failure>;
    /// `console.warn('[generate] saving a material failed:', error)`
    fn warn_save_failed(&mut self, error: &Failure);
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

/// `createOpenMaterials(deps)`
pub struct OpenMaterials<'a, D: OpenMaterialsDeps> {
    deps: &'a mut D,
}

pub fn create_open_materials<D: OpenMaterialsDeps>(deps: &mut D) -> OpenMaterials<'_, D> {
    OpenMaterials { deps }
}

impl<D: OpenMaterialsDeps> OpenMaterials<'_, D> {
    fn tab_of_path(&mut self, path: &str) -> Result<Option<OpenDocumentTab>, Failure> {
        let wanted = path_key(path);
        Ok(self.deps.list()?.into_iter().find(|tab| {
            tab.file_path
                .as_deref()
                .filter(|file| !file.is_empty())
                .is_some_and(|file| path_key(file) == wanted)
        }))
    }

    fn can_save_in_place(&self, tab: &OpenDocumentTab) -> bool {
        let Some(file) = tab.file_path.as_deref().filter(|file| !file.is_empty()) else {
            return false;
        };
        let ext = extname(file).get(1..).unwrap_or_default().to_lowercase();
        match tab.kind {
            DocumentTabKind::Docs | DocumentTabKind::Sheets | DocumentTabKind::Slides => {
                self.deps.has_save(tab.kind) && in_place_exts(tab.kind).contains(&ext.as_str())
            }
            DocumentTabKind::Markdown | DocumentTabKind::Html | DocumentTabKind::Mindmap => {
                self.deps.has_save(tab.kind)
            }
            _ => false,
        }
    }

    fn save_tab(&mut self, tab: &OpenDocumentTab, contents: &D::Contents) -> Result<bool, Failure> {
        let path = tab.file_path.as_deref().unwrap_or_default();
        match tab.kind {
            DocumentTabKind::Docs | DocumentTabKind::Sheets | DocumentTabKind::Slides => {
                self.deps.save_to_path(tab.kind, contents.id(), path)?;
                Ok(true)
            }
            DocumentTabKind::Markdown | DocumentTabKind::Html | DocumentTabKind::Mindmap => {
                self.deps.save_editor(tab.kind, contents)
            }
            _ => Ok(false),
        }
    }

    pub fn save_action_for(&mut self, path: &str) -> Result<SaveAction, Failure> {
        let tab = self.tab_of_path(path)?;
        Ok(match tab {
            Some(tab) if self.can_save_in_place(&tab) => SaveAction::Save,
            _ => SaveAction::Show,
        })
    }

    pub fn save_material(&mut self, path: &str) -> Result<SaveOutcome, Failure> {
        let tab = self.tab_of_path(path)?;
        // closed meanwhile, or already clean: nothing left to save
        let Some(tab) = tab.filter(|tab| tab.dirty) else {
            return Ok(SaveOutcome::Saved);
        };
        let contents = match self.deps.web_contents_for(&tab.id) {
            Some(contents) if !contents.is_destroyed() => contents,
            _ => return Ok(SaveOutcome::Saved),
        };
        if !self.can_save_in_place(&tab) {
            self.deps.reveal(&tab.id);
            return Ok(SaveOutcome::Shown);
        }
        match self.save_tab(&tab, &contents) {
            Ok(true) => Ok(SaveOutcome::Saved),
            Ok(false) => Ok(SaveOutcome::Failed),
            Err(error) => {
                self.deps.warn_save_failed(&error);
                Ok(SaveOutcome::Failed)
            }
        }
    }

    pub fn path_of_untitled(&mut self, web_contents_id: f64) -> Result<Option<String>, Failure> {
        for tab in self.deps.list()? {
            let id = self.deps.web_contents_for(&tab.id).map(|c| c.id());
            if id == Some(web_contents_id) {
                return Ok(tab.file_path);
            }
        }
        Ok(None)
    }

    pub fn show_untitled(&mut self, web_contents_id: f64) -> Result<(), Failure> {
        for tab in self.deps.list()? {
            let id = self.deps.web_contents_for(&tab.id).map(|c| c.id());
            if id == Some(web_contents_id) {
                self.deps.reveal(&tab.id);
                return Ok(());
            }
        }
        Ok(())
    }
}
