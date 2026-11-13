//! The fakes of this area's hosts for `crates/ipc-probe` (tools/ipc-diff).
//! Each answers from `hosts.w.projects` of the case and logs one line per call
//! named after the TypeScript call it fakes, as `groups/w/projects*.ts` writes
//! it for the real modules:
//!
//! - `random`: none; every `n`-byte draw is `n` bytes of the draw's number
//!   among the `n`-byte draws, from 1;
//! - `files`: `{results: {"<q>": [hit]}, indexedAsOnDisk: [path], openFiles:
//!   [{filePath, dirty}], openFilesFail}`, the index, the open documents and
//!   the reader of the tools (a text file is read as it is);
//! - `store`: `{legacy: {"<doc>": meta}, resolve: {"<path>": answer}, lookup,
//!   load: {"<projectId>/<chatId>": messages}, rebind, sessions:
//!   {"<view>/<session>": path}, headless, fail: {"<method>": message}}`, the
//!   app-data project store.
//!
//! The page events and timers are driven by the case's `trigger` calls
//! (`w/projects:<event>`, see [`probe_trigger`]).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use jscompat::{number_to_string, slice_utf16};
use main_core::packages::electron_utils::default_save_dir::Thrown;
use main_core::packages::electron_utils::unsaved_files::{OpenFileState, OpenFilesSourceFailed};
use main_core::packages::i18n::Lang;
use main_core::packages::project_store::LegacyDocumentChat;
use main_core::shell::projects::memory::LocalDateParts;
use main_core::shell::projects::project_tools::{
    IndexHit, IndexSearchOptions, IndexSearchResult, KbReadPage,
};
use serde_json::{Value, json};
use shell_contract::Hosts;
use shell_contract::editors::Then;
use shell_contract::ids::ViewId;
use shell_contract::provided::Provided;
use shell_contract::runtime::Services;
use shell_contract::value::IpcValue;

use super::host::{
    LegacyProjectStore, LegacyProjectStoreHost, PageEvent, PageEvents, ProjectFiles,
    ProjectFilesHost, ProjectTimer, ProjectsHost, ProjectsHostRef,
};

type Log = Arc<Mutex<Vec<Value>>>;

/// `KB_READ_CHUNK_CHARS`: one page of a knowledge read
const KB_READ_CHUNK_CHARS: f64 = 24_000.0;

fn push(log: &Log, line: Value) {
    log.lock().unwrap().push(line);
}

#[derive(Default)]
struct State {
    events: Option<Arc<dyn PageEvents>>,
    tracked: HashSet<ViewId>,
    watching: HashSet<ViewId>,
    /// the timers set and not cleared, oldest first
    timers: Vec<ProjectTimer>,
    /// draws so far, by number of bytes
    draws: HashMap<usize, u8>,
}

struct FakeHost {
    log: Log,
    state: Mutex<State>,
}

impl FakeHost {
    /// `contents.emit(event)` of the TypeScript: the host reports it when a
    /// listener of this kind was registered
    fn fire(&self, view: ViewId, what: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        let Some(events) = state.events.clone() else {
            return false;
        };
        let tracked = state.tracked.contains(&view);
        let watching = state.watching.contains(&view);
        let reported: Vec<PageEvent> = match what {
            "blur" => watching
                .then_some(PageEvent::Blur(view))
                .into_iter()
                .collect(),
            "focus" => watching
                .then_some(PageEvent::Focus(view))
                .into_iter()
                .collect(),
            "destroyed" => (tracked || watching)
                .then_some(PageEvent::Destroyed(view))
                .into_iter()
                .collect(),
            "navigate" => tracked
                .then_some(PageEvent::Navigated(view))
                .into_iter()
                .collect(),
            "navigate-same" => Vec::new(),
            "timer" => std::mem::take(&mut state.timers)
                .into_iter()
                .map(PageEvent::Timer)
                .collect(),
            _ => return false,
        };
        drop(state);
        for event in reported {
            events.send(event);
        }
        true
    }
}

impl ProjectsHost for FakeHost {
    fn attach(&self, events: Arc<dyn PageEvents>) {
        self.state.lock().unwrap().events = Some(events);
    }

    fn track(&self, view: ViewId) {
        push(&self.log, json!(["once", view.0, "destroyed"]));
        push(&self.log, json!(["on", view.0, "did-start-navigation"]));
        self.state.lock().unwrap().tracked.insert(view);
    }

    fn page_destroyed(&self, _view: ViewId) -> bool {
        false
    }

    fn watch_return(&self, view: ViewId) {
        for event in ["focus", "blur", "destroyed"] {
            push(&self.log, json!(["on", view.0, event]));
        }
        self.state.lock().unwrap().watching.insert(view);
    }

    fn stop_return(&self, view: ViewId) {
        for event in ["focus", "blur", "destroyed"] {
            push(&self.log, json!(["off", view.0, event]));
        }
        self.state.lock().unwrap().watching.remove(&view);
    }

    fn set_timer(&self, key: ProjectTimer, delay_ms: f64) {
        push(&self.log, json!(["setTimeout", delay_ms]));
        self.state.lock().unwrap().timers.push(key);
    }

    fn clear_timer(&self, key: ProjectTimer) {
        push(&self.log, json!(["clearTimeout"]));
        self.state
            .lock()
            .unwrap()
            .timers
            .retain(|known| *known != key);
    }

    fn random_bytes(&self, n: usize) -> Vec<u8> {
        let mut state = self.state.lock().unwrap();
        let draw = state.draws.entry(n).or_insert(0);
        *draw = draw.wrapping_add(1);
        vec![*draw; n]
    }

    fn local_date(&self, at_ms: f64) -> LocalDateParts {
        // the process time zone is UTC (the group sets TZ)
        let ms = at_ms as i64;
        let days = ms.div_euclid(86_400_000);
        let in_day = ms.rem_euclid(86_400_000);
        // civil from days (Howard Hinnant)
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = yoe + era * 400 + i64::from(month <= 2);
        LocalDateParts {
            full_year: year,
            month: month - 1,
            date: day,
            hours: in_day / 3_600_000,
            minutes: in_day / 60_000 % 60,
            seconds: in_day / 1_000 % 60,
        }
    }

    /// the real home: both sides read it from the process, so a case's
    /// folder is never the home
    fn os_home_dir(&self) -> String {
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| "/".to_owned())
    }

    fn format_number(&self, count: f64, lang: Lang) -> Result<String, String> {
        Ok(format!("{}#{}", lang.as_str(), number_to_string(count)))
    }

    fn format_date_time(&self, at_ms: f64, lang: Lang) -> Result<String, String> {
        Ok(format!("{}@{}", lang.as_str(), number_to_string(at_ms)))
    }

    fn run_listing(
        &self,
        _file: &str,
        _args: &[String],
        _cwd: &str,
        _env: &[(String, String)],
        _timeout_ms: f64,
        _input: &str,
    ) -> Result<String, String> {
        Err("no listing in the probe".to_owned())
    }

    fn warn(&self, label: &str, detail: Option<&str>) {
        push(
            &self.log,
            json!(["console", label, detail.unwrap_or("undefined")]),
        );
    }
}

struct FakeFiles {
    log: Log,
    config: Value,
}

impl ProjectFiles for FakeFiles {
    fn search(
        &self,
        input: &str,
        options: &mut IndexSearchOptions<'_>,
    ) -> Result<IndexSearchResult, Thrown> {
        let mut logged = serde_json::Map::new();
        if let Some(exts) = &options.exts {
            logged.insert("exts".into(), json!(exts));
        }
        logged.insert("offset".into(), json!(options.offset));
        logged.insert("limit".into(), json!(options.limit));
        push(&self.log, json!(["fileIndexStore.search", input, logged]));
        let mut kept = Vec::new();
        for hit in self.config["files"]["results"][input]
            .as_array()
            .into_iter()
            .flatten()
        {
            let path = hit["path"].as_str().unwrap_or_default();
            if (options.within)(path)? {
                kept.push(IndexHit {
                    path: path.to_owned(),
                    name: hit["name"].as_str().unwrap_or_default().to_owned(),
                    ext: hit["ext"].as_str().unwrap_or_default().to_owned(),
                    mtime_ms: hit["mtimeMs"].as_f64().unwrap_or(0.0),
                    snippet: hit["snippet"].as_array().map(|parts| {
                        parts
                            .iter()
                            .map(|part| part["text"].as_str().unwrap_or_default().to_owned())
                            .collect()
                    }),
                });
            }
        }
        let total = kept.len() as u64;
        let from = (options.offset.max(0.0) as usize).min(kept.len());
        let upto = from
            .saturating_add(options.limit.max(0.0) as usize)
            .min(kept.len());
        Ok(IndexSearchResult {
            hits: kept[from..upto].to_vec(),
            total,
        })
    }

    fn paths_indexed_as_on_disk(&self, paths: &[String]) -> Vec<String> {
        let indexed: Vec<&str> = self.config["files"]["indexedAsOnDisk"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        paths
            .iter()
            .filter(|path| indexed.contains(&path.as_str()))
            .cloned()
            .collect()
    }

    /// `readKnowledgeFilePage` for a text file: `parseFileToText` of one reads
    /// the file as it is (the real parsers are the shell's)
    fn read_page(&self, file_path: &str, offset: f64) -> Result<KbReadPage, Thrown> {
        let bytes = std::fs::read(file_path).map_err(|error| Thrown(error.to_string()))?;
        let text = String::from_utf8_lossy(&bytes);
        let total = text.encode_utf16().count();
        let start = if offset.is_finite() {
            offset.floor().max(0.0)
        } else {
            0.0
        };
        let page = if start >= total as f64 {
            String::new()
        } else {
            slice_utf16(&text, start, Some(start + KB_READ_CHUNK_CHARS))
        };
        Ok(KbReadPage {
            text: page,
            total_chars: total as u64,
            offset: start,
        })
    }

    fn open_files(&self) -> Result<Vec<OpenFileState>, OpenFilesSourceFailed> {
        if self.config["openFilesFail"].as_bool() == Some(true) {
            return Err(OpenFilesSourceFailed);
        }
        Ok(self.config["openFiles"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|doc| OpenFileState {
                file_path: doc["filePath"].as_str().map(str::to_owned),
                dirty: doc["dirty"].as_bool().unwrap_or(false),
            })
            .collect())
    }
}

struct FakeStore {
    log: Log,
    config: Value,
}

impl FakeStore {
    fn call(&self, method: &str, args: Vec<Value>) -> Result<(), String> {
        let mut line = vec![json!(format!("projectStore.{method}"))];
        line.extend(args);
        push(&self.log, Value::Array(line));
        match self.config["fail"][method].as_str() {
            Some(message) => Err(message.to_owned()),
            None => Ok(()),
        }
    }
}

/// the key of an answer table: a string as it is, anything else printed
fn key_of(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

impl LegacyProjectStore for FakeStore {
    fn legacy_chat_for(&self, doc_path: &str) -> Result<Option<LegacyDocumentChat>, String> {
        match &self.config["legacy"][doc_path] {
            Value::Null => Ok(None),
            meta => serde_json::from_value(meta.clone())
                .map(Some)
                .map_err(|error| error.to_string()),
        }
    }

    fn ensure_default_project(&self) -> Result<(), String> {
        self.call("ensureDefaultProject", vec![])
    }

    fn resolve_chat_for_file(&self, path: &Value) -> Result<Value, String> {
        self.call("resolveChatForFile", vec![path.clone()])?;
        Ok(self.config["resolve"][key_of(path)].clone())
    }

    fn lookup_chat_for_file(&self, path: &Value) -> Result<Value, String> {
        self.call("lookupChatForFile", vec![path.clone()])?;
        Ok(self.config["lookup"][key_of(path)].clone())
    }

    fn append_chat_message(
        &self,
        project_id: &Value,
        chat_id: &Value,
        message: &Value,
    ) -> Result<(), String> {
        self.call(
            "appendChatMessage",
            vec![project_id.clone(), chat_id.clone(), message.clone()],
        )
    }

    fn load_chat(
        &self,
        project_id: &Value,
        chat_id: &Value,
        limit: &Value,
    ) -> Result<Value, String> {
        self.call(
            "loadChat",
            vec![project_id.clone(), chat_id.clone(), limit.clone()],
        )?;
        let key = format!("{}/{}", key_of(project_id), key_of(chat_id));
        Ok(self.config["load"][key].clone())
    }

    fn rebind_chat_to_file(
        &self,
        project_id: &Value,
        temp_chat_id: &Value,
        path: &Value,
    ) -> Result<Value, String> {
        self.call(
            "rebindChatToFile",
            vec![project_id.clone(), temp_chat_id.clone(), path.clone()],
        )?;
        Ok(self.config["rebind"][key_of(path)].clone())
    }

    fn rebind_chat(
        &self,
        project_id: &Value,
        temp_chat_id: &Value,
        new_chat_id: &Value,
    ) -> Result<(), String> {
        self.call(
            "rebindChat",
            vec![
                project_id.clone(),
                temp_chat_id.clone(),
                new_chat_id.clone(),
            ],
        )
    }

    fn sheets_session_path(&self, sender: ViewId, session_id: &Value) -> Option<String> {
        let key = format!("{}/{}", sender.0, key_of(session_id));
        self.config["sessions"][key].as_str().map(str::to_owned)
    }

    fn headless(&self) -> bool {
        self.config["headless"].as_bool().unwrap_or(false)
    }
}

/// Inserts the fakes of this area's hosts, answering from the case's
/// `hosts.w.projects`
pub fn probe_hosts(hosts: &mut Hosts, case: &Value) {
    let log: Log = hosts
        .get::<Log>()
        .cloned()
        .expect("ipc-probe inserts the host log first");
    let config = case["projects"].clone();
    let host = Arc::new(FakeHost {
        log: log.clone(),
        state: Mutex::default(),
    });
    // the same fake, for the triggers
    hosts.insert(host.clone());
    hosts.insert(host as ProjectsHostRef);
    hosts.insert(Arc::new(FakeFiles {
        log: log.clone(),
        config: config.clone(),
    }) as ProjectFilesHost);
    hosts.insert(Arc::new(FakeStore {
        log,
        config: config["store"].clone(),
    }) as LegacyProjectStoreHost);
}

/// The trigger calls of this area: `w/projects:<event>` with the page of
/// the call's view: `blur`, `focus`, `destroyed`, `navigate` (a main-frame
/// navigation to another document), `navigate-same` (to a place of the same
/// document: nothing happens) and `timer` (every timer set so far fires).
/// `false` for a name that is none of these.
pub fn probe_trigger(
    name: &str,
    view: ViewId,
    _args: &Value,
    services: &Services,
    _provided: &Provided,
    then: Then<IpcValue>,
) -> bool {
    let Some(what) = name.strip_prefix("w/projects:") else {
        return false;
    };
    let Some(host) = services.hosts.get::<Arc<FakeHost>>() else {
        return false;
    };
    if !host.fire(view, what) {
        return false;
    }
    then(Ok(IpcValue::Undefined));
    true
}
