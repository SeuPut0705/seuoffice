//! `apps/shell/src/main/user-skills/user-skills-service.ts`: the person's
//! skills in the shell's main process: the list with its states, state
//! changes, the app-owned skill folder's writes, imports, GitHub updates,
//! export, and the AI's reads. No Electron here.
//!
//! The service reads and writes the folders and the settings file itself. What
//! needs a JS library with no Rust yet goes through [`SkillLibrary`], which the
//! caller implements: the import pipeline (`prepareSkillImport`,
//! `installImportedSkills`, `disposeSkillImport`: archive.ts, github.ts,
//! warnings.ts and the prepare half of import.ts, about 1,200 lines), the
//! GitHub update check and apply (update.ts, 244 lines) and the zip writers of
//! export.ts (about 70 lines). The Electron trash and the clock are
//! [`UserSkillsHost`].
//!
//! An async function that rejects returns `Err(Failure::Thrown(..))`; a
//! result that is `{ ok: false, reason }` returns `Err(Failure::Fail(..))`; an
//! `{ ok: true, ... }` result returns its parts in `Ok`.

use std::fs;
use std::io::Read;

use jscompat::node_path::host;
use jscompat::{JsMap, JsObject, JsonValue, js_regex, trim};

use crate::node_fs::NodeError;
use crate::packages::ai_provider::user_skill_md::{
    EditorsText, IEUM_EDITORS_KEY, IEUM_SOURCE_FILE, IEUM_TEMPLATE_KEY, IEUM_TITLE_KEY,
    MAX_USER_SKILL_BYTES, MAX_USER_SKILL_FILES, SKILL_TEXT_EXTENSIONS, SkillMdError, SkillMdInput,
    is_inside_dir, parse_skill_md, real_path, render_skill_md,
};
use crate::packages::ai_provider::user_skills_folder::{
    SkillExportInfo, SkillFolderLimits, UserSkillSourceOptions, app_skills_dir_of,
    list_skill_folder_files, list_user_skills, mcp_servers_of_skill_md, read_listed_skill_md,
    skill_export_info,
};
use crate::packages::ai_provider::user_skills_import::{
    ChangedCheck, CollisionChoices, CommitSkillInstallOptions, DiscardFailed, DiscardReplaced,
    GitHubSkillUpdateCheck, InstallImportedSkillsResult, InstalledSkill, SKILL_STAGING_PREFIX,
    SkillImport, SkillImportCandidate, SkillImportError, SkillImportOrigin, SkillImportSource,
    SkillInstallPlan, Thrown, app_skill_folders_by_name, commit_skill_install, copy_file_over,
    mkdir, mkdir_recursive, random_hex, read_ieum_source_record, read_text, remove_quietly, rename,
    write_file, write_file_exclusive,
};
use crate::packages::ai_provider::user_skills_states::{
    ResolvedUserSkill, UserSkillSettings, UserSkillStateSetting, initial_user_skill_state,
    parse_user_skill_id, pick_enabled_user_skills, random_skill_suffix, resolve_user_skill_states,
    skill_editor_scope, skill_editors_choice_of, skill_editors_of, suggest_user_skill_name,
    user_skill_id, validate_new_user_skill_name,
};
use crate::packages::electron_utils::user_skills_channels::USER_SKILL_PREVIEW_TEXT_MAX_CHARS;
use crate::shell::app_settings::{read_skill_settings, update_skill_settings};

/// Largest skill file the AI may read in one call (spec 5.8; tunable)
pub const AI_SKILL_FILE_MAX_BYTES: u64 = 200 * 1024;

/// Largest template document a skill card saves (the folder limit)
pub const SKILL_TEMPLATE_MAX_BYTES: u64 = MAX_USER_SKILL_BYTES;

/// Documents a template may be (spec 5.7): the formats the app's editors open
const TEMPLATE_EXTENSIONS: [&str; 17] = [
    ".docx",
    ".odt",
    ".xlsx",
    ".xlsm",
    ".xls",
    ".csv",
    ".tsv",
    ".pptx",
    ".pdf",
    ".md",
    ".markdown",
    ".txt",
    ".html",
    ".htm",
    ".xmind",
    ".hwp",
    ".hwpx",
];

fn folder_limits() -> SkillFolderLimits {
    SkillFolderLimits {
        files: MAX_USER_SKILL_FILES,
        bytes: MAX_USER_SKILL_BYTES,
    }
}

// ---- results ----

/// `UserSkillsFail`: `{ ok: false, reason, problem? }`
#[derive(Debug, Clone, PartialEq)]
pub struct UserSkillsFail {
    pub reason: String,
    pub problem: Option<String>,
}

impl UserSkillsFail {
    pub fn to_json(&self) -> JsonValue {
        let mut object = JsObject::new();
        object.set("ok", JsonValue::Bool(false));
        object.set("reason", text(&self.reason));
        if let Some(problem) = &self.problem {
            object.set("problem", text(problem));
        }
        JsonValue::Object(object)
    }
}

fn fail(reason: &str) -> UserSkillsFail {
    UserSkillsFail {
        reason: reason.to_owned(),
        problem: None,
    }
}

fn fail_with(reason: &str, problem: &str) -> UserSkillsFail {
    UserSkillsFail {
        reason: reason.to_owned(),
        problem: Some(problem.to_owned()),
    }
}

/// `failureOf(error)`: a thrown error as a result: the core's kinds pass
/// through, the rest is a failure
pub fn failure_of(error: &Thrown) -> UserSkillsFail {
    match error {
        Thrown::Import(error) => fail(error.kind),
        _ => fail("failed"),
    }
}

/// What a method of the service ends with other than its value
#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    /// the method resolved with `{ ok: false, reason }`
    Fail(UserSkillsFail),
    /// the method rejected
    Thrown(Thrown),
}

impl Failure {
    /// What `.catch(failureOf)` makes of it
    pub fn as_fail(&self) -> UserSkillsFail {
        match self {
            Failure::Fail(fail) => fail.clone(),
            Failure::Thrown(thrown) => failure_of(thrown),
        }
    }
}

impl From<UserSkillsFail> for Failure {
    fn from(value: UserSkillsFail) -> Self {
        Failure::Fail(value)
    }
}

impl From<Thrown> for Failure {
    fn from(value: Thrown) -> Self {
        Failure::Thrown(value)
    }
}

impl From<NodeError> for Failure {
    fn from(value: NodeError) -> Self {
        Failure::Thrown(Thrown::Node(value))
    }
}

impl From<SkillMdError> for Failure {
    fn from(value: SkillMdError) -> Self {
        Failure::Thrown(Thrown::Range(value))
    }
}

impl From<SkillImportError> for Failure {
    fn from(value: SkillImportError) -> Self {
        Failure::Thrown(Thrown::Import(value))
    }
}

pub type Svc<T> = Result<T, Failure>;

/// a `try { ... } catch (error) { return failureOf(error) }`
fn catching<T>(result: Result<T, Thrown>) -> Svc<T> {
    result.map_err(|error| Failure::Fail(failure_of(&error)))
}

// ---- what the caller supplies ----

/// `UserSkillsServiceDeps`, less the GitHub fetch (it is the library's)
pub trait UserSkillsHost {
    fn home_dir(&self) -> String;
    /// the builtin skills folder; none in a build without it
    fn builtin_dir(&self) -> Option<String>;
    /// userData/app-settings.json
    fn settings_path(&self) -> String;
    /// where imports and update checks make their temporary folders
    fn temp_dir(&self) -> String;
    /// moves a folder to the OS trash; `Err` when it cannot go
    fn trash(&mut self, path: &str) -> Result<(), DiscardFailed>;
    /// `new Date()` in milliseconds since the epoch
    fn now_ms(&self) -> f64;
}

/// `signal.aborted` of the abort signal an import or update check runs under
pub type Aborted<'a> = &'a dyn Fn() -> bool;

/// How a replaced folder goes away: the shell's trash
pub type Discard<'a> = DiscardReplaced<'a>;

/// the `prepareSkillImport` environment, less the fetch and the signal
#[derive(Debug, Clone, PartialEq)]
pub struct PrepareEnv {
    pub app_skills_dir: String,
    pub home_dir: String,
    pub temp_dir: String,
}

/// the `installImportedSkills` options, less `discardReplaced`
#[derive(Debug, Clone, PartialEq)]
pub struct InstallOptions {
    pub app_skills_dir: String,
    pub selected: Vec<String>,
    pub on_collision: CollisionChoices,
}

/// the `checkGitHubSkillUpdate` options, less the fetch and the signal
#[derive(Debug, Clone, PartialEq)]
pub struct CheckUpdateOptions {
    pub skill_dir: String,
    pub app_skills_dir: String,
    pub temp_dir: String,
}

/// the `applyGitHubSkillUpdate` options, less `discardReplaced`
#[derive(Debug, Clone, PartialEq)]
pub struct ApplyUpdateOptions {
    pub app_skills_dir: String,
    pub skill_dir: String,
}

/// What `@seuoffice/ai-provider` does with archives, GitHub and zip writing.
/// The caller implements it; a method answers what the TypeScript function it
/// is named for resolves with, or rejects with.
pub trait SkillLibrary {
    /// `prepareSkillImport(source, env)`
    fn prepare_skill_import(
        &mut self,
        source: &SkillImportSource,
        env: &PrepareEnv,
        aborted: Option<Aborted<'_>>,
    ) -> Result<SkillImport, Thrown>;
    /// `installImportedSkills(imported, options)`
    fn install_imported_skills(
        &mut self,
        imported: &SkillImport,
        options: &InstallOptions,
        discard: Discard<'_>,
    ) -> Result<InstallImportedSkillsResult, Thrown>;
    /// `disposeSkillImport(imported)`
    fn dispose_skill_import(&mut self, imported: &SkillImport);
    /// `checkGitHubSkillUpdate(options)`
    fn check_github_skill_update(
        &mut self,
        options: &CheckUpdateOptions,
        aborted: Option<Aborted<'_>>,
    ) -> Result<GitHubSkillUpdateCheck, Thrown>;
    /// `applyGitHubSkillUpdate(check, options)`
    fn apply_github_skill_update(
        &mut self,
        check: &ChangedCheck,
        options: &ApplyUpdateOptions,
        discard: Discard<'_>,
    ) -> Result<InstalledSkill, Thrown>;
    /// `exportSkillZip(skillDir, outPath)`
    fn export_skill_zip(&mut self, skill_dir: &str, out_path: &str) -> Result<(), Thrown>;
    /// `exportSkillBundleZip(skillDirs, outPath)`
    fn export_skill_bundle_zip(
        &mut self,
        skill_dirs: &[String],
        out_path: &str,
    ) -> Result<(), Thrown>;
}

// ---- inputs ----

/// `UserSkillStatePatch`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UserSkillStatePatch {
    pub enabled: Option<bool>,
    pub invoke: Option<String>,
    /// `'all'` or a list of ids, as `statePatchOf` hands it over
    pub editors: Option<JsonValue>,
}

impl UserSkillStatePatch {
    /// the value `statePatchOf` answers
    pub fn from_json(value: &JsonValue) -> UserSkillStatePatch {
        let JsonValue::Object(object) = value else {
            return UserSkillStatePatch::default();
        };
        UserSkillStatePatch {
            enabled: match object.get("enabled") {
                Some(JsonValue::Bool(flag)) => Some(*flag),
                _ => None,
            },
            invoke: match object.get("invoke") {
                Some(JsonValue::String(invoke)) => Some(invoke.clone()),
                _ => None,
            },
            editors: object.get("editors").cloned(),
        }
    }
}

fn string_of(object: &JsObject<JsonValue>, key: &str) -> Option<String> {
    match object.get(key) {
        Some(JsonValue::String(text)) => Some(text.clone()),
        _ => None,
    }
}

fn flag_of(object: &JsObject<JsonValue>, key: &str) -> bool {
    object.get(key) == Some(&JsonValue::Bool(true))
}

/// `UserSkillSaveInput`
#[derive(Debug, Clone, PartialEq)]
pub struct UserSkillSaveInput {
    pub id: Option<String>,
    pub title: String,
    pub name: Option<String>,
    pub description: String,
    pub body: String,
    pub editors: Option<JsonValue>,
    pub turn_off_same_name: bool,
}

impl UserSkillSaveInput {
    /// from the value `saveInputOf` answers
    pub fn from_json(value: &JsonValue) -> Option<UserSkillSaveInput> {
        let JsonValue::Object(object) = value else {
            return None;
        };
        Some(UserSkillSaveInput {
            id: string_of(object, "id"),
            title: string_of(object, "title")?,
            name: string_of(object, "name"),
            description: string_of(object, "description")?,
            body: string_of(object, "body")?,
            editors: object.get("editors").cloned(),
            turn_off_same_name: flag_of(object, "turnOffSameName"),
        })
    }
}

/// `UserSkillTemplateInput`: `bytes` is `None` for a value that is no `Uint8Array`
#[derive(Debug, Clone, PartialEq)]
pub struct UserSkillTemplateInput {
    pub bytes: Option<Vec<u8>>,
    pub file_name: String,
}

/// `UserSkillCardSaveInput`
#[derive(Debug, Clone, PartialEq)]
pub struct UserSkillCardSaveInput {
    pub title: String,
    pub name: String,
    pub description: String,
    pub body: String,
    pub invoke: String,
    pub template: Option<UserSkillTemplateInput>,
    pub target_id: Option<String>,
    pub overwrite: bool,
    pub editors: Option<JsonValue>,
    pub turn_off_same_name: bool,
}

impl UserSkillCardSaveInput {
    /// from the value `cardSaveInputOf` answers; `template_bytes` are the
    /// bytes its `template.bytes` stands for
    pub fn from_json(
        value: &JsonValue,
        template_bytes: Option<Vec<u8>>,
    ) -> Option<UserSkillCardSaveInput> {
        let JsonValue::Object(object) = value else {
            return None;
        };
        let template = match object.get("template") {
            Some(JsonValue::Object(template)) => Some(UserSkillTemplateInput {
                bytes: template_bytes,
                file_name: string_of(template, "fileName")?,
            }),
            _ => None,
        };
        Some(UserSkillCardSaveInput {
            title: string_of(object, "title")?,
            name: string_of(object, "name")?,
            description: string_of(object, "description")?,
            body: string_of(object, "body")?,
            invoke: string_of(object, "invoke")?,
            template,
            target_id: string_of(object, "targetId"),
            overwrite: flag_of(object, "overwrite"),
            editors: object.get("editors").cloned(),
            turn_off_same_name: flag_of(object, "turnOffSameName"),
        })
    }
}

/// An enabled skill as the agent session's bundle takes it
#[derive(Debug, Clone, PartialEq)]
pub struct AgentEnabledSkill {
    pub id: String,
    pub source: String,
    pub plugin: Option<String>,
    pub name: String,
    pub title: String,
    pub description: String,
    /// the skill folder
    pub dir: String,
    pub invoke: String,
    pub agent_only: bool,
}

/// The template file `templateFile` finds
#[derive(Debug, Clone, PartialEq)]
pub struct TemplateFile {
    pub path: String,
    pub file_name: String,
    pub title: String,
}

/// What `install` answers: `{ ok: true, installed: [{ key, id }], skipped }`
#[derive(Debug, Clone, PartialEq)]
pub struct InstallDone {
    /// `(key, id)` of each skill installed
    pub installed: Vec<(String, String)>,
    /// keys skipped because of a name already taken
    pub skipped: Vec<String>,
}

/// What an own skill hands on when another version takes its folder
#[derive(Debug, Clone, PartialEq)]
pub struct ReplacedSkill {
    pub id: String,
    /// `metadata.ieum-editors` as its file wrote it; `None` when the file named none
    pub editors_text: Option<String>,
}

// ---- JSON of the results ----

fn text(value: &str) -> JsonValue {
    JsonValue::String(value.to_owned())
}

fn num(value: f64) -> JsonValue {
    JsonValue::Number(value)
}

fn strings(values: &[String]) -> JsonValue {
    JsonValue::Array(values.iter().map(|value| text(value)).collect())
}

fn editor_ids(ids: &[&str]) -> JsonValue {
    JsonValue::Array(ids.iter().map(|id| text(id)).collect())
}

fn put(object: &mut JsObject<JsonValue>, key: &str, value: Option<JsonValue>) {
    if let Some(value) = value {
        object.set(key, value);
    }
}

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// `viewOf(skill, github, shadowedBy, owned)`
fn view_of(
    skill: &ResolvedUserSkill,
    github: Option<JsonValue>,
    shadowed_by: Option<&str>,
    owned: bool,
) -> JsonValue {
    let other = skill.source == "user" || skill.source == "plugin" || skill.source == "codex";
    let mut view = JsObject::new();
    view.set("id", text(&skill.id));
    view.set("source", text(&skill.source));
    put(&mut view, "plugin", skill.plugin.as_deref().map(text));
    view.set("name", text(&skill.name));
    view.set("title", text(&skill.title));
    view.set("description", text(&skill.description));
    view.set("enabled", JsonValue::Bool(skill.enabled));
    view.set("invoke", text(&skill.invoke));
    view.set("hidden", JsonValue::Bool(skill.hidden));
    view.set("hasScripts", JsonValue::Bool(skill.has_scripts));
    view.set("mcpServers", strings(&skill.mcp_servers));
    put(&mut view, "template", skill.template.as_deref().map(text));
    view.set("templateExists", JsonValue::Bool(skill.template_exists));
    view.set("agentOnly", JsonValue::Bool(skill.agent_only));
    put(
        &mut view,
        "editors",
        skill.editors.as_deref().map(editor_ids),
    );
    put(&mut view, "unreadable", skill.unreadable.map(text));
    view.set("files", num(skill.files as f64));
    view.set("bytes", num(skill.bytes as f64));
    put(&mut view, "github", github);
    view.set("owned", JsonValue::Bool(owned));
    let mut can = JsObject::new();
    can.set("edit", JsonValue::Bool(owned));
    can.set(
        "copyToMine",
        JsonValue::Bool(skill.source == "builtin" || other),
    );
    can.set("export", JsonValue::Bool(owned));
    can.set("checkUpdate", JsonValue::Bool(owned && skill.github));
    can.set("openFolder", JsonValue::Bool(owned || other));
    can.set("remove", JsonValue::Bool(owned));
    can.set("hide", JsonValue::Bool(skill.source == "builtin"));
    view.set("can", JsonValue::Object(can));
    put(&mut view, "shadowedBy", shadowed_by.map(text));
    JsonValue::Object(view)
}

/// `candidateView(candidate)`
fn candidate_view(candidate: &SkillImportCandidate) -> JsonValue {
    let mut view = JsObject::new();
    view.set("key", text(&candidate.key));
    view.set("rel", text(&candidate.rel));
    view.set("name", text(&candidate.name));
    view.set("title", text(&candidate.title));
    view.set("description", text(&candidate.description));
    view.set("files", num(candidate.files as f64));
    view.set("bytes", num(candidate.bytes as f64));
    view.set("hasScripts", JsonValue::Bool(candidate.has_scripts));
    view.set("hasTemplate", JsonValue::Bool(candidate.has_template));
    view.set("urls", strings(&candidate.urls));
    view.set("urlCount", num(candidate.url_count as f64));
    put(&mut view, "license", candidate.license.as_deref().map(text));
    let warnings = candidate
        .warnings
        .iter()
        .map(|warning| {
            let mut entry = JsObject::new();
            entry.set("messageKey", text(&warning.message_key));
            entry.set("file", text(&warning.file));
            entry.set("line", num(warning.line));
            entry.set("excerpt", text(&warning.excerpt));
            JsonValue::Object(entry)
        })
        .collect();
    view.set("warnings", JsonValue::Array(warnings));
    view.set("warningCount", num(candidate.warning_count as f64));
    view.set("collision", JsonValue::Bool(candidate.collision));
    view.set("emptyBody", JsonValue::Bool(candidate.empty_body));
    put(&mut view, "problem", candidate.problem.map(text));
    JsonValue::Object(view)
}

/// `importPreviewOf(imported, token)`: what an import preview shows (no folder paths)
pub fn import_preview_of(imported: &SkillImport, token: &str) -> JsonValue {
    let mut origin = JsObject::new();
    match &imported.origin {
        SkillImportOrigin::Github {
            repo,
            ref_,
            commit,
            path,
        } => {
            origin.set("kind", text("github"));
            origin.set("repo", text(repo));
            origin.set("ref", text(ref_));
            origin.set("commit", text(commit));
            origin.set("path", text(path));
        }
        SkillImportOrigin::Folder { .. } => origin.set("kind", text("folder")),
        SkillImportOrigin::Zip { .. } => origin.set("kind", text("zip")),
        SkillImportOrigin::SkillFile { .. } => origin.set("kind", text("skill-file")),
        SkillImportOrigin::Text => origin.set("kind", text("text")),
    }
    let mut preview = JsObject::new();
    preview.set("token", text(token));
    preview.set("origin", JsonValue::Object(origin));
    preview.set(
        "candidates",
        JsonValue::Array(imported.candidates.iter().map(candidate_view).collect()),
    );
    put(
        &mut preview,
        "rootLicense",
        imported.root_license.as_deref().map(text),
    );
    JsonValue::Object(preview)
}

// ---- helpers of the file ----

/// `clearState(settings, id)`: drop the saved state of a skill so it starts as its source starts
fn clear_state(settings: &mut UserSkillSettings, id: &str) {
    let kept: JsObject<UserSkillStateSetting> = settings
        .states
        .entries()
        .into_iter()
        .filter(|(key, _)| !same_name(key, id))
        .map(|(key, value)| (key.to_owned(), value.clone()))
        .collect();
    settings.states = kept;
}

/// `String(skillEditorScope(...))` or `String(fileEditors)`
fn scope_string(ids: Option<&[&str]>) -> String {
    match ids {
        Some(ids) => ids.join(","),
        None => "undefined".to_owned(),
    }
}

/// `setStateValue(settings, id, source, patch, fileEditors)`: keep only what
/// differs from the initial state of the source. A where-used choice that
/// says what the skill's file says is not kept either.
fn set_state_value(
    settings: &mut UserSkillSettings,
    id: &str,
    source: &str,
    patch: &UserSkillStatePatch,
    file_editors: Option<&[&'static str]>,
) {
    let (initial_enabled, initial_invoke) = initial_user_skill_state(source);
    let mut next = settings.states.get(id).cloned().unwrap_or_default();
    if let Some(enabled) = patch.enabled {
        next.enabled = Some(enabled);
    }
    if let Some(invoke) = &patch.invoke {
        next.invoke = Some(invoke.clone());
    }
    if let Some(editors) = &patch.editors {
        let choice = skill_editors_choice_of(Some(editors));
        let scope = skill_editor_scope(choice.as_ref(), file_editors);
        let same_as_file = scope_string(scope.as_deref()) == scope_string(file_editors);
        match choice {
            Some(choice) if !same_as_file => next.editors = Some(choice),
            _ => next.editors = None,
        }
    }
    if next.enabled == Some(initial_enabled) {
        next.enabled = None;
    }
    if next.invoke.as_deref() == Some(initial_invoke) {
        next.invoke = None;
    }
    clear_state(settings, id);
    if next != UserSkillStateSetting::default() {
        settings.states.set(id, next);
    }
}

/// `editorsTextOf(choice, base)`: the `metadata.ieum-editors` text a save
/// writes: unchanged when the choice says what the file says, taken out for
/// every editor
fn editors_text_of(
    choice: Option<&JsonValue>,
    base: Option<&str>,
) -> Result<EditorsText, SkillMdError> {
    let Some(choice) = choice else {
        return Ok(EditorsText::Keep);
    };
    let written = match base {
        None => None,
        Some(base) => {
            parse_skill_md(base)?.and_then(|parsed| parsed.metadata.get(IEUM_EDITORS_KEY).cloned())
        }
    };
    let wanted = skill_editor_scope(skill_editors_choice_of(Some(choice)).as_ref(), None);
    let in_file = match &written {
        Some(value) => skill_editors_of(&JsonValue::String(value.clone())),
        None => None,
    };
    if scope_string(wanted.as_deref()) == scope_string(in_file.as_deref()) {
        return Ok(EditorsText::Keep);
    }
    Ok(match wanted {
        Some(ids) => EditorsText::Set(ids.join(" ")),
        None => EditorsText::Remove,
    })
}

/// `cutForPreview(text, more)`: text cut at the preview's display limit,
/// never in the middle of a character pair; `(text, truncated)`
fn cut_for_preview(body: &str, more: bool) -> (String, bool) {
    let max = USER_SKILL_PREVIEW_TEXT_MAX_CHARS as usize;
    let units: Vec<u16> = body.encode_utf16().collect();
    if units.len() <= max {
        return (body.to_owned(), more);
    }
    let last = units[max - 1];
    let end = if (0xd800..=0xdbff).contains(&last) {
        max - 1
    } else {
        max
    };
    (String::from_utf16_lossy(&units[..end]), true)
}

fn text_of_cut(cut: (String, bool)) -> JsonValue {
    let mut object = JsObject::new();
    object.set("text", JsonValue::String(cut.0));
    object.set("truncated", JsonValue::Bool(cut.1));
    JsonValue::Object(object)
}

/// `readFileHead(path)`: the start of a text file, as much as a preview shows
fn read_file_head(path: &str) -> Result<(String, bool), NodeError> {
    let mut file =
        fs::File::open(path).map_err(|e| crate::node_fs::node_error(&e, "open", path))?;
    // four bytes cover any one character, so the head holds at least the display limit
    let mut head = vec![0u8; USER_SKILL_PREVIEW_TEXT_MAX_CHARS as usize * 4];
    let mut filled = 0;
    while filled < head.len() {
        let read = file
            .read(&mut head[filled..])
            .map_err(|e| crate::node_fs::node_error_fd(&e, "read"))?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    let size = file
        .metadata()
        .map_err(|e| crate::node_fs::node_error_fd(&e, "fstat"))?
        .len();
    let more = (filled as u64) < size;
    let decoded = String::from_utf8_lossy(&head[..filled]).into_owned();
    // a character cut by the end of the head reads as U+FFFD
    let body = if more {
        decoded
            .strip_suffix('\u{fffd}')
            .unwrap_or(&decoded)
            .to_owned()
    } else {
        decoded
    };
    Ok(cut_for_preview(&body, more))
}

/// `skillRelOf(rel)`: a path inside a skill folder as a caller gave it, `/`
/// between parts; `None` when it leads out
fn skill_rel_of(rel: &str) -> Option<String> {
    let backslashes = rel.replace('\\', "/");
    let wanted = backslashes.strip_prefix("./").unwrap_or(&backslashes);
    let parts: Vec<&str> = wanted.split('/').collect();
    let leads_out = wanted.is_empty()
        || host::is_absolute(rel)
        || js_regex!(r"^[A-Za-z]:").test(wanted)
        || parts
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == "..");
    if leads_out {
        None
    } else {
        Some(wanted.to_owned())
    }
}

fn has_text_extension(rel: &str) -> bool {
    SKILL_TEXT_EXTENSIONS.contains(&host::extname(rel).to_lowercase().as_str())
}

/// `isOtherTextFile(rel)`: whether a listed file is one of a skill's text
/// files besides its SKILL.md and source record
fn is_other_text_file(rel: &str) -> bool {
    rel != "SKILL.md" && rel != IEUM_SOURCE_FILE && has_text_extension(rel)
}

/// `skillTextFileIn(dir, rel)`: one text file of a skill folder by its path
/// inside it. The file must be one the folder listing finds, its real place
/// must be inside the folder's, and it must be a text type.
fn skill_text_file_in(dir: &str, rel: &str) -> Result<(String, u64), UserSkillsFail> {
    let Some(wanted) = skill_rel_of(rel) else {
        return Err(fail("outside"));
    };
    if !has_text_extension(&wanted) {
        return Err(fail("not-text"));
    }
    let Some(listed) = list_skill_folder_files(dir, Some(&folder_limits())) else {
        return Err(fail("unreadable"));
    };
    let file = listed
        .files
        .iter()
        .find(|entry| entry.rel == wanted)
        .or_else(|| {
            if cfg!(windows) {
                listed
                    .files
                    .iter()
                    .find(|entry| same_name(&entry.rel, &wanted))
            } else {
                None
            }
        });
    let Some(file) = file else {
        let mut there = dir.to_owned();
        for part in wanted.split('/') {
            there = host::join(&[&there, part]);
        }
        return Err(if fs::metadata(&there).is_ok() {
            fail("outside")
        } else {
            fail("not-found")
        });
    };
    let root = real_path(dir);
    let real = real_path(&file.path);
    match (root, real) {
        (Some(root), Some(real)) if is_inside_dir(&real, &root) => {
            Ok((file.path.clone(), file.size))
        }
        _ => Err(fail("outside")),
    }
}

/// `templateFileNameOf(raw)`: a template file name as it goes under
/// `assets/`: one plain name with a document extension
pub fn template_file_name_of(raw: &str) -> Option<String> {
    let last = js_regex!(r"[\\/]").split(raw).pop().unwrap_or("");
    let stripped =
        js_regex!(r#"[<>:"|?*\u0000-\u001f\u007f]"#).replace_all(last, |_| String::new());
    let trimmed = trim(&stripped);
    let undotted = js_regex!(r"^\.+").replace_all(trimmed, |_| String::new());
    let cleaned = js_regex!(r"[. ]+$").replace_all(&undotted, |_| String::new());
    let units = cleaned.encode_utf16().count();
    if cleaned.is_empty() || units > 150 {
        return None;
    }
    let extension = host::extname(&cleaned).to_lowercase();
    if !TEMPLATE_EXTENSIONS.contains(&extension.as_str())
        || units == extension.encode_utf16().count()
    {
        return None;
    }
    Some(cleaned)
}

/// `writeFileAtomic(path, data)`: a file by a temporary name beside it and a
/// rename, so it is never half written
fn write_file_atomic(path: &str, data: &[u8]) -> Result<(), NodeError> {
    let temp = host::join(&[
        &host::dirname(path),
        &format!(".{}.{}.tmp", host::basename(path, None), random_hex(4)),
    ]);
    let written = write_file_exclusive(&temp, data).and_then(|()| rename(&temp, path));
    if written.is_err() {
        remove_quietly(&temp);
    }
    written
}

/// `stagedCandidate(dir, name)`: a folder of the app's skills folder handed
/// to the core installer as an import candidate
fn staged_candidate(dir: &str, name: &str) -> SkillImportCandidate {
    SkillImportCandidate {
        key: name.to_owned(),
        rel: String::new(),
        dir: dir.to_owned(),
        name: name.to_owned(),
        title: name.to_owned(),
        description: String::new(),
        files: 0,
        bytes: 0,
        has_scripts: false,
        has_template: false,
        urls: Vec::new(),
        url_count: 0,
        license: None,
        warnings: Vec::new(),
        warning_count: 0,
        collision: false,
        empty_body: false,
        problem: None,
    }
}

/// `templateOf(input)`: a card's template, or why it cannot be one
fn template_of(input: &UserSkillTemplateInput) -> Result<(Vec<u8>, String), UserSkillsFail> {
    let file_name = template_file_name_of(&input.file_name);
    let (Some(file_name), Some(bytes)) = (file_name, &input.bytes) else {
        return Err(fail("bad-template"));
    };
    if bytes.len() as u64 > SKILL_TEMPLATE_MAX_BYTES {
        return Err(fail("too-large"));
    }
    Ok((bytes.clone(), file_name))
}

fn read_skill_md_text(dir: &str) -> Option<String> {
    read_text(&host::join(&[dir, "SKILL.md"])).ok()
}

/// `writeSkill`'s request
struct WriteRequest {
    title: String,
    name: Option<String>,
    description: String,
    body: String,
    invoke: Option<String>,
    template: Option<UserSkillTemplateInput>,
    target_id: Option<String>,
    overwrite: bool,
    editors: Option<JsonValue>,
    /// the person agreed that enabled skills of other sources with this name are turned off
    turn_off_same_name: bool,
}

/// `sourcesOf(skills)`: where the skills of `enabledElsewhere` come from
fn sources_of(skills: &[ResolvedUserSkill]) -> String {
    let mut sources: Vec<String> = Vec::new();
    for skill in skills {
        let source = if skill.source == "plugin" {
            format!("plugin:{}", skill.plugin.clone().unwrap_or_default())
        } else {
            skill.source.clone()
        };
        if !sources.contains(&source) {
            sources.push(source);
        }
    }
    sources.join(",")
}

/// `turnOff(settings, skill)`: turn another source's skill off
fn turn_off(settings: &mut UserSkillSettings, skill: &ResolvedUserSkill) {
    let patch = UserSkillStatePatch {
        enabled: Some(false),
        ..UserSkillStatePatch::default()
    };
    set_state_value(settings, &skill.id, &skill.source, &patch, None);
}

// ---- the service ----

/// `createUserSkillsService(deps)`
pub struct UserSkillsService<H: UserSkillsHost, L: SkillLibrary> {
    pub host: H,
    pub library: L,
    ai_file_max: u64,
}

impl<H: UserSkillsHost, L: SkillLibrary> UserSkillsService<H, L> {
    pub fn new(host: H, library: L, ai_file_max_bytes: Option<u64>) -> Self {
        UserSkillsService {
            host,
            library,
            ai_file_max: ai_file_max_bytes.unwrap_or(AI_SKILL_FILE_MAX_BYTES),
        }
    }

    pub fn app_skills_dir(&self) -> String {
        app_skills_dir_of(&self.host.home_dir())
    }

    fn settings_path(&self) -> String {
        self.host.settings_path()
    }

    /// `resolved(projectRoot)`
    fn resolved(&self, project_root: Option<&str>) -> Svc<Vec<ResolvedUserSkill>> {
        let skills = list_user_skills(&UserSkillSourceOptions {
            home_dir: self.host.home_dir(),
            builtin_dir: self.host.builtin_dir(),
            app_skills_dir: None,
            project_root: project_root.map(str::to_owned),
        })?;
        let settings = read_skill_settings(&self.settings_path()).to_json();
        Ok(resolve_user_skill_states(skills, Some(&settings)))
    }

    /// `find(id)`
    fn find(&self, id: &str) -> Svc<Option<ResolvedUserSkill>> {
        let parsed = parse_user_skill_id(id);
        if parsed.is_none_or(|parsed| parsed.source == "project") {
            return Ok(None);
        }
        let all = self.resolved(None)?;
        let exact = all.iter().position(|skill| skill.id == id);
        let at = exact.or_else(|| all.iter().position(|skill| same_name(&skill.id, id)));
        Ok(at.map(|at| all[at].clone()))
    }

    /// `ownedDir(skill)`: an own skill's folder: a direct child of the app's
    /// skills folder whose real place is inside the app's skills folder too.
    /// A linked folder leading elsewhere is read, but never written, deleted
    /// or edited through.
    fn owned_dir(&self, skill: &ResolvedUserSkill) -> Option<String> {
        if skill.source != "app" {
            return None;
        }
        let root = self.app_skills_dir();
        let dir = host::resolve(&[&skill.dir]);
        let parent = host::dirname(&dir);
        let child = is_inside_dir(&parent, &root) && is_inside_dir(&root, &parent);
        if !child || is_inside_dir(&root, &dir) {
            return None;
        }
        let real_root = real_path(&root)?;
        let real = real_path(&dir)?;
        if is_inside_dir(&real, &real_root) && !is_inside_dir(&real_root, &real) {
            Some(dir)
        } else {
            None
        }
    }

    fn change_settings(
        &self,
        change: impl FnOnce(&mut UserSkillSettings),
    ) -> Result<(), NodeError> {
        update_skill_settings(&self.settings_path(), change).map(|_| ())
    }

    fn taken_names(&self) -> Svc<JsMap<Vec<String>>> {
        Ok(app_skill_folders_by_name(&self.app_skills_dir())?)
    }

    /// `nameProblem(name, except)`: the strict rule for a name the app writes,
    /// and whether an own skill has it
    fn name_problem(&self, name: &str, except: Option<&str>) -> Svc<Option<String>> {
        if let Some(problem) = validate_new_user_skill_name(name) {
            return Ok(Some(problem.to_owned()));
        }
        let names = self.taken_names()?;
        let taken = names.get(&name.to_lowercase()).cloned().unwrap_or_default();
        let others: Vec<&String> = match except.filter(|except| !except.is_empty()) {
            Some(except) => taken
                .iter()
                .filter(|dir| !is_inside_dir(dir, except))
                .collect(),
            None => taken.iter().collect(),
        };
        Ok(if others.is_empty() {
            None
        } else {
            Some("taken".to_owned())
        })
    }

    /// `makeWorkDir()`: a work folder inside the app's skills folder (hidden from the list)
    fn make_work_dir(&self) -> Result<String, NodeError> {
        let root = self.app_skills_dir();
        mkdir_recursive(&root)?;
        let dir = host::join(&[
            &root,
            &format!("{SKILL_STAGING_PREFIX}work-{}", random_hex(6)),
        ]);
        mkdir(&dir)?;
        Ok(dir)
    }

    /// `copyFolderInto(from, to)`
    fn copy_folder_into(&self, from: &str, to: &str) -> Result<(), Thrown> {
        let Some(listed) = list_skill_folder_files(from, Some(&folder_limits())) else {
            return Err(SkillImportError::new("failed", format!("Cannot read {from}")).into());
        };
        if listed.too_large {
            return Err(SkillImportError::new("too-large", "The skill folder is too large").into());
        }
        for file in &listed.files {
            if file.rel == IEUM_SOURCE_FILE {
                continue;
            }
            let mut target = to.to_owned();
            for part in file.rel.split('/') {
                target = host::join(&[&target, part]);
            }
            mkdir_recursive(&host::dirname(&target))?;
            copy_file_over(&file.path, &target)?;
        }
        Ok(())
    }

    /// `replacedSkillOf(id)`: an own skill as it is just before another version replaces it
    fn replaced_skill_of(&self, id: &str) -> Svc<Option<ReplacedSkill>> {
        let Some(skill) = self.find(id)? else {
            return Ok(None);
        };
        if skill.source != "app" {
            return Ok(None);
        }
        let body = read_skill_md_text(&skill.dir);
        let parsed = match &body {
            Some(body) => parse_skill_md(body)?,
            None => None,
        };
        Ok(Some(ReplacedSkill {
            id: skill.id.clone(),
            editors_text: parsed.and_then(|parsed| parsed.metadata.get(IEUM_EDITORS_KEY).cloned()),
        }))
    }

    /// `keepAcrossReplace(old, newId, newDir)`: the one rule for what stays
    /// when another version takes an own skill's place (decision 0127)
    fn keep_across_replace(
        &self,
        old: &ReplacedSkill,
        new_id: &str,
        new_dir: &str,
    ) -> Result<(), Thrown> {
        if new_id != old.id {
            self.change_settings(|settings| {
                let kept = settings.states.get(&old.id).cloned();
                clear_state(settings, &old.id);
                clear_state(settings, new_id);
                if let Some(kept) = kept {
                    settings.states.set(new_id, kept);
                }
            })?;
        }
        let Some(editors_text) = &old.editors_text else {
            return Ok(());
        };
        let base = read_skill_md_text(new_dir);
        let parsed = match &base {
            Some(base) => parse_skill_md(base)?,
            None => None,
        };
        let Some(parsed) = parsed else {
            return Ok(());
        };
        let Some(name) = parsed.name.clone().filter(|name| !name.is_empty()) else {
            return Ok(());
        };
        if parsed.metadata.get(IEUM_EDITORS_KEY).is_some() {
            return Ok(());
        }
        let rendered = render_skill_md(
            &SkillMdInput {
                name,
                description: parsed.description.clone().unwrap_or_default(),
                title: parsed.metadata.get(IEUM_TITLE_KEY).cloned(),
                template: parsed.metadata.get(IEUM_TEMPLATE_KEY).cloned(),
                editors: EditorsText::Set(editors_text.clone()),
                body: parsed.body.clone(),
                fields: Vec::new(),
            },
            base.as_deref(),
        )?;
        // the new version is in place either way; a file that cannot be rewritten keeps what it brought
        let _ = write_file_atomic(&host::join(&[new_dir, "SKILL.md"]), rendered.as_bytes());
        Ok(())
    }

    /// `enabledElsewhere(name, exceptId)`: enabled skills of other sources
    /// that carry `name` (builtin, Claude, plugins, Codex)
    fn enabled_elsewhere(
        &self,
        name: &str,
        except_id: Option<&str>,
    ) -> Svc<Vec<ResolvedUserSkill>> {
        Ok(self
            .resolved(None)?
            .into_iter()
            .filter(|skill| {
                skill.source != "app"
                    && skill.enabled
                    && same_name(&skill.name, name)
                    && Some(skill.id.as_str()) != except_id
            })
            .collect())
    }

    /// `place(work, name, replaceDirs)`: put a finished folder into the app's
    /// skills folder under `name`, replacing the given folders (they go to the
    /// OS trash)
    fn place(&mut self, work: &str, name: &str, replace_dirs: Vec<String>) -> Result<(), Thrown> {
        let app_skills_dir = self.app_skills_dir();
        let now_ms = self.host.now_ms();
        let host = &mut self.host;
        let mut discard = |dir: &str| host.trash(dir);
        commit_skill_install(
            &app_skills_dir,
            &[SkillInstallPlan {
                candidate: staged_candidate(work, name),
                folder_name: name.to_owned(),
                replace_dirs,
                source: None,
            }],
            &mut CommitSkillInstallOptions {
                now_ms,
                discard_replaced: Some(&mut discard),
                limits: None,
                random: None,
            },
        )?;
        Ok(())
    }

    /// `writeSkill(request)`
    fn write_skill(&mut self, request: &WriteRequest) -> Svc<String> {
        let description = trim(&request.description).to_owned();
        if description.is_empty() {
            return Err(fail("empty-description").into());
        }
        if trim(&request.body).is_empty() {
            return Err(fail("empty-body").into());
        }

        let mut template: Option<(Vec<u8>, String)> = None;
        if let Some(input) = &request.template {
            template = Some(template_of(input)?);
        }
        let template_path = template
            .as_ref()
            .map(|(_, file_name)| format!("assets/{file_name}"));

        let target = match request.target_id.as_deref().filter(|id| !id.is_empty()) {
            Some(id) => {
                let found = self.find(id)?;
                if found.is_none() {
                    return Err(fail("not-found").into());
                }
                found
            }
            None => None,
        };
        // the title is the person's to give in any language; an empty one takes the key out
        let title = Some(trim(&request.title).to_owned()).filter(|title| !title.is_empty());

        // ---- an edit of an own skill: files rewritten in place, the folder renamed with the name
        if let Some(target) = target.as_ref().filter(|target| target.source == "app") {
            let Some(dir) = self.owned_dir(target) else {
                return Err(fail("not-owned").into());
            };
            let name = request
                .name
                .as_deref()
                .map(|name| trim(name).to_owned())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| target.name.clone());
            if name != target.name {
                let problem = self.name_problem(&name, Some(&dir))?;
                match problem.as_deref() {
                    Some("taken") => return Err(fail("name-taken").into()),
                    Some(problem) => return Err(fail_with("bad-name", problem).into()),
                    None => {}
                }
            }
            // a new name may be one another source's enabled skill has: ask before taking its place
            let elsewhere = if name != target.name {
                self.enabled_elsewhere(&name, None)?
            } else {
                Vec::new()
            };
            if !elsewhere.is_empty() && !request.turn_off_same_name {
                return Err(fail_with("same-name-on", &sources_of(&elsewhere)).into());
            }
            let base = read_skill_md_text(&dir);
            let rendered = render_skill_md(
                &SkillMdInput {
                    name: name.clone(),
                    description,
                    title,
                    template: template_path.clone().or_else(|| target.template.clone()),
                    editors: editors_text_of(request.editors.as_ref(), base.as_deref())?,
                    body: request.body.clone(),
                    fields: Vec::new(),
                },
                base.as_deref(),
            )?;
            let app_skills_dir = self.app_skills_dir();
            let written = (|| -> Result<(), NodeError> {
                if let Some((bytes, file_name)) = &template {
                    mkdir_recursive(&host::join(&[&dir, "assets"]))?;
                    write_file_atomic(&host::join(&[&dir, "assets", file_name]), bytes)?;
                }
                write_file_atomic(&host::join(&[&dir, "SKILL.md"]), rendered.as_bytes())?;
                // an own skill's folder carries its name
                if name != target.name && host::basename(&dir, None) != name {
                    rename(&dir, &host::join(&[&app_skills_dir, &name]))?;
                }
                Ok(())
            })();
            catching(written.map_err(Thrown::Node))?;
            let new_id = user_skill_id("app", &name, None);
            self.change_settings(|settings| {
                let kept = settings.states.get(&target.id).cloned();
                if new_id != target.id {
                    clear_state(settings, &target.id);
                    clear_state(settings, &new_id);
                    if let Some(kept) = kept {
                        settings.states.set(new_id.as_str(), kept);
                    }
                }
                if let Some(invoke) = request
                    .invoke
                    .as_deref()
                    .filter(|invoke| !invoke.is_empty())
                {
                    let patch = UserSkillStatePatch {
                        invoke: Some(invoke.to_owned()),
                        ..UserSkillStatePatch::default()
                    };
                    set_state_value(settings, &new_id, "app", &patch, None);
                }
                for other in &elsewhere {
                    turn_off(settings, other);
                }
            })?;
            return Ok(new_id);
        }

        if target
            .as_ref()
            .is_some_and(|target| target.source == "project")
        {
            return Err(fail("invalid").into());
        }

        // ---- a new skill, or another source's skill copied in with the new text
        let mut name = trim(request.name.as_deref().unwrap_or("")).to_owned();
        if target.is_none() && name.is_empty() {
            let taken: Vec<String> = self.taken_names()?.keys().map(str::to_owned).collect();
            name = suggest_user_skill_name(
                title.as_deref().unwrap_or(""),
                &taken,
                &mut random_skill_suffix,
            );
        }
        if let Some(target) = &target
            && name.is_empty()
        {
            name = target.name.clone();
        }
        let keeps_name = target.as_ref().is_some_and(|target| name == target.name);
        if !keeps_name && let Some(problem) = validate_new_user_skill_name(&name) {
            return Err(fail_with("bad-name", problem).into());
        }
        let taken = self
            .taken_names()?
            .get(&name.to_lowercase())
            .cloned()
            .unwrap_or_default();
        if !taken.is_empty() {
            if target.is_none() {
                return Err(fail("name-taken").into());
            }
            if !request.overwrite {
                return Err(fail("exists").into());
            }
        }
        if target
            .as_ref()
            .is_some_and(|target| target.unreadable == Some("too-large"))
        {
            return Err(fail("too-large").into());
        }
        let elsewhere =
            self.enabled_elsewhere(&name, target.as_ref().map(|target| target.id.as_str()))?;
        if !elsewhere.is_empty() && !request.turn_off_same_name {
            return Err(fail_with("same-name-on", &sources_of(&elsewhere)).into());
        }

        let work = self.make_work_dir()?;
        let built = self.build_new_skill(
            &work,
            &name,
            &description,
            title,
            request,
            target.as_ref(),
            template.as_ref(),
            template_path,
            if target.is_some() { taken } else { Vec::new() },
        );
        remove_quietly(&work);
        catching(built)?;
        let id = user_skill_id("app", &name, None);
        self.change_settings(|settings| {
            clear_state(settings, &id);
            if let Some(invoke) = request
                .invoke
                .as_deref()
                .filter(|invoke| !invoke.is_empty())
            {
                let patch = UserSkillStatePatch {
                    invoke: Some(invoke.to_owned()),
                    ..UserSkillStatePatch::default()
                };
                set_state_value(settings, &id, "app", &patch, None);
            }
            if let Some(target) = &target {
                turn_off(settings, target);
            }
            for other in &elsewhere {
                turn_off(settings, other);
            }
        })?;
        Ok(id)
    }

    /// the `try` body of `writeSkill` for a new skill
    #[allow(clippy::too_many_arguments)]
    fn build_new_skill(
        &mut self,
        work: &str,
        name: &str,
        description: &str,
        title: Option<String>,
        request: &WriteRequest,
        target: Option<&ResolvedUserSkill>,
        template: Option<&(Vec<u8>, String)>,
        template_path: Option<String>,
        replace_dirs: Vec<String>,
    ) -> Result<(), Thrown> {
        if let Some(target) = target {
            self.copy_folder_into(&target.dir, work)?;
        }
        let base = target.and_then(|target| read_skill_md_text(&target.dir));
        let kept_template = match (target, &base) {
            (Some(target), Some(_)) => target.template.clone(),
            _ => None,
        };
        let rendered = render_skill_md(
            &SkillMdInput {
                name: name.to_owned(),
                description: description.to_owned(),
                title,
                template: template_path.or(kept_template),
                editors: editors_text_of(request.editors.as_ref(), base.as_deref())?,
                body: request.body.clone(),
                fields: Vec::new(),
            },
            base.as_deref(),
        )?;
        if let Some((bytes, file_name)) = template {
            mkdir_recursive(&host::join(&[work, "assets"]))?;
            write_file(&host::join(&[work, "assets", file_name]), bytes)?;
        }
        write_file(&host::join(&[work, "SKILL.md"]), rendered.as_bytes())?;
        self.place(work, name, replace_dirs)
    }

    // ---- the methods of the returned object ----

    /// `list()`: every skill of the settings list (project skills are the agent window's only)
    pub fn list(&mut self) -> Svc<Vec<JsonValue>> {
        let all = self.resolved(None)?;
        let picked = pick_enabled_user_skills(&all);
        let mut pushed_back: JsMap<String> = JsMap::new();
        for (index, by) in &picked.shadowed {
            pushed_back.set(all[*index].id.as_str(), by.clone());
        }
        let mut views = Vec::new();
        for skill in &all {
            let mut github: Option<JsonValue> = None;
            if skill.source == "app"
                && skill.github
                && let Some(record) = read_ieum_source_record(&skill.dir)
            {
                let mut object = JsObject::new();
                object.set("repo", text(&record.repo));
                object.set("ref", text(&record.ref_));
                object.set("path", text(&record.path));
                object.set("commit", text(&record.commit));
                github = Some(JsonValue::Object(object));
            }
            let owned = skill.source == "app" && self.owned_dir(skill).is_some();
            views.push(view_of(
                skill,
                github,
                pushed_back.get(&skill.id).map(String::as_str),
                owned,
            ));
        }
        Ok(views)
    }

    /// `read(id)`: a skill's text for the read-only view and the editor
    pub fn read(&mut self, id: &str) -> Svc<JsonValue> {
        let Some(skill) = self.find(id)? else {
            return Err(fail("not-found").into());
        };
        let listed = list_skill_folder_files(&skill.dir, Some(&folder_limits()));
        let listed = match listed {
            Some(listed) if !listed.too_large => listed,
            Some(_) => return Err(fail("too-large").into()),
            None => return Err(fail("unreadable").into()),
        };
        let body = read_skill_md_text(&skill.dir);
        let parsed = match &body {
            Some(body) => parse_skill_md(body)?,
            None => None,
        };
        let mut content = JsObject::new();
        content.set("id", text(&skill.id));
        content.set("name", text(&skill.name));
        content.set("title", text(&skill.title));
        content.set("description", text(&skill.description));
        content.set(
            "body",
            text(match (&parsed, &body) {
                (Some(parsed), _) => parsed.body.as_str(),
                (None, Some(body)) => body.as_str(),
                (None, None) => "",
            }),
        );
        put(
            &mut content,
            "template",
            skill.template.as_deref().map(text),
        );
        put(
            &mut content,
            "editors",
            skill.file_editors.as_deref().map(editor_ids),
        );
        let files = listed
            .files
            .iter()
            .filter(|file| file.rel != IEUM_SOURCE_FILE)
            .map(|file| {
                let mut entry = JsObject::new();
                entry.set("rel", text(&file.rel));
                entry.set("size", num(file.size as f64));
                JsonValue::Object(entry)
            })
            .collect();
        content.set("files", JsonValue::Array(files));
        Ok(JsonValue::Object(content))
    }

    /// `setState(id, patch)`: on/off, when it is used, and where; an own
    /// skill's where-used is in its file
    pub fn set_state(&mut self, id: &str, patch: &UserSkillStatePatch) -> Svc<()> {
        let Some(skill) = self.find(id)? else {
            return Err(fail("not-found").into());
        };
        if patch.enabled == Some(true) && skill.hidden {
            return Err(fail("hidden").into());
        }
        if patch.enabled == Some(true) && skill.unreadable.is_some() {
            return Err(fail("unreadable").into());
        }
        if patch.editors.is_some() && self.owned_dir(&skill).is_some() {
            return Err(fail("invalid").into());
        }
        self.change_settings(|settings| {
            set_state_value(
                settings,
                &skill.id,
                &skill.source,
                patch,
                skill.file_editors.as_deref(),
            );
        })?;
        Ok(())
    }

    /// `hideBuiltin(id)`
    pub fn hide_builtin(&mut self, id: &str) -> Svc<()> {
        let Some(skill) = self.find(id)? else {
            return Err(fail("not-found").into());
        };
        if skill.source != "builtin" {
            return Err(fail("invalid").into());
        }
        self.change_settings(|settings| {
            if !settings
                .hidden_builtins
                .iter()
                .any(|name| same_name(name, &skill.name))
            {
                settings.hidden_builtins.push(skill.name.clone());
            }
            clear_state(settings, &skill.id);
        })?;
        Ok(())
    }

    /// `unhideBuiltins(names)`: show hidden builtins again; each comes back in its initial state
    pub fn unhide_builtins(&mut self, names: Option<&[String]>) -> Svc<()> {
        self.change_settings(|settings| {
            let shown: Vec<String> = match names {
                Some(names) => settings
                    .hidden_builtins
                    .iter()
                    .filter(|hidden| names.iter().any(|name| same_name(name, hidden)))
                    .cloned()
                    .collect(),
                None => settings.hidden_builtins.clone(),
            };
            settings.hidden_builtins = settings
                .hidden_builtins
                .iter()
                .filter(|hidden| !shown.contains(hidden))
                .cloned()
                .collect();
            for name in &shown {
                clear_state(settings, &user_skill_id("builtin", name, None));
            }
        })?;
        Ok(())
    }

    /// `remove(id)`: an own skill to the OS trash; any other source is refused
    pub fn remove(&mut self, id: &str) -> Svc<()> {
        let Some(skill) = self.find(id)? else {
            return Err(fail("not-found").into());
        };
        let Some(dir) = self.owned_dir(&skill) else {
            return Err(fail("not-owned").into());
        };
        if self.host.trash(&dir).is_err() {
            return Err(fail("failed").into());
        }
        self.change_settings(|settings| clear_state(settings, &skill.id))?;
        Ok(())
    }

    /// `copyToMine(id, overwrite)`: copy a builtin or another program's skill
    /// into the app's folder under the same name and turn the original off
    pub fn copy_to_mine(&mut self, id: &str, overwrite: bool) -> Svc<String> {
        let Some(skill) = self.find(id)? else {
            return Err(fail("not-found").into());
        };
        if skill.source == "app" || skill.source == "project" {
            return Err(fail("invalid").into());
        }
        if let Some(reason) = skill.unreadable {
            return Err(fail(if reason == "too-large" {
                "too-large"
            } else {
                "unreadable"
            })
            .into());
        }
        let taken = self
            .taken_names()?
            .get(&skill.name.to_lowercase())
            .cloned()
            .unwrap_or_default();
        if !taken.is_empty() && !overwrite {
            return Err(fail("exists").into());
        }
        let work = self.make_work_dir()?;
        let copied = self.copy_into_work(&skill, &work, taken);
        remove_quietly(&work);
        catching(copied)?;
        let new_id = user_skill_id("app", &skill.name, None);
        self.change_settings(|settings| {
            clear_state(settings, &new_id);
            turn_off(settings, &skill);
        })?;
        Ok(new_id)
    }

    /// the `try` body of `copyToMine`
    fn copy_into_work(
        &mut self,
        skill: &ResolvedUserSkill,
        work: &str,
        taken: Vec<String>,
    ) -> Result<(), Thrown> {
        self.copy_folder_into(&skill.dir, work)?;
        // the copy is mine to edit: the person's where-used choice goes into its file
        let base = read_skill_md_text(work);
        let parsed = match &base {
            Some(base) => parse_skill_md(base)?,
            None => None,
        };
        let all = JsonValue::String("all".to_owned());
        let choice = match &skill.editors {
            Some(ids) => editor_ids(ids),
            None => all,
        };
        let editors = editors_text_of(Some(&choice), base.as_deref())?;
        if let Some(parsed) = parsed
            && editors != EditorsText::Keep
        {
            let rendered = render_skill_md(
                &SkillMdInput {
                    name: parsed.name.clone().unwrap_or_else(|| skill.name.clone()),
                    description: parsed.description.clone().unwrap_or_default(),
                    title: parsed.metadata.get(IEUM_TITLE_KEY).cloned(),
                    template: parsed.metadata.get(IEUM_TEMPLATE_KEY).cloned(),
                    editors,
                    body: parsed.body.clone(),
                    fields: Vec::new(),
                },
                base.as_deref(),
            )?;
            write_file(&host::join(&[work, "SKILL.md"]), rendered.as_bytes())?;
        }
        self.place(work, &skill.name, taken)
    }

    /// `suggestName(title)`: a free name for a new skill from its title
    pub fn suggest_name(&mut self, title: &str) -> Svc<String> {
        let taken: Vec<String> = self.taken_names()?.keys().map(str::to_owned).collect();
        Ok(suggest_user_skill_name(
            title,
            &taken,
            &mut random_skill_suffix,
        ))
    }

    /// `checkName(name, forId)`: the strict rule for a new name; `for_id` is
    /// the own skill being renamed. `None` is `{ ok: true }`, a problem is
    /// `{ ok: false, problem }`.
    pub fn check_name(&mut self, name: &str, for_id: Option<&str>) -> Svc<Option<String>> {
        let skill = match for_id.filter(|id| !id.is_empty()) {
            Some(id) => self.find(id)?,
            None => None,
        };
        let except = skill.as_ref().and_then(|skill| self.owned_dir(skill));
        self.name_problem(name, except.as_deref())
    }

    /// `save(input)`: the settings editor's save: a new skill, or an edit of an own skill
    pub fn save(&mut self, input: &UserSkillSaveInput) -> Svc<String> {
        if let Some(id) = input.id.as_deref().filter(|id| !id.is_empty()) {
            let Some(target) = self.find(id)? else {
                return Err(fail("not-found").into());
            };
            if target.source != "app" {
                return Err(fail("not-owned").into());
            }
        }
        self.write_skill(&WriteRequest {
            title: input.title.clone(),
            name: input.name.clone(),
            description: input.description.clone(),
            body: input.body.clone(),
            invoke: None,
            template: None,
            target_id: input.id.clone(),
            overwrite: false,
            editors: input.editors.clone(),
            turn_off_same_name: input.turn_off_same_name,
        })
    }

    /// `saveFromCard(input)`: a skill card's save (spec 5.6)
    pub fn save_from_card(&mut self, input: &UserSkillCardSaveInput) -> Svc<String> {
        self.write_skill(&WriteRequest {
            title: input.title.clone(),
            name: Some(input.name.clone()),
            description: input.description.clone(),
            body: input.body.clone(),
            invoke: Some(input.invoke.clone()),
            template: input.template.clone(),
            target_id: input.target_id.clone(),
            overwrite: input.overwrite,
            editors: input.editors.clone(),
            turn_off_same_name: input.turn_off_same_name,
        })
    }

    /// `prepare(source, signal)`: find the skills of any import source for the preview
    pub fn prepare(
        &mut self,
        source: &SkillImportSource,
        aborted: Option<Aborted<'_>>,
    ) -> Svc<SkillImport> {
        let env = PrepareEnv {
            app_skills_dir: self.app_skills_dir(),
            home_dir: self.host.home_dir(),
            temp_dir: self.host.temp_dir(),
        };
        Ok(self.library.prepare_skill_import(source, &env, aborted)?)
    }

    /// `install(imported, request)`: install the checked skills of a previewed
    /// import. A new skill starts on, used on its own; one that replaces an own
    /// skill of the same name keeps that skill's settings.
    pub fn install(
        &mut self,
        imported: &SkillImport,
        selected: &[String],
        on_collision: &CollisionChoices,
    ) -> Svc<InstallDone> {
        catching(self.install_inner(imported, selected, on_collision))
    }

    fn install_inner(
        &mut self,
        imported: &SkillImport,
        selected: &[String],
        on_collision: &CollisionChoices,
    ) -> Result<InstallDone, Thrown> {
        let mut replaced_by_key: JsMap<ReplacedSkill> = JsMap::new();
        for candidate in &imported.candidates {
            if !selected.contains(&candidate.key) {
                continue;
            }
            let choice = on_collision
                .iter()
                .find(|(key, _)| *key == candidate.key)
                .map(|(_, choice)| choice.as_str());
            if choice != Some("replace") {
                continue;
            }
            let old = self
                .replaced_skill_of(&user_skill_id("app", &candidate.name, None))
                .map_err(thrown_of)?;
            if let Some(old) = old {
                replaced_by_key.set(candidate.key.as_str(), old);
            }
        }
        let options = InstallOptions {
            app_skills_dir: self.app_skills_dir(),
            selected: selected.to_vec(),
            on_collision: on_collision.clone(),
        };
        let host = &mut self.host;
        let mut discard = |dir: &str| host.trash(dir);
        let done = self
            .library
            .install_imported_skills(imported, &options, &mut discard)?;
        for skill in &done.installed {
            let id = user_skill_id("app", &skill.name, None);
            let old = if skill.replaced {
                replaced_by_key.get(&skill.key)
            } else {
                None
            };
            match old {
                Some(old) => self.keep_across_replace(old, &id, &skill.dir)?,
                None => self.change_settings(|settings| clear_state(settings, &id))?,
            }
        }
        let installed = done
            .installed
            .iter()
            .map(|skill| (skill.key.clone(), user_skill_id("app", &skill.name, None)))
            .collect();
        Ok(InstallDone {
            installed,
            skipped: done.skipped,
        })
    }

    /// `dispose(imported)`
    pub fn dispose(&mut self, imported: &SkillImport) {
        self.library.dispose_skill_import(imported);
    }

    /// `readImported(imported, key)`: a found skill of a previewed import,
    /// opened to read before installing (decision 0127): its SKILL.md after
    /// the front matter, cut at the display limit, and the text files the
    /// preview can open. The `content` of the result.
    pub fn read_imported(&mut self, imported: &SkillImport, key: &str) -> Svc<JsonValue> {
        let Some(candidate) = imported.candidates.iter().find(|found| found.key == key) else {
            return Err(fail("not-found").into());
        };
        if candidate.problem == Some("too-large") {
            return Err(fail("too-large").into());
        }
        let listed = match list_skill_folder_files(&candidate.dir, Some(&folder_limits())) {
            Some(listed) if !listed.too_large => listed,
            Some(_) => return Err(fail("too-large").into()),
            None => return Err(fail("unreadable").into()),
        };
        let Some(body) = read_listed_skill_md(&candidate.dir) else {
            return Err(fail("unreadable").into());
        };
        let parsed = parse_skill_md(&body)?;
        let shown = match &parsed {
            Some(parsed) => parsed.body.as_str(),
            None => body.as_str(),
        };
        let files = listed
            .files
            .iter()
            .filter(|file| is_other_text_file(&file.rel) && !same_name(&file.rel, "SKILL.md"))
            .map(|file| {
                let mut entry = JsObject::new();
                entry.set("rel", text(&file.rel));
                entry.set("size", num(file.size as f64));
                JsonValue::Object(entry)
            })
            .collect();
        let mut content = JsObject::new();
        content.set("body", text_of_cut(cut_for_preview(shown, false)));
        content.set("files", JsonValue::Array(files));
        Ok(JsonValue::Object(content))
    }

    /// `readImportedFile(imported, key, rel)`: one text file of a previewed
    /// import's skill, cut at the display limit. The `file` of the result.
    pub fn read_imported_file(
        &mut self,
        imported: &SkillImport,
        key: &str,
        rel: &str,
    ) -> Svc<JsonValue> {
        let Some(candidate) = imported.candidates.iter().find(|found| found.key == key) else {
            return Err(fail("not-found").into());
        };
        if candidate.problem == Some("too-large") {
            return Err(fail("too-large").into());
        }
        let (path, _) = skill_text_file_in(&candidate.dir, rel)?;
        match read_file_head(&path) {
            Ok(cut) => Ok(text_of_cut(cut)),
            Err(_) => Err(fail("unreadable").into()),
        }
    }

    /// `checkUpdate(id, signal)`: check an own GitHub skill for an update; connects only when called
    pub fn check_update(
        &mut self,
        id: &str,
        aborted: Option<Aborted<'_>>,
    ) -> Svc<GitHubSkillUpdateCheck> {
        let Some(skill) = self.find(id)? else {
            return Err(fail("not-found").into());
        };
        let Some(dir) = self.owned_dir(&skill) else {
            return Err(fail("not-owned").into());
        };
        if !skill.github {
            return Err(fail("not-github").into());
        }
        let options = CheckUpdateOptions {
            skill_dir: dir,
            app_skills_dir: self.app_skills_dir(),
            temp_dir: self.host.temp_dir(),
        };
        catching(self.library.check_github_skill_update(&options, aborted))
    }

    /// `applyUpdate(id, check)`: apply a found update; the skill's settings
    /// stay as they were
    pub fn apply_update(&mut self, id: &str, check: &ChangedCheck) -> Svc<String> {
        let skill = self.find(id)?;
        let dir = match &skill {
            Some(skill) => self.owned_dir(skill),
            None => None,
        };
        let (Some(skill), Some(dir)) = (skill.as_ref(), dir) else {
            self.library.dispose_skill_import(&check.update);
            return Err(fail(if skill.is_some() {
                "not-owned"
            } else {
                "not-found"
            })
            .into());
        };
        catching(self.apply_update_inner(skill, &dir, check))
    }

    fn apply_update_inner(
        &mut self,
        skill: &ResolvedUserSkill,
        dir: &str,
        check: &ChangedCheck,
    ) -> Result<String, Thrown> {
        let old = self.replaced_skill_of(&skill.id).map_err(thrown_of)?;
        let options = ApplyUpdateOptions {
            app_skills_dir: self.app_skills_dir(),
            skill_dir: dir.to_owned(),
        };
        let host = &mut self.host;
        let mut discard = |replaced: &str| host.trash(replaced);
        let done = self
            .library
            .apply_github_skill_update(check, &options, &mut discard)?;
        let new_id = user_skill_id("app", &done.name, None);
        let old = old.unwrap_or(ReplacedSkill {
            id: skill.id.clone(),
            editors_text: None,
        });
        self.keep_across_replace(&old, &new_id, &done.dir)?;
        Ok(new_id)
    }

    /// `exportInfo(id)`
    pub fn export_info(&mut self, id: &str) -> Svc<SkillExportInfo> {
        let Some(skill) = self.find(id)? else {
            return Err(fail("not-found").into());
        };
        let Some(dir) = self.owned_dir(&skill) else {
            return Err(fail("not-owned").into());
        };
        catching(skill_export_info(&dir, None))
    }

    /// `exportTo(id, outPath)`
    pub fn export_to(&mut self, id: &str, out_path: &str) -> Svc<String> {
        let Some(skill) = self.find(id)? else {
            return Err(fail("not-found").into());
        };
        let Some(dir) = self.owned_dir(&skill) else {
            return Err(fail("not-owned").into());
        };
        catching(self.library.export_skill_zip(&dir, out_path))?;
        Ok(out_path.to_owned())
    }

    /// `exportBundleTo(ids, outPath)`: write several own skills into one zip, a folder per skill
    pub fn export_bundle_to(&mut self, ids: &[String], out_path: &str) -> Svc<String> {
        let mut dirs: Vec<String> = Vec::new();
        for id in ids {
            let Some(skill) = self.find(id)? else {
                return Err(fail("not-found").into());
            };
            let Some(dir) = self.owned_dir(&skill) else {
                return Err(fail("not-owned").into());
            };
            dirs.push(dir);
        }
        catching(self.library.export_skill_bundle_zip(&dirs, out_path))?;
        Ok(out_path.to_owned())
    }

    /// `folderOf(id)`: the folder "open folder" shows: own skills and other programs' (not builtin)
    pub fn folder_of(&mut self, id: &str) -> Svc<String> {
        let Some(skill) = self.find(id)? else {
            return Err(fail("not-found").into());
        };
        if skill.source == "builtin" || skill.source == "project" {
            return Err(fail("invalid").into());
        }
        Ok(skill.dir.clone())
    }

    /// the refusals `aiRead`, `templateFile` and `aiReadFile` share
    fn readable_by_ai(&self, id: &str) -> Svc<ResolvedUserSkill> {
        let Some(skill) = self.find(id)? else {
            return Err(fail("not-found").into());
        };
        if skill.agent_only {
            return Err(fail("agent-only").into());
        }
        if skill.unreadable.is_some() {
            return Err(fail("unreadable").into());
        }
        if !skill.enabled {
            return Err(fail("disabled").into());
        }
        Ok(skill)
    }

    /// `aiRead(id)`: `use_skill` (spec 5.8): an enabled skill's body and its
    /// text files. The `skill` of the result.
    pub fn ai_read(&mut self, id: &str) -> Svc<JsonValue> {
        let skill = self.readable_by_ai(id)?;
        let listed = match list_skill_folder_files(&skill.dir, Some(&folder_limits())) {
            Some(listed) if !listed.too_large => listed,
            Some(_) => return Err(fail("too-large").into()),
            None => return Err(fail("unreadable").into()),
        };
        let body = read_skill_md_text(&skill.dir);
        let parsed = match &body {
            Some(body) => parse_skill_md(body)?,
            None => None,
        };
        let Some(parsed) = parsed else {
            return Err(fail("unreadable").into());
        };
        let files: Vec<String> = listed
            .files
            .iter()
            .map(|file| file.rel.clone())
            .filter(|rel| is_other_text_file(rel))
            .collect();
        let mut result = JsObject::new();
        result.set("id", text(&skill.id));
        result.set("name", text(&skill.name));
        result.set("title", text(&skill.title));
        result.set("body", text(&parsed.body));
        result.set("files", strings(&files));
        put(
            &mut result,
            "template",
            if skill.template_exists {
                skill.template.as_deref().map(text)
            } else {
                None
            },
        );
        result.set("hasScripts", JsonValue::Bool(skill.has_scripts));
        // read again from the text sent now, not the list's copy
        result.set("mcpServers", strings(&mcp_servers_of_skill_md(&parsed)));
        Ok(JsonValue::Object(result))
    }

    /// `templateFile(id)`: the template document of an enabled skill (spec
    /// 5.7), for its copy in a new tab: the file's absolute place, only when
    /// it is a document the editors open and it lies inside the skill's folder
    pub fn template_file(&mut self, id: &str) -> Svc<TemplateFile> {
        let skill = self.readable_by_ai(id)?;
        let Some(template) = skill
            .template
            .as_deref()
            .filter(|template| !template.is_empty())
        else {
            return Err(fail("no-template").into());
        };
        let Some(file_name) = template_file_name_of(template) else {
            return Err(fail("bad-template").into());
        };
        let mut path = skill.dir.clone();
        for part in template.split('/') {
            path = host::join(&[&path, part]);
        }
        let info = match fs::metadata(&path) {
            Ok(info) if info.is_file() => info,
            _ => return Err(fail("no-template").into()),
        };
        let (Some(root), Some(real)) = (real_path(&skill.dir), real_path(&path)) else {
            return Err(fail("bad-template").into());
        };
        if !is_inside_dir(&real, &root) {
            return Err(fail("bad-template").into());
        }
        if info.len() > SKILL_TEMPLATE_MAX_BYTES {
            return Err(fail("too-large").into());
        }
        Ok(TemplateFile {
            path: real,
            file_name,
            title: skill.title.clone(),
        })
    }

    /// `aiReadFile(id, rel)`: `read_skill_file` (spec 5.8): one text file
    /// inside an enabled skill's folder, by its path inside the folder
    pub fn ai_read_file(&mut self, id: &str, rel: &str) -> Svc<String> {
        let skill = self.readable_by_ai(id)?;
        let (path, size) = skill_text_file_in(&skill.dir, rel)?;
        if size > self.ai_file_max {
            return Err(fail("too-large").into());
        }
        match read_text(&path) {
            Ok(body) => Ok(body),
            Err(_) => Err(fail("unreadable").into()),
        }
    }

    /// `enabledForAgent(projectRoot)`: the skills an agent session takes (spec
    /// 6.1): every enabled skill, builtin, own, Claude's, plugins' and Codex's,
    /// plus the project's when a folder is given
    pub fn enabled_for_agent(&mut self, project_root: Option<&str>) -> Svc<Vec<AgentEnabledSkill>> {
        let all = self.resolved(project_root.filter(|root| !root.is_empty()))?;
        Ok(all
            .iter()
            .filter(|skill| skill.enabled)
            .map(|skill| AgentEnabledSkill {
                id: skill.id.clone(),
                source: skill.source.clone(),
                plugin: skill.plugin.clone(),
                name: skill.name.clone(),
                title: skill.title.clone(),
                description: skill.description.clone(),
                dir: skill.dir.clone(),
                invoke: skill.invoke.clone(),
                agent_only: skill.agent_only,
            })
            .collect())
    }
}

/// a rejection of a helper that answers a [`Failure`], as the plain `Thrown`
/// a surrounding `try` sees: a `{ ok: false }` result of those helpers never
/// happens, they only reject
fn thrown_of(failure: Failure) -> Thrown {
    match failure {
        Failure::Thrown(thrown) => thrown,
        Failure::Fail(fail) => Thrown::Plain(fail.reason),
    }
}
