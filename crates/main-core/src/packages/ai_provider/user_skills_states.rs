//! `packages/ai-provider/src/user-skills/{states,names,constants}.ts` and
//! `packages/agent-core/src/skill-editors.ts`: what
//! `normalizeUserSkillSettings` calls.

use jscompat::{JsMap, JsObject, JsonValue, js_regex, string_less_than};

use super::user_skill_md::{
    NEW_USER_SKILL_NAME_MAX, USER_SKILL_PRIORITY, is_reserved_user_skill_name,
};

/// `SKILL_EDITORS` of skill-editors.ts, in the order the screens list them.
pub const SKILL_EDITORS: [&str; 10] = [
    "docs", "sheets", "slides", "hwp", "pdf", "markdown", "html", "mindmap", "epub", "diagram",
];

/// `USER_SKILL_SOURCES` of constants.ts.
pub const USER_SKILL_SOURCES: [&str; 6] = ["builtin", "app", "user", "plugin", "codex", "project"];

/// `skillEditorsOf(value)`: the known editor ids of a written value, once
/// each and in screen order; `None` (undefined) when none is left or all are.
pub fn skill_editors_of(value: &JsonValue) -> Option<Vec<&'static str>> {
    let parts: Vec<JsonValue> = match value {
        JsonValue::String(text) => js_regex!(r"[\s,]+", "")
            .split(text)
            .into_iter()
            .map(|part| JsonValue::String(part.to_owned()))
            .collect(),
        JsonValue::Array(items) => items.clone(),
        _ => Vec::new(),
    };
    let editors: Vec<&'static str> = SKILL_EDITORS
        .iter()
        .copied()
        .filter(|id| {
            parts
                .iter()
                .any(|part| matches!(part, JsonValue::String(t) if t == id))
        })
        .collect();
    (!editors.is_empty() && editors.len() < SKILL_EDITORS.len()).then_some(editors)
}

/// `SkillEditorsChoice`: every editor, or only these.
#[derive(Debug, Clone, PartialEq)]
pub enum SkillEditorsChoice {
    All,
    Some(Vec<&'static str>),
}

impl SkillEditorsChoice {
    /// The value as `JSON.parse` would give it back.
    pub fn to_json(&self) -> JsonValue {
        match self {
            SkillEditorsChoice::All => JsonValue::String("all".to_owned()),
            SkillEditorsChoice::Some(ids) => JsonValue::Array(
                ids.iter()
                    .map(|id| JsonValue::String((*id).to_owned()))
                    .collect(),
            ),
        }
    }
}

/// `skillEditorsChoiceOf(value)`
pub fn skill_editors_choice_of(value: Option<&JsonValue>) -> Option<SkillEditorsChoice> {
    match value {
        Some(JsonValue::String(text)) if text == "all" => Some(SkillEditorsChoice::All),
        Some(array @ JsonValue::Array(_)) => {
            Some(skill_editors_of(array).map_or(SkillEditorsChoice::All, SkillEditorsChoice::Some))
        }
        _ => None,
    }
}

/// `isValidUserSkillName(name)`: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`.
pub fn is_valid_user_skill_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && name.chars().count() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// `ParsedUserSkillId`
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedUserSkillId {
    pub source: String,
    pub name: String,
    pub plugin: Option<String>,
}

/// `parseUserSkillId(id)`
pub fn parse_user_skill_id(id: &str) -> Option<ParsedUserSkillId> {
    let first = id.find(':')?;
    if first == 0 {
        return None;
    }
    let source = &id[..first];
    if !USER_SKILL_SOURCES.contains(&source) {
        return None;
    }
    let rest = &id[first + 1..];
    if source == "plugin" {
        let last = rest.rfind(':')?;
        if last == 0 {
            return None;
        }
        let plugin = &rest[..last];
        let name = &rest[last + 1..];
        return is_valid_user_skill_name(name).then(|| ParsedUserSkillId {
            source: source.to_owned(),
            name: name.to_owned(),
            plugin: Some(plugin.to_owned()),
        });
    }
    is_valid_user_skill_name(rest).then(|| ParsedUserSkillId {
        source: source.to_owned(),
        name: rest.to_owned(),
        plugin: None,
    })
}

/// `UserSkillStateSetting`: the keys are written in this order.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UserSkillStateSetting {
    pub enabled: Option<bool>,
    /// `"auto"` or `"manual"`
    pub invoke: Option<String>,
    pub editors: Option<SkillEditorsChoice>,
}

impl UserSkillStateSetting {
    pub fn to_json(&self) -> JsonValue {
        let mut object = JsObject::new();
        if let Some(enabled) = self.enabled {
            object.set("enabled", JsonValue::Bool(enabled));
        }
        if let Some(invoke) = &self.invoke {
            object.set("invoke", JsonValue::String(invoke.clone()));
        }
        if let Some(editors) = &self.editors {
            object.set("editors", editors.to_json());
        }
        JsonValue::Object(object)
    }
}

/// `UserSkillSettings`
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UserSkillSettings {
    pub states: JsObject<UserSkillStateSetting>,
    pub hidden_builtins: Vec<String>,
}

impl UserSkillSettings {
    pub fn to_json(&self) -> JsonValue {
        let mut states = JsObject::new();
        for (id, state) in self.states.entries() {
            states.set(id, state.to_json());
        }
        let mut object = JsObject::new();
        object.set("states", JsonValue::Object(states));
        object.set(
            "hiddenBuiltins",
            JsonValue::Array(
                self.hidden_builtins
                    .iter()
                    .map(|name| JsonValue::String(name.clone()))
                    .collect(),
            ),
        );
        JsonValue::Object(object)
    }
}

/// `normalizeUserSkillSettings(raw)`
pub fn normalize_user_skill_settings(raw: Option<&JsonValue>) -> UserSkillSettings {
    let mut settings = UserSkillSettings::default();
    let Some(JsonValue::Object(raw)) = raw else {
        return settings;
    };
    let states = raw.get("states");
    let hidden_builtins = raw.get("hiddenBuiltins");
    if let Some(JsonValue::Object(states)) = states {
        for (id, value) in states.entries() {
            let Some(parsed) = parse_user_skill_id(id) else {
                continue;
            };
            if parsed.source == "project" {
                continue;
            }
            let JsonValue::Object(value) = value else {
                continue;
            };
            let mut state = UserSkillStateSetting::default();
            if let Some(JsonValue::Bool(enabled)) = value.get("enabled") {
                state.enabled = Some(*enabled);
            }
            if let Some(JsonValue::String(invoke)) = value.get("invoke")
                && (invoke == "auto" || invoke == "manual")
            {
                state.invoke = Some(invoke.clone());
            }
            state.editors = skill_editors_choice_of(value.get("editors"));
            settings.states.set(id, state);
        }
    }
    if let Some(JsonValue::Array(items)) = hidden_builtins {
        for item in items {
            if let JsonValue::String(name) = item
                && !name.is_empty()
                && !settings.hidden_builtins.contains(name)
            {
                settings.hidden_builtins.push(name.clone());
            }
        }
    }
    settings
}

// ---- names.ts: the strict rule, suggestions and identifiers ----

/// `validateNewUserSkillName(name)`: the first problem of a name the app
/// writes, or `None` when the name is fine
pub fn validate_new_user_skill_name(name: &str) -> Option<&'static str> {
    let units = name.encode_utf16().count();
    if units == 0 {
        return Some("empty");
    }
    if units > NEW_USER_SKILL_NAME_MAX {
        return Some("too-long");
    }
    if name
        .chars()
        .any(|c| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
    {
        return Some("characters");
    }
    if name.starts_with('-') || name.ends_with('-') {
        return Some("hyphen-edge");
    }
    if name.contains("--") {
        return Some("double-hyphen");
    }
    if is_reserved_user_skill_name(name) {
        return Some("reserved");
    }
    None
}

const RANDOM_ALPHABET: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";

/// `randomSuffix()`: six random letters and digits
pub fn random_skill_suffix() -> String {
    let mut bytes = [0u8; 6];
    getrandom::fill(&mut bytes).expect("the platform random source");
    bytes
        .iter()
        .map(|byte| RANDOM_ALPHABET[usize::from(*byte) % RANDOM_ALPHABET.len()] as char)
        .collect()
}

/// `trimToLength(name, max)` for an ASCII name
fn trim_to_length(name: &str, max: usize) -> String {
    let cut: String = name.chars().take(max).collect();
    cut.trim_end_matches('-').to_owned()
}

/// `suggestUserSkillName(title, { taken, random })`: an English name for a new
/// skill made from its title. A title with no Latin letters or digits gives
/// `skill-<short random>`. A name already taken gets `-2`, `-3`, ...
pub fn suggest_user_skill_name(
    title: &str,
    taken: &[String],
    random: &mut dyn FnMut() -> String,
) -> String {
    let decomposed = icu_normalizer::DecomposingNormalizerBorrowed::new_nfkd().normalize(title);
    let stripped: String = decomposed
        .chars()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect();
    let lowered = stripped.to_lowercase();
    let dashed = js_regex!(r"[^a-z0-9]+").replace_all(&lowered, |_| "-".to_owned());
    let slug = trim_to_length(dashed.trim_matches('-'), NEW_USER_SKILL_NAME_MAX);
    let base = if !slug.is_empty() && !is_reserved_user_skill_name(&slug) {
        slug
    } else {
        trim_to_length(&format!("skill-{}", random()), NEW_USER_SKILL_NAME_MAX)
    };
    let taken: Vec<String> = taken.iter().map(|name| name.to_lowercase()).collect();
    if !taken.contains(&base) {
        return base;
    }
    let mut n = 2;
    loop {
        let suffix = format!("-{n}");
        let candidate = format!(
            "{}{suffix}",
            trim_to_length(&base, NEW_USER_SKILL_NAME_MAX - suffix.len())
        );
        if !taken.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// `userSkillId(source, name, plugin)`: `source:name`, `plugin:<plugin>:<name>` for plugins
pub fn user_skill_id(source: &str, name: &str, plugin: Option<&str>) -> String {
    if source == "plugin" {
        format!("plugin:{}:{name}", plugin.unwrap_or(""))
    } else {
        format!("{source}:{name}")
    }
}

// ---- skill-editors.ts: the scope ----

/// `skillEditorScope(choice, fromFile)`: the editors a skill is used in, the
/// person's choice over the skill's own value; `None` means every editor
pub fn skill_editor_scope(
    choice: Option<&SkillEditorsChoice>,
    from_file: Option<&[&'static str]>,
) -> Option<Vec<&'static str>> {
    if matches!(choice, Some(SkillEditorsChoice::All)) {
        return None;
    }
    let ids = |list: &[&str]| {
        JsonValue::Array(
            list.iter()
                .map(|id| JsonValue::String((*id).to_owned()))
                .collect(),
        )
    };
    match choice {
        Some(SkillEditorsChoice::Some(list)) => skill_editors_of(&ids(list)),
        _ => from_file.and_then(|list| skill_editors_of(&ids(list))),
    }
}

// ---- types.ts ----

/// `UserSkill`: one skill folder as read from disk
#[derive(Debug, Clone, PartialEq)]
pub struct UserSkill {
    /// `source:name`, `plugin:<plugin>:<name>`
    pub id: String,
    /// a value of `USER_SKILL_SOURCES`
    pub source: String,
    pub plugin: Option<String>,
    pub name: String,
    pub folder_name: String,
    pub dir: String,
    pub title: String,
    pub description: String,
    pub template: Option<String>,
    pub template_exists: bool,
    pub has_scripts: bool,
    pub mcp_servers: Vec<String>,
    pub github: bool,
    pub agent_only: bool,
    pub file_editors: Option<Vec<&'static str>>,
    pub files: usize,
    pub bytes: u64,
    pub unreadable: Option<&'static str>,
}

fn editor_ids_json(ids: &[&str]) -> JsonValue {
    JsonValue::Array(
        ids.iter()
            .map(|id| JsonValue::String((*id).to_owned()))
            .collect(),
    )
}

impl UserSkill {
    /// The object `readUserSkillFolder` builds: its keys in the literal's
    /// order, an `undefined` value left out
    pub fn to_json(&self) -> JsonValue {
        let mut object = JsObject::new();
        self.write_json(&mut object);
        JsonValue::Object(object)
    }

    fn write_json(&self, object: &mut JsObject<JsonValue>) {
        let text = |value: &str| JsonValue::String(value.to_owned());
        object.set("id", text(&self.id));
        object.set("source", text(&self.source));
        if let Some(plugin) = &self.plugin {
            object.set("plugin", text(plugin));
        }
        object.set("name", text(&self.name));
        object.set("folderName", text(&self.folder_name));
        object.set("dir", text(&self.dir));
        object.set("title", text(&self.title));
        object.set("description", text(&self.description));
        if let Some(template) = &self.template {
            object.set("template", text(template));
        }
        object.set("templateExists", JsonValue::Bool(self.template_exists));
        object.set("hasScripts", JsonValue::Bool(self.has_scripts));
        object.set(
            "mcpServers",
            JsonValue::Array(self.mcp_servers.iter().map(|s| text(s)).collect()),
        );
        object.set("github", JsonValue::Bool(self.github));
        object.set("agentOnly", JsonValue::Bool(self.agent_only));
        if let Some(editors) = &self.file_editors {
            object.set("fileEditors", editor_ids_json(editors));
        }
        object.set("files", JsonValue::Number(self.files as f64));
        object.set("bytes", JsonValue::Number(self.bytes as f64));
        if let Some(reason) = self.unreadable {
            object.set("unreadable", text(reason));
        }
    }
}

/// `ResolvedUserSkill`: a skill with its on/off state worked out
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedUserSkill {
    pub skill: UserSkill,
    pub enabled: bool,
    /// `"auto"` or `"manual"`
    pub invoke: String,
    /// a builtin skill the person hid; it is off
    pub hidden: bool,
    /// the editors the skill is used in; `None`: every editor
    pub editors: Option<Vec<&'static str>>,
}

impl std::ops::Deref for ResolvedUserSkill {
    type Target = UserSkill;

    fn deref(&self) -> &UserSkill {
        &self.skill
    }
}

impl ResolvedUserSkill {
    /// `{ ...skill, enabled, invoke, hidden, editors }`
    pub fn to_json(&self) -> JsonValue {
        let mut object = JsObject::new();
        self.skill.write_json(&mut object);
        object.set("enabled", JsonValue::Bool(self.enabled));
        object.set("invoke", JsonValue::String(self.invoke.clone()));
        object.set("hidden", JsonValue::Bool(self.hidden));
        if let Some(editors) = &self.editors {
            object.set("editors", editor_ids_json(editors));
        }
        JsonValue::Object(object)
    }
}

// ---- states.ts ----

/// `initialUserSkillState(source)`: builtin, the app's own and project skills
/// start on; other programs' skills start off. Returns `(enabled, invoke)`.
pub fn initial_user_skill_state(source: &str) -> (bool, &'static str) {
    (
        source == "builtin" || source == "app" || source == "project",
        "auto",
    )
}

/// `resolveUserSkillStates(skills, rawSettings)`: each skill with its state:
/// the saved value over the initial one. A hidden builtin and a skill that
/// cannot be read are off. Project skills are always on and used whenever the
/// AI sees fit.
pub fn resolve_user_skill_states(
    skills: Vec<UserSkill>,
    raw_settings: Option<&JsonValue>,
) -> Vec<ResolvedUserSkill> {
    let settings = normalize_user_skill_settings(raw_settings);
    let hidden: Vec<String> = settings
        .hidden_builtins
        .iter()
        .map(|name| name.to_lowercase())
        .collect();
    skills
        .into_iter()
        .map(|skill| {
            let (initial_enabled, initial_invoke) = initial_user_skill_state(&skill.source);
            if skill.source == "project" {
                return ResolvedUserSkill {
                    enabled: skill.unreadable.is_none(),
                    invoke: "auto".to_owned(),
                    hidden: false,
                    editors: skill.file_editors.clone(),
                    skill,
                };
            }
            let saved = settings.states.get(&skill.id).cloned().unwrap_or_default();
            let is_hidden =
                skill.source == "builtin" && hidden.contains(&skill.name.to_lowercase());
            let file_editors = skill.file_editors.as_deref();
            ResolvedUserSkill {
                enabled: !is_hidden
                    && skill.unreadable.is_none()
                    && saved.enabled.unwrap_or(initial_enabled),
                invoke: saved
                    .invoke
                    .clone()
                    .unwrap_or_else(|| initial_invoke.to_owned()),
                hidden: is_hidden,
                editors: skill_editor_scope(saved.editors.as_ref(), file_editors),
                skill,
            }
        })
        .collect()
}

/// `rank(skill)`
fn rank(skill: &ResolvedUserSkill) -> i64 {
    USER_SKILL_PRIORITY
        .iter()
        .position(|source| *source == skill.source)
        .map_or(-1, |at| at as i64)
}

/// `wins(a, b)`: whether `a` wins over `b` on a shared name
fn wins(a: &ResolvedUserSkill, b: &ResolvedUserSkill) -> bool {
    if rank(a) != rank(b) {
        return rank(a) < rank(b);
    }
    if a.source == "plugin" {
        let pa = a.plugin.clone().unwrap_or_default().to_lowercase();
        let pb = b.plugin.clone().unwrap_or_default().to_lowercase();
        if pa != pb {
            return string_less_than(&pa, &pb);
        }
    }
    false
}

/// `PickedUserSkills`, the skills named by their place in the list given
#[derive(Debug, Clone, PartialEq)]
pub struct PickedUserSkills {
    /// one enabled skill per name (compared without case), in list order
    pub chosen: Vec<usize>,
    /// enabled skills that lost on a shared name, with the identifier of the winner
    pub shadowed: Vec<(usize, String)>,
}

/// `pickEnabledUserSkills(skills)`: among enabled skills only, the one per
/// name the AI picks on its own: project, app, builtin, Claude, Codex, then
/// plugins (by plugin name)
pub fn pick_enabled_user_skills(skills: &[ResolvedUserSkill]) -> PickedUserSkills {
    // name (lowercase) -> index of the best skill, in the order names were first seen
    let mut best: JsMap<usize> = JsMap::new();
    for (index, skill) in skills.iter().enumerate() {
        if !skill.enabled {
            continue;
        }
        let key = skill.name.to_lowercase();
        let current = best.get(&key).copied();
        if current.is_none_or(|current| wins(skill, &skills[current])) {
            best.set(key, index);
        }
    }
    let mut chosen = Vec::new();
    let mut shadowed = Vec::new();
    for (index, skill) in skills.iter().enumerate() {
        if !skill.enabled {
            continue;
        }
        let winner = *best
            .get(&skill.name.to_lowercase())
            .expect("every enabled name has a winner");
        if winner == index {
            chosen.push(index);
        } else {
            shadowed.push((index, skills[winner].id.clone()));
        }
    }
    PickedUserSkills { chosen, shadowed }
}
