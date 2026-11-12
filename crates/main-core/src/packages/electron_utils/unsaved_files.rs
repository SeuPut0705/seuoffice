//! `packages/electron-utils/src/unsaved-files.ts`: "is this file open
//! somewhere with unsaved changes?", asked before a file is read as another
//! document's material.
//!
//! The TypeScript keeps the host's list source behind a `Symbol.for` key on
//! `globalThis`; here the holder is an explicit value the caller owns and
//! passes to every question. The source's promise is a plain call: a source
//! that throws or rejects is an `Err`.

use std::collections::HashSet;
use std::fs;

use jscompat::node_path::host::resolve;

/// what the host knows about one open document
#[derive(Debug, Clone, PartialEq)]
pub struct OpenFileState {
    /// absent for a document that was never saved
    pub file_path: Option<String>,
    pub dirty: bool,
}

/// What a failing source (or a list the loop cannot read) comes to: the
/// TypeScript's `catch` answers 'unknown' for every one of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenFilesSourceFailed;

/// `OpenFilesSource`. The error of a source call, and of reading an entry of
/// its list (a `null` entry, a path `resolve` refuses), is [`OpenFilesSourceFailed`].
pub type OpenFilesSource = Box<dyn Fn() -> Result<Vec<OpenFileState>, OpenFilesSourceFailed>>;

/// what a refused read answers with; the caller's own error path carries it
pub const UNSAVED_CHANGES_MESSAGE: &str =
    "This file is open with unsaved changes. Save it, then try again.";

/// The `Symbol.for('seuoffice.open-files-source')` slot.
#[derive(Default)]
pub struct OpenFilesHolder {
    source: Option<OpenFilesSource>,
}

impl OpenFilesHolder {
    pub fn new() -> Self {
        Self::default()
    }

    /// the host's list of open documents; `None` removes it
    pub fn set_open_files_source(&mut self, source: Option<OpenFilesSource>) {
        self.source = source;
    }
}

/// one spelling per file: resolved, through links, case-folded where the disk is
fn path_key(value: &str) -> String {
    let mut resolved = resolve(&[value]);
    // realpathSync.native: a moved or deleted file compares as resolved
    if let Ok(real) = fs::canonicalize(&resolved) {
        let real = real.to_string_lossy().into_owned();
        // std adds the verbatim prefix on Windows; realpath does not
        resolved = match real.strip_prefix(r"\\?\") {
            Some(rest) if !rest.starts_with(r"UNC\") => rest.to_owned(),
            _ => real,
        };
    }
    if cfg!(windows) {
        resolved.to_lowercase()
    } else {
        resolved
    }
}

enum Unsaved {
    /// no source: nothing is blocked
    NoSource,
    /// the host could not say
    Unknown,
    Keys(HashSet<String>),
}

fn unsaved_keys(holder: &OpenFilesHolder) -> Unsaved {
    let Some(source) = &holder.source else {
        return Unsaved::NoSource;
    };
    let Ok(docs) = source() else {
        return Unsaved::Unknown;
    };
    let mut keys = HashSet::new();
    for doc in docs {
        if doc.dirty
            && let Some(path) = doc.file_path.as_deref().filter(|path| !path.is_empty())
        {
            keys.insert(path_key(path));
        }
    }
    Unsaved::Keys(keys)
}

pub fn file_has_unsaved_changes(holder: &OpenFilesHolder, file_path: &str) -> bool {
    match unsaved_keys(holder) {
        Unsaved::NoSource => false,
        Unsaved::Unknown => true,
        Unsaved::Keys(keys) => keys.contains(&path_key(file_path)),
    }
}

/// `Err(UNSAVED_CHANGES_MESSAGE)` for a file that must be saved before it is read
pub fn assert_file_saved(holder: &OpenFilesHolder, file_path: &str) -> Result<(), &'static str> {
    if file_has_unsaved_changes(holder, file_path) {
        Err(UNSAVED_CHANGES_MESSAGE)
    } else {
        Ok(())
    }
}

/// the items whose file is not open with unsaved changes, in their order
pub fn without_unsaved_files<T: Clone>(
    holder: &OpenFilesHolder,
    items: &[T],
    path_of: impl Fn(&T) -> String,
) -> Vec<T> {
    match unsaved_keys(holder) {
        Unsaved::NoSource => items.to_vec(),
        Unsaved::Unknown => Vec::new(),
        Unsaved::Keys(keys) => items
            .iter()
            .filter(|item| !keys.contains(&path_key(&path_of(item))))
            .cloned()
            .collect(),
    }
}
