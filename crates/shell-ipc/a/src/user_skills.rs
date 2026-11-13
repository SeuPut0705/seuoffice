//! `apps/shell/src/main/user-skills/{user-skills-ipc,template-tabs-ipc}.ts` and
//! the objects the shell entry builds them over (`createUserSkillsService`,
//! `createTemplateTabs`): the skills channels (list, read, save, import,
//! export, update, remove, the drop queue) and the template flow (open a
//! skill's template in a tab, preview a blank template, take the hand-off).
//!
//! Two ports share this file: [`UserSkillsPort`] answers the 32 invoke
//! channels of `ports::UserSkills`, [`TemplateTabsPort`] the six of
//! `ports::TemplateTabs`. Both run `main_core::shell::user_skills` (the
//! service, `UserSkillsIpc` and `TemplateTabs` with their `*_ipc` handler
//! bodies); this file is the adapter the TypeScript entry was: the Electron
//! objects as hosts, one method per `ipcMain.handle`.
//!
//! Shared state. `main-core` keeps the skills service, the previewed imports
//! and the template previews in objects that are `Send`, so the port holds them
//! in `Arc<Mutex<..>>`: a GitHub import or update check, which awaited the
//! network in TypeScript, runs on a worker and finishes on the core thread
//! without holding the lock meanwhile, and the destroyed-view listener of
//! `Views::on_destroyed` (`sender.once('destroyed')`) reaches the same state.
//! [`SkillsCore`] and [`TemplateTabsCore`] are added to what the batches
//! provide ([`shell_contract::Provided`]) for the shell code that called the
//! TypeScript module's exports: the agent window (`listSkills`,
//! `enabledForAgent`, `openTemplatePreview`) and the drop handler
//! (`userSkillsIpc.queueDropped`). The hand-off queue every editor and the
//! generate window take from is one `HandoffStore`, found (or made) in the
//! provided table by [`shared_handoff_store`].
//!
//! What the TypeScript reached that is not in `main-core` or the shared hosts
//! is a batch host here:
//!
//! - [`SkillImporter`] (`@seuoffice/ai-provider`: the import pipeline, the
//!   GitHub update check and the zip writers),
//! - [`SkillsShell`] (`builtinSkillsDirFor` over `app` and `process`),
//! - [`TemplateCopyTabs`] (the tab manager: open a template copy in a new
//!   tab, a tab's file, focus a tab, the project a copy follows).

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use jscompat::{JsObject, JsonValue, json_value_from_serde, random_uuid};
use main_core::packages::ai_provider::user_skills_import::{
    ChangedCheck, DiscardFailed, GitHubSkillUpdateCheck, InstallImportedSkillsResult,
    InstalledSkill, SkillImport, SkillImportSource, Thrown,
};
use main_core::packages::electron_utils::dialog_memory::Dialog;
use main_core::packages::electron_utils::generate_handoff::{
    HandoffSkillChip, HandoffStore, HandoffWebContents,
};
use main_core::packages::electron_utils::unsaved_files::{
    OpenFileState, OpenFilesHolder, OpenFilesSourceFailed,
};
use main_core::shell::agent::agent_skills::{ManageWindows, user_skills_manage_gate};
use main_core::shell::app_settings::{agent_skill_notice_due, mark_agent_skill_notice_seen};
use main_core::shell::atomic_write::atomic_write_file;
use main_core::shell::user_skills::template_tabs::{
    OpenedCopyTab, PREVIEW_ENDED_CHANNEL, PreviewInput, TemplateCopy, TemplateTabs as Tabs,
    TemplateTabsHost,
};
use main_core::shell::user_skills::template_tabs_ipc::{
    PreviewOriginalAnswer, handle_finish_preview, handle_focus_tab, handle_open_preview,
    handle_open_template, handle_preview_original, handle_take_handoff,
};
use main_core::shell::user_skills::user_skills_ipc::{
    DroppedSkillEntry, Run, UserSkillsIpc, UserSkillsIpcHost,
};
use main_core::shell::user_skills::user_skills_service::{
    Aborted, ApplyUpdateOptions, CheckUpdateOptions, Discard, Failure, InstallOptions, PrepareEnv,
    SkillLibrary, Svc, TemplateFile, UserSkillsHost, UserSkillsService,
};
use shell_contract::hosts::{
    ContentsHost, DialogsHost, FileDialog, FileFilter, MainWindowHost, OsShellHost,
};
use shell_contract::ipc::{CallContext, RegisterError, Responder, Sender, Target};
use shell_contract::provided::Provided;
use shell_contract::runtime::{AppPaths, PathName, Services, Views};
use shell_contract::{Batch, IpcValue, Surface, ViewId, WindowId};

use crate::port::Factory;
use crate::shell_ai_prefs::ShellUiHost;
use crate::value::{arg, from_json, to_json};

const CHANGED: &str = "skills:changed";
const DROPPED: &str = "skills:dropped";
/// `HOME_CHANNELS.openSettings`
const HOME_OPEN_SETTINGS: &str = "home:open-settings";

// ---- the hosts of this batch --------------------------------------------

/// What `@seuoffice/ai-provider` does with archives, GitHub and zip files: the
/// functions `UserSkillsServiceDeps` leaves to the library. `main-core` has no
/// port of them; the shell implements this over the library it has. Every
/// method answers what the TypeScript function named in its doc line resolves
/// with, or rejects with (`Err`). The GitHub calls (`prepare_skill_import` of
/// a GitHub source and `check_github_skill_update`) wait on the network: the
/// port runs them on a worker thread, `aborted` is `signal.aborted`.
pub trait SkillImporter: Send + Sync {
    /// `prepareSkillImport(source, env)`
    fn prepare_skill_import(
        &self,
        source: &SkillImportSource,
        env: &PrepareEnv,
        aborted: Option<Aborted<'_>>,
    ) -> Result<SkillImport, Thrown>;
    /// `installImportedSkills(imported, options)`
    fn install_imported_skills(
        &self,
        imported: &SkillImport,
        options: &InstallOptions,
        discard: Discard<'_>,
    ) -> Result<InstallImportedSkillsResult, Thrown>;
    /// `disposeSkillImport(imported)`
    fn dispose_skill_import(&self, imported: &SkillImport);
    /// `checkGitHubSkillUpdate(options)`
    fn check_github_skill_update(
        &self,
        options: &CheckUpdateOptions,
        aborted: Option<Aborted<'_>>,
    ) -> Result<GitHubSkillUpdateCheck, Thrown>;
    /// `applyGitHubSkillUpdate(check, options)`
    fn apply_github_skill_update(
        &self,
        check: &ChangedCheck,
        options: &ApplyUpdateOptions,
        discard: Discard<'_>,
    ) -> Result<InstalledSkill, Thrown>;
    /// `exportSkillZip(skillDir, outPath)`
    fn export_skill_zip(&self, skill_dir: &str, out_path: &str) -> Result<(), Thrown>;
    /// `exportSkillBundleZip(skillDirs, outPath)`
    fn export_skill_bundle_zip(&self, skill_dirs: &[String], out_path: &str) -> Result<(), Thrown>;
}

pub type SkillImporterHost = Arc<dyn SkillImporter>;

/// What the shell entry knows of the packaged app
pub trait SkillsShell: Send + Sync {
    /// `builtinSkillsDirFor({ isPackaged: app.isPackaged, resourcesPath:
    /// process.resourcesPath, appPath: app.getAppPath() })`
    fn builtin_skills_dir(&self) -> String;
}

pub type SkillsShellHost = Arc<dyn SkillsShell>;

/// The tab side of the template flow: the tab manager of the shell window (W)
/// and the shell entry's functions over it. Every method answers at once.
pub trait TemplateCopyTabs: Send + Sync {
    /// `openTemplateCopyTab(copy)` of the shell entry: a new untitled tab of
    /// the copy's editor on the copy (sheets through its backing workbook,
    /// the others `tabManager.openTemplateCopy(copy)`); `Ok(None)` when it
    /// could not. `Err` is a rejection.
    fn open_template_copy(&self, copy: &TemplateCopy) -> Result<Option<OpenedCopy>, String>;
    /// `tabManager?.describeWebContents(openerId)?.filePath ??
    /// detachedDocumentFor(openerId)?.filePath`: the file of the document the
    /// asking panel belongs to; `None` for a document never saved
    fn opener_file_path(&self, opener: ViewId) -> Option<String>;
    /// the list `setOpenFilesSource` gives `fileHasUnsavedChanges`: the open
    /// documents and whether each has unsaved changes; `Err` when the shell
    /// cannot say
    fn open_files(&self) -> Result<Vec<OpenFileState>, OpenFilesSourceFailed>;
    /// the `focusTab` dep of the shell entry: restore and focus the shell
    /// window and activate the tab; `false` when the tab is gone
    fn focus_tab(&self, tab_id: &str) -> bool;
    /// `followOpenerProject(contents, { kind: 'window', webContentsId })`: the
    /// copy's tab follows the project of the panel that asked (spec 6)
    fn follow_opener_project(&self, copy: ViewId, opener: ViewId);
}

pub type TemplateCopyTabsHost = Arc<dyn TemplateCopyTabs>;

/// `OpenedCopyTab`
#[derive(Debug, Clone, PartialEq)]
pub struct OpenedCopy {
    pub tab_id: String,
    /// the new tab's webContents
    pub view: ViewId,
    /// true when the editor removes the copy's folder itself
    pub owns_copy: bool,
}

// ---- values --------------------------------------------------------------

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn view_of(id: f64) -> ViewId {
    ViewId(id as u32)
}

fn id_of(view: ViewId) -> f64 {
    f64::from(view.0)
}

fn path_text(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

fn clock_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

/// What the probe pins so a run can be compared with the TypeScript's: the
/// ids `randomUUID()` makes are counted and `Date.now()` is fixed
#[cfg(feature = "probe")]
pub struct Pinned {
    pub now: f64,
}

/// `randomUUID()` and `Date.now()` of the module: the platform's, or pinned
struct Ids {
    pinned_now: Option<f64>,
    count: std::sync::atomic::AtomicU64,
}

impl Ids {
    fn of(services: &Services) -> Arc<Ids> {
        #[cfg(feature = "probe")]
        let pinned_now = services.hosts.get::<Pinned>().map(|pinned| pinned.now);
        #[cfg(not(feature = "probe"))]
        let pinned_now = {
            let _ = services;
            None
        };
        Arc::new(Ids {
            pinned_now,
            count: std::sync::atomic::AtomicU64::new(0),
        })
    }

    fn uuid(&self) -> String {
        match self.pinned_now {
            Some(_) => {
                let next = self.count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                format!("00000000-0000-4000-8000-{next:012}")
            }
            None => random_uuid(),
        }
    }

    fn now(&self) -> f64 {
        self.pinned_now.unwrap_or_else(clock_ms)
    }
}

/// The answer of a handler as the renderer receives it: what `main-core` built
/// from JSON, with the keys the TypeScript literals carry as `undefined` put back
fn answer(reply: Responder, value: JsonValue) {
    let mut answer = from_json(&value);
    with_unset_keys(&mut answer);
    reply.reply(Ok(answer))
}

/// Puts `key: undefined` into `entries` after the key `after` (at the end when `None`),
/// unless the key is there. JSON has no `undefined`, so `main-core` leaves such
/// keys out; the TypeScript literals that build the objects always have them.
fn unset_key(entries: &mut Vec<(String, IpcValue)>, key: &str, after: Option<&str>) {
    if entries.iter().any(|(name, _)| name == key) {
        return;
    }
    let at = after
        .and_then(|after| entries.iter().position(|(name, _)| name == after))
        .map_or(entries.len(), |anchor| anchor + 1);
    entries.insert(at, (key.to_owned(), IpcValue::Undefined));
}

/// The objects of `user-skills-service.ts` whose literals hold an optional key
/// as `key: value` rather than as a spread, found by their keys, nested ones first:
///
/// - `viewOf`: `plugin` after `source`, `template` after `mcpServers`, `unreadable`
///   before `files` (after `editors` when there), `github` before `owned`, `shadowedBy` last
/// - `read`'s content: `template` after `body`
/// - `aiRead`'s skill: `template` after `files`
/// - `candidateView`: `license` after `urlCount`, `problem` last
/// - `importPreviewOf`: `rootLicense` last
fn with_unset_keys(value: &mut IpcValue) {
    match value {
        IpcValue::Array(items) => items.iter_mut().for_each(with_unset_keys),
        IpcValue::Object(entries) => {
            entries
                .iter_mut()
                .for_each(|(_, member)| with_unset_keys(member));
            let has = |entries: &[(String, IpcValue)], keys: &[&str]| {
                keys.iter()
                    .all(|key| entries.iter().any(|(name, _)| name == key))
            };
            if has(entries, &["id", "source", "templateExists", "owned", "can"]) {
                unset_key(entries, "plugin", Some("source"));
                unset_key(entries, "template", Some("mcpServers"));
                let before_files = if entries.iter().any(|(name, _)| name == "editors") {
                    "editors"
                } else {
                    "agentOnly"
                };
                unset_key(entries, "unreadable", Some(before_files));
                unset_key(entries, "github", Some("bytes"));
                unset_key(entries, "shadowedBy", None);
            } else if has(
                entries,
                &["key", "rel", "urlCount", "emptyBody", "warnings"],
            ) {
                unset_key(entries, "license", Some("urlCount"));
                unset_key(entries, "problem", None);
            } else if has(entries, &["token", "origin", "candidates"]) {
                unset_key(entries, "rootLicense", None);
            } else if has(
                entries,
                &["id", "name", "title", "description", "body", "files"],
            ) {
                unset_key(entries, "template", Some("body"));
            } else if has(
                entries,
                &[
                    "id",
                    "name",
                    "title",
                    "body",
                    "files",
                    "hasScripts",
                    "mcpServers",
                ],
            ) {
                unset_key(entries, "template", Some("files"));
            }
        }
        _ => {}
    }
}

fn undefined(reply: Responder) {
    reply.reply(Ok(IpcValue::Undefined))
}

/// `args[0]` with the bytes at `path` replaced by the `{"$bytes": n}` marker
/// `main-core` reads (JSON cannot hold bytes), and those bytes. `None` when
/// the argument is `undefined`.
fn marked_arg(args: Vec<IpcValue>, path: &[&str]) -> (Option<JsonValue>, Option<Vec<u8>>) {
    let Some(first) = args.into_iter().next() else {
        return (None, None);
    };
    let mut taken = None;
    let marked = mark_bytes(first, path, &mut taken);
    (to_json(&marked), taken)
}

fn mark_bytes(value: IpcValue, path: &[&str], taken: &mut Option<Vec<u8>>) -> IpcValue {
    match (value, path) {
        (IpcValue::Bytes(_, bytes), []) => {
            let marker = IpcValue::Number(bytes.len() as f64);
            *taken = Some(bytes);
            IpcValue::Object(vec![("$bytes".to_owned(), marker)])
        }
        (IpcValue::Object(entries), [head, rest @ ..]) => IpcValue::Object(
            entries
                .into_iter()
                .map(|(key, value)| {
                    if key == *head {
                        (key, mark_bytes(value, rest, taken))
                    } else {
                        (key, value)
                    }
                })
                .collect(),
        ),
        (other, _) => other,
    }
}

// ---- the Electron objects of the IPC module -------------------------------

/// What both ports and their listeners hold: the shell's services and the
/// shared hosts they call. Cheap to clone and `Send`: a worker's job builds
/// its host from it.
#[derive(Clone)]
struct Env {
    services: Services,
    dialogs: DialogsHost,
    os_shell: OsShellHost,
    contents: ContentsHost,
    main_window: MainWindowHost,
    ui: ShellUiHost,
    ids: Arc<Ids>,
}

impl Env {
    fn from_services(services: &Services) -> Result<Env, RegisterError> {
        let hosts = &services.hosts;
        Ok(Env {
            services: services.clone(),
            dialogs: hosts.need::<DialogsHost>(Batch::A)?,
            os_shell: hosts.need::<OsShellHost>(Batch::A)?,
            contents: hosts.need::<ContentsHost>(Batch::A)?,
            main_window: hosts.need::<MainWindowHost>(Batch::A)?,
            ui: hosts.need::<ShellUiHost>(Batch::A)?,
            ids: Ids::of(services),
        })
    }

    fn host(&self, sender: Option<Sender>) -> IpcHost {
        IpcHost {
            dialog: DialogAdapter {
                dialogs: self.dialogs.clone(),
            },
            env: self.clone(),
            sender,
        }
    }

    fn is_destroyed(&self, view: ViewId) -> bool {
        self.services.views.sender_of(view).is_none()
    }

    fn settings_path(&self) -> String {
        path_text(
            self.services
                .paths
                .path(PathName::UserData)
                .join("app-settings.json"),
        )
    }
}

/// `dialog.showOpenDialog` and `showSaveDialog` over the shared dialogs host:
/// Electron's options in, Electron's `{ canceled, filePaths | filePath }` out
struct DialogAdapter {
    dialogs: DialogsHost,
}

fn strings_of(value: Option<&JsonValue>) -> Vec<String> {
    match value {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsonValue::String(text) => Some(text.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn file_dialog(options: &JsObject<JsonValue>) -> FileDialog {
    let filters = match options.get("filters") {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|item| {
                let JsonValue::Object(filter) = item else {
                    return None;
                };
                let name = match filter.get("name") {
                    Some(JsonValue::String(name)) => name.clone(),
                    _ => String::new(),
                };
                Some(FileFilter {
                    name,
                    extensions: strings_of(filter.get("extensions")),
                })
            })
            .collect(),
        _ => Vec::new(),
    };
    FileDialog {
        default_path: match options.get("defaultPath") {
            Some(JsonValue::String(path)) => Some(PathBuf::from(path)),
            _ => None,
        },
        properties: strings_of(options.get("properties")),
        filters,
        ..FileDialog::default()
    }
}

impl Dialog for DialogAdapter {
    type Window = WindowId;

    fn show_open_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let picked = self.dialogs.open(parent.copied(), &file_dialog(options));
        let mut result = JsObject::new();
        result.set("canceled", JsonValue::Bool(picked.is_none()));
        let paths = picked
            .unwrap_or_default()
            .into_iter()
            .map(|path| JsonValue::String(path_text(path)))
            .collect();
        result.set("filePaths", JsonValue::Array(paths));
        JsonValue::Object(result)
    }

    fn show_save_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let picked = self.dialogs.save(parent.copied(), &file_dialog(options));
        let mut result = JsObject::new();
        result.set("canceled", JsonValue::Bool(picked.is_none()));
        result.set(
            "filePath",
            JsonValue::String(picked.map(path_text).unwrap_or_default()),
        );
        JsonValue::Object(result)
    }
}

/// which senders are which window, for `userSkillsManageGate`
struct Windows {
    main: Option<ViewId>,
}

impl ManageWindows<Sender> for Windows {
    fn is_main_window(&self, sender: &Sender) -> bool {
        self.main == Some(sender.view)
    }

    /// `isAgentWindowContents`: the agent window loads the agent preload
    fn is_agent_window(&self, sender: &Sender) -> bool {
        sender.surface == Surface::ShellAgent
    }
}

/// `UserSkillsIpcDeps` and the Electron objects `registerUserSkillsIpc` uses,
/// for one call of one sender (`None` for what the shell does on its own: a drop)
struct IpcHost {
    dialog: DialogAdapter,
    env: Env,
    sender: Option<Sender>,
}

impl UserSkillsIpcHost for IpcHost {
    type Dialog = DialogAdapter;

    fn dialog(&mut self) -> &mut DialogAdapter {
        &mut self.dialog
    }

    /// `BrowserWindow.fromWebContents(event.sender)`
    fn parent_of(&mut self, sender_id: f64) -> Option<WindowId> {
        self.env.contents.window_of(view_of(sender_id))
    }

    /// `userSkillsManageGate`: the settings screen (the shell window) any of
    /// them, the agent window only its install preview
    fn can_manage(&mut self, _sender_id: f64, channel: &str) -> bool {
        let Some(sender) = self.sender else {
            return false;
        };
        let windows = Windows {
            main: self.env.main_window.view(),
        };
        user_skills_manage_gate(&windows)(&sender, channel)
    }

    /// `openSkillsSettings()`: the main window forward on its home tab, the
    /// settings open on the skills page
    fn open_settings(&mut self) {
        let Some(view) = self.env.main_window.view() else {
            return;
        };
        self.env.ui.show_home_tab();
        let mut section = JsObject::new();
        section.set("section", JsonValue::String("skills".into()));
        self.env.services.events.emit(
            Target::View(view),
            HOME_OPEN_SETTINGS,
            vec![from_json(&JsonValue::Object(section))],
        );
    }

    fn agent_notice_due(&mut self) -> Result<bool, String> {
        Ok(agent_skill_notice_due(&self.env.settings_path()))
    }

    fn mark_agent_notice_seen(&mut self) -> Result<(), String> {
        mark_agent_skill_notice_seen(&self.env.settings_path()).map_err(|error| error.message)
    }

    fn broadcast_changed(&mut self) {
        self.env
            .services
            .events
            .emit(Target::All, CHANGED, Vec::new());
    }

    fn broadcast_dropped(&mut self) {
        self.env
            .services
            .events
            .emit(Target::All, DROPPED, Vec::new());
    }

    fn random_uuid(&mut self) -> String {
        self.env.ids.uuid()
    }

    fn is_destroyed(&mut self, sender_id: f64) -> bool {
        self.env.is_destroyed(view_of(sender_id))
    }

    /// `sender.once('destroyed')`: the one listener [`SkillsCore::new`] gave
    /// `Views::on_destroyed` hears every view, so there is nothing to ask for
    fn watch_destroyed(&mut self, _sender_id: f64) {}

    /// `shell.openPath(path)`
    fn open_path(&mut self, path: &str) -> String {
        self.env.os_shell.open_path(Path::new(path))
    }
}

// ---- the skills service ---------------------------------------------------

/// `UserSkillsServiceDeps`: where the person's home, settings and temporary
/// folders are, the OS trash and the clock
struct SkillsHost {
    paths: Arc<dyn AppPaths>,
    os_shell: OsShellHost,
    shell: SkillsShellHost,
    ids: Arc<Ids>,
}

impl UserSkillsHost for SkillsHost {
    fn home_dir(&self) -> String {
        path_text(self.paths.path(PathName::Home))
    }

    fn builtin_dir(&self) -> Option<String> {
        Some(self.shell.builtin_skills_dir())
    }

    fn settings_path(&self) -> String {
        path_text(
            self.paths
                .path(PathName::UserData)
                .join("app-settings.json"),
        )
    }

    /// `join(tmpdir(), 'seuoffice-skills')`
    fn temp_dir(&self) -> String {
        path_text(self.paths.path(PathName::Temp).join("seuoffice-skills"))
    }

    /// `shell.trashItem(path)`
    fn trash(&mut self, path: &str) -> Result<(), DiscardFailed> {
        self.os_shell
            .trash_item(Path::new(path))
            .map_err(|_| DiscardFailed)
    }

    fn now_ms(&self) -> f64 {
        self.ids.now()
    }
}

/// A call the service made that waits on the network: it was not run, the
/// port runs it on a worker
enum Deferred {
    Prepare {
        source: SkillImportSource,
        env: PrepareEnv,
    },
    Check {
        options: CheckUpdateOptions,
    },
}

/// The [`SkillLibrary`] of the service over the shell's [`SkillImporter`].
/// The two GitHub calls are never run by the service itself: it records what
/// they were asked and answers a placeholder rejection, and the port runs the
/// recorded call off the core thread (`service.prepare` and
/// `service.check_update` keep their checks and the options they build).
struct Library {
    importer: SkillImporterHost,
    deferred: Option<Deferred>,
}

fn deferred_failure() -> Thrown {
    Thrown::Plain("deferred to a worker".to_owned())
}

impl SkillLibrary for Library {
    fn prepare_skill_import(
        &mut self,
        source: &SkillImportSource,
        env: &PrepareEnv,
        aborted: Option<Aborted<'_>>,
    ) -> Result<SkillImport, Thrown> {
        if matches!(source, SkillImportSource::Github { .. }) {
            self.deferred = Some(Deferred::Prepare {
                source: source.clone(),
                env: env.clone(),
            });
            return Err(deferred_failure());
        }
        self.importer.prepare_skill_import(source, env, aborted)
    }

    fn install_imported_skills(
        &mut self,
        imported: &SkillImport,
        options: &InstallOptions,
        discard: Discard<'_>,
    ) -> Result<InstallImportedSkillsResult, Thrown> {
        self.importer
            .install_imported_skills(imported, options, discard)
    }

    fn dispose_skill_import(&mut self, imported: &SkillImport) {
        self.importer.dispose_skill_import(imported)
    }

    fn check_github_skill_update(
        &mut self,
        options: &CheckUpdateOptions,
        _aborted: Option<Aborted<'_>>,
    ) -> Result<GitHubSkillUpdateCheck, Thrown> {
        self.deferred = Some(Deferred::Check {
            options: options.clone(),
        });
        Err(deferred_failure())
    }

    fn apply_github_skill_update(
        &mut self,
        check: &ChangedCheck,
        options: &ApplyUpdateOptions,
        discard: Discard<'_>,
    ) -> Result<InstalledSkill, Thrown> {
        self.importer
            .apply_github_skill_update(check, options, discard)
    }

    fn export_skill_zip(&mut self, skill_dir: &str, out_path: &str) -> Result<(), Thrown> {
        self.importer.export_skill_zip(skill_dir, out_path)
    }

    fn export_skill_bundle_zip(
        &mut self,
        skill_dirs: &[String],
        out_path: &str,
    ) -> Result<(), Thrown> {
        self.importer.export_skill_bundle_zip(skill_dirs, out_path)
    }
}

type SkillsIpc = UserSkillsIpc<SkillsHost, Library>;

/// The skills service and its IPC state: `userSkills` and `userSkillsIpc` of
/// the shell entry. Provided to the other ports ([`shell_contract::Provided`]).
pub struct SkillsCore {
    ipc: Arc<Mutex<SkillsIpc>>,
    importer: SkillImporterHost,
    env: Env,
}

impl SkillsCore {
    fn new(env: Env, importer: SkillImporterHost, shell: SkillsShellHost) -> SkillsCore {
        let host = SkillsHost {
            paths: env.services.paths.clone(),
            os_shell: env.os_shell.clone(),
            shell,
            ids: env.ids.clone(),
        };
        let library = Library {
            importer: importer.clone(),
            deferred: None,
        };
        let ipc = Arc::new(Mutex::new(UserSkillsIpc::new(UserSkillsService::new(
            host, library, None,
        ))));
        // `sender.once('destroyed')` of every window that left something waiting
        let listener = ipc.clone();
        env.services.views.on_destroyed(Box::new(move |view| {
            lock(&listener).sender_destroyed(id_of(view));
        }));
        SkillsCore { ipc, importer, env }
    }

    fn ipc(&self) -> MutexGuard<'_, SkillsIpc> {
        lock(&self.ipc)
    }

    /// `userSkills.list()`
    pub fn list(&self) -> Svc<Vec<JsonValue>> {
        self.ipc().service.list()
    }

    /// `userSkills.enabledForAgent(projectRoot)`
    pub fn enabled_for_agent(
        &self,
        project_root: Option<&str>,
    ) -> Svc<Vec<main_core::shell::user_skills::user_skills_service::AgentEnabledSkill>> {
        self.ipc().service.enabled_for_agent(project_root)
    }

    /// `userSkills.templateFile(id)`
    pub fn template_file(&self, id: &str) -> Svc<TemplateFile> {
        self.ipc().service.template_file(id)
    }

    /// `userSkillsIpc.broadcastChanged()`
    pub fn broadcast_changed(&self) {
        let mut host = self.env.host(None);
        self.ipc().broadcast_changed(&mut host);
    }

    /// `userSkillsIpc.queueDropped(entry)`: what a drop left for the settings
    /// screen; the caller opens the settings on the skills page
    pub fn queue_dropped(&self, entry: DroppedSkillEntry) {
        let mut host = self.env.host(None);
        self.ipc().queue_dropped(&mut host, entry);
    }

    /// the GitHub import's network call on a worker, then its finish on the
    /// core thread, which answers `reply`
    fn import_in_background(
        &self,
        sender: Sender,
        run: Run,
        source: SkillImportSource,
        env: PrepareEnv,
        reply: Responder,
    ) {
        let importer = self.importer.clone();
        let ipc = self.ipc.clone();
        let shared = self.env.clone();
        let core = self.env.services.core.clone();
        self.env.services.workers.spawn(Box::new(move || {
            let aborted = || run.aborted();
            let prepared = importer
                .prepare_skill_import(&source, &env, Some(&aborted))
                .map_err(Failure::Thrown);
            core.post(Box::new(move || {
                let mut host = shared.host(Some(sender));
                let done = lock(&ipc).import_github_finish(&mut host, &run, prepared);
                answer(reply, done);
            }));
        }));
    }

    /// the update check's network call on a worker, then its finish on the core thread
    fn check_in_background(
        &self,
        sender: Sender,
        run: Run,
        skill_id: String,
        options: CheckUpdateOptions,
        reply: Responder,
    ) {
        let importer = self.importer.clone();
        let ipc = self.ipc.clone();
        let shared = self.env.clone();
        let core = self.env.services.core.clone();
        self.env.services.workers.spawn(Box::new(move || {
            let aborted = || run.aborted();
            let checked = importer
                .check_github_skill_update(&options, Some(&aborted))
                .map_err(Failure::Thrown);
            core.post(Box::new(move || {
                let mut host = shared.host(Some(sender));
                let done = lock(&ipc).check_update_finish(&mut host, &run, &skill_id, checked);
                answer(reply, done);
            }));
        }));
    }
}

/// The skills core of this shell: the one already provided, or built now
fn skills_core(
    services: &Services,
    provided: &Rc<Provided>,
) -> Result<Rc<SkillsCore>, RegisterError> {
    if let Some(core) = provided.all::<SkillsCore>().into_iter().next() {
        return Ok(core);
    }
    let hosts = &services.hosts;
    let core = Rc::new(SkillsCore::new(
        Env::from_services(services)?,
        hosts.need::<SkillImporterHost>(Batch::A)?,
        hosts.need::<SkillsShellHost>(Batch::A)?,
    ));
    provided.add::<SkillsCore>(core.clone());
    Ok(core)
}

// ---- the skills channels ---------------------------------------------------

/// The handlers of `registerUserSkillsIpc`
pub struct UserSkillsPort {
    core: Rc<SkillsCore>,
}

impl UserSkillsPort {
    /// one handler body: the sender's host, the IPC state locked, the sender's id
    fn run<R>(
        &self,
        cx: &CallContext,
        body: impl FnOnce(&mut SkillsIpc, &mut IpcHost, f64) -> R,
    ) -> R {
        let mut host = self.core.env.host(Some(cx.sender));
        let mut ipc = self.core.ipc();
        body(&mut ipc, &mut host, id_of(cx.sender.view))
    }

    /// The network call the service recorded in `import_github` or
    /// `check_update` instead of running it; `None` when the service refused
    /// first (not found, not owned, not GitHub) and its answer stands
    fn deferred(&self) -> Option<Deferred> {
        self.core.ipc().service.library.deferred.take()
    }
}

impl crate::ports::UserSkills for UserSkillsPort {
    fn skills_agent_notice(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let due = self.run(cx, |ipc, host, _| ipc.agent_notice(host));
        answer(reply, JsonValue::Bool(due))
    }

    fn skills_agent_notice_seen(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        self.run(cx, |ipc, host, _| ipc.agent_notice_seen(host));
        undefined(reply)
    }

    fn skills_ai_read(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let id = arg(&args, 0);
        answer(reply, self.core.ipc().ai_read(id.as_ref()))
    }

    fn skills_ai_read_file(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let (id, rel) = (arg(&args, 0), arg(&args, 1));
        answer(
            reply,
            self.core.ipc().ai_read_file(id.as_ref(), rel.as_ref()),
        )
    }

    fn skills_apply_update(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let token = arg(&args, 0);
        let done = self.run(cx, |ipc, host, sender| {
            ipc.apply_update(host, sender, token.as_ref())
        });
        answer(reply, done)
    }

    fn skills_cancel_import(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let token = arg(&args, 0);
        let done = self.run(cx, |ipc, host, sender| {
            ipc.cancel_import(host, sender, token.as_ref())
        });
        answer(reply, done)
    }

    fn skills_cancel_update(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let token = arg(&args, 0);
        let done = self.run(cx, |ipc, host, sender| {
            ipc.cancel_update(host, sender, token.as_ref())
        });
        answer(reply, done)
    }

    fn skills_check_name(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let (name, for_id) = (arg(&args, 0), arg(&args, 1));
        answer(
            reply,
            self.core.ipc().check_name(name.as_ref(), for_id.as_ref()),
        )
    }

    fn skills_check_update(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let id = arg(&args, 0);
        let begun = self.run(cx, |ipc, host, sender| {
            ipc.check_update_begin(host, sender, id.as_ref())
        });
        let (run, skill_id) = match begun {
            Ok(begun) => begun,
            Err(refused) => return answer(reply, refused),
        };
        let checked = self
            .core
            .ipc()
            .service
            .check_update(&skill_id, Some(&|| run.aborted()));
        match self.deferred() {
            Some(Deferred::Check { options }) => self
                .core
                .check_in_background(cx.sender, run, skill_id, options, reply),
            // the service refused (not found, not owned, not GitHub) before it called out
            _ => {
                let done = self.run(cx, |ipc, host, _| {
                    ipc.check_update_finish(host, &run, &skill_id, checked)
                });
                answer(reply, done)
            }
        }
    }

    fn skills_copy_to_mine(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let (id, overwrite) = (arg(&args, 0), arg(&args, 1));
        let done = self.run(cx, |ipc, host, sender| {
            ipc.copy_to_mine(host, sender, id.as_ref(), overwrite.as_ref())
        });
        answer(reply, done)
    }

    fn skills_export_bundle(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let (ids, suggested) = (arg(&args, 0), arg(&args, 1));
        let done = self.run(cx, |ipc, host, sender| {
            ipc.export_bundle(host, sender, ids.as_ref(), suggested.as_ref())
        });
        answer(reply, done)
    }

    fn skills_export_info(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let id = arg(&args, 0);
        let done = self.run(cx, |ipc, host, sender| {
            ipc.export_info(host, sender, id.as_ref())
        });
        answer(reply, done)
    }

    fn skills_export_zip(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let id = arg(&args, 0);
        let done = self.run(cx, |ipc, host, sender| {
            ipc.export_zip(host, sender, id.as_ref())
        });
        answer(reply, done)
    }

    fn skills_hide_builtin(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let id = arg(&args, 0);
        let done = self.run(cx, |ipc, host, sender| {
            ipc.hide_builtin(host, sender, id.as_ref())
        });
        answer(reply, done)
    }

    fn skills_import_folder(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let done = self.run(cx, |ipc, host, sender| ipc.import_folder(host, sender));
        answer(reply, done)
    }

    fn skills_import_github(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let address = arg(&args, 0);
        let begun = self.run(cx, |ipc, host, sender| {
            ipc.import_github_begin(host, sender, address.as_ref())
        });
        let (run, source) = match begun {
            Ok(begun) => begun,
            Err(refused) => return answer(reply, refused),
        };
        let prepared = self
            .core
            .ipc()
            .service
            .prepare(&source, Some(&|| run.aborted()));
        match self.deferred() {
            Some(Deferred::Prepare { source, env }) => self
                .core
                .import_in_background(cx.sender, run, source, env, reply),
            _ => {
                let done = self.run(cx, |ipc, host, _| {
                    ipc.import_github_finish(host, &run, prepared)
                });
                answer(reply, done)
            }
        }
    }

    fn skills_import_text(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let raw = arg(&args, 0);
        let done = self.run(cx, |ipc, host, sender| {
            ipc.import_text(host, sender, raw.as_ref())
        });
        answer(reply, done)
    }

    fn skills_import_zip(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let done = self.run(cx, |ipc, host, sender| ipc.import_zip(host, sender));
        answer(reply, done)
    }

    fn skills_install(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let raw = arg(&args, 0);
        let done = self.run(cx, |ipc, host, sender| {
            ipc.install(host, sender, raw.as_ref())
        });
        answer(reply, done)
    }

    fn skills_list(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        answer(reply, self.core.ipc().list())
    }

    fn skills_open_folder(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let id = arg(&args, 0);
        let done = self.run(cx, |ipc, host, sender| {
            ipc.open_folder(host, sender, id.as_ref())
        });
        answer(reply, done)
    }

    fn skills_open_settings(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        self.run(cx, |ipc, host, _| ipc.open_settings(host));
        undefined(reply)
    }

    fn skills_read(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let id = arg(&args, 0);
        answer(reply, self.core.ipc().read(id.as_ref()))
    }

    fn skills_read_import(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let (token, key) = (arg(&args, 0), arg(&args, 1));
        let done = self.run(cx, |ipc, host, sender| {
            ipc.read_import(host, sender, token.as_ref(), key.as_ref())
        });
        answer(reply, done)
    }

    fn skills_read_import_file(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let (token, key, rel) = (arg(&args, 0), arg(&args, 1), arg(&args, 2));
        let done = self.run(cx, |ipc, host, sender| {
            ipc.read_import_file(host, sender, token.as_ref(), key.as_ref(), rel.as_ref())
        });
        answer(reply, done)
    }

    fn skills_remove(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let id = arg(&args, 0);
        let done = self.run(cx, |ipc, host, sender| {
            ipc.remove(host, sender, id.as_ref())
        });
        answer(reply, done)
    }

    fn skills_save(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let raw = arg(&args, 0);
        let done = self.run(cx, |ipc, host, sender| ipc.save(host, sender, raw.as_ref()));
        answer(reply, done)
    }

    fn skills_save_from_card(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let (raw, bytes) = marked_arg(args, &["template", "bytes"]);
        let done = self.run(cx, |ipc, host, _| {
            ipc.save_from_card(host, raw.as_ref(), bytes)
        });
        answer(reply, done)
    }

    fn skills_set_state(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let (id, patch) = (arg(&args, 0), arg(&args, 1));
        let done = self.run(cx, |ipc, host, sender| {
            ipc.set_state(host, sender, id.as_ref(), patch.as_ref())
        });
        answer(reply, done)
    }

    fn skills_suggest_name(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let title = arg(&args, 0);
        answer(reply, self.core.ipc().suggest_name(title.as_ref()))
    }

    fn skills_take_dropped(&self, cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let done = self.run(cx, |ipc, host, sender| ipc.take_dropped(host, sender));
        answer(reply, done)
    }

    fn skills_unhide_builtins(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let names = arg(&args, 0);
        let done = self.run(cx, |ipc, host, sender| {
            ipc.unhide_builtins(host, sender, names.as_ref())
        });
        answer(reply, done)
    }
}

/// The host the shell inserts for the skills channels. Building it adds the
/// [`SkillsCore`] to what the batches provide.
pub fn factory() -> Factory<dyn crate::ports::UserSkills> {
    Factory::new(|services, provided| {
        let port: Rc<dyn crate::ports::UserSkills> = Rc::new(UserSkillsPort {
            core: skills_core(services, provided)?,
        });
        Ok(port)
    })
}

// ---- the template tabs ------------------------------------------------------

/// The hand-off queue the editors, the generate window and the skills
/// channels share (`generate-handoff.ts` keeps it in module state): the one in
/// the provided table, or a new one added to it. Every port that queues or
/// takes hand-offs must get its store here.
pub fn shared_handoff_store(provided: &Provided) -> Rc<RefCell<HandoffStore>> {
    if let Some(store) = provided.all::<RefCell<HandoffStore>>().into_iter().next() {
        return store;
    }
    let store = Rc::new(RefCell::new(HandoffStore::new(cfg!(windows))));
    provided.add::<RefCell<HandoffStore>>(store.clone());
    store
}

/// What `createTemplateTabs(deps)` is given, for one call
struct TabsHost {
    env: Env,
    tabs: TemplateCopyTabsHost,
    skills: Arc<Mutex<SkillsIpc>>,
}

fn io_message(error: std::io::Error) -> String {
    error.to_string()
}

/// the webContents of a copy tab, as the hand-off queue needs it
struct CopyContents {
    id: f64,
    views: Arc<dyn Views>,
}

impl HandoffWebContents for CopyContents {
    fn id(&self) -> f64 {
        self.id
    }

    fn is_destroyed(&self) -> bool {
        self.views.sender_of(view_of(self.id)).is_none()
    }

    /// `contents.once('destroyed', ...)`: [`TemplateTabsCore`] hears every
    /// destroyed view and drops its queued hand-off then
    fn once_destroyed(&mut self) {}
}

impl TemplateTabsHost for TabsHost {
    /// `join(app.getPath('temp'), 'seuoffice-template-copies', randomUUID())`, made
    fn make_copy_dir(&mut self) -> Result<String, String> {
        let dir = path_text(
            self.env
                .services
                .paths
                .path(PathName::Temp)
                .join("seuoffice-template-copies")
                .join(self.env.ids.uuid()),
        );
        std::fs::create_dir_all(&dir).map_err(io_message)?;
        Ok(dir)
    }

    /// `atomicWriteFile(path, bytes)`
    fn write_file(&mut self, path: &str, bytes: &[u8]) -> Result<(), String> {
        atomic_write_file(path, bytes).map_err(|error| error.message)
    }

    fn read_file(&mut self, path: &str) -> Result<Vec<u8>, String> {
        std::fs::read(path).map_err(io_message)
    }

    /// `rmSync(dir, { recursive: true, force: true })`
    fn remove_dir(&mut self, path: &str) -> Result<(), String> {
        match std::fs::remove_dir_all(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(io_message(error)),
            _ => Ok(()),
        }
    }

    /// `userSkills.templateFile(id)`
    fn template_file_of(&mut self, skill_id: &str) -> Svc<TemplateFile> {
        lock(&self.skills).service.template_file(skill_id)
    }

    fn open_copy(&mut self, copy: &TemplateCopy) -> Result<Option<OpenedCopyTab>, String> {
        Ok(self
            .tabs
            .open_template_copy(copy)?
            .map(|opened| OpenedCopyTab {
                tab_id: opened.tab_id,
                contents: Box::new(CopyContents {
                    id: id_of(opened.view),
                    views: self.env.services.views.clone(),
                }),
                owns_copy: opened.owns_copy,
            }))
    }

    fn opener_file_path(&mut self, opener_id: f64) -> Option<String> {
        self.tabs.opener_file_path(view_of(opener_id))
    }

    fn focus_tab(&mut self, tab_id: &str) -> bool {
        self.tabs.focus_tab(tab_id)
    }

    fn copy_opened_for(&mut self, contents_id: f64, opener_id: f64) {
        self.tabs
            .follow_opener_project(view_of(contents_id), view_of(opener_id))
    }

    fn new_id(&mut self) -> String {
        self.env.ids.uuid()
    }

    fn now(&mut self) -> f64 {
        self.env.ids.now()
    }

    fn owner_is_destroyed(&mut self, owner_id: f64) -> bool {
        self.env.is_destroyed(view_of(owner_id))
    }

    /// `owner.send(channel, payload)`: only the preview's end is ever sent
    fn owner_send(&mut self, owner_id: f64, channel: &str, payload: &JsonValue) {
        debug_assert_eq!(channel, PREVIEW_ENDED_CHANNEL);
        self.env.services.events.emit(
            Target::View(view_of(owner_id)),
            "skills:preview-ended",
            vec![from_json(payload)],
        );
    }
}

/// The template previews and the hand-off queue: `templateTabs` of the shell
/// entry. Provided to the other ports (the agent window opens previews and copies).
pub struct TemplateTabsCore {
    tabs: Arc<Mutex<Tabs>>,
    store: Rc<RefCell<HandoffStore>>,
    /// views destroyed since a handler last ran: their queued hand-offs go
    gone: Arc<Mutex<Vec<f64>>>,
    env: Env,
    copies: TemplateCopyTabsHost,
    skills: Arc<Mutex<SkillsIpc>>,
}

impl TemplateTabsCore {
    fn new(
        env: Env,
        copies: TemplateCopyTabsHost,
        skills: &SkillsCore,
        store: Rc<RefCell<HandoffStore>>,
    ) -> TemplateTabsCore {
        let core = TemplateTabsCore {
            tabs: Arc::new(Mutex::new(Tabs::new())),
            store,
            gone: Arc::new(Mutex::new(Vec::new())),
            env,
            copies,
            skills: skills.ipc.clone(),
        };
        // the `contents.once('destroyed', ...)` listeners of copy and preview tabs
        let tabs = core.tabs.clone();
        let gone = core.gone.clone();
        let (env, copies, skills) = (core.env.clone(), core.copies.clone(), core.skills.clone());
        core.env.services.views.on_destroyed(Box::new(move |view| {
            let mut host = TabsHost {
                env: env.clone(),
                tabs: copies.clone(),
                skills: skills.clone(),
            };
            lock(&tabs).contents_destroyed(&mut host, id_of(view));
            lock(&gone).push(id_of(view));
        }));
        core
    }

    fn host(&self) -> TabsHost {
        TabsHost {
            env: self.env.clone(),
            tabs: self.copies.clone(),
            skills: self.skills.clone(),
        }
    }

    /// drop the hand-offs of the views destroyed meanwhile
    fn forget_gone(&self) {
        let gone = std::mem::take(&mut *lock(&self.gone));
        if gone.is_empty() {
            return;
        }
        let mut store = self.store.borrow_mut();
        for id in gone {
            store.drop_generate_handoff(id);
        }
    }

    /// `fileHasUnsavedChanges` reads the open documents through this
    fn open_files(&self) -> OpenFilesHolder {
        let copies = self.copies.clone();
        let mut holder = OpenFilesHolder::new();
        holder.set_open_files_source(Some(Box::new(move || copies.open_files())));
        holder
    }

    /// `templateTabs.openPreview(owner, input)`: spec 5.6 "make a blank
    /// template". Returns `(tabId, previewId)`.
    pub fn open_preview(&self, owner: ViewId, input: &PreviewInput) -> Svc<(String, String)> {
        self.forget_gone();
        let mut host = self.host();
        lock(&self.tabs).open_preview(&mut host, &mut self.store.borrow_mut(), id_of(owner), input)
    }

    /// `templateTabs.openCopy(input)`: any document's byte copy as a new
    /// untitled tab, with a request handed to its AI panel. Returns the tab id.
    pub fn open_copy(
        &self,
        bytes: &[u8],
        file_name: &str,
        title: &str,
        request: &str,
        chips: &[HandoffSkillChip],
    ) -> Svc<String> {
        self.forget_gone();
        let mut host = self.host();
        lock(&self.tabs).open_copy(
            &mut host,
            &mut self.store.borrow_mut(),
            bytes,
            file_name,
            title,
            request,
            chips,
        )
    }
}

/// The template tabs core of this shell: the one already provided, or built now
fn template_tabs_core(
    services: &Services,
    provided: &Rc<Provided>,
) -> Result<Rc<TemplateTabsCore>, RegisterError> {
    if let Some(core) = provided.all::<TemplateTabsCore>().into_iter().next() {
        return Ok(core);
    }
    let skills = skills_core(services, provided)?;
    let core = Rc::new(TemplateTabsCore::new(
        skills.env.clone(),
        services.hosts.need::<TemplateCopyTabsHost>(Batch::A)?,
        &skills,
        shared_handoff_store(provided),
    ));
    provided.add::<TemplateTabsCore>(core.clone());
    Ok(core)
}

/// The handlers of `registerTemplateTabsIpc`
pub struct TemplateTabsPort {
    core: Rc<TemplateTabsCore>,
}

impl crate::ports::TemplateTabs for TemplateTabsPort {
    fn skills_finish_preview(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let raw = arg(&args, 0);
        self.core.forget_gone();
        let mut host = self.core.host();
        let done = handle_finish_preview(
            &mut lock(&self.core.tabs),
            &mut host,
            raw.as_ref(),
            id_of(cx.sender.view),
        );
        answer(reply, done)
    }

    fn skills_focus_tab(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let tab_id = arg(&args, 0);
        let mut host = self.core.host();
        let done = handle_focus_tab(&mut lock(&self.core.tabs), &mut host, tab_id.as_ref());
        answer(reply, done)
    }

    fn skills_open_preview(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let (raw, bytes) = marked_arg(args, &["bytes"]);
        self.core.forget_gone();
        let mut host = self.core.host();
        let done = handle_open_preview(
            &mut lock(&self.core.tabs),
            &mut host,
            &mut self.core.store.borrow_mut(),
            raw.as_ref(),
            bytes.unwrap_or_default(),
            id_of(cx.sender.view),
        );
        answer(reply, done)
    }

    fn skills_open_template(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let raw = arg(&args, 0);
        self.core.forget_gone();
        let mut host = self.core.host();
        let holder = self.core.open_files();
        let done = handle_open_template(
            &mut lock(&self.core.tabs),
            &mut host,
            &mut self.core.store.borrow_mut(),
            &holder,
            raw.as_ref(),
            id_of(cx.sender.view),
        );
        answer(reply, done)
    }

    fn skills_preview_original(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let preview_id = arg(&args, 0);
        let original = handle_preview_original(
            &lock(&self.core.tabs),
            preview_id.as_ref(),
            id_of(cx.sender.view),
        );
        match original {
            PreviewOriginalAnswer::Original { bytes, file_name } => {
                reply.reply(Ok(IpcValue::Object(vec![
                    ("ok".to_owned(), IpcValue::Bool(true)),
                    (
                        "bytes".to_owned(),
                        IpcValue::Bytes(shell_contract::BytesKind::Uint8Array, bytes),
                    ),
                    ("fileName".to_owned(), IpcValue::String(file_name)),
                ])))
            }
            PreviewOriginalAnswer::Refused(refused) => answer(reply, refused),
        }
    }

    fn skills_take_handoff(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let target = arg(&args, 0);
        self.core.forget_gone();
        let taken = handle_take_handoff(
            &mut lock(&self.core.tabs),
            &mut self.core.store.borrow_mut(),
            target.as_ref(),
            id_of(cx.sender.view),
        );
        let value = match taken {
            Some(handoff) => match serde_json::to_value(&handoff) {
                Ok(json) => json_value_from_serde(&json),
                Err(_) => JsonValue::Null,
            },
            None => JsonValue::Null,
        };
        answer(reply, value)
    }
}

/// The host the shell inserts for the template channels. Building it adds the
/// [`TemplateTabsCore`] to what the batches provide.
pub fn template_tabs_factory() -> Factory<dyn crate::ports::TemplateTabs> {
    Factory::new(|services, provided| {
        let port: Rc<dyn crate::ports::TemplateTabs> = Rc::new(TemplateTabsPort {
            core: template_tabs_core(services, provided)?,
        });
        Ok(port)
    })
}

/// The `a/skills-drop` trigger of tools/ipc-diff: a file dropped on a window
/// reaches `userSkillsIpc.queueDropped(entry)` from the shell's drop handler,
/// not from a channel call. `args[0]` is `{kind: "zip" | "skill-file", file}`
/// or `{kind: "no-skills"}`. `false` for any other name.
#[cfg(feature = "probe")]
pub fn probe_trigger(
    name: &str,
    args: &serde_json::Value,
    provided: &Rc<Provided>,
    then: shell_contract::editors::Then<IpcValue>,
) -> bool {
    if name != "a/skills-drop" {
        return false;
    }
    let given = match args {
        serde_json::Value::Array(items) => items.first().cloned().unwrap_or_default(),
        other => other.clone(),
    };
    let file = given["file"].as_str().unwrap_or_default().to_owned();
    let entry = match given["kind"].as_str() {
        Some("zip") => DroppedSkillEntry::Zip { file },
        Some("skill-file") => DroppedSkillEntry::SkillFile { file },
        _ => DroppedSkillEntry::NoSkills,
    };
    match provided.all::<SkillsCore>().into_iter().next() {
        Some(core) => {
            core.queue_dropped(entry);
            then(Ok(IpcValue::Undefined));
        }
        None => then(Err(shell_contract::IpcError {
            name: Some("Error".into()),
            message: "the skills port is not built".into(),
        })),
    }
    true
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, VecDeque};

    use main_core::packages::ai_provider::user_skills_import::{IeumSourceRecord, SkillFileChange};
    use main_core::packages::ai_provider::user_skills_import::{
        SkillImportCandidate, SkillImportOrigin,
    };
    use serde_json::{Value, json};
    use shell_contract::hosts::{
        Contents, Dialogs, MainWindow, MessageBox, MessageBoxAnswer, OsShell,
    };
    use shell_contract::ipc::EventSink;
    use shell_contract::runtime::{CancelToken, Thread, Workers};
    use shell_contract::{BytesKind, Hosts, IpcError};

    use super::*;
    use crate::port::Port;

    type Job = Box<dyn FnOnce() + Send>;

    /// the core thread's queue: what was posted runs when the test says
    #[derive(Default)]
    struct Queue(Mutex<VecDeque<Job>>);
    impl Queue {
        fn run(&self) {
            loop {
                let job = lock(&self.0).pop_front();
                match job {
                    Some(job) => job(),
                    None => break,
                }
            }
        }
    }
    impl Thread for Queue {
        fn post(&self, job: Job) {
            lock(&self.0).push_back(job);
        }
        fn is_current(&self) -> bool {
            true
        }
    }

    /// the workers: a job waits until the test runs it, so a call can be in
    /// flight while another arrives
    #[derive(Default)]
    struct Pool(Mutex<VecDeque<Job>>);
    impl Pool {
        fn run(&self) {
            loop {
                let job = lock(&self.0).pop_front();
                match job {
                    Some(job) => job(),
                    None => break,
                }
            }
        }
    }
    impl Workers for Pool {
        fn spawn(&self, job: Job) {
            lock(&self.0).push_back(job);
        }
    }

    type Emitted = (Target, &'static str, Vec<IpcValue>);
    #[derive(Default)]
    struct Events(Mutex<Vec<Emitted>>);
    impl EventSink for Events {
        fn emit(&self, target: Target, channel: &'static str, args: Vec<IpcValue>) {
            lock(&self.0).push((target, channel, args));
        }
    }
    impl Events {
        fn of(&self, channel: &str) -> Vec<(Target, Vec<IpcValue>)> {
            lock(&self.0)
                .iter()
                .filter(|(_, name, _)| *name == channel)
                .map(|(target, _, args)| (*target, args.clone()))
                .collect()
        }
    }

    type Listener = Box<dyn Fn(ViewId) + Send + Sync>;
    #[derive(Default)]
    struct ViewTable {
        live: Mutex<Vec<Sender>>,
        listeners: Mutex<Vec<Listener>>,
    }
    impl ViewTable {
        fn destroy(&self, view: u32) {
            lock(&self.live).retain(|sender| sender.view != ViewId(view));
            for listener in lock(&self.listeners).iter() {
                listener(ViewId(view));
            }
        }
    }
    impl Views for ViewTable {
        fn sender_of(&self, view: ViewId) -> Option<Sender> {
            lock(&self.live).iter().find(|s| s.view == view).copied()
        }
        fn all(&self) -> Vec<Sender> {
            lock(&self.live).clone()
        }
        fn on_destroyed(&self, listener: Listener) {
            lock(&self.listeners).push(listener);
        }
    }

    struct Paths(PathBuf);
    impl AppPaths for Paths {
        fn path(&self, name: PathName) -> PathBuf {
            match name {
                PathName::Home => self.0.join("home"),
                PathName::UserData => self.0.join("data"),
                PathName::Temp => self.0.join("temp"),
                _ => self.0.join("other"),
            }
        }
    }

    /// dialogs, the OS shell and web contents of the shell window
    #[derive(Default)]
    struct Pc {
        open: Mutex<VecDeque<Option<Vec<PathBuf>>>>,
        save: Mutex<VecDeque<Option<PathBuf>>>,
        asked: Mutex<Vec<String>>,
        trashed: Mutex<Vec<String>>,
        opened: Mutex<Vec<String>>,
        open_error: Mutex<String>,
        trash_fails: Mutex<bool>,
    }
    impl Dialogs for Pc {
        fn open(&self, parent: Option<WindowId>, options: &FileDialog) -> Option<Vec<PathBuf>> {
            lock(&self.asked).push(format!(
                "open {:?} {:?} {:?}",
                parent.map(|w| w.0),
                options.properties,
                options
                    .filters
                    .iter()
                    .map(|f| (f.name.clone(), f.extensions.clone()))
                    .collect::<Vec<_>>()
            ));
            lock(&self.open).pop_front().flatten()
        }
        fn save(&self, parent: Option<WindowId>, options: &FileDialog) -> Option<PathBuf> {
            lock(&self.asked).push(format!(
                "save {:?} {:?}",
                parent.map(|w| w.0),
                options
                    .default_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().into_owned())
            ));
            lock(&self.save).pop_front().flatten()
        }
        fn message(&self, _: Option<WindowId>, _: &MessageBox) -> MessageBoxAnswer {
            unreachable!("the skills channels ask no question")
        }
        fn error(&self, _: &str, _: &str) {}
    }
    impl OsShell for Pc {
        fn open_external(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn open_path(&self, path: &Path) -> String {
            lock(&self.opened).push(path.to_string_lossy().into_owned());
            lock(&self.open_error).clone()
        }
        fn show_item_in_folder(&self, _: &Path) {}
        fn trash_item(&self, path: &Path) -> Result<(), String> {
            if *lock(&self.trash_fails) {
                return Err("no trash".into());
            }
            lock(&self.trashed).push(path.to_string_lossy().into_owned());
            Ok(())
        }
    }
    impl Contents for Pc {
        fn window_of(&self, view: ViewId) -> Option<WindowId> {
            Some(WindowId(view.0))
        }
        fn capture_png(&self, _: ViewId) -> Result<Vec<u8>, String> {
            unreachable!()
        }
        fn print_to_pdf(&self, _: ViewId, _: IpcValue) -> Result<Vec<u8>, String> {
            unreachable!()
        }
        fn print(&self, _: ViewId, _: IpcValue) -> Result<bool, String> {
            unreachable!()
        }
        fn zoom_factor(&self, _: ViewId) -> f64 {
            1.0
        }
        fn set_zoom_factor(&self, _: ViewId, _: f64) {}
        fn focus(&self, _: ViewId) {}
        fn close_window(&self, _: WindowId) {}
    }

    struct Main;
    impl MainWindow for Main {
        fn view(&self) -> Option<ViewId> {
            Some(ViewId(1))
        }
        fn window(&self) -> Option<WindowId> {
            Some(WindowId(1))
        }
    }

    #[derive(Default)]
    struct Ui(Mutex<u32>);
    impl crate::shell_ai_prefs::ShellUi for Ui {
        fn document_locale(&self) -> String {
            "ko".into()
        }
        fn show_home_tab(&self) {
            *lock(&self.0) += 1;
        }
    }

    struct Shell(String);
    impl SkillsShell for Shell {
        fn builtin_skills_dir(&self) -> String {
            self.0.clone()
        }
    }

    /// The import library over a folder of one skill, `demo`
    struct Importer {
        stage: PathBuf,
        log: Mutex<Vec<String>>,
        throws: Mutex<Option<String>>,
        check: Mutex<Option<GitHubSkillUpdateCheck>>,
    }
    impl Importer {
        fn import(&self, origin: SkillImportOrigin) -> SkillImport {
            let dir = self.stage.to_string_lossy().into_owned();
            std::fs::create_dir_all(&self.stage).unwrap();
            std::fs::write(
                self.stage.join("SKILL.md"),
                "---\nname: demo\ndescription: A demo\n---\nBody text\n",
            )
            .unwrap();
            SkillImport {
                origin,
                root: dir.clone(),
                candidates: vec![SkillImportCandidate {
                    key: ".".into(),
                    rel: String::new(),
                    dir,
                    name: "demo".into(),
                    title: "Demo".into(),
                    description: "A demo".into(),
                    files: 1,
                    bytes: 40,
                    has_scripts: false,
                    has_template: false,
                    urls: Vec::new(),
                    url_count: 0,
                    license: None,
                    warnings: Vec::new(),
                    warning_count: 0,
                    collision: false,
                    empty_body: false,
                    problem: None,
                }],
                root_license: None,
                temp_dir: None,
            }
        }
        fn note(&self, line: String) {
            lock(&self.log).push(line);
        }
    }
    impl SkillImporter for Importer {
        fn prepare_skill_import(
            &self,
            source: &SkillImportSource,
            _env: &PrepareEnv,
            _aborted: Option<Aborted<'_>>,
        ) -> Result<SkillImport, Thrown> {
            self.note(format!("prepare {source:?}"));
            if let Some(message) = lock(&self.throws).clone() {
                return Err(Thrown::Plain(message));
            }
            Ok(self.import(match source {
                SkillImportSource::Folder { folder } => SkillImportOrigin::Folder {
                    folder: folder.clone(),
                },
                SkillImportSource::Zip { file } => SkillImportOrigin::Zip { file: file.clone() },
                SkillImportSource::SkillFile { file } => {
                    SkillImportOrigin::SkillFile { file: file.clone() }
                }
                SkillImportSource::Text { .. } => SkillImportOrigin::Text,
                SkillImportSource::Github { .. } => SkillImportOrigin::Github {
                    repo: "o/r".into(),
                    ref_: "main".into(),
                    commit: "abc".into(),
                    path: String::new(),
                },
            }))
        }
        fn install_imported_skills(
            &self,
            imported: &SkillImport,
            options: &InstallOptions,
            _discard: Discard<'_>,
        ) -> Result<InstallImportedSkillsResult, Thrown> {
            self.note(format!("install {:?}", options.selected));
            let installed = imported
                .candidates
                .iter()
                .filter(|c| options.selected.contains(&c.key))
                .map(|c| InstalledSkill {
                    key: c.key.clone(),
                    name: c.name.clone(),
                    dir: format!("{}/{}", options.app_skills_dir, c.name),
                    replaced: false,
                })
                .collect();
            Ok(InstallImportedSkillsResult {
                installed,
                skipped: Vec::new(),
            })
        }
        fn dispose_skill_import(&self, imported: &SkillImport) {
            self.note(format!("dispose {}", imported.candidates.len()));
        }
        fn check_github_skill_update(
            &self,
            options: &CheckUpdateOptions,
            _aborted: Option<Aborted<'_>>,
        ) -> Result<GitHubSkillUpdateCheck, Thrown> {
            self.note(format!("check {}", options.skill_dir));
            match lock(&self.check).clone() {
                Some(check) => Ok(check),
                None => Err(Thrown::Plain("offline".into())),
            }
        }
        fn apply_github_skill_update(
            &self,
            _check: &ChangedCheck,
            options: &ApplyUpdateOptions,
            _discard: Discard<'_>,
        ) -> Result<InstalledSkill, Thrown> {
            self.note(format!("apply {}", options.skill_dir));
            Ok(InstalledSkill {
                key: ".".into(),
                name: "gh-skill".into(),
                dir: options.skill_dir.clone(),
                replaced: true,
            })
        }
        fn export_skill_zip(&self, skill_dir: &str, out_path: &str) -> Result<(), Thrown> {
            self.note(format!("zip {skill_dir} -> {out_path}"));
            std::fs::write(out_path, b"zip").map_err(|e| Thrown::Plain(e.to_string()))
        }
        fn export_skill_bundle_zip(
            &self,
            skill_dirs: &[String],
            out_path: &str,
        ) -> Result<(), Thrown> {
            self.note(format!("bundle {} -> {out_path}", skill_dirs.len()));
            std::fs::write(out_path, b"zip").map_err(|e| Thrown::Plain(e.to_string()))
        }
    }

    /// The tab manager: where copies open, which file a panel's tab shows
    struct Copies {
        log: Mutex<Vec<String>>,
        opened: Mutex<Option<OpenedCopy>>,
        seen: Mutex<Vec<TemplateCopy>>,
        files: Mutex<HashMap<u32, String>>,
        open_files: Mutex<Result<Vec<OpenFileState>, OpenFilesSourceFailed>>,
        focusable: Mutex<Vec<String>>,
    }
    impl TemplateCopyTabs for Copies {
        fn open_template_copy(&self, copy: &TemplateCopy) -> Result<Option<OpenedCopy>, String> {
            lock(&self.seen).push(copy.clone());
            Ok(lock(&self.opened).clone())
        }
        fn opener_file_path(&self, opener: ViewId) -> Option<String> {
            lock(&self.files).get(&opener.0).cloned()
        }
        fn open_files(&self) -> Result<Vec<OpenFileState>, OpenFilesSourceFailed> {
            lock(&self.open_files).clone()
        }
        fn focus_tab(&self, tab_id: &str) -> bool {
            lock(&self.focusable).iter().any(|known| known == tab_id)
        }
        fn follow_opener_project(&self, copy: ViewId, opener: ViewId) {
            lock(&self.log).push(format!("follow {} {}", copy.0, opener.0));
        }
    }

    struct World {
        dir: PathBuf,
        queue: Arc<Queue>,
        pool: Arc<Pool>,
        events: Arc<Events>,
        views: Arc<ViewTable>,
        pc: Arc<Pc>,
        ui: Arc<Ui>,
        importer: Arc<Importer>,
        copies: Arc<Copies>,
        provided: Rc<Provided>,
        skills: Rc<dyn crate::ports::UserSkills>,
        tabs: Rc<dyn crate::ports::TemplateTabs>,
    }

    type Slot = Arc<Mutex<Option<Result<IpcValue, IpcError>>>>;

    const MAIN: u32 = 1;
    const AGENT: u32 = 7;
    const DOCS: u32 = 5;

    fn sender(view: u32, surface: Surface) -> Sender {
        Sender {
            view: ViewId(view),
            window: WindowId(view),
            surface,
        }
    }

    impl World {
        fn new(name: &str) -> World {
            let dir = std::env::temp_dir()
                .join(format!("shell-a-user-skills-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("data")).unwrap();
            let queue = Arc::new(Queue::default());
            let pool = Arc::new(Pool::default());
            let events = Arc::new(Events::default());
            let views = Arc::new(ViewTable::default());
            for (view, surface) in [
                (MAIN, Surface::Shell),
                (DOCS, Surface::Docs),
                (AGENT, Surface::ShellAgent),
                (9, Surface::Docs),
                (20, Surface::Docs),
            ] {
                lock(&views.live).push(sender(view, surface));
            }
            let pc = Arc::new(Pc::default());
            let ui = Arc::new(Ui::default());
            let importer = Arc::new(Importer {
                stage: dir.join("stage"),
                log: Mutex::default(),
                throws: Mutex::default(),
                check: Mutex::default(),
            });
            let copies = Arc::new(Copies {
                log: Mutex::default(),
                opened: Mutex::new(Some(OpenedCopy {
                    tab_id: "tab-1".into(),
                    view: ViewId(20),
                    owns_copy: false,
                })),
                seen: Mutex::default(),
                files: Mutex::default(),
                open_files: Mutex::new(Ok(Vec::new())),
                focusable: Mutex::default(),
            });
            let mut hosts = Hosts::default();
            hosts.insert::<DialogsHost>(pc.clone());
            hosts.insert::<OsShellHost>(pc.clone());
            hosts.insert::<ContentsHost>(pc.clone());
            hosts.insert::<MainWindowHost>(Arc::new(Main));
            hosts.insert::<ShellUiHost>(ui.clone());
            hosts.insert::<SkillImporterHost>(importer.clone());
            hosts.insert::<SkillsShellHost>(Arc::new(Shell(
                dir.join("builtin").to_string_lossy().into_owned(),
            )));
            hosts.insert::<TemplateCopyTabsHost>(copies.clone());
            let services = Services {
                ui: queue.clone(),
                core: queue.clone(),
                workers: pool.clone(),
                events: events.clone(),
                views: views.clone(),
                paths: Arc::new(Paths(dir.clone())),
                hosts: Arc::new(hosts),
            };
            let provided = Rc::new(Provided::default());
            let skills = (factory().0)(&services, &provided).unwrap();
            let tabs = (template_tabs_factory().0)(&services, &provided).unwrap();
            World {
                dir,
                queue,
                pool,
                events,
                views,
                pc,
                ui,
                importer,
                copies,
                provided,
                skills,
                tabs,
            }
        }

        fn home_skills(&self) -> PathBuf {
            self.dir.join("home/.seuoffice/skills")
        }

        /// the call is made and left waiting for the workers and the core queue
        fn start(&self, view: u32, channel: &str, args: Vec<IpcValue>) -> Slot {
            let from = lock(&self.views.live)
                .iter()
                .find(|s| s.view == ViewId(view))
                .copied()
                .expect("a live view");
            let cx = CallContext {
                sender: from,
                request: None,
                cancel: CancelToken::default(),
            };
            let slot: Slot = Arc::new(Mutex::new(None));
            let out = slot.clone();
            let reply = Responder::new(move |r| *lock(&out) = Some(r));
            let skill_index = <dyn crate::ports::UserSkills as Port>::CHANNELS
                .iter()
                .position(|c| c.name == channel);
            match skill_index {
                Some(index) => self.skills.dispatch(index, &cx, args, reply),
                None => {
                    let index = <dyn crate::ports::TemplateTabs as Port>::CHANNELS
                        .iter()
                        .position(|c| c.name == channel)
                        .unwrap_or_else(|| panic!("no channel {channel}"));
                    self.tabs.dispatch(index, &cx, args, reply)
                }
            }
            slot
        }

        /// the workers' jobs run, then what they posted to the core thread
        fn settle(&self) {
            self.pool.run();
            self.queue.run();
        }

        fn call(&self, view: u32, channel: &str, args: Vec<IpcValue>) -> Value {
            let slot = self.start(view, channel, args);
            self.settle();
            let answer = lock(&slot).take().expect("answered").expect("resolved");
            json_of(&answer)
        }

        fn call_raw(
            &self,
            view: u32,
            channel: &str,
            args: Vec<IpcValue>,
        ) -> Result<IpcValue, IpcError> {
            let slot = self.start(view, channel, args);
            self.settle();
            lock(&slot).take().expect("answered")
        }

        fn changed(&self) -> usize {
            self.events.of(CHANGED).len()
        }

        fn save_skill(&self, name: &str) -> String {
            let saved = self.call(
                MAIN,
                "skills:save",
                vec![iv(json!({
                    "title": name, "name": name, "description": "d", "body": "Do it"
                }))],
            );
            assert_eq!(saved["ok"], json!(true), "{saved}");
            saved["id"].as_str().expect("an id").to_owned()
        }
    }

    fn iv(value: Value) -> IpcValue {
        match value {
            Value::Null => IpcValue::Null,
            Value::Bool(b) => IpcValue::Bool(b),
            Value::Number(n) => IpcValue::Number(n.as_f64().unwrap()),
            Value::String(s) => IpcValue::String(s),
            Value::Array(items) => IpcValue::Array(items.into_iter().map(iv).collect()),
            Value::Object(map) => {
                IpcValue::Object(map.into_iter().map(|(k, v)| (k, iv(v))).collect())
            }
        }
    }

    fn json_of(value: &IpcValue) -> Value {
        match value {
            IpcValue::Undefined => json!("undefined"),
            IpcValue::Null => Value::Null,
            IpcValue::Bool(b) => json!(b),
            IpcValue::Number(n) => json!(n),
            IpcValue::String(s) => json!(s),
            IpcValue::Bytes(_, bytes) => json!({"bytes": bytes}),
            IpcValue::Date(ms) => json!(ms),
            IpcValue::Array(items) => Value::Array(items.iter().map(json_of).collect()),
            IpcValue::Object(entries) => Value::Object(
                entries
                    .iter()
                    .map(|(k, v)| (k.clone(), json_of(v)))
                    .collect(),
            ),
        }
    }

    fn s(text: &str) -> IpcValue {
        IpcValue::String(text.into())
    }

    fn reason(answer: &Value) -> String {
        assert_eq!(answer["ok"], json!(false), "{answer}");
        answer["reason"].as_str().unwrap_or_default().to_owned()
    }

    // ---- list, read, save, remove ----

    #[test]
    fn a_saved_skill_is_listed_read_and_removed_with_every_window_told() {
        let w = World::new("cycle");
        let id = w.save_skill("my-skill");
        assert!(w.home_skills().join("my-skill/SKILL.md").exists());
        assert_eq!(w.changed(), 1);
        assert_eq!(w.events.of(CHANGED)[0].0, Target::All);

        let listed = w.call(DOCS, "skills:list", vec![]);
        assert!(
            listed
                .as_array()
                .unwrap()
                .iter()
                .any(|skill| skill["id"] == json!(id)),
            "{listed}"
        );
        let read = w.call(DOCS, "skills:read", vec![s(&id)]);
        assert_eq!(read["ok"], json!(true), "{read}");

        let removed = w.call(MAIN, "skills:remove", vec![s(&id)]);
        assert_eq!(removed, json!({"ok": true}));
        assert_eq!(w.changed(), 2);
        // the OS trash takes the folder (the fake one keeps it where it was)
        assert_eq!(
            *lock(&w.pc.trashed),
            vec![
                w.home_skills()
                    .join("my-skill")
                    .to_string_lossy()
                    .into_owned()
            ]
        );
    }

    #[test]
    fn changes_are_for_the_settings_screen_and_the_agent_window_its_preview_only() {
        let w = World::new("gate");
        let id = w.save_skill("kept");
        let before = w.changed();
        let save = || iv(json!({"title": "t", "name": "other", "description": "d", "body": "b"}));
        for view in [DOCS, AGENT] {
            assert_eq!(
                reason(&w.call(view, "skills:save", vec![save()])),
                "not-allowed"
            );
            assert_eq!(
                reason(&w.call(view, "skills:remove", vec![s(&id)])),
                "not-allowed"
            );
        }
        assert!(w.home_skills().join("kept").exists());
        assert!(!w.home_skills().join("other").exists());
        assert_eq!(w.changed(), before);
        // the agent window may read the preview it holds; a page without one finds nothing
        let read_import = w.call(AGENT, "skills:read-import", vec![s("nope"), s(".")]);
        assert_eq!(reason(&read_import), "not-found");
        let from_docs = w.call(DOCS, "skills:read-import", vec![s("nope"), s(".")]);
        assert_eq!(reason(&from_docs), "not-allowed");
    }

    #[test]
    fn malformed_arguments_are_invalid_and_change_nothing() {
        let w = World::new("invalid");
        for (channel, args) in [
            ("skills:read", vec![IpcValue::Number(3.0)]),
            ("skills:ai-read", vec![s("no-colon")]),
            ("skills:ai-read-file", vec![s("app:x"), IpcValue::Null]),
            ("skills:save", vec![iv(json!({"title": 1}))]),
            ("skills:set-state", vec![s("app:x"), iv(json!({}))]),
            ("skills:hide-builtin", vec![]),
            ("skills:unhide-builtins", vec![s("all")]),
            ("skills:remove", vec![IpcValue::Undefined]),
            ("skills:copy-to-mine", vec![IpcValue::Null]),
            ("skills:import-text", vec![IpcValue::Number(1.0)]),
            ("skills:import-github", vec![IpcValue::Number(1.0)]),
            ("skills:check-update", vec![s("no-colon")]),
            ("skills:apply-update", vec![IpcValue::Null]),
            ("skills:cancel-update", vec![IpcValue::Null]),
            ("skills:export-info", vec![IpcValue::Null]),
            ("skills:export-zip", vec![IpcValue::Null]),
            ("skills:export-bundle", vec![iv(json!([]))]),
            ("skills:open-folder", vec![IpcValue::Null]),
            ("skills:install", vec![iv(json!({"token": ""}))]),
            ("skills:save-from-card", vec![iv(json!({"title": 1}))]),
            ("skills:read-import", vec![s("t"), IpcValue::Number(1.0)]),
            ("skills:cancel-import", vec![IpcValue::Number(1.0)]),
        ] {
            let answer = w.call(MAIN, channel, args);
            assert_eq!(reason(&answer), "invalid", "{channel}");
        }
        assert_eq!(w.changed(), 0);
        assert!(!w.home_skills().exists());
    }

    #[test]
    fn names_are_suggested_and_checked_against_the_skills_there_are() {
        let w = World::new("names");
        let id = w.save_skill("taken-name");
        let suggested = w.call(DOCS, "skills:suggest-name", vec![s("My Great Skill")]);
        assert!(
            suggested.as_str().is_some_and(|name| !name.is_empty()),
            "{suggested}"
        );
        // a title with nothing to make a name of gets a generated one
        let generated = w.call(DOCS, "skills:suggest-name", vec![IpcValue::Number(1.0)]);
        assert!(
            generated
                .as_str()
                .is_some_and(|name| name.starts_with("skill-")),
            "{generated}"
        );
        let taken = w.call(DOCS, "skills:check-name", vec![s("taken-name")]);
        assert_eq!(taken["ok"], json!(false), "{taken}");
        assert_eq!(
            w.call(DOCS, "skills:check-name", vec![s("fresh-name")]),
            json!({"ok": true})
        );
        assert_eq!(
            w.call(DOCS, "skills:check-name", vec![s("taken-name"), s(&id)]),
            json!({"ok": true})
        );
        assert_eq!(
            w.call(DOCS, "skills:check-name", vec![IpcValue::Null]),
            json!({"ok": false, "problem": "empty"})
        );
    }

    #[test]
    fn state_changes_hiding_and_copying_tell_the_windows() {
        let w = World::new("state");
        let id = w.save_skill("stateful");
        let before = w.changed();
        let set = w.call(
            MAIN,
            "skills:set-state",
            vec![s(&id), iv(json!({"enabled": false}))],
        );
        assert_eq!(set, json!({"ok": true}));
        assert_eq!(w.changed(), before + 1);
        let refused = w.call(
            MAIN,
            "skills:set-state",
            vec![s("app:missing"), iv(json!({"enabled": true}))],
        );
        assert_eq!(refused["ok"], json!(false), "{refused}");
        assert_eq!(w.changed(), before + 1, "a failed change tells nobody");
        let unhid = w.call(MAIN, "skills:unhide-builtins", vec![]);
        assert_eq!(unhid, json!({"ok": true}));
        assert_eq!(w.changed(), before + 2);
    }

    #[test]
    fn the_ai_reads_a_skill_and_its_files() {
        let w = World::new("ai-read");
        let id = w.save_skill("readable");
        let read = w.call(DOCS, "skills:ai-read", vec![s(&id)]);
        assert_eq!(read["ok"], json!(true), "{read}");
        std::fs::write(w.home_skills().join("readable/notes.txt"), "hello").unwrap();
        let file = w.call(DOCS, "skills:ai-read-file", vec![s(&id), s("notes.txt")]);
        assert_eq!(file, json!({"ok": true, "text": "hello"}));
        let outside = w.call(DOCS, "skills:ai-read-file", vec![s(&id), s("../x.txt")]);
        assert_eq!(outside["ok"], json!(false), "{outside}");
    }

    // ---- the card ----

    #[test]
    fn a_card_saves_its_template_bytes() {
        let w = World::new("card");
        let card = iv(json!({
            "title": "Card", "name": "card-skill", "description": "d", "body": "b",
            "template": {"fileName": "t.docx", "bytes": null},
        }));
        let IpcValue::Object(mut entries) = card else {
            unreachable!()
        };
        for (key, value) in entries.iter_mut() {
            if key == "template" {
                *value = IpcValue::Object(vec![
                    ("fileName".into(), s("t.docx")),
                    (
                        "bytes".into(),
                        IpcValue::Bytes(BytesKind::Uint8Array, vec![1, 2, 3]),
                    ),
                ]);
            }
        }
        let saved = w.call(
            DOCS,
            "skills:save-from-card",
            vec![IpcValue::Object(entries)],
        );
        assert_eq!(saved["ok"], json!(true), "{saved}");
        let template = w.home_skills().join("card-skill/assets/t.docx");
        assert_eq!(std::fs::read(&template).unwrap(), vec![1, 2, 3]);
        assert_eq!(w.changed(), 1);
    }

    // ---- import ----

    fn preview_token(answer: &Value) -> String {
        assert_eq!(answer["ok"], json!(true), "{answer}");
        answer["preview"]["token"]
            .as_str()
            .expect("a token")
            .to_owned()
    }

    #[test]
    fn a_pasted_skill_waits_under_a_token_for_its_own_window_until_installed() {
        let w = World::new("text");
        let previewed = w.call(
            MAIN,
            "skills:import-text",
            vec![s("---\nname: demo\n---\nBody")],
        );
        let token = preview_token(&previewed);
        assert_eq!(previewed["preview"]["candidates"][0]["name"], json!("demo"));
        assert_eq!(w.changed(), 0, "a preview changes no list");

        // another window (the agent window may read previews) cannot see it
        let other = w.call(AGENT, "skills:read-import", vec![s(&token), s(".")]);
        assert_eq!(reason(&other), "not-found");
        let read = w.call(MAIN, "skills:read-import", vec![s(&token), s(".")]);
        assert_eq!(read["ok"], json!(true), "{read}");
        assert_eq!(read["content"]["body"]["text"], json!("Body text\n"));

        let installed = w.call(
            MAIN,
            "skills:install",
            vec![iv(
                json!({"token": token, "selected": ["."], "onCollision": {}}),
            )],
        );
        assert_eq!(
            installed,
            json!({"ok": true, "installed": [{"key": ".", "id": "app:demo"}], "skipped": []})
        );
        assert_eq!(w.changed(), 1);
        // the preview is spent, and its folder disposed
        let again = w.call(
            MAIN,
            "skills:install",
            vec![iv(json!({"token": token, "selected": ["."]}))],
        );
        assert_eq!(reason(&again), "not-found");
        assert!(lock(&w.importer.log).iter().any(|l| l == "dispose 1"));
    }

    #[test]
    fn a_failed_preparation_answers_the_failure_and_keeps_nothing() {
        let w = World::new("prepare-fails");
        *lock(&w.importer.throws) = Some("boom".into());
        let answer = w.call(MAIN, "skills:import-text", vec![s("x")]);
        assert_eq!(reason(&answer), "failed");
    }

    #[test]
    fn cancelling_a_preview_disposes_it_for_its_owner_only() {
        let w = World::new("cancel-import");
        let token = preview_token(&w.call(MAIN, "skills:import-text", vec![s("x")]));
        // the agent window may cancel, but not what another window holds
        assert_eq!(
            w.call(AGENT, "skills:cancel-import", vec![s(&token)]),
            json!({"ok": true})
        );
        assert!(
            lock(&w.importer.log)
                .iter()
                .all(|l| !l.starts_with("dispose"))
        );
        assert_eq!(
            w.call(MAIN, "skills:cancel-import", vec![s(&token)]),
            json!({"ok": true})
        );
        assert!(lock(&w.importer.log).iter().any(|l| l == "dispose 1"));
        let gone = w.call(MAIN, "skills:read-import", vec![s(&token), s(".")]);
        assert_eq!(reason(&gone), "not-found");
    }

    #[test]
    fn folder_and_zip_imports_ask_the_person_with_the_options_of_the_screen() {
        let w = World::new("dialogs");
        // cancelled: nothing is prepared
        let cancelled = w.call(MAIN, "skills:import-folder", vec![]);
        assert_eq!(reason(&cancelled), "cancelled");
        assert!(lock(&w.importer.log).is_empty());

        lock(&w.pc.open).push_back(Some(vec![PathBuf::from("/picked/folder")]));
        let folder = w.call(MAIN, "skills:import-folder", vec![]);
        preview_token(&folder);
        lock(&w.pc.open).push_back(Some(vec![PathBuf::from("/picked/skill.zip")]));
        let zip = w.call(MAIN, "skills:import-zip", vec![]);
        preview_token(&zip);
        assert_eq!(
            *lock(&w.pc.asked),
            vec![
                "open Some(1) [\"openDirectory\"] []".to_owned(),
                "open Some(1) [\"openDirectory\"] []".to_owned(),
                "open Some(1) [\"openFile\"] [(\"Zip\", [\"zip\"])]".to_owned(),
            ]
        );
        assert_eq!(
            *lock(&w.importer.log),
            vec![
                "prepare Folder { folder: \"/picked/folder\" }".to_owned(),
                "prepare Zip { file: \"/picked/skill.zip\" }".to_owned(),
            ]
        );
    }

    // ---- the drop queue ----

    #[test]
    fn a_dropped_file_waits_in_a_bounded_queue_until_the_settings_screen_takes_it() {
        let w = World::new("dropped");
        let core = w.provided.all::<SkillsCore>().remove(0);
        let empty = w.call(MAIN, "skills:take-dropped", vec![]);
        assert_eq!(empty, json!({"ok": true, "preview": null}));

        core.queue_dropped(DroppedSkillEntry::Zip {
            file: "/drop/a.zip".into(),
        });
        core.queue_dropped(DroppedSkillEntry::NoSkills);
        core.queue_dropped(DroppedSkillEntry::SkillFile {
            file: "/drop/SKILL.md".into(),
        });
        let told = w.events.of(DROPPED);
        assert_eq!(told.len(), 3);
        assert!(
            told.iter()
                .all(|(target, args)| *target == Target::All && args.is_empty())
        );

        // only the settings screen takes; the first dropped comes first
        assert_eq!(
            reason(&w.call(DOCS, "skills:take-dropped", vec![])),
            "not-allowed"
        );
        preview_token(&w.call(MAIN, "skills:take-dropped", vec![]));
        assert_eq!(
            reason(&w.call(MAIN, "skills:take-dropped", vec![])),
            "no-skills"
        );
        preview_token(&w.call(MAIN, "skills:take-dropped", vec![]));
        assert_eq!(
            w.call(MAIN, "skills:take-dropped", vec![]),
            json!({"ok": true, "preview": null})
        );
        assert_eq!(
            *lock(&w.importer.log),
            vec![
                "prepare Zip { file: \"/drop/a.zip\" }".to_owned(),
                "prepare SkillFile { file: \"/drop/SKILL.md\" }".to_owned(),
            ]
        );

        for n in 0..25 {
            core.queue_dropped(DroppedSkillEntry::Zip {
                file: format!("/drop/{n}.zip"),
            });
        }
        lock(&w.importer.log).clear();
        let mut taken = 0;
        loop {
            let answer = w.call(MAIN, "skills:take-dropped", vec![]);
            if answer["preview"].is_null() {
                break;
            }
            taken += 1;
        }
        assert_eq!(taken, 20, "older drops go first");
        assert_eq!(
            lock(&w.importer.log)[0],
            "prepare Zip { file: \"/drop/5.zip\" }"
        );
    }

    // ---- GitHub: the network on a worker ----

    #[test]
    fn a_github_import_answers_when_its_worker_finishes_and_one_runs_at_a_time() {
        let w = World::new("github");
        let first = w.start(MAIN, "skills:import-github", vec![s("o/r")]);
        assert!(lock(&first).is_none(), "the call waits on the network");
        assert!(lock(&w.importer.log).is_empty(), "the worker has not run");
        let second = w.call(MAIN, "skills:import-github", vec![s("o/other")]);
        assert_eq!(reason(&second), "busy");

        w.settle();
        let answer = json_of(&lock(&first).take().unwrap().unwrap());
        let token = preview_token(&answer);
        assert_eq!(answer["preview"]["origin"]["kind"], json!("github"));
        assert_eq!(
            *lock(&w.importer.log),
            vec!["prepare Github { address: \"o/r\" }".to_owned()]
        );
        // the run is over: the window may import again
        let again = w.call(MAIN, "skills:import-github", vec![s("o/r")]);
        preview_token(&again);
        assert_ne!(token, preview_token(&again));
    }

    #[test]
    fn cancelling_a_github_import_in_flight_disposes_what_arrives() {
        let w = World::new("github-cancel");
        let first = w.start(MAIN, "skills:import-github", vec![s("o/r")]);
        // no token: the call that is running is the one to stop
        assert_eq!(
            w.call(MAIN, "skills:cancel-import", vec![]),
            json!({"ok": true})
        );
        w.settle();
        let answer = json_of(&lock(&first).take().unwrap().unwrap());
        assert_eq!(reason(&answer), "cancelled");
        assert_eq!(
            *lock(&w.importer.log),
            vec![
                "prepare Github { address: \"o/r\" }".to_owned(),
                "dispose 1".to_owned()
            ]
        );
    }

    #[test]
    fn a_failed_github_import_answers_the_failure() {
        let w = World::new("github-fails");
        *lock(&w.importer.throws) = Some("offline".into());
        let answer = w.call(MAIN, "skills:import-github", vec![s("o/r")]);
        assert_eq!(reason(&answer), "failed");
        // and the window is free again
        *lock(&w.importer.throws) = None;
        preview_token(&w.call(MAIN, "skills:import-github", vec![s("o/r")]));
    }

    // ---- updates ----

    fn github_skill(w: &World) -> String {
        let dir = w.home_skills().join("gh-skill");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: gh-skill\ndescription: From GitHub\n---\nBody\n",
        )
        .unwrap();
        std::fs::write(
            dir.join(".ieum-source.json"),
            r#"{"kind":"github","repo":"o/r","ref":"main","path":"","commit":"old","installedAt":"2026-01-01T00:00:00Z","contentHash":"h"}"#,
        )
        .unwrap();
        "app:gh-skill".to_owned()
    }

    fn record() -> IeumSourceRecord {
        IeumSourceRecord {
            repo: "o/r".into(),
            ref_: "main".into(),
            path: String::new(),
            commit: "new".into(),
            installed_at: "2026-02-01T00:00:00Z".into(),
            content_hash: "h2".into(),
        }
    }

    #[test]
    fn an_update_is_found_on_a_worker_held_under_a_token_and_applied_once() {
        let w = World::new("update");
        let id = github_skill(&w);
        let import = w.importer.import(SkillImportOrigin::Github {
            repo: "o/r".into(),
            ref_: "main".into(),
            commit: "new".into(),
            path: String::new(),
        });
        *lock(&w.importer.check) = Some(GitHubSkillUpdateCheck::Changed(Box::new(ChangedCheck {
            record: record(),
            commit: "new".into(),
            locally_edited: false,
            changed_files: vec![SkillFileChange {
                rel: "SKILL.md".into(),
                change: "modified",
            }],
            update: import,
        })));
        let waiting = w.start(MAIN, "skills:check-update", vec![s(&id)]);
        assert!(lock(&waiting).is_none());
        w.settle();
        let found = json_of(&lock(&waiting).take().unwrap().unwrap());
        assert_eq!(found["status"], json!("changed"), "{found}");
        assert_eq!(
            found["changedFiles"],
            json!([{"rel": "SKILL.md", "change": "modified"}])
        );
        assert_eq!(found["locallyEdited"], json!(false));
        let token = found["token"].as_str().unwrap().to_owned();

        // not another window's, then the owner's
        assert_eq!(
            reason(&w.call(AGENT, "skills:apply-update", vec![s(&token)])),
            "not-allowed"
        );
        let before = w.changed();
        let applied = w.call(MAIN, "skills:apply-update", vec![s(&token)]);
        assert_eq!(
            applied,
            json!({"ok": true, "id": "app:gh-skill"}),
            "{applied}"
        );
        assert_eq!(w.changed(), before + 1);
        let twice = w.call(MAIN, "skills:apply-update", vec![s(&token)]);
        assert_eq!(reason(&twice), "not-found");
        assert!(
            lock(&w.importer.log)
                .iter()
                .any(|l| l.starts_with("apply "))
        );
    }

    #[test]
    fn a_current_skill_is_up_to_date_and_a_skill_without_github_is_not_checked() {
        let w = World::new("up-to-date");
        let id = github_skill(&w);
        *lock(&w.importer.check) = Some(GitHubSkillUpdateCheck::UpToDate {
            record: record(),
            commit: "old".into(),
            locally_edited: true,
        });
        assert_eq!(
            w.call(MAIN, "skills:check-update", vec![s(&id)]),
            json!({"ok": true, "status": "up-to-date", "locallyEdited": true})
        );
        let own = w.save_skill("plain");
        let calls = lock(&w.importer.log).len();
        let refused = w.call(MAIN, "skills:check-update", vec![s(&own)]);
        assert_eq!(reason(&refused), "not-github");
        assert_eq!(
            lock(&w.importer.log).len(),
            calls,
            "the network was not asked"
        );
        let missing = w.call(MAIN, "skills:check-update", vec![s("app:absent")]);
        assert_eq!(reason(&missing), "not-found");
    }

    #[test]
    fn a_cancelled_update_disposes_the_found_files_and_a_failed_check_is_a_failure() {
        let w = World::new("update-cancel");
        let id = github_skill(&w);
        let failed = w.call(MAIN, "skills:check-update", vec![s(&id)]);
        assert_eq!(reason(&failed), "failed");

        let import = w.importer.import(SkillImportOrigin::Github {
            repo: "o/r".into(),
            ref_: "main".into(),
            commit: "new".into(),
            path: String::new(),
        });
        *lock(&w.importer.check) = Some(GitHubSkillUpdateCheck::Changed(Box::new(ChangedCheck {
            record: record(),
            commit: "new".into(),
            locally_edited: true,
            changed_files: Vec::new(),
            update: import,
        })));
        let found = w.call(MAIN, "skills:check-update", vec![s(&id)]);
        let token = found["token"].as_str().unwrap().to_owned();
        assert_eq!(
            w.call(MAIN, "skills:cancel-update", vec![s(&token)]),
            json!({"ok": true})
        );
        assert!(lock(&w.importer.log).iter().any(|l| l == "dispose 1"));
        assert_eq!(
            reason(&w.call(MAIN, "skills:apply-update", vec![s(&token)])),
            "not-found"
        );
    }

    #[test]
    fn windows_that_go_away_take_their_waiting_work_with_them() {
        let w = World::new("gone");
        // the shell window holds a preview and an import in flight, then goes away
        let token = preview_token(&w.call(MAIN, "skills:import-text", vec![s("x")]));
        let flight = w.start(MAIN, "skills:import-github", vec![s("o/r")]);
        w.views.destroy(MAIN);
        assert!(
            lock(&w.importer.log).iter().any(|l| l == "dispose 1"),
            "the waiting preview is disposed at once"
        );
        w.settle();
        // the answer of a view that is gone is still given; it says cancelled
        let answer = json_of(&lock(&flight).take().unwrap().unwrap());
        assert_eq!(reason(&answer), "cancelled");
        let disposed = lock(&w.importer.log)
            .iter()
            .filter(|l| *l == "dispose 1")
            .count();
        assert_eq!(disposed, 2, "the import that arrived late was disposed too");
        let _ = token;
    }

    // ---- export ----

    #[test]
    fn a_skill_is_exported_to_the_zip_the_person_names() {
        let w = World::new("export");
        let id = w.save_skill("exported");
        let info = w.call(MAIN, "skills:export-info", vec![s(&id)]);
        assert_eq!(info["ok"], json!(true), "{info}");
        let file_name = info["fileName"].as_str().unwrap().to_owned();

        let out = w.dir.join("out.zip");
        lock(&w.pc.save).push_back(Some(out.clone()));
        let zipped = w.call(MAIN, "skills:export-zip", vec![s(&id)]);
        assert_eq!(
            zipped,
            json!({"ok": true, "path": out.to_string_lossy()}),
            "{zipped}"
        );
        assert_eq!(std::fs::read(&out).unwrap(), b"zip");
        assert_eq!(
            *lock(&w.pc.asked),
            vec![format!("save Some(1) Some(\"{file_name}\")")]
        );
        // cancelled: nothing is written
        let cancelled = w.call(MAIN, "skills:export-zip", vec![s(&id)]);
        assert_eq!(reason(&cancelled), "cancelled");
        assert_eq!(lock(&w.importer.log).len(), 1);
    }

    #[test]
    fn several_skills_are_exported_as_one_bundle_named_by_the_screen() {
        let w = World::new("bundle");
        let (one, two) = (w.save_skill("one"), w.save_skill("two"));
        let out = w.dir.join("bundle.zip");
        lock(&w.pc.save).push_back(Some(out.clone()));
        let done = w.call(
            MAIN,
            "skills:export-bundle",
            vec![iv(json!([one, two, one])), s("My bundle")],
        );
        assert_eq!(done["ok"], json!(true), "{done}");
        assert!(
            lock(&w.importer.log)
                .iter()
                .any(|l| l.starts_with("bundle 2 "))
        );
        let asked = lock(&w.pc.asked)[0].clone();
        assert!(
            asked.contains("My"),
            "the suggested words name the file: {asked}"
        );
    }

    #[test]
    fn a_skill_folder_opens_in_the_os_and_a_refusal_is_a_failure() {
        let w = World::new("folder");
        let id = w.save_skill("openable");
        assert_eq!(
            w.call(MAIN, "skills:open-folder", vec![s(&id)]),
            json!({"ok": true})
        );
        assert_eq!(
            *lock(&w.pc.opened),
            vec![
                w.home_skills()
                    .join("openable")
                    .to_string_lossy()
                    .into_owned()
            ]
        );
        *lock(&w.pc.open_error) = "no app".into();
        assert_eq!(
            reason(&w.call(MAIN, "skills:open-folder", vec![s(&id)])),
            "failed"
        );
    }

    // ---- the settings page and the agent notice ----

    #[test]
    fn settings_open_on_the_skills_page_of_the_shell_window() {
        let w = World::new("settings");
        assert_eq!(
            w.call_raw(DOCS, "skills:open-settings", vec![]),
            Ok(IpcValue::Undefined)
        );
        assert_eq!(*lock(&w.ui.0), 1);
        let sent = w.events.of(HOME_OPEN_SETTINGS);
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, Target::View(ViewId(MAIN)));
        assert_eq!(json_of(&sent[0].1[0]), json!({"section": "skills"}));
    }

    #[test]
    fn the_agent_notice_is_due_once_the_warning_is_accepted_until_seen() {
        let w = World::new("notice");
        assert_eq!(w.call(AGENT, "skills:agent-notice", vec![]), json!(false));
        std::fs::create_dir_all(w.dir.join("data")).unwrap();
        std::fs::write(
            w.dir.join("data/app-settings.json"),
            r#"{"agent":{"warningAccepted":1}}"#,
        )
        .unwrap();
        assert_eq!(w.call(AGENT, "skills:agent-notice", vec![]), json!(true));
        assert_eq!(
            w.call_raw(AGENT, "skills:agent-notice-seen", vec![]),
            Ok(IpcValue::Undefined)
        );
        assert_eq!(w.call(AGENT, "skills:agent-notice", vec![]), json!(false));
    }

    // ---- the template tabs ----

    fn skill_with_template(w: &World) -> String {
        let dir = w.home_skills().join("tpl");
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: tpl\ndescription: A template\nmetadata:\n  ieum-template: assets/letter.docx\n---\nUse it\n",
        )
        .unwrap();
        std::fs::write(dir.join("assets/letter.docx"), [9u8, 8, 7]).unwrap();
        "app:tpl".to_owned()
    }

    fn open_template_input(id: &str, with_current: bool) -> IpcValue {
        let mut input = json!({"skillId": id, "text": "make it", "chips": [
            {"id": id, "source": "app", "title": "Tpl"}
        ]});
        if with_current {
            input["withCurrent"] = json!(true);
        }
        iv(input)
    }

    #[test]
    fn a_template_opens_as_a_copy_in_a_tab_and_its_request_is_taken_once_by_that_tab() {
        let w = World::new("template");
        let id = skill_with_template(&w);
        let opened = w.call(
            DOCS,
            "skills:open-template",
            vec![open_template_input(&id, false)],
        );
        assert_eq!(
            opened,
            json!({"ok": true, "tabId": "tab-1", "attached": false}),
            "{opened}"
        );
        let copy = lock(&w.copies.seen)[0].clone();
        assert_eq!(copy.file_name, "letter.docx");
        assert_eq!(copy.title, "letter");
        assert_eq!(std::fs::read(&copy.path).unwrap(), vec![9, 8, 7]);
        assert!(
            copy.path.starts_with(
                &*w.dir
                    .join("temp/seuoffice-template-copies")
                    .to_string_lossy()
            )
        );
        // the copy's tab follows the panel that asked
        assert_eq!(*lock(&w.copies.log), vec![format!("follow 20 {DOCS}")]);

        // only that tab takes it, and only for its editor, once
        assert_eq!(
            w.call(DOCS, "skills:take-handoff", vec![s("docs")]),
            Value::Null
        );
        assert_eq!(
            w.call(20, "skills:take-handoff", vec![s("sheets")]),
            Value::Null
        );
        assert_eq!(
            w.call(20, "skills:take-handoff", vec![s("nonsense")]),
            Value::Null
        );
        let taken = w.call(20, "skills:take-handoff", vec![s("docs")]);
        assert_eq!(taken["text"], json!("make it"), "{taken}");
        assert_eq!(taken["mode"], json!("skill"));
        assert_eq!(taken["target"], json!("docs"));
        assert_eq!(taken["chips"][0]["title"], json!("Tpl"));
        assert!(taken.get("attach").is_none());
        assert_eq!(
            w.call(20, "skills:take-handoff", vec![s("docs")]),
            Value::Null
        );
    }

    #[test]
    fn a_template_request_names_a_skill_with_a_template_or_is_refused() {
        let w = World::new("template-refused");
        let missing = w.call(
            DOCS,
            "skills:open-template",
            vec![open_template_input("app:absent", false)],
        );
        assert_eq!(missing["ok"], json!(false), "{missing}");
        let plain = w.save_skill("no-template");
        let none = w.call(
            DOCS,
            "skills:open-template",
            vec![open_template_input(&plain, false)],
        );
        assert_eq!(none["ok"], json!(false), "{none}");
        assert_eq!(
            reason(&w.call(
                DOCS,
                "skills:open-template",
                vec![iv(json!({"skillId": 1}))]
            )),
            "invalid"
        );
        assert!(lock(&w.copies.seen).is_empty());

        // the tab could not open: the folder made for the copy is removed
        let id = skill_with_template(&w);
        *lock(&w.copies.opened) = None;
        let failed = w.call(
            DOCS,
            "skills:open-template",
            vec![open_template_input(&id, false)],
        );
        assert_eq!(reason(&failed), "failed");
        let copy = lock(&w.copies.seen)[0].clone();
        assert!(!Path::new(&copy.dir).exists());
    }

    #[test]
    fn the_asking_tabs_saved_file_goes_along_only_without_unsaved_changes() {
        let w = World::new("with-current");
        let id = skill_with_template(&w);
        // never saved
        let never = w.call(
            DOCS,
            "skills:open-template",
            vec![open_template_input(&id, true)],
        );
        assert_eq!(reason(&never), "unsaved");
        // saved, with unsaved changes
        lock(&w.copies.files).insert(DOCS, "/docs/a.docx".into());
        *lock(&w.copies.open_files) = Ok(vec![OpenFileState {
            file_path: Some("/docs/a.docx".into()),
            dirty: true,
        }]);
        let dirty = w.call(
            DOCS,
            "skills:open-template",
            vec![open_template_input(&id, true)],
        );
        assert_eq!(reason(&dirty), "unsaved");
        // the shell cannot say: refused as well
        *lock(&w.copies.open_files) = Err(OpenFilesSourceFailed);
        assert_eq!(
            reason(&w.call(
                DOCS,
                "skills:open-template",
                vec![open_template_input(&id, true)]
            )),
            "unsaved"
        );
        assert!(lock(&w.copies.seen).is_empty(), "nothing opened");
        // clean
        *lock(&w.copies.open_files) = Ok(vec![OpenFileState {
            file_path: Some("/docs/a.docx".into()),
            dirty: false,
        }]);
        let clean = w.call(
            DOCS,
            "skills:open-template",
            vec![open_template_input(&id, true)],
        );
        assert_eq!(
            clean,
            json!({"ok": true, "tabId": "tab-1", "attached": true}),
            "{clean}"
        );
        let taken = w.call(20, "skills:take-handoff", vec![s("docs")]);
        assert_eq!(taken["attach"], json!(["/docs/a.docx"]));
    }

    fn preview_input(redacted: bool) -> IpcValue {
        IpcValue::Object(vec![
            (
                "bytes".into(),
                IpcValue::Bytes(BytesKind::Uint8Array, vec![4, 5, 6]),
            ),
            ("fileName".into(), s("report.docx")),
            ("title".into(), s("Report")),
            ("tabTitle".into(), s("Template preview - Report")),
            ("text".into(), s("clear it")),
            ("originalRedacted".into(), IpcValue::Bool(redacted)),
            ("proposal".into(), iv(json!({"name": "report"}))),
        ])
    }

    #[test]
    fn a_preview_keeps_the_original_for_its_tab_and_tells_the_owner_when_it_ends() {
        let w = World::new("preview");
        let opened = w.call(DOCS, "skills:open-preview", vec![preview_input(false)]);
        assert_eq!(opened["ok"], json!(true), "{opened}");
        assert_eq!(opened["tabId"], json!("tab-1"));
        let preview_id = opened["previewId"].as_str().unwrap().to_owned();
        let copy = lock(&w.copies.seen)[0].clone();
        assert_eq!(copy.file_name, "Template preview - Report.docx");
        assert_eq!(std::fs::read(&copy.path).unwrap(), vec![4, 5, 6]);
        assert!(
            lock(&w.copies.log).is_empty(),
            "a preview's tab does not follow a project"
        );

        // only the preview tab reads the original
        let refused = w.call(DOCS, "skills:preview-original", vec![s(&preview_id)]);
        assert_eq!(reason(&refused), "not-found");
        let original = w
            .call_raw(20, "skills:preview-original", vec![s(&preview_id)])
            .unwrap();
        assert_eq!(
            original,
            IpcValue::Object(vec![
                ("ok".into(), IpcValue::Bool(true)),
                (
                    "bytes".into(),
                    IpcValue::Bytes(BytesKind::Uint8Array, vec![4, 5, 6])
                ),
                ("fileName".into(), s("report.docx")),
            ])
        );

        // the preview's hand-off carries the proposal
        let taken = w.call(20, "skills:take-handoff", vec![s("docs")]);
        assert_eq!(taken["preview"]["previewId"], json!(preview_id));
        assert_eq!(taken["preview"]["proposal"], json!({"name": "report"}));

        // only the preview tab ends it; the owner hears it once
        let ended = iv(
            json!({"previewId": preview_id, "outcome": "saved", "skillId": "app:made", "title": "Made"}),
        );
        assert_eq!(
            reason(&w.call(DOCS, "skills:finish-preview", vec![ended.clone()])),
            "not-found"
        );
        assert!(w.events.of("skills:preview-ended").is_empty());
        assert_eq!(
            w.call(20, "skills:finish-preview", vec![ended.clone()]),
            json!({"ok": true})
        );
        assert_eq!(
            w.call(20, "skills:finish-preview", vec![ended]),
            json!({"ok": true})
        );
        let heard = w.events.of("skills:preview-ended");
        assert_eq!(heard.len(), 1);
        assert_eq!(heard[0].0, Target::View(ViewId(DOCS)));
        assert_eq!(
            json_of(&heard[0].1[0]),
            json!({"previewId": preview_id, "outcome": "saved", "skillId": "app:made", "title": "Made"})
        );
    }

    #[test]
    fn an_original_that_may_withhold_something_is_not_handed_back() {
        let w = World::new("redacted");
        let opened = w.call(DOCS, "skills:open-preview", vec![preview_input(true)]);
        let preview_id = opened["previewId"].as_str().unwrap().to_owned();
        let refused = w.call(20, "skills:preview-original", vec![s(&preview_id)]);
        assert_eq!(reason(&refused), "redacted");
        assert_eq!(
            reason(&w.call(
                DOCS,
                "skills:open-preview",
                vec![iv(json!({"fileName": "a.docx"}))]
            )),
            "invalid"
        );
        assert_eq!(
            reason(&w.call(20, "skills:preview-original", vec![IpcValue::Number(1.0)])),
            "invalid"
        );
        assert_eq!(
            reason(&w.call(
                20,
                "skills:finish-preview",
                vec![iv(json!({"previewId": "x", "outcome": "later"}))]
            )),
            "invalid"
        );
    }

    #[test]
    fn closing_a_preview_tab_unsaved_ends_it_as_not_saved_and_removes_its_copy() {
        let w = World::new("preview-closed");
        let opened = w.call(DOCS, "skills:open-preview", vec![preview_input(false)]);
        let preview_id = opened["previewId"].as_str().unwrap().to_owned();
        let copy = lock(&w.copies.seen)[0].clone();
        assert!(Path::new(&copy.dir).exists());

        w.views.destroy(20);
        let heard = w.events.of("skills:preview-ended");
        assert_eq!(heard.len(), 1);
        assert_eq!(heard[0].0, Target::View(ViewId(DOCS)));
        assert_eq!(
            json_of(&heard[0].1[0]),
            json!({"previewId": preview_id, "outcome": "unsaved"})
        );
        assert!(
            !Path::new(&copy.dir).exists(),
            "the editor does not own the copy"
        );
        // the hand-off nobody took is gone from the shared queue
        assert_eq!(
            w.provided.all::<RefCell<HandoffStore>>()[0]
                .borrow()
                .queued_skill_handoffs()
                .len(),
            1,
            "dropped at the next call that touches the queue"
        );
        w.call(DOCS, "skills:take-handoff", vec![s("docs")]);
        assert!(
            w.provided.all::<RefCell<HandoffStore>>()[0]
                .borrow()
                .queued_skill_handoffs()
                .is_empty()
        );
    }

    #[test]
    fn a_preview_ended_before_its_tab_closes_is_not_reported_again_and_a_gone_owner_hears_nothing()
    {
        let w = World::new("preview-twice");
        let opened = w.call(DOCS, "skills:open-preview", vec![preview_input(false)]);
        let preview_id = opened["previewId"].as_str().unwrap().to_owned();
        w.call(
            20,
            "skills:finish-preview",
            vec![iv(json!({"previewId": preview_id, "outcome": "unsaved"}))],
        );
        w.views.destroy(20);
        assert_eq!(w.events.of("skills:preview-ended").len(), 1);

        // an owner that is gone hears nothing
        *lock(&w.copies.opened) = Some(OpenedCopy {
            tab_id: "tab-2".into(),
            view: ViewId(9),
            owns_copy: true,
        });
        let second = w.call(DOCS, "skills:open-preview", vec![preview_input(false)]);
        assert_eq!(second["tabId"], json!("tab-2"));
        w.views.destroy(DOCS);
        w.views.destroy(9);
        assert_eq!(w.events.of("skills:preview-ended").len(), 1);
        // an editor that owns its copy removes it itself
        let copy = lock(&w.copies.seen)[1].clone();
        assert!(Path::new(&copy.dir).exists());
    }

    #[test]
    fn a_tab_is_focused_when_it_is_still_there() {
        let w = World::new("focus");
        lock(&w.copies.focusable).push("tab-1".into());
        assert_eq!(
            w.call(DOCS, "skills:focus-tab", vec![s("tab-1")]),
            json!({"ok": true})
        );
        assert_eq!(
            reason(&w.call(DOCS, "skills:focus-tab", vec![s("tab-9")])),
            "not-found"
        );
        assert_eq!(
            reason(&w.call(DOCS, "skills:focus-tab", vec![IpcValue::Number(1.0)])),
            "invalid"
        );
        assert_eq!(
            reason(&w.call(DOCS, "skills:focus-tab", vec![s(&"x".repeat(65))])),
            "invalid"
        );
    }

    #[test]
    fn the_agent_window_reaches_the_same_core_through_what_is_provided() {
        let w = World::new("provided");
        let id = w.save_skill("for-agent");
        let core = w.provided.all::<SkillsCore>().remove(0);
        assert!(core.list().unwrap().iter().any(|skill| {
            matches!(skill, JsonValue::Object(o) if o.get("id") == Some(&JsonValue::String(id.clone())))
        }));
        let enabled = core.enabled_for_agent(None).unwrap();
        assert!(enabled.iter().any(|skill| skill.id == id));
        assert_eq!(w.provided.all::<TemplateTabsCore>().len(), 1);
        // one queue of hand-offs for every port that asks for it
        let a = shared_handoff_store(&w.provided);
        let b = shared_handoff_store(&w.provided);
        assert!(Rc::ptr_eq(&a, &b));
        assert_eq!(w.provided.all::<SkillsCore>().len(), 1);
    }
}
