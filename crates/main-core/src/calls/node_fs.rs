//! The functions of group `node-fs` (tools/main-diff/groups/node-fs.ts): a few
//! raw file operations, each the std call Node's `fs` makes, answering with
//! the error Node would throw (`crate::node_fs`).
//!
//! Where Node's libuv names an error itself instead of passing the system's
//! (a directory given to `rmdir`, `readdir` or `read` on Windows) the Windows
//! branches below do the same check libuv does.

use super::{Answer, CallError, Context, str_arg};
use crate::node_fs::{NodeError, node_error, node_error_fd, node_error_named, node_error2};
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
            fs::create_dir(path)
                .map(|()| None)
                .map_err(|e| node_error(&e, "mkdir", path).into())
        }),
        "node-fs.rmdirSync" => str_arg(args, 0).and_then(rmdir),
        "node-fs.renameSync" => str_arg(args, 0).and_then(|from| {
            let to = str_arg(args, 1)?;
            fs::rename(from, to)
                .map(|()| None)
                .map_err(|e| node_error2(&e, "rename", from, to).into())
        }),
        "node-fs.unlinkSync" => str_arg(args, 0).and_then(unlink),
        "node-fs.openSync" => str_arg(args, 0).and_then(|path| {
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .map(|_| None)
                .map_err(|e| node_error(&e, "open", path).into())
        }),
        "node-fs.readdirSync" => str_arg(args, 0).and_then(readdir),
        "node-fs.rmdirAsCwd" => str_arg(args, 0).and_then(rmdir_as_cwd),
        "node-fs.readThroughLoop" => str_arg(args, 0).and_then(read_through_loop),
        _ => return None,
    })
}

fn fail(e: NodeError) -> CallError {
    e.into()
}

/// `fs.readFileSync(path, 'utf8')`: `open`, then `read` (a directory opens on
/// Windows, libuv opening with backup semantics, and fails in the `read`).
fn read_file(path: &str) -> Answer {
    #[cfg(windows)]
    if fs::metadata(path).is_ok_and(|m| m.is_dir()) {
        // ERROR_INVALID_FUNCTION, which libuv names EISDIR
        return Err(fail(node_error_fd(
            &io::Error::from_raw_os_error(1),
            "read",
        )));
    }
    let mut file = fs::File::open(path).map_err(|e| fail(node_error(&e, "open", path)))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| fail(node_error_fd(&e, "read")))?;
    Ok(Some(Value::from(
        String::from_utf8_lossy(&bytes).into_owned(),
    )))
}

/// `fs.writeFileSync(path, text, { flag })` for the flags `w` and `wx`.
fn write_file(path: &str, flag: &str, text: &str) -> Answer {
    let mut options = OpenOptions::new();
    options.write(true);
    match flag {
        "w" => options.create(true).truncate(true),
        "wx" => options.create_new(true),
        _ => return Err(CallError::plain(format!("unsupported flag: {flag}"))),
    };
    let mut file = options.open(path).map_err(|e| {
        // libuv's fs__open: ERROR_FILE_EXISTS under O_CREAT without O_EXCL
        // means the path is a directory
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

/// `fs.rmdirSync`: libuv's `fs__rmdir` says ENOTDIR for a file on Windows.
fn rmdir(path: &str) -> Answer {
    #[cfg(windows)]
    if fs::symlink_metadata(path).is_ok_and(|m| !m.is_dir()) {
        return Err(fail(node_error_named("ENOTDIR", "rmdir", path)));
    }
    fs::remove_dir(path)
        .map(|()| None)
        .map_err(|e| fail(node_error(&e, "rmdir", path)))
}

/// `fs.unlinkSync`: libuv's `fs__unlink` says EPERM for a directory on Windows.
fn unlink(path: &str) -> Answer {
    #[cfg(windows)]
    if fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) {
        return Err(fail(node_error_named("EPERM", "unlink", path)));
    }
    fs::remove_file(path)
        .map(|()| None)
        .map_err(|e| fail(node_error(&e, "unlink", path)))
}

/// `fs.readdirSync(path)`, sorted: libuv's `fs__scandir` says ENOTDIR for a
/// file on Windows.
fn readdir(path: &str) -> Answer {
    #[cfg(windows)]
    if fs::metadata(path).is_ok_and(|m| !m.is_dir()) {
        return Err(fail(node_error_named("ENOTDIR", "scandir", path)));
    }
    let entries = fs::read_dir(path).map_err(|e| fail(node_error(&e, "scandir", path)))?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| fail(node_error(&e, "scandir", path)))?;
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    Ok(Some(Value::from(names)))
}

/// `process.chdir(path)`, `fs.rmdirSync(path)`, and the working folder back:
/// the process holds the folder open, which Windows refuses to remove (EBUSY).
fn rmdir_as_cwd(path: &str) -> Answer {
    let before = std::env::current_dir().map_err(|e| fail(node_error(&e, "uv_cwd", "")))?;
    std::env::set_current_dir(path).map_err(|e| fail(node_error(&e, "chdir", path)))?;
    let answer = rmdir(path);
    std::env::set_current_dir(before)
        .map_err(|e| fail(node_error(&e, "chdir", "the working folder")))?;
    answer
}

/// Two links that point at each other, `readFileSync` of the first, and the
/// links removed: ELOOP on Unix, ERROR_CANT_RESOLVE_FILENAME on Windows.
fn read_through_loop(dir: &str) -> Answer {
    let a = format!("{dir}/a.lnk");
    let b = format!("{dir}/b.lnk");
    for (target, link) in [(&b, &a), (&a, &b)] {
        symlink(target, link).map_err(|e| fail(node_error2(&e, "symlink", target, link)))?;
    }
    let answer = read_file(&a);
    for link in [&a, &b] {
        // a link to a missing target is a file link on Windows
        fs::remove_file(link).map_err(|e| fail(node_error(&e, "unlink", link)))?;
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
