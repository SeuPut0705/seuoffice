//! `apps/shell/src/main/update-cache.ts`.

use std::fs;
use std::path::Path;

use jscompat::node_path::host::{basename, join};
use jscompat::{JsonValue, js_regex, json_parse, to_number};

use crate::node_fs::{code_of, node_error};

const PENDING_DIR: &str = "pending";
const UPDATE_INFO_FILE: &str = "update-info.json";
const BLOCK_MAP_FILE: &str = "current.blockmap";

/// `Log`: one call per line, the arguments in order.
pub type Log<'a> = &'a mut dyn FnMut(&[&str]);

/// `rmSync(file)` without options, as far as the reason it gives goes: a
/// folder is `ERR_FS_EISDIR`, any other error its errno name, else its text.
fn rm_sync(file: &str) -> Result<(), String> {
    let is_dir = fs::symlink_metadata(file).map(|m| m.is_dir());
    let result = match is_dir {
        Ok(true) => return Err("ERR_FS_EISDIR".to_string()),
        Ok(false) => fs::remove_file(file),
        Err(e) => Err(e),
    };
    result.map_err(|e| {
        code_of(&e)
            .map(str::to_string)
            .unwrap_or_else(|| format!("Error: {}", node_error(&e, "rm", file).message))
    })
}

/// `removed`
fn removed(dir: &str, name: &str, log: &mut dyn FnMut(&[&str])) -> bool {
    let file = join(&[dir, name]);
    if !Path::new(&file).exists() {
        return true;
    }
    match rm_sync(&file) {
        Ok(()) => {
            log(&["removed", name, "from the update cache"]);
            true
        }
        Err(reason) => {
            log(&["could not remove", name, "from the update cache:", &reason]);
            false
        }
    }
}

/// `downloadedFileName`
fn downloaded_file_name(pending_dir: &str) -> Option<String> {
    let bytes = fs::read(join(&[pending_dir, UPDATE_INFO_FILE])).ok()?;
    let info = json_parse(&String::from_utf8_lossy(&bytes)).ok()?;
    let file_name = match info.get("fileName").as_deref() {
        Some(JsonValue::String(s)) => s.clone(),
        _ => return None,
    };
    // a bare name only: the record is a file on disk, and what it names is removed
    if basename(&file_name, None) != file_name {
        return None;
    }
    Some(file_name)
}

/// `numbersOf`
fn numbers_of(m: Option<jscompat::JsMatch<'_>>) -> Option<[f64; 3]> {
    let m = m?;
    let n = |i: usize| to_number(m.get(i).unwrap_or(""));
    Some([n(1), n(2), n(3)])
}

/// `installedOrOlder`
fn installed_or_older(file_name: &str, running_version: &str) -> bool {
    let cached = numbers_of(js_regex!(r"-(\d+)\.(\d+)\.(\d+)(?=[-.])").exec(file_name));
    let running = numbers_of(js_regex!(r"^(\d+)\.(\d+)\.(\d+)").exec(running_version));
    let (Some(cached), Some(running)) = (cached, running) else {
        return false;
    };
    for i in 0..3 {
        if cached[i] != running[i] {
            return cached[i] < running[i];
        }
    }
    !running_version.contains('-')
}

/// `pruneUpdateCache`. The TypeScript wraps the body in a `catch` that logs
/// `the update cache was not cleared:`; nothing in the body can throw (every
/// file operation is guarded), so it has no counterpart here.
pub fn prune_update_cache(cache_dir: &str, running_version: &str, log: Log) -> bool {
    let pending_dir = join(&[cache_dir, PENDING_DIR]);
    let Some(file_name) = downloaded_file_name(&pending_dir) else {
        return true;
    };
    if !installed_or_older(&file_name, running_version) {
        return true;
    }
    // the record goes only with the file it names, so a failed removal is retried
    removed(&pending_dir, &file_name, log)
        && removed(&pending_dir, BLOCK_MAP_FILE, log)
        && removed(&pending_dir, UPDATE_INFO_FILE, log)
}
