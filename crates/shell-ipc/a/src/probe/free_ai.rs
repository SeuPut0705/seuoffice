//! The probe fakes of the `free_ai` port's host: the docs entry's settings and
//! window, and the free connections' `fetch`, scripted by the case's
//! `hosts.a.freeAi` (the TypeScript half is tools/ipc-diff/groups/a/
//! free-ai.ts, which reads the same value and logs the same lines).
//!
//! `hosts.a.lang` is the UI language (`ko` by default); `hosts.a.freeAi`:
//!
//! - `settings`: the settings file before the case (`{}`); what
//!   `readSettings()` answers is that, normalized as the entry's
//!   `storedAiSettings` does
//! - `refuseWrite`: `writeSettings` answers false
//! - `window`: `{destroyed, minimized}` of the window the sender's view has
//!   (none by default)
//! - `fetches`: one answer per `fetch`, in order: `{status, json, location}`
//!   or `{throw: message}`
//!
//! A browser sign-in is not scripted: its loopback server has no fake, so a
//! case never runs one (the fake's `listen` fails, which answers `network`).
//!
//! The host log gets one line per call: `["writeSettings", settings]`,
//! `["win.restore"]`, `["win.show"]`, `["win.focus"]`, and
//! `["fetch", url, method, headers, body]` (header names in lower case, `GET`
//! for no method, `null` for no body).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use main_core::docs::free_ai_ipc::{WindowCommand, WindowState};
use main_core::packages::ai_provider::free_connect::{
    CodeWait, FetchRequest, FetchResponse, FreeConnectNet, OpenRouterHost,
};
use main_core::packages::ai_provider::legacy_settings::normalize_ai_settings;
use main_core::packages::i18n::{Lang, normalize_lang};
use serde_json::{Map, Value, json};
use shell_contract::ViewId;
use shell_contract::runtime::CancelToken;

use super::{Log, push};
use crate::free_ai::{FreeAiHost, FreeAiHostHandle, OpenBrowser};

type Fetches = Arc<Mutex<VecDeque<Value>>>;

struct Net {
    fetches: Fetches,
    log: Option<Log>,
    signal: CancelToken,
}

impl FreeConnectNet for Net {
    fn fetch(&mut self, request: &FetchRequest) -> Result<FetchResponse, String> {
        let headers: Map<String, Value> = request
            .headers
            .iter()
            .map(|(name, value)| (name.to_lowercase(), json!(value)))
            .collect();
        push(
            &self.log,
            json!([
                "fetch",
                request.url,
                request.method.unwrap_or("GET"),
                headers,
                request.body
            ]),
        );
        let answer = self.fetches.lock().unwrap().pop_front();
        let Some(answer) = answer else {
            return Err("no fetch scripted".to_owned());
        };
        if let Some(message) = answer["throw"].as_str() {
            return Err(message.to_owned());
        }
        Ok(FetchResponse {
            status: answer["status"].as_u64().unwrap_or(200) as u16,
            opaque_redirect: false,
            location: answer["location"].as_str().map(str::to_owned),
            json: Ok(json_value_from_serde(&answer["json"])),
        })
    }

    fn signal_aborted(&self) -> bool {
        self.signal.is_cancelled()
    }
}

/// The loopback server of a sign-in: there is none
struct NoLoopback(Net);

impl FreeConnectNet for NoLoopback {
    fn fetch(&mut self, request: &FetchRequest) -> Result<FetchResponse, String> {
        self.0.fetch(request)
    }

    fn signal_aborted(&self) -> bool {
        self.0.signal_aborted()
    }
}

impl OpenRouterHost for NoLoopback {
    fn random_bytes(&mut self) -> [u8; 32] {
        [0; 32]
    }

    fn listen(&mut self) -> Result<f64, String> {
        Err("the probe has no loopback server".to_owned())
    }

    fn open_browser(&mut self, _url: &str) -> Result<bool, String> {
        Ok(false)
    }

    fn start_timer(&mut self, _timeout_ms: f64) {}

    fn await_outcome(&mut self, _wait: &mut CodeWait) {}

    fn close_servers(&mut self) {}
}

struct FakeHost {
    lang: Lang,
    settings: Mutex<Value>,
    refuse_write: AtomicBool,
    window: Option<WindowState>,
    fetches: Fetches,
    log: Option<Log>,
}

impl FakeHost {
    fn net(&self, signal: CancelToken) -> Net {
        Net {
            fetches: self.fetches.clone(),
            log: self.log.clone(),
            signal,
        }
    }
}

impl FreeAiHost for FakeHost {
    fn read_settings(&self) -> JsonValue {
        let stored = json_value_from_serde(&self.settings.lock().unwrap());
        normalize_ai_settings(None, Some(&stored), None)
    }

    fn write_settings(&self, settings: &JsonValue) -> bool {
        if self.refuse_write.load(Ordering::SeqCst) {
            return false;
        }
        let written = json_value_to_serde(settings);
        push(&self.log, json!(["writeSettings", written]));
        *self.settings.lock().unwrap() = written;
        true
    }

    fn ui_lang(&self) -> Lang {
        self.lang
    }

    fn window_state(&self, _view: ViewId) -> Option<WindowState> {
        self.window
    }

    fn window_command(&self, _view: ViewId, command: WindowCommand) {
        let name = match command {
            WindowCommand::Restore => "win.restore",
            WindowCommand::Show => "win.show",
            WindowCommand::Focus => "win.focus",
        };
        push(&self.log, json!([name]));
    }

    fn net(&self, signal: CancelToken) -> Box<dyn FreeConnectNet> {
        Box::new(self.net(signal))
    }

    fn open_router(
        &self,
        signal: CancelToken,
        _open_browser: OpenBrowser,
    ) -> Box<dyn OpenRouterHost> {
        Box::new(NoLoopback(self.net(signal)))
    }
}

pub fn insert(hosts: &mut shell_contract::Hosts, case: &Value, log: Option<Log>) {
    let scripted = &case["freeAi"];
    let window = scripted
        .get("window")
        .filter(|w| w.is_object())
        .map(|w| WindowState {
            destroyed: w["destroyed"].as_bool().unwrap_or(false),
            minimized: w["minimized"].as_bool().unwrap_or(false),
        });
    let host: FreeAiHostHandle = Arc::new(FakeHost {
        lang: normalize_lang(Some(case["lang"].as_str().unwrap_or("ko"))),
        settings: Mutex::new(if scripted["settings"].is_null() {
            json!({})
        } else {
            scripted["settings"].clone()
        }),
        refuse_write: AtomicBool::new(scripted["refuseWrite"].as_bool().unwrap_or(false)),
        window,
        fetches: Arc::new(Mutex::new(
            scripted["fetches"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into(),
        )),
        log,
    });
    hosts.insert(host);
    hosts.insert(crate::free_ai::factory());
}
