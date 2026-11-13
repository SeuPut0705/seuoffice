//! `apps/shell/src/main/knowledge-base.ts`: the reader's starred files (the
//! star corpus) as the AI can search and read, the run scopes that narrow a
//! run to one starred group or to a project folder (decision 0020), and the
//! ask panel's one write path, `create_document`.
//!
//! What the TypeScript awaits and this crate does not hold is a seam:
//!
//! - `parseFileToText` (file-parse, engine-waiting) is the [`FileParser`] of
//!   `generate/materials`;
//! - the full-text index is a closure per call (`search`, `indexedAsOnDisk`),
//!   a project's `within` test and `readProject` likewise;
//! - the unsaved-changes question is the [`OpenFilesHolder`] each function
//!   that reads it is given;
//! - `KbCreateDeps` is [`KbCreateDeps`] (and the project part of it
//!   [`KbCreateProject`]).
//!
//! The text cache (`kbTextCache`, module state in the TypeScript) is a
//! [`KbTextCache`] the caller owns. A `Promise` is a plain call; an `Error`
//! any of them throws is a [`Thrown`].

use std::collections::HashSet;
use std::fs;
use std::sync::Arc;

use jscompat::node_path::host::{basename, dirname, extname};
use jscompat::{
    JsMap, JsonValue, js_regex, math_max, math_round, number_to_string, replace_first, slice_utf16,
    trim,
};
use serde::Serialize;

use crate::node_fs::{namespaced, node_error};
use crate::packages::ai_provider::user_skills_import::random_hex;
use crate::packages::electron_utils::default_save_dir::Thrown;
use crate::packages::electron_utils::unsaved_files::{
    OpenFilesHolder, UNSAVED_CHANGES_MESSAGE, assert_file_saved, without_unsaved_files,
};
use crate::packages::file_parse::attachable::attachable_max_bytes;
use crate::packages::project_store::{ProjectId, ProjectReadRefusal, ProjectReadResult};
use crate::shell::generate::materials::FileParser;
use crate::shell::projects::project_tools::ProjectToolsScopes;
use crate::shell::recent_files::StatInfo;

/// `KB_READ_CHUNK_CHARS`: characters of parsed text one read_knowledge_file
/// page returns (aligned with the chat-attachment reader, so models meet one
/// paging convention everywhere)
pub const KB_READ_CHUNK_CHARS: f64 = 24_000.0;

/// `KB_READ_MAX_BYTES`: byte cap per corpus file
pub const KB_READ_MAX_BYTES: f64 = 50.0 * 1024.0 * 1024.0;

/// `kbReadMaxBytes(filePath)`: the largest file with this path read for the AI
/// (`attachableMaxBytes`, pictures aside)
pub fn kb_read_max_bytes(file_path: &str) -> f64 {
    let cap = attachable_max_bytes(&extname(file_path));
    if cap.is_finite() {
        cap.max(KB_READ_MAX_BYTES)
    } else {
        cap
    }
}

/// `KB_QUERY_MAX_CHARS`: query cap, same as the home search box
const KB_QUERY_MAX_CHARS: f64 = 200.0;

/// `KB_SEARCH_POOL`: how many indexed hits to fetch before filtering to the
/// starred set
const KB_SEARCH_POOL: f64 = 200.0;

/// `KbFile`: one corpus entry as the AI (and the panel) sees it. The keys are
/// in the order the literal of `listKnowledgeFiles` writes them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbFile {
    /// absolute path, also the citation target
    pub path: String,
    /// owning folder name ("contracts" in /Users/me/contracts/lease.docx)
    pub folder: String,
    /// absolute folder path
    pub folder_path: String,
    pub name: String,
    pub ext: String,
    pub size_bytes: u64,
}

/// `KbSearchHit`: search result as the model sees it
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KbSearchHit {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub folder: String,
    pub snippet: String,
}

/// One hit of the index as the knowledge search reads it
/// (`{ path, name, ext, snippetText? }`)
#[derive(Debug, Clone, PartialEq)]
pub struct IndexedHit {
    pub path: String,
    pub name: String,
    pub ext: String,
    /// `None` (`undefined`) reads as `''`
    pub snippet_text: Option<String>,
}

/// `search(q, limit)` of `searchKnowledgeBase`
pub type KbSearch<'a> = dyn FnMut(&str, f64) -> Result<Vec<IndexedHit>, Thrown> + 'a;

/// `within` of `searchSavedKnowledgeWithProject`: the project's "visible to
/// the AI" test on absolute paths, or none (`null`)
pub type KbWithin<'a> = Option<&'a mut dyn FnMut(&str) -> Result<bool, Thrown>>;

/// `readProject` of `readKnowledgeOrProjectPage`: the project's read of one
/// page, or none (`null`)
pub type KbReadProject<'a> =
    Option<&'a mut dyn FnMut(&str, f64) -> Result<ProjectReadResult, Thrown>>;

/// `search(q, limit, within?)` of `searchSavedKnowledgeWithProject`; `within`
/// narrows the query itself, so starred and project files rank together
pub type KbSearchWithin<'a> =
    dyn FnMut(&str, f64, KbWithin<'_>) -> Result<Vec<IndexedHit>, Thrown> + 'a;

/// `KB_TEXT_CACHE_MAX`
const KB_TEXT_CACHE_MAX: usize = 8;

/// one entry of `kbTextCache`
struct CachedText {
    stamp: String,
    text: Arc<str>,
}

/// `kbTextCache`: text extraction cache, keyed by path, invalidated by
/// mtime+size. Insertion order is the eviction order.
#[derive(Default)]
pub struct KbTextCache {
    entries: JsMap<CachedText>,
}

impl KbTextCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// `kbTextCache.size`
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// `kbTextCache.set(path, { stamp, text })`, then the oldest entry out
    /// while there are more than [`KB_TEXT_CACHE_MAX`]
    fn insert(&mut self, path: &str, stamp: String, text: Arc<str>) {
        self.entries.set(path, CachedText { stamp, text });
        if self.entries.len() > KB_TEXT_CACHE_MAX {
            let oldest = self.entries.keys().next().map(str::to_owned);
            if let Some(oldest) = oldest.filter(|oldest| !oldest.is_empty()) {
                self.entries.delete(&oldest);
            }
        }
    }
}

/// `basename(path).replace(/^[^.]*./, '').toLowerCase()`
fn kb_ext(name: &str) -> String {
    replace_first(js_regex!(r"^[^.]*."), 0, name, "").to_lowercase()
}

/// `listKnowledgeFiles(starredPaths)`: the corpus, every starred file that
/// still exists on disk. A starred path can outlive its file; for the corpus
/// it simply drops out.
pub fn list_knowledge_files(starred_paths: &[String]) -> Vec<KbFile> {
    let mut out = Vec::new();
    for path in starred_paths {
        let Ok(stat) = fs::metadata(namespaced(path)) else {
            continue;
        };
        if !stat.is_file() {
            continue;
        }
        let folder_path = dirname(path);
        out.push(KbFile {
            path: path.clone(),
            folder: basename(&folder_path, None),
            folder_path,
            name: basename(path, None),
            ext: kb_ext(&basename(path, None)),
            size_bytes: stat.len(),
        });
    }
    out
}

/// the part of `searchKnowledgeBase` after the pool is fetched: the hits whose
/// path is in `starred`, each path once, up to `limit`
fn filter_pool(pool: &[IndexedHit], starred: &HashSet<&str>, limit: f64) -> Vec<KbSearchHit> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut out = Vec::new();
    for hit in pool {
        if !starred.contains(hit.path.as_str()) || seen.contains(hit.path.as_str()) {
            continue;
        }
        seen.insert(hit.path.as_str());
        out.push(KbSearchHit {
            path: hit.path.clone(),
            name: hit.name.clone(),
            ext: hit.ext.clone(),
            folder: basename(&dirname(&hit.path), None),
            snippet: hit.snippet_text.clone().unwrap_or_default(),
        });
        if out.len() as f64 >= limit {
            break;
        }
    }
    out
}

/// `searchKnowledgeBase(search, query, starredPaths, limit)`: fetch + filter +
/// trim one search page. The limit is checked after a hit is kept, so `0`,
/// a negative one and `1` all keep one hit, and `NaN` keeps them all.
pub fn search_knowledge_base(
    search: &mut KbSearch<'_>,
    query: &str,
    starred_paths: &[String],
    limit: f64,
) -> Result<Vec<KbSearchHit>, Thrown> {
    let q = slice_utf16(trim(query), 0.0, Some(KB_QUERY_MAX_CHARS));
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let starred: HashSet<&str> = starred_paths.iter().map(String::as_str).collect();
    let pool = search(&q, KB_SEARCH_POOL)?;
    Ok(filter_pool(&pool, &starred, limit))
}

/// `searchSavedKnowledgeBase(search, query, starredPaths, limit)`:
/// `searchKnowledgeBase` over the starred files that are not open with unsaved
/// changes. The excerpt comes from the index, which holds a file as it was
/// last saved; a file being edited may carry a withholding mark that has not
/// reached the disk yet, so nothing of it is quoted until it is saved.
pub fn search_saved_knowledge_base(
    open_files: &OpenFilesHolder,
    search: &mut KbSearch<'_>,
    query: &str,
    starred_paths: &[String],
    limit: f64,
) -> Result<Vec<KbSearchHit>, Thrown> {
    let saved = without_unsaved_files(open_files, starred_paths, |path| path.clone());
    search_knowledge_base(search, query, &saved, limit)
}

/// `KbReadPage`: one page of a corpus file's text
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbReadPage {
    pub text: String,
    /// total parsed characters, so the reader knows whether to page on
    pub total_chars: u64,
    pub offset: f64,
}

/// `readKnowledgeFileText(filePath)`: parsed text of one corpus file. The
/// message of an `Err` is plain: shell main has no i18n channel of its own.
pub fn read_knowledge_file_text(
    open_files: &OpenFilesHolder,
    cache: &mut KbTextCache,
    parser: &mut dyn FileParser,
    file_path: &str,
) -> Result<Arc<str>, Thrown> {
    // before the cache: a file open with unsaved changes is not read at all
    assert_file_saved(open_files, file_path).map_err(|message| Thrown(message.to_owned()))?;
    let meta = fs::metadata(namespaced(file_path))
        .map_err(|error| Thrown(node_error(&error, "stat", file_path).message))?;
    let stat = StatInfo::of(&meta);
    let stamp = format!(
        "{}:{}",
        number_to_string(stat.mtime_ms),
        number_to_string(stat.size as f64)
    );
    if let Some(cached) = cache.entries.get(file_path)
        && cached.stamp == stamp
    {
        return Ok(cached.text.clone());
    }
    let cap = kb_read_max_bytes(file_path);
    if stat.size as f64 > cap {
        return Err(Thrown(format!(
            "file too large to read ({}MB, cap {}MB)",
            number_to_string(math_round(stat.size as f64 / 1024.0 / 1024.0)),
            number_to_string(cap / 1024.0 / 1024.0)
        )));
    }
    let parsed = parser
        .parse_file_to_text(file_path)
        .map_err(|failure| Thrown(failure.0))?;
    let readable = parsed.ok && parsed.kind.as_deref() == Some("text");
    let text = match parsed.text {
        Some(text) if readable => text,
        _ => {
            return Err(Thrown(
                parsed.error.unwrap_or_else(|| "unreadable file".to_owned()),
            ));
        }
    };
    let text: Arc<str> = Arc::from(text);
    cache.insert(file_path, stamp, text.clone());
    Ok(text)
}

/// `readKnowledgeFilePage(filePath, offset)`
pub fn read_knowledge_file_page(
    open_files: &OpenFilesHolder,
    cache: &mut KbTextCache,
    parser: &mut dyn FileParser,
    file_path: &str,
    offset: f64,
) -> Result<KbReadPage, Thrown> {
    let text = read_knowledge_file_text(open_files, cache, parser, file_path)?;
    let start = if offset.is_finite() {
        math_max(0.0, offset.floor())
    } else {
        0.0
    };
    let length = text.encode_utf16().count();
    if start >= length as f64 {
        return Ok(KbReadPage {
            text: String::new(),
            total_chars: length as u64,
            offset: start,
        });
    }
    Ok(KbReadPage {
        text: slice_utf16(&text, start, Some(start + KB_READ_CHUNK_CHARS)),
        total_chars: length as u64,
        offset: start,
    })
}

// ---- asking one starred group (spec 8.8) ----
//
// A home ask can be narrowed to one starred group. The narrowing is kept here
// in main, not by the screen: the panel names a group once per run, main mints
// an opaque scope for it, and every kb:* call of that run carries the scope.
// Main resolves the group's members from the starred store on each call, so a
// file list sent from the renderer is never trusted, and there is no call that
// changes what an open scope covers. A call without a scope is an unscoped ask
// (every starred file, as before); a scope main does not hold is refused,
// never read as unscoped. Narrowing only ever filters what the existing checks
// (starred only, unsaved files refused, excerpts from files indexed as on
// disk) already allow.

/// `KB_NOT_IN_BASE`: the refusal of a read outside the run's knowledge base:
/// the starred set, or the run's group
pub const KB_NOT_IN_BASE: &str = "path is not in the knowledge base";

/// `KB_SCOPE_UNKNOWN`: a call carried a scope main does not hold (never
/// opened, closed, evicted, or another window's)
pub const KB_SCOPE_UNKNOWN: &str = "knowledge-base scope is not open";

/// `KB_GROUP_EMPTY`: a scope was asked for a group with no starred files
/// (never existed, emptied, renamed away)
pub const KB_GROUP_EMPTY: &str = "knowledge-base group has no starred files";

/// `KB_SCOPES_MAX`: how many group scopes main holds at once; the oldest is
/// dropped (and then refused) past this
pub const KB_SCOPES_MAX: f64 = 16.0;

/// `KbStarredReach`: the starred part of a scope: every starred file, one
/// group's, or none (the project scope of an editor's AI panel, which reads
/// its project folder only)
#[derive(Debug, Clone, PartialEq)]
pub enum KbStarredReach {
    All,
    None,
    Group(String),
}

/// `HeldScope`
struct HeldScope {
    /// a webContents id
    owner: i64,
    starred: KbStarredReach,
    /// a project folder the run may also read (spec 5.5); the project tools
    /// re-check it on every call
    project_id: Option<ProjectId>,
}

/// `KbRunScopes`: the scopes of runs (decision 0020). A scope covers a starred
/// group, a project folder (kind "project folder", decision 0088), or both:
/// the home ask with a project chosen reads the project folder plus its
/// starred scope (all or one group). What a scope covers never changes after
/// it is opened.
pub struct KbRunScopes {
    scopes: JsMap<HeldScope>,
    new_scope: Box<dyn FnMut() -> String + Send>,
    max: f64,
}

impl Default for KbRunScopes {
    /// `new KbRunScopes()`: `randomBytes(24).toString('hex')` and
    /// [`KB_SCOPES_MAX`]
    fn default() -> Self {
        Self::new(Box::new(|| random_hex(24)), KB_SCOPES_MAX)
    }
}

/// `checkedGroup(group, groupOf)` of a group that is a string, or not
fn checked_group_name(group: Option<&str>, group_of: &JsMap<String>) -> Result<String, Thrown> {
    match group {
        Some(group) if !group.is_empty() && group_of.values().any(|held| held == group) => {
            Ok(group.to_owned())
        }
        _ => Err(Thrown(KB_GROUP_EMPTY.to_owned())),
    }
}

/// `checkedGroup(group, groupOf)`: the group, or the refusal for anything that
/// is not the name of a group with starred files
fn checked_group(group: Option<&JsonValue>, group_of: &JsMap<String>) -> Result<String, Thrown> {
    checked_group_name(
        match group {
            Some(JsonValue::String(group)) => Some(group.as_str()),
            _ => None,
        },
        group_of,
    )
}

impl KbRunScopes {
    /// `new KbRunScopes(newScope, max)`
    pub fn new(new_scope: Box<dyn FnMut() -> String + Send>, max: f64) -> Self {
        KbRunScopes {
            scopes: JsMap::new(),
            new_scope,
            max,
        }
    }

    /// `open(owner, group, groupOf)`: a scope for one run of `owner` (a
    /// webContents id) over `group`; refuses a group with no starred files
    pub fn open(
        &mut self,
        owner: i64,
        group: Option<&JsonValue>,
        group_of: &JsMap<String>,
    ) -> Result<String, Thrown> {
        let group = checked_group(group, group_of)?;
        Ok(self.hold(HeldScope {
            owner,
            starred: KbStarredReach::Group(group),
            project_id: None,
        }))
    }

    /// `openProject(owner, projectId, starred, groupOf)`: a scope for one run
    /// of `owner` over a project folder plus a starred part: `None` for an
    /// editor's panel, `All` or a group for the home ask. The caller has
    /// checked that the project is listed and its folder exists.
    pub fn open_project(
        &mut self,
        owner: i64,
        project_id: &str,
        starred: KbStarredReach,
        group_of: &JsMap<String>,
    ) -> Result<String, Thrown> {
        let reach = match starred {
            KbStarredReach::Group(group) => {
                KbStarredReach::Group(checked_group_name(Some(&group), group_of)?)
            }
            other => other,
        };
        Ok(self.hold(HeldScope {
            owner,
            starred: reach,
            project_id: Some(project_id.to_owned()),
        }))
    }

    fn hold(&mut self, held: HeldScope) -> String {
        let scope = (self.new_scope)();
        self.scopes.set(scope.clone(), held);
        while self.scopes.len() as f64 > self.max {
            let Some(oldest) = self.scopes.keys().next().map(str::to_owned) else {
                break;
            };
            self.scopes.delete(&oldest);
        }
        scope
    }

    /// the held scope a call names; `None` (`undefined`) when it names none;
    /// an `Err` for any other value
    fn held_for(&self, owner: i64, raw: Option<&JsonValue>) -> Result<Option<&HeldScope>, Thrown> {
        let scope = match raw {
            Some(JsonValue::Object(object)) => object.get("scope"),
            _ => None,
        };
        let Some(scope) = scope else {
            return Ok(None);
        };
        let held = match scope {
            JsonValue::String(scope) => self.scopes.get(scope),
            _ => None,
        };
        match held {
            Some(held) if held.owner == owner => Ok(Some(held)),
            _ => Err(Thrown(KB_SCOPE_UNKNOWN.to_owned())),
        }
    }

    /// `close(owner, scope)`: the run is over; only the window that opened a
    /// scope can close it
    pub fn close(&mut self, owner: i64, scope: Option<&JsonValue>) {
        if let Some(JsonValue::String(scope)) = scope
            && self
                .scopes
                .get(scope)
                .is_some_and(|held| held.owner == owner)
        {
            self.scopes.delete(scope);
        }
    }

    /// `narrow(owner, raw, paths, groupOf)`: `paths` narrowed to what this
    /// call may touch. `raw` is the call's argument object; only its `scope`
    /// field is read. No scope: every path (an unscoped ask). A held scope:
    /// every path (`All`), none (`None`), or the paths whose group is the
    /// scope's group right now. Anything else: refused.
    pub fn narrow(
        &self,
        owner: i64,
        raw: Option<&JsonValue>,
        paths: &[String],
        group_of: impl FnOnce() -> JsMap<String>,
    ) -> Result<Vec<String>, Thrown> {
        let held = self.held_for(owner, raw)?;
        let starred = match held {
            None => return Ok(paths.to_vec()),
            Some(held) => &held.starred,
        };
        match starred {
            KbStarredReach::All => Ok(paths.to_vec()),
            KbStarredReach::None => Ok(Vec::new()),
            KbStarredReach::Group(group) => {
                let groups = group_of();
                Ok(paths
                    .iter()
                    .filter(|path| groups.get(path).is_some_and(|held| held == group))
                    .cloned()
                    .collect())
            }
        }
    }

    /// `projectOf(owner, raw)`: the project folder the call's scope also
    /// reads, or `None` (`null`: no scope, or a starred-only scope). A scope
    /// main does not hold is refused, as in `narrow`.
    pub fn project_of(
        &self,
        owner: i64,
        raw: Option<&JsonValue>,
    ) -> Result<Option<ProjectId>, Thrown> {
        Ok(self
            .held_for(owner, raw)?
            .and_then(|held| held.project_id.clone()))
    }
}

/// The scopes the project tools hold are these: `openProject(owner,
/// projectId, 'none')`, `close` and `projectOf` as the tools call them.
impl ProjectToolsScopes for KbRunScopes {
    fn open_project(&mut self, owner: i64, project_id: &str) -> String {
        // 'none' names no group, so nothing is checked and nothing is refused
        self.hold(HeldScope {
            owner,
            starred: KbStarredReach::None,
            project_id: Some(project_id.to_owned()),
        })
    }

    fn close(&mut self, owner: i64, scope: Option<&JsonValue>) {
        KbRunScopes::close(self, owner, scope);
    }

    fn project_of(&mut self, owner: i64, raw: &JsonValue) -> Result<Option<ProjectId>, Thrown> {
        KbRunScopes::project_of(self, owner, Some(raw))
    }
}

/// What `kb:open-scope` was asked for (`{ group, projectId }`)
#[derive(Debug, Clone, PartialEq)]
pub struct KbOpenScope {
    /// `unknown`; `None` is `undefined`
    pub group: Option<JsonValue>,
    pub project_id: Option<ProjectId>,
}

/// `parseKbOpenScope(raw)`: a group name alone (as before), or `{ group,
/// projectId }` from the home ask with a project chosen, where a missing or
/// null group means every starred file.
pub fn parse_kb_open_scope(raw: Option<&JsonValue>) -> KbOpenScope {
    let Some(JsonValue::Object(req)) = raw else {
        return KbOpenScope {
            group: raw.cloned(),
            project_id: None,
        };
    };
    KbOpenScope {
        group: Some(req.get("group").cloned().unwrap_or(JsonValue::Null)),
        project_id: match req.get("projectId") {
            Some(JsonValue::String(id)) if !id.is_empty() => Some(id.clone()),
            _ => None,
        },
    }
}

// ---- the home ask with a project chosen (spec 5.5) ----

/// `KB_DOWNLOAD_DECLINED`: a knowledge read reached a cloud-only project file
/// and the person declined the download
pub const KB_DOWNLOAD_DECLINED: &str =
    "the person declined to download this file, which is not on this PC";

/// `searchSavedKnowledgeWithProject(search, query, starredPaths, limit,
/// within, indexedAsOnDisk)`: `searchSavedKnowledgeBase` widened by a project
/// folder the run also reads. `within` is the project's "visible to the AI"
/// test on absolute paths. The narrowing happens in the index query
/// (`search`'s filter), so starred and project files rank together and nothing
/// else fills the pool. Project hits keep the protections of starred ones:
/// only files indexed as they are on disk, none open with unsaved changes.
/// Without a project this is the starred search unchanged.
pub fn search_saved_knowledge_with_project(
    open_files: &OpenFilesHolder,
    search: &mut KbSearchWithin<'_>,
    query: &str,
    starred_paths: &[String],
    limit: f64,
    within: KbWithin<'_>,
    indexed_as_on_disk: &mut dyn FnMut(&[String]) -> Vec<String>,
) -> Result<Vec<KbSearchHit>, Thrown> {
    let Some(within) = within else {
        return search_saved_knowledge_base(
            open_files,
            &mut |q: &str, n: f64| search(q, n, None),
            query,
            starred_paths,
            limit,
        );
    };
    let q = slice_utf16(trim(query), 0.0, Some(KB_QUERY_MAX_CHARS));
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let saved = without_unsaved_files(open_files, starred_paths, |path| path.clone());
    let starred: HashSet<&str> = saved.iter().map(String::as_str).collect();
    let pool = {
        let mut narrowed = |path: &str| -> Result<bool, Thrown> {
            if starred.contains(path) {
                return Ok(true);
            }
            within(path)
        };
        search(&q, KB_SEARCH_POOL, Some(&mut narrowed))?
    };
    let from_project: Vec<String> = pool
        .iter()
        .filter(|hit| !starred.contains(hit.path.as_str()))
        .map(|hit| hit.path.clone())
        .collect();
    let project_ok_paths =
        without_unsaved_files(open_files, &indexed_as_on_disk(&from_project), |path| {
            path.clone()
        });
    let project_ok: HashSet<&str> = project_ok_paths.iter().map(String::as_str).collect();
    let allowed: HashSet<&str> = pool
        .iter()
        .map(|hit| hit.path.as_str())
        .filter(|path| starred.contains(path) || project_ok.contains(path))
        .collect();
    // `searchKnowledgeBase(() => pool, q, allowed, limit)`: `q` is cut and
    // not blank already, and the pool answers itself
    Ok(filter_pool(&pool, &allowed, limit))
}

/// `readKnowledgeOrProjectPage(path, offset, starredAllowed, readProject)`:
/// one page of a knowledge read in a run that may also hold a project. A
/// starred file the scope allows reads as before (the person chose it); else
/// the project read decides (visibility, unsaved, size, the cloud-only
/// question); without a project the path is outside the base.
pub fn read_knowledge_or_project_page(
    open_files: &OpenFilesHolder,
    cache: &mut KbTextCache,
    parser: &mut dyn FileParser,
    path: &str,
    offset: f64,
    starred_allowed: bool,
    read_project: KbReadProject<'_>,
) -> Result<KbReadPage, Thrown> {
    if starred_allowed {
        return read_knowledge_file_page(open_files, cache, parser, path, offset);
    }
    let Some(read_project) = read_project else {
        return Err(Thrown(KB_NOT_IN_BASE.to_owned()));
    };
    match read_project(path, offset)? {
        ProjectReadResult::Ok {
            text,
            total_chars,
            offset,
        } => Ok(KbReadPage {
            text,
            total_chars,
            offset: offset.0,
        }),
        ProjectReadResult::Declined => Err(Thrown(KB_DOWNLOAD_DECLINED.to_owned())),
        ProjectReadResult::Refused { reason } => Err(Thrown(match reason {
            ProjectReadRefusal::Unsaved => UNSAVED_CHANGES_MESSAGE.to_owned(),
            ProjectReadRefusal::TooLarge => format!(
                "file too large to read (cap {}MB)",
                number_to_string(kb_read_max_bytes(path) / 1024.0 / 1024.0)
            ),
            ProjectReadRefusal::Unreadable => "unreadable file".to_owned(),
            _ => KB_NOT_IN_BASE.to_owned(),
        })),
    }
}

// ---- create_document: the ask panel's one write path ----

/// `KbCreateFormat`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KbCreateFormat {
    Md,
    Docx,
}

impl KbCreateFormat {
    /// the format as the file's extension and the request spell it
    pub fn as_str(self) -> &'static str {
        match self {
            KbCreateFormat::Md => "md",
            KbCreateFormat::Docx => "docx",
        }
    }
}

/// `KbCreateRequest`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KbCreateRequest {
    pub title: String,
    pub format: KbCreateFormat,
    pub content: String,
}

/// `KB_CREATE_MAX_CHARS`: keep in step with `CREATE_DOCUMENT_MAX_CHARS` in
/// agent-core
pub const KB_CREATE_MAX_CHARS: f64 = 2_000_000.0;

/// `parseKbCreateRequest(raw)`: validate the renderer's payload; the `Err`
/// is a plain message for the panel
pub fn parse_kb_create_request(raw: Option<&JsonValue>) -> Result<KbCreateRequest, Thrown> {
    let field = |key: &str| match raw {
        Some(JsonValue::Object(req)) => req.get(key),
        _ => None,
    };
    let format = match field("format") {
        Some(JsonValue::String(format)) if format == "md" => KbCreateFormat::Md,
        Some(JsonValue::String(format)) if format == "docx" => KbCreateFormat::Docx,
        _ => return Err(Thrown("format must be \"md\" or \"docx\"".to_owned())),
    };
    let content = match field("content") {
        Some(JsonValue::String(content)) => content.as_str(),
        _ => "",
    };
    if trim(content).is_empty() {
        return Err(Thrown("content must not be empty".to_owned()));
    }
    if content.encode_utf16().count() as f64 > KB_CREATE_MAX_CHARS {
        return Err(Thrown("content is too long".to_owned()));
    }
    Ok(KbCreateRequest {
        title: match field("title") {
            Some(JsonValue::String(title)) => title.clone(),
            _ => String::new(),
        },
        format,
        content: content.to_owned(),
    })
}

/// `KbCreateDeps.project`: a project chosen at home (spec 6): the document is
/// made first (Word through `docx_bytes`, never inside the folder) and then
/// written by `write`, which picks a free name in the project folder through
/// its write guard.
pub trait KbCreateProject {
    /// `write(fileName, bytes)`: the path written
    fn write(&mut self, file_name: &str, bytes: &[u8]) -> Result<String, Thrown>;
    /// `docxBytes(markdown)`
    fn docx_bytes(&mut self, markdown: &str) -> Result<Vec<u8>, Thrown>;
}

/// `KbCreateDeps`
pub trait KbCreateDeps {
    /// `dir()`: folder new files land in
    fn dir(&mut self) -> Result<String, Thrown>;
    /// `uniquePath(dir, fileName)`: `${sanitized title}${ext}` to the first
    /// free absolute path in `dir`
    fn unique_path(&mut self, dir: &str, file_name: &str) -> Result<String, Thrown>;
    /// `sanitizeBase(title)`
    fn sanitize_base(&mut self, title: &str) -> Result<String, Thrown>;
    /// `writeText(path, text)`
    fn write_text(&mut self, path: &str, text: &str) -> Result<(), Thrown>;
    /// `markdownToDocx(markdown, out)`: markdown to .docx at `out` (the
    /// bundled CLI)
    fn markdown_to_docx(&mut self, markdown: &str, out: &str) -> Result<(), Thrown>;
    /// `recordRecent(path)`
    fn record_recent(&mut self, path: &str) -> Result<(), Thrown>;
    /// `project`: absent, the default save folder as before
    fn project(&mut self) -> Option<&mut dyn KbCreateProject>;
}

/// `{ path }` that `createKnowledgeDocument` answers
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KbCreated {
    pub path: String,
}

/// `createKnowledgeDocument(deps, req)`
pub fn create_knowledge_document(
    deps: &mut dyn KbCreateDeps,
    req: &KbCreateRequest,
) -> Result<KbCreated, Thrown> {
    let file_name = format!(
        "{}.{}",
        deps.sanitize_base(&req.title)?,
        req.format.as_str()
    );
    if let Some(project) = deps.project() {
        let written = match req.format {
            KbCreateFormat::Md => project.write(&file_name, req.content.as_bytes())?,
            KbCreateFormat::Docx => {
                let bytes = project.docx_bytes(&req.content)?;
                project.write(&file_name, &bytes)?
            }
        };
        deps.record_recent(&written)?;
        return Ok(KbCreated { path: written });
    }
    let dir = deps.dir()?;
    let path = deps.unique_path(&dir, &file_name)?;
    match req.format {
        KbCreateFormat::Md => deps.write_text(&path, &req.content)?,
        KbCreateFormat::Docx => deps.markdown_to_docx(&req.content, &path)?,
    }
    deps.record_recent(&path)?;
    Ok(KbCreated { path })
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use jscompat::json_parse;

    use super::*;
    use crate::packages::electron_utils::unsaved_files::{OpenFileState, OpenFilesSource};
    use crate::shell::generate::materials::ParsedFile;
    use crate::shell::renderer_disposal::Failure;

    fn json(text: &str) -> JsonValue {
        json_parse(text).expect("a JSON literal")
    }

    fn strings(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|path| (*path).to_owned()).collect()
    }

    fn groups(pairs: &[(&str, &str)]) -> JsMap<String> {
        let mut out = JsMap::new();
        for (path, group) in pairs {
            out.set(*path, (*group).to_owned());
        }
        out
    }

    fn counting(max: f64) -> KbRunScopes {
        let mut made = 0;
        KbRunScopes::new(
            Box::new(move || {
                made += 1;
                format!("scope-{made}")
            }),
            max,
        )
    }

    fn call_with(scope: &str) -> JsonValue {
        json(&format!(r#"{{"scope":"{scope}"}}"#))
    }

    /// parses every file as its text, counting the parses
    struct Counting {
        parsed: Rc<RefCell<Vec<String>>>,
    }

    impl FileParser for Counting {
        fn parse_file_to_text(&mut self, path: &str) -> Result<ParsedFile, Failure> {
            self.parsed.borrow_mut().push(path.to_owned());
            let text = fs::read_to_string(path).map_err(|error| Failure(error.to_string()))?;
            Ok(ParsedFile {
                ok: true,
                error: None,
                kind: Some("text".to_owned()),
                text: Some(text),
            })
        }
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("kb-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("a scratch folder");
        dir
    }

    #[test]
    fn a_scope_belongs_to_the_window_that_opened_it() {
        let mut scopes = counting(KB_SCOPES_MAX);
        let group_of = groups(&[("/a", "work")]);
        let id = scopes
            .open(1, Some(&json(r#""work""#)), &group_of)
            .expect("a group with files");
        let call = call_with(&id);
        let paths = strings(&["/a", "/b"]);
        let refused = scopes
            .narrow(2, Some(&call), &paths, || group_of.clone())
            .expect_err("another window");
        assert_eq!(refused.0, KB_SCOPE_UNKNOWN);
        scopes.close(2, Some(&json(&format!("\"{id}\""))));
        assert_eq!(
            scopes
                .narrow(1, Some(&call), &paths, || group_of.clone())
                .expect("still open"),
            strings(&["/a"])
        );
        scopes.close(1, Some(&json(&format!("\"{id}\""))));
        assert!(
            scopes
                .narrow(1, Some(&call), &paths, || group_of.clone())
                .is_err()
        );
    }

    #[test]
    fn the_oldest_scope_is_dropped_past_the_limit() {
        let mut scopes = counting(2.0);
        let group_of = groups(&[("/a", "work")]);
        let work = json(r#""work""#);
        let first = scopes.open(1, Some(&work), &group_of).expect("open");
        let second = scopes.open(1, Some(&work), &group_of).expect("open");
        let third = scopes.open(1, Some(&work), &group_of).expect("open");
        let alive =
            |scopes: &KbRunScopes, id: &str| scopes.project_of(1, Some(&call_with(id))).is_ok();
        assert!(!alive(&scopes, &first));
        assert!(alive(&scopes, &second));
        assert!(alive(&scopes, &third));
    }

    #[test]
    fn a_project_scope_names_its_project_and_the_starred_part_it_asked_for() {
        let mut scopes = counting(KB_SCOPES_MAX);
        let group_of = groups(&[("/a", "work")]);
        let paths = strings(&["/a", "/b"]);
        let all = scopes
            .open_project(1, "p1", KbStarredReach::All, &group_of)
            .expect("all");
        let none = ProjectToolsScopes::open_project(&mut scopes, 1, "p2");
        let group = scopes
            .open_project(1, "p3", KbStarredReach::Group("work".to_owned()), &group_of)
            .expect("a group");
        let narrow = |id: &str| {
            scopes
                .narrow(1, Some(&call_with(id)), &paths, || group_of.clone())
                .expect("open")
        };
        assert_eq!(narrow(&all), paths);
        assert!(narrow(&none).is_empty());
        assert_eq!(narrow(&group), strings(&["/a"]));
        assert_eq!(
            scopes.project_of(1, Some(&call_with(&none))),
            Ok(Some("p2".to_owned()))
        );
        assert_eq!(scopes.project_of(1, None), Ok(None));
        assert!(
            scopes
                .open_project(1, "p4", KbStarredReach::Group("gone".to_owned()), &group_of)
                .is_err()
        );
    }

    #[test]
    fn the_default_scope_is_an_opaque_random_token() {
        let mut scopes = KbRunScopes::default();
        let group_of = groups(&[("/a", "work")]);
        let work = json(r#""work""#);
        let a = scopes.open(1, Some(&work), &group_of).expect("open");
        let b = scopes.open(1, Some(&work), &group_of).expect("open");
        assert_ne!(a, b);
        assert_eq!(a.len(), 48);
        assert!(a.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn open_scope_takes_a_group_alone_or_a_group_and_a_project() {
        let work = json(r#""work""#);
        assert_eq!(
            parse_kb_open_scope(Some(&work)),
            KbOpenScope {
                group: Some(work),
                project_id: None
            }
        );
        assert_eq!(parse_kb_open_scope(None).group, None);
        let with_project = json(r#"{"projectId":"p1"}"#);
        assert_eq!(
            parse_kb_open_scope(Some(&with_project)),
            KbOpenScope {
                group: Some(JsonValue::Null),
                project_id: Some("p1".to_owned())
            }
        );
        let empty_id = json(r#"{"group":"work","projectId":""}"#);
        assert_eq!(parse_kb_open_scope(Some(&empty_id)).project_id, None);
    }

    #[test]
    fn a_file_is_parsed_once_until_it_changes_and_the_cache_keeps_eight() {
        let dir = scratch("cache");
        let parsed = Rc::new(RefCell::new(Vec::new()));
        let mut parser = Counting {
            parsed: parsed.clone(),
        };
        let open_files = OpenFilesHolder::new();
        let mut cache = KbTextCache::new();
        let mut paths = Vec::new();
        for n in 0..9 {
            let path = dir.join(format!("f{n}.txt"));
            fs::write(&path, format!("text {n}")).expect("a file");
            paths.push(path.to_string_lossy().into_owned());
        }
        for path in &paths {
            read_knowledge_file_text(&open_files, &mut cache, &mut parser, path).expect("read");
        }
        assert_eq!(cache.len(), 8);
        assert_eq!(parsed.borrow().len(), 9);
        read_knowledge_file_text(&open_files, &mut cache, &mut parser, &paths[8]).expect("hit");
        assert_eq!(parsed.borrow().len(), 9);
        // the oldest was evicted
        read_knowledge_file_text(&open_files, &mut cache, &mut parser, &paths[0]).expect("miss");
        assert_eq!(parsed.borrow().len(), 10);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_with_unsaved_changes_is_not_read_even_when_cached() {
        let dir = scratch("unsaved");
        let path = dir.join("a.txt").to_string_lossy().into_owned();
        fs::write(&path, "abc").expect("a file");
        let mut parser = Counting {
            parsed: Rc::new(RefCell::new(Vec::new())),
        };
        let mut open_files = OpenFilesHolder::new();
        let mut cache = KbTextCache::new();
        read_knowledge_file_text(&open_files, &mut cache, &mut parser, &path).expect("read");
        let dirty = path.clone();
        let source: OpenFilesSource = Box::new(move || {
            Ok(vec![OpenFileState {
                file_path: Some(dirty.clone()),
                dirty: true,
            }])
        });
        open_files.set_open_files_source(Some(source));
        let refused = read_knowledge_file_text(&open_files, &mut cache, &mut parser, &path)
            .expect_err("unsaved");
        assert_eq!(refused.0, UNSAVED_CHANGES_MESSAGE);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_page_is_a_chunk_from_the_floored_offset() {
        let dir = scratch("page");
        let path = dir.join("a.txt").to_string_lossy().into_owned();
        fs::write(&path, "x".repeat(24_005)).expect("a file");
        let mut parser = Counting {
            parsed: Rc::new(RefCell::new(Vec::new())),
        };
        let open_files = OpenFilesHolder::new();
        let mut cache = KbTextCache::new();
        let mut page = |offset: f64| {
            read_knowledge_file_page(&open_files, &mut cache, &mut parser, &path, offset)
                .expect("a page")
        };
        assert_eq!(page(0.0).text.len(), 24_000);
        assert_eq!(page(24_000.9).text.len(), 5);
        let past = page(30_000.0);
        assert_eq!(
            (past.text.as_str(), past.total_chars, past.offset),
            ("", 24_005, 30_000.0)
        );
        assert_eq!(page(f64::NAN).offset, 0.0);
        assert_eq!(page(-5.0).offset, 0.0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_keeps_starred_hits_once_and_cuts_the_page() {
        let hit = |path: &str| IndexedHit {
            path: path.to_owned(),
            name: "n".to_owned(),
            ext: "txt".to_owned(),
            snippet_text: None,
        };
        let pool = vec![
            hit("/a/x.txt"),
            hit("/b/y.txt"),
            hit("/a/x.txt"),
            hit("/c/z.txt"),
        ];
        let starred = strings(&["/a/x.txt", "/c/z.txt"]);
        let mut search = |_: &str, _: f64| -> Result<Vec<IndexedHit>, Thrown> { Ok(pool.clone()) };
        let all = search_knowledge_base(&mut search, " q ", &starred, 10.0).expect("hits");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].folder, "a");
        assert_eq!(all[0].snippet, "");
        let one = search_knowledge_base(&mut search, "q", &starred, 0.0).expect("hits");
        assert_eq!(one.len(), 1);
        let blank = search_knowledge_base(&mut search, "  ", &starred, 10.0).expect("hits");
        assert!(blank.is_empty());
    }

    #[test]
    fn create_request_refusals_name_the_first_thing_wrong() {
        let refusal = |text: &str| {
            parse_kb_create_request(Some(&json(text)))
                .expect_err("refused")
                .0
        };
        assert_eq!(refusal("null"), "format must be \"md\" or \"docx\"");
        assert_eq!(
            refusal(r#"{"format":"docx","content":" \n"}"#),
            "content must not be empty"
        );
        let ok = parse_kb_create_request(Some(&json(r#"{"format":"md","content":"hi"}"#)))
            .expect("a request");
        assert_eq!(ok.title, "");
        assert_eq!(ok.format, KbCreateFormat::Md);
    }
}
