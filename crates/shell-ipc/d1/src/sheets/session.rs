//! `SessionInfo` of sheets-main.ts and its siblings: what a tab remembers per
//! open workbook, and the JSON form `main-core`'s session modules read.

use main_core::packages::electron_utils::recovery_store::{
    RecoveryFileIdentity, RecoveryIdentity, RecoveryUntitledIdentity,
};
use main_core::packages::electron_utils::save_conflict::SaveDiskState;
use serde_json::{Map, Value};

/// `SessionInfo`
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionInfo {
    pub path: String,
    /// byte-for-byte copy of the file as it was opened (in the OS temp dir)
    pub snapshot_path: String,
    pub sha256: String,
    /// sheet id to file sheet name, in the order the sidecar listed them
    pub sheet_names: Vec<(String, String)>,
    pub automatic_recovery_disabled: bool,
    pub suggest_save_as: Option<String>,
    pub ods_converted: bool,
    pub formulas_dropped: Option<f64>,
    pub ods_source_path: Option<String>,
    pub unsaved_new: bool,
    pub csv_import: bool,
    pub csv_source_path: Option<String>,
    pub csv_source_sha: Option<String>,
    pub import_temp_dir: Option<String>,
    pub restore_target: Option<String>,
    pub restore_target_sha: Option<String>,
    pub empty_source: bool,
    pub password: Option<String>,
    pub recovery_identity: Option<RecoveryIdentity>,
    pub recovery_original_path: Option<String>,
    pub unsaved_restore: bool,
    pub disk_state: Option<(String, SaveDiskState)>,
}

/// `RecoveryIdentity` as the TypeScript object
pub fn identity_to_json(identity: &RecoveryIdentity) -> Value {
    let mut map = Map::new();
    match identity {
        RecoveryIdentity::File(f) => {
            map.insert("kind".into(), Value::from(f.kind.as_str()));
            map.insert("filePath".into(), Value::from(f.file_path.as_str()));
        }
        RecoveryIdentity::Untitled(u) => {
            map.insert("kind".into(), Value::from(u.kind.as_str()));
            map.insert("untitledId".into(), Value::from(u.untitled_id.as_str()));
            map.insert("ext".into(), Value::from(u.ext.as_str()));
        }
    }
    Value::Object(map)
}

pub fn identity_from_json(value: &Value) -> Option<RecoveryIdentity> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    let kind = text("kind")?;
    if let Some(file_path) = text("filePath") {
        return Some(RecoveryIdentity::File(RecoveryFileIdentity {
            kind,
            file_path,
        }));
    }
    Some(RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
        kind,
        untitled_id: text("untitledId")?,
        ext: text("ext")?,
    }))
}

/// the sheets file identity of a path
pub fn file_identity(path: &str) -> RecoveryIdentity {
    RecoveryIdentity::File(RecoveryFileIdentity {
        kind: "sheets".into(),
        file_path: path.to_owned(),
    })
}

impl SessionInfo {
    /// The object `main-core`'s session functions read (`Map` fields left out)
    pub fn to_map(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("path".into(), Value::from(self.path.as_str()));
        map.insert(
            "snapshotPath".into(),
            Value::from(self.snapshot_path.as_str()),
        );
        map.insert("sha256".into(), Value::from(self.sha256.as_str()));
        map.insert(
            "automaticRecoveryDisabled".into(),
            Value::Bool(self.automatic_recovery_disabled),
        );
        let mut text = |key: &str, value: &Option<String>| {
            if let Some(value) = value {
                map.insert(key.into(), Value::from(value.as_str()));
            }
        };
        text("suggestSaveAs", &self.suggest_save_as);
        if self.ods_converted {
            map.insert("odsConverted".into(), Value::Bool(true));
        }
        if let Some(count) = self.formulas_dropped {
            map.insert("formulasDropped".into(), Value::from(count));
        }
        let mut text = |key: &str, value: &Option<String>| {
            if let Some(value) = value {
                map.insert(key.into(), Value::from(value.as_str()));
            }
        };
        text("odsSourcePath", &self.ods_source_path);
        if self.csv_import {
            map.insert("csvImport".into(), Value::Bool(true));
        }
        let mut text = |key: &str, value: &Option<String>| {
            if let Some(value) = value {
                map.insert(key.into(), Value::from(value.as_str()));
            }
        };
        text("csvSourcePath", &self.csv_source_path);
        text("csvSourceSha", &self.csv_source_sha);
        text("importTempDir", &self.import_temp_dir);
        text("restoreTarget", &self.restore_target);
        text("restoreTargetSha", &self.restore_target_sha);
        if self.empty_source {
            map.insert("emptySource".into(), Value::Bool(true));
        }
        if self.unsaved_new {
            map.insert("unsavedNew".into(), Value::Bool(true));
        }
        if let Some(password) = &self.password {
            map.insert("password".into(), Value::from(password.as_str()));
        }
        if let Some(identity) = &self.recovery_identity {
            map.insert("recoveryIdentity".into(), identity_to_json(identity));
        }
        if let Some(path) = &self.recovery_original_path {
            map.insert("recoveryOriginalPath".into(), Value::from(path.as_str()));
        }
        if self.unsaved_restore {
            map.insert("unsavedRestore".into(), Value::Bool(true));
        }
        if let Some((path, state)) = &self.disk_state {
            let mut inner = Map::new();
            inner.insert("mtimeMs".into(), Value::from(state.mtime_ms));
            inner.insert("size".into(), Value::from(state.size));
            inner.insert("hash".into(), Value::from(state.hash.as_str()));
            let mut disk = Map::new();
            disk.insert("path".into(), Value::from(path.as_str()));
            disk.insert("state".into(), Value::Object(inner));
            map.insert("diskState".into(), Value::Object(disk));
        }
        map
    }

    /// The path fields of `main-core`'s rename answer, applied to this session
    pub fn with_renamed_fields(&self, renamed: &Map<String, Value>) -> SessionInfo {
        let text = |key: &str| renamed.get(key).and_then(Value::as_str).map(str::to_owned);
        let mut next = self.clone();
        if let Some(path) = text("path") {
            next.path = path;
        }
        next.csv_source_path = text("csvSourcePath");
        next.restore_target = text("restoreTarget");
        next.ods_source_path = text("odsSourcePath");
        next.suggest_save_as = text("suggestSaveAs");
        next
    }
}

/// What the open pipeline is told about a session (`openWorkbookSession`'s options)
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OpenOptions {
    pub suggest_save_as: Option<String>,
    pub csv_import: bool,
    pub csv_source_path: Option<String>,
    pub empty_csv: bool,
    pub import_temp_dir: Option<String>,
    pub restore_target: Option<String>,
    pub empty_source: bool,
    pub unsaved_new: bool,
    pub password: Option<String>,
    pub recovery_identity: Option<RecoveryIdentity>,
    pub recovery_original_path: Option<String>,
    pub unsaved_restore: bool,
    pub ods_converted: bool,
    pub formulas_dropped: Option<f64>,
    pub ods_source_path: Option<String>,
    /// a save's output the sidecar already opened
    pub staged: Option<Staged>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Staged {
    pub snapshot_path: String,
    pub opened: super::engine::OpenedWorkbook,
}

impl OpenOptions {
    /// `continuedOpenOptions(previous)` read back as options
    pub fn from_carried(carried: &Map<String, Value>) -> OpenOptions {
        let text = |key: &str| carried.get(key).and_then(Value::as_str).map(str::to_owned);
        let flag = |key: &str| carried.get(key) == Some(&Value::Bool(true));
        OpenOptions {
            suggest_save_as: text("suggestSaveAs"),
            csv_import: flag("csvImport"),
            csv_source_path: text("csvSourcePath"),
            empty_csv: false,
            import_temp_dir: None,
            restore_target: text("restoreTarget"),
            empty_source: flag("emptySource"),
            unsaved_new: flag("unsavedNew"),
            password: text("password"),
            recovery_identity: carried.get("recoveryIdentity").and_then(identity_from_json),
            recovery_original_path: text("recoveryOriginalPath"),
            unsaved_restore: flag("unsavedRestore"),
            ods_converted: flag("odsConverted"),
            formulas_dropped: carried.get("formulasDropped").and_then(Value::as_f64),
            ods_source_path: text("odsSourcePath"),
            staged: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_round_trip_through_json() {
        let untitled = RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
            kind: "sheets".into(),
            untitled_id: "abc".into(),
            ext: ".xlsx".into(),
        });
        assert_eq!(
            identity_from_json(&identity_to_json(&untitled)),
            Some(untitled)
        );
        let file = file_identity("/a/b.xlsx");
        assert_eq!(identity_from_json(&identity_to_json(&file)), Some(file));
    }
}
