//! `apps/shell/src/main/tab-duplicate.ts`.

use std::path::Path;

use jscompat::node_path::host::{basename, dirname, extname, join};

use crate::node_fs::NodeError;
use crate::packages::electron_utils::atomic_write::atomic_copy_file;

/// `DuplicateFileDeps`
pub struct DuplicateFileDeps<'a> {
    pub copy_suffix: &'a str,
    pub record_recent_file: &'a mut dyn FnMut(&str),
    pub on_error: &'a mut dyn FnMut(&NodeError),
}

/// `duplicateDocumentFile`: copies `path` to the first free
/// `<base> <suffix>[ n]<ext>` beside it. `None` is `undefined` (the copy
/// failed and `onError` was told).
pub fn duplicate_document_file(path: &str, deps: DuplicateFileDeps<'_>) -> Option<String> {
    let DuplicateFileDeps {
        copy_suffix,
        record_recent_file,
        on_error,
    } = deps;
    let ext = extname(path);
    let base = basename(path, Some(&ext));
    let mut i: u64 = 1;
    loop {
        let numbered = if i == 1 {
            String::new()
        } else {
            format!(" {i}")
        };
        let dir = dirname(path);
        let name = format!("{base} {copy_suffix}{numbered}{ext}");
        let target = join(&[dir.as_str(), name.as_str()]);
        if Path::new(&target).exists() {
            i += 1;
            continue;
        }
        if let Err(error) = atomic_copy_file(path, &target) {
            on_error(&error);
            return None;
        }
        record_recent_file(&target);
        return Some(target);
    }
}
