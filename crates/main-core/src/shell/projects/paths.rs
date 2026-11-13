//! `apps/shell/src/main/projects/paths.ts`: path rules of the project guide.
//! Every path the guide stores or compares is canonical by the same rule as
//! project-store's `canonicalPathKey` (the real path, NFC), and comparisons
//! ignore case where the file system does.
//!
//! `pathApi(platform)` answers `win32` or `posix` of `node:path`; [`PathApi`]
//! is that choice with the functions the guide calls.

use jscompat::node_path::{ParsedPath, host, posix, win32};

use crate::node_fs::namespaced;
use crate::packages::project_store::{FolderRefusalReason, canonical_path_key, nfc};
use crate::shell::agent::agent_sessions::agent_protected_paths;

/// `typeof win32`: the `node:path` flavour `pathApi(platform)` answers
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathApi {
    Win32,
    Posix,
}

impl PathApi {
    /// `api.sep`
    pub fn sep(self) -> &'static str {
        match self {
            Self::Win32 => win32::SEP,
            Self::Posix => posix::SEP,
        }
    }

    /// `api.normalize(path)`
    pub fn normalize(self, path: &str) -> String {
        match self {
            Self::Win32 => win32::normalize(path),
            Self::Posix => posix::normalize(path),
        }
    }

    /// `api.isAbsolute(path)`
    pub fn is_absolute(self, path: &str) -> bool {
        match self {
            Self::Win32 => win32::is_absolute(path),
            Self::Posix => posix::is_absolute(path),
        }
    }

    /// `api.relative(from, to)`
    pub fn relative(self, from: &str, to: &str) -> String {
        match self {
            Self::Win32 => win32::relative(from, to),
            Self::Posix => posix::relative(from, to),
        }
    }

    /// `api.dirname(path)`
    pub fn dirname(self, path: &str) -> String {
        match self {
            Self::Win32 => win32::dirname(path),
            Self::Posix => posix::dirname(path),
        }
    }

    /// `api.parse(path)`
    pub fn parse(self, path: &str) -> ParsedPath {
        match self {
            Self::Win32 => win32::parse(path),
            Self::Posix => posix::parse(path),
        }
    }
}

/// `pathApi(platform)`
pub fn path_api(platform: &str) -> PathApi {
    if platform == "win32" {
        PathApi::Win32
    } else {
        PathApi::Posix
    }
}

/// `canonicalPath(path)`: the one key a folder or document is stored under
/// (same rule as project-store)
pub fn canonical_path(path: &str) -> String {
    canonical_path_key(path)
}

/// `foldsCase(platform)`
fn folds_case(platform: &str) -> bool {
    platform == "win32" || platform == "darwin"
}

/// `comparablePath(path, platform)`: normalized, NFC, without trailing
/// separators (except a root), case-folded where needed
pub fn comparable_path(path: &str, platform: &str) -> String {
    let api = path_api(platform);
    let mut normalized = nfc(&api.normalize(path));
    let root = api.parse(&normalized).root;
    let root_length = root.encode_utf16().count();
    // the last unit is a separator, so one `pop` is one `slice(0, -1)`
    while normalized.encode_utf16().count() > root_length && normalized.ends_with(['\\', '/']) {
        normalized.pop();
    }
    if folds_case(platform) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

/// `isPlainSegment(segment)`: one path segment as a person or the app could
/// name it inside the folder: not empty, `.` or `..`, no control characters
/// or `:` (a drive or an NTFS stream), and no trailing dot or space (Windows
/// drops those, so such a name could stand for another entry).
pub fn is_plain_segment(segment: &str) -> bool {
    if segment.is_empty() || segment == "." || segment == ".." {
        return false;
    }
    if segment.chars().any(|c| c <= '\u{1f}' || c == ':') {
        return false;
    }
    !segment.ends_with('.') && !segment.ends_with(' ')
}

/// `samePath(a, b, platform)`
pub fn same_path(a: &str, b: &str, platform: &str) -> bool {
    comparable_path(a, platform) == comparable_path(b, platform)
}

/// `isInsideFolder(child, root, platform)`: `child` is `root` itself or
/// somewhere below it
pub fn is_inside_folder(child: &str, root: &str, platform: &str) -> bool {
    let c = comparable_path(child, platform);
    let r = comparable_path(root, platform);
    if c == r {
        return true;
    }
    let sep = path_api(platform).sep();
    if r.ends_with(sep) {
        c.starts_with(&r)
    } else {
        c.starts_with(&format!("{r}{sep}"))
    }
}

/// `leavesRoot(rel, platform)`: `rel` (from `relative`) leads out of its
/// root: a whole `..` step, or on Windows another drive or share. A name that
/// merely starts with dots (`..x`, `...`) is below the root.
fn leaves_root(rel: &str, platform: &str) -> bool {
    let api = path_api(platform);
    rel == ".."
        || rel.starts_with(&format!("..{}", api.sep()))
        || (platform == "win32" && rel.starts_with("../"))
        || api.is_absolute(rel)
}

/// `relativeInside(root, child, platform)`: `child` relative to `root`,
/// `/`-separated, or `None` (`null`) when it is not strictly inside. The
/// spelling of `child` is kept (only the root prefix is dropped).
pub fn relative_inside(root: &str, child: &str, platform: &str) -> Option<String> {
    if !is_inside_folder(child, root, platform) || same_path(child, root, platform) {
        return None;
    }
    let api = path_api(platform);
    let rel = api.relative(&api.normalize(root), &api.normalize(child));
    if rel.is_empty() || leaves_root(&rel, platform) {
        return None;
    }
    Some(nfc(&rel.split(api.sep()).collect::<Vec<_>>().join("/")))
}

/// `RefusalContext`
#[derive(Debug, Clone, PartialEq)]
pub struct RefusalContext {
    pub home_dir: String,
    pub user_data: String,
    pub platform: String,
}

/// `folderRefusal(folder, ctx)`: why a folder cannot become a project, or
/// `None` (`null`) when it can (spec 5.1). `folder` is the canonical path.
/// Same refusals as an agent-mode project folder: a whole drive, the whole
/// user folder, a protected folder (`agentProtectedPaths`) or a folder holding
/// one. The user folder counts as holding itself, so a folder above it is
/// refused too.
pub fn folder_refusal(folder: &str, ctx: &RefusalContext) -> Option<FolderRefusalReason> {
    if folder.is_empty() || !host::is_absolute(folder) {
        return Some(FolderRefusalReason::NotAFolder);
    }
    match std::fs::metadata(namespaced(folder)) {
        Ok(info) if info.is_dir() => {}
        _ => return Some(FolderRefusalReason::NotAFolder),
    }
    location_refusal(folder, ctx)
}

/// `locationRefusal(folder, ctx)`: the location rules of `folderRefusal`
/// alone, for a folder that does not exist yet
pub fn location_refusal(folder: &str, ctx: &RefusalContext) -> Option<FolderRefusalReason> {
    let platform = ctx.platform.as_str();
    if folder.is_empty() || !host::is_absolute(folder) {
        return Some(FolderRefusalReason::NotAFolder);
    }
    let api = path_api(platform);
    if same_path(folder, &api.parse(&api.normalize(folder)).root, platform) {
        return Some(FolderRefusalReason::DriveRoot);
    }
    let home = canonical_path_key(&ctx.home_dir);
    if same_path(folder, &home, platform) {
        return Some(FolderRefusalReason::UserHome);
    }
    let guarded: Vec<String> = agent_protected_paths(&home, &canonical_path_key(&ctx.user_data))
        .iter()
        .map(|path| canonical_path_key(path))
        .collect();
    for guard in &guarded {
        if is_inside_folder(folder, guard, platform) {
            return Some(FolderRefusalReason::Protected);
        }
    }
    for guard in guarded.iter().map(String::as_str).chain([home.as_str()]) {
        if is_inside_folder(guard, folder, platform) {
            return Some(FolderRefusalReason::ContainsProtected);
        }
    }
    None
}
