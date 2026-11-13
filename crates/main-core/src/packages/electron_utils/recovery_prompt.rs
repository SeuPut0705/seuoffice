//! `packages/electron-utils/src/recovery-prompt.ts`: the per-file recovery
//! prompt, asked when a document with an undecided or "later" recovery copy
//! is opened, before its content is loaded.
//!
//! The dialog is a [`MessageBox`] and the parent window a [`ParentWindow`]
//! (`message_box.rs`). Promises are plain calls.

use jscompat::node_path::host::basename;

use super::message_box::{MessageBox, MessageBoxOptions, ParentWindow, show_over_open_parent};
use super::recovery_labels::recovery_prompt_labels;
use super::recovery_store::{
    RecoveryCopyInfo, RecoveryDeleteReason, RecoveryIdentity, RecoveryOpenPlan, RecoveryStore,
};
use crate::node_fs::NodeError;

pub struct RecoveryPromptOptions<'a, D, W> {
    pub dialog: &'a D,
    /// the window the box sits over; None or destroyed shows it unparented
    pub parent: Option<&'a W>,
    /// shown in the message (normally the file name)
    pub document_name: &'a str,
    /// the file on disk is newer than the copy
    pub file_changed_after_copy: bool,
    /// UI language (raw locale tags accepted)
    pub lang: &'a str,
}

const RESTORE: u32 = 0;
const DISCARD: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryPromptAnswer {
    Restore,
    Discard,
}

pub fn prompt_recovery_for_file<D, W>(
    options: &RecoveryPromptOptions<'_, D, W>,
) -> RecoveryPromptAnswer
where
    D: MessageBox<W>,
    W: ParentWindow,
{
    let labels = recovery_prompt_labels(options.lang, options.document_name);
    let detail = if options.file_changed_after_copy {
        format!("{}\n\n{}", labels.detail, labels.file_changed)
    } else {
        labels.detail.clone()
    };
    let message_box = MessageBoxOptions {
        kind: "question",
        title: None,
        message: labels.message,
        detail: Some(detail),
        buttons: vec![labels.restore, labels.discard],
        default_id: RESTORE,
        // Esc and the window's close button answer cancelId: restore, so nothing is lost
        cancel_id: Some(RESTORE),
        no_link: Some(true),
    };
    let response = show_over_open_parent(options.dialog, options.parent, &message_box);
    if response == f64::from(DISCARD) {
        RecoveryPromptAnswer::Discard
    } else {
        RecoveryPromptAnswer::Restore
    }
}

pub struct ResolveRecoveryOnOpenOptions<'a, 's, D, W> {
    pub store: &'a RecoveryStore<'s>,
    pub identity: &'a RecoveryIdentity,
    pub dialog: &'a D,
    pub parent: Option<&'a W>,
    pub lang: &'a str,
    /// defaults to the file name (or the copy's title for an untitled copy)
    pub document_name: Option<&'a str>,
}

/// `RecoveryOpenResult`
#[derive(Debug, Clone, PartialEq)]
pub enum RecoveryOpenResult {
    /// open the file as saved (no copy, or the copy was discarded)
    Original,
    /// open `bytes` (the copy's content); the original path stays the tab's path
    Restore {
        bytes: Vec<u8>,
        copy: Box<RecoveryCopyInfo>,
    },
}

/// Everything an editor does about recovery when it opens a document: no copy
/// -> original; "restore" already chosen -> the copy without asking;
/// otherwise the per-file prompt. Restoring marks the copy loaded;
/// discarding deletes it. A copy that cannot be read falls back to the
/// original and is kept.
pub fn resolve_recovery_on_open<D, W>(
    options: &ResolveRecoveryOnOpenOptions<'_, '_, D, W>,
) -> Result<RecoveryOpenResult, NodeError>
where
    D: MessageBox<W>,
    W: ParentWindow,
{
    let store = options.store;
    let identity = options.identity;
    let plan = store.open_plan(identity)?;
    let copy = match plan {
        RecoveryOpenPlan::None => return Ok(RecoveryOpenResult::Original),
        RecoveryOpenPlan::Ask(copy) => {
            let document_name = match options.document_name {
                Some(name) => name.to_owned(),
                None => match identity {
                    RecoveryIdentity::Untitled(_) => copy.title.clone(),
                    RecoveryIdentity::File(f) => basename(&f.file_path, None),
                },
            };
            let answer = prompt_recovery_for_file(&RecoveryPromptOptions {
                dialog: options.dialog,
                parent: options.parent,
                document_name: &document_name,
                file_changed_after_copy: copy.file_changed_after_copy,
                lang: options.lang,
            });
            if answer == RecoveryPromptAnswer::Discard {
                store.delete_copy(identity, RecoveryDeleteReason::Discarded)?;
                return Ok(RecoveryOpenResult::Original);
            }
            copy
        }
        RecoveryOpenPlan::Restore(copy) => copy,
    };
    let Some(bytes) = store.read_copy(identity) else {
        return Ok(RecoveryOpenResult::Original);
    };
    store.mark_copy_loaded(identity)?;
    Ok(RecoveryOpenResult::Restore {
        bytes,
        copy: Box::new(copy),
    })
}
