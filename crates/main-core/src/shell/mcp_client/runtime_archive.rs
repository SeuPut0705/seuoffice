//! `apps/shell/src/main/mcp-client/runtime-archive.ts`: download one pinned
//! runtime archive, check it against its pinned SHA-256, and unpack it: `.zip`
//! (read by the JSZip port of `ooxml-pkg`) and `.tar.gz` (gzip by `flate2`,
//! the tar reader is the TypeScript's own, ported as it is).
//!
//! Plain calls. The `fetch` is the [`RuntimeFetch`] trait (Electron's
//! `net.fetch` or global `fetch` behind it); a body is an iterator of chunks
//! pulled one at a time, so a body longer than the pinned size is cut off at
//! the first chunk past it, as `body.destroy()` does. The `AbortSignal` of
//! the TypeScript has no counterpart (a plain call is not cancelled).
//!
//! What the TypeScript throws that is not a [`RuntimeArchiveError`] (a Node
//! error from `open(target, 'wx')` or `handle.close()` in the download) is
//! [`DownloadError::Io`]; the unpack wraps every other failure into
//! `extract-failed` with `unpacking failed: <message>` as the TypeScript
//! does, the message being Node's error text (`node_fs`) or JSZip's.
//!
//! Differences that cannot be reproduced and are not in the cases: the
//! message of a corrupt gzip stream is zlib's text in Node; `flate2` reports
//! its own, and only the common ones are mapped to zlib's words
//! (`incorrect header check`, `unexpected end of file`, `incorrect data
//! check`, `incorrect length check`). A zip lists entries here in central
//! directory order without the parent folders JSZip adds with
//! `createFolders`; each file makes its own folder first, so the unpacked tree
//! is the same.
//!
//! Needs `ooxml_pkg::jszip::load` (public since commit 8cca48e00).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};

use flate2::read::GzDecoder;
use jscompat::node_path::host;
use jscompat::{JsObject, Radix, parse_int, trim};
use sha2::{Digest, Sha256};

use super::runtime_pins::{ArchiveFormat, PinnedArchive};
use crate::node_fs::{NodeError, namespaced, node_error, node_error_fd, node_error2};

/// `RuntimeArchiveFailure`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeArchiveFailure {
    Offline,
    HashMismatch,
    ExtractFailed,
}

impl RuntimeArchiveFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeArchiveFailure::Offline => "offline",
            RuntimeArchiveFailure::HashMismatch => "hash-mismatch",
            RuntimeArchiveFailure::ExtractFailed => "extract-failed",
        }
    }
}

/// `RuntimeArchiveError`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeArchiveError {
    pub kind: RuntimeArchiveFailure,
    pub message: String,
}

impl RuntimeArchiveError {
    fn new(kind: RuntimeArchiveFailure, message: impl Into<String>) -> Self {
        RuntimeArchiveError {
            kind,
            message: message.into(),
        }
    }

    fn extract(message: impl Into<String>) -> Self {
        Self::new(RuntimeArchiveFailure::ExtractFailed, message)
    }
}

impl std::fmt::Display for RuntimeArchiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RuntimeArchiveError: {}", self.message)
    }
}

/// What `downloadVerifiedArchive` rejects with
#[derive(Debug, Clone, PartialEq)]
pub enum DownloadError {
    Archive(RuntimeArchiveError),
    /// a Node error of `open(target, 'wx')` or `handle.close()`
    Io(NodeError),
}

/// The `Response` of the fetch, as far as the download reads it
pub struct RuntimeResponse {
    pub ok: bool,
    pub status: u16,
    /// `response.body`: `None` is a response without one. Each item is a chunk
    /// or the message of the error the stream failed with.
    pub body: Option<Box<dyn Iterator<Item = Result<Vec<u8>, String>>>>,
}

/// `RuntimeFetch`: `Err` is the message of the rejection
pub trait RuntimeFetch {
    fn fetch(&self, url: &str) -> Result<RuntimeResponse, String>;
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `downloadVerifiedArchive(archive, target, fetchImpl)`: stream `archive.url`
/// into `target`, hashing as it goes. The file is deleted and `hash-mismatch`
/// returned when the bytes are not exactly the pinned ones (a longer body is
/// cut off at the pinned size); an unreachable or refused download is
/// `offline`.
pub fn download_verified_archive(
    archive: &PinnedArchive,
    target: &str,
    fetch_impl: &dyn RuntimeFetch,
) -> Result<(), DownloadError> {
    let offline = |message: String| {
        DownloadError::Archive(RuntimeArchiveError::new(
            RuntimeArchiveFailure::Offline,
            message,
        ))
    };
    let response = match fetch_impl.fetch(&archive.url) {
        Ok(response) => response,
        Err(error) => return Err(offline(format!("download failed: {error}"))),
    };
    let RuntimeResponse { ok, status, body } = response;
    let body = match body {
        Some(body) if ok => body,
        _ => return Err(offline(format!("download failed: HTTP {status}"))),
    };
    let mut hash = Sha256::new();
    let mut received: u64 = 0;
    let mut too_long = false;
    let mut handle = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(namespaced(target))
        .map_err(|e| DownloadError::Io(node_error(&e, "open", target)))?;
    let streamed = (|| -> Result<(), String> {
        for chunk in body {
            let chunk = chunk?;
            received += chunk.len() as u64;
            if received > archive.bytes {
                too_long = true;
                break;
            }
            hash.update(&chunk);
            handle
                .write_all(&chunk)
                .map_err(|e| node_error_fd(&e, "write").message)?;
        }
        Ok(())
    })();
    if let Err(message) = streamed {
        drop(handle);
        let _ = fs::remove_file(namespaced(target));
        return Err(offline(format!("download interrupted: {message}")));
    }
    drop(handle);
    let digest = hex(&hash.finalize());
    if too_long || received != archive.bytes || digest != archive.sha256.to_lowercase() {
        let _ = fs::remove_file(namespaced(target));
        return Err(DownloadError::Archive(RuntimeArchiveError::new(
            RuntimeArchiveFailure::HashMismatch,
            if too_long {
                format!("download is longer than the pinned {} bytes", archive.bytes)
            } else {
                format!("download does not match the pinned SHA-256 ({received} bytes, {digest})")
            },
        )));
    }
    Ok(())
}

/// A failure inside the unpack: the TypeScript's own error, or another one
/// whose message `extractRuntimeArchive` wraps
enum Fail {
    Archive(RuntimeArchiveError),
    Other(String),
}

impl From<RuntimeArchiveError> for Fail {
    fn from(error: RuntimeArchiveError) -> Self {
        Fail::Archive(error)
    }
}

impl From<NodeError> for Fail {
    fn from(error: NodeError) -> Self {
        Fail::Other(error.message)
    }
}

type Step<T = ()> = Result<T, Fail>;

fn extract_fail<T>(message: impl Into<String>) -> Step<T> {
    Err(Fail::Archive(RuntimeArchiveError::extract(message)))
}

/// `mkdir(path, { recursive: true })`
fn mkdir_p(path: &str) -> Step {
    fs::create_dir_all(namespaced(path)).map_err(|e| node_error(&e, "mkdir", path))?;
    Ok(())
}

/// `open(target, 'w', mode)`
fn open_for_write(target: &str, mode: u32) -> Step<File> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(options
        .open(namespaced(target))
        .map_err(|e| node_error(&e, "open", target))?)
}

fn write_chunk(file: &mut File, chunk: &[u8]) -> Step {
    file.write_all(chunk)
        .map_err(|e| Fail::Other(node_error_fd(&e, "write").message))
}

/// `extractRuntimeArchive(file, format, root, dest)`: unpack `file` into
/// `dest`, dropping the archive's top folder `root`
pub fn extract_runtime_archive(
    file: &str,
    format: ArchiveFormat,
    root: &str,
    dest: &str,
) -> Result<(), RuntimeArchiveError> {
    let run = || -> Step {
        mkdir_p(dest)?;
        match format {
            ArchiveFormat::Zip => extract_zip(file, root, dest),
            ArchiveFormat::TarGz => extract_tar_gz(file, root, dest),
        }
    };
    match run() {
        Ok(()) => Ok(()),
        Err(Fail::Archive(error)) => Err(error),
        Err(Fail::Other(message)) => Err(RuntimeArchiveError::extract(format!(
            "unpacking failed: {message}"
        ))),
    }
}

/// `entrySegments(name, root)`: the path below the archive's top folder as
/// segments, or `None` for entries outside it (and the folder itself). `..`
/// and absolute names are refused.
fn entry_segments(name: &str, root: &str) -> Step<Option<Vec<String>>> {
    let raw = name.replace('\\', "/");
    let drive = {
        let mut chars = raw.chars();
        matches!((chars.next(), chars.next()), (Some(c), Some(':')) if c.is_ascii_alphabetic())
    };
    if raw.starts_with('/') || drive {
        return extract_fail(format!("absolute entry in archive: {name}"));
    }
    let mut segments: Vec<String> = raw
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .map(str::to_owned)
        .collect();
    if segments.iter().any(|s| s == "..") {
        return extract_fail(format!("entry leaves the archive: {name}"));
    }
    if !root.is_empty() {
        if segments.first().map(String::as_str) != Some(root) {
            return Ok(None);
        }
        segments.remove(0);
    }
    Ok(if segments.is_empty() {
        None
    } else {
        Some(segments)
    })
}

fn separator() -> &'static str {
    if cfg!(windows) { "\\" } else { "/" }
}

/// `inside(dest, target)`
fn inside(dest: &str, target: &str) -> bool {
    let base = host::resolve(&[dest]);
    let full = host::resolve(&[target]);
    full == base || full.starts_with(&format!("{base}{}", separator()))
}

/// `targetOf(dest, segments)`
fn target_of(dest: &str, segments: &[String]) -> Step<String> {
    let mut parts: Vec<&str> = vec![dest];
    parts.extend(segments.iter().map(String::as_str));
    let target = host::join(&parts);
    if !inside(dest, &target) {
        return extract_fail(format!("entry leaves the archive: {}", segments.join("/")));
    }
    Ok(target)
}

/// `fileMode(mode)`: permission bits worth keeping: read/write/execute, never
/// set-id or sticky
fn file_mode(mode: Option<f64>) -> u32 {
    let bits = match mode {
        Some(m) if m > 0.0 => (m as u64 & 0o777) as u32,
        _ => 0o644,
    };
    bits | 0o600
}

// ── zip ──

fn extract_zip(file: &str, root: &str, dest: &str) -> Step {
    let bytes = fs::read(namespaced(file)).map_err(|e| node_error(&e, "open", file))?;
    // `zip.file(name, ...)` of `loadAsync` sets `this.files[name]`: a later
    // entry of a name replaces the earlier one in its place (an own key of a
    // plain object, so a name that is an array index sorts first), and the
    // replaced entry is never inflated
    let mut files: JsObject<ooxml_pkg::jszip::LoadedEntry> = JsObject::new();
    for entry in ooxml_pkg::jszip::load(&bytes, false).map_err(Fail::Other)? {
        files.set(entry.name.clone(), entry);
    }
    for (_, entry) in files.entries() {
        let Some(segments) = entry_segments(&entry.name, root)? else {
            continue;
        };
        let target = target_of(dest, &segments)?;
        if entry.is_dir {
            mkdir_p(&target)?;
            continue;
        }
        mkdir_p(&host::dirname(&target))?;
        let data = entry.content.as_ref().map_err(|e| Fail::Other(e.clone()))?;
        let mut handle = open_for_write(&target, file_mode(entry.unix_permissions.map(f64::from)))?;
        write_chunk(&mut handle, data)?;
    }
    Ok(())
}

// ── tar.gz ──

const BLOCK: usize = 512;

/// `RuntimeArchiveError` of a gzip stream that failed, worded as zlib words
/// the common ones
fn gzip_error(e: &io::Error) -> Fail {
    let text = e.to_string();
    let message = if e.kind() == io::ErrorKind::UnexpectedEof {
        "unexpected end of file".to_owned()
    } else if text.contains("invalid gzip header") {
        "incorrect header check".to_owned()
    } else if text.contains("matching checksum") {
        "incorrect data check".to_owned()
    } else if text.contains("matching size") {
        "incorrect length check".to_owned()
    } else {
        text
    };
    Fail::Other(message)
}

/// `ChunkReader`: exact byte counts from the inflated stream
struct ChunkReader<R: Read> {
    source: R,
}

impl<R: Read> ChunkReader<R> {
    /// up to `max` bytes (at least one unless the stream ended), `None` at the end
    fn take(&mut self, max: u64) -> Step<Option<Vec<u8>>> {
        let mut buffer = vec![0u8; max.min(65536) as usize];
        loop {
            match self.source.read(&mut buffer) {
                Ok(0) => return Ok(None),
                Ok(n) => {
                    buffer.truncate(n);
                    return Ok(Some(buffer));
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(gzip_error(&e)),
            }
        }
    }

    /// exactly `count` bytes, or `None` when the stream ends first. A count
    /// that is not above zero (NaN from a bad size field included) is an
    /// empty read, as in the TypeScript.
    fn exact(&mut self, count: f64) -> Step<Option<Vec<u8>>> {
        if count.is_nan() || count <= 0.0 {
            return Ok(Some(Vec::new()));
        }
        let wanted = count as u64;
        let mut out: Vec<u8> = Vec::new();
        while (out.len() as u64) < wanted {
            match self.take(wanted - out.len() as u64)? {
                Some(part) => out.extend_from_slice(&part),
                None => return Ok(None),
            }
        }
        Ok(Some(out))
    }

    /// hand `count` bytes to `sink` piece by piece
    fn pipe(&mut self, count: f64, sink: &mut dyn FnMut(&[u8]) -> Step) -> Step {
        let mut remaining = count;
        while remaining > 0.0 {
            let Some(chunk) = self.take(remaining as u64)? else {
                return extract_fail("archive ends inside an entry");
            };
            remaining -= chunk.len() as f64;
            sink(&chunk)?;
        }
        Ok(())
    }
}

/// `cString(block, offset, length)`
fn c_string(block: &[u8], offset: usize, length: usize) -> String {
    let end = (offset + length).min(block.len());
    let slice = &block[offset.min(end)..end];
    let stop = slice.iter().position(|b| *b == 0).unwrap_or(slice.len());
    String::from_utf8_lossy(&slice[..stop]).into_owned()
}

/// `Number.parseInt(text, 8)`: `Radix` has no octal, so the digits are read
/// here
fn parse_octal(text: &str) -> f64 {
    let text = jscompat::trim_start(text);
    let (negative, text) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let digits: &str = {
        let end = text
            .bytes()
            .position(|b| !(b'0'..=b'7').contains(&b))
            .unwrap_or(text.len());
        &text[..end]
    };
    if digits.is_empty() {
        return f64::NAN;
    }
    let magnitude = digits
        .bytes()
        .fold(0.0_f64, |acc, b| acc * 8.0 + f64::from(b - b'0'));
    if negative { -magnitude } else { magnitude }
}

/// `numeric(block, offset, length)`
fn numeric(block: &[u8], offset: usize, length: usize) -> f64 {
    let field = &block[offset..offset + length];
    if field[0] & 0x80 != 0 {
        // base-256 (GNU) for values that do not fit the octal field
        let mut value = f64::from(field[0] & 0x7f);
        for byte in &field[1..] {
            value = value * 256.0 + f64::from(*byte);
        }
        return value;
    }
    let stop = field.iter().position(|b| *b == 0).unwrap_or(field.len());
    let latin1: String = field[..stop].iter().map(|b| char::from(*b)).collect();
    let text = trim(&latin1);
    if text.is_empty() {
        0.0
    } else {
        parse_octal(text)
    }
}

/// `checksumOk(block)`
fn checksum_ok(block: &[u8]) -> bool {
    let mut sum: f64 = 0.0;
    for (index, byte) in block.iter().enumerate().take(BLOCK) {
        sum += if (148..156).contains(&index) {
            f64::from(0x20u8)
        } else {
            f64::from(*byte)
        };
    }
    sum == numeric(block, 148, 8)
}

/// `paxRecords(data)`: `path` and `linkpath` from a pax extended header
fn pax_records(data: &[u8]) -> HashMap<String, String> {
    let mut records = HashMap::new();
    let mut offset = 0usize;
    while offset < data.len() {
        let Some(space) = data[offset..]
            .iter()
            .position(|b| *b == 0x20)
            .map(|p| p + offset)
        else {
            break;
        };
        let latin1: String = data[offset..space].iter().map(|b| char::from(*b)).collect();
        let length = parse_int(&latin1, Radix::Ten);
        if !length.is_finite() || length <= 0.0 {
            break;
        }
        let length = length as usize;
        let start = (space + 1).min(data.len());
        let end = offset
            .saturating_add(length)
            .saturating_sub(1)
            .clamp(start, data.len());
        let record = String::from_utf8_lossy(&data[start..end]).into_owned();
        if let Some(equals) = record.find('=')
            && equals > 0
        {
            records.insert(record[..equals].to_owned(), record[equals + 1..].to_owned());
        }
        offset = offset.saturating_add(length);
    }
    records
}

fn extract_tar_gz(file: &str, root: &str, dest: &str) -> Step {
    let opened = File::open(namespaced(file)).map_err(|e| node_error(&e, "open", file))?;
    let mut reader = ChunkReader {
        source: GzDecoder::new(opened),
    };
    let mut long_name: Option<String> = None;
    let mut long_link: Option<String> = None;
    let mut pax: HashMap<String, String> = HashMap::new();
    loop {
        let Some(header) = reader.exact(BLOCK as f64)? else {
            return extract_fail("archive ends without its end mark");
        };
        if header.iter().all(|byte| *byte == 0) {
            break;
        }
        if !checksum_ok(&header) {
            return extract_fail("archive header checksum is wrong");
        }
        let size = numeric(&header, 124, 12);
        let padded = (size / BLOCK as f64).ceil() * BLOCK as f64;
        let type_byte = header[156];
        let kind = if type_byte == 0 { b'0' } else { type_byte };

        if matches!(kind, b'x' | b'L' | b'K' | b'g') {
            let Some(data) = reader.exact(padded)? else {
                return extract_fail("archive ends inside a header");
            };
            let take = if size.is_nan() || size < 0.0 {
                0
            } else {
                (size as usize).min(data.len())
            };
            let body = &data[..take];
            match kind {
                b'x' => pax = pax_records(body),
                b'L' => long_name = Some(c_string(body, 0, body.len())),
                b'K' => long_link = Some(c_string(body, 0, body.len())),
                _ => {}
            }
            continue;
        }

        let ustar = c_string(&header, 257, 6).starts_with("ustar");
        let prefix = if ustar {
            c_string(&header, 345, 155)
        } else {
            String::new()
        };
        let short_name = c_string(&header, 0, 100);
        let name = pax
            .get("path")
            .cloned()
            .or_else(|| long_name.clone())
            .unwrap_or_else(|| {
                if prefix.is_empty() {
                    short_name.clone()
                } else {
                    format!("{prefix}/{short_name}")
                }
            });
        let link = pax
            .get("linkpath")
            .cloned()
            .or_else(|| long_link.clone())
            .unwrap_or_else(|| c_string(&header, 157, 100));
        let mode = numeric(&header, 100, 8);
        pax = HashMap::new();
        long_name = None;
        long_link = None;

        let segments = entry_segments(&name, root)?;
        let target = match &segments {
            Some(segments) => Some(target_of(dest, segments)?),
            None => None,
        };
        if let Some(target) = &target
            && (kind == b'0' || kind == b'7')
        {
            mkdir_p(&host::dirname(target))?;
            let mut handle = open_for_write(target, file_mode(Some(mode)))?;
            reader.pipe(size, &mut |chunk| write_chunk(&mut handle, chunk))?;
            drop(handle);
            skip(&mut reader, padded - size)?;
            continue;
        }
        if let Some(target) = &target {
            if kind == b'5' {
                mkdir_p(target)?;
            }
            if kind == b'2' {
                link_symbolic(dest, target, &link)?;
            }
            if kind == b'1' {
                link_hard(dest, root, target, &link)?;
            }
        }
        skip(&mut reader, padded)?;
    }
    Ok(())
}

fn skip<R: Read>(reader: &mut ChunkReader<R>, count: f64) -> Step {
    if count > 0.0 {
        reader.pipe(count, &mut |_| Ok(()))?;
    }
    Ok(())
}

/// `linkSymbolic(dest, target, link)`: a symlink is made only when it points
/// inside the unpacked folder. A link the OS refuses (Windows without the
/// symlink right) is left out rather than failing the install.
fn link_symbolic(dest: &str, target: &str, link: &str) -> Step {
    if link.is_empty()
        || host::is_absolute(link)
        || !inside(dest, &host::resolve(&[&host::dirname(target), link]))
    {
        return Ok(());
    }
    mkdir_p(&host::dirname(target))?;
    remove_forced(target)?;
    #[cfg(unix)]
    let _ = std::os::unix::fs::symlink(link, namespaced(target));
    #[cfg(windows)]
    let _ = std::os::windows::fs::symlink_file(link, namespaced(target));
    Ok(())
}

/// `rm(target, { force: true })`: a missing path is fine, a folder is refused
fn remove_forced(target: &str) -> Step {
    match fs::symlink_metadata(namespaced(target)) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(node_error(&e, "lstat", target).into()),
        Ok(info) if info.is_dir() => Err(Fail::Other(format!(
            "Path is a directory: rm returned EISDIR (is a directory) {target}"
        ))),
        Ok(_) => match fs::remove_file(namespaced(target)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(node_error(&e, "unlink", target).into()),
        },
    }
}

/// `linkHard(dest, root, target, link)`
fn link_hard(dest: &str, root: &str, target: &str, link: &str) -> Step {
    let Some(segments) = entry_segments(link, root)? else {
        return Ok(());
    };
    let source = target_of(dest, &segments)?;
    match fs::metadata(namespaced(&source)) {
        Ok(info) if info.is_file() => {}
        _ => return Ok(()),
    }
    mkdir_p(&host::dirname(target))?;
    fs::copy(namespaced(&source), namespaced(target))
        .map_err(|e| node_error2(&e, "copyfile", &source, target))?;
    Ok(())
}
