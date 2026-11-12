//! `packages/ai-provider/src/user-skills/{states,names,constants}.ts` and
//! `packages/agent-core/src/skill-editors.ts`: what
//! `normalizeUserSkillSettings` calls.

use jscompat::{JsObject, JsonValue, js_regex};

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
