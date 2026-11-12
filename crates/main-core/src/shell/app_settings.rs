//! `apps/shell/src/main/app-settings.ts`: userData/app-settings.json, a flat
//! JSON object holding cross-module app preferences.
//!
//! Values the TypeScript holds as `unknown` are [`JsonValue`]s (read with
//! `JSON.parse` key order); `undefined` is `None`.

use std::fs::{self, OpenOptions};
use std::io::Write;

use jscompat::node_path::host::{is_absolute, resolve};
use jscompat::{JsObject, JsonValue, date_parse, json_parse, json_stringify_pretty, random_uuid};

use crate::node_fs::{NodeError, node_error, node_error2};
use crate::packages::ai_provider::user_skills_states::{
    UserSkillSettings, UserSkillStateSetting, normalize_user_skill_settings,
};
use crate::packages::project_store::is_valid_project_id;

/// What `readAppSettings` returns: a plain object.
pub type Settings = JsObject<JsonValue>;

/// What a function of this module throws: an `Error` with a message only, or
/// a Node file error.
#[derive(Debug, Clone, PartialEq)]
pub enum SettingsError {
    Plain(String),
    Node(NodeError),
}

impl From<NodeError> for SettingsError {
    fn from(e: NodeError) -> Self {
        SettingsError::Node(e)
    }
}

/// `readAppSettings(path)`: a missing or corrupt file, and a JSON value that
/// is not a plain object, read as empty settings.
pub fn read_app_settings(path: &str) -> Settings {
    // readFileSync(path, 'utf8') keeps a byte order mark, which JSON.parse refuses
    let Ok(bytes) = fs::read(path) else {
        return Settings::new();
    };
    match json_parse(&String::from_utf8_lossy(&bytes)) {
        Ok(JsonValue::Object(object)) => object,
        _ => Settings::new(),
    }
}

/// `{ ...settings, key: undefined }` as `JSON.stringify` writes it: the key
/// is gone.
fn without_key(settings: &Settings, key: &str) -> Settings {
    settings
        .entries()
        .into_iter()
        .filter(|(k, _)| *k != key)
        .map(|(k, v)| (k.to_owned(), v.clone()))
        .collect()
}

/// `writeAppSettings(path, updates)`: `updates` in the order of the object
/// literal; `None` is `undefined`, which `JSON.stringify` leaves out.
pub fn write_app_settings(
    path: &str,
    updates: &[(&str, Option<JsonValue>)],
) -> Result<(), NodeError> {
    let mut settings = read_app_settings(path);
    for (key, value) in updates {
        match value {
            Some(value) => settings.set(*key, value.clone()),
            None => settings = without_key(&settings, key),
        }
    }
    let temp_path = format!("{path}.{}.{}.tmp", std::process::id(), random_uuid());
    let text = json_stringify_pretty(&JsonValue::Object(settings), 2);
    let written = (|| -> Result<(), NodeError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|e| node_error(&e, "open", &temp_path))?;
        file.write_all(text.as_bytes())
            .map_err(|e| node_error(&e, "write", &temp_path))?;
        file.sync_all()
            .map_err(|e| node_error(&e, "fsync", &temp_path))?;
        drop(file);
        fs::rename(&temp_path, path).map_err(|e| node_error2(&e, "rename", &temp_path, path))
    })();
    if let Err(error) = written {
        // The write may have failed before the temporary file was created.
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    Ok(())
}

/// `writeAppSetting(path, key, value)`
pub fn write_app_setting(path: &str, key: &str, value: Option<JsonValue>) -> Result<(), NodeError> {
    write_app_settings(path, &[(key, value)])
}

/// `writeAppSettingThen(path, key, value, apply)`: `apply` runs only once the
/// bytes are on disk.
pub fn write_app_setting_then(
    path: &str,
    key: &str,
    value: Option<JsonValue>,
    apply: impl FnOnce(Option<&JsonValue>),
) -> Result<(), NodeError> {
    write_app_setting(path, key, value.clone())?;
    apply(value.as_ref());
    Ok(())
}

// ---- the person's skills and the agent window (spec 10.1) ----

pub const SKILLS_SETTING_KEY: &str = "skills";
pub const AGENT_SKILL_NOTICE_KEY: &str = "agentSkillNoticeSeen";
pub const AGENT_PROJECT_PREFS_KEY: &str = "agentProjectPrefs";
const AGENT_PREFS_KEY: &str = "agent";

/// `readSkillSettings(path)`
pub fn read_skill_settings(path: &str) -> UserSkillSettings {
    normalize_user_skill_settings(read_app_settings(path).get(SKILLS_SETTING_KEY))
}

/// `writeSkillSettings(path, settings)`
pub fn write_skill_settings(path: &str, settings: &UserSkillSettings) -> Result<(), NodeError> {
    let mut states = JsObject::new();
    for (id, state) in settings.states.entries() {
        let mut kept = UserSkillStateSetting::default();
        if let Some(enabled) = state.enabled {
            kept.enabled = Some(enabled);
        }
        if state.invoke.as_deref() == Some("auto") || state.invoke.as_deref() == Some("manual") {
            kept.invoke = state.invoke.clone();
        }
        if let Some(editors) = &state.editors {
            kept.editors = Some(editors.clone());
        }
        if kept != UserSkillStateSetting::default() {
            states.set(id, kept.to_json());
        }
    }
    let mut value = JsObject::new();
    if !states.is_empty() {
        value.set("states", JsonValue::Object(states));
    }
    let mut hidden: Vec<String> = Vec::new();
    for name in &settings.hidden_builtins {
        if !name.is_empty() && !hidden.contains(name) {
            hidden.push(name.clone());
        }
    }
    if !hidden.is_empty() {
        value.set(
            "hiddenBuiltins",
            JsonValue::Array(hidden.into_iter().map(JsonValue::String).collect()),
        );
    }
    write_app_setting(path, SKILLS_SETTING_KEY, Some(JsonValue::Object(value)))
}

/// `updateSkillSettings(path, change)`
pub fn update_skill_settings(
    path: &str,
    change: impl FnOnce(&mut UserSkillSettings),
) -> Result<UserSkillSettings, NodeError> {
    let mut settings = read_skill_settings(path);
    change(&mut settings);
    write_skill_settings(path, &settings)?;
    Ok(read_skill_settings(path))
}

/// `acceptedAgentWarning(agent)`
fn accepted_agent_warning(agent: Option<&JsonValue>) -> bool {
    match agent {
        Some(JsonValue::Object(object)) => matches!(
            object.get("warningAccepted"),
            Some(JsonValue::Number(x)) if x.is_finite() && x.fract() == 0.0 && *x >= 1.0
        ),
        _ => false,
    }
}

/// `agentSkillNoticeDue(path)`
pub fn agent_skill_notice_due(path: &str) -> bool {
    let settings = read_app_settings(path);
    accepted_agent_warning(settings.get(AGENT_PREFS_KEY))
        && settings.get(AGENT_SKILL_NOTICE_KEY) != Some(&JsonValue::Bool(true))
}

/// `markAgentSkillNoticeSeen(path)`
pub fn mark_agent_skill_notice_seen(path: &str) -> Result<(), NodeError> {
    write_app_setting(path, AGENT_SKILL_NOTICE_KEY, Some(JsonValue::Bool(true)))
}

/// `writeAgentPrefs(path, prefs)`
pub fn write_agent_prefs(path: &str, prefs: &JsonValue) -> Result<(), NodeError> {
    let before = read_app_settings(path);
    let mut updates: Vec<(&str, Option<JsonValue>)> = vec![(AGENT_PREFS_KEY, Some(prefs.clone()))];
    if !accepted_agent_warning(before.get(AGENT_PREFS_KEY))
        && accepted_agent_warning(Some(prefs))
        && before.get(AGENT_SKILL_NOTICE_KEY).is_none()
    {
        updates.push((AGENT_SKILL_NOTICE_KEY, Some(JsonValue::Bool(true))));
    }
    write_app_settings(path, &updates)
}

/// `AgentProjectPref`
#[derive(Debug, Clone, PartialEq)]
pub struct AgentProjectPref {
    pub codex_web_search: String,
    pub codex_network: bool,
}

impl AgentProjectPref {
    pub fn to_json(&self) -> JsonValue {
        let mut object = JsObject::new();
        object.set(
            "codexWebSearch",
            JsonValue::String(self.codex_web_search.clone()),
        );
        object.set("codexNetwork", JsonValue::Bool(self.codex_network));
        JsonValue::Object(object)
    }
}

/// `DEFAULT_AGENT_PROJECT_PREF`
pub fn default_agent_project_pref() -> AgentProjectPref {
    AgentProjectPref {
        codex_web_search: "cached".to_owned(),
        codex_network: false,
    }
}

/// `StoredAgentProjectPref` (`Partial<AgentProjectPref>`): an object whose
/// keys come in the order they were set.
pub type StoredAgentProjectPref = JsObject<JsonValue>;

/// The value of `AGENT_CODEX_WEB_SEARCH` equal to `value`
fn codex_web_search_of(value: Option<&JsonValue>) -> Option<&'static str> {
    ["cached", "live", "disabled"]
        .into_iter()
        .find(|choice| matches!(value, Some(JsonValue::String(text)) if text == choice))
}

/// `normalizeAgentProjectPrefs(raw)`
pub fn normalize_agent_project_prefs(raw: Option<&JsonValue>) -> JsObject<StoredAgentProjectPref> {
    let mut out = JsObject::new();
    let Some(JsonValue::Object(raw)) = raw else {
        return out;
    };
    for (folder, value) in raw.entries() {
        if folder.is_empty() || !is_absolute(folder) {
            continue;
        }
        // an array is an object here too, and holds none of the keys
        if !matches!(value, JsonValue::Object(_) | JsonValue::Array(_)) {
            continue;
        }
        let mut kept = StoredAgentProjectPref::new();
        if let Some(web_search) = codex_web_search_of(value.get("codexWebSearch").as_deref()) {
            kept.set("codexWebSearch", JsonValue::String(web_search.to_owned()));
        }
        if let Some(JsonValue::Bool(network)) = value.get("codexNetwork").as_deref() {
            kept.set("codexNetwork", JsonValue::Bool(*network));
        }
        if !kept.is_empty() {
            out.set(folder, kept);
        }
    }
    out
}

/// `sameFolder(a, b)`
fn same_folder(a: &str, b: &str) -> bool {
    let fold = |p: &str| {
        if cfg!(windows) {
            resolve(&[p]).to_lowercase()
        } else {
            resolve(&[p])
        }
    };
    fold(a) == fold(b)
}

/// `projectKey(prefs, folder)`
fn project_key(prefs: &JsObject<StoredAgentProjectPref>, folder: &str) -> String {
    prefs
        .entries()
        .into_iter()
        .map(|(key, _)| key)
        .find(|key| same_folder(key, folder))
        .map_or_else(|| resolve(&[folder]), str::to_owned)
}

/// `{ ...DEFAULT_AGENT_PROJECT_PREF, ...stored }`
fn with_defaults(stored: Option<&StoredAgentProjectPref>) -> AgentProjectPref {
    let mut pref = default_agent_project_pref();
    if let Some(stored) = stored {
        if let Some(JsonValue::String(web_search)) = stored.get("codexWebSearch") {
            pref.codex_web_search = web_search.clone();
        }
        if let Some(JsonValue::Bool(network)) = stored.get("codexNetwork") {
            pref.codex_network = *network;
        }
    }
    pref
}

/// `readAgentProjectPref(path, folder)`
pub fn read_agent_project_pref(path: &str, folder: &str) -> AgentProjectPref {
    let settings = read_app_settings(path);
    let prefs = normalize_agent_project_prefs(settings.get(AGENT_PROJECT_PREFS_KEY));
    let stored = prefs.get(&project_key(&prefs, folder));
    with_defaults(stored)
}

/// `writeAgentProjectPref(path, folder, patch)`; `patch` is an object.
pub fn write_agent_project_pref(
    path: &str,
    folder: &str,
    patch: &JsonValue,
) -> Result<AgentProjectPref, SettingsError> {
    if !is_absolute(folder) {
        return Err(SettingsError::Plain(
            "A project folder must be an absolute path".to_owned(),
        ));
    }
    let settings = read_app_settings(path);
    let mut prefs = normalize_agent_project_prefs(settings.get(AGENT_PROJECT_PREFS_KEY));
    let key = project_key(&prefs, folder);
    let mut next = StoredAgentProjectPref::new();
    if let Some(stored) = prefs.get(&key) {
        next.assign(stored);
    }
    if let Some(web_search) = codex_web_search_of(patch.get("codexWebSearch").as_deref()) {
        next.set("codexWebSearch", JsonValue::String(web_search.to_owned()));
    }
    if let Some(JsonValue::Bool(network)) = patch.get("codexNetwork").as_deref() {
        next.set("codexNetwork", JsonValue::Bool(*network));
    }
    let result = with_defaults(Some(&next));
    prefs.set(key, next);
    let mut stored = JsObject::new();
    for (folder, pref) in prefs.entries() {
        stored.set(folder, JsonValue::Object(pref.clone()));
    }
    write_app_setting(
        path,
        AGENT_PROJECT_PREFS_KEY,
        Some(JsonValue::Object(stored)),
    )?;
    Ok(result)
}

// ---- project folders (decision 0088) ----

pub const PROJECTS_SETTING_KEY: &str = "projects";

const PROJECT_HASHED_FILES: [&str; 4] = ["instructions", "memory", "agents", "claude"];

/// `/^[0-9a-f]{64}$/`
fn is_sha256_hex(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `plainObject(value)`
fn plain_object(value: Option<&JsonValue>) -> Option<&JsObject<JsonValue>> {
    match value {
        Some(JsonValue::Object(object)) => Some(object),
        _ => None,
    }
}

/// `isValidProjectId(value)` of a value of any type
fn valid_id(value: Option<&JsonValue>) -> Option<&str> {
    match value {
        Some(JsonValue::String(text)) if is_valid_project_id(text) => Some(text),
        _ => None,
    }
}

/// `isIsoTime(value)`
fn iso_time(value: Option<&JsonValue>) -> Option<&str> {
    match value {
        Some(JsonValue::String(text)) if !text.is_empty() && !date_parse(text).is_nan() => {
            Some(text)
        }
        _ => None,
    }
}

/// An entry of `list`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectListEntry {
    pub id: String,
    pub path: String,
    pub pinned: bool,
    pub last_used_at: String,
}

/// `ProjectTrustRecord`; `hashes` holds the files of `PROJECT_HASHED_FILES`
/// it has a hash for, in that order.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectTrustRecord {
    /// `"use"` or `"without"`
    pub decision: String,
    pub hashes: JsObject<String>,
}

/// `OutsideDocumentChoice`
#[derive(Debug, Clone, PartialEq)]
pub struct OutsideDocumentChoice {
    pub project_id: Option<String>,
    pub last_chat_id: Option<String>,
}

/// The switches of `StoredProjectsSettings.settings[id]`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectSwitches {
    pub memory_enabled: bool,
    pub read_agents_files: bool,
}

/// `StoredProjectsSettings`. `home_project_id` is `None` when the key is
/// absent, `Some(None)` for `null`.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredProjectsSettings {
    pub install_id: String,
    pub list: Vec<ProjectListEntry>,
    pub trust: JsObject<ProjectTrustRecord>,
    pub outside_documents: JsObject<OutsideDocumentChoice>,
    pub opted_out_documents: JsObject<String>,
    pub settings: JsObject<ProjectSwitches>,
    pub sync_notice_shown: Vec<String>,
    pub home_project_id: Option<Option<String>>,
}

impl StoredProjectsSettings {
    /// The object as the TypeScript builds it: `installId`, `list`, `trust`,
    /// `outsideDocuments`, `optedOutDocuments`, `settings`, `syncNoticeShown`,
    /// then `homeProjectId` when it is there.
    pub fn to_json(&self) -> JsonValue {
        let string = |text: &str| JsonValue::String(text.to_owned());
        let list = self
            .list
            .iter()
            .map(|entry| {
                let mut object = JsObject::new();
                object.set("id", string(&entry.id));
                object.set("path", string(&entry.path));
                object.set("pinned", JsonValue::Bool(entry.pinned));
                object.set("lastUsedAt", string(&entry.last_used_at));
                JsonValue::Object(object)
            })
            .collect();
        let mut trust = JsObject::new();
        for (id, record) in self.trust.entries() {
            let mut hashes = JsObject::new();
            for (file, hash) in record.hashes.entries() {
                hashes.set(file, string(hash));
            }
            let mut object = JsObject::new();
            object.set("decision", string(&record.decision));
            object.set("hashes", JsonValue::Object(hashes));
            trust.set(id, JsonValue::Object(object));
        }
        let mut outside = JsObject::new();
        for (doc, choice) in self.outside_documents.entries() {
            let mut object = JsObject::new();
            object.set(
                "projectId",
                choice.project_id.as_deref().map_or(JsonValue::Null, string),
            );
            if let Some(chat) = &choice.last_chat_id {
                object.set("lastChatId", string(chat));
            }
            outside.set(doc, JsonValue::Object(object));
        }
        let mut opted_out = JsObject::new();
        for (doc, project_id) in self.opted_out_documents.entries() {
            let mut object = JsObject::new();
            object.set("projectId", string(project_id));
            opted_out.set(doc, JsonValue::Object(object));
        }
        let mut settings = JsObject::new();
        for (id, switches) in self.settings.entries() {
            let mut object = JsObject::new();
            object.set("memoryEnabled", JsonValue::Bool(switches.memory_enabled));
            object.set(
                "readAgentsFiles",
                JsonValue::Bool(switches.read_agents_files),
            );
            settings.set(id, JsonValue::Object(object));
        }
        let mut out = JsObject::new();
        out.set("installId", string(&self.install_id));
        out.set("list", JsonValue::Array(list));
        out.set("trust", JsonValue::Object(trust));
        out.set("outsideDocuments", JsonValue::Object(outside));
        out.set("optedOutDocuments", JsonValue::Object(opted_out));
        out.set("settings", JsonValue::Object(settings));
        out.set(
            "syncNoticeShown",
            JsonValue::Array(self.sync_notice_shown.iter().map(|id| string(id)).collect()),
        );
        if let Some(home) = &self.home_project_id {
            out.set(
                "homeProjectId",
                home.as_deref().map_or(JsonValue::Null, string),
            );
        }
        JsonValue::Object(out)
    }
}

/// `normalizeProjectsSettings(raw)`.
///
/// An id that is `"__proto__"` (the project id pattern allows it) names no
/// own key in `trust` or `settings`: the TypeScript assigns `out.trust[id]`
/// on a plain object, which sets its prototype, and `JSON.stringify` and
/// `Object.entries` do not see that.
pub fn normalize_projects_settings(raw: Option<&JsonValue>) -> StoredProjectsSettings {
    let empty = JsObject::new();
    let source = plain_object(raw).unwrap_or(&empty);
    let mut out = StoredProjectsSettings {
        install_id: valid_id(source.get("installId")).unwrap_or("").to_owned(),
        list: Vec::new(),
        trust: JsObject::new(),
        outside_documents: JsObject::new(),
        opted_out_documents: JsObject::new(),
        settings: JsObject::new(),
        sync_notice_shown: Vec::new(),
        home_project_id: None,
    };
    let mut seen: Vec<String> = Vec::new();
    let items: &[JsonValue] = match source.get("list") {
        Some(JsonValue::Array(items)) => items,
        _ => &[],
    };
    for item in items {
        let Some(entry) = plain_object(Some(item)) else {
            continue;
        };
        let Some(id) = valid_id(entry.get("id")) else {
            continue;
        };
        if seen.iter().any(|s| s == id) {
            continue;
        }
        let Some(JsonValue::String(path)) = entry.get("path") else {
            continue;
        };
        if !is_absolute(path) {
            continue;
        }
        seen.push(id.to_owned());
        out.list.push(ProjectListEntry {
            id: id.to_owned(),
            path: path.clone(),
            pinned: entry.get("pinned") == Some(&JsonValue::Bool(true)),
            last_used_at: iso_time(entry.get("lastUsedAt"))
                .unwrap_or("1970-01-01T00:00:00.000Z")
                .to_owned(),
        });
    }
    for (id, value) in plain_object(source.get("trust"))
        .unwrap_or(&empty)
        .entries()
    {
        let Some(record) = plain_object(Some(value)) else {
            continue;
        };
        if !is_valid_project_id(id) {
            continue;
        }
        let decision = match record.get("decision") {
            Some(JsonValue::String(text)) if text == "use" || text == "without" => text,
            _ => continue,
        };
        let mut hashes = JsObject::new();
        let stored_hashes = plain_object(record.get("hashes")).unwrap_or(&empty);
        for file in PROJECT_HASHED_FILES {
            if let Some(JsonValue::String(hash)) = stored_hashes.get(file)
                && is_sha256_hex(hash)
            {
                hashes.set(file, hash.clone());
            }
        }
        if id != "__proto__" {
            out.trust.set(
                id,
                ProjectTrustRecord {
                    decision: decision.clone(),
                    hashes,
                },
            );
        }
    }
    for (doc, value) in plain_object(source.get("outsideDocuments"))
        .unwrap_or(&empty)
        .entries()
    {
        let Some(choice) = plain_object(Some(value)) else {
            continue;
        };
        if !is_absolute(doc) {
            continue;
        }
        let project_id = choice.get("projectId");
        if project_id != Some(&JsonValue::Null) && valid_id(project_id).is_none() {
            continue;
        }
        let project_id = valid_id(project_id).map(str::to_owned);
        let last_chat_id = if project_id.is_some() {
            valid_id(choice.get("lastChatId")).map(str::to_owned)
        } else {
            None
        };
        out.outside_documents.set(
            doc,
            OutsideDocumentChoice {
                project_id,
                last_chat_id,
            },
        );
    }
    for (doc, value) in plain_object(source.get("optedOutDocuments"))
        .unwrap_or(&empty)
        .entries()
    {
        let Some(record) = plain_object(Some(value)) else {
            continue;
        };
        if !is_absolute(doc) {
            continue;
        }
        let Some(project_id) = valid_id(record.get("projectId")) else {
            continue;
        };
        out.opted_out_documents.set(doc, project_id.to_owned());
    }
    for (id, value) in plain_object(source.get("settings"))
        .unwrap_or(&empty)
        .entries()
    {
        let Some(switches) = plain_object(Some(value)) else {
            continue;
        };
        if !is_valid_project_id(id) {
            continue;
        }
        if id != "__proto__" {
            out.settings.set(
                id,
                ProjectSwitches {
                    memory_enabled: switches.get("memoryEnabled") != Some(&JsonValue::Bool(false)),
                    read_agents_files: switches.get("readAgentsFiles")
                        != Some(&JsonValue::Bool(false)),
                },
            );
        }
    }
    match source.get("homeProjectId") {
        Some(JsonValue::Null) => out.home_project_id = Some(None),
        other => {
            if let Some(id) = valid_id(other) {
                out.home_project_id = Some(Some(id.to_owned()));
            }
        }
    }
    if let Some(JsonValue::Array(shown)) = source.get("syncNoticeShown") {
        for item in shown {
            if let Some(id) = valid_id(Some(item))
                && !out.sync_notice_shown.iter().any(|s| s == id)
            {
                out.sync_notice_shown.push(id.to_owned());
            }
        }
    }
    out
}

/// `readProjectsSettings(path)`
pub fn read_projects_settings(path: &str) -> StoredProjectsSettings {
    normalize_projects_settings(read_app_settings(path).get(PROJECTS_SETTING_KEY))
}

/// `writeProjectsSettings(path, value)`; `value` is what the caller holds,
/// normalized again on the way out (`None` is `undefined`, which normalizes
/// to the empty registry).
pub fn write_projects_settings(path: &str, value: Option<&JsonValue>) -> Result<(), NodeError> {
    write_app_setting(
        path,
        PROJECTS_SETTING_KEY,
        Some(normalize_projects_settings(value).to_json()),
    )
}

/// `updateProjectsSettings(path, change)`
pub fn update_projects_settings(
    path: &str,
    change: impl FnOnce(&mut StoredProjectsSettings),
) -> Result<StoredProjectsSettings, NodeError> {
    let mut settings = read_projects_settings(path);
    change(&mut settings);
    let value = settings.to_json();
    write_projects_settings(path, Some(&value))?;
    Ok(normalize_projects_settings(Some(&value)))
}
