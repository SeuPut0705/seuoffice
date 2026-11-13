//! `packages/ai-provider/src/user-skills/{folder,sources,export}.ts`: one skill
//! folder (what is in it, its front matter), where the skills are read from
//! and the list of them, and what an export would hold. The zip building of
//! `export.ts` is left to the caller's `SkillLibrary`; so are `findUrlsInText`
//! and `findSkillUrls` of `folder.ts`, which only the import preview reads.
//!
//! `readdir` answers in the order libuv sorts it (by name, byte order); a
//! folder is read that way here too.

use std::cmp::Ordering;
use std::fs;

use jscompat::node_path::host;
use jscompat::{JsonValue, js_regex, json_parse, slice_utf16, trim};

use super::user_skill_md::{
    BUILTIN_SKILLS_MANIFEST, IEUM_EDITORS_KEY, IEUM_SOURCE_FILE, IEUM_TEMPLATE_KEY, IEUM_TITLE_KEY,
    MAX_USER_SKILL_BYTES, MAX_USER_SKILL_FILES, ParsedSkillMd, SKILL_SCRIPT_EXTENSIONS,
    SKILL_SCRIPTS_FOLDER, SkillMdError, is_inside_codex_home, is_inside_dir,
    is_reserved_user_skill_name, normalize_skill_template_path, parse_skill_md, real_path,
};
use super::user_skills_import::{SkillImportError, Thrown, exists, read_text};
use super::user_skills_states::{
    UserSkill, is_valid_user_skill_name, skill_editors_of, user_skill_id,
};
use crate::node_fs::code_of;
use crate::packages::agent_core::skill_mcp_refs::mcp_servers_of_skill;
use crate::packages::i18n::{OLD_HOME_DIR_NAMES, existing_or_current};

/// `a < b` of a JavaScript `sort` comparator on strings: UTF-16 code units
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

// ---- folder.ts ----

/// `SkillFolderFile`
#[derive(Debug, Clone, PartialEq)]
pub struct SkillFolderFile {
    /// the path inside the skill folder, with `/` between parts
    pub rel: String,
    pub path: String,
    pub size: u64,
}

/// `SkillFolderLimits`
#[derive(Debug, Clone, PartialEq)]
pub struct SkillFolderLimits {
    pub files: usize,
    pub bytes: u64,
}

/// What `listSkillFolderFiles` finds
#[derive(Debug, Clone, PartialEq)]
pub struct SkillFolderListing {
    pub files: Vec<SkillFolderFile>,
    pub bytes: u64,
    pub too_large: bool,
}

struct Walk<'a> {
    root: &'a str,
    limits: Option<&'a SkillFolderLimits>,
    files: Vec<SkillFolderFile>,
    bytes: u64,
    too_large: bool,
}

impl Walk<'_> {
    fn walk(&mut self, current: &str, rel: &str) -> bool {
        let Ok(entries) = fs::read_dir(current) else {
            return false;
        };
        let mut entries: Vec<fs::DirEntry> = entries.filter_map(Result::ok).collect();
        entries.sort_by(|a, b| {
            a.file_name()
                .as_encoded_bytes()
                .cmp(b.file_name().as_encoded_bytes())
        });
        for entry in entries {
            if self.too_large {
                return true;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = host::join(&[current, &name]);
            let rel_path = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if !self.walk(&path, &rel_path) {
                    return false;
                }
                continue;
            }
            let mut target = path.clone();
            if kind.is_symlink() {
                let Some(real) = real_path(&path) else {
                    continue;
                };
                if !is_inside_dir(&real, self.root) {
                    continue;
                }
                target = real;
            } else if !kind.is_file() {
                continue;
            }
            let Ok(info) = fs::metadata(&target) else {
                continue;
            };
            if !info.is_file() {
                continue;
            }
            self.files.push(SkillFolderFile {
                rel: rel_path,
                path: target,
                size: info.len(),
            });
            self.bytes += info.len();
            if let Some(limits) = self.limits
                && (self.files.len() > limits.files || self.bytes > limits.bytes)
            {
                self.too_large = true;
            }
        }
        true
    }
}

/// `listSkillFolderFiles(dir, limits)`: every file in a folder, sorted by
/// inside path. Links to folders are not followed. A link to a file counts
/// only when its real place is inside the folder's real place, and then `path`
/// is that real place. With limits, the walk stops once either is passed and
/// `too_large` is set. `None` when the folder or a folder in it cannot be read.
pub fn list_skill_folder_files(
    dir: &str,
    limits: Option<&SkillFolderLimits>,
) -> Option<SkillFolderListing> {
    let root = real_path(dir)?;
    let mut walk = Walk {
        root: &root,
        limits,
        files: Vec::new(),
        bytes: 0,
        too_large: false,
    };
    if !walk.walk(dir, "") {
        return None;
    }
    let mut files = walk.files;
    files.sort_by(|a, b| cmp_utf16(&a.rel, &b.rel));
    Some(SkillFolderListing {
        files,
        bytes: walk.bytes,
        too_large: walk.too_large,
    })
}

/// `isSkillScriptPath(rel)`: a file in the scripts folder or of a script type
/// makes a skill "with scripts"
pub fn is_skill_script_path(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts[..parts.len() - 1]
        .iter()
        .any(|part| part.to_lowercase() == SKILL_SCRIPTS_FOLDER)
    {
        return true;
    }
    let extension = host::extname(rel).to_lowercase();
    SKILL_SCRIPT_EXTENSIONS.contains(&extension.as_str())
}

fn fold_name(rel: &str) -> String {
    if cfg!(windows) {
        rel.to_lowercase()
    } else {
        rel.to_owned()
    }
}

/// the listed file `SKILL.md` names (the other case on Windows too)
fn skill_md_in(files: &[SkillFolderFile]) -> Option<&SkillFolderFile> {
    files
        .iter()
        .find(|file| file.rel == "SKILL.md")
        .or_else(|| {
            files
                .iter()
                .find(|file| fold_name(&file.rel) == fold_name("SKILL.md"))
        })
}

/// `readUserSkillFolder(dir, options)`: read one skill folder. `None` for a
/// reserved name (by folder or by front matter): such a skill is never listed.
/// A skill that cannot be used still comes back, with `unreadable` set.
pub fn read_user_skill_folder(
    dir: &str,
    source: &str,
    plugin: Option<&str>,
    agent_only_names: Option<&[String]>,
) -> Result<Option<UserSkill>, SkillMdError> {
    let folder_name = host::basename(dir, None);
    if is_reserved_user_skill_name(&folder_name) {
        return Ok(None);
    }

    let mut unreadable: Option<&'static str> = None;
    let limits = SkillFolderLimits {
        files: MAX_USER_SKILL_FILES,
        bytes: MAX_USER_SKILL_BYTES,
    };
    let listed = list_skill_folder_files(dir, Some(&limits));
    match &listed {
        None => unreadable = Some("unreadable"),
        Some(listed) if listed.too_large => unreadable = Some("too-large"),
        Some(_) => {}
    }

    let mut text: Option<String> = None;
    if let Some(listed) = &listed {
        match skill_md_in(&listed.files) {
            Some(skill_md) => match read_text(&skill_md.path) {
                Ok(read) => text = Some(read),
                Err(_) => {
                    unreadable.get_or_insert("unreadable");
                }
            },
            None => {
                // something named SKILL.md that is not a file in the folder, such as a link leading out
                if fs::symlink_metadata(host::join(&[dir, "SKILL.md"])).is_ok() {
                    unreadable.get_or_insert("unreadable");
                }
            }
        }
    }
    let parsed: Option<ParsedSkillMd> = match &text {
        Some(text) => parse_skill_md(text)?,
        None => None,
    };
    let front_name = parsed
        .as_ref()
        .and_then(|parsed| parsed.name.as_deref())
        .map(|name| trim(name).to_owned())
        .filter(|name| !name.is_empty());
    if let Some(front_name) = &front_name
        && is_reserved_user_skill_name(front_name)
    {
        return Ok(None);
    }
    let description = parsed
        .as_ref()
        .and_then(|parsed| parsed.description.as_deref())
        .map_or("", trim)
        .to_owned();
    if parsed.is_none() || description.is_empty() {
        unreadable.get_or_insert("no-frontmatter");
    }
    if front_name
        .as_deref()
        .is_none_or(|name| !is_valid_user_skill_name(name))
    {
        unreadable.get_or_insert("bad-name");
    }

    let name = match &front_name {
        Some(front) if is_valid_user_skill_name(front) => front.clone(),
        _ => folder_name.clone(),
    };
    let metadata = |key: &str| parsed.as_ref().and_then(|parsed| parsed.metadata.get(key));
    let template = normalize_skill_template_path(metadata(IEUM_TEMPLATE_KEY).map(String::as_str));
    let title = match metadata(IEUM_TITLE_KEY).map(|title| trim(title)) {
        Some(title) if !title.is_empty() => title.to_owned(),
        _ => name.clone(),
    };
    let files: &[SkillFolderFile] = listed.as_ref().map_or(&[], |listed| &listed.files);
    let agent_only = source == "builtin"
        && agent_only_names
            .is_some_and(|names| names.contains(&name) || names.contains(&folder_name));
    Ok(Some(UserSkill {
        id: user_skill_id(source, &name, plugin),
        source: source.to_owned(),
        plugin: if source == "plugin" {
            plugin.map(str::to_owned)
        } else {
            None
        },
        name,
        folder_name,
        dir: dir.to_owned(),
        title,
        description,
        template_exists: template
            .as_ref()
            .is_some_and(|template| files.iter().any(|file| file.rel == *template)),
        template,
        has_scripts: files.iter().any(|file| is_skill_script_path(&file.rel)),
        mcp_servers: match &parsed {
            Some(parsed) => mcp_servers_of_skill_md(parsed),
            None => Vec::new(),
        },
        github: source == "app" && files.iter().any(|file| file.rel == IEUM_SOURCE_FILE),
        agent_only,
        file_editors: skill_editors_of(&match metadata(IEUM_EDITORS_KEY) {
            Some(value) => JsonValue::String(value.clone()),
            None => JsonValue::Null,
        }),
        files: files.len(),
        bytes: listed.as_ref().map_or(0, |listed| listed.bytes),
        unreadable,
    }))
}

/// `readListedSkillMd(dir)`: a skill folder's `SKILL.md` text, read only as a
/// file the folder listing finds. `None` when the folder has none or it cannot
/// be read.
pub fn read_listed_skill_md(dir: &str) -> Option<String> {
    let limits = SkillFolderLimits {
        files: MAX_USER_SKILL_FILES,
        bytes: MAX_USER_SKILL_BYTES,
    };
    let listed = list_skill_folder_files(dir, Some(&limits))?;
    let skill_md = skill_md_in(&listed.files)?;
    read_text(&skill_md.path).ok()
}

/// `mcpServersOfSkillMd(parsed)`: the MCP servers a read SKILL.md refers to:
/// its front matter `allowed-tools` (a list or a string) and `mcp__<server>__<tool>`
/// in its body
pub fn mcp_servers_of_skill_md(parsed: &ParsedSkillMd) -> Vec<String> {
    let allowed: Option<Vec<String>> = match parsed.lists.get("allowed-tools") {
        Some(list) => Some(list.clone()),
        None => parsed
            .fields
            .get("allowed-tools")
            .map(|field| vec![field.clone()]),
    };
    mcp_servers_of_skill(&parsed.body, allowed.as_deref())
}

// ---- sources.ts ----
//
// Temporary stand-in for user_skills_sources.rs (sources.ts), owned by the projects session; delete at merge.
// Everything from here to `export.ts` below is that stand-in: no cases or faults of its own.

/// `UserSkillSourceDir`: a folder whose child folders are skills
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct UserSkillSourceDir {
    pub source: String,
    pub dir: String,
    /// the plugin a plugin source came from
    pub plugin: Option<String>,
}

/// `UserSkillSourceOptions`
#[derive(Debug, Clone, Default)]
pub(crate) struct UserSkillSourceOptions {
    pub home_dir: String,
    /// the app's builtin skills folder; left out when not given
    pub builtin_dir: Option<String>,
    /// the app's own skills folder; `appSkillsDirOf(homeDir)` when not given
    pub app_skills_dir: Option<String>,
    /// the agent window's project folder; its skills are read only when given
    pub project_root: Option<String>,
}

/// `folderHoldsData(dir, depth)`: whether `dir` holds a file anywhere in its
/// first few levels (a `.DS_Store` does not count). Missing (or not a
/// folder): no. Any other failure to read it counts as holding data.
pub(crate) fn folder_holds_data(dir: &str, depth: u32) -> bool {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            let code = code_of(&error);
            return code != Some("ENOENT") && code != Some("ENOTDIR");
        }
    };
    entries.filter_map(Result::ok).any(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            depth > 1 && folder_holds_data(&host::join(&[dir, &name]), depth - 1)
        } else {
            name != ".DS_Store"
        }
    })
}

/// `appHomeDir(homeDir)`: the app's folder under the home folder
/// (`~/.seuoffice`), or the one an earlier version made under its old name
pub(crate) fn app_home_dir(home_dir: &str) -> String {
    let name = existing_or_current(
        ".seuoffice",
        &OLD_HOME_DIR_NAMES,
        |candidate| exists(&host::join(&[home_dir, candidate])),
        Some(&mut |candidate: &str| folder_holds_data(&host::join(&[home_dir, candidate]), 3)),
    );
    host::join(&[home_dir, &name])
}

/// `appSkillsDirOf(homeDir)`: the app's own skills folder, the only one the app writes to
pub(crate) fn app_skills_dir_of(home_dir: &str) -> String {
    host::join(&[&app_home_dir(home_dir), "skills"])
}

/// `pluginSources(homeDir)`: installed Claude plugins with a `skills` folder,
/// from Claude Code's list of installed plugins, ordered by plugin name. A
/// missing or unreadable list: none. Only a `plugins` that is an object is
/// read.
fn plugin_sources(home_dir: &str) -> Vec<UserSkillSourceDir> {
    let mut sources: Vec<UserSkillSourceDir> = Vec::new();
    let path = host::join(&[home_dir, ".claude", "plugins", "installed_plugins.json"]);
    if let Ok(text) = read_text(&path)
        && let Ok(JsonValue::Object(installed)) = json_parse(&text)
        && let Some(JsonValue::Object(plugins)) = installed.get("plugins")
    {
        for (plugin, installs) in plugins.entries() {
            let install_path = match installs {
                JsonValue::Array(list) => match list.last() {
                    Some(JsonValue::Object(last)) => match last.get("installPath") {
                        Some(JsonValue::String(path)) => Some(path.as_str()),
                        _ => None,
                    },
                    _ => None,
                },
                _ => None,
            };
            let name = plugin.split('@').next().unwrap_or("");
            if let Some(install_path) = install_path
                && !install_path.is_empty()
                && !name.is_empty()
            {
                sources.push(UserSkillSourceDir {
                    source: "plugin".to_owned(),
                    dir: host::join(&[install_path, "skills"]),
                    plugin: Some(name.to_owned()),
                });
            }
        }
    }
    let key = |entry: &UserSkillSourceDir| entry.plugin.clone().unwrap_or_default().to_lowercase();
    sources.sort_by(|a, b| cmp_utf16(&key(a), &key(b)));
    sources
}

/// `userSkillSources(options)`: the skill sources in list order: builtin, the
/// app's own, Claude's, each Claude plugin, the shared agents folder, then
/// the project's `.claude/skills` and `.agents/skills`. Nothing inside
/// `~/.codex` is ever included.
pub(crate) fn user_skill_sources(options: &UserSkillSourceOptions) -> Vec<UserSkillSourceDir> {
    let home = options.home_dir.as_str();
    let mut sources: Vec<UserSkillSourceDir> = Vec::new();
    let mut push = |source: &str, dir: String| {
        sources.push(UserSkillSourceDir {
            source: source.to_owned(),
            dir,
            plugin: None,
        });
    };
    if let Some(builtin) = options.builtin_dir.as_deref().filter(|dir| !dir.is_empty()) {
        push("builtin", builtin.to_owned());
    }
    push(
        "app",
        options
            .app_skills_dir
            .clone()
            .filter(|dir| !dir.is_empty())
            .unwrap_or_else(|| app_skills_dir_of(home)),
    );
    push("user", host::join(&[home, ".claude", "skills"]));
    sources.extend(plugin_sources(home));
    let mut push = |source: &str, dir: String| {
        sources.push(UserSkillSourceDir {
            source: source.to_owned(),
            dir,
            plugin: None,
        });
    };
    push("codex", host::join(&[home, ".agents", "skills"]));
    if let Some(root) = options
        .project_root
        .as_deref()
        .filter(|dir| !dir.is_empty())
    {
        push("project", host::join(&[root, ".claude", "skills"]));
        push("project", host::join(&[root, ".agents", "skills"]));
    }
    sources
        .into_iter()
        .filter(|entry| !is_inside_codex_home(&entry.dir, home))
        .collect()
}

/// `BuiltinSkillManifestEntry`: one entry of `builtin-skills.json`
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BuiltinSkillManifestEntry {
    pub name: String,
    /// where the skill was taken from, such as `owner/repo`
    pub source: String,
    /// the folder inside that repository
    pub path: String,
    pub commit: String,
    pub license: String,
    /// a builtin skill only the agent window uses
    pub agent_only: bool,
    /// the app changed the original text
    pub modified: bool,
}

/// `readBuiltinSkillsManifest(builtinDir)`: entries without a name are
/// dropped; a missing or malformed file gives an empty list
pub(crate) fn read_builtin_skills_manifest(builtin_dir: &str) -> Vec<BuiltinSkillManifestEntry> {
    let Ok(text) = read_text(&host::join(&[builtin_dir, BUILTIN_SKILLS_MANIFEST])) else {
        return Vec::new();
    };
    let Ok(JsonValue::Array(items)) = json_parse(&text) else {
        return Vec::new();
    };
    let mut entries: Vec<BuiltinSkillManifestEntry> = Vec::new();
    for item in &items {
        let JsonValue::Object(entry) = item else {
            continue;
        };
        let text_of = |key: &str| match entry.get(key) {
            Some(JsonValue::String(text)) => text.clone(),
            _ => String::new(),
        };
        let flag = |key: &str| entry.get(key) == Some(&JsonValue::Bool(true));
        let Some(JsonValue::String(name)) = entry.get("name") else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        entries.push(BuiltinSkillManifestEntry {
            name: name.clone(),
            source: text_of("source"),
            path: text_of("path"),
            commit: text_of("commit"),
            license: text_of("license"),
            agent_only: flag("agentOnly"),
            modified: flag("modified"),
        });
    }
    entries
}

/// `skillFolders(dir)`: child folders of a source (links to folders followed), sorted by name
fn skill_folders(dir: &str) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<fs::DirEntry> = entries.filter_map(Result::ok).collect();
    entries.sort_by(|a, b| {
        a.file_name()
            .as_encoded_bytes()
            .cmp(b.file_name().as_encoded_bytes())
    });
    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_reserved_user_skill_name(&name) {
            continue;
        }
        // hidden folders are not skills: the install staging folder lives here a moment
        if name.starts_with('.') {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        // The two branches mirror the TS `isDirectory()` / `isSymbolicLink() && stat` lines
        // of `listSkillFolders`; the shape is kept so the port stays line by line.
        #[allow(clippy::if_same_then_else)]
        if kind.is_dir() {
            names.push(name);
        } else if kind.is_symlink()
            && fs::metadata(host::join(&[dir, &name])).is_ok_and(|info| info.is_dir())
        {
            names.push(name);
        }
    }
    names.sort_by(|a, b| cmp_utf16(&a.to_lowercase(), &b.to_lowercase()));
    names
}

/// `readUserSkillsFrom(sources, options)`: read the skills of the given
/// sources, in source order. Within one source a second skill with an
/// identifier already seen is left out. Reserved names and folders inside
/// `~/.codex` never appear.
pub(crate) fn read_user_skills_from(
    sources: &[UserSkillSourceDir],
    home_dir: &str,
    agent_only_names: Option<&[String]>,
) -> Result<Vec<UserSkill>, SkillMdError> {
    let mut skills: Vec<UserSkill> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for source in sources {
        // checked before the source folder is opened
        if is_inside_codex_home(&source.dir, home_dir) {
            continue;
        }
        for folder in skill_folders(&source.dir) {
            let dir = host::join(&[&source.dir, &folder]);
            if is_inside_codex_home(&dir, home_dir) {
                continue;
            }
            let Some(skill) = read_user_skill_folder(
                &dir,
                &source.source,
                source.plugin.as_deref(),
                agent_only_names,
            )?
            else {
                continue;
            };
            let key = skill.id.to_lowercase();
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            skills.push(skill);
        }
    }
    Ok(skills)
}

/// `listUserSkills(options)`: every skill of every source the options name,
/// with builtin flags read from the builtin list
pub(crate) fn list_user_skills(
    options: &UserSkillSourceOptions,
) -> Result<Vec<UserSkill>, SkillMdError> {
    let manifest = match options.builtin_dir.as_deref().filter(|dir| !dir.is_empty()) {
        Some(dir) => read_builtin_skills_manifest(dir),
        None => Vec::new(),
    };
    let agent_only: Vec<String> = manifest
        .iter()
        .filter(|entry| entry.agent_only)
        .map(|entry| entry.name.clone())
        .collect();
    read_user_skills_from(
        &user_skill_sources(options),
        &options.home_dir,
        Some(&agent_only),
    )
}

// ---- export.ts ----

/// `SkillExportInfo`: what an export of a skill would hold
#[derive(Debug, Clone, PartialEq)]
pub struct SkillExportInfo {
    /// the skill's name, also the top folder inside the zip
    pub name: String,
    /// the save dialog's suggestion
    pub file_name: String,
    /// a template document is in the folder and goes into the zip
    pub includes_template: bool,
    pub files: usize,
    pub bytes: u64,
}

/// `fileStemOf(words)`: words as the stem of a file name: the characters a
/// Windows file name cannot hold taken out. `""` when nothing usable is left.
fn file_stem_of(words: Option<&str>) -> String {
    let words = words.unwrap_or("");
    let no_zip = js_regex!(r"\.zip$", "i").replace_all(words, |_| String::new());
    let spaced = js_regex!(r"\s+").replace_all(&no_zip, |_| " ".to_owned());
    let cleaned =
        js_regex!(r#"[<>:"/\\|?*\u0000-\u001f\u007f]"#).replace_all(&spaced, |_| String::new());
    let trimmed = trim(&cleaned);
    let undotted = js_regex!(r"^\.+").replace_all(trimmed, |_| String::new());
    let cut = slice_utf16(&undotted, 0.0, Some(100.0));
    let stem = js_regex!(r"[. ]+$").replace_all(&cut, |_| String::new());
    if js_regex!(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$", "i").test(&stem) {
        String::new()
    } else {
        stem
    }
}

/// The file name a bundle export suggests when it is given no words for one
pub const SKILL_BUNDLE_FILE_NAME: &str = "skills.zip";

/// `skillBundleFileName(suggested)`: the file name a bundle export suggests,
/// from the words the screen made for it, `.zip` at the end; `skills.zip`
/// when nothing usable is left
pub fn skill_bundle_file_name(suggested: Option<&str>) -> String {
    let stem = file_stem_of(suggested);
    if stem.is_empty() {
        SKILL_BUNDLE_FILE_NAME.to_owned()
    } else {
        format!("{stem}.zip")
    }
}

/// `skillExportInfo(skillDir, limits)`: what an export of this skill would
/// hold, for the warning and the save dialog
pub fn skill_export_info(
    skill_dir: &str,
    limits: Option<&SkillFolderLimits>,
) -> Result<SkillExportInfo, Thrown> {
    let default = SkillFolderLimits {
        files: MAX_USER_SKILL_FILES,
        bytes: MAX_USER_SKILL_BYTES,
    };
    let limits = limits.unwrap_or(&default);
    let Some(skill) = read_user_skill_folder(skill_dir, "app", None, None)? else {
        return Err(
            SkillImportError::new("not-installable", "This skill cannot be exported").into(),
        );
    };
    let Some(listed) = list_skill_folder_files(skill_dir, Some(limits)) else {
        return Err(SkillImportError::new("failed", format!("Cannot read {skill_dir}")).into());
    };
    if listed.too_large {
        return Err(SkillImportError::new("too-large", "The skill folder is too large").into());
    }
    let files: Vec<&SkillFolderFile> = listed
        .files
        .iter()
        .filter(|file| file.rel != IEUM_SOURCE_FILE)
        .collect();
    let stem = file_stem_of(Some(&skill.title));
    Ok(SkillExportInfo {
        file_name: format!(
            "{}.zip",
            if stem.is_empty() {
                skill.name.clone()
            } else {
                stem
            }
        ),
        name: skill.name.clone(),
        includes_template: skill.template.is_some() && skill.template_exists,
        files: files.len(),
        bytes: files.iter().map(|file| file.size).sum(),
    })
}
