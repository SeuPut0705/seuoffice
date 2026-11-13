//! `apps/shell/src/main/projects/write-guard.ts`: the single write guard for
//! project folders (spec 3, invariants 3 and 9).
//!
//! The app writes into a person's folder in two places only: under the
//! project's data folder (`dataDirName`), and a new document the AI made
//! inside the project folder (never under the data folder, by any name it has
//! had). Every such write goes through this type, which checks each time that
//! the project root is still its canonical path, that the target stays below
//! it (no `..`, no drive or stream names), and that no folder on the way nor
//! the target itself is a link or junction. JSON and Markdown are written to a
//! temporary file and renamed. The data folder and its subfolders are created
//! only by an actual write.
//!
//! A policy refusal is `ProjectWriteRefused`; a file system failure is the
//! Node error of the call that failed (`code` and `message` as Node gives
//! them). Neither is swallowed.
//!
//! The TypeScript awaits `node:fs/promises` and queues the writes to one file
//! so they run one at a time in arrival order; here every call runs to its
//! end before the next one starts, which is that order, so there is no queue.
//! A caller that shares the guard between threads runs the writes to one file
//! one at a time itself.

use std::fs::{self, Metadata, OpenOptions};
use std::io::Write;

use jscompat::js_regex;
use jscompat::node_path::host::{self, join};
use jscompat::node_path::{posix, win32};
use serde::{Deserialize, Serialize};

use super::folder_files::{data_dir_name, is_data_dir_name, link_count};
use super::paths::{is_plain_segment, path_api, relative_inside, same_path};
use crate::node_fs::{NodeError, namespaced, node_error, node_error_fd, node_error2};
use crate::packages::electron_utils::atomic_write::temp_path_beside;
use crate::packages::project_store::nfc;
use crate::shell::atomic_write::atomic_write_file;
use crate::shell::rename_validation::is_valid_rename_name;

/// `ProjectWriteRefusal`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectWriteRefusal {
    /// The relative path is empty, absolute, or holds `..`, `.`, a stream or control characters
    BadPath,
    /// The target is not below the project folder (or, for a new document, inside the data folder)
    Outside,
    /// A folder on the way, or the target, is a link or junction
    Link,
    /// Something that should be a folder is a file, or the target is a folder
    NotAFolder,
    /// The project folder no longer resolves to the path it was registered under
    RootMoved,
    /// A new document or new project folder would replace an existing entry
    Exists,
    /// A new document's folder does not exist (new documents never create folders)
    MissingFolder,
    /// A hard-linked file would be appended to through its other name
    HardLink,
}

impl ProjectWriteRefusal {
    /// the text the message and `reason` carry
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BadPath => "bad-path",
            Self::Outside => "outside",
            Self::Link => "link",
            Self::NotAFolder => "not-a-folder",
            Self::RootMoved => "root-moved",
            Self::Exists => "exists",
            Self::MissingFolder => "missing-folder",
            Self::HardLink => "hard-link",
        }
    }
}

/// `ProjectWriteRefused`: an `Error` named `ProjectWriteRefused`, with no `code`
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectWriteRefused {
    pub reason: ProjectWriteRefusal,
    pub detail: String,
}

impl ProjectWriteRefused {
    /// `new ProjectWriteRefused(reason, detail)`
    pub fn new(reason: ProjectWriteRefusal, detail: impl Into<String>) -> Self {
        Self {
            reason,
            detail: detail.into(),
        }
    }

    /// `error.name`
    pub const NAME: &'static str = "ProjectWriteRefused";

    /// `error.message`
    pub fn message(&self) -> String {
        format!(
            "project folder write refused ({}): {}",
            self.reason.as_str(),
            self.detail
        )
    }
}

impl std::fmt::Display for ProjectWriteRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for ProjectWriteRefused {}

/// What a write of the guard throws: a refusal, or the error of the file
/// system call (an `Error` without a `code` is a [`NodeError`] with none).
/// `error instanceof ProjectWriteRefused` is a match on `Refused`.
#[derive(Debug, Clone, PartialEq)]
pub enum WriteGuardError {
    Refused(ProjectWriteRefused),
    Fs(NodeError),
}

impl WriteGuardError {
    /// `error.message`
    pub fn message(&self) -> String {
        match self {
            Self::Refused(refused) => refused.message(),
            Self::Fs(error) => error.message.clone(),
        }
    }

    /// `error.code`; `None` for a refusal
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Refused(_) => None,
            Self::Fs(error) => error.code,
        }
    }
}

impl From<ProjectWriteRefused> for WriteGuardError {
    fn from(refused: ProjectWriteRefused) -> Self {
        Self::Refused(refused)
    }
}

impl From<NodeError> for WriteGuardError {
    fn from(error: NodeError) -> Self {
        Self::Fs(error)
    }
}

/// The `change` of `updateData`: the current text (`None` when absent) to the
/// new text, `None` to leave the file alone, or what the change fails with
pub type DataChange<'r, E> = &'r mut dyn FnMut(Option<&str>) -> Result<Option<String>, E>;

/// `DataUpdateResult`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DataUpdateResult {
    /// False when the change returned null or undefined: nothing was written or created
    pub written: bool,
    /// The text now in the file (the previous text when nothing was written; `None` (`null`) when absent)
    pub text: Option<String>,
}

// ---------- the file system, as Node's promises API answers ----------

/// `lstat(path)`
fn lstat(path: &str) -> Result<Metadata, NodeError> {
    fs::symlink_metadata(namespaced(path)).map_err(|e| node_error(&e, "lstat", path))
}

/// `lstatOrNull(path)`: only a missing entry is `None`; any other failure is thrown
fn lstat_or_null(path: &str) -> Result<Option<Metadata>, NodeError> {
    match lstat(path) {
        Ok(info) => Ok(Some(info)),
        Err(error) if error.code == Some("ENOENT") => Ok(None),
        Err(error) => Err(error),
    }
}

/// `realpath(path)`
fn realpath(path: &str) -> Result<String, NodeError> {
    let real = fs::canonicalize(namespaced(path)).map_err(|e| node_error(&e, "realpath", path))?;
    let text = real.to_string_lossy().into_owned();
    // the verbatim form std gives on Windows is not what Node's realpath answers
    #[cfg(windows)]
    if let Some(plain) = text.strip_prefix(r"\\?\")
        && !plain.starts_with("UNC\\")
    {
        return Ok(plain.to_owned());
    }
    Ok(text)
}

/// `mkdir(path)`
fn mkdir(path: &str) -> Result<(), NodeError> {
    fs::create_dir(namespaced(path)).map_err(|e| node_error(&e, "mkdir", path))
}

/// `unlink(path)`
fn unlink(path: &str) -> Result<(), NodeError> {
    fs::remove_file(namespaced(path)).map_err(|e| node_error(&e, "unlink", path))
}

/// `rename(from, to)`
fn rename(from: &str, to: &str) -> Result<(), NodeError> {
    fs::rename(namespaced(from), namespaced(to)).map_err(|e| node_error2(&e, "rename", from, to))
}

/// `readFile(path, 'utf8')`: ill-formed bytes decode as U+FFFD, a byte order
/// mark stays
fn read_utf8(path: &str) -> Result<String, NodeError> {
    use std::io::Read;
    let mut file = fs::File::open(namespaced(path)).map_err(|e| node_error(&e, "open", path))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| node_error_fd(&e, "read"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// `writeFile(path, data, { flag: 'wx' })`
fn write_new(path: &str, data: &[u8]) -> Result<(), NodeError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(namespaced(path))
        .map_err(|e| node_error(&e, "open", path))?;
    file.write_all(data).map_err(|e| node_error_fd(&e, "write"))
}

/// `appendFile(path, text, { encoding: 'utf8' })`
fn append_text(path: &str, text: &str) -> Result<(), NodeError> {
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(namespaced(path))
        .map_err(|e| node_error(&e, "open", path))?;
    file.write_all(text.as_bytes())
        .map_err(|e| node_error_fd(&e, "write"))
}

/// `looksAbsolute(path)`
fn looks_absolute(path: &str) -> bool {
    host::is_absolute(path)
        || win32::is_absolute(path)
        || posix::is_absolute(path)
        || js_regex!(r"^[A-Za-z]:").test(path)
}

/// `relPath.split(/[\\/]/)`
fn split_segments(path: &str) -> Vec<&str> {
    js_regex!(r"[\\/]").split(path)
}

/// `dataSegments(relPath)`: the segments of a path relative to `.seuoffice/`,
/// or a refusal
fn data_segments(rel_path: &str) -> Result<Vec<&str>, ProjectWriteRefused> {
    if rel_path.is_empty() || looks_absolute(rel_path) {
        return Err(ProjectWriteRefused::new(
            ProjectWriteRefusal::BadPath,
            rel_path,
        ));
    }
    let segments = split_segments(rel_path);
    if !segments.iter().all(|segment| is_plain_segment(segment)) {
        return Err(ProjectWriteRefused::new(
            ProjectWriteRefusal::BadPath,
            rel_path,
        ));
    }
    Ok(segments)
}

/// `ProjectWriteGuard`
#[derive(Debug, Clone)]
pub struct ProjectWriteGuard {
    /// `NodeJS.Platform` (`process.platform` where the TypeScript leaves it out)
    platform: String,
}

impl ProjectWriteGuard {
    pub fn new(platform: &str) -> Self {
        Self {
            platform: platform.to_owned(),
        }
    }

    /// `locate(root, relPath, dataDir)`: the data folder and the file
    /// `relPath` names in it. `dataDir` is the name an operation of several
    /// writes resolved once (`dataDirName`), so all its writes land in one
    /// folder; only the data folder's own names are taken.
    fn locate(
        &self,
        root: &str,
        rel_path: &str,
        data_dir: Option<&str>,
    ) -> Result<(String, String), ProjectWriteRefused> {
        let name = match data_dir {
            Some(name) => name.to_owned(),
            None => data_dir_name(root),
        };
        if !is_data_dir_name(&name) {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::BadPath, name));
        }
        let dir = join(&[root, &name]);
        let mut parts: Vec<&str> = vec![&dir];
        parts.extend(data_segments(rel_path)?);
        let target = join(&parts);
        Ok((dir, target))
    }

    /// `dataPath(root, relPath, dataDir)`: the absolute path of a file in
    /// `root`'s data folder; checks the name only, touches nothing
    pub fn data_path(
        &self,
        root: &str,
        rel_path: &str,
        data_dir: Option<&str>,
    ) -> Result<String, ProjectWriteRefused> {
        self.locate(root, rel_path, data_dir)
            .map(|(_, target)| target)
    }

    /// `writeData(root, relPath, data, dataDir)`: replace a file in the data
    /// folder (temporary file, then rename)
    pub fn write_data(
        &self,
        root: &str,
        rel_path: &str,
        data: &[u8],
        data_dir: Option<&str>,
    ) -> Result<(), WriteGuardError> {
        let (dir, target) = self.locate(root, rel_path, data_dir)?;
        self.prepare_data(root, &dir, rel_path, true)?;
        atomic_write_file(&target, data)?;
        Ok(())
    }

    /// `appendData(root, relPath, text, dataDir)`: append to a file in the
    /// data folder (chat message lines)
    pub fn append_data(
        &self,
        root: &str,
        rel_path: &str,
        text: &str,
        data_dir: Option<&str>,
    ) -> Result<(), WriteGuardError> {
        let (dir, target) = self.locate(root, rel_path, data_dir)?;
        let existing = self.prepare_data(root, &dir, rel_path, true)?;
        if existing.is_some_and(|info| link_count(&info) > 1) {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::HardLink, target).into());
        }
        append_text(&target, text)?;
        Ok(())
    }

    /// `updateData(root, relPath, change, dataDir)`: read, change and write
    /// one file in the data folder without another write to that file in
    /// between. `change` gets the current text (`None` when absent) and
    /// returns the new text, or `None` (null/undefined) to leave the file
    /// (and the folder) alone. What `change` fails with comes back as it is.
    pub fn update_data<E: From<WriteGuardError>>(
        &self,
        root: &str,
        rel_path: &str,
        change: DataChange<'_, E>,
        data_dir: Option<&str>,
    ) -> Result<DataUpdateResult, E> {
        fn lift<E: From<WriteGuardError>>(error: impl Into<WriteGuardError>) -> E {
            E::from(error.into())
        }
        let (dir, target) = self.locate(root, rel_path, data_dir).map_err(lift::<E>)?;
        let existing = self
            .prepare_data(root, &dir, rel_path, false)
            .map_err(lift::<E>)?;
        let current = if existing.is_some() {
            Some(read_utf8(&target).map_err(lift::<E>)?)
        } else {
            None
        };
        let Some(next) = change(current.as_deref())? else {
            return Ok(DataUpdateResult {
                written: false,
                text: current,
            });
        };
        self.prepare_data(root, &dir, rel_path, true)
            .map_err(lift::<E>)?;
        atomic_write_file(&target, next.as_bytes()).map_err(lift::<E>)?;
        Ok(DataUpdateResult {
            written: true,
            text: Some(next),
        })
    }

    /// `removeData(root, relPath, dataDir)`: delete one file in the data
    /// folder (old memory backups); a missing file is fine
    pub fn remove_data(
        &self,
        root: &str,
        rel_path: &str,
        data_dir: Option<&str>,
    ) -> Result<(), WriteGuardError> {
        let (dir, target) = self.locate(root, rel_path, data_dir)?;
        let existing = self.prepare_data(root, &dir, rel_path, false)?;
        if existing.is_some() {
            unlink(&target)?;
        }
        Ok(())
    }

    /// `writeNewDocument(root, target, data)`: write a new document the AI
    /// made (spec 6): an absolute path inside the project folder, not under
    /// `.seuoffice/`, in a folder that already exists, never over an existing
    /// entry. The bytes go to a temporary file beside it first.
    pub fn write_new_document(
        &self,
        root: &str,
        target: &str,
        data: &[u8],
    ) -> Result<(), WriteGuardError> {
        let api = path_api(&self.platform);
        let bad_path = || ProjectWriteRefused::new(ProjectWriteRefusal::BadPath, target);
        if !looks_absolute(target) {
            return Err(bad_path().into());
        }
        if split_segments(target)
            .iter()
            .any(|segment| *segment == ".." || *segment == ".")
        {
            return Err(bad_path().into());
        }
        self.assert_root(root)?;
        let Some(rel) = relative_inside(root, &api.normalize(target), &self.platform) else {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::Outside, target).into());
        };
        let segments: Vec<&str> = rel.split('/').collect();
        if !segments.iter().all(|segment| is_plain_segment(segment)) {
            return Err(bad_path().into());
        }
        if is_data_dir_name(segments[0]) {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::Outside, target).into());
        }
        let (last, folders) = segments
            .split_last()
            .expect("a relative path has a segment");
        let mut dir = root.to_owned();
        for segment in folders {
            dir = join(&[&dir, segment]);
            let Some(info) = lstat_or_null(&dir)? else {
                return Err(
                    ProjectWriteRefused::new(ProjectWriteRefusal::MissingFolder, dir).into(),
                );
            };
            if info.file_type().is_symlink() {
                return Err(ProjectWriteRefused::new(ProjectWriteRefusal::Link, dir).into());
            }
            if !info.is_dir() {
                return Err(ProjectWriteRefused::new(ProjectWriteRefusal::NotAFolder, dir).into());
            }
        }
        if !same_path(&realpath(&dir)?, &dir, &self.platform) {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::Link, dir).into());
        }
        let final_path = join(&[&dir, last]);
        if lstat_or_null(&final_path)?.is_some() {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::Exists, final_path).into());
        }
        let temp = temp_path_beside(&final_path);
        let written = (|| -> Result<(), WriteGuardError> {
            write_new(&temp, data)?;
            if lstat_or_null(&final_path)?.is_some() {
                return Err(ProjectWriteRefused::new(
                    ProjectWriteRefusal::Exists,
                    final_path.as_str(),
                )
                .into());
            }
            rename(&temp, &final_path)?;
            Ok(())
        })();
        if let Err(error) = written {
            // `unlink(temp).catch(() => undefined)`
            let _ = unlink(&temp);
            return Err(error);
        }
        Ok(())
    }

    /// `createProjectFolder(parent, name)`: make the folder of a new project
    /// (spec 5.1): one new folder `name` in an existing `parent`. Never
    /// reuses or replaces an existing entry. Returns the folder's path under
    /// the parent's canonical path.
    pub fn create_project_folder(
        &self,
        parent: &str,
        name: &str,
    ) -> Result<String, WriteGuardError> {
        if !is_valid_rename_name(name) || !is_plain_segment(name) {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::BadPath, name).into());
        }
        if !looks_absolute(parent) {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::BadPath, parent).into());
        }
        let real_parent = nfc(&realpath(parent)?);
        let target = join(&[&real_parent, name]);
        if lstat_or_null(&target)?.is_some() {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::Exists, target).into());
        }
        match mkdir(&target) {
            Ok(()) => {}
            Err(error) if error.code == Some("EEXIST") => {
                return Err(ProjectWriteRefused::new(ProjectWriteRefusal::Exists, target).into());
            }
            Err(error) => return Err(error.into()),
        }
        Ok(target)
    }

    /// `assertRoot(root)`: the root must still be a folder at exactly its
    /// registered (canonical) path
    fn assert_root(&self, root: &str) -> Result<(), WriteGuardError> {
        if !looks_absolute(root) {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::BadPath, root).into());
        }
        let real = realpath(root)?;
        if !same_path(&real, root, &self.platform) {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::RootMoved, root).into());
        }
        let info = lstat(root)?;
        if !info.is_dir() {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::NotAFolder, root).into());
        }
        Ok(())
    }

    /// `prepareData(root, dataDir, relPath, create)`: checks the way from the
    /// root through `dataDir` to a data file. With `create`, missing folders
    /// below the root are made one level at a time; without it, a missing
    /// folder means the file is absent. The target's stats, or `None` (`null`)
    /// when it is absent.
    fn prepare_data(
        &self,
        root: &str,
        data_dir: &str,
        rel_path: &str,
        create: bool,
    ) -> Result<Option<Metadata>, WriteGuardError> {
        let segments = data_segments(rel_path)?;
        self.assert_root(root)?;
        let (last, folders_below) = segments.split_last().expect("a split has a segment");
        let mut dir = data_dir.to_owned();
        let mut folders = vec![dir.clone()];
        for segment in folders_below {
            dir = join(&[&dir, segment]);
            folders.push(dir.clone());
        }
        for folder in &folders {
            let info = match lstat_or_null(folder)? {
                Some(info) => info,
                None => {
                    if !create {
                        return Ok(None);
                    }
                    match mkdir(folder) {
                        Ok(()) => {}
                        Err(error) if error.code == Some("EEXIST") => {}
                        Err(error) => return Err(error.into()),
                    }
                    lstat(folder)?
                }
            };
            if info.file_type().is_symlink() {
                return Err(
                    ProjectWriteRefused::new(ProjectWriteRefusal::Link, folder.as_str()).into(),
                );
            }
            if !info.is_dir() {
                return Err(ProjectWriteRefused::new(
                    ProjectWriteRefusal::NotAFolder,
                    folder.as_str(),
                )
                .into());
            }
        }
        if !same_path(&realpath(&dir)?, &dir, &self.platform) {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::Link, dir).into());
        }
        let target = join(&[&dir, last]);
        let Some(info) = lstat_or_null(&target)? else {
            return Ok(None);
        };
        if info.file_type().is_symlink() {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::Link, target).into());
        }
        if !info.is_file() {
            return Err(ProjectWriteRefused::new(ProjectWriteRefusal::NotAFolder, target).into());
        }
        Ok(Some(info))
    }
}
