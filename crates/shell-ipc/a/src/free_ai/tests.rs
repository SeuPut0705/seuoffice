//! Behavior of the free AI port over fake hosts: what each channel answers,
//! what is written to the settings, which window is raised, which address is
//! opened, and what a second sign-in or a cancel does to the one waiting.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use jscompat::JsonValue;
use main_core::packages::ai_provider::free_ai_browser::{GEMINI_FREE_MODEL, free_ai_key_page};
use main_core::packages::ai_provider::free_connect::{
    CodeWait, FetchRequest, FetchResponse, FreeConnectNet, OpenRouterHost,
};
use shell_contract::hosts::{Hosts, OsShell};
use shell_contract::ipc::{CallContext, EventSink, Sender, Target};
use shell_contract::provided::Provided;
use shell_contract::runtime::{AppPaths, CancelToken, PathName, Services, Thread, Views, Workers};
use shell_contract::{IpcError, Surface, ViewId, WindowId};

use super::*;

const VIEW: ViewId = ViewId(5);

thread_local! {
    static PORT: RefCell<Option<Rc<dyn FreeAi>>> = const { RefCell::new(None) };
}

struct Inline;

impl Thread for Inline {
    fn post(&self, job: Box<dyn FnOnce() + Send>) {
        job()
    }
    fn is_current(&self) -> bool {
        false
    }
}

impl Workers for Inline {
    fn spawn(&self, job: Box<dyn FnOnce() + Send>) {
        job()
    }
}

impl Views for Inline {
    fn sender_of(&self, _: ViewId) -> Option<Sender> {
        None
    }
    fn all(&self) -> Vec<Sender> {
        Vec::new()
    }
    fn on_destroyed(&self, _: Box<dyn Fn(ViewId) + Send + Sync>) {}
}

struct NoPaths;

impl AppPaths for NoPaths {
    fn path(&self, _: PathName) -> PathBuf {
        std::env::temp_dir()
    }
}

struct NoEvents;

impl EventSink for NoEvents {
    fn emit(&self, _: Target, _: &'static str, _: Vec<IpcValue>) {}
}

#[derive(Default)]
struct FakeOs {
    opened: Mutex<Vec<String>>,
    refuse: AtomicBool,
}

impl OsShell for FakeOs {
    fn open_external(&self, url: &str) -> Result<(), String> {
        if self.refuse.load(Ordering::SeqCst) {
            return Err("no browser".into());
        }
        self.opened.lock().unwrap().push(url.to_owned());
        Ok(())
    }
    fn open_path(&self, _: &Path) -> String {
        String::new()
    }
    fn show_item_in_folder(&self, _: &Path) {}
    fn trash_item(&self, _: &Path) -> Result<(), String> {
        Ok(())
    }
}

type Script = Arc<Mutex<VecDeque<Result<FetchResponse, String>>>>;

struct Net {
    script: Script,
    requests: Arc<Mutex<Vec<FetchRequest>>>,
    signal: CancelToken,
}

impl FreeConnectNet for Net {
    fn fetch(&mut self, request: &FetchRequest) -> Result<FetchResponse, String> {
        self.requests.lock().unwrap().push(request.clone());
        self.script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| Err("nothing scripted".into()))
    }
    fn signal_aborted(&self) -> bool {
        self.signal.is_cancelled()
    }
}

/// The browser's way back: the query it calls the loopback server with, and
/// what the test does while the sign-in waits
struct Router {
    net: Net,
    open_browser: OpenBrowser,
    callback: Option<String>,
    while_waiting: Option<Box<dyn FnOnce() + Send>>,
}

impl FreeConnectNet for Router {
    fn fetch(&mut self, request: &FetchRequest) -> Result<FetchResponse, String> {
        self.net.fetch(request)
    }
    fn signal_aborted(&self) -> bool {
        self.net.signal_aborted()
    }
}

impl OpenRouterHost for Router {
    fn random_bytes(&mut self) -> [u8; 32] {
        [7; 32]
    }
    fn listen(&mut self) -> Result<f64, String> {
        Ok(5555.0)
    }
    fn open_browser(&mut self, url: &str) -> Result<bool, String> {
        (self.open_browser)(url)
    }
    fn start_timer(&mut self, _timeout_ms: f64) {}
    fn await_outcome(&mut self, wait: &mut CodeWait) {
        if let Some(act) = self.while_waiting.take() {
            act();
        }
        if self.net.signal_aborted() {
            wait.abort();
        }
        if let Some(query) = self.callback.take() {
            wait.handle("GET", Some(&query)).unwrap();
        }
    }
    fn close_servers(&mut self) {}
}

/// A sign-in's browser callback and the test's step while it waits
type SignIn = (Option<String>, Option<Box<dyn FnOnce() + Send>>);

struct FakeHost {
    settings: Mutex<JsonValue>,
    writes: Mutex<Vec<JsonValue>>,
    refuse_write: AtomicBool,
    lang: Mutex<Lang>,
    window: Mutex<Option<WindowState>>,
    commands: Mutex<Vec<(ViewId, WindowCommand)>>,
    script: Script,
    requests: Arc<Mutex<Vec<FetchRequest>>>,
    /// per sign-in, in order: the browser's callback and the test's step while it waits
    sign_ins: Mutex<VecDeque<SignIn>>,
    signals: Mutex<Vec<CancelToken>>,
}

impl FreeAiHost for FakeHost {
    fn read_settings(&self) -> JsonValue {
        self.settings.lock().unwrap().clone()
    }
    fn write_settings(&self, settings: &JsonValue) -> bool {
        if self.refuse_write.load(Ordering::SeqCst) {
            return false;
        }
        self.writes.lock().unwrap().push(settings.clone());
        *self.settings.lock().unwrap() = settings.clone();
        true
    }
    fn ui_lang(&self) -> Lang {
        *self.lang.lock().unwrap()
    }
    fn window_state(&self, _view: ViewId) -> Option<WindowState> {
        *self.window.lock().unwrap()
    }
    fn window_command(&self, view: ViewId, command: WindowCommand) {
        self.commands.lock().unwrap().push((view, command));
    }
    fn net(&self, signal: CancelToken) -> Box<dyn FreeConnectNet> {
        Box::new(Net {
            script: self.script.clone(),
            requests: self.requests.clone(),
            signal,
        })
    }
    fn open_router(
        &self,
        signal: CancelToken,
        open_browser: OpenBrowser,
    ) -> Box<dyn OpenRouterHost> {
        self.signals.lock().unwrap().push(signal.clone());
        let (callback, while_waiting) = self
            .sign_ins
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or((None, None));
        Box::new(Router {
            net: Net {
                script: self.script.clone(),
                requests: self.requests.clone(),
                signal,
            },
            open_browser,
            callback,
            while_waiting,
        })
    }
}

struct Rig {
    host: Arc<FakeHost>,
    os: Arc<FakeOs>,
    port: Rc<dyn FreeAi>,
}

fn rig() -> Rig {
    let host = Arc::new(FakeHost {
        settings: Mutex::new(
            jscompat::json_parse(
                r#"{"provider":"auto","providers":{"openrouter":{"apiKey":"sk-or-old"}}}"#,
            )
            .unwrap(),
        ),
        writes: Mutex::default(),
        refuse_write: AtomicBool::new(false),
        lang: Mutex::new(Lang::En),
        window: Mutex::new(Some(WindowState {
            destroyed: false,
            minimized: true,
        })),
        commands: Mutex::default(),
        script: Arc::default(),
        requests: Arc::default(),
        sign_ins: Mutex::default(),
        signals: Mutex::default(),
    });
    let os = Arc::new(FakeOs::default());
    let mut hosts = Hosts::default();
    let handle: FreeAiHostHandle = host.clone();
    hosts.insert(handle);
    let os_host: OsShellHost = os.clone();
    hosts.insert(os_host);
    let inline = Arc::new(Inline);
    let services = Services {
        ui: inline.clone(),
        core: inline.clone(),
        workers: inline.clone(),
        events: Arc::new(NoEvents),
        views: inline,
        paths: Arc::new(NoPaths),
        hosts: Arc::new(hosts),
    };
    let port = (factory().0)(&services, &Rc::new(Provided::default())).unwrap();
    PORT.with(|p| *p.borrow_mut() = Some(port.clone()));
    Rig { host, os, port }
}

fn context() -> CallContext {
    CallContext {
        sender: Sender {
            view: VIEW,
            window: WindowId(2),
            surface: Surface::Docs,
        },
        request: None,
        cancel: CancelToken::default(),
    }
}

fn call(f: impl FnOnce(&CallContext, Responder)) -> Result<IpcValue, IpcError> {
    let out = Arc::new(Mutex::new(None));
    let slot = out.clone();
    f(
        &context(),
        Responder::new(move |r| *slot.lock().unwrap() = Some(r)),
    );
    out.lock().unwrap().take().expect("answered")
}

fn ipc(value: serde_json::Value) -> IpcValue {
    match value {
        serde_json::Value::Null => IpcValue::Null,
        serde_json::Value::Bool(b) => IpcValue::Bool(b),
        serde_json::Value::Number(n) => IpcValue::Number(n.as_f64().unwrap()),
        serde_json::Value::String(s) => IpcValue::String(s),
        serde_json::Value::Array(a) => IpcValue::Array(a.into_iter().map(ipc).collect()),
        serde_json::Value::Object(o) => {
            IpcValue::Object(o.into_iter().map(|(k, v)| (k, ipc(v))).collect())
        }
    }
}

fn sv(value: &IpcValue) -> serde_json::Value {
    match value {
        IpcValue::Undefined => serde_json::json!("<undefined>"),
        IpcValue::Null => serde_json::Value::Null,
        IpcValue::Bool(b) => serde_json::json!(b),
        IpcValue::Number(n) if n.fract() == 0.0 => serde_json::json!(*n as i64),
        IpcValue::Number(n) => serde_json::json!(n),
        IpcValue::String(s) => serde_json::json!(s),
        IpcValue::Array(items) => items.iter().map(sv).collect(),
        IpcValue::Object(entries) => entries
            .iter()
            .map(|(k, v)| (k.clone(), sv(v)))
            .collect::<serde_json::Map<_, _>>()
            .into(),
        other => panic!("{other:?}"),
    }
}

fn response(status: u16, json: serde_json::Value) -> Result<FetchResponse, String> {
    Ok(FetchResponse {
        status,
        opaque_redirect: false,
        location: None,
        json: Ok(jscompat::json_parse(&json.to_string()).unwrap()),
    })
}

fn script(r: &Rig, answers: Vec<Result<FetchResponse, String>>) {
    r.host.script.lock().unwrap().extend(answers);
}

/// The settings as they were written last, as JSON
fn written(r: &Rig) -> serde_json::Value {
    let last = r
        .host
        .writes
        .lock()
        .unwrap()
        .last()
        .cloned()
        .expect("a write");
    serde_json::from_str(&jscompat::json_stringify(&last)).unwrap()
}

macro_rules! invoke {
    ($port:expr, $method:ident $(, $arg:expr)* $(,)?) => {
        call(|cx, re| $port.$method(cx, vec![$($arg),*], re))
    };
}

const SIGN_IN_OK: [&str; 2] = ["/callback?code=abc", "/callback?code=def"];

fn models() -> serde_json::Value {
    serde_json::json!({"data": [
        {"id": "short:free", "supported_parameters": ["tools"], "context_length": 8000},
        {"id": "long:free", "supported_parameters": ["tools"], "context_length": 128000},
        {"id": "no-tools:free", "supported_parameters": [], "context_length": 900000},
    ]})
}

#[test]
fn a_browser_sign_in_saves_the_key_in_the_main_process_and_raises_the_window() {
    let r = rig();
    r.host
        .sign_ins
        .lock()
        .unwrap()
        .push_back((Some(SIGN_IN_OK[0].into()), None));
    script(
        &r,
        vec![
            response(200, serde_json::json!({"key": " sk-or-new "})),
            response(200, models()),
        ],
    );
    let answer = invoke!(
        r.port,
        ai_free_connect,
        ipc(serde_json::json!({"provider": "openrouter"}))
    )
    .unwrap();
    // the renderer is told the provider and the model, never the key
    assert_eq!(
        sv(&answer),
        serde_json::json!({"ok": true, "provider": "openrouter", "model": "long:free"})
    );
    let settings = written(&r);
    assert_eq!(settings["providers"]["openrouter"]["apiKey"], "sk-or-new");
    assert_eq!(settings["providers"]["openrouter"]["model"], "long:free");
    // the code was traded at OpenRouter with the PKCE verifier
    let requests = r.host.requests.lock().unwrap();
    assert_eq!(requests[0].url, "https://openrouter.ai/api/v1/auth/keys");
    let body: serde_json::Value = serde_json::from_str(requests[0].body.as_ref().unwrap()).unwrap();
    assert_eq!(body["code"], "abc");
    assert_eq!(body["code_challenge_method"], "S256");
    // the browser was sent to OpenRouter's page, calling back on the loopback port
    let opened = r.os.opened.lock().unwrap();
    assert!(
        opened[0].starts_with(
            "https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A5555%2Fcallback"
        ),
        "{}",
        opened[0]
    );
    // the user is still in the browser: the minimized window comes back
    assert_eq!(
        *r.host.commands.lock().unwrap(),
        vec![
            (VIEW, WindowCommand::Restore),
            (VIEW, WindowCommand::Show),
            (VIEW, WindowCommand::Focus),
        ]
    );
}

#[test]
fn a_sign_in_the_user_denied_or_that_no_browser_took_saves_nothing() {
    let r = rig();
    // the browser comes back without a code
    r.host
        .sign_ins
        .lock()
        .unwrap()
        .push_back((Some("/callback?error=access_denied".into()), None));
    let denied = invoke!(
        r.port,
        ai_free_connect,
        ipc(serde_json::json!({"provider": "openrouter"}))
    )
    .unwrap();
    assert_eq!(
        sv(&denied),
        serde_json::json!({"ok": false, "reason": "denied"})
    );
    // no browser took the address
    r.os.refuse.store(true, Ordering::SeqCst);
    r.host.sign_ins.lock().unwrap().push_back((None, None));
    let refused = invoke!(
        r.port,
        ai_free_connect,
        ipc(serde_json::json!({"provider": "openrouter"}))
    )
    .unwrap();
    assert_eq!(
        sv(&refused),
        serde_json::json!({"ok": false, "reason": "network"})
    );
    assert!(r.host.writes.lock().unwrap().is_empty());
}

#[test]
fn a_connection_the_settings_refuse_is_a_network_failure() {
    let r = rig();
    r.host.refuse_write.store(true, Ordering::SeqCst);
    script(&r, vec![response(200, serde_json::json!({"data": []}))]);
    let answer = invoke!(
        r.port,
        ai_free_connect,
        ipc(serde_json::json!({"provider": "gemini", "apiKey": "AIzaSyExampleExampleExample1"}))
    )
    .unwrap();
    assert_eq!(
        sv(&answer),
        serde_json::json!({"ok": false, "reason": "network"})
    );
}

#[test]
fn a_pasted_gemini_key_is_checked_by_listing_models_and_saved() {
    let r = rig();
    script(&r, vec![response(200, serde_json::json!({"models": []}))]);
    let answer = invoke!(
        r.port,
        ai_free_connect,
        ipc(serde_json::json!({"provider": "gemini", "apiKey": " AIzaSyExampleExampleExample1 "}))
    )
    .unwrap();
    assert_eq!(
        sv(&answer),
        serde_json::json!({"ok": true, "provider": "gemini", "model": GEMINI_FREE_MODEL})
    );
    assert_eq!(
        written(&r)["providers"]["gemini"]["apiKey"],
        "AIzaSyExampleExampleExample1"
    );
    let requests = r.host.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].headers,
        vec![(
            "x-goog-api-key".to_owned(),
            "AIzaSyExampleExampleExample1".to_owned()
        )]
    );
    // a key Google refuses
    drop(requests);
    script(&r, vec![response(401, serde_json::json!({}))]);
    let refused = invoke!(
        r.port,
        ai_free_connect,
        ipc(serde_json::json!({"provider": "gemini", "apiKey": "AIzaSyExampleExampleExample2"}))
    )
    .unwrap();
    assert_eq!(
        sv(&refused),
        serde_json::json!({"ok": false, "reason": "invalid"})
    );
}

#[test]
fn a_key_that_does_not_look_like_one_never_reaches_the_network() {
    let r = rig();
    for input in [
        serde_json::json!({"provider": "gemini", "apiKey": "has spaces in it, so no"}),
        serde_json::json!({"provider": "gemini"}),
    ] {
        let answer = invoke!(r.port, ai_free_connect, ipc(input)).unwrap();
        assert_eq!(
            sv(&answer),
            serde_json::json!({"ok": false, "reason": "invalid"})
        );
    }
    assert!(r.host.requests.lock().unwrap().is_empty());
}

#[test]
fn an_unknown_provider_is_invalid() {
    let r = rig();
    for input in [
        ipc(serde_json::json!({"provider": "openai"})),
        ipc(serde_json::json!(null)),
        IpcValue::Undefined,
    ] {
        let answer = invoke!(r.port, ai_free_connect, input).unwrap();
        assert_eq!(
            sv(&answer),
            serde_json::json!({"ok": false, "reason": "invalid"})
        );
    }
}

#[test]
fn cancel_ends_the_waiting_sign_in_without_raising_the_window() {
    let r = rig();
    let cancel: Box<dyn FnOnce() + Send> = Box::new(|| {
        PORT.with(|p| {
            let port = p.borrow().clone().unwrap();
            assert_eq!(
                invoke!(port, ai_free_connect_cancel).unwrap(),
                IpcValue::Undefined
            );
        })
    });
    r.host
        .sign_ins
        .lock()
        .unwrap()
        .push_back((None, Some(cancel)));
    let answer = invoke!(
        r.port,
        ai_free_connect,
        ipc(serde_json::json!({"provider": "openrouter"}))
    )
    .unwrap();
    assert_eq!(
        sv(&answer),
        serde_json::json!({"ok": false, "reason": "cancelled"})
    );
    assert!(r.host.signals.lock().unwrap()[0].is_cancelled());
    // a cancelled sign-in brings nobody back
    assert!(r.host.commands.lock().unwrap().is_empty());
    assert!(r.host.writes.lock().unwrap().is_empty());
    // with nothing waiting a cancel does nothing
    assert_eq!(
        invoke!(r.port, ai_free_connect_cancel).unwrap(),
        IpcValue::Undefined
    );
}

#[test]
fn a_new_sign_in_replaces_the_one_waiting() {
    let r = rig();
    let second: Box<dyn FnOnce() + Send> = Box::new(|| {
        PORT.with(|p| {
            let port = p.borrow().clone().unwrap();
            let answer = invoke!(
                port,
                ai_free_connect,
                ipc(serde_json::json!({"provider": "openrouter"}))
            )
            .unwrap();
            assert_eq!(
                sv(&answer),
                serde_json::json!({"ok": true, "provider": "openrouter", "model": "long:free"})
            );
        })
    });
    {
        let mut sign_ins = r.host.sign_ins.lock().unwrap();
        sign_ins.push_back((None, Some(second)));
        sign_ins.push_back((Some(SIGN_IN_OK[1].into()), None));
    }
    script(
        &r,
        vec![
            response(200, serde_json::json!({"key": "sk-or-second"})),
            response(200, models()),
        ],
    );
    let first = invoke!(
        r.port,
        ai_free_connect,
        ipc(serde_json::json!({"provider": "openrouter"}))
    )
    .unwrap();
    assert_eq!(
        sv(&first),
        serde_json::json!({"ok": false, "reason": "cancelled"})
    );
    let signals = r.host.signals.lock().unwrap();
    assert!(signals[0].is_cancelled());
    assert!(!signals[1].is_cancelled());
    assert_eq!(
        written(&r)["providers"]["openrouter"]["apiKey"],
        "sk-or-second"
    );
}

#[test]
fn disconnect_removes_the_connection_of_a_known_provider_only() {
    let r = rig();
    assert_eq!(
        invoke!(
            r.port,
            ai_free_disconnect,
            ipc(serde_json::json!({"provider": "openrouter"}))
        )
        .unwrap(),
        IpcValue::Undefined
    );
    // the key is gone (the model is the provider's default again)
    assert_eq!(written(&r)["providers"]["openrouter"]["apiKey"], "");
    let writes = r.host.writes.lock().unwrap().len();
    invoke!(
        r.port,
        ai_free_disconnect,
        ipc(serde_json::json!({"provider": "openai"}))
    )
    .unwrap();
    invoke!(r.port, ai_free_disconnect).unwrap();
    assert_eq!(r.host.writes.lock().unwrap().len(), writes);
}

#[test]
fn quota_reads_todays_free_requests_of_the_stored_openrouter_key() {
    let r = rig();
    script(
        &r,
        vec![response(
            200,
            serde_json::json!({"data": {"free_model_daily_requests": {"used": 3, "limit": 50, "remaining": 47}}}),
        )],
    );
    let quota = invoke!(
        r.port,
        ai_free_quota,
        ipc(serde_json::json!({"provider": "openrouter"}))
    )
    .unwrap();
    assert_eq!(
        sv(&quota),
        serde_json::json!({"used": 3, "limit": 50, "remaining": 47})
    );
    let requests = r.host.requests.lock().unwrap();
    assert_eq!(requests[0].url, "https://openrouter.ai/api/v1/key");
    assert_eq!(
        requests[0].headers,
        vec![("Authorization".to_owned(), "Bearer sk-or-old".to_owned())]
    );
    drop(requests);
    // Gemini has no endpoint that tells it; OpenRouter not saying is null too
    assert_eq!(
        invoke!(
            r.port,
            ai_free_quota,
            ipc(serde_json::json!({"provider": "gemini"}))
        )
        .unwrap(),
        IpcValue::Null
    );
    script(&r, vec![response(500, serde_json::json!({}))]);
    assert_eq!(
        invoke!(
            r.port,
            ai_free_quota,
            ipc(serde_json::json!({"provider": "openrouter"}))
        )
        .unwrap(),
        IpcValue::Null
    );
    assert_eq!(r.host.requests.lock().unwrap().len(), 2);
}

#[test]
fn open_key_page_opens_the_providers_page_when_it_is_safe() {
    let r = rig();
    assert_eq!(
        invoke!(
            r.port,
            ai_free_open_key_page,
            ipc(serde_json::json!({"provider": "gemini"}))
        )
        .unwrap(),
        IpcValue::Undefined
    );
    assert_eq!(
        *r.os.opened.lock().unwrap(),
        vec![free_ai_key_page("gemini").unwrap().to_owned()]
    );
    // an unknown provider opens nothing, and a browser that refuses is no failure
    invoke!(
        r.port,
        ai_free_open_key_page,
        ipc(serde_json::json!({"provider": "openai"}))
    )
    .unwrap();
    r.os.refuse.store(true, Ordering::SeqCst);
    assert_eq!(
        invoke!(
            r.port,
            ai_free_open_key_page,
            ipc(serde_json::json!({"provider": "openrouter"}))
        )
        .unwrap(),
        IpcValue::Undefined
    );
    assert_eq!(r.os.opened.lock().unwrap().len(), 1);
}
