//! `packages/electron-utils/src/generated-images.ts`.
//!
//! `os.tmpdir()` is a parameter (`tmpdir`), `Date.now()` is `now_ms`. The
//! two `node:url` functions the TypeScript uses, `pathToFileURL` and
//! `fileURLToPath`, are ported here too ([`path_to_file_url`],
//! [`file_url_to_path`]) for `permission_guard`.

use std::fs;
use std::io::Write;

use jscompat::node_path::host;
use jscompat::{decode_uri_component, js_regex, number_to_string, random_uuid};
use url::Url;

use crate::node_fs::{NodeError, node_error};
use crate::shell::recent_files::StatInfo;

const DIR_NAME: &str = "seuoffice-ai-images";

/// `GENERATED_IMAGE_DIR` for a given `os.tmpdir()`.
pub fn generated_image_dir(tmpdir: &str) -> String {
    host::join(&[tmpdir, DIR_NAME])
}

/// `MIME_BY_EXT[ext] ?? 'image/png'`; the extension is one `FILE_NAME_RE` allows.
fn mime_by_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

/// `EXT_BY_MIME[label.toLowerCase()] ?? 'png'`, as the template literal reads
/// it. The table is a plain object, so a label that names an inherited
/// property of `Object.prototype` finds that (a function, whose source text
/// goes into the file name, or the prototype object itself), not the default.
fn ext_by_mime(label: &str) -> String {
    let lowered = label.to_lowercase();
    let found = match lowered.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "constructor" => "function Object() { [native code] }",
        "__defineGetter__" => "function __defineGetter__() { [native code] }",
        "__defineSetter__" => "function __defineSetter__() { [native code] }",
        "hasOwnProperty" => "function hasOwnProperty() { [native code] }",
        "__lookupGetter__" => "function __lookupGetter__() { [native code] }",
        "__lookupSetter__" => "function __lookupSetter__() { [native code] }",
        "isPrototypeOf" => "function isPrototypeOf() { [native code] }",
        "propertyIsEnumerable" => "function propertyIsEnumerable() { [native code] }",
        "toString" => "function toString() { [native code] }",
        "valueOf" => "function valueOf() { [native code] }",
        "__proto__" => "[object Object]",
        "toLocaleString" => "function toLocaleString() { [native code] }",
        _ => "png",
    };
    found.to_owned()
}

const FILE_NAME_PATTERN: &str =
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$";

fn is_image_file_name(name: &str) -> bool {
    js_regex!(FILE_NAME_PATTERN).test(name)
}

const MAX_AGE_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// Single-image byte budget: BYOK bytes land in tmpdir, so the cache stays bounded.
pub const MAX_GENERATED_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

/// MIME label budget: overlong labels fall back to png instead of reaching file names.
const MAX_MIME_LENGTH: usize = 128;

/// Best-effort sweep of yesterday's images; the directory is a cache, not a document store
fn prune_old(dir: &str, now: f64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries {
        let Ok(entry) = entry else { return };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !is_image_file_name(&name) {
            continue;
        }
        let path = host::join(&[dir, &name]);
        // another process may have removed it
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if now - StatInfo::of(&meta).mtime_ms > MAX_AGE_MS {
            let _ = fs::remove_file(&path);
        }
    }
}

/// What `storeGeneratedImage` throws.
#[derive(Debug, Clone, PartialEq)]
pub enum StoreError {
    /// an `Error` the function raises itself
    Plain(String),
    /// a Node file error
    Node(NodeError),
}

impl StoreError {
    pub fn code(&self) -> Option<&'static str> {
        match self {
            StoreError::Plain(_) => None,
            StoreError::Node(e) => e.code,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            StoreError::Plain(message) => message,
            StoreError::Node(e) => &e.message,
        }
    }
}

/// `storeGeneratedImage(bytes, mime)`: the `file:` URL of the stored picture.
/// `bytes` is `None` where the TypeScript is given something that is not a
/// `Uint8Array`; `mime` is `None` where it is not a string.
pub fn store_generated_image(
    tmpdir: &str,
    now_ms: f64,
    bytes: Option<&[u8]>,
    mime: Option<&str>,
) -> Result<String, StoreError> {
    let bytes = match bytes {
        Some(bytes) if !bytes.is_empty() => bytes,
        _ => {
            return Err(StoreError::Plain(
                "generated image bytes must be a non-empty buffer".to_owned(),
            ));
        }
    };
    if bytes.len() as u64 > MAX_GENERATED_IMAGE_BYTES {
        return Err(StoreError::Plain(format!(
            "generated image too large (limit {} bytes)",
            number_to_string(MAX_GENERATED_IMAGE_BYTES as f64)
        )));
    }
    // `mime.length` counts UTF-16 code units
    let label = match mime {
        Some(mime) if mime.encode_utf16().count() <= MAX_MIME_LENGTH => mime,
        _ => "",
    };
    let ext = ext_by_mime(label);
    let dir = generated_image_dir(tmpdir);
    fs::create_dir_all(&dir).map_err(|e| StoreError::Node(node_error(&e, "mkdir", &dir)))?;
    prune_old(&dir, now_ms);
    let path = host::join(&[&dir, &format!("{}.{}", random_uuid(), ext)]);
    let mut file =
        fs::File::create(&path).map_err(|e| StoreError::Node(node_error(&e, "open", &path)))?;
    file.write_all(bytes)
        .map_err(|e| StoreError::Node(node_error(&e, "write", &path)))?;
    Ok(path_to_file_url(&path).to_string())
}

/// A picture read back from the store.
#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedImage {
    pub bytes: Vec<u8>,
    pub mime: String,
}

/// Reads a `file:` URL back only when it names an image this store wrote:
/// inside the store's folder, uuid-named, image extension. Returns none for
/// every other URL so a prompt-injected `file:///etc/passwd` never gets read.
pub fn read_generated_image(tmpdir: &str, raw_url: &str) -> Option<GeneratedImage> {
    let url = Url::parse(raw_url).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    let local = file_url_to_path(&url, cfg!(windows))?;
    let path = host::resolve(&[local.as_str()]);
    let dir = host::resolve(&[&generated_image_dir(tmpdir)]);
    if !path.starts_with(&format!("{}{}", dir, host::SEP)) {
        return None;
    }
    let name = host::basename(&path, None);
    if !is_image_file_name(&name) || path != host::join(&[&dir, &name]) {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    let ext = &name[name.rfind('.')? + 1..];
    Some(GeneratedImage {
        bytes,
        mime: mime_by_ext(ext).to_owned(),
    })
}

/// `pathToFileURL(path)` of Node 22: the path resolved, each character of the
/// table below written as a percent escape, then parsed as `file://` and the
/// rest.
///
/// [INFERENCE] the Windows branch (drive paths and `\\host\share` paths) is
/// written from the documented behaviour; the comparison runs on POSIX.
pub fn path_to_file_url(path: &str) -> Url {
    let windows = cfg!(windows);
    if windows && path.starts_with("\\\\") {
        // \\host\share\file: the first segment is the host
        let rest = &path[2..];
        let (host_part, tail) = match rest.find('\\') {
            Some(at) => (&rest[..at], &rest[at..]),
            None => (rest, ""),
        };
        let mut url = Url::parse("file://").expect("an empty file URL parses");
        let _ = url.set_host(Some(&url::quirks::domain_to_ascii(host_part)));
        url.set_path(&encode_path_chars(tail, true));
        return url;
    }
    let mut resolved = if windows {
        jscompat::node_path::win32::resolve(&[path])
    } else {
        jscompat::node_path::posix::resolve(&[path])
    };
    // path.resolve strips trailing slashes so we must add them back
    let last = path.chars().last();
    let sep = if windows { "\\" } else { "/" };
    if (last == Some('/') || (windows && last == Some('\\'))) && !resolved.ends_with(sep) {
        resolved.push('/');
    }
    let encoded = encode_path_chars(&resolved, windows);
    let text = if windows && !encoded.starts_with('/') {
        format!("file:///{encoded}")
    } else {
        format!("file://{encoded}")
    };
    Url::parse(&text).expect("an encoded absolute path parses as a file URL")
}

/// The characters of a path the URL parser would read as something else, as
/// percent escapes.
fn encode_path_chars(path: &str, windows: bool) -> String {
    let mut out = String::with_capacity(path.len());
    for c in path.chars() {
        match c {
            '\0' => out.push_str("%00"),
            '\t' => out.push_str("%09"),
            '\n' => out.push_str("%0A"),
            '\r' => out.push_str("%0D"),
            ' ' => out.push_str("%20"),
            '"' => out.push_str("%22"),
            '#' => out.push_str("%23"),
            '%' => out.push_str("%25"),
            '?' => out.push_str("%3F"),
            '[' => out.push_str("%5B"),
            '\\' => out.push_str(if windows { "/" } else { "%5C" }),
            ']' => out.push_str("%5D"),
            '^' => out.push_str("%5E"),
            '|' => out.push_str("%7C"),
            '~' => out.push_str("%7E"),
            other => out.push(other),
        }
    }
    out
}

/// `fileURLToPath(url)` of Node 22 for a URL that is already parsed; none
/// where Node throws (the scheme is not `file:`, a host a POSIX path cannot
/// have, an encoded separator, a malformed escape, a path without a drive on
/// Windows). `windows` is Node's `windows` option, the platform by default.
///
/// [INFERENCE] the Windows branch is written from Node's source as recalled;
/// the comparison runs on POSIX.
pub fn file_url_to_path(url: &Url, windows: bool) -> Option<String> {
    if url.scheme() != "file" {
        return None;
    }
    let hostname = url.host_str().unwrap_or("");
    let pathname = url.path();
    if !windows {
        if !hostname.is_empty() {
            return None;
        }
        if has_encoded(pathname, b"2f") {
            return None;
        }
        return decode_uri_component(pathname).ok();
    }
    if has_encoded(pathname, b"2f") || has_encoded(pathname, b"5c") {
        return None;
    }
    let pathname = decode_uri_component(&pathname.replace('/', "\\")).ok()?;
    if !hostname.is_empty() {
        // a UNC path; the host goes through domainToUnicode in case it is punycode
        return Some(format!(
            "\\\\{}{}",
            url::quirks::domain_to_unicode(hostname),
            pathname
        ));
    }
    // a local path needs a drive letter
    let units: Vec<u16> = pathname.encode_utf16().collect();
    let letter = code_point_at(&units, 1) | 0x20;
    let separator = units.get(2).copied();
    if !(u32::from(b'a')..=u32::from(b'z')).contains(&letter) || separator != Some(u16::from(b':'))
    {
        return None;
    }
    Some(String::from_utf16_lossy(&units[1..]))
}

/// `StringPrototypeCodePointAt(text, at) | 0x20` reads `undefined` as 0.
fn code_point_at(units: &[u16], at: usize) -> u32 {
    match units.get(at) {
        None => 0,
        Some(&high) if (0xD800..0xDC00).contains(&high) => match units.get(at + 1) {
            Some(&low) if (0xDC00..0xE000).contains(&low) => {
                0x10000 + ((u32::from(high) - 0xD800) << 10) + (u32::from(low) - 0xDC00)
            }
            _ => u32::from(high),
        },
        Some(&unit) => u32::from(unit),
    }
}

/// `%` followed by the two characters `digits` (the second one in either case).
fn has_encoded(pathname: &str, digits: &[u8; 2]) -> bool {
    let bytes = pathname.as_bytes();
    (0..bytes.len()).any(|n| {
        bytes[n] == b'%'
            && bytes.get(n + 1) == Some(&digits[0])
            && bytes.get(n + 2).is_some_and(|b| *b | 0x20 == digits[1])
    })
}
