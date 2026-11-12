//! `packages/electron-utils/src/atomic-write.ts`.
//!
//! The TypeScript's async functions are one synchronous function each here;
//! the order of the calls on the file system is the same. The retry sleeps
//! block the caller, as `writeJsonAtomic`'s do.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::time::Duration;

use jscompat::node_path::host::{basename, dirname, join};
use jscompat::{JsonValue, js_regex, json_stringify_pretty, random_uuid};

use crate::node_fs::{NodeError, code_of, node_error, node_error2};

/// Transient Windows codes: antivirus/indexer briefly locks the rename target.
const RETRYABLE_RENAME_CODES: &[&str] = &["EPERM", "EACCES", "EBUSY"];
const RENAME_RETRY_DELAYS_MS: [u64; 4] = [50, 100, 200, 400];

/// Codes a refused fsync may surface with inside cloud-sync folders, under AV
/// locks or on filesystems without fsync.
const TOLERATED_SYNC_CODES: &[&str] = &["EPERM", "EACCES", "EBUSY", "EINVAL", "ENOSYS", "ENOTSUP"];

/// `error.code ?? ''` of a Node error.
fn error_code(error: &NodeError) -> &'static str {
    error.code.unwrap_or("")
}

fn is_retryable_rename(error: &NodeError) -> bool {
    RETRYABLE_RENAME_CODES.contains(&error_code(error))
}

/// The code of a refused open or fsync. node_fs has no name for `ENOSYS` and
/// `ENOTSUP`, which the tolerated set holds.
fn sync_code(e: &io::Error) -> &'static str {
    if let Some(code) = code_of(e) {
        return code;
    }
    #[cfg(unix)]
    match e.raw_os_error() {
        Some(libc::ENOSYS) => return "ENOSYS",
        Some(libc::ENOTSUP) => return "ENOTSUP",
        _ => {}
    }
    ""
}

fn sleep_sync(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

/// Most bytes of the target's name a temp name carries. The temp name adds
/// `.` + 12 hex + `.tmp` (17 bytes) and Linux and macOS cap a file name
/// at 255 bytes.
const TEMP_NAME_MAX_BYTES: usize = 200;

/// `name` cut to at most `max_bytes` of UTF-8, never inside a character
fn name_head(name: &str, max_bytes: usize) -> &str {
    if name.len() <= max_bytes {
        return name;
    }
    let mut bytes = 0;
    for (at, ch) in name.char_indices() {
        bytes += ch.len_utf8();
        if bytes > max_bytes {
            return &name[..at];
        }
    }
    name
}

/// random bytes in a staging temp's name (written as twice as many hex digits)
const TEMP_RANDOM_BYTES: usize = 6;
const TEMP_EXT: &str = "tmp";
/// what the rescue copy carries where a staging temp has its random part
const RESCUE_MARK: &str = "unsaved";

/// Whether a file name is one a save can put beside a document: the staging
/// temp or the rescue copy.
pub fn is_save_temp_name(name: &str) -> bool {
    // `^.+\.(?:[0-9a-f]{TEMP_RANDOM_BYTES * 2}|RESCUE_MARK)\.TEMP_EXT$`, flag i
    js_regex!(r"^.+\.(?:[0-9a-f]{12}|unsaved)\.tmp$", "i").test(name)
}

/// a fresh `<name>.<12 hex>.tmp` path in the target's folder (a long name is cut short).
pub fn temp_path_beside(file_path: &str) -> String {
    // the first 12 digits of a UUID are 6 random bytes written as hex
    let random: String = random_uuid()
        .chars()
        .filter(|c| *c != '-')
        .take(TEMP_RANDOM_BYTES * 2)
        .collect();
    join(&[
        &dirname(file_path),
        &format!(
            "{}.{random}.{TEMP_EXT}",
            name_head(&basename(file_path, None), TEMP_NAME_MAX_BYTES)
        ),
    ])
}

/// Where a failed save parks the new bytes: beside the target, under ONE
/// stable name.
fn rescue_path_for(file_path: &str) -> String {
    join(&[
        &dirname(file_path),
        &format!(
            "{}.{RESCUE_MARK}.{TEMP_EXT}",
            name_head(&basename(file_path, None), TEMP_NAME_MAX_BYTES)
        ),
    ])
}

/// Park the new bytes beside the target, replacing the copy an earlier failed
/// attempt left. If the copy does not land, the staging temp still holds the
/// bytes.
fn keep_rescue_copy(file_path: &str, tmp: &str) {
    if fs::copy(tmp, rescue_path_for(file_path)).is_err() {
        return;
    }
    let _ = fs::remove_file(tmp);
}

/// The save landed: an earlier attempt's rescue copy is stale.
fn clear_rescue_copy(file_path: &str) {
    let _ = fs::remove_file(rescue_path_for(file_path));
}

fn sync_file_best_effort(path: &str) -> Result<(), NodeError> {
    let file = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(e) => {
            if TOLERATED_SYNC_CODES.contains(&sync_code(&e)) {
                return Ok(());
            }
            return Err(node_error(&e, "open", path));
        }
    };
    match file.sync_all() {
        Ok(()) => Ok(()),
        Err(e) if TOLERATED_SYNC_CODES.contains(&sync_code(&e)) => Ok(()),
        Err(e) => Err(node_error(&e, "fsync", path)),
    }
}

fn rename_with_retry(tmp: &str, file_path: &str) -> Result<(), NodeError> {
    let mut attempt = 0;
    loop {
        match fs::rename(tmp, file_path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let error = node_error2(&e, "rename", tmp, file_path);
                if !is_retryable_rename(&error) || attempt >= RENAME_RETRY_DELAYS_MS.len() {
                    return Err(error);
                }
                sleep_sync(RENAME_RETRY_DELAYS_MS[attempt]);
                attempt += 1;
            }
        }
    }
}

/// `writeFile(path, data)`
fn write_file(path: &str, data: &[u8]) -> Result<(), NodeError> {
    let mut file = fs::File::create(path).map_err(|e| node_error(&e, "open", path))?;
    file.write_all(data)
        .map_err(|e| node_error(&e, "write", path))
}

/// `copyFile(from, to)`
fn copy_file(from: &str, to: &str) -> Result<(), NodeError> {
    fs::copy(from, to)
        .map(|_| ())
        .map_err(|e| node_error2(&e, "copyfile", from, to))
}

/// Same-dir temp file, best-effort fsync, then rename. Rename-over-existing fails
/// transiently on Windows (Defender/indexer locks: retry) and permanently on some
/// network mounts; either way the save falls back to an in-place write rather
/// than failing.
pub fn atomic_write_file(file_path: &str, data: &[u8]) -> Result<(), NodeError> {
    let tmp = temp_path_beside(file_path);
    if let Err(error) = write_file(&tmp, data).and_then(|()| sync_file_best_effort(&tmp)) {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    if rename_with_retry(&tmp, file_path).is_ok() {
        clear_rescue_copy(file_path);
        return Ok(());
    }
    // fall through to the in-place write: keep the completed temp until it lands
    if let Err(error) = write_file(file_path, data) {
        keep_rescue_copy(file_path, &tmp);
        return Err(error);
    }
    let _ = fs::remove_file(&tmp);
    clear_rescue_copy(file_path);
    Ok(())
}

/// copyFile stays in the kernel, so a multi-hundred-MB file is never read into RAM
pub fn atomic_copy_file(source: &str, file_path: &str) -> Result<(), NodeError> {
    let tmp = temp_path_beside(file_path);
    if let Err(error) = copy_file(source, &tmp).and_then(|()| sync_file_best_effort(&tmp)) {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    if rename_with_retry(&tmp, file_path).is_ok() {
        clear_rescue_copy(file_path);
        return Ok(());
    }
    // keep the completed temp until the fallback lands, as atomic_write_file does
    if let Err(error) = copy_file(source, file_path) {
        keep_rescue_copy(file_path, &tmp);
        return Err(error);
    }
    let _ = fs::remove_file(&tmp);
    clear_rescue_copy(file_path);
    Ok(())
}

/// Put a finished temp file (one a caller streamed to `temp_path_beside(file_path)`)
/// in place of `file_path`, with `atomic_write_file`'s flush, rename retry and
/// in-place fallback. The temp file is gone afterwards, whether this returns
/// `Ok` or `Err`, except when the in-place fallback itself fails.
pub fn atomic_move_file(temp_path: &str, file_path: &str) -> Result<(), NodeError> {
    if let Err(error) = sync_file_best_effort(temp_path) {
        let _ = fs::remove_file(temp_path);
        return Err(error);
    }
    if rename_with_retry(temp_path, file_path).is_ok() {
        return Ok(());
    }
    // fall through to the in-place write
    copy_file(temp_path, file_path)?;
    let _ = fs::remove_file(temp_path);
    Ok(())
}

/// The same contract for output that is produced by a writer: `write` fills
/// the sibling temp path, and only a temp that `write` completed is synced
/// and renamed over the target. A writer that fails part-way leaves the
/// target untouched.
pub fn atomic_write_via(
    file_path: &str,
    write: &mut dyn FnMut(&str) -> Result<(), NodeError>,
) -> Result<(), NodeError> {
    let tmp = temp_path_beside(file_path);
    if let Err(error) = write(&tmp).and_then(|()| sync_file_best_effort(&tmp)) {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    if rename_with_retry(&tmp, file_path).is_ok() {
        clear_rescue_copy(file_path);
        return Ok(());
    }
    // fall through to the in-place copy: keep the completed temp until it lands
    if let Err(error) = copy_file(&tmp, file_path) {
        keep_rescue_copy(file_path, &tmp);
        return Err(error);
    }
    let _ = fs::remove_file(&tmp);
    clear_rescue_copy(file_path);
    Ok(())
}

/// Atomic replacement for small userData JSON state files (recents, stars, AI
/// settings): `JSON.stringify(value, null, 2)`. Same retry + in-place
/// fallback as `atomic_write_file`; the retry sleeps block the caller.
pub fn write_json_atomic(file_path: &str, value: &JsonValue) -> Result<(), NodeError> {
    let dir = dirname(file_path);
    fs::create_dir_all(&dir).map_err(|e| node_error(&e, "mkdir", &dir))?;
    let json = json_stringify_pretty(value, 2);
    let tmp = temp_path_beside(file_path);
    let remove_temp = || {
        // temp never created
        let _ = fs::remove_file(&tmp);
    };
    let staged = (|| -> Result<(), NodeError> {
        // writeFileSync(tmp, json, { encoding: 'utf8', flag: 'wx' })
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| node_error(&e, "open", &tmp))?;
        file.write_all(json.as_bytes())
            .map_err(|e| node_error(&e, "write", &tmp))?;
        drop(file);
        sync_file_best_effort(&tmp)?;
        let mut attempt = 0;
        loop {
            match fs::rename(&tmp, file_path) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    let error = node_error2(&e, "rename", &tmp, file_path);
                    if !is_retryable_rename(&error) || attempt >= RENAME_RETRY_DELAYS_MS.len() {
                        return Err(error);
                    }
                    sleep_sync(RENAME_RETRY_DELAYS_MS[attempt]);
                    attempt += 1;
                }
            }
        }
    })();
    match staged {
        Ok(()) => Ok(()),
        Err(error) if is_retryable_rename(&error) => {
            write_file(file_path, json.as_bytes())?;
            remove_temp();
            Ok(())
        }
        Err(error) => {
            remove_temp();
            Err(error)
        }
    }
}
