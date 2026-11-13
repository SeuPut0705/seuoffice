//! Behavior of the shared AI port over a fake net and fake hosts: the chunks
//! and replies of a stream, its cancel and its view's end, the one-shot chat,
//! the settings file (sealed keys, unknown fields, the live model lists),
//! the local model test and its cancel, the page reader and the tools that
//! run on the host.

use std::cell::Cell;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::mpsc::{self, Receiver, Sender as JobSender};
use std::sync::{Arc, Mutex};
use std::thread::{self, ThreadId};
use std::time::{Duration, Instant};

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use main_core::packages::ai_provider::settings_secrets::{AiSecretCodec, CodecThrow};
use main_core::packages::ai_provider::task::{Fetcher, Id, Request};
use main_core::packages::ai_search::search_tools::{SearchAnswer, SearchOptions};
use main_core::packages::i18n::Lang;
use serde_json::{Value, json};
use shell_contract::Hosts;
use shell_contract::ipc::{CallContext, EventSink, Reply, Responder, Sender, Target};
use shell_contract::runtime::{AppPaths, CancelToken, PathName, Services, Thread, Views, Workers};
use shell_contract::{Surface, ViewId, WindowId};

use super::*;
use crate::runtime::testing::FakeNet;
use crate::runtime::{Net, Sink};

type Job = Box<dyn FnOnce() + Send>;

// ---- the world the port runs in ----

struct Queue {
    jobs: JobSender<Job>,
    owner: ThreadId,
}

impl Thread for Queue {
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

struct Dir(PathBuf);

impl AppPaths for Dir {
    fn path(&self, _: PathName) -> PathBuf {
        self.0.clone()
    }
}

/// What the view side saw, in order: the events and the replies
#[derive(Clone, Debug)]
enum Entry {
    Event(Target, &'static str, Value),
    Reply(usize, Result<Value, String>),
}

type Log = Arc<Mutex<Vec<Entry>>>;

fn plain(value: &IpcValue) -> Value {
    match value {
        IpcValue::Undefined => json!("<undefined>"),
        IpcValue::Null => Value::Null,
        IpcValue::Bool(b) => json!(b),
        IpcValue::Number(n) if n.fract() == 0.0 => json!(*n as i64),
        IpcValue::Number(n) => json!(n),
        IpcValue::String(s) => json!(s),
        IpcValue::Array(items) => items.iter().map(plain).collect(),
        IpcValue::Object(entries) => entries
            .iter()
            .map(|(k, v)| (k.clone(), plain(v)))
            .collect::<serde_json::Map<_, _>>()
            .into(),
        other => panic!("{other:?}"),
    }
}

fn ipc(value: Value) -> IpcValue {
    match value {
        Value::Null => IpcValue::Null,
        Value::Bool(b) => IpcValue::Bool(b),
        Value::Number(n) => IpcValue::Number(n.as_f64().unwrap()),
        Value::String(s) => IpcValue::String(s),
        Value::Array(a) => IpcValue::Array(a.into_iter().map(ipc).collect()),
        Value::Object(o) => IpcValue::Object(o.into_iter().map(|(k, v)| (k, ipc(v))).collect()),
    }
}

struct Recorder(Log);

impl EventSink for Recorder {
    fn emit(&self, target: Target, channel: &'static str, args: Vec<IpcValue>) {
        let first = args.first().map_or(json!("<none>"), plain);
        self.0
            .lock()
            .unwrap()
            .push(Entry::Event(target, channel, first));
    }
}

/// A callback told when a view is destroyed
type ViewListener = Box<dyn Fn(ViewId) + Send + Sync>;

/// The views of the case: a view alive until [`TestViews::destroy`]
#[derive(Default)]
struct TestViews {
    gone: Mutex<Vec<ViewId>>,
    cancels: Mutex<HashMap<u32, CancelToken>>,
    listeners: Mutex<Vec<ViewListener>>,
}

impl TestViews {
    fn cancel_of(&self, view: u32) -> CancelToken {
        self.cancels
            .lock()
            .unwrap()
            .entry(view)
            .or_default()
            .clone()
    }

    fn destroy(&self, view: u32) {
        self.gone.lock().unwrap().push(ViewId(view));
        self.cancel_of(view).cancel();
        for listener in self.listeners.lock().unwrap().iter() {
            listener(ViewId(view));
        }
    }
}

impl Views for TestViews {
    fn sender_of(&self, view: ViewId) -> Option<Sender> {
        (!self.gone.lock().unwrap().contains(&view)).then_some(Sender {
            view,
            window: WindowId(1),
            surface: Surface::Docs,
        })
    }
    fn all(&self) -> Vec<Sender> {
        Vec::new()
    }
    fn on_destroyed(&self, listener: Box<dyn Fn(ViewId) + Send + Sync>) {
        self.listeners.lock().unwrap().push(listener);
    }
}

/// `safeStorage` as a test needs it: a sealed value is the plain one reversed
struct ReversingCodec;

const SEALED: &str = "sealed:v1:";

impl AiSecretCodec for ReversingCodec {
    fn seal(&self, plain: &str) -> Result<Option<String>, CodecThrow> {
        Ok(Some(format!(
            "{SEALED}{}",
            plain.chars().rev().collect::<String>()
        )))
    }
    fn open(&self, sealed: &str) -> Result<Option<String>, CodecThrow> {
        Ok(Some(
            sealed.trim_start_matches(SEALED).chars().rev().collect(),
        ))
    }
}

fn sealed(plain: &str) -> String {
    format!("{SEALED}{}", plain.chars().rev().collect::<String>())
}

/// The net: scripted fetches, except the ones to a host named `hang`, which
/// never answer (a slow model); what the runtime cancelled is recorded
struct TestNet {
    inner: Arc<FakeNet>,
    hung: Mutex<Vec<Id>>,
    cancelled: Mutex<Vec<Id>>,
}

impl Net for TestNet {
    fn fetch(&self, id: Id, via: Fetcher, url: String, request: Request, sink: Sink) {
        if url.contains("hang.test") {
            self.hung.lock().unwrap().push(id);
            return;
        }
        self.inner.fetch(id, via, url, request, sink)
    }
    fn read(&self, id: Id, body: Id, sink: Sink) {
        self.inner.read(id, body, sink)
    }
    fn clone_body(&self, from: Id, to: Id) {
        self.inner.clone_body(from, to)
    }
    fn cancel(&self, id: Id) {
        self.cancelled.lock().unwrap().push(id);
        self.inner.cancel(id)
    }
    fn listen(&self, id: Id, host: String, port: f64, sink: Sink) {
        self.inner.listen(id, host, port, sink)
    }
    fn respond(&self, request: Id, status: f64, headers: Vec<(String, String)>, body: Vec<u8>) {
        self.inner.respond(request, status, headers, body)
    }
    fn close_server(&self, server: Id) {
        self.inner.close_server(server)
    }
}

/// A generated image's bytes and its mime type
type ImageAnswer = (Vec<u8>, String);

/// The host the entry gives: what it answers is set by the test, what it was
/// asked is kept
#[derive(Default)]
struct FakeHost {
    statuses: Mutex<Option<JsonValue>>,
    headless: Mutex<bool>,
    capabilities: Mutex<Vec<(JsonValue, JsonValue)>>,
    web: Mutex<VecDeque<SearchAnswer>>,
    searches: Mutex<Vec<(String, String, f64, JsonValue)>>,
    reads: Mutex<VecDeque<Result<JsonValue, JsonValue>>>,
    read_requests: Mutex<Vec<(String, f64)>>,
    /// a read of this url waits until its signal fires
    slow_read: Mutex<Option<String>>,
    read_cancelled: Mutex<bool>,
    images: Mutex<VecDeque<Option<ImageAnswer>>>,
}

impl AiCoreHost for FakeHost {
    fn ui_lang(&self) -> Lang {
        Lang::En
    }
    fn subscription_statuses(&self) -> JsonValue {
        self.statuses
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| json_value_from_serde(&json!({})))
    }
    fn is_headless_mode(&self) -> bool {
        *self.headless.lock().unwrap()
    }
    fn ai_tool_capabilities(&self, settings: &JsonValue, context: &JsonValue) -> JsonValue {
        self.capabilities
            .lock()
            .unwrap()
            .push((settings.clone(), context.clone()));
        json_value_from_serde(&json!({ "webSearch": { "available": true } }))
    }
    fn web_search(&self, query: &str, max: f64, options: &SearchOptions) -> SearchAnswer {
        self.searches
            .lock()
            .unwrap()
            .push(("web".into(), query.into(), max, options.to_json()));
        self.web.lock().unwrap().pop_front().unwrap_or_else(|| {
            Ok(json_value_from_serde(
                &json!({ "results": [], "method": "ddg" }),
            ))
        })
    }
    fn image_search(&self, query: &str, max: f64, options: &SearchOptions) -> SearchAnswer {
        self.searches
            .lock()
            .unwrap()
            .push(("image".into(), query.into(), max, options.to_json()));
        Ok(json_value_from_serde(
            &json!({ "images": [], "method": "ddg" }),
        ))
    }
    fn read_url(
        &self,
        _settings_path: &str,
        url: &str,
        offset: f64,
        signal: &CancelToken,
    ) -> Result<JsonValue, JsonValue> {
        self.read_requests
            .lock()
            .unwrap()
            .push((url.into(), offset));
        if self.slow_read.lock().unwrap().as_deref() == Some(url) {
            let end = Instant::now() + Duration::from_secs(10);
            while !signal.is_cancelled() && Instant::now() < end {
                thread::sleep(Duration::from_millis(5));
            }
            *self.read_cancelled.lock().unwrap() = signal.is_cancelled();
            return Ok(json_value_from_serde(
                &json!({ "ok": false, "error": "aborted" }),
            ));
        }
        self.reads.lock().unwrap().pop_front().unwrap_or_else(|| {
            Ok(json_value_from_serde(
                &json!({ "ok": true, "text": "page" }),
            ))
        })
    }
    fn fetch_remote_image(&self, _url: &str) -> Option<RemoteImage> {
        self.images
            .lock()
            .unwrap()
            .pop_front()
            .flatten()
            .map(|(bytes, content_type)| RemoteImage {
                bytes,
                content_type,
            })
    }
}

struct Rig {
    dir: PathBuf,
    jobs: Receiver<Job>,
    log: Log,
    host: Arc<FakeHost>,
    views: Arc<TestViews>,
    net: Arc<TestNet>,
    /// the fetches the runtime made, as `FakeNet` logs them
    net_log: crate::runtime::testing::Log,
    pending: PendingAiDocsHost,
    port: AiCorePort,
    app: AppAiPort,
    calls: Cell<usize>,
}

/// A rig over a case folder holding `settings` as `ai-settings.json`, and
/// the fetches of `net` (the table of [`FakeNet`])
fn rig(name: &str, settings: Option<Value>, net: Value) -> Rig {
    let dir = std::env::temp_dir().join(format!("seuoffice-aicore-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    if let Some(settings) = settings {
        std::fs::write(dir.join("ai-settings.json"), settings.to_string()).unwrap();
    }
    let (jobs_tx, jobs) = mpsc::channel();
    let core: Arc<dyn Thread> = Arc::new(Queue {
        jobs: jobs_tx,
        owner: thread::current().id(),
    });
    let log: Log = Arc::default();
    let views = Arc::new(TestViews::default());
    let services = Services {
        ui: core.clone(),
        core,
        workers: Arc::new(Threads),
        events: Arc::new(Recorder(log.clone())),
        views: views.clone(),
        paths: Arc::new(Dir(dir.clone())),
        hosts: Arc::new(Hosts::default()),
    };
    let net_log: crate::runtime::testing::Log = Arc::default();
    let test_net = Arc::new(TestNet {
        inner: FakeNet::new(&net, Some(net_log.clone())),
        hung: Mutex::default(),
        cancelled: Mutex::default(),
    });
    let driver = Driver::new(&services, test_net.clone());
    let provided = Rc::new(Provided::default());
    let host = Arc::new(FakeHost::default());
    let codec: Codec = Arc::new(ReversingCodec);
    let handle: AiCoreHostHandle = host.clone();
    let port = AiCorePort::new(&services, &provided, handle.clone(), codec.clone(), driver);
    let pending = Arc::new(PendingAiDocs::default());
    let app = AppAiPort {
        files: Files::new(
            &Dir(dir.clone()),
            services.events.clone(),
            codec,
            handle.clone(),
        ),
        host: handle,
        pending: pending.clone(),
    };
    Rig {
        dir,
        jobs,
        log,
        host,
        views,
        net: test_net,
        net_log,
        pending,
        port,
        app,
        calls: Cell::new(0),
    }
}

impl Rig {
    fn context(&self, view: u32) -> CallContext {
        CallContext {
            sender: Sender {
                view: ViewId(view),
                window: WindowId(1),
                surface: Surface::Docs,
            },
            request: None,
            cancel: self.views.cancel_of(view),
        }
    }

    /// Starts a call of `view`; its number is what [`Rig::wait`] takes
    fn start(&self, view: u32, f: impl FnOnce(&CallContext, Responder)) -> usize {
        let n = self.calls.get();
        self.calls.set(n + 1);
        let log = self.log.clone();
        f(
            &self.context(view),
            Responder::new(move |reply: Reply| {
                let reply = reply
                    .map(|v| plain(&v))
                    .map_err(|e| format!("{}: {}", e.name.unwrap_or_default(), e.message));
                log.lock().unwrap().push(Entry::Reply(n, reply));
            }),
        );
        n
    }

    fn run_until(&self, mut done: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(20);
        while !done() {
            assert!(Instant::now() < end, "timed out");
            if let Ok(job) = self.jobs.recv_timeout(Duration::from_millis(5)) {
                job();
            }
        }
    }

    fn reply_of(&self, n: usize) -> Option<Result<Value, String>> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .find_map(|entry| match entry {
                Entry::Reply(m, reply) if *m == n => Some(reply.clone()),
                _ => None,
            })
    }

    /// The answer of call `n`, once it came
    fn wait(&self, n: usize) -> Result<Value, String> {
        self.run_until(|| self.reply_of(n).is_some());
        self.reply_of(n).unwrap()
    }

    /// One call to its end
    fn call(
        &self,
        view: u32,
        f: impl FnOnce(&AiCorePort, &CallContext, Responder),
    ) -> Result<Value, String> {
        let n = self.start(view, |cx, reply| f(&self.port, cx, reply));
        self.wait(n)
    }

    fn app_call(
        &self,
        view: u32,
        f: impl FnOnce(&AppAiPort, &CallContext, Responder),
    ) -> Result<Value, String> {
        let n = self.start(view, |cx, reply| f(&self.app, cx, reply));
        self.wait(n)
    }

    /// The `ai:stream-chunk` events so far
    fn chunks(&self) -> Vec<Value> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter_map(|entry| match entry {
                Entry::Event(_, "ai:stream-chunk", chunk) => Some(chunk.clone()),
                _ => None,
            })
            .collect()
    }

    fn events_of(&self, channel: &str) -> Vec<(Target, Value)> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter_map(|entry| match entry {
                Entry::Event(target, name, arg) if *name == channel => Some((*target, arg.clone())),
                _ => None,
            })
            .collect()
    }

    fn settings_file(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.dir.join("ai-settings.json")).unwrap())
            .unwrap()
    }
}

/// the renderer's settings: DeepSeek with a key
fn renderer_settings() -> Value {
    json!({
        "provider": "deepseek",
        "providers": { "deepseek": { "apiKey": "sk-test", "model": "deepseek-chat" } },
    })
}

fn sse(events: &[Value]) -> Vec<Value> {
    let mut body: Vec<Value> = events
        .iter()
        .map(|event| json!(format!("data: {event}\n\n")))
        .collect();
    body.push(json!("data: [DONE]\n\n"));
    body
}

fn delta(text: &str) -> Value {
    json!({ "choices": [{ "delta": { "content": text } }] })
}

fn stream_request(id: &str) -> Value {
    json!({
        "requestId": id,
        "system": "be brief",
        "messages": [{ "role": "user", "content": "hi" }],
        "settings": renderer_settings(),
    })
}

fn stream(rig: &Rig, view: u32, request: Value) -> usize {
    rig.start(view, |cx, reply| {
        rig.port.ai_stream(cx, vec![ipc(request)], reply)
    })
}

// ---- ai:stream ----

#[test]
fn a_stream_sends_its_chunks_in_order_then_replies() {
    let r = rig(
        "stream",
        None,
        json!({ "fetch": [{
            "method": "POST",
            "urlIncludes": "/chat/completions",
            "headers": { "content-type": "text/event-stream" },
            "body": sse(&[delta("Hel"), delta("lo"), json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] })]),
        }] }),
    );
    let reply = r.call(7, |p, cx, re| {
        p.ai_stream(cx, vec![ipc(stream_request("r1"))], re)
    });
    assert_eq!(reply, Ok(json!("<undefined>")));
    // the response headers (wire activity) tell the renderer the model is alive, the
    // two deltas went out as one chunk, then the end of the turn
    assert_eq!(
        r.chunks(),
        vec![
            json!({ "requestId": "r1", "type": "ping" }),
            json!({ "requestId": "r1", "type": "delta", "text": "Hello" }),
            // the key is there with the value `undefined` when the provider gave no reason
            json!({ "requestId": "r1", "type": "done", "stopReason": "<undefined>" }),
        ]
    );
    // one request, to the provider of the renderer's settings, with its key
    let fetches: Vec<Value> = (r.net_log.lock().unwrap().iter())
        .filter(|line| line[0] == "fetch")
        .cloned()
        .collect();
    assert_eq!(fetches.len(), 1);
    assert_eq!(
        fetches[0][4],
        "https://api.deepseek.com/v1/chat/completions"
    );
    assert!(fetches[0][5].to_string().contains("Bearer sk-test"));
    // every chunk reached the sender view, and all of them before the reply
    let log = r.log.lock().unwrap();
    let reply_at = log
        .iter()
        .position(|e| matches!(e, Entry::Reply(..)))
        .unwrap();
    for (at, entry) in log.iter().enumerate() {
        if let Entry::Event(target, channel, _) = entry {
            assert_eq!(*channel, "ai:stream-chunk");
            assert_eq!(*target, Target::View(ViewId(7)));
            assert!(at < reply_at);
        }
    }
}

#[test]
fn the_stop_reason_a_provider_reports_ends_the_stream_in_its_done_chunk() {
    let events: Vec<Value> = [
        json!({ "type": "message_start", "message": { "usage": { "input_tokens": 3 } } }),
        json!({ "type": "content_block_delta", "delta": { "type": "text_delta", "text": "Cut" } }),
        json!({ "type": "message_delta", "delta": { "stop_reason": "max_tokens" }, "usage": { "output_tokens": 5 } }),
    ]
    .iter()
    .map(|event| json!(format!("data: {event}\n\n")))
    .collect();
    let r = rig(
        "stream-stop",
        None,
        json!({ "fetch": [{
            "method": "POST",
            "urlIncludes": "/v1/messages",
            "headers": { "content-type": "text/event-stream" },
            "body": events,
        }] }),
    );
    let mut request = stream_request("r8");
    request["settings"] = json!({
        "provider": "anthropic",
        "providers": { "anthropic": { "apiKey": "sk-ant", "model": "claude-x" } },
    });
    let reply = r.call(1, |p, cx, re| p.ai_stream(cx, vec![ipc(request)], re));
    assert_eq!(reply, Ok(json!("<undefined>")));
    let chunks = r.chunks();
    let last = chunks.last().unwrap();
    assert_eq!(last["type"], "done");
    assert_eq!(last["stopReason"], "max_tokens");
    // the usage of the turn goes out before the end, and the text before it
    let kinds: Vec<&str> = chunks.iter().map(|c| c["type"].as_str().unwrap()).collect();
    assert!(kinds.ends_with(&["delta", "usage", "done"]), "{kinds:?}");
}

#[test]
fn a_stream_that_fails_ends_with_an_error_chunk_not_a_rejection() {
    let r = rig(
        "stream-fail",
        None,
        json!({ "fetch": [{
            "method": "POST",
            "urlIncludes": "/chat/completions",
            "status": 401,
            "body": ["{\"error\":{\"message\":\"bad key\"}}"],
        }] }),
    );
    let reply = r.call(1, |p, cx, re| {
        p.ai_stream(cx, vec![ipc(stream_request("r2"))], re)
    });
    assert_eq!(reply, Ok(json!("<undefined>")));
    let chunks = r.chunks();
    // the headers were seen before the failure came
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0]["type"], "ping");
    let chunks = &chunks[1..];
    assert_eq!(chunks[0]["type"], "error");
    assert_eq!(chunks[0]["requestId"], "r2");
    assert!(chunks[0]["error"].as_str().unwrap().contains("401"));
}

#[test]
fn a_stream_the_provider_cannot_run_is_refused_before_any_request() {
    let r = rig("stream-refused", None, json!({}));
    // a key provider with no key
    let mut missing = stream_request("r3");
    missing["settings"]["providers"]["deepseek"]["apiKey"] = json!("");
    // a payload that is not settings at all
    let mut invalid = stream_request("r4");
    invalid["settings"] = json!(5);
    for request in [missing, invalid] {
        let reply = r.call(1, |p, cx, re| p.ai_stream(cx, vec![ipc(request)], re));
        assert_eq!(reply, Ok(json!("<undefined>")));
    }
    let chunks = r.chunks();
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0]["type"], "error");
    assert!(
        chunks[0]["error"]
            .as_str()
            .unwrap()
            .contains("No API key configured")
    );
    assert_eq!(chunks[1]["error"], "invalid AI settings payload");
    assert!(r.net.hung.lock().unwrap().is_empty());
}

#[test]
fn a_call_without_a_request_rejects_like_the_destructuring_does() {
    let r = rig("stream-none", None, json!({}));
    let reply = r.call(1, |p, cx, re| p.ai_stream(cx, vec![], re));
    assert!(
        reply
            .unwrap_err()
            .starts_with("TypeError: Cannot destructure property 'requestId'")
    );
    assert!(r.chunks().is_empty());
}

/// a stream to a server that never answers
fn hanging_request(id: &str) -> Value {
    let mut request = stream_request(id);
    request["settings"] = json!({
        "provider": "custom",
        "providers": { "custom": { "apiKey": "k", "model": "m", "baseUrl": "http://hang.test/v1" } },
    });
    request
}

fn wait_for_hung_fetch(r: &Rig) {
    r.run_until(|| !r.net.hung.lock().unwrap().is_empty());
}

#[test]
fn stream_cancel_ends_the_stream_with_done() {
    let r = rig("stream-cancel", None, json!({}));
    let running = stream(&r, 3, hanging_request("r5"));
    wait_for_hung_fetch(&r);
    assert_eq!(r.reply_of(running), None);
    // another request id is not this one
    let other = r.call(3, |p, cx, re| {
        p.ai_stream_cancel(cx, vec![ipc(json!("r-other"))], re)
    });
    assert_eq!(other, Ok(json!("<undefined>")));
    assert_eq!(r.reply_of(running), None);
    let cancel = r.call(3, |p, cx, re| {
        p.ai_stream_cancel(cx, vec![ipc(json!("r5"))], re)
    });
    assert_eq!(cancel, Ok(json!("<undefined>")));
    assert_eq!(r.wait(running), Ok(json!("<undefined>")));
    assert_eq!(
        r.chunks(),
        vec![json!({ "requestId": "r5", "type": "done" })]
    );
    // the request in flight was cut
    assert!(!r.net.cancelled.lock().unwrap().is_empty());
}

#[test]
fn a_stream_ends_when_its_view_goes_away_and_sends_nothing_to_it() {
    let r = rig("stream-destroyed", None, json!({}));
    let running = stream(&r, 4, hanging_request("r6"));
    wait_for_hung_fetch(&r);
    r.views.destroy(4);
    assert_eq!(r.wait(running), Ok(json!("<undefined>")));
    assert!(r.chunks().is_empty());
}

#[test]
fn a_stream_of_a_view_that_navigated_away_ends_too() {
    let r = rig("stream-navigated", None, json!({}));
    let running = stream(&r, 4, hanging_request("r7"));
    wait_for_hung_fetch(&r);
    // the shell set the call's flag without destroying the view
    r.views.cancel_of(4).cancel();
    assert_eq!(r.wait(running), Ok(json!("<undefined>")));
    assert_eq!(
        r.chunks(),
        vec![json!({ "requestId": "r7", "type": "done" })]
    );
}

// ---- ai:chat ----

#[test]
fn a_chat_answers_the_providers_reply() {
    let r = rig(
        "chat",
        None,
        json!({ "fetch": [{
            "method": "POST",
            "urlIncludes": "/chat/completions",
            "headers": { "content-type": "application/json" },
            "body": ["{\"choices\":[{\"message\":{\"content\":\"Hi there\"}}]}"],
        }] }),
    );
    let request = json!({ "system": "s", "user": "hello", "settings": renderer_settings() });
    let reply = r.call(1, |p, cx, re| p.ai_chat(cx, vec![ipc(request)], re));
    assert_eq!(reply, Ok(json!({ "ok": true, "content": "Hi there" })));
}

#[test]
fn a_chat_the_provider_cannot_run_answers_a_refusal_not_a_request() {
    let r = rig("chat-refused", None, json!({}));
    let request = json!({ "system": "s", "user": "hello", "settings": 5 });
    let reply = r.call(1, |p, cx, re| p.ai_chat(cx, vec![ipc(request)], re));
    assert_eq!(
        reply,
        Ok(json!({ "ok": false, "error": "invalid AI settings payload" }))
    );
    let reply = r.call(1, |p, cx, re| p.ai_chat(cx, vec![], re));
    assert!(
        reply
            .unwrap_err()
            .starts_with("TypeError: Cannot read properties of undefined")
    );
}

#[test]
fn a_chat_that_fails_answers_ok_false() {
    let r = rig(
        "chat-fail",
        None,
        json!({ "fetch": [{ "method": "POST", "urlIncludes": "/chat/completions", "status": 400, "body": ["nope"], "times": "always" }] }),
    );
    let request = json!({ "system": "s", "user": "hello", "settings": renderer_settings() });
    let reply = r
        .call(1, |p, cx, re| p.ai_chat(cx, vec![ipc(request)], re))
        .unwrap();
    assert_eq!(reply["ok"], false);
    assert!(reply["error"].as_str().unwrap().contains("400"));
}

// ---- settings ----

fn stored_with_sealed_key() -> Value {
    json!({
        "provider": "deepseek",
        "providers": { "deepseek": { "apiKey": sealed("sk-secret"), "model": "deepseek-chat" } },
        "futureField": { "kept": true },
    })
}

#[test]
fn settings_are_read_with_their_keys_opened() {
    let r = rig("get", Some(stored_with_sealed_key()), json!({}));
    let settings = r
        .call(1, |p, cx, re| p.ai_get_settings(cx, vec![], re))
        .unwrap();
    assert_eq!(settings["provider"], "deepseek");
    assert_eq!(settings["providers"]["deepseek"]["apiKey"], "sk-secret");
    // a build reads only what it knows
    assert!(settings.get("futureField").is_none());
    // reading changes nothing on disk
    assert_eq!(r.settings_file(), stored_with_sealed_key());
}

#[test]
fn a_file_from_before_notice_versions_is_migrated_once_when_read() {
    let mut stored = stored_with_sealed_key();
    stored["subscriptionNoticeSeen"] = json!(true);
    let r = rig("migrate", Some(stored), json!({}));
    let settings = r
        .call(1, |p, cx, re| p.ai_get_settings(cx, vec![], re))
        .unwrap();
    assert_eq!(settings["subscriptionNoticeVersion"], 1);
    // the file got the version, with its key still sealed and its other fields kept
    let file = r.settings_file();
    assert_eq!(file["subscriptionNoticeVersion"], 1);
    assert_eq!(file["providers"]["deepseek"]["apiKey"], sealed("sk-secret"));
    assert_eq!(file["futureField"], json!({ "kept": true }));
}

#[test]
fn saved_settings_keep_what_only_the_main_process_writes_and_seal_the_keys() {
    let mut stored = stored_with_sealed_key();
    stored["providers"]["deepseek"]["models"] = json!(["deepseek-chat", "deepseek-reasoner"]);
    stored["subscriptionOff"] = json!({ "codex": true });
    let r = rig("set", Some(stored), json!({}));
    let sent = json!({
        "provider": "deepseek",
        "providers": { "deepseek": {
            "apiKey": "sk-new", "model": "deepseek-reasoner", "models": ["injected"],
        } },
        "subscriptionOff": {},
    });
    let reply = r.call(2, |p, cx, re| p.ai_set_settings(cx, vec![ipc(sent)], re));
    assert_eq!(reply, Ok(json!("<undefined>")));
    let file = r.settings_file();
    // the key is sealed on disk, and opened for readers
    assert_eq!(file["providers"]["deepseek"]["apiKey"], sealed("sk-new"));
    assert_eq!(file["providers"]["deepseek"]["model"], "deepseek-reasoner");
    // the live model list is the file's, the CLIs turned off are the file's
    assert_eq!(
        file["providers"]["deepseek"]["models"],
        json!(["deepseek-chat", "deepseek-reasoner"])
    );
    assert_eq!(file["subscriptionOff"], json!({ "codex": true }));
    // a field a newer build wrote stays
    assert_eq!(file["futureField"], json!({ "kept": true }));
    // every renderer is told
    assert_eq!(
        r.events_of("ai:settings-changed"),
        vec![(Target::All, json!("<none>"))]
    );
    let read = r
        .call(1, |p, cx, re| p.ai_get_settings(cx, vec![], re))
        .unwrap();
    assert_eq!(read["providers"]["deepseek"]["apiKey"], "sk-new");
}

#[test]
fn a_payload_that_is_not_settings_changes_nothing() {
    let r = rig("set-invalid", Some(stored_with_sealed_key()), json!({}));
    for sent in [
        json!(5),
        json!({ "provider": "nope", "providers": {} }),
        Value::Null,
    ] {
        let reply = r.call(2, |p, cx, re| p.ai_set_settings(cx, vec![ipc(sent)], re));
        assert_eq!(reply, Ok(json!("<undefined>")));
    }
    assert_eq!(r.settings_file(), stored_with_sealed_key());
    assert!(r.events_of("ai:settings-changed").is_empty());
}

#[test]
fn a_headless_run_writes_no_setting_but_still_tells_the_windows() {
    let r = rig("set-headless", Some(stored_with_sealed_key()), json!({}));
    *r.host.headless.lock().unwrap() = true;
    let sent = json!({
        "provider": "deepseek",
        "providers": { "deepseek": { "apiKey": "sk-new", "model": "m" } },
    });
    let reply = r.call(2, |p, cx, re| p.ai_set_settings(cx, vec![ipc(sent)], re));
    assert_eq!(reply, Ok(json!("<undefined>")));
    assert_eq!(r.settings_file(), stored_with_sealed_key());
    assert_eq!(r.events_of("ai:settings-changed").len(), 1);
}

#[test]
fn a_changed_key_asks_the_provider_for_its_models_and_the_list_lands_in_the_file() {
    let r = rig(
        "models",
        None,
        json!({ "fetch": [{
            "urlIncludes": "api.deepseek.com/v1/models",
            "body": ["{\"data\":[{\"id\":\"model-one\"},{\"id\":\"model-two\"}]}"],
        }] }),
    );
    let reply = r.call(2, |p, cx, re| {
        p.ai_set_settings(cx, vec![ipc(renderer_settings())], re)
    });
    assert_eq!(reply, Ok(json!("<undefined>")));
    r.run_until(|| r.events_of("ai:settings-changed").len() == 2);
    let models = r.settings_file()["providers"]["deepseek"]["models"].clone();
    assert_eq!(models, json!(["model-one", "model-two"]));
}

// ---- tool capabilities ----

#[test]
fn tool_capabilities_ask_the_host_with_the_stored_settings_and_the_screen_path() {
    let r = rig("caps", Some(stored_with_sealed_key()), json!({}));
    *r.host.statuses.lock().unwrap() = Some(json_value_from_serde(
        &json!({ "codex": { "state": "ready" } }),
    ));
    let reply = r.call(1, |p, cx, re| p.ai_tool_capabilities(cx, vec![], re));
    assert_eq!(reply, Ok(json!({ "webSearch": { "available": true } })));
    let asked = r.host.capabilities.lock().unwrap();
    let (settings, context) = &asked[0];
    assert_eq!(
        json_value_to_serde(settings)["providers"]["deepseek"]["apiKey"],
        "sk-secret"
    );
    assert_eq!(
        json_value_to_serde(context),
        json!({ "path": "screen", "statuses": { "codex": { "state": "ready" } } })
    );
}

#[test]
fn the_sheets_capabilities_read_the_file_as_the_search_package_does() {
    let r = rig("sheets-caps", Some(stored_with_sealed_key()), json!({}));
    let reply = r.app_call(1, |p, cx, re| p.sheets_ai_tool_capabilities(cx, vec![], re));
    assert_eq!(reply, Ok(json!({ "webSearch": { "available": true } })));
    let asked = r.host.capabilities.lock().unwrap();
    assert_eq!(
        json_value_to_serde(&asked[0].0)["providers"]["deepseek"]["apiKey"],
        "sk-secret"
    );
}

#[test]
fn ai_content_queued_for_a_tab_is_consumed_once() {
    let r = rig("consume", None, json!({}));
    r.pending
        .queue(9, &json!({ "title": "T", "html": "<p>x</p>" }));
    let first = r.app_call(9, |p, cx, re| p.docs_consume_ai_doc_content(cx, vec![], re));
    assert_eq!(first, Ok(json!({ "title": "T", "html": "<p>x</p>" })));
    let again = r.app_call(9, |p, cx, re| p.docs_consume_ai_doc_content(cx, vec![], re));
    assert_eq!(again, Ok(Value::Null));
    // another tab has its own
    let other = r.app_call(8, |p, cx, re| p.docs_consume_ai_doc_content(cx, vec![], re));
    assert_eq!(other, Ok(Value::Null));
}

// ---- model lists ----

#[test]
fn custom_models_are_listed_from_the_servers_models_endpoint() {
    let r = rig(
        "custom-models",
        None,
        json!({ "fetch": [{
            "url": "http://models.test/v1/models",
            "body": ["{\"data\":[{\"id\":\" a \"},{\"id\":\"b\"},{\"id\":\"a\"}]}"],
        }] }),
    );
    let input = json!({ "baseUrl": "http://models.test/v1/" });
    let reply = r.call(1, |p, cx, re| p.ai_custom_models(cx, vec![ipc(input)], re));
    assert_eq!(
        reply,
        Ok(json!({ "models": ["a", "b"], "defaultModel": "" }))
    );
    // no base URL: no list, and no request
    let none = r.call(1, |p, cx, re| p.ai_custom_models(cx, vec![], re));
    assert_eq!(none, Ok(json!({ "models": [], "defaultModel": "" })));
}

#[test]
fn local_models_and_inspect_answer_a_shape_error_for_a_malformed_payload() {
    let r = rig("local-shape", None, json!({}));
    let models = r.call(1, |p, cx, re| {
        p.ai_local_models(cx, vec![ipc(json!({ "baseUrl": "ftp://x" }))], re)
    });
    assert_eq!(models.as_ref().unwrap()["errorCode"], "shape");
    let inspect = r.call(1, |p, cx, re| p.ai_local_inspect(cx, vec![], re));
    assert_eq!(inspect.as_ref().unwrap()["errorCode"], "shape");
}

#[test]
fn codex_is_not_started_for_its_list_when_it_is_turned_off() {
    let r = rig(
        "codex-off",
        Some(json!({ "subscriptionOff": { "codex": true } })),
        json!({}),
    );
    let reply = r.call(1, |p, cx, re| p.ai_codex_models(cx, vec![], re));
    assert_eq!(
        reply,
        Err("Error: Codex is turned off in this app".to_owned())
    );
}

// ---- the local model test ----

fn local_test_input(test_id: &str) -> Value {
    json!({ "baseUrl": "http://hang.test:1234/v1", "model": "m", "testId": test_id })
}

#[test]
fn a_local_test_ends_cancelled_when_its_test_id_is_cancelled_from_the_same_window() {
    let r = rig("local-cancel", None, json!({}));
    let running = r.start(5, |cx, re| {
        r.port
            .ai_local_test(cx, vec![ipc(local_test_input("t1"))], re)
    });
    wait_for_hung_fetch(&r);
    // another window cannot cancel it, nor can another id
    let foreign = r.call(6, |p, cx, re| {
        p.ai_local_test_cancel(cx, vec![ipc(json!({ "testId": "t1" }))], re)
    });
    assert_eq!(foreign, Ok(json!(false)));
    let unknown = r.call(5, |p, cx, re| {
        p.ai_local_test_cancel(cx, vec![ipc(json!("t2"))], re)
    });
    assert_eq!(unknown, Ok(json!(false)));
    assert_eq!(r.reply_of(running), None);
    let cancel = r.call(5, |p, cx, re| {
        p.ai_local_test_cancel(cx, vec![ipc(json!({ "testId": "t1" }))], re)
    });
    assert_eq!(cancel, Ok(json!(true)));
    let result = r.wait(running).unwrap();
    assert_eq!(result["cancelled"], true);
    assert!(!r.net.cancelled.lock().unwrap().is_empty());
    // the test is over: nothing is left to cancel
    let again = r.call(5, |p, cx, re| {
        p.ai_local_test_cancel(cx, vec![ipc(json!({ "testId": "t1" }))], re)
    });
    assert_eq!(again, Ok(json!(false)));
}

#[test]
fn a_local_test_ends_when_the_window_that_asked_is_closed() {
    let r = rig("local-destroyed", None, json!({}));
    let running = r.start(5, |cx, re| {
        r.port
            .ai_local_test(cx, vec![ipc(local_test_input("t3"))], re)
    });
    wait_for_hung_fetch(&r);
    r.views.destroy(5);
    let result = r.wait(running).unwrap();
    assert_eq!(result["cancelled"], true);
}

#[test]
fn a_malformed_local_test_skips_every_check() {
    let r = rig("local-shape-test", None, json!({}));
    let result = r
        .call(1, |p, cx, re| {
            p.ai_local_test(cx, vec![ipc(json!({ "baseUrl": 5 }))], re)
        })
        .unwrap();
    assert_eq!(result["inputError"], "shape");
    assert!(r.net.hung.lock().unwrap().is_empty());
}

// ---- the page reader ----

#[test]
fn a_page_is_read_through_the_host_with_the_offset() {
    let r = rig("read-url", None, json!({}));
    r.host
        .reads
        .lock()
        .unwrap()
        .push_back(Ok(json_value_from_serde(
            &json!({ "ok": true, "text": "abc", "nextOffset": 3 }),
        )));
    let reply = r.call(1, |p, cx, re| {
        p.ai_read_url(
            cx,
            vec![ipc(json!("https://example.com/a")), ipc(json!(40))],
            re,
        )
    });
    assert_eq!(
        reply,
        Ok(json!({ "ok": true, "text": "abc", "nextOffset": 3 }))
    );
    assert_eq!(
        *r.host.read_requests.lock().unwrap(),
        vec![("https://example.com/a".to_owned(), 40.0)]
    );
}

#[test]
fn a_url_that_is_no_string_is_refused_before_any_read() {
    let r = rig("read-url-invalid", None, json!({}));
    for args in [vec![], vec![ipc(json!(5))], vec![ipc(json!("  "))]] {
        let reply = r.call(1, |p, cx, re| p.ai_read_url(cx, args, re));
        assert_eq!(
            reply,
            Ok(json!({ "ok": false, "error": "url must be a string", "errorCode": "invalid_url" }))
        );
    }
    assert!(r.host.read_requests.lock().unwrap().is_empty());
}

#[test]
fn a_read_that_throws_answers_the_unexpected_failure() {
    let r = rig("read-url-throws", None, json!({}));
    r.host
        .reads
        .lock()
        .unwrap()
        .push_back(Err(json_value_from_serde(
            &json!({ "$class": "Error", "message": "boom" }),
        )));
    let reply = r.call(1, |p, cx, re| {
        p.ai_read_url(cx, vec![ipc(json!("https://x.test/"))], re)
    });
    assert_eq!(
        reply,
        Ok(json!({ "ok": false, "error": "The read failed.", "errorCode": "network" }))
    );
}

#[test]
fn stop_cuts_the_download_of_the_tab_whose_run_is_stopped_only() {
    let r = rig("read-url-stop", None, json!({}));
    *r.host.slow_read.lock().unwrap() = Some("https://slow.test/".into());
    let reading = r.start(3, |cx, re| {
        r.port
            .ai_read_url(cx, vec![ipc(json!("https://slow.test/"))], re)
    });
    r.run_until(|| !r.host.read_requests.lock().unwrap().is_empty());
    // the stop of another tab leaves it alone
    let other = r.call(4, |p, cx, re| {
        p.ai_stream_cancel(cx, vec![ipc(json!("r"))], re)
    });
    assert_eq!(other, Ok(json!("<undefined>")));
    // a stream-only cancel does not reach media calls
    let request_only = r.call(3, |p, cx, re| {
        p.ai_stream_cancel(cx, vec![ipc(json!("r")), ipc(json!("request"))], re)
    });
    assert_eq!(request_only, Ok(json!("<undefined>")));
    assert_eq!(r.reply_of(reading), None);
    let stop = r.call(3, |p, cx, re| {
        p.ai_stream_cancel(cx, vec![ipc(json!("r"))], re)
    });
    assert_eq!(stop, Ok(json!("<undefined>")));
    assert_eq!(
        r.wait(reading),
        Ok(json!({ "ok": false, "error": "aborted" }))
    );
    assert!(*r.host.read_cancelled.lock().unwrap());
}

// ---- the tools the host runs ----

#[test]
fn a_search_goes_to_the_backend_the_settings_select_and_a_rejection_is_an_answer() {
    let r = rig(
        "search",
        Some(json!({
            "provider": "deepseek",
            "providers": { "deepseek": { "apiKey": "", "model": "" } },
            "search": { "provider": "serper", "providers": { "serper": { "apiKey": sealed("sk-serper") } } },
        })),
        json!({}),
    );
    r.host
        .web
        .lock()
        .unwrap()
        .push_back(Ok(json_value_from_serde(
            &json!({ "results": [{ "title": "t" }], "method": "serper" }),
        )));
    let reply = r.call(1, |p, cx, re| {
        p.ai_web_search(cx, vec![ipc(json!("rust")), ipc(json!(3))], re)
    });
    assert_eq!(
        reply,
        Ok(json!({ "results": [{ "title": "t" }], "method": "serper" }))
    );
    {
        let searches = r.host.searches.lock().unwrap();
        let (kind, query, max, options) = &searches[0];
        assert_eq!((kind.as_str(), query.as_str(), *max), ("web", "rust", 3.0));
        let options = json_value_to_serde(options);
        assert_eq!(options["serperKey"], "sk-serper");
        assert_eq!(options["prefer"], "serper");
    }
    // the default count, and a rejection of the backend
    r.host
        .web
        .lock()
        .unwrap()
        .push_back(Err(json_value_from_serde(
            &json!({ "$class": "Error", "message": "boom" }),
        )));
    let failed = r.call(1, |p, cx, re| {
        p.ai_web_search(cx, vec![ipc(json!("rust"))], re)
    });
    assert_eq!(
        failed,
        Ok(json!({ "results": [], "method": "error", "error": "Error: boom" }))
    );
    assert_eq!(r.host.searches.lock().unwrap()[1].2, 6.0);
    let images = r.call(1, |p, cx, re| {
        p.ai_image_search(cx, vec![ipc(json!("cats"))], re)
    });
    assert_eq!(images, Ok(json!({ "images": [], "method": "ddg" })));
    assert_eq!(r.host.searches.lock().unwrap()[2].2, 8.0);
}

#[test]
fn a_search_test_needs_a_known_provider_and_a_key() {
    let r = rig("search-test", None, json!({}));
    let unknown = r.call(1, |p, cx, re| {
        p.ai_search_test(cx, vec![ipc(json!({ "provider": "nope" }))], re)
    });
    assert_eq!(
        unknown,
        Ok(json!({ "ok": false, "error": "No search provider to test" }))
    );
    let none = r.call(1, |p, cx, re| p.ai_search_test(cx, vec![], re));
    assert_eq!(
        none,
        Ok(json!({ "ok": false, "error": "No search provider to test" }))
    );
    let keyless = r.call(1, |p, cx, re| {
        p.ai_search_test(
            cx,
            vec![ipc(json!({ "provider": "serper", "apiKey": "  " }))],
            re,
        )
    });
    assert_eq!(
        keyless,
        Ok(json!({ "ok": false, "error": "API key is empty" }))
    );
    // the backend answered through the provider that was tested
    r.host
        .web
        .lock()
        .unwrap()
        .push_back(Ok(json_value_from_serde(
            &json!({ "results": [], "method": "serper" }),
        )));
    let ok = r.call(1, |p, cx, re| {
        p.ai_search_test(
            cx,
            vec![ipc(json!({ "provider": "serper", "apiKey": "k" }))],
            re,
        )
    });
    assert_eq!(ok, Ok(json!({ "ok": true })));
    assert_eq!(r.host.searches.lock().unwrap()[0].1, "weather");
}

#[test]
fn a_media_test_checks_the_provider_and_its_configuration_before_any_request() {
    let r = rig("media-test", None, json!({}));
    let unknown = r.call(1, |p, cx, re| {
        p.ai_media_test(cx, vec![ipc(json!({ "provider": "nope" }))], re)
    });
    assert_eq!(
        unknown,
        Ok(json!({ "ok": false, "error": "No media provider to test" }))
    );
    let no_config = r.call(1, |p, cx, re| {
        p.ai_media_test(cx, vec![ipc(json!({ "provider": "openai" }))], re)
    });
    assert_eq!(
        no_config,
        Ok(json!({ "ok": false, "error": "No media provider configuration" }))
    );
}

#[test]
fn a_media_test_lists_the_providers_models() {
    let r = rig(
        "media-test-net",
        None,
        json!({ "fetch": [{ "urlIncludes": "/models", "body": ["{\"data\":[]}"] }] }),
    );
    let input = json!({ "provider": "openai", "config": { "apiKey": "sk-test" } });
    let reply = r.call(1, |p, cx, re| {
        p.ai_media_test(cx, vec![ipc(input.clone())], re)
    });
    assert_eq!(reply, Ok(json!({ "ok": true })));
    // a refused key is the provider's status in the answer
    let refused = rig(
        "media-test-refused",
        None,
        json!({ "fetch": [{ "urlIncludes": "/models", "status": 401, "body": ["no"] }] }),
    );
    let reply = refused
        .call(1, |p, cx, re| p.ai_media_test(cx, vec![ipc(input)], re))
        .unwrap();
    assert_eq!(reply["ok"], false);
    assert!(reply["error"].as_str().unwrap().contains("401"));
}

#[test]
fn a_remote_image_is_answered_as_base64_with_the_mime_the_server_named() {
    let r = rig("fetch-image", None, json!({}));
    {
        let mut images = r.host.images.lock().unwrap();
        images.push_back(Some((vec![1, 2, 3], "image/PNG; x".into())));
        images.push_back(Some((vec![4], "image/gif".into())));
        images.push_back(Some((vec![5], "".into())));
        images.push_back(None);
    }
    let mut got = Vec::new();
    for _ in 0..4 {
        got.push(r.call(1, |p, cx, re| {
            p.ai_fetch_image(cx, vec![ipc(json!("https://i.test/a"))], re)
        }));
    }
    // `png` is looked for as the server wrote it
    assert_eq!(
        got[0],
        Ok(json!({ "base64": "AQID", "mime": "image/jpeg" }))
    );
    assert_eq!(got[1], Ok(json!({ "base64": "BA==", "mime": "image/gif" })));
    assert_eq!(
        got[2],
        Ok(json!({ "base64": "BQ==", "mime": "image/jpeg" }))
    );
    assert_eq!(got[3], Ok(Value::Null));
}
