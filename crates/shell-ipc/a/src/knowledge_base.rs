//! The knowledge-base channels of the shell entry (`kb:*` of
//! `apps/shell/src/main/index.ts`) and the module they call,
//! `apps/shell/src/main/knowledge-base.ts`: the reader's starred files (and,
//! for a home ask with a project chosen, that project's folder) as the AI can
//! list, search, read, and the one write path of the ask panel, a new
//! document.
//!
//! `knowledge-base.ts` is a shell entry helper nobody else ports, so its
//! logic lives here: the run scopes ([`KbRunScopes`]), the corpus listing,
//! the search filters, the read paging and its text cache, and the create
//! request. The starred store, the atomic write and the unsaved-file message
//! are `main-core`'s; what the TypeScript took from modules that are not in
//! `main-core` is [`KbServices`].

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::UNIX_EPOCH;

use jscompat::node_path::host::{basename, dirname, extname, join};
use jscompat::{math_round, number_to_string, to_number, trim};
use main_core::docs::starred_files::{read_starred_items, starred_group_map};
use main_core::node_fs::{NodeError, node_error};
use main_core::packages::electron_utils::unsaved_files::UNSAVED_CHANGES_MESSAGE;
use main_core::shell::atomic_write::atomic_write_file;
use shell_contract::ipc::{CallContext, Responder};
use shell_contract::runtime::{AppPaths, PathName, Thread, Workers};
use shell_contract::value::BytesKind;
use shell_contract::{IpcError, IpcValue, ViewId};

use crate::ports::KnowledgeBase;

/// the refusal of a read outside the run's knowledge base: the starred set, or the run's group
pub const KB_NOT_IN_BASE: &str = "path is not in the knowledge base";
/// a call carried a scope main does not hold (never opened, closed, evicted, or another window's)
pub const KB_SCOPE_UNKNOWN: &str = "knowledge-base scope is not open";
/// a scope was asked for a group with no starred files
pub const KB_GROUP_EMPTY: &str = "knowledge-base group has no starred files";
/// a knowledge read reached a cloud-only project file and the person declined the download
pub const KB_DOWNLOAD_DECLINED: &str =
    "the person declined to download this file, which is not on this PC";
/// `PROJECT_UNAVAILABLE` of `projects/project-tools.ts`
pub const PROJECT_UNAVAILABLE: &str = "project is not listed or its folder is missing";

/// characters of parsed text one read page returns
pub const KB_READ_CHUNK_CHARS: usize = 24_000;
/// byte cap per corpus file
pub const KB_READ_MAX_BYTES: f64 = 50.0 * 1024.0 * 1024.0;
/// keep in step with `CREATE_DOCUMENT_MAX_CHARS` in agent-core
pub const KB_CREATE_MAX_CHARS: usize = 2_000_000;
/// query cap, same as the home search box
const KB_QUERY_MAX_CHARS: usize = 200;
/// how many indexed hits to fetch before filtering to the starred set
const KB_SEARCH_POOL: usize = 200;
/// the most hits one search returns
const KB_SEARCH_LIMIT_MAX: f64 = 20.0;
const KB_SEARCH_LIMIT_DEFAULT: f64 = 8.0;
/// `KB_TEXT_CACHE_MAX`
const KB_TEXT_CACHE_MAX: usize = 8;
/// how many scopes main holds at once; the oldest is dropped (and then refused) past this
const KB_SCOPES_MAX: usize = 16;
/// `refreshIfStale(60_000)`: a stale index shows when a search is asked
const INDEX_STALE_MS: u64 = 60_000;

// ---- what the shell entry reaches outside main-core ----

/// One hit of the full-text index (`store.search(..).hits`), its excerpt
/// already joined (`snippet.map(part => part.text).join('')`)
#[derive(Clone, Debug, PartialEq)]
pub struct IndexHit {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub snippet_text: String,
}

/// A project's "visible to the AI" test on absolute paths (`tools.visibleTest`)
pub type VisibleTest = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Why a project read was refused (`ProjectReadRefusal`)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectReadRefusal {
    Outside,
    Hidden,
    Ignored,
    NotFound,
    Unsaved,
    TooLarge,
    Unreadable,
}

/// `ProjectReadResult`
#[derive(Clone, Debug, PartialEq)]
pub enum ProjectRead {
    Ok {
        text: String,
        total_chars: f64,
        offset: f64,
    },
    /// the file is cloud-only and the person declined the download
    Declined,
    Refused(ProjectReadRefusal),
}

/// `NewDocumentPlacement`: where a window's new documents go
#[derive(Clone, Debug, PartialEq)]
pub struct Placement {
    pub project_id: String,
    pub root: String,
    pub dir: String,
}

/// What the knowledge-base channels reach beyond `main-core` and the shared
/// hosts. Methods the TypeScript awaited are called from a worker thread and
/// may block; the others run on the core thread.
pub trait KbServices {
    /// `fileIndexStore !== null`
    fn has_file_index(&self) -> bool;
    /// `ensureFileIndexer()?.refreshIfStale(60_000)`
    fn refresh_file_index_if_stale(&self, max_age_ms: u64);
    /// `store.pathsIndexedAsOnDisk(paths)`: the paths the index holds as they
    /// are on disk now, in their order
    fn paths_indexed_as_on_disk(&self, paths: &[String]) -> Vec<String>;
    /// `store.search(q, { limit, within })`, worker thread. `within` narrows
    /// the query itself, so starred and project files rank together
    fn index_search(
        &self,
        q: &str,
        limit: usize,
        within: Option<&dyn Fn(&str) -> bool>,
    ) -> Vec<IndexHit>;
    /// `withoutUnsavedFiles(paths, (path) => path)` of
    /// `@seuoffice/electron-utils/unsaved-files`: the paths whose file is not
    /// open with unsaved changes, in their order. Worker thread
    fn without_unsaved_files(&self, paths: &[String]) -> Vec<String>;
    /// `attachableMaxBytes(ext)` of `@seuoffice/file-parse`, `ext` as
    /// `extname` gives it; infinity for the formats read at any size
    fn attachable_max_bytes(&self, ext: &str) -> f64;
    /// `parseFileToText(path)`, worker thread: the parsed text of a text
    /// file; the error is the parser's message, if it gave one
    fn parse_file_to_text(&self, path: &str) -> Result<String, Option<String>>;
    /// `projectFolderServices().tools.isAvailable(projectId)`, worker thread
    fn project_available(&self, project_id: &str) -> bool;
    /// `projectFolderServices().tools.visibleTest(projectId)`, worker thread;
    /// `None` when the project is not available (`null`)
    fn project_visible_test(&self, project_id: &str) -> Option<VisibleTest>;
    /// `projectFolderServices().tools.readPath(owner, projectId, path, offset)`,
    /// worker thread
    fn project_read(&self, owner: ViewId, project_id: &str, path: &str, offset: f64)
    -> ProjectRead;
    /// `newDocuments.placementFor(owner)`: where the window's new documents
    /// go, `None` when its panel has no project. Worker thread
    fn new_document_placement(&self, owner: ViewId) -> Result<Option<Placement>, String>;
    /// `newDocuments.write(placement, fileName, bytes)`: the project folder's
    /// write guard picks a free name; the path written. Worker thread
    fn write_project_document(
        &self,
        placement: &Placement,
        file_name: &str,
        bytes: Vec<u8>,
    ) -> Result<String, String>;
    /// `defaultSaveDir()` of docs-main: the folder new files land in
    fn default_save_dir(&self) -> Result<String, String>;
    /// `createFileViaCli(bundledCliRunner(), { type: 'docx', input: { name:
    /// 'content.md', content: markdown }, out })`, worker thread
    fn markdown_to_docx(&self, markdown: &str, out: &str) -> Result<(), String>;
    /// `recordRecentFile(path)` of docs-main (the recent list and its menu)
    fn record_recent_file(&self, path: &str);
}

pub type KbServicesHost = Arc<dyn KbServices + Send + Sync>;

// ---- JavaScript string helpers ----

/// `text.slice(0, max)` by UTF-16 code units; a cut surrogate pair becomes U+FFFD
fn slice_units(text: &str, start: usize, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let end = end.min(units.len());
    let start = start.min(end);
    String::from_utf16_lossy(&units[start..end])
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `Number(value)` of a value a renderer sent
fn js_number(value: Option<&IpcValue>) -> f64 {
    match value {
        Some(IpcValue::Number(n)) => *n,
        Some(IpcValue::String(s)) => to_number(s),
        Some(IpcValue::Bool(b)) => f64::from(u8::from(*b)),
        Some(IpcValue::Null) => 0.0,
        Some(IpcValue::Date(ms)) => *ms,
        Some(value @ (IpcValue::Array(_) | IpcValue::Bytes(..) | IpcValue::Object(_))) => {
            to_number(&primitive_text(value))
        }
        Some(IpcValue::Undefined) | None => f64::NAN,
    }
}

/// What `Number` reads of an object: its `toString()`, an array's `join(',')`
/// (a date inside an array is text no number can be read from)
fn primitive_text(value: &IpcValue) -> String {
    match value {
        IpcValue::Undefined | IpcValue::Null => String::new(),
        IpcValue::Bool(b) => b.to_string(),
        IpcValue::Number(n) => number_to_string(*n),
        IpcValue::String(s) => s.clone(),
        IpcValue::Date(_) => "Date".to_owned(),
        IpcValue::Array(items) => items
            .iter()
            .map(primitive_text)
            .collect::<Vec<_>>()
            .join(","),
        IpcValue::Bytes(BytesKind::Uint8Array, bytes) => bytes
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(","),
        IpcValue::Bytes(BytesKind::ArrayBuffer, _) => "[object ArrayBuffer]".to_owned(),
        IpcValue::Object(_) => "[object Object]".to_owned(),
    }
}

/// An own property of an object argument; `undefined` when `raw` is not an object
fn field<'a>(raw: Option<&'a IpcValue>, key: &str) -> Option<&'a IpcValue> {
    match raw {
        Some(IpcValue::Object(entries)) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn string_field<'a>(raw: Option<&'a IpcValue>, key: &str) -> Option<&'a str> {
    match field(raw, key) {
        Some(IpcValue::String(s)) => Some(s),
        _ => None,
    }
}

fn object(entries: Vec<(&str, IpcValue)>) -> IpcValue {
    IpcValue::Object(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
    )
}

fn error(message: impl Into<String>) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: message.into(),
    }
}

fn node(error: NodeError) -> String {
    error.message
}

// ---- the corpus ----

/// `KbFile`: one corpus entry as the AI (and the panel) sees it
#[derive(Clone, Debug, PartialEq)]
pub struct KbFile {
    pub path: String,
    pub folder: String,
    pub folder_path: String,
    pub name: String,
    pub ext: String,
    pub size_bytes: u64,
}

impl KbFile {
    fn to_ipc(&self) -> IpcValue {
        object(vec![
            ("path", IpcValue::String(self.path.clone())),
            ("folder", IpcValue::String(self.folder.clone())),
            ("folderPath", IpcValue::String(self.folder_path.clone())),
            ("name", IpcValue::String(self.name.clone())),
            ("ext", IpcValue::String(self.ext.clone())),
            ("sizeBytes", IpcValue::Number(self.size_bytes as f64)),
        ])
    }
}

/// `basename(path).replace(/^[^.]*./, '').toLowerCase()`: what follows the
/// first dot (everything when the name has none, as the pattern's `.` then
/// eats the last character)
fn kb_ext(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let run = chars.iter().take_while(|c| **c != '.').count();
    let line_end = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    let consumed = (0..=run)
        .rev()
        .find(|at| chars.get(*at).is_some_and(|c| !line_end(*c)))
        .map(|at| at + 1)
        .unwrap_or(0);
    chars[consumed..].iter().collect::<String>().to_lowercase()
}

/// `listKnowledgeFiles(starredPaths)`: every starred file that still exists on
/// disk. A starred path can outlive its file; it then drops out
pub fn list_knowledge_files(starred_paths: &[String]) -> Vec<KbFile> {
    starred_paths
        .iter()
        .filter_map(|path| {
            let meta = fs::metadata(path).ok().filter(|m| m.is_file())?;
            let folder_path = dirname(path);
            let name = basename(path, None);
            Some(KbFile {
                path: path.clone(),
                folder: basename(&folder_path, None),
                ext: kb_ext(&name),
                folder_path,
                name,
                size_bytes: meta.len(),
            })
        })
        .collect()
}

// ---- search ----

/// `KbSearchHit`: a search result as the model sees it
#[derive(Clone, Debug, PartialEq)]
pub struct KbSearchHit {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub folder: String,
    pub snippet: String,
}

impl KbSearchHit {
    fn to_ipc(&self) -> IpcValue {
        object(vec![
            ("path", IpcValue::String(self.path.clone())),
            ("name", IpcValue::String(self.name.clone())),
            ("ext", IpcValue::String(self.ext.clone())),
            ("folder", IpcValue::String(self.folder.clone())),
            ("snippet", IpcValue::String(self.snippet.clone())),
        ])
    }
}

/// `query.trim().slice(0, KB_QUERY_MAX_CHARS)`
fn search_query(query: &str) -> String {
    slice_units(trim(query), 0, KB_QUERY_MAX_CHARS)
}

/// `searchKnowledgeBase`: the pool filtered to the allowed paths, each once,
/// trimmed to `limit`
fn filter_pool(pool: &[IndexHit], allowed: &HashSet<&str>, limit: usize) -> Vec<KbSearchHit> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for hit in pool {
        if !allowed.contains(hit.path.as_str()) || !seen.insert(hit.path.as_str()) {
            continue;
        }
        out.push(KbSearchHit {
            path: hit.path.clone(),
            name: hit.name.clone(),
            ext: hit.ext.clone(),
            folder: basename(&dirname(&hit.path), None),
            snippet: hit.snippet_text.clone(),
        });
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// `searchSavedKnowledgeWithProject`: the starred search over the starred
/// files not open with unsaved changes, widened by the project folder the run
/// also reads (`within`). The excerpt comes from the index, which holds a file
/// as last saved, so nothing of a file being edited is quoted until it is
/// saved; project hits keep that protection and the "indexed as on disk" one.
fn search_saved_knowledge(
    host: &dyn KbServices,
    query: &str,
    starred_paths: &[String],
    limit: usize,
    within: Option<VisibleTest>,
) -> Vec<KbSearchHit> {
    let q = search_query(query);
    if q.is_empty() {
        return Vec::new();
    }
    let saved = host.without_unsaved_files(starred_paths);
    let starred: HashSet<&str> = saved.iter().map(String::as_str).collect();
    let Some(within) = within else {
        let pool = host.index_search(&q, KB_SEARCH_POOL, None);
        return filter_pool(&pool, &starred, limit);
    };
    let pool = host.index_search(
        &q,
        KB_SEARCH_POOL,
        Some(&|path: &str| starred.contains(path) || within(path)),
    );
    let from_project: Vec<String> = pool
        .iter()
        .filter(|hit| !starred.contains(hit.path.as_str()))
        .map(|hit| hit.path.clone())
        .collect();
    let project_ok = host.without_unsaved_files(&host.paths_indexed_as_on_disk(&from_project));
    let allowed: HashSet<&str> = pool
        .iter()
        .map(|hit| hit.path.as_str())
        .filter(|path| starred.contains(path) || project_ok.iter().any(|ok| ok == path))
        .collect();
    filter_pool(&pool, &allowed, limit)
}

// ---- reading ----

/// `KbReadPage`: one page of a corpus file's text
#[derive(Clone, Debug, PartialEq)]
pub struct KbReadPage {
    pub text: String,
    /// total parsed characters (UTF-16 units), so the reader knows whether to page on
    pub total_chars: f64,
    pub offset: f64,
}

impl KbReadPage {
    fn to_ipc(&self) -> IpcValue {
        object(vec![
            ("text", IpcValue::String(self.text.clone())),
            ("totalChars", IpcValue::Number(self.total_chars)),
            ("offset", IpcValue::Number(self.offset)),
        ])
    }
}

/// `kbReadMaxBytes(filePath)`: the largest file with this path read for the AI
fn kb_read_max_bytes(host: &dyn KbServices, path: &str) -> f64 {
    let cap = host.attachable_max_bytes(&extname(path));
    if cap.is_finite() {
        cap.max(KB_READ_MAX_BYTES)
    } else {
        cap
    }
}

/// `kbTextCache`: the parsed text by path, invalidated by mtime and size,
/// the oldest entry dropped past [`KB_TEXT_CACHE_MAX`]
#[derive(Default)]
struct TextCache {
    entries: Vec<CachedText>,
}

/// path, (mtime, size), the text as UTF-16 units
type CachedText = (String, (u128, u64), Arc<[u16]>);

impl TextCache {
    fn get(&self, path: &str, stamp: (u128, u64)) -> Option<Arc<[u16]>> {
        self.entries
            .iter()
            .find(|(p, s, _)| p == path && *s == stamp)
            .map(|(_, _, text)| text.clone())
    }

    fn put(&mut self, path: &str, stamp: (u128, u64), text: Arc<[u16]>) {
        match self.entries.iter_mut().find(|(p, _, _)| p == path) {
            Some(entry) => *entry = (path.to_owned(), stamp, text),
            None => self.entries.push((path.to_owned(), stamp, text)),
        }
        if self.entries.len() > KB_TEXT_CACHE_MAX {
            self.entries.remove(0);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `readKnowledgeFileText(filePath)`: a file open with unsaved changes is not
/// read at all (before the cache), a larger file than its cap is refused
/// before it is parsed
fn read_knowledge_file_text(
    host: &dyn KbServices,
    cache: &Mutex<TextCache>,
    path: &str,
) -> Result<Arc<[u16]>, String> {
    if host.without_unsaved_files(&[path.to_owned()]).is_empty() {
        return Err(UNSAVED_CHANGES_MESSAGE.to_owned());
    }
    let meta = fs::metadata(path).map_err(|e| node(node_error(&e, "stat", path)))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    let stamp = (mtime, meta.len());
    if let Some(text) = lock(cache).get(path, stamp) {
        return Ok(text);
    }
    let cap = kb_read_max_bytes(host, path);
    if meta.len() as f64 > cap {
        return Err(format!(
            "file too large to read ({}MB, cap {}MB)",
            number_to_string(math_round(meta.len() as f64 / 1024.0 / 1024.0)),
            number_to_string(cap / 1024.0 / 1024.0)
        ));
    }
    let text = host
        .parse_file_to_text(path)
        .map_err(|e| e.unwrap_or_else(|| "unreadable file".to_owned()))?;
    let units: Arc<[u16]> = text.encode_utf16().collect();
    lock(cache).put(path, stamp, units.clone());
    Ok(units)
}

/// `readKnowledgeFilePage(filePath, offset)`
fn read_knowledge_file_page(
    host: &dyn KbServices,
    cache: &Mutex<TextCache>,
    path: &str,
    offset: f64,
) -> Result<KbReadPage, String> {
    let text = read_knowledge_file_text(host, cache, path)?;
    let total = text.len();
    let start = if offset.is_finite() {
        offset.floor().max(0.0)
    } else {
        0.0
    };
    if start >= total as f64 {
        return Ok(KbReadPage {
            text: String::new(),
            total_chars: total as f64,
            offset: start,
        });
    }
    let from = start as usize;
    let to = (from + KB_READ_CHUNK_CHARS).min(total);
    Ok(KbReadPage {
        text: String::from_utf16_lossy(&text[from..to]),
        total_chars: total as f64,
        offset: start,
    })
}

/// The project a read may also reach: its owner window and id
struct ProjectReach<'a> {
    owner: ViewId,
    project_id: &'a str,
}

/// `readKnowledgeOrProjectPage`: a starred file the scope allows reads as
/// before (the person chose it); else the project read decides (visibility,
/// unsaved, size, the cloud-only question); without a project the path is
/// outside the base
fn read_knowledge_or_project_page(
    host: &dyn KbServices,
    cache: &Mutex<TextCache>,
    path: &str,
    offset: f64,
    starred_allowed: bool,
    project: Option<ProjectReach>,
) -> Result<KbReadPage, String> {
    if starred_allowed {
        return read_knowledge_file_page(host, cache, path, offset);
    }
    let Some(project) = project else {
        return Err(KB_NOT_IN_BASE.to_owned());
    };
    match host.project_read(project.owner, project.project_id, path, offset) {
        ProjectRead::Ok {
            text,
            total_chars,
            offset,
        } => Ok(KbReadPage {
            text,
            total_chars,
            offset,
        }),
        ProjectRead::Declined => Err(KB_DOWNLOAD_DECLINED.to_owned()),
        ProjectRead::Refused(ProjectReadRefusal::Unsaved) => {
            Err(UNSAVED_CHANGES_MESSAGE.to_owned())
        }
        ProjectRead::Refused(ProjectReadRefusal::TooLarge) => Err(format!(
            "file too large to read (cap {}MB)",
            number_to_string(kb_read_max_bytes(host, path) / 1024.0 / 1024.0)
        )),
        ProjectRead::Refused(ProjectReadRefusal::Unreadable) => Err("unreadable file".to_owned()),
        ProjectRead::Refused(_) => Err(KB_NOT_IN_BASE.to_owned()),
    }
}

// ---- the scopes of runs ----

/// The starred part of a scope: every starred file, one group's, or none (the
/// project scope of an editor's AI panel, which reads its project folder only)
#[derive(Clone, Debug, PartialEq)]
enum StarredReach {
    All,
    None,
    Group(String),
}

/// What a project scope asks of the starred part (`KbStarredReach`); a group
/// is the value the caller sent, and anything but a group that exists is refused
pub enum StarredAsk<'a> {
    All,
    None,
    Group(&'a IpcValue),
}

struct HeldScope {
    owner: ViewId,
    starred: StarredReach,
    /// a project folder the run may also read; the project tools re-check it on every call
    project_id: Option<String>,
}

/// `KbRunScopes`: the scopes of runs. A scope covers a starred group, a
/// project folder, or both: the home ask with a project chosen reads the
/// project folder plus its starred scope (all or one group). The renderer
/// names a group once per run, main mints an opaque scope for it, and every
/// `kb:*` call of that run carries the scope; main resolves the group's
/// members itself on each call, so a file list sent from a renderer is never
/// trusted. What a scope covers never changes after it is opened. A call
/// without a scope is an unscoped ask (every starred file); a scope main does
/// not hold is refused, never read as unscoped.
pub struct KbRunScopes {
    /// oldest first
    scopes: Vec<(String, HeldScope)>,
    new_scope: Box<dyn Fn() -> String + Send>,
    max: usize,
}

impl Default for KbRunScopes {
    fn default() -> Self {
        Self::new(Box::new(random_scope), KB_SCOPES_MAX)
    }
}

/// `randomBytes(24).toString('hex')`
fn random_scope() -> String {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).expect("the platform's random source");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn checked_group(
    group: &IpcValue,
    group_of: &HashMap<String, String>,
) -> Result<String, &'static str> {
    match group {
        IpcValue::String(g) if !g.is_empty() && group_of.values().any(|v| v == g) => Ok(g.clone()),
        _ => Err(KB_GROUP_EMPTY),
    }
}

impl KbRunScopes {
    pub fn new(new_scope: Box<dyn Fn() -> String + Send>, max: usize) -> Self {
        KbRunScopes {
            scopes: Vec::new(),
            new_scope,
            max,
        }
    }

    /// a scope for one run of `owner` over `group`; refuses a group with no starred files
    pub fn open(
        &mut self,
        owner: ViewId,
        group: &IpcValue,
        group_of: &HashMap<String, String>,
    ) -> Result<String, &'static str> {
        let group = checked_group(group, group_of)?;
        Ok(self.hold(HeldScope {
            owner,
            starred: StarredReach::Group(group),
            project_id: None,
        }))
    }

    /// A scope for one run of `owner` over a project folder plus a starred
    /// part. The caller has checked that the project is listed and its folder exists
    pub fn open_project(
        &mut self,
        owner: ViewId,
        project_id: &str,
        starred: StarredAsk,
        group_of: &HashMap<String, String>,
    ) -> Result<String, &'static str> {
        let starred = match starred {
            StarredAsk::All => StarredReach::All,
            StarredAsk::None => StarredReach::None,
            StarredAsk::Group(group) => StarredReach::Group(checked_group(group, group_of)?),
        };
        Ok(self.hold(HeldScope {
            owner,
            starred,
            project_id: Some(project_id.to_owned()),
        }))
    }

    fn hold(&mut self, held: HeldScope) -> String {
        let scope = (self.new_scope)();
        self.scopes.push((scope.clone(), held));
        while self.scopes.len() > self.max {
            self.scopes.remove(0);
        }
        scope
    }

    /// the held scope a call names; `None` when it names none; refused for any other value
    fn held_for(
        &self,
        owner: ViewId,
        raw: Option<&IpcValue>,
    ) -> Result<Option<&HeldScope>, &'static str> {
        let scope = match field(raw, "scope") {
            None | Some(IpcValue::Undefined) => return Ok(None),
            Some(scope) => scope,
        };
        let held = match scope {
            IpcValue::String(id) => self.scopes.iter().find(|(s, _)| s == id).map(|(_, h)| h),
            _ => None,
        };
        match held {
            Some(held) if held.owner == owner => Ok(Some(held)),
            _ => Err(KB_SCOPE_UNKNOWN),
        }
    }

    /// the run is over; only the window that opened a scope can close it
    pub fn close(&mut self, owner: ViewId, scope: Option<&IpcValue>) {
        if let Some(IpcValue::String(id)) = scope {
            self.scopes
                .retain(|(s, held)| !(s == id && held.owner == owner));
        }
    }

    /// `paths` narrowed to what this call may touch. `raw` is the call's
    /// argument; only its `scope` field is read. No scope: every path. A held
    /// scope: every path (all), none, or the paths whose group is the scope's
    /// group right now. Anything else: refused
    pub fn narrow(
        &self,
        owner: ViewId,
        raw: Option<&IpcValue>,
        paths: &[String],
        group_of: impl FnOnce() -> HashMap<String, String>,
    ) -> Result<Vec<String>, &'static str> {
        let reach = match self.held_for(owner, raw)? {
            None => return Ok(paths.to_vec()),
            Some(held) => &held.starred,
        };
        Ok(match reach {
            StarredReach::All => paths.to_vec(),
            StarredReach::None => Vec::new(),
            StarredReach::Group(group) => {
                let groups = group_of();
                paths
                    .iter()
                    .filter(|path| groups.get(*path) == Some(group))
                    .cloned()
                    .collect()
            }
        })
    }

    /// The project folder the call's scope also reads, or `None` (no scope,
    /// or a starred-only scope). A scope main does not hold is refused, as in `narrow`
    pub fn project_of(
        &self,
        owner: ViewId,
        raw: Option<&IpcValue>,
    ) -> Result<Option<String>, &'static str> {
        Ok(self
            .held_for(owner, raw)?
            .and_then(|held| held.project_id.clone()))
    }
}

/// `parseKbOpenScope(raw)`: a group name alone, or `{ group, projectId }` from
/// the home ask with a project chosen, where a missing or null group means
/// every starred file
fn parse_kb_open_scope(raw: Option<&IpcValue>) -> (IpcValue, Option<String>) {
    match raw {
        None => (IpcValue::Undefined, None),
        Some(IpcValue::Object(_)) => {
            let group = match field(raw, "group") {
                None | Some(IpcValue::Undefined) => IpcValue::Null,
                Some(group) => group.clone(),
            };
            let project = string_field(raw, "projectId")
                .filter(|id| !id.is_empty())
                .map(str::to_owned);
            (group, project)
        }
        Some(IpcValue::Date(_) | IpcValue::Bytes(..)) => (IpcValue::Null, None),
        Some(other) => (other.clone(), None),
    }
}

// ---- create_document: the ask panel's one write path ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KbCreateFormat {
    Md,
    Docx,
}

impl KbCreateFormat {
    fn ext(self) -> &'static str {
        match self {
            KbCreateFormat::Md => "md",
            KbCreateFormat::Docx => "docx",
        }
    }
}

#[derive(Debug, PartialEq)]
struct KbCreateRequest {
    title: String,
    format: KbCreateFormat,
    content: String,
}

/// `parseKbCreateRequest(raw)`: validate the renderer's payload
fn parse_kb_create_request(raw: Option<&IpcValue>) -> Result<KbCreateRequest, String> {
    let format = match string_field(raw, "format") {
        Some("md") => KbCreateFormat::Md,
        Some("docx") => KbCreateFormat::Docx,
        _ => return Err("format must be \"md\" or \"docx\"".to_owned()),
    };
    let content = string_field(raw, "content").unwrap_or_default();
    if trim(content).is_empty() {
        return Err("content must not be empty".to_owned());
    }
    if utf16_len(content) > KB_CREATE_MAX_CHARS {
        return Err("content is too long".to_owned());
    }
    Ok(KbCreateRequest {
        title: string_field(raw, "title").unwrap_or_default().to_owned(),
        format,
        content: content.to_owned(),
    })
}

/// `sanitizeFileBase(title)` of `mcp/tools/document-tools.ts`: a title as a file base name
fn sanitize_file_base(title: &str) -> String {
    let replaced: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\u{0}'..='\u{1f}' => '_',
            c => c,
        })
        .collect();
    let cut = slice_units(trim(&replaced), 0, 80);
    let cleaned = trim(trim(&cut).trim_matches('.'));
    if cleaned.is_empty() {
        "Untitled".to_owned()
    } else {
        cleaned.to_owned()
    }
}

/// `uniquePathIn(dir, fileName)`: the first free path, name.ext, name-2.ext, name-3.ext...
fn unique_path_in(dir: &str, file_name: &str) -> String {
    let (base, ext) = match file_name.rfind('.') {
        Some(dot) if dot > 0 => file_name.split_at(dot),
        _ => (file_name, ""),
    };
    let mut candidate = join(&[dir, file_name]);
    let mut n = 2;
    while Path::new(&candidate).exists() {
        candidate = join(&[dir, &format!("{base}-{n}{ext}")]);
        n += 1;
    }
    candidate
}

/// `markdownDocxBytes(markdown)`: the document made by the CLI in a temp
/// folder, for a project (the file reaches the project folder only through
/// its write guard, after the conversion succeeded)
fn markdown_docx_bytes(
    host: &dyn KbServices,
    temp: &Path,
    markdown: &str,
) -> Result<Vec<u8>, String> {
    let dir = temp.join(format!("seuoffice-kb-docx-{}", random_scope()));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join("document.docx");
    let made = host
        .markdown_to_docx(markdown, &out.to_string_lossy())
        .and_then(|()| fs::read(&out).map_err(|e| e.to_string()));
    let _ = fs::remove_dir_all(&dir);
    made
}

/// Where `createKnowledgeDocument` writes: a project folder through its write
/// guard, or a free path in the default save folder
enum Destination {
    Project(Placement),
    Path(String),
}

/// `createKnowledgeDocument(deps, req)` without the recent-list record: the
/// path written. A project's document is made first (Word through the CLI,
/// never inside the folder) and then written by the guard
fn write_document(
    host: &dyn KbServices,
    temp: &Path,
    req: &KbCreateRequest,
    file_name: &str,
    destination: Destination,
) -> Result<String, String> {
    match destination {
        Destination::Project(placement) => {
            let bytes = match req.format {
                KbCreateFormat::Md => req.content.clone().into_bytes(),
                KbCreateFormat::Docx => markdown_docx_bytes(host, temp, &req.content)?,
            };
            host.write_project_document(&placement, file_name, bytes)
        }
        Destination::Path(path) => {
            match req.format {
                KbCreateFormat::Md => {
                    atomic_write_file(&path, req.content.as_bytes()).map_err(node)
                }
                KbCreateFormat::Docx => host.markdown_to_docx(&req.content, &path),
            }?;
            Ok(path)
        }
    }
}

// ---- the port ----

pub struct KnowledgeBasePort {
    paths: Arc<dyn AppPaths>,
    workers: Arc<dyn Workers>,
    core: Arc<dyn Thread>,
    host: KbServicesHost,
    /// shared with the continuations that finish an awaited call on the core thread
    scopes: Arc<Mutex<KbRunScopes>>,
    /// read on a worker, as the parse it spares
    cache: Arc<Mutex<TextCache>>,
}

impl KnowledgeBasePort {
    pub fn new(
        paths: Arc<dyn AppPaths>,
        workers: Arc<dyn Workers>,
        core: Arc<dyn Thread>,
        host: KbServicesHost,
    ) -> Self {
        Self::with_scopes(paths, workers, core, host, KbRunScopes::default())
    }

    fn with_scopes(
        paths: Arc<dyn AppPaths>,
        workers: Arc<dyn Workers>,
        core: Arc<dyn Thread>,
        host: KbServicesHost,
        scopes: KbRunScopes,
    ) -> Self {
        KnowledgeBasePort {
            paths,
            workers,
            core,
            host,
            scopes: Arc::new(Mutex::new(scopes)),
            cache: Arc::new(Mutex::new(TextCache::default())),
        }
    }

    fn starred_store(&self) -> String {
        self.paths
            .path(PathName::UserData)
            .join("starred.json")
            .to_string_lossy()
            .into_owned()
    }

    /// `readStarredFiles()`
    fn starred_files(&self) -> Vec<String> {
        starred_files_of(&self.starred_store())
    }

    fn starred_groups(&self) -> HashMap<String, String> {
        starred_groups_of(&self.starred_store())
    }

    /// Runs `work` on a worker and answers on the core thread with its result
    fn answer_from_worker(
        &self,
        reply: Responder,
        work: impl FnOnce() -> Result<IpcValue, String> + Send + 'static,
    ) {
        let core = self.core.clone();
        self.workers.spawn(Box::new(move || {
            let result = work();
            core.post(Box::new(move || reply.reply(result.map_err(error))));
        }));
    }
}

fn starred_files_of(store: &str) -> Vec<String> {
    read_starred_items(store)
        .into_iter()
        .map(|item| item.path)
        .collect()
}

fn starred_groups_of(store: &str) -> HashMap<String, String> {
    starred_group_map(&read_starred_items(store))
        .iter()
        .map(|(path, group)| (path.to_owned(), group.clone()))
        .collect()
}

impl KnowledgeBase for KnowledgeBasePort {
    fn kb_open_scope(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let owner = cx.sender.view;
        let (group, project_id) = parse_kb_open_scope(args.first());
        let Some(project_id) = project_id else {
            let opened = lock(&self.scopes).open(owner, &group, &self.starred_groups());
            return reply.reply(opened.map(IpcValue::String).map_err(error));
        };
        let host = self.host.clone();
        let scopes = self.scopes.clone();
        let core = self.core.clone();
        let store = self.starred_store();
        self.workers.spawn(Box::new(move || {
            let available = host.project_available(&project_id);
            core.post(Box::new(move || {
                if !available {
                    return reply.reply(Err(error(PROJECT_UNAVAILABLE)));
                }
                let starred = match &group {
                    IpcValue::Null => StarredAsk::All,
                    group => StarredAsk::Group(group),
                };
                let opened = lock(&scopes).open_project(
                    owner,
                    &project_id,
                    starred,
                    &starred_groups_of(&store),
                );
                reply.reply(opened.map(IpcValue::String).map_err(error))
            }));
        }));
    }

    fn kb_close_scope(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        lock(&self.scopes).close(cx.sender.view, args.first());
        reply.reply(Ok(IpcValue::Undefined))
    }

    fn kb_list(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let narrowed =
            lock(&self.scopes).narrow(cx.sender.view, args.first(), &self.starred_files(), || {
                self.starred_groups()
            });
        reply.reply(
            narrowed
                .map(|starred| {
                    IpcValue::Array(
                        list_knowledge_files(&starred)
                            .iter()
                            .map(KbFile::to_ipc)
                            .collect(),
                    )
                })
                .map_err(error),
        )
    }

    fn kb_search(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let raw = args.first();
        let q = string_field(raw, "q").unwrap_or_default().to_owned();
        let limit = js_number(field(raw, "limit"));
        let limit = if limit.is_finite() {
            limit.floor().max(1.0)
        } else {
            KB_SEARCH_LIMIT_DEFAULT
        };
        if trim(&q).is_empty() || !self.host.has_file_index() {
            return reply.reply(Ok(IpcValue::Array(Vec::new())));
        }
        self.host.refresh_file_index_if_stale(INDEX_STALE_MS);
        // a file saved since its last scan is still indexed as it was before
        // the save, so only the files the index holds as they are on disk are quoted
        let starred = self.host.paths_indexed_as_on_disk(&self.starred_files());
        let owner = cx.sender.view;
        let scoped = {
            let scopes = lock(&self.scopes);
            scopes
                .narrow(owner, raw, &starred, || self.starred_groups())
                .and_then(|in_scope| Ok((in_scope, scopes.project_of(owner, raw)?)))
        };
        let (in_scope, project_id) = match scoped {
            Ok(scoped) => scoped,
            Err(refused) => return reply.reply(Err(error(refused))),
        };
        let host = self.host.clone();
        let limit = limit.min(KB_SEARCH_LIMIT_MAX) as usize;
        self.answer_from_worker(reply, move || {
            let within = project_id.and_then(|id| host.project_visible_test(&id));
            let hits = search_saved_knowledge(&*host, &q, &in_scope, limit, within);
            Ok(IpcValue::Array(
                hits.iter().map(KbSearchHit::to_ipc).collect(),
            ))
        });
    }

    fn kb_read(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let raw = args.first();
        let path = string_field(raw, "path").unwrap_or_default().to_owned();
        let offset = js_number(field(raw, "offset"));
        let offset = if offset.is_finite() {
            offset.floor()
        } else {
            0.0
        };
        if path.is_empty() {
            return reply.reply(Err(error(KB_NOT_IN_BASE)));
        }
        let owner = cx.sender.view;
        let scoped = {
            let scopes = lock(&self.scopes);
            scopes.project_of(owner, raw).and_then(|project_id| {
                // a starred file reads as before when the scope allows it
                // (a group-scoped ask reads its group only)
                let allowed = self.starred_files().contains(&path)
                    && scopes
                        .narrow(owner, raw, std::slice::from_ref(&path), || {
                            self.starred_groups()
                        })?
                        .contains(&path);
                Ok((project_id, allowed))
            })
        };
        let (project_id, starred_allowed) = match scoped {
            Ok(scoped) => scoped,
            Err(refused) => return reply.reply(Err(error(refused))),
        };
        let host = self.host.clone();
        let cache = self.cache.clone();
        self.answer_from_worker(reply, move || {
            read_knowledge_or_project_page(
                &*host,
                &cache,
                &path,
                offset,
                starred_allowed,
                project_id
                    .as_deref()
                    .map(|project_id| ProjectReach { owner, project_id }),
            )
            .map(|page| page.to_ipc())
        });
    }

    fn kb_create_document(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let req = match parse_kb_create_request(args.first()) {
            Ok(req) => req,
            Err(message) => return reply.reply(Err(error(message))),
        };
        let owner = cx.sender.view;
        let host = self.host.clone();
        let core = self.core.clone();
        let workers = self.workers.clone();
        let temp = self.paths.path(PathName::Temp);
        // the placement of a project chosen at home: the new document goes to
        // its folder's top (spec 6)
        self.workers.spawn(Box::new(move || {
            let placement = host.new_document_placement(owner);
            let after = core.clone();
            after.post(Box::new(move || {
                let file_name = format!("{}.{}", sanitize_file_base(&req.title), req.format.ext());
                let destination = match placement {
                    Err(message) => return reply.reply(Err(error(message))),
                    Ok(Some(placement)) => Destination::Project(placement),
                    Ok(None) => match host.default_save_dir() {
                        Ok(dir) => Destination::Path(unique_path_in(&dir, &file_name)),
                        Err(message) => return reply.reply(Err(error(message))),
                    },
                };
                let finish_core = core.clone();
                let finish_host = host.clone();
                workers.spawn(Box::new(move || {
                    let written = write_document(&*host, &temp, &req, &file_name, destination);
                    finish_core.post(Box::new(move || {
                        reply.reply(written.map_err(error).map(|path| {
                            finish_host.record_recent_file(&path);
                            object(vec![("path", IpcValue::String(path))])
                        }))
                    }));
                }));
            }));
        }));
    }
}

/// Names the scopes of runs, where the host wants them predictable (the
/// probe does); without one main mints `randomBytes(24).toString('hex')`
pub type KbScopeIds = Arc<dyn Fn() -> String + Send + Sync>;

/// The host the shell inserts for this port
pub fn factory() -> crate::Factory<dyn KnowledgeBase> {
    crate::Factory::new(|services, _| {
        let scopes = match services.hosts.get::<KbScopeIds>() {
            Some(ids) => {
                let ids = ids.clone();
                KbRunScopes::new(Box::new(move || ids()), KB_SCOPES_MAX)
            }
            None => KbRunScopes::default(),
        };
        let port: std::rc::Rc<dyn KnowledgeBase> =
            std::rc::Rc::new(KnowledgeBasePort::with_scopes(
                services.paths.clone(),
                services.workers.clone(),
                services.core.clone(),
                services
                    .hosts
                    .need::<KbServicesHost>(shell_contract::Batch::A)?,
                scopes,
            ));
        Ok(port)
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use main_core::docs::starred_files::{StarredItem, write_starred_items};
    use shell_contract::ipc::{Reply, Sender};
    use shell_contract::runtime::CancelToken;
    use shell_contract::{Surface, WindowId};

    use super::*;

    fn s(text: &str) -> IpcValue {
        IpcValue::String(text.into())
    }

    fn obj(entries: &[(&str, IpcValue)]) -> IpcValue {
        IpcValue::Object(
            entries
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        )
    }

    fn strings(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|p| p.to_string()).collect()
    }

    fn groups(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(p, g)| (p.to_string(), g.to_string()))
            .collect()
    }

    fn counting(max: usize) -> KbRunScopes {
        let n = Arc::new(AtomicUsize::new(0));
        KbRunScopes::new(
            Box::new(move || format!("scope-{}", n.fetch_add(1, Ordering::SeqCst) + 1)),
            max,
        )
    }

    fn with_scope(id: &str) -> IpcValue {
        obj(&[("scope", s(id))])
    }

    // ---- KbRunScopes ----

    #[test]
    fn a_scope_belongs_to_the_view_that_opened_it() {
        let mut scopes = counting(16);
        let g = groups(&[("/a", "work")]);
        let id = scopes.open(ViewId(1), &s("work"), &g).unwrap();
        let call = with_scope(&id);
        let paths = strings(&["/a", "/b"]);

        assert_eq!(
            scopes.narrow(ViewId(2), Some(&call), &paths, || g.clone()),
            Err(KB_SCOPE_UNKNOWN)
        );
        scopes.close(ViewId(2), Some(&s(&id)));
        assert_eq!(
            scopes.narrow(ViewId(1), Some(&call), &paths, || g.clone()),
            Ok(strings(&["/a"]))
        );
        scopes.close(ViewId(1), Some(&s(&id)));
        assert_eq!(
            scopes.narrow(ViewId(1), Some(&call), &paths, || g.clone()),
            Err(KB_SCOPE_UNKNOWN)
        );
    }

    #[test]
    fn a_group_scope_narrows_to_the_members_it_has_now() {
        let mut scopes = counting(16);
        let id = scopes
            .open(ViewId(1), &s("work"), &groups(&[("/a", "work")]))
            .unwrap();
        let call = with_scope(&id);
        let paths = strings(&["/a", "/b", "/c"]);
        let at = |scopes: &KbRunScopes, now: HashMap<String, String>| {
            scopes
                .narrow(ViewId(1), Some(&call), &paths, || now)
                .unwrap()
        };

        assert_eq!(
            at(
                &scopes,
                groups(&[("/a", "work"), ("/b", "work"), ("/c", "play")])
            ),
            strings(&["/a", "/b"])
        );
        // /a left the group since the scope was opened; nothing widens it back
        assert_eq!(at(&scopes, groups(&[("/b", "work")])), strings(&["/b"]));
        assert!(at(&scopes, HashMap::new()).is_empty());
    }

    #[test]
    fn a_call_without_a_scope_is_unscoped_and_never_asks_for_groups() {
        let scopes = counting(16);
        let paths = strings(&["/a", "/b"]);
        let never = || -> HashMap<String, String> { panic!("groups read for an unscoped call") };
        for raw in [
            None,
            Some(IpcValue::Null),
            Some(obj(&[])),
            Some(obj(&[("scope", IpcValue::Undefined)])),
            Some(IpcValue::Array(vec![])),
        ] {
            assert_eq!(
                scopes.narrow(ViewId(1), raw.as_ref(), &paths, never),
                Ok(paths.clone())
            );
        }
    }

    #[test]
    fn a_scope_main_does_not_hold_is_refused_never_read_as_unscoped() {
        let scopes = counting(16);
        let paths = strings(&["/a"]);
        for scope in [s("nope"), s(""), IpcValue::Null, IpcValue::Number(1.0)] {
            let raw = obj(&[("scope", scope)]);
            assert_eq!(
                scopes.narrow(ViewId(1), Some(&raw), &paths, HashMap::new),
                Err(KB_SCOPE_UNKNOWN)
            );
            assert_eq!(
                scopes.project_of(ViewId(1), Some(&raw)),
                Err(KB_SCOPE_UNKNOWN)
            );
        }
    }

    #[test]
    fn a_group_with_no_starred_files_is_refused() {
        let mut scopes = counting(16);
        let g = groups(&[("/a", "work")]);
        for group in [
            s("gone"),
            s(""),
            IpcValue::Null,
            IpcValue::Undefined,
            IpcValue::Number(3.0),
        ] {
            assert_eq!(scopes.open(ViewId(1), &group, &g), Err(KB_GROUP_EMPTY));
            assert_eq!(
                scopes.open_project(ViewId(1), "p1", StarredAsk::Group(&group), &g),
                Err(KB_GROUP_EMPTY)
            );
        }
    }

    #[test]
    fn a_project_scope_reads_its_project_and_the_starred_part_it_asked_for() {
        let mut scopes = counting(16);
        let g = groups(&[("/a", "work")]);
        let paths = strings(&["/a", "/b"]);
        let all = scopes
            .open_project(ViewId(1), "p1", StarredAsk::All, &g)
            .unwrap();
        let none = scopes
            .open_project(ViewId(1), "p2", StarredAsk::None, &g)
            .unwrap();
        let work_group = s("work");
        let group = scopes
            .open_project(ViewId(1), "p3", StarredAsk::Group(&work_group), &g)
            .unwrap();
        let plain = scopes.open(ViewId(1), &s("work"), &g).unwrap();

        let narrow =
            |id: &str| scopes.narrow(ViewId(1), Some(&with_scope(id)), &paths, || g.clone());
        assert_eq!(narrow(&all), Ok(paths.clone()));
        assert_eq!(narrow(&none), Ok(Vec::new()));
        assert_eq!(narrow(&group), Ok(strings(&["/a"])));
        let project_of = |id: &str| scopes.project_of(ViewId(1), Some(&with_scope(id)));
        assert_eq!(project_of(&all), Ok(Some("p1".to_owned())));
        assert_eq!(project_of(&none), Ok(Some("p2".to_owned())));
        assert_eq!(project_of(&group), Ok(Some("p3".to_owned())));
        assert_eq!(project_of(&plain), Ok(None));
        assert_eq!(scopes.project_of(ViewId(1), None), Ok(None));
    }

    #[test]
    fn the_oldest_scope_is_dropped_past_the_limit() {
        let mut scopes = counting(2);
        let g = groups(&[("/a", "work")]);
        let first = scopes.open(ViewId(1), &s("work"), &g).unwrap();
        let second = scopes.open(ViewId(1), &s("work"), &g).unwrap();
        let third = scopes.open(ViewId(1), &s("work"), &g).unwrap();
        let alive = |id: &str| {
            scopes
                .narrow(ViewId(1), Some(&with_scope(id)), &[], HashMap::new)
                .is_ok()
        };
        assert!(!alive(&first));
        assert!(alive(&second));
        assert!(alive(&third));
    }

    #[test]
    fn the_default_scope_is_an_opaque_random_token() {
        let mut scopes = KbRunScopes::default();
        let g = groups(&[("/a", "work")]);
        let a = scopes.open(ViewId(1), &s("work"), &g).unwrap();
        let b = scopes.open(ViewId(1), &s("work"), &g).unwrap();
        assert_ne!(a, b);
        assert_eq!(a.len(), 48);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn open_scope_takes_a_group_alone_or_a_group_and_a_project() {
        assert_eq!(parse_kb_open_scope(Some(&s("work"))), (s("work"), None));
        assert_eq!(parse_kb_open_scope(None), (IpcValue::Undefined, None));
        assert_eq!(
            parse_kb_open_scope(Some(&obj(&[("projectId", s("p1"))]))),
            (IpcValue::Null, Some("p1".to_owned()))
        );
        assert_eq!(
            parse_kb_open_scope(Some(&obj(&[("group", s("work")), ("projectId", s(""))]))),
            (s("work"), None)
        );
        assert_eq!(
            parse_kb_open_scope(Some(&obj(&[("group", IpcValue::Undefined)]))),
            (IpcValue::Null, None)
        );
    }

    // ---- the port ----

    struct Inline;
    impl Thread for Inline {
        fn post(&self, job: Box<dyn FnOnce() + Send>) {
            job()
        }
        fn is_current(&self) -> bool {
            true
        }
    }
    impl Workers for Inline {
        fn spawn(&self, job: Box<dyn FnOnce() + Send>) {
            job()
        }
    }

    struct Dir(PathBuf);
    impl AppPaths for Dir {
        fn path(&self, name: PathName) -> PathBuf {
            match name {
                PathName::Temp => self.0.join("tmp"),
                _ => self.0.clone(),
            }
        }
    }

    #[derive(Default)]
    struct State {
        no_index: bool,
        refreshes: u32,
        hits: Vec<IndexHit>,
        on_disk: HashSet<String>,
        unsaved: HashSet<String>,
        texts: HashMap<String, String>,
        parse_error: Option<Option<String>>,
        parses: u32,
        cap: Option<f64>,
        available: bool,
        visible: HashSet<String>,
        no_visible_test: bool,
        project_reads: HashMap<String, ProjectRead>,
        read_by: Vec<(ViewId, String, String, f64)>,
        placement: Option<Placement>,
        project_writes: Vec<(String, String, Vec<u8>)>,
        save_dir: String,
        docx: Vec<(String, String)>,
        recent: Vec<String>,
        searches: Vec<(String, usize, bool)>,
    }

    #[derive(Default)]
    struct Fake(Mutex<State>);

    impl Fake {
        fn state(&self) -> MutexGuard<'_, State> {
            self.0.lock().unwrap()
        }
    }

    impl KbServices for Fake {
        fn has_file_index(&self) -> bool {
            !self.state().no_index
        }
        fn refresh_file_index_if_stale(&self, max_age_ms: u64) {
            assert_eq!(max_age_ms, 60_000);
            self.state().refreshes += 1;
        }
        fn paths_indexed_as_on_disk(&self, paths: &[String]) -> Vec<String> {
            let state = self.state();
            paths
                .iter()
                .filter(|p| state.on_disk.contains(*p))
                .cloned()
                .collect()
        }
        fn index_search(
            &self,
            q: &str,
            limit: usize,
            within: Option<&dyn Fn(&str) -> bool>,
        ) -> Vec<IndexHit> {
            let mut state = self.state();
            state.searches.push((q.to_owned(), limit, within.is_some()));
            state
                .hits
                .iter()
                .filter(|hit| within.is_none_or(|within| within(&hit.path)))
                .take(limit)
                .cloned()
                .collect()
        }
        fn without_unsaved_files(&self, paths: &[String]) -> Vec<String> {
            let state = self.state();
            paths
                .iter()
                .filter(|p| !state.unsaved.contains(*p))
                .cloned()
                .collect()
        }
        fn attachable_max_bytes(&self, _ext: &str) -> f64 {
            self.state().cap.unwrap_or(f64::INFINITY)
        }
        fn parse_file_to_text(&self, path: &str) -> Result<String, Option<String>> {
            let mut state = self.state();
            state.parses += 1;
            if let Some(failure) = state.parse_error.clone() {
                return Err(failure);
            }
            Ok(state.texts.get(path).cloned().unwrap_or_default())
        }
        fn project_available(&self, _project_id: &str) -> bool {
            self.state().available
        }
        fn project_visible_test(&self, _project_id: &str) -> Option<VisibleTest> {
            if self.state().no_visible_test {
                return None;
            }
            let visible = self.state().visible.clone();
            Some(Arc::new(move |path| visible.contains(path)))
        }
        fn project_read(
            &self,
            owner: ViewId,
            project_id: &str,
            path: &str,
            offset: f64,
        ) -> ProjectRead {
            let mut state = self.state();
            state
                .read_by
                .push((owner, project_id.to_owned(), path.to_owned(), offset));
            state
                .project_reads
                .get(path)
                .cloned()
                .unwrap_or(ProjectRead::Refused(ProjectReadRefusal::NotFound))
        }
        fn new_document_placement(&self, _owner: ViewId) -> Result<Option<Placement>, String> {
            Ok(self.state().placement.clone())
        }
        fn write_project_document(
            &self,
            placement: &Placement,
            file_name: &str,
            bytes: Vec<u8>,
        ) -> Result<String, String> {
            let path = format!("{}/{file_name}", placement.dir);
            self.state().project_writes.push((
                placement.project_id.clone(),
                file_name.to_owned(),
                bytes,
            ));
            Ok(path)
        }
        fn default_save_dir(&self) -> Result<String, String> {
            Ok(self.state().save_dir.clone())
        }
        fn markdown_to_docx(&self, markdown: &str, out: &str) -> Result<(), String> {
            fs::write(out, format!("DOCX:{markdown}")).map_err(|e| e.to_string())?;
            self.state()
                .docx
                .push((markdown.to_owned(), out.to_owned()));
            Ok(())
        }
        fn record_recent_file(&self, path: &str) {
            self.state().recent.push(path.to_owned());
        }
    }

    struct Rig {
        dir: PathBuf,
        host: Arc<Fake>,
        port: KnowledgeBasePort,
    }

    fn rig(name: &str) -> Rig {
        let dir = std::env::temp_dir().join(format!("shell-a-kb-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("files")).unwrap();
        let host = Arc::new(Fake::default());
        host.state().save_dir = dir.join("saved").to_string_lossy().into_owned();
        fs::create_dir_all(dir.join("saved")).unwrap();
        let port = KnowledgeBasePort::with_scopes(
            Arc::new(Dir(dir.clone())),
            Arc::new(Inline),
            Arc::new(Inline),
            host.clone(),
            counting(16),
        );
        Rig { dir, host, port }
    }

    impl Rig {
        /// a file of the test folder, written now
        fn file(&self, name: &str, body: &str) -> String {
            let path = self.dir.join("files").join(name);
            fs::write(&path, body).unwrap();
            path.to_string_lossy().into_owned()
        }

        fn star(&self, items: &[(&str, Option<&str>)]) {
            let items: Vec<StarredItem> = items
                .iter()
                .map(|(path, group)| StarredItem {
                    path: path.to_string(),
                    group: group.map(str::to_owned),
                })
                .collect();
            write_starred_items(&self.dir.join("starred.json").to_string_lossy(), &items).unwrap();
        }
    }

    fn call_as(view: u32, f: impl FnOnce(&CallContext, Responder)) -> Reply {
        let cx = CallContext {
            sender: Sender {
                view: ViewId(view),
                window: WindowId(2),
                surface: Surface::Docs,
            },
            request: None,
            cancel: CancelToken::default(),
        };
        let out = Arc::new(Mutex::new(None));
        let slot = out.clone();
        f(
            &cx,
            Responder::new(move |r| *slot.lock().unwrap() = Some(r)),
        );
        out.lock().unwrap().take().expect("answered")
    }

    fn call(f: impl FnOnce(&CallContext, Responder)) -> Reply {
        call_as(5, f)
    }

    fn refused(reply: Reply) -> String {
        reply.expect_err("a refusal").message
    }

    fn list(r: &Rig, raw: IpcValue) -> Reply {
        call(|cx, re| r.port.kb_list(cx, vec![raw], re))
    }

    fn open_scope(r: &Rig, raw: IpcValue) -> Reply {
        call(|cx, re| r.port.kb_open_scope(cx, vec![raw], re))
    }

    fn paths_of(reply: Reply) -> Vec<String> {
        let IpcValue::Array(items) = reply.unwrap() else {
            panic!("an array")
        };
        items
            .iter()
            .map(|item| match field(Some(item), "path") {
                Some(IpcValue::String(p)) => p.clone(),
                other => panic!("no path: {other:?}"),
            })
            .collect()
    }

    fn hit(path: &str) -> IndexHit {
        IndexHit {
            path: path.into(),
            name: basename(path, None),
            ext: "md".into(),
            snippet_text: format!("about {}", basename(path, None)),
        }
    }

    #[test]
    fn the_corpus_is_the_starred_files_still_on_disk() {
        let r = rig("list");
        let a = r.file("lease.docx", "12345");
        let tar = r.file("notes.tar.GZ", "");
        let bare = r.file("README", "");
        let folder = r.dir.join("files").to_string_lossy().into_owned();
        r.star(&[
            (&a, None),
            ("/gone/missing.md", None),
            (&folder, None),
            (&tar, None),
            (&bare, None),
        ]);

        let IpcValue::Array(items) = list(&r, IpcValue::Undefined).unwrap() else {
            panic!("an array")
        };
        assert_eq!(items.len(), 3);
        assert_eq!(
            items[0],
            obj(&[
                ("path", s(&a)),
                ("folder", s("files")),
                ("folderPath", s(&folder)),
                ("name", s("lease.docx")),
                ("ext", s("docx")),
                ("sizeBytes", IpcValue::Number(5.0)),
            ])
        );
        assert_eq!(field(Some(&items[1]), "ext"), Some(&s("tar.gz")));
        assert_eq!(field(Some(&items[2]), "ext"), Some(&s("")));
    }

    #[test]
    fn a_scope_opened_for_a_group_narrows_every_later_call_until_it_is_closed() {
        let r = rig("scope-list");
        let a = r.file("a.md", "");
        let b = r.file("b.md", "");
        r.star(&[(&a, Some("work")), (&b, None)]);

        assert_eq!(
            paths_of(list(&r, IpcValue::Undefined)),
            vec![a.clone(), b.clone()]
        );
        let IpcValue::String(id) = open_scope(&r, s("work")).unwrap() else {
            panic!("a scope")
        };
        assert_eq!(paths_of(list(&r, with_scope(&id))), vec![a.clone()]);

        let other_view = call_as(6, |cx, re| r.port.kb_list(cx, vec![with_scope(&id)], re));
        assert_eq!(refused(other_view), KB_SCOPE_UNKNOWN);

        assert_eq!(
            call(|cx, re| r.port.kb_close_scope(cx, vec![s(&id)], re)),
            Ok(IpcValue::Undefined)
        );
        assert_eq!(refused(list(&r, with_scope(&id))), KB_SCOPE_UNKNOWN);
    }

    #[test]
    fn a_scope_for_a_group_nobody_starred_is_refused() {
        let r = rig("scope-empty");
        let a = r.file("a.md", "");
        r.star(&[(&a, Some("work"))]);
        assert_eq!(refused(open_scope(&r, s("play"))), KB_GROUP_EMPTY);
        assert_eq!(refused(open_scope(&r, IpcValue::Undefined)), KB_GROUP_EMPTY);
        assert_eq!(refused(open_scope(&r, obj(&[]))), KB_GROUP_EMPTY);
    }

    #[test]
    fn a_project_scope_needs_a_listed_project_and_adds_its_folder() {
        let r = rig("scope-project");
        let a = r.file("a.md", "");
        let b = r.file("b.md", "");
        r.star(&[(&a, Some("work")), (&b, None)]);
        let ask = obj(&[("projectId", s("p1"))]);

        assert_eq!(refused(open_scope(&r, ask.clone())), PROJECT_UNAVAILABLE);

        r.host.state().available = true;
        let IpcValue::String(id) = open_scope(&r, ask).unwrap() else {
            panic!("a scope")
        };
        assert_eq!(
            paths_of(list(&r, with_scope(&id))),
            vec![a.clone(), b.clone()]
        );

        let grouped = obj(&[("projectId", s("p1")), ("group", s("work"))]);
        let IpcValue::String(id) = open_scope(&r, grouped).unwrap() else {
            panic!("a scope")
        };
        assert_eq!(paths_of(list(&r, with_scope(&id))), vec![a]);

        let bad = obj(&[("projectId", s("p1")), ("group", s("play"))]);
        assert_eq!(refused(open_scope(&r, bad)), KB_GROUP_EMPTY);
    }

    fn search(r: &Rig, raw: IpcValue) -> Reply {
        call(|cx, re| r.port.kb_search(cx, vec![raw], re))
    }

    fn query(q: &str) -> IpcValue {
        obj(&[("q", s(q))])
    }

    #[test]
    fn search_quotes_only_saved_starred_files_the_index_holds_as_on_disk() {
        let r = rig("search");
        let saved = r.file("saved.md", "");
        let edited = r.file("edited.md", "");
        let stale = r.file("stale.md", "");
        let other = r.file("other.md", "");
        r.star(&[(&saved, None), (&edited, None), (&stale, None)]);
        {
            let mut st = r.host.state();
            st.hits = vec![
                hit(&other),
                hit(&edited),
                hit(&stale),
                hit(&saved),
                hit(&saved),
            ];
            st.on_disk = [saved.clone(), edited.clone(), other.clone()].into();
            st.unsaved = [edited.clone()].into();
        }

        let reply = search(&r, query("  lease  "));
        assert_eq!(
            reply.unwrap(),
            IpcValue::Array(vec![obj(&[
                ("path", s(&saved)),
                ("name", s("saved.md")),
                ("ext", s("md")),
                ("folder", s("files")),
                ("snippet", s("about saved.md")),
            ])])
        );
        let st = r.host.state();
        assert_eq!(st.refreshes, 1);
        assert_eq!(st.searches, vec![("lease".to_owned(), 200, false)]);
    }

    #[test]
    fn search_returns_nothing_for_a_blank_query_or_without_an_index() {
        let r = rig("search-none");
        let a = r.file("a.md", "");
        r.star(&[(&a, None)]);
        {
            let mut st = r.host.state();
            st.hits = vec![hit(&a)];
            st.on_disk = [a.clone()].into();
        }
        assert_eq!(search(&r, query("   ")), Ok(IpcValue::Array(vec![])));
        assert_eq!(search(&r, IpcValue::Undefined), Ok(IpcValue::Array(vec![])));
        assert_eq!(r.host.state().searches.len(), 0);
        r.host.state().no_index = true;
        assert_eq!(search(&r, query("a")), Ok(IpcValue::Array(vec![])));
        assert_eq!(r.host.state().refreshes, 0);
    }

    #[test]
    fn search_returns_eight_hits_by_default_and_never_more_than_twenty() {
        let r = rig("search-limit");
        let names: Vec<String> = (0..30)
            .map(|i| r.file(&format!("f{i:02}.md"), ""))
            .collect();
        let items: Vec<(&str, Option<&str>)> = names.iter().map(|p| (p.as_str(), None)).collect();
        r.star(&items);
        {
            let mut st = r.host.state();
            st.hits = names.iter().map(|p| hit(p)).collect();
            st.on_disk = names.iter().cloned().collect();
        }
        let count =
            |limit: IpcValue| paths_of(search(&r, obj(&[("q", s("f")), ("limit", limit)]))).len();
        assert_eq!(count(IpcValue::Undefined), 8);
        assert_eq!(count(IpcValue::Number(3.9)), 3);
        assert_eq!(count(s("5")), 5);
        assert_eq!(count(IpcValue::Number(0.0)), 1);
        assert_eq!(count(IpcValue::Number(500.0)), 20);
        assert_eq!(count(s("many")), 8);
    }

    #[test]
    fn a_group_scoped_search_looks_in_that_group_only() {
        let r = rig("search-group");
        let a = r.file("a.md", "");
        let b = r.file("b.md", "");
        r.star(&[(&a, Some("work")), (&b, None)]);
        {
            let mut st = r.host.state();
            st.hits = vec![hit(&a), hit(&b)];
            st.on_disk = [a.clone(), b.clone()].into();
        }
        let IpcValue::String(id) = open_scope(&r, s("work")).unwrap() else {
            panic!("a scope")
        };
        let scoped = obj(&[("q", s("x")), ("scope", s(&id))]);
        assert_eq!(paths_of(search(&r, scoped)), vec![a.clone()]);
        assert_eq!(paths_of(search(&r, query("x"))), vec![a, b]);
        let unknown = obj(&[("q", s("x")), ("scope", s("nope"))]);
        assert_eq!(refused(search(&r, unknown)), KB_SCOPE_UNKNOWN);
    }

    #[test]
    fn a_project_scope_widens_search_to_the_visible_saved_files_of_its_folder() {
        let r = rig("search-project");
        let starred = r.file("starred.md", "");
        let seen = r.file("seen.md", "");
        let hidden = r.file("hidden.md", "");
        let edited = r.file("edited.md", "");
        let stale = r.file("stale.md", "");
        r.star(&[(&starred, None)]);
        {
            let mut st = r.host.state();
            st.available = true;
            st.hits = vec![
                hit(&hidden),
                hit(&edited),
                hit(&stale),
                hit(&seen),
                hit(&starred),
            ];
            st.on_disk = [
                starred.clone(),
                seen.clone(),
                edited.clone(),
                hidden.clone(),
            ]
            .into();
            st.unsaved = [edited.clone()].into();
            st.visible = [seen.clone(), edited.clone(), stale.clone()].into();
        }
        let IpcValue::String(id) = open_scope(&r, obj(&[("projectId", s("p1"))])).unwrap() else {
            panic!("a scope")
        };

        let got = paths_of(search(&r, obj(&[("q", s("x")), ("scope", s(&id))])));
        assert_eq!(got, vec![seen, starred]);
        assert_eq!(r.host.state().searches, vec![("x".to_owned(), 200, true)]);
    }

    #[test]
    fn a_project_without_a_visible_test_searches_the_starred_files_alone() {
        let r = rig("search-project-gone");
        let starred = r.file("starred.md", "");
        let seen = r.file("seen.md", "");
        r.star(&[(&starred, None)]);
        {
            let mut st = r.host.state();
            st.available = true;
            st.no_visible_test = true;
            st.hits = vec![hit(&seen), hit(&starred)];
            st.on_disk = [starred.clone(), seen.clone()].into();
            st.visible = [seen.clone()].into();
        }
        let IpcValue::String(id) = open_scope(&r, obj(&[("projectId", s("p1"))])).unwrap() else {
            panic!("a scope")
        };
        let got = paths_of(search(&r, obj(&[("q", s("x")), ("scope", s(&id))])));
        assert_eq!(got, vec![starred]);
        assert_eq!(r.host.state().searches, vec![("x".to_owned(), 200, false)]);
    }

    #[test]
    fn number_reads_an_array_a_date_or_bytes_as_javascript_does() {
        let n = |value: IpcValue| js_number(Some(&value));
        assert_eq!(n(IpcValue::Array(vec![s("6")])), 6.0);
        assert_eq!(n(IpcValue::Array(vec![])), 0.0);
        assert!(
            n(IpcValue::Array(vec![
                IpcValue::Number(1.0),
                IpcValue::Number(2.0)
            ]))
            .is_nan()
        );
        assert_eq!(n(IpcValue::Date(7.0)), 7.0);
        assert_eq!(n(IpcValue::Bytes(BytesKind::Uint8Array, vec![9])), 9.0);
        assert!(n(obj(&[])).is_nan());
    }

    fn read(r: &Rig, path: &str, offset: IpcValue) -> Reply {
        call(|cx, re| {
            r.port
                .kb_read(cx, vec![obj(&[("path", s(path)), ("offset", offset)])], re)
        })
    }

    fn page(text: &str, total: f64, offset: f64) -> IpcValue {
        obj(&[
            ("text", s(text)),
            ("totalChars", IpcValue::Number(total)),
            ("offset", IpcValue::Number(offset)),
        ])
    }

    #[test]
    fn a_starred_file_reads_in_pages_counted_in_utf16_units() {
        let r = rig("read-pages");
        let a = r.file("a.md", "x");
        r.star(&[(&a, None)]);
        let long = format!("{}tail", "x".repeat(24_000));
        r.host.state().texts.insert(a.clone(), long.clone());

        assert_eq!(
            read(&r, &a, IpcValue::Undefined),
            Ok(page(&"x".repeat(24_000), 24_004.0, 0.0))
        );
        assert_eq!(
            read(&r, &a, IpcValue::Number(24_000.0)),
            Ok(page("tail", 24_004.0, 24_000.0))
        );
        assert_eq!(
            read(&r, &a, IpcValue::Number(-7.0)),
            Ok(page(&"x".repeat(24_000), 24_004.0, 0.0))
        );
        assert_eq!(read(&r, &a, s("30000")), Ok(page("", 24_004.0, 30_000.0)));

        r.host.state().texts.insert(a.clone(), "😀😀😀".into());
        fs::write(&a, "xx").unwrap();
        assert_eq!(
            read(&r, &a, IpcValue::Number(2.0)),
            Ok(page("😀😀", 6.0, 2.0))
        );
    }

    #[test]
    fn a_file_is_parsed_once_until_it_changes_on_disk() {
        let r = rig("read-cache");
        let a = r.file("a.md", "one");
        r.star(&[(&a, None)]);
        r.host.state().texts.insert(a.clone(), "first".into());
        assert_eq!(
            read(&r, &a, IpcValue::Undefined),
            Ok(page("first", 5.0, 0.0))
        );
        r.host.state().texts.insert(a.clone(), "second".into());
        assert_eq!(
            read(&r, &a, IpcValue::Undefined),
            Ok(page("first", 5.0, 0.0))
        );
        assert_eq!(r.host.state().parses, 1);

        fs::write(&a, "longer than before").unwrap();
        assert_eq!(
            read(&r, &a, IpcValue::Undefined),
            Ok(page("second", 6.0, 0.0))
        );
        assert_eq!(r.host.state().parses, 2);
    }

    #[test]
    fn the_text_cache_keeps_the_eight_newest_files() {
        let r = rig("read-evict");
        let names: Vec<String> = (0..9).map(|i| r.file(&format!("f{i}.md"), "x")).collect();
        let items: Vec<(&str, Option<&str>)> = names.iter().map(|p| (p.as_str(), None)).collect();
        r.star(&items);
        for name in &names {
            read(&r, name, IpcValue::Undefined).unwrap();
        }
        assert_eq!(r.host.state().parses, 9);
        read(&r, &names[8], IpcValue::Undefined).unwrap();
        assert_eq!(r.host.state().parses, 9);
        read(&r, &names[0], IpcValue::Undefined).unwrap();
        assert_eq!(r.host.state().parses, 10);
    }

    #[test]
    fn a_file_with_unsaved_changes_is_not_read_even_when_cached() {
        let r = rig("read-unsaved");
        let a = r.file("a.md", "x");
        r.star(&[(&a, None)]);
        r.host.state().texts.insert(a.clone(), "text".into());
        read(&r, &a, IpcValue::Undefined).unwrap();
        r.host.state().unsaved.insert(a.clone());
        assert_eq!(
            refused(read(&r, &a, IpcValue::Undefined)),
            UNSAVED_CHANGES_MESSAGE
        );
    }

    #[test]
    fn a_file_over_its_cap_is_refused_before_it_is_parsed() {
        let r = rig("read-large");
        let big = r.file("big.pdf", "");
        fs::File::options()
            .write(true)
            .open(&big)
            .unwrap()
            .set_len(52 * 1024 * 1024)
            .unwrap();
        r.star(&[(&big, None)]);
        r.host.state().cap = Some(1024.0);
        assert_eq!(
            refused(read(&r, &big, IpcValue::Undefined)),
            "file too large to read (52MB, cap 50MB)"
        );
        r.host.state().cap = None;
        assert_eq!(read(&r, &big, IpcValue::Undefined), Ok(page("", 0.0, 0.0)));
        assert_eq!(r.host.state().parses, 1);
    }

    #[test]
    fn a_parse_failure_reads_as_the_parsers_message_or_unreadable() {
        let r = rig("read-parse");
        let a = r.file("a.md", "x");
        r.star(&[(&a, None)]);
        r.host.state().parse_error = Some(Some("password protected".into()));
        assert_eq!(
            refused(read(&r, &a, IpcValue::Undefined)),
            "password protected"
        );
        r.host.state().parse_error = Some(None);
        assert_eq!(
            refused(read(&r, &a, IpcValue::Undefined)),
            "unreadable file"
        );
    }

    #[test]
    fn a_path_outside_the_starred_set_or_the_scope_is_outside_the_base() {
        let r = rig("read-base");
        let a = r.file("a.md", "x");
        let b = r.file("b.md", "x");
        let loose = r.file("loose.md", "x");
        r.star(&[(&a, Some("work")), (&b, None)]);
        r.host.state().texts.insert(a.clone(), "a".into());
        r.host.state().texts.insert(loose.clone(), "loose".into());

        assert_eq!(
            refused(read(&r, &loose, IpcValue::Undefined)),
            KB_NOT_IN_BASE
        );
        assert_eq!(refused(read(&r, "", IpcValue::Undefined)), KB_NOT_IN_BASE);
        let IpcValue::String(id) = open_scope(&r, s("work")).unwrap() else {
            panic!("a scope")
        };
        let scoped = |path: &str| {
            call(|cx, re| {
                r.port
                    .kb_read(cx, vec![obj(&[("path", s(path)), ("scope", s(&id))])], re)
            })
        };
        assert_eq!(scoped(&a), Ok(page("a", 1.0, 0.0)));
        assert_eq!(refused(scoped(&b)), KB_NOT_IN_BASE);
        assert_eq!(
            refused(call(|cx, re| r.port.kb_read(
                cx,
                vec![obj(&[("path", s(&a)), ("scope", s("nope"))])],
                re
            ))),
            KB_SCOPE_UNKNOWN
        );
        assert_eq!(r.host.state().read_by, vec![]);
    }

    #[test]
    fn a_project_scope_reads_files_of_its_project_and_names_why_one_is_refused() {
        let r = rig("read-project");
        r.host.state().available = true;
        let IpcValue::String(id) = open_scope(&r, obj(&[("projectId", s("p1"))])).unwrap() else {
            panic!("a scope")
        };
        {
            let mut st = r.host.state();
            st.project_reads.insert(
                "/proj/ok.md".into(),
                ProjectRead::Ok {
                    text: "project text".into(),
                    total_chars: 12.0,
                    offset: 3.0,
                },
            );
            st.project_reads
                .insert("/proj/cloud.md".into(), ProjectRead::Declined);
            for (name, why) in [
                ("unsaved", ProjectReadRefusal::Unsaved),
                ("large", ProjectReadRefusal::TooLarge),
                ("broken", ProjectReadRefusal::Unreadable),
                ("outside", ProjectReadRefusal::Outside),
                ("hidden", ProjectReadRefusal::Hidden),
                ("ignored", ProjectReadRefusal::Ignored),
                ("missing", ProjectReadRefusal::NotFound),
            ] {
                st.project_reads
                    .insert(format!("/proj/{name}.md"), ProjectRead::Refused(why));
            }
        }
        let project_read = |name: &str| {
            call(|cx, re| {
                r.port.kb_read(
                    cx,
                    vec![obj(&[
                        ("path", s(&format!("/proj/{name}.md"))),
                        ("offset", IpcValue::Number(3.5)),
                        ("scope", s(&id)),
                    ])],
                    re,
                )
            })
        };

        assert_eq!(project_read("ok"), Ok(page("project text", 12.0, 3.0)));
        assert_eq!(
            r.host.state().read_by,
            vec![(ViewId(5), "p1".to_owned(), "/proj/ok.md".to_owned(), 3.0)]
        );
        assert_eq!(refused(project_read("cloud")), KB_DOWNLOAD_DECLINED);
        assert_eq!(refused(project_read("unsaved")), UNSAVED_CHANGES_MESSAGE);
        assert_eq!(
            {
                r.host.state().cap = Some(1024.0);
                refused(project_read("large"))
            },
            "file too large to read (cap 50MB)"
        );
        assert_eq!(refused(project_read("broken")), "unreadable file");
        for outside in ["outside", "hidden", "ignored", "missing"] {
            assert_eq!(refused(project_read(outside)), KB_NOT_IN_BASE);
        }
    }

    fn create(r: &Rig, title: &str, format: &str, content: &str) -> Reply {
        call(|cx, re| {
            r.port.kb_create_document(
                cx,
                vec![obj(&[
                    ("title", s(title)),
                    ("format", s(format)),
                    ("content", s(content)),
                ])],
                re,
            )
        })
    }

    fn created_path(reply: Reply) -> String {
        match field(Some(&reply.unwrap()), "path") {
            Some(IpcValue::String(p)) => p.clone(),
            other => panic!("no path: {other:?}"),
        }
    }

    #[test]
    fn a_new_markdown_document_lands_in_the_default_folder_under_a_free_name() {
        let r = rig("create-md");
        let saved = r.host.state().save_dir.clone();

        let first = created_path(create(&r, "Q3: plan/draft?", "md", "# Plan"));
        assert_eq!(first, format!("{saved}/Q3_ plan_draft_.md"));
        assert_eq!(fs::read_to_string(&first).unwrap(), "# Plan");
        let second = created_path(create(&r, "Q3: plan/draft?", "md", "# Again"));
        assert_eq!(second, format!("{saved}/Q3_ plan_draft_-2.md"));
        assert_eq!(fs::read_to_string(&first).unwrap(), "# Plan");
        let untitled = created_path(create(&r, " ..  ", "md", "x"));
        assert_eq!(untitled, format!("{saved}/Untitled.md"));

        assert_eq!(r.host.state().recent, vec![first, second, untitled]);
        assert!(r.host.state().project_writes.is_empty());
    }

    #[test]
    fn a_new_word_document_is_made_by_the_cli_at_the_free_path() {
        let r = rig("create-docx");
        let saved = r.host.state().save_dir.clone();
        let path = created_path(create(&r, "Memo", "docx", "# Hi"));
        assert_eq!(path, format!("{saved}/Memo.docx"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "DOCX:# Hi");
        assert_eq!(r.host.state().docx, vec![("# Hi".to_owned(), path.clone())]);
        assert_eq!(r.host.state().recent, vec![path]);
    }

    #[test]
    fn with_a_project_chosen_the_document_goes_through_the_project_guide_only() {
        let r = rig("create-project");
        let saved = r.host.state().save_dir.clone();
        r.host.state().placement = Some(Placement {
            project_id: "p1".into(),
            root: "/proj".into(),
            dir: "/proj".into(),
        });

        let md = created_path(create(&r, "Notes", "md", "# N"));
        let docx = created_path(create(&r, "Brief", "docx", "# B"));
        assert_eq!(
            (md.as_str(), docx.as_str()),
            ("/proj/Notes.md", "/proj/Brief.docx")
        );

        let st = r.host.state();
        assert_eq!(
            st.project_writes,
            vec![
                ("p1".to_owned(), "Notes.md".to_owned(), b"# N".to_vec()),
                (
                    "p1".to_owned(),
                    "Brief.docx".to_owned(),
                    b"DOCX:# B".to_vec()
                ),
            ]
        );
        assert_eq!(st.recent, vec![md, docx]);
        assert_eq!(fs::read_dir(&saved).unwrap().count(), 0);
        let temp = r.dir.join("tmp");
        assert_eq!(
            fs::read_dir(&temp).unwrap().count(),
            0,
            "the CLI's temp folder is removed"
        );
    }

    #[test]
    fn a_bad_create_request_is_refused_before_anything_is_written() {
        let r = rig("create-bad");
        assert_eq!(
            refused(create(&r, "t", "pdf", "x")),
            "format must be \"md\" or \"docx\""
        );
        assert_eq!(
            refused(call(|cx, re| r.port.kb_create_document(cx, vec![], re))),
            "format must be \"md\" or \"docx\""
        );
        assert_eq!(
            refused(create(&r, "t", "md", " \n ")),
            "content must not be empty"
        );
        assert_eq!(
            refused(create(&r, "t", "md", &"x".repeat(KB_CREATE_MAX_CHARS + 1))),
            "content is too long"
        );
        assert!(create(&r, "t", "md", &"x".repeat(KB_CREATE_MAX_CHARS)).is_ok());
        assert_eq!(r.host.state().recent.len(), 1);
    }

    #[test]
    fn titles_become_safe_file_names() {
        assert_eq!(
            sanitize_file_base("a/b\\c:d*e?f\"g<h>i|j\u{1}k"),
            "a_b_c_d_e_f_g_h_i_j_k"
        );
        assert_eq!(sanitize_file_base("  ..report.. "), "report");
        assert_eq!(sanitize_file_base(".."), "Untitled");
        assert_eq!(sanitize_file_base(&"y".repeat(100)).len(), 80);
        assert_eq!(unique_path_in("/nope", "a.md"), "/nope/a.md");
    }
}
