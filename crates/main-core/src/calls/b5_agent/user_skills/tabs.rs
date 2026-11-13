//! The template tabs scenarios of part user-skills: `createTemplateTabs`, and
//! `registerTemplateTabsIpc` over it, with the file, tab and window objects of
//! the spec as fakes. The scenario plays the adapter: it carries out the
//! `once('destroyed')` listeners of a destroyed webContents.

use std::fs;

use jscompat::node_path::host::join;
use jscompat::{JsonValue, json_value_to_serde};
use serde_json::{Map, Value, json};

use super::{
    Answer, Context, Log, arg, bool_of, hex_bytes, hex_of, js_of, list_of, log_line, number_of,
    str_of, unreal,
};
use crate::packages::ai_provider::user_skills_import::{Thrown, remove_quietly};
use crate::packages::electron_utils::generate_handoff::{
    HandoffEditor, HandoffSkillChip, HandoffStore, HandoffWebContents,
};
use crate::shell::user_skills::template_tabs::{
    CurrentDocument, OpenedCopyTab, PreviewEnded, PreviewInput, TemplateCopy, TemplateOpenInput,
    TemplateTabs, TemplateTabsHost,
};
use crate::shell::user_skills::template_tabs_ipc::{
    PreviewOriginalAnswer, handle_finish_preview, handle_focus_tab, handle_open_preview,
    handle_open_template, handle_preview_original, handle_take_handoff,
};
use crate::shell::user_skills::user_skills_service::{Failure, Svc, TemplateFile, UserSkillsFail};

/// the webContents of a copy tab: destroyed when the scenario says so
struct FakeContents {
    id: f64,
    destroyed: std::rc::Rc<std::cell::RefCell<Vec<f64>>>,
}

impl HandoffWebContents for FakeContents {
    fn id(&self) -> f64 {
        self.id
    }

    fn is_destroyed(&self) -> bool {
        self.destroyed.borrow().contains(&self.id)
    }

    fn once_destroyed(&mut self) {}
}

struct TabsHost {
    opts: Value,
    root: String,
    log: Log,
    now_ms: f64,
    ids: u32,
    dirs: u32,
    destroyed: std::rc::Rc<std::cell::RefCell<Vec<f64>>>,
}

fn fail(reason: &str) -> Failure {
    Failure::Fail(UserSkillsFail {
        reason: reason.to_owned(),
        problem: None,
    })
}

impl TemplateTabsHost for TabsHost {
    fn make_copy_dir(&mut self) -> Result<String, String> {
        self.dirs += 1;
        let dir = join(&[&self.root, "copies", &format!("c{}", self.dirs)]);
        if bool_of(self.opts.get("makeDirThrows")) {
            return Err("no space".to_owned());
        }
        let _ = fs::create_dir_all(&dir);
        log_line(
            &self.log,
            vec![Value::from("makeCopyDir"), Value::from(dir.as_str())],
        );
        Ok(dir)
    }

    fn write_file(&mut self, path: &str, bytes: &[u8]) -> Result<(), String> {
        log_line(
            &self.log,
            vec![
                Value::from("writeFile"),
                Value::from(path),
                Value::from(hex_of(bytes)),
            ],
        );
        if bool_of(self.opts.get("writeThrows")) {
            return Err("read-only".to_owned());
        }
        fs::write(path, bytes).map_err(|e| e.to_string())
    }

    fn read_file(&mut self, path: &str) -> Result<Vec<u8>, String> {
        log_line(&self.log, vec![Value::from("readFile"), Value::from(path)]);
        fs::read(path).map_err(|e| e.to_string())
    }

    fn remove_dir(&mut self, path: &str) -> Result<(), String> {
        log_line(&self.log, vec![Value::from("removeDir"), Value::from(path)]);
        remove_quietly(path);
        Ok(())
    }

    fn template_file_of(&mut self, skill_id: &str) -> Svc<TemplateFile> {
        log_line(
            &self.log,
            vec![Value::from("templateFileOf"), Value::from(skill_id)],
        );
        let Some(entry) = self
            .opts
            .get("skills")
            .and_then(|skills| skills.get(skill_id))
        else {
            return Err(fail("not-found"));
        };
        if bool_of(entry.get("throw")) {
            return Err(Failure::Thrown(Thrown::Plain("lookup failed".to_owned())));
        }
        if entry.get("ok") == Some(&Value::Bool(false)) {
            return Err(fail(str_of(entry.get("reason")).unwrap_or("")));
        }
        let text = |key: &str| str_of(entry.get(key)).unwrap_or("").to_owned();
        Ok(TemplateFile {
            path: text("path"),
            file_name: text("fileName"),
            title: text("title"),
        })
    }

    fn open_copy(&mut self, copy: &TemplateCopy) -> Result<Option<OpenedCopyTab>, String> {
        log_line(
            &self.log,
            vec![
                Value::from("openCopy"),
                json!({
                    "editor": copy.editor.as_str(),
                    "path": copy.path,
                    "dir": copy.dir,
                    "bytes": hex_of(&copy.bytes),
                    "fileName": copy.file_name,
                    "title": copy.title,
                }),
            ],
        );
        let open = self.opts.get("open");
        if bool_of(open.and_then(|o| o.get("throw"))) {
            return Err("window failed".to_owned());
        }
        if bool_of(open.and_then(|o| o.get("none"))) {
            return Ok(None);
        }
        Ok(Some(OpenedCopyTab {
            tab_id: str_of(open.and_then(|o| o.get("tabId")))
                .unwrap_or("")
                .to_owned(),
            contents: Box::new(FakeContents {
                id: number_of(open.and_then(|o| o.get("contentsId"))),
                destroyed: self.destroyed.clone(),
            }),
            owns_copy: bool_of(open.and_then(|o| o.get("ownsCopy"))),
        }))
    }

    fn current_document_of(&mut self, opener_id: f64) -> Option<Result<CurrentDocument, String>> {
        let current = self.opts.get("current")?;
        log_line(
            &self.log,
            vec![Value::from("currentDocumentOf"), Value::from(opener_id)],
        );
        Some(match current.as_str() {
            Some("throw") => Err("no document".to_owned()),
            Some("unsaved") => Ok(CurrentDocument::Unsaved),
            Some(path) => Ok(CurrentDocument::Path(path.to_owned())),
            None => Ok(CurrentDocument::Unsaved),
        })
    }

    fn focus_tab(&mut self, tab_id: &str) -> bool {
        log_line(
            &self.log,
            vec![Value::from("focusTab"), Value::from(tab_id)],
        );
        list_of(self.opts.get("focusable"))
            .iter()
            .any(|known| known.as_str() == Some(tab_id))
    }

    fn copy_opened_for(&mut self, contents_id: f64, opener_id: f64) {
        if bool_of(self.opts.get("copyOpened")) {
            log_line(
                &self.log,
                vec![
                    Value::from("copyOpenedFor"),
                    Value::from(contents_id),
                    Value::from(opener_id),
                ],
            );
        }
    }

    fn new_id(&mut self) -> String {
        self.ids += 1;
        format!("id-{}", self.ids)
    }

    fn now(&mut self) -> f64 {
        self.now_ms
    }

    fn owner_is_destroyed(&mut self, owner_id: f64) -> bool {
        self.destroyed.borrow().contains(&owner_id)
    }

    fn owner_send(&mut self, owner_id: f64, channel: &str, payload: &JsonValue) {
        log_line(
            &self.log,
            vec![
                Value::from("send"),
                Value::from(owner_id),
                Value::from(channel),
                json_value_to_serde(payload),
            ],
        );
    }
}

/// the state of a scenario: the host, the tabs, the hand-off store
struct Env {
    host: TabsHost,
    tabs: TemplateTabs,
    store: HandoffStore,
    root: String,
    log: Log,
}

fn env_of(opts: &Value, cx: &Context) -> Env {
    let root = str_of(opts.get("root")).unwrap_or("").to_owned();
    let log: Log = Log::default();
    Env {
        host: TabsHost {
            opts: opts.clone(),
            root: root.clone(),
            log: log.clone(),
            now_ms: cx.now_ms,
            ids: 0,
            dirs: 0,
            destroyed: Default::default(),
        },
        tabs: TemplateTabs::new(),
        store: HandoffStore::new(false),
        root,
        log,
    }
}

impl Env {
    /// `destroy(id)` of the scenario: the listeners of the webContents, in the order they were added
    fn destroy(&mut self, id: f64) {
        self.host.destroyed.borrow_mut().push(id);
        self.store.drop_generate_handoff(id);
        self.tabs.contents_destroyed(&mut self.host, id);
    }
}

fn chips_of(value: Option<&Value>) -> Vec<HandoffSkillChip> {
    list_of(value)
        .iter()
        .map(|chip| {
            let text = |key: &str| str_of(chip.get(key)).unwrap_or("").to_owned();
            HandoffSkillChip {
                id: text("id"),
                source: text("source"),
                title: text("title"),
            }
        })
        .collect()
}

/// `value` with `bytes` as `{ "$bytes": n }`, and the bytes it stood for
fn marked(value: &Value, key: &str) -> (Value, Vec<u8>) {
    let bytes = value.get(key).and_then(hex_bytes);
    let Some(bytes) = bytes else {
        return (value.clone(), Vec::new());
    };
    let mut out = value.clone();
    if let Some(map) = out.as_object_mut() {
        map.insert(key.to_owned(), json!({"$bytes": bytes.len()}));
    }
    (out, bytes)
}

fn editor_of(name: &str) -> Option<HandoffEditor> {
    HandoffEditor::parse(name)
}

fn handoff_value(
    handoff: Option<crate::packages::electron_utils::generate_handoff::SkillHandoff>,
) -> Value {
    match handoff {
        Some(handoff) => serde_json::to_value(&handoff).expect("a hand-off prints"),
        None => Value::Null,
    }
}

fn ok_with(entries: Vec<(&str, Value)>) -> Value {
    let mut object = Map::new();
    object.insert("ok".into(), Value::Bool(true));
    for (key, value) in entries {
        object.insert(key.to_owned(), value);
    }
    Value::Object(object)
}

fn answer_of<T>(result: Svc<T>, ok: impl FnOnce(T) -> Value) -> Value {
    match result {
        Ok(value) => ok(value),
        Err(Failure::Fail(fail)) => json_value_to_serde(&fail.to_json()),
        Err(Failure::Thrown(thrown)) => {
            json!({"threw": super::thrown_error(&thrown).message})
        }
    }
}

fn step(env: &mut Env, step: &Value) -> Value {
    let method = str_of(step.get("m")).unwrap_or("");
    let a = list_of(step.get("a"));
    let text = |i: usize| str_of(a.get(i)).unwrap_or("");
    let num = |i: usize| number_of(a.get(i));
    match method {
        "openTemplate" => {
            let input = TemplateOpenInput {
                skill_id: str_of(a.first().and_then(|i| i.get("skillId")))
                    .unwrap_or("")
                    .to_owned(),
                text: str_of(a.first().and_then(|i| i.get("text")))
                    .unwrap_or("")
                    .to_owned(),
                chips: chips_of(a.first().and_then(|i| i.get("chips"))),
                with_current: bool_of(a.first().and_then(|i| i.get("withCurrent"))),
            };
            let opener = a.get(1).and_then(Value::as_f64);
            answer_of(
                env.tabs
                    .open_template(&mut env.host, &mut env.store, &input, opener),
                |(tab_id, attached)| {
                    ok_with(vec![
                        ("tabId", Value::from(tab_id)),
                        ("attached", Value::Bool(attached)),
                    ])
                },
            )
        }
        "openPreview" => {
            let (raw, bytes) = marked(a.get(1).unwrap_or(&Value::Null), "bytes");
            let Some(input) = PreviewInput::from_json(&js_of(&raw), bytes) else {
                return json!({"threw": "bad step"});
            };
            answer_of(
                env.tabs
                    .open_preview(&mut env.host, &mut env.store, num(0), &input),
                |(tab_id, preview_id)| {
                    ok_with(vec![
                        ("tabId", Value::from(tab_id)),
                        ("previewId", Value::from(preview_id)),
                    ])
                },
            )
        }
        "openPreviewIds" => json!(env.tabs.open_preview_ids()),
        "openCopy" => {
            let input = a.first().unwrap_or(&Value::Null);
            let bytes = input.get("bytes").and_then(hex_bytes).unwrap_or_default();
            answer_of(
                env.tabs.open_copy(
                    &mut env.host,
                    &mut env.store,
                    &bytes,
                    str_of(input.get("fileName")).unwrap_or(""),
                    str_of(input.get("title")).unwrap_or(""),
                    str_of(input.get("text")).unwrap_or(""),
                    &chips_of(input.get("chips")),
                ),
                |tab_id| ok_with(vec![("tabId", Value::from(tab_id))]),
            )
        }
        "previewOriginal" => match env.tabs.preview_original(num(0), text(1)) {
            Ok((bytes, file_name)) => ok_with(vec![
                ("bytes", Value::from(hex_of(&bytes))),
                ("fileName", Value::from(file_name)),
            ]),
            Err(fail) => json_value_to_serde(&fail.to_json()),
        },
        "finishPreview" => {
            match PreviewEnded::from_json(&js_of(a.get(1).unwrap_or(&Value::Null))) {
                Some(ended) => match env.tabs.finish_preview(&mut env.host, num(0), &ended) {
                    Ok(()) => ok_with(Vec::new()),
                    Err(fail) => json_value_to_serde(&fail.to_json()),
                },
                None => json!({"threw": "bad step"}),
            }
        }
        "takeHandoff" => {
            let Some(editor) = editor_of(text(0)) else {
                return Value::Null;
            };
            handoff_value(env.tabs.take_handoff(&mut env.store, editor, num(1)))
        }
        "focusTab" => match env.tabs.focus_tab(&mut env.host, text(0)) {
            Ok(()) => ok_with(Vec::new()),
            Err(fail) => json_value_to_serde(&fail.to_json()),
        },
        _ => json!({"threw": "no such method"}),
    }
}

pub(super) fn run(args: &[Value], cx: &mut Context) -> Answer {
    let opts = arg(args, 0).cloned().unwrap_or(Value::Null);
    let mut env = env_of(&opts, cx);
    let mut out: Vec<Value> = Vec::new();
    for entry in list_of(arg(args, 1)) {
        if let Some(id) = entry.get("destroy").and_then(Value::as_f64) {
            env.destroy(id);
            out.push(Value::Null);
        } else {
            let answer = step(&mut env, entry);
            out.push(unreal(answer, &env.root));
        }
    }
    cx.logs.extend(env.log.borrow().iter().cloned());
    Ok(Some(Value::Array(out)))
}

/// the handler of a `skills:<channel>` of the template flow
fn handler(env: &mut Env, ch: &str, sender: f64, a: &[Value]) -> Value {
    let js: Vec<JsonValue> = a.iter().map(js_of).collect();
    let at = |i: usize| js.get(i);
    match ch {
        "open-template" => json_value_to_serde(&handle_open_template(
            &mut env.tabs,
            &mut env.host,
            &mut env.store,
            at(0),
            sender,
        )),
        "open-preview" => {
            let (raw, bytes) = marked(a.first().unwrap_or(&Value::Null), "bytes");
            let raw = js_of(&raw);
            json_value_to_serde(&handle_open_preview(
                &mut env.tabs,
                &mut env.host,
                &mut env.store,
                if a.is_empty() { None } else { Some(&raw) },
                bytes,
                sender,
            ))
        }
        "preview-original" => match handle_preview_original(&env.tabs, at(0), sender) {
            PreviewOriginalAnswer::Original { bytes, file_name } => ok_with(vec![
                ("bytes", Value::from(hex_of(&bytes))),
                ("fileName", Value::from(file_name)),
            ]),
            PreviewOriginalAnswer::Refused(answer) => json_value_to_serde(&answer),
        },
        "finish-preview" => json_value_to_serde(&handle_finish_preview(
            &mut env.tabs,
            &mut env.host,
            at(0),
            sender,
        )),
        "take-handoff" => handoff_value(handle_take_handoff(
            &mut env.tabs,
            &mut env.store,
            at(0),
            sender,
        )),
        "focus-tab" => json_value_to_serde(&handle_focus_tab(&mut env.tabs, &mut env.host, at(0))),
        _ => json!({"threw": "no handler"}),
    }
}

pub(super) fn run_ipc(args: &[Value], cx: &mut Context) -> Answer {
    let opts = arg(args, 0).cloned().unwrap_or(Value::Null);
    let mut env = env_of(&opts, cx);
    let mut out: Vec<Value> = Vec::new();
    for entry in list_of(arg(args, 1)) {
        if let Some(id) = entry.get("destroy").and_then(Value::as_f64) {
            env.destroy(id);
            out.push(Value::Null);
            continue;
        }
        let ch = str_of(entry.get("ch")).unwrap_or("");
        let sender = entry.get("s").and_then(Value::as_f64).unwrap_or(1.0);
        let answer = handler(&mut env, ch, sender, list_of(entry.get("a")));
        out.push(unreal(answer, &env.root));
    }
    cx.logs.extend(env.log.borrow().iter().cloned());
    Ok(Some(Value::Array(out)))
}
