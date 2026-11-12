//! `apps/shell/src/main/rename-validation.ts`.

use jscompat::{JsRegex, js_regex, trim};

/// Name characters Windows forbids (plus controls): `RENAME_ILLEGAL_NAME_CHARS`.
pub fn rename_illegal_name_chars() -> &'static JsRegex {
    js_regex!(r#"[\\/:*?"<>|\u0000-\u001f]"#)
}

/// Windows device names reserved with or without an extension (CON.pdf is still CON).
fn rename_reserved_base() -> &'static JsRegex {
    js_regex!(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$", "i")
}

/// True when the raw requested name is usable: surrounding whitespace is
/// rejected instead of silently trimmed.
pub fn is_valid_raw_rename_name(new_name: &str) -> bool {
    if new_name != trim(new_name) {
        return false;
    }
    is_valid_rename_name(trim(new_name))
}

/// True when the trimmed name is usable as a file name.
pub fn is_valid_rename_name(name: &str) -> bool {
    // `name.length` counts UTF-16 code units
    let length = name.encode_utf16().count();
    if length == 0 || length > 255 {
        return false;
    }
    if rename_illegal_name_chars().test(name) {
        return false;
    }
    // Windows strips trailing dots/spaces: renaming to "file." lands elsewhere
    if name.ends_with('.') || name.ends_with(' ') {
        return false;
    }
    if rename_reserved_base().test(name) {
        return false;
    }
    true
}

/// True when both paths resolve to the same on-disk file (same device +
/// inode, as `fs.statSync` reports them). A stat that fails answers false.
pub fn is_same_file(a: &str, b: &str) -> bool {
    match (file_identity(a), file_identity(b)) {
        (Some(ia), Some(ib)) => ia == ib,
        _ => false,
    }
}

/// `(stat.dev, stat.ino)` as Node hands them out: doubles.
#[cfg(unix)]
pub fn file_identity(path: &str) -> Option<(f64, f64)> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.dev() as f64, meta.ino() as f64))
}

/// `(stat.dev, stat.ino)` as libuv's `stat` reads them on Windows: the volume
/// serial number and the 64-bit file index, from a handle opened for its
/// attributes alone, following links, with backup semantics so a folder opens.
/// Two hard links to one file answer alike, which a path comparison would not.
#[cfg(windows)]
pub fn file_identity(path: &str) -> Option<(f64, f64)> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
    };
    let file = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;
    // SAFETY: the handle is open for the duration of the call and `info` is a
    // plain struct the call fills in
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return None;
    }
    let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Some((f64::from(info.dwVolumeSerialNumber), index as f64))
}

/// Save As target for an open PDF, or `None` when the dialog was cancelled or
/// the pick resolves to the open file itself (case/symlink variants included).
pub fn pdf_save_as_target(
    canceled: bool,
    file_path: Option<&str>,
    current_path: &str,
) -> Option<String> {
    if canceled {
        return None;
    }
    let file_path = file_path.filter(|p| !p.is_empty())?;
    if file_path == current_path || is_same_file(file_path, current_path) {
        return None;
    }
    Some(file_path.to_owned())
}
