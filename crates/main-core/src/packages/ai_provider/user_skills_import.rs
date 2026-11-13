//! `packages/ai-provider/src/user-skills/{errors,source-record,import}.ts`:
//! what the app's skills folder needs to take skills in, as far as it needs no
//! archive, no GitHub and no network: the error kinds, the shapes of a prepared
//! import and of a GitHub update check, the app's skills by name, the GitHub
//! source record, and the commit of a staged install with its undo.
//!
//! Left to the caller's `SkillLibrary` (`shell::user_skills::user_skills_service`):
//! `archive.ts` (244 lines, JSZip reading), `github.ts` (423, the fetches),
//! `warnings.ts` (131, the preview's pattern table), `update.ts` (244, the
//! GitHub update check and apply) and the `prepare*Import`,
//! `installImportedSkills` and `disposeSkillImport` of `import.ts` (about 600
//! of its 941 lines), `export.ts`' zip building (about 70 lines).
//!
//! A Node file call that throws is a [`NodeError`]; a `SkillImportError` is a
//! [`SkillImportError`]; the `RangeError` of a SKILL.md read is a
//! [`SkillMdError`]. [`Thrown`] is whichever of them an async function
//! rejects with.

use std::fs;
use std::io;
use std::path::Path;

use jscompat::node_path::host;
use jscompat::{JsMap, JsObject, JsonValue, json_parse, json_stringify_pretty, to_iso_string};
use sha2::{Digest, Sha256};

use super::user_skill_md::{
    IEUM_SOURCE_FILE, MAX_USER_SKILL_BYTES, MAX_USER_SKILL_FILES, SkillMdError, is_inside_dir,
    parse_skill_md,
};
use super::user_skills_folder::{SkillFolderLimits, list_skill_folder_files};
use crate::node_fs::{NodeError, copy_file, node_error, node_error2};

// ---- errors.ts ----

/// `SkillImportError`: why taking in a skill, checking one for an update or
/// exporting one did not happen. `kind` is one of `SkillImportErrorKind`.
#[derive(Debug, Clone, PartialEq)]
pub struct SkillImportError {
    pub kind: &'static str,
    pub message: String,
}

impl SkillImportError {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        SkillImportError {
            kind,
            message: message.into(),
        }
    }
}

/// What an async function of this package rejects with
#[derive(Debug, Clone, PartialEq)]
pub enum Thrown {
    Import(SkillImportError),
    Range(SkillMdError),
    Node(NodeError),
    /// a plain `Error`
    Plain(String),
}

impl From<SkillImportError> for Thrown {
    fn from(error: SkillImportError) -> Self {
        Thrown::Import(error)
    }
}

impl From<SkillMdError> for Thrown {
    fn from(error: SkillMdError) -> Self {
        Thrown::Range(error)
    }
}

impl From<NodeError> for Thrown {
    fn from(error: NodeError) -> Self {
        Thrown::Node(error)
    }
}

// ---- the file calls the skills code makes ----

/// `mkdir(path, { recursive: true })`
pub fn mkdir_recursive(path: &str) -> Result<(), NodeError> {
    fs::create_dir_all(path).map_err(|e| node_error(&e, "mkdir", path))
}

/// `mkdir(path)`
pub fn mkdir(path: &str) -> Result<(), NodeError> {
    fs::create_dir(path).map_err(|e| node_error(&e, "mkdir", path))
}

/// `writeFile(path, data)`
pub fn write_file(path: &str, data: &[u8]) -> Result<(), NodeError> {
    fs::write(path, data).map_err(|e| node_error(&e, "open", path))
}

/// `writeFile(path, data, { flag: 'wx' })`
pub fn write_file_exclusive(path: &str, data: &[u8]) -> Result<(), NodeError> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| node_error(&e, "open", path))?;
    file.write_all(data)
        .map_err(|e| node_error(&e, "write", path))
}

/// `rename(from, to)`
pub fn rename(from: &str, to: &str) -> Result<(), NodeError> {
    fs::rename(from, to).map_err(|e| node_error2(&e, "rename", from, to))
}

/// `copyFile(from, to)`
pub fn copy_file_over(from: &str, to: &str) -> Result<(), NodeError> {
    copy_file(from, to, false)
}

/// `readFile(path)`
pub fn read_file(path: &str) -> Result<Vec<u8>, NodeError> {
    fs::read(path).map_err(|e| {
        if is_dir(path) {
            crate::node_fs::node_error_fd(&e, "read")
        } else {
            node_error(&e, "open", path)
        }
    })
}

/// `readFile(path, 'utf8')`: invalid bytes read as U+FFFD
pub fn read_text(path: &str) -> Result<String, NodeError> {
    read_file(path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

fn is_dir(path: &str) -> bool {
    Path::new(path).is_dir()
}

/// `rm(path, { recursive: true, force: true }).catch(() => undefined)`
pub fn remove_quietly(path: &str) {
    let target = Path::new(path);
    let removed = match fs::symlink_metadata(target) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(target),
        Ok(_) => fs::remove_file(target),
        Err(e) => Err(e),
    };
    // a missing path and a path that cannot go are both left as they are
    let _: Result<(), io::Error> = removed;
}

/// `stat(path)` succeeded: the path is there (links followed)
pub fn exists(path: &str) -> bool {
    fs::metadata(path).is_ok()
}

// ---- source-record.ts ----

/// `IeumSourceRecord`: the GitHub source record at the top of a skill installed
/// from GitHub
#[derive(Debug, Clone, PartialEq)]
pub struct IeumSourceRecord {
    /// `owner/repo`
    pub repo: String,
    /// the branch name settled when the skill was taken
    pub ref_: String,
    /// the skill folder inside the repository, `""` for the top
    pub path: String,
    pub commit: String,
    /// ISO time, whole seconds, UTC
    pub installed_at: String,
    /// `skillContentHash` of the installed folder
    pub content_hash: String,
}

impl IeumSourceRecord {
    /// The record as an object, keys in the documented order
    pub fn to_json(&self) -> JsonValue {
        let mut object = JsObject::new();
        let text = |value: &str| JsonValue::String(value.to_owned());
        object.set("kind", text("github"));
        object.set("repo", text(&self.repo));
        object.set("ref", text(&self.ref_));
        object.set("path", text(&self.path));
        object.set("commit", text(&self.commit));
        object.set("installedAt", text(&self.installed_at));
        object.set("contentHash", text(&self.content_hash));
        JsonValue::Object(object)
    }
}

/// `isoSeconds(date)`: `2026-10-21T09:00:00Z`, ISO time without the milliseconds
pub fn iso_seconds(ms: f64) -> Result<String, SkillMdError> {
    let iso = to_iso_string(ms).ok_or_else(|| SkillMdError("Invalid time value".to_owned()))?;
    // `.replace(/\.\d{3}Z$/, 'Z')`
    Ok(match iso.strip_suffix('Z') {
        Some(head) if head.len() >= 4 && head.as_bytes()[head.len() - 4] == b'.' => {
            format!("{}Z", &head[..head.len() - 4])
        }
        _ => iso,
    })
}

/// `renderIeumSourceRecord(record)`: the record as written to disk
pub fn render_ieum_source_record(record: &IeumSourceRecord) -> String {
    format!("{}\n", json_stringify_pretty(&record.to_json(), 2))
}

/// `readIeumSourceRecord(skillDir)`: `None` when missing or not of the documented shape
pub fn read_ieum_source_record(skill_dir: &str) -> Option<IeumSourceRecord> {
    let text = read_text(&host::join(&[skill_dir, IEUM_SOURCE_FILE])).ok()?;
    let JsonValue::Object(value) = json_parse(&text).ok()? else {
        return None;
    };
    let text_of = |key: &str| match value.get(key) {
        Some(JsonValue::String(text)) => Some(text.clone()),
        _ => None,
    };
    let repo = text_of("repo");
    let ref_ = text_of("ref");
    let path = text_of("path");
    let commit = text_of("commit");
    if value.get("kind") != Some(&JsonValue::String("github".to_owned())) {
        return None;
    }
    let (Some(repo), Some(ref_), Some(path), Some(commit)) = (repo, ref_, path, commit) else {
        return None;
    };
    if repo.is_empty() || ref_.is_empty() || commit.is_empty() {
        return None;
    }
    Some(IeumSourceRecord {
        repo,
        ref_,
        path,
        commit,
        installed_at: text_of("installedAt").unwrap_or_default(),
        content_hash: text_of("contentHash").unwrap_or_default(),
    })
}

// ---- folder.ts: the content hash ----

/// `skillContentHash(dir, { skillMd })`: SHA-256 (hex) of a skill folder's
/// paths, sizes and contents, leaving out the GitHub source record at its top.
/// `skill_md` hashes the SKILL.md as the given function rewrites its text.
pub fn skill_content_hash(
    dir: &str,
    skill_md: Option<&dyn Fn(&str) -> String>,
) -> Result<String, Thrown> {
    let Some(listed) = list_skill_folder_files(dir, None) else {
        return Err(Thrown::Plain(format!(
            "Cannot read the skill folder: {dir}"
        )));
    };
    let mut hash = Sha256::new();
    for file in &listed.files {
        if file.rel == IEUM_SOURCE_FILE {
            continue;
        }
        let read = read_file(&file.path)?;
        let content = match skill_md {
            Some(rewrite) if file.rel == "SKILL.md" => {
                rewrite(&String::from_utf8_lossy(&read)).into_bytes()
            }
            _ => read,
        };
        hash.update(format!("{}\0{}\0", file.rel, content.len()).as_bytes());
        hash.update(&content);
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

// ---- import.ts: shapes ----

/// Folders made while installing, inside the app's skills folder
pub const SKILL_STAGING_PREFIX: &str = ".ieum-staging-";

/// `SkillWarning`
#[derive(Debug, Clone, PartialEq)]
pub struct SkillWarning {
    pub message_key: String,
    pub file: String,
    pub line: f64,
    pub excerpt: String,
}

/// `SkillImportCandidate`: one skill found by an import, as the preview shows it
#[derive(Debug, Clone, PartialEq)]
pub struct SkillImportCandidate {
    pub key: String,
    pub rel: String,
    pub dir: String,
    pub name: String,
    pub title: String,
    pub description: String,
    pub files: usize,
    pub bytes: u64,
    pub has_scripts: bool,
    pub has_template: bool,
    pub urls: Vec<String>,
    pub url_count: usize,
    pub license: Option<String>,
    pub warnings: Vec<SkillWarning>,
    pub warning_count: usize,
    pub collision: bool,
    pub empty_body: bool,
    /// a `SkillImportProblem`: an unreadable reason or `duplicate`
    pub problem: Option<&'static str>,
}

/// `SkillImportSource`: what the person handed over to take skills from
#[derive(Debug, Clone, PartialEq)]
pub enum SkillImportSource {
    Folder { folder: String },
    Zip { file: String },
    SkillFile { file: String },
    Text { text: String },
    Github { address: String },
}

/// `SkillImportOrigin`: where an import came from
#[derive(Debug, Clone, PartialEq)]
pub enum SkillImportOrigin {
    Folder {
        folder: String,
    },
    Zip {
        file: String,
    },
    SkillFile {
        file: String,
    },
    Text,
    Github {
        repo: String,
        ref_: String,
        commit: String,
        path: String,
    },
}

/// `SkillImport`: a prepared import waiting for the person's choice
#[derive(Debug, Clone, PartialEq)]
pub struct SkillImport {
    pub origin: SkillImportOrigin,
    pub root: String,
    pub candidates: Vec<SkillImportCandidate>,
    pub root_license: Option<String>,
    /// this import's temporary folder; `disposeSkillImport` removes it
    pub temp_dir: Option<String>,
}

/// `SkillFileChange`
#[derive(Debug, Clone, PartialEq)]
pub struct SkillFileChange {
    pub rel: String,
    /// `added`, `removed` or `modified`
    pub change: &'static str,
}

/// `GitHubSkillUpdateCheck`
#[derive(Debug, Clone, PartialEq)]
pub enum GitHubSkillUpdateCheck {
    UpToDate {
        record: IeumSourceRecord,
        commit: String,
        locally_edited: bool,
    },
    Changed(ChangedCheck),
}

/// The `changed` form of [`GitHubSkillUpdateCheck`]
#[derive(Debug, Clone, PartialEq)]
pub struct ChangedCheck {
    pub record: IeumSourceRecord,
    pub commit: String,
    pub locally_edited: bool,
    pub changed_files: Vec<SkillFileChange>,
    pub update: SkillImport,
}

/// `SkillCollisionChoice` by candidate key, in the order the request has them
pub type CollisionChoices = Vec<(String, String)>;

/// `InstalledSkill`
#[derive(Debug, Clone, PartialEq)]
pub struct InstalledSkill {
    pub key: String,
    pub name: String,
    pub dir: String,
    pub replaced: bool,
}

/// `InstallImportedSkillsResult`
#[derive(Debug, Clone, PartialEq)]
pub struct InstallImportedSkillsResult {
    pub installed: Vec<InstalledSkill>,
    pub skipped: Vec<String>,
}

fn default_limits() -> SkillFolderLimits {
    SkillFolderLimits {
        files: MAX_USER_SKILL_FILES,
        bytes: MAX_USER_SKILL_BYTES,
    }
}

/// `appSkillFoldersByName(appSkillsDir)`: the app's own skills by lowercase
/// name: each folder under its folder name and under the `name` its `SKILL.md`
/// gives. Staging folders are left out.
// Temporary stand-in for user_skills_sources.rs (sources.ts), owned by the projects session; delete at merge.
pub(crate) fn app_skill_folders_by_name(
    app_skills_dir: &str,
) -> Result<JsMap<Vec<String>>, SkillMdError> {
    let mut by_name: JsMap<Vec<String>> = JsMap::new();
    let mut add = |name: &str, dir: &str| {
        let key = name.to_lowercase();
        let mut dirs = by_name.get(&key).cloned().unwrap_or_default();
        if !dirs.iter().any(|known| known == dir) {
            dirs.push(dir.to_owned());
        }
        by_name.set(key, dirs);
    };
    for name in read_dir_names(app_skills_dir) {
        if name.starts_with(SKILL_STAGING_PREFIX) {
            continue;
        }
        let dir = host::join(&[app_skills_dir, &name]);
        if !is_dir(&dir) {
            continue;
        }
        add(&name, &dir);
        let text = read_text(&host::join(&[&dir, "SKILL.md"])).ok();
        let found = match &text {
            Some(text) => parse_skill_md(text)?
                .and_then(|parsed| parsed.name)
                .map(|name| jscompat::trim(&name).to_owned())
                .filter(|name| !name.is_empty()),
            None => None,
        };
        if let Some(found) = found {
            add(&found, &dir);
        }
    }
    Ok(by_name)
}

/// `readDirents(dir)`'s names, in the order `readdir` gives them (sorted by
/// name as libuv sorts them); an unreadable folder holds none
pub fn read_dir_names(dir: &str) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    names
}

/// `copySkillFolder(from, to, limits)`: copy a skill folder's files (links
/// inside it as the files they lead to), leaving out a source record at its
/// top. `too-large` over the limits.
fn copy_skill_folder(from: &str, to: &str, limits: &SkillFolderLimits) -> Result<(), Thrown> {
    let Some(listed) = list_skill_folder_files(from, Some(limits)) else {
        return Err(SkillImportError::new("failed", format!("Cannot read {from}")).into());
    };
    if listed.too_large {
        return Err(SkillImportError::new("too-large", "A skill folder is too large").into());
    }
    mkdir_recursive(to)?;
    for file in &listed.files {
        if file.rel == IEUM_SOURCE_FILE {
            continue;
        }
        let parts: Vec<&str> = file.rel.split('/').collect();
        let mut target = to.to_owned();
        for part in &parts {
            target = host::join(&[&target, part]);
        }
        mkdir_recursive(&host::dirname(&target))?;
        copy_file_over(&file.path, &target)?;
    }
    Ok(())
}

/// `SkillInstallPlan`: one skill to put into the app's skills folder
#[derive(Debug, Clone, PartialEq)]
pub struct SkillInstallPlan {
    pub candidate: SkillImportCandidate,
    /// the folder name under the app's skills folder
    pub folder_name: String,
    /// existing folders it replaces
    pub replace_dirs: Vec<String>,
    /// for a GitHub skill: the record to write, without the time and hash
    pub source: Option<SkillInstallSource>,
}

/// `SkillInstallPlan.source`
#[derive(Debug, Clone, PartialEq)]
pub struct SkillInstallSource {
    pub repo: String,
    pub ref_: String,
    pub path: String,
    pub commit: String,
}

/// `CommitSkillInstallOptions`
pub struct CommitSkillInstallOptions<'a> {
    /// `now()` in milliseconds since the epoch
    pub now_ms: f64,
    /// how a replaced folder goes away (the shell passes the OS trash);
    /// `Err` is a folder that could not go. Removed for good when not given.
    pub discard_replaced: Option<&'a mut dyn FnMut(&str) -> Result<(), ()>>,
    pub limits: Option<SkillFolderLimits>,
    pub random: Option<&'a mut dyn FnMut() -> String>,
}

/// a folder an install moved aside: where it was and where it is now
struct Aside {
    from: String,
    aside: String,
}

/// `commitSkillInstall(appSkillsDir, plans, options)`: put skills into the
/// app's skills folder: each is written completely into a staging folder
/// first, then folders it replaces are moved aside and it is renamed into
/// place. If anything fails, what was moved is moved back and nothing is
/// installed.
pub fn commit_skill_install(
    app_skills_dir: &str,
    plans: &[SkillInstallPlan],
    options: &mut CommitSkillInstallOptions<'_>,
) -> Result<Vec<String>, Thrown> {
    let limits = options.limits.clone().unwrap_or_else(default_limits);
    for plan in plans {
        for dir in &plan.replace_dirs {
            // a direct child of the app's skills folder, never that folder itself
            let child = is_inside_dir(app_skills_dir, &host::dirname(dir))
                && !is_inside_dir(app_skills_dir, dir);
            if !child || !is_inside_dir(dir, app_skills_dir) {
                return Err(SkillImportError::new(
                    "invalid-source",
                    "Only skills of the app folder are replaced",
                )
                .into());
            }
        }
    }
    mkdir_recursive(app_skills_dir)?;
    let suffix = match options.random.as_mut() {
        Some(random) => random(),
        None => random_hex(6),
    };
    let stage = host::join(&[app_skills_dir, &format!("{SKILL_STAGING_PREFIX}{suffix}")]);
    mkdir(&stage)?;
    let mut moved: Vec<(String, String)> = Vec::new();
    // per plan, the folders it replaced as moved aside into the staging folder
    let mut replaced: Vec<Vec<Aside>> = plans.iter().map(|_| Vec::new()).collect();
    let mut installed: Vec<String> = Vec::new();
    let attempt = (|| -> Result<(), Thrown> {
        let mut staged: Vec<String> = Vec::new();
        for (index, plan) in plans.iter().enumerate() {
            let dir = host::join(&[&stage, &format!("new-{index}")]);
            copy_skill_folder(&plan.candidate.dir, &dir, &limits)?;
            if let Some(source) = &plan.source {
                let record = IeumSourceRecord {
                    repo: source.repo.clone(),
                    ref_: source.ref_.clone(),
                    path: source.path.clone(),
                    commit: source.commit.clone(),
                    installed_at: iso_seconds(options.now_ms)?,
                    content_hash: skill_content_hash(&dir, None)?,
                };
                write_file(
                    &host::join(&[&dir, IEUM_SOURCE_FILE]),
                    render_ieum_source_record(&record).as_bytes(),
                )?;
            }
            staged.push(dir);
        }
        for (index, plan) in plans.iter().enumerate() {
            for (n, dir) in plan.replace_dirs.iter().enumerate() {
                if !exists(dir) {
                    continue;
                }
                let aside = host::join(&[
                    &stage,
                    &format!("old-{index}-{n}"),
                    &host::basename(dir, None),
                ]);
                mkdir_recursive(&host::dirname(&aside))?;
                rename(dir, &aside)?;
                moved.push((dir.clone(), aside.clone()));
                replaced[index].push(Aside {
                    from: dir.clone(),
                    aside,
                });
            }
            let target = host::join(&[app_skills_dir, &plan.folder_name]);
            if exists(&target) {
                return Err(SkillImportError::new(
                    "needs-choice",
                    format!("{} is already there", plan.folder_name),
                )
                .into());
            }
            rename(&staged[index], &target)?;
            moved.push((staged[index].clone(), target.clone()));
            installed.push(target);
        }
        Ok(())
    })();
    if let Err(error) = attempt {
        let mut restored = true;
        for (from, to) in moved.iter().rev() {
            // `moved` holds where each folder was and where it went: put it back
            if rename(to, from).is_err() {
                restored = false;
            }
        }
        // a folder that could not be moved back stays in the staging folder rather than being lost
        if restored {
            remove_quietly(&stage);
        }
        return Err(match error {
            Thrown::Import(error) => Thrown::Import(error),
            _ => SkillImportError::new("failed", "Installing the skill failed").into(),
        });
    }
    if let Some(discard) = options.discard_replaced.as_mut()
        && !discard_or_restore(&stage, &replaced, &installed, &mut **discard)
    {
        return Err(SkillImportError::new(
            "trash-failed",
            "A replaced skill could not be moved to the trash; it was put back",
        )
        .into());
    }
    remove_quietly(&stage);
    Ok(installed)
}

/// Hand the replaced folders to `discard` (the OS trash). If one cannot go,
/// nothing is deleted for good: every plan none of whose folders has gone yet
/// is undone (its new folder out, its old ones back), and the staging folder
/// is kept when anything could not be put back. False when one could not go.
fn discard_or_restore(
    stage: &str,
    replaced: &[Vec<Aside>],
    installed: &[String],
    discard: &mut dyn FnMut(&str) -> Result<(), ()>,
) -> bool {
    let mut gone: Vec<&str> = Vec::new();
    let mut failed = false;
    for folders in replaced {
        for folder in folders {
            if discard(&folder.aside).is_ok() {
                gone.push(&folder.aside);
            } else {
                failed = true;
                break;
            }
        }
        if failed {
            break;
        }
    }
    if !failed {
        return true;
    }
    let mut restored = true;
    for (index, folders) in replaced.iter().enumerate().rev() {
        // a plan whose old folder is already in the trash stays installed: undoing it would lose both
        if folders
            .iter()
            .any(|folder| gone.contains(&folder.aside.as_str()))
        {
            if folders
                .iter()
                .any(|folder| !gone.contains(&folder.aside.as_str()))
            {
                restored = false;
            }
            continue;
        }
        let undone = (|| -> Result<(), NodeError> {
            rename(
                &installed[index],
                &host::join(&[stage, &format!("undone-{index}")]),
            )?;
            for folder in folders {
                rename(&folder.aside, &folder.from)?;
            }
            Ok(())
        })();
        if undone.is_err() {
            restored = false;
        }
    }
    if restored {
        remove_quietly(stage);
    }
    false
}

/// `randomBytes(n).toString('hex')`
pub fn random_hex(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes).expect("the platform random source");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
