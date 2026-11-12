//! Node's view of a failed file operation: the `code` of its error (`ENOENT`)
//! and the `message` it prints (`ENOENT: no such file or directory, open
//! '/x'`). Node takes both from libuv, which names the errno of the platform
//! (Unix) or maps the Windows error to one; this module does the same.

use std::io;

/// A Node file error as the TypeScript sees it: `err.code` and `err.message`.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeError {
    /// `None` where libuv has no name for the error (Node then says `UNKNOWN`
    /// in the message and leaves `code` as that too; see [`code_of`])
    pub code: Option<&'static str>,
    pub message: String,
}

/// libuv's name and text of each error the main process meets.
const ERRORS: &[(&str, &str)] = &[
    ("E2BIG", "argument list too long"),
    ("EACCES", "permission denied"),
    ("EAGAIN", "resource temporarily unavailable"),
    ("EBADF", "bad file descriptor"),
    ("EBUSY", "resource busy or locked"),
    ("EEXIST", "file already exists"),
    ("EFBIG", "file too large"),
    ("EINVAL", "invalid argument"),
    ("EIO", "i/o error"),
    ("EISDIR", "illegal operation on a directory"),
    ("ELOOP", "too many symbolic links encountered"),
    ("EMFILE", "too many open files"),
    ("ENAMETOOLONG", "name too long"),
    ("ENFILE", "file table overflow"),
    ("ENOENT", "no such file or directory"),
    ("ENOSPC", "no space left on device"),
    ("ENOTDIR", "not a directory"),
    ("ENOTEMPTY", "directory not empty"),
    ("EPERM", "operation not permitted"),
    ("EROFS", "read-only file system"),
    ("ETXTBSY", "text file is busy"),
    ("EXDEV", "cross-device link not permitted"),
];

#[cfg(unix)]
fn errno_name(raw: i32) -> Option<&'static str> {
    Some(match raw {
        libc::E2BIG => "E2BIG",
        libc::EACCES => "EACCES",
        libc::EAGAIN => "EAGAIN",
        libc::EBADF => "EBADF",
        libc::EBUSY => "EBUSY",
        libc::EEXIST => "EEXIST",
        libc::EFBIG => "EFBIG",
        libc::EINVAL => "EINVAL",
        libc::EIO => "EIO",
        libc::EISDIR => "EISDIR",
        libc::ELOOP => "ELOOP",
        libc::EMFILE => "EMFILE",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::ENFILE => "ENFILE",
        libc::ENOENT => "ENOENT",
        libc::ENOSPC => "ENOSPC",
        libc::ENOTDIR => "ENOTDIR",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::EPERM => "EPERM",
        libc::EROFS => "EROFS",
        libc::ETXTBSY => "ETXTBSY",
        libc::EXDEV => "EXDEV",
        _ => return None,
    })
}

/// libuv's `uv_translate_sys_error` for the Windows errors of file calls.
#[cfg(windows)]
fn errno_name(raw: i32) -> Option<&'static str> {
    Some(match raw {
        2 | 3 | 15 | 123 | 161 | 1392 => "ENOENT", // FILE_NOT_FOUND, PATH_NOT_FOUND, INVALID_DRIVE, INVALID_NAME, BAD_PATHNAME, FILE_CORRUPT
        4 => "EMFILE",                             // TOO_MANY_OPEN_FILES
        5 | 19 => "EPERM",                         // ACCESS_DENIED, WRITE_PROTECT
        6 => "EBADF",                              // INVALID_HANDLE
        17 => "EXDEV",                             // NOT_SAME_DEVICE
        32 | 33 | 170 => "EBUSY",                  // SHARING_VIOLATION, LOCK_VIOLATION, BUSY
        39 | 112 => "ENOSPC",                      // HANDLE_DISK_FULL, DISK_FULL
        80 | 183 => "EEXIST",                      // FILE_EXISTS, ALREADY_EXISTS
        87 => "EINVAL",                            // INVALID_PARAMETER
        145 => "ENOTEMPTY",                        // DIR_NOT_EMPTY
        206 => "ENAMETOOLONG",                     // FILENAME_EXCED_RANGE
        267 => "ENOTDIR",                          // DIRECTORY
        1921 => "ELOOP",                           // CANT_RESOLVE_FILENAME
        _ => return None,
    })
}

/// The `code` Node gives the error; `None` for an error that did not come
/// from the system (one Rust made up, such as invalid UTF-8).
pub fn code_of(e: &io::Error) -> Option<&'static str> {
    e.raw_os_error().and_then(errno_name)
}

fn text_of(code: &str) -> &'static str {
    ERRORS
        .iter()
        .find(|(name, _)| *name == code)
        .map_or("unknown error", |(_, text)| text)
}

/// Node's error for `syscall` on `path`: `ENOENT: no such file or directory,
/// open '/x'`.
pub fn node_error(e: &io::Error, syscall: &str, path: &str) -> NodeError {
    let code = code_of(e);
    let name = code.unwrap_or("UNKNOWN");
    NodeError {
        code,
        message: format!("{name}: {}, {syscall} '{path}'", text_of(name)),
    }
}

/// Node's error for a two-path call (`rename`, `copyfile`, `link`):
/// `ENOENT: no such file or directory, rename '/a' -> '/b'`.
pub fn node_error2(e: &io::Error, syscall: &str, from: &str, to: &str) -> NodeError {
    let code = code_of(e);
    let name = code.unwrap_or("UNKNOWN");
    NodeError {
        code,
        message: format!("{name}: {}, {syscall} '{from}' -> '{to}'", text_of(name)),
    }
}
