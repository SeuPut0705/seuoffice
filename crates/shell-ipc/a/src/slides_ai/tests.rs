//! Behavior of the slides AI ports over fake hosts and the in-memory D1
//! ([`World`]): what each channel answers, which files it writes, what the
//! tools and the download are asked, and when a call is aborted.

use std::cell::RefCell;
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use jscompat::{JsonValue, json_stringify};
use main_core::packages::ai_provider::settings_secrets::AiSecretCodec;
use main_core::packages::i18n::Lang;
use main_core::slides::ai_ipc::{ImageDecoder, MediaToolOptions, NativeImage, PictureTicket};
use main_core::slides::ai_proposal::{RunBeginTicket, RunBeginWake, SettleStep};
use shell_contract::hosts::{Hosts, OsShell};
use shell_contract::ipc::{CallContext, EventSink, Sender, Target};
use shell_contract::provided::Provided;
use shell_contract::runtime::{AppPaths, CancelToken, PathName, Services, Thread, Views, Workers};
use shell_contract::slides::{SlidesDocument, SlidesDocuments};
use shell_contract::{IpcError, IpcValue, Surface, ViewId, WindowId};

use super::sessions::{SessionsBuilder, SlidesAiSessions};
use super::world::World;
use super::*;
use crate::ports::{SlidesAi, SlidesAiProposal};
use crate::shell_ai_prefs::ShellUi;

const VIEW: ViewId = ViewId(5);
const PNG: [u8; 12] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];

thread_local! {
    static WORLD: Rc<World> = World::new();
    static SCRIPTED: RefCell<Option<Rc<dyn SlidesAiSessions>>> = const { RefCell::new(None) };
    static PROVIDED: RefCell<Option<Rc<Provided>>> = const { RefCell::new(None) };
}

fn world() -> Rc<World> {
    WORLD.with(Rc::clone)
}

// ---- fakes ----

/// A hook run before each spawn, given the spawn count
type SpawnHook = Box<dyn Fn(usize) + Send + Sync>;

/// Runs every job at once; `spawn`s are counted and may run a hook first
#[derive(Default)]
struct Inline {
    spawns: AtomicUsize,
    before_spawn: Mutex<Option<SpawnHook>>,
}

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
        let n = self.spawns.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(hook) = self.before_spawn.lock().unwrap().as_ref() {
            hook(n);
        }
        job()
    }
}

/// A callback told when a view is destroyed
type ViewListener = Box<dyn Fn(ViewId) + Send + Sync>;

#[derive(Default)]
struct TestViews {
    gone: Mutex<HashSet<u32>>,
    listeners: Mutex<Vec<ViewListener>>,
}

impl TestViews {
    fn destroy(&self, view: ViewId) {
        self.gone.lock().unwrap().insert(view.0);
        for listener in self.listeners.lock().unwrap().iter() {
            listener(view);
        }
    }
}

impl Views for TestViews {
    fn sender_of(&self, view: ViewId) -> Option<Sender> {
        (!self.gone.lock().unwrap().contains(&view.0)).then_some(Sender {
            view,
            window: WindowId(2),
            surface: Surface::Slides,
        })
    }
    fn all(&self) -> Vec<Sender> {
        Vec::new()
    }
    fn on_destroyed(&self, listener: Box<dyn Fn(ViewId) + Send + Sync>) {
        self.listeners.lock().unwrap().push(listener);
    }
}

struct Dir(PathBuf);

impl AppPaths for Dir {
    fn path(&self, name: PathName) -> PathBuf {
        match name {
            PathName::Temp => self.0.join("tmp"),
            PathName::Home => self.0.join("home"),
            _ => self.0.clone(),
        }
    }
}

struct NoEvents;

impl EventSink for NoEvents {
    fn emit(&self, _target: Target, _channel: &'static str, _args: Vec<IpcValue>) {}
}

struct Ui(Mutex<String>);

impl ShellUi for Ui {
    fn document_locale(&self) -> String {
        self.0.lock().unwrap().clone()
    }
    fn show_home_tab(&self) {}
}

struct NoOs;

impl OsShell for NoOs {
    fn open_external(&self, _url: &str) -> Result<(), String> {
        Ok(())
    }
    fn open_path(&self, _path: &Path) -> String {
        String::new()
    }
    fn show_item_in_folder(&self, _path: &Path) {}
    fn trash_item(&self, _path: &Path) -> Result<(), String> {
        Ok(())
    }
}

/// `nativeImage`: the bytes are the PNG; the size is the first two bytes
struct Decoder;
struct Img(Vec<u8>);

impl NativeImage for Img {
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    fn to_png(&self) -> Vec<u8> {
        self.0.clone()
    }
    fn size(&self) -> (f64, f64) {
        (f64::from(self.0[0]), f64::from(self.0[1]))
    }
}

impl ImageDecoder for Decoder {
    fn create_from_buffer(&self, bytes: &[u8]) -> Box<dyn NativeImage> {
        Box::new(Img(bytes.to_vec()))
    }
}

/// One call of `generateImageTool` / `analyzeMediaTool`
#[derive(Debug, PartialEq)]
struct ToolCall {
    tool: &'static str,
    settings_path: String,
    request: String,
    media_roots: Vec<String>,
    statuses: String,
    /// the signal was already aborted when the tool started
    aborted: bool,
    /// ... and when it ended
    aborted_at_end: bool,
}

struct FakeHost {
    lang: Mutex<Lang>,
    statuses: JsonValue,
    capabilities: Mutex<Vec<(String, String)>>,
    tools: Mutex<Vec<ToolCall>>,
    tool_answer: Mutex<Result<JsonValue, JsonValue>>,
    during_tool: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    fetches: Mutex<Vec<String>>,
    fetch_answer: Mutex<Option<Vec<u8>>>,
    during_fetch: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    decoder: Decoder,
}

impl FakeHost {
    fn tool(
        &self,
        tool: &'static str,
        settings_path: &str,
        request: &JsonValue,
        options: &MediaToolOptions,
        signal: &CancelToken,
    ) -> Result<JsonValue, JsonValue> {
        let aborted = signal.is_cancelled();
        if let Some(hook) = self.during_tool.lock().unwrap().as_ref() {
            hook();
        }
        let statuses = main_core::packages::ai_provider::jsval::prop(&options.context, "statuses");
        self.tools.lock().unwrap().push(ToolCall {
            tool,
            settings_path: settings_path.to_owned(),
            request: json_stringify(request),
            media_roots: options.media_roots.clone(),
            statuses: json_stringify(statuses.unwrap_or(&JsonValue::Null)),
            aborted,
            aborted_at_end: signal.is_cancelled(),
        });
        self.tool_answer.lock().unwrap().clone()
    }
}

impl SlidesAiHost for FakeHost {
    fn ui_lang(&self) -> Lang {
        *self.lang.lock().unwrap()
    }
    fn secret_codec(&self) -> Option<&dyn AiSecretCodec> {
        None
    }
    fn shared_subscription_statuses(&self) -> JsonValue {
        self.statuses.clone()
    }
    fn ai_tool_capabilities(&self, settings: &JsonValue, context: &JsonValue) -> JsonValue {
        self.capabilities
            .lock()
            .unwrap()
            .push((json_stringify(settings), json_stringify(context)));
        jscompat::json_parse(r#"{"webSearch":{"available":true}}"#).unwrap()
    }
    fn generate_image(
        &self,
        settings_path: &str,
        request: &JsonValue,
        options: &MediaToolOptions,
        signal: &CancelToken,
    ) -> Result<JsonValue, JsonValue> {
        self.tool("generateImageTool", settings_path, request, options, signal)
    }
    fn analyze_media(
        &self,
        settings_path: &str,
        request: &JsonValue,
        options: &MediaToolOptions,
        signal: &CancelToken,
    ) -> Result<JsonValue, JsonValue> {
        self.tool("analyzeMediaTool", settings_path, request, options, signal)
    }
    fn fetch_remote_image(&self, url: &str) -> Option<Vec<u8>> {
        self.fetches.lock().unwrap().push(url.to_owned());
        if let Some(hook) = self.during_fetch.lock().unwrap().as_ref() {
            hook();
        }
        self.fetch_answer.lock().unwrap().clone()
    }
    fn image_decoder(&self) -> &dyn ImageDecoder {
        &self.decoder
    }
}

struct Rig {
    dir: PathBuf,
    inline: Arc<Inline>,
    views: Arc<TestViews>,
    host: Arc<FakeHost>,
    ui: Arc<Ui>,
    ai: Rc<dyn SlidesAi>,
    proposal: Rc<dyn SlidesAiProposal>,
}

fn rig(name: &str) -> Rig {
    rig_over(name, None)
}

/// `sessions`: what D1 provides in place of the in-memory world
fn rig_over(name: &str, sessions: Option<Rc<dyn SlidesAiSessions>>) -> Rig {
    let dir = std::env::temp_dir().join(format!("shell-a-slides-ai-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("tmp")).unwrap();
    // the world of this test thread starts empty
    for view in [5, 6] {
        world().close(ViewId(view));
    }
    let inline = Arc::new(Inline::default());
    let views = Arc::new(TestViews::default());
    let host = Arc::new(FakeHost {
        lang: Mutex::new(Lang::En),
        statuses: jscompat::json_parse(r#"{"codex":{"state":"ready"}}"#).unwrap(),
        capabilities: Mutex::default(),
        tools: Mutex::default(),
        tool_answer: Mutex::new(Ok(JsonValue::Null)),
        during_tool: Mutex::default(),
        fetches: Mutex::default(),
        fetch_answer: Mutex::new(Some(PNG.to_vec())),
        during_fetch: Mutex::default(),
        decoder: Decoder,
    });
    let ui = Arc::new(Ui(Mutex::new("ko".into())));
    let mut hosts = Hosts::default();
    let handle: SlidesAiHostHandle = host.clone();
    hosts.insert(handle);
    let ui_host: ShellUiHost = ui.clone();
    hosts.insert(ui_host);
    let os: OsShellHost = Arc::new(NoOs);
    hosts.insert(os);
    let services = Services {
        ui: inline.clone(),
        core: inline.clone(),
        workers: inline.clone(),
        events: Arc::new(NoEvents),
        views: views.clone(),
        paths: Arc::new(Dir(dir.clone())),
        hosts: Arc::new(hosts),
    };
    let provided = Rc::new(Provided::default());
    PROVIDED.with(|p| *p.borrow_mut() = Some(provided.clone()));
    SCRIPTED.with(|s| *s.borrow_mut() = sessions);
    let build: SessionsBuilder = Arc::new(|| -> Rc<dyn SlidesAiSessions> {
        match SCRIPTED.with(|s| s.borrow().clone()) {
            Some(custom) => custom,
            None => world(),
        }
    });
    let overrides = Overrides {
        sessions: Some(build),
        now_ms: None,
    };
    let ai = (factory_with(overrides.clone()).0)(&services, &provided).unwrap();
    let proposal = (proposal_factory_with(overrides).0)(&services, &provided).unwrap();
    Rig {
        dir,
        inline,
        views,
        host,
        ui,
        ai,
        proposal,
    }
}

fn context() -> CallContext {
    CallContext {
        sender: Sender {
            view: VIEW,
            window: WindowId(2),
            surface: Surface::Slides,
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

/// An argument from JSON text (keys in JSON's sorted order)
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

/// An answer as JSON, to compare whatever order its keys came in
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

/// `op` with `key` set (replaced, or added)
fn with(mut op: IpcValue, key: &str, value: IpcValue) -> IpcValue {
    if let IpcValue::Object(entries) = &mut op {
        match entries.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = value,
            None => entries.push((key.to_owned(), value)),
        }
    }
    op
}

fn deck_path(r: &Rig) -> String {
    r.dir
        .join("deck")
        .join("a.pptx")
        .to_string_lossy()
        .into_owned()
}

macro_rules! invoke {
    ($port:expr, $method:ident $(, $arg:expr)* $(,)?) => {
        call(|cx, re| $port.$method(cx, vec![$($arg),*], re))
    };
}

// ---- image and media tools ----

#[test]
fn generate_image_runs_the_tool_beside_the_deck_on_the_screen_route() {
    let r = rig("generate");
    world().open(VIEW, &deck_path(&r), &["p1"]);
    *r.host.tool_answer.lock().unwrap() =
        Ok(jscompat::json_parse(r#"{"url":"file:///made.png"}"#).unwrap());
    let op = ipc(serde_json::json!({
        "prompt": "a cat", "model": "m1", "referenceImageUrls": ["a", 1],
        "aspectRatio": "16:9", "imageSize": "", "transparentBackground": true,
    }));
    let answer = invoke!(r.ai, ai_generate_image, op).unwrap();
    assert_eq!(sv(&answer), serde_json::json!({"url": "file:///made.png"}));
    let tools = r.host.tools.lock().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].tool, "generateImageTool");
    assert_eq!(
        tools[0].settings_path,
        r.dir.join("ai-settings.json").to_string_lossy()
    );
    // an empty imageSize and absent fields are left out; the other values are strings
    let request: serde_json::Value = serde_json::from_str(&tools[0].request).unwrap();
    assert_eq!(
        request,
        serde_json::json!({
            "prompt": "a cat", "model": "m1", "referenceImageUrls": ["a", "1"],
            "aspectRatio": "16:9", "transparentBackground": true,
        })
    );
    assert_eq!(
        tools[0].media_roots,
        vec![
            r.dir.join("deck").to_string_lossy().into_owned(),
            r.dir
                .join("tmp")
                .join("seuoffice-pasted")
                .to_string_lossy()
                .into_owned(),
        ]
    );
    assert_eq!(tools[0].statuses, r#"{"codex":{"state":"ready"}}"#);
    assert!(!tools[0].aborted && !tools[0].aborted_at_end);
}

#[test]
fn generate_image_of_an_unsaved_deck_may_read_only_the_staging_folder() {
    let r = rig("unsaved");
    world().open(VIEW, "", &["p1"]);
    invoke!(
        r.ai,
        ai_generate_image,
        ipc(serde_json::json!({"prompt": "x"}))
    )
    .unwrap();
    let tools = r.host.tools.lock().unwrap();
    assert_eq!(
        tools[0].media_roots,
        vec![
            r.dir
                .join("tmp")
                .join("seuoffice-pasted")
                .to_string_lossy()
                .into_owned()
        ]
    );
    // transparentBackground is a flag: anything but `true` is false
    let request: serde_json::Value = serde_json::from_str(&tools[0].request).unwrap();
    assert_eq!(
        request,
        serde_json::json!({"prompt": "x", "transparentBackground": false})
    );
}

#[test]
fn a_window_that_goes_away_during_the_tool_aborts_its_signal() {
    let r = rig("away");
    let views = r.views.clone();
    *r.host.during_tool.lock().unwrap() = Some(Box::new(move || views.destroy(VIEW)));
    invoke!(
        r.ai,
        ai_generate_image,
        ipc(serde_json::json!({"prompt": "x"}))
    )
    .unwrap();
    let tools = r.host.tools.lock().unwrap();
    assert!(!tools[0].aborted);
    assert!(tools[0].aborted_at_end);
}

#[test]
fn a_call_for_a_destroyed_window_starts_aborted() {
    let r = rig("destroyed");
    r.views.destroy(VIEW);
    invoke!(
        r.ai,
        ai_analyze_media,
        ipc(serde_json::json!({"mediaUrls": []}))
    )
    .unwrap();
    assert!(r.host.tools.lock().unwrap()[0].aborted);
}

#[test]
fn the_user_stopping_the_run_aborts_the_media_calls_of_that_window_only() {
    let r = rig("stop");
    let stop = |sender: f64| -> Box<dyn Fn() + Send + Sync> {
        Box::new(move || {
            PROVIDED.with(|p| {
                let provided = p.borrow().clone().unwrap();
                provided.all::<dyn MediaCallAbort>()[0].abort_media_calls(sender);
            })
        })
    };
    *r.host.during_tool.lock().unwrap() = Some(stop(f64::from(VIEW.0)));
    invoke!(
        r.ai,
        ai_generate_image,
        ipc(serde_json::json!({"prompt": "x"}))
    )
    .unwrap();
    assert!(r.host.tools.lock().unwrap()[0].aborted_at_end);

    // another window's stop leaves this call alone
    *r.host.during_tool.lock().unwrap() = Some(stop(99.0));
    invoke!(
        r.ai,
        ai_generate_image,
        ipc(serde_json::json!({"prompt": "y"}))
    )
    .unwrap();
    assert!(!r.host.tools.lock().unwrap()[1].aborted_at_end);
}

#[test]
fn analyze_media_stringifies_the_request_and_throws_what_the_tool_threw() {
    let r = rig("analyze");
    *r.host.tool_answer.lock().unwrap() =
        Err(jscompat::json_parse(r#"{"$class":"Error","message":"quota exceeded"}"#).unwrap());
    let error = invoke!(
        r.ai,
        ai_analyze_media,
        ipc(serde_json::json!({"mediaUrls": ["a.png", 2], "requirements": null}))
    )
    .unwrap_err();
    assert_eq!(error.message, "quota exceeded");
    let request: serde_json::Value =
        serde_json::from_str(&r.host.tools.lock().unwrap()[0].request).unwrap();
    assert_eq!(
        request,
        serde_json::json!({"mediaUrls": ["a.png", "2"], "requirements": ""})
    );
}

#[test]
fn a_media_call_without_a_payload_throws_a_type_error_and_runs_no_tool() {
    let r = rig("noop");
    let error = invoke!(r.ai, ai_generate_image).unwrap_err();
    assert_eq!(error.name.as_deref(), Some("TypeError"));
    assert_eq!(
        error.message,
        "Cannot read properties of undefined (reading 'prompt')"
    );
    let error = invoke!(
        r.ai,
        ai_analyze_media,
        ipc(serde_json::json!({"mediaUrls": 5}))
    )
    .unwrap_err();
    assert_eq!(error.message, "(op.mediaUrls ?? []).map is not a function");
    assert!(r.host.tools.lock().unwrap().is_empty());
}

// ---- style templates, sidecar, failures ----

#[test]
fn style_templates_are_saved_listed_and_loaded_by_their_safe_name() {
    let r = rig("styles");
    let saved = invoke!(
        r.ai,
        ai_save_style_template,
        ipc(serde_json::json!("Q1/Review: *draft*")),
        ipc(serde_json::json!({
            "topic": "sales", "styleSkill": "bold", "createdAt": "2026-01-01",
            "layout": {"chrome": 1}, "basedOn": "  modern  ",
        }))
    )
    .unwrap();
    assert_eq!(sv(&saved), serde_json::json!({"ok": true}));
    let file = r
        .dir
        .join("style-templates")
        .join("Q1_Review_ _draft_.json");
    let stored: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(stored["name"], "Q1_Review_ _draft_");
    assert_eq!(stored["basedOn"], "modern");
    assert_eq!(stored["layout"], serde_json::json!({"chrome": 1}));

    invoke!(
        r.ai,
        ai_save_style_template,
        ipc(serde_json::json!("plain")),
        ipc(
            serde_json::json!({"topic": "t", "styleSkill": "s", "createdAt": "c", "basedOn": "   "})
        )
    )
    .unwrap();
    let listed = invoke!(r.ai, ai_list_style_templates).unwrap();
    assert_eq!(
        sv(&listed),
        serde_json::json!([
            {"name": "Q1_Review_ _draft_", "topic": "sales", "createdAt": "2026-01-01"},
            {"name": "plain", "topic": "t", "createdAt": "c"},
        ])
    );
    // a blank basedOn is not written
    let plain: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(r.dir.join("style-templates").join("plain.json")).unwrap(),
    )
    .unwrap();
    assert!(plain.get("basedOn").is_none());

    let loaded = invoke!(
        r.ai,
        ai_load_style_template,
        ipc(serde_json::json!("Q1/Review: *draft*"))
    )
    .unwrap();
    assert_eq!(
        sv(&loaded),
        serde_json::json!({
            "ok": true, "styleSkill": "bold", "topic": "sales",
            "layout": {"chrome": 1}, "basedOn": "modern",
        })
    );
}

#[test]
fn listing_with_no_folder_is_empty_and_skips_other_files() {
    let r = rig("list-empty");
    assert_eq!(
        invoke!(r.ai, ai_list_style_templates).unwrap(),
        IpcValue::Array(vec![])
    );
    let dir = r.dir.join("style-templates");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("notes.txt"), "x").unwrap();
    std::fs::write(dir.join("bare.json"), "{}").unwrap();
    std::fs::write(dir.join("null.json"), "null").unwrap();
    // no name in the file: the file's name; a file that holds null is left out
    assert_eq!(
        sv(&invoke!(r.ai, ai_list_style_templates).unwrap()),
        serde_json::json!([{"name": "bare", "topic": "", "createdAt": ""}])
    );
}

#[test]
fn template_errors_are_worded_in_the_ui_language() {
    let r = rig("tpl-errors");
    let invalid = |r: &Rig| {
        invoke!(
            r.ai,
            ai_save_style_template,
            ipc(serde_json::json!("")),
            ipc(serde_json::json!({}))
        )
        .unwrap()
    };
    *r.host.lang.lock().unwrap() = Lang::En;
    assert_eq!(
        sv(&invalid(&r)),
        serde_json::json!({"ok": false, "error": "Invalid template name"})
    );
    *r.host.lang.lock().unwrap() = Lang::Ko;
    assert_eq!(
        sv(&invalid(&r)),
        serde_json::json!({"ok": false, "error": "템플릿 이름이 잘못되었습니다"})
    );

    let missing = invoke!(
        r.ai,
        ai_load_style_template,
        ipc(serde_json::json!("ghost"))
    )
    .unwrap();
    assert_eq!(
        sv(&missing),
        serde_json::json!({"ok": false, "error": "템플릿 \"ghost\"이(가) 존재하지 않습니다"})
    );
    let dir = r.dir.join("style-templates");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("empty.json"), r#"{"topic":"t"}"#).unwrap();
    *r.host.lang.lock().unwrap() = Lang::En;
    let no_skill = invoke!(
        r.ai,
        ai_load_style_template,
        ipc(serde_json::json!("empty"))
    )
    .unwrap();
    assert_eq!(
        sv(&no_skill),
        serde_json::json!({"ok": false, "error": "Template \"empty\" has no valid Style Skill"})
    );
}

#[test]
fn a_style_template_name_that_is_not_text_answers_the_error_message() {
    let r = rig("tpl-type");
    let answer = invoke!(
        r.ai,
        ai_save_style_template,
        IpcValue::Number(1.0),
        ipc(serde_json::json!({}))
    )
    .unwrap();
    assert_eq!(
        sv(&answer),
        serde_json::json!({"ok": false, "error": "name.replace is not a function"})
    );
}

#[test]
fn a_run_failure_is_one_clipped_line_of_the_post_mortem_log() {
    let r = rig("failure");
    let entry = ipc(serde_json::json!({
        "instruction": "x".repeat(20_005), "streamed": "abc", "reason": "loop",
    }));
    assert_eq!(
        invoke!(r.ai, ai_log_run_failure, entry).unwrap(),
        IpcValue::Undefined
    );
    let log_path = r.dir.join("ai-run-failures.jsonl");
    let log = std::fs::read_to_string(&log_path).unwrap();
    let line: serde_json::Value = serde_json::from_str(log.trim_end()).unwrap();
    assert_eq!(line["instruction"].as_str().unwrap().len(), 20_000);
    assert_eq!(line["streamed"], "abc");
    assert_eq!(line["streamedChars"], 3);
    assert_eq!(line["reason"], "loop");
    assert!(line["ts"].as_str().unwrap().ends_with('Z'));
    // a second failure is the next line
    invoke!(
        r.ai,
        ai_log_run_failure,
        ipc(serde_json::json!({"instruction": "i", "streamed": ""}))
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(&log_path).unwrap().lines().count(),
        2
    );
    // an entry that cannot be read is dropped without failing the run
    invoke!(r.ai, ai_log_run_failure).unwrap();
    assert_eq!(
        std::fs::read_to_string(&log_path).unwrap().lines().count(),
        2
    );
}

#[test]
fn the_style_sidecar_is_written_beside_a_saved_pptx() {
    let r = rig("sidecar");
    std::fs::create_dir_all(r.dir.join("deck")).unwrap();
    world().open(VIEW, &deck_path(&r), &["p1"]);
    let data = ipc(serde_json::json!({"topic": "t", "styleSkill": "s", "createdAt": "c"}));
    assert_eq!(
        sv(&invoke!(r.ai, ai_save_sidecar, data.clone()).unwrap()),
        serde_json::json!({"ok": true})
    );
    let written = std::fs::read_to_string(r.dir.join("deck").join("a.styleskill.json")).unwrap();
    let written: serde_json::Value = serde_json::from_str(&written).unwrap();
    assert_eq!(
        written,
        serde_json::json!({"topic": "t", "styleSkill": "s", "createdAt": "c"})
    );
    // an unsaved deck, a deck that is not a pptx and a view without a session write nothing
    for path in ["", "/x/deck.odp"] {
        world().open(VIEW, path, &["p1"]);
        assert_eq!(
            sv(&invoke!(r.ai, ai_save_sidecar, data.clone()).unwrap()),
            serde_json::json!({"ok": false})
        );
    }
    world().close(VIEW);
    assert_eq!(
        sv(&invoke!(r.ai, ai_save_sidecar, data).unwrap()),
        serde_json::json!({"ok": false})
    );
}

// ---- fonts and capabilities ----

#[test]
fn default_fonts_are_the_stored_choice_or_the_document_languages() {
    let r = rig("fonts");
    let default = |locale: &str| {
        *r.ui.0.lock().unwrap() = locale.to_owned();
        sv(&invoke!(r.ai, slides_ai_default_fonts).unwrap())
    };
    // the faces cover Korean and English text only: elsewhere the model picks
    assert_eq!(default("ko")["mode"], "sans");
    assert_eq!(default("ja")["mode"], "auto");
    std::fs::write(
        r.dir.join("app-settings.json"),
        r#"{"slidesAiFonts":{"mode":"serif","sans":"Foo Sans","serif":"Bar Serif"}}"#,
    )
    .unwrap();
    assert_eq!(
        default("ja"),
        serde_json::json!({"mode": "serif", "sans": "Foo Sans", "serif": "Bar Serif"})
    );
}

#[test]
fn tool_capabilities_are_asked_with_the_stored_settings_and_the_screen_context() {
    let r = rig("capabilities");
    std::fs::write(
        r.dir.join("ai-settings.json"),
        r#"{"provider":"openai","providers":{}}"#,
    )
    .unwrap();
    let answer = invoke!(r.ai, slides_ai_tool_capabilities).unwrap();
    assert_eq!(
        sv(&answer),
        serde_json::json!({"webSearch": {"available": true}})
    );
    let asked = r.host.capabilities.lock().unwrap();
    assert_eq!(asked.len(), 1);
    let settings: serde_json::Value = serde_json::from_str(&asked[0].0).unwrap();
    assert!(settings["providers"].is_object());
    let context: serde_json::Value = serde_json::from_str(&asked[0].1).unwrap();
    assert_eq!(
        context,
        serde_json::json!({"path": "screen", "statuses": {"codex": {"state": "ready"}}})
    );
}

// ---- pictures ----

fn insert_op(url: &str) -> IpcValue {
    ipc(serde_json::json!({
        "slideIndex": 0, "url": url, "xPx": 10, "yPx": 20, "wPx": 480, "hPx": 270, "fitWidthPx": 960,
    }))
}

#[test]
fn an_image_is_downloaded_then_placed_cropped_to_its_frame() {
    let r = rig("insert");
    world().open(VIEW, "", &["p1"]);
    let answer = invoke!(
        r.ai,
        ai_insert_image_url,
        insert_op("https://img.test/a.png")
    )
    .unwrap();
    assert_eq!(
        *r.host.fetches.lock().unwrap(),
        vec!["https://img.test/a.png".to_owned()]
    );
    let page = match &answer {
        IpcValue::Object(_) => sv(&answer)["slide"]["page"].as_str().unwrap().to_owned(),
        other => panic!("{other:?}"),
    };
    // 960px wide is the deck's 960px: the frame is the model's, converted to EMU
    assert!(
        page.starts_with("p1+picture(12 bytes,png,95250,190500,4572000,2571750)+crop("),
        "{page}"
    );
    assert!(
        sv(&answer)["sourceId"]
            .as_str()
            .unwrap()
            .starts_with("pic-")
    );
    assert_eq!(world().undo_depth(VIEW), 1);
}

#[test]
fn an_attachment_is_placed_without_a_download() {
    let r = rig("attachment");
    world().open(VIEW, "", &["p1"]);
    let op = with(
        with(
            insert_op("ignored"),
            "base64",
            IpcValue::String(jscompat::base64(&PNG)),
        ),
        "ext",
        IpcValue::String("PNG".into()),
    );
    let answer = invoke!(r.ai, ai_insert_image_url, op).unwrap();
    assert!(r.host.fetches.lock().unwrap().is_empty());
    assert!(
        sv(&answer)["slide"]["page"]
            .as_str()
            .unwrap()
            .contains("+picture(12 bytes,png,")
    );
}

#[test]
fn a_picture_that_cannot_be_had_answers_null_and_leaves_the_deck_alone() {
    let r = rig("insert-null");
    world().open(VIEW, "", &["p1"]);
    // the download failed
    *r.host.fetch_answer.lock().unwrap() = None;
    assert_eq!(
        invoke!(r.ai, ai_insert_image_url, insert_op("https://x/a.png")).unwrap(),
        IpcValue::Null
    );
    // the bytes are not a raster image (an HTML error page)
    *r.host.fetch_answer.lock().unwrap() = Some(b"<html>nope</html>".to_vec());
    assert_eq!(
        invoke!(r.ai, ai_insert_image_url, insert_op("https://x/a.png")).unwrap(),
        IpcValue::Null
    );
    // a page the deck lacks
    *r.host.fetch_answer.lock().unwrap() = Some(PNG.to_vec());
    let op = with(
        insert_op("https://x/a.png"),
        "slideIndex",
        IpcValue::Number(7.0),
    );
    assert_eq!(
        invoke!(r.ai, ai_insert_image_url, op).unwrap(),
        IpcValue::Null
    );
    assert_eq!(world().pages(VIEW), vec!["p1".to_owned()]);
    assert_eq!(world().undo_depth(VIEW), 0);
    // no session
    world().close(VIEW);
    assert_eq!(
        invoke!(r.ai, ai_insert_image_url, insert_op("https://x/a.png")).unwrap(),
        IpcValue::Null
    );
    assert_eq!(
        invoke!(r.ai, ai_replace_picture_url, insert_op("https://x/a.png")).unwrap(),
        IpcValue::Null
    );
}

#[test]
fn a_write_for_a_run_that_ended_during_the_download_is_dropped() {
    let r = rig("late");
    world().open(VIEW, "", &["p1"]);
    assert_eq!(
        invoke!(r.proposal, slides_ai_run_begin).unwrap(),
        IpcValue::Bool(true)
    );
    // the run is held while the image downloads
    *r.host.during_fetch.lock().unwrap() = Some(Box::new(|| {
        world().run_hold(VIEW);
    }));
    let op = with(
        insert_op("https://x/a.png"),
        "aiRunExpected",
        IpcValue::Bool(true),
    );
    assert_eq!(
        invoke!(r.ai, ai_insert_image_url, op.clone()).unwrap(),
        IpcValue::Null
    );
    assert_eq!(world().pages(VIEW), vec!["p1".to_owned()]);
    // a run expected but none open answers null before any download
    r.host.fetches.lock().unwrap().clear();
    assert_eq!(
        invoke!(r.ai, ai_insert_image_url, op).unwrap(),
        IpcValue::Null
    );
    assert!(r.host.fetches.lock().unwrap().is_empty());
}

#[test]
fn a_picture_is_replaced_in_place_by_its_durable_or_parse_time_id() {
    let r = rig("replace");
    world().open(VIEW, "", &["p1"]);
    let op = |source: &str, keep: bool| {
        ipc(serde_json::json!({
            "slideIndex": 0, "sourceId": source, "url": "https://x/b.png", "keepSrcRect": keep,
        }))
    };
    let answer = invoke!(r.ai, ai_replace_picture_url, op("d:7", false)).unwrap();
    // the durable id is translated to the one the engine matches; the frame crops the new image
    assert!(
        sv(&answer)["page"]
            .as_str()
            .unwrap()
            .starts_with("p1+replace(7,12 bytes,png,keep=false)+crop(")
    );
    let kept = invoke!(r.ai, ai_replace_picture_url, op("8", true)).unwrap();
    assert!(
        sv(&kept)["page"]
            .as_str()
            .unwrap()
            .ends_with("+replace(8,12 bytes,png,keep=true)")
    );
    // the engine replaced nothing: no undo step is left behind
    let depth = world().undo_depth(VIEW);
    assert_eq!(
        invoke!(r.ai, ai_replace_picture_url, op("missing", false)).unwrap(),
        IpcValue::Null
    );
    assert_eq!(world().undo_depth(VIEW), depth);
}

#[test]
fn a_picture_handler_that_throws_before_its_try_answers_the_error() {
    let r = rig("replace-throw");
    world().open(VIEW, "", &["p1"]);
    let error = invoke!(r.ai, ai_replace_picture_url).unwrap_err();
    assert_eq!(error.name.as_deref(), Some("TypeError"));
    assert_eq!(
        error.message,
        "Cannot read properties of undefined (reading 'aiRunExpected')"
    );
}

// ---- the held proposal ----

fn pages(page: &str) -> IpcValue {
    IpcValue::Array(vec![IpcValue::String(page.into())])
}

#[test]
fn a_run_is_held_as_a_proposal_then_accepted_as_one_undo_step() {
    let r = rig("proposal");
    world().open(VIEW, "", &["p1"]);
    assert_eq!(
        invoke!(r.proposal, slides_ai_run_begin).unwrap(),
        IpcValue::Bool(true)
    );
    assert!(world().run_open(VIEW));
    world().edit(VIEW, 0, "+ai");
    // held: the deck is back as it was and the proposal waits
    assert_eq!(
        invoke!(r.proposal, slides_ai_run_hold).unwrap(),
        pages("p1")
    );
    assert!(world().proposal_held(VIEW));
    assert_eq!(world().pages(VIEW), vec!["p1".to_owned()]);
    // a second hold has nothing to hold
    assert_eq!(
        invoke!(r.proposal, slides_ai_run_hold).unwrap(),
        IpcValue::Null
    );

    let accepted = invoke!(r.proposal, slides_ai_proposal_accept).unwrap();
    let json = sv(&accepted);
    assert_eq!(json["slides"], serde_json::json!(["p1+ai"]));
    assert_eq!(json["snapshotId"], 1);
    assert_eq!(world().undo_depth(VIEW), 1);
    // nothing is left to accept
    assert_eq!(
        invoke!(r.proposal, slides_ai_proposal_accept).unwrap(),
        IpcValue::Null
    );

    // the pre-run deck is a rollback point the renderer can restore
    assert_eq!(
        invoke!(r.ai, slides_ai_snapshot_restore, IpcValue::Number(1.0)).unwrap(),
        pages("p1")
    );
    assert_eq!(world().undo_depth(VIEW), 2);
    // a rollback point is used once, and an id that is not a number is none
    assert_eq!(
        invoke!(r.ai, slides_ai_snapshot_restore, IpcValue::Number(1.0)).unwrap(),
        IpcValue::Null
    );
    assert_eq!(
        invoke!(
            r.ai,
            slides_ai_snapshot_restore,
            IpcValue::String("1".into())
        )
        .unwrap(),
        IpcValue::Null
    );
}

#[test]
fn a_rejected_proposal_is_dropped() {
    let r = rig("reject");
    world().open(VIEW, "", &["p1"]);
    invoke!(r.proposal, slides_ai_run_begin).unwrap();
    world().edit(VIEW, 0, "+ai");
    invoke!(r.proposal, slides_ai_run_hold).unwrap();
    assert_eq!(
        invoke!(r.proposal, slides_ai_proposal_reject).unwrap(),
        IpcValue::Bool(true)
    );
    assert!(!world().proposal_held(VIEW));
    assert_eq!(
        invoke!(r.proposal, slides_ai_proposal_reject).unwrap(),
        IpcValue::Bool(false)
    );
    assert_eq!(
        invoke!(r.proposal, slides_ai_proposal_accept).unwrap(),
        IpcValue::Null
    );
    assert_eq!(world().pages(VIEW), vec!["p1".to_owned()]);
}

#[test]
fn a_view_without_a_session_gets_the_empty_answers() {
    let r = rig("nosession");
    assert_eq!(
        invoke!(r.proposal, slides_ai_run_begin).unwrap(),
        IpcValue::Bool(false)
    );
    assert_eq!(
        invoke!(r.proposal, slides_ai_run_hold).unwrap(),
        IpcValue::Null
    );
    assert_eq!(
        invoke!(r.proposal, slides_ai_proposal_accept).unwrap(),
        IpcValue::Null
    );
    assert_eq!(
        invoke!(r.proposal, slides_ai_proposal_reject).unwrap(),
        IpcValue::Bool(false)
    );
    assert_eq!(
        invoke!(r.ai, slides_ai_snapshot_restore, IpcValue::Number(1.0)).unwrap(),
        IpcValue::Null
    );
}

#[test]
fn master_view_refuses_a_run_and_a_rollback() {
    let r = rig("master");
    world().open(VIEW, "", &["p1"]);
    world().set_master_edit(VIEW, true);
    assert_eq!(
        invoke!(r.proposal, slides_ai_run_begin).unwrap(),
        IpcValue::Bool(false)
    );
    assert!(!world().run_open(VIEW));
    assert_eq!(
        invoke!(r.ai, slides_ai_snapshot_restore, IpcValue::Number(1.0)).unwrap(),
        IpcValue::Null
    );
}

#[test]
fn a_run_begin_waits_for_the_writes_in_flight() {
    let r = rig("settle");
    world().open(VIEW, "", &["p1"]);
    let write = world().begin_write(VIEW).unwrap();
    // the write ends while the begin sleeps: the third poll finds the session quiet
    *r.inline.before_spawn.lock().unwrap() = Some(Box::new(move |n| {
        if n == 3 {
            world().end_write(VIEW, write);
        }
    }));
    assert_eq!(
        invoke!(r.proposal, slides_ai_run_begin).unwrap(),
        IpcValue::Bool(true)
    );
    assert_eq!(r.inline.spawns.load(Ordering::SeqCst), 3);
    assert!(world().run_open(VIEW));
}

/// The world with `settle_step` scripted, running a hook at its first turn
struct Scripted {
    inner: Rc<World>,
    steps: RefCell<VecDeque<SettleStep>>,
    at_turn: RefCell<Option<Box<dyn Fn()>>>,
}

impl SlidesDocuments for Scripted {
    fn document(&self, view: ViewId) -> Option<SlidesDocument> {
        self.inner.document(view)
    }
}

impl SlidesAiSessions for Scripted {
    fn run_begin_start(&self, view: ViewId) -> Option<RunBeginTicket> {
        self.inner.run_begin_start(view)
    }
    fn settle_step(&self, _view: ViewId, _now_ms: f64, _deadline_ms: f64) -> SettleStep {
        let hook = self.at_turn.borrow_mut().take();
        if let Some(hook) = hook {
            hook();
        }
        self.steps
            .borrow_mut()
            .pop_front()
            .unwrap_or(SettleStep::Quiet)
    }
    fn run_begin_finish(&self, view: ViewId, ticket: RunBeginTicket, wake: RunBeginWake) -> bool {
        self.inner.run_begin_finish(view, ticket, wake)
    }
    fn run_hold(&self, view: ViewId) -> Option<IpcValue> {
        self.inner.run_hold(view)
    }
    fn proposal_accept(&self, view: ViewId) -> Option<(IpcValue, u64)> {
        self.inner.proposal_accept(view)
    }
    fn proposal_reject(&self, view: ViewId) -> bool {
        self.inner.proposal_reject(view)
    }
    fn snapshot_restore(&self, view: ViewId, id: f64) -> Option<IpcValue> {
        self.inner.snapshot_restore(view, id)
    }
    fn picture_begin(
        &self,
        view: ViewId,
        replace: bool,
        images: &dyn ImageDecoder,
        op: Option<&JsonValue>,
    ) -> Result<Option<PictureTicket>, main_core::slides::ai_ipc::IpcError> {
        self.inner.picture_begin(view, replace, images, op)
    }
    fn picture_finish(
        &self,
        view: ViewId,
        replace: bool,
        images: &dyn ImageDecoder,
        op: &JsonValue,
        ticket: PictureTicket,
        downloaded: Option<Vec<u8>>,
    ) -> Option<JsonValue> {
        self.inner
            .picture_finish(view, replace, images, op, ticket, downloaded)
    }
}

fn scripted_rig(name: &str, steps: Vec<SettleStep>) -> (Rig, Rc<Scripted>) {
    let scripted = Rc::new(Scripted {
        inner: world(),
        steps: RefCell::new(steps.into()),
        at_turn: RefCell::new(None),
    });
    let sessions: Rc<dyn SlidesAiSessions> = scripted.clone();
    (rig_over(name, Some(sessions)), scripted)
}

#[test]
fn a_run_begin_whose_wait_timed_out_begins_nothing() {
    let (r, _) = scripted_rig(
        "timeout",
        vec![SettleStep::Wait { left_ms: 5.0 }, SettleStep::TimedOut],
    );
    world().open(VIEW, "", &["p1"]);
    assert_eq!(
        invoke!(r.proposal, slides_ai_run_begin).unwrap(),
        IpcValue::Bool(false)
    );
    assert!(!world().run_open(VIEW));
}

#[test]
fn a_run_begin_for_a_window_that_went_away_during_the_wait_begins_nothing() {
    let (r, scripted) = scripted_rig("gone", vec![SettleStep::Quiet]);
    world().open(VIEW, "", &["p1"]);
    let views = r.views.clone();
    *scripted.at_turn.borrow_mut() = Some(Box::new(move || views.destroy(VIEW)));
    assert_eq!(
        invoke!(r.proposal, slides_ai_run_begin).unwrap(),
        IpcValue::Bool(false)
    );
    // the deck stays unlocked for every other window
    assert!(!world().run_open(VIEW));
}

#[test]
fn a_run_begin_for_a_session_replaced_during_the_wait_begins_nothing() {
    let (r, scripted) = scripted_rig("replaced", vec![SettleStep::Quiet]);
    world().open(VIEW, "", &["p1"]);
    *scripted.at_turn.borrow_mut() = Some(Box::new(|| {
        // the window reloaded and opened another deck
        world().open(VIEW, "", &["other"]);
    }));
    assert_eq!(
        invoke!(r.proposal, slides_ai_run_begin).unwrap(),
        IpcValue::Bool(false)
    );
    assert!(!world().run_open(VIEW));
}

#[test]
fn the_shell_finds_the_sessions_d1_provides_when_a_handler_runs() {
    let r = rig("provided");
    let services = {
        let inline = r.inline.clone();
        let mut hosts = Hosts::default();
        let handle: SlidesAiHostHandle = r.host.clone();
        hosts.insert(handle);
        let ui: ShellUiHost = r.ui.clone();
        hosts.insert(ui);
        let os: OsShellHost = Arc::new(NoOs);
        hosts.insert(os);
        Services {
            ui: inline.clone(),
            core: inline.clone(),
            workers: inline,
            events: Arc::new(NoEvents),
            views: r.views.clone(),
            paths: Arc::new(Dir(r.dir.clone())),
            hosts: Arc::new(hosts),
        }
    };
    let provided = Rc::new(Provided::default());
    let proposal = (proposal_factory().0)(&services, &provided).unwrap();
    // D1 has provided nothing yet: every view is a view without a session
    world().open(VIEW, "", &["p1"]);
    assert_eq!(
        invoke!(proposal, slides_ai_run_begin).unwrap(),
        IpcValue::Bool(false)
    );
    // once it does, the same port reaches them
    let sessions: Rc<dyn SlidesAiSessions> = world();
    provided.add::<dyn SlidesAiSessions>(sessions);
    assert_eq!(
        invoke!(proposal, slides_ai_run_begin).unwrap(),
        IpcValue::Bool(true)
    );
}
