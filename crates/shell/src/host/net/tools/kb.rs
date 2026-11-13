//! The host of the knowledge-base port (`shell_ipc_a::knowledge_base`): what
//! `apps/shell/src/main/knowledge-base.ts` took from modules that are not in
//! main-core. The default save folder is real (main-core's
//! `configured_default_save_dir` over the process's one state); the file
//! index, the file parser, the project folders, the docx writer and the
//! recent list wait for the parts that own them.

use std::sync::Arc;

use main_core::packages::electron_utils::default_save_dir::{
    PathProvider, Thrown, configured_default_save_dir,
};
use main_core::packages::electron_utils::unsaved_files::{OpenFileState, OpenFilesSourceFailed};
use main_core::packages::project_store::{ProjectReadRefusal, ProjectReadResult};
use main_core::shell::generate::materials::ParsedFile;
use main_core::shell::knowledge_base::{IndexedHit, KbWithin};
use main_core::shell::renderer_disposal::Failure;
use shell_contract::runtime::{AppPaths, PathName};
use shell_contract::{Hosts, ViewId};
use shell_ipc_a::knowledge_base::{KbServices, KbServicesHost, Placement, VisibleTest};
use shell_ipc_w::SharedSaveDirState;

use super::{NOT_BUILT, now_ms, unbuilt};
use crate::host::HostContext;
use crate::paths::ShellPaths;

pub(super) fn install(hosts: &mut Hosts, _cx: &HostContext) {
    let save_dir = hosts
        .get::<SharedSaveDirState>()
        .cloned()
        .unwrap_or_default();
    let services: KbServicesHost = Arc::new(ShellKb {
        paths: ShellPaths::new(),
        save_dir,
    });
    hosts.insert(services);
    hosts.insert(shell_ipc_a::knowledge_base::factory());
}

struct ShellKb {
    paths: ShellPaths,
    save_dir: SharedSaveDirState,
}

/// `app.getPath` for `default-save-dir.ts`
struct Paths<'a>(&'a ShellPaths);

impl PathProvider for Paths<'_> {
    fn get_path(&self, name: &str) -> Result<String, Thrown> {
        let name = match name {
            "home" => PathName::Home,
            "documents" => PathName::Documents,
            _ => PathName::UserData,
        };
        Ok(self.0.path(name).to_string_lossy().into_owned())
    }
}

impl KbServices for ShellKb {
    fn has_file_index(&self) -> bool {
        unbuilt("KbServices::has_file_index");
        false
    }

    fn refresh_file_index_if_stale(&self, _: u64) {
        unbuilt("KbServices::refresh_file_index_if_stale");
    }

    fn paths_indexed_as_on_disk(&self, _: &[String]) -> Vec<String> {
        unbuilt("KbServices::paths_indexed_as_on_disk");
        Vec::new()
    }

    fn index_search(&self, _: &str, _: f64, _: KbWithin<'_>) -> Result<Vec<IndexedHit>, Thrown> {
        unbuilt("KbServices::index_search");
        Err(Thrown(NOT_BUILT.into()))
    }

    fn open_files(&self) -> Result<Vec<OpenFileState>, OpenFilesSourceFailed> {
        // no tab is open, so no file has unsaved changes
        unbuilt("KbServices::open_files");
        Ok(Vec::new())
    }

    fn parse_file_to_text(&self, _: &str) -> Result<ParsedFile, Failure> {
        unbuilt("KbServices::parse_file_to_text");
        Err(Failure(NOT_BUILT.into()))
    }

    fn project_available(&self, _: &str) -> bool {
        unbuilt("KbServices::project_available");
        false
    }

    fn project_visible_test(&self, _: &str) -> Option<VisibleTest> {
        unbuilt("KbServices::project_visible_test");
        None
    }

    fn project_read(&self, _: ViewId, _: &str, _: &str, _: f64) -> ProjectReadResult {
        unbuilt("KbServices::project_read");
        ProjectReadResult::Refused {
            reason: ProjectReadRefusal::Unreadable,
        }
    }

    fn new_document_placement(&self, _: ViewId) -> Result<Option<Placement>, String> {
        // no window has a project panel yet
        unbuilt("KbServices::new_document_placement");
        Ok(None)
    }

    fn write_project_document(&self, _: &Placement, _: &str, _: Vec<u8>) -> Result<String, String> {
        unbuilt("KbServices::write_project_document");
        Err(NOT_BUILT.into())
    }

    /// `defaultSaveDir()` of docs-main
    fn default_save_dir(&self) -> Result<String, String> {
        let mut state = self
            .save_dir
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        configured_default_save_dir(&Paths(&self.paths), &mut state, now_ms()).map_err(|e| e.0)
    }

    fn markdown_to_docx(&self, _: &str, _: &str) -> Result<(), String> {
        unbuilt("KbServices::markdown_to_docx");
        Err(NOT_BUILT.into())
    }

    fn record_recent_file(&self, _: &str) {
        unbuilt("KbServices::record_recent_file");
    }
}
