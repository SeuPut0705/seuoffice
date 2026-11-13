//! `apps/shell/src/main/projects/project-tools.ts`: the project folder tools
//! of one shell (spec 5.5, 5.8; decision 0020 for the run scope). The screen
//! names a project id once per run; main mints an opaque scope for it
//! (`open_scope`) and every tool call carries that scope. On every call main
//! resolves the project's folder and visibility rule again (list, `ignore`),
//! so a path or list sent by the renderer is never trusted, a project removed
//! mid-run is refused, and `ignore` edits apply to the next call.
//!
//! Reading is the attachment path: unsaved changes refused, the size cap, then
//! the knowledge base's page of the parsed text (`parseFileToText` with its
//! withholding: a mark it cannot process fails the read). A file that is not
//! on this PC is opened only after the person agreed to download it
//! (`ask_download`).
//!
//! The TypeScript awaits its collaborators; each is a plain call here. The
//! `unknown` a tool call carries is a `JsonValue`; `argsOf` of it is the
//! object it is, or nothing. What the tools use of other modules is a trait:
//!
//! - [`ProjectToolsGuide`]: `Pick<ProjectGuide, 'aiVisibility'>`;
//! - [`ProjectToolsScopes`]: the `KbRunScopes` methods the tools call;
//! - [`ProjectToolsStore`] and [`IndexStore`]: the home search index and the
//!   `Pick<FileIndexStore, 'search' | 'pathsIndexedAsOnDisk'>` it answers;
//! - [`KnowledgePages`]: `readKnowledgeFilePage` (engine-waiting: file-parse
//!   reads the document).
//!
//! The question `askDownload` asks is a closure of the caller, the open files
//! the unsaved-changes question reads are the `OpenFilesHolder` each tool that
//! reads a file is given. An `Error` any of them throws is a [`Thrown`].

use std::collections::HashSet;
use std::fs;

use jscompat::node_path::host::{basename, is_absolute, join};
use jscompat::{JsMap, JsNum, JsObject, JsonValue, slice_utf16, to_primitive, trim};
use serde::Serialize;

use super::folder_files::real_plain_file_in;
use super::ignore::IgnoreMatcher;
use super::paths::{is_plain_segment, relative_inside};
use super::project_files::{
    CloudOnlyResolver, ListVisibleFiles, VisibleFileLister, no_ignore, slice_bounds, thrown_limit,
    to_entry, with_cloud_flags,
};
use super::project_guide::ProjectAiVisibility;
use super::visibility::is_ai_visible_path;
use crate::node_fs::namespaced;
use crate::packages::ai_provider::agent_session_policy::process_platform;
use crate::packages::electron_utils::default_save_dir::Thrown;
use crate::packages::electron_utils::unsaved_files::{
    OpenFilesHolder, UNSAVED_CHANGES_MESSAGE, file_has_unsaved_changes, without_unsaved_files,
};
use crate::packages::project_store::{
    ProjectId, ProjectListFilesResult, ProjectReadRefusal, ProjectReadResult, ProjectSearchHit,
    ProjectSearchResult,
};
use crate::shell::folder_tree::is_supported_tree_file;
use crate::shell::knowledge_base::{KbReadPage, kb_read_max_bytes};

/// `PROJECT_SCOPE_UNKNOWN`: a call named no scope, a scope main does not hold,
/// another window's, or a starred-only scope
pub const PROJECT_SCOPE_UNKNOWN: &str = "project scope is not open";

/// `PROJECT_UNAVAILABLE`: the project is not in the list (any more) or its
/// folder is gone
pub const PROJECT_UNAVAILABLE: &str = "project is not listed or its folder is missing";

/// `PROJECT_LIST_DEFAULT_LIMIT`: default page size; the tool input may ask for
/// another size
pub const PROJECT_LIST_DEFAULT_LIMIT: f64 = 200.0;

/// `PROJECT_SEARCH_DEFAULT_LIMIT`: default page size; the tool input may ask
/// for another size
pub const PROJECT_SEARCH_DEFAULT_LIMIT: f64 = 20.0;

/// `QUERY_MAX_CHARS`: query cap, same as the home search box and the
/// knowledge search
const QUERY_MAX_CHARS: f64 = 200.0;

/// `DownloadAsk`: what the download question shows and where
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadAsk {
    /// the asking window (webContents id), parent of the dialog
    pub owner: i64,
    pub project_id: ProjectId,
    /// the file's name, as the question names it
    pub file_name: String,
    /// folder-relative path, `/`-separated
    pub rel_path: String,
}

/// `askDownload`: asks "'<file>' is not on this PC; download it?"; `true`
/// only when the person agreed. `Err` is a rejection, which counts as "no".
pub type DownloadAsker = Box<dyn FnMut(&DownloadAsk) -> Result<bool, Thrown>>;

/// `ProjectToolsDeps.guide`: `Pick<ProjectGuide, 'aiVisibility'>`
pub trait ProjectToolsGuide {
    /// `aiVisibility(id)`: the visibility rule of one project (reads its
    /// `ignore` now); `None` (`null`) when not listed
    fn ai_visibility(&mut self, id: &str) -> Result<Option<ProjectAiVisibility>, Thrown>;
}

/// `ProjectToolsDeps.scopes`: the run scopes (may be shared with the
/// knowledge-base channel); the `KbRunScopes` methods the tools call
pub trait ProjectToolsScopes {
    /// `openProject(owner, projectId, 'none')`: a scope for one run of
    /// `owner` over a project folder only
    fn open_project(&mut self, owner: i64, project_id: &str) -> String;

    /// `close(owner, scope)`: only the window that opened a scope can close
    /// it; `scope` is whatever the call carried (`None` is `undefined`)
    fn close(&mut self, owner: i64, scope: Option<&JsonValue>);

    /// `projectOf(owner, raw)`: the project folder the call's scope also
    /// reads, or `None` (`null`: no scope, or a starred-only scope). A scope
    /// main does not hold is an `Err`.
    fn project_of(&mut self, owner: i64, raw: &JsonValue) -> Result<Option<ProjectId>, Thrown>;
}

/// `SearchOptions` of the file index, as the project search passes them. The
/// keys are in the order the TypeScript literal writes them.
pub struct IndexSearchOptions<'a> {
    pub offset: f64,
    pub limit: f64,
    /// lowercased extensions; `None` leaves the key out
    pub exts: Option<Vec<String>>,
    /// keep only the files whose path passes; applied before ranking and
    /// paging, so files elsewhere cannot fill the page first and `total`
    /// counts the kept ones. `Err` is a throw of the test.
    pub within: &'a mut dyn FnMut(&str) -> Result<bool, Thrown>,
}

/// `SearchHit` of the file index: the fields the project search reads
#[derive(Debug, Clone, PartialEq)]
pub struct IndexHit {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub mtime_ms: f64,
    /// the text of each part of the excerpt around the first content match
    /// (`snippet[i].text`); `None` (`null`) when only the name or path matched
    pub snippet: Option<Vec<String>>,
}

/// `SearchResult` of the file index
#[derive(Debug, Clone, PartialEq)]
pub struct IndexSearchResult {
    pub hits: Vec<IndexHit>,
    pub total: u64,
}

/// `Pick<FileIndexStore, 'search' | 'pathsIndexedAsOnDisk'>`
pub trait IndexStore {
    /// `search(input, opts)`
    fn search(
        &mut self,
        input: &str,
        options: &mut IndexSearchOptions<'_>,
    ) -> Result<IndexSearchResult, Thrown>;

    /// `pathsIndexedAsOnDisk(paths)`: the paths whose index row matches the
    /// file as it is on disk now
    fn paths_indexed_as_on_disk(&mut self, paths: &[String]) -> Vec<String>;
}

/// `ProjectToolsDeps.store`: the home search index, or `None` (`null`) while
/// it is unavailable; asked on every search
pub trait ProjectToolsStore {
    fn store(&mut self) -> Option<&mut dyn IndexStore>;
}

/// `readKnowledgeFilePage(filePath, offset)` of `knowledge-base`: engine-waiting
/// (file-parse reads the document). The message of its `Err` is compared with
/// `UNSAVED_CHANGES_MESSAGE`.
pub trait KnowledgePages {
    fn read_page(&mut self, file_path: &str, offset: f64) -> Result<KbReadPage, Thrown>;
}

/// `ProjectToolsDeps`
pub struct ProjectToolsDeps {
    pub guide: Box<dyn ProjectToolsGuide>,
    /// the run scopes (may be shared with the knowledge-base channel)
    pub scopes: Box<dyn ProjectToolsScopes>,
    /// the home search index
    pub store: Box<dyn ProjectToolsStore>,
    /// The check right before a read opens a file; never cached. Where the
    /// TypeScript defaults it to `resolveCloudOnly` (one detector run per
    /// call), the caller passes that.
    pub resolve_cloud_only: Box<dyn CloudOnlyResolver>,
    /// The "not on this PC" marks of list and search results, which a run asks
    /// for often; may reuse recent verdicts. `None`: `resolve_cloud_only`.
    pub list_cloud_only: Option<Box<dyn CloudOnlyResolver>>,
    /// the project's AI-visible files; may reuse a recent walk. `None`:
    /// `listVisibleFiles`.
    pub list_files: Option<Box<dyn VisibleFileLister>>,
    /// asks "'<file>' is not on this PC; download it?"
    pub ask_download: DownloadAsker,
    /// `readKnowledgeFilePage`
    pub pages: Box<dyn KnowledgePages>,
    /// `NodeJS.Platform`; `None`: the host's
    pub platform: Option<String>,
}

/// `argsOf(raw)`: the object a call carries, or nothing
fn args_of(raw: &JsonValue) -> Option<&JsObject<JsonValue>> {
    match raw {
        JsonValue::Object(object) => Some(object),
        _ => None,
    }
}

/// `argsOf(raw)[key]`
fn field<'a>(raw: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    args_of(raw)?.get(key)
}

/// `count(value, fallback)` of a number
fn count_of_number(n: f64, fallback: f64) -> f64 {
    if n.is_finite() {
        n.floor().max(0.0)
    } else {
        fallback
    }
}

/// `count(value, fallback)`: `Number(value)` as a whole number from 0, else
/// `fallback`. `Err` is the `TypeError` of a value that converts to no
/// primitive.
fn count(value: Option<&JsonValue>, fallback: f64) -> Result<f64, Thrown> {
    let n = to_primitive(value)
        .map_err(|error| Thrown(error.0))?
        .to_number();
    Ok(count_of_number(n, fallback))
}

/// `cleanRelPath(value)`: `/`-separated, without a leading `./`; the rest is
/// judged by the visibility rule
fn clean_rel_path(value: &str) -> String {
    let slashed = trim(value).replace('\\', "/");
    let mut rel = slashed.as_str();
    while let Some(rest) = rel.strip_prefix("./") {
        rel = rest;
    }
    rel.to_owned()
}

/// `foldsCase(platform)`
fn folds_case(platform: &str) -> bool {
    platform == "win32" || platform == "darwin"
}

/// `relOf(visibility, path)`: folder-relative path of an absolute path the AI
/// may see in this project, or `None`
fn rel_of(
    visibility: &ProjectAiVisibility,
    platform: &str,
    path: &str,
) -> Result<Option<String>, Thrown> {
    let Some(rel) = relative_inside(&visibility.root, path, platform) else {
        return Ok(None);
    };
    let visible = visibility.is_visible(&rel, false).map_err(thrown_limit)?;
    Ok(visible.then_some(rel))
}

/// `cloudVerdicts(paths, resolve)`: one detector run for the paths; `None`
/// when it failed (callers treat that as not on this PC)
fn cloud_verdicts(paths: &[String], resolve: &mut dyn CloudOnlyResolver) -> Option<JsMap<bool>> {
    if paths.is_empty() {
        return Some(JsMap::new());
    }
    resolve.resolve(paths).ok()
}

/// `refused(reason)` of `readIn`
fn refused(reason: ProjectReadRefusal) -> ProjectReadResult {
    ProjectReadResult::Refused { reason }
}

/// the function `visibleTest` returns: the project's "visible to the AI" test
/// on absolute paths
pub struct VisibleTest {
    visibility: ProjectAiVisibility,
    platform: String,
}

impl VisibleTest {
    /// `(path) => this.relOf(visibility, path) !== null`
    pub fn test(&self, path: &str) -> Result<bool, Thrown> {
        Ok(rel_of(&self.visibility, &self.platform, path)?.is_some())
    }
}

/// `ProjectFolderTools`
pub struct ProjectFolderTools {
    guide: Box<dyn ProjectToolsGuide>,
    scopes: Box<dyn ProjectToolsScopes>,
    store: Box<dyn ProjectToolsStore>,
    resolve_cloud: Box<dyn CloudOnlyResolver>,
    list_cloud: Option<Box<dyn CloudOnlyResolver>>,
    list: Box<dyn VisibleFileLister>,
    ask_download: DownloadAsker,
    pages: Box<dyn KnowledgePages>,
    platform: String,
    /// `NO_IGNORE`
    no_ignore: IgnoreMatcher,
}

/// `this.listCloud`: `listCloudOnly ?? resolveCloud`
fn list_cloud_of<'a>(
    list_cloud: &'a mut Option<Box<dyn CloudOnlyResolver>>,
    resolve_cloud: &'a mut Box<dyn CloudOnlyResolver>,
) -> &'a mut dyn CloudOnlyResolver {
    match list_cloud {
        Some(resolver) => resolver.as_mut(),
        None => resolve_cloud.as_mut(),
    }
}

impl ProjectFolderTools {
    /// `new ProjectFolderTools(deps)`
    pub fn new(deps: ProjectToolsDeps) -> Self {
        ProjectFolderTools {
            guide: deps.guide,
            scopes: deps.scopes,
            store: deps.store,
            resolve_cloud: deps.resolve_cloud_only,
            list_cloud: deps.list_cloud_only,
            list: deps
                .list_files
                .unwrap_or_else(|| Box::new(ListVisibleFiles)),
            ask_download: deps.ask_download,
            pages: deps.pages,
            platform: deps
                .platform
                .unwrap_or_else(|| process_platform().to_owned()),
            no_ignore: no_ignore(),
        }
    }

    // ---- scope ----

    /// `visibility(projectId)`: the folder and visibility of a listed project
    /// whose folder exists; `None` otherwise
    fn visibility_of(&mut self, project_id: &str) -> Result<Option<ProjectAiVisibility>, Thrown> {
        if project_id.is_empty() {
            return Ok(None);
        }
        let Some(visibility) = self.guide.ai_visibility(project_id)? else {
            return Ok(None);
        };
        if !fs::metadata(namespaced(&visibility.root)).is_ok_and(|info| info.is_dir()) {
            return Ok(None);
        }
        Ok(Some(visibility))
    }

    /// `visibility(projectId)` of a value of any type
    fn visibility(
        &mut self,
        project_id: Option<&JsonValue>,
    ) -> Result<Option<ProjectAiVisibility>, Thrown> {
        match project_id {
            Some(JsonValue::String(id)) => self.visibility_of(id),
            _ => Ok(None),
        }
    }

    /// `openScope(owner, raw)`: for an editor's panel: the project folder only
    pub fn open_scope(&mut self, owner: i64, raw: &JsonValue) -> Result<String, Thrown> {
        let project_id = field(raw, "projectId");
        if self.visibility(project_id)?.is_none() {
            return Err(Thrown(PROJECT_UNAVAILABLE.to_owned()));
        }
        let Some(JsonValue::String(project_id)) = project_id else {
            return Err(Thrown(PROJECT_UNAVAILABLE.to_owned()));
        };
        Ok(self.scopes.open_project(owner, project_id))
    }

    /// `closeScope(owner, raw)`: only the window that opened a scope can close
    /// it
    pub fn close_scope(&mut self, owner: i64, raw: &JsonValue) {
        self.scopes.close(owner, field(raw, "scope"));
    }

    /// `isAvailable(projectId)`: whether a project can be scoped (listed,
    /// folder present); for the home ask's combined scope
    pub fn is_available(&mut self, project_id: Option<&JsonValue>) -> Result<bool, Thrown> {
        Ok(self.visibility(project_id)?.is_some())
    }

    /// `scoped(owner, raw)`: the project of the call's scope and its
    /// visibility now; an `Err` when either is gone
    fn scoped(
        &mut self,
        owner: i64,
        raw: &JsonValue,
    ) -> Result<(ProjectId, ProjectAiVisibility), Thrown> {
        // a call without a scope is never an unscoped call here
        let project_id = if field(raw, "scope").is_none() {
            None
        } else {
            self.scopes.project_of(owner, raw).ok().flatten()
        };
        let Some(project_id) = project_id.filter(|id| !id.is_empty()) else {
            return Err(Thrown(PROJECT_SCOPE_UNKNOWN.to_owned()));
        };
        let Some(visibility) = self.visibility_of(&project_id)? else {
            return Err(Thrown(PROJECT_UNAVAILABLE.to_owned()));
        };
        Ok((project_id, visibility))
    }

    // ---- project_list_files ----

    /// `listFiles(owner, raw)`
    pub fn list_files(
        &mut self,
        owner: i64,
        raw: &JsonValue,
    ) -> Result<ProjectListFilesResult, Thrown> {
        let (_, visibility) = self.scoped(owner, raw)?;
        let prefix = match field(raw, "prefix") {
            Some(JsonValue::String(prefix)) => clean_rel_path(prefix),
            _ => String::new(),
        };
        let mut files = self.list.list(&visibility)?;
        if !prefix.is_empty() {
            let fold = folds_case(&self.platform);
            let wanted = if fold { prefix.to_lowercase() } else { prefix };
            files.retain(|file| {
                if fold {
                    file.entry.rel_path.to_lowercase().starts_with(&wanted)
                } else {
                    file.entry.rel_path.starts_with(&wanted)
                }
            });
        }
        let offset = count(field(raw, "offset"), 0.0)?;
        let limit = count(field(raw, "limit"), PROJECT_LIST_DEFAULT_LIMIT)?;
        let range = slice_bounds(files.len(), offset, offset + limit);
        let page = with_cloud_flags(
            &files[range],
            list_cloud_of(&mut self.list_cloud, &mut self.resolve_cloud),
        );
        Ok(ProjectListFilesResult {
            files: page.iter().map(to_entry).collect(),
            total: files.len() as u64,
        })
    }

    // ---- project_search ----

    /// `visibleTest(projectId)`: the project's "visible to the AI" test on
    /// absolute paths, or `None` when the project is not available; for the
    /// home ask's knowledge search
    pub fn visible_test(&mut self, project_id: &str) -> Result<Option<VisibleTest>, Thrown> {
        Ok(self
            .visibility_of(project_id)?
            .map(|visibility| VisibleTest {
                visibility,
                platform: self.platform.clone(),
            }))
    }

    /// `search(owner, raw)`
    pub fn search(
        &mut self,
        open_files: &OpenFilesHolder,
        owner: i64,
        raw: &JsonValue,
    ) -> Result<ProjectSearchResult, Thrown> {
        let (_, visibility) = self.scoped(owner, raw)?;
        let query = match field(raw, "query") {
            Some(JsonValue::String(query)) => slice_utf16(trim(query), 0.0, Some(QUERY_MAX_CHARS)),
            _ => String::new(),
        };
        let empty = ProjectSearchResult {
            hits: Vec::new(),
            total: 0,
        };
        let Some(store) = self.store.store() else {
            return Ok(empty);
        };
        if query.is_empty() {
            return Ok(empty);
        }
        let exts: Vec<&str> = match field(raw, "exts") {
            Some(JsonValue::Array(items)) => items
                .iter()
                .filter_map(|ext| match ext {
                    JsonValue::String(ext) if !ext.is_empty() => Some(ext.as_str()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        let offset = count(field(raw, "offset"), 0.0)?;
        let limit = count(field(raw, "limit"), PROJECT_SEARCH_DEFAULT_LIMIT)?;
        let exts = (!exts.is_empty()).then(|| {
            exts.iter()
                .map(|ext| ext.strip_prefix('.').unwrap_or(ext).to_lowercase())
                .collect::<Vec<String>>()
        });
        let platform = self.platform.as_str();
        // narrowed in the query: only this project's visible files are ranked
        // and paged
        let mut within = |path: &str| -> Result<bool, Thrown> {
            Ok(rel_of(&visibility, platform, path)?.is_some())
        };
        let result = store.search(
            &query,
            &mut IndexSearchOptions {
                offset,
                limit,
                exts,
                within: &mut within,
            },
        )?;
        let paths: Vec<String> = result.hits.iter().map(|hit| hit.path.clone()).collect();
        // an excerpt is quoted only from a file indexed as it is on disk and
        // not open with unsaved changes
        let indexed = store.paths_indexed_as_on_disk(&paths);
        let quotable: HashSet<String> =
            without_unsaved_files(open_files, &indexed, |path| path.clone())
                .into_iter()
                .collect();
        let cloud = cloud_verdicts(
            &paths,
            list_cloud_of(&mut self.list_cloud, &mut self.resolve_cloud),
        );
        let mut hits: Vec<ProjectSearchHit> = Vec::new();
        for hit in result.hits {
            let Some(rel_path) = rel_of(&visibility, platform, &hit.path)? else {
                continue;
            };
            let cloud_only = cloud
                .as_ref()
                .is_none_or(|cloud| cloud.get(&hit.path) != Some(&false));
            let snippet = if quotable.contains(&hit.path) {
                hit.snippet.unwrap_or_default().concat()
            } else {
                String::new()
            };
            hits.push(ProjectSearchHit {
                rel_path,
                name: hit.name,
                ext: hit.ext,
                mtime_ms: JsNum(hit.mtime_ms),
                cloud_only,
                snippet,
            });
        }
        Ok(ProjectSearchResult {
            hits,
            total: result.total,
        })
    }

    // ---- project_read ----

    /// `read(owner, raw)`
    pub fn read(
        &mut self,
        open_files: &OpenFilesHolder,
        owner: i64,
        raw: &JsonValue,
    ) -> Result<ProjectReadResult, Thrown> {
        let (project_id, visibility) = self.scoped(owner, raw)?;
        let given = match field(raw, "relPath") {
            Some(JsonValue::String(given)) => given.as_str(),
            _ => "",
        };
        let offset = count(field(raw, "offset"), 0.0)?;
        self.read_in(open_files, owner, &project_id, &visibility, given, offset)
    }

    /// `readPath(owner, projectId, path, offset)`: a read by absolute path for
    /// a run whose scope holds `projectId` (the home ask's knowledge read);
    /// the same checks and question as `read`
    pub fn read_path(
        &mut self,
        open_files: &OpenFilesHolder,
        owner: i64,
        project_id: &str,
        path: &str,
        offset: f64,
    ) -> Result<ProjectReadResult, Thrown> {
        let Some(visibility) = self.visibility_of(project_id)? else {
            return Ok(refused(ProjectReadRefusal::Outside));
        };
        self.read_in(
            open_files,
            owner,
            project_id,
            &visibility,
            path,
            count_of_number(offset, 0.0),
        )
    }

    /// `judge(visibility, segments)`: why the AI may not see these
    /// folder-relative segments, or `None` when it may
    fn judge<S: AsRef<str>>(
        &self,
        visibility: &ProjectAiVisibility,
        segments: &[S],
    ) -> Result<Option<ProjectReadRefusal>, Thrown> {
        let rel = segments
            .iter()
            .map(|segment| segment.as_ref())
            .collect::<Vec<&str>>()
            .join("/");
        if !is_ai_visible_path(&visibility.root, &rel, &self.no_ignore, false)
            .map_err(thrown_limit)?
        {
            return Ok(Some(ProjectReadRefusal::Hidden));
        }
        if !visibility.is_visible(&rel, false).map_err(thrown_limit)? {
            return Ok(Some(ProjectReadRefusal::Ignored));
        }
        Ok(None)
    }

    /// `readIn(owner, projectId, visibility, given, offset)`
    fn read_in(
        &mut self,
        open_files: &OpenFilesHolder,
        owner: i64,
        project_id: &str,
        visibility: &ProjectAiVisibility,
        given: &str,
        offset: f64,
    ) -> Result<ProjectReadResult, Thrown> {
        let given = trim(given);
        let rel = if is_absolute(given) || has_drive_prefix(given) {
            // an absolute path is accepted only when it lies inside the folder
            match relative_inside(&visibility.root, given, &self.platform) {
                Some(inside) => inside,
                None => return Ok(refused(ProjectReadRefusal::Outside)),
            }
        } else {
            clean_rel_path(given)
        };
        let asked: Vec<&str> = rel
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect();
        if asked.is_empty()
            || asked
                .iter()
                .any(|segment| *segment == ".." || *segment == ".")
        {
            return Ok(refused(ProjectReadRefusal::Outside));
        }
        // a stream name (`:`) or a trailing dot or space is another spelling
        // of some entry on Windows
        if self.platform == "win32" && !asked.iter().all(|segment| is_plain_segment(segment)) {
            return Ok(refused(ProjectReadRefusal::NotFound));
        }
        if let Some(judged) = self.judge(visibility, &asked)? {
            return Ok(refused(judged));
        }

        // no link or junction on the way, a plain file at the end
        let Some(found) = real_plain_file_in(&visibility.root, &asked, &self.platform) else {
            let mut parts: Vec<&str> = Vec::with_capacity(asked.len() + 1);
            parts.push(&visibility.root);
            parts.extend(asked.iter().copied());
            return Ok(refused(
                match fs::symlink_metadata(namespaced(&join(&parts))) {
                    // a folder is no file to read; anything else present was
                    // reached through a link
                    Ok(info) if info.is_dir() => ProjectReadRefusal::NotFound,
                    Ok(_) => ProjectReadRefusal::Outside,
                    Err(_) => ProjectReadRefusal::NotFound,
                },
            ));
        };
        // judged again by the name on disk: a short name or other spelling may
        // stand for a hidden, `.seuoffice/` or ignored entry; every later
        // check uses the real path
        let path = found.path;
        let segments = found.segments;
        if let Some(judged) = self.judge(visibility, &segments)? {
            return Ok(refused(judged));
        }
        if !is_supported_tree_file(&path) {
            return Ok(refused(ProjectReadRefusal::Unreadable));
        }
        if file_has_unsaved_changes(open_files, &path) {
            return Ok(refused(ProjectReadRefusal::Unsaved));
        }
        match fs::metadata(namespaced(&path)) {
            Ok(info) if info.len() as f64 > kb_read_max_bytes(&path) => {
                return Ok(refused(ProjectReadRefusal::TooLarge));
            }
            Ok(_) => {}
            Err(_) => return Ok(refused(ProjectReadRefusal::NotFound)),
        }

        // the content of a file that is not on this PC is opened only on the
        // person's yes; fresh, never the list cache: this decides whether
        // opening the file downloads it
        let cloud = cloud_verdicts(std::slice::from_ref(&path), self.resolve_cloud.as_mut());
        if cloud.is_none_or(|cloud| cloud.get(&path) != Some(&false)) {
            let ask = DownloadAsk {
                owner,
                project_id: project_id.to_owned(),
                file_name: basename(&path, None),
                rel_path: segments.join("/"),
            };
            let agreed = (self.ask_download)(&ask).unwrap_or(false);
            if !agreed {
                return Ok(ProjectReadResult::Declined);
            }
        }

        match self.pages.read_page(&path, offset) {
            Ok(page) => Ok(ProjectReadResult::Ok {
                text: page.text,
                total_chars: page.total_chars,
                offset: JsNum(page.offset),
            }),
            Err(Thrown(message)) => {
                if message == UNSAVED_CHANGES_MESSAGE {
                    return Ok(refused(ProjectReadRefusal::Unsaved));
                }
                Ok(refused(ProjectReadRefusal::Unreadable))
            }
        }
    }
}

/// `/^[A-Za-z]:/.test(text)`
fn has_drive_prefix(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.next() == Some(':')
}
