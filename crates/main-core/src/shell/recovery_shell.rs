//! `apps/shell/src/main/recovery-shell.ts`: the shell's Electron side of crash
//! recovery: the editors' answers about an untitled document's copy, the
//! openers restored tabs load through, and the launch flow that carries out
//! launch-recovery.ts.
//!
//! What stays with the caller: the shell's one recovery store (the
//! `store ??= createRecoveryStore(...)` of `shellRecoveryStore`: the caller
//! keeps one [`RecoveryStore`] and hands it to every function that reads it),
//! the editors' main modules ([`RecoveryEditors`]), the tab manager
//! ([`LaunchManager`]), the launch list's gate and the rest of the launch's
//! `deps` ([`LaunchDeps`]). `planLaunch` and `resolveLaunchDecisions` of
//! launch-recovery.ts are not ported: they are the [`LaunchPlanner`], under
//! the names of the TypeScript exports, with the plan types it reads and
//! writes defined here. The module-level `plannedUntitled` map is a
//! [`RecoveryShell`] the caller owns. The launch list's answer arrives later:
//! [`run_launch_recovery`] hands back a [`PendingLaunchList`] whose
//! [`PendingLaunchList::answer`] is the callback the gate would run.

use std::collections::HashMap;

use serde_json::Value;

use crate::node_fs::NodeError;
use crate::packages::electron_utils::recovery_contract::RecoveryOpenUntitledRequest;
use crate::packages::electron_utils::recovery_store::{
    RecoveryFileIdentity, RecoveryIdentity, RecoveryLaunchDecision, RecoveryOpenPlan,
    RecoveryStore, RecoveryUntitledIdentity, is_recovery_editor_kind, is_untitled_identity,
};
use crate::shell::renderer_disposal::Failure;
use crate::shell::session_record::{
    PreviousExitJudgment, SessionRecordProcess, SessionRecordReadResult, SessionRecorderEnv,
    SessionRecorderOptions, SessionUntitledCopy, judge_previous_exit,
};

/// the part of a `WebContents` this module reads
pub trait RecoveryContents {
    fn id(&self) -> i64;
    fn is_destroyed(&self) -> bool;
}

/// What the editors' main modules answer, by editor (the `switch` of
/// `editorRecoveryIdentity` picks one). Each may throw.
pub trait RecoveryEditors {
    type Contents: RecoveryContents;
    /// the view a editor makes, whose `webContents` the contract opens a copy in
    type View;

    fn docs_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure>;
    fn sheets_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure>;
    fn pdf_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure>;
    fn markdown_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure>;
    fn html_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure>;
    fn mindmap_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure>;
    fn hwp_recovery_identity(
        &self,
        contents: &Self::Contents,
    ) -> Result<Option<RecoveryIdentity>, Failure>;
    fn slides_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure>;
    fn diagram_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure>;

    fn discard_docs_recovery(&self, contents: &Self::Contents);
    fn discard_sheets_recovery(&self, contents: &Self::Contents);
    fn discard_pdf_recovery(&self, contents: &Self::Contents);
    fn discard_mindmap_recovery(&self, contents: &Self::Contents);
    fn hwp_discard_recovery_copy(&self, contents: &Self::Contents);
    fn discard_diagram_recovery(&self, contents: &Self::Contents);

    /// `createPdfView()`
    fn create_pdf_view(&self) -> Result<Self::View, Failure>;
    /// `createSheetsView({ includeAiHandlers, openingWorkbook })`
    fn create_sheets_view(
        &self,
        include_ai_handlers: bool,
        opening_workbook: bool,
    ) -> Result<Self::View, Failure>;
    /// `createPlainEditorView(kind, filePath?)`
    fn create_plain_editor_view(
        &self,
        kind: &str,
        file_path: Option<&str>,
    ) -> Result<Self::View, Failure>;

    /// `isRecoveryEditorKind(kind) ? recoveryEditor(kind) : null` is not null
    fn has_recovery_editor(&self, kind: &str) -> bool;
    /// `contract.openUntitledCopy(view.webContents, request)`: `Err` is a
    /// throw or a rejection
    fn open_untitled_copy(
        &self,
        kind: &str,
        view: &Self::View,
        request: &RecoveryOpenUntitledRequest,
    ) -> Result<(), Failure>;

    /// `console.warn(prefix, detail)`
    fn warn(&self, prefix: &str, detail: &str);
    /// `migrateSheetsLegacyRecovery()`
    fn migrate_sheets_legacy_recovery(&self);
    /// `setImmediate(() => deps.afterSheetsOpen())`
    fn after_sheets_open_soon(&self);
    /// `setMarkdownRecoveryTitleSource(titleOf)`, `setHtmlRecoveryTitleSource`,
    /// `setMindmapRecoveryTitleHook`, `setDiagramRecoveryTitleHook`
    fn set_recovery_title_source(&self, editor: &str);
    /// `setHwpRecoveryTitle(contents, title)`
    fn set_hwp_recovery_title(&self, contents: &Self::Contents, title: &str);
}

/// `plannedUntitled`: untitled-copy identities of restored tabs, by tab id,
/// until their editor answers itself
#[derive(Debug, Default)]
pub struct RecoveryShell {
    planned_untitled: HashMap<String, RecoveryUntitledIdentity>,
}

/// `PlannedOpen`
#[derive(Debug, Clone, PartialEq)]
pub enum PlannedOpen {
    /// the tab's file as a plain open
    File,
    /// a copy opened as an untitled document
    UntitledCopy {
        copy: RecoveryIdentity,
        save_as_default_path: Option<String>,
    },
}

/// `PlannedTab`: one document tab the launch puts in the strip, unloaded
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedTab {
    pub key: String,
    pub kind: String,
    pub title: String,
    pub file_path: Option<String>,
    pub open: PlannedOpen,
}

/// `PlannedSplit`
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedSplit {
    pub a: String,
    pub b: String,
    pub orientation: String,
    pub ratio: f64,
    /// 'a' or 'b'
    pub focus: String,
}

/// `LaunchPlan`: the fields recovery-shell.ts reads
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchPlan {
    pub restore_run: bool,
    pub plain_launch: bool,
    pub tabs: Vec<PlannedTab>,
    /// the launch list's rows; empty = no list
    pub items: Vec<Value>,
}

/// `LaunchOutcome`
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchOutcome {
    pub store_decisions: Vec<(RecoveryIdentity, RecoveryLaunchDecision)>,
    pub remove: Vec<String>,
    pub replace: Vec<PlannedTab>,
    pub append: Vec<PlannedTab>,
    pub front: Option<String>,
    pub split: Option<PlannedSplit>,
    pub launch_paths: Vec<String>,
    pub split_memory_or_home: bool,
}

/// launch-recovery.ts, as far as the launch flow calls it
pub trait LaunchPlanner {
    /// `planLaunch({ judgment, previous, copies, launchPaths })`
    fn plan_launch(
        &self,
        judgment: &PreviousExitJudgment,
        previous: &SessionRecordReadResult,
        copies: &RecoveryStore<'_>,
        launch_paths: &[String],
    ) -> Result<LaunchPlan, Failure>;
    /// `resolveLaunchDecisions(plan, result)`; `result` is `None` for no list
    fn resolve_launch_decisions(&self, plan: &LaunchPlan, result: Option<&Value>) -> LaunchOutcome;
}

/// `UnloadedTabSpec`'s `opener`
#[derive(Debug, Clone, PartialEq)]
pub enum RestoredTabOpener {
    UntitledCopy {
        copy: RecoveryIdentity,
        save_as_default_path: Option<String>,
    },
    File,
}

/// `UnloadedTabSpec`
#[derive(Debug, Clone, PartialEq)]
pub struct UnloadedTabSpec {
    pub kind: String,
    pub title: String,
    pub file_path: Option<String>,
    pub opener: RestoredTabOpener,
}

/// `RestoredTabOpenerDeps`
pub trait RestoredTabOpenerDeps {
    /// the launch list is not answered yet: nothing may load
    fn blocked(&self) -> bool;
}

/// the context the opener is called with (`UnloadedTabOpenContext`)
#[derive(Debug, Clone, PartialEq)]
pub struct OpenContext {
    pub kind: String,
    pub title: String,
    pub file_path: Option<String>,
}

/// a tab of `manager.list()`
#[derive(Debug, Clone, PartialEq)]
pub struct ListedTab {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub file_path: Option<String>,
}

/// the part of the `TabManager` this module drives
pub trait LaunchManager {
    type Contents;
    /// every method that changes the strip may throw
    fn add_unloaded_tab(&mut self, spec: UnloadedTabSpec) -> Result<String, Failure>;
    fn activate_tab(&mut self, id: &str) -> Result<(), Failure>;
    fn hydrate_session(&mut self, tabs: Vec<UnloadedTabSpec>) -> Result<Vec<String>, Failure>;
    fn close_tab_without_prompt(&mut self, id: &str) -> Result<(), Failure>;
    fn list(&self) -> Vec<ListedTab>;
    fn reorder_tab(&mut self, id: &str, slot: usize) -> Result<(), Failure>;
    fn begin_split(
        &mut self,
        a: &str,
        b: &str,
        orientation: &str,
        ratio: f64,
        focus: &str,
    ) -> Result<(), Failure>;
    /// `manager.splitState()` is set
    fn split_state(&self) -> bool;
    fn open_home_tab(&mut self) -> Result<(), Failure>;
    fn web_contents_for_tab(&self, id: &str) -> Option<Self::Contents>;
}

/// `LaunchRecoveryDeps`; the gate's methods are here too
pub trait LaunchDeps {
    type Manager: LaunchManager;
    /// `deps.gate.blocking()`
    fn gate_blocking(&self) -> bool;
    /// `deps.gate.publishNone()`
    fn gate_publish_none(&mut self);
    /// `deps.gate.publish(items, apply)`: the answer comes to [`PendingLaunchList::answer`]
    fn gate_publish(&mut self, items: &[Value]);
    /// `deps.manager()`
    fn manager(&mut self) -> &mut Self::Manager;
    fn user_data_dir(&self) -> String;
    fn launch_paths(&self) -> Vec<String>;
    /// `deps.openLaunchPaths(paths)`; an `Err` is a throw
    fn open_launch_paths(&mut self, paths: &[String]) -> Result<(), Failure>;
    /// an `Err` is a throw
    fn restore_split_memory_or_home(&mut self) -> Result<(), Failure>;
    /// `deps.settled()`; an `Err` is a throw
    fn settled(&mut self) -> Result<(), Failure>;
    /// `deps.sessionChanged()`; an `Err` is a throw
    fn session_changed(&mut self) -> Result<(), Failure>;
    /// `deps.reopenedByInstaller === true`
    fn reopened_by_installer(&self) -> bool;
}

/// `asSessionCopy`
fn as_session_copy(identity: &RecoveryUntitledIdentity) -> SessionUntitledCopy {
    SessionUntitledCopy {
        untitled_id: identity.untitled_id.clone(),
        ext: identity.ext.clone(),
    }
}

/// `editorRecoveryIdentity`: the copy a tab's editor writes (its file's or its
/// untitled slot); `None` when it does not say
pub fn editor_recovery_identity<E: RecoveryEditors>(
    editors: &E,
    kind: &str,
    contents: &E::Contents,
) -> Option<RecoveryIdentity> {
    if contents.is_destroyed() {
        return None;
    }
    let answer = match kind {
        "docs" => editors.docs_recovery_identity(contents.id()),
        "sheets" => editors.sheets_recovery_identity(contents.id()),
        "pdf" => editors.pdf_recovery_identity(contents.id()),
        "markdown" => editors.markdown_recovery_identity(contents.id()),
        "html" => editors.html_recovery_identity(contents.id()),
        "mindmap" => editors.mindmap_recovery_identity(contents.id()),
        "hwp" => editors.hwp_recovery_identity(contents),
        "slides" => editors.slides_recovery_identity(contents.id()),
        "diagram" => editors.diagram_recovery_identity(contents.id()),
        _ => Ok(None),
    };
    answer.unwrap_or(None)
}

impl RecoveryShell {
    pub fn new() -> Self {
        Self::default()
    }

    /// `tabUntitledCopy`: the untitled copy a tab stands for in the session record
    pub fn tab_untitled_copy<E: RecoveryEditors>(
        &self,
        editors: &E,
        tab_id: &str,
        tab_file_path: Option<&str>,
        kind: &str,
        contents: Option<&E::Contents>,
    ) -> Option<SessionUntitledCopy> {
        if let Some(contents) = contents
            && !contents.is_destroyed()
            && let Some(identity) = editor_recovery_identity(editors, kind, contents)
        {
            return match &identity {
                RecoveryIdentity::Untitled(untitled) => Some(as_session_copy(untitled)),
                RecoveryIdentity::File(_) => None,
            };
        }
        if tab_file_path.is_some_and(|p| !p.is_empty()) {
            return None;
        }
        self.planned_untitled.get(tab_id).map(as_session_copy)
    }

    /// `crashedUntitledCopy`: the untitled copy to reopen a crashed tab from,
    /// only an untitled document whose copy is on disk
    pub fn crashed_untitled_copy<E: RecoveryEditors>(
        &self,
        store: &RecoveryStore<'_>,
        editors: &E,
        tab_id: Option<&str>,
        tab_kind: &str,
        tab_file_path: Option<&str>,
        contents: &E::Contents,
    ) -> Result<Option<RecoveryUntitledIdentity>, NodeError> {
        if tab_kind == "home" || tab_kind == "help" {
            return Ok(None);
        }
        let mut identity = editor_recovery_identity(editors, tab_kind, contents);
        if identity.is_none()
            && !tab_file_path.is_some_and(|p| !p.is_empty())
            && let Some(id) = tab_id.filter(|id| !id.is_empty())
        {
            identity = self
                .planned_untitled
                .get(id)
                .cloned()
                .map(RecoveryIdentity::Untitled);
        }
        let Some(RecoveryIdentity::Untitled(untitled)) = identity else {
            return Ok(None);
        };
        let identity = RecoveryIdentity::Untitled(untitled.clone());
        Ok(store.copy_info(&identity)?.map(|_| untitled))
    }

    /// `notePlanned`
    pub fn note_planned(&mut self, tab_id: &str, planned: &PlannedTab) {
        if let PlannedOpen::UntitledCopy { copy, .. } = &planned.open
            && is_untitled_identity(copy)
            && let RecoveryIdentity::Untitled(untitled) = copy
        {
            self.planned_untitled
                .insert(tab_id.to_owned(), untitled.clone());
        }
    }

    /// `reopenUntitledCopy`: reopen an untitled document from its copy in a new tab
    pub fn reopen_untitled_copy<M: LaunchManager>(
        &mut self,
        manager: &mut M,
        kind: &str,
        title: &str,
        copy: &RecoveryUntitledIdentity,
    ) -> Result<(), Failure> {
        let planned = PlannedTab {
            key: "crash".to_owned(),
            kind: kind.to_owned(),
            title: title.to_owned(),
            open: PlannedOpen::UntitledCopy {
                copy: RecoveryIdentity::Untitled(copy.clone()),
                save_as_default_path: None,
            },
            file_path: None,
        };
        let id = manager.add_unloaded_tab(tab_spec(&planned))?;
        self.note_planned(&id, &planned);
        manager.activate_tab(&id)
    }
}

/// `createUntitledEditorView`: a fresh editor view with no document, to load an
/// untitled copy into
fn create_untitled_editor_view<E: RecoveryEditors>(
    editors: &E,
    kind: &str,
) -> Result<E::View, Failure> {
    if kind == "pdf" {
        return editors.create_pdf_view();
    }
    if kind == "sheets" {
        return editors.create_sheets_view(false, true);
    }
    editors.create_plain_editor_view(kind, None)
}

/// `openUntitledCopyView`: a new editor view with a copy queued as an untitled
/// document; the contract runs in the same tick as the view is made
pub fn open_untitled_copy_view<E: RecoveryEditors>(
    editors: &E,
    kind: &str,
    request: &RecoveryOpenUntitledRequest,
) -> Result<E::View, Failure> {
    let has_contract = is_recovery_editor_kind(kind) && editors.has_recovery_editor(kind);
    if !has_contract {
        return Err(Failure(format!(
            "the {kind} editor cannot open a recovery copy"
        )));
    }
    let view = create_untitled_editor_view(editors, kind)?;
    if let Err(error) = editors.open_untitled_copy(kind, &view, request) {
        editors.warn("[recovery] the copy could not be opened:", &error.0);
    }
    Ok(view)
}

/// `restoredTabOpener`
pub fn restored_tab_opener(planned: &PlannedTab) -> RestoredTabOpener {
    match &planned.open {
        PlannedOpen::UntitledCopy {
            copy,
            save_as_default_path,
        } => RestoredTabOpener::UntitledCopy {
            copy: copy.clone(),
            save_as_default_path: save_as_default_path.clone(),
        },
        PlannedOpen::File => RestoredTabOpener::File,
    }
}

impl RestoredTabOpener {
    /// `opener.open(context)`: the view the tab loads through
    pub fn open<E: RecoveryEditors>(
        &self,
        editors: &E,
        deps: &dyn RestoredTabOpenerDeps,
        context: &OpenContext,
    ) -> Result<E::View, Failure> {
        const NOT_ANSWERED: &str = "the launch recovery list is not answered yet";
        match self {
            RestoredTabOpener::UntitledCopy {
                copy,
                save_as_default_path,
            } => {
                if deps.blocked() {
                    return Err(Failure(NOT_ANSWERED.to_owned()));
                }
                open_untitled_copy_view(
                    editors,
                    &context.kind,
                    &RecoveryOpenUntitledRequest {
                        copy: copy.clone(),
                        title: context.title.clone(),
                        save_as_default_path: save_as_default_path
                            .clone()
                            .filter(|path| !path.is_empty()),
                    },
                )
            }
            RestoredTabOpener::File => {
                if deps.blocked() {
                    return Err(Failure(NOT_ANSWERED.to_owned()));
                }
                let view = editors
                    .create_plain_editor_view(&context.kind, context.file_path.as_deref())?;
                if context.kind == "sheets" {
                    editors.after_sheets_open_soon();
                }
                Ok(view)
            }
        }
    }

    /// `opener.needsUser(context)`: opening the document has to ask the user
    /// the per-file recovery question first
    pub fn needs_user(
        &self,
        store: &RecoveryStore<'_>,
        deps: &dyn RestoredTabOpenerDeps,
        context: &OpenContext,
    ) -> bool {
        match self {
            RestoredTabOpener::UntitledCopy { .. } => deps.blocked(),
            RestoredTabOpener::File => {
                if deps.blocked() {
                    return true;
                }
                let Some(path) = context.file_path.as_deref().filter(|p| !p.is_empty()) else {
                    return false;
                };
                if !is_recovery_editor_kind(&context.kind) {
                    return false;
                }
                let identity = RecoveryIdentity::File(RecoveryFileIdentity {
                    kind: context.kind.clone(),
                    file_path: path.to_owned(),
                });
                // an unsettled copy of the file asks the user first (5.4)
                matches!(store.open_plan(&identity), Ok(RecoveryOpenPlan::Ask(_)))
            }
        }
    }
}

/// `tabSpec`
pub fn tab_spec(planned: &PlannedTab) -> UnloadedTabSpec {
    UnloadedTabSpec {
        kind: planned.kind.clone(),
        title: planned.title.clone(),
        file_path: planned.file_path.clone().filter(|p| !p.is_empty()),
        opener: restored_tab_opener(planned),
    }
}

/// `discardEditorRecovery`: the editors' own "Don't Save" for their copy when
/// MCP / AI closes a tab without saving
pub fn discard_editor_recovery<E: RecoveryEditors>(
    editors: &E,
    kind: &str,
    contents: &E::Contents,
) {
    if contents.is_destroyed() {
        return;
    }
    match kind {
        "docs" => editors.discard_docs_recovery(contents),
        "sheets" => editors.discard_sheets_recovery(contents),
        "pdf" => editors.discard_pdf_recovery(contents),
        "mindmap" => editors.discard_mindmap_recovery(contents),
        "hwp" => editors.hwp_discard_recovery_copy(contents),
        "diagram" => editors.discard_diagram_recovery(contents),
        _ => {}
    }
}

/// the editors `installRecoveryTitleSources` gives the title lookup to, in order
pub const RECOVERY_TITLE_SOURCES: [&str; 4] = ["markdown", "html", "mindmap", "diagram"];

/// `installRecoveryTitleSources`: the untitled documents' copies are listed
/// under their real tab titles
pub fn install_recovery_title_sources<E: RecoveryEditors>(editors: &E) {
    for editor in RECOVERY_TITLE_SOURCES {
        editors.set_recovery_title_source(editor);
    }
}

/// `pushHwpRecoveryTitles`: hwp is told its untitled tabs' titles (it does not ask)
pub fn push_hwp_recovery_titles<E, M>(editors: &E, manager: &M)
where
    E: RecoveryEditors,
    M: LaunchManager<Contents = E::Contents>,
{
    for tab in manager.list() {
        if tab.kind != "hwp" || tab.file_path.as_deref().is_some_and(|p| !p.is_empty()) {
            continue;
        }
        if let Some(contents) = manager.web_contents_for_tab(&tab.id)
            && !contents.is_destroyed()
        {
            editors.set_hwp_recovery_title(&contents, &tab.title);
        }
    }
}

/// the launch list is up: [`PendingLaunchList::answer`] is the callback the
/// gate runs with the person's answer
pub struct PendingLaunchList {
    plan: LaunchPlan,
    ids: HashMap<String, String>,
}

/// `runLaunchRecovery`: the whole launch (spec 4, 5.1, 5.2, 5.3, 6). `None`
/// once the launch settled; `Some` while it waits for the launch list.
#[allow(clippy::too_many_arguments)]
pub fn run_launch_recovery<E, D, P>(
    shell: &mut RecoveryShell,
    editors: &E,
    planner: &P,
    store: &RecoveryStore<'_>,
    session: &mut SessionRecordProcess,
    session_env: &mut dyn SessionRecorderEnv,
    deps: &mut D,
) -> Result<Option<PendingLaunchList>, Failure>
where
    E: RecoveryEditors,
    D: LaunchDeps + RestoredTabOpenerDeps,
    P: LaunchPlanner,
{
    let launch_paths = deps.launch_paths();
    // pruneStaleCopies answers a count and never throws
    store.prune_stale_copies(None);
    editors.migrate_sheets_legacy_recovery();

    let mut ids: HashMap<String, String> = HashMap::new();
    let plan: Option<LaunchPlan> = (|| -> Result<LaunchPlan, Failure> {
        let recorder = session.init_session_record(&SessionRecorderOptions {
            user_data_dir: deps.user_data_dir(),
            write_delay_ms: None,
            crash_loop_window_ms: None,
        });
        let mut unresolved_error: Option<NodeError> = None;
        let judgment = judge_previous_exit(
            &recorder.previous,
            &mut || match store.has_unresolved_copies() {
                Ok(unresolved) => unresolved,
                Err(e) => {
                    unresolved_error = Some(e);
                    false
                }
            },
            deps.reopened_by_installer(),
        );
        if let Some(e) = unresolved_error {
            return Err(Failure(e.message));
        }
        let plan = planner.plan_launch(&judgment, &recorder.previous, store, &launch_paths)?;
        recorder.start_run(session_env, plan.restore_run);
        if !plan.plain_launch {
            let tabs = plan.tabs.clone();
            let tab_ids = deps
                .manager()
                .hydrate_session(tabs.iter().map(tab_spec).collect())?;
            for (index, tab) in tabs.iter().enumerate() {
                if let Some(id) = tab_ids.get(index) {
                    ids.insert(tab.key.clone(), id.clone());
                }
            }
            for (index, tab) in tabs.iter().enumerate() {
                if let Some(id) = tab_ids.get(index) {
                    shell.note_planned(id, tab);
                }
            }
            // the strip's change notice went out before the untitled copies were noted
            if let Err(error) = deps.session_changed() {
                editors.warn(
                    "[recovery] the session record could not be updated:",
                    &error.0,
                );
            }
        }
        Ok(plan)
    })()
    .map_err(|error| {
        editors.warn(
            "[recovery] the launch could not restore the previous session:",
            &error.0,
        );
    })
    .ok();

    let Some(plan) = plan.filter(|plan| !plan.plain_launch) else {
        deps.gate_publish_none();
        if !launch_paths.is_empty() {
            deps.open_launch_paths(&launch_paths)?;
        } else {
            deps.restore_split_memory_or_home()?;
        }
        deps.settled()?;
        return Ok(None);
    };

    if plan.items.is_empty() {
        deps.gate_publish_none();
        let outcome = planner.resolve_launch_decisions(&plan, None);
        finish_launch(shell, editors, deps, &mut ids, &outcome);
        return Ok(None);
    }
    // Home stays in front while the list is up: an editor view would cover it,
    // and what a restored tab loads depends on the answer
    deps.manager().open_home_tab()?;
    deps.gate_publish(&plan.items);
    Ok(Some(PendingLaunchList { plan, ids }))
}

impl PendingLaunchList {
    /// the gate's `apply(result)` callback
    pub fn answer<E, D, P>(
        mut self,
        shell: &mut RecoveryShell,
        editors: &E,
        planner: &P,
        store: &RecoveryStore<'_>,
        deps: &mut D,
        result: &Value,
    ) where
        E: RecoveryEditors,
        D: LaunchDeps + RestoredTabOpenerDeps,
        P: LaunchPlanner,
    {
        let outcome = planner.resolve_launch_decisions(&self.plan, Some(result));
        for (identity, decision) in &outcome.store_decisions {
            if let Err(error) = store.apply_launch_decision(identity, *decision) {
                editors.warn(
                    "[recovery] a launch decision could not be recorded:",
                    &error.message,
                );
            }
        }
        finish_launch(shell, editors, deps, &mut self.ids, &outcome);
    }
}

/// `finish`: carry out the outcome. A failure while laying out the tabs never
/// escapes: Home comes to the front and the launch settles anyway.
fn finish_launch<E, D>(
    shell: &mut RecoveryShell,
    editors: &E,
    deps: &mut D,
    ids: &mut HashMap<String, String>,
    outcome: &LaunchOutcome,
) where
    E: RecoveryEditors,
    D: LaunchDeps + RestoredTabOpenerDeps,
{
    if let Err(error) = lay_out(shell, deps, ids, outcome) {
        editors.warn(
            "[recovery] the restored session could not be laid out:",
            &error.0,
        );
        if let Err(home_error) = deps.manager().open_home_tab() {
            editors.warn("[recovery] Home could not be shown:", &home_error.0);
        }
    }
    if let Err(error) = deps.settled() {
        editors.warn(
            "[recovery] the files that arrived during the launch could not open:",
            &error.0,
        );
    }
}

/// `layOut`
fn lay_out<D>(
    shell: &mut RecoveryShell,
    deps: &mut D,
    ids: &mut HashMap<String, String>,
    outcome: &LaunchOutcome,
) -> Result<(), Failure>
where
    D: LaunchDeps + RestoredTabOpenerDeps,
{
    for key in &outcome.remove {
        if let Some(id) = ids.get(key).filter(|id| !id.is_empty()).cloned() {
            deps.manager().close_tab_without_prompt(&id)?;
        }
        ids.remove(key);
    }
    for planned in &outcome.replace {
        let old_id = ids.get(&planned.key).cloned();
        let manager = deps.manager();
        let slot = manager
            .list()
            .iter()
            .position(|tab| Some(&tab.id) == old_id.as_ref());
        let new_id = manager.add_unloaded_tab(tab_spec(planned))?;
        shell.note_planned(&new_id, planned);
        if let Some(slot) = slot.filter(|slot| *slot > 0) {
            manager.reorder_tab(&new_id, slot)?;
        }
        if let Some(old_id) = old_id.filter(|id| !id.is_empty()) {
            manager.close_tab_without_prompt(&old_id)?;
        }
        ids.insert(planned.key.clone(), new_id);
    }
    for planned in &outcome.append {
        let id = deps.manager().add_unloaded_tab(tab_spec(planned))?;
        shell.note_planned(&id, planned);
        ids.insert(planned.key.clone(), id);
    }
    let front = outcome
        .front
        .as_ref()
        .and_then(|key| ids.get(key))
        .filter(|id| !id.is_empty())
        .cloned();
    let split = outcome.split.as_ref();
    let a = split
        .and_then(|s| ids.get(&s.a))
        .filter(|id| !id.is_empty())
        .cloned();
    let b = split
        .and_then(|s| ids.get(&s.b))
        .filter(|id| !id.is_empty())
        .cloned();
    if let (Some(split), Some(a), Some(b)) = (split, a, b) {
        let focus = if outcome.front.as_deref() == Some(split.a.as_str()) {
            "a"
        } else if outcome.front.as_deref() == Some(split.b.as_str()) {
            "b"
        } else {
            split.focus.as_str()
        };
        deps.manager()
            .begin_split(&a, &b, &split.orientation, split.ratio, focus)?;
    }
    if !deps.manager().split_state()
        && let Some(front) = &front
    {
        deps.manager().activate_tab(front)?;
    }
    if !outcome.launch_paths.is_empty() {
        deps.open_launch_paths(&outcome.launch_paths)?;
    } else if outcome.split_memory_or_home {
        deps.restore_split_memory_or_home()?;
    } else if front.is_none() && !deps.manager().split_state() {
        deps.manager().open_home_tab()?;
    }
    Ok(())
}
