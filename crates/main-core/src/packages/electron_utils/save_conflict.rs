//! `packages/electron-utils/src/save-conflict.ts`: the same-document save
//! guard of the editor mains (sheets, slides, PDF, markdown, HTML, mindmap,
//! HWP).
//!
//! When the same document is open in two split panes, a manual save of one
//! copy asks before it overwrites a change the other copy made on disk since
//! this copy last read or wrote the file; autosave defers silently instead.
//! The guard only judges copy pairs: a path open nowhere else saves as
//! before. This module decides whether to write; it never writes.
//!
//! The shell's "is this path open in another pane" probe, which the
//! TypeScript keeps on `globalThis`, is an argument: the host holds it. The
//! dialog is a [`MessageBox`].

use std::fs;

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::message_box::{MessageBox, MessageBoxOptions, ParentWindow, show_over_open_parent};
use super::save_conflict_labels::save_conflict_labels;
use crate::node_fs::namespaced;
use crate::shell::recent_files::StatInfo;

/// `SaveDiskState`: the disk snapshot recorded when a copy last read or wrote
/// a document path.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDiskState {
    pub mtime_ms: f64,
    pub size: f64,
    pub hash: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `stat` of the path, as `mtimeMs` and `size`
fn stat(path: &str) -> Option<(f64, f64)> {
    let meta = fs::metadata(namespaced(path)).ok()?;
    let info = StatInfo::of(&meta);
    Some((info.mtime_ms, info.size as f64))
}

fn read(path: &str) -> Option<Vec<u8>> {
    fs::read(namespaced(path)).ok()
}

/// `recordDiskState(path)`: stat and content hash of the file, or `None` when
/// it is not a readable file.
pub fn record_disk_state(path: &str) -> Option<SaveDiskState> {
    let (mtime_ms, size) = stat(path)?;
    let bytes = read(path)?;
    Some(SaveDiskState {
        mtime_ms,
        size,
        hash: sha256_hex(&bytes),
    })
}

/// `isModifiedSince(recorded, path)`: the file on disk no longer matches the
/// record. No record or a missing file is not a conflict, equal mtime and
/// size skip the reread, and only a differing mtime or size falls through to
/// the hash.
pub fn is_modified_since(recorded: Option<&SaveDiskState>, path: &str) -> bool {
    let Some(recorded) = recorded else {
        return false;
    };
    let Some((mtime_ms, size)) = stat(path) else {
        return false;
    };
    if mtime_ms == recorded.mtime_ms && size == recorded.size {
        return false;
    }
    read(path).is_some_and(|bytes| sha256_hex(&bytes) != recorded.hash)
}

/// The probe threw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProbeThrew;

/// `OpenPathProbe`: the shell's answer to "is this path open in another
/// pane"; `Ok(true)` stands for the probe answering `true` itself
pub type OpenPathProbe<'a> = &'a dyn Fn(&str) -> Result<bool, ProbeThrew>;

/// `isPathOpenElsewhere(path)`: without a probe (an editor running on its
/// own) nothing is open elsewhere, and a broken probe counts as "no sibling
/// copy", so a normal save is never interrupted.
pub fn is_path_open_elsewhere(probe: Option<OpenPathProbe<'_>>, path: &str) -> bool {
    probe.is_some_and(|probe| probe(path).unwrap_or(false))
}

/// `SaveConflictOptions`, with the probe and the dialog the TypeScript reads
/// from the process
pub struct SaveConflictOptions<'a, D: ?Sized, W> {
    pub probe: Option<OpenPathProbe<'a>>,
    pub dialog: &'a D,
    /// the window the prompt should sit over; `None` shows it without a parent
    pub parent: Option<&'a W>,
    pub path: &'a str,
    /// this copy's disk state, from its last read or write of the path
    pub recorded: Option<&'a SaveDiskState>,
    pub lang: &'a str,
}

/// the answer of `confirmOverwriteIfConflicted`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SaveConflictAnswer {
    Proceed,
    Cancel,
}

/// `confirmOverwriteIfConflicted(options)`: `Proceed` when nothing should
/// stop the write (the path is open nowhere else, the disk still matches the
/// record, or the user chose to overwrite), `Cancel` when the user chose to
/// keep the disk copy.
pub fn confirm_overwrite_if_conflicted<D, W>(
    options: &SaveConflictOptions<'_, D, W>,
) -> SaveConflictAnswer
where
    D: MessageBox<W> + ?Sized,
    W: ParentWindow,
{
    if !is_path_open_elsewhere(options.probe, options.path) {
        return SaveConflictAnswer::Proceed;
    }
    if !is_modified_since(options.recorded, options.path) {
        return SaveConflictAnswer::Proceed;
    }
    let labels = save_conflict_labels(options.lang);
    let message_box = MessageBoxOptions {
        kind: "warning",
        title: None,
        message: labels.message,
        detail: Some(labels.detail),
        buttons: vec![labels.overwrite, labels.cancel],
        default_id: 0,
        cancel_id: Some(1),
        no_link: Some(true),
    };
    if show_over_open_parent(options.dialog, options.parent, &message_box) == 0.0 {
        SaveConflictAnswer::Proceed
    } else {
        SaveConflictAnswer::Cancel
    }
}

/// `shouldDeferAutoSave(path, recorded)`: a silent (auto) save is skipped
/// exactly when a manual save would raise the prompt.
pub fn should_defer_auto_save(
    probe: Option<OpenPathProbe<'_>>,
    path: &str,
    recorded: Option<&SaveDiskState>,
) -> bool {
    if !is_path_open_elsewhere(probe, path) {
        return false;
    }
    is_modified_since(recorded, path)
}
