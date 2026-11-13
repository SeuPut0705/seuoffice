//! `apps/shell/src/main/projects/new-documents.ts`: new documents the AI makes
//! while a project is chosen (spec 6, invariant 3).
//!
//! The folder rule: the folder of the window's current document when that
//! document is inside the project folder (not under `.seuoffice/`), else the
//! project folder itself. The home ask has no document, so it is the top. A
//! name already taken gets " (2)", " (3)"... and is never written over. The
//! bytes go through the project guide's write guard only (`writeNewDocument`),
//! after the document was made: a failed make writes nothing.
//!
//! A tab a create flow opened (the create window, a template copy, the AI's new
//! Word document) carries the placement of the window that opened it, so the
//! new tab's AI panel starts in that project and its first save lands in the
//! same folder. Without a project nothing here applies: callers keep their
//! behavior of today.
//!
//! No host object here: windows are named by webContents id and the shell
//! passes how to read a window's project and document. What the TypeScript
//! awaits is a plain synchronous call: a promise that rejects is an `Err` of
//! [`NodeError`], and the placement a create flow hands to `preset` is the
//! result of its own call, settled already.

use std::collections::HashMap;

use jscompat::node_path::host::join;
use jscompat::{js_regex, number_to_string, truthy};
use serde::{Deserialize, Serialize};

use super::folder_files::is_data_dir_name;
use super::paths::relative_inside;
use super::write_guard::{ProjectWriteRefusal, ProjectWriteRefused, WriteGuardError};
use crate::node_fs::{NodeError, namespaced};
use crate::packages::project_store::{ProjectId, ProjectWriteResult};

/// `NewDocumentPlacement`: where one window's new documents go
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewDocumentPlacement {
    pub project_id: ProjectId,
    /// the project folder (canonical, as listed)
    pub root: String,
    /// the folder new documents are written into: `root` or a folder below it
    pub dir: String,
}

/// `NewDocumentOpener`: who opened a create flow: the home ask, or an editor
/// window
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NewDocumentOpener {
    Home,
    #[serde(rename_all = "camelCase")]
    Window {
        web_contents_id: i64,
    },
}

/// `NEW_DOCUMENT_NAME_ATTEMPTS`: names tried for one new document before
/// giving up (a folder full of copies)
pub const NEW_DOCUMENT_NAME_ATTEMPTS: u32 = 1000;

/// `newDocumentFolder(root, docPath, platform)`: the folder rule (spec 6):
/// `docPath`'s folder when it is inside `root` and not under the data folder
/// (by any name it has had), else `root`. The result keeps the root's
/// spelling.
pub fn new_document_folder(root: &str, doc_path: Option<&str>, platform: &str) -> String {
    let Some(doc_path) = truthy(doc_path) else {
        return root.to_owned();
    };
    let Some(rel) = relative_inside(root, doc_path, platform) else {
        return root.to_owned();
    };
    let mut segments: Vec<&str> = rel.split('/').collect();
    segments.pop();
    let Some(first) = segments.first() else {
        return root.to_owned();
    };
    if is_data_dir_name(first) {
        return root.to_owned();
    }
    let mut parts: Vec<&str> = vec![root];
    parts.extend(segments);
    join(&parts)
}

/// `isBareFileName(fileName)`: whether `fileName` names a file only: no
/// folder part (either slash), no drive, not `.` or `..`. The folder always
/// comes from the placement, never from whoever named the document (an
/// editor passes a renderer's name on).
pub fn is_bare_file_name(file_name: &str) -> bool {
    if file_name.is_empty() || file_name == "." || file_name == ".." {
        return false;
    }
    !js_regex!(r"[\\/:]").test(file_name)
}

/// `numberedFileName(fileName, n)`: `name.ext` for 1, `name (2).ext` for 2,
/// and so on (the extension stays last)
pub fn numbered_file_name(file_name: &str, n: f64) -> String {
    if n <= 1.0 {
        return file_name.to_owned();
    }
    // `lastIndexOf('.')` is 0 only for a name that starts with the dot, and
    // `dot > 0` is the same test on the byte index
    let (base, ext) = match file_name.rfind('.') {
        Some(dot) if dot > 0 => (&file_name[..dot], &file_name[dot..]),
        _ => (file_name, ""),
    };
    format!("{base} ({}){ext}", number_to_string(n))
}

/// `entryExists(path)`: `lstat` answers
fn entry_exists(path: &str) -> bool {
    std::fs::symlink_metadata(namespaced(path)).is_ok()
}

/// `NewDocumentPlacerDeps.guide`: `Pick<ProjectGuide, 'projectRoot' | 'writeNewDocument'>`
pub trait NewDocumentsGuide {
    /// `projectRoot(id)`: the canonical folder of a listed project, or `None` (`null`)
    fn project_root(&mut self, id: &str) -> Option<String>;

    /// `writeNewDocument(id, target, data)`: throws `ProjectWriteRefused` (or
    /// the file system error); callers pick a free name
    fn write_new_document(
        &mut self,
        id: &str,
        target: &str,
        data: &[u8],
    ) -> Result<ProjectWriteResult, WriteGuardError>;
}

/// `NewDocumentPlacerDeps`
pub struct NewDocumentPlacerDeps<G: NewDocumentsGuide> {
    pub guide: G,
    /// the project the window's AI panel has chosen now; `None` for none or
    /// no AI window
    pub window_project: Box<dyn FnMut(i64) -> Result<Option<ProjectId>, NodeError>>,
    /// the window's saved document, as the shell knows it; `None` when
    /// untitled or unknown
    pub document_of: Box<dyn FnMut(i64) -> Option<String>>,
    /// `NodeJS.Platform` (`process.platform` where the TypeScript leaves it out)
    pub platform: String,
}

/// `NewDocumentPlacer`
pub struct NewDocumentPlacer<G: NewDocumentsGuide> {
    deps: NewDocumentPlacerDeps<G>,
    /// tabs opened by a create flow → the placement they were opened with
    presets: HashMap<i64, Option<NewDocumentPlacement>>,
}

impl<G: NewDocumentsGuide> NewDocumentPlacer<G> {
    pub fn new(deps: NewDocumentPlacerDeps<G>) -> Self {
        Self {
            deps,
            presets: HashMap::new(),
        }
    }

    /// `placementFor(webContentsId)`: where `webContentsId`'s new documents
    /// go now, or `None` when its panel has no project (the caller then does
    /// what it did before projects existed).
    pub fn placement_for(
        &mut self,
        web_contents_id: i64,
    ) -> Result<Option<NewDocumentPlacement>, NodeError> {
        let project_id = (self.deps.window_project)(web_contents_id)?;
        let Some(project_id) = truthy(project_id.as_deref()) else {
            return Ok(None);
        };
        let root = self.deps.guide.project_root(project_id);
        let Some(root) = truthy(root.as_deref()) else {
            return Ok(None);
        };
        let preset = self.preset_of(web_contents_id);
        if let Some(preset) = preset
            && preset.project_id == project_id
            && preset.root == root
        {
            return Ok(Some(preset));
        }
        let document = (self.deps.document_of)(web_contents_id);
        Ok(Some(NewDocumentPlacement {
            project_id: project_id.to_owned(),
            root: root.to_owned(),
            dir: new_document_folder(root, document.as_deref(), &self.deps.platform),
        }))
    }

    /// `placementOfOpener(opener, homeId)`: the placement of the window or
    /// home ask that opened a create flow
    pub fn placement_of_opener(
        &mut self,
        opener: Option<&NewDocumentOpener>,
        home_id: Option<i64>,
    ) -> Result<Option<NewDocumentPlacement>, NodeError> {
        match opener {
            None => Ok(None),
            Some(NewDocumentOpener::Window { web_contents_id }) => {
                self.placement_for(*web_contents_id)
            }
            Some(NewDocumentOpener::Home) => match home_id {
                None => Ok(None),
                Some(home_id) => self.placement_for(home_id),
            },
        }
    }

    /// `preset(webContentsId, placement)`: a create flow opened
    /// `webContentsId` for its opener: the tab starts in the opener's project
    /// and saves into the opener's folder (spec 5.2, 6). A placement that
    /// resolves to `None` leaves the tab as it is today; one that failed is
    /// `None` too (`placement.catch(() => null)`).
    pub fn preset(
        &mut self,
        web_contents_id: i64,
        placement: Result<Option<NewDocumentPlacement>, NodeError>,
    ) {
        self.presets
            .insert(web_contents_id, placement.ok().flatten());
    }

    /// `presetProjectOf(webContentsId)`: the project a create flow opened
    /// this tab in, or `None` (for the project request layer)
    pub fn preset_project_of(&mut self, web_contents_id: i64) -> Option<ProjectId> {
        let preset = self.preset_of(web_contents_id)?;
        let root = self.deps.guide.project_root(&preset.project_id);
        truthy(root.as_deref()).map(|_| preset.project_id)
    }

    /// `forget(webContentsId)`: the tab closed
    pub fn forget(&mut self, web_contents_id: i64) {
        self.presets.remove(&web_contents_id);
    }

    /// `saveDialogFolder(webContentsId)`: the folder an untitled document's
    /// save dialog opens in (spec 6): the placement's folder, or `None` for
    /// the editor's default save folder.
    pub fn save_dialog_folder(
        &mut self,
        web_contents_id: i64,
    ) -> Result<Option<String>, NodeError> {
        Ok(self
            .placement_for(web_contents_id)?
            .map(|placement| placement.dir))
    }

    /// `writeFor(webContentsId, fileName, bytes)`: write a new document of
    /// `webContentsId`'s run into its project folder; `None` (nothing
    /// written) when its panel has no project. Fails when the project folder
    /// refuses the write: nothing goes elsewhere instead.
    pub fn write_for(
        &mut self,
        web_contents_id: i64,
        file_name: &str,
        bytes: &[u8],
    ) -> Result<Option<String>, WriteGuardError> {
        match self.placement_for(web_contents_id)? {
            Some(placement) => self.write(&placement, file_name, bytes).map(Some),
            None => Ok(None),
        }
    }

    /// `write(placement, fileName, bytes)`: write `bytes` as `fileName` (or
    /// the first free numbered name) in the placement's folder through the
    /// write guard; the path written.
    pub fn write(
        &mut self,
        placement: &NewDocumentPlacement,
        file_name: &str,
        bytes: &[u8],
    ) -> Result<String, WriteGuardError> {
        if !is_bare_file_name(file_name) {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::BadPath, file_name).into());
        }
        for n in 1..=NEW_DOCUMENT_NAME_ATTEMPTS {
            let target = join(&[&placement.dir, &numbered_file_name(file_name, f64::from(n))]);
            if entry_exists(&target) {
                continue;
            }
            match self
                .deps
                .guide
                .write_new_document(&placement.project_id, &target, bytes)
            {
                Ok(_) => return Ok(target),
                // another write took the name in between: try the next one
                Err(WriteGuardError::Refused(refused))
                    if refused.reason == ProjectWriteRefusal::Exists => {}
                Err(error) => return Err(error),
            }
        }
        Err(ProjectWriteRefused::new(
            ProjectWriteRefusal::Exists,
            join(&[&placement.dir, file_name]),
        )
        .into())
    }

    /// `presetOf(webContentsId)`
    fn preset_of(&self, web_contents_id: i64) -> Option<NewDocumentPlacement> {
        self.presets.get(&web_contents_id).cloned().flatten()
    }
}
