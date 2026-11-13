//! `ai:stream` of docs-main: one streaming turn, run on the AI runtime. The
//! chunks go to the sender view as `ai:stream-chunk` events, in order, deltas
//! gathered for a short window (`stream-coalesce.ts`); the reply is
//! `undefined` once the last chunk (`done` or `error`) is out.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use jscompat::{JsTypeError, JsonValue};
use main_core::docs::ai_keepalive::{
    AI_KEEPALIVE_INTERVAL_MS, FirstChunkKeepalive, Interval, start_first_chunk_keepalive,
};
use main_core::docs::ai_run::{
    AiRunTarget, ai_stream_error_chunk, resolve_ai_run, subscription_stream_callbacks,
};
use main_core::docs::stream_coalesce::{
    Chunk, ChunkCoalescer, STREAM_COALESCE_MS, create_chunk_coalescer,
};
use main_core::packages::ai_provider::jsval::{Obj, js_string, prop, text};
use main_core::packages::ai_provider::local_profile::local_endpoint_timeout_ms;
use main_core::packages::ai_provider::protocols_shared::StreamCallbacks;
use main_core::packages::ai_provider::providers::max_output_tokens_of;
use main_core::packages::ai_provider::stream::{StreamForProviderOptions, stream_for_provider};
use main_core::packages::ai_provider::task::{Id, Rt};
use main_core::packages::electron_utils::ai_run_guard::AiRunGuardInput;
use shell_contract::IpcValue;
use shell_contract::ipc::{CallContext, Responder, Target};

use super::{Core, Texts, thrown_type_error};
use crate::drive::DriveService;
use crate::value::from_json;

/// `{ requestId, type, ...rest }`; a request id the renderer left out is not a key
fn chunk(request_id: &Option<JsonValue>, kind: &str, rest: Vec<(&str, JsonValue)>) -> Chunk {
    let mut out = Obj::new();
    if let Some(id) = request_id {
        out.set("requestId", id.clone());
    }
    out.set("type", text(kind));
    for (key, value) in rest {
        out.set(key, value);
    }
    out
}

/// what the coalescer hands each gathered chunk to
type SendChunk = Box<dyn FnMut(Chunk)>;

/// `createChunkCoalescer(send)` with its gather timer on the runtime
struct Out {
    rt: Rt,
    coalescer: RefCell<ChunkCoalescer<SendChunk>>,
    /// the `due_ms` the timer in flight was set for
    scheduled: Cell<Option<f64>>,
    timer: Cell<Option<Id>>,
}

impl Out {
    fn new(rt: Rt, send: Box<dyn FnMut(Chunk)>) -> Rc<Out> {
        Rc::new(Out {
            rt,
            coalescer: RefCell::new(create_chunk_coalescer(send, None)),
            scheduled: Cell::new(None),
            timer: Cell::new(None),
        })
    }

    fn push(self: &Rc<Self>, chunk: Chunk) {
        let now = self.rt.now();
        self.coalescer.borrow_mut().push(chunk, now);
        self.sync();
    }

    fn flush(self: &Rc<Self>) {
        self.coalescer.borrow_mut().flush();
        self.sync();
    }

    /// `setTimeout` and `clearTimeout` of the coalescer: one timer for the
    /// gathered chunk, left alone while more text joins it
    fn sync(self: &Rc<Self>) {
        let due = self.coalescer.borrow().due_ms();
        if due == self.scheduled.get() {
            return;
        }
        self.rt.clear_timeout(self.timer.take());
        self.scheduled.set(due);
        if due.is_some() {
            let this = self.clone();
            let timer = self.rt.set_timeout(STREAM_COALESCE_MS, move || {
                this.timer.set(None);
                this.scheduled.set(None);
                this.coalescer.borrow_mut().fire();
            });
            self.timer.set(Some(timer));
        }
    }
}

/// the ticker's timers: its own number and the runtime timer in flight
type TickTimers = Rc<RefCell<Vec<(u64, Option<Id>)>>>;

/// `setInterval` and `clearInterval` on the runtime's timers
#[derive(Clone)]
struct Ticker {
    rt: Rt,
    send: Rc<dyn Fn()>,
    timers: TickTimers,
    next: Rc<Cell<u64>>,
}

impl Ticker {
    fn schedule(&self, handle: u64, interval_ms: f64) {
        let again = self.clone();
        let timer = self.rt.set_timeout(interval_ms, move || {
            match again
                .timers
                .borrow_mut()
                .iter_mut()
                .find(|(h, _)| *h == handle)
            {
                Some(entry) => entry.1 = None,
                None => return,
            }
            (again.send)();
            if again.timers.borrow().iter().any(|(h, _)| *h == handle) {
                again.schedule(handle, interval_ms);
            }
        });
        if let Some(entry) = self
            .timers
            .borrow_mut()
            .iter_mut()
            .find(|(h, _)| *h == handle)
        {
            entry.1 = Some(timer);
        }
    }
}

impl Interval for Ticker {
    fn set_interval(&mut self, interval_ms: f64) -> u64 {
        let handle = self.next.get();
        self.next.set(handle + 1);
        self.timers.borrow_mut().push((handle, None));
        self.schedule(handle, interval_ms);
        handle
    }

    fn clear_interval(&mut self, handle: u64) {
        let mut timers = self.timers.borrow_mut();
        if let Some(at) = timers.iter().position(|(h, _)| *h == handle) {
            let (_, timer) = timers.remove(at);
            drop(timers);
            self.rt.clear_timeout(timer);
        }
    }
}

/// What one stream's callbacks share
struct Run {
    rt: Rt,
    out: Rc<Out>,
    request_id: Option<JsonValue>,
    /// `lastPing`
    last_ping: Cell<f64>,
    /// `answerSeen`
    answer_seen: Cell<bool>,
    keepalive: RefCell<Option<FirstChunkKeepalive>>,
    ticker: Ticker,
    /// `stopReason`
    stop_reason: RefCell<Option<JsonValue>>,
}

impl Run {
    fn push(&self, kind: &str, rest: Vec<(&str, JsonValue)>) {
        self.out.push(chunk(&self.request_id, kind, rest));
    }

    /// `ping`: at most one per interval
    fn ping(&self) {
        let now = self.rt.now();
        if now - self.last_ping.get() < AI_KEEPALIVE_INTERVAL_MS {
            return;
        }
        self.last_ping.set(now);
        self.push("ping", Vec::new());
    }

    /// `answerStarted`
    fn answer_started(&self) {
        if self.answer_seen.replace(true) {
            return;
        }
        if let Some(keepalive) = self.keepalive.borrow_mut().as_mut() {
            keepalive.first_chunk(&mut self.ticker.clone());
        }
    }

    fn stop_keepalive(&self) {
        if let Some(keepalive) = self.keepalive.borrow_mut().as_mut() {
            keepalive.stop(&mut self.ticker.clone());
        }
    }
}

/// A local server's first-response limit: the active custom endpoint's, when
/// the provider is `custom` and the endpoint is a local one
fn local_timeout(provider: &str, settings: &JsonValue) -> Option<f64> {
    if provider != "custom" {
        return None;
    }
    let active = prop(settings, "customEndpoint")?;
    let JsonValue::Array(endpoints) = prop(settings, "customEndpoints")? else {
        return None;
    };
    let endpoint = endpoints.iter().find(|e| prop(e, "id") == Some(active))?;
    matches!(prop(endpoint, "kind"), Some(JsonValue::String(kind)) if kind == "local")
        .then(|| local_endpoint_timeout_ms(Some(endpoint)))
}

/// What a missing `request` is to the destructuring of the handler
fn destructuring_error(request: &Option<JsonValue>) -> Option<JsTypeError> {
    let reason = match request {
        None => "undefined",
        Some(JsonValue::Null) => "null",
        Some(_) => return None,
    };
    Some(JsTypeError(format!(
        "Cannot destructure property 'requestId' of 'request' as it is {reason}."
    )))
}

pub(super) fn ai_stream(
    core: &Rc<Core>,
    cx: &CallContext,
    request: Option<JsonValue>,
    reply: Responder,
) {
    if let Some(error) = destructuring_error(&request) {
        return reply.reply(Err(thrown_type_error(error)));
    }
    let request = request.unwrap_or(JsonValue::Null);
    let get = |key: &str| prop(&request, key).cloned();
    let request_id = get("requestId");
    let view = cx.sender.view;
    let send = {
        let services = core.services.clone();
        move |chunk: &JsonValue| {
            if services.views.sender_of(view).is_some() {
                services.events.emit(
                    Target::View(view),
                    "ai:stream-chunk",
                    vec![from_json(chunk)],
                );
            }
        }
    };

    // the selection decides, and nothing stands in for a provider that cannot run
    let settings_arg = get("settings").unwrap_or(JsonValue::Null);
    let statuses = core.host.subscription_statuses();
    let target = match resolve_ai_run(
        &core.files.guard,
        Some(core.files.codec()),
        &settings_arg,
        &statuses,
        &Texts(core.host.ui_lang()),
    ) {
        Ok(target) => target,
        Err(error) => return reply.reply(Err(thrown_type_error(error))),
    };
    let (settings, provider, config) = match target {
        AiRunTarget::Refused { refusal } => {
            let mut error = chunk(&request_id, "error", Vec::new());
            if let JsonValue::Object(fields) = &refusal {
                error.assign(fields);
            }
            send(&JsonValue::Object(error));
            return reply.reply(Ok(IpcValue::Undefined));
        }
        AiRunTarget::Ok {
            settings,
            provider,
            config,
            ..
        } => (settings, provider, config),
    };
    let model = match prop(&config, "model") {
        Some(JsonValue::String(model)) => model.clone(),
        _ => String::new(),
    };
    let guard = core.provided.all::<dyn DriveService>();
    let refusal = guard.first().and_then(|drive| {
        drive.ai_run_refusal(&AiRunGuardInput {
            sender_id: f64::from(view.0),
            provider: provider.clone(),
            model,
        })
    });
    if let Some(refusal) = refusal {
        let error = chunk(&request_id, "error", vec![("error", text(refusal))]);
        send(&JsonValue::Object(error));
        return reply.reply(Ok(IpcValue::Undefined));
    }

    let system = match get("system") {
        Some(JsonValue::String(system)) => system,
        _ => String::new(),
    };
    let messages = match get("messages") {
        Some(JsonValue::Array(messages)) => messages,
        _ => Vec::new(),
    };
    let tools = match get("tools") {
        Some(JsonValue::Array(tools)) => tools,
        _ => Vec::new(),
    };
    let max_tokens = match get("maxTokens") {
        Some(JsonValue::Number(n)) => n,
        _ => max_output_tokens_of(Some(&settings)),
    };
    // A local server loads the model on its first request, so this endpoint's
    // own first-response limit replaces the protocol default, and a timer
    // keeps the renderer informed while nothing has arrived yet
    let local_timeout_ms = local_timeout(&provider, &settings);
    let session_id = match get("sessionId") {
        Some(JsonValue::String(id)) if !id.is_empty() => Some(id),
        _ => None,
    };

    let rt = core.driver.rt();
    let providers = core.driver.providers();
    let controller = rt.controller();
    let key = super::request_key(request_id.as_ref());
    core.streams
        .borrow_mut()
        .insert(key.clone(), controller.clone());
    let watch = core.watches.watch(view, &cx.cancel, &controller);

    let out = Out::new(rt.clone(), {
        Box::new(move |chunk| send(&JsonValue::Object(chunk)))
    });
    let run = Rc::new_cyclic(|weak: &std::rc::Weak<Run>| {
        let ping = weak.clone();
        Run {
            rt: rt.clone(),
            out,
            request_id: request_id.clone(),
            last_ping: Cell::new(0.0),
            answer_seen: Cell::new(false),
            keepalive: RefCell::new(None),
            ticker: Ticker {
                rt: rt.clone(),
                send: Rc::new(move || {
                    if let Some(run) = ping.upgrade() {
                        run.ping();
                    }
                }),
                timers: Rc::default(),
                next: Rc::new(Cell::new(1)),
            },
            stop_reason: RefCell::new(None),
        }
    });
    if local_timeout_ms.is_some() {
        *run.keepalive.borrow_mut() =
            Some(start_first_chunk_keepalive(&mut run.ticker.clone(), None));
    }

    let id_text = request_id.as_ref().map(js_string).unwrap_or_default();
    let callbacks = {
        let delta = run.clone();
        let reasoning = run.clone();
        let tool = run.clone();
        let activity = run.clone();
        let stop = run.clone();
        let usage = run.clone();
        let subscription = run.clone();
        let truncated = run.clone();
        let (subscription_id, truncated_id) = (id_text.clone(), id_text.clone());
        StreamCallbacks {
            on_delta: Rc::new(move |value| {
                delta.answer_started();
                delta.push("delta", vec![("text", value)]);
            }),
            on_tool_call: Rc::new(move |call| {
                tool.answer_started();
                tool.push("tool-call", vec![("toolCall", call)]);
            }),
            on_reasoning_delta: Some(Rc::new(move |value| {
                reasoning.answer_started();
                reasoning.push("reasoning", vec![("text", value)]);
            })),
            on_stop_reason: Some(Rc::new(move |reason| {
                *stop.stop_reason.borrow_mut() = Some(reason);
            })),
            on_usage: Some(Rc::new(move |value| {
                usage.push("usage", vec![("usage", value)]);
            })),
            on_subscription_usage: Some(Rc::new(move |value| {
                let target = subscription.clone();
                subscription_stream_callbacks(&subscription_id, &mut |chunk| {
                    if let JsonValue::Object(chunk) = chunk {
                        target.out.push(chunk);
                    }
                })
                .on_subscription_usage(&value);
            })),
            on_input_truncated: Some(Rc::new(move || {
                let target = truncated.clone();
                subscription_stream_callbacks(&truncated_id, &mut |chunk| {
                    if let JsonValue::Object(chunk) = chunk {
                        target.out.push(chunk);
                    }
                })
                .on_input_truncated();
            })),
            // Headers are not an answer: a local server may send them while it
            // is still loading the model. Keep pinging until the first real chunk.
            on_activity: Some(Rc::new(move || {
                if !activity.answer_seen.get() {
                    activity.ping();
                }
            })),
            session_id,
            signal: controller.clone(),
        }
    };

    let core = core.clone();
    let driver = core.driver.clone();
    let future = {
        let run = run.clone();
        let rt = rt.clone();
        async move {
            let result = stream_for_provider(
                &rt,
                &providers,
                &provider,
                &config,
                &system,
                &messages,
                &tools,
                max_tokens,
                &callbacks,
                &StreamForProviderOptions {
                    timeout_ms: local_timeout_ms,
                },
            )
            .await;
            let mut failed = None;
            match result {
                Ok(()) => {
                    let rest = run
                        .stop_reason
                        .borrow()
                        .clone()
                        .map(|reason| vec![("stopReason", reason)])
                        .unwrap_or_default();
                    run.push("done", rest);
                }
                Err(_) if controller.aborted() => run.push("done", Vec::new()),
                Err(error) => {
                    match ai_stream_error_chunk(&id_text, &super::thrown_json(&error), rt.now()) {
                        Ok(JsonValue::Object(error)) => run.out.push(error),
                        Ok(_) => {}
                        Err(thrown) => failed = Some(thrown),
                    }
                }
            }
            // success, error and cancel all leave through here: the timer never survives the turn
            run.stop_keepalive();
            run.out.flush();
            core.watches.unwatch(watch);
            core.streams.borrow_mut().remove(&key);
            failed
        }
    };
    driver.run(future, move |failed| {
        reply.reply(match failed {
            None => Ok(IpcValue::Undefined),
            Some(error) => Err(thrown_type_error(error)),
        })
    });
}
