//! The fakes of the document picker's hosts for `crates/ipc-probe`, answering
//! from the case's `hosts.w.docPicker`:
//!
//! - `view`: the view the picker window opens as (2 by default);
//! - `lang`, `theme`: what the app answers (`ko`, `light`);
//! - `open`: the open documents, `{ id, path?, title, dirty }`; `recent`:
//!   `{ path, title, missing }`; `project`: the project files `{ path, title }`
//!   or `{ throws: true }` (absent: none); `sizes`: the size of each path
//!   (absent: the file is not there);
//! - `askers`: the asker of each view, by view number;
//! - `asked`: `{ parent, asker }`, an editor (in window `parent`) already
//!   asked for the picker when the case starts, and its answer is logged when
//!   it comes: `["doc:pick-attachments settled", answer]`;
//! - `userCloses`: the person closes each picker window as soon as it is up.
//!
//! Each host call is one line of the case's log, named after the call it
//! fakes (`tools/ipc-diff/support/doc-picker.ts` writes the same).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use main_core::packages::i18n::Lang;
use main_core::shell::doc_picker::asker::DocAsker;
use main_core::shell::doc_picker::doc_list::{
    DocListDeps, OpenDocumentEntry, ProjectFile, RecentDocumentEntry,
};
use serde_json::{Value, json};
use shell_contract::Hosts;
use shell_contract::IpcValue;
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::ipc::Responder;

use super::{
    DocPickerControl, DocPickerSources, DocPickerSourcesHost, DocPickerWindow, DocPickerWindowHost,
    DocPickerWindowOptions,
};

type Log = Arc<Mutex<Vec<Value>>>;

fn push(log: &Log, line: Value) {
    log.lock().expect("the probe log").push(line);
}

fn text_of(spec: &Value, key: &str) -> Option<String> {
    spec[key].as_str().map(str::to_owned)
}

struct Window {
    log: Log,
    view: ViewId,
    lang: Lang,
    theme: String,
    control: Mutex<Option<DocPickerControl>>,
    open: AtomicBool,
    /// `asked`: the window that asked and the asker
    asked: Option<(WindowId, DocAsker)>,
    user_closes: bool,
}

/// An answer as the log writes it
fn json_of(value: &IpcValue) -> Value {
    match value {
        IpcValue::Bool(b) => Value::Bool(*b),
        IpcValue::String(s) => Value::String(s.clone()),
        IpcValue::Number(n) => json!(n),
        IpcValue::Array(items) => Value::Array(items.iter().map(json_of).collect()),
        IpcValue::Object(entries) => Value::Object(
            entries
                .iter()
                .map(|(k, v)| (k.clone(), json_of(v)))
                .collect(),
        ),
        _ => Value::Null,
    }
}

impl DocPickerWindow for Window {
    fn attach(&self, control: DocPickerControl) {
        *self.control.lock().expect("the control") = Some(control.clone());
        if let Some((parent, asker)) = &self.asked {
            let log = self.log.clone();
            control.open(
                Some(*parent),
                asker.clone(),
                Responder::new(move |reply| {
                    let answer = reply.map_or(Value::Null, |v| json_of(&v));
                    push(&log, json!(["doc:pick-attachments settled", answer]));
                }),
            );
            control.wait_idle();
        }
    }

    fn lang(&self) -> Lang {
        self.lang
    }

    fn theme(&self) -> String {
        self.theme.clone()
    }

    fn create(&self, o: &DocPickerWindowOptions) -> ViewId {
        let mut options = serde_json::Map::new();
        options.insert("width".into(), o.width.into());
        options.insert("height".into(), o.height.into());
        options.insert("minWidth".into(), o.min_width.into());
        options.insert("minHeight".into(), o.min_height.into());
        if let Some(parent) = o.parent {
            options.insert("parent".into(), parent.0.into());
            options.insert("modal".into(), true.into());
        }
        options.insert("show".into(), o.show.into());
        options.insert("center".into(), o.center.into());
        options.insert("minimizable".into(), o.minimizable.into());
        options.insert("maximizable".into(), o.maximizable.into());
        options.insert("fullscreenable".into(), o.fullscreenable.into());
        options.insert("autoHideMenuBar".into(), o.auto_hide_menu_bar.into());
        options.insert("title".into(), o.title.clone().into());
        push(&self.log, json!(["new BrowserWindow", options]));
        self.open.store(true, Ordering::SeqCst);
        if let Some(control) = self.control.lock().expect("the control").as_ref() {
            control.window_ready(self.view);
            if self.user_closes {
                control.window_closed(self.view);
            }
        }
        self.view
    }

    fn show(&self) {
        push(&self.log, json!(["BrowserWindow.show"]));
    }

    fn focus(&self) {
        push(&self.log, json!(["BrowserWindow.focus"]));
    }

    fn close(&self) {
        push(&self.log, json!(["BrowserWindow.close"]));
        if let Some(control) = self.control.lock().expect("the control").as_ref() {
            control.window_closed(self.view);
        }
        self.open.store(false, Ordering::SeqCst);
    }
}

struct Sources {
    log: Log,
    open: Vec<OpenDocumentEntry>,
    recent: Vec<RecentDocumentEntry>,
    /// `None`: the dependency is not given; a dependency that threw gives no files
    project: Option<Vec<ProjectFile>>,
    sizes: HashMap<String, f64>,
    askers: HashMap<u32, DocAsker>,
}

impl DocListDeps for Sources {
    fn open_documents(&self) -> Vec<OpenDocumentEntry> {
        self.open.clone()
    }

    fn recent(&self) -> Vec<RecentDocumentEntry> {
        self.recent.clone()
    }

    fn project_files(&self, asker: &DocAsker) -> Vec<ProjectFile> {
        // no `projectFiles` dependency, no call
        let Some(project) = &self.project else {
            return Vec::new();
        };
        push(&self.log, json!(["deps.projectFiles", asker.to_json()]));
        project.clone()
    }

    fn stat(&self, path: &str) -> Option<f64> {
        push(&self.log, json!(["deps.stat", path]));
        self.sizes.get(path).copied()
    }
}

impl DocPickerSources for Sources {
    fn asker_for(&self, view: ViewId) -> DocAsker {
        self.askers.get(&view.0).cloned().unwrap_or_default()
    }
}

pub(super) fn insert(hosts: &mut Hosts, case: &Value) {
    let spec = &case["docPicker"];
    let log: Log = hosts.get::<Log>().cloned().unwrap_or_default();
    let list = |key: &str| spec[key].as_array().cloned().unwrap_or_default();
    let window: DocPickerWindowHost = Arc::new(Window {
        log: log.clone(),
        view: ViewId(spec["view"].as_u64().unwrap_or(2) as u32),
        lang: if spec["lang"].as_str() == Some("en") {
            Lang::En
        } else {
            Lang::Ko
        },
        theme: spec["theme"].as_str().unwrap_or("light").to_owned(),
        control: Mutex::default(),
        open: AtomicBool::new(false),
        asked: spec["asked"].as_object().map(|asked| {
            let asker = &spec["asked"]["asker"];
            (
                WindowId(asked["parent"].as_u64().unwrap_or(1) as u32),
                DocAsker {
                    web_contents_id: None,
                    tab_id: text_of(asker, "tabId"),
                    path: text_of(asker, "path"),
                    pane_tab_id: text_of(asker, "paneTabId"),
                },
            )
        }),
        user_closes: spec["userCloses"].as_bool().unwrap_or(false),
    });
    // an object (`{ throws }`) stands for a dependency that threw: no files
    let project = spec.get("project").map(|project| {
        project
            .as_array()
            .map(|files| {
                files
                    .iter()
                    .map(|file| ProjectFile {
                        path: text_of(file, "path").unwrap_or_default(),
                        title: text_of(file, "title").unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    });
    let sources: DocPickerSourcesHost = Arc::new(Sources {
        log,
        open: list("open")
            .iter()
            .map(|doc| OpenDocumentEntry {
                id: text_of(doc, "id").unwrap_or_default(),
                path: text_of(doc, "path"),
                title: text_of(doc, "title").unwrap_or_default(),
                dirty: doc["dirty"].as_bool().unwrap_or(false),
            })
            .collect(),
        recent: list("recent")
            .iter()
            .map(|doc| RecentDocumentEntry {
                path: text_of(doc, "path").unwrap_or_default(),
                title: text_of(doc, "title").unwrap_or_default(),
                missing: doc["missing"].as_bool().unwrap_or(false),
            })
            .collect(),
        project,
        sizes: spec["sizes"]
            .as_object()
            .map(|o| {
                o.iter()
                    .filter_map(|(k, v)| Some((k.clone(), v.as_f64()?)))
                    .collect()
            })
            .unwrap_or_default(),
        askers: spec["askers"]
            .as_object()
            .map(|o| {
                o.iter()
                    .filter_map(|(view, asker)| {
                        Some((
                            view.parse().ok()?,
                            DocAsker {
                                web_contents_id: None,
                                tab_id: text_of(asker, "tabId"),
                                path: text_of(asker, "path"),
                                pane_tab_id: text_of(asker, "paneTabId"),
                            },
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default(),
    });
    hosts.insert(window);
    hosts.insert(sources);
}
