//! The functions of group `settings` (tools/main-diff/groups/settings.ts).
//!
//! Callbacks the TypeScript takes are described by the spec as data, and both
//! sides run the same description:
//!
//! - `updateSkillSettings` and `updateProjectsSettings` get a list of
//!   operations on the settings they are handed;
//! - the split memory options name hooks that log their calls;
//! - the window functions get a window described by its state.
//!
//! The temporary file of an atomic write is named after the process and a
//! random UUID, so a message that holds it is compared with that part
//! replaced by `.<pid>.<uuid>.tmp` on both sides.

use std::cell::RefCell;

use jscompat::{JsObject, JsonValue, js_regex, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Value};

use super::{Answer, CallError, Context, arg, str_arg};
use crate::node_fs::NodeError;
use crate::packages::ai_provider::{
    SKILL_EDITORS, SkillEditorsChoice, UserSkillSettings, UserSkillStateSetting,
    normalize_user_skill_settings,
};
use crate::packages::project_store::is_valid_project_id;
use crate::shell::app_settings::{self as aps, SettingsError, StoredProjectsSettings};
use crate::shell::folder_roots as fr;
use crate::shell::split_memory::{self as sm, SettingsPath, SplitMemoryOptions, SplitMemoryState};
use crate::shell::window_bounds::{self as wb, ShellWindowLaunch, ShellWindowState, WindowRect};

fn scrub(message: &str) -> String {
    js_regex!(
        r"\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp",
        ""
    )
    .replace_all(message, |_| ".<pid>.<uuid>.tmp".to_owned())
}

fn node(error: NodeError) -> CallError {
    let call: CallError = error.into();
    CallError {
        code: call.code,
        message: scrub(&call.message),
    }
}

fn settings_error(error: SettingsError) -> CallError {
    match error {
        SettingsError::Plain(message) => CallError::plain(message),
        SettingsError::Node(error) => node(error),
    }
}

fn plain(message: impl Into<String>) -> CallError {
    CallError::plain(message)
}

fn ok(value: Value) -> Answer {
    Ok(Some(value))
}

fn done(result: Result<(), NodeError>) -> Answer {
    result.map(|()| None).map_err(node)
}

fn out(value: &JsonValue) -> Value {
    json_value_to_serde(value)
}

fn jv(args: &[Value], i: usize) -> Option<JsonValue> {
    arg(args, i).map(json_value_from_serde)
}

fn object_of(value: Option<&Value>, what: &str) -> Result<JsObject<JsonValue>, CallError> {
    match value.map(json_value_from_serde) {
        Some(JsonValue::Object(object)) => Ok(object),
        _ => Err(plain(format!("{what} is not an object"))),
    }
}

fn strings_of(value: Option<&Value>, what: &str) -> Result<Vec<String>, CallError> {
    let Some(Value::Array(items)) = value else {
        return Err(plain(format!("{what} is not an array")));
    };
    items
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or_else(|| plain(format!("{what} holds a non-string")))
        })
        .collect()
}

fn text_field(object: &Map<String, Value>, key: &str) -> Result<String, CallError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| plain(format!("{key} is not a string")))
}

fn number_field(object: &Map<String, Value>, key: &str) -> Result<f64, CallError> {
    object
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| plain(format!("{key} is not a number")))
}

fn rect_of(value: &Value) -> Result<WindowRect, CallError> {
    let Value::Object(object) = value else {
        return Err(plain("a rectangle is not an object"));
    };
    Ok(WindowRect {
        x: number_field(object, "x")?,
        y: number_field(object, "y")?,
        width: number_field(object, "width")?,
        height: number_field(object, "height")?,
    })
}

fn rects_of(value: Option<&Value>) -> Result<Vec<WindowRect>, CallError> {
    let Some(Value::Array(items)) = value else {
        return Err(plain("work areas are not an array"));
    };
    items.iter().map(rect_of).collect()
}

fn state_of(value: &Value) -> Result<ShellWindowState, CallError> {
    let Value::Object(object) = value else {
        return Err(plain("a state is not an object"));
    };
    Ok(ShellWindowState {
        rect: rect_of(value)?,
        maximized: object.get("maximized") == Some(&Value::Bool(true)),
    })
}

fn nullable<T>(value: Option<T>, to_value: impl FnOnce(T) -> Value) -> Value {
    value.map_or(Value::Null, to_value)
}

// ---- skills

fn skill_state_of(value: &Value) -> Result<UserSkillStateSetting, CallError> {
    let Value::Object(object) = value else {
        return Err(plain("a skill state is not an object"));
    };
    let mut state = UserSkillStateSetting::default();
    if let Some(enabled) = object.get("enabled") {
        state.enabled = Some(
            enabled
                .as_bool()
                .ok_or_else(|| plain("enabled is not a boolean"))?,
        );
    }
    if let Some(invoke) = object.get("invoke") {
        state.invoke = Some(
            invoke
                .as_str()
                .ok_or_else(|| plain("invoke is not a string"))?
                .to_owned(),
        );
    }
    match object.get("editors") {
        None => {}
        Some(Value::String(text)) if text == "all" => state.editors = Some(SkillEditorsChoice::All),
        Some(Value::Array(items)) => {
            let mut ids = Vec::new();
            for item in items {
                let id = item
                    .as_str()
                    .and_then(|text| SKILL_EDITORS.iter().copied().find(|id| *id == text))
                    .ok_or_else(|| plain("editors holds an unknown id"))?;
                ids.push(id);
            }
            state.editors = Some(SkillEditorsChoice::Some(ids));
        }
        Some(_) => return Err(plain("editors is neither \"all\" nor a list")),
    }
    Ok(state)
}

fn skill_settings_of(value: Option<&Value>) -> Result<UserSkillSettings, CallError> {
    let Some(Value::Object(object)) = value else {
        return Err(plain("settings is not an object"));
    };
    let mut settings = UserSkillSettings::default();
    if let Some(Value::Object(states)) = object.get("states") {
        for (id, state) in states {
            settings.states.set(id.clone(), skill_state_of(state)?);
        }
    }
    if object.contains_key("hiddenBuiltins") {
        settings.hidden_builtins = strings_of(object.get("hiddenBuiltins"), "hiddenBuiltins")?;
    }
    Ok(settings)
}

enum SkillOp {
    Set(String, UserSkillStateSetting),
    Hide(String),
    ClearHidden,
}

fn skill_ops_of(value: Option<&Value>) -> Result<Vec<SkillOp>, CallError> {
    let Some(Value::Array(items)) = value else {
        return Err(plain("ops is not an array"));
    };
    items
        .iter()
        .map(|item| {
            let Value::Object(op) = item else {
                return Err(plain("an op is not an object"));
            };
            match text_field(op, "op")?.as_str() {
                "set" => Ok(SkillOp::Set(
                    text_field(op, "id")?,
                    skill_state_of(op.get("value").ok_or_else(|| plain("set has no value"))?)?,
                )),
                "hide" => Ok(SkillOp::Hide(text_field(op, "name")?)),
                "clearHidden" => Ok(SkillOp::ClearHidden),
                other => Err(plain(format!("unknown op {other}"))),
            }
        })
        .collect()
}

fn skill_settings_json(settings: &UserSkillSettings) -> Value {
    out(&settings.to_json())
}

// ---- projects

enum ProjectOp {
    InstallId(String),
    HomeProjectId(Option<String>),
    AddList(aps::ProjectListEntry),
    SyncNotice(String),
    Switch(String, aps::ProjectSwitches),
    Trust(String, aps::ProjectTrustRecord),
}

fn project_ops_of(value: Option<&Value>) -> Result<Vec<ProjectOp>, CallError> {
    let Some(Value::Array(items)) = value else {
        return Err(plain("ops is not an array"));
    };
    items
        .iter()
        .map(|item| {
            let Value::Object(op) = item else {
                return Err(plain("an op is not an object"));
            };
            match text_field(op, "op")?.as_str() {
                "installId" => Ok(ProjectOp::InstallId(text_field(op, "value")?)),
                "homeProjectId" => Ok(ProjectOp::HomeProjectId(match op.get("value") {
                    Some(Value::Null) => None,
                    _ => Some(text_field(op, "value")?),
                })),
                "addList" => {
                    let Some(Value::Object(entry)) = op.get("entry") else {
                        return Err(plain("addList has no entry"));
                    };
                    Ok(ProjectOp::AddList(aps::ProjectListEntry {
                        id: text_field(entry, "id")?,
                        path: text_field(entry, "path")?,
                        pinned: entry.get("pinned") == Some(&Value::Bool(true)),
                        last_used_at: text_field(entry, "lastUsedAt")?,
                    }))
                }
                "syncNotice" => Ok(ProjectOp::SyncNotice(text_field(op, "id")?)),
                "switch" => Ok(ProjectOp::Switch(
                    text_field(op, "id")?,
                    aps::ProjectSwitches {
                        memory_enabled: op.get("memoryEnabled") != Some(&Value::Bool(false)),
                        read_agents_files: op.get("readAgentsFiles") != Some(&Value::Bool(false)),
                    },
                )),
                "trust" => {
                    let mut hashes = JsObject::new();
                    if let Some(Value::Object(stored)) = op.get("hashes") {
                        for (file, hash) in stored {
                            hashes.set(
                                file.clone(),
                                hash.as_str()
                                    .ok_or_else(|| plain("a hash is not a string"))?
                                    .to_owned(),
                            );
                        }
                    }
                    Ok(ProjectOp::Trust(
                        text_field(op, "id")?,
                        aps::ProjectTrustRecord {
                            decision: text_field(op, "decision")?,
                            hashes,
                        },
                    ))
                }
                other => Err(plain(format!("unknown op {other}"))),
            }
        })
        .collect()
}

fn apply_project_op(settings: &mut StoredProjectsSettings, op: &ProjectOp) {
    match op {
        ProjectOp::InstallId(id) => settings.install_id = id.clone(),
        ProjectOp::HomeProjectId(id) => settings.home_project_id = Some(id.clone()),
        ProjectOp::AddList(entry) => settings.list.push(entry.clone()),
        ProjectOp::SyncNotice(id) => settings.sync_notice_shown.push(id.clone()),
        ProjectOp::Switch(id, switches) => settings.settings.set(id.clone(), switches.clone()),
        ProjectOp::Trust(id, record) => settings.trust.set(id.clone(), record.clone()),
    }
}

fn projects_json(settings: &StoredProjectsSettings) -> Value {
    out(&settings.to_json())
}

// ---- split memory

fn split_state_of(value: &Value) -> Result<Option<SplitMemoryState>, CallError> {
    let Value::Object(object) = value else {
        return if value.is_null() {
            Ok(None)
        } else {
            Err(plain("a state is not an object"))
        };
    };
    let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
    Ok(Some(SplitMemoryState {
        a_tab_id_path: text("aTabIdPath"),
        b_tab_id_path: text("bTabIdPath"),
        orientation: text("orientation"),
        ratio: object.get("ratio").and_then(Value::as_f64),
        focus: text("focus"),
    }))
}

fn split_memory_json(memory: Option<sm::SplitMemory>) -> Value {
    nullable(memory, |memory| out(&memory.to_json()))
}

/// Runs `run` with the options the spec describes: `settingsPath`, `lazy`
/// (the path is given by a function that logs), `fakeRead` (a settings object
/// handed out by a `readSettings` hook that logs) and `fakeWrite` (a
/// `writeSetting` hook that logs).
fn with_split_options<T>(
    value: Option<&Value>,
    cx: &mut Context,
    run: impl FnOnce(&SplitMemoryOptions) -> T,
) -> Result<T, CallError> {
    let Some(Value::Object(spec)) = value else {
        return Err(plain("options is not an object"));
    };
    let path = text_field(spec, "settingsPath")?;
    let logs: RefCell<Vec<Vec<Value>>> = RefCell::new(Vec::new());
    let lazy_path = || {
        logs.borrow_mut()
            .push(vec![Value::String("settingsPath".to_owned())]);
        path.clone()
    };
    let fake_read = match spec.get("fakeRead") {
        Some(value) => Some(object_of(Some(value), "fakeRead")?),
        None => None,
    };
    let read_hook = |p: &str| {
        logs.borrow_mut().push(vec![
            Value::String("read".to_owned()),
            Value::String(p.to_owned()),
        ]);
        fake_read.clone().unwrap_or_default()
    };
    let write_hook = |p: &str, key: &str, value: Option<JsonValue>| -> Result<(), NodeError> {
        logs.borrow_mut().push(vec![
            Value::String("write".to_owned()),
            Value::String(p.to_owned()),
            Value::String(key.to_owned()),
            value
                .as_ref()
                .map_or_else(|| Value::String("<undefined>".to_owned()), out),
        ]);
        Ok(())
    };
    let options = SplitMemoryOptions {
        settings_path: if spec.get("lazy") == Some(&Value::Bool(true)) {
            SettingsPath::Lazy(&lazy_path)
        } else {
            SettingsPath::Fixed(path.clone())
        },
        read_settings: if fake_read.is_some() {
            Some(&read_hook)
        } else {
            None
        },
        write_setting: if spec.get("fakeWrite") == Some(&Value::Bool(true)) {
            Some(&write_hook)
        } else {
            None
        },
    };
    let result = run(&options);
    drop(options);
    cx.logs.extend(logs.into_inner());
    Ok(result)
}

// ---- windows

fn bool_field(object: &Map<String, Value>, key: &str, default: bool) -> bool {
    object.get(key).and_then(Value::as_bool).unwrap_or(default)
}

/// A window as the spec describes it.
struct FakeWindow {
    maximized: bool,
    minimized: bool,
    full_screen: bool,
    destroyed: bool,
    bounds: WindowRect,
}

impl FakeWindow {
    fn of(value: &Value) -> Result<Self, CallError> {
        let Value::Object(object) = value else {
            return Err(plain("a window is not an object"));
        };
        let optional = bool_field(object, "optional", true);
        Ok(FakeWindow {
            maximized: bool_field(object, "maximized", false),
            minimized: optional && bool_field(object, "minimized", false),
            full_screen: optional && bool_field(object, "fullScreen", false),
            destroyed: bool_field(object, "destroyed", false),
            bounds: rect_of(
                object
                    .get("bounds")
                    .ok_or_else(|| plain("a window has no bounds"))?,
            )?,
        })
    }
}

impl wb::ShellWindowSource for FakeWindow {
    fn is_maximized(&self) -> bool {
        self.maximized
    }
    fn is_minimized(&self) -> bool {
        self.minimized
    }
    fn is_full_screen(&self) -> bool {
        self.full_screen
    }
    fn get_content_bounds(&self) -> WindowRect {
        self.bounds
    }
    fn is_destroyed(&self) -> bool {
        self.destroyed
    }
}

/// The window `applyShellWindowState` is handed: it reports `reported` when
/// the spec gives one, else the bounds it was last set to; each call is
/// recorded.
struct RecordingTarget {
    reported: Option<WindowRect>,
    bounds: WindowRect,
    calls: Vec<Value>,
}

impl wb::ShellWindowTarget for RecordingTarget {
    fn set_content_bounds(&mut self, bounds: WindowRect) {
        self.bounds = bounds;
        self.calls.push(Value::Array(vec![
            Value::String("set".to_owned()),
            out(&bounds.to_json()),
        ]));
    }
    fn get_content_bounds(&self) -> WindowRect {
        self.reported.unwrap_or(self.bounds)
    }
    fn maximize(&mut self) {
        self.calls
            .push(Value::Array(vec![Value::String("maximize".to_owned())]));
    }
}

fn install_persistence(args: &[Value], cx: &mut Context) -> Answer {
    let settings_path = str_arg(args, 0)?;
    let Some(Value::Array(steps)) = arg(args, 1) else {
        return Err(plain("steps is not an array"));
    };
    let launch = match arg(args, 2) {
        Some(Value::Object(launch)) => ShellWindowLaunch {
            restored: match launch.get("restored") {
                Some(Value::Null) | None => None,
                Some(state) => Some(state_of(state)?),
            },
            baseline: match launch.get("baseline") {
                Some(Value::Null) | None => None,
                Some(rect) => Some(rect_of(rect)?),
            },
        },
        _ => return Err(plain("launch is not an object")),
    };
    let mut persistence: Option<wb::ShellWindowBoundsPersistence> = None;
    let mut settle_pending = false;
    let mut save_pending = false;
    for step in steps {
        let Value::Object(step) = step else {
            return Err(plain("a step is not an object"));
        };
        let win = FakeWindow::of(step.get("win").ok_or_else(|| plain("a step has no win"))?)?;
        let Some(live) = persistence.as_mut() else {
            persistence = Some(wb::ShellWindowBoundsPersistence::install(launch, &win));
            continue;
        };
        let save = |live: &mut wb::ShellWindowBoundsPersistence,
                    cx: &mut Context,
                    settle_pending: &mut bool,
                    save_pending: &mut bool| {
            *settle_pending = false;
            *save_pending = false;
            live.save(settings_path, &win, |error| {
                cx.logs.push(vec![
                    Value::String("[shell] window bounds were not saved:".to_owned()),
                    Value::String(scrub(&error.message)),
                ]);
            });
        };
        match text_field(step, "action")?.as_str() {
            "move" | "resize" => {
                settle_pending = true;
                save_pending = true;
            }
            "settle" => {
                if settle_pending {
                    settle_pending = false;
                    live.settle(&win);
                }
            }
            "debounce" => {
                if save_pending {
                    save(live, cx, &mut settle_pending, &mut save_pending);
                }
            }
            "close" => save(live, cx, &mut settle_pending, &mut save_pending),
            other => return Err(plain(format!("unknown action {other}"))),
        }
    }
    Ok(None)
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- states.ts, folder-api.ts
        "states.normalizeUserSkillSettings" => ok(skill_settings_json(
            &normalize_user_skill_settings(jv(args, 0).as_ref()),
        )),
        "folder-api.isValidProjectId" => ok(Value::Bool(
            matches!(arg(args, 0), Some(Value::String(text)) if is_valid_project_id(text)),
        )),

        // ---- app-settings.ts
        "app-settings.readAppSettings" => (|| {
            let settings = aps::read_app_settings(str_arg(args, 0)?);
            ok(out(&JsonValue::Object(settings)))
        })(),
        "app-settings.writeAppSettings" => (|| {
            let path = str_arg(args, 0)?;
            let updates = object_of(arg(args, 1), "updates")?;
            let updates: Vec<(&str, Option<JsonValue>)> = updates
                .entries()
                .into_iter()
                .map(|(k, v)| (k, Some(v.clone())))
                .collect();
            done(aps::write_app_settings(path, &updates))
        })(),
        "app-settings.writeAppSetting" => (|| {
            done(aps::write_app_setting(
                str_arg(args, 0)?,
                str_arg(args, 1)?,
                jv(args, 2),
            ))
        })(),
        "app-settings.writeAppSettingThen" => (|| {
            let mut seen: Option<(bool, Option<JsonValue>)> = None;
            aps::write_app_setting_then(
                str_arg(args, 0)?,
                str_arg(args, 1)?,
                jv(args, 2),
                |value| {
                    seen = Some((true, value.cloned()));
                },
            )
            .map_err(node)?;
            let mut result = Map::new();
            result.insert("called".to_owned(), Value::Bool(seen.is_some()));
            if let Some((_, Some(value))) = &seen {
                result.insert("with".to_owned(), out(value));
            }
            ok(Value::Object(result))
        })(),
        "app-settings.SKILLS_SETTING_KEY" => ok(Value::String(aps::SKILLS_SETTING_KEY.to_owned())),
        "app-settings.AGENT_SKILL_NOTICE_KEY" => {
            ok(Value::String(aps::AGENT_SKILL_NOTICE_KEY.to_owned()))
        }
        "app-settings.AGENT_PROJECT_PREFS_KEY" => {
            ok(Value::String(aps::AGENT_PROJECT_PREFS_KEY.to_owned()))
        }
        "app-settings.PROJECTS_SETTING_KEY" => {
            ok(Value::String(aps::PROJECTS_SETTING_KEY.to_owned()))
        }
        "app-settings.DEFAULT_AGENT_PROJECT_PREF" => {
            ok(out(&aps::default_agent_project_pref().to_json()))
        }
        "app-settings.readSkillSettings" => (|| {
            ok(skill_settings_json(&aps::read_skill_settings(str_arg(
                args, 0,
            )?)))
        })(),
        "app-settings.writeSkillSettings" => (|| {
            let settings = skill_settings_of(arg(args, 1))?;
            done(aps::write_skill_settings(str_arg(args, 0)?, &settings))
        })(),
        "app-settings.updateSkillSettings" => (|| {
            let ops = skill_ops_of(arg(args, 1))?;
            let settings = aps::update_skill_settings(str_arg(args, 0)?, |settings| {
                for op in &ops {
                    match op {
                        SkillOp::Set(id, state) => settings.states.set(id.clone(), state.clone()),
                        SkillOp::Hide(name) => settings.hidden_builtins.push(name.clone()),
                        SkillOp::ClearHidden => settings.hidden_builtins = Vec::new(),
                    }
                }
            })
            .map_err(node)?;
            ok(skill_settings_json(&settings))
        })(),
        "app-settings.agentSkillNoticeDue" => {
            (|| ok(Value::Bool(aps::agent_skill_notice_due(str_arg(args, 0)?))))()
        }
        "app-settings.markAgentSkillNoticeSeen" => {
            (|| done(aps::mark_agent_skill_notice_seen(str_arg(args, 0)?)))()
        }
        "app-settings.writeAgentPrefs" => (|| {
            let prefs = jv(args, 1).ok_or_else(|| plain("prefs is missing"))?;
            done(aps::write_agent_prefs(str_arg(args, 0)?, &prefs))
        })(),
        "app-settings.normalizeAgentProjectPrefs" => {
            let prefs = aps::normalize_agent_project_prefs(jv(args, 0).as_ref());
            let mut object = JsObject::new();
            for (folder, pref) in prefs.entries() {
                object.set(folder, JsonValue::Object(pref.clone()));
            }
            ok(out(&JsonValue::Object(object)))
        }
        "app-settings.readAgentProjectPref" => (|| {
            let pref = aps::read_agent_project_pref(str_arg(args, 0)?, str_arg(args, 1)?);
            ok(out(&pref.to_json()))
        })(),
        "app-settings.writeAgentProjectPref" => (|| {
            let patch = jv(args, 2).ok_or_else(|| plain("patch is missing"))?;
            let pref = aps::write_agent_project_pref(str_arg(args, 0)?, str_arg(args, 1)?, &patch)
                .map_err(settings_error)?;
            ok(out(&pref.to_json()))
        })(),
        "app-settings.normalizeProjectsSettings" => ok(projects_json(
            &aps::normalize_projects_settings(jv(args, 0).as_ref()),
        )),
        "app-settings.readProjectsSettings" => (|| {
            ok(projects_json(&aps::read_projects_settings(str_arg(
                args, 0,
            )?)))
        })(),
        "app-settings.writeProjectsSettings" => (|| {
            let value = jv(args, 1);
            done(aps::write_projects_settings(
                str_arg(args, 0)?,
                value.as_ref(),
            ))
        })(),
        "app-settings.updateProjectsSettings" => (|| {
            let ops = project_ops_of(arg(args, 1))?;
            let settings = aps::update_projects_settings(str_arg(args, 0)?, |settings| {
                for op in &ops {
                    apply_project_op(settings, op);
                }
            })
            .map_err(node)?;
            ok(projects_json(&settings))
        })(),

        // ---- folder-roots.ts
        "folder-roots.FOLDER_ROOTS_KEY" => ok(Value::String(fr::FOLDER_ROOTS_KEY.to_owned())),
        "folder-roots.readExtraRoots" => (|| {
            let settings = object_of(arg(args, 0), "settings")?;
            let roots = fr::read_extra_roots(&settings, str_arg(args, 1)?);
            ok(Value::Array(roots.into_iter().map(Value::String).collect()))
        })(),
        "folder-roots.withExtraRoot" => (|| {
            let extras = strings_of(arg(args, 0), "extras")?;
            let list = fr::with_extra_root(&extras, str_arg(args, 1)?, str_arg(args, 2)?);
            ok(nullable(list, |list| {
                Value::Array(list.into_iter().map(Value::String).collect())
            }))
        })(),
        "folder-roots.withoutExtraRoot" => (|| {
            let extras = strings_of(arg(args, 0), "extras")?;
            let list = fr::without_extra_root(&extras, str_arg(args, 1)?);
            ok(Value::Array(list.into_iter().map(Value::String).collect()))
        })(),
        "folder-roots.describeExtraRoot" => {
            (|| ok(out(&fr::describe_extra_root(str_arg(args, 0)?).to_json())))()
        }

        // ---- split-memory.ts
        "split-memory.SPLIT_MEMORY_SETTING_KEY" => {
            ok(Value::String(sm::SPLIT_MEMORY_SETTING_KEY.to_owned()))
        }
        "split-memory.readSplitMemory" => (|| {
            let memory = with_split_options(arg(args, 0), cx, sm::read_split_memory)?;
            ok(split_memory_json(memory))
        })(),
        "split-memory.writeSplitMemory" => (|| {
            let state = split_state_of(arg(args, 0).ok_or_else(|| plain("state is missing"))?)?;
            let result = with_split_options(arg(args, 1), cx, |options| {
                sm::write_split_memory(state.as_ref(), options)
            })?;
            done(result)
        })(),
        "split-memory.clearSplitMemory" => (|| {
            let result = with_split_options(arg(args, 0), cx, sm::clear_split_memory)?;
            done(result)
        })(),

        // ---- window-bounds.ts
        "window-bounds.WINDOW_BOUNDS_KEY" => ok(Value::String(wb::WINDOW_BOUNDS_KEY.to_owned())),
        "window-bounds.SHELL_WINDOW_DEFAULT_WIDTH" => ok(wb::SHELL_WINDOW_DEFAULT_WIDTH.into()),
        "window-bounds.SHELL_WINDOW_DEFAULT_HEIGHT" => ok(wb::SHELL_WINDOW_DEFAULT_HEIGHT.into()),
        "window-bounds.SHELL_WINDOW_MIN_WIDTH" => ok(wb::SHELL_WINDOW_MIN_WIDTH.into()),
        "window-bounds.SHELL_WINDOW_MIN_HEIGHT" => ok(wb::SHELL_WINDOW_MIN_HEIGHT.into()),
        "window-bounds.WINDOW_BOUNDS_SAVE_DEBOUNCE_MS" => {
            ok(wb::WINDOW_BOUNDS_SAVE_DEBOUNCE_MS.into())
        }
        "window-bounds.WINDOW_BOUNDS_SETTLE_MS" => ok(wb::WINDOW_BOUNDS_SETTLE_MS.into()),
        "window-bounds.parseShellWindowState" => {
            let state = wb::parse_shell_window_state(jv(args, 0).as_ref());
            ok(nullable(state, |state| out(&state.to_json())))
        }
        "window-bounds.isShellWindowVisible" => (|| {
            let state = rect_of(arg(args, 0).ok_or_else(|| plain("state is missing"))?)?;
            ok(Value::Bool(wb::is_shell_window_visible(
                &state,
                &rects_of(arg(args, 1))?,
            )))
        })(),
        "window-bounds.readShellWindowState" => (|| {
            let state = wb::read_shell_window_state(str_arg(args, 0)?, &rects_of(arg(args, 1))?);
            ok(nullable(state, |state| out(&state.to_json())))
        })(),
        "window-bounds.applyShellWindowState" => (|| {
            let Some(Value::Object(win)) = arg(args, 0) else {
                return Err(plain("win is not an object"));
            };
            let reported = match win.get("reported") {
                Some(Value::Null) | None => None,
                Some(rect) => Some(rect_of(rect)?),
            };
            let mut target = RecordingTarget {
                reported,
                bounds: rect_of(
                    win.get("bounds")
                        .ok_or_else(|| plain("win has no bounds"))?,
                )?,
                calls: Vec::new(),
            };
            let state = match arg(args, 1) {
                Some(Value::Null) | None => None,
                Some(state) => Some(state_of(state)?),
            };
            let baseline = wb::apply_shell_window_state(&mut target, state.as_ref());
            let mut result = Map::new();
            result.insert(
                "baseline".to_owned(),
                nullable(baseline, |rect| out(&rect.to_json())),
            );
            result.insert("calls".to_owned(), Value::Array(target.calls));
            ok(Value::Object(result))
        })(),
        "window-bounds.installShellWindowBoundsPersistence" => install_persistence(args, cx),
        _ => return None,
    })
}
