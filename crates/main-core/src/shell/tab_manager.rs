//! `apps/shell/src/main/tab-manager.ts`: the tab list of the shell window and
//! every decision around it (which tab is active, the two-pane split, which
//! view is visible and where, unloaded tabs, the close flow, detach and
//! attach, find by path).
//!
//! The Electron objects stay with the caller. A view of the shell window is
//! the caller's handle `V` (`WebContentsView`); everything the TypeScript
//! calls on the window, on a view, on its `webContents` or in an editor's main
//! module is one method of [`TabHost`], called in the order the TypeScript
//! calls it. Promises are plain calls, except an `await` on a renderer's reply
//! (`docsQueryDirty`, a family's `requestXClose`, an opener's `needsUser`, a
//! document's `ready`): the reply arrives on the thread that would block, so
//! such a flow returns a step the caller carries out and answers with a
//! `resume_*` method ([`TabCloseStep`], [`OpenDocumentsStep`], [`EnsureStep`]).
//! The three timers of the TypeScript are
//! steps the caller drives: the spare Sheets view timer
//! ([`TabManager::fire_spare_sheets_timer`]) and the two `setImmediate`
//! layouts ([`TabManager::run_deferred`]). The window and view events are
//! methods too (`on_window_resize`, `on_enter_html_full_screen`, ...), called
//! by the adapter that registered the listener the host was asked to install.

use jscompat::node_path::host::basename;
use jscompat::{js_regex, math_max, math_min, math_round, text_decoder_decode, truthy};
use serde_json::{Map, Value};

use super::split_layout::{
    OppositeTab, Pane, Rect, SPLIT_EVEN_RATIO, SplitActivationMode, SplitDropIntent,
    SplitOrientation, activation_mode, clamp_split_ratio, opposite_document_id, pane_rects,
    split_survivor,
};
use crate::node_fs::namespaced;
use crate::packages::electron_utils::renderer_scheme::{RendererUrlError, renderer_url};
use crate::packages::electron_utils::safe_external_url::safe_external_url;
use crate::packages::i18n::PRODUCT_NAME;

const HOME_ID: &str = "home";

/// `TAB_STRIP_HEIGHT` of `shared/tab-drag-geometry.ts`
const TAB_STRIP_HEIGHT: f64 = 40.0;

/// `tabStripHeight`: the strip's rendered height at an interface scale
pub fn tab_strip_height(scale: f64) -> f64 {
    math_round(TAB_STRIP_HEIGHT * scale)
}

/// `isSettledRect`: finite coordinates, positive size
pub fn is_settled_rect(rect: &Rect) -> bool {
    rect.x.is_finite()
        && rect.y.is_finite()
        && rect.width.is_finite()
        && rect.height.is_finite()
        && rect.width > 0.0
        && rect.height > 0.0
}

/// `TabKind`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabKind {
    Home,
    Docs,
    Sheets,
    Slides,
    Pdf,
    Markdown,
    Html,
    Mindmap,
    Hwp,
    Epub,
    Diagram,
    Help,
}

impl TabKind {
    /// the TypeScript's string
    pub fn as_str(self) -> &'static str {
        match self {
            TabKind::Home => "home",
            TabKind::Docs => "docs",
            TabKind::Sheets => "sheets",
            TabKind::Slides => "slides",
            TabKind::Pdf => "pdf",
            TabKind::Markdown => "markdown",
            TabKind::Html => "html",
            TabKind::Mindmap => "mindmap",
            TabKind::Hwp => "hwp",
            TabKind::Epub => "epub",
            TabKind::Diagram => "diagram",
            TabKind::Help => "help",
        }
    }

    /// the kind a string names, `None` for anything else
    pub fn parse(text: &str) -> Option<TabKind> {
        Some(match text {
            "home" => TabKind::Home,
            "docs" => TabKind::Docs,
            "sheets" => TabKind::Sheets,
            "slides" => TabKind::Slides,
            "pdf" => TabKind::Pdf,
            "markdown" => TabKind::Markdown,
            "html" => TabKind::Html,
            "mindmap" => TabKind::Mindmap,
            "hwp" => TabKind::Hwp,
            "epub" => TabKind::Epub,
            "diagram" => TabKind::Diagram,
            "help" => TabKind::Help,
            _ => return None,
        })
    }
}

/// The `Error` the TypeScript throws, by its message.
#[derive(Debug, Clone, PartialEq)]
pub struct TabError(pub String);

impl From<RendererUrlError> for TabError {
    fn from(error: RendererUrlError) -> TabError {
        TabError(error.0)
    }
}

pub type TabResult<T> = Result<T, TabError>;

/// `SplitViewState`
#[derive(Debug, Clone, PartialEq)]
pub struct SplitViewState {
    pub a_tab_id: String,
    pub b_tab_id: String,
    pub orientation: SplitOrientation,
    pub ratio: f64,
    pub focus: Pane,
}

fn num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

impl SplitViewState {
    /// `{ aTabId, bTabId, orientation, ratio, focus }`
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("aTabId".into(), Value::from(self.a_tab_id.as_str()));
        map.insert("bTabId".into(), Value::from(self.b_tab_id.as_str()));
        map.insert("orientation".into(), Value::from(self.orientation.as_str()));
        map.insert("ratio".into(), num(self.ratio));
        map.insert("focus".into(), Value::from(self.focus.as_str()));
        Value::Object(map)
    }
}

/// `SplitPaneRole`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitPaneRole {
    Focus,
    Secondary,
}

impl SplitPaneRole {
    pub fn as_str(self) -> &'static str {
        match self {
            SplitPaneRole::Focus => "focus",
            SplitPaneRole::Secondary => "secondary",
        }
    }
}

/// `TabSummary`
#[derive(Debug, Clone, PartialEq)]
pub struct TabSummary {
    pub id: String,
    pub kind: TabKind,
    pub title: String,
    pub closable: bool,
    pub active: bool,
    pub file_path: Option<String>,
}

impl TabSummary {
    /// `{ id, kind, title, closable, active, filePath? }`
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("id".into(), Value::from(self.id.as_str()));
        map.insert("kind".into(), Value::from(self.kind.as_str()));
        map.insert("title".into(), Value::from(self.title.as_str()));
        map.insert("closable".into(), Value::Bool(self.closable));
        map.insert("active".into(), Value::Bool(self.active));
        if let Some(path) = &self.file_path {
            map.insert("filePath".into(), Value::from(path.as_str()));
        }
        Value::Object(map)
    }
}

/// `OpenDocumentTab`
#[derive(Debug, Clone, PartialEq)]
pub struct OpenDocumentTab {
    pub id: String,
    pub kind: TabKind,
    pub title: String,
    pub file_path: Option<String>,
    pub active: bool,
    pub dirty: bool,
}

impl OpenDocumentTab {
    /// `{ id, kind, title, filePath?, active, dirty }`
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("id".into(), Value::from(self.id.as_str()));
        map.insert("kind".into(), Value::from(self.kind.as_str()));
        map.insert("title".into(), Value::from(self.title.as_str()));
        if let Some(path) = &self.file_path {
            map.insert("filePath".into(), Value::from(path.as_str()));
        }
        map.insert("active".into(), Value::Bool(self.active));
        map.insert("dirty".into(), Value::Bool(self.dirty));
        Value::Object(map)
    }
}

/// One tab of `SessionStripState.tabs`
#[derive(Debug, Clone, PartialEq)]
pub struct SessionStripTab {
    pub id: String,
    pub kind: TabKind,
    pub title: String,
    pub file_path: Option<String>,
}

/// `SessionStripState`: `TabManager.sessionTabs()`
#[derive(Debug, Clone, PartialEq)]
pub struct SessionStripState {
    pub tabs: Vec<SessionStripTab>,
    pub active_id: String,
    pub split: Option<SplitViewState>,
}

impl SessionStripState {
    /// `{ tabs: [{ id, kind, title, filePath? }], activeId, split }`
    pub fn to_value(&self) -> Value {
        let tabs = self
            .tabs
            .iter()
            .map(|t| {
                let mut map = Map::new();
                map.insert("id".into(), Value::from(t.id.as_str()));
                map.insert("kind".into(), Value::from(t.kind.as_str()));
                map.insert("title".into(), Value::from(t.title.as_str()));
                if let Some(path) = &t.file_path {
                    map.insert("filePath".into(), Value::from(path.as_str()));
                }
                Value::Object(map)
            })
            .collect();
        let mut map = Map::new();
        map.insert("tabs".into(), Value::Array(tabs));
        map.insert("activeId".into(), Value::from(self.active_id.as_str()));
        map.insert(
            "split".into(),
            self.split.as_ref().map_or(Value::Null, |s| s.to_value()),
        );
        Value::Object(map)
    }
}

/// `DetachedTab`: a tab lifted out of the strip with its live view
#[derive(Debug, Clone, PartialEq)]
pub struct DetachedTab<V> {
    pub view: V,
    pub kind: TabKind,
    pub title: String,
    pub file_path: Option<String>,
}

/// A tab with a live view as the lookups hand it out: the TypeScript's
/// `{ id, kind, webContents, filePath? }` with the view in place of its
/// `webContents`.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveTab<V> {
    pub id: String,
    pub kind: TabKind,
    pub view: V,
    pub file_path: Option<String>,
}

/// `UnloadedTabOpener`, as the caller knows it: the host runs `open` and
/// `needsUser` (`has_needs_user` says the TypeScript's opener has one).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Opener {
    pub id: u64,
    pub has_needs_user: bool,
}

/// What settles when a document is ready (`LoadedTabView.ready`, or the page
/// load of the view); the host hands one out and awaits it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ready(pub u64);

/// `UnloadedTabOpenContext`
#[derive(Debug, Clone, PartialEq)]
pub struct UnloadedTabOpenContext {
    pub tab_id: String,
    pub kind: TabKind,
    pub title: String,
    pub file_path: Option<String>,
}

impl UnloadedTabOpenContext {
    /// `{ tabId, kind, title, filePath? }`
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("tabId".into(), Value::from(self.tab_id.as_str()));
        map.insert("kind".into(), Value::from(self.kind.as_str()));
        map.insert("title".into(), Value::from(self.title.as_str()));
        if let Some(path) = &self.file_path {
            map.insert("filePath".into(), Value::from(path.as_str()));
        }
        Value::Object(map)
    }
}

/// `LoadedTabView`: `ready` is `None` where the opener gave none (the page
/// load of the view counts then)
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedTabView<V> {
    pub view: V,
    pub ready: Option<Ready>,
}

/// `UnloadedTabSpec`
#[derive(Debug, Clone, PartialEq)]
pub struct UnloadedTabSpec {
    pub kind: TabKind,
    pub title: Option<String>,
    pub file_path: Option<String>,
    pub opener: Opener,
}

/// `RestoredSession.split`; the indices are JavaScript numbers
#[derive(Debug, Clone, PartialEq)]
pub struct RestoredSplit {
    pub a: f64,
    pub b: f64,
    pub orientation: SplitOrientation,
    pub ratio: f64,
    pub focus: Pane,
}

/// `RestoredSession`
#[derive(Debug, Clone, PartialEq)]
pub struct RestoredSession {
    pub tabs: Vec<UnloadedTabSpec>,
    pub active: Option<f64>,
    pub split: Option<RestoredSplit>,
}

/// `TabLoadResult`
#[derive(Debug, Clone, PartialEq)]
pub enum TabLoadResult<V> {
    Ready(V),
    NeedsUser,
    Missing,
}

/// `DiagramTabIdentity` as `openDiagramTab` and `findDiagramTabByPath` read it
#[derive(Debug, Clone, PartialEq)]
pub struct DiagramIdentity {
    /// `identity.imported !== undefined`
    pub imported: bool,
    pub title: String,
    pub source_path: Option<String>,
}

/// `createHwpView`'s `untitledCopy` option
#[derive(Debug, Clone, PartialEq)]
pub enum HwpUntitledCopy {
    /// `!!copy`
    Flag(bool),
    /// `{ baseName }` of an imported PDF
    BaseName(String),
}

/// The editor view a `create*View` call makes, with the arguments the
/// TypeScript passes.
#[derive(Debug, Clone, PartialEq)]
pub enum ViewSpec<'a> {
    Docs {
        path: Option<&'a str>,
    },
    /// `createSheetsView({ includeAiHandlers: false, openingWorkbook? })`
    Sheets {
        opening_workbook: Option<bool>,
    },
    Slides {
        path: Option<&'a str>,
    },
    Pdf {
        path: &'a str,
    },
    Markdown {
        path: Option<&'a str>,
    },
    Html {
        path: Option<&'a str>,
    },
    HtmlPresent {
        owner: i64,
        title: &'a str,
    },
    Mindmap {
        path: Option<&'a str>,
    },
    Epub {
        path: &'a str,
    },
    Diagram {
        path: Option<&'a str>,
    },
    Hwp {
        path: Option<&'a str>,
        untitled_copy: HwpUntitledCopy,
    },
}

/// A step the TypeScript defers with `setImmediate`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deferred {
    Layout,
    ReconcileAfterWindowRestore,
}

/// What the shell and the detached windows both call on a view, its
/// `webContents` and the editor modules.
pub trait EditorCalls<V> {
    /// `view.webContents.id`
    fn view_id(&mut self, view: &V) -> i64;
    /// `view.webContents.isDestroyed()`
    fn view_destroyed(&mut self, view: &V) -> bool;
    /// `view.setVisible(visible)`
    fn set_visible(&mut self, view: &V, visible: bool);
    /// `view.setBounds(bounds)`
    fn set_bounds(&mut self, view: &V, bounds: &Rect);
    /// `view.webContents.focus()`
    fn focus_view(&mut self, view: &V);
    /// `view.webContents.close()`
    fn close_view(&mut self, view: &V);
    /// `sheetsPendingEditCount(wcId)`
    fn sheets_pending_edit_count(&mut self, wc_id: i64) -> f64;
    /// `pdfIsDirty`, `markdownIsDirty`, `htmlIsDirty`, `hwpIsDirty`,
    /// `slidesIsDirty`, `mindmapIsDirty`, `epubIsDirty` or `diagramIsDirty`
    /// (by `kind`) of the view with this webContents id
    fn family_is_dirty(&mut self, kind: TabKind, wc_id: i64) -> bool;
    /// `hwpMemoModalOpen(wcId)`
    fn hwp_memo_modal_open(&mut self, wc_id: i64) -> bool;
    /// `setActiveDocsResolver(() => view.webContents)`; `None` is `() => null`.
    /// With `null_if_destroyed` the resolver answers null once the view's
    /// `webContents` is destroyed (the detached window's resolver does).
    fn set_active_docs_resolver(&mut self, view: Option<&V>, null_if_destroyed: bool);
    /// `setActiveSheetsWebContents(view.webContents)`; `None` is `null`
    fn set_active_sheets_web_contents(&mut self, view: Option<&V>);
    /// `setActiveSlidesWebContents(view.webContents)`
    fn set_active_slides_web_contents(&mut self, view: &V);
    /// `applyMenuFor(kind)`
    fn apply_menu_for(&mut self, kind: TabKind);
    /// `teardownDocsRenderer(view.webContents)`
    fn teardown_docs_renderer(&mut self, view: &V);
    /// `releaseClosedRenderer(view.webContents)`
    fn release_closed_renderer(&mut self, view: &V);
}

/// What `TabManager` calls: the shell `BrowserWindow`, the views, the
/// callbacks it was given and the editor modules.
pub trait TabHost<V>: EditorCalls<V> {
    // ---- the shell window ----
    /// `shellWindow.isDestroyed()`
    fn window_destroyed(&mut self) -> bool;
    /// `shellWindow.isMinimized()`
    fn window_minimized(&mut self) -> bool;
    /// `shellWindow.isFocused()`
    fn window_focused(&mut self) -> bool;
    /// `shellWindow.getContentBounds()`: `(width, height)`
    fn window_content_size(&mut self) -> (f64, f64);
    /// `shellWindow.contentView.addChildView(view)`
    fn add_child_view(&mut self, view: &V);
    /// `shellWindow.contentView.removeChildView(view)`
    fn remove_child_view(&mut self, view: &V);
    /// `shellWindow.webContents.focus()`
    fn focus_shell_contents(&mut self);

    // ---- views ----
    /// `view.webContents.reload()`
    fn reload_view(&mut self, view: &V);
    /// `void view.webContents.loadURL(url)`
    fn load_url(&mut self, view: &V, url: &str);
    /// installs the `enter-html-full-screen` and `leave-html-full-screen`
    /// listeners (`on_enter_html_full_screen`, `on_leave_html_full_screen`)
    fn listen_html_full_screen(&mut self, view: &V);
    /// installs the `focus` listener (`on_pane_focus`)
    fn listen_pane_focus(&mut self, view: &V);
    /// `view.webContents.once('render-process-gone', ...)`
    /// (`on_spare_render_process_gone`)
    fn once_render_process_gone(&mut self, view: &V);
    /// `pageLoaded(view.webContents)`: the promise that settles on
    /// `did-finish-load` and rejects on `destroyed`
    fn page_loaded(&mut self, view: &V) -> Ready;

    // ---- what the constructor was given ----
    /// `onChanged()`
    fn on_changed(&mut self);
    /// `onSplitChanged?.(state)`
    fn on_split_changed(&mut self, state: Option<&SplitViewState>);
    /// the closed listener: `closedListener?.({ kind, filePath })`
    fn on_tab_closed(&mut self, kind: TabKind, file_path: &str);
    /// `untitledTitleFor?.(kind)`; `None` is `undefined` (or no function)
    fn untitled_title_for(&mut self, kind: TabKind) -> Option<String>;
    /// `uiScale()`
    fn ui_scale(&mut self) -> f64;

    // ---- the environment ----
    /// `process.env.SEUOFFICE_NO_SPARE_VIEW` is truthy
    fn no_spare_view_env(&mut self) -> bool;
    /// `process.env.ELECTRON_RENDERER_URL`
    fn renderer_dev_url(&mut self) -> Option<String>;

    // ---- timers the caller drives ----
    /// `setTimeout(fireSpareSheetsTimer, delay_ms)`
    fn set_spare_timer(&mut self, delay_ms: f64);
    /// `clearTimeout(spareSheetsTimer)`
    fn clear_spare_timer(&mut self);
    /// `setImmediate(step)`
    fn defer(&mut self, step: Deferred);

    // ---- making views ----
    /// the `create*View` call of the spec
    fn create_view(&mut self, spec: &ViewSpec<'_>) -> TabResult<V>;
    /// `new WebContentsView({ webPreferences })` and its
    /// `setWindowOpenHandler` (`help_window_open`): the manual's view before
    /// its page is loaded
    fn create_help_view(&mut self) -> V;

    // ---- queues and marks of the editor modules ----
    /// `markDocsNewBlank(wcId)`
    fn mark_docs_new_blank(&mut self, wc_id: i64);
    /// `queueDocsAiContent(wcId, content)`
    fn queue_docs_ai_content(&mut self, wc_id: i64, content: &Value);
    /// `queueDocsCopy(wcId, { path, name })`
    fn queue_docs_copy(&mut self, wc_id: i64, path: &str, name: &str);
    /// `setSheetsNewBlank()`
    fn set_sheets_new_blank(&mut self);
    /// `queueWorkbookForView(view.webContents, path)`
    fn queue_workbook_for_view(&mut self, view: &V, path: &str);
    /// `nudgeQueuedWorkbook(view.webContents)`
    fn nudge_queued_workbook(&mut self, view: &V);
    /// `markPdfUntitledCopy(path)`
    fn mark_pdf_untitled_copy(&mut self, path: &str);
    /// `clearPdfDirty(wcId)`
    fn clear_pdf_dirty(&mut self, wc_id: i64);
    /// `queueMarkdownSeedFor(contents, text)`
    fn queue_markdown_seed_for(&mut self, view: &V, text: &str);
    /// `queueHtmlSeedFor(contents, text)`
    fn queue_html_seed_for(&mut self, view: &V, text: &str);
    /// `queueMindmapSeedFor(contents, { bytes })`
    fn queue_mindmap_seed_for(&mut self, view: &V, bytes: &[u8]);
    /// `queueSlidesSeedFor(contents, bytes, { askPathOnFirstSave: true, suggestedName })`
    fn queue_slides_seed_for(&mut self, view: &V, bytes: &[u8], suggested_name: &str);
    /// `queueGenerateHandoffFor(contents, handoff)`
    fn queue_generate_handoff_for(&mut self, view: &V, handoff: &Value);
    /// `queueConvertedContent(contents, doc)`
    fn queue_converted_content(&mut self, view: &V, doc: &Value);
    /// `dropGenerateHandoff(wcId)`
    fn drop_generate_handoff(&mut self, wc_id: i64);
    /// `diagramTabIdentity(wcId)`
    fn diagram_tab_identity(&mut self, wc_id: i64) -> Option<DiagramIdentity>;

    // ---- openers of unloaded tabs ----
    /// `opener.open(context)`; `Err` is what it throws
    fn opener_open(
        &mut self,
        opener: &Opener,
        context: &UnloadedTabOpenContext,
    ) -> Result<LoadedTabView<V>, String>;
    /// `console.warn(message, error)`
    fn warn(&mut self, message: &str, error: &str);
}

/// one row of the strip
struct TabRecord<V> {
    id: String,
    kind: TabKind,
    /// `None` for the Home tab and for an unloaded tab until its opener runs
    view: Option<V>,
    title: String,
    file_path: Option<String>,
    present: bool,
    opener: Option<Opener>,
    lazy: Option<LazyLoadState>,
}

/// a tab loaded through its opener, until its document reports ready
struct LazyLoadState {
    ready: Ready,
    settled: bool,
    needs_user: Option<Opener>,
}

/// What a suspended `closeTab` waits for.
enum ClosePhase<V> {
    /// the answer of `docsQueryDirty`
    Query { view: V },
    /// the answer of `requestXClose`
    Prompt,
}

/// What the caller does next for a `closeTab` run. The TypeScript awaits a
/// renderer's reply twice (`docsQueryDirty`, then the family's `requestXClose`);
/// here each await is a step the caller carries out and answers with
/// [`TabManager::resume_close`]. While a step is open, the tab is in
/// `closingIds`: a second close, a detach or a promptless close of it is
/// refused, as in the TypeScript.
#[derive(Debug, Clone, PartialEq)]
pub enum TabCloseStep<V> {
    /// the run ended: the tab is closed, the close was cancelled, or there was
    /// nothing to do
    Done,
    /// `await docsQueryDirty(view.webContents)`: answer with
    /// `resume_close(id, Ok(dirty))`
    QueryDocsDirty { id: String, view: V },
    /// `await requestXClose(view.webContents, shellWindow)` of the family of
    /// `kind`: answer with `resume_close(id, Ok(confirmed))`
    RequestClose { id: String, kind: TabKind, view: V },
    /// the `closeTab` promise rejected with this message (after its `finally`)
    Rejected(String),
}

/// `openDocuments`' run: the tabs of the list with their dirty state so far.
pub struct OpenDocumentsRun<V> {
    entries: Vec<(OpenDocumentTab, TabKind, Option<V>)>,
    at: usize,
}

/// What the caller does next for a run that reads the dirty state of several
/// documents (`openDocuments`, `detachedOpenDocuments`). The documents are
/// asked one after another; `docsQueryDirty` is the only await.
#[derive(Debug, Clone, PartialEq)]
pub enum OpenDocumentsStep<V, K> {
    /// the answer: the list
    Done(Vec<OpenDocumentTab>),
    /// `await docsQueryDirty(view.webContents)`: answer with the resume method
    /// of the run, given `next`
    QueryDocsDirty { view: V, next: K },
    /// the promise rejected with this message
    Rejected(String),
}

/// The dirty state of one document as far as it can be known without
/// waiting.
#[derive(Debug, Clone, PartialEq)]
pub enum DirtyAsk<V> {
    Known(bool),
    /// the docs editor must be asked: `await docsQueryDirty(view.webContents)`
    QueryDocs(V),
}

/// `tabIsDirty` / `detachedIsDirty`: unsaved-changes state of one document,
/// whichever family owns it.
pub fn dirty_ask<V: Clone, H: EditorCalls<V> + ?Sized>(
    host: &mut H,
    kind: TabKind,
    view: Option<&V>,
) -> DirtyAsk<V> {
    let Some(view) = view else {
        return DirtyAsk::Known(false);
    };
    if host.view_destroyed(view) {
        return DirtyAsk::Known(false);
    }
    let wc_id = host.view_id(view);
    match kind {
        TabKind::Sheets => DirtyAsk::Known(host.sheets_pending_edit_count(wc_id) > 0.0),
        TabKind::Docs => DirtyAsk::QueryDocs(view.clone()),
        TabKind::Pdf
        | TabKind::Markdown
        | TabKind::Html
        | TabKind::Hwp
        | TabKind::Slides
        | TabKind::Mindmap
        | TabKind::Epub
        | TabKind::Diagram => DirtyAsk::Known(host.family_is_dirty(kind, wc_id)),
        TabKind::Home | TabKind::Help => DirtyAsk::Known(false),
    }
}

/// What the caller does next for an `ensureTabLoaded` run.
#[derive(Debug, Clone, PartialEq)]
pub enum EnsureStep<V> {
    /// the answer
    Done(TabLoadResult<V>),
    /// `await opener.needsUser(context)`: answer with
    /// `resume_ensure_needs_user(next, Ok(needs_user))`
    NeedsUser {
        opener: Opener,
        context: UnloadedTabOpenContext,
        next: EnsureAfterNeedsUser<V>,
    },
    /// `await lazy.ready` (the opener's `ready`, or the page load): answer with
    /// `resume_ensure_ready(next, Ok(()))` when it resolved or `Err(message)`
    /// when it rejected. Settle it too with [`TabManager::ready_settled`].
    AwaitReady {
        ready: Ready,
        next: EnsureAfterReady<V>,
    },
    /// the `ensureTabLoaded` promise rejected with this message
    Rejected(String),
}

#[derive(Debug, Clone, PartialEq)]
enum NeedsStage<V> {
    /// the check of the tab's own opener, before the tab is loaded
    Opener { id: String },
    /// the check of the loaded tab's `lazy.needsUser`: the `ready` to wait on
    /// next, and the tab's view then
    Lazy { ready: Ready, view: Option<V> },
}

/// Where `ensureTabLoaded` goes on after a `needsUser` answer.
#[derive(Debug, Clone, PartialEq)]
pub struct EnsureAfterNeedsUser<V>(NeedsStage<V>);

/// Where `ensureTabLoaded` goes on after `lazy.ready` settled: the tab's view
/// as it was when the wait began.
#[derive(Debug, Clone, PartialEq)]
pub struct EnsureAfterReady<V> {
    view: Option<V>,
}

/// The state of `TabManager`, owned by the caller.
pub struct TabManager<V> {
    tabs: Vec<TabRecord<V>>,
    active_id: String,
    next_id: u64,
    html_full_screen_id: Option<String>,
    bleed_wc_ids: Vec<i64>,
    /// `closingIds`: the tabs whose close is suspended on an answer
    pending_closes: Vec<(String, ClosePhase<V>)>,
    full_screen_tracked: Vec<V>,
    spare_sheets_view: Option<V>,
    spare_sheets_timer: bool,
    split: Option<SplitViewState>,
    previous_active_id: Option<String>,
    pane_focus_tracked: Vec<V>,
    prompt_depth: u32,
    prompt_split_snapshot: Option<SplitViewState>,
    prompt_active_id_snapshot: Option<String>,
    loading_ids: Vec<String>,
}

/// `openDocsTab`'s `options`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OpenDocsOptions {
    pub new_blank: bool,
    pub ai_content: Option<Value>,
}

/// `openHwpTab`'s `options.untitledCopy`
#[derive(Debug, Clone, PartialEq)]
pub struct HwpCopy {
    pub title: String,
    pub imported_pdf: bool,
}

/// `openTemplateCopy`'s argument
#[derive(Debug, Clone, PartialEq)]
pub struct TemplateCopy {
    pub editor: String,
    pub path: String,
    pub bytes: Vec<u8>,
    pub file_name: String,
    pub title: String,
}

fn truthy_opt(text: &Option<String>) -> bool {
    truthy(text.as_deref()).is_some()
}

impl<V: Clone + PartialEq> TabManager<V> {
    /// the constructor: Home, the only tab
    pub fn new() -> TabManager<V> {
        TabManager {
            tabs: vec![TabRecord {
                id: HOME_ID.to_owned(),
                kind: TabKind::Home,
                view: None,
                title: PRODUCT_NAME.to_owned(),
                file_path: None,
                present: false,
                opener: None,
                lazy: None,
            }],
            active_id: HOME_ID.to_owned(),
            next_id: 1,
            html_full_screen_id: None,
            bleed_wc_ids: Vec::new(),
            pending_closes: Vec::new(),
            full_screen_tracked: Vec::new(),
            spare_sheets_view: None,
            spare_sheets_timer: false,
            split: None,
            previous_active_id: None,
            pane_focus_tracked: Vec::new(),
            prompt_depth: 0,
            prompt_split_snapshot: None,
            prompt_active_id_snapshot: None,
            loading_ids: Vec::new(),
        }
    }

    // ---- window events ----

    /// the shell window's `resize`: a layout now and one on the next tick
    pub fn on_window_resize(&mut self, host: &mut dyn TabHost<V>) {
        self.layout(host);
        host.defer(Deferred::Layout);
    }

    /// the shell window's `restore`: a reconcile now and one on the next tick
    pub fn on_window_restore(&mut self, host: &mut dyn TabHost<V>) {
        self.reconcile_after_window_restore(host);
        host.defer(Deferred::ReconcileAfterWindowRestore);
    }

    /// the `setImmediate` callback of `step`
    pub fn run_deferred(&mut self, host: &mut dyn TabHost<V>, step: Deferred) {
        match step {
            Deferred::Layout => self.layout(host),
            Deferred::ReconcileAfterWindowRestore => self.reconcile_after_window_restore(host),
        }
    }

    // ---- the spare Sheets view ----

    fn schedule_spare_sheets_view(&mut self, host: &mut dyn TabHost<V>, delay_ms: f64) {
        if host.no_spare_view_env() || self.spare_sheets_timer || self.spare_sheets_view.is_some() {
            return;
        }
        // a spare sheets view belongs to the single-pane shell; it must never
        // shadow a pane while a split is live
        if self.split.is_some() {
            return;
        }
        if self.tab_by_id(&self.active_id).map(|t| t.kind) != Some(TabKind::Sheets) {
            return;
        }
        host.set_spare_timer(delay_ms);
        self.spare_sheets_timer = true;
    }

    /// the callback of the spare-view timer
    pub fn fire_spare_sheets_timer(&mut self, host: &mut dyn TabHost<V>) -> TabResult<()> {
        self.spare_sheets_timer = false;
        if self.spare_sheets_view.is_some() || host.window_destroyed() || self.split.is_some() {
            return Ok(());
        }
        let active_view = match self.tab_by_id(&self.active_id) {
            Some(active) if active.kind == TabKind::Sheets => active.view.clone(),
            _ => return Ok(()),
        };
        let view = host.create_view(&ViewSpec::Sheets {
            opening_workbook: None,
        })?;
        // registering the session made the spare the menu-action target
        host.set_active_sheets_web_contents(active_view.as_ref());
        host.add_child_view(&view);
        host.set_visible(&view, false);
        // the window may be minimized or mid-restore when the spare spawns; a
        // degenerate rect would leave the spare zero-sized until its next layout
        let bounds = self.content_bounds(host);
        if is_settled_rect(&bounds) {
            host.set_bounds(&view, &bounds);
        }
        host.once_render_process_gone(&view);
        self.spare_sheets_view = Some(view);
        Ok(())
    }

    /// the spare view's `render-process-gone`
    pub fn on_spare_render_process_gone(&mut self, host: &mut dyn TabHost<V>, view: &V) {
        if self.spare_sheets_view.as_ref() != Some(view) {
            return;
        }
        self.spare_sheets_view = None;
        host.close_view(view);
    }

    fn take_spare_sheets_view(&mut self, host: &mut dyn TabHost<V>) -> Option<V> {
        let view = self.spare_sheets_view.take();
        match view {
            Some(view) if !host.view_destroyed(&view) => Some(view),
            _ => None,
        }
    }

    fn discard_spare_sheets_view(&mut self, host: &mut dyn TabHost<V>) {
        if self.spare_sheets_timer {
            host.clear_spare_timer();
        }
        self.spare_sheets_timer = false;
        let spare = self.spare_sheets_view.take();
        let Some(spare) = spare else {
            return;
        };
        host.remove_child_view(&spare);
        host.close_view(&spare);
    }

    // ---- geometry ----

    fn untitled(&self, host: &mut dyn TabHost<V>, kind: TabKind, fallback: &str) -> String {
        host.untitled_title_for(kind)
            .unwrap_or_else(|| fallback.to_owned())
    }

    /// the shell window's own content size: what a covering view fills
    fn window_rect(&self, host: &mut dyn TabHost<V>) -> Rect {
        let (width, height) = host.window_content_size();
        Rect {
            x: 0.0,
            y: 0.0,
            width,
            height,
        }
    }

    /// the layout space normal tab views live in: the window below the strip
    fn content_bounds(&self, host: &mut dyn TabHost<V>) -> Rect {
        let (width, height) = host.window_content_size();
        // the strip is `zoom`ed by the interface scale, so its rendered height
        // grows with it
        let strip = tab_strip_height(host.ui_scale());
        Rect {
            x: 0.0,
            y: strip,
            width,
            height: math_max(0.0, height - strip),
        }
    }

    /// the tab whose view covers the whole window right now
    fn cover_tab_id(&self, host: &mut dyn TabHost<V>) -> Option<String> {
        if let Some(id) = &self.html_full_screen_id {
            return Some(id.clone());
        }
        let view = self
            .tab_by_id(&self.active_id)
            .and_then(|t| t.view.as_ref());
        if let Some(view) = view
            && self.bleed_wc_ids.contains(&host.view_id(view))
        {
            return Some(self.active_id.clone());
        }
        None
    }

    fn index_of(&self, id: &str) -> Option<usize> {
        self.tabs.iter().position(|t| t.id == id)
    }

    fn tab_by_id(&self, id: &str) -> Option<&TabRecord<V>> {
        self.tabs.iter().find(|t| t.id == id)
    }

    fn alloc_id(&mut self) -> String {
        let id = format!("t{}", self.next_id);
        self.next_id += 1;
        id
    }

    fn index_of_view(&self, view: &V) -> Option<usize> {
        self.tabs.iter().position(|t| t.view.as_ref() == Some(view))
    }

    fn index_of_wc(&self, host: &mut dyn TabHost<V>, wc_id: i64) -> Option<usize> {
        for (i, tab) in self.tabs.iter().enumerate() {
            if let Some(view) = &tab.view
                && host.view_id(view) == wc_id
            {
                return Some(i);
            }
        }
        None
    }

    /// `setContentBleed`
    pub fn set_content_bleed(&mut self, host: &mut dyn TabHost<V>, wc_id: i64, on: bool) {
        if on {
            if !self.bleed_wc_ids.contains(&wc_id) {
                self.bleed_wc_ids.push(wc_id);
            }
        } else {
            self.bleed_wc_ids.retain(|id| *id != wc_id);
        }
        self.layout(host);
    }

    /// the view's `enter-html-full-screen`
    pub fn on_enter_html_full_screen(&mut self, host: &mut dyn TabHost<V>, view: &V) {
        let Some(i) = self.index_of_view(view) else {
            return;
        };
        self.html_full_screen_id = Some(self.tabs[i].id.clone());
        self.layout(host);
    }

    /// the view's `leave-html-full-screen`
    pub fn on_leave_html_full_screen(&mut self, host: &mut dyn TabHost<V>, view: &V) {
        let id = self.index_of_view(view).map(|i| self.tabs[i].id.clone());
        if let Some(id) = id
            && self.html_full_screen_id.as_deref() == Some(id.as_str())
        {
            self.html_full_screen_id = None;
        }
        self.layout(host);
    }

    fn track_html_full_screen(&mut self, host: &mut dyn TabHost<V>, view: &V) {
        if self.full_screen_tracked.contains(view) {
            return;
        }
        self.full_screen_tracked.push(view.clone());
        host.listen_html_full_screen(view);
    }

    fn track_pane_focus(&mut self, host: &mut dyn TabHost<V>, view: &V) {
        if self.pane_focus_tracked.contains(view) {
            return;
        }
        self.pane_focus_tracked.push(view.clone());
        host.listen_pane_focus(view);
    }

    /// the view's `focus` event: the pane showing it takes the focus
    pub fn on_pane_focus(&mut self, host: &mut dyn TabHost<V>, view: &V) {
        let Some(i) = self.index_of_view(view) else {
            return;
        };
        let Some(split) = self.split.clone() else {
            return;
        };
        let id = self.tabs[i].id.clone();
        if id == split.a_tab_id {
            self.focus_pane(host, Pane::A);
        } else if id == split.b_tab_id {
            self.focus_pane(host, Pane::B);
        }
    }

    /// Re-fit every visible view after a window resize, an activation or a split
    /// change.
    pub fn layout(&mut self, host: &mut dyn TabHost<V>) {
        // deferred resize layouts can land after the shell window was closed
        if host.window_destroyed() {
            return;
        }
        let bounds = self.content_bounds(host);
        // a minimized or mid-restore window can report a degenerate client rect
        if !is_settled_rect(&bounds) {
            return;
        }
        // pane references can go stale while a close prompt is settling; drop them
        let stale = match &self.split {
            Some(split) => {
                !self
                    .tab_by_id(&split.a_tab_id)
                    .is_some_and(|t| t.view.is_some())
                    || !self
                        .tab_by_id(&split.b_tab_id)
                        .is_some_and(|t| t.view.is_some())
            }
            None => false,
        };
        if stale {
            self.split = None;
        }
        let cover = self.cover_tab_id(host);
        if let Some(cover) = cover {
            for t in &self.tabs {
                if let Some(view) = &t.view {
                    host.set_visible(view, t.id == cover);
                }
            }
            if let Some(view) = self.tab_by_id(&cover).and_then(|t| t.view.as_ref()) {
                let rect = self.window_rect(host);
                host.set_bounds(view, &rect);
            }
            return;
        }
        if let Some(split) = &self.split
            && (self.active_id == split.a_tab_id || self.active_id == split.b_tab_id)
        {
            for t in &self.tabs {
                if let Some(view) = &t.view {
                    host.set_visible(view, t.id == split.a_tab_id || t.id == split.b_tab_id);
                }
            }
            let rects = pane_rects(&bounds, split.orientation, split.ratio);
            if let Some(view) = self
                .tab_by_id(&split.a_tab_id)
                .and_then(|t| t.view.as_ref())
            {
                host.set_bounds(view, &rects.a);
            }
            if let Some(view) = self
                .tab_by_id(&split.b_tab_id)
                .and_then(|t| t.view.as_ref())
            {
                host.set_bounds(view, &rects.b);
            }
            return;
        }
        for t in &self.tabs {
            if let Some(view) = &t.view {
                host.set_visible(view, t.id == self.active_id);
            }
        }
        if let Some(view) = self
            .tab_by_id(&self.active_id)
            .and_then(|t| t.view.as_ref())
        {
            host.set_bounds(view, &bounds);
        }
    }

    /// Re-fit the active view after the native window returns from the
    /// taskbar: no visibility toggles, no focus, no menu, no onChanged.
    pub fn reconcile_after_window_restore(&mut self, host: &mut dyn TabHost<V>) {
        if host.window_destroyed() || host.window_minimized() {
            return;
        }
        self.layout(host);
    }

    // ---- lists ----

    /// files open in any tab, for the open-documents registry
    pub fn open_file_paths(&self) -> Vec<String> {
        self.tabs
            .iter()
            .filter(|t| truthy_opt(&t.file_path))
            .filter_map(|t| t.file_path.clone())
            .collect()
    }

    /// `list`
    pub fn list(&self) -> Vec<TabSummary> {
        self.tabs
            .iter()
            .map(|t| TabSummary {
                id: t.id.clone(),
                kind: t.kind,
                title: t.title.clone(),
                closable: t.id != HOME_ID,
                active: t.id == self.active_id,
                file_path: t.file_path.clone().filter(|p| !p.is_empty()),
            })
            .collect()
    }

    /// `openDocuments`: every editor tab except Home and chrome-free Present
    /// tabs, with its dirty state resolved per family. The list and each
    /// tab's `active` are read when the run begins; the tabs are asked in
    /// strip order and the run waits for each docs answer
    /// ([`OpenDocumentsStep::QueryDocsDirty`], resumed with
    /// [`TabManager::resume_open_documents`]).
    pub fn open_documents(
        &self,
        host: &mut dyn TabHost<V>,
    ) -> OpenDocumentsStep<V, OpenDocumentsRun<V>> {
        // an unloaded tab is listed like any other (clean: it has no edits yet)
        let entries = self
            .tabs
            .iter()
            .filter(|tab| {
                !(tab.kind == TabKind::Home
                    || tab.present
                    || !(tab.view.is_some() || tab.opener.is_some()))
            })
            .map(|tab| {
                (
                    OpenDocumentTab {
                        id: tab.id.clone(),
                        kind: tab.kind,
                        title: tab.title.clone(),
                        file_path: tab.file_path.clone().filter(|p| !p.is_empty()),
                        active: tab.id == self.active_id,
                        dirty: false,
                    },
                    tab.kind,
                    tab.view.clone(),
                )
            })
            .collect();
        Self::open_documents_advance(host, OpenDocumentsRun { entries, at: 0 })
    }

    /// the answer of the `docsQueryDirty` of [`TabManager::open_documents`]
    pub fn resume_open_documents(
        &self,
        host: &mut dyn TabHost<V>,
        mut run: OpenDocumentsRun<V>,
        answer: Result<bool, String>,
    ) -> OpenDocumentsStep<V, OpenDocumentsRun<V>> {
        match answer {
            Err(message) => OpenDocumentsStep::Rejected(message),
            Ok(dirty) => {
                run.entries[run.at].0.dirty = dirty;
                run.at += 1;
                Self::open_documents_advance(host, run)
            }
        }
    }

    fn open_documents_advance(
        host: &mut dyn TabHost<V>,
        mut run: OpenDocumentsRun<V>,
    ) -> OpenDocumentsStep<V, OpenDocumentsRun<V>> {
        while run.at < run.entries.len() {
            let (_, kind, view) = &run.entries[run.at];
            match dirty_ask(host, *kind, view.as_ref()) {
                DirtyAsk::Known(dirty) => {
                    run.entries[run.at].0.dirty = dirty;
                    run.at += 1;
                }
                DirtyAsk::QueryDocs(view) => {
                    return OpenDocumentsStep::QueryDocsDirty { view, next: run };
                }
            }
        }
        OpenDocumentsStep::Done(run.entries.into_iter().map(|(tab, _, _)| tab).collect())
    }

    // ---- opening tabs ----

    /// `openHomeTab`
    pub fn open_home_tab(&mut self, host: &mut dyn TabHost<V>) {
        self.activate_tab(host, HOME_ID);
    }

    /// `openHelpTab`: the in-app user manual; a second call focuses the open
    /// one (at the topic when given)
    pub fn open_help_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        topic: Option<&str>,
    ) -> TabResult<String> {
        let wanted = help_topic_param(topic);
        if let Some(existing) = self.tabs.iter().find(|t| t.kind == TabKind::Help) {
            let existing_id = existing.id.clone();
            let existing_view = existing.view.clone();
            // a link to one topic has to land on it even when the manual was
            // open on another; reloading at the topic is the whole navigation
            if let (Some(wanted), Some(view)) = (wanted, existing_view.as_ref()) {
                let dev_url = host.renderer_dev_url();
                let url = help_view_url(dev_url.as_deref(), Some(wanted))?;
                host.load_url(view, &url);
            }
            self.activate_tab(host, &existing_id);
            return Ok(existing_id);
        }
        let view = host.create_help_view();
        let dev_url = host.renderer_dev_url();
        let url = help_view_url(dev_url.as_deref(), wanted)?;
        host.load_url(&view, &url);
        let id = self.alloc_id();
        host.add_child_view(&view);
        host.set_visible(&view, false);
        let title = self.untitled(host, TabKind::Help, &format!("{PRODUCT_NAME} Help"));
        self.tabs.push(TabRecord {
            id: id.clone(),
            kind: TabKind::Help,
            view: Some(view),
            title,
            file_path: None,
            present: false,
            opener: None,
            lazy: None,
        });
        self.activate_tab(host, &id);
        Ok(id)
    }

    /// the part every `open*Tab` shares after its view is made: add it hidden,
    /// track it, push the tab and activate it
    #[allow(clippy::too_many_arguments)]
    fn finish_open(
        &mut self,
        host: &mut dyn TabHost<V>,
        id: String,
        view: V,
        kind: TabKind,
        title: String,
        file_path: Option<String>,
        present: bool,
    ) -> String {
        self.track_html_full_screen(host, &view);
        self.track_pane_focus(host, &view);
        self.tabs.push(TabRecord {
            id: id.clone(),
            kind,
            view: Some(view),
            title,
            file_path,
            present,
            opener: None,
            lazy: None,
        });
        self.activate_tab(host, &id);
        id
    }

    /// add a new view to the window, hidden
    fn add_hidden(host: &mut dyn TabHost<V>, view: &V) {
        host.add_child_view(view);
        host.set_visible(view, false);
    }

    /// `path ? basename(path) : untitled(kind, fallback)`
    fn title_for(
        &self,
        host: &mut dyn TabHost<V>,
        path: Option<&str>,
        kind: TabKind,
        fallback: &str,
    ) -> String {
        match truthy(path) {
            Some(path) => basename(path, None),
            None => self.untitled(host, kind, fallback),
        }
    }

    /// `openDocsTab`
    pub fn open_docs_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        open_path: Option<&str>,
        options: Option<&OpenDocsOptions>,
    ) -> TabResult<String> {
        let view = host.create_view(&ViewSpec::Docs { path: open_path })?;
        let id = self.alloc_id();
        if let Some(options) = options {
            if options.new_blank {
                let wc_id = host.view_id(&view);
                host.mark_docs_new_blank(wc_id);
            }
            if let Some(content) = &options.ai_content {
                let wc_id = host.view_id(&view);
                host.queue_docs_ai_content(wc_id, content);
            }
        }
        Self::add_hidden(host, &view);
        let title = self.title_for(
            host,
            open_path,
            TabKind::Docs,
            &format!("{PRODUCT_NAME} Docs"),
        );
        Ok(self.finish_open(
            host,
            id,
            view,
            TabKind::Docs,
            title,
            open_path.map(str::to_owned),
            false,
        ))
    }

    /// `openSheetsTab`
    pub fn open_sheets_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        open_path: Option<&str>,
        new_blank: bool,
    ) -> TabResult<String> {
        if new_blank {
            host.set_sheets_new_blank();
        }
        let spare = self.take_spare_sheets_view(host);
        let view = match &spare {
            Some(view) => view.clone(),
            None => host.create_view(&ViewSpec::Sheets {
                opening_workbook: Some(truthy(open_path).is_some()),
            })?,
        };
        // bind the path to this tab's webContents: a multi-select Open creates
        // several sheets tabs in one loop
        if let Some(path) = truthy(open_path) {
            host.queue_workbook_for_view(&view, path);
            if spare.is_some() {
                host.nudge_queued_workbook(&view);
            }
        }
        let id = self.alloc_id();
        if spare.is_none() {
            Self::add_hidden(host, &view);
        }
        let title = self.title_for(host, open_path, TabKind::Sheets, "AI Sheets");
        Ok(self.finish_open(
            host,
            id,
            view,
            TabKind::Sheets,
            title,
            open_path.map(str::to_owned),
            false,
        ))
    }

    /// `openSlidesTab`
    pub fn open_slides_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        open_path: Option<&str>,
    ) -> TabResult<String> {
        let view = host.create_view(&ViewSpec::Slides { path: open_path })?;
        let id = self.alloc_id();
        Self::add_hidden(host, &view);
        let title = self.title_for(host, open_path, TabKind::Slides, "AI Slides");
        Ok(self.finish_open(
            host,
            id,
            view,
            TabKind::Slides,
            title,
            open_path.map(str::to_owned),
            false,
        ))
    }

    /// `openPdfTab`
    pub fn open_pdf_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        open_path: &str,
    ) -> TabResult<String> {
        let view = host.create_view(&ViewSpec::Pdf { path: open_path })?;
        let id = self.alloc_id();
        Self::add_hidden(host, &view);
        Ok(self.finish_open(
            host,
            id,
            view,
            TabKind::Pdf,
            basename(open_path, None),
            Some(open_path.to_owned()),
            false,
        ))
    }

    /// `reloadTab`: remount the tab's renderer so it re-reads its file
    pub fn reload_tab(&mut self, host: &mut dyn TabHost<V>, id: &str) {
        let Some(tab) = self.tab_by_id(id) else {
            return;
        };
        let Some(view) = tab.view.clone() else {
            return;
        };
        let kind = tab.kind;
        if host.view_destroyed(&view) {
            return;
        }
        if kind == TabKind::Pdf {
            let wc_id = host.view_id(&view);
            host.clear_pdf_dirty(wc_id);
        }
        host.reload_view(&view);
    }

    /// `openMarkdownTab`
    pub fn open_markdown_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        open_path: Option<&str>,
    ) -> TabResult<String> {
        let view = host.create_view(&ViewSpec::Markdown { path: open_path })?;
        let id = self.alloc_id();
        Self::add_hidden(host, &view);
        let title = self.title_for(host, open_path, TabKind::Markdown, "AI Markdown");
        Ok(self.finish_open(
            host,
            id,
            view,
            TabKind::Markdown,
            title,
            open_path.map(str::to_owned),
            false,
        ))
    }

    /// `openHtmlTab`
    pub fn open_html_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        open_path: Option<&str>,
    ) -> TabResult<String> {
        let view = host.create_view(&ViewSpec::Html { path: open_path })?;
        let id = self.alloc_id();
        Self::add_hidden(host, &view);
        let title = self.title_for(host, open_path, TabKind::Html, "AI HTML");
        Ok(self.finish_open(
            host,
            id,
            view,
            TabKind::Html,
            title,
            open_path.map(str::to_owned),
            false,
        ))
    }

    /// `openMindmapTab`
    pub fn open_mindmap_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        open_path: Option<&str>,
    ) -> TabResult<String> {
        let view = host.create_view(&ViewSpec::Mindmap { path: open_path })?;
        let id = self.alloc_id();
        Self::add_hidden(host, &view);
        let title = self.title_for(host, open_path, TabKind::Mindmap, "Mind Map");
        Ok(self.finish_open(
            host,
            id,
            view,
            TabKind::Mindmap,
            title,
            open_path.map(str::to_owned),
            false,
        ))
    }

    /// `openEpubTab`: a book always has its file
    pub fn open_epub_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        open_path: &str,
    ) -> TabResult<String> {
        let view = host.create_view(&ViewSpec::Epub { path: open_path })?;
        let id = self.alloc_id();
        Self::add_hidden(host, &view);
        Ok(self.finish_open(
            host,
            id,
            view,
            TabKind::Epub,
            basename(open_path, None),
            Some(open_path.to_owned()),
            false,
        ))
    }

    /// `openDiagramTab`
    pub fn open_diagram_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        open_path: Option<&str>,
    ) -> TabResult<String> {
        let view = host.create_view(&ViewSpec::Diagram { path: open_path })?;
        let id = self.alloc_id();
        Self::add_hidden(host, &view);
        self.track_html_full_screen(host, &view);
        self.track_pane_focus(host, &view);
        let identity = if truthy(open_path).is_some() {
            let wc_id = host.view_id(&view);
            host.diagram_tab_identity(wc_id)
        } else {
            None
        };
        let imported = identity.as_ref().is_some_and(|i| i.imported);
        let title = if imported {
            identity.map(|i| i.title).unwrap_or_default()
        } else if let Some(path) = truthy(open_path) {
            basename(path, None)
        } else {
            self.untitled(host, TabKind::Diagram, "Diagram")
        };
        self.tabs.push(TabRecord {
            id: id.clone(),
            kind: TabKind::Diagram,
            view: Some(view),
            title,
            file_path: if imported {
                None
            } else {
                open_path.map(str::to_owned)
            },
            present: false,
            opener: None,
            lazy: None,
        });
        self.activate_tab(host, &id);
        Ok(id)
    }

    /// `webContentsForTab`
    pub fn web_contents_for_tab(&self, id: &str) -> Option<V> {
        self.tab_by_id(id).and_then(|t| t.view.clone())
    }

    /// `openGenerateTargetTab`: a new untitled tab of the target kind, with
    /// the request queued for that tab's webContents
    pub fn open_generate_target_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        target: &str,
        handoff: &Value,
    ) -> TabResult<String> {
        let id = if target == "slides" {
            self.open_slides_tab(host, None)?
        } else if target == "html" {
            self.open_html_tab(host, None)?
        } else {
            self.open_mindmap_tab(host, None)?
        };
        let Some(contents) = self.web_contents_for_tab(&id) else {
            return Err(TabError("the new tab could not be opened".to_owned()));
        };
        host.queue_generate_handoff_for(&contents, handoff);
        Ok(id)
    }

    /// `openConversionResult`: a new untitled tab of the result's editor,
    /// with the converted content queued
    pub fn open_conversion_result(
        &mut self,
        host: &mut dyn TabHost<V>,
        target: &str,
        doc: &Value,
    ) -> TabResult<String> {
        let id = if target == "markdown" {
            self.open_markdown_tab(host, None)?
        } else if target == "slides" {
            self.open_slides_tab(host, None)?
        } else {
            self.open_mindmap_tab(host, None)?
        };
        let Some(contents) = self.web_contents_for_tab(&id) else {
            return Err(TabError("the new tab could not be opened".to_owned()));
        };
        host.queue_converted_content(&contents, doc);
        Ok(id)
    }

    /// `openHwpTab`
    pub fn open_hwp_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        open_path: Option<&str>,
        untitled_copy: Option<&HwpCopy>,
    ) -> TabResult<String> {
        let copy = untitled_copy;
        let view = host.create_view(&ViewSpec::Hwp {
            path: open_path,
            untitled_copy: match copy {
                Some(copy) if copy.imported_pdf => HwpUntitledCopy::BaseName(copy.title.clone()),
                other => HwpUntitledCopy::Flag(other.is_some()),
            },
        })?;
        let id = self.alloc_id();
        Self::add_hidden(host, &view);
        // an untitled copy reads a temp file but is not that file
        let title = match copy {
            Some(copy) => copy.title.clone(),
            None => self.title_for(host, open_path, TabKind::Hwp, "HWP"),
        };
        Ok(self.finish_open(
            host,
            id,
            view,
            TabKind::Hwp,
            title,
            if copy.is_some() {
                None
            } else {
                open_path.map(str::to_owned)
            },
            false,
        ))
    }

    /// `openTemplateCopy`: a skill template's copy as a new, untitled
    /// document of its editor; `None` for Sheets and EPUB and when the tab
    /// could not be made
    pub fn open_template_copy(
        &mut self,
        host: &mut dyn TabHost<V>,
        copy: &TemplateCopy,
    ) -> TabResult<Option<(String, V)>> {
        let id = match copy.editor.as_str() {
            "docs" => self.open_docs_tab(host, None, None)?,
            "markdown" => self.open_markdown_tab(host, None)?,
            "html" => self.open_html_tab(host, None)?,
            "mindmap" => self.open_mindmap_tab(host, None)?,
            "slides" => self.open_slides_tab(host, None)?,
            "hwp" => self.open_hwp_tab(
                host,
                Some(copy.path.as_str()),
                Some(&HwpCopy {
                    title: copy.title.clone(),
                    imported_pdf: false,
                }),
            )?,
            "pdf" => {
                host.mark_pdf_untitled_copy(&copy.path);
                self.open_pdf_tab(host, &copy.path)?
            }
            _ => return Ok(None),
        };
        let Some(contents) = self.web_contents_for_tab(&id) else {
            return Ok(None);
        };
        // the decoder drops a leading byte order mark
        let text = || text_decoder_decode(&copy.bytes).into_owned();
        match copy.editor.as_str() {
            "docs" => {
                let wc_id = host.view_id(&contents);
                host.queue_docs_copy(wc_id, &copy.path, &copy.file_name);
            }
            "markdown" => host.queue_markdown_seed_for(&contents, &text()),
            "html" => host.queue_html_seed_for(&contents, &text()),
            "mindmap" => host.queue_mindmap_seed_for(&contents, &copy.bytes),
            "slides" => host.queue_slides_seed_for(&contents, &copy.bytes, &copy.file_name),
            _ => {}
        }
        // a tab without a file takes the copy's title
        let wc_id = host.view_id(&contents);
        self.set_tab_title_for(host, wc_id, &copy.title);
        Ok(Some((id, contents)))
    }

    /// `openHtmlPresentTab`: a chrome-free html tab showing the owner tab's
    /// live preview
    pub fn open_html_present_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        owner_wc_id: i64,
        title: &str,
    ) -> TabResult<String> {
        let view = host.create_view(&ViewSpec::HtmlPresent {
            owner: owner_wc_id,
            title,
        })?;
        let id = self.alloc_id();
        Self::add_hidden(host, &view);
        let title = match truthy(Some(title)) {
            Some(title) => title.to_owned(),
            None => self.untitled(host, TabKind::Html, "AI HTML"),
        };
        Ok(self.finish_open(host, id, view, TabKind::Html, title, None, true))
    }

    /// `cycleTab`: step through the strip in order and wrap at the ends
    pub fn cycle_tab(&mut self, host: &mut dyn TabHost<V>, direction: i32) {
        if self.tabs.len() < 2 {
            return;
        }
        let Some(current) = self.index_of(&self.active_id.clone()) else {
            return;
        };
        let len = self.tabs.len() as i64;
        let next = (current as i64 + i64::from(direction) + len) % len;
        let id = self.tabs[next as usize].id.clone();
        self.activate_tab(host, &id);
    }

    // ---- unloaded tabs ----

    /// `addUnloadedTab`
    pub fn add_unloaded_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        spec: &UnloadedTabSpec,
    ) -> String {
        let id = self.push_unloaded_tab(host, spec);
        host.on_changed();
        id
    }

    fn push_unloaded_tab(&mut self, host: &mut dyn TabHost<V>, spec: &UnloadedTabSpec) -> String {
        let id = self.alloc_id();
        let title = match &spec.title {
            Some(title) => title.clone(),
            None => match truthy(spec.file_path.as_deref()) {
                Some(path) => basename(path, None),
                None => self.untitled(host, spec.kind, PRODUCT_NAME),
            },
        };
        self.tabs.push(TabRecord {
            id: id.clone(),
            kind: spec.kind,
            view: None,
            title,
            file_path: spec.file_path.clone(),
            present: false,
            opener: Some(spec.opener),
            lazy: None,
        });
        id
    }

    /// `isTabUnloaded`
    pub fn is_tab_unloaded(&self, id: &str) -> bool {
        self.tab_by_id(id).is_some_and(|t| t.opener.is_some())
    }

    /// `hydrateSession`: rebuild a restored session; returns the new tab ids
    pub fn hydrate_session(
        &mut self,
        host: &mut dyn TabHost<V>,
        session: &RestoredSession,
    ) -> Vec<String> {
        let ids: Vec<String> = session
            .tabs
            .iter()
            .map(|spec| self.push_unloaded_tab(host, spec))
            .collect();
        host.on_changed();
        let at = |index: Option<f64>| -> Option<String> {
            let index = index?;
            if index.fract() == 0.0 && index.is_finite() && index >= 0.0 && index < ids.len() as f64
            {
                Some(ids[index as usize].clone())
            } else {
                None
            }
        };
        let active_id = at(session.active);
        let a_id = at(session.split.as_ref().map(|s| s.a));
        let b_id = at(session.split.as_ref().map(|s| s.b));
        if let (Some(split), Some(a_id), Some(b_id)) = (&session.split, &a_id, &b_id)
            && a_id != b_id
        {
            let focus = if active_id.as_ref() == Some(a_id) {
                Pane::A
            } else if active_id.as_ref() == Some(b_id) {
                Pane::B
            } else {
                split.focus
            };
            self.begin_split(host, a_id, b_id, split.orientation, split.ratio, focus);
            if self.split.is_some() {
                return ids;
            }
        }
        if let Some(active_id) = active_id {
            self.activate_tab(host, &active_id);
        }
        ids
    }

    /// `ensureTabLoaded`: load the tab if it is unloaded, without activating
    /// it, and resolve once its document is ready. The two awaits that can
    /// wait on a person or a renderer are steps ([`EnsureStep`]): the
    /// opener's `needsUser` and `lazy.ready`.
    pub fn ensure_tab_loaded(&mut self, host: &mut dyn TabHost<V>, id: &str) -> EnsureStep<V> {
        if self.index_of(id).is_none() || id == HOME_ID {
            return EnsureStep::Done(TabLoadResult::Missing);
        }
        let opener = self.tab_by_id(id).and_then(|t| t.opener);
        if let Some(opener) = opener {
            if opener.has_needs_user {
                let context = self.open_context(self.index_of(id).unwrap_or(0));
                return EnsureStep::NeedsUser {
                    opener,
                    context,
                    next: EnsureAfterNeedsUser(NeedsStage::Opener { id: id.to_owned() }),
                };
            }
            return self.ensure_after_opener(host, id);
        }
        self.ensure_lazy(host, id)
    }

    /// the answer of `opener.needsUser` of [`EnsureStep::NeedsUser`]
    pub fn resume_ensure_needs_user(
        &mut self,
        host: &mut dyn TabHost<V>,
        next: EnsureAfterNeedsUser<V>,
        answer: Result<bool, String>,
    ) -> EnsureStep<V> {
        match answer {
            Err(message) => EnsureStep::Rejected(message),
            Ok(true) => EnsureStep::Done(TabLoadResult::NeedsUser),
            Ok(false) => match next.0 {
                NeedsStage::Opener { id } => self.ensure_after_opener(host, &id),
                NeedsStage::Lazy { ready, view } => EnsureStep::AwaitReady {
                    ready,
                    next: EnsureAfterReady { view },
                },
            },
        }
    }

    /// the end of `lazy.ready` of [`EnsureStep::AwaitReady`]
    pub fn resume_ensure_ready(
        &mut self,
        host: &mut dyn TabHost<V>,
        next: EnsureAfterReady<V>,
        answer: Result<(), String>,
    ) -> EnsureStep<V> {
        match answer {
            Err(message) => EnsureStep::Rejected(message),
            Ok(()) => Self::ensure_finish(host, next.view),
        }
    }

    /// the part after the opener's `needsUser` check
    fn ensure_after_opener(&mut self, host: &mut dyn TabHost<V>, id: &str) -> EnsureStep<V> {
        // the answer may have taken a while: the tab can be gone or loaded by now
        if self.index_of(id).is_none() {
            return EnsureStep::Done(TabLoadResult::Missing);
        }
        if !self.load_tab(host, id) {
            let title = self
                .tab_by_id(id)
                .map(|t| t.title.clone())
                .unwrap_or_default();
            return EnsureStep::Rejected(format!("\"{title}\" could not be opened"));
        }
        self.ensure_lazy(host, id)
    }

    /// `const lazy = tab.lazy` and what follows it
    fn ensure_lazy(&mut self, host: &mut dyn TabHost<V>, id: &str) -> EnsureStep<V> {
        let Some(index) = self.index_of(id) else {
            return EnsureStep::Done(TabLoadResult::Missing);
        };
        let view = self.tabs[index].view.clone();
        let lazy = self.tabs[index]
            .lazy
            .as_ref()
            .map(|l| (l.ready, l.settled, l.needs_user));
        if let Some((ready, settled, needs_user)) = lazy
            && !settled
        {
            if let Some(needs_user) = needs_user {
                let context = self.open_context(index);
                return EnsureStep::NeedsUser {
                    opener: needs_user,
                    context,
                    next: EnsureAfterNeedsUser(NeedsStage::Lazy { ready, view }),
                };
            }
            return EnsureStep::AwaitReady {
                ready,
                next: EnsureAfterReady { view },
            };
        }
        Self::ensure_finish(host, view)
    }

    /// `const contents = tab.view?.webContents` and the answer
    fn ensure_finish(host: &mut dyn TabHost<V>, view: Option<V>) -> EnsureStep<V> {
        let Some(view) = view else {
            return EnsureStep::Done(TabLoadResult::Missing);
        };
        if host.view_destroyed(&view) {
            return EnsureStep::Done(TabLoadResult::Missing);
        }
        EnsureStep::Done(TabLoadResult::Ready(view))
    }

    /// a document's ready promise settled (resolved or rejected)
    pub fn ready_settled(&mut self, ready: Ready) {
        for tab in &mut self.tabs {
            if let Some(lazy) = &mut tab.lazy
                && lazy.ready == ready
            {
                lazy.settled = true;
            }
        }
    }

    fn open_context(&self, index: usize) -> UnloadedTabOpenContext {
        let tab = &self.tabs[index];
        UnloadedTabOpenContext {
            tab_id: tab.id.clone(),
            kind: tab.kind,
            title: tab.title.clone(),
            file_path: tab.file_path.clone().filter(|p| !p.is_empty()),
        }
    }

    /// Make an unloaded tab's editor view through its opener, once. True when
    /// the tab has its view afterwards (or never needed one); false when the
    /// opener failed, leaving the tab unloaded for the next try.
    fn load_tab(&mut self, host: &mut dyn TabHost<V>, id: &str) -> bool {
        let Some(index) = self.index_of(id) else {
            return true;
        };
        let Some(opener) = self.tabs[index].opener else {
            return true;
        };
        if self.tabs[index].view.is_some() {
            return true;
        }
        if self.loading_ids.iter().any(|l| l == id) {
            return false;
        }
        self.loading_ids.push(id.to_owned());
        let context = self.open_context(index);
        let loaded = match host.opener_open(&opener, &context) {
            Ok(loaded) => loaded,
            Err(error) => {
                host.warn("[tabs] a restored tab could not be opened:", &error);
                self.loading_ids.retain(|l| l != id);
                return false;
            }
        };
        self.loading_ids.retain(|l| l != id);
        let LoadedTabView { view, ready } = loaded;
        Self::add_hidden(host, &view);
        self.track_html_full_screen(host, &view);
        self.track_pane_focus(host, &view);
        let ready = match ready {
            Some(ready) => ready,
            None => host.page_loaded(&view),
        };
        let tab = &mut self.tabs[index];
        tab.view = Some(view);
        tab.opener = None;
        tab.lazy = Some(LazyLoadState {
            ready,
            settled: false,
            needs_user: if opener.has_needs_user {
                Some(opener)
            } else {
                None
            },
        });
        true
    }

    // ---- activation ----

    /// `activateTab`
    pub fn activate_tab(&mut self, host: &mut dyn TabHost<V>, id: &str) {
        let Some(index) = self.index_of(id) else {
            return;
        };
        // an unloaded tab makes its editor first; a failed opener leaves the window as it was
        if !self.load_tab(host, id) {
            return;
        }
        let previous = self.active_id.clone();
        let (target_kind, target_present) = {
            let target = &self.tabs[index];
            (target.kind, target.present)
        };
        if let Some(split) = self.split.clone() {
            let mode = activation_mode(
                Some((split.a_tab_id.as_str(), split.b_tab_id.as_str())),
                id,
                target_kind.as_str(),
                target_present,
            );
            if mode == SplitActivationMode::ReplacePane {
                // a strip document tab takes over the focused pane; the replaced
                // document stays open in the strip
                let side = split.focus;
                self.split = Some(if side == Pane::A {
                    SplitViewState {
                        a_tab_id: id.to_owned(),
                        ..split
                    }
                } else {
                    SplitViewState {
                        b_tab_id: id.to_owned(),
                        ..split
                    }
                });
                if previous != id {
                    self.previous_active_id = Some(previous);
                }
                self.active_id = id.to_owned();
                self.layout(host);
                self.refresh_active_targets(host);
                self.focus_active_view(host);
                host.on_changed();
                self.notify_split_changed(host);
                return;
            }
            if mode == SplitActivationMode::Pane {
                let side = if id == split.a_tab_id {
                    Pane::A
                } else {
                    Pane::B
                };
                if split.focus != side {
                    self.split = Some(SplitViewState {
                        focus: side,
                        ..split
                    });
                    self.notify_split_changed(host);
                }
            }
        }
        if previous != id {
            self.previous_active_id = Some(previous);
        }
        self.active_id = id.to_owned();
        if target_kind == TabKind::Sheets && self.split.is_none() {
            self.schedule_spare_sheets_view(host, 3000.0);
        } else {
            self.discard_spare_sheets_view(host);
        }
        self.layout(host);
        self.refresh_active_targets(host);
        self.focus_active_view(host);
        host.on_changed();
    }

    /// `focusActiveView`: hand keyboard focus to the active tab's view
    pub fn focus_active_view(&mut self, host: &mut dyn TabHost<V>) {
        if host.window_destroyed() || !host.window_focused() {
            return;
        }
        let Some(target) = self.tab_by_id(&self.active_id) else {
            return;
        };
        match target.view.clone() {
            Some(view) => host.focus_view(&view),
            None => host.focus_shell_contents(),
        }
    }

    /// `refreshActiveTargets`: re-point the process-global active-editor
    /// targets and the app menu at this window's active tab
    pub fn refresh_active_targets(&mut self, host: &mut dyn TabHost<V>) {
        let Some(target) = self.tab_by_id(&self.active_id) else {
            return;
        };
        let kind = target.kind;
        let view = target.view.clone();
        let menu_kind = if target.present || target.opener.is_some() {
            TabKind::Home
        } else {
            kind
        };
        host.set_active_docs_resolver(
            if kind == TabKind::Docs {
                view.as_ref()
            } else {
                None
            },
            false,
        );
        if kind == TabKind::Sheets
            && let Some(view) = &view
        {
            host.set_active_sheets_web_contents(Some(view));
        }
        if kind == TabKind::Slides
            && let Some(view) = &view
        {
            host.set_active_slides_web_contents(view);
        }
        // an unloaded tab has no editor to take menu actions yet
        host.apply_menu_for(menu_kind);
    }

    // ---- the two-pane split ----

    fn notify_split_changed(&mut self, host: &mut dyn TabHost<V>) {
        host.on_split_changed(self.split.as_ref());
    }

    /// `splitState`
    pub fn split_state(&self) -> Option<SplitViewState> {
        self.split.clone()
    }

    /// `sessionTabs`: the strip as the session record keeps it
    pub fn session_tabs(&self) -> SessionStripState {
        SessionStripState {
            tabs: self
                .tabs
                .iter()
                .filter(|t| t.kind != TabKind::Home && t.kind != TabKind::Help && !t.present)
                .map(|t| SessionStripTab {
                    id: t.id.clone(),
                    kind: t.kind,
                    title: t.title.clone(),
                    file_path: t.file_path.clone().filter(|p| !p.is_empty()),
                })
                .collect(),
            active_id: self.active_id.clone(),
            split: self.split_state(),
        }
    }

    /// `splitRoleOf`: which pane role the given view plays right now
    pub fn split_role_of(&self, host: &mut dyn TabHost<V>, wc_id: i64) -> Option<SplitPaneRole> {
        let split = self.split.as_ref()?;
        let i = self.index_of_wc(host, wc_id)?;
        let id = &self.tabs[i].id;
        if *id == split.a_tab_id {
            return Some(if split.focus == Pane::A {
                SplitPaneRole::Focus
            } else {
                SplitPaneRole::Secondary
            });
        }
        if *id == split.b_tab_id {
            return Some(if split.focus == Pane::B {
                SplitPaneRole::Focus
            } else {
                SplitPaneRole::Secondary
            });
        }
        None
    }

    /// `isPaneTab`
    pub fn is_pane_tab(&self, tab_id: &str) -> bool {
        self.split
            .as_ref()
            .is_some_and(|s| tab_id == s.a_tab_id || tab_id == s.b_tab_id)
    }

    /// Make the given pane the focused one without stealing keyboard focus.
    fn focus_pane(&mut self, host: &mut dyn TabHost<V>, side: Pane) {
        let Some(split) = self.split.clone() else {
            return;
        };
        if split.focus == side {
            return;
        }
        let id = if side == Pane::A {
            split.a_tab_id.clone()
        } else {
            split.b_tab_id.clone()
        };
        self.split = Some(SplitViewState {
            focus: side,
            ..split
        });
        if self.tabs.iter().any(|t| t.id == id) {
            if self.active_id != id {
                self.previous_active_id = Some(self.active_id.clone());
            }
            self.active_id = id;
        }
        self.layout(host);
        self.refresh_active_targets(host);
        host.on_changed();
        self.notify_split_changed(host);
    }

    /// `focusPaneByWebContents`: focus the pane showing this view's document
    pub fn focus_pane_by_web_contents(&mut self, host: &mut dyn TabHost<V>, wc_id: i64) {
        let Some(split) = self.split.clone() else {
            return;
        };
        let Some(i) = self.index_of_wc(host, wc_id) else {
            return;
        };
        let id = self.tabs[i].id.clone();
        if id == split.a_tab_id {
            self.focus_pane(host, Pane::A);
        } else if id == split.b_tab_id {
            self.focus_pane(host, Pane::B);
        }
    }

    /// the pane whose document is this tab's document (same tab or same file)
    fn pane_of_document(&self, index: usize) -> Option<Pane> {
        let split = self.split.as_ref()?;
        let tab = &self.tabs[index];
        let wanted = canonical_path(tab.file_path.as_deref());
        for side in [Pane::A, Pane::B] {
            let id = if side == Pane::A {
                &split.a_tab_id
            } else {
                &split.b_tab_id
            };
            let Some(pane) = self.tab_by_id(id) else {
                continue;
            };
            if pane.id == tab.id {
                return Some(side);
            }
            if wanted.is_some() && canonical_path(pane.file_path.as_deref()) == wanted {
                return Some(side);
            }
        }
        None
    }

    /// the last shown document tab other than the excluded one
    fn previous_document_tab(&self, exclude_id: &str) -> Option<String> {
        let tabs: Vec<OppositeTab> = self
            .tabs
            .iter()
            .map(|t| OppositeTab {
                id: t.id.clone(),
                kind: t.kind.as_str().to_owned(),
                present: t.present,
                // an unloaded tab can be a pane: set_split loads it
                has_view: t.view.is_some() || t.opener.is_some(),
            })
            .collect();
        opposite_document_id(
            &self.active_id,
            self.previous_active_id.as_deref(),
            exclude_id,
            &tabs,
        )
        .map(str::to_owned)
    }

    /// install a split state and make one of its tabs active (clamps the ratio)
    fn set_split(
        &mut self,
        host: &mut dyn TabHost<V>,
        next: SplitViewState,
        active_tab_id: Option<&str>,
    ) {
        // entering a pane is a first activation: an unloaded pane document loads now
        for id in [&next.a_tab_id, &next.b_tab_id] {
            let unloaded = self.tab_by_id(id).is_some_and(|t| t.opener.is_some());
            if unloaded && !self.load_tab(host, id) {
                return;
            }
        }
        let bounded = if next.ratio > 0.0 && next.ratio < 1.0 {
            let bounds = self.content_bounds(host);
            let ratio = clamp_split_ratio(next.ratio, &bounds, next.orientation);
            SplitViewState { ratio, ..next }
        } else {
            next
        };
        self.split = Some(bounded);
        if let Some(active) = active_tab_id
            && self.tabs.iter().any(|t| t.id == active)
        {
            if self.active_id != active {
                self.previous_active_id = Some(self.active_id.clone());
            }
            self.active_id = active.to_owned();
        }
        self.layout(host);
        self.refresh_active_targets(host);
        self.focus_active_view(host);
        host.on_changed();
        self.notify_split_changed(host);
    }

    /// `splitWith`: apply a drop intent decided by `decide_split_drop`
    pub fn split_with(
        &mut self,
        host: &mut dyn TabHost<V>,
        tab_id: &str,
        intent: Option<SplitDropIntent>,
    ) -> TabResult<()> {
        let Some(intent) = intent else {
            return Ok(());
        };
        let Some(index) = self.index_of(tab_id) else {
            return Ok(());
        };
        {
            let tab = &self.tabs[index];
            if (tab.view.is_none() && tab.opener.is_none()) || tab.present {
                return Ok(());
            }
        }
        // a dropped unloaded tab enters a pane: load it before it is placed
        if matches!(
            intent,
            SplitDropIntent::Create(_) | SplitDropIntent::Replace | SplitDropIntent::Reorient(_)
        ) && !self.load_tab(host, tab_id)
        {
            return Ok(());
        }
        match intent {
            SplitDropIntent::Noop => Ok(()),
            SplitDropIntent::Create(orientation) => {
                let mut a_tab_id = self.previous_document_tab(tab_id);
                if a_tab_id.is_none() {
                    a_tab_id = self.open_duplicate_pane_tab(host, tab_id)?;
                    if a_tab_id.is_none() {
                        return Ok(());
                    }
                }
                let Some(a_tab_id) = a_tab_id else {
                    return Ok(());
                };
                self.set_split(
                    host,
                    SplitViewState {
                        a_tab_id,
                        b_tab_id: tab_id.to_owned(),
                        orientation,
                        ratio: SPLIT_EVEN_RATIO,
                        focus: Pane::B,
                    },
                    Some(tab_id),
                );
                Ok(())
            }
            SplitDropIntent::Replace => {
                let Some(split) = self.split.clone() else {
                    return Ok(());
                };
                // the dropped side becomes the focused pane, like create/reorient
                self.set_split(
                    host,
                    SplitViewState {
                        b_tab_id: tab_id.to_owned(),
                        focus: Pane::B,
                        ..split
                    },
                    Some(tab_id),
                );
                Ok(())
            }
            SplitDropIntent::Reorient(orientation) => {
                let Some(split) = self.split.clone() else {
                    return Ok(());
                };
                let focused_tab_id = if split.focus == Pane::A {
                    split.a_tab_id.clone()
                } else {
                    split.b_tab_id.clone()
                };
                self.set_split(
                    host,
                    SplitViewState {
                        a_tab_id: focused_tab_id,
                        b_tab_id: tab_id.to_owned(),
                        orientation,
                        ratio: split.ratio,
                        focus: Pane::B,
                    },
                    Some(tab_id),
                );
                Ok(())
            }
            SplitDropIntent::Flip(orientation) => {
                let Some(split) = self.split.clone() else {
                    return Ok(());
                };
                // set_split re-clamps the ratio for the new axis
                self.set_split(
                    host,
                    SplitViewState {
                        orientation,
                        ..split
                    },
                    None,
                );
                Ok(())
            }
            SplitDropIntent::Focus => {
                if let Some(side) = self.pane_of_document(index) {
                    self.focus_pane(host, side);
                }
                Ok(())
            }
        }
    }

    /// `beginSplit`: rebuild a remembered split at launch
    pub fn begin_split(
        &mut self,
        host: &mut dyn TabHost<V>,
        a_tab_id: &str,
        b_tab_id: &str,
        orientation: SplitOrientation,
        ratio: f64,
        focus: Pane,
    ) {
        if a_tab_id == b_tab_id {
            return;
        }
        let (Some(a), Some(b)) = (self.tab_by_id(a_tab_id), self.tab_by_id(b_tab_id)) else {
            return;
        };
        if (a.view.is_none() && a.opener.is_none()) || (b.view.is_none() && b.opener.is_none()) {
            return;
        }
        if a.present || b.present {
            return;
        }
        if a.kind == TabKind::Home
            || a.kind == TabKind::Help
            || b.kind == TabKind::Home
            || b.kind == TabKind::Help
        {
            return;
        }
        let safe_ratio = if ratio.is_finite() {
            math_min(1.0, math_max(0.0, ratio))
        } else {
            SPLIT_EVEN_RATIO
        };
        let active = if focus == Pane::A { a_tab_id } else { b_tab_id };
        self.set_split(
            host,
            SplitViewState {
                a_tab_id: a_tab_id.to_owned(),
                b_tab_id: b_tab_id.to_owned(),
                orientation,
                ratio: safe_ratio,
                focus,
            },
            Some(active),
        );
    }

    /// `setSplitRatio`: an in-between share resizes the panes; 0 closes the
    /// first pane and 1 closes the second
    pub fn set_split_ratio(&mut self, host: &mut dyn TabHost<V>, ratio: f64) {
        let Some(split) = self.split.clone() else {
            return;
        };
        if !ratio.is_finite() {
            return;
        }
        if ratio <= 0.0 {
            self.unsplit_keeping(host, Pane::B);
            return;
        }
        if ratio >= 1.0 {
            self.unsplit_keeping(host, Pane::A);
            return;
        }
        let bounds = self.content_bounds(host);
        let bounded = clamp_split_ratio(ratio, &bounds, split.orientation);
        if bounded == split.ratio {
            return;
        }
        self.split = Some(SplitViewState {
            ratio: bounded,
            ..split
        });
        self.layout(host);
        self.notify_split_changed(host);
    }

    /// `unsplit`: the focused pane's document becomes the single visible tab
    pub fn unsplit(&mut self, host: &mut dyn TabHost<V>) {
        let Some(split) = &self.split else {
            return;
        };
        let focus = split.focus;
        self.unsplit_keeping(host, focus);
    }

    fn unsplit_keeping(&mut self, host: &mut dyn TabHost<V>, side: Pane) {
        let Some(split) = self.split.clone() else {
            return;
        };
        let keep_id = if side == Pane::A {
            split.a_tab_id
        } else {
            split.b_tab_id
        };
        self.split = None;
        if self.tabs.iter().any(|t| t.id == keep_id) {
            self.activate_tab(host, &keep_id);
        } else {
            self.layout(host);
            host.on_changed();
        }
        self.notify_split_changed(host);
    }

    /// `openDuplicatePaneTab`: a second view of the same document for the
    /// same-document split; `None` for a kind that cannot be duplicated
    pub fn open_duplicate_pane_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        tab_id: &str,
    ) -> TabResult<Option<String>> {
        let Some(tab) = self.tab_by_id(tab_id) else {
            return Ok(None);
        };
        if tab.view.is_none() || tab.present {
            return Ok(None);
        }
        let kind = tab.kind;
        let path = tab.file_path.clone();
        let path = path.as_deref();
        let has_path = truthy(path).is_some();
        Ok(Some(match kind {
            TabKind::Docs => {
                let options = OpenDocsOptions {
                    new_blank: true,
                    ai_content: None,
                };
                self.open_docs_tab(host, path, if has_path { None } else { Some(&options) })?
            }
            TabKind::Sheets => self.open_sheets_tab(host, path, !has_path)?,
            TabKind::Slides => self.open_slides_tab(host, path)?,
            TabKind::Pdf => match truthy(path) {
                Some(path) => self.open_pdf_tab(host, path)?,
                None => return Ok(None),
            },
            TabKind::Markdown => self.open_markdown_tab(host, path)?,
            TabKind::Html => self.open_html_tab(host, path)?,
            TabKind::Mindmap => self.open_mindmap_tab(host, path)?,
            TabKind::Hwp => self.open_hwp_tab(host, path, None)?,
            TabKind::Epub => match truthy(path) {
                Some(path) => self.open_epub_tab(host, path)?,
                None => return Ok(None),
            },
            TabKind::Diagram => self.open_diagram_tab(host, path)?,
            TabKind::Home | TabKind::Help => return Ok(None),
        }))
    }

    /// `beginExclusivePrompt`: snapshot the arrangement around a prompt that
    /// may activate dirty tabs
    pub fn begin_exclusive_prompt(&mut self) {
        if self.prompt_depth == 0 {
            // only a live split needs restoring
            if let Some(split) = &self.split {
                self.prompt_split_snapshot = Some(split.clone());
                self.prompt_active_id_snapshot = Some(self.active_id.clone());
            } else {
                self.prompt_split_snapshot = None;
                self.prompt_active_id_snapshot = None;
            }
        }
        self.prompt_depth += 1;
    }

    /// `endExclusivePrompt`: put the arrangement back exactly as it was
    /// before the outermost begin
    pub fn end_exclusive_prompt(&mut self, host: &mut dyn TabHost<V>) {
        if self.prompt_depth == 0 {
            return;
        }
        self.prompt_depth -= 1;
        if self.prompt_depth > 0 {
            return;
        }
        let split = self.prompt_split_snapshot.take();
        let active_id = self.prompt_active_id_snapshot.take();
        let Some(active_id) = active_id else {
            return;
        };
        let same = self.split == split;
        if same && self.active_id == active_id {
            return;
        }
        self.split = split;
        if self.tabs.iter().any(|t| t.id == active_id) {
            self.active_id = active_id;
        }
        self.layout(host);
        self.refresh_active_targets(host);
        self.focus_active_view(host);
        host.on_changed();
        self.notify_split_changed(host);
    }

    // ---- reorder and lookups by view ----

    /// `reorderTab`: move a tab to a new index in the strip; Home is pinned at 0
    pub fn reorder_tab(&mut self, host: &mut dyn TabHost<V>, id: &str, to_index: f64) {
        if id == HOME_ID {
            return;
        }
        let Some(from_index) = self.index_of(id) else {
            return;
        };
        let clamped = math_min(
            math_max(to_index.trunc(), 1.0),
            (self.tabs.len() - 1) as f64,
        );
        if clamped == from_index as f64 {
            return;
        }
        let moved = self.tabs.remove(from_index);
        // `splice(NaN, 0, moved)` starts at 0
        let at = if clamped.is_nan() {
            0
        } else {
            (clamped as usize).min(self.tabs.len())
        };
        self.tabs.insert(at, moved);
        host.on_changed();
    }

    /// `describeWebContents`: kind, title and file of the document tab
    /// rendered by `wc_id`
    pub fn describe_web_contents(
        &self,
        host: &mut dyn TabHost<V>,
        wc_id: i64,
    ) -> Option<(TabKind, String, Option<String>)> {
        let i = self.index_of_wc(host, wc_id)?;
        let tab = &self.tabs[i];
        Some((
            tab.kind,
            tab.title.clone(),
            tab.file_path.clone().filter(|p| !p.is_empty()),
        ))
    }

    /// `tabIdForWebContents`
    pub fn tab_id_for_web_contents(&self, host: &mut dyn TabHost<V>, wc_id: i64) -> Option<String> {
        self.index_of_wc(host, wc_id)
            .map(|i| self.tabs[i].id.clone())
    }

    /// `setTabFileFor`: a module opened a file inside an existing tab
    pub fn set_tab_file_for(&mut self, host: &mut dyn TabHost<V>, wc_id: i64, file_path: &str) {
        let Some(i) = self.index_of_wc(host, wc_id) else {
            return;
        };
        let tab = &mut self.tabs[i];
        tab.file_path = Some(file_path.to_owned());
        tab.title = basename(file_path, None);
        host.on_changed();
    }

    /// `setTabTitleFor`: an untitled document named itself before its first save
    pub fn set_tab_title_for(&mut self, host: &mut dyn TabHost<V>, wc_id: i64, title: &str) {
        let Some(i) = self.index_of_wc(host, wc_id) else {
            return;
        };
        let tab = &mut self.tabs[i];
        if truthy_opt(&tab.file_path) || tab.title == title {
            return;
        }
        tab.title = title.to_owned();
        host.on_changed();
    }

    /// `renameTabFile`: a file was renamed on disk; returns the affected views
    pub fn rename_tab_file(
        &mut self,
        host: &mut dyn TabHost<V>,
        old_path: &str,
        new_path: &str,
    ) -> Vec<(TabKind, V)> {
        let mut affected = Vec::new();
        for tab in &mut self.tabs {
            if tab.file_path.as_deref() != Some(old_path) {
                continue;
            }
            tab.file_path = Some(new_path.to_owned());
            tab.title = basename(new_path, None);
            if let Some(view) = &tab.view {
                affected.push((tab.kind, view.clone()));
            }
        }
        if !affected.is_empty() {
            host.on_changed();
        }
        affected
    }

    // ---- dirty and live tabs ----

    /// `dirtySheetsTabs`, `dirtyPdfTabs`, `dirtyMarkdownTabs`, `dirtyHtmlTabs`,
    /// `dirtyMindmapTabs`, `dirtyHwpTabs`, `dirtyEpubTabs`, `dirtyDiagramTabs`
    /// and `dirtySlidesTabs`: the tabs of `kind` whose renderer reports unsaved
    /// edits, as `(tab id, view)`
    pub fn dirty_tabs(&self, host: &mut dyn TabHost<V>, kind: TabKind) -> Vec<(String, V)> {
        let mut out = Vec::new();
        for t in &self.tabs {
            if t.kind != kind {
                continue;
            }
            let Some(view) = &t.view else {
                continue;
            };
            let wc_id = host.view_id(view);
            let dirty = match kind {
                TabKind::Sheets => host.sheets_pending_edit_count(wc_id) > 0.0,
                _ => host.family_is_dirty(kind, wc_id),
            };
            if dirty {
                out.push((t.id.clone(), view.clone()));
            }
        }
        out
    }

    /// `dirtyOrMemoHwpTabs`: unsaved edits, or an open memo editor
    pub fn dirty_or_memo_hwp_tabs(&self, host: &mut dyn TabHost<V>) -> Vec<(String, V)> {
        let mut out = Vec::new();
        for t in &self.tabs {
            if t.kind != TabKind::Hwp {
                continue;
            }
            let Some(view) = &t.view else {
                continue;
            };
            let wc_id = host.view_id(view);
            if host.family_is_dirty(TabKind::Hwp, wc_id) || host.hwp_memo_modal_open(wc_id) {
                out.push((t.id.clone(), view.clone()));
            }
        }
        out
    }

    /// `docsTabs`, `slidesTabs` and `sheetsTabs`: all live tabs of `kind`
    pub fn live_tabs(&self, kind: TabKind) -> Vec<(String, V)> {
        self.tabs
            .iter()
            .filter(|t| t.kind == kind)
            .filter_map(|t| t.view.as_ref().map(|v| (t.id.clone(), v.clone())))
            .collect()
    }

    // ---- closing ----

    /// `closingIds.has(id)`: a close of the tab is waiting on an answer
    fn is_closing(&self, id: &str) -> bool {
        self.pending_closes.iter().any(|(closing, _)| closing == id)
    }

    /// `closeActiveTab`: `closeTab` of the active tab (no-op for Home)
    pub fn close_active_tab(&mut self, host: &mut dyn TabHost<V>) -> TabCloseStep<V> {
        let id = self.active_id.clone();
        self.close_tab(host, &id)
    }

    /// `closeTab`: runs the family's unsaved-changes prompt when the tab is
    /// dirty. The awaits are steps: see [`TabCloseStep`]; a run that needs
    /// none ends in [`TabCloseStep::Done`] at once.
    pub fn close_tab(&mut self, host: &mut dyn TabHost<V>, id: &str) -> TabCloseStep<V> {
        if id == HOME_ID {
            return TabCloseStep::Done;
        }
        let Some(index) = self.index_of(id) else {
            return TabCloseStep::Done;
        };
        if self.is_closing(id) {
            return TabCloseStep::Done;
        }
        let kind = self.tabs[index].kind;
        let view = self.tabs[index].view.clone();
        let mut close_guard: Option<TabKind> = None;
        if let Some(view) = &view {
            let wc_id = host.view_id(view);
            let ask = match kind {
                TabKind::Sheets => host.sheets_pending_edit_count(wc_id) > 0.0,
                TabKind::Pdf | TabKind::Markdown | TabKind::Html | TabKind::Slides => {
                    host.family_is_dirty(kind, wc_id)
                }
                TabKind::Hwp => {
                    host.family_is_dirty(kind, wc_id) || host.hwp_memo_modal_open(wc_id)
                }
                _ => false,
            };
            if ask {
                close_guard = Some(kind);
            }
            if close_guard.is_none()
                && kind == TabKind::Mindmap
                && host.family_is_dirty(kind, wc_id)
            {
                close_guard = Some(kind);
            }
            if close_guard.is_none() && kind == TabKind::Epub && host.family_is_dirty(kind, wc_id) {
                close_guard = Some(kind);
            }
            if close_guard.is_none()
                && kind == TabKind::Diagram
                && host.family_is_dirty(kind, wc_id)
            {
                close_guard = Some(kind);
            }
        }
        // docs dirty state lives in the renderer and needs an async query; skip
        // the guard when clean (avoids a flash activation)
        if close_guard.is_none()
            && kind == TabKind::Docs
            && let Some(view) = &view
        {
            self.pending_closes
                .push((id.to_owned(), ClosePhase::Query { view: view.clone() }));
            return TabCloseStep::QueryDocsDirty {
                id: id.to_owned(),
                view: view.clone(),
            };
        }
        if let (Some(guard), Some(view)) = (close_guard, view) {
            return self.begin_close_prompt(host, id, guard, view);
        }
        self.remove_tab(host, id);
        TabCloseStep::Done
    }

    /// the answer of the step [`TabManager::close_tab`] last gave for `id`;
    /// `Err` is what the awaited call rejected with. A call for a tab with no
    /// open step ends at once.
    pub fn resume_close(
        &mut self,
        host: &mut dyn TabHost<V>,
        id: &str,
        answer: Result<bool, String>,
    ) -> TabCloseStep<V> {
        let Some(at) = self
            .pending_closes
            .iter()
            .position(|(closing, _)| closing == id)
        else {
            return TabCloseStep::Done;
        };
        let (_, phase) = self.pending_closes.remove(at);
        match phase {
            ClosePhase::Query { view } => match answer {
                Err(message) => TabCloseStep::Rejected(message),
                Ok(true) => self.begin_close_prompt(host, id, TabKind::Docs, view),
                Ok(false) => {
                    self.remove_tab(host, id);
                    TabCloseStep::Done
                }
            },
            ClosePhase::Prompt => {
                self.end_exclusive_prompt(host);
                match answer {
                    Err(message) => TabCloseStep::Rejected(message),
                    Ok(false) => TabCloseStep::Done,
                    Ok(true) => {
                        self.remove_tab(host, id);
                        TabCloseStep::Done
                    }
                }
            }
        }
    }

    /// Bring the tab into view for the prompt, and put the arrangement back
    /// exactly as it was afterwards (`resume_close` does that).
    fn begin_close_prompt(
        &mut self,
        host: &mut dyn TabHost<V>,
        id: &str,
        kind: TabKind,
        view: V,
    ) -> TabCloseStep<V> {
        self.begin_exclusive_prompt();
        if self.active_id != id {
            self.activate_tab(host, id);
        }
        self.pending_closes
            .push((id.to_owned(), ClosePhase::Prompt));
        TabCloseStep::RequestClose {
            id: id.to_owned(),
            kind,
            view,
        }
    }

    /// `closeTabWithoutPrompt`: false when there is no such tab or one is
    /// mid-prompt, or an open memo editor would lose its text
    pub fn close_tab_without_prompt(&mut self, host: &mut dyn TabHost<V>, id: &str) -> bool {
        if id == HOME_ID {
            return false;
        }
        let Some(index) = self.index_of(id) else {
            return false;
        };
        if self.is_closing(id) {
            return false;
        }
        // a memo editor's text is not in the document yet: a promptless close
        // must not drop it
        if self.tabs[index].kind == TabKind::Hwp
            && let Some(view) = self.tabs[index].view.clone()
            && !host.view_destroyed(&view)
        {
            let wc_id = host.view_id(&view);
            if host.hwp_memo_modal_open(wc_id) {
                return false;
            }
        }
        self.remove_tab(host, id);
        true
    }

    /// detach and drop one tab and re-activate a neighbour (no guards, no prompts)
    fn remove_tab(&mut self, host: &mut dyn TabHost<V>, id: &str) {
        let Some(idx) = self.index_of(id) else {
            return;
        };
        if self.html_full_screen_id.as_deref() == Some(id) {
            self.html_full_screen_id = None;
        }
        let removed = self.tabs.remove(idx);
        if truthy_opt(&removed.file_path) && !removed.present {
            host.on_tab_closed(
                removed.kind,
                removed.file_path.as_deref().unwrap_or_default(),
            );
        }
        self.after_leaving_strip(host, id, idx);
        if let Some(view) = &removed.view {
            // a generate request the tab never took goes with the tab
            let wc_id = host.view_id(view);
            host.drop_generate_handoff(wc_id);
            host.set_visible(view, false);
            host.remove_child_view(view);
            if removed.kind == TabKind::Docs {
                // the view is only detached here: its renderer process is
                // ended, and the webContents is destroyed once that process
                // is gone
                host.teardown_docs_renderer(view);
                host.release_closed_renderer(view);
            } else {
                host.close_view(view);
            }
        }
    }

    /// what `removeTab` and `detachTab` do after the tab left the list: the
    /// split drops, or the neighbour takes over
    fn after_leaving_strip(&mut self, host: &mut dyn TabHost<V>, id: &str, idx: usize) {
        let survivor = self
            .split
            .as_ref()
            .and_then(|s| split_survivor(&s.a_tab_id, &s.b_tab_id, id))
            .map(|(_, tab_id)| tab_id.to_owned());
        if let Some(survivor) = survivor {
            // removing a pane document drops the split; the other pane's
            // document takes the whole window (or stays backgrounded under a
            // cover tab)
            self.split = None;
            if self.active_id == id && self.tabs.iter().any(|t| t.id == survivor) {
                self.activate_tab(host, &survivor);
            } else {
                self.layout(host);
                self.refresh_active_targets(host);
                host.on_changed();
            }
            self.notify_split_changed(host);
        } else if self.active_id == id {
            let before = if idx >= 1 {
                self.tabs.get(idx - 1)
            } else {
                None
            };
            let fallback = before.or_else(|| self.tabs.first()).map(|t| t.id.clone());
            if let Some(fallback) = fallback {
                self.activate_tab(host, &fallback);
            }
        } else {
            host.on_changed();
        }
    }

    // ---- detach and attach ----

    /// `detachTab`: remove a tab from the strip WITHOUT destroying its view
    /// and hand it to the caller; `None` while a close prompt is pending on it
    pub fn detach_tab(&mut self, host: &mut dyn TabHost<V>, id: &str) -> Option<DetachedTab<V>> {
        if id == HOME_ID {
            return None;
        }
        let idx = self.index_of(id)?;
        {
            let tab = &self.tabs[idx];
            if tab.present || self.is_closing(id) {
                return None;
            }
        }
        // an unloaded tab leaves with a live document: it loads first
        if !self.load_tab(host, id) || self.tabs[idx].view.is_none() {
            return None;
        }
        let tab = self.tabs.remove(idx);
        if self.html_full_screen_id.as_deref() == Some(id) {
            self.html_full_screen_id = None;
        }
        let view = tab.view.clone()?;
        host.set_visible(&view, false);
        host.remove_child_view(&view);
        self.after_leaving_strip(host, id, idx);
        Some(DetachedTab {
            view,
            kind: tab.kind,
            title: tab.title,
            file_path: tab.file_path,
        })
    }

    /// `canDetachTab`
    pub fn can_detach_tab(&self, id: &str) -> bool {
        self.tab_by_id(id).is_some_and(|t| {
            (t.view.is_some() || t.opener.is_some()) && !t.present && !self.is_closing(id)
        })
    }

    /// `attachTab`: a live view coming back from a detached window becomes a
    /// tab again at `index` (Home stays pinned at 0, an out-of-range or
    /// omitted index appends); with `activate` false the tab comes back quietly
    pub fn attach_tab(
        &mut self,
        host: &mut dyn TabHost<V>,
        record: DetachedTab<V>,
        index: Option<f64>,
        activate: bool,
    ) -> String {
        let id = self.alloc_id();
        let DetachedTab {
            view,
            kind,
            title,
            file_path,
        } = record;
        Self::add_hidden(host, &view);
        self.track_html_full_screen(host, &view);
        self.track_pane_focus(host, &view);
        let len = self.tabs.len();
        let slot = match index {
            Some(index) if index.is_finite() => {
                math_min(math_max(index.trunc(), 1.0), len as f64) as usize
            }
            _ => len,
        };
        self.tabs.insert(
            slot,
            TabRecord {
                id: id.clone(),
                kind,
                view: Some(view),
                title,
                file_path,
                present: false,
                opener: None,
                lazy: None,
            },
        );
        if activate {
            self.activate_tab(host, &id);
        } else {
            host.on_changed();
        }
        id
    }

    // ---- finding tabs ----

    fn live(&self, index: usize) -> Option<LiveTab<V>> {
        let tab = &self.tabs[index];
        tab.view.as_ref().map(|view| LiveTab {
            id: tab.id.clone(),
            kind: tab.kind,
            view: view.clone(),
            file_path: tab.file_path.clone(),
        })
    }

    /// `findTabByPath`: the editor tab showing this file, whichever module
    /// owns it; an unloaded tab for the file is loaded so its view can be
    /// handed out
    pub fn find_tab_by_path(
        &mut self,
        host: &mut dyn TabHost<V>,
        path: Option<&str>,
    ) -> Option<LiveTab<V>> {
        let wanted = canonical_path(path);
        let found = self.tabs.iter().position(|t| {
            (t.view.is_some() || t.opener.is_some())
                && truthy_opt(&t.file_path)
                && !t.present
                && canonical_path(t.file_path.as_deref()) == wanted
        })?;
        let id = self.tabs[found].id.clone();
        if !self.load_tab(host, &id) {
            return None;
        }
        self.live(found)
    }

    /// `findTabOfKindByPath`: the tab of this kind for the file, an unloaded
    /// one too, so the caller's activate loads it
    pub fn find_tab_of_kind_by_path(&self, kind: TabKind, path: Option<&str>) -> Option<String> {
        let wanted = canonical_path(path);
        self.tabs
            .iter()
            .find(|t| {
                t.kind == kind
                    && (t.view.is_some() || t.opener.is_some())
                    && truthy_opt(&t.file_path)
                    && !t.present
                    && canonical_path(t.file_path.as_deref()) == wanted
            })
            .map(|t| t.id.clone())
    }

    /// `findSheetsTab`: any sheets tab
    pub fn find_sheets_tab(&self) -> Option<String> {
        self.tabs
            .iter()
            .find(|t| t.kind == TabKind::Sheets)
            .map(|t| t.id.clone())
    }

    /// `findDiagramTabByPath`: the diagram tab showing this file, or the Visio
    /// drawing an untitled tab was made from
    pub fn find_diagram_tab_by_path(
        &self,
        host: &mut dyn TabHost<V>,
        path: Option<&str>,
    ) -> Option<String> {
        if let Some(own) = self.find_tab_of_kind_by_path(TabKind::Diagram, path) {
            return Some(own);
        }
        let wanted = canonical_path(path)?;
        for t in &self.tabs {
            if t.kind != TabKind::Diagram || t.present {
                continue;
            }
            let Some(view) = &t.view else {
                continue;
            };
            if host.view_destroyed(view) {
                continue;
            }
            let wc_id = host.view_id(view);
            let source = host
                .diagram_tab_identity(wc_id)
                .and_then(|identity| identity.source_path);
            if let Some(source) = truthy(source.as_deref())
                && canonical_path(Some(source)).as_deref() == Some(wanted.as_str())
            {
                return Some(t.id.clone());
            }
        }
        None
    }

    /// `activeMindmapTab`, `activeEpubTab`, `activeDiagramTab`, `activeHwpTab`,
    /// `activeHtmlTab`, `activeMarkdownTab` and `activePdfTab`: the active
    /// tab's view when the active tab is of `kind` (a Present tab is no html
    /// menu target)
    pub fn active_tab_of_kind(&self, kind: TabKind) -> Option<LiveTab<V>> {
        let index = self.index_of(&self.active_id)?;
        let tab = &self.tabs[index];
        if tab.kind != kind || tab.view.is_none() {
            return None;
        }
        if kind == TabKind::Html && tab.present {
            return None;
        }
        self.live(index)
    }
}

impl<V: Clone + PartialEq> Default for TabManager<V> {
    fn default() -> Self {
        TabManager::new()
    }
}

/// `createPlainEditorView`: the editor view a plain open of `file_path`
/// makes, without adding a tab; the opener of a document that has no
/// recovery copy to settle
pub fn create_plain_editor_view<V: Clone + PartialEq>(
    host: &mut dyn TabHost<V>,
    kind: TabKind,
    file_path: Option<&str>,
) -> TabResult<V> {
    match kind {
        TabKind::Docs => host.create_view(&ViewSpec::Docs { path: file_path }),
        TabKind::Sheets => {
            let view = host.create_view(&ViewSpec::Sheets {
                opening_workbook: Some(truthy(file_path).is_some()),
            })?;
            if let Some(path) = truthy(file_path) {
                host.queue_workbook_for_view(&view, path);
            }
            Ok(view)
        }
        TabKind::Slides => host.create_view(&ViewSpec::Slides { path: file_path }),
        TabKind::Pdf => match truthy(file_path) {
            Some(path) => host.create_view(&ViewSpec::Pdf { path }),
            None => Err(TabError("a PDF tab needs its file".to_owned())),
        },
        TabKind::Markdown => host.create_view(&ViewSpec::Markdown { path: file_path }),
        TabKind::Html => host.create_view(&ViewSpec::Html { path: file_path }),
        TabKind::Mindmap => host.create_view(&ViewSpec::Mindmap { path: file_path }),
        TabKind::Hwp => host.create_view(&ViewSpec::Hwp {
            path: file_path,
            untitled_copy: HwpUntitledCopy::Flag(false),
        }),
        TabKind::Epub => match truthy(file_path) {
            Some(path) => host.create_view(&ViewSpec::Epub { path }),
            None => Err(TabError("an EPUB tab needs its file".to_owned())),
        },
        TabKind::Diagram => host.create_view(&ViewSpec::Diagram { path: file_path }),
        TabKind::Home | TabKind::Help => Err(TabError("not a document tab".to_owned())),
    }
}

/// `canonicalPath`: the path after resolving links, or as given when it
/// cannot be resolved
pub fn canonical_path(path: Option<&str>) -> Option<String> {
    let path = path?;
    match std::fs::canonicalize(namespaced(path)) {
        Ok(real) => {
            let text = real.to_string_lossy().into_owned();
            // the verbatim form std gives on Windows is not what Node's realpath answers
            #[cfg(windows)]
            if let Some(plain) = text.strip_prefix(r"\\?\")
                && !plain.starts_with("UNC\\")
            {
                return Some(plain.to_owned());
            }
            Some(text)
        }
        Err(_) => Some(path.to_owned()),
    }
}

/// `helpTopicParam`: a topic id the manual's URL may carry (the registry's id
/// shape), `None` for anything else
pub fn help_topic_param(topic: Option<&str>) -> Option<&str> {
    topic.filter(|topic| js_regex!(r"^[a-z0-9-]{1,64}$").test(topic))
}

/// `helpViewUrl`: the manual's URL, at one topic when given; `dev_url` is
/// `process.env.ELECTRON_RENDERER_URL`
pub fn help_view_url(
    dev_url: Option<&str>,
    topic: Option<&str>,
) -> Result<String, RendererUrlError> {
    let mut query = vec![("mode".to_owned(), "help".to_owned())];
    if let Some(wanted) = help_topic_param(topic) {
        query.push(("topic".to_owned(), wanted.to_owned()));
    }
    renderer_url(dev_url, "help", &query)
}

/// the manual's window-open handler: an external URL on the allowlist opens
/// in the browser, and the window itself is always denied (`"deny"`)
pub fn help_window_open(url: &str, open_external: &mut dyn FnMut(&str)) -> &'static str {
    if let Some(target) = safe_external_url(Some(url), None) {
        open_external(&target);
    }
    "deny"
}
