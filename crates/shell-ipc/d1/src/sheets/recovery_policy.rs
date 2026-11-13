//! `apps/sheets/src/main/recovery-policy.ts`: which recovery copy a workbook
//! session writes, and the Save As defaults of a CSV or converted session.

use jscompat::js_regex;
use jscompat::node_path::host::extname;
use main_core::packages::electron_utils::recovery_store::{
    RecoveryIdentity, RecoveryUntitledIdentity,
};

use super::engine::OpenedSheet;
use super::session::{OpenOptions, SessionInfo, file_identity};

/// `MAX_AUTOMATIC_RECOVERY_WORKSHEET_XML_BYTES`
pub const MAX_AUTOMATIC_RECOVERY_WORKSHEET_XML_BYTES: f64 = 64.0 * 1024.0 * 1024.0;

pub fn allows_automatic_workbook_recovery(sheets: &[OpenedSheet]) -> bool {
    sheets.iter().all(|sheet| {
        sheet
            .source_xml_bytes
            .is_none_or(|bytes| bytes <= MAX_AUTOMATIC_RECOVERY_WORKSHEET_XML_BYTES)
    })
}

/// The document a session's recovery copy belongs to, or `None` when it has
/// none (`sessionRecoveryIdentity`)
pub fn session_recovery_identity(session: &SessionInfo) -> Option<RecoveryIdentity> {
    if session.password.is_some() {
        return None;
    }
    if let Some(identity) = &session.recovery_identity {
        return Some(identity.clone());
    }
    if session.unsaved_new {
        return None;
    }
    if session.csv_source_path.is_some() || session.suggest_save_as.is_some() {
        return None;
    }
    Some(file_identity(
        session.restore_target.as_deref().unwrap_or(&session.path),
    ))
}

/// What `convertedSessionRecovery` answers
#[derive(Clone, Debug, PartialEq)]
pub struct ConvertedRecovery {
    pub recovery_identity: RecoveryIdentity,
    pub recovery_original_path: String,
}

/// The recovery copy a CSV or converted session keeps: an untitled .xlsx copy
/// that remembers the file it came from
pub fn converted_session_recovery(
    prepared: &OpenOptions,
    opened_path: &str,
    new_untitled_id: impl FnOnce() -> String,
) -> Option<ConvertedRecovery> {
    if prepared.password.is_some() || prepared.unsaved_new {
        return None;
    }
    if prepared.recovery_identity.is_some() {
        return None;
    }
    if prepared.csv_source_path.is_none() && prepared.suggest_save_as.is_none() {
        return None;
    }
    Some(ConvertedRecovery {
        recovery_identity: RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
            kind: "sheets".into(),
            untitled_id: new_untitled_id(),
            ext: ".xlsx".into(),
        }),
        recovery_original_path: prepared
            .csv_source_path
            .clone()
            .unwrap_or_else(|| opened_path.to_owned()),
    })
}

/// The first Save As a workbook opened from `original_path` suggests
pub fn save_as_default_for(original_path: &str) -> String {
    // `/.xls[xm]$/i`: the first dot is any character, as the TypeScript wrote it
    if js_regex!(r".xls[xm]$", "i").test(original_path) {
        return original_path.to_owned();
    }
    let ext = extname(original_path);
    let stem = if ext.is_empty() {
        original_path
    } else {
        &original_path[..original_path.len() - ext.len()]
    };
    format!("{stem}.xlsx")
}

/// the extension an untitled workbook's copy is written in
pub fn untitled_workbook_ext(suggest_save_as: &str) -> &'static str {
    if extname(suggest_save_as).to_lowercase() == ".xlsm" {
        ".xlsm"
    } else {
        ".xlsx"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_follow_the_open_kind() {
        let mut session = SessionInfo {
            path: "/tmp/a.xlsx".into(),
            ..SessionInfo::default()
        };
        assert_eq!(
            session_recovery_identity(&session),
            Some(file_identity("/tmp/a.xlsx"))
        );
        session.restore_target = Some("/docs/a.xlsx".into());
        assert_eq!(
            session_recovery_identity(&session),
            Some(file_identity("/docs/a.xlsx"))
        );
        session.suggest_save_as = Some("/docs/a.xlsx".into());
        session.restore_target = None;
        assert_eq!(session_recovery_identity(&session), None);
        session.password = Some("x".into());
        session.recovery_identity = Some(file_identity("/z"));
        assert_eq!(session_recovery_identity(&session), None);
    }

    #[test]
    fn save_as_defaults() {
        assert_eq!(save_as_default_for("/a/b.csv"), "/a/b.xlsx");
        assert_eq!(save_as_default_for("/a/b.XLSM"), "/a/b.XLSM");
        assert_eq!(save_as_default_for("/a/b"), "/a/b.xlsx");
        assert_eq!(untitled_workbook_ext("/a/b.xlsm"), ".xlsm");
        assert_eq!(untitled_workbook_ext("/a/b.csv"), ".xlsx");
    }
}
