//! `registerAiIpc` of `apps/docs/src/main/docs-main.ts`: the AI channels every
//! editor uses. The shell registers the docs entry's handlers for every app
//! (the sheets and slides entries register the same names, but only docs-main
//! answers in the shell), so the settings, the streams, the one-shot chat,
//! the model lists, the search and the page reader are one port here
//! ([`AiCorePort`]), and the per-app channels the entries answer themselves
//! (`docs:consume-ai-doc-content`, `sheets:ai-tool-capabilities`) another
//! ([`AppAiPort`]).
//!
//! The judgment is `main-core`'s (`packages::ai_provider`, `packages::ai_search`,
//! `docs::{ai_run, ai_keepalive, read_url_ipc, stream_coalesce}`); what awaits
//! the network or a child process runs on the AI runtime (`crate::runtime::Driver`,
//! one per core thread, provided by the batch). What `main-core` does not hold
//! is [`AiCoreHost`]: the search backends, the page reader, the remote image
//! download, the subscription service's routing state and the entry's values.
//! A call of a worker goes through `services.workers` and answers back on the
//! core thread.
//!
//! `ai:stream` sends its chunks to the sender view as `ai:stream-chunk` in
//! order, then replies; `ai:stream-cancel` and the view's end abort it
//! ([`watch`]).

mod files;
mod host;
mod stream;
mod watch;

#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use jscompat::{JsTypeError, JsonValue};
use main_core::docs::ai_run::{AiRunTarget, AiRunTexts, ai_chat_failure, resolve_ai_run};
use main_core::docs::read_url_ipc::{
    ReadUrlRequest, normalize_read_url_request, unexpected_read_url_failure,
};
use main_core::packages::ai_provider::ai_settings_guard::{
    sanitize_ai_settings, sanitize_cli_path,
};
use main_core::packages::ai_provider::chat::chat_for_provider;
use main_core::packages::ai_provider::codex_app_server::list_codex_models;
use main_core::packages::ai_provider::custom_models::list_custom_models_for_ipc;
use main_core::packages::ai_provider::jsval::{object, prop, text, thrown_to_string, value_key};
use main_core::packages::ai_provider::key_model_refresh::{
    KeyModelRefresher, KeyModelRefresherDeps, create_key_model_refresher,
};
use main_core::packages::ai_provider::local_ipc::{
    AiLocalTestIpcOptions, LocalIpcState, cancel_local_test_for_ipc, inspect_local_model_for_ipc,
    list_local_models_for_ipc, test_local_model_for_ipc,
};
use main_core::packages::ai_provider::media::AI_MEDIA_PROVIDERS;
use main_core::packages::ai_provider::media_protocols::{
    AiMediaProviderConfig, bytes_to_base64, test_media_provider,
};
use main_core::packages::ai_provider::overload_error::is_ai_overloaded_error;
use main_core::packages::ai_provider::provider_selection::subscription_off_in;
use main_core::packages::ai_provider::search_settings::AI_SEARCH_PROVIDERS;
use main_core::packages::ai_provider::settings_secrets::open_ai_secrets;
use main_core::packages::ai_provider::stored_settings::with_stored_main_fields;
use main_core::packages::ai_provider::task::{JsError, Signal};
use main_core::packages::ai_search::media_call_abort::{MediaCallId, MediaCalls};
use main_core::packages::ai_search::search_tools::{
    SearchAnswer, SearchBackend, SearchOptions, image_search_tool, test_search_provider,
    web_search_tool,
};
use main_core::packages::i18n::Lang;
use shell_contract::ipc::{CallContext, Responder};
use shell_contract::provided::Provided;
use shell_contract::runtime::{CancelToken, Services};
use shell_contract::{Batch, IpcError, IpcValue, ViewId};

use self::files::Files;
use self::watch::Watches;
use crate::ai_naming::Codec;
use crate::ports::{AiCore, AppAi};
use crate::runtime::Driver;
use crate::secrets::SecretCodecHost;
use crate::slides_ai::MediaCallAbort;
use crate::value::{arg, from_json};

pub use self::host::{AiCoreHost, AiCoreHostHandle, PendingAiDocs, PendingAiDocsHost, RemoteImage};

/// `KEY_MODEL_FIRST_LIST_DELAY_MS`: how long after start the key providers
/// are first asked for their models
const KEY_MODEL_FIRST_LIST_DELAY_MS: f64 = 5000.0;

/// `AI_RUN_TEXTS` of docs-main: `tm('errNoApiKey', { provider })` and `tm('errNoModel')`
struct Texts(Lang);

impl AiRunTexts for Texts {
    fn no_api_key(&self, provider: &str) -> String {
        match self.0 {
            Lang::En => format!("No API key configured for {provider}"),
            Lang::Ko => format!("{provider}의 API 키가 설정되지 않았습니다"),
        }
    }

    fn no_model(&self) -> String {
        match self.0 {
            Lang::En => "No model name configured".to_owned(),
            Lang::Ko => "모델 이름이 설정되지 않았습니다".to_owned(),
        }
    }
}

/// `tm('errAiBusy')`
fn busy_text(lang: Lang) -> String {
    match lang {
        Lang::En => "The AI service is busy right now — please try again in a moment",
        Lang::Ko => "AI 서비스가 혼잡합니다. 잠시 후 다시 시도해 주세요",
    }
    .to_owned()
}

/// What a handler throws: the renderer's rejection carries the name
fn thrown(error: JsError) -> IpcError {
    IpcError {
        name: Some(if error.name.is_empty() {
            "Error".to_owned()
        } else {
            error.name
        }),
        message: error.message,
    }
}

fn thrown_type_error(error: JsTypeError) -> IpcError {
    IpcError {
        name: Some("TypeError".into()),
        message: error.0,
    }
}

/// The error of a rejection the library threw as a value
fn thrown_value(value: &JsonValue) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: thrown_to_string(value).unwrap_or_default(),
    }
}

/// Whether the classifiers of `main-core` know the class of a thrown error
fn known_class(error: &JsError) -> bool {
    matches!(
        error.class.as_str(),
        "Error" | "AiRunError" | "AiTimeoutError" | "AiCreditsError"
    )
}

/// A thrown value as the classifiers of `main-core` read it: an `Error` of any
/// other class (a `TypeError` of `fetch`, a `DOMException`) is an `Error` that
/// keeps its own name
fn thrown_json(error: &JsError) -> JsonValue {
    let mut json = error.to_json();
    if !known_class(error)
        && error.is_error()
        && let JsonValue::Object(fields) = &mut json
    {
        fields.set("$class", text("Error"));
        fields.set("name", text(error.name.clone()));
    }
    json
}

/// The settings file's text with its keys opened (`readFileSync` of a file a
/// codec is registered for): `main-core`'s search tools read the text with no codec
fn opened_settings_text(path: &str, codec: &Codec) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let file = String::from_utf8_lossy(&bytes).into_owned();
    Some(match jscompat::json_parse(&file) {
        Ok(stored) => jscompat::json_stringify(&open_ai_secrets(Some(&**codec), &stored)),
        Err(_) => file,
    })
}

/// `activeAiStreams` is a `Map` keyed by the request id as the renderer sent it
fn request_key(id: Option<&JsonValue>) -> String {
    id.map_or_else(|| "undefined".to_owned(), jscompat::json_stringify)
}

fn answer(reply: Responder, result: Result<JsonValue, JsError>) {
    reply.reply(result.map(|json| from_json(&json)).map_err(thrown))
}

/// `{ path: 'screen', statuses: sharedSubscriptionStatuses() }`
fn screen_tool_context(host: &dyn AiCoreHost) -> JsonValue {
    object(vec![
        ("path", text("screen")),
        ("statuses", host.subscription_statuses()),
    ])
}

/// The one shared driver of the batch
fn driver_of(provided: &Provided) -> Driver {
    provided
        .all::<Driver>()
        .first()
        .expect("the shared driver is provided before the ports are built")
        .as_ref()
        .clone()
}

/// The search backends of the host, as `main-core`'s search tools ask them
struct Backend(AiCoreHostHandle);

impl SearchBackend for Backend {
    fn web_search(
        &mut self,
        query: &str,
        max_results: f64,
        options: &SearchOptions,
    ) -> SearchAnswer {
        self.0.web_search(query, max_results, options)
    }

    fn image_search(
        &mut self,
        query: &str,
        max_results: f64,
        options: &SearchOptions,
    ) -> SearchAnswer {
        self.0.image_search(query, max_results, options)
    }
}

/// `process.env[name]`
fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// What the media calls of this port (`ai:read-url`) have in flight:
/// `inFlightMediaCalls` and the signal of each call
#[derive(Default)]
struct MediaState {
    calls: MediaCalls,
    signals: Vec<(MediaCallId, CancelToken)>,
}

/// What a handler and the continuation of an awaited call both need. It lives
/// on the core thread (it holds `Rc`s): a continuation posted from a worker
/// finds it again by its index ([`with_core`]).
struct Core {
    services: Services,
    host: AiCoreHostHandle,
    files: Rc<Files>,
    driver: Driver,
    provided: Rc<Provided>,
    watches: Rc<Watches>,
    /// `activeAiStreams`
    streams: RefCell<HashMap<String, Signal>>,
    local_ipc: Rc<RefCell<LocalIpcState>>,
    /// `keyModelRefresher`
    refresher: Rc<KeyModelRefresher>,
    media: RefCell<MediaState>,
}

thread_local! {
    static CORES: RefCell<Vec<Rc<Core>>> = const { RefCell::new(Vec::new()) };
}

/// Runs `f` with the core registered at `index`, on the core thread
fn with_core<R>(index: usize, f: impl FnOnce(&Rc<Core>) -> R) -> Option<R> {
    let core = CORES.with(|cores| cores.borrow().get(index).cloned())?;
    Some(f(&core))
}

impl Core {
    fn build(
        services: &Services,
        provided: &Rc<Provided>,
        host: AiCoreHostHandle,
        codec: Codec,
        driver: Driver,
    ) -> (Rc<Core>, usize) {
        let files = Rc::new(Files::new(
            &*services.paths,
            services.events.clone(),
            codec,
            host.clone(),
        ));
        let rt = driver.rt();
        let fx = driver.providers().fx;
        let refresher = {
            let read = files.clone();
            let write = files.clone();
            Rc::new(create_key_model_refresher(
                &rt,
                &fx,
                KeyModelRefresherDeps {
                    read: Rc::new(move || read.stored()),
                    write: Rc::new(move |update| {
                        let latest = write.stored()?;
                        let Some(next) = update(&latest)? else {
                            return Ok(());
                        };
                        write.write(&next)?;
                        write.broadcast();
                        Ok(())
                    }),
                    list: None,
                },
            ))
        };
        let core = Rc::new(Core {
            services: services.clone(),
            host,
            files,
            driver,
            provided: provided.clone(),
            watches: Watches::new(rt),
            streams: RefCell::default(),
            local_ipc: Rc::default(),
            refresher,
            media: RefCell::default(),
        });
        let index = CORES.with(|cores| {
            let mut cores = cores.borrow_mut();
            cores.push(core.clone());
            cores.len() - 1
        });
        // `sender.once('destroyed', ...)`: the requests and media calls of the view end
        services.views.on_destroyed(Box::new(move |view| {
            with_core(index, |core| core.view_destroyed(view));
        }));
        provided.add::<dyn MediaCallAbort>(Rc::new(MediaAbort { index }));
        // the first listing waits for the windows: a key provider's list is not needed to show them
        {
            let refresher = core.refresher.clone();
            let rt = core.driver.rt();
            core.driver.run(
                async move {
                    rt.sleep(KEY_MODEL_FIRST_LIST_DELAY_MS).await;
                    let _ = refresher.refresh_changed();
                },
                |()| {},
            );
        }
        (core, index)
    }

    /// Lets the runtime look at what a call from outside it changed (an abort)
    fn kick(&self) {
        self.driver.run(async {}, |()| {});
    }

    fn view_destroyed(&self, view: ViewId) {
        self.watches.abort_view(view);
        self.abort_media(f64::from(view.0));
        self.kick();
    }

    /// `abortMediaCalls(senderId)`: the signals of the calls fire
    fn abort_media(&self, sender_id: f64) {
        let mut media = self.media.borrow_mut();
        for call in media.calls.abort_media_calls(sender_id) {
            for (_, signal) in media.signals.iter().filter(|(id, _)| *id == call) {
                signal.cancel();
            }
        }
    }

    fn end_media(&self, sender_id: f64, call: MediaCallId) {
        let mut media = self.media.borrow_mut();
        media.calls.end(sender_id, call);
        media.signals.retain(|(id, _)| *id != call);
    }

    /// `writeRendererAiSettings(settings)`: persist what a renderer sent,
    /// schema-checked, with the live model lists kept from the file, then a
    /// listing for a key that changed. False when the payload is not settings
    /// at all.
    fn write_renderer_settings(&self, settings: &JsonValue) -> Result<bool, JsError> {
        let sanitized = sanitize_ai_settings(&self.files.guard, settings)
            .map_err(|error| JsError::type_error(error.0))?;
        let Some(sanitized) = sanitized else {
            return Ok(false);
        };
        let stored = self.files.stored()?;
        self.files
            .write(&with_stored_main_fields(&sanitized, &stored))?;
        self.files.broadcast();
        let refreshed = self.refresher.refresh_changed();
        self.kick();
        refreshed?;
        Ok(true)
    }
}

/// `abortMediaCalls` for the editors' calls: provided to the ports whose
/// handlers `ai:stream-cancel` reaches
struct MediaAbort {
    index: usize,
}

impl MediaCallAbort for MediaAbort {
    fn abort_media_calls(&self, sender_id: f64) {
        with_core(self.index, |core| core.abort_media(sender_id));
    }
}

pub struct AiCorePort {
    core: Rc<Core>,
    index: usize,
}

impl AiCorePort {
    /// The port over its hosts; `driver` is the batch's one
    pub fn new(
        services: &Services,
        provided: &Rc<Provided>,
        host: AiCoreHostHandle,
        codec: Codec,
        driver: Driver,
    ) -> AiCorePort {
        let (core, index) = Core::build(services, provided, host, codec, driver);
        AiCorePort { core, index }
    }

    /// A call that waits on a worker: `work` runs there, `then` on the core thread
    fn worker<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
        then: impl FnOnce(&Rc<Core>, T) + Send + 'static,
    ) {
        let core_thread = self.core.services.core.clone();
        let index = self.index;
        self.core.services.workers.spawn(Box::new(move || {
            let outcome = work();
            core_thread.post(Box::new(move || {
                with_core(index, |core| then(core, outcome));
            }));
        }));
    }
}

/// `String(value)` of an argument
fn string_of(value: Option<&JsonValue>) -> String {
    value_key(value)
}

impl AiCore for AiCorePort {
    fn ai_chat(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let core = &self.core;
        let request = match arg(&args, 0) {
            Some(JsonValue::Null) => {
                return reply.reply(Err(thrown_type_error(JsTypeError(
                    "Cannot read properties of null (reading 'settings')".into(),
                ))));
            }
            Some(request) => request,
            None => {
                return reply.reply(Err(thrown_type_error(JsTypeError(
                    "Cannot read properties of undefined (reading 'settings')".into(),
                ))));
            }
        };
        let lang = core.host.ui_lang();
        let settings = prop(&request, "settings")
            .cloned()
            .unwrap_or(JsonValue::Null);
        let statuses = core.host.subscription_statuses();
        // same schema check and provider choice as ai:stream
        let target = match resolve_ai_run(
            &core.files.guard,
            Some(core.files.codec()),
            &settings,
            &statuses,
            &Texts(lang),
        ) {
            Ok(target) => target,
            Err(error) => return reply.reply(Err(thrown_type_error(error))),
        };
        let (provider, config) = match target {
            AiRunTarget::Refused { refusal } => {
                let mut failure = vec![("ok", JsonValue::Bool(false))];
                if let JsonValue::Object(fields) = &refusal {
                    failure.extend(fields.entries().into_iter().map(|(k, v)| (k, v.clone())));
                }
                return reply.reply(Ok(from_json(&object(failure))));
            }
            AiRunTarget::Ok {
                provider, config, ..
            } => (provider, config),
        };
        let string_prop = |key: &str| match prop(&request, key) {
            Some(JsonValue::String(value)) => value.clone(),
            _ => String::new(),
        };
        let (system, user) = (string_prop("system"), string_prop("user"));
        let rt = core.driver.rt();
        let providers = core.driver.providers();
        let now = rt.now();
        core.driver.run(
            async move {
                chat_for_provider(&rt, &providers, &provider, &config, &system, &user, None).await
            },
            move |result| {
                let busy = || busy_text(lang);
                let answered = match result {
                    // the one-shot path reports HTTP failures as ok:false with the raw body:
                    // capacity and rate-limit dumps become the localized "busy" message
                    Ok(chat) => {
                        let overloaded = !chat.ok
                            && is_ai_overloaded_error(
                                &chat
                                    .error
                                    .clone()
                                    .map_or(JsonValue::Null, JsonValue::String),
                            );
                        Ok(if overloaded {
                            object(vec![
                                ("ok", JsonValue::Bool(false)),
                                ("error", text(busy())),
                            ])
                        } else {
                            chat.to_json()
                        })
                    }
                    Err(error) => {
                        ai_chat_failure(&thrown_json(&error), busy, now).map(|mut failure| {
                            // `String(err)` of an error of another class keeps its own name
                            if !known_class(&error)
                                && let JsonValue::Object(fields) = &mut failure
                                && fields.get("error")
                                    == thrown_to_string(&thrown_json(&error))
                                        .ok()
                                        .map(text)
                                        .as_ref()
                            {
                                fields.set("error", text(error.to_js_string()));
                            }
                            failure
                        })
                    }
                };
                reply.reply(
                    answered
                        .map(|json| from_json(&json))
                        .map_err(thrown_type_error),
                );
            },
        );
    }

    fn ai_codex_models(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let core = &self.core;
        let settings = match core.files.stored() {
            Ok(settings) => settings,
            Err(error) => return reply.reply(Err(thrown(error))),
        };
        // turned off in this app (decision 0114): Codex is not started for its list either
        if subscription_off_in(&settings, Some(&text("codex"))) {
            return reply.reply(Err(thrown(JsError::error(
                "Codex is turned off in this app",
            ))));
        }
        // the probe spawns the path directly, so it gets the same metacharacter and
        // existence check as the stored setting (anything else: auto-detect)
        let cli_path = sanitize_cli_path(&core.files.guard, arg(&args, 0).as_ref());
        let rt = core.driver.rt();
        let providers = core.driver.providers();
        core.driver.run(
            async move { list_codex_models(&rt, &providers.codex, cli_path.as_deref()).await },
            move |result| answer(reply, result),
        );
    }

    fn ai_custom_models(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let input = arg(&args, 0).unwrap_or(JsonValue::Null);
        let rt = self.core.driver.rt();
        let providers = self.core.driver.providers();
        self.core.driver.run(
            async move {
                list_custom_models_for_ipc(&rt, &providers.fx, &input)
                    .await
                    .to_json()
            },
            move |json| reply.reply(Ok(from_json(&json))),
        );
    }

    fn ai_fetch_image(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let url = string_of(arg(&args, 0).as_ref());
        let host = self.core.host.clone();
        self.worker(
            move || host.fetch_remote_image(&url),
            move |_, image| {
                let answered = match image {
                    None => IpcValue::Null,
                    Some(image) => {
                        let content_type = image.content_type;
                        let mime = if content_type.contains("png") {
                            "image/png"
                        } else if content_type.contains("gif") {
                            "image/gif"
                        } else {
                            "image/jpeg"
                        };
                        from_json(&object(vec![
                            ("base64", text(bytes_to_base64(&image.bytes))),
                            ("mime", text(mime)),
                        ]))
                    }
                };
                reply.reply(Ok(answered));
            },
        );
    }

    fn ai_get_settings(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        answer(reply, self.core.files.stored())
    }

    fn ai_image_search(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.search(args, reply, false)
    }

    fn ai_local_inspect(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let input = arg(&args, 0).unwrap_or(JsonValue::Null);
        let rt = self.core.driver.rt();
        let providers = self.core.driver.providers();
        self.core.driver.run(
            async move {
                inspect_local_model_for_ipc(&rt, &providers.fx, &input)
                    .await
                    .to_json()
            },
            move |json| reply.reply(Ok(from_json(&json))),
        );
    }

    fn ai_local_models(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let input = arg(&args, 0).unwrap_or(JsonValue::Null);
        let rt = self.core.driver.rt();
        let providers = self.core.driver.providers();
        self.core.driver.run(
            async move {
                list_local_models_for_ipc(&rt, &providers.fx, &input)
                    .await
                    .to_json()
            },
            move |json| reply.reply(Ok(from_json(&json))),
        );
    }

    fn ai_local_test(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let core = self.core.clone();
        let input = arg(&args, 0).unwrap_or(JsonValue::Null);
        let rt = core.driver.rt();
        let providers = core.driver.providers();
        // the requests end here, not only in the renderer: on a cancel by test id
        // (from the same window) and when the window that asked is closed
        let controller = rt.controller();
        let watch = core.watches.watch(cx.sender.view, &cx.cancel, &controller);
        let options = AiLocalTestIpcOptions {
            owner: Some(JsonValue::Number(f64::from(cx.sender.view.0))),
            signal: Some(controller),
        };
        let ipc = core.local_ipc.clone();
        let driver = core.driver.clone();
        driver.run(
            async move {
                test_local_model_for_ipc(
                    &rt,
                    &providers.fx,
                    &providers.openai,
                    &ipc,
                    &input,
                    Some(&options),
                )
                .await
                .to_json()
            },
            move |json| {
                core.watches.unwatch(watch);
                reply.reply(Ok(from_json(&json)));
            },
        );
    }

    fn ai_local_test_cancel(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let core = &self.core;
        let input = arg(&args, 0).unwrap_or(JsonValue::Null);
        let owner = JsonValue::Number(f64::from(cx.sender.view.0));
        let cancelled = cancel_local_test_for_ipc(&core.local_ipc, &input, Some(&owner));
        core.kick();
        reply.reply(Ok(IpcValue::Bool(cancelled)))
    }

    fn ai_media_test(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let input = arg(&args, 0).unwrap_or(JsonValue::Null);
        let provider = match prop(&input, "provider") {
            Some(JsonValue::String(id)) if AI_MEDIA_PROVIDERS.iter().any(|meta| meta.id == id) => {
                id.clone()
            }
            _ => return reply.reply(Ok(test_failure("No media provider to test"))),
        };
        let config = match prop(&input, "config") {
            Some(config) if config.truthy() => config.clone(),
            _ => return reply.reply(Ok(test_failure("No media provider configuration"))),
        };
        let field = |key: &str| match prop(&config, key) {
            Some(JsonValue::String(value)) => Some(value.clone()),
            _ => None,
        };
        let config = AiMediaProviderConfig {
            api_key: field("apiKey").unwrap_or_default(),
            base_url: field("baseUrl"),
            image_model: field("imageModel").unwrap_or_default(),
            analysis_model: field("analysisModel").unwrap_or_default(),
        };
        let rt = self.core.driver.rt();
        let providers = self.core.driver.providers();
        self.core.driver.run(
            async move { test_media_provider(&rt, &providers.fx, &provider, &config, None).await },
            move |result| {
                let mut out = vec![("ok", JsonValue::Bool(result.ok))];
                if let Some(error) = result.error {
                    out.push(("error", text(error)));
                }
                reply.reply(Ok(from_json(&object(out))));
            },
        );
    }

    fn ai_read_url(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let core = &self.core;
        let (url, offset) =
            match normalize_read_url_request(arg(&args, 0).as_ref(), arg(&args, 1).as_ref()) {
                ReadUrlRequest::Ok { url, offset } => (url, offset),
                ReadUrlRequest::Failure(failure) => {
                    return reply.reply(Ok(from_json(&read_url_failure(
                        failure.error,
                        failure.error_code,
                    ))));
                }
            };
        // `withMediaCallSignal(event.sender, ...)`: Stop (`ai:stream-cancel`) or a
        // closed tab cuts the download
        let sender_id = f64::from(cx.sender.view.0);
        let (call, signal) = {
            let mut media = core.media.borrow_mut();
            let call = media.calls.begin(sender_id, cx.cancel.is_cancelled());
            let signal = CancelToken::default();
            if media.calls.aborted(call) {
                signal.cancel();
            }
            media.signals.push((call, signal.clone()));
            (call, signal)
        };
        let host = core.host.clone();
        let settings_path = core.files.path();
        self.worker(
            move || host.read_url(&settings_path, &url, offset, &signal),
            move |core, outcome| {
                core.end_media(sender_id, call);
                let answered = outcome.unwrap_or_else(|_| {
                    let failure = unexpected_read_url_failure();
                    read_url_failure(failure.error, failure.error_code)
                });
                reply.reply(Ok(from_json(&answered)));
            },
        );
    }

    fn ai_search_test(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let input = arg(&args, 0).unwrap_or(JsonValue::Null);
        let provider = match prop(&input, "provider") {
            Some(JsonValue::String(id)) if AI_SEARCH_PROVIDERS.iter().any(|meta| meta.id == id) => {
                id.clone()
            }
            _ => return reply.reply(Ok(test_failure("No search provider to test"))),
        };
        let api_key = match prop(&input, "apiKey") {
            None | Some(JsonValue::Null) => String::new(),
            Some(key) => string_of(Some(key)),
        };
        let host = self.core.host.clone();
        self.worker(
            move || test_search_provider(&mut Backend(host), &provider, &api_key),
            move |_, outcome| {
                reply.reply(
                    outcome
                        .map(|json| from_json(&json))
                        .map_err(|e| thrown_value(&e)),
                );
            },
        );
    }

    fn ai_set_settings(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let settings = arg(&args, 0).unwrap_or(JsonValue::Null);
        match self.core.write_renderer_settings(&settings) {
            Ok(true) => {}
            Ok(false) => eprintln!("[ai] rejected invalid ai:set-settings payload"),
            Err(error) => return reply.reply(Err(thrown(error))),
        }
        reply.reply(Ok(IpcValue::Undefined))
    }

    fn ai_stream(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        stream::ai_stream(&self.core, cx, arg(&args, 0), reply)
    }

    fn ai_stream_cancel(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        let core = &self.core;
        let key = request_key(arg(&args, 0).as_ref());
        let running = core.streams.borrow().get(&key).cloned();
        if let Some(signal) = running {
            signal.abort(None);
            core.kick();
        }
        // a call that runs no tool (a PDF document job) ends only its own stream
        if matches!(arg(&args, 1), Some(JsonValue::String(scope)) if scope == "request") {
            return reply.reply(Ok(IpcValue::Undefined));
        }
        // Stop while a tool runs names a turn that already ended: end the tab's media calls
        // too, whichever port started them
        let sender_id = f64::from(cx.sender.view.0);
        for calls in core.provided.all::<dyn MediaCallAbort>() {
            calls.abort_media_calls(sender_id);
        }
        reply.reply(Ok(IpcValue::Undefined))
    }

    fn ai_tool_capabilities(&self, _cx: &CallContext, _args: Vec<IpcValue>, reply: Responder) {
        let core = &self.core;
        let settings = match core.files.stored() {
            Ok(settings) => settings,
            Err(error) => return reply.reply(Err(thrown(error))),
        };
        let context = screen_tool_context(&*core.host);
        reply.reply(Ok(from_json(
            &core.host.ai_tool_capabilities(&settings, &context),
        )))
    }

    fn ai_web_search(&self, _cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.search(args, reply, true)
    }
}

impl AiCorePort {
    /// `ai:web-search` and `ai:image-search`: the shared search tools (content
    /// and images), Serper with the keyless fallback; a rejection is an answer
    fn search(&self, args: Vec<IpcValue>, reply: Responder, web: bool) {
        let query = string_of(arg(&args, 0).as_ref());
        let max_results = match arg(&args, 1) {
            Some(JsonValue::Number(n)) => Some(n),
            _ => None,
        };
        let host = self.core.host.clone();
        let settings_path = self.core.files.path();
        let codec = self.core.files.codec_handle();
        self.worker(
            move || {
                let file = opened_settings_text(&settings_path, &codec);
                let mut backend = Backend(host);
                if web {
                    web_search_tool(&mut backend, file.as_deref(), &query, max_results, &env)
                } else {
                    image_search_tool(&mut backend, file.as_deref(), &query, max_results, &env)
                }
            },
            move |_, outcome| {
                let answered = outcome.unwrap_or_else(|error| {
                    object(vec![
                        (
                            if web { "results" } else { "images" },
                            JsonValue::Array(Vec::new()),
                        ),
                        ("method", text("error")),
                        ("error", text(thrown_to_string(&error).unwrap_or_default())),
                    ])
                });
                reply.reply(Ok(from_json(&answered)));
            },
        );
    }
}

fn test_failure(error: &str) -> IpcValue {
    from_json(&object(vec![
        ("ok", JsonValue::Bool(false)),
        ("error", text(error)),
    ]))
}

fn read_url_failure(error: &str, error_code: &str) -> JsonValue {
    object(vec![
        ("ok", JsonValue::Bool(false)),
        ("error", text(error)),
        ("errorCode", text(error_code)),
    ])
}

/// The port the shell inserts for the shared AI channels
pub fn factory() -> crate::Factory<dyn AiCore> {
    crate::Factory::new(|services, provided| {
        let hosts = &services.hosts;
        let port: Rc<dyn AiCore> = Rc::new(AiCorePort::new(
            services,
            provided,
            hosts.need::<AiCoreHostHandle>(Batch::A)?,
            hosts.need::<SecretCodecHost>(Batch::A)? as Codec,
            driver_of(provided),
        ));
        Ok(port)
    })
}

/// The per-app AI channels the docs and sheets entries answer themselves
pub struct AppAiPort {
    host: AiCoreHostHandle,
    files: Files,
    pending: PendingAiDocsHost,
}

impl AppAi for AppAiPort {
    /// one-shot AI content queued by create_document for this tab; null when none
    fn docs_consume_ai_doc_content(
        &self,
        cx: &CallContext,
        _args: Vec<IpcValue>,
        reply: Responder,
    ) {
        let content = self.pending.consume(i64::from(cx.sender.view.0));
        reply.reply(Ok(match content {
            Some(content) => from_json(&jscompat::json_value_from_serde(&content)),
            None => IpcValue::Null,
        }))
    }

    /// What the image and search tools can do right now. Registered in sheets-main
    /// for the same reason: the renderer offers generate_image from this answer.
    fn sheets_ai_tool_capabilities(
        &self,
        _cx: &CallContext,
        _args: Vec<IpcValue>,
        reply: Responder,
    ) {
        let settings = self.files.resolved();
        let context = screen_tool_context(&*self.host);
        reply.reply(Ok(from_json(
            &self.host.ai_tool_capabilities(&settings, &context),
        )))
    }
}

/// The port the shell inserts for the per-app AI channels
pub fn app_ai_factory() -> crate::Factory<dyn AppAi> {
    crate::Factory::new(|services, _| {
        let hosts = &services.hosts;
        let host = hosts.need::<AiCoreHostHandle>(Batch::A)?;
        let codec = hosts.need::<SecretCodecHost>(Batch::A)? as Codec;
        let port: Rc<dyn AppAi> = Rc::new(AppAiPort {
            files: Files::new(
                &*services.paths,
                services.events.clone(),
                codec,
                host.clone(),
            ),
            host,
            pending: hosts.need::<PendingAiDocsHost>(Batch::A)?,
        });
        Ok(port)
    })
}
