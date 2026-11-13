//! Fakes of batch M's hosts for crates/ipc-probe (tools/ipc-diff) and this
//! crate's tests. Every answer comes from the case's `hosts.m` object (keys
//! below, each with a default); every call is recorded in `calls` as a line
//! (`name arg...`) for the tests to read.
//!
//! ```json
//! { "now": 1700000000000, "appLocale": "en-US", "systemLocale": "en-US",
//!   "envLang": null, "username": "tester", "revealHome": true, "openPath": "",
//!   "spellLanguages": ["en-US"], "spellAvailable": ["en-US", "ko"], "addWord": true,
//!   "printers": [{ "name": "q", "displayName": "Q" }],
//!   "print": { "success": true, "failureReason": "" }, "pdf": "%PDF-fake",
//!   "loadError": null, "exec": "settled",
//!   "commands": { "/usr/bin/lp": { "code": 0, "stdout": "", "stderr": "" } },
//!   "splitRoles": { "3": "focus" }, "sheetsViews": [1], "htmlPaths": { "1": "/a.html" },
//!   "hwpPaths": {}, "hwpGrants": {}, "tornDown": [], "headless": false,
//!   "openGenerated": false, "defaultSaveDir": "/docs", "fingerprints": {},
//!   "privateFontFaces": [], "privateFontData": { "id": "AAEC" },
//!   "setElementFont": null, "applyTheme": null,
//!   "familyInfo": [], "metrics": {}, "aliases": {}, "editFonts": [] }
//! ```

use std::sync::{Arc, Mutex};

use jscompat::buffer_from_base64;
use main_core::packages::electron_utils::print_window::{ExecOutcome, PrintReport};
use main_core::packages::electron_utils::printer_options::CommandOutcome;
use serde_json::{Value, json};
use shell_contract::ipc::Responder;
use shell_contract::{Hosts, ViewId};

use crate::hosts::{
    FontQueries, FontQueriesRef, KeyInput, MHost, MHostRef, Peers, PeersRef, PrintSurface,
    PrintWindowSpec, Printer, SplitRole,
};
use crate::state::{MState, MStateRef};
use crate::value::from_serde;

pub struct Fake {
    config: Value,
    pub calls: Arc<Mutex<Vec<String>>>,
}

impl Fake {
    pub fn new(config: &Value) -> Self {
        Fake {
            config: config.clone(),
            calls: Arc::default(),
        }
    }

    fn get(&self, key: &str) -> Option<&Value> {
        self.config.get(key).filter(|v| !v.is_null())
    }

    fn str_or(&self, key: &str, default: &str) -> String {
        self.get(key)
            .and_then(Value::as_str)
            .unwrap_or(default)
            .to_owned()
    }

    fn strings(&self, key: &str, default: &[&str]) -> Vec<String> {
        match self.get(key).and_then(Value::as_array) {
            Some(items) => items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
            None => default.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    fn by_view(&self, key: &str, view: ViewId) -> Option<&Value> {
        self.get(key)?.get(view.0.to_string())
    }

    fn has_view(&self, key: &str, view: ViewId) -> bool {
        self.get(key)
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(|v| v.as_u64() == Some(u64::from(view.0))))
    }

    fn log(&self, line: String) {
        self.calls.lock().unwrap().push(line)
    }
}

impl MHost for Fake {
    fn now_ms(&self) -> f64 {
        self.get("now")
            .and_then(Value::as_f64)
            .unwrap_or(1_700_000_000_000.0)
    }

    fn app_locale(&self) -> String {
        self.str_or("appLocale", "en-US")
    }

    fn system_locale(&self) -> String {
        self.str_or("systemLocale", "en-US")
    }

    fn env_lang(&self) -> Option<String> {
        self.get("envLang")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    fn username(&self) -> Option<String> {
        match self.config.get("username") {
            Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            _ => Some("tester".to_owned()),
        }
    }

    fn set_native_theme(&self, theme: &str) {
        self.log(format!("nativeTheme {theme}"))
    }

    fn refresh_title_bar_overlay(&self) {
        self.log("titleBarOverlay".into())
    }

    fn rebuild_menus_for_language(&self) {
        self.log("menus".into())
    }

    fn sync_tray_menu(&self) {
        self.log("tray".into())
    }

    fn reveal_home(&self) -> bool {
        self.log("revealHome".into());
        self.get("revealHome")
            .and_then(Value::as_bool)
            .unwrap_or(true)
    }

    fn open_template_fonts_folder(&self) -> String {
        self.log("openTemplateFonts".into());
        self.str_or("openPath", "")
    }

    fn spell_add_word(&self, view: ViewId, word: &str) -> bool {
        self.log(format!("addWord {} {word}", view.0));
        self.get("addWord").and_then(Value::as_bool).unwrap_or(true)
    }

    fn spell_remove_word(&self, word: &str) {
        self.log(format!("removeWord {word}"))
    }

    fn spell_languages(&self, _view: ViewId) -> Vec<String> {
        let set = self.calls.lock().unwrap().iter().rev().find_map(|line| {
            line.strip_prefix("setLanguages ")
                .map(|rest| rest.split(',').map(str::to_owned).collect())
        });
        set.unwrap_or_else(|| self.strings("spellLanguages", &["en-US"]))
    }

    fn spell_available_languages(&self, _view: ViewId) -> Vec<String> {
        self.strings("spellAvailable", &["en-US", "ko"])
    }

    fn spell_set_languages(&self, _view: ViewId, languages: &[String]) {
        self.log(format!("setLanguages {}", languages.join(",")))
    }

    fn replace_misspelling(&self, view: ViewId, word: &str) {
        self.log(format!("replaceMisspelling {} {word}", view.0))
    }

    fn send_space(&self, view: ViewId, input: KeyInput) {
        self.log(format!("sendInput {} {input:?}", view.0))
    }

    fn printers(&self, _view: ViewId) -> Vec<Printer> {
        let Some(items) = self.get("printers").and_then(Value::as_array) else {
            return vec![Printer {
                name: "office".into(),
                display_name: "Office".into(),
            }];
        };
        items
            .iter()
            .map(|p| Printer {
                name: p["name"].as_str().unwrap_or("").to_owned(),
                display_name: p["displayName"].as_str().unwrap_or("").to_owned(),
            })
            .collect()
    }

    fn print_window(&self, spec: &PrintWindowSpec) -> Box<dyn PrintSurface> {
        self.log(format!("printWindow {:?}", spec.profile));
        Box::new(FakeSurface {
            config: self.config.clone(),
            calls: self.calls.clone(),
            destroyed: false,
        })
    }

    fn run_command(&self, file: &str, args: &[String], stdin: Option<&[u8]>) -> CommandOutcome {
        self.log(format!(
            "run {file} {} stdin={}",
            args.join(" "),
            stdin.map_or(0, <[u8]>::len)
        ));
        match self.get("commands").and_then(|c| c.get(file)) {
            Some(out) => CommandOutcome::Exited {
                code: out["code"].as_i64().map(|c| c as i32),
                stdout: out["stdout"].as_str().unwrap_or("").as_bytes().to_vec(),
                stderr: out["stderr"].as_str().unwrap_or("").as_bytes().to_vec(),
            },
            None => CommandOutcome::Failed(format!("spawn {file} ENOENT")),
        }
    }
}

struct FakeSurface {
    config: Value,
    calls: Arc<Mutex<Vec<String>>>,
    destroyed: bool,
}

impl FakeSurface {
    fn log(&self, line: String) {
        self.calls.lock().unwrap().push(line)
    }

    fn load(&self, what: &str, target: &str) -> Result<(), String> {
        self.log(format!("{what} {target}"));
        match self.config.get("loadError").and_then(Value::as_str) {
            Some(error) => Err(error.to_owned()),
            None => Ok(()),
        }
    }
}

impl PrintSurface for FakeSurface {
    fn load_file(&mut self, path: &str) -> Result<(), String> {
        self.load("loadFile", path)
    }

    fn load_url(&mut self, url: &str) -> Result<(), String> {
        self.load("loadURL", url)
    }

    fn execute_javascript(&mut self, _script: &str, _user_gesture: bool) -> ExecOutcome {
        self.log("executeJavaScript".into());
        match self.config.get("exec").and_then(Value::as_str) {
            Some("pending") => ExecOutcome::Pending,
            Some("rejected") => ExecOutcome::Rejected("probe failed".into()),
            _ => ExecOutcome::Settled,
        }
    }

    fn print(&mut self, options: &Value) -> PrintReport {
        self.log(format!("print {options}"));
        let print = self.config.get("print").cloned().unwrap_or(json!({}));
        PrintReport {
            success: print["success"].as_bool().unwrap_or(true),
            failure_reason: print["failureReason"].as_str().unwrap_or("").to_owned(),
        }
    }

    fn print_to_pdf(&mut self, options: &Value) -> Result<Vec<u8>, String> {
        self.log(format!("printToPDF {options}"));
        match self.config.get("pdfError").and_then(Value::as_str) {
            Some(error) => Err(error.to_owned()),
            None => Ok(self
                .config
                .get("pdf")
                .and_then(Value::as_str)
                .unwrap_or("%PDF-fake")
                .as_bytes()
                .to_vec()),
        }
    }

    fn show(&mut self) {
        self.log("show".into())
    }

    fn focus(&mut self) {
        self.log("focus".into())
    }

    fn is_destroyed(&self) -> bool {
        self.destroyed
    }

    fn destroy(&mut self) {
        self.log("destroy".into());
        self.destroyed = true
    }
}

impl Peers for Fake {
    fn split_role_of(&self, view: ViewId) -> Option<SplitRole> {
        match self.by_view("splitRoles", view).and_then(Value::as_str) {
            Some("focus") => Some(SplitRole::Focus),
            Some("secondary") => Some(SplitRole::Secondary),
            _ => None,
        }
    }

    fn focus_pane_of(&self, view: ViewId) {
        self.log(format!("focusPane {}", view.0))
    }

    fn open_dropped_files(&self, raw: &Value) {
        self.log(format!("openDropped {raw}"))
    }

    fn sheets_session(&self, view: ViewId) -> bool {
        self.has_view("sheetsViews", view)
    }

    fn html_document_path(&self, view: ViewId) -> Option<String> {
        self.by_view("htmlPaths", view)
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    fn hwp_document_path(&self, view: ViewId) -> Option<String> {
        self.by_view("hwpPaths", view)
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    fn hwp_take_pdf_grant(&self, view: ViewId) -> Option<String> {
        let taken = self
            .calls
            .lock()
            .unwrap()
            .contains(&format!("takeGrant {}", view.0));
        self.log(format!("takeGrant {}", view.0));
        if taken {
            return None;
        }
        self.by_view("hwpGrants", view)
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    fn docs_torn_down(&self, view: ViewId) -> bool {
        self.has_view("tornDown", view)
    }

    fn headless(&self) -> bool {
        self.get("headless")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    fn open_generated_path(&self, path: &str) -> bool {
        self.log(format!("openGenerated {path}"));
        self.get("openGenerated")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    fn default_save_dir(&self) -> String {
        self.str_or("defaultSaveDir", "/docs")
    }

    fn store_page_fingerprints(&self, view: ViewId, request: Value, reply: Responder) {
        self.log(format!("fingerprints {} {request}", view.0));
        let answer = self.get("fingerprints").cloned().unwrap_or(json!({
            "ok": false, "error": "invalid-request", "message": "request must be an object"
        }));
        reply.reply(Ok(from_serde(&answer)))
    }

    fn slides_private_font_faces(&self) -> Value {
        self.get("privateFontFaces").cloned().unwrap_or(json!([]))
    }

    fn slides_private_font_data(&self, id: &Value) -> Option<Vec<u8>> {
        let id = id.as_str()?;
        let data = self.get("privateFontData")?.get(id)?.as_str()?;
        Some(buffer_from_base64(data))
    }

    fn slides_set_element_font(&self, view: ViewId, op: &Value) -> Value {
        self.log(format!("setElementFont {} {op}", view.0));
        self.get("setElementFont").cloned().unwrap_or(Value::Null)
    }

    fn slides_apply_theme(&self, view: ViewId, op: &Value) -> Value {
        self.log(format!("applyTheme {} {op}", view.0));
        self.get("applyTheme").cloned().unwrap_or(Value::Null)
    }
}

impl FontQueries for Fake {
    fn family_info_for(&self, families: &Value) -> Value {
        self.log(format!("familyInfo {families}"));
        self.get("familyInfo").cloned().unwrap_or(json!([]))
    }

    fn family_vertical_metrics(&self, family: &str) -> Option<Value> {
        self.get("metrics")?.get(family).cloned()
    }

    fn family_aliases(&self, name: &str) -> Vec<String> {
        self.get("aliases")
            .and_then(|a| a.get(name))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn list_edit_fonts(&self) -> Vec<String> {
        self.strings("editFonts", &[])
    }
}

/// Inserts the batch's fakes, one `Fake` behind each of its traits; returns
/// it for the caller to read `calls`
pub fn insert(hosts: &mut Hosts, case: &Value) -> Arc<Fake> {
    let fake = Arc::new(Fake::new(case));
    hosts.insert::<MHostRef>(fake.clone());
    hosts.insert::<PeersRef>(fake.clone());
    hosts.insert::<FontQueriesRef>(fake.clone());
    hosts.insert::<MStateRef>(Arc::new(MState::new()));
    fake
}
