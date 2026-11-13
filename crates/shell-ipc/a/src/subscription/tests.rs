//! Behavior of the subscription port over the driver: a core thread that
//! queues jobs (the test thread), real worker threads and children, and a
//! fake net, shell and OS. The CLIs are never the machine's: statuses come
//! from a scripted detector, programs from a scripted finder.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread::{self, ThreadId};
use std::time::{Duration, Instant};

use jscompat::JsonValue;
use main_core::packages::ai_provider::subscription_ipc::SubscriptionIpc;
use main_core::packages::ai_provider::subscription_locate::SubscriptionProgram;
use main_core::packages::ai_provider::subscription_status::SubscriptionDetection;
use serde_json::{Value, json};
use shell_contract::hosts::{Hosts, OsShell};
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::ipc::{CallContext, EventSink, Responder, Sender, Target};
use shell_contract::runtime::{AppPaths, CancelToken, PathName, Services, Thread, Views, Workers};
use shell_contract::{IpcError, IpcValue, Surface};

use super::*;
use crate::runtime::testing::{FakeNet, Log};
use crate::secrets::{KeyPlace, OsSafeStorage, ShellSecretCodec};

type Job = Box<dyn FnOnce() + Send>;
type Reply = Result<IpcValue, IpcError>;
type Method = fn(&SubscriptionPort, &CallContext, Vec<IpcValue>, Responder);

struct Core {
    jobs: mpsc::Sender<Job>,
    owner: ThreadId,
}

impl Thread for Core {
    fn post(&self, job: Job) {
        let _ = self.jobs.send(job);
    }
    fn is_current(&self) -> bool {
        thread::current().id() == self.owner
    }
}

struct Threads;

impl Workers for Threads {
    fn spawn(&self, job: Job) {
        thread::spawn(job);
    }
}

struct NoViews;

impl Views for NoViews {
    fn sender_of(&self, _: ViewId) -> Option<Sender> {
        None
    }
    fn all(&self) -> Vec<Sender> {
        Vec::new()
    }
    fn on_destroyed(&self, _: Box<dyn Fn(ViewId) + Send + Sync>) {}
}

struct Dir(PathBuf);

impl AppPaths for Dir {
    fn path(&self, name: PathName) -> PathBuf {
        match name {
            PathName::Home => self.0.join("home"),
            PathName::Temp => self.0.join("tmp"),
            PathName::UserData => self.0.join("userData"),
            _ => self.0.clone(),
        }
    }
}

#[derive(Default)]
struct Events(Mutex<Vec<(Target, &'static str, Vec<IpcValue>)>>);

impl EventSink for Events {
    fn emit(&self, target: Target, channel: &'static str, args: Vec<IpcValue>) {
        self.0.lock().unwrap().push((target, channel, args));
    }
}

impl Events {
    fn on(&self, channel: &str) -> Vec<(Target, Vec<IpcValue>)> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, name, _)| *name == channel)
            .map(|(target, _, args)| (*target, args.clone()))
            .collect()
    }
}

#[derive(Default)]
struct FakeOs(Mutex<Vec<String>>);

impl OsShell for FakeOs {
    fn open_external(&self, url: &str) -> Result<(), String> {
        self.0.lock().unwrap().push(url.to_owned());
        Ok(())
    }
    fn open_path(&self, _: &std::path::Path) -> String {
        String::new()
    }
    fn show_item_in_folder(&self, _: &std::path::Path) {}
    fn trash_item(&self, _: &std::path::Path) -> Result<(), String> {
        Ok(())
    }
}

struct Shell;

impl SubscriptionShell for Shell {
    fn ui_lang(&self) -> String {
        "ko".into()
    }
    fn login_window_text(&self, lang: &str, provider: &str) -> JsonValue {
        jscompat::json_value_from_serde(&json!({ "title": format!("{provider} {lang}") }))
    }
    fn chat_gpt_sign_in_pages(&self, lang: &str) -> JsonValue {
        let page = |what: &str| json!({ "lang": lang, "title": what, "body": what });
        jscompat::json_value_from_serde(&json!({ "done": page("done"), "failed": page("failed") }))
    }
    fn signature_valid(&self, _: &str, _: &[u8], _: &[u8], _: &JsonValue) -> Result<bool, String> {
        Ok(true)
    }
}

/// The scripted CLIs: a detection per provider (not installed otherwise), a
/// program per provider (none otherwise), the models each lists
#[derive(Default)]
struct Stand {
    detections: Mutex<HashMap<String, SubscriptionDetection>>,
    programs: Mutex<HashMap<String, SubscriptionProgram>>,
    asked: Mutex<Vec<(String, Option<String>)>>,
}

impl SubscriptionStandIns for Stand {
    fn detect(&self, provider: &str, path: Option<&str>) -> Result<SubscriptionDetection, String> {
        self.asked
            .lock()
            .unwrap()
            .push((provider.to_owned(), path.map(str::to_owned)));
        Ok(self
            .detections
            .lock()
            .unwrap()
            .get(provider)
            .cloned()
            .unwrap_or_else(|| SubscriptionDetection::new(provider, "not-installed")))
    }
    fn list_models(&self, _: &str, _: Option<&str>) -> Result<Vec<JsonValue>, String> {
        Ok(Vec::new())
    }
    fn locate(
        &self,
        provider: &str,
        _: Option<&str>,
    ) -> Result<Option<SubscriptionProgram>, String> {
        Ok(self.programs.lock().unwrap().get(provider).cloned())
    }
}

fn detection(provider: &str, state: &str) -> SubscriptionDetection {
    let mut d = SubscriptionDetection::new(provider, state);
    if state == "ready" || state == "metered" {
        d.version = Some("1.2.3".into());
    }
    d
}

struct World {
    jobs: Receiver<Job>,
    dir: PathBuf,
    events: Arc<Events>,
    os: Arc<FakeOs>,
    stand: Arc<Stand>,
    net_log: Log,
    port: SubscriptionPort,
    shared: Rc<SubscriptionShared>,
    // keeps the driver (and its handlers) alive
    _driver: Driver,
}

fn world(name: &str, settings: Option<&str>, net: Value) -> World {
    let dir = std::env::temp_dir().join(format!(
        "seuoffice-subscription-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    for sub in ["home", "tmp", "userData"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    if let Some(settings) = settings {
        std::fs::write(dir.join("userData").join("ai-settings.json"), settings).unwrap();
    }
    let (tx, jobs) = mpsc::channel();
    let core: Arc<dyn Thread> = Arc::new(Core {
        jobs: tx,
        owner: thread::current().id(),
    });
    let events = Arc::new(Events::default());
    let services = Services {
        ui: core.clone(),
        core,
        workers: Arc::new(Threads),
        events: events.clone(),
        views: Arc::new(NoViews),
        paths: Arc::new(Dir(dir.clone())),
        hosts: Arc::new(Hosts::default()),
    };
    let net_log: Log = Arc::default();
    let driver = Driver::new(&services, FakeNet::new(&net, Some(net_log.clone())));
    let os = Arc::new(FakeOs::default());
    let stand = Arc::new(Stand::default());
    let shared = SubscriptionShared::build(Wiring {
        driver: driver.clone(),
        events: events.clone(),
        user_data: dir.join("userData"),
        codec: Arc::new(ShellSecretCodec::new(Arc::new(OsSafeStorage::new(
            KeyPlace {
                app_name: "seuoffice".into(),
                user_data: dir.join("userData"),
            },
        )))),
        shell: Arc::new(Shell),
        os: os.clone(),
        stand_ins: Some(stand.clone()),
        platform: None,
    });
    let port = SubscriptionPort::new(shared.clone(), driver.clone(), os.clone());
    World {
        jobs,
        dir,
        events,
        os,
        stand,
        net_log,
        port,
        shared,
        _driver: driver,
    }
}

fn cx() -> CallContext {
    CallContext {
        sender: Sender {
            view: ViewId(1),
            window: WindowId(1),
            surface: Surface::Shell,
        },
        request: None,
        cancel: CancelToken::default(),
    }
}

fn text(s: &str) -> IpcValue {
    IpcValue::String(s.into())
}

fn object(entries: Vec<(&str, IpcValue)>) -> IpcValue {
    IpcValue::Object(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
    )
}

fn field<'a>(value: &'a IpcValue, key: &str) -> Option<&'a IpcValue> {
    match value {
        IpcValue::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn state_of(statuses: &IpcValue, provider: &str) -> Option<String> {
    match field(field(statuses, provider)?, "state")? {
        IpcValue::String(s) => Some(s.clone()),
        _ => None,
    }
}

impl World {
    /// Runs the jobs posted to the core thread until `done` holds
    fn pump_until(&self, mut done: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(20);
        while !done() {
            assert!(Instant::now() < end, "timed out");
            if let Ok(job) = self.jobs.recv_timeout(Duration::from_millis(5)) {
                job();
            }
        }
    }

    /// Runs what is posted for a moment more (a check that was started and
    /// not waited for)
    fn settle(&self) {
        let end = Instant::now() + Duration::from_millis(300);
        while Instant::now() < end {
            if let Ok(job) = self.jobs.recv_timeout(Duration::from_millis(5)) {
                job();
            }
        }
    }

    fn call(&self, method: Method, args: Vec<IpcValue>) -> Reply {
        let slot: Arc<Mutex<Option<Reply>>> = Arc::default();
        let out = slot.clone();
        method(
            &self.port,
            &cx(),
            args,
            Responder::new(move |reply| *out.lock().unwrap() = Some(reply)),
        );
        self.pump_until(|| slot.lock().unwrap().is_some());
        let reply = slot.lock().unwrap().take().unwrap();
        reply
    }

    fn ok(&self, method: Method, args: Vec<IpcValue>) -> IpcValue {
        self.call(method, args).expect("answered")
    }

    fn settings(&self) -> Value {
        let text = std::fs::read_to_string(self.dir.join("userData").join("ai-settings.json"))
            .expect("the settings file");
        serde_json::from_str(&text).unwrap()
    }
}

fn provider(name: &str) -> Vec<IpcValue> {
    vec![object(vec![("provider", text(name))])]
}

#[test]
fn statuses_start_the_first_check_and_every_view_hears_the_result() {
    let w = world("statuses", None, json!({}));
    w.stand
        .detections
        .lock()
        .unwrap()
        .insert("claude-code".into(), detection("claude-code", "ready"));
    // nothing was checked yet: each provider reads `checking`
    let first = w.ok(SubscriptionPort::ai_subscription_statuses, vec![]);
    for id in ["claude-code", "codex", "chatgpt"] {
        assert_eq!(state_of(&first, id).as_deref(), Some("checking"), "{id}");
    }
    // the check runs now, off to the side; the answer arrives as an event
    w.pump_until(|| {
        w.events.on(CHANGED).iter().any(|(_, args)| {
            args.first().is_some_and(|s| {
                ["claude-code", "codex", "chatgpt"]
                    .iter()
                    .all(|id| state_of(s, id).as_deref() != Some("checking"))
            })
        })
    });
    let heard = w.events.on(CHANGED);
    assert!(heard.iter().all(|(target, _)| *target == Target::All));
    let again = w.ok(SubscriptionPort::ai_subscription_statuses, vec![]);
    assert_eq!(state_of(&again, "claude-code").as_deref(), Some("ready"));
    assert_eq!(
        field(field(&again, "claude-code").unwrap(), "version"),
        Some(&text("1.2.3"))
    );
    assert_eq!(state_of(&again, "codex").as_deref(), Some("not-installed"));
}

#[test]
fn recheck_asks_the_named_providers_again() {
    let w = world("recheck", None, json!({}));
    let all = w.ok(SubscriptionPort::ai_subscription_recheck, vec![]);
    assert_eq!(state_of(&all, "codex").as_deref(), Some("not-installed"));
    w.stand
        .detections
        .lock()
        .unwrap()
        .insert("codex".into(), detection("codex", "ready"));
    w.stand.asked.lock().unwrap().clear();
    let one = w.ok(
        SubscriptionPort::ai_subscription_recheck,
        vec![object(vec![(
            "providers",
            IpcValue::Array(vec![text("codex"), text("not-a-provider")]),
        )])],
    );
    assert_eq!(state_of(&one, "codex").as_deref(), Some("ready"));
    let asked: Vec<String> = w
        .stand
        .asked
        .lock()
        .unwrap()
        .iter()
        .map(|(p, _)| p.clone())
        .collect();
    assert_eq!(asked, vec!["codex".to_owned()]);
}

#[test]
fn a_configured_path_reaches_the_detector() {
    let w = world(
        "path",
        Some(r#"{"providers":{"codex":{"cliPath":"/opt/codex"}}}"#),
        json!({}),
    );
    w.ok(SubscriptionPort::ai_subscription_recheck, vec![]);
    let asked = w.stand.asked.lock().unwrap().clone();
    assert!(asked.contains(&("codex".to_owned(), Some("/opt/codex".to_owned()))));
}

#[test]
fn metered_use_anyway_is_remembered_in_the_settings_file() {
    let w = world("metered", None, json!({}));
    let mut metered = detection("claude-code", "metered");
    metered.login_method = Some("metered".into());
    metered.login_kind = Some("api-key".into());
    w.stand
        .detections
        .lock()
        .unwrap()
        .insert("claude-code".into(), metered);
    w.ok(SubscriptionPort::ai_subscription_recheck, vec![]);
    let accepted = w.ok(
        SubscriptionPort::ai_subscription_metered,
        vec![object(vec![
            ("provider", text("claude-code")),
            ("accepted", IpcValue::Bool(true)),
        ])],
    );
    assert_eq!(field(&accepted, "ok"), Some(&IpcValue::Bool(true)));
    let statuses = field(&accepted, "statuses").unwrap();
    assert_eq!(
        field(field(statuses, "claude-code").unwrap(), "meteredAccepted"),
        Some(&IpcValue::Bool(true))
    );
    assert_eq!(w.settings()["meteredAccepted"]["claude-code"], json!(true));
    assert_eq!(w.events.on(SETTINGS_CHANGED).len(), 1);
    // withdrawn again
    w.ok(
        SubscriptionPort::ai_subscription_metered,
        vec![object(vec![
            ("provider", text("claude-code")),
            ("accepted", IpcValue::Bool(false)),
        ])],
    );
    assert_eq!(w.settings()["meteredAccepted"]["claude-code"], json!(false));
}

#[test]
fn metered_needs_a_provider_and_a_real_boolean() {
    let w = world("metered-bad", None, json!({}));
    for payload in [
        object(vec![
            ("provider", text("bogus")),
            ("accepted", IpcValue::Bool(true)),
        ]),
        object(vec![
            ("provider", text("claude-code")),
            ("accepted", text("yes")),
        ]),
        object(vec![("provider", text("claude-code"))]),
    ] {
        let answer = w.ok(SubscriptionPort::ai_subscription_metered, vec![payload]);
        assert_eq!(field(&answer, "ok"), Some(&IpcValue::Bool(false)));
    }
    assert!(!w.dir.join("userData").join("ai-settings.json").exists());
}

#[test]
fn a_cli_turned_off_is_not_started_and_comes_back() {
    let w = world("off", None, json!({}));
    let off = w.ok(
        SubscriptionPort::ai_subscription_off,
        vec![object(vec![
            ("provider", text("codex")),
            ("off", IpcValue::Bool(true)),
        ])],
    );
    assert_eq!(field(&off, "ok"), Some(&IpcValue::Bool(true)));
    assert_eq!(
        state_of(field(&off, "statuses").unwrap(), "codex").as_deref(),
        Some("off")
    );
    assert_eq!(w.settings()["subscriptionOff"]["codex"], json!(true));
    // neither login, logout, install nor update start it
    for method in [
        SubscriptionPort::ai_subscription_login as Method,
        SubscriptionPort::ai_subscription_logout,
        SubscriptionPort::ai_subscription_install,
        SubscriptionPort::ai_subscription_update,
    ] {
        let answer = w.ok(method, provider("codex"));
        assert_eq!(field(&answer, "ok"), Some(&IpcValue::Bool(false)));
        assert_eq!(field(&answer, "reason"), Some(&text("invalid")));
    }
    // back on
    let on = w.ok(
        SubscriptionPort::ai_subscription_off,
        vec![object(vec![
            ("provider", text("codex")),
            ("off", IpcValue::Bool(false)),
        ])],
    );
    assert_eq!(field(&on, "ok"), Some(&IpcValue::Bool(true)));
    assert!(w.settings().get("subscriptionOff").is_none());
    assert_ne!(
        state_of(field(&on, "statuses").unwrap(), "codex").as_deref(),
        Some("off")
    );
}

#[test]
fn only_a_vendor_cli_can_be_turned_off() {
    let w = world("off-bad", None, json!({}));
    for payload in [
        object(vec![
            ("provider", text("chatgpt")),
            ("off", IpcValue::Bool(true)),
        ]),
        object(vec![("provider", text("codex")), ("off", text("true"))]),
        object(vec![
            ("provider", text("bogus")),
            ("off", IpcValue::Bool(true)),
        ]),
    ] {
        let answer = w.ok(SubscriptionPort::ai_subscription_off, vec![payload]);
        assert_eq!(field(&answer, "ok"), Some(&IpcValue::Bool(false)));
    }
    assert!(!w.dir.join("userData").join("ai-settings.json").exists());
}

#[test]
fn login_of_an_unknown_provider_is_invalid() {
    let w = world("login-bad", None, json!({}));
    for args in [provider("bogus"), vec![], vec![IpcValue::Null]] {
        let answer = w.ok(SubscriptionPort::ai_subscription_login, args);
        assert_eq!(field(&answer, "ok"), Some(&IpcValue::Bool(false)));
        assert_eq!(field(&answer, "reason"), Some(&text("invalid")));
    }
}

#[test]
fn login_without_the_program_says_so_and_leaves_no_login_running() {
    let w = world("login-missing", None, json!({}));
    let answer = w.ok(SubscriptionPort::ai_subscription_login, provider("codex"));
    assert_eq!(field(&answer, "ok"), Some(&IpcValue::Bool(false)));
    assert_eq!(field(&answer, "reason"), Some(&text("not-installed")));
    assert!(field(&answer, "installUrl").is_some());
    let statuses = w.ok(SubscriptionPort::ai_subscription_statuses, vec![]);
    assert!(field(field(&statuses, "codex").unwrap(), "signingIn").is_none());
}

#[cfg(unix)]
#[test]
fn a_login_that_ends_is_followed_by_a_check_of_its_own() {
    let w = world("login-run", None, json!({}));
    w.stand.programs.lock().unwrap().insert(
        "codex".into(),
        SubscriptionProgram {
            provider: "codex".into(),
            command: "/bin/sh".into(),
            // the CLI's own arguments follow as positional ones
            prefix_args: vec!["-c".into(), "exit 0".into()],
            env: Vec::new(),
            entry: "/bin/sh".into(),
            source: "path".into(),
        },
    );
    w.ok(SubscriptionPort::ai_subscription_recheck, vec![]);
    // the login the program completes: the detector now finds it signed in
    w.stand
        .detections
        .lock()
        .unwrap()
        .insert("codex".into(), detection("codex", "ready"));
    let answer = w.ok(SubscriptionPort::ai_subscription_login, provider("codex"));
    assert_eq!(field(&answer, "ok"), Some(&IpcValue::Bool(true)));
    // the program ends, the login ends, and the provider is looked at again
    w.pump_until(|| {
        let statuses = w.shared.ipc.borrow().ipc().is_some();
        statuses
            && w.events.on(CHANGED).iter().any(|(_, args)| {
                args.first()
                    .is_some_and(|s| state_of(s, "codex").as_deref() == Some("ready"))
            })
    });
    let statuses = w.ok(SubscriptionPort::ai_subscription_statuses, vec![]);
    assert_eq!(state_of(&statuses, "codex").as_deref(), Some("ready"));
    assert!(field(field(&statuses, "codex").unwrap(), "signingIn").is_none());
}

#[test]
fn cancelling_without_a_login_is_not_a_failure() {
    let w = world("cancel", None, json!({}));
    let answer = w.ok(
        SubscriptionPort::ai_subscription_cancel_login,
        provider("codex"),
    );
    assert_eq!(field(&answer, "ok"), Some(&IpcValue::Bool(true)));
    let bad = w.ok(
        SubscriptionPort::ai_subscription_cancel_login,
        provider("bogus"),
    );
    assert_eq!(field(&bad, "reason"), Some(&text("invalid")));
}

#[test]
fn logout_of_chatgpt_forgets_the_connection() {
    let w = world("logout", None, json!({}));
    let answer = w.ok(
        SubscriptionPort::ai_subscription_logout,
        provider("chatgpt"),
    );
    assert_eq!(field(&answer, "ok"), Some(&IpcValue::Bool(true)));
    // looked at again before the answer went back
    w.settle();
    assert!(
        w.stand
            .asked
            .lock()
            .unwrap()
            .iter()
            .any(|(p, _)| p == "chatgpt")
    );
    let bad = w.ok(SubscriptionPort::ai_subscription_logout, provider("bogus"));
    assert_eq!(field(&bad, "reason"), Some(&text("invalid")));
}

#[test]
fn install_and_update_are_for_vendor_clis_on_windows_only() {
    if cfg!(windows) {
        return;
    }
    let w = world("install", None, json!({}));
    for method in [
        SubscriptionPort::ai_subscription_install as Method,
        SubscriptionPort::ai_subscription_update,
    ] {
        let codex = w.ok(method, provider("codex"));
        assert_eq!(field(&codex, "ok"), Some(&IpcValue::Bool(false)));
        assert_eq!(field(&codex, "reason"), Some(&text("unsupported")));
        assert_eq!(
            field(&codex, "installUrl"),
            Some(&text("https://developers.openai.com/codex/cli"))
        );
        // ChatGPT has no program to install or update
        let chatgpt = w.ok(method, provider("chatgpt"));
        assert_eq!(field(&chatgpt, "reason"), Some(&text("invalid")));
        let bogus = w.ok(method, provider("bogus"));
        assert_eq!(field(&bogus, "reason"), Some(&text("invalid")));
    }
}

#[test]
fn the_codex_image_backend_is_loaded_in_this_process() {
    let w = world("image", None, json!({}));
    assert_eq!(
        w.ok(SubscriptionPort::ai_subscription_codex_image, vec![]),
        IpcValue::Bool(true)
    );
    w.shared
        .image
        .borrow_mut()
        .set_codex_image_generation_available(false);
    assert_eq!(
        w.ok(SubscriptionPort::ai_subscription_codex_image, vec![]),
        IpcValue::Bool(false)
    );
}

#[test]
fn install_help_opens_the_vendor_page_and_only_for_a_known_provider() {
    let w = world("help", None, json!({}));
    for (name, page) in [
        ("claude-code", Some("https://code.claude.com/docs/en/setup")),
        ("codex", Some("https://developers.openai.com/codex/cli")),
        ("chatgpt", Some("https://chatgpt.com/#settings/Usage")),
        ("bogus", None),
    ] {
        w.os.0.lock().unwrap().clear();
        let answer = w.ok(
            SubscriptionPort::home_open_subscription_install_help,
            vec![text(name)],
        );
        assert_eq!(answer, IpcValue::Undefined);
        let opened = w.os.0.lock().unwrap().clone();
        assert_eq!(
            opened,
            page.map(str::to_owned).into_iter().collect::<Vec<_>>(),
            "{name}"
        );
    }
    let none = w.ok(
        SubscriptionPort::home_open_subscription_install_help,
        vec![],
    );
    assert_eq!(none, IpcValue::Undefined);
    assert!(w.os.0.lock().unwrap().is_empty());
}

#[test]
fn the_chatgpt_sign_in_listens_on_this_pc_and_opens_the_system_browser() {
    let w = world(
        "chatgpt-login",
        None,
        json!({ "listen": { "port": 43111 } }),
    );
    let answer = w.ok(SubscriptionPort::ai_subscription_login, provider("chatgpt"));
    assert_eq!(field(&answer, "ok"), Some(&IpcValue::Bool(true)));
    w.pump_until(|| !w.os.0.lock().unwrap().is_empty());
    let opened = w.os.0.lock().unwrap().clone();
    assert!(opened[0].starts_with("https://"), "{opened:?}");
    assert!(opened[0].contains("43111"), "{opened:?}");
    let listened = w
        .net_log
        .lock()
        .unwrap()
        .iter()
        .any(|line| line[0] == json!("listen"));
    assert!(listened);
    // a press while it runs leaves it running
    let again = w.ok(SubscriptionPort::ai_subscription_login, provider("chatgpt"));
    assert_eq!(field(&again, "ok"), Some(&IpcValue::Bool(true)));
    let mid = w.ok(SubscriptionPort::ai_subscription_statuses, vec![]);
    assert_eq!(
        field(field(&mid, "chatgpt").unwrap(), "signingIn"),
        Some(&text("browser"))
    );
    // cancelled: the server closes and the card is back to its button
    let cancelled = w.ok(
        SubscriptionPort::ai_subscription_cancel_login,
        provider("chatgpt"),
    );
    assert_eq!(field(&cancelled, "ok"), Some(&IpcValue::Bool(true)));
    w.pump_until(|| {
        w.net_log
            .lock()
            .unwrap()
            .iter()
            .any(|line| line[0] == json!("closeServer"))
    });
    let after = w.ok(SubscriptionPort::ai_subscription_statuses, vec![]);
    assert!(field(field(&after, "chatgpt").unwrap(), "signingIn").is_none());
}

#[test]
fn the_channels_of_the_handlers_are_the_ports_channels() {
    let handled: Vec<&str> = <dyn Subscription as crate::port::Port>::CHANNELS
        .iter()
        .map(|c| c.name)
        .filter(|n| n.starts_with("ai:subscription-") && *n != CHANGED)
        .collect();
    let mut ipc: Vec<&str> = SubscriptionIpc::channels();
    let mut handled = handled;
    ipc.sort_unstable();
    handled.sort_unstable();
    assert_eq!(ipc, handled);
}
