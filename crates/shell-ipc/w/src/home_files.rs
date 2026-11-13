//! `home:*` files and folders: recents, starred files and groups, the file
//! search, open, reveal, move, rename, duplicate and delete, and the folder
//! tree with its roots (`apps/shell/src/main/index.ts` `registerHomeIpc`, and
//! the modules it calls: recent-files, file-targets, folder-roots,
//! rename-validation, the starred store and the recents list of docs-main).
//!
//! What lives outside `main-core` today is behind four hosts of this batch:
//! [`HomeFiles`] (the tabs, projects and other areas that key on a path),
//! [`FileSearch`] (the file index) and [`FolderWatch`] (the recursive watcher
//! of the tree's roots).

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use jscompat::node_path::host::{basename, dirname, join, resolve};
use jscompat::{JsObject, JsTypeError, JsonValue, json_parse, number_to_string, slice_utf16, trim};
use main_core::docs::starred_files::{
    StarredItem, assign_starred_group, drop_starred_items, read_starred_items, rename_starred_item,
    starred_group_map, starred_group_names, toggle_starred_item, write_starred_items,
};
use main_core::node_fs::NodeError;
use main_core::packages::electron_utils::atomic_write::write_json_atomic;
use main_core::packages::electron_utils::default_save_dir::{
    PathProvider, SaveDirState, Thrown as SaveDirThrown, configured_default_save_dir,
    default_save_dir_fallback,
};
use main_core::packages::electron_utils::dialog_memory::{
    Dialog, DialogMemory, show_open_dialog_with_memory,
};
use main_core::packages::electron_utils::message_box::ParentWindow;
use main_core::packages::i18n::{Lang, install_lang, normalize_lang};
use main_core::shell::app_routing::rename_stays_in_app;
use main_core::shell::app_settings::{read_app_settings, write_app_setting};
use main_core::shell::error_dialog::{ErrorDialog, ErrorValue};
use main_core::shell::file_targets::{
    FileTargetSources, MoveSourceSources, is_move_source, is_user_visible_file,
};
use main_core::shell::folder_roots::{
    FOLDER_ROOTS_KEY, FolderRoot, describe_extra_root, read_extra_roots, with_extra_root,
    without_extra_root,
};
use main_core::shell::folder_tree::{
    FolderErrors, FolderListing, MoveConflictPolicy, MoveFailure, MoveOptions, MoveResult, Moved,
    RenameResult, ReplacedItem, Thrown, create_folder, describe_root, is_inside_root, list_folder,
    move_paths_into, paths_under, rebase_path, rename_folder,
};
use main_core::shell::recent_files::{
    RecentEntry, cap_stat_paths, matches_ext_family, normalize_recent_query, page_recent_paths,
    stat_path_entries_async,
};
use main_core::shell::rename_validation::{is_same_file, is_valid_raw_rename_name};
use main_core::shell::tab_duplicate::{DuplicateFileDeps, duplicate_document_file};
use shell_contract::error::IpcError;
use shell_contract::hosts::{FileDialog, FileFilter, MessageBox as MessageBoxOptions};
use shell_contract::ipc::{CallContext, RegisterError};
use shell_contract::ipc::{ChannelKind, EventSink, Handler, Registry, Responder, Target};
use shell_contract::provided::Provided;
use shell_contract::runtime::{AppPaths, PathName, Services};
use shell_contract::slides::SlidesTemplateSelectionHooks;
use shell_contract::{Batch, DialogsHost, IpcValue, MainWindowHost, OsShellHost, WindowId};

use crate::handle;

// ---- hosts -----------------------------------------------------------------

/// What the other areas hold or do about a file path
pub trait HomeFiles: Send + Sync {
    /// `Date.now()`
    fn now_ms(&self) -> f64;
    /// `app.getLocale()`
    fn system_locale(&self) -> String;
    /// `openDocumentPath(path)`: the File > Open pipeline; `false` when
    /// nothing opened
    fn open_document_path(&self, path: &str) -> bool;
    /// `handleDroppedFiles(paths, droppedFilesDeps())`
    fn open_dropped_files(&self, paths: Vec<String>);
    /// `[...tabManager.openFilePaths(), ...detachedFilePaths()]`
    fn open_file_paths(&self) -> Vec<String>;
    /// `projectFilePaths()`
    fn project_file_paths(&self) -> Vec<String>;
    /// `readSlidesRecentFiles()`
    fn slides_recent_files(&self) -> Vec<String>;
    /// `documentLinkPaths()`
    fn document_link_paths(&self) -> Vec<String>;
    /// `projectFileRenamed(old, new)`
    fn project_file_renamed(&self, old_path: &str, new_path: &str);
    /// The rest of `afterFileMoved` after the project store and the template
    /// selection hook: `documentLinkFileMoved`, the slides recent list of a
    /// .pptx, and the open tabs and detached windows of the file with the
    /// editors that show them told (`*FileRenamed`)
    fn file_moved(&self, old_path: &str, new_path: &str);
    /// `buildDocsMenu()`: File > Open Recent follows recent.json
    fn recents_changed(&self);
    /// `spawn('explorer.exe', ['shell:RecycleBin'])`, Windows only
    fn open_recycle_bin(&self);
}

pub type HomeFilesHost = Arc<dyn HomeFiles>;

/// One hit as the file index answers it: the keys of `FileSearchHit` in
/// order, `path` among them
#[derive(Clone, Debug, PartialEq)]
pub struct SearchHit(pub Vec<(String, IpcValue)>);

/// `{ hits, total }` of `FileIndexStore.search`
#[derive(Clone, Debug, PartialEq)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub total: f64,
}

/// `IndexProgress`
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IndexProgress {
    pub indexed: f64,
    pub pending: f64,
    pub scanning: bool,
}

/// `fileIndexStore` and `fileIndexer` of index.ts (the file index is not in
/// `main-core` yet)
pub trait FileSearch: Send + Sync {
    /// `ensureFileIndexer() !== null`: creates the store and the indexer on
    /// the first call; `false` when the store cannot open
    fn available(&self) -> bool;
    /// `fileIndexer.refreshIfStale(maxAgeMs)`
    fn refresh_if_stale(&self, max_age_ms: f64);
    /// `fileIndexer?.refresh()`: nothing when the indexer was never created
    fn refresh(&self);
    /// `fileIndexStore.search(q, { exts, offset, limit })`
    fn search(&self, q: &str, exts: Option<&[String]>, offset: f64, limit: f64) -> SearchResult;
    /// `fileIndexer.progress()`
    fn progress(&self) -> IndexProgress;
    /// `searchReranker.rerank(q, fileIndexStore.pathsIndexedAsOnDisk(paths), settings)`
    /// with the saved file search settings; blocks (the network)
    fn rerank(&self, q: &str, paths: &[String]) -> Option<IpcValue>;
}

pub type FileSearchHost = Arc<dyn FileSearch>;

/// The recursive watcher of the tree's roots (`ensureFolderWatchers`)
pub trait FolderWatch: Send + Sync {
    /// Watch exactly `roots`: a watcher of any other root closes, a root
    /// with no live watcher gets one. `changed` is called, from any thread,
    /// with the folders whose direct contents changed (debounced).
    fn watch(&self, roots: &[String], changed: Arc<dyn Fn(Vec<String>) + Send + Sync>);
}

pub type FolderWatchHost = Arc<dyn FolderWatch>;

// ---- messages --------------------------------------------------------------

/// The texts of `tMain` this module uses (index.ts), by key
#[derive(Clone, Copy)]
enum Msg {
    BadArgs,
    BadName,
    BadExtension,
    Missing,
    Exists,
    RenameFailed,
    DlgOpenTitle,
    FilterSupported,
    FilterWord,
    FilterOdt,
    FilterExcel,
    FilterPpt,
    FilterPdf,
    FilterMarkdown,
    FilterHtml,
    FilterMindmap,
    FilterHwp,
    FilterEpub,
    FilterDiagram,
    DlgAddFolderRoot,
    FolderRootUnusable,
    CopySuffix,
    DuplicateFailed,
    SaveDirFallbackTitle,
    SaveDirFallbackDetail,
}

fn tm(lang: Lang, key: Msg) -> &'static str {
    let ko = lang == Lang::Ko;
    match key {
        Msg::BadArgs if ko => "잘못된 인수입니다",
        Msg::BadArgs => "Invalid arguments",
        Msg::BadName if ko => "파일 이름이 잘못되었습니다",
        Msg::BadName => "Invalid file name",
        Msg::BadExtension if ko => "지원하지 않는 확장자이며 파일을 열 수 없게 됩니다",
        Msg::BadExtension => "That extension is not supported, and the file would no longer open",
        Msg::Missing if ko => "파일을 찾을 수 없습니다",
        Msg::Missing => "File not found",
        Msg::Exists if ko => "같은 이름의 파일이 이미 있습니다",
        Msg::Exists => "A file with that name already exists",
        Msg::RenameFailed if ko => "이름 바꾸기에 실패했습니다",
        Msg::RenameFailed => "Rename failed",
        Msg::DlgOpenTitle if ko => "파일 열기",
        Msg::DlgOpenTitle => "Open File",
        Msg::FilterSupported if ko => "지원되는 파일",
        Msg::FilterSupported => "Supported Files",
        Msg::FilterWord if ko => "Word 문서",
        Msg::FilterWord => "Word Documents",
        Msg::FilterOdt if ko => "OpenDocument 텍스트",
        Msg::FilterOdt => "OpenDocument Text",
        Msg::FilterExcel if ko => "Excel 통합 문서",
        Msg::FilterExcel => "Excel Workbooks",
        Msg::FilterPpt if ko => "PowerPoint 프레젠테이션",
        Msg::FilterPpt => "PowerPoint Presentations",
        Msg::FilterPdf if ko => "PDF 문서",
        Msg::FilterPdf => "PDF Documents",
        Msg::FilterMarkdown if ko => "텍스트 파일 (Markdown, TXT, JSON)",
        Msg::FilterMarkdown => "Text Files (Markdown, TXT, JSON)",
        Msg::FilterHtml if ko => "HTML 문서",
        Msg::FilterHtml => "HTML Documents",
        Msg::FilterMindmap if ko => "마인드맵 (XMind, FreeMind, Freeplane)",
        Msg::FilterMindmap => "Mind Maps (XMind, FreeMind, Freeplane)",
        Msg::FilterHwp if ko => "한글 문서 (HWP, HWPX)",
        Msg::FilterHwp => "HWP Documents (HWP, HWPX)",
        Msg::FilterEpub if ko => "전자책 (EPUB)",
        Msg::FilterEpub => "E-books (EPUB)",
        Msg::FilterDiagram if ko => "다이어그램 (draw.io, VSDX)",
        Msg::FilterDiagram => "Diagrams (draw.io, VSDX)",
        Msg::DlgAddFolderRoot if ko => "홈에 폴더 추가",
        Msg::DlgAddFolderRoot => "Add Folder to Home",
        Msg::FolderRootUnusable if ko => "선택한 폴더를 읽을 수 없습니다",
        Msg::FolderRootUnusable => "The selected folder cannot be read",
        Msg::CopySuffix if ko => "복사본",
        Msg::CopySuffix => "copy",
        Msg::DuplicateFailed if ko => "파일을 복제할 수 없습니다",
        Msg::DuplicateFailed => "Could not duplicate the file",
        Msg::SaveDirFallbackTitle if ko => "문서 폴더에 저장할 수 없습니다",
        Msg::SaveDirFallbackTitle => "Can't save to the Documents folder",
        Msg::SaveDirFallbackDetail if ko => {
            "{blocked} 폴더를 만들거나 쓰지 못해서, 새 파일은 {using}에 저장합니다. Windows 보안의 \"제어된 폴더 액세스\"가 막은 것이라면 \"제어된 폴더 액세스를 통해 앱 허용\"에 SeuOffice를 추가한 뒤 앱을 다시 시작하세요. 설정 → 일반 → 저장 위치에서 다른 폴더를 고를 수도 있습니다."
        }
        Msg::SaveDirFallbackDetail => {
            "SeuOffice could not create or write {blocked}, so new files are saved in {using}. If Windows Security's \"Controlled folder access\" blocked it, add SeuOffice under \"Allow an app through Controlled folder access\" and restart the app. You can also pick another folder in Settings → General → Save Location."
        }
    }
}

/// `OPEN_DIALOG_EXTENSIONS`
const OPEN_DIALOG_EXTENSIONS: &[&str] = &[
    "docx",
    "doc",
    "dot",
    "odt",
    "xlsx",
    "xlsm",
    "xls",
    "csv",
    "tsv",
    "ods",
    "pptx",
    "ppt",
    "odp",
    "otp",
    "pdf",
    "md",
    "markdown",
    "txt",
    "json",
    "html",
    "htm",
    "xmind",
    "mm",
    "hwp",
    "hwpx",
    "epub",
    "drawio",
    "dio",
    "drawio.svg",
    "drawio.png",
    "vsdx",
];

// ---- values ----------------------------------------------------------------

fn text(s: impl Into<String>) -> IpcValue {
    IpcValue::String(s.into())
}

fn object(entries: Vec<(&str, IpcValue)>) -> IpcValue {
    IpcValue::Object(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
    )
}

fn strings(list: &[String]) -> IpcValue {
    IpcValue::Array(list.iter().map(|s| text(s.clone())).collect())
}

fn error(message: impl Into<String>) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: message.into(),
    }
}

fn node_error(e: NodeError) -> IpcError {
    error(e.message)
}

fn type_error(e: JsTypeError) -> IpcError {
    IpcError {
        name: Some("TypeError".into()),
        message: e.0,
    }
}

/// `typeof value === 'string'`
fn as_str(value: Option<&IpcValue>) -> Option<&str> {
    match value {
        Some(IpcValue::String(s)) => Some(s),
        _ => None,
    }
}

/// `stringPaths(value)`: the strings of an array, `[]` for anything else
fn string_paths(value: Option<&IpcValue>) -> Vec<String> {
    match value {
        Some(IpcValue::Array(items)) => items
            .iter()
            .filter_map(|v| match v {
                IpcValue::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `value && typeof value === 'object'`
fn is_object(value: Option<&IpcValue>) -> bool {
    matches!(
        value,
        Some(IpcValue::Object(_) | IpcValue::Array(_) | IpcValue::Bytes(..) | IpcValue::Date(_))
    )
}

fn field<'a>(value: Option<&'a IpcValue>, key: &str) -> Option<&'a IpcValue> {
    match value {
        Some(IpcValue::Object(entries)) => {
            entries.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v)
        }
        _ => None,
    }
}

/// The value as a parsed JSON value, for the `main-core` functions that read
/// a renderer's object as `unknown`. `undefined` is `None`; the types JSON
/// has no word for read as what `Number(...)` and `typeof` make of them.
fn to_json(value: Option<&IpcValue>) -> Option<JsonValue> {
    Some(match value? {
        IpcValue::Undefined => return None,
        IpcValue::Null => JsonValue::Null,
        IpcValue::Bool(b) => JsonValue::Bool(*b),
        IpcValue::Number(n) => JsonValue::Number(*n),
        IpcValue::String(s) => JsonValue::String(s.clone()),
        IpcValue::Date(ms) => JsonValue::Number(*ms),
        IpcValue::Bytes(..) => JsonValue::Object(JsObject::new()),
        IpcValue::Array(items) => JsonValue::Array(
            items
                .iter()
                .map(|v| to_json(Some(v)).unwrap_or(JsonValue::Null))
                .collect(),
        ),
        IpcValue::Object(entries) => {
            let mut object = JsObject::new();
            for (k, v) in entries {
                if let Some(v) = to_json(Some(v)) {
                    object.set(k.as_str(), v);
                }
            }
            JsonValue::Object(object)
        }
    })
}

/// `String(value)` of a value the renderer sent
fn js_string(value: Option<&IpcValue>) -> String {
    match value {
        None | Some(IpcValue::Undefined) => "undefined".into(),
        Some(IpcValue::Null) => "null".into(),
        Some(IpcValue::Bool(b)) => b.to_string(),
        Some(IpcValue::Number(n)) => number_to_string(*n),
        Some(IpcValue::String(s)) => s.clone(),
        Some(IpcValue::Array(items)) => items
            .iter()
            .map(|v| match v {
                IpcValue::Undefined | IpcValue::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(IpcValue::Bytes(..)) => "[object ArrayBuffer]".into(),
        Some(IpcValue::Date(_)) => "Invalid Date".into(),
        Some(IpcValue::Object(_)) => "[object Object]".into(),
    }
}

fn entry_to_ipc(entry: &RecentEntry, group: Option<&str>) -> IpcValue {
    let mut fields = vec![
        ("path", text(entry.path.clone())),
        ("name", text(entry.name.clone())),
        ("ext", text(entry.ext.clone())),
        ("mtimeMs", IpcValue::Number(entry.mtime_ms)),
        ("sizeBytes", IpcValue::Number(entry.size_bytes as f64)),
        ("starred", IpcValue::Bool(entry.starred)),
    ];
    if entry.missing {
        fields.push(("missing", IpcValue::Bool(true)));
    }
    if let Some(group) = group {
        fields.push(("group", text(group)));
    }
    object(fields)
}

fn page_to_ipc(entries: Vec<IpcValue>, total: usize, total_all: usize) -> IpcValue {
    object(vec![
        ("entries", IpcValue::Array(entries)),
        ("total", IpcValue::Number(total as f64)),
        ("totalAll", IpcValue::Number(total_all as f64)),
    ])
}

fn root_to_ipc(root: &FolderRoot) -> IpcValue {
    object(vec![
        ("path", text(root.path.clone())),
        ("name", text(root.name.clone())),
        ("usable", IpcValue::Bool(root.usable)),
        ("readable", IpcValue::Bool(root.readable)),
        ("removable", IpcValue::Bool(root.removable)),
    ])
}

fn rename_result_to_ipc(r: &RenameResult) -> IpcValue {
    let mut fields = vec![("ok", IpcValue::Bool(r.ok))];
    if let Some(path) = &r.path {
        fields.push(("path", text(path.clone())));
    }
    if let Some(e) = &r.error {
        fields.push(("error", text(e.clone())));
    }
    object(fields)
}

fn failed(error: &str) -> IpcValue {
    rename_result_to_ipc(&RenameResult {
        ok: false,
        path: None,
        error: Some(error.to_owned()),
    })
}

fn listing_to_ipc(l: &FolderListing) -> IpcValue {
    let mut fields = vec![
        ("dir", text(l.dir.clone())),
        (
            "folders",
            IpcValue::Array(
                l.folders
                    .iter()
                    .map(|f| {
                        object(vec![
                            ("path", text(f.path.clone())),
                            ("name", text(f.name.clone())),
                            ("mtimeMs", IpcValue::Number(f.mtime_ms)),
                            ("hasSubfolders", IpcValue::Bool(f.has_subfolders)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "files",
            IpcValue::Array(l.files.iter().map(|e| entry_to_ipc(e, None)).collect()),
        ),
    ];
    if let Some(missing) = l.missing {
        fields.push(("missing", IpcValue::Bool(missing)));
    }
    object(fields)
}

fn move_result_to_ipc(r: &MoveResult) -> IpcValue {
    object(vec![
        (
            "moved",
            IpcValue::Array(
                r.moved
                    .iter()
                    .map(|m| {
                        object(vec![
                            ("from", text(m.from.clone())),
                            ("to", text(m.to.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("conflicts", strings(&r.conflicts)),
        (
            "failed",
            IpcValue::Array(
                r.failed
                    .iter()
                    .map(|f| {
                        object(vec![
                            ("path", text(f.path.clone())),
                            ("error", text(f.error.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
}

// ---- file system helpers (folder-tree.ts, small and pure) -------------------

fn exists_sync(path: &str) -> bool {
    Path::new(path).exists()
}

// ---- recents and starred (docs-main) ----------------------------------------

/// `RECENT_LIMIT`
const RECENT_LIMIT: usize = 100;

/// `readJson<string[]>(RECENT_PATH(), [])`: a missing or corrupt file is
/// empty; what is not a string is dropped
fn read_recent(path: &str) -> Vec<String> {
    if !exists_sync(path) {
        return Vec::new();
    }
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    match json_parse(&String::from_utf8_lossy(&bytes)) {
        Ok(JsonValue::Array(items)) => items
            .into_iter()
            .filter_map(|v| match v {
                JsonValue::String(s) => Some(s),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn write_recent(path: &str, list: Vec<String>) -> Result<(), NodeError> {
    write_json_atomic(
        path,
        &JsonValue::Array(list.into_iter().map(JsonValue::String).collect()),
    )
}

// ---- the module's state -----------------------------------------------------

/// What every handler of this module shares; lives on the core thread
struct Home {
    settings_path: String,
    recent_path: String,
    starred_path: String,
    paths: Arc<dyn AppPaths>,
    events: Arc<dyn EventSink>,
    workers: Arc<dyn shell_contract::runtime::Workers>,
    host: HomeFilesHost,
    search: FileSearchHost,
    watch: FolderWatchHost,
    dialogs: DialogsHost,
    os: OsShellHost,
    main_window: MainWindowHost,
    provided: Rc<Provided>,
    save_dir: RefCell<SaveDirState>,
    save_dir_noticed: Cell<bool>,
    dialog_memory: RefCell<DialogMemory>,
    error_dialog: RefCell<ErrorDialog>,
}

/// `app.getPath` for `default-save-dir.ts`
struct Paths<'a>(&'a dyn AppPaths);

impl PathProvider for Paths<'_> {
    fn get_path(&self, name: &str) -> Result<String, SaveDirThrown> {
        let name = match name {
            "home" => PathName::Home,
            "documents" => PathName::Documents,
            _ => PathName::UserData,
        };
        Ok(self.0.path(name).to_string_lossy().into_owned())
    }
}

/// The window an error box sits over
struct Parent;

impl ParentWindow for Parent {
    fn is_destroyed(&self) -> bool {
        false
    }
}

/// `dialog` as `showOpenDialogWithMemory` calls it
struct OpenDialog<'a> {
    dialogs: &'a DialogsHost,
}

impl Dialog for OpenDialog<'_> {
    type Window = WindowId;

    fn show_open_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let mut dialog = FileDialog::default();
        if let Some(JsonValue::String(title)) = options.get("title") {
            dialog.title = Some(title.clone());
        }
        if let Some(JsonValue::String(path)) = options.get("defaultPath") {
            dialog.default_path = Some(PathBuf::from(path));
        }
        if let Some(JsonValue::Array(filters)) = options.get("filters") {
            for filter in filters {
                let name = match filter.get("name").as_deref() {
                    Some(JsonValue::String(name)) => name.clone(),
                    _ => String::new(),
                };
                let extensions = match filter.get("extensions").as_deref() {
                    Some(JsonValue::Array(items)) => items
                        .iter()
                        .filter_map(|e| match e {
                            JsonValue::String(e) => Some(e.clone()),
                            _ => None,
                        })
                        .collect(),
                    _ => Vec::new(),
                };
                dialog.filters.push(FileFilter { name, extensions });
            }
        }
        if let Some(JsonValue::Array(props)) = options.get("properties") {
            for p in props {
                if let JsonValue::String(p) = p {
                    dialog.properties.push(p.clone());
                }
            }
        }
        let answer = self.dialogs.open(parent.copied(), &dialog);
        let mut result = JsObject::new();
        result.set("canceled", JsonValue::Bool(answer.is_none()));
        result.set(
            "filePaths",
            JsonValue::Array(
                answer
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| JsonValue::String(p.to_string_lossy().into_owned()))
                    .collect(),
            ),
        );
        JsonValue::Object(result)
    }

    fn show_save_dialog(&mut self, _: Option<&WindowId>, _: &JsObject<JsonValue>) -> JsonValue {
        let mut result = JsObject::new();
        result.set("canceled", JsonValue::Bool(true));
        JsonValue::Object(result)
    }
}

/// The sources `isUserVisibleFile` and `isMoveSource` read
struct Targets<'a> {
    home: &'a Home,
    tracked: Vec<String>,
}

impl FileTargetSources for Targets<'_> {
    fn inside_any_root(&mut self, path: &str) -> bool {
        self.home.inside_any_root(path).unwrap_or(false)
    }

    fn tracked_paths(&self) -> &[String] {
        &self.tracked
    }
}

impl MoveSourceSources for Targets<'_> {
    fn is_directory(&mut self, path: &str) -> bool {
        is_directory(path)
    }

    fn is_any_root(&mut self, path: &str) -> bool {
        self.home.is_any_root(path).unwrap_or(false)
    }
}

/// `statSync(p).isDirectory()`, false when it throws
fn is_directory(path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_dir())
}

impl Home {
    fn lang(&self) -> Lang {
        if let Ok(env) = std::env::var("SEUOFFICE_LANG") {
            return normalize_lang(Some(&env));
        }
        let settings = read_app_settings(&self.settings_path);
        install_lang(settings.get("language"), Some(&self.host.system_locale()))
    }

    fn tm(&self, key: Msg) -> &'static str {
        tm(self.lang(), key)
    }

    fn folder_errors(&self) -> FolderErrors {
        FolderErrors {
            bad_args: self.tm(Msg::BadArgs).into(),
            bad_name: self.tm(Msg::BadName).into(),
            missing: self.tm(Msg::Missing).into(),
            exists: self.tm(Msg::Exists).into(),
            failed: self.tm(Msg::RenameFailed).into(),
        }
    }

    fn parent_of_main(&self) -> Option<WindowId> {
        self.main_window.window()
    }

    /// `defaultSaveDir()`
    fn default_save_dir(&self) -> Result<String, IpcError> {
        configured_default_save_dir(
            &Paths(self.paths.as_ref()),
            &mut self.save_dir.borrow_mut(),
            self.host.now_ms(),
        )
        .map_err(|e| error(e.0))
    }

    /// `extraFolderRoots()`
    fn extra_folder_roots(&self) -> Result<Vec<String>, IpcError> {
        let default_dir = self.default_save_dir()?;
        Ok(read_extra_roots(
            &read_app_settings(&self.settings_path),
            &default_dir,
        ))
    }

    /// `folderRootPaths()`
    fn folder_root_paths(&self) -> Result<Vec<String>, IpcError> {
        let mut roots = vec![self.default_save_dir()?];
        roots.extend(self.extra_folder_roots()?);
        Ok(roots)
    }

    fn inside_any_root(&self, path: &str) -> Result<bool, IpcError> {
        Ok(self
            .folder_root_paths()?
            .iter()
            .any(|root| is_inside_root(root, path)))
    }

    fn is_any_root(&self, path: &str) -> Result<bool, IpcError> {
        let key = resolve(&[path]);
        Ok(self
            .folder_root_paths()?
            .iter()
            .any(|root| resolve(&[root]) == key))
    }

    /// `insideRoot(value)`
    fn inside_root(&self, value: Option<&IpcValue>) -> Result<bool, IpcError> {
        match as_str(value) {
            Some(path) => self.inside_any_root(path),
            None => Ok(false),
        }
    }

    fn starred_files(&self) -> Vec<String> {
        read_starred_items(&self.starred_path)
            .into_iter()
            .map(|i| i.path)
            .collect()
    }

    fn write_starred(&self, items: Option<Vec<StarredItem>>) -> Result<(), IpcError> {
        match items {
            Some(items) => write_starred_items(&self.starred_path, &items).map_err(node_error),
            None => Ok(()),
        }
    }

    /// `removeRecentFiles(paths)`
    fn remove_recent_files(&self, paths: &[String]) -> Result<(), IpcError> {
        let recent = read_recent(&self.recent_path);
        write_recent(
            &self.recent_path,
            recent.into_iter().filter(|p| !paths.contains(p)).collect(),
        )
        .map_err(node_error)?;
        self.host.recents_changed();
        Ok(())
    }

    /// `removeStarredFiles(paths)`
    fn remove_starred_files(&self, paths: &[String]) -> Result<(), IpcError> {
        let next = drop_starred_items(&read_starred_items(&self.starred_path), paths);
        self.write_starred(next)
    }

    /// `replaceRecentFile(old, new)`
    fn replace_recent_file(&self, old_path: &str, new_path: &str) -> Result<(), IpcError> {
        let recent = read_recent(&self.recent_path);
        write_recent(
            &self.recent_path,
            recent
                .into_iter()
                .map(|p| {
                    if p == old_path {
                        new_path.to_owned()
                    } else {
                        p
                    }
                })
                .collect(),
        )
        .map_err(node_error)?;
        let renamed =
            rename_starred_item(&read_starred_items(&self.starred_path), old_path, new_path);
        self.write_starred(renamed)?;
        self.host.recents_changed();
        Ok(())
    }

    /// `pushRecent(path)` of docs-main: the head of the recent list
    fn record_recent_file(&self, path: &str) {
        let recent = read_recent(&self.recent_path);
        if recent.first().map(String::as_str) == Some(path) {
            return;
        }
        let mut next = vec![path.to_owned()];
        next.extend(recent.into_iter().filter(|p| p != path));
        next.truncate(RECENT_LIMIT);
        // the document itself is saved: a lost recents entry only warns
        let _ = write_recent(&self.recent_path, next);
        self.host.recents_changed();
    }

    /// The paths other areas track, in the order `fileTargetSources` lists them
    fn tracked_paths(&self) -> Vec<String> {
        let mut paths = read_recent(&self.recent_path);
        paths.extend(self.starred_files());
        paths.extend(self.host.project_file_paths());
        paths.extend(self.host.slides_recent_files());
        paths.extend(self.host.open_file_paths());
        paths
    }

    fn targets(&self) -> Targets<'_> {
        Targets {
            home: self,
            tracked: self.tracked_paths(),
        }
    }

    /// `trackedFilesUnder(dir)`
    fn tracked_files_under(&self, dir: &str) -> Vec<String> {
        let mut candidates = self.tracked_paths();
        candidates.extend(self.host.document_link_paths());
        paths_under(dir, &candidates)
    }

    /// `afterFileMoved(old, new)`
    fn after_file_moved(&self, old_path: &str, new_path: &str) -> Result<(), IpcError> {
        self.replace_recent_file(old_path, new_path)?;
        self.host.project_file_renamed(old_path, new_path);
        if new_path.to_ascii_lowercase().ends_with(".pptx") {
            for hooks in self.provided.all::<dyn SlidesTemplateSelectionHooks>() {
                hooks.moved(old_path, new_path);
            }
        }
        self.host.file_moved(old_path, new_path);
        Ok(())
    }

    /// `afterFolderMoved(oldDir, newDir, filesBefore)`
    fn after_folder_moved(
        &self,
        old_dir: &str,
        new_dir: &str,
        files: &[String],
    ) -> Result<(), IpcError> {
        for file in files {
            self.after_file_moved(file, &rebase_path(file, old_dir, new_dir))?;
        }
        Ok(())
    }

    /// `ensureFolderWatchers()`
    fn ensure_folder_watchers(&self) -> Result<(), IpcError> {
        let wanted: Vec<String> = self
            .folder_root_paths()?
            .into_iter()
            .filter(|root| exists_sync(root))
            .collect();
        let events = self.events.clone();
        let search = self.search.clone();
        self.watch.watch(
            &wanted,
            Arc::new(move |dirs| {
                search.refresh();
                events.emit(Target::All, "home:folder-changed", vec![strings(&dirs)]);
            }),
        );
        Ok(())
    }

    /// `noticeSaveDirFallback()`: once per run
    fn notice_save_dir_fallback(&self) {
        let Some(fallback) = default_save_dir_fallback(&self.save_dir.borrow()) else {
            return;
        };
        if self.save_dir_noticed.replace(true) {
            return;
        }
        let lang = self.lang();
        let detail = tm(lang, Msg::SaveDirFallbackDetail)
            .replace("{blocked}", &fallback.blocked)
            .replace("{using}", &fallback.using);
        self.dialogs.message(
            self.parent_of_main(),
            &MessageBoxOptions {
                kind: Some("warning".into()),
                message: tm(lang, Msg::SaveDirFallbackTitle).into(),
                detail: Some(detail),
                ..MessageBoxOptions::default()
            },
        );
    }

    /// `showErrorDialog(shellWindow, message, err)`
    fn show_error_dialog(&self, message: &str, detail: &str) {
        let parent = self.main_window.window().map(|_| Parent);
        let Some(shown) = self.error_dialog.borrow_mut().show(
            parent.as_ref(),
            message,
            &ErrorValue::Error {
                message: detail.to_owned(),
            },
        ) else {
            return;
        };
        let parent = if shown.over_parent {
            self.parent_of_main()
        } else {
            None
        };
        self.dialogs.message(
            parent,
            &MessageBoxOptions {
                kind: Some(shown.options.kind.into()),
                message: shown.options.message,
                detail: Some(shown.options.detail),
                ..MessageBoxOptions::default()
            },
        );
        self.error_dialog.borrow_mut().settled();
    }

    /// `showOpenDialogWithMemory(dialog, parent, options)` as `{ canceled, filePaths }`
    fn open_dialog(
        &self,
        parent: Option<WindowId>,
        options: &JsObject<JsonValue>,
    ) -> (bool, Vec<String>) {
        let result = show_open_dialog_with_memory(
            &mut self.dialog_memory.borrow_mut(),
            &mut OpenDialog {
                dialogs: &self.dialogs,
            },
            parent.as_ref(),
            options,
            None,
        );
        let canceled = matches!(
            result.get("canceled").as_deref(),
            Some(JsonValue::Bool(true))
        );
        let files = match result.get("filePaths").as_deref() {
            Some(JsonValue::Array(items)) => items
                .iter()
                .filter_map(|p| match p {
                    JsonValue::String(p) => Some(p.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        (canceled, files)
    }

    /// `addFolderRoot(path)`
    fn add_folder_root(&self, path: &str) -> Result<Option<FolderRoot>, IpcError> {
        let extras = self.extra_folder_roots()?;
        let default_dir = self.default_save_dir()?;
        let Some(extras) = with_extra_root(&extras, &default_dir, path) else {
            return Ok(None);
        };
        write_app_setting(
            &self.settings_path,
            FOLDER_ROOTS_KEY,
            Some(JsonValue::Array(
                extras.into_iter().map(JsonValue::String).collect(),
            )),
        )
        .map_err(node_error)?;
        self.ensure_folder_watchers()?;
        self.search.refresh();
        Ok(Some(describe_extra_root(path)))
    }
}

// ---- search ----------------------------------------------------------------

fn js_finite(value: Option<&IpcValue>) -> Option<f64> {
    match value {
        Some(IpcValue::Number(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

fn search_files(home: &Home, raw: Option<&IpcValue>) -> IpcValue {
    let query = if is_object(raw) { raw } else { None };
    if !home.search.available() {
        return object(vec![
            ("hits", IpcValue::Array(Vec::new())),
            ("total", IpcValue::Number(0.0)),
            (
                "index",
                object(vec![
                    ("indexed", IpcValue::Number(0.0)),
                    ("pending", IpcValue::Number(0.0)),
                    ("scanning", IpcValue::Bool(false)),
                ]),
            ),
        ]);
    }
    // an open search box is the moment a stale index shows; rescan at most once a minute
    home.search.refresh_if_stale(60_000.0);
    let q = match as_str(field(query, "q")) {
        Some(q) => slice_utf16(trim(q), 0.0, Some(200.0)),
        None => String::new(),
    };
    let filter = as_str(field(query, "ext")).unwrap_or("");
    let exts: Option<Vec<String>> = if !filter.is_empty() && filter != "all" {
        Some(
            main_core::shell::recent_files::EXT_FAMILY
                .iter()
                .find(|(key, _)| *key == filter)
                .map_or_else(
                    || vec![filter.to_owned()],
                    |(_, family)| family.iter().map(|e| (*e).to_owned()).collect(),
                ),
        )
    } else {
        None
    };
    let offset = js_finite(field(query, "offset")).map_or(0.0, |n| n.floor().max(0.0));
    let limit = js_finite(field(query, "limit")).map_or(50.0, |n| n.floor().max(0.0));
    let starred: HashSet<String> = home.starred_files().into_iter().collect();
    let result = if q.is_empty() {
        SearchResult {
            hits: Vec::new(),
            total: 0.0,
        }
    } else {
        home.search.search(&q, exts.as_deref(), offset, limit)
    };
    let hits = result
        .hits
        .into_iter()
        .map(|SearchHit(mut fields)| {
            let path = match fields.iter().find(|(k, _)| k == "path") {
                Some((_, IpcValue::String(p))) => p.clone(),
                _ => String::new(),
            };
            let flag = IpcValue::Bool(starred.contains(&path));
            match fields.iter_mut().find(|(k, _)| k == "starred") {
                Some((_, v)) => *v = flag,
                None => fields.push(("starred".into(), flag)),
            }
            IpcValue::Object(fields)
        })
        .collect();
    let progress = home.search.progress();
    object(vec![
        ("hits", IpcValue::Array(hits)),
        ("total", IpcValue::Number(result.total)),
        (
            "index",
            object(vec![
                ("indexed", IpcValue::Number(progress.indexed)),
                ("pending", IpcValue::Number(progress.pending)),
                ("scanning", IpcValue::Bool(progress.scanning)),
            ]),
        ),
    ])
}

// ---- registration ------------------------------------------------------------

/// A handler that answers from a worker: it keeps the responder
struct OnWorker<F>(F);

impl<F> Handler for OnWorker<F>
where
    F: Fn(&CallContext, Vec<IpcValue>, Responder),
{
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        (self.0)(cx, args, reply)
    }
}

fn handle_on_worker(
    registry: &mut dyn Registry,
    channel: &'static str,
    f: impl Fn(&CallContext, Vec<IpcValue>, Responder) + 'static,
) -> Result<(), RegisterError> {
    registry.register(Batch::W, channel, ChannelKind::Invoke, Rc::new(OnWorker(f)))
}

pub fn register(registry: &mut dyn Registry, services: &Services) -> Result<(), RegisterError> {
    let user_data = services.paths.path(PathName::UserData);
    let at = |name: &str| user_data.join(name).to_string_lossy().into_owned();
    let home = Rc::new(Home {
        settings_path: at("app-settings.json"),
        recent_path: at("recent.json"),
        starred_path: at("starred.json"),
        paths: services.paths.clone(),
        events: services.events.clone(),
        workers: services.workers.clone(),
        host: services.hosts.need(Batch::W)?,
        search: services.hosts.need(Batch::W)?,
        watch: services.hosts.need(Batch::W)?,
        dialogs: services.hosts.need(Batch::W)?,
        os: services.hosts.need(Batch::W)?,
        main_window: services.hosts.need(Batch::W)?,
        provided: registry.provided(),
        save_dir: RefCell::default(),
        save_dir_noticed: Cell::new(false),
        dialog_memory: RefCell::default(),
        error_dialog: RefCell::default(),
    });
    let invoke = ChannelKind::Invoke;

    // ---- recents and starred ----

    let h = home.clone();
    handle_on_worker(registry, "home:recents", move |_, args, reply| {
        let starred: HashSet<String> = h.starred_files().into_iter().collect();
        let paths = read_recent(&h.recent_path);
        let query = to_json(args.first());
        // the stat of the page may wait on a mount: a worker does it
        h.workers.spawn(Box::new(move || {
            let page = page_recent_paths(&paths, query.as_ref(), &starred)
                .map(|page| {
                    page_to_ipc(
                        page.entries.iter().map(|e| entry_to_ipc(e, None)).collect(),
                        page.total,
                        page.total_all,
                    )
                })
                .map_err(type_error);
            reply.reply(page)
        }));
    })?;

    let h = home.clone();
    handle_on_worker(registry, "home:starred", move |_, args, reply| {
        let query = args.first();
        let raw = to_json(query);
        let normal = match normalize_recent_query(raw.as_ref()) {
            Ok(n) => n,
            Err(e) => return reply.reply(Err(type_error(e))),
        };
        let group = as_str(field(if is_object(query) { query } else { None }, "group"))
            .filter(|g| !g.is_empty())
            .map(str::to_owned);
        let items = read_starred_items(&h.starred_path);
        let group_of = starred_group_map(&items);
        let paths: Vec<String> = items.iter().map(|i| i.path.clone()).collect();
        let scoped: Vec<String> = match &group {
            Some(g) => paths
                .into_iter()
                .filter(|p| group_of.get(p).map(String::as_str) == Some(g.as_str()))
                .collect(),
            None => paths,
        };
        let starred: HashSet<String> = h.starred_files().into_iter().collect();
        h.workers.spawn(Box::new(move || {
            let mut all = stat_path_entries_async(&scoped, &starred);
            all.sort_by(|a, b| {
                b.mtime_ms
                    .partial_cmp(&a.mtime_ms)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            let all: Vec<(RecentEntry, Option<String>)> = all
                .into_iter()
                .map(|e| {
                    let g = group_of.get(&e.path).cloned();
                    (e, g)
                })
                .collect();
            let mut filtered = Vec::new();
            for (entry, g) in &all {
                match &normal.ext {
                    Some(ext) => match matches_ext_family(&entry.ext, ext) {
                        Ok(true) => filtered.push((entry, g)),
                        Ok(false) => {}
                        Err(e) => return reply.reply(Err(type_error(e))),
                    },
                    None => filtered.push((entry, g)),
                }
            }
            let entries = if normal.limit == 0.0 {
                Vec::new()
            } else {
                let len = filtered.len() as f64;
                let start = normal.offset.min(len) as usize;
                let end = (normal.offset + normal.limit).min(len) as usize;
                filtered[start..end.max(start)]
                    .iter()
                    .map(|(e, g)| entry_to_ipc(e, g.as_deref()))
                    .collect()
            };
            reply.reply(Ok(page_to_ipc(entries, filtered.len(), all.len())))
        }));
    })?;

    let h = home.clone();
    handle(registry, "home:starred-groups", invoke, move |_, _| {
        Ok(strings(&starred_group_names(&read_starred_items(
            &h.starred_path,
        ))))
    })?;

    let h = home.clone();
    handle(
        registry,
        "home:set-starred-group",
        invoke,
        move |_, args| {
            let paths = string_paths(args.first());
            let group = as_str(args.get(1)).filter(|g| !g.is_empty());
            let next = assign_starred_group(&read_starred_items(&h.starred_path), &paths, group);
            h.write_starred(next)?;
            Ok(IpcValue::Undefined)
        },
    )?;

    let h = home.clone();
    handle_on_worker(registry, "home:stat-paths", move |_, args, reply| {
        let paths = cap_stat_paths(&string_paths(args.first()));
        let starred: HashSet<String> = h.starred_files().into_iter().collect();
        h.workers.spawn(Box::new(move || {
            let entries = stat_path_entries_async(&paths, &starred);
            reply.reply(Ok(IpcValue::Array(
                entries.iter().map(|e| entry_to_ipc(e, None)).collect(),
            )))
        }));
    })?;

    let h = home.clone();
    handle(registry, "home:toggle-star", invoke, move |_, args| {
        if let Some(path) = as_str(args.first()) {
            let next = toggle_starred_item(&read_starred_items(&h.starred_path), path);
            write_starred_items(&h.starred_path, &next).map_err(node_error)?;
        }
        Ok(IpcValue::Undefined)
    })?;

    let h = home.clone();
    handle(registry, "home:unstar-paths", invoke, move |_, args| {
        h.remove_starred_files(&string_paths(args.first()))?;
        Ok(IpcValue::Undefined)
    })?;

    let h = home.clone();
    handle(registry, "home:remove-recent", invoke, move |_, args| {
        let list = string_paths(args.first());
        h.remove_recent_files(&list)?;
        // an unavailable entry's star goes with it
        let gone: Vec<String> = list.into_iter().filter(|p| !exists_sync(p)).collect();
        h.remove_starred_files(&gone)?;
        Ok(IpcValue::Undefined)
    })?;

    // ---- search ----

    let h = home.clone();
    handle(registry, "home:search-files", invoke, move |_, args| {
        Ok(search_files(&h, args.first()))
    })?;

    let h = home.clone();
    handle_on_worker(registry, "home:rerank-search", move |_, args, reply| {
        let settings = read_app_settings(&h.settings_path);
        let enabled = match settings.get("fileSearch") {
            Some(JsonValue::Object(o)) => matches!(o.get("rerank"), Some(JsonValue::Bool(true))),
            _ => false,
        };
        if !enabled {
            return reply.reply(Ok(IpcValue::Null));
        }
        let query = if is_object(args.first()) {
            args.first()
        } else {
            None
        };
        let q = match as_str(field(query, "q")) {
            Some(q) => slice_utf16(trim(q), 0.0, Some(200.0)),
            None => String::new(),
        };
        let paths: Vec<String> = match field(query, "paths") {
            Some(IpcValue::Array(_)) => string_paths(field(query, "paths"))
                .into_iter()
                .take(20)
                .collect(),
            _ => Vec::new(),
        };
        if q.is_empty() || paths.len() < 2 || !h.search.available() {
            return reply.reply(Ok(IpcValue::Null));
        }
        let search = h.search.clone();
        // the excerpts go to a decision model: the network, off the core thread
        h.workers.spawn(Box::new(move || {
            reply.reply(Ok(search.rerank(&q, &paths).unwrap_or(IpcValue::Null)))
        }));
    })?;

    // ---- open, reveal, trash ----

    let h = home.clone();
    handle(registry, "home:open-path", invoke, move |_, args| {
        let Some(path) =
            as_str(args.first()).filter(|p| !p.is_empty() && p.encode_utf16().count() <= 4096)
        else {
            return Ok(IpcValue::Undefined);
        };
        h.host.open_document_path(path);
        h.search.refresh();
        Ok(IpcValue::Undefined)
    })?;

    let h = home.clone();
    handle(registry, "home:browse", invoke, move |cx, _| {
        let lang = h.lang();
        let filter = |name: Msg, extensions: &[&str]| {
            let mut f = JsObject::new();
            f.set("name", JsonValue::String(tm(lang, name).into()));
            f.set(
                "extensions",
                JsonValue::Array(
                    extensions
                        .iter()
                        .map(|e| JsonValue::String((*e).into()))
                        .collect(),
                ),
            );
            JsonValue::Object(f)
        };
        let mut options = JsObject::new();
        options.set(
            "title",
            JsonValue::String(tm(lang, Msg::DlgOpenTitle).into()),
        );
        options.set(
            "filters",
            JsonValue::Array(vec![
                filter(Msg::FilterSupported, OPEN_DIALOG_EXTENSIONS),
                filter(Msg::FilterWord, &["docx", "doc", "dot"]),
                filter(Msg::FilterOdt, &["odt"]),
                filter(
                    Msg::FilterExcel,
                    &["xlsx", "xlsm", "xls", "csv", "tsv", "ods"],
                ),
                filter(Msg::FilterPpt, &["pptx", "ppt", "odp", "otp"]),
                filter(Msg::FilterPdf, &["pdf"]),
                filter(Msg::FilterMarkdown, &["md", "markdown", "txt", "json"]),
                filter(Msg::FilterHtml, &["html", "htm"]),
                filter(Msg::FilterMindmap, &["xmind", "mm"]),
                filter(Msg::FilterHwp, &["hwp", "hwpx"]),
                filter(Msg::FilterEpub, &["epub"]),
                filter(
                    Msg::FilterDiagram,
                    &["drawio", "dio", "drawio.svg", "drawio.png", "vsdx"],
                ),
            ]),
        );
        options.set(
            "properties",
            JsonValue::Array(vec![
                JsonValue::String("openFile".into()),
                JsonValue::String("multiSelections".into()),
            ]),
        );
        let (canceled, files) = h.open_dialog(Some(cx.sender.window), &options);
        if !canceled {
            for path in &files {
                h.host.open_document_path(path);
            }
        }
        Ok(IpcValue::Undefined)
    })?;

    let h = home.clone();
    handle(registry, "home:reveal-path", invoke, move |_, args| {
        if let Some(path) = as_str(args.first()).filter(|p| exists_sync(p)) {
            h.os.show_item_in_folder(Path::new(path));
        }
        Ok(IpcValue::Undefined)
    })?;

    let h = home.clone();
    handle(registry, "home:open-trash", invoke, move |_, _| {
        let home_dir = h.paths.path(PathName::Home).to_string_lossy().into_owned();
        #[cfg(target_os = "macos")]
        {
            h.os.open_path(Path::new(&join(&[&home_dir, ".Trash"])));
        }
        #[cfg(windows)]
        {
            let _ = &home_dir;
            h.host.open_recycle_bin();
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            h.os.open_path(Path::new(&join(&[
                &home_dir, ".local", "share", "Trash", "files",
            ])));
        }
        Ok(IpcValue::Undefined)
    })?;

    // ---- rename, duplicate, delete ----

    let h = home.clone();
    handle(registry, "home:rename-file", invoke, move |_, args| {
        let (Some(path), Some(new_name)) = (as_str(args.first()), as_str(args.get(1))) else {
            return Ok(failed(h.tm(Msg::BadArgs)));
        };
        // the raw name is validated before it is trimmed: "report " is refused, not renamed to "report"
        if !is_valid_raw_rename_name(new_name) {
            return Ok(failed(h.tm(Msg::BadName)));
        }
        let name = trim(new_name);
        if !rename_stays_in_app(path, name) {
            return Ok(failed(h.tm(Msg::BadExtension)));
        }
        if !is_user_visible_file(Some(path), &mut h.targets()) {
            return Ok(failed(h.tm(Msg::BadArgs)));
        }
        if !exists_sync(path) {
            return Ok(failed(h.tm(Msg::Missing)));
        }
        let target = join(&[&dirname(path), name]);
        if target == path {
            return Ok(rename_result_to_ipc(&RenameResult {
                ok: true,
                path: Some(path.to_owned()),
                error: None,
            }));
        }
        // a case-only rename hits the source itself on a case-insensitive file system
        if exists_sync(&target) && !is_same_file(path, &target) {
            return Ok(failed(h.tm(Msg::Exists)));
        }
        if let Err(e) = main_core::markdown::fs_util::rename(path, &target) {
            return Ok(failed(&e.message));
        }
        h.after_file_moved(path, &target)?;
        Ok(rename_result_to_ipc(&RenameResult {
            ok: true,
            path: Some(target),
            error: None,
        }))
    })?;

    let h = home.clone();
    handle(registry, "home:duplicate-file", invoke, move |_, args| {
        let Some(path) = as_str(args.first()).filter(|p| exists_sync(p)) else {
            return Ok(IpcValue::Undefined);
        };
        if !is_user_visible_file(Some(path), &mut h.targets()) {
            return Ok(IpcValue::Undefined);
        }
        let message = h.tm(Msg::DuplicateFailed);
        duplicate_document_file(
            path,
            DuplicateFileDeps {
                copy_suffix: h.tm(Msg::CopySuffix),
                record_recent_file: &mut |p| h.record_recent_file(p),
                on_error: &mut |e| h.show_error_dialog(message, &e.message),
            },
        );
        Ok(IpcValue::Undefined)
    })?;

    let h = home.clone();
    handle(registry, "home:delete-files", invoke, move |_, args| {
        let mut targets = h.targets();
        // a missing path still passes so the ghost recent/star entry gets cleaned up
        let list: Vec<String> = string_paths(args.first())
            .into_iter()
            .filter(|p| {
                is_user_visible_file(Some(p), &mut targets)
                    && std::fs::metadata(p).map_or(true, |m| m.is_file())
            })
            .collect();
        for path in &list {
            // already gone or no trash: still dropped from the lists
            let _ = h.os.trash_item(Path::new(path));
        }
        h.remove_recent_files(&list)?;
        h.remove_starred_files(&list)?;
        Ok(IpcValue::Undefined)
    })?;

    // ---- roots ----

    let h = home.clone();
    handle(registry, "home:folder-roots", invoke, move |_, _| {
        // describeRoot creates a missing save folder, so its watcher has something to attach to
        let mut roots = vec![describe_root(&h.default_save_dir()?)];
        roots.extend(
            h.extra_folder_roots()?
                .iter()
                .map(|p| describe_extra_root(p)),
        );
        h.ensure_folder_watchers()?;
        h.notice_save_dir_fallback();
        Ok(IpcValue::Array(roots.iter().map(root_to_ipc).collect()))
    })?;

    let h = home.clone();
    handle(registry, "home:folder-root-add", invoke, move |_, _| {
        let mut options = JsObject::new();
        options.set(
            "title",
            JsonValue::String(h.tm(Msg::DlgAddFolderRoot).into()),
        );
        options.set(
            "properties",
            JsonValue::Array(vec![JsonValue::String("openDirectory".into())]),
        );
        let (canceled, files) = h.open_dialog(h.parent_of_main(), &options);
        let Some(picked) = files.first().filter(|p| !p.is_empty()) else {
            return Ok(IpcValue::Null);
        };
        if canceled {
            return Ok(IpcValue::Null);
        }
        if !describe_extra_root(picked).readable {
            h.show_error_dialog(h.tm(Msg::FolderRootUnusable), picked);
            return Ok(IpcValue::Null);
        }
        Ok(h.add_folder_root(picked)?
            .map_or(IpcValue::Null, |r| root_to_ipc(&r)))
    })?;

    let h = home.clone();
    handle(registry, "home:folder-root-drop", invoke, move |_, args| {
        let mut added = Vec::new();
        let mut files = Vec::new();
        for path in string_paths(args.first()) {
            if !describe_extra_root(&path).readable {
                files.push(path);
                continue;
            }
            if let Some(root) = h.add_folder_root(&path)? {
                added.push(root_to_ipc(&root));
            }
        }
        if !files.is_empty() {
            h.host.open_dropped_files(files);
        }
        Ok(IpcValue::Array(added))
    })?;

    let h = home.clone();
    handle(
        registry,
        "home:folder-root-remove",
        invoke,
        move |_, args| {
            let Some(path) = as_str(args.first()) else {
                return Ok(IpcValue::Undefined);
            };
            let extras = without_extra_root(&h.extra_folder_roots()?, path);
            write_app_setting(
                &h.settings_path,
                FOLDER_ROOTS_KEY,
                Some(JsonValue::Array(
                    extras.into_iter().map(JsonValue::String).collect(),
                )),
            )
            .map_err(node_error)?;
            h.ensure_folder_watchers()?;
            h.search.refresh();
            Ok(IpcValue::Undefined)
        },
    )?;

    // ---- the tree ----

    let h = home.clone();
    handle(registry, "home:folder-list", invoke, move |_, args| {
        let dir = args.first();
        let Some(path) = as_str(dir).filter(|_| h.inside_root(dir).unwrap_or(false)) else {
            return Ok(object(vec![
                ("dir", text(js_string(dir))),
                ("folders", IpcValue::Array(Vec::new())),
                ("files", IpcValue::Array(Vec::new())),
            ]));
        };
        let starred: HashSet<String> = h.starred_files().into_iter().collect();
        Ok(listing_to_ipc(&list_folder(path, &starred)))
    })?;

    let h = home.clone();
    handle(registry, "home:folder-create", invoke, move |_, args| {
        let (Some(parent), Some(name)) = (as_str(args.first()), as_str(args.get(1))) else {
            return Ok(failed(h.tm(Msg::BadArgs)));
        };
        if !h.inside_any_root(parent)? {
            return Ok(failed(h.tm(Msg::BadArgs)));
        }
        Ok(rename_result_to_ipc(&create_folder(
            parent,
            name,
            &h.folder_errors(),
        )))
    })?;

    let h = home.clone();
    handle(registry, "home:folder-rename", invoke, move |_, args| {
        let (Some(dir), Some(new_name)) = (as_str(args.first()), as_str(args.get(1))) else {
            return Ok(failed(h.tm(Msg::BadArgs)));
        };
        if !h.inside_any_root(dir)? || h.is_any_root(dir)? {
            return Ok(failed(h.tm(Msg::BadArgs)));
        }
        let files_before = h.tracked_files_under(dir);
        let result = rename_folder(dir, new_name, &h.folder_errors());
        if let (true, Some(path)) = (result.ok, &result.path)
            && path != dir
        {
            h.after_folder_moved(dir, path, &files_before)?;
        }
        Ok(rename_result_to_ipc(&result))
    })?;

    let h = home.clone();
    handle(registry, "home:folder-delete", invoke, move |_, args| {
        let Some(dir) = as_str(args.first()) else {
            return Ok(IpcValue::Undefined);
        };
        if !h.inside_any_root(dir)? || h.is_any_root(dir)? {
            return Ok(IpcValue::Undefined);
        }
        let files = h.tracked_files_under(dir);
        if h.os.trash_item(Path::new(dir)).is_err() {
            return Ok(IpcValue::Undefined);
        }
        h.remove_recent_files(&files)?;
        h.remove_starred_files(&files)?;
        Ok(IpcValue::Undefined)
    })?;

    let h = home.clone();
    handle(registry, "home:move-paths", invoke, move |_, args| {
        let list = string_paths(args.first());
        if !h.inside_root(args.get(1))? {
            let error = h.tm(Msg::BadArgs);
            return Ok(move_result_to_ipc(&MoveResult {
                moved: Vec::new(),
                conflicts: Vec::new(),
                failed: list
                    .into_iter()
                    .map(|path| MoveFailure {
                        path,
                        error: error.to_owned(),
                    })
                    .collect(),
            }));
        }
        let target_dir = as_str(args.get(1)).unwrap_or_default();
        let policy = match as_str(args.get(2)) {
            Some("replace") => MoveConflictPolicy::Replace,
            Some("keepBoth") => MoveConflictPolicy::KeepBoth,
            Some("skip") => MoveConflictPolicy::Skip,
            _ => MoveConflictPolicy::Ask,
        };
        // files may come from anywhere the UI can show (the Recent list); folders only from inside the tree, never a root itself
        let mut targets = h.targets();
        let sources: Vec<String> = list
            .into_iter()
            .filter(|p| is_move_source(Some(p), &mut targets))
            .collect();
        let dir_files: Vec<(String, Vec<String>)> = sources
            .iter()
            .filter(|p| is_directory(p))
            .map(|p| (p.clone(), h.tracked_files_under(p)))
            .collect();
        // 'replace' must not destroy data: the displaced target goes to the trash,
        // and everything keyed on its path leaves with it
        let displaced = Rc::new(RefCell::new(Vec::<String>::new()));
        let mut options = Replacer {
            home: h.clone(),
            displaced: displaced.clone(),
        };
        let result = move_paths_into(
            &sources,
            target_dir,
            policy,
            &h.folder_errors(),
            &mut options,
        )
        .map_err(|thrown| error(thrown.unwrap_or_default()))?;
        for parked in displaced.borrow().iter() {
            if h.os.trash_item(Path::new(parked)).is_err() {
                let _ = std::fs::remove_dir_all(parked).or_else(|_| std::fs::remove_file(parked));
            }
        }
        for Moved { from, to } in &result.moved {
            match dir_files.iter().rev().find(|(p, _)| p == from) {
                Some((_, files)) => h.after_folder_moved(from, to, files)?,
                None => h.after_file_moved(from, to)?,
            }
        }
        Ok(move_result_to_ipc(&result))
    })?;

    Ok(())
}

/// The 'replace' policy of `home:move-paths`: parks the displaced target
struct Replacer {
    home: Rc<Home>,
    displaced: Rc<RefCell<Vec<String>>>,
}

struct Parked {
    home: Rc<Home>,
    displaced: Rc<RefCell<Vec<String>>>,
    path: String,
    parked: String,
    files: Vec<String>,
}

impl MoveOptions for Replacer {
    fn replace_existing(&mut self, path: &str) -> Result<Box<dyn ReplacedItem>, Thrown> {
        let name = format!(
            ".seuoffice-replaced-{}-{}",
            number_to_string(self.home.host.now_ms()),
            basename(path, None)
        );
        let parked = join(&[&dirname(path), &name]);
        let files = if is_directory(path) {
            self.home.tracked_files_under(path)
        } else {
            vec![path.to_owned()]
        };
        main_core::markdown::fs_util::rename(path, &parked).map_err(|e| Some(e.message))?;
        Ok(Box::new(Parked {
            home: self.home.clone(),
            displaced: self.displaced.clone(),
            path: path.to_owned(),
            parked,
            files,
        }))
    }
}

impl ReplacedItem for Parked {
    fn commit(&mut self) -> Result<(), Thrown> {
        self.displaced.borrow_mut().push(self.parked.clone());
        let thrown = |e: IpcError| Some(e.message);
        self.home.remove_recent_files(&self.files).map_err(thrown)?;
        self.home
            .remove_starred_files(&self.files)
            .map_err(thrown)?;
        for file in &self.files {
            self.home
                .host
                .project_file_renamed(file, &rebase_path(file, &self.path, &self.parked));
        }
        Ok(())
    }

    fn rollback(&mut self) -> Result<(), Thrown> {
        main_core::markdown::fs_util::rename(&self.parked, &self.path).map_err(|e| Some(e.message))
    }
}

// ---- the probe's fakes -------------------------------------------------------

#[cfg(feature = "probe")]
mod fakes {
    use std::collections::BTreeSet;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::{Value, json};

    use super::*;

    type Log = Arc<Mutex<Vec<Value>>>;

    fn push(log: &Log, line: Value) {
        log.lock().unwrap().push(line);
    }

    fn ipc_of(value: &Value) -> IpcValue {
        match value {
            Value::Null => IpcValue::Null,
            Value::Bool(b) => IpcValue::Bool(*b),
            Value::Number(n) => IpcValue::Number(n.as_f64().unwrap_or(f64::NAN)),
            Value::String(s) => IpcValue::String(s.clone()),
            Value::Array(items) => IpcValue::Array(items.iter().map(ipc_of).collect()),
            Value::Object(map) => {
                IpcValue::Object(map.iter().map(|(k, v)| (k.clone(), ipc_of(v))).collect())
            }
        }
    }

    fn string_list(value: &Value) -> Vec<String> {
        value
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// hosts.w: `{nowMs, locale, projectFiles, slidesRecentFile}`; the
    /// tabs, detached windows and document links are not in the TypeScript's
    /// world (no shell window before `whenReady`), so they hold nothing
    struct FakeHomeFiles {
        log: Log,
        case: Value,
    }

    impl HomeFiles for FakeHomeFiles {
        fn now_ms(&self) -> f64 {
            self.case["nowMs"].as_f64().unwrap_or(1_700_000_000_000.0)
        }
        fn system_locale(&self) -> String {
            self.case["locale"].as_str().unwrap_or("ko").to_owned()
        }
        fn open_document_path(&self, _: &str) -> bool {
            false
        }
        fn open_dropped_files(&self, _: Vec<String>) {}
        fn open_file_paths(&self) -> Vec<String> {
            Vec::new()
        }
        fn project_file_paths(&self) -> Vec<String> {
            string_list(&self.case["projectFiles"])
        }
        fn slides_recent_files(&self) -> Vec<String> {
            let Some(path) = self.case["slidesRecentFile"].as_str() else {
                return Vec::new();
            };
            std::fs::read_to_string(path)
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .map(|v| string_list(&v))
                .unwrap_or_default()
        }
        fn document_link_paths(&self) -> Vec<String> {
            Vec::new()
        }
        fn project_file_renamed(&self, old_path: &str, new_path: &str) {
            push(
                &self.log,
                json!(["projectStore.fileRenamed", old_path, new_path]),
            );
        }
        fn file_moved(&self, _: &str, _: &str) {}
        fn recents_changed(&self) {}
        fn open_recycle_bin(&self) {}
    }

    /// hosts.w.fileSearch: `{unavailable, results: {"<q>": {hits, total}},
    /// progress, rerank, indexedAsOnDisk}`
    struct FakeFileSearch {
        log: Log,
        case: Value,
        created: AtomicBool,
    }

    impl FileSearch for FakeFileSearch {
        fn available(&self) -> bool {
            if self.case["unavailable"].as_bool() == Some(true) {
                return false;
            }
            self.created.store(true, Ordering::Relaxed);
            true
        }
        fn refresh_if_stale(&self, max_age_ms: f64) {
            push(&self.log, json!(["fileIndexer.refreshIfStale", max_age_ms]));
        }
        fn refresh(&self) {
            if self.created.load(Ordering::Relaxed) {
                push(&self.log, json!(["fileIndexer.refresh"]));
            }
        }
        fn search(
            &self,
            q: &str,
            exts: Option<&[String]>,
            offset: f64,
            limit: f64,
        ) -> SearchResult {
            let mut options = serde_json::Map::new();
            if let Some(exts) = exts {
                options.insert("exts".into(), json!(exts));
            }
            options.insert("offset".into(), json!(offset));
            options.insert("limit".into(), json!(limit));
            push(&self.log, json!(["fileIndexStore.search", q, options]));
            let result = &self.case["results"][q];
            let hits = result["hits"]
                .as_array()
                .map(|hits| {
                    hits.iter()
                        .map(|h| match ipc_of(h) {
                            IpcValue::Object(fields) => SearchHit(fields),
                            _ => SearchHit(Vec::new()),
                        })
                        .collect()
                })
                .unwrap_or_default();
            SearchResult {
                hits,
                total: result["total"].as_f64().unwrap_or(0.0),
            }
        }
        fn progress(&self) -> IndexProgress {
            let p = &self.case["progress"];
            IndexProgress {
                indexed: p["indexed"].as_f64().unwrap_or(0.0),
                pending: p["pending"].as_f64().unwrap_or(0.0),
                scanning: p["scanning"].as_bool().unwrap_or(false),
            }
        }
        fn rerank(&self, q: &str, paths: &[String]) -> Option<IpcValue> {
            let indexed = string_list(&self.case["indexedAsOnDisk"]);
            let on_disk: Vec<&String> = paths.iter().filter(|p| indexed.contains(p)).collect();
            push(&self.log, json!(["searchReranker.rerank", q, on_disk]));
            match &self.case["rerank"] {
                Value::Null => None,
                v => Some(ipc_of(v)),
            }
        }
    }

    /// hosts.w.watch: `[{root, changed: ["<changed path relative to the root>", ...]}]`,
    /// what `fs.watch` reports once the root is watched
    struct FakeWatch {
        log: Log,
        case: Value,
        watched: Mutex<Vec<String>>,
    }

    impl FolderWatch for FakeWatch {
        fn watch(&self, roots: &[String], changed: Arc<dyn Fn(Vec<String>) + Send + Sync>) {
            let mut watched = self.watched.lock().unwrap();
            let gone: Vec<String> = watched
                .iter()
                .filter(|r| !roots.contains(r))
                .cloned()
                .collect();
            for root in gone {
                push(&self.log, json!(["fsWatcher.close", root]));
                watched.retain(|r| *r != root);
            }
            for root in roots {
                if watched.contains(root) {
                    continue;
                }
                watched.push(root.clone());
                push(
                    &self.log,
                    json!(["fs.watch", root, {"recursive": true, "persistent": false}]),
                );
                // FolderWatcher.note: the folder of the changed entry, and the
                // entry itself when it is a folder; one report per debounce
                let mut pending: Vec<String> = Vec::new();
                let mut seen = BTreeSet::new();
                let changes = self
                    .case
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|w| w["root"] == root.as_str());
                for rel in changes
                    .map(|w| string_list(&w["changed"]))
                    .unwrap_or_default()
                {
                    let path = if rel.is_empty() {
                        root.clone()
                    } else {
                        join(&[root, &rel])
                    };
                    let mut add = |p: String| {
                        if seen.insert(p.clone()) {
                            pending.push(p);
                        }
                    };
                    add(dirname(&path));
                    if is_directory(&path) {
                        add(path);
                    }
                }
                if !pending.is_empty() {
                    changed(pending);
                }
            }
        }
    }

    pub fn probe_hosts(hosts: &mut shell_contract::Hosts, case: &Value) {
        let log: Log = hosts
            .get::<Log>()
            .cloned()
            .expect("ipc-probe inserts the host log first");
        let files: HomeFilesHost = Arc::new(FakeHomeFiles {
            log: log.clone(),
            case: case.clone(),
        });
        hosts.insert(files);
        let search: FileSearchHost = Arc::new(FakeFileSearch {
            log: log.clone(),
            case: case["fileSearch"].clone(),
            created: AtomicBool::new(false),
        });
        hosts.insert(search);
        let watch: FolderWatchHost = Arc::new(FakeWatch {
            log,
            case: case["watch"].clone(),
            watched: Mutex::new(Vec::new()),
        });
        hosts.insert(watch);
    }
}

#[cfg(feature = "probe")]
pub use fakes::probe_hosts;
