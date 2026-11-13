//! `projectFolderServices()` of `apps/shell/src/main/index.ts`: the one project
//! guide, chat store and set of project tools of the shell, made on first use,
//! and the seven traits `main-core`'s [`ProjectIpc`] is served through.
//!
//! The guide is shared (an `Rc`) by the chat store, the tools and the new
//! document placer, as the one object of the TypeScript is. What the
//! TypeScript took from Electron is a host call here: the clock is
//! [`HomeFiles::now_ms`], the language is read from the settings as
//! `currentLang()` reads it, the dialogs are `DialogsHost` message boxes over
//! the window [`TabsState`] names, the window of a webContents is the
//! `TabsState` that owns the tab strip.

use std::cell::RefCell;
use std::collections::HashSet;
use std::path::Path;
use std::rc::{Rc, Weak};
use std::sync::Arc;

use jscompat::{JsMap, JsObject, JsonValue, base64, to_iso_string};
use main_core::packages::ai_provider::agent_session_policy::process_platform;
use main_core::packages::electron_utils::default_save_dir::{
    PathProvider, Thrown, configured_default_save_dir,
};
use main_core::packages::electron_utils::message_box::MessageBoxOptions;
use main_core::packages::electron_utils::unsaved_files::OpenFilesHolder;
use main_core::packages::i18n::{Lang, install_lang, normalize_lang};
use main_core::packages::project_store::{
    AddFolderResult, ApplyMemoryConsolidationArgs, ApplyMemoryConsolidationResult,
    CreateProjectResult, DecideTrustResult, LegacyDocumentChat, ProjectChatListItem,
    ProjectChatRef, ProjectContextResult, ProjectDetail, ProjectEditor, ProjectId,
    ProjectListFilesResult, ProjectListItem, ProjectMemoryEditResult, ProjectMemoryOp,
    ProjectReadResult, ProjectSearchResult, ProjectSelection, ProjectSettings, ProjectTrustAnswer,
    ProjectTrustDecision, ProjectWriteResult, UndoMemoryConsolidationArgs,
    UndoMemoryConsolidationResult,
};
use main_core::shell::app_settings::read_app_settings;
use main_core::shell::knowledge_base::KbReadPage;
use main_core::shell::projects::chat_store::{
    AppendOutcome, ChatAppendedEvent, ChatAppendedListener, ChatSender, ChatStoreHost,
    ChatStoreOptions, OpenChatOutcome, ProjectChatStore, default_new_id,
};
use main_core::shell::projects::cloud_cache::{CacheClock, CachedCloudResolver};
use main_core::shell::projects::cloud_files::{
    ListingFailure, ListingRun, ListingRunOptions, PowerShellAttributeReader, ResolveOptions,
    resolve_cloud_only,
};
use main_core::shell::projects::new_documents::{NewDocumentPlacer, NewDocumentPlacerDeps};
use main_core::shell::projects::project_dialog_text::{
    IntlFormat, ProjectFolderPickPurpose, download_prompt_options, folder_picker_options,
    trust_choice_of, trust_prompt_options, use_existing_prompt_options,
};
use main_core::shell::projects::project_files::{
    CachedFileLister, CloudOnlyResolver, ContextFilesSource, ListVisibleFiles, ResolveFailure,
    VisibleFile, VisibleFileLister,
};
use main_core::shell::projects::project_guide::{
    ContextFiles, ContextFilesProvider, ContextFilesRequest, GuideError, GuideStep, MemoryEditor,
    NewProjectRequest, PendingAdopt, PendingAdoptFolderHint, PendingDecideTrust,
    ProjectAiVisibility, ProjectGuide, ProjectGuideDeps,
    ProjectSettingsPatch as GuideSettingsPatch, SelectionTarget,
};
use main_core::shell::projects::project_ipc::{
    AppendedNotice, ChatDocuments, MemoryAuthor, ProjectIpcChats, ProjectIpcDialogs,
    ProjectIpcGuide, ProjectIpcHost, ProjectIpcScopes, ProjectIpcTools, ProjectSettingsPatch,
    ProjectWindow,
};
use main_core::shell::projects::project_tools::{
    DownloadAsk, IndexSearchOptions, IndexSearchResult, IndexStore, KnowledgePages,
    ProjectFolderTools, ProjectToolsDeps, ProjectToolsScopes, ProjectToolsStore,
};
use serde_json::Value;
use shell_contract::hosts::{FileDialog, MessageBox};
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::ipc::{EventSink, Target};
use shell_contract::provided::Provided;
use shell_contract::runtime::{AppPaths, PathName, Views};
use shell_contract::{DialogsHost, OsShellHost};

use super::Projects;
use super::host::{LegacyProjectStoreHost, ProjectFilesHost, ProjectsHostRef};
use crate::home_files::{FileSearchHost, HomeFilesHost};
use crate::tabs::TabsState;

/// `PROJECT_EDITORS` less `home`, by the name of the tab kind
fn editor_of(kind: &str) -> Option<ProjectEditor> {
    Some(match kind {
        "docs" => ProjectEditor::Docs,
        "sheets" => ProjectEditor::Sheets,
        "slides" => ProjectEditor::Slides,
        "pdf" => ProjectEditor::Pdf,
        "markdown" => ProjectEditor::Markdown,
        "html" => ProjectEditor::Html,
        "mindmap" => ProjectEditor::Mindmap,
        "hwp" => ProjectEditor::Hwp,
        "epub" => ProjectEditor::Epub,
        _ => return None,
    })
}

fn thrown(error: GuideError) -> Thrown {
    Thrown(error.message())
}

// ---- what every part needs of the shell ----

/// The hosts and paths the parts of the services share
#[derive(Clone)]
pub(super) struct Shell {
    pub host: ProjectsHostRef,
    pub home: HomeFilesHost,
    pub search: FileSearchHost,
    pub files: ProjectFilesHost,
    pub legacy: LegacyProjectStoreHost,
    pub dialogs: DialogsHost,
    pub os: OsShellHost,
    pub events: Arc<dyn EventSink>,
    pub views: Arc<dyn Views>,
    pub paths: Arc<dyn AppPaths>,
    pub provided: Rc<Provided>,
    /// the process's one default-save-folder state
    pub save_dir: crate::SharedSaveDirState,
}

impl Shell {
    fn at(&self, name: PathName) -> String {
        self.paths.path(name).to_string_lossy().into_owned()
    }

    pub(super) fn settings_path(&self) -> String {
        self.paths
            .path(PathName::UserData)
            .join("app-settings.json")
            .to_string_lossy()
            .into_owned()
    }

    /// `currentLang()`
    pub(super) fn lang(&self) -> Lang {
        if let Ok(env) = std::env::var("SEUOFFICE_LANG") {
            return normalize_lang(Some(&env));
        }
        let settings = read_app_settings(&self.settings_path());
        install_lang(settings.get("language"), Some(&self.home.system_locale()))
    }

    /// the tab strip, once the tabs batch has registered
    pub(super) fn tabs(&self) -> Option<Rc<TabsState>> {
        self.provided.all::<TabsState>().into_iter().next()
    }

    /// `projectDialogParent(owner)`: the window a dialog about `owner` sits over
    fn parent_of(&self, owner: i64) -> Option<WindowId> {
        self.tabs()?.dialog_parent(view_of(owner)?)
    }

    /// `projectMessageBox(owner, options)`: the pressed button
    pub(super) fn message_box(&self, owner: i64, options: &MessageBoxOptions) -> usize {
        let parent = self.parent_of(owner);
        self.dialogs.message(parent, &message_of(options)).response
    }

    /// `dialog.showOpenDialog` for a folder, over `owner`'s window
    fn pick_folder(&self, owner: i64, purpose: ProjectFolderPickPurpose) -> Option<String> {
        let options = folder_picker_options(self.lang(), purpose);
        let text = |key: &str| match options.get(key) {
            Some(JsonValue::String(text)) => Some(text.clone()),
            _ => None,
        };
        let dialog = FileDialog {
            title: text("title"),
            button_label: text("buttonLabel"),
            properties: match options.get("properties") {
                Some(JsonValue::Array(items)) => items
                    .iter()
                    .filter_map(|item| match item {
                        JsonValue::String(text) => Some(text.clone()),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            },
            ..FileDialog::default()
        };
        let picked = self.dialogs.open(self.parent_of(owner), &dialog)?;
        picked
            .first()
            .map(|path| path.to_string_lossy().into_owned())
    }

    /// `askTrust(owner, prompt)`: the person's pick, `None` when closed
    pub(super) fn ask_trust(
        &self,
        owner: i64,
        prompt: &main_core::packages::project_store::ProjectTrustPrompt,
    ) -> Option<main_core::shell::projects::project_dialog_text::ProjectTrustChoice> {
        let options = trust_prompt_options(self.lang(), prompt, &Intl(self.host.as_ref()));
        trust_choice_of(self.message_box(owner, &options) as f64)
    }
}

/// `webContents.fromId(id)`'s id as a view; `None` for an id no view has
fn view_of(id: i64) -> Option<ViewId> {
    u32::try_from(id).ok().map(ViewId)
}

fn message_of(options: &MessageBoxOptions) -> MessageBox {
    MessageBox {
        kind: Some(options.kind.to_owned()),
        title: options.title.clone(),
        message: options.message.clone(),
        detail: options.detail.clone(),
        buttons: options.buttons.clone(),
        default_id: Some(options.default_id as usize),
        cancel_id: options.cancel_id.map(|id| id as usize),
        checkbox_label: None,
    }
}

/// `Intl` as the host formats it
struct Intl<'a>(&'a dyn super::host::ProjectsHost);

impl IntlFormat for Intl<'_> {
    fn format_number(&self, count: f64, lang: Lang) -> Result<String, Thrown> {
        self.0.format_number(count, lang).map_err(Thrown)
    }

    fn format_date_time(&self, at_ms: f64, lang: Lang) -> Result<String, Thrown> {
        self.0.format_date_time(at_ms, lang).map_err(Thrown)
    }
}

/// `app.getPath` for the default save folder
struct Paths<'a>(&'a dyn AppPaths);

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

/// `options.now` of the cached lists: the clock of the process
struct Clock(HomeFilesHost);

impl CacheClock for Clock {
    fn now(&mut self) -> f64 {
        self.0.now_ms()
    }
}

/// `process.env` as an object
fn process_env() -> JsObject<String> {
    let mut env = JsObject::new();
    for (key, value) in std::env::vars() {
        env.set(key, value);
    }
    env
}

// ---- "not on this PC", and the lists that reuse a verdict or a walk ----

/// `execFileListing` over the host
struct HostListing(ProjectsHostRef);

impl ListingRun for HostListing {
    fn run(
        &mut self,
        file: &str,
        args: &[String],
        options: &ListingRunOptions<'_>,
    ) -> Result<String, ListingFailure> {
        let env: Vec<(String, String)> = options
            .env
            .entries()
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value.clone()))
            .collect();
        self.0
            .run_listing(
                file,
                args,
                options.cwd,
                &env,
                options.timeout_ms,
                options.input,
            )
            .map_err(ListingFailure)
    }
}

/// `resolveCloudOnly(paths)`: one detector run per call
struct DetectCloudOnly(ProjectsHostRef);

impl CloudOnlyResolver for DetectCloudOnly {
    fn resolve(&mut self, paths: &[String]) -> Result<JsMap<bool>, ResolveFailure> {
        let env = process_env();
        let mut reader = PowerShellAttributeReader::new(env.clone(), HostListing(self.0.clone()));
        let home = self.0.os_home_dir();
        Ok(resolve_cloud_only(
            paths,
            &env,
            &ResolveOptions {
                platform: process_platform(),
                timeout_ms: None,
                home_dir: None,
                os_home_dir: &home,
                extra_roots: &[],
            },
            &mut reader,
        ))
    }
}

type CachedCloud = Rc<RefCell<CachedCloudResolver<DetectCloudOnly, Clock>>>;
type CachedLister = Rc<RefCell<CachedFileLister<ListVisibleFiles, Clock>>>;

/// `projectListCloudOnly`, shared by the context file names, the tools' lists
/// and the project screen
#[derive(Clone)]
pub(super) struct SharedCloud(CachedCloud);

impl CloudOnlyResolver for SharedCloud {
    fn resolve(&mut self, paths: &[String]) -> Result<JsMap<bool>, ResolveFailure> {
        self.0.borrow_mut().resolve(paths)
    }
}

/// `projectFileLister`
#[derive(Clone)]
struct SharedLister(CachedLister);

impl VisibleFileLister for SharedLister {
    fn list(&mut self, visibility: &ProjectAiVisibility) -> Result<Vec<VisibleFile>, Thrown> {
        self.0.borrow_mut().list(visibility)
    }
}

// ---- the run scopes of the project tools ----

/// How many run scopes are held at once; the oldest is dropped past this
const SCOPES_MAX: usize = 16;

/// `KbRunScopes` as the project services use it: scopes that cover a project
/// folder only, minted from random bytes
pub(super) struct ProjectScopes {
    host: ProjectsHostRef,
    /// scope, owner, project: the oldest first
    held: Vec<(String, i64, ProjectId)>,
}

impl ProjectScopes {
    /// `heldFor(owner, raw)`: the project of the scope a call names; `Ok(None)`
    /// when it names none, an `Err` for a scope that is not held or is
    /// another window's
    fn project_of(&self, owner: i64, raw: &JsonValue) -> Result<Option<ProjectId>, Thrown> {
        let JsonValue::Object(object) = raw else {
            return Ok(None);
        };
        let Some(scope) = object.get("scope") else {
            return Ok(None);
        };
        let held = match scope {
            JsonValue::String(scope) => self.held.iter().find(|(known, ..)| known == scope),
            _ => None,
        };
        match held {
            Some((_, held_owner, project)) if *held_owner == owner => Ok(Some(project.clone())),
            _ => Err(Thrown("knowledge-base scope is not open".to_owned())),
        }
    }
}

#[derive(Clone)]
pub(super) struct SharedScopes(Rc<RefCell<ProjectScopes>>);

impl ProjectToolsScopes for SharedScopes {
    fn open_project(&mut self, owner: i64, project_id: &str) -> String {
        let mut scopes = self.0.borrow_mut();
        let scope: String = scopes
            .host
            .random_bytes(24)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        scopes
            .held
            .push((scope.clone(), owner, project_id.to_owned()));
        while scopes.held.len() > SCOPES_MAX {
            scopes.held.remove(0);
        }
        scope
    }

    fn close(&mut self, owner: i64, scope: Option<&JsonValue>) {
        let Some(JsonValue::String(scope)) = scope else {
            return;
        };
        self.0
            .borrow_mut()
            .held
            .retain(|(known, held_owner, _)| !(known == scope && *held_owner == owner));
    }

    fn project_of(&mut self, owner: i64, raw: &JsonValue) -> Result<Option<ProjectId>, Thrown> {
        self.0.borrow().project_of(owner, raw)
    }
}

impl ProjectIpcScopes for SharedScopes {
    fn project_of(&mut self, owner: i64, raw: &JsonValue) -> Result<Option<ProjectId>, Thrown> {
        self.0.borrow().project_of(owner, raw)
    }
}

// ---- the index and the knowledge reader for the tools ----

/// `fileIndexStore`, `Pick<FileIndexStore, 'search' | 'pathsIndexedAsOnDisk'>`
struct IndexOfHost(ProjectFilesHost);

impl IndexStore for IndexOfHost {
    fn search(
        &mut self,
        input: &str,
        options: &mut IndexSearchOptions<'_>,
    ) -> Result<IndexSearchResult, Thrown> {
        self.0.search(input, options)
    }

    fn paths_indexed_as_on_disk(&mut self, paths: &[String]) -> Vec<String> {
        self.0.paths_indexed_as_on_disk(paths)
    }
}

/// `store: () => { ensureFileIndexer()?.refreshIfStale(60_000); return fileIndexStore }`
struct StoreOfShell {
    search: FileSearchHost,
    index: IndexOfHost,
}

impl ProjectToolsStore for StoreOfShell {
    fn store(&mut self) -> Option<&mut dyn IndexStore> {
        if !self.search.available() {
            return None;
        }
        self.search.refresh_if_stale(60_000.0);
        Some(&mut self.index)
    }
}

struct PagesOfHost(ProjectFilesHost);

impl KnowledgePages for PagesOfHost {
    fn read_page(&mut self, file_path: &str, offset: f64) -> Result<KbReadPage, Thrown> {
        self.0.read_page(file_path, offset)
    }
}

// ---- the guide ----

/// What a guide call that asked the trust question keeps until the answer
#[derive(Debug, Clone, PartialEq)]
pub(super) enum GuidePending {
    Adopt(PendingAdopt),
    AdoptFolderHint(PendingAdoptFolderHint),
    DecideTrust(PendingDecideTrust),
}

fn adopt_step<T>(
    step: GuideStep<T, PendingAdopt>,
    pending: impl FnOnce(PendingAdopt) -> GuidePending,
) -> GuideStep<T, GuidePending> {
    match step {
        GuideStep::Done(result) => GuideStep::Done(result),
        GuideStep::AskTrust { prompt, pending: p } => GuideStep::AskTrust {
            prompt,
            pending: pending(p),
        },
    }
}

/// An unexpected kind of pending state: the step of another operation
fn wrong_pending() -> Thrown {
    Thrown("the trust answer belongs to another request".to_owned())
}

pub(super) struct GuideOfShell(pub Rc<ProjectGuide>);

impl ProjectIpcGuide for GuideOfShell {
    type Pending = GuidePending;

    fn list_projects(&mut self) -> Result<Vec<ProjectListItem>, Thrown> {
        Ok(self.0.list_projects())
    }

    fn add_folder(
        &mut self,
        folder_path: &str,
    ) -> Result<GuideStep<AddFolderResult, GuidePending>, Thrown> {
        let step = self.0.add_folder(folder_path).map_err(thrown)?;
        Ok(adopt_step(step, GuidePending::Adopt))
    }

    fn relocate_project(
        &mut self,
        id: &str,
        folder_path: &str,
    ) -> Result<GuideStep<AddFolderResult, GuidePending>, Thrown> {
        let step = self.0.relocate_project(id, folder_path).map_err(thrown)?;
        Ok(adopt_step(step, GuidePending::Adopt))
    }

    fn get_default_parent_folder(&mut self) -> Result<String, Thrown> {
        Ok(self.0.get_default_parent_folder())
    }

    fn create_project(
        &mut self,
        request: &NewProjectRequest,
    ) -> Result<GuideStep<CreateProjectResult, GuidePending>, Thrown> {
        let step = self.0.create_project(request).map_err(thrown)?;
        Ok(adopt_step(step, GuidePending::Adopt))
    }

    fn remove_from_list(&mut self, id: &str) -> Result<(), Thrown> {
        self.0.remove_from_list(id).map_err(thrown)
    }

    fn set_pinned(&mut self, id: &str, pinned: bool) -> Result<(), Thrown> {
        self.0.set_pinned(id, pinned).map_err(thrown)
    }

    fn rename_project(&mut self, id: &str, name: &str) -> Result<ProjectWriteResult, Thrown> {
        self.0.rename_project(id, name).map_err(thrown)
    }

    fn retry_unwritable(&mut self, id: &str) -> Result<ProjectWriteResult, Thrown> {
        self.0.retry_unwritable(id).map_err(thrown)
    }

    fn project_root(&mut self, id: &str) -> Option<String> {
        self.0.project_root(id)
    }

    fn get_selection(&mut self, target: &SelectionTarget) -> Result<ProjectSelection, Thrown> {
        self.0.get_selection(target).map_err(thrown)
    }

    fn set_selection(
        &mut self,
        target: &SelectionTarget,
        project_id: Option<&str>,
    ) -> Result<ProjectSelection, Thrown> {
        self.0.set_selection(target, project_id).map_err(thrown)
    }

    fn adopt_folder_hint(
        &mut self,
        doc_path: &str,
    ) -> Result<GuideStep<AddFolderResult, GuidePending>, Thrown> {
        Ok(match self.0.adopt_folder_hint(doc_path).map_err(thrown)? {
            GuideStep::Done(result) => GuideStep::Done(result),
            GuideStep::AskTrust { prompt, pending } => GuideStep::AskTrust {
                prompt,
                pending: GuidePending::AdoptFolderHint(pending),
            },
        })
    }

    fn read_context(&mut self, id: &str) -> Result<ProjectContextResult, Thrown> {
        self.0.read_context(id).map_err(thrown)
    }

    fn edit_memory(
        &mut self,
        id: &str,
        change: &ProjectMemoryOp,
        by: MemoryAuthor,
    ) -> Result<ProjectMemoryEditResult, Thrown> {
        let by = match by {
            MemoryAuthor::Ai => MemoryEditor::Ai,
            MemoryAuthor::Person => MemoryEditor::Person,
        };
        self.0.edit_memory(id, change, by).map_err(thrown)
    }

    fn save_memory(&mut self, id: &str, text: &str) -> Result<ProjectWriteResult, Thrown> {
        self.0.save_memory(id, text).map_err(thrown)
    }

    fn apply_memory_consolidation(
        &mut self,
        project_id: &str,
        entries: &[JsonValue],
    ) -> Result<ApplyMemoryConsolidationResult, Thrown> {
        let strings: Option<Vec<String>> = entries
            .iter()
            .map(|entry| match entry {
                JsonValue::String(text) => Some(text.clone()),
                _ => None,
            })
            .collect();
        match strings {
            Some(entries) => self
                .0
                .apply_memory_consolidation(&ApplyMemoryConsolidationArgs {
                    project_id: project_id.to_owned(),
                    entries,
                })
                .map_err(thrown),
            None => {
                // the project is looked up before the entries are checked
                if self.0.project_root(project_id).is_none() {
                    return Err(Thrown(format!("unknown project {project_id}")));
                }
                Err(Thrown("entries must be a list of strings".to_owned()))
            }
        }
    }

    fn undo_memory_consolidation(
        &mut self,
        project_id: &str,
        backup_name: &str,
    ) -> Result<UndoMemoryConsolidationResult, Thrown> {
        self.0
            .undo_memory_consolidation(&UndoMemoryConsolidationArgs {
                project_id: project_id.to_owned(),
                backup_name: backup_name.to_owned(),
            })
            .map_err(thrown)
    }

    fn get_project_detail(&mut self, id: &str) -> Result<ProjectDetail, Thrown> {
        self.0.get_project_detail(id).map_err(thrown)
    }

    fn get_settings(&mut self, id: &str) -> Result<ProjectSettings, Thrown> {
        Ok(self.0.get_settings(id))
    }

    fn set_settings(
        &mut self,
        id: &str,
        patch: &ProjectSettingsPatch,
    ) -> Result<ProjectSettings, Thrown> {
        self.0
            .set_settings(
                id,
                &GuideSettingsPatch {
                    memory_enabled: patch.memory_enabled,
                    read_agents_files: patch.read_agents_files,
                },
            )
            .map_err(thrown)
    }

    fn decide_trust(
        &mut self,
        id: &str,
        decision: ProjectTrustDecision,
    ) -> Result<GuideStep<DecideTrustResult, GuidePending>, Thrown> {
        Ok(match self.0.decide_trust(id, decision).map_err(thrown)? {
            GuideStep::Done(result) => GuideStep::Done(result),
            GuideStep::AskTrust { prompt, pending } => GuideStep::AskTrust {
                prompt,
                pending: GuidePending::DecideTrust(pending),
            },
        })
    }

    fn save_instructions(&mut self, id: &str, text: &str) -> Result<ProjectWriteResult, Thrown> {
        self.0.save_instructions(id, text).map_err(thrown)
    }

    fn add_ignore(&mut self, id: &str, rel_path: &str) -> Result<ProjectWriteResult, Thrown> {
        self.0.add_ignore(id, rel_path).map_err(thrown)
    }

    fn remove_ignore(&mut self, id: &str, rel_path: &str) -> Result<ProjectWriteResult, Thrown> {
        self.0.remove_ignore(id, rel_path).map_err(thrown)
    }

    fn ai_visibility(&mut self, id: &str) -> Result<Option<ProjectAiVisibility>, Thrown> {
        self.0.ai_visibility(id).map_err(thrown)
    }

    fn resume_add_folder(
        &mut self,
        pending: GuidePending,
        answer: ProjectTrustAnswer,
    ) -> Result<AddFolderResult, Thrown> {
        let GuidePending::Adopt(pending) = pending else {
            return Err(wrong_pending());
        };
        self.0.resume_add_folder(pending, answer).map_err(thrown)
    }

    fn resume_create_project(
        &mut self,
        pending: GuidePending,
        answer: ProjectTrustAnswer,
    ) -> Result<CreateProjectResult, Thrown> {
        let GuidePending::Adopt(pending) = pending else {
            return Err(wrong_pending());
        };
        self.0
            .resume_create_project(pending, answer)
            .map_err(thrown)
    }

    fn resume_adopt_folder_hint(
        &mut self,
        pending: GuidePending,
        answer: ProjectTrustAnswer,
    ) -> Result<AddFolderResult, Thrown> {
        let GuidePending::AdoptFolderHint(pending) = pending else {
            return Err(wrong_pending());
        };
        self.0
            .resume_adopt_folder_hint(pending, answer)
            .map_err(thrown)
    }

    fn resume_decide_trust(
        &mut self,
        pending: GuidePending,
        answer: ProjectTrustAnswer,
    ) -> Result<DecideTrustResult, Thrown> {
        let GuidePending::DecideTrust(pending) = pending else {
            return Err(wrong_pending());
        };
        self.0.resume_decide_trust(pending, answer).map_err(thrown)
    }
}

// ---- the chats ----

/// `ProjectChatStoreDeps.trash`, the clock and the ids of the chat store
struct ChatHost {
    shell: Shell,
}

impl ChatStoreHost for ChatHost {
    fn trash(&mut self, abs_path: &str) -> Result<(), String> {
        self.shell.os.trash_item(Path::new(abs_path))
    }

    fn now_iso(&mut self) -> String {
        to_iso_string(self.shell.home.now_ms()).unwrap_or_default()
    }

    fn new_id(&mut self) -> String {
        let mut bytes = [0u8; 12];
        let random = self.shell.host.random_bytes(12);
        bytes.copy_from_slice(&random[..12]);
        default_new_id(&bytes)
    }

    fn warn(&mut self, label: &str, detail: Option<&str>) {
        self.shell.host.warn(label, detail);
    }
}

/// The messages the store's `onAppended` listener saw, for [`ProjectIpcChats::take_appended`]
struct Collect(Rc<RefCell<Vec<AppendedNotice>>>);

impl ChatAppendedListener for Collect {
    fn appended(&mut self, event: &ChatAppendedEvent, sender: &ChatSender) -> Result<(), String> {
        self.0.borrow_mut().push(AppendedNotice {
            event: event.clone(),
            from: sender.key.clone(),
        });
        Ok(())
    }
}

pub(super) struct ChatsOfShell {
    store: ProjectChatStore<Rc<ProjectGuide>, ChatHost>,
    appended: Rc<RefCell<Vec<AppendedNotice>>>,
}

fn chat_error(error: main_core::shell::projects::chat_store::ChatStoreError) -> Thrown {
    Thrown(error.0)
}

impl ProjectIpcChats for ChatsOfShell {
    fn new_chat(&mut self, project_id: &str) -> Result<ProjectId, Thrown> {
        self.store.new_chat(project_id).map_err(chat_error)
    }

    fn list_chats(&mut self, project_id: &str) -> Result<Vec<ProjectChatListItem>, Thrown> {
        self.store.list_chats(project_id).map_err(chat_error)
    }

    fn open_chat(&mut self, args: &JsonValue) -> Result<Value, Thrown> {
        let outcome: OpenChatOutcome = self.store.open_chat(args).map_err(chat_error)?;
        serde_json::to_value(&outcome).map_err(|error| Thrown(error.to_string()))
    }

    fn append(&mut self, args: &JsonValue, sender: &ChatSender) -> Result<Value, Thrown> {
        let outcome: AppendOutcome = self.store.append(args, sender).map_err(chat_error)?;
        serde_json::to_value(&outcome).map_err(|error| Thrown(error.to_string()))
    }

    fn rename_chat(&mut self, args: &JsonValue) -> Result<ProjectWriteResult, Thrown> {
        self.store.rename_chat(args).map_err(chat_error)
    }

    fn delete_chat(&mut self, chat_ref: &ProjectChatRef) -> Result<ProjectWriteResult, Thrown> {
        self.store.delete_chat(chat_ref).map_err(chat_error)
    }

    fn attach_document(
        &mut self,
        chat_ref: &ProjectChatRef,
        doc_path: &str,
    ) -> Result<ProjectWriteResult, Thrown> {
        self.store
            .attach_document(chat_ref, doc_path)
            .map_err(chat_error)
    }

    fn chat_for_document(
        &mut self,
        project_id: &str,
        doc_path: &str,
    ) -> Result<Option<ProjectId>, Thrown> {
        self.store
            .chat_for_document(project_id, doc_path)
            .map_err(chat_error)
    }

    fn chat_info(&mut self, chat_ref: &ProjectChatRef) -> Result<Option<ChatDocuments>, Thrown> {
        Ok(self
            .store
            .chat_info(chat_ref)
            .map_err(chat_error)?
            .map(|info| ChatDocuments {
                documents: info.documents(),
                last_editor: info.last_editor(),
            }))
    }

    fn take_appended(&mut self) -> Vec<AppendedNotice> {
        std::mem::take(&mut self.appended.borrow_mut())
    }
}

// ---- the tools ----

pub(super) struct ToolsOfShell {
    tools: ProjectFolderTools,
    /// `setOpenFilesSource`: the shell's open documents, asked when a read or
    /// a search must leave out files open with unsaved changes
    open_files: OpenFilesHolder,
}

impl ProjectIpcTools for ToolsOfShell {
    fn open_scope(&mut self, owner: i64, raw: &JsonValue) -> Result<String, Thrown> {
        self.tools.open_scope(owner, raw)
    }

    fn close_scope(&mut self, owner: i64, raw: &JsonValue) {
        self.tools.close_scope(owner, raw);
    }

    fn list_files(
        &mut self,
        owner: i64,
        raw: &JsonValue,
    ) -> Result<ProjectListFilesResult, Thrown> {
        self.tools.list_files(owner, raw)
    }

    fn search(&mut self, owner: i64, raw: &JsonValue) -> Result<ProjectSearchResult, Thrown> {
        self.tools.search(&self.open_files, owner, raw)
    }

    fn read(&mut self, owner: i64, raw: &JsonValue) -> Result<ProjectReadResult, Thrown> {
        self.tools.read(&self.open_files, owner, raw)
    }
}

// ---- the dialogs and the rest of the shell ----

pub(super) struct DialogsOfShell(Shell);

impl ProjectIpcDialogs for DialogsOfShell {
    fn pick_folder(
        &mut self,
        owner: i64,
        purpose: ProjectFolderPickPurpose,
    ) -> Result<Option<String>, Thrown> {
        Ok(self.0.pick_folder(owner, purpose))
    }

    fn confirm_use_existing(&mut self, owner: i64, folder_path: &str) -> Result<bool, Thrown> {
        let options = use_existing_prompt_options(self.0.lang(), folder_path);
        Ok(self.0.message_box(owner, &options) == 0)
    }
}

pub(super) struct HostOfShell {
    shell: Shell,
    lister: SharedLister,
    cloud: SharedCloud,
    placer: Rc<RefCell<NewDocumentPlacer<Rc<ProjectGuide>>>>,
    tracked: Rc<RefCell<HashSet<ViewId>>>,
}

impl HostOfShell {
    /// `trackProjectContents(contents)`
    fn track(&self, view: ViewId) {
        if self.tracked.borrow_mut().insert(view) {
            self.shell.host.track(view);
        }
    }
}

impl ProjectIpcHost for HostOfShell {
    fn window_of(&mut self, sender: i64) -> Option<ProjectWindow> {
        let tabs = self.shell.tabs();
        let view = view_of(sender)?;
        if tabs.as_ref()?.shell_window().map(|shell| shell.view) == Some(view) {
            return Some(ProjectWindow::Home);
        }
        let doc = tabs?.document_of(view)?;
        Some(ProjectWindow::Editor {
            editor: editor_of(doc.kind.as_str())?,
            doc_path: doc.file_path,
        })
    }

    fn send(&mut self, target: i64, channel: &str, payload: &Value) -> bool {
        let Some(view) = view_of(target) else {
            return false;
        };
        if self.shell.views.sender_of(view).is_none() {
            return false;
        }
        let Some(channel) = main_core::packages::project_store::PROJECT_FOLDER_EVENTS
            .iter()
            .map(|(_, channel)| *channel)
            .find(|known| *known == channel)
        else {
            return false;
        };
        self.shell
            .events
            .emit(Target::View(view), channel, vec![super::to_ipc(payload)]);
        true
    }

    fn legacy_chat_for(&mut self, doc_path: &str) -> Result<Option<LegacyDocumentChat>, Thrown> {
        self.shell.legacy.legacy_chat_for(doc_path).map_err(Thrown)
    }

    fn open_folder(&mut self, path: &str) -> Result<(), Thrown> {
        // `shell.openPath` answers an error text and never throws
        let _ = self.shell.os.open_path(Path::new(path));
        Ok(())
    }

    fn open_document(&mut self, path: &str) -> Option<i64> {
        let tabs = self.shell.tabs()?;
        if !tabs.open_document_path(path) {
            return None;
        }
        let view = tabs.view_of_file(path)?;
        self.track(view);
        Some(i64::from(view.0))
    }

    fn show_home(&mut self) -> Option<i64> {
        let tabs = self.shell.tabs()?;
        tabs.reveal_shell_window();
        tabs.open_home_tab();
        let view = tabs.shell_window()?.view;
        self.track(view);
        Some(i64::from(view.0))
    }

    fn projects_changed(&mut self) {
        self.lister.0.borrow_mut().invalidate(None);
        self.shell.search.refresh();
    }

    fn cloud_only(&mut self) -> Option<&mut dyn CloudOnlyResolver> {
        Some(&mut self.cloud)
    }

    fn preset_project_of(&mut self, sender: i64) -> Result<Option<ProjectId>, Thrown> {
        Ok(self.placer.borrow_mut().preset_project_of(sender))
    }
}

// ---- all of it ----

/// `ProjectFolderRuntime`
pub(super) struct Services {
    pub guide: GuideOfShell,
    pub chats: ChatsOfShell,
    pub tools: ToolsOfShell,
    pub scopes: SharedScopes,
    pub dialogs: DialogsOfShell,
    pub host: HostOfShell,
    pub placer: Rc<RefCell<NewDocumentPlacer<Rc<ProjectGuide>>>>,
}

impl Services {
    /// `projects` serves the placer the project a window's panel chose
    pub(super) fn new(
        shell: &Shell,
        tracked: Rc<RefCell<HashSet<ViewId>>>,
        projects: Weak<Projects>,
    ) -> Services {
        let cloud = SharedCloud(Rc::new(RefCell::new(CachedCloudResolver::new(
            DetectCloudOnly(shell.host.clone()),
            None,
            Clock(shell.home.clone()),
        ))));
        let lister = SharedLister(Rc::new(RefCell::new(CachedFileLister::new(
            None,
            Clock(shell.home.clone()),
            ListVisibleFiles,
        ))));

        let context_files: ContextFilesProvider = {
            let mut source = ContextFilesSource::new(cloud.clone(), None, lister.clone());
            Box::new(move |request: &ContextFilesRequest| {
                source.context_files(request).unwrap_or(ContextFiles {
                    files: Vec::new(),
                    omitted: 0,
                })
            })
        };
        let guide = Rc::new(ProjectGuide::new(ProjectGuideDeps {
            settings_path: shell.settings_path(),
            home_dir: shell.host.os_home_dir(),
            user_data: shell.at(PathName::UserData),
            default_parent_dir: {
                let shell = shell.clone();
                Box::new(move || {
                    configured_default_save_dir(
                        &Paths(shell.paths.as_ref()),
                        &mut shell.save_dir.lock().unwrap(),
                        shell.home.now_ms(),
                    )
                    .unwrap_or_default()
                })
            },
            platform: None,
            env: None,
            now: Some({
                let home = shell.home.clone();
                Box::new(move || home.now_ms())
            }),
            new_id: Some({
                let host = shell.host.clone();
                Box::new(move || {
                    base64(&host.random_bytes(16))
                        .trim_end_matches('=')
                        .replace('+', "-")
                        .replace('/', "_")
                })
            }),
            language: Some({
                let shell = shell.clone();
                Box::new(move || shell.lang().as_str().to_owned())
            }),
            context_files: Some(context_files),
            touch_write_ms: None,
            local_date: {
                let host = shell.host.clone();
                Box::new(move |at| host.local_date(at))
            },
            warn: Some({
                let host = shell.host.clone();
                Box::new(move |label: &str, detail: &str| host.warn(label, Some(detail)))
            }),
        }));

        let appended = Rc::new(RefCell::new(Vec::new()));
        let mut store = ProjectChatStore::new(
            guide.clone(),
            ChatHost {
                shell: shell.clone(),
            },
            ChatStoreOptions::default(),
        );
        store.on_appended(Box::new(Collect(appended.clone())));

        let scopes = SharedScopes(Rc::new(RefCell::new(ProjectScopes {
            host: shell.host.clone(),
            held: Vec::new(),
        })));
        let tools = ProjectFolderTools::new(ProjectToolsDeps {
            guide: Box::new(guide.clone()),
            scopes: Box::new(scopes.clone()),
            store: Box::new(StoreOfShell {
                search: shell.search.clone(),
                index: IndexOfHost(shell.files.clone()),
            }),
            resolve_cloud_only: Box::new(DetectCloudOnly(shell.host.clone())),
            list_cloud_only: Some(Box::new(cloud.clone())),
            list_files: Some(Box::new(lister.clone())),
            ask_download: {
                let shell = shell.clone();
                Box::new(move |ask: &DownloadAsk| {
                    let options = download_prompt_options(shell.lang(), &ask.file_name);
                    Ok(shell.message_box(ask.owner, &options) == 0)
                })
            },
            pages: Box::new(PagesOfHost(shell.files.clone())),
            platform: None,
        });

        let placer = Rc::new(RefCell::new(NewDocumentPlacer::new(
            NewDocumentPlacerDeps {
                guide: guide.clone(),
                window_project: Box::new(move |id| {
                    Ok(projects
                        .upgrade()
                        .and_then(|projects| projects.window_project(id)))
                }),
                document_of: {
                    let shell = shell.clone();
                    Box::new(move |id| {
                        let doc = shell.tabs()?.document_of(view_of(id)?)?;
                        editor_of(doc.kind.as_str())?;
                        doc.file_path
                    })
                },
                platform: process_platform().to_owned(),
            },
        )));
        Services {
            guide: GuideOfShell(guide),
            chats: ChatsOfShell { store, appended },
            tools: ToolsOfShell {
                tools,
                open_files: {
                    let files = shell.files.clone();
                    let mut holder = OpenFilesHolder::new();
                    holder.set_open_files_source(Some(Box::new(move || files.open_files())));
                    holder
                },
            },
            scopes,
            dialogs: DialogsOfShell(shell.clone()),
            host: HostOfShell {
                shell: shell.clone(),
                lister,
                cloud,
                placer: placer.clone(),
                tracked,
            },
            placer,
        }
    }
}
