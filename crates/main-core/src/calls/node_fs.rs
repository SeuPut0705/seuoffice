//! The functions of group `node-fs` (tools/main-diff/groups/node-fs.ts): a few
//! raw file operations, each the std call Node's `fs` makes, answering with
//! the error Node would throw (`crate::node_fs`).
//!
//! On Windows the std call takes the path as libuv gets it from Node
//! (`namespaced`: `\\?\C:\...`, no Win32 normalisation), opens with backup
//! semantics as libuv's `fs__open` does (a folder opens), and renames with
//! `MoveFileExW` as `fs__rename` does (std's `rename` is a different call with
//! other errors). Where libuv names an error itself instead of passing the
//! system's (`fs__scandir` of a file: ENOTDIR; `fs__unlink` of a folder:
//! EPERM; `fs__open` of a folder with `O_CREAT`: EISDIR) the Windows
//! branches do the same check libuv does.

use super::{Answer, CallError, Context, str_arg};
use crate::node_fs::{
    NodeError, namespaced, node_error, node_error_fd, node_error_named, node_error2,
};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};

pub(super) fn call(name: &str, args: &[Value], _cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "node-fs.readFileSync" => str_arg(args, 0).and_then(read_file),
        "node-fs.writeFileSync" => str_arg(args, 0).and_then(|path| {
            let flag = str_arg(args, 1)?;
            let text = str_arg(args, 2)?;
            write_file(path, flag, text)
        }),
        "node-fs.mkdirSync" => str_arg(args, 0).and_then(|path| {
            fs::create_dir(namespaced(path))
                .map(|()| None)
                .map_err(|e| node_error(&e, "mkdir", path).into())
        }),
        "node-fs.rmdirSync" => str_arg(args, 0).and_then(rmdir),
        "node-fs.renameSync" => str_arg(args, 0).and_then(|from| {
            let to = str_arg(args, 1)?;
            rename(&namespaced(from), &namespaced(to))
                .map(|()| None)
                .map_err(|e| node_error2(&e, "rename", from, to).into())
        }),
        "node-fs.unlinkSync" => str_arg(args, 0).and_then(unlink),
        "node-fs.openSync" => str_arg(args, 0).and_then(|path| {
            open_options()
                .read(true)
                .write(true)
                .open(namespaced(path))
                .map(|_| None)
                .map_err(|e| node_error(&e, "open", path).into())
        }),
        "node-fs.readdirSync" => str_arg(args, 0).and_then(readdir),
        "node-fs.rmdirAsCwd" => str_arg(args, 0).and_then(|cwd| {
            let target = str_arg(args, 1)?;
            rmdir_as_cwd(cwd, target)
        }),
        "node-fs.readThroughLinks" => str_arg(args, 0).and_then(|dir| {
            let second = str_arg(args, 1)?;
            read_through_links(dir, second)
        }),
        _ => return None,
    })
}

fn fail(e: NodeError) -> CallError {
    e.into()
}

/// `OpenOptions` as libuv's `fs__open` opens: with backup semantics on
/// Windows, so that a folder opens (and `read` then fails on it, `O_CREAT`
/// on it says ERROR_FILE_EXISTS) instead of failing with access denied.
fn open_options() -> OpenOptions {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let mut options = OpenOptions::new();
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS);
        options
    }
    #[cfg(not(windows))]
    {
        OpenOptions::new()
    }
}

/// `fs.readFileSync(path, 'utf8')`: `open`, then `read`.
fn read_file(path: &str) -> Answer {
    let mut file = open_options()
        .read(true)
        .open(namespaced(path))
        .map_err(|e| fail(node_error(&e, "open", path)))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| fail(node_error_fd(&e, "read")))?;
    Ok(Some(Value::from(
        String::from_utf8_lossy(&bytes).into_owned(),
    )))
}

/// `fs.writeFileSync(path, text, { flag })` for the flags `w` and `wx`.
fn write_file(path: &str, flag: &str, text: &str) -> Answer {
    let mut options = open_options();
    options.write(true);
    match flag {
        "w" => options.create(true).truncate(true),
        "wx" => options.create_new(true),
        _ => return Err(CallError::plain(format!("unsupported flag: {flag}"))),
    };
    let mut file = options.open(namespaced(path)).map_err(|e| {
        // libuv's fs__open: ERROR_FILE_EXISTS under O_CREAT without O_EXCL
        // means the path is a folder
        if cfg!(windows) && flag == "w" && e.raw_os_error() == Some(80) {
            fail(node_error_named("EISDIR", "open", path))
        } else {
            fail(node_error(&e, "open", path))
        }
    })?;
    file.write_all(text.as_bytes())
        .map(|()| None)
        .map_err(|e| fail(node_error_fd(&e, "write")))
}

/// `fs.rmdirSync`
fn rmdir(path: &str) -> Answer {
    fs::remove_dir(namespaced(path))
        .map(|()| None)
        .map_err(|e| fail(node_error(&e, "rmdir", path)))
}

/// `fs.unlinkSync`: libuv's `fs__unlink` says EPERM for a folder on Windows.
fn unlink(path: &str) -> Answer {
    let full = namespaced(path);
    #[cfg(windows)]
    if fs::symlink_metadata(&full).is_ok_and(|m| m.is_dir()) {
        return Err(fail(node_error_named("EPERM", "unlink", path)));
    }
    fs::remove_file(full)
        .map(|()| None)
        .map_err(|e| fail(node_error(&e, "unlink", path)))
}

/// `fs.readdirSync(path)`, sorted: libuv's `fs__scandir` says ENOTDIR for a
/// file on Windows.
fn readdir(path: &str) -> Answer {
    let full = namespaced(path);
    #[cfg(windows)]
    if fs::metadata(&full).is_ok_and(|m| !m.is_dir()) {
        return Err(fail(node_error_named("ENOTDIR", "scandir", path)));
    }
    let entries = fs::read_dir(full).map_err(|e| fail(node_error(&e, "scandir", path)))?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| fail(node_error(&e, "scandir", path)))?;
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    Ok(Some(Value::from(names)))
}

/// libuv's `fs__rename`: `MoveFileExW` replacing an existing file
#[cfg(windows)]
fn rename(from: &str, to: &str) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_REPLACE_EXISTING, MoveFileExW};
    let wide = |path: &str| -> Vec<u16> {
        std::ffi::OsStr::new(path)
            .encode_wide()
            .chain(Some(0))
            .collect()
    };
    let (from, to) = (wide(from), wide(to));
    // SAFETY: both are NUL-terminated UTF-16 strings that outlive the call
    let moved = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING) };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn rename(from: &str, to: &str) -> io::Result<()> {
    fs::rename(from, to)
}

/// `process.chdir(cwd)`, `fs.rmdirSync(target)`, and the working folder back:
/// the process holds `cwd` open, which Windows refuses to remove (EBUSY).
fn rmdir_as_cwd(cwd: &str, target: &str) -> Answer {
    let before = std::env::current_dir().map_err(|e| fail(node_error(&e, "uv_cwd", "")))?;
    std::env::set_current_dir(cwd).map_err(|e| fail(node_error(&e, "chdir", cwd)))?;
    let answer = rmdir(target);
    std::env::set_current_dir(before)
        .map_err(|e| fail(node_error(&e, "chdir", "the working folder")))?;
    answer
}

/// Two links in `dir`, `a.lnk` to `b.lnk` and `b.lnk` to `a.lnk` (`second` is
/// "loop") or to `file.txt` (`second` is "file"); `readFileSync` of `a.lnk`;
/// the links removed. ELOOP on Unix, ERROR_CANT_RESOLVE_FILENAME on Windows,
/// for the loop.
fn read_through_links(dir: &str, second: &str) -> Answer {
    let a = format!("{dir}/a.lnk");
    let b = format!("{dir}/b.lnk");
    let end = match second {
        "loop" => a.clone(),
        "file" => format!("{dir}/file.txt"),
        _ => return Err(CallError::plain(format!("unsupported link end: {second}"))),
    };
    for (target, link) in [(&b, &a), (&end, &b)] {
        symlink(target, link).map_err(|e| fail(node_error2(&e, "symlink", target, link)))?;
    }
    let answer = read_file(&a);
    for link in [&a, &b] {
        // a link to a missing target is a file link on Windows
        fs::remove_file(namespaced(link)).map_err(|e| fail(node_error(&e, "unlink", link)))?;
    }
    answer
}

#[cfg(unix)]
fn symlink(target: &str, link: &str) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn symlink(target: &str, link: &str) -> io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}
