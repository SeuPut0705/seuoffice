//! `apps/shell/src/main/file-index/scan.ts`: the walk that lists the files the
//! index keys on. A `Dirent` reports a symlinked directory as a link, not a
//! directory, so the walk does not follow it.

use std::fs;

use serde::Serialize;

use crate::node_fs::namespaced;
use crate::shell::folder_tree::{
    DirentKind, is_hidden_entry, is_supported_tree_file, read_dirents,
};
use crate::shell::recent_files::StatInfo;
use jscompat::node_path::host::join;

/// `ScannedFile`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScannedFile {
    pub path: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: f64,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: f64,
}

/// `ScanResult`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScanResult {
    pub files: Vec<ScannedFile>,
    /// the walk hit a budget, so `files` is not the full set under the root
    pub truncated: bool,
}

pub const SCAN_MAX_DEPTH: f64 = 32.0;
pub const SCAN_MAX_FILES: f64 = 200_000.0;

/// `limits` of `scanFiles`: a limit left out (`undefined`) is its default.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ScanLimits {
    pub max_depth: Option<f64>,
    pub max_files: Option<f64>,
}

struct Walk {
    max_depth: f64,
    max_files: f64,
    out: Vec<ScannedFile>,
    truncated: bool,
}

impl Walk {
    fn walk(&mut self, dir: &str, depth: u64) {
        if depth as f64 > self.max_depth {
            self.truncated = true;
            return;
        }
        let Some(dirents) = read_dirents(dir) else {
            return;
        };
        for ent in &dirents {
            if self.out.len() as f64 >= self.max_files {
                self.truncated = true;
                return;
            }
            let path = join(&[dir, &ent.name]);
            if ent.kind == DirentKind::Directory {
                if !is_hidden_entry(dir, &ent.name, true) {
                    self.walk(&path, depth + 1);
                }
            } else if ent.kind == DirentKind::File
                && is_supported_tree_file(&ent.name)
                && !is_hidden_entry(dir, &ent.name, false)
                && let Some(st) = stat_or_null(&path)
            {
                self.out.push(st);
            }
        }
    }
}

/// Every supported, visible file under `root` with the stat fields the index keys
/// on. Symlinked directories are not followed, and the walk is bounded by depth
/// and file count.
pub fn scan_files(root: &str, limits: &ScanLimits) -> ScanResult {
    let mut walk = Walk {
        max_depth: limits.max_depth.unwrap_or(SCAN_MAX_DEPTH),
        max_files: limits.max_files.unwrap_or(SCAN_MAX_FILES),
        out: Vec::new(),
        truncated: false,
    };
    walk.walk(root, 0);
    ScanResult {
        files: walk.out,
        truncated: walk.truncated,
    }
}

pub fn stat_or_null(path: &str) -> Option<ScannedFile> {
    let meta = fs::metadata(namespaced(path)).ok()?;
    if !meta.is_file() {
        return None;
    }
    let info = StatInfo::of(&meta);
    Some(ScannedFile {
        path: path.to_owned(),
        mtime_ms: info.mtime_ms,
        size_bytes: info.size as f64,
    })
}
