//! The image channels over a fake network (the key providers' HTTP) and a
//! fake Codex generator. The core thread queues its jobs and the test thread
//! runs them until the answer comes.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender as Chan};
use std::sync::{Arc, Mutex};
use std::thread::{self, ThreadId};
use std::time::{Duration, Instant};

use main_core::packages::ai_provider::media_protocols::bytes_to_base64;
use main_core::packages::electron_utils::generated_images::read_generated_image;
use serde_json::json;
use shell_contract::hosts::Hosts;
use shell_contract::ipc::{CallContext, EventSink, Responder, Sender, Target};
use shell_contract::runtime::{AppPaths, Services, Thread, Views, Workers};
use shell_contract::{IpcValue, Surface, ViewId, WindowId};

use super::*;
use crate::runtime::testing::FakeNet;

const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 1, 2, 3, 4];
const VIEW: u32 = 7;

type Job = Box<dyn FnOnce() + Send>;

struct Core {
    jobs: Chan<Job>,
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

struct Live(Mutex<HashSet<u32>>);

impl Views for Live {
    fn sender_of(&self, view: ViewId) -> Option<Sender> {
        self.0.lock().unwrap().contains(&view.0).then(|| Sender {
            view,
            window: WindowId(1),
            surface: Surface::Shell,
        })
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
            PathName::Temp => self.0.join("tmp"),
            PathName::UserData => self.0.join("userData"),
            _ => self.0.clone(),
        }
    }
}

struct NoEvents;

impl EventSink for NoEvents {
    fn emit(&self, _: Target, _: &'static str, _: Vec<IpcValue>) {}
}

/// What the Codex generator does
enum Codex {
    Url(&'static str),
    Bytes,
    Fail(&'static str),
    /// waits until the call's signal fires, then fails as an abort does
    UntilCancelled,
}

struct FakeHost {
    statuses: JsonValue,
    route: CodexImageRoute,
    codex: Mutex<Vec<Codex>>,
    asked: Mutex<Vec<CodexImageRequest>>,
}

impl AppAiImageHost for FakeHost {
    fn shared_subscription_statuses(&self) -> JsonValue {
        self.statuses.clone()
    }
    fn codex_image_route(&self) -> CodexImageRoute {
        self.route
    }
    fn codex_generate_image(
        &self,
        request: &CodexImageRequest,
        signal: &CancelToken,
    ) -> Result<CodexImage, JsError> {
        self.asked.lock().unwrap().push(request.clone());
        let step = self.codex.lock().unwrap().remove(0);
        match step {
            Codex::Url(url) => Ok(CodexImage::Url(url.to_owned())),
            Codex::Bytes => Ok(CodexImage::Bytes {
                bytes: PNG.to_vec(),
                mime: "image/png".into(),
            }),
            Codex::Fail(message) => Err(JsError::error(message)),
            Codex::UntilCancelled => {
                let started = Instant::now();
                while !signal.is_cancelled() {
                    assert!(
                        started.elapsed() < Duration::from_secs(10),
                        "never cancelled"
                    );
                    thread::sleep(Duration::from_millis(2));
                }
                Err(JsError::abort())
            }
        }
    }
}

struct Rig {
    dir: PathBuf,
    views: Arc<Live>,
    host: Arc<FakeHost>,
    jobs: Receiver<Job>,
    provided: Rc<Provided>,
    port: Rc<dyn AppAiImage>,
}

fn statuses(codex_ready: bool) -> JsonValue {
    let mut o = jscompat::JsObject::new();
    if codex_ready {
        o.set(
            "codex",
            object(vec![("provider", text("codex")), ("state", text("ready"))]),
        );
    }
    JsonValue::Object(o)
}

fn rig(
    name: &str,
    codex_ready: bool,
    route: CodexImageRoute,
    codex: Vec<Codex>,
    net: serde_json::Value,
) -> Rig {
    let dir = std::env::temp_dir().join(format!(
        "shell-a-app-ai-image-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("userData")).unwrap();
    let (tx, jobs) = mpsc::channel();
    let core: Arc<dyn Thread> = Arc::new(Core {
        jobs: tx,
        owner: thread::current().id(),
    });
    let views = Arc::new(Live(Mutex::new(HashSet::from([VIEW]))));
    let host = Arc::new(FakeHost {
        statuses: statuses(codex_ready),
        route,
        codex: Mutex::new(codex),
        asked: Mutex::default(),
    });
    let mut hosts = Hosts::default();
    let handle: AppAiImageHostHandle = host.clone();
    hosts.insert(handle);
    let services = Services {
        ui: core.clone(),
        core,
        workers: Arc::new(Threads),
        events: Arc::new(NoEvents),
        views: views.clone(),
        paths: Arc::new(Dir(dir.clone())),
        hosts: Arc::new(hosts),
    };
    let provided = Rc::new(Provided::default());
    provided.add(Rc::new(Driver::new(&services, FakeNet::new(&net, None))));
    let port = (factory().0)(&services, &provided).unwrap();
    Rig {
        dir,
        views,
        host,
        jobs,
        provided,
        port,
    }
}

fn write_settings(rig: &Rig, settings: serde_json::Value) {
    std::fs::write(
        rig.dir.join("userData").join("ai-settings.json"),
        settings.to_string(),
    )
    .unwrap();
}

fn context(view: u32) -> CallContext {
    CallContext {
        sender: Sender {
            view: ViewId(view),
            window: WindowId(1),
            surface: Surface::Shell,
        },
        request: None,
        cancel: CancelToken::default(),
    }
}

type Answer = mpsc::Receiver<shell_contract::ipc::Reply>;

impl Rig {
    fn start(&self, channel: &str, op: serde_json::Value) -> Answer {
        let (tx, rx) = mpsc::channel();
        let reply = Responder::new(move |r| {
            let _ = tx.send(r);
        });
        let cx = context(VIEW);
        let args = vec![crate::value::from_json(&jscompat::json_value_from_serde(
            &op,
        ))];
        match channel {
            "docs" => self.port.docs_ai_generate_image(&cx, args, reply),
            "html" => self.port.html_ai_generate_image(&cx, args, reply),
            "hwp" => self.port.hwp_ai_generate_image(&cx, args, reply),
            "markdown" => self.port.markdown_ai_generate_image(&cx, args, reply),
            "mindmap" => self.port.mindmap_ai_generate_image(&cx, args, reply),
            "sheets" => self.port.sheets_ai_generate_image(&cx, args, reply),
            other => panic!("{other}"),
        }
        rx
    }

    /// Runs the core thread's jobs until the call answers
    fn finish(&self, answer: &Answer) -> serde_json::Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(reply) = answer.try_recv() {
                let value = reply.expect("the handler resolves");
                return jscompat::json_value_to_serde(&crate::value::to_json(&value).unwrap());
            }
            assert!(Instant::now() < deadline, "no answer");
            if let Ok(job) = self.jobs.recv_timeout(Duration::from_millis(5)) {
                job();
            }
        }
    }

    fn call(&self, channel: &str, op: serde_json::Value) -> serde_json::Value {
        let answer = self.start(channel, op);
        self.finish(&answer)
    }

    fn tmp(&self) -> String {
        self.dir.join("tmp").to_string_lossy().into_owned()
    }
}

const READY: CodexImageRoute = CodexImageRoute {
    available: true,
    registered: true,
};
const NO_CODEX: CodexImageRoute = CodexImageRoute {
    available: false,
    registered: false,
};

fn openai_settings() -> serde_json::Value {
    json!({ "providers": {}, "media": {
        "imageProvider": "openai",
        "providers": { "openai": { "apiKey": "sk-test", "imageModel": "gpt-image-1" } },
    }})
}

fn openai_net(status: u16, body: serde_json::Value) -> serde_json::Value {
    json!({ "fetch": [{
        "method": "POST",
        "urlIncludes": "/images/generations",
        "status": status,
        "headers": { "content-type": "application/json" },
        "body": body.to_string(),
    }]})
}

#[test]
fn a_key_provider_image_is_stored_and_answered_as_a_file_url() {
    let net = openai_net(
        200,
        json!({ "data": [{ "b64_json": bytes_to_base64(PNG) }] }),
    );
    for channel in ["docs", "html", "hwp", "markdown", "mindmap", "sheets"] {
        let r = rig(
            &format!("key-{channel}"),
            false,
            NO_CODEX,
            vec![],
            net.clone(),
        );
        write_settings(&r, openai_settings());
        let answer = r.call(
            channel,
            json!({ "prompt": "  a red fox ", "aspectRatio": "16:9" }),
        );
        let url = answer["url"]
            .as_str()
            .unwrap_or_else(|| panic!("{channel}: {answer}"));
        assert!(url.starts_with("file://"), "{channel}: {url}");
        let stored = read_generated_image(&r.tmp(), url).expect("the picture is in the store");
        assert_eq!(stored.bytes, PNG, "{channel}");
        assert_eq!(stored.mime, "image/png", "{channel}");
        assert_eq!(answer.as_object().unwrap().len(), 1, "{channel}: {answer}");
    }
}

#[test]
fn a_provider_failure_is_an_error_answer_not_a_rejection() {
    let net = openai_net(401, json!({ "error": { "message": "bad key" } }));
    let r = rig("failed", false, NO_CODEX, vec![], net);
    write_settings(&r, openai_settings());
    let answer = r.call("docs", json!({ "prompt": "fox" }));
    let error = answer["error"].as_str().unwrap();
    assert!(error.starts_with("Image generation failed:"), "{error}");
    assert!(answer.get("url").is_none());
}

#[test]
fn an_empty_prompt_is_refused_before_any_route_is_looked_at() {
    let r = rig("empty", false, NO_CODEX, vec![], json!({}));
    for op in [
        json!({}),
        json!({ "prompt": "   " }),
        json!({ "prompt": null }),
    ] {
        assert_eq!(
            r.call("sheets", op),
            json!({ "error": "prompt must not be empty" })
        );
    }
}

#[test]
fn nothing_configured_answers_unavailable() {
    let r = rig("none", false, NO_CODEX, vec![], json!({}));
    let answer = r.call("markdown", json!({ "prompt": "fox" }));
    assert_eq!(answer["errorCode"], "unavailable");
    assert!(
        answer["error"]
            .as_str()
            .unwrap()
            .starts_with("Image generation is unavailable")
    );
}

#[test]
fn the_codex_route_runs_the_generator_with_the_prompt_and_ratio() {
    let r = rig(
        "codex",
        true,
        READY,
        vec![Codex::Url("file:///tmp/x.png"), Codex::Bytes],
        json!({}),
    );
    let answer = r.call("html", json!({ "prompt": " owl ", "aspectRatio": "1:1" }));
    assert_eq!(answer, json!({ "url": "file:///tmp/x.png" }));
    // a picture the generator hands as bytes is stored like a provider's
    let answer = r.call("hwp", json!({ "prompt": "owl" }));
    let stored = read_generated_image(&r.tmp(), answer["url"].as_str().unwrap()).unwrap();
    assert_eq!(stored.bytes, PNG);
    assert_eq!(
        *r.host.asked.lock().unwrap(),
        vec![
            CodexImageRequest {
                prompt: "owl".into(),
                aspect_ratio: Some("1:1".into())
            },
            CodexImageRequest {
                prompt: "owl".into(),
                aspect_ratio: None
            },
        ]
    );
}

#[test]
fn a_codex_failure_is_an_error_answer() {
    let r = rig(
        "codex-fail",
        true,
        READY,
        vec![Codex::Fail("codex is busy")],
        json!({}),
    );
    assert_eq!(
        r.call("mindmap", json!({ "prompt": "owl" })),
        json!({ "error": "codex is busy" })
    );
}

#[test]
fn stopping_the_windows_run_aborts_its_generation() {
    let r = rig("abort", true, READY, vec![Codex::UntilCancelled], json!({}));
    let answer = r.start("docs", json!({ "prompt": "owl" }));
    for abort in r.provided.all::<dyn MediaCallAbort>() {
        abort.abort_media_calls(f64::from(VIEW));
    }
    let answer = r.finish(&answer);
    assert_eq!(answer["error"], "This operation was aborted");
}

#[test]
fn a_destroyed_window_starts_its_generation_aborted() {
    let r = rig(
        "destroyed",
        true,
        READY,
        vec![Codex::UntilCancelled],
        json!({}),
    );
    r.views.0.lock().unwrap().clear();
    let answer = r.call("sheets", json!({ "prompt": "owl" }));
    assert_eq!(answer["error"], "This operation was aborted");
}

#[test]
fn the_registrable_domain_of_a_host() {
    assert_eq!(registrable_domain("api.bfl.ai").as_deref(), Some("bfl.ai"));
    assert_eq!(registrable_domain("x.y.co.uk").as_deref(), Some("y.co.uk"));
    assert_eq!(
        registrable_domain("A.Tenant.appspot.com").as_deref(),
        Some("tenant.appspot.com")
    );
    assert_eq!(
        registrable_domain("a.b.s3.amazonaws.com").as_deref(),
        Some("b.s3.amazonaws.com")
    );
    assert_eq!(registrable_domain("127.0.0.1"), None);
    assert_eq!(registrable_domain("localhost"), None);
}

#[test]
fn a_flux_job_polled_from_another_tenant_of_the_same_host_gets_no_key() {
    let net = json!({ "fetch": [{
        "method": "POST",
        "urlIncludes": "/v1/flux-2-pro",
        "status": 200,
        "headers": { "content-type": "application/json" },
        "body": json!({ "id": "job", "polling_url": "https://evil.appspot.com/v1/get_result?id=job" }).to_string(),
    }]});
    let r = rig("flux-tenant", false, NO_CODEX, vec![], net);
    write_settings(
        &r,
        json!({ "providers": {}, "media": {
            "imageProvider": "bfl",
            "providers": { "bfl": {
                "apiKey": "bfl-key",
                "imageModel": "flux-2-pro",
                "baseUrl": "https://mine.appspot.com",
            } },
        }}),
    );
    let answer = r.call("docs", json!({ "prompt": "fox" }));
    let error = answer["error"]
        .as_str()
        .unwrap_or_else(|| panic!("{answer}"));
    assert!(
        error.contains("not its own (https://evil.appspot.com)")
            && error.contains("The API key was not sent"),
        "{error}"
    );
}
