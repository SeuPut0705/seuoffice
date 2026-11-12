//! `apps/shell/src/main/split-memory.ts`: the split view the home window
//! reopens with, kept in app-settings.json under `splitView`.

use jscompat::{JsObject, JsonValue, math_max, math_min};

use super::app_settings::{Settings, read_app_settings, write_app_setting};
use crate::node_fs::NodeError;

/// `SPLIT_MEMORY_SETTING_KEY`
pub const SPLIT_MEMORY_SETTING_KEY: &str = "splitView";

const MIN_RATIO: f64 = 0.2;
const MAX_RATIO: f64 = 0.8;

/// `SplitMemory` (`version` is always 1). The keys are written in the order
/// of the fields.
#[derive(Debug, Clone, PartialEq)]
pub struct SplitMemory {
    pub a: String,
    pub b: Option<String>,
    /// `"side"` or `"stack"`
    pub orientation: Option<String>,
    pub ratio: Option<f64>,
    /// `"a"` or `"b"`
    pub focus: Option<String>,
}

impl SplitMemory {
    pub fn to_json(&self) -> JsonValue {
        let string = |text: &str| JsonValue::String(text.to_owned());
        let mut object = JsObject::new();
        object.set("version", JsonValue::Number(1.0));
        object.set("a", string(&self.a));
        if let Some(b) = &self.b {
            object.set("b", string(b));
        }
        if let Some(orientation) = &self.orientation {
            object.set("orientation", string(orientation));
        }
        if let Some(ratio) = self.ratio {
            object.set("ratio", JsonValue::Number(ratio));
        }
        if let Some(focus) = &self.focus {
            object.set("focus", string(focus));
        }
        JsonValue::Object(object)
    }
}

/// `SplitMemoryState`
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SplitMemoryState {
    pub a_tab_id_path: Option<String>,
    pub b_tab_id_path: Option<String>,
    pub orientation: Option<String>,
    pub ratio: Option<f64>,
    pub focus: Option<String>,
}

/// `SplitMemoryOptions.settingsPath`: a path or a function giving it
pub enum SettingsPath<'a> {
    Fixed(String),
    Lazy(&'a dyn Fn() -> String),
}

/// `SplitMemoryOptions`
pub struct SplitMemoryOptions<'a> {
    pub settings_path: SettingsPath<'a>,
    pub read_settings: Option<&'a dyn Fn(&str) -> Settings>,
    pub write_setting: Option<&'a dyn Fn(&str, &str, Option<JsonValue>) -> Result<(), NodeError>>,
}

fn resolve_settings_path(options: &SplitMemoryOptions) -> String {
    match &options.settings_path {
        SettingsPath::Fixed(path) => path.clone(),
        SettingsPath::Lazy(path) => path(),
    }
}

fn non_empty_path(value: Option<&String>) -> Option<&String> {
    value.filter(|text| !text.is_empty())
}

fn clamp_ratio(ratio: f64) -> f64 {
    math_min(MAX_RATIO, math_max(MIN_RATIO, ratio))
}

fn base_memory(a_path: Option<&String>, b_path: Option<&String>) -> Option<SplitMemory> {
    let memory = |a: &String, b: Option<&String>| SplitMemory {
        a: a.clone(),
        b: b.cloned(),
        orientation: None,
        ratio: None,
        focus: None,
    };
    match (a_path, b_path) {
        (Some(a), Some(b)) => Some(memory(a, Some(b))),
        (Some(a), None) => Some(memory(a, None)),
        (None, Some(b)) => Some(memory(b, None)),
        (None, None) => None,
    }
}

/// `normalizeStoredMemory(raw)`
pub fn normalize_stored_memory(raw: Option<&JsonValue>) -> Option<SplitMemory> {
    let Some(JsonValue::Object(record)) = raw else {
        return None;
    };
    if record.get("version") != Some(&JsonValue::Number(1.0)) {
        return None;
    }
    let Some(JsonValue::String(a)) = record.get("a") else {
        return None;
    };
    if a.is_empty() {
        return None;
    }
    let mut memory = SplitMemory {
        a: a.clone(),
        b: None,
        orientation: None,
        ratio: None,
        focus: None,
    };
    if let Some(b) = record.get("b") {
        let JsonValue::String(b) = b else { return None };
        if !b.is_empty() {
            memory.b = Some(b.clone());
        }
    }
    if let Some(orientation) = record.get("orientation") {
        match orientation {
            JsonValue::String(text) if text == "side" || text == "stack" => {
                memory.orientation = Some(text.clone());
            }
            _ => return None,
        }
    }
    if let Some(ratio) = record.get("ratio") {
        match ratio {
            JsonValue::Number(x) if x.is_finite() => memory.ratio = Some(clamp_ratio(*x)),
            _ => return None,
        }
    }
    if let Some(focus) = record.get("focus") {
        match focus {
            JsonValue::String(text) if text == "a" || text == "b" => {
                memory.focus = Some(text.clone());
            }
            _ => return None,
        }
    }
    Some(memory)
}

fn write_setting(options: &SplitMemoryOptions, value: Option<JsonValue>) -> Result<(), NodeError> {
    let path = resolve_settings_path(options);
    match options.write_setting {
        Some(write) => write(&path, SPLIT_MEMORY_SETTING_KEY, value),
        None => write_app_setting(&path, SPLIT_MEMORY_SETTING_KEY, value),
    }
}

/// `writeSplitMemory(state, options)`
pub fn write_split_memory(
    state: Option<&SplitMemoryState>,
    options: &SplitMemoryOptions,
) -> Result<(), NodeError> {
    let Some(state) = state else {
        return clear_split_memory(options);
    };
    let memory = base_memory(
        non_empty_path(state.a_tab_id_path.as_ref()),
        non_empty_path(state.b_tab_id_path.as_ref()),
    );
    let Some(mut memory) = memory else {
        return clear_split_memory(options);
    };
    if matches!(state.orientation.as_deref(), Some("side" | "stack")) {
        memory.orientation = state.orientation.clone();
    }
    if let Some(ratio) = state.ratio
        && ratio.is_finite()
    {
        memory.ratio = Some(clamp_ratio(ratio));
    }
    if matches!(state.focus.as_deref(), Some("a" | "b")) {
        memory.focus = state.focus.clone();
    }
    write_setting(options, Some(memory.to_json()))
}

/// `readSplitMemory(options)`
pub fn read_split_memory(options: &SplitMemoryOptions) -> Option<SplitMemory> {
    let path = resolve_settings_path(options);
    let settings = match options.read_settings {
        Some(read) => read(&path),
        None => read_app_settings(&path),
    };
    normalize_stored_memory(settings.get(SPLIT_MEMORY_SETTING_KEY))
}

/// `clearSplitMemory(options)`
pub fn clear_split_memory(options: &SplitMemoryOptions) -> Result<(), NodeError> {
    write_setting(options, None)
}
