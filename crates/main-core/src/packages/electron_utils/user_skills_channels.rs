//! `packages/electron-utils/src/user-skills-channels.ts`: the channel names and
//! the checks both ends run on what crosses them.
//!
//! A value the TypeScript holds as `unknown` is an `Option<&JsonValue>`
//! (`None` is `undefined`). A `Uint8Array` cannot be a `JsonValue`: it is
//! written as the object `{"$bytes": byteLength}` (what the Node-API adapter
//! hands over for one), and only its length is ever read.

use jscompat::{JsObject, JsonValue, json_parse, json_stringify};

use super::handoff_editors::is_handoff_editor;

/// `USER_SKILLS_BRIDGE_KEY`
pub const USER_SKILLS_BRIDGE_KEY: &str = "aiOfficeUserSkills";

/// `USER_SKILLS_CHANNELS`, as (key, channel) in the order the object has them.
pub const USER_SKILLS_CHANNELS: [(&str, &str); 41] = [
    ("list", "skills:list"),
    ("read", "skills:read"),
    ("setState", "skills:set-state"),
    ("hideBuiltin", "skills:hide-builtin"),
    ("unhideBuiltins", "skills:unhide-builtins"),
    ("remove", "skills:remove"),
    ("copyToMine", "skills:copy-to-mine"),
    ("suggestName", "skills:suggest-name"),
    ("checkName", "skills:check-name"),
    ("save", "skills:save"),
    ("saveFromCard", "skills:save-from-card"),
    ("importFolder", "skills:import-folder"),
    ("importZip", "skills:import-zip"),
    ("importGitHub", "skills:import-github"),
    ("importText", "skills:import-text"),
    ("takeDropped", "skills:take-dropped"),
    ("readImport", "skills:read-import"),
    ("readImportFile", "skills:read-import-file"),
    ("cancelImport", "skills:cancel-import"),
    ("install", "skills:install"),
    ("checkUpdate", "skills:check-update"),
    ("applyUpdate", "skills:apply-update"),
    ("cancelUpdate", "skills:cancel-update"),
    ("exportInfo", "skills:export-info"),
    ("exportZip", "skills:export-zip"),
    ("exportBundle", "skills:export-bundle"),
    ("openFolder", "skills:open-folder"),
    ("aiRead", "skills:ai-read"),
    ("aiReadFile", "skills:ai-read-file"),
    ("openSettings", "skills:open-settings"),
    ("agentNotice", "skills:agent-notice"),
    ("agentNoticeSeen", "skills:agent-notice-seen"),
    ("openTemplate", "skills:open-template"),
    ("openPreview", "skills:open-preview"),
    ("previewOriginal", "skills:preview-original"),
    ("finishPreview", "skills:finish-preview"),
    ("takeHandoff", "skills:take-handoff"),
    ("focusTab", "skills:focus-tab"),
    ("previewEnded", "skills:preview-ended"),
    ("changed", "skills:changed"),
    ("dropped", "skills:dropped"),
];

/// `USER_SKILL_PREVIEW_TEXT_MAX_CHARS`
pub const USER_SKILL_PREVIEW_TEXT_MAX_CHARS: u32 = 20_000;
/// `USER_SKILL_BODY_MAX`
pub const USER_SKILL_BODY_MAX: usize = 2_000_000;
/// `USER_SKILL_TEMPLATE_MAX_BYTES`
pub const USER_SKILL_TEMPLATE_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// `USER_SKILL_PASTE_MAX_CHARS`
pub const USER_SKILL_PASTE_MAX_CHARS: usize = 2_000_000;
/// `USER_SKILL_BUNDLE_MAX`
pub const USER_SKILL_BUNDLE_MAX: usize = 500;
/// `USER_SKILL_HANDOFF_TEXT_MAX`
pub const USER_SKILL_HANDOFF_TEXT_MAX: usize = 200_000;
/// `PREVIEW_DATA_MAX_CHARS`
const PREVIEW_DATA_MAX_CHARS: usize = 4_000_000;

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn record(value: Option<&JsonValue>) -> Option<&JsObject<JsonValue>> {
    match value {
        Some(JsonValue::Object(object)) => Some(object),
        _ => None,
    }
}

/// `value.key` of a record
fn field<'a>(object: &'a JsObject<JsonValue>, key: &str) -> Option<&'a JsonValue> {
    object.get(key)
}

/// `text(value, max)`
fn text(value: Option<&JsonValue>, max: usize) -> Option<&str> {
    match value {
        Some(JsonValue::String(s)) if utf16_len(s) <= max => Some(s),
        _ => None,
    }
}

/// `text(value, max)` where the caller then tests the result for truthiness
fn text_truthy(value: Option<&JsonValue>, max: usize) -> Option<&str> {
    text(value, max).filter(|s| !s.is_empty())
}

/// `bytes instanceof Uint8Array`: the length of the one `{"$bytes": n}` marks
fn bytes_len(value: Option<&JsonValue>) -> Option<f64> {
    let object = record(value)?;
    if object.len() != 1 {
        return None;
    }
    match object.get("$bytes") {
        Some(JsonValue::Number(n)) => Some(*n),
        _ => None,
    }
}

fn string(s: &str) -> JsonValue {
    JsonValue::String(s.to_owned())
}

/// `skillIdOf(value)`
pub fn skill_id_of(value: Option<&JsonValue>) -> Option<String> {
    let id = text_truthy(value, 512)?;
    id.contains(':').then(|| id.to_owned())
}

/// `invokeOf(value)`
pub fn invoke_of(value: Option<&JsonValue>) -> Option<&'static str> {
    match value {
        Some(JsonValue::String(s)) if s == "auto" => Some("auto"),
        Some(JsonValue::String(s)) if s == "manual" => Some("manual"),
        _ => None,
    }
}

/// What `editorsValueOf` answers: `undefined`, `'all'`, a list, or `null`.
#[derive(Debug, Clone, PartialEq)]
pub enum EditorsValue {
    Undefined,
    All,
    List(Vec<String>),
    Malformed,
}

/// `editorsValueOf(value)`
pub fn editors_value_of(value: Option<&JsonValue>) -> EditorsValue {
    match value {
        None => EditorsValue::Undefined,
        Some(JsonValue::String(s)) if s == "all" => EditorsValue::All,
        Some(JsonValue::Array(items)) => {
            if items.len() > 32 {
                return EditorsValue::Malformed;
            }
            let mut ids = Vec::new();
            for item in items {
                match item {
                    JsonValue::String(id) if utf16_len(id) <= 32 => ids.push(id.clone()),
                    _ => return EditorsValue::Malformed,
                }
            }
            EditorsValue::List(ids)
        }
        Some(_) => EditorsValue::Malformed,
    }
}

impl EditorsValue {
    /// The value `if (editors)` takes into an object: `None` for `undefined`
    /// and `null`.
    fn truthy_json(&self) -> Option<JsonValue> {
        match self {
            EditorsValue::Undefined | EditorsValue::Malformed => None,
            EditorsValue::All => Some(string("all")),
            EditorsValue::List(ids) => {
                Some(JsonValue::Array(ids.iter().map(|id| string(id)).collect()))
            }
        }
    }
}

/// `statePatchOf(value)`
pub fn state_patch_of(value: Option<&JsonValue>) -> Option<JsonValue> {
    let value = record(value)?;
    let mut patch = JsObject::new();
    if let Some(JsonValue::Bool(enabled)) = field(value, "enabled") {
        patch.set("enabled", JsonValue::Bool(*enabled));
    }
    if let Some(invoke) = invoke_of(field(value, "invoke")) {
        patch.set("invoke", string(invoke));
    }
    if let Some(editors) = editors_value_of(field(value, "editors")).truthy_json() {
        patch.set("editors", editors);
    }
    if patch.is_empty() {
        None
    } else {
        Some(JsonValue::Object(patch))
    }
}

/// `saveInputOf(value)`
pub fn save_input_of(value: Option<&JsonValue>) -> Option<JsonValue> {
    let value = record(value)?;
    let title = text(field(value, "title"), 10_000)?;
    let description = text(field(value, "description"), 100_000)?;
    let body = text(field(value, "body"), USER_SKILL_BODY_MAX)?;
    let id = match field(value, "id") {
        None => None,
        raw => Some(skill_id_of(raw)?),
    };
    let name = match field(value, "name") {
        None => None,
        raw => Some(text(raw, 512)?),
    };
    let editors = editors_value_of(field(value, "editors"));
    if editors == EditorsValue::Malformed {
        return None;
    }
    let mut out = JsObject::new();
    if let Some(id) = id {
        out.set("id", string(&id));
    }
    out.set("title", string(title));
    if let Some(name) = name {
        out.set("name", string(name));
    }
    out.set("description", string(description));
    out.set("body", string(body));
    if let Some(editors) = editors.truthy_json() {
        out.set("editors", editors);
    }
    if field(value, "turnOffSameName") == Some(&JsonValue::Bool(true)) {
        out.set("turnOffSameName", JsonValue::Bool(true));
    }
    Some(JsonValue::Object(out))
}

/// `templateOf(value)`: `Ok(None)` is `undefined`, `Err(())` is `null`.
fn template_of(value: Option<&JsonValue>) -> Result<Option<JsonValue>, ()> {
    match value {
        None | Some(JsonValue::Null) => return Ok(None),
        _ => {}
    }
    let object = record(value).ok_or(())?;
    let file_name = text_truthy(field(object, "fileName"), 1024).ok_or(())?;
    let raw = field(object, "bytes");
    match bytes_len(raw) {
        Some(len) if len <= USER_SKILL_TEMPLATE_MAX_BYTES as f64 => {}
        _ => return Err(()),
    }
    let mut out = JsObject::new();
    out.set("bytes", raw.cloned().unwrap_or(JsonValue::Null));
    out.set("fileName", string(file_name));
    Ok(Some(JsonValue::Object(out)))
}

/// `cardSaveInputOf(value)`
pub fn card_save_input_of(value: Option<&JsonValue>) -> Option<JsonValue> {
    let value = record(value)?;
    let title = text(field(value, "title"), 10_000)?;
    let name = text(field(value, "name"), 512)?;
    let description = text(field(value, "description"), 100_000)?;
    let body = text(field(value, "body"), USER_SKILL_BODY_MAX)?;
    let invoke = invoke_of(field(value, "invoke")).unwrap_or("auto");
    let template = template_of(field(value, "template")).ok()?;
    let target_id = match field(value, "targetId") {
        None => None,
        raw => Some(skill_id_of(raw)?),
    };
    let editors = editors_value_of(field(value, "editors"));
    if editors == EditorsValue::Malformed {
        return None;
    }
    let mut out = JsObject::new();
    out.set("title", string(title));
    out.set("name", string(name));
    out.set("description", string(description));
    out.set("body", string(body));
    out.set("invoke", string(invoke));
    if let Some(template) = template {
        out.set("template", template);
    }
    if let Some(target_id) = target_id {
        out.set("targetId", string(&target_id));
    }
    out.set(
        "overwrite",
        JsonValue::Bool(field(value, "overwrite") == Some(&JsonValue::Bool(true))),
    );
    if let Some(editors) = editors.truthy_json() {
        out.set("editors", editors);
    }
    if field(value, "turnOffSameName") == Some(&JsonValue::Bool(true)) {
        out.set("turnOffSameName", JsonValue::Bool(true));
    }
    Some(JsonValue::Object(out))
}

/// `importTextOf(value)`
pub fn import_text_of(value: Option<&JsonValue>) -> Option<String> {
    text(value, USER_SKILL_PASTE_MAX_CHARS).map(str::to_owned)
}

/// `skillIdListOf(value)`
pub fn skill_id_list_of(value: Option<&JsonValue>) -> Option<Vec<String>> {
    let Some(JsonValue::Array(items)) = value else {
        return None;
    };
    if items.is_empty() || items.len() > USER_SKILL_BUNDLE_MAX {
        return None;
    }
    let mut ids: Vec<String> = Vec::new();
    for item in items {
        let id = skill_id_of(Some(item))?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    Some(ids)
}

/// `installRequestOf(value)`
pub fn install_request_of(value: Option<&JsonValue>) -> Option<JsonValue> {
    let value = record(value)?;
    let token = text_truthy(field(value, "token"), 128)?;
    let Some(JsonValue::Array(selected)) = field(value, "selected") else {
        return None;
    };
    let selected: Vec<JsonValue> = selected
        .iter()
        .filter(|key| matches!(key, JsonValue::String(s) if utf16_len(s) <= 4096))
        .cloned()
        .collect();
    let mut on_collision = JsObject::new();
    if let Some(entries) = record(field(value, "onCollision")) {
        for (key, choice) in entries.entries() {
            // `onCollision["__proto__"] = "replace"` sets no key on a plain object
            if key == "__proto__" {
                continue;
            }
            if matches!(choice, JsonValue::String(s) if s == "replace" || s == "skip") {
                on_collision.set(key, choice.clone());
            }
        }
    }
    let mut out = JsObject::new();
    out.set("token", string(token));
    out.set("selected", JsonValue::Array(selected));
    out.set("onCollision", JsonValue::Object(on_collision));
    Some(JsonValue::Object(out))
}

/// `skillViewsOf(value)`
pub fn skill_views_of(value: Option<&JsonValue>) -> Vec<JsonValue> {
    let Some(JsonValue::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter(|item| {
            record(Some(item)).is_some_and(|object| {
                matches!(field(object, "id"), Some(JsonValue::String(_)))
                    && matches!(field(object, "name"), Some(JsonValue::String(_)))
            })
        })
        .cloned()
        .collect()
}

/// `skillsResultOf(value)`
pub fn skills_result_of(value: Option<&JsonValue>) -> JsonValue {
    if let Some(object) = record(value)
        && matches!(field(object, "ok"), Some(JsonValue::Bool(_)))
    {
        return value.cloned().unwrap_or(JsonValue::Null);
    }
    let mut out = JsObject::new();
    out.set("ok", JsonValue::Bool(false));
    out.set("reason", string("failed"));
    JsonValue::Object(out)
}

/// `chipsOf(value)`
fn chips_of(value: Option<&JsonValue>) -> Option<JsonValue> {
    let Some(JsonValue::Array(items)) = value else {
        return None;
    };
    if items.len() > 50 {
        return None;
    }
    let mut chips = Vec::new();
    for item in items {
        let item = record(Some(item))?;
        let id = skill_id_of(field(item, "id"))?;
        let source = text(field(item, "source"), 64)?;
        let title = text(field(item, "title"), 10_000)?;
        let mut chip = JsObject::new();
        chip.set("id", string(&id));
        chip.set("source", string(source));
        chip.set("title", string(title));
        chips.push(JsonValue::Object(chip));
    }
    Some(JsonValue::Array(chips))
}

/// `templateOpenInputOf(value)`
pub fn template_open_input_of(value: Option<&JsonValue>) -> Option<JsonValue> {
    let value = record(value)?;
    let skill_id = skill_id_of(field(value, "skillId"))?;
    let request = text(field(value, "text"), USER_SKILL_HANDOFF_TEXT_MAX)?;
    let chips = chips_of(field(value, "chips"))?;
    let mut out = JsObject::new();
    out.set("skillId", string(&skill_id));
    out.set("text", string(request));
    out.set("chips", chips);
    if field(value, "withCurrent") == Some(&JsonValue::Bool(true)) {
        out.set("withCurrent", JsonValue::Bool(true));
    }
    Some(JsonValue::Object(out))
}

/// `plainDataOf(value)`: `Ok(None)` is `undefined`, `Ok(Some(Null))` and
/// `Err(())` are `null`.
fn plain_data_of(value: Option<&JsonValue>) -> Result<Option<JsonValue>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    let json = json_stringify(value);
    if utf16_len(&json) > PREVIEW_DATA_MAX_CHARS {
        return Err(());
    }
    json_parse(&json).map(Some).map_err(|_| ())
}

/// `previewInputOf(value)`
pub fn preview_input_of(value: Option<&JsonValue>) -> Option<JsonValue> {
    let value = record(value)?;
    let raw_bytes = field(value, "bytes");
    match bytes_len(raw_bytes) {
        Some(len) if len <= USER_SKILL_TEMPLATE_MAX_BYTES as f64 => {}
        _ => return None,
    }
    let file_name = text_truthy(field(value, "fileName"), 1024)?;
    let title = text(field(value, "title"), 10_000)?;
    let tab_title = text_truthy(field(value, "tabTitle"), 10_000)?;
    let request = text(field(value, "text"), USER_SKILL_HANDOFF_TEXT_MAX)?;
    let Some(JsonValue::Bool(original_redacted)) = field(value, "originalRedacted") else {
        return None;
    };
    let proposal = plain_data_of(field(value, "proposal"));
    let draft = plain_data_of(field(value, "draft"));
    let proposal = match proposal {
        Ok(Some(proposal @ JsonValue::Object(_))) => proposal,
        _ => return None,
    };
    let draft = match draft {
        Ok(draft) => draft,
        Err(()) => return None,
    };
    if draft == Some(JsonValue::Null) {
        return None;
    }
    let mut out = JsObject::new();
    out.set("bytes", raw_bytes.cloned().unwrap_or(JsonValue::Null));
    out.set("fileName", string(file_name));
    out.set("title", string(title));
    out.set("tabTitle", string(tab_title));
    out.set("text", string(request));
    out.set("originalRedacted", JsonValue::Bool(*original_redacted));
    out.set("proposal", proposal);
    if let Some(draft) = draft {
        out.set("draft", draft);
    }
    Some(JsonValue::Object(out))
}

/// `handoffTargetOf(value)`
pub fn handoff_target_of(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(s)) if is_handoff_editor(s) => Some(s.clone()),
        _ => None,
    }
}

/// `previewEndedOf(value)`
pub fn preview_ended_of(value: Option<&JsonValue>) -> Option<JsonValue> {
    let value = record(value)?;
    let preview_id = text_truthy(field(value, "previewId"), 128)?;
    let outcome = match field(value, "outcome") {
        Some(JsonValue::String(s)) if s == "saved" => "saved",
        Some(JsonValue::String(s)) if s == "unsaved" => "unsaved",
        _ => return None,
    };
    let skill_id = match field(value, "skillId") {
        None => None,
        raw => skill_id_of(raw),
    };
    let title = match field(value, "title") {
        None => None,
        raw => text(raw, 10_000),
    };
    let mut out = JsObject::new();
    out.set("previewId", string(preview_id));
    out.set("outcome", string(outcome));
    if let Some(skill_id) = skill_id {
        out.set("skillId", string(&skill_id));
    }
    if let Some(title) = title {
        out.set("title", string(title));
    }
    Some(JsonValue::Object(out))
}
