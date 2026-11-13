//! `apps/shell/src/main/projects/project-files.ts`: the files of a project
//! folder the AI may see (spec 5.4 item 4, 5.5): every supported file the
//! visibility rule keeps, newest first, with the "not on this PC" mark filled
//! in from one detector run; the lists the context, the `@` list and the list
//! tool are made from.
//!
//! The TypeScript awaits `node:fs/promises` and the resolver; each call here
//! is the plain synchronous one. A function type of the TypeScript
//! (`VisibleFileLister`, `CloudOnlyResolver`) is a trait, and the clock of the
//! cached lister is the [`CacheClock`] of `cloud_cache`. An `Error` a function
//! throws is a [`Thrown`] with its message.
//!
//! `resolveCloudOnly`, where the TypeScript defaults it to the detector of
//! `cloud-files`, and `listVisibleFiles`, where it defaults to the walk, are
//! values the caller passes.

use std::fs;
use std::ops::Range;

use jscompat::node_path::host::{basename, extname, join};
use jscompat::{JsMap, JsNum, RegexLimit, sort_by_number, string_less_than};
use serde::Serialize;

use super::cloud_cache::CacheClock;
use super::ignore::{IgnoreMatcher, IgnoreOptions, compile_ignore};
use super::project_guide::{ContextFiles, ContextFilesRequest, ProjectAiVisibility};
use super::stand_ins::{SCAN_MAX_DEPTH, is_supported_tree_file};
use super::visibility::is_ai_visible_path;
use crate::node_fs::namespaced;
use crate::packages::electron_utils::default_save_dir::Thrown;
use crate::packages::project_store::{ProjectFileEntry, nfc};
use crate::shell::recent_files::StatInfo;

/// What a resolver rejects with (`error.message`)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveFailure(pub String);

/// `CloudOnlyResolver`: `resolveCloudOnly` from cloud-files, one detector run
/// per call, `true` = not on this PC. The real resolver and the cache of
/// `cloud_cache` both implement it.
pub trait CloudOnlyResolver {
    fn resolve(&mut self, paths: &[String]) -> Result<JsMap<bool>, ResolveFailure>;
}

impl<T: CloudOnlyResolver + ?Sized> CloudOnlyResolver for Box<T> {
    fn resolve(&mut self, paths: &[String]) -> Result<JsMap<bool>, ResolveFailure> {
        (**self).resolve(paths)
    }
}

/// The error of a search of `ignore` that reached the backtrack bound, as the
/// `RangeError` the TypeScript would throw
pub fn thrown_limit(error: RegexLimit) -> Thrown {
    Thrown(error.to_string())
}

/// `compileIgnore('', { caseInsensitive: false })`: the rule that ignores
/// nothing
pub fn no_ignore() -> IgnoreMatcher {
    compile_ignore(
        "",
        IgnoreOptions {
            case_insensitive: false,
        },
    )
    .expect("an empty ignore file compiles")
}

/// `array.slice(start, end)` of a list of `len` items: a negative index counts
/// from the end, NaN is 0, an index past the end is the end
pub fn slice_bounds(len: usize, start: f64, end: f64) -> Range<usize> {
    let length = len as f64;
    let clamp = |index: f64| {
        let index = if index.is_nan() { 0.0 } else { index.trunc() };
        let index = if index < 0.0 {
            (length + index).max(0.0)
        } else {
            index.min(length)
        };
        index as usize
    };
    let from = clamp(start);
    let to = clamp(end).max(from);
    from..to
}

/// `PROJECT_CONTEXT_FILES_LIMIT`: file names per send (spec 5.4 item 4); past
/// this the context says "N more, use search"
pub const PROJECT_CONTEXT_FILES_LIMIT: f64 = 500.0;

/// `VisibleFile`: a listed file and where it is on disk. `path` comes first
/// in the object the TypeScript builds, then the keys of `ProjectFileEntry`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VisibleFile {
    pub path: String,
    #[serde(flatten)]
    pub entry: ProjectFileEntry,
}

/// `newestFirst(a, b)`: newest first; equal times by path so the order is
/// stable
fn newest_first(a: &VisibleFile, b: &VisibleFile) -> f64 {
    let by_time = b.entry.mtime_ms.0 - a.entry.mtime_ms.0;
    // `x || y`: 0 and NaN fall through
    if by_time != 0.0 && !by_time.is_nan() {
        return by_time;
    }
    if string_less_than(&a.entry.rel_path, &b.entry.rel_path) {
        -1.0
    } else if string_less_than(&b.entry.rel_path, &a.entry.rel_path) {
        1.0
    } else {
        0.0
    }
}

/// `listVisibleFiles(visibility)`: every AI-visible supported file of the
/// folder, newest first, `cloudOnly` unset (false). Depth follows the index's
/// walk (`SCAN_MAX_DEPTH`). `Err` is a search of `ignore` that reached the
/// backtrack bound.
pub fn list_visible_files(
    visibility: &ProjectAiVisibility,
) -> Result<Vec<VisibleFile>, RegexLimit> {
    walk_supported_files(
        &visibility.root,
        &mut |rel| visibility.is_visible(rel, true),
        &mut |rel| visibility.is_visible(rel, false),
    )
}

/// `VisibleFileLister`: `listVisibleFiles` or a cached stand-in for it
pub trait VisibleFileLister {
    fn list(&mut self, visibility: &ProjectAiVisibility) -> Result<Vec<VisibleFile>, Thrown>;
}

/// `listVisibleFiles` as a [`VisibleFileLister`]
#[derive(Debug, Clone, Copy, Default)]
pub struct ListVisibleFiles;

impl VisibleFileLister for ListVisibleFiles {
    fn list(&mut self, visibility: &ProjectAiVisibility) -> Result<Vec<VisibleFile>, Thrown> {
        list_visible_files(visibility).map_err(thrown_limit)
    }
}

impl<T: VisibleFileLister + ?Sized> VisibleFileLister for Box<T> {
    fn list(&mut self, visibility: &ProjectAiVisibility) -> Result<Vec<VisibleFile>, Thrown> {
        (**self).list(visibility)
    }
}

/// `PROJECT_FILE_LIST_CACHE_MS`: how long one project's walk is reused
/// (context file names of each send, the `@` list, the list tool). A send, its
/// tool calls and the `@` list of the next message often ask within seconds;
/// on a large folder each walk is thousands of file system calls. Tunable; a
/// file added or removed meanwhile shows after this.
pub const PROJECT_FILE_LIST_CACHE_MS: f64 = 5_000.0;

/// one remembered walk
struct Walk {
    root: String,
    at: f64,
    files: Vec<VisibleFile>,
}

/// `createCachedFileLister(options)`: `list` with each project's walk
/// remembered for `ttl`, keyed by the root and the visibility rule
/// (`ruleKey`), so an `ignore` edit is a new key and never served a stale
/// list. A visibility without a `ruleKey` is never cached. A failed walk is
/// not kept.
pub struct CachedFileLister<L, C> {
    ttl: f64,
    clock: C,
    list: L,
    walks: JsMap<Walk>,
}

impl<L: VisibleFileLister, C: CacheClock> CachedFileLister<L, C> {
    /// `options.ttlMs` is `ttl_ms`; where it is `None` it is
    /// [`PROJECT_FILE_LIST_CACHE_MS`]. `options.now` is `clock` and
    /// `options.list` is `list`.
    pub fn new(ttl_ms: Option<f64>, clock: C, list: L) -> Self {
        CachedFileLister {
            ttl: ttl_ms.unwrap_or(PROJECT_FILE_LIST_CACHE_MS),
            clock,
            list,
            walks: JsMap::new(),
        }
    }

    /// `invalidate(root)`: forget the walks of one project root, or of every
    /// project
    pub fn invalidate(&mut self, root: Option<&str>) {
        let gone: Vec<String> = self
            .walks
            .iter()
            .filter(|(_, walk)| root.is_none_or(|root| walk.root == root))
            .map(|(key, _)| key.to_owned())
            .collect();
        for key in gone {
            self.walks.delete(&key);
        }
    }
}

impl<L: VisibleFileLister, C: CacheClock> VisibleFileLister for CachedFileLister<L, C> {
    fn list(&mut self, visibility: &ProjectAiVisibility) -> Result<Vec<VisibleFile>, Thrown> {
        let Some(rule_key) = &visibility.rule_key else {
            return self.list.list(visibility);
        };
        let at = self.clock.now();
        let ttl = self.ttl;
        let expired: Vec<String> = self
            .walks
            .iter()
            .filter(|(_, walk)| at - walk.at >= ttl)
            .map(|(key, _)| key.to_owned())
            .collect();
        for key in expired {
            self.walks.delete(&key);
        }
        let key = format!("{}\u{0}{rule_key}", visibility.root);
        if let Some(walk) = self.walks.get(&key) {
            // a copy: callers filter and slice, and one caller's list is
            // never another's
            return Ok(walk.files.clone());
        }
        let files = self.list.list(visibility)?;
        self.walks.set(
            key,
            Walk {
                root: visibility.root.clone(),
                at,
                files: files.clone(),
            },
        );
        Ok(files)
    }
}

/// `listIgnoredFiles(visibility)`: the supported files `ignore` keeps from the
/// AI (the project screen's own list, spec 5.12; never offered to AI tools),
/// newest first. Hidden entries and `.seuoffice/` stay out of this list too.
pub fn list_ignored_files(
    visibility: &ProjectAiVisibility,
) -> Result<Vec<VisibleFile>, RegexLimit> {
    let no_ignore = no_ignore();
    let root = visibility.root.as_str();
    let shown = |rel: &str, is_dir: bool| is_ai_visible_path(root, rel, &no_ignore, is_dir);
    walk_supported_files(root, &mut |rel| shown(rel, true), &mut |rel| {
        Ok(shown(rel, false)? && !visibility.is_visible(rel, false)?)
    })
}

/// `enterFolder` / `keepFile` of `walkSupportedFiles`
type RelTest<'a> = &'a mut dyn FnMut(&str) -> Result<bool, RegexLimit>;

/// `walkSupportedFiles(root, enterFolder, keepFile)`
fn walk_supported_files(
    root: &str,
    enter_folder: RelTest<'_>,
    keep_file: RelTest<'_>,
) -> Result<Vec<VisibleFile>, RegexLimit> {
    let mut out: Vec<VisibleFile> = Vec::new();
    walk(root, "", 0, enter_folder, keep_file, &mut out)?;
    sort_by_number(&mut out, newest_first);
    Ok(out)
}

/// the `walk(dir, rel, depth)` of `walkSupportedFiles`
fn walk(
    dir: &str,
    rel: &str,
    depth: u32,
    enter_folder: RelTest<'_>,
    keep_file: RelTest<'_>,
    out: &mut Vec<VisibleFile>,
) -> Result<(), RegexLimit> {
    if depth > SCAN_MAX_DEPTH {
        return Ok(());
    }
    let Ok(reader) = fs::read_dir(namespaced(dir)) else {
        return Ok(());
    };
    let mut entries: Vec<(String, fs::FileType)> = Vec::new();
    for entry in reader {
        let Ok(entry) = entry else {
            // a listing that fails is not walked
            return Ok(());
        };
        if let Ok(kind) = entry.file_type() {
            entries.push((entry.file_name().to_string_lossy().into_owned(), kind));
        }
    }
    // libuv sorts the names by bytes
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut folders: Vec<(String, String)> = Vec::new();
    let mut files: Vec<(String, String, String)> = Vec::new();
    for (name, kind) in entries {
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let path = join(&[dir, &name]);
        if kind.is_dir() {
            if enter_folder(&child_rel)? {
                folders.push((path, child_rel));
            }
        } else if kind.is_file() && is_supported_tree_file(&name) && keep_file(&child_rel)? {
            files.push((path, child_rel, name));
        }
    }
    for (path, child_rel, name) in files {
        // gone between the listing and the stat: left out
        let Ok(meta) = fs::metadata(namespaced(&path)) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let info = StatInfo::of(&meta);
        // `.slice(1)`: the extension is '' or starts with the dot
        let ext = extname(&name).get(1..).unwrap_or("").to_lowercase();
        out.push(VisibleFile {
            path,
            entry: ProjectFileEntry {
                rel_path: nfc(&child_rel),
                ext,
                size_bytes: info.size,
                mtime_ms: JsNum(info.mtime_ms),
                cloud_only: false,
            },
        });
    }
    for (path, child_rel) in folders {
        walk(
            &path,
            &child_rel,
            depth + 1,
            &mut *enter_folder,
            &mut *keep_file,
            out,
        )?;
    }
    Ok(())
}

/// `withCloudFlags(files, resolve)`: the given files with `cloudOnly` filled
/// in from one detector run. A detector that fails marks every file as not on
/// this PC: reading one then asks first, which is the safe side.
pub fn with_cloud_flags(
    files: &[VisibleFile],
    resolve: &mut dyn CloudOnlyResolver,
) -> Vec<VisibleFile> {
    if files.is_empty() {
        return Vec::new();
    }
    let paths: Vec<String> = files.iter().map(|file| file.path.clone()).collect();
    let verdicts = resolve.resolve(&paths).ok();
    files
        .iter()
        .map(|file| {
            let mut flagged = file.clone();
            flagged.entry.cloud_only = verdicts
                .as_ref()
                .is_none_or(|verdicts| verdicts.get(&file.path) != Some(&false));
            flagged
        })
        .collect()
}

/// `toEntry(file)`: a list entry as the bridge carries it (no absolute path)
pub fn to_entry(file: &VisibleFile) -> ProjectFileEntry {
    file.entry.clone()
}

/// `PROJECT_MENTION_FILES_LIMIT`: project files in the AI input's `@` list
/// (spec 5.13); tunable
pub const PROJECT_MENTION_FILES_LIMIT: f64 = 50.0;

/// an item of the `@` list: `{ path, title }`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MentionFile {
    pub path: String,
    pub title: String,
}

/// `projectMentionFiles(visibility, limit, list)`: the `@` list's "files of
/// this project" (spec 5.13): the newest `limit` AI-visible supported files
/// (hidden entries, `.seuoffice/` and `ignore` left out), as path and file
/// name. Nothing is opened. `limit` is [`PROJECT_MENTION_FILES_LIMIT`] where
/// it is `None`.
pub fn project_mention_files(
    visibility: &ProjectAiVisibility,
    limit: Option<f64>,
    list: &mut dyn VisibleFileLister,
) -> Result<Vec<MentionFile>, Thrown> {
    let files = list.list(visibility)?;
    let range = slice_bounds(
        files.len(),
        0.0,
        limit.unwrap_or(PROJECT_MENTION_FILES_LIMIT),
    );
    Ok(files[range]
        .iter()
        .map(|file| MentionFile {
            path: file.path.clone(),
            title: basename(&file.path, None),
        })
        .collect())
}

/// `createContextFiles(options)`: the guide's `contextFiles`: the newest
/// `limit` visible files with their "not on this PC" mark, and how many were
/// left out.
pub struct ContextFilesSource<R, L> {
    resolve: R,
    limit: f64,
    list: L,
}

impl<R: CloudOnlyResolver, L: VisibleFileLister> ContextFilesSource<R, L> {
    /// `options.limit` is `limit`; where it is `None` it is
    /// [`PROJECT_CONTEXT_FILES_LIMIT`]
    pub fn new(resolve: R, limit: Option<f64>, list: L) -> Self {
        ContextFilesSource {
            resolve,
            limit: limit.unwrap_or(PROJECT_CONTEXT_FILES_LIMIT),
            list,
        }
    }

    /// the function `createContextFiles` returns
    pub fn context_files(&mut self, request: &ContextFilesRequest) -> Result<ContextFiles, Thrown> {
        let all = self.list.list(&request.visibility)?;
        let range = slice_bounds(all.len(), 0.0, self.limit);
        let shown = with_cloud_flags(&all[range], &mut self.resolve);
        Ok(ContextFiles {
            files: shown.iter().map(to_entry).collect(),
            omitted: all.len().saturating_sub(shown.len()) as u64,
        })
    }
}
