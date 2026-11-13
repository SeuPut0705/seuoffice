//! The page context menu (`installContextMenu` of
//! packages/electron-utils/src/context-menu.ts). The vendored CEF runtime
//! hands every right-click on one of our views here instead of showing
//! Chrome's menu (crates/vendor/tauri-runtime-cef/VENDORED.md). On the core
//! thread the docs editor's interceptor gets the click first (its renderer
//! draws its own menu); otherwise the app's native menu pops up, built from
//! `context_menu_template` in the app's language.
//!
//! A page that is not ours (no bridge) keeps the runtime's filtered Chrome menu.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use jscompat::{JsObject, JsonValue};
use main_core::packages::electron_utils::context_menu::{
    ContextMenuParams, EditAction, EditFlags, MenuCommand, MenuEntry, context_menu_labels,
    context_menu_template,
};
use main_core::packages::electron_utils::dialog_memory::Dialog;
use main_core::packages::electron_utils::safe_remote_url::{FetchError, Response};
use main_core::packages::electron_utils::save_image::{
    SaveImageOptions, fetch_image_for_save, save_fetched_image,
};
use serde_json::{Value, json};
use shell_contract::hosts::{ClipboardHost, DialogsHost, FileDialog, FileFilter};
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::provided::Provided;
use shell_contract::runtime::{PathName, Services};
use shell_ipc_m::hosts::MHostRef;
use shell_ipc_m::intercept_context_menu;
use shell_ipc_m::state::MStateRef;
use shell_ipc_w::SharedDialogMemory;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, LogicalPosition, Manager};
use tauri_runtime_cef::WebviewCefExt;

use super::super::contents::cdp;
use super::super::w::post_core;
use super::super::window::Windows;
use crate::views::ViewTable;

/// Menu ids of this module start with this; the app menu's with `m-app-`
pub(crate) const ID_PREFIX: &str = "m-ctx-";

/// The entries of the menu that is up: one context menu at a time
static OPEN: Mutex<Option<OpenMenu>> = Mutex::new(None);

struct OpenMenu {
    view: ViewId,
    params: ContextMenuParams,
    commands: HashMap<String, MenuCommand>,
}

pub(crate) fn install(app: &AppHandle, views: Arc<ViewTable>, windows: Arc<Windows>) {
    let handle = app.clone();
    tauri_runtime_cef::set_context_menu_handler(move |label, raw, done| {
        let Some(sender) = views.sender_of_label(label) else {
            return false;
        };
        let params = params_of(&raw);
        let app = handle.clone();
        let label = label.to_owned();
        post_core(move |provided, services| {
            // Chrome's menu goes away first: our menu may run a modal loop
            done.cancel();
            pop_up(&app, provided, services, sender.view, &label, params);
        });
        true
    });
    let windows_for_clicks = windows;
    app.on_menu_event(move |_app, event| {
        let id = event.id().as_ref();
        if !id.starts_with(ID_PREFIX) {
            return;
        }
        let Some((view, params, command)) = take_command(id) else {
            return;
        };
        let windows = windows_for_clicks.clone();
        post_core(move |_, services| run(services, &windows, view, &params, command));
    });
}

/// The runtime's params as the menu template reads them
fn params_of(raw: &tauri_runtime_cef::ContextMenuParams) -> ContextMenuParams {
    ContextMenuParams {
        is_editable: raw.is_editable,
        selection_text: raw.selection_text.clone(),
        misspelled_word: raw.misspelled_word.clone(),
        dictionary_suggestions: raw.dictionary_suggestions.clone(),
        edit_flags: EditFlags {
            can_cut: raw.edit_flags.can_cut,
            can_copy: raw.edit_flags.can_copy,
            can_paste: raw.edit_flags.can_paste,
            can_select_all: raw.edit_flags.can_select_all,
        },
        media_type: raw.media_type.clone(),
        src_url: raw.src_url.clone(),
        x: f64::from(raw.x),
        y: f64::from(raw.y),
    }
}

/// The language the process holds (`currentLang()`)
fn lang_of(services: &Services) -> Option<String> {
    let state = services.hosts.get::<MStateRef>()?;
    let host = services.hosts.get::<MHostRef>()?;
    let settings = services
        .paths
        .path(PathName::UserData)
        .join("app-settings.json");
    Some(
        state
            .language(&**host, &settings.to_string_lossy())
            .lang
            .as_str()
            .to_owned(),
    )
}

/// The `context-menu` listener on the core thread: the interceptor, then
/// `popupMenu`
fn pop_up(
    app: &AppHandle,
    provided: &Provided,
    services: &Services,
    view: ViewId,
    label: &str,
    params: ContextMenuParams,
) {
    if intercept_context_menu(services, provided, view, &params) {
        return;
    }
    let lang = lang_of(services).unwrap_or_else(|| "en".to_owned());
    let template = context_menu_template(&params, &context_menu_labels(&lang));
    if template.is_empty() {
        return;
    }
    let mut commands = HashMap::new();
    let mut entries = Vec::new();
    for (i, entry) in template.into_iter().enumerate() {
        match entry {
            MenuEntry::Separator => entries.push(None),
            MenuEntry::Item {
                label,
                enabled,
                click,
            } => {
                let id = format!("{ID_PREFIX}{i}");
                commands.insert(id.clone(), click);
                entries.push(Some((id, label, enabled.unwrap_or(true))));
            }
        }
    }
    let (x, y) = (params.x, params.y);
    *OPEN.lock().unwrap() = Some(OpenMenu {
        view,
        params,
        commands,
    });
    let app = app.clone();
    let label = label.to_owned();
    let _ = app.clone().run_on_main_thread(move || {
        if let Err(error) = show(&app, &label, &entries, x, y) {
            eprintln!("shell: context menu: {error}");
        }
    });
}

type Entry = Option<(String, String, bool)>;

/// `Menu.buildFromTemplate(template).popup()` at the click, on the UI thread
fn show(app: &AppHandle, label: &str, entries: &[Entry], x: f64, y: f64) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    for entry in entries {
        match entry {
            None => menu.append(&PredefinedMenuItem::separator(app)?)?,
            Some((id, text, enabled)) => {
                menu.append(&MenuItem::with_id(app, id, text, *enabled, None::<&str>)?)?
            }
        }
    }
    let Some(webview) = app.get_webview(label) else {
        return Ok(());
    };
    // the click is in the view; a tab view sits below the shell window's strip
    let scale = webview.window().scale_factor()?;
    let origin = webview.position()?.to_logical::<f64>(scale);
    webview
        .window()
        .popup_menu_at(&menu, LogicalPosition::new(origin.x + x, origin.y + y))
}

fn take_command(id: &str) -> Option<(ViewId, ContextMenuParams, MenuCommand)> {
    let mut open = OPEN.lock().unwrap();
    let menu = open.as_mut()?;
    let command = menu.commands.remove(id)?;
    Some((menu.view, menu.params.clone(), command))
}

/// A clicked entry: what is IPC goes through batch M, the rest is the view's
/// own `webContents` call
fn run(
    services: &Services,
    windows: &Arc<Windows>,
    view: ViewId,
    params: &ContextMenuParams,
    command: MenuCommand,
) {
    let Some(rest) = shell_ipc_m::context_menu_command(services, view, command) else {
        return;
    };
    let Some(webview) = windows.webview(view) else {
        return;
    };
    match rest {
        MenuCommand::Edit(action) => {
            let _ = webview.with_cef_webview(move |cef_view| edit(cef_view, action));
        }
        MenuCommand::CopyImageAt { x, y } => {
            let clipboard = services.hosts.get::<ClipboardHost>().cloned();
            services.workers.spawn(Box::new(move || {
                match (image_png_at(&webview, x, y), clipboard) {
                    (Ok(png), Some(clipboard)) => clipboard.write_image_png(&png),
                    (Err(error), _) => eprintln!("shell: copy image: {error}"),
                    _ => {}
                }
            }));
        }
        MenuCommand::SaveImageAs { src_url, title } => {
            let Some(dialogs) = services.hosts.get::<DialogsHost>().cloned() else {
                return;
            };
            // the last folder every save dialog of the process shares
            let Some(memory) = services.hosts.get::<SharedDialogMemory>().cloned() else {
                return;
            };
            let parent = services.views.sender_of(view).map(|s| s.window);
            let url = src_url
                .or_else(|| params.src_url.clone())
                .unwrap_or_default();
            services.workers.spawn(Box::new(move || {
                // the fetch takes no lock: other dialogs stay free while it runs
                let mut fetch = |url: &str| page_fetch(&webview, url);
                let image = match fetch_image_for_save(&url, &mut fetch) {
                    Ok(image) => image,
                    Err(error) => return eprintln!("shell: save image: {error}"),
                };
                let mut dialog = SaveDialog(dialogs);
                let mut memory = memory
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let result = save_fetched_image(
                    &mut memory,
                    &mut dialog,
                    parent.as_ref(),
                    &url,
                    image,
                    &SaveImageOptions {
                        title: &title,
                        fallback_dir: None,
                    },
                );
                if let Some(error) = result.error {
                    eprintln!("shell: save image: {error}");
                }
            }));
        }
        // ReplaceMisspelling and ViewImage are batch M's
        MenuCommand::ReplaceMisspelling(_) | MenuCommand::ViewImage(_) => {}
    }
}

/// `contents.cut()` and its siblings: the main frame's editing commands
fn edit(cef_view: &tauri_runtime_cef::Webview, action: EditAction) {
    use cef::{ImplBrowser, ImplFrame};
    let Some(frame) = cef_view.browser().main_frame() else {
        return;
    };
    match action {
        EditAction::Cut => frame.cut(),
        EditAction::Copy => frame.copy(),
        EditAction::Paste => frame.paste(),
        EditAction::SelectAll => frame.select_all(),
    }
}

/// `contents.copyImageAt(x, y)`: the image under the click, drawn into a
/// canvas by the page and read back as PNG (CEF has no copy-image command)
fn image_png_at(webview: &tauri::Webview, x: f64, y: f64) -> Result<Vec<u8>, String> {
    let script = format!(
        "(async () => {{
            const el = document.elementFromPoint({x}, {y});
            const img = el && el.closest('img');
            if (!img) throw new Error('no image at the click');
            await img.decode().catch(() => {{}});
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
        }})()"
    );
    let answer = cdp(
        webview,
        "Runtime.evaluate",
        json!({ "expression": script, "awaitPromise": true, "returnByValue": true }),
    )?;
    if let Some(details) = answer.get("exceptionDetails") {
        return Err(details["exception"]["description"]
            .as_str()
            .unwrap_or("the page could not draw the image")
            .to_owned());
    }
    let base64 = answer["result"]["value"].as_str().ok_or("no image data")?;
    Ok(jscompat::buffer_from_base64(base64))
}

/// `net.fetch(url)` from the view itself, so the app schemes keep their own
/// access rules as Electron's protocol handlers did
fn page_fetch(webview: &tauri::Webview, url: &str) -> Result<Box<dyn Response>, String> {
    let script = format!(
        "(async () => {{
            const res = await fetch({url});
            const bytes = new Uint8Array(await res.arrayBuffer());
            let text = '';
            for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return {{ status: res.status, type: res.headers.get('content-type'), body: btoa(text) }};
        }})()",
        url = Value::String(url.to_owned())
    );
    let answer = cdp(
        webview,
        "Runtime.evaluate",
        json!({ "expression": script, "awaitPromise": true, "returnByValue": true }),
    )?;
    if let Some(details) = answer.get("exceptionDetails") {
        return Err(details["exception"]["description"]
            .as_str()
            .unwrap_or("TypeError: fetch failed")
            .to_owned());
    }
    let value = &answer["result"]["value"];
    Ok(Box::new(Fetched {
        status: value["status"].as_u64().unwrap_or(0) as u16,
        content_type: value["type"].as_str().map(str::to_owned),
        body: Some(jscompat::buffer_from_base64(
            value["body"].as_str().unwrap_or(""),
        )),
    }))
}

/// A response whose body the page already read whole
struct Fetched {
    status: u16,
    content_type: Option<String>,
    body: Option<Vec<u8>>,
}

impl Response for Fetched {
    fn status(&self) -> u16 {
        self.status
    }

    fn header(&self, name: &str) -> Option<String> {
        name.eq_ignore_ascii_case("content-type")
            .then(|| self.content_type.clone())
            .flatten()
    }

    fn has_body(&self) -> bool {
        self.body.is_some()
    }

    fn cancel_body(&mut self) {
        self.body = None;
    }

    fn read_chunk(&mut self) -> Result<Option<Vec<u8>>, FetchError> {
        Ok(self.body.take())
    }

    fn array_buffer(&mut self) -> Result<Vec<u8>, FetchError> {
        Ok(self.body.take().unwrap_or_default())
    }
}

/// `dialog.showSaveDialog` as `showSaveDialogWithMemory` calls it
struct SaveDialog(DialogsHost);

impl Dialog for SaveDialog {
    type Window = WindowId;

    fn show_open_dialog(
        &mut self,
        _parent: Option<&WindowId>,
        _options: &JsObject<JsonValue>,
    ) -> JsonValue {
        JsonValue::Null
    }

    fn show_save_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let text = |key: &str| match options.get(key) {
            Some(JsonValue::String(s)) => Some(s.clone()),
            _ => None,
        };
        let filters = match options.get("filters") {
            Some(JsonValue::Array(list)) => list
                .iter()
                .filter_map(|f| match f {
                    JsonValue::Object(f) => Some(FileFilter {
                        name: match f.get("name") {
                            Some(JsonValue::String(s)) => s.clone(),
                            _ => String::new(),
                        },
                        extensions: match f.get("extensions") {
                            Some(JsonValue::Array(e)) => e
                                .iter()
                                .filter_map(|e| match e {
                                    JsonValue::String(s) => Some(s.clone()),
                                    _ => None,
                                })
                                .collect(),
                            _ => Vec::new(),
                        },
                    }),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        let picked = self.0.save(
            parent.copied(),
            &FileDialog {
                title: text("title"),
                default_path: text("defaultPath").map(Into::into),
                filters,
                ..FileDialog::default()
            },
        );
        let mut answer = JsObject::new();
        answer.set("canceled", JsonValue::Bool(picked.is_none()));
        answer.set(
            "filePath",
            JsonValue::String(
                picked
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            ),
        );
        JsonValue::Object(answer)
    }
}
