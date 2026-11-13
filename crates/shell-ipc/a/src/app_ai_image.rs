//! The editors' image generation channels: `docs:ai-generate-image`
//! (`apps/docs/src/main/docs-main.ts`), `html:ai-generate-image`
//! (`html-main.ts`), `hwp:ai-generate-image` (`apps/hwp/src/main/ai-image.ts`),
//! `markdown:ai-generate-image` (`markdown-main.ts`),
//! `mindmap:ai-generate-image` (`apps/mindmap/src/main/ai-image.ts`) and
//! `sheets:ai-generate-image` (`sheets-main.ts`). Every handler is
//! `withMediaCallSignal(sender, signal => generateImageTool(settingsPath,
//! { prompt, aspectRatio }, { mediaRoots, context: screen, signal }))`.
//!
//! The hwp and mindmap handlers begin in `main_core::{hwp, mindmap}::ai_image`;
//! the other four have no `main-core` module, so their (identical) request is
//! built here. `generateImageTool` itself (`packages/ai-search/src/media-tools.ts`)
//! is not in `main-core`: the route is `tool_routing::resolve_image_route`, a
//! key provider's request is `ai_provider::media_protocols::generate_image_with_provider`
//! run on the shared [`Driver`], the picture lands in
//! `electron_utils::generated_images::store_generated_image`. The Codex
//! generator (`createCodexImageCliGenerator`, `codex-image-generator.ts`) is
//! the host's ([`AppAiImageHost::codex_generate_image`]).
//!
//! These channels only ever send `{ prompt, aspectRatio }`, never reference
//! images, so `mediaRoots` (which only `loadMediaReferences` reads) is not
//! needed to answer: it is computed only where `main-core` computes it with
//! the request (hwp, mindmap), from the document path the editors provide
//! ([`shell_contract::editors::DocumentEditors::document_path`]; D1/D2 add
//! their `DocumentEditors` to `Provided`). Nothing else of the apps' document
//! state is reached.
//!
//! A generation can be cancelled by the window's `abortMediaCalls` (the shared
//! AI port's `ai:stream-cancel`) or by the window going away: this port keeps
//! each call's signal and provides [`MediaCallAbort`] for the former.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use jscompat::node_path::host::join;
use jscompat::{JsTypeError, JsonValue, trim};
use main_core::hwp::ai_image::{HwpImageHost, begin_generate_image as hwp_begin};
use main_core::mindmap::ai_image::{MindmapImageHost, begin_generate_image as mindmap_begin};
use main_core::packages::ai_provider::image_backend::AiImageBackend;
use main_core::packages::ai_provider::jsval::{js_string_checked, object, prop, text};
use main_core::packages::ai_provider::media_protocols::{
    AiMediaProviderConfig, GenerateImageInput, MediaBlob, generate_image_with_provider,
};
use main_core::packages::ai_provider::run_error::ai_stream_error_fields_of;
use main_core::packages::ai_provider::task::{JsError, Signal};
use main_core::packages::ai_search::media_call_abort::{MediaCallId, MediaCallRun, MediaCalls};
use main_core::packages::ai_search::media_tools::read_routing_settings;
use main_core::packages::ai_search::tool_routing::{
    AiToolCallContext, AiToolCallPath, ToolRoutingState, image_generation_unavailable_message,
    resolve_image_route,
};
use main_core::packages::electron_utils::generated_images::store_generated_image;
use shell_contract::editors::editor_for;
use shell_contract::ipc::{CallContext, RegisterError, Responder};
use shell_contract::provided::Provided;
use shell_contract::runtime::{CancelToken, PathName, Services};
use shell_contract::{Batch, IpcError, IpcValue, ViewId};

use crate::ports::AppAiImage;
use crate::runtime::Driver;
use crate::slides_ai::MediaCallAbort;
use crate::value::{arg, from_json};

/// `CodexImageRequest` of `codex-image-generator.ts` as these channels build
/// it: a prompt and an aspect ratio (no size, never transparent)
#[derive(Debug, Clone, PartialEq)]
pub struct CodexImageRequest {
    pub prompt: String,
    pub aspect_ratio: Option<String>,
}

/// What the Codex generator gives back: `{ url }` or `{ bytes, mime }`
#[derive(Debug, Clone, PartialEq)]
pub enum CodexImage {
    Url(String),
    Bytes { bytes: Vec<u8>, mime: String },
}

/// `codexImageRouteOffered()`'s two inputs
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodexImageRoute {
    /// `codexImageGenerationAvailable()` of `image-backend.ts`: the build
    /// announces Codex image generation
    pub available: bool,
    /// `registerCodexImageGenerator(fn)` was called with a function
    pub registered: bool,
}

/// Batch A host of the image channels: what lives in the shell entry
pub trait AppAiImageHost: Send + Sync {
    /// `sharedSubscriptionStatuses()`
    fn shared_subscription_statuses(&self) -> JsonValue;
    /// The Codex image state of this process (`setCodexImageGenerationAvailable`,
    /// `registerCodexImageGenerator`)
    fn codex_image_route(&self) -> CodexImageRoute;
    /// `codexImageGenerator()(request)` (`createCodexImageCliGenerator` of
    /// `@seuoffice/ai-search`, not in `main-core`): blocking, so the port runs
    /// it on a worker; `signal` is the call's `AbortSignal`. `Err` is what it
    /// threw.
    fn codex_generate_image(
        &self,
        request: &CodexImageRequest,
        signal: &CancelToken,
    ) -> Result<CodexImage, JsError>;
}

pub type AppAiImageHostHandle = Arc<dyn AppAiImageHost>;

/// The app a handler answers for
#[derive(Clone, Copy, PartialEq, Eq)]
enum App {
    Docs,
    Html,
    Hwp,
    Markdown,
    Mindmap,
    Sheets,
}

/// What `generateImageTool` is called with
struct Request {
    settings_path: String,
    prompt: String,
    aspect_ratio: Option<String>,
    statuses: JsonValue,
}

/// What a generation does, decided before anything waits
enum Plan {
    Answer(JsonValue),
    Key {
        provider: &'static str,
        config: JsonValue,
        input: GenerateImageInput,
    },
    Codex(CodexImageRequest),
}

struct Running {
    call: MediaCallId,
    signal: Signal,
    cancel: CancelToken,
}

#[derive(Default)]
struct State {
    /// `inFlightMediaCalls`
    calls: MediaCalls,
    running: Vec<Running>,
}

struct Core {
    index: usize,
    services: Services,
    host: AppAiImageHostHandle,
    provided: Rc<Provided>,
    driver: Rc<Driver>,
    state: RefCell<State>,
}

thread_local! {
    static CORES: RefCell<Vec<Rc<Core>>> = const { RefCell::new(Vec::new()) };
}

/// Runs `f` with the core registered at `index`, on the core thread
fn with_core<R>(index: usize, f: impl FnOnce(&Rc<Core>) -> R) -> Option<R> {
    let core = CORES.with(|cores| cores.borrow().get(index).cloned())?;
    Some(f(&core))
}

/// `Date.now()`
fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

fn path_text(path: std::path::PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

/// `getDomain(hostname, { allowPrivateDomains: true })` of `tldts` for the
/// polling address of a queued FLUX job: the public suffix list with its
/// private section, so two tenants of one hosting suffix (`appspot.com`,
/// `github.io`) are two sites. An IP address has no domain.
fn registrable_domain(host: &str) -> Option<String> {
    let lower = host.to_ascii_lowercase();
    if lower.contains(':') || lower.starts_with('[') || lower.parse::<std::net::Ipv4Addr>().is_ok()
    {
        return None;
    }
    psl::domain_str(&lower).map(str::to_owned)
}

fn type_error(error: JsTypeError) -> IpcError {
    IpcError {
        name: Some("TypeError".into()),
        message: error.0,
    }
}

/// `{ error, errorCode?, resetsAt? }` of `failure(err)`
fn failure(error: &JsError) -> JsonValue {
    let fields = ai_stream_error_fields_of(error, now_ms());
    let mut entries = vec![("error", text(error.message.as_str()))];
    if let Some(code) = fields.get("errorCode") {
        entries.push(("errorCode", code.clone()));
    }
    if let Some(resets_at) = fields.get("errorResetsAt") {
        entries.push(("resetsAt", resets_at.clone()));
    }
    object(entries)
}

fn config_of(config: &JsonValue) -> AiMediaProviderConfig {
    let field = |key: &str| match prop(config, key) {
        Some(JsonValue::String(s)) => Some(s.clone()),
        _ => None,
    };
    AiMediaProviderConfig {
        api_key: field("apiKey").unwrap_or_default(),
        base_url: field("baseUrl"),
        image_model: field("imageModel").unwrap_or_default(),
        analysis_model: field("analysisModel").unwrap_or_default(),
    }
}

/// What hwp and mindmap's `main-core` begin asks of Electron
struct Bridge<'a> {
    core: &'a Core,
}

impl Bridge<'_> {
    fn user_data(&self) -> String {
        path_text(self.core.services.paths.path(PathName::UserData))
    }

    fn file_path_of(&self, id: f64) -> Option<String> {
        let view = ViewId(id as u32);
        editor_for(&self.core.provided, view)?
            .document_path(view)
            .map(path_text)
    }
}

impl HwpImageHost for Bridge<'_> {
    fn user_data_dir(&mut self) -> String {
        self.user_data()
    }
    fn temp_dir(&mut self) -> String {
        path_text(self.core.services.paths.path(PathName::Temp))
    }
    fn file_path_of(&mut self, web_contents_id: f64) -> Option<String> {
        Bridge::file_path_of(self, web_contents_id)
    }
    fn subscription_statuses(&mut self) -> JsonValue {
        self.core.host.shared_subscription_statuses()
    }
}

impl MindmapImageHost for Bridge<'_> {
    fn user_data_dir(&mut self) -> String {
        self.user_data()
    }
    fn file_path_of(&mut self, web_contents_id: f64) -> Option<String> {
        Bridge::file_path_of(self, web_contents_id)
    }
    fn subscription_statuses(&mut self) -> JsonValue {
        self.core.host.shared_subscription_statuses()
    }
}

impl Core {
    /// `join(app.getPath('userData'), 'ai-settings.json')`
    fn settings_path(&self) -> String {
        join(&[
            &path_text(self.services.paths.path(PathName::UserData)),
            "ai-settings.json",
        ])
    }

    /// The request of the handlers without a `main-core` module, in the order
    /// JavaScript evaluates it: the settings path, the op (whose `String()` may
    /// throw), the statuses
    fn generic_request(&self, op: Option<&JsonValue>) -> Result<Request, JsTypeError> {
        let settings_path = self.settings_path();
        let (prompt, aspect_ratio) = op_fields(op)?;
        Ok(Request {
            settings_path,
            prompt,
            aspect_ratio,
            statuses: self.host.shared_subscription_statuses(),
        })
    }

    /// `withMediaCallSignal` up to the call of the tool: the call is
    /// remembered under its window, `Err` is the throw of a handler (the call
    /// is forgotten by then)
    fn begin(
        &self,
        app: App,
        sender_id: f64,
        destroyed: bool,
        op: Option<&JsonValue>,
    ) -> Result<(MediaCallRun, Request), JsTypeError> {
        let mut bridge = Bridge { core: self };
        match app {
            App::Hwp => {
                let start = hwp_begin(
                    &mut bridge,
                    &mut self.state.borrow_mut().calls,
                    sender_id,
                    destroyed,
                    op,
                )?;
                let request = start.request;
                Ok((
                    start.run,
                    Request {
                        settings_path: request.settings_path,
                        prompt: request.op.prompt,
                        aspect_ratio: request.op.aspect_ratio,
                        statuses: request.statuses,
                    },
                ))
            }
            App::Mindmap => {
                let pasted = join(&[
                    &path_text(self.services.paths.path(PathName::Temp)),
                    "seuoffice-pasted",
                ]);
                let start = mindmap_begin(
                    &mut bridge,
                    &mut self.state.borrow_mut().calls,
                    &pasted,
                    sender_id,
                    destroyed,
                    op,
                )?;
                let request = start.request;
                Ok((
                    start.run,
                    Request {
                        settings_path: request.settings_path,
                        prompt: request.op.prompt,
                        aspect_ratio: request.op.aspect_ratio,
                        statuses: request.statuses,
                    },
                ))
            }
            App::Docs | App::Html | App::Markdown | App::Sheets => {
                let call = self.state.borrow_mut().calls.begin(sender_id, destroyed);
                match self.generic_request(op) {
                    Ok(request) => Ok((MediaCallRun { sender_id, call }, request)),
                    // the `finally` of `withMediaCallSignal` when its callback throws
                    Err(error) => {
                        self.state.borrow_mut().calls.end(sender_id, call);
                        Err(error)
                    }
                }
            }
        }
    }

    /// The first half of `generateImageTool`: what the request comes to
    fn plan(&self, request: &Request) -> Plan {
        let prompt = trim(&request.prompt).to_owned();
        if prompt.is_empty() {
            return Plan::Answer(object(vec![("error", text("prompt must not be empty"))]));
        }
        let file = std::fs::read_to_string(&request.settings_path).ok();
        let settings = read_routing_settings(file.as_deref());
        let context = AiToolCallContext {
            path: AiToolCallPath::Screen,
            statuses: Some(request.statuses.clone()),
            data_dir: None,
        };
        let route = self.host.codex_image_route();
        let mut routing = ToolRoutingState::default();
        routing
            .image_backend
            .set_codex_image_generation_available(route.available);
        routing.codex_generator_registered = route.registered;
        let unavailable = || {
            Plan::Answer(object(vec![
                (
                    "error",
                    text(image_generation_unavailable_message(
                        &routing, &settings, &context,
                    )),
                ),
                ("errorCode", text("unavailable")),
            ]))
        };
        match resolve_image_route(&routing, &settings, &context) {
            AiImageBackend::None => unavailable(),
            AiImageBackend::Codex => Plan::Codex(CodexImageRequest {
                prompt,
                aspect_ratio: request.aspect_ratio.clone(),
            }),
            AiImageBackend::Key { provider, config } => Plan::Key {
                provider,
                config,
                input: GenerateImageInput {
                    prompt,
                    aspect_ratio: request.aspect_ratio.clone(),
                    // `loadMediaReferences([])`
                    references: Some(Vec::new()),
                    transparent: Some(false),
                },
            },
        }
    }

    /// The picture is stored and answered as its `file:` URL
    fn stored(&self, bytes: &[u8], mime: &str) -> Result<JsonValue, JsError> {
        let tmp = path_text(self.services.paths.path(PathName::Temp));
        store_generated_image(&tmp, now_ms(), Some(bytes), Some(mime))
            .map(|url| object(vec![("url", text(url))]))
            .map_err(|e| JsError::error(e.message()))
    }

    /// The `finally` of `withMediaCallSignal` and the handler's answer
    fn finish(&self, run: MediaCallRun, reply: Responder, answer: JsonValue) {
        {
            let mut state = self.state.borrow_mut();
            state.calls.end(run.sender_id, run.call);
            state.running.retain(|r| r.call != run.call);
        }
        reply.reply(Ok(from_json(&answer)))
    }

    fn finish_with(
        &self,
        run: MediaCallRun,
        reply: Responder,
        outcome: Result<JsonValue, JsError>,
    ) {
        let answer = outcome.unwrap_or_else(|error| failure(&error));
        self.finish(run, reply, answer)
    }

    /// `abortMediaCalls(senderId)`: the calls' signals fire
    fn abort_calls_of(&self, sender_id: f64) {
        let fire: Vec<(Signal, CancelToken)> = {
            let mut state = self.state.borrow_mut();
            let aborted = state.calls.abort_media_calls(sender_id);
            state
                .running
                .iter()
                .filter(|r| aborted.contains(&r.call))
                .map(|r| (r.signal.clone(), r.cancel.clone()))
                .collect()
        };
        for (signal, cancel) in fire {
            signal.abort(Some(JsError::abort()));
            cancel.cancel();
        }
    }
}

/// `String(op?.prompt ?? '')` and `op?.aspectRatio ? String(op.aspectRatio) : undefined`
fn op_fields(op: Option<&JsonValue>) -> Result<(String, Option<String>), JsTypeError> {
    let prompt = match op.and_then(|o| prop(o, "prompt")) {
        None | Some(JsonValue::Null) => String::new(),
        Some(value) => js_string_checked(value)?,
    };
    let aspect_ratio = op
        .and_then(|o| prop(o, "aspectRatio"))
        .filter(|a| a.truthy())
        .map(js_string_checked)
        .transpose()?;
    Ok((prompt, aspect_ratio))
}

/// Starts the tool of a begun call; answers `reply` when it ends
fn run_tool(core: &Rc<Core>, run: MediaCallRun, request: Request, reply: Responder) {
    let rt = core.driver.rt();
    let signal = rt.controller();
    let cancel = CancelToken::default();
    {
        let mut state = core.state.borrow_mut();
        // a destroyed window's call starts aborted
        if state.calls.aborted(run.call) {
            signal.abort(Some(JsError::abort()));
            cancel.cancel();
        }
        state.running.push(Running {
            call: run.call,
            signal: signal.clone(),
            cancel: cancel.clone(),
        });
    }
    match core.plan(&request) {
        Plan::Answer(answer) => core.finish(run, reply, answer),
        Plan::Key {
            provider,
            config,
            input,
        } => {
            let fx = core.driver.providers().fx;
            let config = config_of(&config);
            let future = {
                let rt = rt.clone();
                async move {
                    generate_image_with_provider(
                        &rt,
                        &fx,
                        provider,
                        &config,
                        &input,
                        Some(&signal),
                        &registrable_domain,
                    )
                    .await
                }
            };
            let core = core.clone();
            core.driver.clone().run(future, move |result| {
                let outcome =
                    result.and_then(|MediaBlob { bytes, mime, .. }| core.stored(&bytes, &mime));
                core.finish_with(run, reply, outcome)
            });
        }
        Plan::Codex(codex) => {
            let host = core.host.clone();
            let core_thread = core.services.core.clone();
            let index = core.index;
            core.services.workers.spawn(Box::new(move || {
                let outcome = host.codex_generate_image(&codex, &cancel);
                core_thread.post(Box::new(move || {
                    with_core(index, |core| {
                        let outcome = outcome.and_then(|image| match image {
                            CodexImage::Url(url) => Ok(object(vec![("url", text(url))])),
                            CodexImage::Bytes { bytes, mime } => core.stored(&bytes, &mime),
                        });
                        core.finish_with(run, reply, outcome)
                    });
                }));
            }));
        }
    }
}

pub struct AppAiImagePort {
    core: Rc<Core>,
}

impl AppAiImagePort {
    fn generate(&self, app: App, cx: &CallContext, args: &[IpcValue], reply: Responder) {
        let core = &self.core;
        let view = cx.sender.view;
        let sender_id = f64::from(view.0);
        let destroyed = core.services.views.sender_of(view).is_none();
        let op = arg(args, 0);
        match core.begin(app, sender_id, destroyed, op.as_ref()) {
            Ok((run, request)) => run_tool(core, run, request, reply),
            Err(error) => reply.reply(Err(type_error(error))),
        }
    }
}

impl AppAiImage for AppAiImagePort {
    fn docs_ai_generate_image(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.generate(App::Docs, cx, &args, reply)
    }

    fn html_ai_generate_image(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.generate(App::Html, cx, &args, reply)
    }

    fn hwp_ai_generate_image(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.generate(App::Hwp, cx, &args, reply)
    }

    fn markdown_ai_generate_image(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.generate(App::Markdown, cx, &args, reply)
    }

    fn mindmap_ai_generate_image(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.generate(App::Mindmap, cx, &args, reply)
    }

    fn sheets_ai_generate_image(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.generate(App::Sheets, cx, &args, reply)
    }
}

/// What `ai:stream-cancel` (the shared AI port) calls
struct Abort {
    index: usize,
}

impl MediaCallAbort for Abort {
    fn abort_media_calls(&self, sender_id: f64) {
        with_core(self.index, |core| core.abort_calls_of(sender_id));
    }
}

/// The port the shell inserts. It also provides a [`MediaCallAbort`] for the
/// shared AI port's `ai:stream-cancel` (which calls every one provided).
pub fn factory() -> crate::Factory<dyn AppAiImage> {
    crate::Factory::new(|services, provided| {
        let host = services.hosts.need::<AppAiImageHostHandle>(Batch::A)?;
        let driver =
            provided
                .all::<Driver>()
                .first()
                .cloned()
                .ok_or(RegisterError::MissingHost {
                    batch: Batch::A,
                    host: "Rc<runtime::Driver> in Provided",
                })?;
        let index = CORES.with(|cores| cores.borrow().len());
        let core = Rc::new(Core {
            index,
            services: services.clone(),
            host,
            provided: provided.clone(),
            driver,
            state: RefCell::default(),
        });
        CORES.with(|cores| cores.borrow_mut().push(core.clone()));
        // `onDestroyed(sender, ...)` of every call: one listener for all
        services.views.on_destroyed(Box::new(move |view| {
            with_core(index, |core| core.abort_calls_of(f64::from(view.0)));
        }));
        provided.add::<dyn MediaCallAbort>(Rc::new(Abort { index }));
        let port: Rc<dyn AppAiImage> = Rc::new(AppAiImagePort { core });
        Ok(port)
    })
}

#[cfg(test)]
mod tests;
