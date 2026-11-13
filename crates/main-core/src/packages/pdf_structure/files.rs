//! `packages/pdf-structure/src/store/files.ts`: the file primitives of the
//! result store, atomic whole-file JSON writes and reads that never throw.
//!
//! A write goes to a uniquely named temp file beside the target, is flushed,
//! then renamed over the target. Writers of one entry take turns through a
//! lock file beside it. The TypeScript's async functions are one synchronous
//! function each here, with the calls on the file system in the same order.
//! What the TypeScript takes from the process (`Date.now`, `Math.random`,
//! `randomBytes`, `process.pid`, `process.kill(pid, 0)`, the timers) comes in
//! through [`StoreEnv`], so a caller can give it a random source of its own;
//! the sleeps block the caller.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::time::Duration;

use jscompat::node_path::host::{basename, dirname, join};
use jscompat::{JsonValue, json_parse, json_stringify, math_min, number_to_string};

use super::StoreWriteError;
use crate::node_fs::{NodeError, namespaced, node_error, node_error2};
use crate::pdf::font_locate::Platform;

/// What the file primitives take from the process.
pub trait StoreEnv {
    /// `Date.now()`
    fn date_now(&mut self) -> f64;
    /// `await sleep(ms)`: blocks the caller
    fn sleep(&mut self, ms: f64);
    /// `Math.random()`
    fn random(&mut self) -> f64;
    /// `randomBytes(bytes).toString('hex')`
    fn random_hex(&mut self, bytes: usize) -> String;
    /// `process.pid`
    fn pid(&mut self) -> f64;
    /// `process.kill(pid, 0)` did not throw, or threw `EPERM`
    fn process_alive(&mut self, pid: f64) -> bool;
    /// `process.platform`
    fn platform(&mut self) -> Platform;
}

/// The process's own clock, timers, random source and ids.
pub struct SystemEnv;

impl StoreEnv for SystemEnv {
    fn date_now(&mut self) -> f64 {
        system_now_ms()
    }

    fn sleep(&mut self, ms: f64) {
        if ms > 0.0 {
            std::thread::sleep(Duration::from_secs_f64(ms / 1000.0));
        }
    }

    fn random(&mut self) -> f64 {
        jscompat::math_random()
    }

    fn random_hex(&mut self, bytes: usize) -> String {
        let mut hex = String::new();
        while hex.len() < bytes * 2 {
            hex.extend(jscompat::random_uuid().chars().filter(|c| *c != '-'));
        }
        hex.truncate(bytes * 2);
        hex
    }

    fn pid(&mut self) -> f64 {
        f64::from(std::process::id())
    }

    fn process_alive(&mut self, pid: f64) -> bool {
        process_alive(pid)
    }

    fn platform(&mut self) -> Platform {
        if cfg!(windows) {
            Platform::Win32
        } else if cfg!(target_os = "macos") {
            Platform::Darwin
        } else {
            Platform::Other
        }
    }
}

/// `Date.now()`
pub fn system_now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// `process.kill(pid, 0)`: Node throws for a `pid` that is not a 32-bit
/// integer, and then it is not alive; `EPERM` means it runs under another
/// account.
fn process_alive(pid: f64) -> bool {
    if pid.trunc() != pid || pid.abs() > f64::from(i32::MAX) {
        return false;
    }
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the process can be signalled
        let sent = unsafe { libc::kill(pid as libc::pid_t, 0) };
        sent == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        windows_process_alive(pid as i32)
    }
    #[cfg(not(any(unix, windows)))]
    {
        true
    }
}

/// libuv's `uv_kill(pid, 0)` on Windows: `OpenProcess` refused with
/// `ERROR_INVALID_PARAMETER` is `ESRCH` (no such process), any other refusal
/// (access denied) is an error that is not `ESRCH`, so the process counts as
/// alive; an opened process is alive while its exit code is `STILL_ACTIVE`.
#[cfg(windows)]
fn windows_process_alive(pid: i32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_SYNCHRONIZE,
        PROCESS_TERMINATE,
    };
    // SAFETY: plain Win32 calls; the handle is closed before returning
    unsafe {
        let handle = OpenProcess(
            PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid as u32,
        );
        if handle.is_null() {
            return GetLastError() != ERROR_INVALID_PARAMETER;
        }
        let mut status = 0u32;
        let read = GetExitCodeProcess(handle, &mut status);
        CloseHandle(handle);
        // a failed read is an error that is not ESRCH, as in libuv
        read == 0 || status == STILL_ACTIVE as u32
    }
}

/// temp and lock files start with a dot; listings skip them
pub fn is_temp_name(name: &str) -> bool {
    name.starts_with('.')
}

// Windows refuses a rename onto, or an open of, a file another process is
// replacing or has open
const RETRYABLE: [&str; 3] = ["EPERM", "EACCES", "EBUSY"];
const READ_ATTEMPTS: u32 = 4;
// a replace still refused after this is not a reader passing by
const REPLACE_BUDGET_MS: f64 = 5_000.0;
/// a lock this old belongs to a writer that died: a live one holds it for one replace
pub const LOCK_STALE_MS: f64 = 10_000.0;
const LOCK_WAIT_MS: f64 = 2.0 * LOCK_STALE_MS;
// how long a reader waits for a writer to rename the new entry into the freed name
const GAP_WAIT_MS: f64 = 1_000.0;
// cloud-sync folders and some filesystems refuse fsync; only durability suffers
const TOLERATED_SYNC: [&str; 6] = ["EPERM", "EACCES", "EBUSY", "EINVAL", "ENOSYS", "ENOTSUP"];

/// `codeOf(e)`: `e.code ?? ''`
fn code_of(error: &NodeError) -> &'static str {
    error.code.unwrap_or("")
}

fn retryable(error: &NodeError) -> bool {
    RETRYABLE.contains(&code_of(error))
}

/// the code of a refused fsync; node_fs has no name for `ENOSYS` and `ENOTSUP`
fn sync_code(e: &io::Error) -> &'static str {
    if let Some(code) = crate::node_fs::code_of(e) {
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

fn backoff(env: &mut dyn StoreEnv, attempt: u32) {
    let ms = math_min(5.0 * 2f64.powi(attempt as i32), 250.0) * (0.5 + env.random());
    env.sleep(ms);
}

fn lock_backoff(env: &mut dyn StoreEnv, attempt: u32) {
    let ms = math_min(2.0 * 2f64.powi(attempt as i32), 50.0) * (0.5 + env.random());
    env.sleep(ms);
}

/// `uniqueSuffix()`: `<pid>.<12 hex>`
fn unique_suffix(env: &mut dyn StoreEnv) -> String {
    let pid = env.pid();
    format!("{}.{}", number_to_string(pid), env.random_hex(6))
}

/// `lockPathOf(path)`: the write lock of an entry, a dot file beside it
pub fn lock_path_of(path: &str) -> String {
    join(&[&dirname(path), &format!(".{}.lock", basename(path, None))])
}

// ---- the calls on the file system, as Node words their errors ----

fn read_text(path: &str) -> Result<String, NodeError> {
    fs::read(namespaced(path))
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|e| node_error(&e, "open", path))
}

/// `stat(path).mtimeMs`
fn mtime_ms(path: &str) -> Result<f64, NodeError> {
    let meta = fs::metadata(namespaced(path)).map_err(|e| node_error(&e, "stat", path))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1e6)
    }
    #[cfg(not(unix))]
    {
        let modified = meta.modified().map_err(|e| node_error(&e, "stat", path))?;
        Ok(modified
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0))
    }
}

fn rename(from: &str, to: &str) -> Result<(), NodeError> {
    fs::rename(namespaced(from), namespaced(to)).map_err(|e| node_error2(&e, "rename", from, to))
}

fn unlink(path: &str) -> Result<(), NodeError> {
    fs::remove_file(namespaced(path)).map_err(|e| node_error(&e, "unlink", path))
}

// ---- writing ----

/// `writeJsonAtomic(path, value)`: the value, written whole and atomically.
/// A failure is a [`StoreWriteError`]; the entry that was there before is left
/// as it was.
pub fn write_json_atomic(
    env: &mut dyn StoreEnv,
    path: &str,
    value: &JsonValue,
) -> Result<(), StoreWriteError> {
    let data = json_stringify(value);
    let dir = dirname(path);
    let tmp = join(&[
        &dir,
        &format!(".{}.{}.tmp", basename(path, None), unique_suffix(env)),
    ]);
    let mut created = false;
    match stage_and_replace(env, path, &dir, &tmp, &data, &mut created) {
        Ok(()) => Ok(()),
        Err(error) => {
            if created {
                let _ = unlink(&tmp);
            }
            Err(StoreWriteError::new(path, error.code))
        }
    }
}

/// the `try` of `writeJsonAtomic`
fn stage_and_replace(
    env: &mut dyn StoreEnv,
    path: &str,
    dir: &str,
    tmp: &str,
    data: &str,
    created: &mut bool,
) -> Result<(), NodeError> {
    fs::create_dir_all(namespaced(dir)).map_err(|e| node_error(&e, "mkdir", dir))?;
    let mut handle = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(namespaced(tmp))
        .map_err(|e| node_error(&e, "open", tmp))?;
    *created = true;
    handle
        .write_all(data.as_bytes())
        .map_err(|e| node_error(&e, "write", tmp))?;
    if let Err(e) = handle.sync_all()
        && !TOLERATED_SYNC.contains(&sync_code(&e))
    {
        return Err(node_error(&e, "fsync", tmp));
    }
    drop(handle);
    let lock = acquire_lock(env, path)?;
    let replaced = replace_entry(env, tmp, path);
    release_lock(env, &lock);
    replaced
}

/// Put `tmp` in the place of `path`, holding the entry's lock. A refused
/// rename means the target is open somewhere: move it aside, rename into the
/// freed name, then delete the old entry (allowed while it is open).
fn replace_entry(env: &mut dyn StoreEnv, tmp: &str, path: &str) -> Result<(), NodeError> {
    let aside = format!("{}.old", &tmp[..tmp.len() - ".tmp".len()]);
    // the old entry is still at `aside` because putting it back failed
    let mut stranded = false;
    let deadline = env.date_now() + REPLACE_BUDGET_MS;
    let mut attempt: u32 = 0;
    loop {
        let mut error = match rename(tmp, path) {
            Ok(()) => {
                if stranded {
                    remove_quietly(env, &aside);
                }
                return Ok(());
            }
            Err(e) => Some(e),
        };
        if error.as_ref().is_some_and(retryable) {
            error = None;
            let mut moved = false;
            match rename(path, &aside) {
                Ok(()) => moved = true,
                Err(e) => {
                    if code_of(&e) != "ENOENT" {
                        error = Some(e);
                    }
                }
            }
            if error.is_none() {
                match rename(tmp, path) {
                    Ok(()) => {
                        if moved || stranded {
                            remove_quietly(env, &aside);
                        }
                        return Ok(());
                    }
                    Err(e) => {
                        error = Some(e);
                        // a reader should find the old entry rather than none
                        if moved {
                            stranded = rename(&aside, path).is_err();
                        }
                    }
                }
            }
        }
        if !error.as_ref().is_some_and(retryable) || env.date_now() >= deadline {
            if stranded {
                let _ = rename(&aside, path);
            }
            // `throw error`: `error` is set on every path that gets here
            return Err(error.unwrap_or(NodeError {
                code: None,
                message: String::new(),
            }));
        }
        backoff(env, attempt);
        attempt += 1;
    }
}

/// `EntryLock`
struct EntryLock {
    path: String,
    /// what this writer wrote into the lock file
    owner: String,
}

/// take the entry's write lock, breaking one left behind by a dead writer
fn acquire_lock(env: &mut dyn StoreEnv, path: &str) -> Result<EntryLock, NodeError> {
    let lock_path = lock_path_of(path);
    let owner = format!(
        "{{\"pid\":{},\"id\":\"{}\"}}",
        number_to_string(env.pid()),
        env.random_hex(6)
    );
    let deadline = env.date_now() + LOCK_WAIT_MS;
    let mut attempt: u32 = 0;
    loop {
        let handle = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(namespaced(&lock_path));
        let mut handle = match handle {
            Ok(handle) => handle,
            Err(e) => {
                let error = node_error(&e, "open", &lock_path);
                let code = code_of(&error);
                // EPERM/EACCES here: the previous lock is still being deleted
                if code != "EEXIST" && !retryable(&error) {
                    return Err(error);
                }
                if env.date_now() >= deadline {
                    return Err(error);
                }
                if code != "EEXIST" || !break_stale_lock(env, &lock_path) {
                    lock_backoff(env, attempt);
                }
                attempt += 1;
                continue;
            }
        };
        if let Err(e) = handle.write_all(owner.as_bytes()) {
            drop(handle);
            let _ = unlink(&lock_path);
            return Err(node_error(&e, "write", &lock_path));
        }
        drop(handle);
        return Ok(EntryLock {
            path: lock_path,
            owner,
        });
    }
}

fn release_lock(env: &mut dyn StoreEnv, lock: &EntryLock) {
    // a writer that judged this lock stale may own the file by now
    if read_text(&lock.path).ok().as_deref() == Some(lock.owner.as_str()) {
        remove_quietly(env, &lock.path);
    }
}

/// Move a dead writer's lock out of the way. True when the caller should try
/// to take the lock again at once.
fn break_stale_lock(env: &mut dyn StoreEnv, lock_path: &str) -> bool {
    let looked = read_text(lock_path).and_then(|seen| Ok((seen, mtime_ms(lock_path)?)));
    let (seen, modified_at) = match looked {
        Ok(looked) => looked,
        Err(e) => return code_of(&e) == "ENOENT",
    };
    if !is_stale_lock(env, &seen, modified_at) {
        return false;
    }
    // a rename moves one file once, so two writers cannot both break the same lock
    let grave = format!("{lock_path}.{}.stale", unique_suffix(env));
    if let Err(e) = rename(lock_path, &grave) {
        return code_of(&e) == "ENOENT";
    }
    if read_text(&grave).ok().as_deref() != Some(seen.as_str()) {
        // another writer took the lock between the look and the move: give it
        // back, without replacing a lock taken since (link refuses an existing name)
        let _ = fs::hard_link(namespaced(&grave), namespaced(lock_path));
    }
    remove_quietly(env, &grave);
    true
}

fn is_stale_lock(env: &mut dyn StoreEnv, content: &str, modified_at: f64) -> bool {
    if env.date_now() - modified_at > LOCK_STALE_MS {
        return true;
    }
    // created a moment ago and not filled in yet: not stale (`JSON.parse`
    // throws, and so does `.pid` of `null`)
    let Ok(parsed) = json_parse(content) else {
        return false;
    };
    if parsed == JsonValue::Null {
        return false;
    }
    let pid = parsed.get("pid");
    match pid.as_deref() {
        Some(JsonValue::Number(pid)) => *pid != env.pid() && !env.process_alive(*pid),
        _ => false,
    }
}

fn remove_quietly(env: &mut dyn StoreEnv, path: &str) {
    for attempt in 0..4 {
        match unlink(path) {
            Ok(()) => return,
            Err(e) => {
                if !retryable(&e) {
                    return;
                }
                backoff(env, attempt);
            }
        }
    }
}

/// a live writer holds the entry's lock, so a missing entry may be mid-replace
fn write_underway(env: &mut dyn StoreEnv, path: &str) -> bool {
    match mtime_ms(&lock_path_of(path)) {
        Ok(modified_at) => env.date_now() - modified_at <= LOCK_STALE_MS,
        Err(_) => false,
    }
}

// ---- reading ----

/// `readJson(path)`: parsed JSON, or `None` (`undefined`) when the file is
/// missing, unreadable or not JSON
pub fn read_json(env: &mut dyn StoreEnv, path: &str) -> Option<JsonValue> {
    let started = env.date_now();
    let mut looked_again = false;
    let mut refused: u32 = 0;
    loop {
        let code = match read_text(path) {
            // `JSON.parse` throws a SyntaxError, which has no code
            Ok(text) => match json_parse(&text) {
                Ok(value) => return Some(value),
                Err(_) => "",
            },
            Err(e) => code_of(&e),
        };
        // a file being replaced can refuse an open for a moment on Windows
        if RETRYABLE.contains(&code) && refused < READ_ATTEMPTS - 1 {
            backoff(env, refused);
            refused += 1;
            continue;
        }
        if code == "ENOENT" && env.date_now() - started < GAP_WAIT_MS {
            // a writer has moved the old entry aside and is renaming the new one in
            if write_underway(env, path) {
                looked_again = false;
                let ms = 1.0 + env.random() * 4.0;
                env.sleep(ms);
                continue;
            }
            // or it finished between the read and the lock check
            if !looked_again {
                looked_again = true;
                continue;
            }
        }
        return None;
    }
}

/// which entries `listNames` lists
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
}

/// `listNames(dir, kind)`: entry names of a folder in the order the system
/// lists them (libuv sorts them by name), temp files left out; empty when it
/// cannot be read
pub fn list_names(dir: &str, kind: EntryKind) -> Vec<String> {
    let Ok(entries) = fs::read_dir(namespaced(dir)) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for entry in entries {
        let Ok(entry) = entry else {
            return Vec::new();
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(file_type) = entry.file_type() else {
            return Vec::new();
        };
        let wanted = match kind {
            EntryKind::File => file_type.is_file(),
            EntryKind::Dir => file_type.is_dir(),
        };
        if !is_temp_name(&name) && wanted {
            names.push(name);
        }
    }
    names.sort();
    names
}

/// `folderSize(dir)`: byte total of every file below a folder; files that
/// vanish mid-walk count 0
pub fn folder_size(dir: &str) -> f64 {
    let Ok(entries) = fs::read_dir(namespaced(dir)) else {
        return 0.0;
    };
    let mut total = 0.0;
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let path = join(&[dir, &entry.file_name().to_string_lossy()]);
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            total += folder_size(&path);
        } else if file_type.is_file() {
            total += fs::metadata(namespaced(&path)).map_or(0.0, |m| m.len() as f64);
        }
    }
    total
}

/// `fileExists(path)`: a regular file is at `path`; false when it is missing
/// or cannot be looked at
pub fn file_exists(path: &str) -> bool {
    fs::metadata(namespaced(path)).is_ok_and(|m| m.is_file())
}

// ---- removing ----

/// `removeEntry(path)`: delete one entry, taking turns with its writers
/// through the entry lock. A missing entry is not an error; any other failure
/// is a [`StoreWriteError`].
pub fn remove_entry(env: &mut dyn StoreEnv, path: &str) -> Result<(), StoreWriteError> {
    let lock = match acquire_lock(env, path) {
        Ok(lock) => lock,
        Err(e) => return remove_failed(path, e),
    };
    let mut attempt: u32 = 0;
    let removed = loop {
        match unlink(path) {
            Ok(()) => break Ok(()),
            Err(e) => {
                let code = code_of(&e);
                if code == "ENOENT" {
                    break Ok(());
                }
                if !retryable(&e) || attempt >= READ_ATTEMPTS {
                    break Err(e);
                }
                backoff(env, attempt);
                attempt += 1;
            }
        }
    };
    release_lock(env, &lock);
    match removed {
        Ok(()) => Ok(()),
        Err(e) => remove_failed(path, e),
    }
}

/// the `catch` of `removeEntry`: the entry's folder does not exist, so there
/// is nothing to delete
fn remove_failed(path: &str, error: NodeError) -> Result<(), StoreWriteError> {
    if code_of(&error) == "ENOENT" {
        return Ok(());
    }
    Err(StoreWriteError::new(path, error.code))
}

/// the codes `rm` retries on
const RM_RETRY: [&str; 5] = ["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"];

/// `removeFolder(dir)`: `rm(dir, { recursive: true, force: true, maxRetries:
/// 5, retryDelay: 50 })`; a failure is a [`StoreWriteError`]
pub fn remove_folder(env: &mut dyn StoreEnv, dir: &str) -> Result<(), StoreWriteError> {
    let mut attempt: u32 = 0;
    loop {
        let removed = match fs::symlink_metadata(namespaced(dir)) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
            Ok(meta) if meta.is_dir() => fs::remove_dir_all(namespaced(dir)),
            Ok(_) => fs::remove_file(namespaced(dir)),
        };
        match removed {
            Ok(()) => return Ok(()),
            Err(e) => {
                let error = node_error(&e, "rm", dir);
                if RM_RETRY.contains(&code_of(&error)) && attempt < 5 {
                    attempt += 1;
                    env.sleep(50.0 * f64::from(attempt));
                    continue;
                }
                return Err(StoreWriteError::new(dir, error.code));
            }
        }
    }
}
