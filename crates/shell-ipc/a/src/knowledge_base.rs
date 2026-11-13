//! The knowledge-base channels of the shell entry (`kb:*` of
//! `apps/shell/src/main/index.ts`) over `apps/shell/src/main/knowledge-base.ts`:
//! the reader's starred files (and, for a home ask with a project chosen, that
//! project's folder) as the AI can list, search, read, and the one write path
//! of the ask panel, a new document.
//!
//! The module's logic is `main_core::shell::knowledge_base`: the run scopes,
//! the corpus listing, the search filters, the read paging with its text
//! cache and the create flow. This file keeps what the shell entry does around
//! it: decoding the `kb:*` arguments, encoding the answers, the index search
//! closures, the parser, the real [`KbCreateDeps`] and the project reads, all
//! over [`KbServices`] (what the TypeScript took from modules that are not in
//! `main-core`).
//!
//! # Threads
//!
//! Handlers run on the core thread and never block it. The run scopes are
//! opened, narrowed and closed there. Everything that parses a file, searches
//! the index or writes runs on a worker, which answers by posting back to the
//! core thread. `main-core` asks "is this file open with unsaved changes?" of
//! an [`OpenFilesHolder`], which is not `Send`; a worker builds its own holder
//! over [`KbServices::open_files`], so the question is asked of the host at
//! the moment `main-core` asks it, as the TypeScript does.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use jscompat::{JsMap, JsonValue, number_to_string, to_number, trim};
use main_core::docs::starred_files::{read_starred_items, starred_group_map};
use main_core::packages::ai_provider::user_skills_import::random_hex;
use main_core::packages::electron_utils::default_save_dir::Thrown;
use main_core::packages::electron_utils::unsaved_files::{
    OpenFileState, OpenFilesHolder, OpenFilesSourceFailed,
};
use main_core::packages::project_store::ProjectReadResult;
use main_core::shell::atomic_write::atomic_write_file;
use main_core::shell::generate::materials::{FileParser, ParsedFile};
use main_core::shell::knowledge_base::{
    IndexedHit, KB_GROUP_EMPTY, KB_NOT_IN_BASE, KB_SCOPES_MAX, KbCreateDeps, KbCreateProject,
    KbFile, KbOpenScope, KbReadPage, KbRunScopes, KbSearchHit, KbStarredReach, KbTextCache,
    KbWithin, create_knowledge_document, list_knowledge_files, parse_kb_create_request,
    parse_kb_open_scope, read_knowledge_or_project_page, search_saved_knowledge_with_project,
};
use main_core::shell::mcp::tools::document_tools::{sanitize_file_base, unique_path_in};
use main_core::shell::projects::project_tools::PROJECT_UNAVAILABLE;
use main_core::shell::renderer_disposal::Failure;
use shell_contract::ipc::{CallContext, Responder};
use shell_contract::runtime::{AppPaths, PathName, Thread, Workers};
use shell_contract::value::BytesKind;
use shell_contract::{IpcError, IpcValue, ViewId};

use crate::ports::KnowledgeBase;
use crate::value::to_json;

/// the most hits one search returns
const KB_SEARCH_LIMIT_MAX: f64 = 20.0;
const KB_SEARCH_LIMIT_DEFAULT: f64 = 8.0;
/// `refreshIfStale(60_000)`: a stale index shows when a search is asked
const INDEX_STALE_MS: u64 = 60_000;

// ---- what the shell entry reaches outside main-core ----

/// A project's "visible to the AI" test on absolute paths (`tools.visibleTest`)
pub type VisibleTest = Arc<dyn Fn(&str) -> bool + Send + Sync>;

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
    /// `store.search(q, { limit, within }).hits`, worker thread, each hit with
    /// its excerpt already joined (`snippet.map(part => part.text).join('')`).
    /// `within` narrows the query itself, so starred and project files rank
    /// together
    fn index_search(
        &self,
        q: &str,
        limit: f64,
        within: KbWithin<'_>,
    ) -> Result<Vec<IndexedHit>, Thrown>;
    /// The list the `Symbol.for('seuoffice.open-files-source')` slot holds
    /// (what `@seuoffice/electron-utils/unsaved-files` asks), worker thread
    fn open_files(&self) -> Result<Vec<OpenFileState>, OpenFilesSourceFailed>;
    /// `parseFileToText(path)` of `@seuoffice/file-parse`, worker thread
    fn parse_file_to_text(&self, path: &str) -> Result<ParsedFile, Failure>;
    /// `projectFolderServices().tools.isAvailable(projectId)`, worker thread
    fn project_available(&self, project_id: &str) -> bool;
    /// `projectFolderServices().tools.visibleTest(projectId)`, worker thread;
    /// `None` when the project is not available (`null`)
    fn project_visible_test(&self, project_id: &str) -> Option<VisibleTest>;
    /// `projectFolderServices().tools.readPath(owner, projectId, path, offset)`,
    /// worker thread
    fn project_read(
        &self,
        owner: ViewId,
        project_id: &str,
        path: &str,
        offset: f64,
    ) -> ProjectReadResult;
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
    /// `recordRecentFile(path)` of docs-main (the recent list and its menu),
    /// core thread
    fn record_recent_file(&self, path: &str);
}

pub type KbServicesHost = Arc<dyn KbServices + Send + Sync>;

// ---- decoding the arguments ----

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

/// `value` with each date and each byte buffer replaced by an empty object:
/// JSON has no form for them, and dropping one would turn `{ scope: <date> }`
/// into a call without a scope. As an empty object it is a value of the key
/// that is neither a string nor `null`, which is how every check of
/// `main-core` reads what the TypeScript reads of a date (no own property).
fn opaque(value: &IpcValue) -> IpcValue {
    match value {
        IpcValue::Date(_) | IpcValue::Bytes(..) => IpcValue::Object(Vec::new()),
        IpcValue::Array(items) => IpcValue::Array(items.iter().map(opaque).collect()),
        IpcValue::Object(entries) => IpcValue::Object(
            entries
                .iter()
                .map(|(key, value)| (key.clone(), opaque(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The `kb:*` argument as `main-core`'s functions take it (`raw: unknown`)
fn call_arg(args: &[IpcValue]) -> Option<JsonValue> {
    args.first().and_then(|raw| to_json(&opaque(raw)))
}

// ---- encoding the answers ----

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

fn thrown(thrown: Thrown) -> IpcError {
    error(thrown.0)
}

fn file_ipc(file: &KbFile) -> IpcValue {
    object(vec![
        ("path", IpcValue::String(file.path.clone())),
        ("folder", IpcValue::String(file.folder.clone())),
        ("folderPath", IpcValue::String(file.folder_path.clone())),
        ("name", IpcValue::String(file.name.clone())),
        ("ext", IpcValue::String(file.ext.clone())),
        ("sizeBytes", IpcValue::Number(file.size_bytes as f64)),
    ])
}

fn hit_ipc(hit: &KbSearchHit) -> IpcValue {
    object(vec![
        ("path", IpcValue::String(hit.path.clone())),
        ("name", IpcValue::String(hit.name.clone())),
        ("ext", IpcValue::String(hit.ext.clone())),
        ("folder", IpcValue::String(hit.folder.clone())),
        ("snippet", IpcValue::String(hit.snippet.clone())),
    ])
}

fn page_ipc(page: &KbReadPage) -> IpcValue {
    object(vec![
        ("text", IpcValue::String(page.text.clone())),
        ("totalChars", IpcValue::Number(page.total_chars as f64)),
        ("offset", IpcValue::Number(page.offset)),
    ])
}

// ---- main-core's seams over the host ----

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The holder `main-core` asks about unsaved changes, over the host's list of
/// open documents. Built where it is used: it is not `Send`
fn open_files_holder(host: &KbServicesHost) -> OpenFilesHolder {
    let host = host.clone();
    let mut holder = OpenFilesHolder::new();
    holder.set_open_files_source(Some(Box::new(move || host.open_files())));
    holder
}

/// `parseFileToText`, as the knowledge read gets it
struct HostParser<'a>(&'a dyn KbServices);

impl FileParser for HostParser<'_> {
    fn parse_file_to_text(&mut self, path: &str) -> Result<ParsedFile, Failure> {
        self.0.parse_file_to_text(path)
    }
}

/// `searchSavedKnowledgeWithProject` over the index and the project's test
fn search_saved(
    host: &KbServicesHost,
    query: &str,
    starred_paths: &[String],
    limit: f64,
    within: Option<VisibleTest>,
) -> Result<Vec<KbSearchHit>, Thrown> {
    let open_files = open_files_holder(host);
    let mut visible =
        within.map(|test| move |path: &str| -> Result<bool, Thrown> { Ok(test(path)) });
    search_saved_knowledge_with_project(
        &open_files,
        &mut |q, pool, within| host.index_search(q, pool, within),
        query,
        starred_paths,
        limit,
        visible
            .as_mut()
            .map(|test| test as &mut dyn FnMut(&str) -> Result<bool, Thrown>),
        &mut |paths| host.paths_indexed_as_on_disk(paths),
    )
}

/// `markdownDocxBytes(markdown)`: the document made by the CLI in a temp
/// folder, for a project (the file reaches the project folder only through
/// its write guard, after the conversion succeeded)
fn markdown_docx_bytes(
    host: &dyn KbServices,
    temp: &Path,
    markdown: &str,
) -> Result<Vec<u8>, String> {
    let dir = temp.join(format!("seuoffice-kb-docx-{}", random_hex(24)));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join("document.docx");
    let made = host
        .markdown_to_docx(markdown, &out.to_string_lossy())
        .and_then(|()| fs::read(&out).map_err(|e| e.to_string()));
    let _ = fs::remove_dir_all(&dir);
    made
}

/// `KbCreateDeps.project`: a project chosen at home
struct ProjectDocs {
    host: KbServicesHost,
    placement: Placement,
    temp: PathBuf,
}

impl KbCreateProject for ProjectDocs {
    fn write(&mut self, file_name: &str, bytes: &[u8]) -> Result<String, Thrown> {
        self.host
            .write_project_document(&self.placement, file_name, bytes.to_vec())
            .map_err(Thrown)
    }

    fn docx_bytes(&mut self, markdown: &str) -> Result<Vec<u8>, Thrown> {
        markdown_docx_bytes(&*self.host, &self.temp, markdown).map_err(Thrown)
    }
}

/// The deps of `createKnowledgeDocument`, run on a worker. The recent list is
/// the core thread's, so the paths it is told of are kept and told there
struct CreateDeps {
    host: KbServicesHost,
    /// the default save folder; only read when there is no project
    dir: String,
    project: Option<ProjectDocs>,
    recorded: Vec<String>,
}

impl KbCreateDeps for CreateDeps {
    fn dir(&mut self) -> Result<String, Thrown> {
        Ok(self.dir.clone())
    }

    fn unique_path(&mut self, dir: &str, file_name: &str) -> Result<String, Thrown> {
        Ok(unique_path_in(dir, file_name))
    }

    fn sanitize_base(&mut self, title: &str) -> Result<String, Thrown> {
        Ok(sanitize_file_base(title))
    }

    fn write_text(&mut self, path: &str, text: &str) -> Result<(), Thrown> {
        atomic_write_file(path, text.as_bytes()).map_err(|e| Thrown(e.message))
    }

    fn markdown_to_docx(&mut self, markdown: &str, out: &str) -> Result<(), Thrown> {
        self.host.markdown_to_docx(markdown, out).map_err(Thrown)
    }

    fn record_recent(&mut self, path: &str) -> Result<(), Thrown> {
        self.recorded.push(path.to_owned());
        Ok(())
    }

    fn project(&mut self) -> Option<&mut dyn KbCreateProject> {
        self.project
            .as_mut()
            .map(|project| project as &mut dyn KbCreateProject)
    }
}

// ---- the port ----

pub struct KnowledgeBasePort {
    paths: Arc<dyn AppPaths>,
    workers: Arc<dyn Workers>,
    core: Arc<dyn Thread>,
    host: KbServicesHost,
    /// only the core thread touches it, but the continuations that finish an
    /// awaited call are `Send`
    scopes: Arc<Mutex<KbRunScopes>>,
    /// read on a worker, as the parse it spares
    cache: Arc<Mutex<KbTextCache>>,
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
            cache: Arc::new(Mutex::new(KbTextCache::new())),
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

    /// `readStarredGroupMap()`
    fn starred_groups(&self) -> JsMap<String> {
        starred_groups_of(&self.starred_store())
    }

    /// Runs `work` on a worker and answers on the core thread with its result
    fn answer_from_worker(
        &self,
        reply: Responder,
        work: impl FnOnce() -> Result<IpcValue, Thrown> + Send + 'static,
    ) {
        let core = self.core.clone();
        self.workers.spawn(Box::new(move || {
            let result = work();
            core.post(Box::new(move || reply.reply(result.map_err(thrown))));
        }));
    }
}

fn starred_files_of(store: &str) -> Vec<String> {
    read_starred_items(store)
        .into_iter()
        .map(|item| item.path)
        .collect()
}

fn starred_groups_of(store: &str) -> JsMap<String> {
    starred_group_map(&read_starred_items(store))
}

impl KnowledgeBase for KnowledgeBasePort {
    fn kb_open_scope(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let owner = i64::from(cx.sender.view.0);
        let raw = call_arg(&args);
        let KbOpenScope { group, project_id } = parse_kb_open_scope(raw.as_ref());
        let Some(project_id) = project_id else {
            let opened = lock(&self.scopes).open(owner, group.as_ref(), &self.starred_groups());
            return reply.reply(opened.map(IpcValue::String).map_err(thrown));
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
                // a missing or null group is every starred file; a group that
                // is not a name is refused as a group nobody starred
                let starred = match group {
                    None | Some(JsonValue::Null) => KbStarredReach::All,
                    Some(JsonValue::String(group)) => KbStarredReach::Group(group),
                    Some(_) => return reply.reply(Err(error(KB_GROUP_EMPTY))),
                };
                let opened = lock(&scopes).open_project(
                    owner,
                    &project_id,
                    starred,
                    &starred_groups_of(&store),
                );
                reply.reply(opened.map(IpcValue::String).map_err(thrown))
            }));
        }));
    }

    fn kb_close_scope(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        lock(&self.scopes).close(i64::from(cx.sender.view.0), call_arg(&args).as_ref());
        reply.reply(Ok(IpcValue::Undefined))
    }

    fn kb_list(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let raw = call_arg(&args);
        let narrowed = lock(&self.scopes).narrow(
            i64::from(cx.sender.view.0),
            raw.as_ref(),
            &self.starred_files(),
            || self.starred_groups(),
        );
        reply.reply(
            narrowed
                .map(|starred| {
                    IpcValue::Array(
                        list_knowledge_files(&starred)
                            .iter()
                            .map(file_ipc)
                            .collect(),
                    )
                })
                .map_err(thrown),
        )
    }

    fn kb_search(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let query = args.first();
        let q = string_field(query, "q").unwrap_or_default().to_owned();
        let limit = js_number(field(query, "limit"));
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
        let owner = i64::from(cx.sender.view.0);
        let raw = call_arg(&args);
        let scoped = {
            let scopes = lock(&self.scopes);
            scopes
                .narrow(owner, raw.as_ref(), &starred, || self.starred_groups())
                .and_then(|in_scope| Ok((in_scope, scopes.project_of(owner, raw.as_ref())?)))
        };
        let (in_scope, project_id) = match scoped {
            Ok(scoped) => scoped,
            Err(refused) => return reply.reply(Err(thrown(refused))),
        };
        let host = self.host.clone();
        self.answer_from_worker(reply, move || {
            let within = project_id.and_then(|id| host.project_visible_test(&id));
            let hits = search_saved(&host, &q, &in_scope, limit.min(KB_SEARCH_LIMIT_MAX), within)?;
            Ok(IpcValue::Array(hits.iter().map(hit_ipc).collect()))
        });
    }

    fn kb_read(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let req = args.first();
        let path = string_field(req, "path").unwrap_or_default().to_owned();
        let offset = js_number(field(req, "offset"));
        let offset = if offset.is_finite() {
            offset.floor()
        } else {
            0.0
        };
        if path.is_empty() {
            return reply.reply(Err(error(KB_NOT_IN_BASE)));
        }
        let view = cx.sender.view;
        let owner = i64::from(view.0);
        let raw = call_arg(&args);
        let scoped = {
            let scopes = lock(&self.scopes);
            scopes
                .project_of(owner, raw.as_ref())
                .and_then(|project_id| {
                    // a starred file reads as before when the scope allows it
                    // (a group-scoped ask reads its group only)
                    let allowed = self.starred_files().contains(&path)
                        && scopes
                            .narrow(owner, raw.as_ref(), std::slice::from_ref(&path), || {
                                self.starred_groups()
                            })?
                            .contains(&path);
                    Ok((project_id, allowed))
                })
        };
        let (project_id, starred_allowed) = match scoped {
            Ok(scoped) => scoped,
            Err(refused) => return reply.reply(Err(thrown(refused))),
        };
        let host = self.host.clone();
        let cache = self.cache.clone();
        self.answer_from_worker(reply, move || {
            let open_files = open_files_holder(&host);
            let mut read_project = project_id.as_deref().map(|project_id| {
                let host = &host;
                move |target: &str, at: f64| -> Result<ProjectReadResult, Thrown> {
                    Ok(host.project_read(view, project_id, target, at))
                }
            });
            let page = read_knowledge_or_project_page(
                &open_files,
                &mut lock(&cache),
                &mut HostParser(&*host),
                &path,
                offset,
                starred_allowed,
                read_project.as_mut().map(|read| {
                    read as &mut dyn FnMut(&str, f64) -> Result<ProjectReadResult, Thrown>
                }),
            )?;
            Ok(page_ipc(&page))
        });
    }

    fn kb_create_document(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let req = match parse_kb_create_request(call_arg(&args).as_ref()) {
            Ok(req) => req,
            Err(refused) => return reply.reply(Err(thrown(refused))),
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
                let (project, dir) = match placement {
                    Err(message) => return reply.reply(Err(error(message))),
                    Ok(Some(placement)) => (
                        Some(ProjectDocs {
                            host: host.clone(),
                            placement,
                            temp,
                        }),
                        String::new(),
                    ),
                    Ok(None) => match host.default_save_dir() {
                        Ok(dir) => (None, dir),
                        Err(message) => return reply.reply(Err(error(message))),
                    },
                };
                let finish_core = core.clone();
                workers.spawn(Box::new(move || {
                    let mut deps = CreateDeps {
                        host,
                        dir,
                        project,
                        recorded: Vec::new(),
                    };
                    let created = create_knowledge_document(&mut deps, &req);
                    let CreateDeps { host, recorded, .. } = deps;
                    finish_core.post(Box::new(move || {
                        for path in &recorded {
                            host.record_recent_file(path);
                        }
                        reply.reply(
                            created
                                .map(|created| {
                                    object(vec![("path", IpcValue::String(created.path))])
                                })
                                .map_err(thrown),
                        )
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
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use jscompat::JsNum;
    use jscompat::node_path::host::basename;
    use main_core::docs::starred_files::{StarredItem, write_starred_items};
    use main_core::packages::electron_utils::unsaved_files::UNSAVED_CHANGES_MESSAGE;
    use main_core::packages::project_store::ProjectReadRefusal;
    use main_core::shell::knowledge_base::{KB_DOWNLOAD_DECLINED, KB_SCOPE_UNKNOWN};
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

    fn with_scope(id: &str) -> IpcValue {
        obj(&[("scope", s(id))])
    }

    fn counting_scopes() -> KbRunScopes {
        let n = Arc::new(AtomicUsize::new(0));
        KbRunScopes::new(
            Box::new(move || format!("scope-{}", n.fetch_add(1, Ordering::SeqCst) + 1)),
            KB_SCOPES_MAX,
        )
    }

    /// Runs every job at once, on the caller's thread
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

    /// Keeps every job until the test runs it: the core thread and a worker
    #[derive(Default)]
    struct Queued(Mutex<VecDeque<Box<dyn FnOnce() + Send>>>);
    impl Queued {
        /// runs the oldest job, `false` when there is none
        fn run_next(&self) -> bool {
            let job = lock(&self.0).pop_front();
            job.map(|job| job()).is_some()
        }
        fn len(&self) -> usize {
            lock(&self.0).len()
        }
    }
    impl Thread for Queued {
        fn post(&self, job: Box<dyn FnOnce() + Send>) {
            lock(&self.0).push_back(job);
        }
        fn is_current(&self) -> bool {
            true
        }
    }
    impl Workers for Queued {
        fn spawn(&self, job: Box<dyn FnOnce() + Send>) {
            lock(&self.0).push_back(job);
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
        hits: Vec<IndexedHit>,
        on_disk: HashSet<String>,
        unsaved: HashSet<String>,
        open_files_asked: u32,
        texts: HashMap<String, String>,
        parses: u32,
        available: bool,
        visible: HashSet<String>,
        no_visible_test: bool,
        project_reads: HashMap<String, ProjectReadResult>,
        read_by: Vec<(ViewId, String, String, f64)>,
        placement: Option<Placement>,
        project_writes: Vec<(String, String, Vec<u8>)>,
        save_dir: String,
        docx: Vec<(String, String)>,
        recent: Vec<String>,
        searches: Vec<(String, f64, bool)>,
    }

    #[derive(Default)]
    struct Fake(Mutex<State>);

    impl Fake {
        fn state(&self) -> MutexGuard<'_, State> {
            lock(&self.0)
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
            limit: f64,
            mut within: KbWithin<'_>,
        ) -> Result<Vec<IndexedHit>, Thrown> {
            let mut state = self.state();
            state.searches.push((q.to_owned(), limit, within.is_some()));
            let mut found = Vec::new();
            for hit in &state.hits {
                let inside = match within.as_mut() {
                    Some(within) => within(&hit.path)?,
                    None => true,
                };
                if inside && (found.len() as f64) < limit {
                    found.push(hit.clone());
                }
            }
            Ok(found)
        }
        fn open_files(&self) -> Result<Vec<OpenFileState>, OpenFilesSourceFailed> {
            let mut state = self.state();
            state.open_files_asked += 1;
            Ok(state
                .unsaved
                .iter()
                .map(|path| OpenFileState {
                    file_path: Some(path.clone()),
                    dirty: true,
                })
                .collect())
        }
        fn parse_file_to_text(&self, path: &str) -> Result<ParsedFile, Failure> {
            let mut state = self.state();
            state.parses += 1;
            Ok(ParsedFile {
                ok: true,
                kind: Some("text".into()),
                text: Some(state.texts.get(path).cloned().unwrap_or_default()),
                error: None,
            })
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
        ) -> ProjectReadResult {
            let mut state = self.state();
            state
                .read_by
                .push((owner, project_id.to_owned(), path.to_owned(), offset));
            state
                .project_reads
                .get(path)
                .cloned()
                .unwrap_or(ProjectReadResult::Refused {
                    reason: ProjectReadRefusal::NotFound,
                })
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

    fn rig_on(name: &str, workers: Arc<dyn Workers>, core: Arc<dyn Thread>) -> Rig {
        let dir = std::env::temp_dir().join(format!("shell-a-kb-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("files")).unwrap();
        let host = Arc::new(Fake::default());
        host.state().save_dir = dir.join("saved").to_string_lossy().into_owned();
        fs::create_dir_all(dir.join("saved")).unwrap();
        let port = KnowledgeBasePort::with_scopes(
            Arc::new(Dir(dir.clone())),
            workers,
            core,
            host.clone(),
            counting_scopes(),
        );
        Rig { dir, host, port }
    }

    fn rig(name: &str) -> Rig {
        rig_on(name, Arc::new(Inline), Arc::new(Inline))
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

    type Slot = Arc<Mutex<Option<Reply>>>;

    fn cx(view: u32) -> CallContext {
        CallContext {
            sender: Sender {
                view: ViewId(view),
                window: WindowId(2),
                surface: Surface::Docs,
            },
            request: None,
            cancel: CancelToken::default(),
        }
    }

    /// Starts a call; the answer lands in the slot whenever the port gives it
    fn begin_as(view: u32, f: impl FnOnce(&CallContext, Responder)) -> Slot {
        let slot: Slot = Arc::new(Mutex::new(None));
        let out = slot.clone();
        f(&cx(view), Responder::new(move |r| *lock(&out) = Some(r)));
        slot
    }

    fn call_as(view: u32, f: impl FnOnce(&CallContext, Responder)) -> Reply {
        lock(&begin_as(view, f)).take().expect("answered")
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

    fn scope_of(reply: Reply) -> String {
        match reply.unwrap() {
            IpcValue::String(id) => id,
            other => panic!("a scope: {other:?}"),
        }
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

    fn hit(path: &str) -> IndexedHit {
        IndexedHit {
            path: path.into(),
            name: basename(path, None),
            ext: "md".into(),
            snippet_text: Some(format!("about {}", basename(path, None))),
        }
    }

    // ---- decoding ----

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

    #[test]
    fn a_scope_that_is_a_date_or_bytes_is_refused_never_read_as_no_scope() {
        let r = rig("scope-opaque");
        let a = r.file("a.md", "");
        r.star(&[(&a, None)]);
        for scope in [
            IpcValue::Date(0.0),
            IpcValue::Bytes(BytesKind::Uint8Array, vec![1]),
            IpcValue::Number(1.0),
            IpcValue::Null,
        ] {
            let raw = obj(&[("scope", scope)]);
            assert_eq!(refused(list(&r, raw)), KB_SCOPE_UNKNOWN);
        }
        // a date or a buffer as the whole argument names no scope at all
        assert_eq!(paths_of(list(&r, IpcValue::Date(0.0))), vec![a]);
    }

    #[test]
    fn the_answers_are_objects_with_the_keys_of_the_typescript_literals() {
        let r = rig("encode-list");
        let a = r.file("lease.docx", "12345");
        r.star(&[(&a, None)]);
        let IpcValue::Array(items) = list(&r, IpcValue::Undefined).unwrap() else {
            panic!("an array")
        };
        assert_eq!(
            items,
            vec![obj(&[
                ("path", s(&a)),
                ("folder", s("files")),
                (
                    "folderPath",
                    s(&r.dir.join("files").to_string_lossy().into_owned())
                ),
                ("name", s("lease.docx")),
                ("ext", s("docx")),
                ("sizeBytes", IpcValue::Number(5.0)),
            ])]
        );
    }

    // ---- scopes ----

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
        let id = scope_of(open_scope(&r, s("work")));
        assert_eq!(id, "scope-1");
        assert_eq!(paths_of(list(&r, with_scope(&id))), vec![a.clone()]);

        // another window's call carrying the scope is refused, and cannot close it
        let other_view = call_as(6, |cx, re| r.port.kb_list(cx, vec![with_scope(&id)], re));
        assert_eq!(refused(other_view), KB_SCOPE_UNKNOWN);
        call_as(6, |cx, re| r.port.kb_close_scope(cx, vec![s(&id)], re)).unwrap();
        assert_eq!(paths_of(list(&r, with_scope(&id))), vec![a]);

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
        assert_eq!(refused(open_scope(&r, IpcValue::Date(0.0))), KB_GROUP_EMPTY);
    }

    #[test]
    fn a_project_scope_needs_an_available_project_and_adds_its_folder() {
        let r = rig("scope-project");
        let a = r.file("a.md", "");
        let b = r.file("b.md", "");
        r.star(&[(&a, Some("work")), (&b, None)]);
        let ask = obj(&[("projectId", s("p1"))]);

        assert_eq!(refused(open_scope(&r, ask.clone())), PROJECT_UNAVAILABLE);

        r.host.state().available = true;
        let id = scope_of(open_scope(&r, ask));
        assert_eq!(
            paths_of(list(&r, with_scope(&id))),
            vec![a.clone(), b.clone()]
        );

        let grouped = obj(&[("projectId", s("p1")), ("group", s("work"))]);
        let id = scope_of(open_scope(&r, grouped));
        assert_eq!(paths_of(list(&r, with_scope(&id))), vec![a]);

        for group in [s("play"), IpcValue::Number(3.0), IpcValue::Date(0.0)] {
            let bad = obj(&[("projectId", s("p1")), ("group", group)]);
            assert_eq!(refused(open_scope(&r, bad)), KB_GROUP_EMPTY);
        }
    }

    // ---- search ----

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
        assert_eq!(st.searches, vec![("lease".to_owned(), 200.0, false)]);
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
        assert_eq!(count(IpcValue::Date(7.0)), 7);
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
        let id = scope_of(open_scope(&r, s("work")));
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
        let id = scope_of(open_scope(&r, obj(&[("projectId", s("p1"))])));

        let got = paths_of(search(&r, obj(&[("q", s("x")), ("scope", s(&id))])));
        assert_eq!(got, vec![seen, starred]);
        assert_eq!(r.host.state().searches, vec![("x".to_owned(), 200.0, true)]);
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
        let id = scope_of(open_scope(&r, obj(&[("projectId", s("p1"))])));
        let got = paths_of(search(&r, obj(&[("q", s("x")), ("scope", s(&id))])));
        assert_eq!(got, vec![starred]);
        assert_eq!(
            r.host.state().searches,
            vec![("x".to_owned(), 200.0, false)]
        );
    }

    // ---- read ----

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
    fn a_starred_file_reads_as_a_page_with_its_offset_decoded() {
        let r = rig("read-pages");
        let a = r.file("a.md", "x");
        r.star(&[(&a, None)]);
        r.host.state().texts.insert(a.clone(), "abcdef".into());

        assert_eq!(
            read(&r, &a, IpcValue::Undefined),
            Ok(page("abcdef", 6.0, 0.0))
        );
        assert_eq!(read(&r, &a, s("2.9")), Ok(page("cdef", 6.0, 2.0)));
        assert_eq!(
            read(&r, &a, IpcValue::Number(-7.0)),
            Ok(page("abcdef", 6.0, 0.0))
        );
        assert_eq!(read(&r, &a, s("many")), Ok(page("abcdef", 6.0, 0.0)));
        assert_eq!(read(&r, &a, IpcValue::Date(3.0)), Ok(page("def", 6.0, 3.0)));
    }

    #[test]
    fn the_text_cache_lives_as_long_as_the_port() {
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
    fn a_file_the_host_lists_as_unsaved_is_not_read_even_when_cached() {
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
        let id = scope_of(open_scope(&r, s("work")));
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
    fn a_project_scope_reads_through_the_host_as_the_window_that_asked() {
        let r = rig("read-project");
        r.host.state().available = true;
        let id = scope_of(open_scope(&r, obj(&[("projectId", s("p1"))])));
        {
            let mut st = r.host.state();
            st.project_reads.insert(
                "/proj/ok.md".into(),
                ProjectReadResult::Ok {
                    text: "project text".into(),
                    total_chars: 12,
                    offset: JsNum(3.0),
                },
            );
            st.project_reads
                .insert("/proj/cloud.md".into(), ProjectReadResult::Declined);
            st.project_reads.insert(
                "/proj/unsaved.md".into(),
                ProjectReadResult::Refused {
                    reason: ProjectReadRefusal::Unsaved,
                },
            );
        }
        let project_read = |name: &str| {
            call_as(7, |cx, re| {
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

        // the scope was opened by window 5: another window cannot use it
        assert_eq!(refused(project_read("ok")), KB_SCOPE_UNKNOWN);
        let own = |name: &str| {
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
        assert_eq!(own("ok"), Ok(page("project text", 12.0, 3.0)));
        assert_eq!(
            r.host.state().read_by,
            vec![(ViewId(5), "p1".to_owned(), "/proj/ok.md".to_owned(), 3.0)]
        );
        assert_eq!(refused(own("cloud")), KB_DOWNLOAD_DECLINED);
        assert_eq!(refused(own("unsaved")), UNSAVED_CHANGES_MESSAGE);
        assert_eq!(refused(own("nothing-said")), KB_NOT_IN_BASE);
    }

    // ---- create ----

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

        let first = created_path(create(&r, "Plan", "md", "# Plan"));
        assert_eq!(first, format!("{saved}/Plan.md"));
        assert_eq!(fs::read_to_string(&first).unwrap(), "# Plan");
        let second = created_path(create(&r, "Plan", "md", "# Again"));
        assert_eq!(second, format!("{saved}/Plan-2.md"));
        assert_eq!(fs::read_to_string(&first).unwrap(), "# Plan");

        assert_eq!(r.host.state().recent, vec![first, second]);
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
    fn with_a_project_chosen_the_document_goes_through_the_project_guard_only() {
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
    fn a_bad_create_request_is_refused_before_the_host_is_asked_anything() {
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
        assert_eq!(fs::read_dir(r.dir.join("saved")).unwrap().count(), 0);
        assert!(r.host.state().recent.is_empty());
    }

    // ---- threads ----

    #[test]
    fn a_read_parses_on_a_worker_and_answers_from_the_core_thread() {
        let queue = Arc::new(Queued::default());
        let r = rig_on("threads-read", queue.clone(), queue.clone());
        let a = r.file("a.md", "x");
        r.star(&[(&a, None)]);
        r.host.state().texts.insert(a.clone(), "text".into());

        let slot = begin_as(5, |cx, re| {
            r.port.kb_read(
                cx,
                vec![obj(&[("path", s(&a)), ("offset", IpcValue::Undefined)])],
                re,
            )
        });
        // the handler returned with the parse not run and nothing answered
        assert_eq!(r.host.state().parses, 0);
        assert!(lock(&slot).is_none());
        assert_eq!(queue.len(), 1);

        // the worker parses, and posts the answer back instead of giving it
        assert!(queue.run_next());
        assert_eq!(r.host.state().parses, 1);
        assert!(lock(&slot).is_none());
        assert_eq!(queue.len(), 1);

        assert!(queue.run_next());
        assert_eq!(
            lock(&slot).take().expect("answered"),
            Ok(page("text", 4.0, 0.0))
        );
    }

    #[test]
    fn a_search_runs_the_index_on_a_worker_and_answers_from_the_core_thread() {
        let queue = Arc::new(Queued::default());
        let r = rig_on("threads-search", queue.clone(), queue.clone());
        let a = r.file("a.md", "");
        r.star(&[(&a, None)]);
        {
            let mut st = r.host.state();
            st.hits = vec![hit(&a)];
            st.on_disk = [a.clone()].into();
        }

        let slot = begin_as(5, |cx, re| r.port.kb_search(cx, vec![query("x")], re));
        assert!(r.host.state().searches.is_empty());
        assert!(lock(&slot).is_none());

        assert!(queue.run_next());
        assert_eq!(r.host.state().searches.len(), 1);
        assert!(lock(&slot).is_none());
        assert!(queue.run_next());
        assert_eq!(paths_of(lock(&slot).take().expect("answered")), vec![a]);
    }

    #[test]
    fn a_new_document_is_made_on_a_worker_and_the_recent_list_is_told_on_the_core_thread() {
        let queue = Arc::new(Queued::default());
        let r = rig_on("threads-create", queue.clone(), queue.clone());
        let saved = r.host.state().save_dir.clone();

        let slot = begin_as(5, |cx, re| {
            r.port.kb_create_document(
                cx,
                vec![obj(&[
                    ("title", s("Plan")),
                    ("format", s("md")),
                    ("content", s("# Plan")),
                ])],
                re,
            )
        });
        let path = format!("{saved}/Plan.md");
        // placement on a worker, then the save folder asked on the core
        // thread, then the write on a worker, then the answer on the core thread
        assert!(queue.run_next());
        assert!(!Path::new(&path).exists());
        assert!(queue.run_next());
        assert!(!Path::new(&path).exists());
        assert!(queue.run_next());
        assert!(Path::new(&path).exists());
        assert!(r.host.state().recent.is_empty());
        assert!(lock(&slot).is_none());

        assert!(queue.run_next());
        assert_eq!(r.host.state().recent, vec![path.clone()]);
        assert_eq!(created_path(lock(&slot).take().expect("answered")), path);
        assert!(!queue.run_next());
    }

    #[test]
    fn opening_a_project_scope_asks_the_host_on_a_worker_and_opens_it_on_the_core_thread() {
        let queue = Arc::new(Queued::default());
        let r = rig_on("threads-scope", queue.clone(), queue.clone());
        r.host.state().available = true;

        let slot = begin_as(5, |cx, re| {
            r.port
                .kb_open_scope(cx, vec![obj(&[("projectId", s("p1"))])], re)
        });
        assert!(lock(&slot).is_none());
        assert!(queue.run_next());
        assert!(lock(&slot).is_none());
        assert!(queue.run_next());
        assert_eq!(lock(&slot).take().expect("answered"), Ok(s("scope-1")));
    }
}
