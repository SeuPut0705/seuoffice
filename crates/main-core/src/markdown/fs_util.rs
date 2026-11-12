//! The few Node `fs` calls the markdown modules share, each with the syscall
//! name and path Node's error carries.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};

use sha2::{Digest, Sha256};

use crate::node_fs::{NodeError, code_of, namespaced, node_error, node_error_fd, node_error2};

/// An `Error` the TypeScript throws itself: no `code`.
pub fn plain_error(message: &str) -> NodeError {
    NodeError {
        code: None,
        message: message.to_owned(),
    }
}

/// `readFile(path)`: Node's `open` then `read`, each with its own error.
pub fn read_file_bytes(path: &str) -> Result<Vec<u8>, NodeError> {
    let mut file = fs::File::open(namespaced(path)).map_err(|e| node_error(&e, "open", path))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| node_error_fd(&e, "read"))?;
    Ok(bytes)
}

/// `readFile(path, 'utf8')`: ill-formed bytes decode as U+FFFD, a byte order mark stays.
pub fn read_file_utf8(path: &str) -> Result<String, NodeError> {
    read_file_bytes(path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// `createHash('sha256').update(await readFile(path)).digest('hex')`
pub fn sha256_file(path: &str) -> Result<String, NodeError> {
    let bytes = read_file_bytes(path)?;
    Ok(sha256_hex(&bytes))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `mkdir(path, { recursive: true })`
pub fn mkdir_p(path: &str) -> Result<(), NodeError> {
    fs::create_dir_all(namespaced(path)).map_err(|e| node_error(&e, "mkdir", path))
}

/// `mkdir(path)`
pub fn mkdir(path: &str) -> Result<(), NodeError> {
    fs::create_dir(namespaced(path)).map_err(|e| node_error(&e, "mkdir", path))
}

/// `writeFile(path, bytes, { flag: 'wx' })`
pub fn write_file_excl(path: &str, bytes: &[u8]) -> Result<(), NodeError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(namespaced(path))
        .map_err(|e| node_error(&e, "open", path))?;
    file.write_all(bytes)
        .map_err(|e| node_error_fd(&e, "write"))
}

/// `copyFile(source, target, COPYFILE_EXCL)`: the target takes the source's mode.
pub fn copy_file_excl(source: &str, target: &str) -> Result<(), NodeError> {
    let fail = |e: std::io::Error| node_error2(&e, "copyfile", source, target);
    let mut from = fs::File::open(namespaced(source)).map_err(fail)?;
    let meta = from.metadata().map_err(fail)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::fs::PermissionsExt;
        options.mode(meta.permissions().mode() & 0o7777);
    }
    let mut to = options.open(namespaced(target)).map_err(fail)?;
    let copied = std::io::copy(&mut from, &mut to).map_err(fail);
    #[cfg(unix)]
    {
        let _ = to.set_permissions(meta.permissions());
    }
    drop(to);
    if let Err(error) = copied {
        let _ = fs::remove_file(namespaced(target));
        return Err(error);
    }
    Ok(())
}

/// `rm(path, { recursive: true, force: true })`
pub fn rm_recursive_force(path: &str) -> Result<(), NodeError> {
    let full = namespaced(path);
    let meta = match fs::symlink_metadata(&full) {
        Ok(meta) => meta,
        Err(e) if code_of(&e) == Some("ENOENT") => return Ok(()),
        Err(e) => return Err(node_error(&e, "lstat", path)),
    };
    if meta.is_dir() {
        fs::remove_dir_all(&full).map_err(|e| node_error(&e, "rmdir", path))
    } else {
        fs::remove_file(&full).map_err(|e| node_error(&e, "unlink", path))
    }
}

/// `rm(path)` (`force` false) or `rm(path, { force: true })`: a file only; a
/// folder is refused as Node's `rm` refuses it.
pub fn rm_file(path: &str, force: bool) -> Result<(), NodeError> {
    let full = namespaced(path);
    match fs::symlink_metadata(&full) {
        Ok(meta) if meta.is_dir() => Err(NodeError {
            code: Some("ERR_FS_EISDIR"),
            message: format!("Path is a directory: rm returned EISDIR (is a directory) {path}"),
        }),
        Ok(_) => fs::remove_file(&full).map_err(|e| node_error(&e, "unlink", path)),
        Err(e) if force && code_of(&e) == Some("ENOENT") => Ok(()),
        Err(e) => Err(node_error(&e, "lstat", path)),
    }
}

/// `mkdtemp(prefix)`: a folder `prefix` plus six characters of `suffix()`,
/// mode 0700 where the platform has modes; a taken name is tried again.
pub fn mkdtemp(prefix: &str, suffix: &dyn Fn() -> String) -> Result<String, NodeError> {
    let mut last = None;
    for _ in 0..128 {
        let path = format!("{prefix}{}", suffix());
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(namespaced(&path)) {
            Ok(()) => return Ok(path),
            Err(e) if code_of(&e) == Some("EEXIST") => last = Some(e),
            Err(e) => return Err(node_error(&e, "mkdtemp", &format!("{prefix}XXXXXX"))),
        }
    }
    Err(node_error(
        &last.expect("the loop ran"),
        "mkdtemp",
        &format!("{prefix}XXXXXX"),
    ))
}

/// `rename(from, to)`
pub fn rename(from: &str, to: &str) -> Result<(), NodeError> {
    fs::rename(namespaced(from), namespaced(to)).map_err(|e| node_error2(&e, "rename", from, to))
}

/// `isPathInside(root, candidate)`: the candidate lies below the root.
pub fn is_path_inside(root: &str, candidate: &str) -> bool {
    use jscompat::node_path::host::{SEP, is_absolute, relative};
    let from_root = relative(root, candidate);
    !from_root.is_empty()
        && from_root != ".."
        && !from_root.starts_with(&format!("..{SEP}"))
        && !is_absolute(&from_root)
}
