//! The few Node calls the PDF modules share (`os.tmpdir()`, `mkdtemp`,
//! `writeFile` with a mode, `rm` with `force`), each
//! with the syscall name and path Node's error carries.

use crate::node_fs::{NodeError, code_of, namespaced, node_error, node_error_fd};
use std::fs;
use std::io::{Read, Write};

/// `buffer.toString('base64url')`: the URL alphabet, no padding
pub fn base64url_encode(bytes: &[u8]) -> String {
    jscompat::base64(bytes)
        .trim_end_matches('=')
        .replace('+', "-")
        .replace('/', "_")
}

/// `crypto.randomBytes(len)`
pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut out = vec![0u8; len];
    // the platform source failing is not something a caller can act on
    getrandom::fill(&mut out).expect("the platform random source");
    out
}

/// `os.tmpdir()`
pub fn tmpdir() -> String {
    #[cfg(windows)]
    {
        let mut path = std::env::var("TEMP")
            .ok()
            .filter(|p| !p.is_empty())
            .or_else(|| std::env::var("TMP").ok().filter(|p| !p.is_empty()))
            .unwrap_or_else(|| {
                let root = std::env::var("SystemRoot")
                    .or_else(|_| std::env::var("windir"))
                    .unwrap_or_default();
                format!("{root}\\temp")
            });
        if path.len() > 1 && path.ends_with('\\') && !path.ends_with(":\\") {
            path.pop();
        }
        path
    }
    #[cfg(not(windows))]
    {
        let mut path = ["TMPDIR", "TMP", "TEMP"]
            .iter()
            .find_map(|name| std::env::var(name).ok().filter(|p| !p.is_empty()))
            .unwrap_or_else(|| "/tmp".to_owned());
        if path.len() > 1 && path.ends_with('/') {
            path.pop();
        }
        path
    }
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

/// `writeFile(path, text, { mode })`: the file made with `mode` (before the
/// umask) where the platform has modes
pub fn write_file_mode(path: &str, text: &str, mode: u32) -> Result<(), NodeError> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = options
        .open(namespaced(path))
        .map_err(|e| node_error(&e, "open", path))?;
    file.write_all(text.as_bytes())
        .map_err(|e| node_error(&e, "write", path))
}

/// `readFile(path)`: Node's `open` then `read`, each with its own error
pub fn read_file_bytes(path: &str) -> Result<Vec<u8>, NodeError> {
    let mut file = fs::File::open(namespaced(path)).map_err(|e| node_error(&e, "open", path))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| node_error_fd(&e, "read"))?;
    Ok(bytes)
}
