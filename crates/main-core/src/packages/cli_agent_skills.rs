//! `packages/cli/src/agent-skills.ts`: installing the bundled `seuoffice`
//! skill into the coding agents found on this machine, shared by Settings ->
//! Integrations and `seuoffice skill`.
//!
//! Pure functions over an injected home and environment, as the TypeScript
//! has them (`home = homedir()` and `env = process.env` are parameters here:
//! the caller names them). The ledger of what this app wrote is a
//! [`SkillLedger`] the caller loads from app settings
//! ([`ledger_from_settings`]) and saves again after [`install_skill`] or
//! [`uninstall_skill`] changed it; both change it in place, as the TypeScript
//! does, even when they then fail.
//!
//! The one thing written that is not a file is the zip of
//! [`build_skill_zip`]: `ooxml-pkg` writes it as JSZip does, except that its
//! deflate stream is its own and its folder entry carries the date of the
//! file (JSZip stamps a folder it makes on its own with the clock).

use std::fs;
use std::io::Write;

use jscompat::node_path::host::{dirname, join};
use jscompat::{JsObject, JsonValue, js_regex, to_iso_string, to_number, trim, truthy};
use ooxml_pkg::Package;
use ooxml_pkg::write::generate;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::cli_install::{Env, exists_sync};
use crate::markdown::fs_util::{plain_error, read_file_bytes, read_file_utf8, rm_file};
use crate::node_fs::{NodeError, namespaced, node_error, node_error_fd};
use crate::packages::i18n::OLD_SKILL_NAMES;

/// `SKILL_NAME` of `names.ts`: the agent skill's `name:` and its folder under
/// an agent's skills directory
pub const SKILL_NAME: &str = "seuoffice";

/// `LEDGER_KEY`: app-settings.json key under which every install this
/// machine's SeuOffice wrote is remembered
pub const LEDGER_KEY: &str = "agentSkillInstalls";

/// `SHARED_AGENT_ID`: the id of the shared `~/.agents` row
pub const SHARED_AGENT_ID: &str = "agents";

/// `AgentTarget`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentTarget {
    /// an `AgentId`
    pub id: String,
    /// product name, shown as is (not translated)
    pub label: String,
    /// global skills directory the agent scans
    #[serde(rename = "skillsDir")]
    pub skills_dir: String,
    /// A tool's own skills folder that the shared `~/.agents` row now serves
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy: Option<bool>,
}

/// `SkillInstallStatus`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillInstallStatus {
    /// no seuoffice/ folder in the skills directory
    Missing,
    /// written by this app, same version and bytes as the bundled skill
    Installed,
    /// written by this app, older than the bundled skill
    Outdated,
    /// written by this app, edited since
    Modified,
    /// our skill by front matter, but not written by this app
    Foreign,
    /// a newer skill version than the one bundled, whoever wrote it
    Newer,
    /// seuoffice/ exists but does not hold our skill
    Occupied,
}

/// `SkillInstallState`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkillInstallState {
    pub status: SkillInstallStatus,
    /// `<skillsDir>/seuoffice/SKILL.md`, or the copy under an earlier name
    /// when only that one is there
    pub path: String,
    #[serde(rename = "installedVersion", skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    /// installed version is older than the bundled one
    #[serde(skip_serializing_if = "Option::is_none")]
    pub older: Option<bool>,
}

/// `AgentRole`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentRole {
    /// the tool reads only its own folder, so it gets a row of its own
    Own,
    /// `~/.agents/skills`, which every reader scans
    Shared,
    /// a tool that reads the shared folder; its own folder is a legacy target
    Reader,
}

/// `AgentDef`
struct AgentDef {
    id: &'static str,
    label: &'static str,
    role: AgentRole,
}

/// `AGENTS`: table order is pane order
static AGENTS: [AgentDef; 9] = [
    AgentDef {
        id: "claude-code",
        label: "Claude Code",
        role: AgentRole::Own,
    },
    AgentDef {
        id: "agents",
        label: "Shared folder (~/.agents): Codex, Cursor, Gemini CLI, Copilot, OpenCode",
        role: AgentRole::Shared,
    },
    AgentDef {
        id: "codex",
        label: "Codex",
        role: AgentRole::Reader,
    },
    AgentDef {
        id: "cursor",
        label: "Cursor",
        role: AgentRole::Reader,
    },
    AgentDef {
        id: "gemini",
        label: "Gemini CLI",
        role: AgentRole::Reader,
    },
    AgentDef {
        id: "copilot",
        label: "GitHub Copilot",
        role: AgentRole::Reader,
    },
    AgentDef {
        id: "opencode",
        label: "OpenCode",
        role: AgentRole::Reader,
    },
    AgentDef {
        id: "dsh",
        label: "DeepSeek Harness (dsh)",
        role: AgentRole::Reader,
    },
    AgentDef {
        id: "windsurf",
        label: "Windsurf",
        role: AgentRole::Own,
    },
];

/// `env.NAME || fallback`
fn env_or(env: Env, name: &str, fallback: impl FnOnce() -> String) -> String {
    let value = env(name);
    match truthy(value.as_deref()) {
        Some(value) => value.to_owned(),
        None => fallback(),
    }
}

impl AgentDef {
    /// `probe`: the tool's own dotfolder: its presence means the tool is installed
    fn probe(&self, env: Env, home: &str) -> String {
        match self.id {
            "claude-code" => env_or(env, "CLAUDE_CONFIG_DIR", || join(&[home, ".claude"])),
            "agents" => join(&[home, ".agents"]),
            "codex" => env_or(env, "CODEX_HOME", || join(&[home, ".codex"])),
            "cursor" => join(&[home, ".cursor"]),
            "gemini" => join(&[home, ".gemini"]),
            "copilot" => join(&[home, ".copilot"]),
            "opencode" => join(&[
                &env_or(env, "XDG_CONFIG_HOME", || join(&[home, ".config"])),
                "opencode",
            ]),
            "dsh" => env_or(env, "DSH_HOME", || join(&[home, ".dsh"])),
            _ => join(&[home, ".codeium", "windsurf"]),
        }
    }

    /// `skills`: the skills directory, inside the probe folder
    fn skills(probe: &str) -> String {
        join(&[probe, "skills"])
    }
}

fn find(id: &str) -> Option<&'static AgentDef> {
    AGENTS.iter().find(|agent| agent.id == id)
}

/// `agentIds`: every name `skill install` takes, in table order
pub fn agent_ids() -> Vec<&'static str> {
    AGENTS.iter().map(|agent| agent.id).collect()
}

/// `skillTargetIds`: the rows a new install can go to
pub fn skill_target_ids() -> Vec<&'static str> {
    AGENTS
        .iter()
        .filter(|agent| agent.role != AgentRole::Reader)
        .map(|agent| agent.id)
        .collect()
}

/// `isSharedReader`: whether `id` is a tool the shared row serves
pub fn is_shared_reader(id: &str) -> bool {
    find(id).map(|agent| agent.role) == Some(AgentRole::Reader)
}

/// `installRowFor`: the row a new install for `id` goes to
pub fn install_row_for(id: &str) -> String {
    if is_shared_reader(id) {
        SHARED_AGENT_ID.to_owned()
    } else {
        id.to_owned()
    }
}

/// `agentLabel`: the product name for any id of the table, the id itself otherwise
pub fn agent_label(id: &str) -> String {
    find(id).map_or(id, |agent| agent.label).to_owned()
}

/// `isDir`
fn is_dir(path: &str) -> bool {
    fs::metadata(namespaced(path)).is_ok_and(|meta| meta.is_dir())
}

/// `agentPresent`: whether the tool is on this machine, judged by its
/// dotfolder; the shared row counts as present when any tool that reads it is
pub fn agent_present(id: &str, env: Env, home: &str) -> bool {
    let Some(agent) = find(id) else {
        return false;
    };
    if is_dir(&agent.probe(env, home)) {
        return true;
    }
    agent.role == AgentRole::Shared
        && AGENTS
            .iter()
            .any(|reader| reader.role == AgentRole::Reader && is_dir(&reader.probe(env, home)))
}

/// `detectAgents`: install rows (own and shared) whose tool is present
pub fn detect_agents(env: Env, home: &str) -> Vec<AgentTarget> {
    let mut out = Vec::new();
    for agent in &AGENTS {
        if agent.role != AgentRole::Reader && agent_present(agent.id, env, home) {
            out.push(target_of(agent, env, home));
        }
    }
    out
}

/// `agentConfigDir`: the dotfolder probed for `id` (env overrides applied)
pub fn agent_config_dir(id: &str, env: Env, home: &str) -> Option<String> {
    find(id).map(|agent| agent.probe(env, home))
}

/// `agentTarget`: the skills folder of any row; for a tool the shared row
/// serves, its own (legacy) folder
pub fn agent_target(id: &str, env: Env, home: &str) -> Option<AgentTarget> {
    find(id).map(|agent| target_of(agent, env, home))
}

/// `legacySkillCopies`: copies this app wrote (by the ledger) into the own
/// folder of a tool the shared row now serves, and that are still there.
/// `only` narrows the list: a reader id to its own copy, the shared row's id
/// to every reader, any other row to none.
pub fn legacy_skill_copies(
    ledger: &SkillLedger,
    env: Env,
    home: &str,
    only: Option<&str>,
) -> Vec<AgentTarget> {
    if let Some(only) = only
        && only != SHARED_AGENT_ID
        && !is_shared_reader(only)
    {
        return Vec::new();
    }
    let mut out = Vec::new();
    for agent in &AGENTS {
        if agent.role != AgentRole::Reader {
            continue;
        }
        if let Some(only) = only
            && only != SHARED_AGENT_ID
            && only != agent.id
        {
            continue;
        }
        let target = target_of(agent, env, home);
        if skill_files_written(&target.skills_dir, ledger)
            .iter()
            .any(|file| exists_sync(&dirname(file)))
        {
            out.push(target);
        }
    }
    out
}

/// `skillRows`: what Settings -> Integrations lists: the install rows present
/// here, then the legacy copies, in table order
pub fn skill_rows(ledger: &SkillLedger, env: Env, home: &str) -> Vec<AgentTarget> {
    let order = agent_ids();
    let mut rows = detect_agents(env, home);
    rows.extend(legacy_skill_copies(ledger, env, home, None));
    rows.sort_by_key(|row| order.iter().position(|id| *id == row.id));
    rows
}

/// `targetOf`
fn target_of(agent: &AgentDef, env: Env, home: &str) -> AgentTarget {
    AgentTarget {
        id: agent.id.to_owned(),
        label: agent.label.to_owned(),
        skills_dir: AgentDef::skills(&agent.probe(env, home)),
        legacy: (agent.role == AgentRole::Reader).then_some(true),
    }
}

/// `SkillFrontmatter`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkillFrontmatter {
    pub name: String,
    pub version: String,
}

/// `parseSkillFrontmatter`: `name` and `metadata.version` from the YAML front
/// matter; enough to tell our skill (and its version) from anything else
pub fn parse_skill_frontmatter(text: &str) -> Option<SkillFrontmatter> {
    let found = js_regex!(r"^---\r?\n([\s\S]*?)\r?\n---").exec(text)?;
    let block = found.get(1).unwrap_or_default();
    let name = js_regex!(r"^name:\s*(\S+)\s*$", "m")
        .exec(block)
        .and_then(|m| m.get(1).map(str::to_owned));
    let version = js_regex!(r#"^\s+version:\s*['"]?(\d+\.\d+\.\d+)['"]?\s*$"#, "m")
        .exec(block)
        .and_then(|m| m.get(1).map(str::to_owned))
        .unwrap_or_default();
    name.filter(|name| !name.is_empty())
        .map(|name| SkillFrontmatter { name, version })
}

/// `sha256`: lower-case hex of the SHA-256 of the bytes (a string is its UTF-8)
pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `parts`: numeric major, minor, patch; anything unparsable sorts lowest
fn parts(version: &str) -> [f64; 3] {
    let Some(found) = js_regex!(r"^(\d+)\.(\d+)\.(\d+)").exec(trim(version)) else {
        return [-1.0, -1.0, -1.0];
    };
    let number = |i: usize| to_number(found.get(i).unwrap_or_default());
    [number(1), number(2), number(3)]
}

/// `compareVersions`: semver-ish, anything unparsable sorts lowest
pub fn compare_versions(a: &str, b: &str) -> i32 {
    let pa = parts(a);
    let pb = parts(b);
    for i in 0..3 {
        if pa[i] < pb[i] {
            return -1;
        }
        if pa[i] > pb[i] {
            return 1;
        }
    }
    0
}

/// `SkillLedger`: absolute SKILL.md path -> what this app wrote there
/// (`LedgerEntry`: `version`, `sha256`, `at`, `channel`). The values are what
/// the settings file holds, which the TypeScript does not check either.
pub type SkillLedger = JsObject<JsonValue>;

/// `ledgerFromSettings`: a copy of the ledger of the settings, `{}` where it
/// is missing or not an object
pub fn ledger_from_settings(settings: &JsObject<JsonValue>) -> SkillLedger {
    match settings.get(LEDGER_KEY) {
        Some(JsonValue::Object(raw)) => raw.clone(),
        _ => JsObject::new(),
    }
}

/// `ledger[file]` as a test
fn ledger_has(ledger: &SkillLedger, file: &str) -> bool {
    ledger.get(file).is_some_and(JsonValue::truthy)
}

/// `ledger[file]?.sha256` where it is a string
fn recorded_sha256<'a>(ledger: &'a SkillLedger, file: &str) -> Option<&'a str> {
    match ledger.get(file) {
        Some(JsonValue::Object(entry)) => match entry.get("sha256") {
            Some(JsonValue::String(hash)) => Some(hash),
            _ => None,
        },
        _ => None,
    }
}

/// `delete ledger[file]`
fn ledger_delete(ledger: &mut SkillLedger, file: &str) {
    let kept: SkillLedger = ledger
        .entries()
        .into_iter()
        .filter(|(key, _)| *key != file)
        .map(|(key, value)| (key.to_owned(), value.clone()))
        .collect();
    *ledger = kept;
}

/// `BundledSkill`
#[derive(Debug, Clone, PartialEq)]
pub struct BundledSkill {
    pub bytes: Vec<u8>,
    pub text: String,
    pub version: String,
    pub sha256: String,
}

/// `bundledSkillFrom`
pub fn bundled_skill_from(bytes: &[u8]) -> BundledSkill {
    let text = String::from_utf8_lossy(bytes).into_owned();
    let frontmatter = parse_skill_frontmatter(&text);
    BundledSkill {
        bytes: bytes.to_vec(),
        text,
        version: frontmatter.map_or_else(|| "0.0.0".to_owned(), |fm| fm.version),
        sha256: sha256(bytes),
    }
}

/// `skillFilePath`
pub fn skill_file_path(skills_dir: &str) -> String {
    join(&[skills_dir, SKILL_NAME, "SKILL.md"])
}

/// `SKILL_FOLDER_NAMES`: every folder name the skill has had, the current one first
fn skill_folder_names() -> Vec<&'static str> {
    let mut names = vec![SKILL_NAME];
    names.extend(OLD_SKILL_NAMES);
    names
}

/// `skillFilesWritten`: the SKILL.md files the ledger says this app wrote in
/// `skills_dir`, under the current name or an earlier one
pub fn skill_files_written(skills_dir: &str, ledger: &SkillLedger) -> Vec<String> {
    skill_folder_names()
        .into_iter()
        .map(|name| join(&[skills_dir, name, "SKILL.md"]))
        .filter(|file| ledger_has(ledger, file))
        .collect()
}

/// `readInstallState`: the skill in `skills_dir`: the current folder decides;
/// without one, a copy of ours under an earlier name reads as needing an
/// update, and a folder of that name holding anything else is not ours
pub fn read_install_state(
    skills_dir: &str,
    bundled: &BundledSkill,
    ledger: &SkillLedger,
) -> SkillInstallState {
    let current = folder_state(skills_dir, SKILL_NAME, bundled, ledger);
    if current.status != SkillInstallStatus::Missing {
        return current;
    }
    for name in OLD_SKILL_NAMES {
        let old = folder_state(skills_dir, name, bundled, ledger);
        if old.status == SkillInstallStatus::Missing || old.status == SkillInstallStatus::Occupied {
            continue;
        }
        if old.status == SkillInstallStatus::Newer {
            return old;
        }
        let status = if old.status == SkillInstallStatus::Installed {
            SkillInstallStatus::Outdated
        } else {
            old.status
        };
        return SkillInstallState {
            status,
            older: Some(true),
            ..old
        };
    }
    current
}

/// `folderState`
fn folder_state(
    skills_dir: &str,
    folder: &str,
    bundled: &BundledSkill,
    ledger: &SkillLedger,
) -> SkillInstallState {
    let path = join(&[skills_dir, folder, "SKILL.md"]);
    let state = |status, installed_version, older| SkillInstallState {
        status,
        path: path.clone(),
        installed_version,
        older,
    };
    if !exists_sync(&join(&[skills_dir, folder])) {
        return state(SkillInstallStatus::Missing, None, None);
    }
    let Ok(text) = read_file_utf8(&path) else {
        return state(SkillInstallStatus::Occupied, None, None);
    };
    let Some(frontmatter) = parse_skill_frontmatter(&text) else {
        return state(SkillInstallStatus::Occupied, None, None);
    };
    if !skill_folder_names().contains(&frontmatter.name.as_str()) {
        return state(SkillInstallStatus::Occupied, None, None);
    }
    let installed_version = frontmatter.version;
    let cmp = compare_versions(&installed_version, &bundled.version);
    if cmp > 0 {
        return state(SkillInstallStatus::Newer, Some(installed_version), None);
    }
    if !ledger_has(ledger, &path) {
        return state(
            SkillInstallStatus::Foreign,
            Some(installed_version),
            Some(cmp < 0),
        );
    }
    if recorded_sha256(ledger, &path) != Some(sha256(text.as_bytes()).as_str()) {
        return state(
            SkillInstallStatus::Modified,
            Some(installed_version),
            Some(cmp < 0),
        );
    }
    if cmp < 0 {
        return state(
            SkillInstallStatus::Outdated,
            Some(installed_version),
            Some(true),
        );
    }
    state(SkillInstallStatus::Installed, Some(installed_version), None)
}

/// `writeFileSync(path, bytes)`: `open`, then `write`
fn write_file_sync(path: &str, bytes: &[u8]) -> Result<(), NodeError> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(namespaced(path))
        .map_err(|e| node_error(&e, "open", path))?;
    file.write_all(bytes)
        .map_err(|e| node_error_fd(&e, "write"))
}

/// `installSkill`: copy the bundled SKILL.md byte for byte and remember the
/// write (`at` is the clock, in milliseconds since the epoch; `channel` is
/// `app` where the TypeScript leaves it out). Returns the file path. A copy
/// under an earlier name goes once the new one is written, and only when this
/// app wrote it and it is unchanged since.
pub fn install_skill(
    skills_dir: &str,
    bundled: &BundledSkill,
    ledger: &mut SkillLedger,
    channel: Option<&str>,
    now_ms: f64,
) -> Result<String, NodeError> {
    let channel = channel.unwrap_or("app");
    let path = skill_file_path(skills_dir);
    let existing = fs::symlink_metadata(namespaced(&path)).ok();
    if existing.is_some_and(|meta| meta.file_type().is_symlink()) {
        return Err(plain_error(&format!(
            "{path} is a symlink; refusing to overwrite whatever it points at"
        )));
    }
    let folder = join(&[skills_dir, SKILL_NAME]);
    fs::create_dir_all(namespaced(&folder)).map_err(|e| node_error(&e, "mkdir", &folder))?;
    write_file_sync(&path, &bundled.bytes)?;
    let mut entry = JsObject::new();
    entry.set("version", JsonValue::String(bundled.version.clone()));
    entry.set("sha256", JsonValue::String(bundled.sha256.clone()));
    entry.set(
        "at",
        JsonValue::String(to_iso_string(now_ms).expect("the clock is a valid date")),
    );
    entry.set("channel", JsonValue::String(channel.to_owned()));
    ledger.set(path.clone(), JsonValue::Object(entry));
    for old in skill_files_written(skills_dir, ledger) {
        if old != path && unchanged_since(&old, ledger) {
            remove_skill_file(&old, ledger)?;
        }
    }
    Ok(path)
}

/// `unchangedSince`
fn unchanged_since(file: &str, ledger: &SkillLedger) -> bool {
    let Ok(meta) = fs::symlink_metadata(namespaced(file)) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return false;
    }
    match read_file_bytes(file) {
        Ok(bytes) => recorded_sha256(ledger, file) == Some(sha256(&bytes).as_str()),
        Err(_) => false,
    }
}

/// `uninstallSkill`: remove only what this app wrote, under the current name
/// and earlier ones; a folder holding other files keeps them
pub fn uninstall_skill(skills_dir: &str, ledger: &mut SkillLedger) -> Result<bool, NodeError> {
    let written = skill_files_written(skills_dir, ledger);
    for file in &written {
        remove_skill_file(file, ledger)?;
    }
    Ok(!written.is_empty())
}

/// `removeSkillFile`
fn remove_skill_file(file: &str, ledger: &mut SkillLedger) -> Result<(), NodeError> {
    rm_file(file, true)?;
    let folder = dirname(file);
    // an empty folder goes with it; any failure here is ignored
    let empty = fs::read_dir(namespaced(&folder)).is_ok_and(|mut entries| entries.next().is_none());
    if empty {
        let is_real_dir = fs::symlink_metadata(namespaced(&folder)).is_ok_and(|meta| meta.is_dir());
        let _ = if is_real_dir {
            fs::remove_dir(namespaced(&folder))
        } else {
            fs::remove_file(namespaced(&folder))
        };
    }
    ledger_delete(ledger, file);
    Ok(())
}

/// `buildSkillZip`: `seuoffice/SKILL.md` inside a zip, the layout claude.ai
/// and the desktop apps accept for an uploaded skill; every entry is dated
/// `new Date(0)`
pub fn build_skill_zip(bundled: &BundledSkill) -> Result<Vec<u8>, String> {
    let package = Package::from_parts([(format!("{SKILL_NAME}/SKILL.md"), bundled.bytes.clone())]);
    generate(&package, 0.0).map_err(|e| e.to_string())
}
