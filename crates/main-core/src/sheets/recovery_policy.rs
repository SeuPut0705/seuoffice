//! `apps/sheets/src/main/recovery-policy.ts`: which recovery copy a workbook
//! session writes, the first Save As of a converted workbook, and the
//! migration of the unsaved new workbooks an earlier version left behind.
//!
//! What stays with the caller: the shared store ([`AdoptUntitledCopy`] is the
//! `Pick<RecoveryStore, 'adoptUntitledCopy'>` of `migrateLegacyUnsavedNew`,
//! which [`RecoveryStore`] implements), the random source behind
//! `crypto.randomUUID` for `convertedSessionRecovery`, and `console.warn`.

use std::fs;
use std::path::Path;

use jscompat::node_path::host::{basename, extname, join};
use jscompat::{JsonValue, js_regex, json_parse, sha1_hex, slice_utf16};

use crate::node_fs::{NodeError, node_error};
use crate::packages::electron_utils::atomic_write::write_json_atomic;
use crate::packages::electron_utils::recovery_store::{
    RecoveryAdoptOptions, RecoveryCopyState, RecoveryFileIdentity, RecoveryIdentity, RecoveryStore,
    RecoveryUntitledIdentity, new_untitled_recovery_id,
};

/// The current xlsx patcher materializes worksheet XML as JavaScript strings.
/// Rewriting a large entry can therefore require several times its
/// uncompressed size in the Electron main process. Automatic recovery is
/// best-effort and must not make an otherwise responsive workbook crash in the
/// background.
pub const MAX_AUTOMATIC_RECOVERY_WORKSHEET_XML_BYTES: f64 = 64.0 * 1024.0 * 1024.0;

/// Every sheet's `sourceXmlBytes` (`None` is `undefined`).
pub fn allows_automatic_workbook_recovery(source_xml_bytes: &[Option<f64>]) -> bool {
    source_xml_bytes.iter().all(|bytes| match bytes {
        None => true,
        Some(bytes) => *bytes <= MAX_AUTOMATIC_RECOVERY_WORKSHEET_XML_BYTES,
    })
}

/// what decides which recovery copy a workbook session writes; a `None` is
/// a property the session does not have (`undefined`)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RecoverySessionShape {
    pub path: String,
    pub suggest_save_as: Option<String>,
    pub unsaved_new: Option<bool>,
    pub csv_source_path: Option<String>,
    pub restore_target: Option<String>,
    pub password: Option<String>,
    /// set for an untitled workbook, a CSV or converted session (see
    /// [`converted_session_recovery`]), and a copy restored as untitled
    pub recovery_identity: Option<RecoveryIdentity>,
}

/// The document a session's recovery copy belongs to, or `None` when the
/// session has none:
/// - a password workbook never gets a copy (it would be plaintext, decision 0041);
/// - a new workbook (a temp backing file the user never saved) is untitled and
///   carries its own identity;
/// - a CSV or converted .xls/.tsv session has no original that could hold the
///   workbook bytes: it writes the untitled copy it was given when it opened
///   ([`converted_session_recovery`]), and none without one (a merge source);
/// - a restored copy or an empty original runs on a temp file and belongs to
///   the user's file (`restore_target`); anything else to the opened path.
pub fn session_recovery_identity(session: &RecoverySessionShape) -> Option<RecoveryIdentity> {
    if session.password.is_some() {
        return None;
    }
    if let Some(identity) = &session.recovery_identity {
        return Some(identity.clone());
    }
    if session.unsaved_new == Some(true) {
        return None;
    }
    if session.csv_source_path.is_some() || session.suggest_save_as.is_some() {
        return None;
    }
    Some(RecoveryIdentity::File(RecoveryFileIdentity {
        kind: "sheets".to_owned(),
        file_path: session
            .restore_target
            .clone()
            .unwrap_or_else(|| session.path.clone()),
    }))
}

/// what decides whether an opened file is a CSV or converted session
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConvertedOpenShape {
    pub csv_source_path: Option<String>,
    pub suggest_save_as: Option<String>,
    pub unsaved_new: Option<bool>,
    pub password: Option<String>,
    pub recovery_identity: Option<RecoveryIdentity>,
}

/// what [`converted_session_recovery`] answers
#[derive(Debug, Clone, PartialEq)]
pub struct ConvertedRecovery {
    pub recovery_identity: RecoveryUntitledIdentity,
    pub recovery_original_path: String,
}

/// The recovery copy a CSV or converted (.xls/.tsv) session keeps: an
/// untitled .xlsx copy that remembers the file it came from (shown in the
/// launch list, offered by the first Save As of the restored workbook). The
/// original file cannot hold the workbook bytes, so the copy never belongs to
/// its path. `None` for every other open, a password workbook included (no
/// plaintext copy). `random_uuid` is `crypto.randomUUID`.
pub fn converted_session_recovery(
    prepared: &ConvertedOpenShape,
    opened_path: &str,
    random_uuid: &dyn Fn() -> String,
) -> Option<ConvertedRecovery> {
    if prepared.password.is_some() || prepared.unsaved_new == Some(true) {
        return None;
    }
    if prepared.recovery_identity.is_some() {
        return None;
    }
    if prepared.csv_source_path.is_none() && prepared.suggest_save_as.is_none() {
        return None;
    }
    Some(ConvertedRecovery {
        recovery_identity: RecoveryUntitledIdentity {
            kind: "sheets".to_owned(),
            untitled_id: new_untitled_recovery_id(random_uuid),
            ext: ".xlsx".to_owned(),
        },
        recovery_original_path: prepared
            .csv_source_path
            .clone()
            .unwrap_or_else(|| opened_path.to_owned()),
    })
}

/// The first Save As a workbook opened from `original_path` suggests: the
/// file itself when it is a workbook, else its .xlsx sibling, which is what a
/// CSV or converted session offers before any crash.
pub fn save_as_default_for(original_path: &str) -> String {
    if js_regex!(r".xls[xm]$", "i").test(original_path) {
        return original_path.to_owned();
    }
    let ext = extname(original_path);
    let stem = if ext.is_empty() {
        original_path.to_owned()
    } else {
        // `slice(0, -ext.length)` counts UTF-16 code units
        slice_utf16(
            original_path,
            0.0,
            Some(-(ext.encode_utf16().count() as f64)),
        )
    };
    format!("{stem}.xlsx")
}

/// the extension an untitled workbook's copy is written in (its first save's format)
pub fn untitled_workbook_ext(suggest_save_as: &str) -> &'static str {
    if extname(suggest_save_as).to_lowercase() == ".xlsm" {
        ".xlsm"
    } else {
        ".xlsx"
    }
}

/// Earlier versions listed unsaved new workbooks here (their would-be paths).
pub const LEGACY_UNSAVED_NEW_INDEX: &str = "unsaved-new.json";

/// where an earlier version kept the copy of a workbook keyed by `file_path`
pub fn legacy_copy_name(file_path: &str) -> String {
    format!("{}.xlsx", &sha1_hex(file_path.as_bytes())[..16])
}

/// `Pick<RecoveryStore, 'adoptUntitledCopy'>`
pub trait AdoptUntitledCopy {
    fn adopt_untitled_copy(
        &self,
        kind: &str,
        source_path: &str,
        options: &RecoveryAdoptOptions,
    ) -> Result<Option<RecoveryUntitledIdentity>, NodeError>;
}

impl AdoptUntitledCopy for RecoveryStore<'_> {
    fn adopt_untitled_copy(
        &self,
        kind: &str,
        source_path: &str,
        options: &RecoveryAdoptOptions,
    ) -> Result<Option<RecoveryUntitledIdentity>, NodeError> {
        RecoveryStore::adopt_untitled_copy(self, kind, source_path, options)
    }
}

/// Move the unsaved new workbooks an earlier version left behind into the
/// shared store as untitled copies in state "later": the launch list offers
/// them, and they are no longer reopened at every launch. Each listed
/// would-be path's copy (named by the hash of that path, like a file copy) is
/// adopted under the path's file name as its title. Entries whose copy is
/// gone are dropped; an entry whose move failed stays listed and is retried at
/// the next call. The index file goes away once it is empty; an index that
/// cannot be read is left in place. Nothing outside the recovery folder is
/// read or written. `warn` is `console.warn`.
pub fn migrate_legacy_unsaved_new<S: AdoptUntitledCopy + ?Sized>(
    store: &S,
    recovery_dir: &str,
    warn: &dyn Fn(&str, &str),
) -> Result<Vec<RecoveryUntitledIdentity>, NodeError> {
    let index_path = join(&[recovery_dir, LEGACY_UNSAVED_NEW_INDEX]);
    if !Path::new(&index_path).exists() {
        return Ok(Vec::new());
    }
    let listed = fs::read(&index_path)
        .ok()
        .and_then(|bytes| json_parse(&String::from_utf8_lossy(&bytes)).ok());
    // Unreadable (earlier versions did not write it atomically): keep it as it
    // is rather than lose the only record of those workbooks, and go on.
    let Some(JsonValue::Array(listed)) = listed else {
        return Ok(Vec::new());
    };
    let mut paths: Vec<String> = Vec::new();
    for item in listed {
        if let JsonValue::String(path) = item
            && !path.is_empty()
            && !paths.contains(&path)
        {
            paths.push(path);
        }
    }
    let mut adopted: Vec<RecoveryUntitledIdentity> = Vec::new();
    let mut remaining: Vec<String> = Vec::new();
    for path in paths {
        let copy = join(&[recovery_dir, &legacy_copy_name(&path)]);
        if !Path::new(&copy).exists() {
            continue;
        }
        let identity = store.adopt_untitled_copy(
            "sheets",
            &copy,
            &RecoveryAdoptOptions {
                title: basename(&path, None),
                ext: untitled_workbook_ext(&path).to_owned(),
                state: Some(RecoveryCopyState::Later),
                original_path: None,
            },
        )?;
        match identity {
            Some(identity) => adopted.push(identity),
            None => remaining.push(path),
        }
    }
    let updated = if remaining.is_empty() {
        fs::remove_file(&index_path).map_err(|error| node_error(&error, "unlink", &index_path))
    } else {
        write_json_atomic(
            &index_path,
            &JsonValue::Array(remaining.into_iter().map(JsonValue::String).collect()),
        )
    };
    if let Err(error) = updated {
        warn(
            "[sheets] legacy unsaved-new index update failed:",
            &error.message,
        );
    }
    Ok(adopted)
}
