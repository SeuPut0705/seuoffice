//! The IPC scenario of part user-skills: `registerUserSkillsIpc` over the
//! service of `service.rs`, with the Electron objects of the spec as fakes.
//! The scenario plays the adapter: it routes a channel to the method that is
//! the body of its handler, and carries out the `await` of a held GitHub
//! import or update check between the `begin` and the `finish` call.

use std::collections::VecDeque;

use jscompat::{JsObject, JsonValue, json_value_from_serde, json_value_to_serde, random_uuid};
use serde_json::{Value, json};

use super::service::{Service, service_of};
use super::{
    Answer, Context, Log, arg, bool_of, clean_uuids, hex_bytes, js_of, list_of, log_line, str_of,
    unreal,
};
use crate::packages::ai_provider::user_skills_import::SkillImportSource;
use crate::packages::electron_utils::dialog_memory::Dialog;
use crate::shell::user_skills::user_skills_ipc::{
    DroppedSkillEntry, Run, UserSkillsIpc, UserSkillsIpcHost,
};

/// `dialog` of the spec: each call logs and answers the next scripted answer
struct FakeDialog {
    log: Log,
    open: VecDeque<Value>,
    save: VecDeque<Value>,
}

impl Dialog for FakeDialog {
    type Window = ();

    fn show_open_dialog(
        &mut self,
        parent: Option<&()>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        log_line(
            &self.log,
            vec![
                Value::from("showOpenDialog"),
                Value::Bool(parent.is_some()),
                json_value_to_serde(&JsonValue::Object(options.clone())),
            ],
        );
        let answer = self
            .open
            .pop_front()
            .unwrap_or_else(|| json!({"canceled": true, "filePaths": []}));
        json_value_from_serde(&answer)
    }

    fn show_save_dialog(
        &mut self,
        parent: Option<&()>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        log_line(
            &self.log,
            vec![
                Value::from("showSaveDialog"),
                Value::Bool(parent.is_some()),
                json_value_to_serde(&JsonValue::Object(options.clone())),
            ],
        );
        let answer = self
            .save
            .pop_front()
            .unwrap_or_else(|| json!({"canceled": true}));
        json_value_from_serde(&answer)
    }
}

/// `canManage` of the spec: everything, nothing, or a list of channels
enum Manage {
    All(bool),
    Channels(Vec<String>),
}

struct IpcHost {
    log: Log,
    dialog: FakeDialog,
    manage: Manage,
    parent: bool,
    /// `agentNoticeDue`: `Some(true | false)`, or `None` to throw
    notice: Option<bool>,
    mark_throws: bool,
    destroyed: Vec<f64>,
    contents: Vec<f64>,
    open_path_error: String,
    /// the windows whose `once('destroyed')` was asked for
    registered: Vec<f64>,
}

impl IpcHost {
    fn of(opts: &Value, log: &Log) -> IpcHost {
        let manage = match opts.get("manage") {
            Some(Value::Array(channels)) => Manage::Channels(
                channels
                    .iter()
                    .filter_map(|c| c.as_str().map(str::to_owned))
                    .collect(),
            ),
            Some(Value::Bool(all)) => Manage::All(*all),
            _ => Manage::All(true),
        };
        let queue = |key: &str| -> VecDeque<Value> {
            opts.get("dialogs")
                .and_then(|d| d.get(key))
                .map(|list| list_of(Some(list)).iter().cloned().collect())
                .unwrap_or_default()
        };
        IpcHost {
            log: log.clone(),
            dialog: FakeDialog {
                log: log.clone(),
                open: queue("open"),
                save: queue("save"),
            },
            manage,
            parent: bool_of(opts.get("parent")),
            notice: match opts.get("notice") {
                Some(Value::String(_)) => None,
                other => Some(bool_of(other)),
            },
            mark_throws: bool_of(opts.get("markThrows")),
            destroyed: Vec::new(),
            contents: list_of(opts.get("contents"))
                .iter()
                .filter_map(Value::as_f64)
                .collect(),
            open_path_error: str_of(opts.get("openPathError")).unwrap_or("").to_owned(),
            registered: Vec::new(),
        }
    }

    fn send_to_all(&mut self, channel: &str) {
        for id in &self.contents {
            if !self.destroyed.contains(id) {
                log_line(
                    &self.log,
                    vec![Value::from("send"), Value::from(*id), Value::from(channel)],
                );
            }
        }
    }
}

impl UserSkillsIpcHost for IpcHost {
    type Dialog = FakeDialog;

    fn dialog(&mut self) -> &mut FakeDialog {
        &mut self.dialog
    }

    fn parent_of(&mut self, _sender_id: f64) -> Option<()> {
        self.parent.then_some(())
    }

    fn can_manage(&mut self, sender_id: f64, channel: &str) -> bool {
        log_line(
            &self.log,
            vec![
                Value::from("canManage"),
                Value::from(sender_id),
                Value::from(channel),
            ],
        );
        match &self.manage {
            Manage::All(all) => *all,
            Manage::Channels(channels) => channels.iter().any(|known| known == channel),
        }
    }

    fn open_settings(&mut self) {
        log_line(&self.log, vec![Value::from("openSettings")]);
    }

    fn agent_notice_due(&mut self) -> Result<bool, String> {
        log_line(&self.log, vec![Value::from("agentNoticeDue")]);
        self.notice.ok_or_else(|| "settings unreadable".to_owned())
    }

    fn mark_agent_notice_seen(&mut self) -> Result<(), String> {
        log_line(&self.log, vec![Value::from("markAgentNoticeSeen")]);
        if self.mark_throws {
            Err("unwritable".to_owned())
        } else {
            Ok(())
        }
    }

    fn broadcast_changed(&mut self) {
        self.send_to_all("skills:changed");
    }

    fn broadcast_dropped(&mut self) {
        self.send_to_all("skills:dropped");
    }

    fn random_uuid(&mut self) -> String {
        random_uuid()
    }

    fn is_destroyed(&mut self, sender_id: f64) -> bool {
        self.destroyed.contains(&sender_id)
    }

    fn watch_destroyed(&mut self, sender_id: f64) {
        self.registered.push(sender_id);
    }

    fn open_path(&mut self, path: &str) -> String {
        log_line(&self.log, vec![Value::from("openPath"), Value::from(path)]);
        self.open_path_error.clone()
    }
}

/// a held call: the answer it already has, or the library call it waits for
enum Held {
    Done(Value),
    Github(Run, SkillImportSource),
    Update(Run, String),
}

/// `fill`: the token of the last preview or update where an argument says `$token`
fn fill(value: &Value, token: &str) -> Value {
    match value {
        Value::String(text) if text == "$token" => Value::from(token),
        Value::Array(items) => Value::Array(items.iter().map(|v| fill(v, token)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, v)| (key.clone(), fill(v, token)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// the card input as the renderer sends it: the template's bytes cross as `{ "$bytes": n }`
fn card_marker(raw: &Value) -> (Value, Option<Vec<u8>>) {
    let bytes = raw
        .get("template")
        .and_then(|template| template.get("bytes"))
        .and_then(hex_bytes);
    let Some(bytes) = bytes else {
        return (raw.clone(), None);
    };
    let mut marked = raw.clone();
    if let Some(template) = marked.get_mut("template").and_then(Value::as_object_mut) {
        template.insert("bytes".to_owned(), json!({"$bytes": bytes.len()}));
    }
    (marked, Some(bytes))
}

fn dropped_of(value: &Value) -> DroppedSkillEntry {
    let file = str_of(value.get("file")).unwrap_or("").to_owned();
    match str_of(value.get("kind")) {
        Some("zip") => DroppedSkillEntry::Zip { file },
        Some("skill-file") => DroppedSkillEntry::SkillFile { file },
        _ => DroppedSkillEntry::NoSkills,
    }
}

type Ipc = UserSkillsIpc<super::service::SvcHost, super::service::ScriptLib>;

/// the handler of a channel, run for a sender; `held` is a held call
fn channel(
    ipc: &mut Ipc,
    host: &mut IpcHost,
    ch: &str,
    sender: f64,
    a: &[Value],
    hold: bool,
    held: &mut Option<Held>,
) -> Option<Value> {
    let js: Vec<JsonValue> = a.iter().map(js_of).collect();
    let at = |i: usize| js.get(i);
    let out = |answer: JsonValue| Some(json_value_to_serde(&answer));
    let name = ch.strip_prefix("skills:").unwrap_or(ch);
    match name {
        "list" => out(ipc.list()),
        "read" => out(ipc.read(at(0))),
        "suggest-name" => out(ipc.suggest_name(at(0))),
        "check-name" => out(ipc.check_name(at(0), at(1))),
        "save-from-card" => {
            let (marked, bytes) = card_marker(a.first().unwrap_or(&Value::Null));
            let raw = js_of(&marked);
            let raw = if a.is_empty() { None } else { Some(&raw) };
            out(ipc.save_from_card(host, raw, bytes))
        }
        "ai-read" => out(ipc.ai_read(at(0))),
        "ai-read-file" => out(ipc.ai_read_file(at(0), at(1))),
        "open-settings" => {
            ipc.open_settings(host);
            Some(Value::Null)
        }
        "agent-notice" => Some(Value::Bool(ipc.agent_notice(host))),
        "agent-notice-seen" => {
            ipc.agent_notice_seen(host);
            Some(Value::Null)
        }
        "set-state" => out(ipc.set_state(host, sender, at(0), at(1))),
        "hide-builtin" => out(ipc.hide_builtin(host, sender, at(0))),
        "unhide-builtins" => out(ipc.unhide_builtins(host, sender, at(0))),
        "remove" => out(ipc.remove(host, sender, at(0))),
        "copy-to-mine" => out(ipc.copy_to_mine(host, sender, at(0), at(1))),
        "save" => out(ipc.save(host, sender, at(0))),
        "import-folder" => out(ipc.import_folder(host, sender)),
        "import-zip" => out(ipc.import_zip(host, sender)),
        "import-text" => out(ipc.import_text(host, sender, at(0))),
        "take-dropped" => out(ipc.take_dropped(host, sender)),
        "import-github" => match ipc.import_github_begin(host, sender, at(0)) {
            Err(answer) => {
                let answer = json_value_to_serde(&answer);
                if hold {
                    *held = Some(Held::Done(answer));
                    return Some(json!({"held": true}));
                }
                Some(answer)
            }
            Ok((run, source)) => {
                if hold {
                    *held = Some(Held::Github(run, source));
                    return Some(json!({"held": true}));
                }
                let prepared = ipc.service.prepare(&source, Some(&|| run.aborted()));
                out(ipc.import_github_finish(host, &run, prepared))
            }
        },
        "read-import" => out(ipc.read_import(host, sender, at(0), at(1))),
        "read-import-file" => out(ipc.read_import_file(host, sender, at(0), at(1), at(2))),
        "cancel-import" => out(ipc.cancel_import(host, sender, at(0))),
        "install" => out(ipc.install(host, sender, at(0))),
        "check-update" => match ipc.check_update_begin(host, sender, at(0)) {
            Err(answer) => {
                let answer = json_value_to_serde(&answer);
                if hold {
                    *held = Some(Held::Done(answer));
                    return Some(json!({"held": true}));
                }
                Some(answer)
            }
            Ok((run, id)) => {
                if hold {
                    *held = Some(Held::Update(run, id));
                    return Some(json!({"held": true}));
                }
                let answer = ipc.service.check_update(&id, Some(&|| run.aborted()));
                out(ipc.check_update_finish(host, &run, &id, answer))
            }
        },
        "apply-update" => out(ipc.apply_update(host, sender, at(0))),
        "cancel-update" => out(ipc.cancel_update(host, sender, at(0))),
        "export-info" => out(ipc.export_info(host, sender, at(0))),
        "export-zip" => out(ipc.export_zip(host, sender, at(0))),
        "export-bundle" => out(ipc.export_bundle(host, sender, at(0), at(1))),
        "open-folder" => out(ipc.open_folder(host, sender, at(0))),
        _ => None,
    }
}

/// the answer a released held call settles with
fn released(ipc: &mut Ipc, host: &mut IpcHost, held: Held) -> Value {
    match held {
        Held::Done(value) => value,
        Held::Github(run, source) => {
            let prepared = ipc.service.prepare(&source, Some(&|| run.aborted()));
            json_value_to_serde(&ipc.import_github_finish(host, &run, prepared))
        }
        Held::Update(run, id) => {
            let answer = ipc.service.check_update(&id, Some(&|| run.aborted()));
            json_value_to_serde(&ipc.check_update_finish(host, &run, &id, answer))
        }
    }
}

pub(super) fn run(args: &[Value], cx: &mut Context) -> Answer {
    let opts = arg(args, 0).cloned().unwrap_or(Value::Null);
    let root = str_of(opts.get("root")).unwrap_or("").to_owned();
    let log: Log = Log::default();
    let service: Service = service_of(&opts, &log, cx.now_ms);
    let mut ipc: Ipc = UserSkillsIpc::new(service);
    let mut host = IpcHost::of(&opts, &log);
    let mut out: Vec<Value> = Vec::new();
    let mut last_token = String::new();
    let mut held: Option<Held> = None;
    for step in list_of(arg(args, 1)) {
        if let Some(entry) = step.get("drop") {
            ipc.queue_dropped(&mut host, dropped_of(entry));
            out.push(Value::Null);
        } else if step.get("broadcast").is_some() {
            ipc.broadcast_changed(&mut host);
            out.push(Value::Null);
        } else if let Some(id) = step.get("destroy").and_then(Value::as_f64) {
            host.destroyed.push(id);
            if host.registered.contains(&id) {
                host.registered.retain(|known| *known != id);
                ipc.sender_destroyed(id);
            }
            out.push(Value::Null);
        } else if bool_of(step.get("release")) {
            let answer = match held.take() {
                Some(call) => {
                    let value = released(&mut ipc, &mut host, call);
                    unreal(clean_uuids(&value, &mut last_token), &root)
                }
                None => Value::Null,
            };
            out.push(answer);
        } else {
            let ch = str_of(step.get("ch")).unwrap_or("");
            let sender = step.get("s").and_then(Value::as_f64).unwrap_or(1.0);
            let a: Vec<Value> = list_of(step.get("a"))
                .iter()
                .map(|value| fill(value, &last_token))
                .collect();
            let hold = bool_of(step.get("hold"));
            let answer = channel(&mut ipc, &mut host, ch, sender, &a, hold, &mut held)
                .unwrap_or_else(|| json!({"threw": "no handler"}));
            out.push(if hold {
                answer
            } else {
                unreal(clean_uuids(&answer, &mut last_token), &root)
            });
        }
    }
    cx.logs.extend(log.borrow().iter().cloned());
    Ok(Some(Value::Array(out)))
}
