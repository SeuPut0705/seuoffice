//! `apps/sheets/src/main/temp-files.ts`.

use std::fs;

use jscompat::node_path::host::{basename, dirname, join, resolve};
use jscompat::{JsRegex, js_regex};

use crate::shell::recent_files::StatInfo;

pub const PASTED_FILE_TTL_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;

fn session_snapshot_name() -> &'static JsRegex {
    js_regex!(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.xlsx$",
        "i"
    )
}

fn import_directory_name() -> &'static JsRegex {
    js_regex!(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        "i"
    )
}

fn owned_pasted_file() -> &'static JsRegex {
    js_regex!(
        r"^pasted-[0-9]{8}-[0-9]{6}-[0-9]+\.(?:png|jpe?g|gif|webp)$",
        "i"
    )
}

/// `SessionTemporaryResources`
pub struct SessionTemporaryResources<'a> {
    pub snapshot_path: &'a str,
    pub import_temp_dir: Option<&'a str>,
}

fn is_direct_owned_child(path: &str, parent: &str, name_pattern: &JsRegex) -> bool {
    let resolved_path = resolve(&[path]);
    dirname(&resolved_path) == resolve(&[parent])
        && name_pattern.test(&basename(&resolved_path, None))
}

/// `rm(path, { force: true })` on a path: a folder is refused (swallowed by
/// the caller), a missing path is fine
fn rm_force(path: &str) {
    let _ = fs::remove_file(path);
}

/// `rm(path, { recursive: true, force: true })`: a link is removed itself
fn rm_recursive_force(path: &str) {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => {
            let _ = fs::remove_dir_all(path);
        }
        Ok(_) => {
            let _ = fs::remove_file(path);
        }
        Err(_) => {}
    }
}

/// Close the sidecar first, remove its snapshot second, then remove a converted
/// CSV/XLS directory. Every deletion is constrained to an app-owned temp root
/// and file name shape. `close_sidecar` answers whether it settled; a
/// rejection (or a throw) is swallowed.
pub fn cleanup_session_resources(
    resources: &SessionTemporaryResources<'_>,
    temp_root: &str,
    close_sidecar: impl FnOnce() -> Result<(), ()>,
) {
    let _ = close_sidecar();
    let snapshot_root = join(&[temp_root, "seuoffice-sheets-sessions"]);
    if is_direct_owned_child(
        resources.snapshot_path,
        &snapshot_root,
        session_snapshot_name(),
    ) {
        rm_force(resources.snapshot_path);
    }
    if let Some(import_temp_dir) = resources.import_temp_dir {
        cleanup_import_temp_directory(temp_root, import_temp_dir);
    }
}

pub fn cleanup_import_temp_directory(temp_root: &str, import_temp_dir: &str) {
    let import_root = join(&[temp_root, "seuoffice-imports"]);
    if !is_direct_owned_child(import_temp_dir, &import_root, import_directory_name()) {
        return;
    }
    rm_recursive_force(import_temp_dir);
}

/// Remove only old regular files created by savePastedImage. Arbitrary files,
/// directories, symlinks, and even similarly named nested paths are untouched.
/// `now_ms` is `Date.now()`; the removed paths come back in the order libuv
/// lists the folder (by bytes).
pub fn cleanup_expired_pasted_files(temp_root: &str, now_ms: f64) -> Vec<String> {
    let dir = join(&[temp_root, "seuoffice-pasted"]);
    let cutoff = now_ms - PASTED_FILE_TTL_MS;
    let mut removed = Vec::new();
    let Ok(read) = fs::read_dir(&dir) else {
        return removed;
    };
    // `readdir` lists the names sorted by bytes
    let mut entries: Vec<(String, bool)> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_owned();
            let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
            Some((name, is_file))
        })
        .collect();
    entries.sort();
    for (name, is_file) in entries {
        if !is_file || !owned_pasted_file().test(&name) {
            continue;
        }
        let path = join(&[&dir, &name]);
        let Ok(info) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !info.is_file() || StatInfo::of(&info).mtime_ms >= cutoff {
            continue;
        }
        if fs::remove_file(&path).is_err() {
            continue;
        }
        removed.push(path);
    }
    removed
}
