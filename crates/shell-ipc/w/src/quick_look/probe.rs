//! The fakes of Quick Look's hosts for `crates/ipc-probe`, answering from the
//! case's `hosts.w.quickLook`:
//!
//! - `windows`: the Explorer hook exists (the TypeScript side runs as
//!   `process.platform === 'win32'`);
//! - `view`: the view the preview window opens as (2 by default);
//! - `lang`, `theme`: what the app answers (`ko`, `light`);
//! - `parse`: `parseFileToText`'s answers, a list of `{ path, ok, text, error }`
//!   or `{ path, throws }`; a path not listed is read as UTF-8 text;
//! - `script`: what the Explorer hook reports once it is enabled, in order,
//!   each finished before the next: `{ op: "space" | "navigate", path }`,
//!   `{ op: "escape" }`, `{ op: "notify" }` (the language switch).
//!
//! Each host call is one line of the case's log, named after the Electron or
//! app call it fakes (`tools/ipc-diff/support/quick-look.ts` writes the same).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use main_core::packages::i18n::Lang;
use main_core::shell::quick_look::{ParsedFile, QuickLookEngines, ZipArchive};
use serde_json::{Value, json};
use shell_contract::Hosts;
use shell_contract::ids::ViewId;

use super::{
    QuickLookControl, QuickLookEnginesHost, QuickLookHost, QuickLookNotify, QuickLookRuntime,
    QuickLookSettings, QuickLookWindow, QuickLookWindowHost, QuickLookWindowOptions,
};

type Log = Arc<Mutex<Vec<Value>>>;

fn push(log: &Log, line: Value) {
    log.lock().expect("the probe log").push(line);
}

struct Window {
    log: Log,
    view: ViewId,
    lang: Lang,
    theme: String,
    visible: AtomicBool,
    control: Mutex<Option<QuickLookControl>>,
}

impl QuickLookWindow for Window {
    fn attach(&self, control: QuickLookControl) {
        *self.control.lock().expect("the control") = Some(control);
    }

    fn lang(&self) -> Lang {
        self.lang
    }

    fn theme(&self) -> String {
        self.theme.clone()
    }

    fn create(&self, o: &QuickLookWindowOptions) -> ViewId {
        push(
            &self.log,
            json!(["new BrowserWindow", {
                "width": o.width,
                "height": o.height,
                "minWidth": o.min_width,
                "minHeight": o.min_height,
                "show": o.show,
                "center": o.center,
                "frame": o.frame,
                "transparent": o.transparent,
                "backgroundColor": o.background_color,
                "hasShadow": o.has_shadow,
                "alwaysOnTop": o.always_on_top,
                "minimizable": o.minimizable,
                "maximizable": o.maximizable,
                "fullscreenable": o.fullscreenable,
                "autoHideMenuBar": o.auto_hide_menu_bar,
                "title": o.title,
            }]),
        );
        self.visible.store(false, Ordering::SeqCst);
        // `once('ready-to-show')`: the page is up once the call returns
        if let Some(control) = self.control.lock().expect("the control").as_ref() {
            control.window_ready(self.view);
        }
        self.view
    }

    fn is_visible(&self) -> bool {
        self.visible.load(Ordering::SeqCst)
    }

    fn set_title(&self, title: &str) {
        push(&self.log, json!(["BrowserWindow.setTitle", title]));
    }

    fn show_inactive(&self) {
        push(&self.log, json!(["BrowserWindow.showInactive"]));
        self.visible.store(true, Ordering::SeqCst);
    }

    fn hide(&self) {
        push(&self.log, json!(["BrowserWindow.hide"]));
        self.visible.store(false, Ordering::SeqCst);
    }

    fn destroy(&self) {
        push(&self.log, json!(["BrowserWindow.destroy"]));
        self.visible.store(false, Ordering::SeqCst);
    }

    fn open_in_editor(&self, path: &str) {
        push(&self.log, json!(["deps.openInEditor", path]));
    }
}

struct Runtime {
    log: Log,
    windows: bool,
    script: Vec<Value>,
    started: AtomicBool,
    control: Mutex<Option<QuickLookControl>>,
}

impl Runtime {
    /// What the Explorer hook reports once it is enabled
    fn play(&self, control: &QuickLookControl) {
        for op in &self.script {
            let path = op["path"].as_str().unwrap_or("");
            match op["op"].as_str() {
                Some("space") => control.explorer_space(path),
                Some("navigate") => control.explorer_navigate(path),
                Some("escape") => control.explorer_escape(),
                Some("notify") => control.lang_or_theme_changed(),
                _ => {}
            }
            control.wait_idle();
        }
    }
}

impl QuickLookRuntime for Runtime {
    fn attach(&self, control: QuickLookControl) {
        *self.control.lock().expect("the control") = Some(control);
    }

    fn windows_explorer(&self) -> bool {
        self.windows
    }

    fn sync(&self, settings: &QuickLookSettings) {
        if !self.windows {
            return;
        }
        push(
            &self.log,
            json!([
                "WinExplorerQuickLookHook.setEnabled",
                settings.explorer_space_preview
            ]),
        );
        if settings.explorer_space_preview && !self.started.swap(true, Ordering::SeqCst) {
            let control = self.control.lock().expect("the control").clone();
            if let Some(control) = control {
                self.play(&control);
            }
        }
    }

    fn refresh_tray(&self) {}

    fn stop(&self) {}
}

struct Engines {
    log: Log,
    parse: HashMap<String, Value>,
}

impl QuickLookEngines for Engines {
    fn parse_file_to_text(&self, path: &str) -> Result<ParsedFile, String> {
        push(&self.log, json!(["parseFileToText", path]));
        let Some(spec) = self.parse.get(path) else {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            return Ok(ParsedFile {
                ok: true,
                text: Some(String::from_utf8_lossy(&bytes).into_owned()),
                error: None,
            });
        };
        if let Some(message) = spec["throws"].as_str() {
            return Err(message.to_owned());
        }
        Ok(ParsedFile {
            ok: spec["ok"].as_bool().unwrap_or(true),
            text: spec["text"].as_str().map(str::to_owned),
            error: spec["error"].as_str().map(str::to_owned),
        })
    }

    /// The zip gate and JSZip are the shell's; the comparison's files hold no
    /// zip thumbnail
    fn open_zip(&self, _bytes: &[u8]) -> Option<Box<dyn ZipArchive>> {
        None
    }
}

pub(super) fn insert(hosts: &mut Hosts, case: &Value) {
    let spec = &case["quickLook"];
    let log: Log = hosts.get::<Log>().cloned().unwrap_or_default();
    let lang = if spec["lang"].as_str() == Some("en") {
        Lang::En
    } else {
        Lang::Ko
    };
    let window: QuickLookWindowHost = Arc::new(Window {
        log: log.clone(),
        view: ViewId(spec["view"].as_u64().unwrap_or(2) as u32),
        lang,
        theme: spec["theme"].as_str().unwrap_or("light").to_owned(),
        visible: AtomicBool::new(false),
        control: Mutex::default(),
    });
    let runtime: QuickLookHost = Arc::new(Runtime {
        log: log.clone(),
        windows: spec["windows"].as_bool().unwrap_or(false),
        script: spec["script"].as_array().cloned().unwrap_or_default(),
        started: AtomicBool::new(false),
        control: Mutex::default(),
    });
    let engines: QuickLookEnginesHost = Arc::new(Engines {
        log,
        parse: spec["parse"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|p| Some((p["path"].as_str()?.to_owned(), p.clone())))
                    .collect()
            })
            .unwrap_or_default(),
    });
    hosts.insert(window);
    hosts.insert(runtime);
    hosts.insert(engines);
}
