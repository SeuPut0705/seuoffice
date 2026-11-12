//! `apps/hwp/src/main/save-plan.ts`: where the bytes a save replaces are kept,
//! when a file is backed up, and the last check before bytes replace a file.

use std::collections::HashSet;

use jscompat::js_regex;

use super::ipc::HwpFormat;

/// Where the bytes a save is about to replace are kept. Beside the document so
/// the user can find it without the app.
pub fn backup_path_for(path: &str) -> String {
    format!("{path}.bak")
}

/// A file is backed up the first time a view overwrites it. Later saves in the
/// same session replace bytes this app already wrote, and a file the save
/// creates has nothing to keep.
pub fn needs_backup(target: &str, target_exists: bool, written: &HashSet<String>) -> bool {
    target_exists && !written.contains(target)
}

/// HWPX is a ZIP container.
const ZIP_MAGIC: [u8; 4] = [0x50, 0x4b, 0x03, 0x04];
/// HWP 5 is an OLE compound file.
const OLE_MAGIC: [u8; 8] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/// The last check before bytes replace a user's file: they must at least be a
/// container of the format the file name promises.
pub fn bytes_match_format(bytes: &[u8], format: HwpFormat) -> bool {
    let magic: &[u8] = match format {
        HwpFormat::Hwpx => &ZIP_MAGIC,
        HwpFormat::Hwp => &OLE_MAGIC,
    };
    if bytes.len() < magic.len() {
        return false;
    }
    magic
        .iter()
        .enumerate()
        .all(|(index, byte)| bytes[index] == *byte)
}

/// Save As may return a name with no usable extension; keep the document's current format then.
pub fn with_format_extension(path: &str, fallback: HwpFormat) -> String {
    if js_regex!(r"\.(hwpx?)$", "i").test(path) {
        path.to_owned()
    } else {
        format!("{path}.{}", fallback.as_str())
    }
}
