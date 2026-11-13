//! The functions of group `b6-utils` (tools/main-diff/groups/b6-utils.ts):
//! the modules of `packages/electron-utils` that call Electron (batch B6 of
//! decision 0030). What they call is a fake the spec describes; each call of
//! a fake is one `logs` line, and the TypeScript writes the same lines. A
//! scenario plays the part of the Electron adapter: it carries out what the
//! Rust decides (the menu to pop up, the command of a click) on the fakes.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsObject, JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::Value;

use super::fakes::{FakeDialog, FakeWindow, fake_parent};
use super::{Answer, CallError, Context, arg, str_arg};
use crate::packages::electron_utils::app_menu::{
    AboutAnswer, DevToolsHost, DevToolsToggle, MenuClick, MenuItem, ViewMenuOptions, about_answer,
    about_box, about_menu_item, app_menu_labels, app_menu_popup_template, app_menu_template,
    check_updates_menu_item, edit_menu_template, help_check_updates_items, help_menu_template,
    settings_menu_item, toggle_dev_tools_item, view_menu_template, window_menu_template,
};
use crate::packages::electron_utils::context_menu::{
    ContextMenuInterceptors, ContextMenuParams, EditFlags, MenuCommand, MenuEntry,
    VIEW_IMAGE_CHANNEL, after_interceptor, base_lang, build_context_menu_items,
    context_menu_labels, context_menu_template,
};
use crate::packages::electron_utils::dialog_memory::{Dialog, DialogMemory};
use crate::packages::electron_utils::message_box::MessageBox;
use crate::packages::electron_utils::remote_image::MemoryResponse;
use crate::packages::electron_utils::renderer_protocol::{
    RendererProtocolAnswer, renderer_protocol_answer, renderer_scheme_privileges,
};
use crate::packages::electron_utils::safe_remote_url::Response;
use crate::packages::electron_utils::save_conflict::{
    ProbeThrew, SaveConflictOptions, SaveDiskState, confirm_overwrite_if_conflicted,
    is_modified_since, is_path_open_elsewhere, record_disk_state, should_defer_auto_save,
};
use crate::packages::electron_utils::save_image::{
    SaveImageOptions, SaveImageResult, decode_data_url, is_savable_image_url, save_image_from_url,
    suggest_image_file_name,
};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- save-conflict ----
        "save-conflict.recordDiskState" => {
            str_arg(args, 0).map(|path| Some(to_value(&record_disk_state(path))))
        }
        "save-conflict.isModifiedSince" => (|| {
            let recorded = disk_state(arg(args, 0))?;
            let path = str_arg(args, 1)?;
            Ok(Some(Value::Bool(is_modified_since(
                recorded.as_ref(),
                path,
            ))))
        })(),
        "save-conflict.isPathOpenElsewhere" => (|| {
            let probe = Probe::of(arg(args, 0));
            let path = str_arg(args, 1)?;
            Ok(Some(Value::Bool(is_path_open_elsewhere(
                probe
                    .as_ref()
                    .map(|p| p as &dyn Fn(&str) -> Result<bool, ProbeThrew>),
                path,
            ))))
        })(),
        "save-conflict.confirmOverwriteIfConflicted" => confirm_call(args, cx),
        "save-conflict.shouldDeferAutoSave" => (|| {
            let probe = Probe::of(arg(args, 0));
            let path = str_arg(args, 1)?;
            let recorded = disk_state(arg(args, 2))?;
            Ok(Some(Value::Bool(should_defer_auto_save(
                probe
                    .as_ref()
                    .map(|p| p as &dyn Fn(&str) -> Result<bool, ProbeThrew>),
                path,
                recorded.as_ref(),
            ))))
        })(),

        // ---- save-image ----
        "save-image.isSavableImageUrl" => {
            str_arg(args, 0).map(|url| Some(Value::Bool(is_savable_image_url(url))))
        }
        "save-image.suggestImageFileName" => str_arg(args, 0).map(|url| {
            let mime = arg(args, 1).and_then(Value::as_str);
            Some(Value::from(suggest_image_file_name(url, mime)))
        }),
        "save-image.decodeDataUrl" => str_arg(args, 0).map(|url| {
            Some(decode_data_url(url).map_or(Value::Null, |decoded| {
                let mut out = serde_json::Map::new();
                out.insert("bytes".into(), Value::from(hex(&decoded.bytes)));
                out.insert("mime".into(), decoded.mime.map_or(Value::Null, Value::from));
                Value::Object(out)
            }))
        }),
        "save-image.saveImageFromUrl" => save_image_call(args, cx),

        // ---- context-menu ----
        "context-menu.VIEW_IMAGE_CHANNEL" => Ok(Some(Value::from(VIEW_IMAGE_CHANNEL))),
        "context-menu.baseLang" => str_arg(args, 0).map(|lang| Some(Value::from(base_lang(lang)))),
        "context-menu.contextMenuLabels" => {
            str_arg(args, 0).map(|lang| Some(to_value(&context_menu_labels(lang))))
        }
        "context-menu.buildContextMenuItems" => (|| {
            let params = menu_params(arg(args, 0).unwrap_or(&Value::Null));
            let labels = context_menu_labels(str_arg(args, 1)?);
            Ok(Some(to_value(&build_context_menu_items(&params, &labels))))
        })(),
        "context-menu.installContextMenu" => context_menu_call(args, cx),

        // ---- app-menu ----
        "app-menu.appMenuLabels" => {
            str_arg(args, 0).map(|lang| Some(to_value(&app_menu_labels(lang))))
        }
        "app-menu.windowMenuTemplate" => (|| {
            let labels = app_menu_labels(str_arg(args, 1)?);
            Ok(Some(to_value(&window_menu_template::<String>(
                str_arg(args, 0)?,
                &labels,
            ))))
        })(),
        "app-menu.editMenuTemplate" => (|| {
            let labels = app_menu_labels(str_arg(args, 1)?);
            Ok(Some(to_value(&edit_menu_template::<String>(
                str_arg(args, 0)?,
                &labels,
            ))))
        })(),
        "app-menu.toggleDevToolsItem" => str_arg(args, 0).map(|lang| {
            Some(to_value(&toggle_dev_tools_item::<String>(
                node_platform(),
                &app_menu_labels(lang),
            )))
        }),
        "app-menu.viewMenuTemplate" => (|| {
            let labels = app_menu_labels(str_arg(args, 0)?);
            let options = arg(args, 1).filter(|o| o.is_object());
            let flag = |key: &str| {
                options
                    .and_then(|o| o.get(key))
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
            };
            Ok(Some(to_value(&view_menu_template::<String>(
                node_platform(),
                &labels,
                ViewMenuOptions {
                    dev_items: flag("devItems"),
                    page_zoom: flag("pageZoom"),
                },
            ))))
        })(),
        "app-menu.helpCheckUpdatesItems" => (|| {
            let labels = app_menu_labels(str_arg(args, 0)?);
            Ok(Some(to_value(&help_check_updates_items::<String>(
                &labels,
                str_arg(args, 1)?,
            ))))
        })(),
        "app-menu.appMenuPopupTemplate" => (|| {
            let labels = app_menu_labels(str_arg(args, 1)?);
            Ok(Some(to_value(&app_menu_popup_template(
                app_items(arg(args, 0)),
                &labels,
            ))))
        })(),
        "app-menu.settingsMenuItem" => str_arg(args, 0).map(|lang| {
            let fallback = arg(args, 1).and_then(Value::as_str).map(str::to_owned);
            Some(to_value(&settings_menu_item(
                &app_menu_labels(lang),
                fallback,
            )))
        }),
        "app-menu.appMenuTemplate" => (|| {
            let labels = app_menu_labels(str_arg(args, 1)?);
            let options = arg(args, 2);
            let extra = app_items(options.and_then(|o| o.get("extra")));
            let app_label = options
                .and_then(|o| o.get("appLabel"))
                .and_then(Value::as_str);
            Ok(
                app_menu_template(str_arg(args, 0)?, &labels, extra, app_label)
                    .map(|menu| to_value(&menu)),
            )
        })(),
        "app-menu.helpMenuTemplate" => (|| {
            let labels = app_menu_labels(str_arg(args, 0)?);
            Ok(Some(to_value(&help_menu_template(
                &labels,
                app_items(arg(args, 1)),
                str_arg(args, 2)?,
            ))))
        })(),
        "app-menu.click" => app_menu_click_call(args, cx),

        // ---- renderer-protocol ----
        "renderer-protocol.registerRendererScheme" => {
            Ok(Some(to_value(&renderer_scheme_privileges())))
        }
        "renderer-protocol.installRendererProtocol" => renderer_protocol_call(args, cx),
        _ => return None,
    })
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a value prints")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

/// `SaveDiskState | undefined` from JSON; `null` stands for undefined
fn disk_state(value: Option<&Value>) -> Result<Option<SaveDiskState>, CallError> {
    let Some(Value::Object(o)) = value else {
        return Ok(None);
    };
    let num = |key: &str| {
        o.get(key)
            .and_then(Value::as_f64)
            .ok_or_else(|| CallError::plain(format!("recorded.{key} is not a number")))
    };
    Ok(Some(SaveDiskState {
        mtime_ms: num("mtimeMs")?,
        size: num("size")?,
        hash: o
            .get("hash")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    }))
}

/// The open-path probe of a spec: `null` (none), `{ open: [paths] }` (true
/// for those), `{ answer: v }` (answers `v` whatever the path) or
/// `{ throws: true }`.
struct Probe(Value);

impl Probe {
    fn of(spec: Option<&Value>) -> Option<impl Fn(&str) -> Result<bool, ProbeThrew>> {
        let spec = spec.filter(|v| v.is_object())?.clone();
        let probe = Probe(spec);
        Some(move |path: &str| probe.answer(path))
    }

    fn answer(&self, path: &str) -> Result<bool, ProbeThrew> {
        if self
            .0
            .get("throws")
            .is_some_and(|v| v == &Value::Bool(true))
        {
            return Err(ProbeThrew);
        }
        if let Some(open) = self.0.get("open").and_then(Value::as_array) {
            return Ok(open.iter().any(|p| p.as_str() == Some(path)));
        }
        Ok(self.0.get("answer") == Some(&Value::Bool(true)))
    }
}

/// `[{ probe, parent, path, recorded, lang, response }]`
fn confirm_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("options"))?;
    let probe = Probe::of(spec.get("probe"));
    let dialog = FakeDialog::of(spec);
    let parent = fake_parent(spec);
    let recorded = disk_state(spec.get("recorded"))?;
    let answer = confirm_overwrite_if_conflicted(&SaveConflictOptions {
        probe: probe
            .as_ref()
            .map(|p| p as &dyn Fn(&str) -> Result<bool, ProbeThrew>),
        dialog: &dialog,
        parent: parent.as_ref(),
        path: spec.get("path").and_then(Value::as_str).unwrap_or_default(),
        recorded: recorded.as_ref(),
        lang: spec.get("lang").and_then(Value::as_str).unwrap_or_default(),
    });
    cx.logs.extend(dialog.log.into_inner());
    Ok(Some(to_value(&answer)))
}

/// A save dialog that logs `["showSaveDialog", "<window>"?, options]` and
/// answers the spec's `pick`.
struct FileDialog {
    log: Rc<RefCell<Vec<Vec<Value>>>>,
    pick: Value,
}

impl Dialog for FileDialog {
    type Window = FakeWindow;

    fn show_open_dialog(
        &mut self,
        parent: Option<&FakeWindow>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        self.record("showOpenDialog", parent, options)
    }

    fn show_save_dialog(
        &mut self,
        parent: Option<&FakeWindow>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        self.record("showSaveDialog", parent, options)
    }
}

impl FileDialog {
    fn record(
        &self,
        name: &str,
        parent: Option<&FakeWindow>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let mut line = vec![Value::from(name)];
        if parent.is_some() {
            line.push(Value::from("<window>"));
        }
        line.push(json_value_to_serde(&JsonValue::Object(options.clone())));
        self.log.borrow_mut().push(line);
        json_value_from_serde(&self.pick)
    }
}

/// `[{ parent, url, title, fallbackDir?, fetch, pick }]`: `fetch` answers
/// `{ status, headers, body }` (hex) or rejects `{ reject: { name, message } }`;
/// each fetch logs `["fetch", url]`
fn save_image_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("options"))?;
    let log = Rc::new(RefCell::new(Vec::new()));
    let result = run_save_image(
        spec,
        &log,
        fake_parent(spec).as_ref(),
        spec.get("url").and_then(Value::as_str).unwrap_or_default(),
        spec.get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    cx.logs.extend(log.take());
    Ok(Some(to_value(&result)))
}

/// `saveImageFromUrl` over the fakes `fetch` and `pick` of `spec` describe
fn run_save_image(
    spec: &Value,
    log: &Log,
    parent: Option<&FakeWindow>,
    url: &str,
    title: &str,
) -> SaveImageResult {
    let mut dialog = FileDialog {
        log: Rc::clone(log),
        pick: spec.get("pick").cloned().unwrap_or(Value::Null),
    };
    let fetch_spec = spec.get("fetch").cloned().unwrap_or(Value::Null);
    let fetch_log = Rc::clone(log);
    let mut fetch = move |url: &str| -> Result<Box<dyn Response>, String> {
        fetch_log
            .borrow_mut()
            .push(vec![Value::from("fetch"), Value::from(url)]);
        if let Some(reject) = fetch_spec.get("reject") {
            let field = |key: &str| reject.get(key).and_then(Value::as_str).unwrap_or("");
            return Err(format!("{}: {}", field("name"), field("message")));
        }
        let status = fetch_spec
            .get("status")
            .and_then(Value::as_u64)
            .unwrap_or(200) as u16;
        let headers = fetch_spec
            .get("headers")
            .and_then(Value::as_object)
            .map(|h| {
                h.iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_owned()))
                    .collect()
            })
            .unwrap_or_default();
        let body = unhex(fetch_spec.get("body").and_then(Value::as_str).unwrap_or(""));
        Ok(Box::new(MemoryResponse::new(status, headers, body)))
    };
    let mut memory = DialogMemory::new();
    save_image_from_url(
        &mut memory,
        &mut dialog,
        &mut fetch,
        parent,
        url,
        &SaveImageOptions {
            title,
            fallback_dir: spec.get("fallbackDir").and_then(Value::as_str),
        },
    )
}

type Log = Rc<RefCell<Vec<Vec<Value>>>>;

fn log_line(log: &Log, line: Vec<Value>) {
    log.borrow_mut().push(line);
}

// ---- context-menu ----

/// `ContextMenuParams` from the spec's JSON (camelCase, as Electron names them)
fn menu_params(spec: &Value) -> ContextMenuParams {
    let text = |key: &str| {
        spec.get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let flag = |key: &str| {
        spec.get("editFlags")
            .and_then(|f| f.get(key))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    ContextMenuParams {
        is_editable: spec
            .get("isEditable")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        selection_text: text("selectionText"),
        misspelled_word: text("misspelledWord"),
        dictionary_suggestions: spec
            .get("dictionarySuggestions")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .map(|w| w.as_str().unwrap_or("").to_owned())
                    .collect()
            })
            .unwrap_or_default(),
        edit_flags: EditFlags {
            can_cut: flag("canCut"),
            can_copy: flag("canCopy"),
            can_paste: flag("canPaste"),
            can_select_all: flag("canSelectAll"),
        },
        media_type: spec
            .get("mediaType")
            .and_then(Value::as_str)
            .map(str::to_owned),
        src_url: spec
            .get("srcURL")
            .and_then(Value::as_str)
            .map(str::to_owned),
        x: spec.get("x").and_then(Value::as_f64).unwrap_or(0.0),
        y: spec.get("y").and_then(Value::as_f64).unwrap_or(0.0),
    }
}

/// the template as `JSON.stringify` writes it: the clicks are functions
fn template_json(template: &[MenuEntry]) -> Value {
    Value::Array(
        template
            .iter()
            .map(|entry| match entry {
                MenuEntry::Separator => serde_json::json!({ "type": "separator" }),
                MenuEntry::Item { label, enabled, .. } => {
                    let mut o = serde_json::Map::new();
                    o.insert("label".into(), Value::from(label.as_str()));
                    if let Some(enabled) = enabled {
                        o.insert("enabled".into(), Value::Bool(*enabled));
                    }
                    Value::Object(o)
                }
            })
            .collect(),
    )
}

/// `[{ lang, interceptors: { [id]: "own" | "native" | "throws" },
/// events: [{ contents, params, clicks }], image }]`: the app's
/// `web-contents-created` and each window's `context-menu`, as a scenario.
/// The fake app logs `["on", event]`, an interceptor `["intercept", id]`,
/// `Menu` `["buildFromTemplate", template]` and `["popup"]`, a window each
/// method it is called with; a "Save Image As" runs over the fakes of `image`
/// (as for `saveImageFromUrl`), after `["fromWebContents", id]`.
fn context_menu_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("options"))?;
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let labels = context_menu_labels(spec.get("lang").and_then(Value::as_str).unwrap_or(""));
    log_line(
        &log,
        vec![Value::from("on"), Value::from("web-contents-created")],
    );
    let mut interceptors = ContextMenuInterceptors::default();
    if let Some(table) = spec.get("interceptors").and_then(Value::as_object) {
        for (id, how) in table {
            let id: u64 = id.parse().map_err(|_| CallError::plain("interceptor id"))?;
            interceptors.set(id, how.as_str().map(str::to_owned));
        }
    }
    let image = spec.get("image").cloned().unwrap_or(Value::Null);
    for event in spec
        .get("events")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let id = event.get("contents").and_then(Value::as_u64).unwrap_or(0);
        let params = menu_params(event.get("params").unwrap_or(&Value::Null));
        let answer = interceptors.get(id).map(|how| {
            log_line(&log, vec![Value::from("intercept"), Value::from(id)]);
            match how.as_str() {
                "own" => Ok(true),
                "throws" => Err(()),
                _ => Ok(false),
            }
        });
        if !after_interceptor(answer) {
            continue;
        }
        let template = context_menu_template(&params, &labels);
        if template.is_empty() {
            continue;
        }
        log_line(
            &log,
            vec![Value::from("buildFromTemplate"), template_json(&template)],
        );
        log_line(&log, vec![Value::from("popup")]);
        for click in event
            .get("clicks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(MenuEntry::Item { click, .. }) =
                click.as_u64().and_then(|i| template.get(i as usize))
            else {
                continue;
            };
            match click {
                MenuCommand::ReplaceMisspelling(word) => log_line(
                    &log,
                    vec![
                        Value::from("replaceMisspelling"),
                        Value::from(word.as_str()),
                    ],
                ),
                MenuCommand::ViewImage(src) => log_line(
                    &log,
                    vec![
                        Value::from("send"),
                        Value::from(VIEW_IMAGE_CHANNEL),
                        src.as_deref().map_or(Value::Null, Value::from),
                    ],
                ),
                MenuCommand::CopyImageAt { x, y } => {
                    log_line(&log, vec![Value::from("copyImageAt"), num(*x), num(*y)])
                }
                MenuCommand::Edit(action) => log_line(&log, vec![Value::from(action.name())]),
                MenuCommand::SaveImageAs { src_url, title } => {
                    log_line(&log, vec![Value::from("fromWebContents"), Value::from(id)]);
                    let window = FakeWindow { destroyed: false };
                    run_save_image(
                        &image,
                        &log,
                        Some(&window),
                        src_url.as_deref().unwrap_or(""),
                        title,
                    );
                }
            }
        }
    }
    cx.logs.extend(log.take());
    Ok(None)
}

fn num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

// ---- renderer-protocol ----

/// `[roots, [url...]]`: the handler's answer for each request URL, logged as
/// `["fetch", fileUrl]` or `["404"]`
fn renderer_protocol_call(args: &[Value], cx: &mut Context) -> Answer {
    let roots: Vec<(String, String)> = arg(args, 0)
        .and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_owned()))
                .collect()
        })
        .unwrap_or_default();
    for url in arg(args, 1).and_then(Value::as_array).into_iter().flatten() {
        let url = url.as_str().unwrap_or("");
        cx.logs.push(match renderer_protocol_answer(&roots, url) {
            RendererProtocolAnswer::NotFound => vec![Value::from("404")],
            RendererProtocolAnswer::Fetch(file) => vec![Value::from("fetch"), Value::from(file)],
        });
    }
    Ok(None)
}

// ---- app-menu ----

/// `process.platform` of this machine, as Node names it
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// An app's own entries: `[{ label }]`, each clicked as `App(label)`
fn app_items(value: Option<&Value>) -> Vec<MenuItem<String>> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| {
            let label = item.get("label").and_then(Value::as_str).unwrap_or("");
            MenuItem::clickable(label, MenuClick::App(label.to_owned()))
        })
        .collect()
}

/// The `webContents` of a Developer Tools scenario: `id`, `devTools` (the id
/// of its DevTools window's contents, or null), `opened`, `destroyed`.
struct DevToolsFake<'a> {
    contents: Vec<Value>,
    focused: Option<u64>,
    log: &'a Log,
}

impl DevToolsFake<'_> {
    fn of(&self, id: u64) -> Option<&Value> {
        self.contents
            .iter()
            .find(|c| c.get("id").and_then(Value::as_u64) == Some(id))
    }

    fn set(&mut self, id: u64, key: &str, value: Value) {
        if let Some(Value::Object(c)) = self
            .contents
            .iter_mut()
            .find(|c| c.get("id").and_then(Value::as_u64) == Some(id))
        {
            c.insert(key.into(), value);
        }
    }

    fn flag(&self, id: u64, key: &str) -> bool {
        self.of(id)
            .and_then(|c| c.get(key))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }
}

impl DevToolsHost<u64> for DevToolsFake<'_> {
    fn focused(&self) -> Option<u64> {
        self.focused
    }

    fn is_destroyed(&self, contents: &u64) -> bool {
        self.flag(*contents, "destroyed")
    }

    fn dev_tools_web_contents(&self, contents: &u64) -> Option<u64> {
        self.of(*contents)
            .and_then(|c| c.get("devTools"))
            .and_then(Value::as_u64)
    }

    fn is_dev_tools_opened(&self, contents: &u64) -> bool {
        self.flag(*contents, "opened")
    }

    fn close_dev_tools(&mut self, contents: &u64) {
        log_line(
            self.log,
            vec![Value::from("closeDevTools"), Value::from(*contents)],
        );
        self.set(*contents, "opened", Value::Bool(false));
    }

    fn open_dev_tools_detached(&mut self, contents: &u64) {
        log_line(
            self.log,
            vec![
                Value::from("openDevTools"),
                Value::from(*contents),
                serde_json::json!({ "mode": "detach" }),
            ],
        );
        self.set(*contents, "opened", Value::Bool(true));
    }
}

/// Clicks on the menus' own entries, as a scenario `[{ lang, uiLang, version,
/// canCheck, settings, contents, steps }]`. A step is `{ click: "minimize" |
/// "close", window }`, `{ click: "devTools", focused }`, `{ destroy: id }`,
/// `{ click: "about", response }`, `{ click: "checkUpdates" }` or `{ click:
/// "settings", fallback }`. The fakes log what they are asked: the shell's
/// update check `["checkUpdates"]`, its Settings `["settings"]`, a fallback
/// `["fallback", name]`, a window its method, the clipboard `["writeText",
/// text]`, the About box as the dialog fake does.
fn app_menu_click_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("options"))?;
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let text = |key: &str| spec.get(key).and_then(Value::as_str).unwrap_or("");
    let labels = app_menu_labels(text("lang"));
    let can_check = spec
        .get("canCheck")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let has_settings = spec
        .get("settings")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let check_updates = |log: &Log| {
        if can_check {
            log_line(log, vec![Value::from("checkUpdates")]);
        }
    };
    let mut toggle = DevToolsToggle::default();
    let mut devtools = DevToolsFake {
        contents: spec
            .get("contents")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        focused: None,
        log: &log,
    };
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(id) = step.get("destroy").and_then(Value::as_u64) {
            devtools.set(id, "destroyed", Value::Bool(true));
            continue;
        }
        let window = step.get("window").and_then(Value::as_bool).unwrap_or(false);
        let item: MenuItem<String> = match step.get("click").and_then(Value::as_str) {
            Some("minimize") => window_menu_template::<String>("linux", &labels)
                .submenu
                .and_then(|items| items.into_iter().next())
                .ok_or_else(|| CallError::plain("no minimize"))?,
            Some("close") => window_menu_template::<String>("linux", &labels)
                .submenu
                .and_then(|items| items.into_iter().nth(2))
                .ok_or_else(|| CallError::plain("no close"))?,
            Some("devTools") => toggle_dev_tools_item(node_platform(), &labels),
            Some("about") => about_menu_item(&labels),
            Some("checkUpdates") => check_updates_menu_item(&labels),
            Some("settings") => settings_menu_item(
                &labels,
                step.get("fallback")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            ),
            _ => continue,
        };
        match item.click {
            Some(MenuClick::MinimizeWindow) if window => {
                log_line(&log, vec![Value::from("minimize")])
            }
            Some(MenuClick::CloseWindow) if window => log_line(&log, vec![Value::from("close")]),
            Some(MenuClick::MinimizeWindow | MenuClick::CloseWindow) => {}
            Some(MenuClick::ToggleDevTools) => {
                devtools.focused = step.get("focused").and_then(Value::as_u64);
                toggle.toggle(&mut devtools);
            }
            Some(MenuClick::CheckUpdates) => check_updates(&log),
            Some(MenuClick::About) => {
                let version = text("version");
                let dialog = FakeDialog::of(step);
                let options = about_box(&labels, version, text("uiLang"), can_check);
                let response = dialog.show_message_box(&options);
                log.borrow_mut().extend(dialog.log.into_inner());
                match about_answer(response, version) {
                    AboutAnswer::CopyText(text) => {
                        log_line(&log, vec![Value::from("writeText"), Value::from(text)]);
                    }
                    AboutAnswer::CheckUpdates => check_updates(&log),
                    AboutAnswer::Nothing => {}
                }
            }
            Some(MenuClick::Settings(fallback)) => {
                if has_settings {
                    log_line(&log, vec![Value::from("settings")]);
                } else if let Some(name) = fallback {
                    log_line(&log, vec![Value::from("fallback"), Value::from(name)]);
                }
            }
            Some(MenuClick::App(_)) | None => {}
        }
    }
    cx.logs.extend(log.take());
    Ok(None)
}
