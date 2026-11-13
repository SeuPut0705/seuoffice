//! `apps/shell/src/main/projects/folder-files.ts`: reading what a project
//! folder holds (spec 3). Reads never create anything and never follow a link
//! or junction: a linked `.seuoffice/`, a linked file or a file with a second
//! hard link reads as absent, so a planted link cannot pull a file from
//! elsewhere on the PC (a sign-in store, say) into a request.
//!
//! The TypeScript awaits `node:fs/promises`; each call here is the plain
//! synchronous one, and a failed read is the `null` / `[]` the TypeScript
//! answers.

use std::fs::Metadata;

use jscompat::node_path::host::{basename, join};
use jscompat::{JsObject, JsonValue, js_regex, json_parse, json_stringify_pretty, trim};
use sha2::{Digest, Sha256};

use super::paths::relative_inside;
use crate::node_fs::namespaced;
use crate::packages::ai_provider::user_skills_sources::folder_holds_data;
use crate::packages::i18n::{OLD_PROJECT_DATA_DIR_NAMES, existing_or_current};
use crate::packages::project_store::{
    PROJECT_FORMAT_VERSION, PROJECT_NAME_MAX_CHARS, ProjectFolderFile, is_valid_project_id, nfc,
    project_folder_name, real_path_native,
};

/// `hashText(text)`: sha256 hex of the UTF-8 text, as kept in the trust record
pub fn hash_text(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `lstatOrNull(path)`
fn lstat_or_null(path: &str) -> Option<Metadata> {
    std::fs::symlink_metadata(namespaced(path)).ok()
}

/// `info.nlink`: how many names the file has. Windows has no answer in the
/// standard library (engine-waiting: the file handle's link count), so a file
/// there counts as having one name.
fn link_count(info: &Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        info.nlink()
    }
    #[cfg(not(unix))]
    {
        let _ = info;
        1
    }
}

/// `plainFileIn(root, segments)`: the absolute path of `<root>/<segments>`
/// when every folder on the way is a real folder and the last entry is a
/// plain file with one name; `None` (`null`) otherwise.
pub fn plain_file_in<S: AsRef<str>>(root: &str, segments: &[S]) -> Option<String> {
    let mut path = root.to_owned();
    for (index, segment) in segments.iter().enumerate() {
        path = join(&[&path, segment.as_ref()]);
        let info = lstat_or_null(&path)?;
        if info.file_type().is_symlink() {
            return None;
        }
        let last = index == segments.len() - 1;
        if !last && !info.is_dir() {
            return None;
        }
        if last && (!info.is_file() || link_count(&info) > 1) {
            return None;
        }
    }
    Some(path)
}

/// `RealFolderFile`: a file reached by `realPlainFileIn`: where it is on disk
/// and its segments below the root
#[derive(Debug, Clone, PartialEq)]
pub struct RealFolderFile {
    pub path: String,
    pub segments: Vec<String>,
}

/// `realPlainFileIn(root, segments, platform)`: `plainFileIn` for a path
/// someone else named (the AI's read tool): the file as it is named on disk.
/// On Windows one entry answers to several spellings: an 8.3 short name
/// (`IEUMOF~1`), trailing dots or spaces, other letter case. A rule judged on
/// the given spelling could pass a hidden or ignored entry, so the caller
/// judges the segments returned here, which come from the file's real path.
/// `root` is the project's canonical path. `None` (`null`) when the file is
/// not plain or its real path does not lie below `root`.
pub fn real_plain_file_in<S: AsRef<str>>(
    root: &str,
    segments: &[S],
    platform: &str,
) -> Option<RealFolderFile> {
    let path = plain_file_in(root, segments)?;
    let real = nfc(&real_path_native(&path)?);
    let rel = relative_inside(root, &real, platform)?;
    Some(RealFolderFile {
        path: real,
        segments: rel.split('/').map(str::to_owned).collect(),
    })
}

/// `plainFolderEntries(root, segments)`: the entry names of
/// `<root>/<segments>` when it is a real folder (no link on the way); `[]`
/// otherwise
pub fn plain_folder_entries<S: AsRef<str>>(root: &str, segments: &[S]) -> Vec<String> {
    let mut path = root.to_owned();
    for segment in segments {
        path = join(&[&path, segment.as_ref()]);
        match lstat_or_null(&path) {
            Some(info) if !info.file_type().is_symlink() && info.is_dir() => {}
            _ => return Vec::new(),
        }
    }
    let Ok(reader) = std::fs::read_dir(namespaced(&path)) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for entry in reader {
        let Ok(entry) = entry else {
            return Vec::new();
        };
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    // libuv sorts the names by bytes
    names.sort();
    names
}

/// `readFolderText(root, segments)`: UTF-8 text of a plain file in the folder
/// (BOM dropped), or `None` (`null`) when absent or not plain
pub fn read_folder_text<S: AsRef<str>>(root: &str, segments: &[S]) -> Option<String> {
    let path = plain_file_in(root, segments)?;
    let bytes = std::fs::read(namespaced(&path)).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    Some(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned())
}

/// `isDataDirName(segment)`: whether a folder-relative first segment names the
/// data folder, by any name it has had. The protections treat each as the data
/// folder whichever one a project uses, so a folder planted under the other
/// name is as closed to the AI as the real one.
pub fn is_data_dir_name(segment: &str) -> bool {
    let lower = segment.to_lowercase();
    lower == project_folder_name("dataDir") || OLD_PROJECT_DATA_DIR_NAMES.contains(&lower.as_str())
}

/// `dataDirName(root)`: the name of `root`'s data folder: the current one when
/// a real folder of that name holds data; else an earlier name while a real
/// folder of that name is there (a project an older version made keeps its
/// folder; nothing is copied or moved, a link reads as absent, and an empty
/// folder made under the current name hides nothing); else the current one.
/// Judged on every call rather than remembered, so it follows the folder as it
/// is on disk.
pub fn data_dir_name(root: &str) -> String {
    let real_folder = |name: &str| -> bool {
        std::fs::symlink_metadata(namespaced(&join(&[root, name])))
            .is_ok_and(|info| info.file_type().is_dir())
    };
    let mut in_use = |name: &str| real_folder(name) && folder_holds_data(&join(&[root, name]), 3);
    existing_or_current(
        project_folder_name("dataDir"),
        &OLD_PROJECT_DATA_DIR_NAMES,
        &real_folder,
        Some(&mut in_use),
    )
}

/// `readDataText(root, name, dataDir)`: a file in the project's data folder;
/// `dataDir` when an operation resolved it already
pub fn read_data_text(root: &str, name: &str, data_dir: Option<&str>) -> Option<String> {
    let data_dir = data_dir.map_or_else(|| data_dir_name(root), str::to_owned);
    read_folder_text(root, &[data_dir.as_str(), name])
}

/// `cleanProjectName(name)`: a project name as stored: one line, at most
/// `PROJECT_NAME_MAX_CHARS` characters
pub fn clean_project_name(name: &str) -> String {
    let collapsed = js_regex!(r"\s+").replace_all(name, |_| " ".to_owned());
    trim(&collapsed)
        .chars()
        .take(PROJECT_NAME_MAX_CHARS)
        .collect()
}

/// `readProjectFile(root, dataDir)`: `project.json` in the data folder when
/// present and well-formed (a bad id makes the file count as absent)
pub fn read_project_file(root: &str, data_dir: Option<&str>) -> Option<ProjectFolderFile> {
    let text = read_data_text(root, project_folder_name("projectFile"), data_dir)?;
    let Ok(JsonValue::Object(raw)) = json_parse(&text) else {
        return None;
    };
    let Some(JsonValue::String(id)) = raw.get("id") else {
        return None;
    };
    if !is_valid_project_id(id) {
        return None;
    }
    let name = match raw.get("name") {
        Some(JsonValue::String(name)) => clean_project_name(name),
        _ => String::new(),
    };
    let created_at = match raw.get("createdAt") {
        Some(JsonValue::String(created_at)) => created_at.clone(),
        _ => "1970-01-01T00:00:00.000Z".to_owned(),
    };
    Some(ProjectFolderFile {
        version: PROJECT_FORMAT_VERSION,
        id: id.clone(),
        name: if name.is_empty() {
            basename(root, None)
        } else {
            name
        },
        created_at,
    })
}

/// `projectFileText(file)`: `project.json` text as the app writes it
pub fn project_file_text(file: &ProjectFolderFile) -> String {
    let mut object = JsObject::new();
    object.set(
        "version",
        JsonValue::Number(f64::from(PROJECT_FORMAT_VERSION)),
    );
    object.set("id", JsonValue::String(file.id.clone()));
    object.set("name", JsonValue::String(file.name.clone()));
    object.set("createdAt", JsonValue::String(file.created_at.clone()));
    format!("{}\n", json_stringify_pretty(&JsonValue::Object(object), 2))
}
