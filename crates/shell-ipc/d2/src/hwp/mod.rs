//! The Hangul editor (`apps/hwp/src/main/hwp-main.ts`, `recovery.ts`,
//! `attachments-ipc.ts`, `ai-image.ts`).
//!
//! [`editor`] is hwp-main.ts: the views' state, the open, save and close
//! channels, and the functions other areas call ([`editor::HwpEditors`]).
//! [`recovery`] registers the recovery channels over `main-core`'s port of
//! recovery.ts (`main_core::hwp::recovery`). [`attachments`] and
//! [`ai_image`] are the AI panel's files and pictures.
//!
//! What the handlers reach that is not in Rust is behind two traits here:
//! [`HwpEngine`], the libraries (the rhwp engine, file-parse, ai-search, the
//! network), and [`HwpShell`], what the shell does for this editor (its
//! windows, its tabs, its keyboard and the runtime callbacks hwp-main.ts was
//! configured with).

mod ai_image;
mod attachments;
mod editor;
mod memos;
#[cfg(feature = "probe")]
mod probe;
mod recovery;

use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;

use main_core::packages::electron_utils::unsaved_files::{OpenFileState, OpenFilesSourceFailed};
use shell_contract::hosts::{FileDialog, FileFilter};
use shell_contract::ipc::RegisterError;
use shell_contract::runtime::{CancelToken, Services};
use shell_contract::{Provided, ViewId, WindowId};

use ai_image::FetchedImage;
use attachments::ParsedFile;

use crate::kit::Entry;

pub use editor::{HEADLESS_TIMEOUT_MS, HwpEditors, UntitledOption};
// lib.rs routes the probe's `d2/hwp:` triggers here
#[cfg(feature = "probe")]
#[allow(unused_imports)]
pub(crate) use probe::probe_trigger;

/// What an HWP file says of tracked changes (`TrackedChanges` of
/// tracked-changes.ts)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
// the shell's engine host makes them; this crate only reads them
#[cfg_attr(not(any(test, feature = "probe")), allow(dead_code))]
pub enum TrackedChanges {
    None,
    Tracked,
    Unreadable,
}

/// A memo as the engine lists it (`HwpMemo` of file-parse): what makes it the
/// same memo across a save
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HwpMemo {
    pub author: Option<String>,
    pub date: Option<String>,
    pub text: Option<String>,
    pub place: Option<String>,
}

/// The libraries the Hangul handlers call that are not in Rust. Every method
/// is the library call alone, on owned data, so it may run on a worker.
pub trait HwpEngine: Send + Sync {
    /// `trackedChangesOf(file)` (apps/hwp/src/main/tracked-changes.ts; needs
    /// the SheetJS container writer)
    fn tracked_changes_of(&self, file: &[u8]) -> TrackedChanges;
    /// `withoutTrackedChanges(file)` (tracked-changes.ts)
    fn without_tracked_changes(&self, file: &[u8]) -> Option<Vec<u8>>;
    /// `hwpMemosOf(bytes)` (packages/file-parse/src/hwp.ts, the rhwp engine);
    /// `Err` is what it threw
    fn hwp_memos_of(&self, file: &[u8]) -> Result<Vec<HwpMemo>, String>;
    /// `hwpToText(bytes)` (packages/file-parse/src/hwp.ts, the rhwp engine);
    /// `Err` is the message of what it threw
    fn hwp_to_text(&self, file: &[u8]) -> Result<String, String>;

    /// The source `setOpenFilesSource` registered (`seuoffice.open-files-source`):
    /// `None` when no source is registered (nothing is blocked), `Some(Err)`
    /// when the source threw or rejected (every file counts as unsaved)
    fn open_files(&self) -> Option<Result<Vec<OpenFileState>, OpenFilesSourceFailed>>;
    /// `extractDiagramXml(fileName, bytes, nodePageCodec)` of
    /// `@seuoffice/drawio-model`: whether it fails with reason `no_original`
    /// (a `.drawio.svg` / `.drawio.png` that does not hold its diagram)
    fn diagram_picture_has_no_original(&self, file_name: String, bytes: Vec<u8>) -> bool;
    /// `parseFileToText(filePath)` of `@seuoffice/file-parse`
    fn parse_file_to_text(&self, path: String) -> ParsedFile;
    /// `checkedHwpBytes(bytes, ext)` of `@seuoffice/file-parse` (magic bytes,
    /// compound-file and zip gates): the bytes, or the message it throws
    fn checked_hwp_bytes(&self, bytes: Vec<u8>, ext: String) -> Result<Vec<u8>, String>;
    /// `fetchImageBytes(url)` of `@seuoffice/electron-utils/fetch-image-bytes`:
    /// the picture at a web address, or the file the image generator wrote
    /// into its own store (the only `file:` it answers), checked at every hop;
    /// `None` for anything it refuses or cannot read
    fn fetch_image_bytes(&self, url: String) -> Option<FetchedImage>;
    /// `withMediaCallSignal(sender, (signal) => analyzeMediaTool(settingsPath,
    /// { mediaUrls, requirements }, { context: { path: 'screen', statuses:
    /// sharedSubscriptionStatuses() }, signal }))` of `@seuoffice/ai-search`.
    /// `view` is the sender the call's signal belongs to (the engine also ends
    /// it when the view's AI run is stopped); `cancel` fires when the view is
    /// destroyed or navigates. The tool's result as JSON, or the message it
    /// rejects with.
    fn analyze_media(
        &self,
        view: ViewId,
        settings_path: PathBuf,
        media_urls: Vec<String>,
        requirements: String,
        cancel: CancelToken,
    ) -> Result<serde_json::Value, String>;
}

pub type HwpEngineHost = Arc<dyn HwpEngine>;

/// A key as Electron's `before-input-event` gives it
#[derive(Clone, Debug, Default, PartialEq)]
pub struct KeyInput {
    /// `'keyDown'`, `'keyUp'`, ...
    pub kind: String,
    pub key: String,
    pub code: String,
    pub is_auto_repeat: bool,
    pub shift: bool,
    pub control: bool,
    pub alt: bool,
    pub meta: bool,
}

/// What the shell does for the Hangul editor: the runtime callbacks
/// `configureHwpRuntime` was given, its windows and keyboard, and the
/// process-wide answers hwp-main.ts read from Electron.
pub trait HwpShell: Send + Sync {
    /// `getUiLang()`
    fn ui_lang(&self) -> String;
    /// `isHeadlessMode()`: the `--headless-export` run
    fn is_headless_mode(&self) -> bool;
    /// `BrowserWindow.getFocusedWindow()`
    fn focused_window(&self) -> Option<WindowId>;
    /// `crypto.randomUUID()`
    fn random_uuid(&self) -> String;
    /// `Date.now()`
    fn now_ms(&self) -> f64;
    /// the shell's probe behind `isPathOpenElsewhere(path)`: another pane
    /// holds this file (false without a probe, or when it throws)
    fn is_path_open_elsewhere(&self, path: &str) -> bool;
    /// `runtime.importPdf?.()`: File > Import PDF
    fn import_pdf(&self);
    /// `runtime.newDocumentDir?.(wcId)`: the project folder a new document
    /// of this view is offered in, `None` for the default save folder
    fn new_document_dir(&self, view: ViewId) -> Option<String>;
    /// `fileSavedHook?.(wc, path)`: a save landed on a new path
    fn file_saved(&self, view: ViewId, path: &str);
    /// `runtime.openFileDialog?.()`; false when the shell gave none
    fn open_file_dialog(&self) -> bool;
    /// `runtime.goHome?.()`; false when the shell gave none
    fn go_home(&self) -> bool;
    /// `runtime.newDocument?.()`; false when the shell gave none
    fn new_document(&self) -> bool;
    /// `contents.reload()`
    fn reload(&self, view: ViewId);
    /// `editorTakes(wc, key)`: runs the key in the editor frame
    /// (`window.__ieumHancomKey`) and answers whether it took it. Waits for
    /// the renderer: called on a worker.
    fn editor_takes(&self, view: ViewId, key: &str) -> bool;
    /// `wc.copy()`
    fn copy(&self, view: ViewId);
    /// `wc.cut()`
    fn cut(&self, view: ViewId);
    /// `wc.sendInputEvent` of a keyDown and its keyUp
    fn send_key(&self, view: ViewId, key_code: &str, modifiers: &[&str]);
    /// `exportHwpPdfHeadless`'s hidden window (1280x900, no throttling) with
    /// the Hangul preload, not loaded yet
    fn create_headless_view(&self) -> Result<ViewId, String>;
    /// its `loadURL` of the Hangul renderer
    fn load_headless_view(&self, view: ViewId);
    /// `win.destroy()` unless it is destroyed already
    fn destroy_headless_view(&self, view: ViewId);
}

pub type HwpShellHost = Arc<dyn HwpShell>;

pub(crate) fn entries(
    services: &Services,
    provided: &Rc<Provided>,
) -> Result<Vec<Entry>, RegisterError> {
    let hwp = editor::Hwp::new(services)?;
    let editors = Rc::new(HwpEditors(Rc::clone(&hwp)));
    provided.add::<dyn shell_contract::DocumentEditors>(editors.clone());
    provided.add::<dyn main_core::packages::electron_utils::recovery_contract::RecoveryEditorContract<ViewId>>(
        editors.clone(),
    );
    // what the shell calls that the contract's traits do not carry
    // (`createHwpView`, `exportHwpPdfHeadless`, the view's own events)
    provided.add::<HwpEditors>(editors);
    let mut all = editor::entries(&hwp);
    all.extend(recovery::entries(&hwp));
    all.extend(attachments::entries_with(
        services,
        Rc::clone(&hwp.dialog_memory),
    )?);
    all.extend(ai_image::entries(services)?);
    Ok(all)
}

/// The open and save dialogs of `main-core`'s `dialog_memory`, over the
/// shared dialog host: its options are the Electron object, its answer
/// `{ canceled, filePaths }` or `{ canceled, filePath }`.
pub(crate) struct FileDialogs(pub shell_contract::DialogsHost);

impl FileDialogs {
    fn options(options: &jscompat::JsObject<jscompat::JsonValue>) -> FileDialog {
        use jscompat::JsonValue;
        let text = |key: &str| match options.get(key) {
            Some(JsonValue::String(s)) => Some(s.clone()),
            _ => None,
        };
        let strings = |v: &JsonValue| match v {
            JsonValue::Array(items) => items
                .iter()
                .filter_map(|i| match i {
                    JsonValue::String(s) => Some(s.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        let filters = match options.get("filters") {
            Some(JsonValue::Array(items)) => items
                .iter()
                .filter_map(|f| match f {
                    JsonValue::Object(o) => Some(FileFilter {
                        name: match o.get("name") {
                            Some(JsonValue::String(s)) => s.clone(),
                            _ => String::new(),
                        },
                        extensions: o.get("extensions").map(strings).unwrap_or_default(),
                    }),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        FileDialog {
            title: text("title"),
            default_path: text("defaultPath").map(PathBuf::from),
            button_label: text("buttonLabel"),
            filters,
            properties: options.get("properties").map(strings).unwrap_or_default(),
        }
    }
}

impl main_core::packages::electron_utils::dialog_memory::Dialog for FileDialogs {
    type Window = WindowId;

    fn show_open_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &jscompat::JsObject<jscompat::JsonValue>,
    ) -> jscompat::JsonValue {
        use jscompat::JsonValue;
        let picked = self.0.open(parent.copied(), &Self::options(options));
        let mut answer = jscompat::JsObject::new();
        answer.set("canceled", JsonValue::Bool(picked.is_none()));
        answer.set(
            "filePaths",
            JsonValue::Array(
                picked
                    .unwrap_or_default()
                    .iter()
                    .map(|p| JsonValue::String(p.to_string_lossy().into_owned()))
                    .collect(),
            ),
        );
        JsonValue::Object(answer)
    }

    fn show_save_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &jscompat::JsObject<jscompat::JsonValue>,
    ) -> jscompat::JsonValue {
        use jscompat::JsonValue;
        let picked = self.0.save(parent.copied(), &Self::options(options));
        let mut answer = jscompat::JsObject::new();
        answer.set("canceled", JsonValue::Bool(picked.is_none()));
        if let Some(path) = picked {
            answer.set(
                "filePath",
                JsonValue::String(path.to_string_lossy().into_owned()),
            );
        }
        JsonValue::Object(answer)
    }
}

/// A window a message box sits over. The shell's dialogs show it unparented
/// when the window is gone, so it never reads as destroyed here.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Parent(pub WindowId);

impl main_core::packages::electron_utils::message_box::ParentWindow for Parent {
    fn is_destroyed(&self) -> bool {
        false
    }
}

/// `dialog.showMessageBox` as `main-core` calls it, over the shared dialogs
pub(crate) struct Boxes(pub shell_contract::DialogsHost);

impl Boxes {
    fn shown(
        &self,
        parent: Option<WindowId>,
        options: &main_core::packages::electron_utils::message_box::MessageBoxOptions,
    ) -> f64 {
        let answer = self.0.message(
            parent,
            &shell_contract::hosts::MessageBox {
                kind: Some(options.kind.to_owned()),
                title: options.title.clone(),
                message: options.message.clone(),
                detail: options.detail.clone(),
                buttons: options.buttons.clone(),
                default_id: Some(options.default_id as usize),
                cancel_id: options.cancel_id.map(|id| id as usize),
                checkbox_label: None,
            },
        );
        answer.response as f64
    }
}

impl main_core::packages::electron_utils::message_box::MessageBox<Parent> for Boxes {
    fn show_message_box_over(
        &self,
        parent: &Parent,
        options: &main_core::packages::electron_utils::message_box::MessageBoxOptions,
    ) -> f64 {
        self.shown(Some(parent.0), options)
    }

    fn show_message_box(
        &self,
        options: &main_core::packages::electron_utils::message_box::MessageBoxOptions,
    ) -> f64 {
        self.shown(None, options)
    }
}

/// `app.getPath(name)` for the `main-core` functions that take Electron's
/// `app` (`readHwpDefaultFormat`, `configuredDefaultSaveDir`)
pub(crate) struct AppPaths(pub Arc<dyn shell_contract::runtime::AppPaths>);

impl main_core::packages::electron_utils::default_save_dir::PathProvider for AppPaths {
    fn get_path(
        &self,
        name: &str,
    ) -> Result<String, main_core::packages::electron_utils::default_save_dir::Thrown> {
        use shell_contract::runtime::PathName;
        let name = match name {
            "home" => PathName::Home,
            "appData" => PathName::AppData,
            "userData" => PathName::UserData,
            "temp" => PathName::Temp,
            "exe" => PathName::Exe,
            "desktop" => PathName::Desktop,
            "documents" => PathName::Documents,
            "downloads" => PathName::Downloads,
            "logs" => PathName::Logs,
            other => {
                return Err(
                    main_core::packages::electron_utils::default_save_dir::Thrown(format!(
                        "Failed to get '{other}' path"
                    )),
                );
            }
        };
        Ok(self.0.path(name).to_string_lossy().into_owned())
    }
}

/// This app's host fakes, answering from `case` (`hosts.d2.hwp`)
#[cfg(any(test, feature = "probe"))]
pub(crate) fn fakes(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    let log = fake::Log::of(hosts);
    hosts.insert::<HwpEngineHost>(Arc::new(fake::FakeEngine::new(case, log.clone())));
    hosts.insert::<HwpShellHost>(Arc::new(fake::FakeShell::new(case, log)));
}

#[cfg(any(test, feature = "probe"))]
pub(crate) mod fake {
    //! The fakes answer from the case's `hosts.d2.hwp` object: `case[<method>]`
    //! is the answer; an array there is the answers of successive calls, in
    //! order, the last one repeating (so a method that answers an array takes
    //! an array of arrays). Bytes are written as a string, its UTF-8 being the
    //! bytes. Without a key the answer is neutral: no tracked changes, no
    //! memos, empty text, English, not headless, no window, nothing open
    //! elsewhere, no project folder, the editor takes no key, the hidden view
    //! is view 900.

    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use main_core::packages::electron_utils::unsaved_files::{
        OpenFileState, OpenFilesSourceFailed,
    };
    use serde_json::{Value, json};
    use shell_contract::runtime::CancelToken;
    use shell_contract::{ViewId, WindowId};

    use super::attachments::ParsedFileKind;
    use super::{FetchedImage, HwpEngine, HwpMemo, HwpShell, ParsedFile, TrackedChanges};

    /// `case[method]`, consumed in order
    pub(crate) struct Answers(Mutex<serde_json::Map<String, Value>>);

    impl Answers {
        pub fn new(case: &Value) -> Self {
            Answers(Mutex::new(case.as_object().cloned().unwrap_or_default()))
        }

        pub fn next(&self, method: &str) -> Option<Value> {
            let mut map = self.0.lock().unwrap();
            match map.get_mut(method)? {
                Value::Array(items) if items.len() > 1 => Some(items.remove(0)),
                Value::Array(items) => items.first().cloned(),
                other => Some(other.clone()),
            }
        }
    }

    fn text(v: Option<Value>) -> Option<String> {
        v.and_then(|v| v.as_str().map(str::to_owned))
    }

    /// `Date.now()` of a case that does not set `now_ms`: 2026-01-01 UTC.
    /// tools/ipc-diff's hwp groups pin the TypeScript's clock to the same.
    pub(crate) const NOW_MS: f64 = 1_767_225_600_000.0;

    /// The case's host log in ipc-probe (`ProbeLog` there); none in unit tests
    #[derive(Clone, Default)]
    pub(crate) struct Log(pub Option<Arc<Mutex<Vec<Value>>>>);

    impl Log {
        pub fn of(hosts: &shell_contract::Hosts) -> Self {
            Log(hosts.get::<Arc<Mutex<Vec<Value>>>>().cloned())
        }

        /// one line, named after the TypeScript function the host method stands for
        pub fn push(&self, line: Value) {
            if let Some(log) = &self.0 {
                log.lock().unwrap().push(line)
            }
        }
    }

    pub(crate) struct FakeEngine(Answers, pub(crate) Log);

    impl FakeEngine {
        pub fn new(case: &Value, log: Log) -> Self {
            FakeEngine(Answers::new(case), log)
        }
    }

    impl HwpEngine for FakeEngine {
        /// `"none" | "tracked" | "unreadable"`
        fn tracked_changes_of(&self, _file: &[u8]) -> TrackedChanges {
            self.1.push(json!(["trackedChangesOf"]));
            match text(self.0.next("tracked_changes_of")).as_deref() {
                Some("tracked") => TrackedChanges::Tracked,
                Some("unreadable") => TrackedChanges::Unreadable,
                _ => TrackedChanges::None,
            }
        }
        /// the bytes as a string, or null
        fn without_tracked_changes(&self, _file: &[u8]) -> Option<Vec<u8>> {
            self.1.push(json!(["withoutTrackedChanges"]));
            text(self.0.next("without_tracked_changes")).map(String::into_bytes)
        }
        /// `[{author, date, text, place}]`, or `{"error": message}`
        fn hwp_memos_of(&self, _file: &[u8]) -> Result<Vec<HwpMemo>, String> {
            self.1.push(json!(["hwpMemosOf"]));
            match self.0.next("hwp_memos_of") {
                Some(Value::Object(o)) if o.contains_key("error") => {
                    Err(o["error"].as_str().unwrap_or_default().to_owned())
                }
                Some(Value::Array(items)) => Ok(items
                    .iter()
                    .map(|m| {
                        let f = |k: &str| m.get(k).and_then(Value::as_str).map(str::to_owned);
                        HwpMemo {
                            author: f("author"),
                            date: f("date"),
                            text: f("text"),
                            place: f("place"),
                        }
                    })
                    .collect()),
                _ => Ok(Vec::new()),
            }
        }
        /// the text, or `{"error": message}`
        fn hwp_to_text(&self, _file: &[u8]) -> Result<String, String> {
            self.1.push(json!(["hwpToText"]));
            match self.0.next("hwp_to_text") {
                Some(Value::String(s)) => Ok(s),
                Some(Value::Object(o)) => Err(o
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()),
                _ => Ok(String::new()),
            }
        }

        /// `{"failed": true}` (the source threw), `{"files": [{"filePath",
        /// "dirty"}]}`, or absent/null for no source registered
        fn open_files(&self) -> Option<Result<Vec<OpenFileState>, OpenFilesSourceFailed>> {
            let source = self.0.next("open_files").filter(|v| !v.is_null())?;
            // the line of `openFilesSource`, called only when a source is registered
            self.1.push(json!(["openFilesSource"]));
            if source.get("failed").and_then(Value::as_bool) == Some(true) {
                return Some(Err(OpenFilesSourceFailed));
            }
            let files = source.get("files").and_then(Value::as_array);
            Some(Ok(files
                .into_iter()
                .flatten()
                .map(|f| OpenFileState {
                    file_path: f.get("filePath").and_then(Value::as_str).map(str::to_owned),
                    dirty: f.get("dirty").and_then(Value::as_bool) == Some(true),
                })
                .collect()))
        }
        /// a bool (default `false`)
        fn diagram_picture_has_no_original(&self, file_name: String, _bytes: Vec<u8>) -> bool {
            self.1.push(json!(["extractDiagramXml", file_name]));
            self.0
                .next("diagram_picture_has_no_original")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        }
        /// `{ok, kind: "text"|"image"|"unsupported", text, error, damaged}`;
        /// default: the file read as UTF-8 text
        fn parse_file_to_text(&self, path: String) -> ParsedFile {
            self.1.push(json!(["parseFileToText", path]));
            let Some(answer) = self.0.next("parse_file_to_text") else {
                return match std::fs::read(&path) {
                    Ok(bytes) => ParsedFile {
                        ok: true,
                        kind: ParsedFileKind::Text,
                        text: Some(String::from_utf8_lossy(&bytes).into_owned()),
                        error: None,
                        damaged: false,
                    },
                    Err(e) => ParsedFile {
                        ok: false,
                        kind: ParsedFileKind::Text,
                        text: None,
                        error: Some(e.to_string()),
                        damaged: false,
                    },
                };
            };
            let member = |key: &str| answer.get(key).and_then(Value::as_str).map(str::to_owned);
            ParsedFile {
                ok: answer.get("ok").and_then(Value::as_bool) == Some(true),
                kind: match answer.get("kind").and_then(Value::as_str) {
                    Some("image") => ParsedFileKind::Image,
                    Some("unsupported") => ParsedFileKind::Unsupported,
                    _ => ParsedFileKind::Text,
                },
                text: member("text"),
                error: member("error"),
                damaged: answer.get("damaged").and_then(Value::as_bool) == Some(true),
            }
        }
        /// a string is the error it throws; default: the bytes
        fn checked_hwp_bytes(&self, bytes: Vec<u8>, ext: String) -> Result<Vec<u8>, String> {
            self.1.push(json!(["checkedHwpBytes", ext]));
            match self.0.next("checked_hwp_bytes") {
                Some(Value::String(error)) => Err(error),
                _ => Ok(bytes),
            }
        }
        /// `{base64, mime}`, or null (default) for a refused address
        fn fetch_image_bytes(&self, url: String) -> Option<FetchedImage> {
            self.1.push(json!(["fetchImageBytes", url]));
            let answer = self.0.next("fetch_image_bytes")?;
            let member = |key: &str| answer.get(key)?.as_str().map(str::to_owned);
            Some(FetchedImage {
                base64: member("base64")?,
                mime: member("mime")?,
            })
        }
        /// the tool's result; `{"throws": message}` rejects; default: what
        /// the engine was asked, `{view, settingsPath, mediaUrls,
        /// requirements, cancelled}`
        fn analyze_media(
            &self,
            view: ViewId,
            settings_path: PathBuf,
            media_urls: Vec<String>,
            requirements: String,
            cancel: CancelToken,
        ) -> Result<Value, String> {
            self.1
                .push(json!(["analyzeMediaTool", media_urls, requirements]));
            match self.0.next("analyze_media") {
                Some(answer) => match answer.get("throws").and_then(Value::as_str) {
                    Some(message) => Err(message.to_owned()),
                    None => Ok(answer),
                },
                None => Ok(serde_json::json!({
                    "view": view.0,
                    "settingsPath": settings_path.to_string_lossy(),
                    "mediaUrls": media_urls,
                    "requirements": requirements,
                    "cancelled": cancel.is_cancelled(),
                })),
            }
        }
    }

    /// The shell's side; what it was asked is in [`FakeShell::calls`] and,
    /// in the probe, the case's log
    pub(crate) struct FakeShell {
        answers: Answers,
        log: Log,
        pub calls: Mutex<Vec<Value>>,
        uuid: Mutex<u64>,
    }

    impl FakeShell {
        pub fn new(case: &Value, log: Log) -> Self {
            FakeShell {
                answers: Answers::new(case),
                log,
                calls: Mutex::default(),
                uuid: Mutex::new(0),
            }
        }

        fn log(&self, line: Value) {
            self.log.push(line.clone());
            self.calls.lock().unwrap().push(line)
        }

        fn flag(&self, method: &str, default: bool) -> bool {
            self.answers
                .next(method)
                .and_then(|v| v.as_bool())
                .unwrap_or(default)
        }

        /// the lines logged since the last call, each as its words
        #[cfg(test)]
        pub fn take_calls(&self) -> Vec<String> {
            std::mem::take(&mut *self.calls.lock().unwrap())
                .into_iter()
                .map(|line| {
                    line.as_array()
                        .into_iter()
                        .flatten()
                        .map(|word| match word {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .collect()
        }
    }

    impl HwpShell for FakeShell {
        fn ui_lang(&self) -> String {
            text(self.answers.next("ui_lang")).unwrap_or_else(|| "en".into())
        }
        fn is_headless_mode(&self) -> bool {
            self.flag("is_headless_mode", false)
        }
        /// a window number, or null
        fn focused_window(&self) -> Option<WindowId> {
            self.answers
                .next("focused_window")
                .and_then(|v| v.as_u64())
                .map(|n| WindowId(n as u32))
        }
        /// `00000000-0000-4000-8000-000000000001`, `...0002`, ...
        fn random_uuid(&self) -> String {
            let mut n = self.uuid.lock().unwrap();
            *n += 1;
            format!("00000000-0000-4000-8000-{:012}", *n)
        }
        /// a number; [`NOW_MS`] by default
        fn now_ms(&self) -> f64 {
            self.answers
                .next("now_ms")
                .and_then(|v| v.as_f64())
                .unwrap_or(NOW_MS)
        }
        fn is_path_open_elsewhere(&self, path: &str) -> bool {
            self.log(json!(["openPathProbe", path]));
            self.flag("is_path_open_elsewhere", false)
        }
        fn import_pdf(&self) {
            self.log(json!(["runtime.importPdf"]))
        }
        fn new_document_dir(&self, view: ViewId) -> Option<String> {
            self.log(json!(["runtime.newDocumentDir", view.0]));
            text(self.answers.next("new_document_dir"))
        }
        fn file_saved(&self, view: ViewId, path: &str) {
            self.log(json!(["fileSavedHook", view.0, path]))
        }
        fn open_file_dialog(&self) -> bool {
            self.log(json!(["runtime.openFileDialog"]));
            self.flag("open_file_dialog", true)
        }
        fn go_home(&self) -> bool {
            self.log(json!(["runtime.goHome"]));
            self.flag("go_home", true)
        }
        fn new_document(&self) -> bool {
            self.log(json!(["runtime.newDocument"]));
            self.flag("new_document", true)
        }
        fn reload(&self, view: ViewId) {
            self.log(json!(["webContents.reload", view.0]))
        }
        fn editor_takes(&self, view: ViewId, key: &str) -> bool {
            self.log(json!(["editorTakes", view.0, key]));
            self.flag("editor_takes", false)
        }
        fn copy(&self, view: ViewId) {
            self.log(json!(["webContents.copy", view.0]))
        }
        fn cut(&self, view: ViewId) {
            self.log(json!(["webContents.cut", view.0]))
        }
        fn send_key(&self, view: ViewId, key_code: &str, modifiers: &[&str]) {
            self.log(json!([
                "webContents.sendInputEvent",
                view.0,
                key_code,
                modifiers
            ]))
        }
        /// a view number, or `{"error": message}`
        fn create_headless_view(&self) -> Result<ViewId, String> {
            let made = match self.answers.next("create_headless_view") {
                Some(Value::Object(o)) => Err(o
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()),
                Some(v) => Ok(ViewId(v.as_u64().unwrap_or(900) as u32)),
                None => Ok(ViewId(900)),
            };
            self.log(json!(["new BrowserWindow"]));
            made
        }
        fn load_headless_view(&self, view: ViewId) {
            self.log(json!(["webContents.loadURL", view.0]))
        }
        fn destroy_headless_view(&self, view: ViewId) {
            self.log(json!(["BrowserWindow.destroy", view.0]))
        }
    }
}
