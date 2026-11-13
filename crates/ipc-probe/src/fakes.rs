//! Fakes of the shared hosts (`shell_contract::hosts`), the Rust half of
//! `tools/ipc-diff/fakes.ts`. Each call is one line of the case's log, named
//! after the Electron call it stands for, with the arguments as Electron got
//! them; answers come from the case's `hosts.shared` (tools/ipc-diff/README.md).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use main_core::packages::electron_utils::recovery_store::SharedRecoveryState;
use serde_json::{Map, Value, json};
use shell_contract::hosts::{
    Clipboard, Contents, Dialogs, FileDialog, MainWindow, MessageBox, MessageBoxAnswer, OsShell,
};
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::ipc::Sender;
use shell_contract::value::IpcValue;
use shell_contract::{
    ClipboardHost, ContentsHost, DialogsHost, Hosts, MainWindowHost, OsShellHost, Surface,
};

use crate::{ProbeLog, hex, unhex};

fn push(log: &ProbeLog, line: Value) {
    log.lock().unwrap().push(line);
}

fn path_text(path: &Path) -> Value {
    Value::String(path.to_string_lossy().into_owned())
}

fn parent(window: Option<WindowId>) -> Value {
    window.map_or(Value::Null, |w| Value::from(w.0))
}

/// The options object as the TypeScript passed it, keys in Electron's
/// order, absent and empty fields left out (fakes.ts writes it the same way)
fn file_dialog(options: &FileDialog) -> Value {
    let mut map = Map::new();
    if let Some(title) = &options.title {
        map.insert("title".into(), json!(title));
    }
    if let Some(path) = &options.default_path {
        map.insert("defaultPath".into(), path_text(path));
    }
    if let Some(label) = &options.button_label {
        map.insert("buttonLabel".into(), json!(label));
    }
    if !options.filters.is_empty() {
        let filters: Vec<Value> = options
            .filters
            .iter()
            .map(|f| json!({ "name": f.name, "extensions": f.extensions }))
            .collect();
        map.insert("filters".into(), Value::Array(filters));
    }
    if !options.properties.is_empty() {
        map.insert("properties".into(), json!(options.properties));
    }
    Value::Object(map)
}

fn message_box(options: &MessageBox) -> Value {
    let mut map = Map::new();
    if let Some(kind) = &options.kind {
        map.insert("type".into(), json!(kind));
    }
    if let Some(title) = &options.title {
        map.insert("title".into(), json!(title));
    }
    map.insert("message".into(), json!(options.message));
    if let Some(detail) = &options.detail {
        map.insert("detail".into(), json!(detail));
    }
    if !options.buttons.is_empty() {
        map.insert("buttons".into(), json!(options.buttons));
    }
    if let Some(id) = options.default_id {
        map.insert("defaultId".into(), json!(id));
    }
    if let Some(id) = options.cancel_id {
        map.insert("cancelId".into(), json!(id));
    }
    if let Some(label) = &options.checkbox_label {
        map.insert("checkboxLabel".into(), json!(label));
    }
    Value::Object(map)
}

fn queue(case: &Value, key: &str) -> Mutex<VecDeque<Value>> {
    Mutex::new(
        case[key]
            .as_array()
            .map(|a| a.iter().cloned().collect())
            .unwrap_or_default(),
    )
}

/// `dialogs.open`, `dialogs.save`, `dialogs.message`: answers taken one per
/// dialog; once a queue is empty the dialog is cancelled (message: button 0)
struct FakeDialogs {
    log: ProbeLog,
    open: Mutex<VecDeque<Value>>,
    save: Mutex<VecDeque<Value>>,
    message: Mutex<VecDeque<Value>>,
}

impl Dialogs for FakeDialogs {
    fn open(&self, window: Option<WindowId>, options: &FileDialog) -> Option<Vec<PathBuf>> {
        push(
            &self.log,
            json!([
                "dialog.showOpenDialog",
                parent(window),
                file_dialog(options)
            ]),
        );
        let answer = self.open.lock().unwrap().pop_front()?;
        let paths = answer.as_array()?;
        Some(
            paths
                .iter()
                .filter_map(Value::as_str)
                .map(PathBuf::from)
                .collect(),
        )
    }

    fn save(&self, window: Option<WindowId>, options: &FileDialog) -> Option<PathBuf> {
        push(
            &self.log,
            json!([
                "dialog.showSaveDialog",
                parent(window),
                file_dialog(options)
            ]),
        );
        let answer = self.save.lock().unwrap().pop_front()?;
        answer.as_str().map(PathBuf::from)
    }

    fn message(&self, window: Option<WindowId>, options: &MessageBox) -> MessageBoxAnswer {
        push(
            &self.log,
            json!([
                "dialog.showMessageBox",
                parent(window),
                message_box(options)
            ]),
        );
        let answer = self.message.lock().unwrap().pop_front();
        let answer = answer.unwrap_or(Value::Null);
        MessageBoxAnswer {
            response: answer["response"].as_u64().unwrap_or(0) as usize,
            checkbox_checked: answer["checkboxChecked"].as_bool().unwrap_or(false),
        }
    }

    fn error(&self, title: &str, content: &str) {
        push(&self.log, json!(["dialog.showErrorBox", title, content]));
    }
}

/// `osShell.openPath` (the answer of every `openPath`, default `""`),
/// `osShell.openExternalError`, `osShell.trashError`
struct FakeOsShell {
    log: ProbeLog,
    case: Value,
}

impl OsShell for FakeOsShell {
    fn open_external(&self, url: &str) -> Result<(), String> {
        push(&self.log, json!(["shell.openExternal", url]));
        match self.case["openExternalError"].as_str() {
            Some(e) => Err(e.into()),
            None => Ok(()),
        }
    }

    fn open_path(&self, path: &Path) -> String {
        push(&self.log, json!(["shell.openPath", path_text(path)]));
        self.case["openPath"].as_str().unwrap_or("").into()
    }

    fn show_item_in_folder(&self, path: &Path) {
        push(
            &self.log,
            json!(["shell.showItemInFolder", path_text(path)]),
        );
    }

    fn trash_item(&self, path: &Path) -> Result<(), String> {
        push(&self.log, json!(["shell.trashItem", path_text(path)]));
        match self.case["trashError"].as_str() {
            Some(e) => Err(e.into()),
            None => Ok(()),
        }
    }
}

/// `clipboard.{text, html, imagePng (hex), formats}`: the clipboard before
/// the case; writes change it
struct FakeClipboard {
    log: ProbeLog,
    state: Mutex<(String, String, Vec<u8>, Vec<String>)>,
}

impl Clipboard for FakeClipboard {
    fn read_text(&self) -> String {
        push(&self.log, json!(["clipboard.readText"]));
        self.state.lock().unwrap().0.clone()
    }

    fn write_text(&self, text: &str) {
        push(&self.log, json!(["clipboard.writeText", text]));
        self.state.lock().unwrap().0 = text.into();
    }

    fn read_html(&self) -> String {
        push(&self.log, json!(["clipboard.readHTML"]));
        self.state.lock().unwrap().1.clone()
    }

    fn write_html(&self, html: &str, text: Option<&str>) {
        push(
            &self.log,
            json!(["clipboard.write", { "html": html, "text": text }]),
        );
        let mut state = self.state.lock().unwrap();
        state.1 = html.into();
        if let Some(text) = text {
            state.0 = text.into();
        }
    }

    fn read_image_png(&self) -> Vec<u8> {
        push(&self.log, json!(["clipboard.readImage"]));
        self.state.lock().unwrap().2.clone()
    }

    fn write_image_png(&self, png: &[u8]) {
        push(&self.log, json!(["clipboard.writeImage", hex(png)]));
        self.state.lock().unwrap().2 = png.to_vec();
    }

    fn available_formats(&self) -> Vec<String> {
        push(&self.log, json!(["clipboard.availableFormats"]));
        self.state.lock().unwrap().3.clone()
    }
}

/// `contents.{capturePng, pdf (hex), print (bool), zoom: {view: factor}}`
struct FakeContents {
    log: ProbeLog,
    views: Vec<Sender>,
    case: Value,
    zoom: Mutex<HashMap<ViewId, f64>>,
}

impl Contents for FakeContents {
    fn window_of(&self, view: ViewId) -> Option<WindowId> {
        self.views.iter().find(|s| s.view == view).map(|s| s.window)
    }

    fn capture_png(&self, view: ViewId) -> Result<Vec<u8>, String> {
        push(&self.log, json!(["webContents.capturePage", view.0]));
        Ok(unhex(self.case["capturePng"].as_str().unwrap_or("")))
    }

    fn print_to_pdf(&self, view: ViewId, options: IpcValue) -> Result<Vec<u8>, String> {
        let (header, _) = shell_core::wire::encode(&options);
        push(&self.log, json!(["webContents.printToPDF", view.0, header]));
        match self.case["pdf"].as_str() {
            Some(pdf) => Ok(unhex(pdf)),
            None => Err("printToPDF failed".into()),
        }
    }

    fn print(&self, view: ViewId, options: IpcValue) -> Result<bool, String> {
        let (header, _) = shell_core::wire::encode(&options);
        push(&self.log, json!(["webContents.print", view.0, header]));
        Ok(self.case["print"].as_bool().unwrap_or(true))
    }

    fn zoom_factor(&self, view: ViewId) -> f64 {
        if let Some(z) = self.zoom.lock().unwrap().get(&view) {
            return *z;
        }
        self.case["zoom"][view.0.to_string()]
            .as_f64()
            .unwrap_or(1.0)
    }

    fn set_zoom_factor(&self, view: ViewId, factor: f64) {
        push(
            &self.log,
            json!(["webContents.setZoomFactor", view.0, factor]),
        );
        self.zoom.lock().unwrap().insert(view, factor);
    }

    fn focus(&self, view: ViewId) {
        push(&self.log, json!(["webContents.focus", view.0]));
    }

    fn close_window(&self, window: WindowId) {
        push(&self.log, json!(["BrowserWindow.close", window.0]));
    }
}

/// `mainWindow: {view, window}`, or the first view on the shell surface
struct FakeMainWindow(Option<Sender>);

impl MainWindow for FakeMainWindow {
    fn view(&self) -> Option<ViewId> {
        self.0.map(|s| s.view)
    }

    fn window(&self) -> Option<WindowId> {
        self.0.map(|s| s.window)
    }
}

/// Inserts the five shared hosts, answering from `case` (`hosts.shared`)
pub fn insert_shared(hosts: &mut Hosts, case: &Value, views: &[Sender], log: &ProbeLog) {
    let dialogs = &case["dialogs"];
    let dialogs: DialogsHost = Arc::new(FakeDialogs {
        log: log.clone(),
        open: queue(dialogs, "open"),
        save: queue(dialogs, "save"),
        message: queue(dialogs, "message"),
    });
    hosts.insert(dialogs);
    let os: OsShellHost = Arc::new(FakeOsShell {
        log: log.clone(),
        case: case["osShell"].clone(),
    });
    hosts.insert(os);
    let c = &case["clipboard"];
    let text = |key: &str| c[key].as_str().unwrap_or("").to_string();
    let formats = c["formats"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    let clipboard: ClipboardHost = Arc::new(FakeClipboard {
        log: log.clone(),
        state: Mutex::new((
            text("text"),
            text("html"),
            unhex(&text("imagePng")),
            formats,
        )),
    });
    hosts.insert(clipboard);
    let contents: ContentsHost = Arc::new(FakeContents {
        log: log.clone(),
        views: views.to_vec(),
        case: case["contents"].clone(),
        zoom: Mutex::default(),
    });
    hosts.insert(contents);
    let main = &case["mainWindow"];
    let main = match (main["view"].as_u64(), main["window"].as_u64()) {
        (Some(view), Some(window)) => views
            .iter()
            .find(|s| s.view.0 as u64 == view && s.window.0 as u64 == window)
            .copied(),
        _ => views.iter().find(|s| s.surface == Surface::Shell).copied(),
    };
    let main: MainWindowHost = Arc::new(FakeMainWindow(main));
    hosts.insert(main);
    // the one recovery state of the process (U, D1, D2 share it); the run id
    // the TypeScript drew at random is the case's, so both sides name files alike
    let run_id = case["recoveryRunId"].as_str().unwrap_or("0000000000000000");
    let recovery = Arc::new(Mutex::new(SharedRecoveryState::new(run_id)));
    hosts.insert(recovery);
}
