// The Windows table and the texts below are a port of libuv v1.51.0 as bundled by
// Node.js v22.22.0 (https://github.com/nodejs/node/tree/v22.22.0/deps/uv):
// `uv_translate_sys_error` of src/win/error.c and the `UV_ERRNO_MAP` texts of
// include/uv.h (`uv_strerror`). libuv carries this notice:
//
//   Copyright Joyent, Inc. and other Node contributors. All rights reserved.
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to
//   deal in the Software without restriction, including without limitation the
//   rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
//   sell copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
//   FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
//   IN THE SOFTWARE.

//! Node's view of a failed file operation: the `code` of its error (`ENOENT`)
//! and the `message` it prints (`ENOENT: no such file or directory, open
//! '/x'`). Node takes both from libuv, which names the errno of the platform
//! (Unix) or maps the Windows error to one; this module does the same.

use std::io;

/// A Node file error as the TypeScript sees it: `err.code` and `err.message`.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeError {
    /// `None` for an error that did not come from the system (see
    /// [`code_of`]); a system error libuv has no name for is `UNKNOWN`, as in
    /// Node
    pub code: Option<&'static str>,
    pub message: String,
}

/// libuv's name and text of every error (`UV_ERRNO_MAP`, what `uv_strerror`
/// prints); the tables below only yield names of this list.
const ERRORS: &[(&str, &str)] = &[
    ("E2BIG", "argument list too long"),
    ("EACCES", "permission denied"),
    ("EADDRINUSE", "address already in use"),
    ("EADDRNOTAVAIL", "address not available"),
    ("EAFNOSUPPORT", "address family not supported"),
    ("EAGAIN", "resource temporarily unavailable"),
    ("EAI_ADDRFAMILY", "address family not supported"),
    ("EAI_AGAIN", "temporary failure"),
    ("EAI_BADFLAGS", "bad ai_flags value"),
    ("EAI_BADHINTS", "invalid value for hints"),
    ("EAI_CANCELED", "request canceled"),
    ("EAI_FAIL", "permanent failure"),
    ("EAI_FAMILY", "ai_family not supported"),
    ("EAI_MEMORY", "out of memory"),
    ("EAI_NODATA", "no address"),
    ("EAI_NONAME", "unknown node or service"),
    ("EAI_OVERFLOW", "argument buffer overflow"),
    ("EAI_PROTOCOL", "resolved protocol is unknown"),
    ("EAI_SERVICE", "service not available for socket type"),
    ("EAI_SOCKTYPE", "socket type not supported"),
    ("EALREADY", "connection already in progress"),
    ("EBADF", "bad file descriptor"),
    ("EBUSY", "resource busy or locked"),
    ("ECANCELED", "operation canceled"),
    ("ECHARSET", "invalid Unicode character"),
    ("ECONNABORTED", "software caused connection abort"),
    ("ECONNREFUSED", "connection refused"),
    ("ECONNRESET", "connection reset by peer"),
    ("EDESTADDRREQ", "destination address required"),
    ("EEXIST", "file already exists"),
    ("EFAULT", "bad address in system call argument"),
    ("EFBIG", "file too large"),
    ("EHOSTUNREACH", "host is unreachable"),
    ("EINTR", "interrupted system call"),
    ("EINVAL", "invalid argument"),
    ("EIO", "i/o error"),
    ("EISCONN", "socket is already connected"),
    ("EISDIR", "illegal operation on a directory"),
    ("ELOOP", "too many symbolic links encountered"),
    ("EMFILE", "too many open files"),
    ("EMSGSIZE", "message too long"),
    ("ENAMETOOLONG", "name too long"),
    ("ENETDOWN", "network is down"),
    ("ENETUNREACH", "network is unreachable"),
    ("ENFILE", "file table overflow"),
    ("ENOBUFS", "no buffer space available"),
    ("ENODEV", "no such device"),
    ("ENOENT", "no such file or directory"),
    ("ENOMEM", "not enough memory"),
    ("ENONET", "machine is not on the network"),
    ("ENOPROTOOPT", "protocol not available"),
    ("ENOSPC", "no space left on device"),
    ("ENOSYS", "function not implemented"),
    ("ENOTCONN", "socket is not connected"),
    ("ENOTDIR", "not a directory"),
    ("ENOTEMPTY", "directory not empty"),
    ("ENOTSOCK", "socket operation on non-socket"),
    ("ENOTSUP", "operation not supported on socket"),
    ("EOVERFLOW", "value too large for defined data type"),
    ("EPERM", "operation not permitted"),
    ("EPIPE", "broken pipe"),
    ("EPROTO", "protocol error"),
    ("EPROTONOSUPPORT", "protocol not supported"),
    ("EPROTOTYPE", "protocol wrong type for socket"),
    ("ERANGE", "result too large"),
    ("EROFS", "read-only file system"),
    ("ESHUTDOWN", "cannot send after transport endpoint shutdown"),
    ("ESPIPE", "invalid seek"),
    ("ESRCH", "no such process"),
    ("ETIMEDOUT", "connection timed out"),
    ("ETXTBSY", "text file is busy"),
    ("EXDEV", "cross-device link not permitted"),
    ("UNKNOWN", "unknown error"),
    ("EOF", "end of file"),
    ("ENXIO", "no such device or address"),
    ("EMLINK", "too many links"),
    ("EHOSTDOWN", "host is down"),
    ("EREMOTEIO", "remote I/O error"),
    ("ENOTTY", "inappropriate ioctl for device"),
    ("EFTYPE", "inappropriate file type or format"),
    ("EILSEQ", "illegal byte sequence"),
    ("ESOCKTNOSUPPORT", "socket type not supported"),
    ("ENODATA", "no data available"),
    ("EUNATCH", "protocol driver not attached"),
    ("ENOEXEC", "exec format error"),
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

/// libuv's `uv_translate_sys_error` (src/win/error.c), every error it maps, in
/// its order; what it does not map is `UV_UNKNOWN`, which Node names `UNKNOWN`.
#[cfg(windows)]
fn errno_name(raw: i32) -> Option<&'static str> {
    if raw <= 0 {
        return None;
    }
    Some(match raw {
        10013 => "EACCES",          // WSAEACCES
        740 => "EACCES",            // ERROR_ELEVATION_REQUIRED
        1920 => "EACCES",           // ERROR_CANT_ACCESS_FILE
        1227 => "EADDRINUSE",       // ERROR_ADDRESS_ALREADY_ASSOCIATED
        10048 => "EADDRINUSE",      // WSAEADDRINUSE
        10049 => "EADDRNOTAVAIL",   // WSAEADDRNOTAVAIL
        10047 => "EAFNOSUPPORT",    // WSAEAFNOSUPPORT
        10035 => "EAGAIN",          // WSAEWOULDBLOCK
        232 => "EAGAIN",            // ERROR_NO_DATA
        10037 => "EALREADY",        // WSAEALREADY
        1004 => "EBADF",            // ERROR_INVALID_FLAGS
        6 => "EBADF",               // ERROR_INVALID_HANDLE
        33 => "EBUSY",              // ERROR_LOCK_VIOLATION
        231 => "EBUSY",             // ERROR_PIPE_BUSY
        32 => "EBUSY",              // ERROR_SHARING_VIOLATION
        995 => "ECANCELED",         // ERROR_OPERATION_ABORTED
        10004 => "ECANCELED",       // WSAEINTR
        1113 => "ECHARSET",         // ERROR_NO_UNICODE_TRANSLATION
        1236 => "ECONNABORTED",     // ERROR_CONNECTION_ABORTED
        10053 => "ECONNABORTED",    // WSAECONNABORTED
        1225 => "ECONNREFUSED",     // ERROR_CONNECTION_REFUSED
        10061 => "ECONNREFUSED",    // WSAECONNREFUSED
        64 => "ECONNRESET",         // ERROR_NETNAME_DELETED
        10054 => "ECONNRESET",      // WSAECONNRESET
        183 => "EEXIST",            // ERROR_ALREADY_EXISTS
        80 => "EEXIST",             // ERROR_FILE_EXISTS
        998 => "EFAULT",            // ERROR_NOACCESS
        10014 => "EFAULT",          // WSAEFAULT
        1232 => "EHOSTUNREACH",     // ERROR_HOST_UNREACHABLE
        10065 => "EHOSTUNREACH",    // WSAEHOSTUNREACH
        122 => "EINVAL",            // ERROR_INSUFFICIENT_BUFFER
        13 => "EINVAL",             // ERROR_INVALID_DATA
        87 => "EINVAL",             // ERROR_INVALID_PARAMETER
        1464 => "EINVAL",           // ERROR_SYMLINK_NOT_SUPPORTED
        10022 => "EINVAL",          // WSAEINVAL
        10046 => "EINVAL",          // WSAEPFNOSUPPORT
        1102 => "EIO",              // ERROR_BEGINNING_OF_MEDIA
        1111 => "EIO",              // ERROR_BUS_RESET
        23 => "EIO",                // ERROR_CRC
        1166 => "EIO",              // ERROR_DEVICE_DOOR_OPEN
        1165 => "EIO",              // ERROR_DEVICE_REQUIRES_CLEANING
        1393 => "EIO",              // ERROR_DISK_CORRUPT
        1129 => "EIO",              // ERROR_EOM_OVERFLOW
        1101 => "EIO",              // ERROR_FILEMARK_DETECTED
        31 => "EIO",                // ERROR_GEN_FAILURE
        1106 => "EIO",              // ERROR_INVALID_BLOCK_LENGTH
        1117 => "EIO",              // ERROR_IO_DEVICE
        1104 => "EIO",              // ERROR_NO_DATA_DETECTED
        205 => "EIO",               // ERROR_NO_SIGNAL_SENT
        110 => "EIO",               // ERROR_OPEN_FAILED
        1103 => "EIO",              // ERROR_SETMARK_DETECTED
        156 => "EIO",               // ERROR_SIGNAL_REFUSED
        10056 => "EISCONN",         // WSAEISCONN
        1921 => "ELOOP",            // ERROR_CANT_RESOLVE_FILENAME
        4 => "EMFILE",              // ERROR_TOO_MANY_OPEN_FILES
        10024 => "EMFILE",          // WSAEMFILE
        10040 => "EMSGSIZE",        // WSAEMSGSIZE
        111 => "ENAMETOOLONG",      // ERROR_BUFFER_OVERFLOW
        206 => "ENAMETOOLONG",      // ERROR_FILENAME_EXCED_RANGE
        1231 => "ENETUNREACH",      // ERROR_NETWORK_UNREACHABLE
        10051 => "ENETUNREACH",     // WSAENETUNREACH
        10055 => "ENOBUFS",         // WSAENOBUFS
        161 => "ENOENT",            // ERROR_BAD_PATHNAME
        267 => "ENOENT",            // ERROR_DIRECTORY
        203 => "ENOENT",            // ERROR_ENVVAR_NOT_FOUND
        2 => "ENOENT",              // ERROR_FILE_NOT_FOUND
        123 => "ENOENT",            // ERROR_INVALID_NAME
        15 => "ENOENT",             // ERROR_INVALID_DRIVE
        4392 => "ENOENT",           // ERROR_INVALID_REPARSE_DATA
        126 => "ENOENT",            // ERROR_MOD_NOT_FOUND
        3 => "ENOENT",              // ERROR_PATH_NOT_FOUND
        11001 => "ENOENT",          // WSAHOST_NOT_FOUND
        11004 => "ENOENT",          // WSANO_DATA
        8 => "ENOMEM",              // ERROR_NOT_ENOUGH_MEMORY
        14 => "ENOMEM",             // ERROR_OUTOFMEMORY
        82 => "ENOSPC",             // ERROR_CANNOT_MAKE
        112 => "ENOSPC",            // ERROR_DISK_FULL
        277 => "ENOSPC",            // ERROR_EA_TABLE_FULL
        1100 => "ENOSPC",           // ERROR_END_OF_MEDIA
        39 => "ENOSPC",             // ERROR_HANDLE_DISK_FULL
        2250 => "ENOTCONN",         // ERROR_NOT_CONNECTED
        10057 => "ENOTCONN",        // WSAENOTCONN
        145 => "ENOTEMPTY",         // ERROR_DIR_NOT_EMPTY
        10038 => "ENOTSOCK",        // WSAENOTSOCK
        50 => "ENOTSUP",            // ERROR_NOT_SUPPORTED
        109 => "EOF",               // ERROR_BROKEN_PIPE
        5 => "EPERM",               // ERROR_ACCESS_DENIED
        1314 => "EPERM",            // ERROR_PRIVILEGE_NOT_HELD
        230 => "EPIPE",             // ERROR_BAD_PIPE
        233 => "EPIPE",             // ERROR_PIPE_NOT_CONNECTED
        10058 => "EPIPE",           // WSAESHUTDOWN
        10043 => "EPROTONOSUPPORT", // WSAEPROTONOSUPPORT
        19 => "EROFS",              // ERROR_WRITE_PROTECT
        121 => "ETIMEDOUT",         // ERROR_SEM_TIMEOUT
        10060 => "ETIMEDOUT",       // WSAETIMEDOUT
        17 => "EXDEV",              // ERROR_NOT_SAME_DEVICE
        1 => "EISDIR",              // ERROR_INVALID_FUNCTION
        208 => "E2BIG",             // ERROR_META_EXPANSION_TOO_LONG
        10044 => "ESOCKTNOSUPPORT", // WSAESOCKTNOSUPPORT
        193 => "EFTYPE",            // ERROR_BAD_EXE_FORMAT
        _ => "UNKNOWN",
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

/// The path as Node hands it to libuv: on Windows `ToNamespacedPath`
/// (node's `path.toNamespacedPath`: resolved against the working folder and
/// written `\\?\C:\...`, which libuv then passes on without the Win32
/// normalisation); elsewhere as given. A std call on a Windows path must take
/// this form to do what libuv does (a name with `<` or past 255 characters
/// gets another error as a verbatim path than as a plain one).
pub fn namespaced(path: &str) -> String {
    #[cfg(windows)]
    {
        jscompat::node_path::win32::to_namespaced_path(path)
    }
    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

/// The path as Node's error message prints it: Node's `StringFromPath` takes
/// the `\\?\` (`\\?\UNC\`) prefix off the namespaced path again, so on
/// Windows the message holds the resolved path with backslashes, whatever form
/// the caller gave.
fn shown(path: &str) -> String {
    #[cfg(windows)]
    {
        let full = namespaced(path);
        if let Some(rest) = full.strip_prefix("\\\\?\\UNC\\") {
            return format!("\\\\{rest}");
        }
        match full.strip_prefix("\\\\?\\") {
            Some(rest) => rest.to_string(),
            None => full,
        }
    }
    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

/// Node's error for `syscall` on `path`: `ENOENT: no such file or directory,
/// open '/x'`.
pub fn node_error(e: &io::Error, syscall: &str, path: &str) -> NodeError {
    let code = code_of(e);
    let name = code.unwrap_or("UNKNOWN");
    NodeError {
        code,
        message: format!("{name}: {}, {syscall} '{}'", text_of(name), shown(path)),
    }
}

/// Node's error for a two-path call (`rename`, `copyfile`, `link`):
/// `ENOENT: no such file or directory, rename '/a' -> '/b'`.
pub fn node_error2(e: &io::Error, syscall: &str, from: &str, to: &str) -> NodeError {
    let code = code_of(e);
    let name = code.unwrap_or("UNKNOWN");
    NodeError {
        code,
        message: format!(
            "{name}: {}, {syscall} '{}' -> '{}'",
            text_of(name),
            shown(from),
            shown(to)
        ),
    }
}

/// Node's error for a call that failed on a descriptor, not a path (the
/// `read` of `readFileSync`): `EISDIR: illegal operation on a directory, read`.
pub fn node_error_fd(e: &io::Error, syscall: &str) -> NodeError {
    let code = code_of(e);
    let name = code.unwrap_or("UNKNOWN");
    NodeError {
        code,
        message: format!("{name}: {}, {syscall}", text_of(name)),
    }
}

/// Node's error for `syscall` on `path` that libuv itself names `code`,
/// without a system error behind it (`fs__scandir` of a file on Windows says
/// `ENOTDIR`).
pub fn node_error_named(code: &'static str, syscall: &str, path: &str) -> NodeError {
    NodeError {
        code: Some(code),
        message: format!("{code}: {}, {syscall} '{}'", text_of(code), shown(path)),
    }
}

/// `fs.copyFileSync(from, to[, COPYFILE_EXCL])` as libuv's `uv_fs_copyfile`
/// does it. The target takes the source's mode. With `excl` an existing
/// target is an `EEXIST`, without it the target is replaced.
///
/// - macOS: `copyfile(3)` with `COPYFILE_ALL`, which refuses a folder source
///   with `ENOTSUP` before it touches the target.
/// - other Unix: open the source, `fstat`, open the target `O_WRONLY |
///   O_CREAT` (`| O_EXCL`); without `excl` stop when the target is the
///   source itself, else truncate it; `fchmod` it to the source's mode, copy
///   the bytes; a failure after the target was opened removes it.
/// - Windows: `CopyFileW(from, to, excl)`.
pub fn copy_file(from: &str, to: &str, excl: bool) -> Result<(), NodeError> {
    let fail = |e: &io::Error| node_error2(e, "copyfile", from, to);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::CopyFileW;
        let wide = |p: &str| -> Vec<u16> {
            std::ffi::OsStr::new(&namespaced(p))
                .encode_wide()
                .chain(std::iter::once(0))
                .collect()
        };
        let (src, dst) = (wide(from), wide(to));
        // SAFETY: both buffers are NUL-terminated and live for the call
        if unsafe { CopyFileW(src.as_ptr(), dst.as_ptr(), i32::from(excl)) } == 0 {
            return Err(fail(&io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        use std::fs;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut source = fs::File::open(namespaced(from)).map_err(|e| fail(&e))?;
        let info = source.metadata().map_err(|e| fail(&e))?;
        #[cfg(target_os = "macos")]
        if info.is_dir() {
            return Err(NodeError {
                code: Some("ENOTSUP"),
                message: format!(
                    "ENOTSUP: operation not supported on socket, copyfile '{}' -> '{}'",
                    shown(from),
                    shown(to)
                ),
            });
        }
        use std::os::unix::fs::MetadataExt;
        let mode = info.permissions().mode() & 0o7777;
        let mut options = fs::OpenOptions::new();
        options.write(true).mode(mode);
        if excl {
            options.create_new(true);
        } else {
            options.create(true);
        }
        let mut target = options.open(namespaced(to)).map_err(|e| fail(&e))?;
        if !excl {
            // the same file under another name: nothing to copy (libuv checks
            // this before it truncates, so the source is never emptied)
            let same = target
                .metadata()
                .map(|t| t.dev() == info.dev() && t.ino() == info.ino())
                .map_err(|e| fail(&e))?;
            if same {
                return Ok(());
            }
            target.set_len(0).map_err(|e| fail(&e))?;
        }
        let copied = target
            .set_permissions(fs::Permissions::from_mode(mode))
            .and_then(|()| io::copy(&mut source, &mut target).map(|_| ()));
        if let Err(e) = copied {
            drop(target);
            let _ = fs::remove_file(namespaced(to));
            return Err(fail(&e));
        }
        Ok(())
    }
}

/// `fs.mkdtempSync(prefix)`: a new folder `prefix` + six characters, mode
/// 0o700. libuv hands `prefixXXXXXX` to `mkdtemp(3)`, which tries names until
/// one is free; `suffix` gives each try's six characters (the caller pins them
/// for a comparison, [`mkdtemp_random`] draws them). An error names the
/// template, as Node's does: `mkdtemp '/tmp/xXXXXXX'`.
pub fn mkdtemp(prefix: &str, suffix: &mut dyn FnMut() -> String) -> Result<String, NodeError> {
    let template = format!("{prefix}XXXXXX");
    let mut last = None;
    for _ in 0..128 {
        let path = format!("{prefix}{}", suffix());
        #[cfg(unix)]
        let builder = {
            let mut builder = std::fs::DirBuilder::new();
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
            builder
        };
        #[cfg(not(unix))]
        let builder = std::fs::DirBuilder::new();
        match builder.create(namespaced(&path)) {
            Ok(()) => return Ok(path),
            Err(e) if code_of(&e) == Some("EEXIST") => last = Some(e),
            Err(e) => return Err(node_error(&e, "mkdtemp", &template)),
        }
    }
    Err(node_error(
        &last.expect("the loop ran"),
        "mkdtemp",
        &template,
    ))
}

/// [`mkdtemp`] with six random characters of `[A-Za-z0-9]`, as `mkdtemp(3)`
/// draws them.
pub fn mkdtemp_random(prefix: &str) -> Result<String, NodeError> {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    mkdtemp(prefix, &mut || {
        (0..6)
            .map(|_| {
                let at = (jscompat::math_random() * CHARS.len() as f64) as usize;
                char::from(CHARS[at.min(CHARS.len() - 1)])
            })
            .collect()
    })
}
