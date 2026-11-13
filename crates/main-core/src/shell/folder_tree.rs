//! `apps/shell/src/main/folder-tree.ts`: the home "Folders" panel's tree over
//! the disk, and the moves and renames it makes.
//!
//! `readdirSync` answers in the order libuv's `scandir` sorts (by name, byte
//! by byte), so a listing is sorted that way here. `FolderWatcher` holds the
//! watcher's state and nothing else: the caller owns the `fs.watch` handle and
//! the timer, feeds each event to [`FolderWatcher::note`] and fires
//! [`FolderWatcher::on_timer`] when the debounce delay it asked for ran out.
//! The `replaceExisting` callback of `MoveOptions` is the [`MoveOptions`]
//! trait. A throw is a [`Thrown`]: `Some(message)` for an `Error`, `None` for
//! any other value, which the TypeScript answers with `errors.failed`.

use std::collections::HashSet;
use std::fs;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::preferences::CollationNumericOrdering;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use jscompat::node_path::host::{SEP, basename, dirname, extname, join, resolve};
use jscompat::{slice_utf16, sort_by_number, trim};
use serde::Serialize;

use super::app_routing::document_extension;
use super::folder_roots::FolderRoot;
use super::recent_files::{RecentEntry, StatInfo, stat_path_entries};
use super::rename_validation::{is_same_file, is_valid_rename_name};
use crate::markdown::asset_lifecycle::ASSET_MANIFEST_FILENAME;
use crate::markdown::fs_util::{mkdir, rename, rm_recursive_force};
use crate::markdown::old_names::OLD_ASSET_MANIFEST_FILENAMES;
use crate::node_fs::{NodeError, namespaced, node_error};
use crate::packages::electron_utils::default_save_dir::is_usable_save_dir;

/// files the home tree shows; mirrors the shell's open-dialog filter
pub const TREE_FILE_EXTENSIONS: &[&str] = &[
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
    "vsdx",
    // draw.io pictures, by their double extension (documentExtension)
    "drawio.svg",
    "drawio.png",
];

const HIDDEN_DIR_NAMES: &[&str] = &["node_modules", "__macosx"];
const HIDDEN_FILE_NAMES: &[&str] = &["thumbs.db", "desktop.ini"];

/// A throw: `Some(message)` for an `Error`, `None` for any other value.
pub type Thrown = Option<String>;

/// `fs.existsSync(path)`
pub(crate) fn exists_sync(path: &str) -> bool {
    fs::metadata(namespaced(path)).is_ok()
}

pub fn is_supported_tree_file(name: &str) -> bool {
    TREE_FILE_EXTENSIONS.contains(&document_extension(name).as_str())
}

/// dotfiles, Office lock files, OS junk and the Markdown `assets/` folder stay out of the tree
pub fn is_hidden_entry(dir: &str, name: &str, is_dir: bool) -> bool {
    if name.starts_with('.') || name.starts_with("~$") {
        return true;
    }
    let lower = name.to_lowercase();
    if is_dir {
        if HIDDEN_DIR_NAMES.contains(&lower.as_str()) {
            return true;
        }
        // the Markdown / HTML apps' image folder is app-owned when it holds their list, under either name
        if lower == "assets"
            && std::iter::once(ASSET_MANIFEST_FILENAME)
                .chain(OLD_ASSET_MANIFEST_FILENAMES)
                .any(|manifest| exists_sync(&join(&[dir, name, manifest])))
        {
            return true;
        }
        return false;
    }
    HIDDEN_FILE_NAMES.contains(&lower.as_str())
}

/// What a `Dirent` of `readdirSync(dir, { withFileTypes: true })` says it is,
/// without following a link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirentKind {
    Directory,
    File,
    Other,
}

/// `Dirent`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dirent {
    pub name: String,
    pub kind: DirentKind,
}

/// `readdirSync(dir, { withFileTypes: true })`, `None` where it throws.
pub fn read_dirents(dir: &str) -> Option<Vec<Dirent>> {
    let mut out = read_dirents_unsorted(dir)?;
    out.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
    Some(out)
}

/// The entries in the order the file system yields them, as `fs.cpSync`
/// walks a folder (`opendir` without sorting): a copy that fails half way
/// leaves the same entries behind.
fn read_dirents_unsorted(dir: &str) -> Option<Vec<Dirent>> {
    let mut out: Vec<Dirent> = Vec::new();
    for entry in fs::read_dir(namespaced(dir)).ok()? {
        let entry = entry.ok()?;
        let file_type = entry.file_type().ok()?;
        let kind = if file_type.is_dir() {
            DirentKind::Directory
        } else if file_type.is_file() {
            DirentKind::File
        } else {
            DirentKind::Other
        };
        out.push(Dirent {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind,
        });
    }
    Some(out)
}

/// `realpathSync.native(path)` as Node writes it: no `\\?\` prefix.
fn real_path(path: &str) -> Option<String> {
    let real = fs::canonicalize(namespaced(path)).ok()?;
    let text = real.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        if let Some(rest) = text.strip_prefix("\\\\?\\UNC\\") {
            return Some(format!("\\\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix("\\\\?\\") {
            return Some(rest.to_owned());
        }
    }
    Some(text)
}

fn real_or_resolved(path: &str) -> String {
    real_path(path).unwrap_or_else(|| resolve(&[path]))
}

/// Ensure a path has a separator boundary without doubling filesystem roots.
fn with_trailing_sep(dir: &str) -> String {
    if dir.ends_with(SEP) {
        dir.to_owned()
    } else {
        format!("{dir}{SEP}")
    }
}

/// True when `path` is the root or lives under it. Existing paths compare by
/// real path (so a symlink pointing outside is rejected); a not-yet-existing
/// target compares by its nearest existing ancestor.
pub fn is_inside_root(root: &str, path: &str) -> bool {
    let real_root = real_or_resolved(root);
    let mut probe = resolve(&[path]);
    let mut missing: Vec<String> = Vec::new();
    while !exists_sync(&probe) {
        let parent = dirname(&probe);
        if parent == probe {
            return false;
        }
        missing.insert(0, basename(&probe, None));
        probe = parent;
    }
    let real_probe = real_or_resolved(&probe);
    let mut parts: Vec<&str> = vec![real_probe.as_str()];
    parts.extend(missing.iter().map(String::as_str));
    let real = join(&parts);
    real == real_root || real.starts_with(&with_trailing_sep(&real_root))
}

pub fn describe_root(root: &str) -> FolderRoot {
    // per-level mkdir, not recursive (createDirLevels): `is_usable_save_dir`
    // makes the missing levels and asks for write access, as the TypeScript's
    // two calls do
    let usable =
        is_usable_save_dir(root) && fs::metadata(namespaced(root)).is_ok_and(|meta| meta.is_dir());
    let name = basename(root, None);
    FolderRoot {
        path: root.to_owned(),
        name: if name.is_empty() {
            root.to_owned()
        } else {
            name
        },
        usable,
        readable: usable,
        removable: false,
    }
}

fn has_visible_subfolder(dir: &str) -> bool {
    read_dirents(dir).is_some_and(|dirents| {
        dirents
            .iter()
            .any(|d| d.kind == DirentKind::Directory && !is_hidden_entry(dir, &d.name, true))
    })
}

/// `FolderEntry`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FolderEntry {
    pub path: String,
    pub name: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: f64,
    #[serde(rename = "hasSubfolders")]
    pub has_subfolders: bool,
}

/// `FolderListing`; `missing` is left out unless the directory could not be read.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FolderListing {
    pub dir: String,
    pub folders: Vec<FolderEntry>,
    pub files: Vec<RecentEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing: Option<bool>,
}

/// `a.name.localeCompare(b.name, undefined, { numeric: true })`
static NUMERIC_COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    let mut preferences = CollatorPreferences::default();
    preferences.numeric_ordering = Some(CollationNumericOrdering::True);
    Collator::try_new(preferences, CollatorOptions::default()).expect("the compiled root collation")
});

pub fn list_folder(dir: &str, starred_paths: &HashSet<String>) -> FolderListing {
    let mut folders: Vec<FolderEntry> = Vec::new();
    let mut file_paths: Vec<String> = Vec::new();
    let Some(dirents) = read_dirents(dir) else {
        return FolderListing {
            dir: dir.to_owned(),
            folders: Vec::new(),
            files: Vec::new(),
            missing: Some(true),
        };
    };
    for d in &dirents {
        let path = join(&[dir, &d.name]);
        if d.kind == DirentKind::Directory {
            if is_hidden_entry(dir, &d.name, true) {
                continue;
            }
            let Ok(meta) = fs::metadata(namespaced(&path)) else {
                continue;
            };
            let mtime_ms = StatInfo::of(&meta).mtime_ms;
            let has_subfolders = has_visible_subfolder(&path);
            folders.push(FolderEntry {
                path,
                name: d.name.clone(),
                mtime_ms,
                has_subfolders,
            });
        } else if d.kind == DirentKind::File
            && !is_hidden_entry(dir, &d.name, false)
            && is_supported_tree_file(&d.name)
        {
            file_paths.push(path);
        }
    }
    folders.sort_by(|a, b| NUMERIC_COLLATOR.compare(&a.name, &b.name));
    let mut files: Vec<RecentEntry> = stat_path_entries(&file_paths, starred_paths)
        .into_iter()
        .filter(|e| !e.missing)
        .collect();
    sort_by_number(&mut files, |a, b| b.mtime_ms - a.mtime_ms);
    FolderListing {
        dir: dir.to_owned(),
        folders,
        files,
        missing: None,
    }
}

/// the candidates below `dir` at any depth; bookkeeping filters tracked paths instead of walking the disk
pub fn paths_under(dir: &str, candidates: &[String]) -> Vec<String> {
    let base = resolve(&[dir]);
    let prefix = with_trailing_sep(&base);
    let mut out: Vec<String> = Vec::new();
    for path in candidates {
        let resolved = resolve(&[path]);
        if resolved != base && resolved.starts_with(&prefix) && !out.contains(path) {
            out.push(path.clone());
        }
    }
    out
}

/// `FolderErrors`
#[derive(Debug, Clone, PartialEq)]
pub struct FolderErrors {
    pub bad_args: String,
    pub bad_name: String,
    pub missing: String,
    pub exists: String,
    pub failed: String,
}

/// `RenameResult` of `home-api.ts`: `ok`, then the path of a success or the
/// error of a failure.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RenameResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RenameResult {
    fn failed(error: &str) -> Self {
        RenameResult {
            ok: false,
            path: None,
            error: Some(error.to_owned()),
        }
    }

    fn succeeded(path: &str) -> Self {
        RenameResult {
            ok: true,
            path: Some(path.to_owned()),
            error: None,
        }
    }
}

pub fn create_folder(parent: &str, name: &str, errors: &FolderErrors) -> RenameResult {
    let trimmed = trim(name);
    if !is_valid_rename_name(trimmed) {
        return RenameResult::failed(&errors.bad_name);
    }
    if !exists_sync(parent) {
        return RenameResult::failed(&errors.missing);
    }
    let target = join(&[parent, trimmed]);
    if exists_sync(&target) {
        return RenameResult::failed(&errors.exists);
    }
    if let Err(err) = mkdir(&target) {
        return RenameResult::failed(&err.message);
    }
    RenameResult::succeeded(&target)
}

fn utf16_len(text: &str) -> f64 {
    text.encode_utf16().count() as f64
}

/// `name.ext` -> `name (2).ext`, `name (3).ext`... first free name inside dir.
/// A folder has no extension, so `is_dir` appends the counter to the whole name:
/// splitting `v1.0` would yield the mid-name `v1 (2).0`.
pub fn unique_name_in(dir: &str, name: &str, is_dir: bool) -> String {
    if !exists_sync(&join(&[dir, name])) {
        return name.to_owned();
    }
    let doc_ext = if is_dir {
        String::new()
    } else {
        document_extension(name)
    };
    // a draw.io picture keeps its double extension (`flow (2).drawio.svg`)
    let ext = if is_dir {
        String::new()
    } else if doc_ext.contains('.') {
        format!(".{}", slice_utf16(name, -utf16_len(&doc_ext), None))
    } else {
        extname(name)
    };
    let base = slice_utf16(name, 0.0, Some(utf16_len(name) - utf16_len(&ext)));
    let mut i: u64 = 2;
    loop {
        let candidate = format!("{base} ({i}){ext}");
        if !exists_sync(&join(&[dir, &candidate])) {
            return candidate;
        }
        i += 1;
    }
}

/// `cpSync(from, to, { recursive: true, errorOnExist: true, force: false })`
/// for what a move across volumes copies: files, folders and links.
fn cp_recursive(from: &str, to: &str) -> Result<(), NodeError> {
    cp_item(from, to, false)
}

/// One entry of [`cp_recursive`]; `nested` is an entry inside a copied folder,
/// whose "target exists" error Node words with its code in front.
fn cp_item(from: &str, to: &str, nested: bool) -> Result<(), NodeError> {
    let meta = fs::symlink_metadata(namespaced(from)).map_err(|e| node_error(&e, "lstat", from))?;
    let dest = fs::symlink_metadata(namespaced(to)).ok();
    let exists = |path: &str| NodeError {
        code: Some("ERR_FS_CP_EEXIST"),
        message: if nested {
            format!(
                "[ERR_FS_CP_EEXIST]: Target already exists: cp returned EEXIST ({path} already exists)"
            )
        } else {
            format!("Target already exists: cp returned EEXIST ({path} already exists) {path}")
        },
    };
    let kind = meta.file_type();
    if !kind.is_dir()
        && let Some(dest) = &dest
        && dest.is_dir()
    {
        return Err(NodeError {
            code: Some("ERR_FS_CP_NON_DIR_TO_DIR"),
            message: format!("Cannot overwrite directory {to} with non-directory {from}"),
        });
    }
    if kind.is_dir() {
        if let Some(dest) = &dest
            && !dest.is_dir()
        {
            return Err(NodeError {
                code: Some("ERR_FS_CP_DIR_TO_NON_DIR"),
                message: format!("Cannot overwrite non-directory {to} with directory {from}"),
            });
        }
        let parent = dirname(to);
        if !exists_sync(&parent) {
            fs::create_dir_all(namespaced(&parent))
                .map_err(|e| node_error(&e, "mkdir", &parent))?;
        }
        if dest.is_none() {
            mkdir(to)?;
        }
        for entry in read_dirents_unsorted(from).ok_or_else(|| NodeError {
            code: None,
            message: format!("cannot read {from}"),
        })? {
            cp_item(&join(&[from, &entry.name]), &join(&[to, &entry.name]), true)?;
        }
        return Ok(());
    }
    let parent = dirname(to);
    if !exists_sync(&parent) {
        fs::create_dir_all(namespaced(&parent)).map_err(|e| node_error(&e, "mkdir", &parent))?;
    }
    if dest.is_some() {
        return Err(exists(to));
    }
    if kind.is_symlink() {
        let target =
            fs::read_link(namespaced(from)).map_err(|e| node_error(&e, "readlink", from))?;
        let target = target.to_string_lossy().into_owned();
        let target = if jscompat::node_path::host::is_absolute(&target) {
            target
        } else {
            resolve(&[&dirname(from), &target])
        };
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, namespaced(to))
                .map_err(|e| node_error(&e, "symlink", &target))?;
        }
        #[cfg(windows)]
        {
            let result = if fs::metadata(&target).is_ok_and(|m| m.is_dir()) {
                std::os::windows::fs::symlink_dir(&target, namespaced(to))
            } else {
                std::os::windows::fs::symlink_file(&target, namespaced(to))
            };
            result.map_err(|e| node_error(&e, "symlink", &target))?;
        }
        return Ok(());
    }
    crate::node_fs::copy_file(from, to, true)
}

/// rename, falling back to copy + delete when the target is on another volume
pub fn move_on_disk(from: &str, to: &str) -> Result<(), NodeError> {
    move_on_disk_via(&rename, from, to)
}

/// [`move_on_disk`] with the rename the caller gives: a platform with no
/// cross-volume rename to try against is driven through it.
pub fn move_on_disk_via(
    rename_sync: &dyn Fn(&str, &str) -> Result<(), NodeError>,
    from: &str,
    to: &str,
) -> Result<(), NodeError> {
    match rename_sync(from, to) {
        Ok(()) => Ok(()),
        Err(err) => {
            if err.code != Some("EXDEV") {
                return Err(err);
            }
            cp_recursive(from, to)?;
            rm_recursive_force(from)
        }
    }
}

/// the displaced target of a 'replace' move: finalized once the move succeeded, put back if it failed
pub trait ReplacedItem {
    fn commit(&mut self) -> Result<(), Thrown>;
    fn rollback(&mut self) -> Result<(), Thrown>;
}

/// `MoveOptions`
pub trait MoveOptions {
    /// park an existing target out of the way before the move (policy 'replace')
    fn replace_existing(&mut self, path: &str) -> Result<Box<dyn ReplacedItem>, Thrown>;
}

/// `MoveConflictPolicy`: what to do when a moved item's name already exists in the target
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveConflictPolicy {
    Ask,
    Replace,
    KeepBoth,
    Skip,
}

impl MoveConflictPolicy {
    /// Any text but 'ask', 'skip' and 'keepBoth' takes the branch 'replace'
    /// takes, as the TypeScript's last `else` does.
    pub fn from_wire(text: &str) -> Self {
        match text {
            "ask" => MoveConflictPolicy::Ask,
            "skip" => MoveConflictPolicy::Skip,
            "keepBoth" => MoveConflictPolicy::KeepBoth,
            _ => MoveConflictPolicy::Replace,
        }
    }
}

/// `{ from, to }` of `MoveResult.moved`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Moved {
    pub from: String,
    pub to: String,
}

/// `{ path, error }` of `MoveResult.failed`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MoveFailure {
    pub path: String,
    pub error: String,
}

/// `MoveResult`
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct MoveResult {
    pub moved: Vec<Moved>,
    pub conflicts: Vec<String>,
    pub failed: Vec<MoveFailure>,
}

/// True when `dir` is `path` itself or somewhere below it (a folder cannot move into itself).
pub fn is_self_or_descendant(path: &str, dir: &str) -> bool {
    let a = resolve(&[path]);
    let b = resolve(&[dir]);
    a == b || b.starts_with(&with_trailing_sep(&a))
}

/// Move each path into `target_dir`. Returns what moved (old -> new) so the
/// caller can re-key recents, stars, chat history and open tabs. With policy
/// 'ask' nothing that collides moves; the collisions come back for the UI to
/// ask about and retry with an explicit policy. `Err` is a throw the
/// TypeScript does not catch: the `rollback` of a displaced target failing.
pub fn move_paths_into(
    paths: &[String],
    target_dir: &str,
    policy: MoveConflictPolicy,
    errors: &FolderErrors,
    options: &mut dyn MoveOptions,
) -> Result<MoveResult, Thrown> {
    let mut result = MoveResult::default();
    let failed_with = |thrown: Thrown| thrown.unwrap_or_else(|| errors.failed.clone());
    if !exists_sync(target_dir) {
        for p in paths {
            result.failed.push(MoveFailure {
                path: p.clone(),
                error: errors.missing.clone(),
            });
        }
        return Ok(result);
    }
    for from in paths {
        if !exists_sync(from) {
            result.failed.push(MoveFailure {
                path: from.clone(),
                error: errors.missing.clone(),
            });
            continue;
        }
        if dirname(&resolve(&[from])) == resolve(&[target_dir]) {
            continue;
        }
        let Ok(meta) = fs::metadata(namespaced(from)) else {
            result.failed.push(MoveFailure {
                path: from.clone(),
                error: errors.missing.clone(),
            });
            continue;
        };
        let is_dir = meta.is_dir();
        if is_dir && is_self_or_descendant(from, target_dir) {
            result.failed.push(MoveFailure {
                path: from.clone(),
                error: errors.bad_args.clone(),
            });
            continue;
        }
        let name = basename(from, None);
        let mut to = join(&[target_dir, &name]);
        let mut replaced: Option<Box<dyn ReplacedItem>> = None;
        if exists_sync(&to) {
            if policy == MoveConflictPolicy::Ask || policy == MoveConflictPolicy::Skip {
                result.conflicts.push(from.clone());
                continue;
            }
            if policy == MoveConflictPolicy::KeepBoth {
                to = join(&[target_dir, &unique_name_in(target_dir, &name, is_dir)]);
            } else {
                match options.replace_existing(&to) {
                    Ok(item) => replaced = Some(item),
                    Err(thrown) => {
                        result.failed.push(MoveFailure {
                            path: from.clone(),
                            error: failed_with(thrown),
                        });
                        continue;
                    }
                }
            }
        }
        let attempt = (|| -> Result<(), Thrown> {
            move_on_disk(from, &to).map_err(|e| Some(e.message))?;
            result.moved.push(Moved {
                from: from.clone(),
                to: to.clone(),
            });
            if let Some(item) = replaced.as_mut() {
                item.commit()?;
            }
            Ok(())
        })();
        if let Err(thrown) = attempt {
            // a failed move must leave the destination as it was
            if let Some(item) = replaced.as_mut() {
                item.rollback()?;
            }
            result.failed.push(MoveFailure {
                path: from.clone(),
                error: failed_with(thrown),
            });
        }
    }
    Ok(result)
}

pub fn rename_folder(dir: &str, new_name: &str, errors: &FolderErrors) -> RenameResult {
    let name = trim(new_name);
    if !is_valid_rename_name(name) {
        return RenameResult::failed(&errors.bad_name);
    }
    if !exists_sync(dir) {
        return RenameResult::failed(&errors.missing);
    }
    let target = join(&[&dirname(dir), name]);
    if target == dir {
        return RenameResult::succeeded(dir);
    }
    if exists_sync(&target) && !is_same_file(dir, &target) {
        return RenameResult::failed(&errors.exists);
    }
    if let Err(err) = rename(dir, &target) {
        return RenameResult::failed(&err.message);
    }
    RenameResult::succeeded(&target)
}

/// `oldPrefix/.../file` -> `newPrefix/.../file` for a file that lived under a renamed/moved folder
pub fn rebase_path(path: &str, old_dir: &str, new_dir: &str) -> String {
    let abs = resolve(&[path]);
    let base = resolve(&[old_dir]);
    // a bare prefix slice would also match a sibling like `/w/src2/f` under `/w/src`
    if abs != base && !abs.starts_with(&with_trailing_sep(&base)) {
        return path.to_owned();
    }
    join(&[new_dir, &abs[base.len()..]])
}

/// `WATCH_DEBOUNCE_MS`
pub const WATCH_DEBOUNCE_MS: u64 = 250;

/// Watches the root recursively and reports the folders whose direct
/// contents changed, debounced. Changes from Finder / Explorer / other apps
/// show up in the tree the same way as our own edits.
#[derive(Debug)]
pub struct FolderWatcher {
    root: String,
    active: bool,
    pending: Vec<String>,
    timer_armed: bool,
}

impl FolderWatcher {
    /// `watch_created` is whether the caller's `fs.watch(root, { recursive: true })` returned a handle.
    pub fn new(root: &str, watch_created: bool) -> Self {
        FolderWatcher {
            root: root.to_owned(),
            active: watch_created,
            pending: Vec::new(),
            timer_armed: false,
        }
    }

    /// false when the watch handle could not be created or has since errored
    pub fn active(&self) -> bool {
        self.active
    }

    /// One event of the watch handle (`filename` is `None` where Node gives
    /// `null`). The answer is the delay the caller restarts its timer with;
    /// whatever timer it had is cleared.
    pub fn note(&mut self, filename: Option<&str>) -> u64 {
        let rel = filename.unwrap_or("");
        let changed = if rel.is_empty() {
            self.root.clone()
        } else {
            join(&[&self.root, rel])
        };
        // a created/removed folder changes its parent's listing; a file inside
        // changes its own folder's listing - report both candidates
        self.add_pending(dirname(&changed));
        let is_dir = fs::metadata(namespaced(&changed)).is_ok_and(|meta| meta.is_dir());
        if is_dir {
            self.add_pending(changed);
        }
        self.timer_armed = true;
        WATCH_DEBOUNCE_MS
    }

    fn add_pending(&mut self, dir: String) {
        if !self.pending.contains(&dir) {
            self.pending.push(dir);
        }
    }

    /// The `'error'` event of the watch handle.
    pub fn on_error(&mut self) {
        self.close();
    }

    /// The debounce timer ran out: the folders to hand to `onChange`, `None`
    /// when no timer was armed.
    pub fn on_timer(&mut self) -> Option<Vec<String>> {
        if !self.timer_armed {
            return None;
        }
        self.timer_armed = false;
        Some(std::mem::take(&mut self.pending))
    }

    /// The caller clears its timer and closes its handle.
    pub fn close(&mut self) {
        self.timer_armed = false;
        self.active = false;
    }
}
