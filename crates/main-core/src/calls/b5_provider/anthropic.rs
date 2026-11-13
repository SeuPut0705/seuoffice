//! Part `anthropic` of group `b5-provider` (tools/main-diff/groups/b5-provider/anthropic.ts):
//! `packages/ai-provider/src/protocols/anthropic.ts`, `gemini.ts` and
//! `gemini-schema.ts`.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Value, json};

use super::super::{Answer, Context, arg};
use super::world::{Sink, call_error, drive, note};
use crate::packages::ai_provider::fetch::{AiFetch, AiFetchState};
use crate::packages::ai_provider::jsval::Obj;
use crate::packages::ai_provider::protocols_anthropic::{
    ANTHROPIC_BASE_URL, chat_anthropic, stream_anthropic,
};
use crate::packages::ai_provider::protocols_gemini::{
    GEMINI_BASE_URL, GeminiRequestOptions, chat_gemini, stream_gemini,
};
use crate::packages::ai_provider::protocols_gemini_schema::to_gemini_schema;
use crate::packages::ai_provider::protocols_shared::StreamCallbacks;
use crate::packages::ai_provider::task::{JsError, Rt, Signal};
use crate::packages::ai_provider::watchdog::create_stream_watchdog;

/// What a case gives a call (`Opts` of the spec), with the defaults the
/// spec's `ts` fills in.
struct Opts {
    config: JsonValue,
    system: String,
    user: String,
    messages: JsonValue,
    tools: JsonValue,
    max_tokens: f64,
    base_url: Option<String>,
    body_extras: Option<Obj>,
    options: GeminiRequestOptions,
    session_id: Option<String>,
    activity: bool,
    bare: bool,
}

fn opts(v: Option<&Value>) -> Opts {
    // `o.x ?? default`: `null` and a missing key are both the default
    let get = |k: &str| v.and_then(|v| v.get(k)).filter(|x| !x.is_null());
    let text =
        |k: &str, default: &str| get(k).and_then(Value::as_str).unwrap_or(default).to_owned();
    Opts {
        config: get("config").map_or_else(
            || json_value_from_serde(&json!({ "apiKey": "sk-test", "model": "model-1" })),
            json_value_from_serde,
        ),
        system: text("system", "You help."),
        user: text("user", "Say hi"),
        messages: get("messages").map_or_else(
            || json_value_from_serde(&json!([{ "role": "user", "text": "hi" }])),
            json_value_from_serde,
        ),
        tools: get("tools").map_or_else(|| JsonValue::Array(Vec::new()), json_value_from_serde),
        max_tokens: get("maxTokens").and_then(Value::as_f64).unwrap_or(4096.0),
        base_url: get("baseUrl").and_then(Value::as_str).map(str::to_owned),
        body_extras: get("bodyExtras")
            .map(json_value_from_serde)
            .and_then(|v| match v {
                JsonValue::Object(o) => Some(o),
                _ => None,
            }),
        options: GeminiRequestOptions {
            omit_temperature: get("options")
                .and_then(|o| o.get("omitTemperature"))
                .and_then(Value::as_bool),
        },
        session_id: get("sessionId").and_then(Value::as_str).map(str::to_owned),
        activity: get("activity").and_then(Value::as_bool) == Some(true),
        bare: get("bare").and_then(Value::as_bool) == Some(true),
    }
}

/// `setUp()`: the module state of `fetch.ts` as the spec leaves it.
fn fetch_state() -> AiFetch {
    let mut state = AiFetchState::default();
    state.set_rescue_fetch(None);
    state.set_ai_fetch(None);
    state.set_ai_user_agent("");
    state.set_ai_transient_retry_delays(None);
    Rc::new(RefCell::new(state))
}

/// `callbacks(o, cx, signal)`: each callback logs a line.
fn callbacks(o: &Opts, sink: &Sink, signal: Signal) -> StreamCallbacks {
    let delta = sink.clone();
    let tool = sink.clone();
    let mut cb = StreamCallbacks {
        on_delta: Rc::new(move |t: &str| note(&delta, json!(["delta", t]))),
        on_tool_call: Rc::new(move |call: JsonValue| {
            note(&tool, json!(["tool", json_value_to_serde(&call)]));
        }),
        on_reasoning_delta: None,
        on_stop_reason: None,
        on_usage: None,
        on_subscription_usage: None,
        on_input_truncated: None,
        on_activity: None,
        session_id: o.session_id.clone(),
        signal,
    };
    if !o.bare {
        let stop = sink.clone();
        cb.on_stop_reason = Some(Rc::new(move |r: &str| note(&stop, json!(["stop", r]))));
        let usage = sink.clone();
        cb.on_usage = Some(Rc::new(move |u: JsonValue| {
            note(&usage, json!(["usage", json_value_to_serde(&u)]));
        }));
    }
    if o.activity {
        let activity = sink.clone();
        cb.on_activity = Some(Rc::new(move || note(&activity, json!(["activity"]))));
    }
    cb
}

/// Runs `body` in the case's world; its value or what it threw.
fn in_world<F>(
    args: &[Value],
    cx: &mut Context,
    body: impl FnOnce(Rt, Signal, Sink, Opts) -> F,
) -> Answer
where
    F: Future<Output = Result<Value, JsError>> + 'static,
{
    let world = arg(args, 0).cloned();
    let o = opts(arg(args, 1));
    match drive(world.as_ref(), cx, move |rt, signal, sink| {
        body(rt, signal, sink, o)
    })? {
        Ok(v) => Ok(Some(v)),
        Err(e) => Err(call_error(&e)),
    }
}

/// A function that answers nothing (`undefined`).
fn in_world_unit<F>(
    args: &[Value],
    cx: &mut Context,
    body: impl FnOnce(Rt, Signal, Sink, Opts) -> F,
) -> Answer
where
    F: Future<Output = Result<(), JsError>> + 'static,
{
    let world = arg(args, 0).cloned();
    let o = opts(arg(args, 1));
    match drive(world.as_ref(), cx, move |rt, signal, sink| {
        body(rt, signal, sink, o)
    })? {
        Ok(()) => Ok(None),
        Err(e) => Err(call_error(&e)),
    }
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "anthropic.ANTHROPIC_BASE_URL" => Ok(Some(Value::String(ANTHROPIC_BASE_URL.to_owned()))),
        "anthropic.streamAnthropic" => in_world_unit(args, cx, |rt, signal, sink, o| async move {
            let fx = fetch_state();
            let cb = callbacks(&o, &sink, signal);
            stream_anthropic(
                &rt,
                &fx,
                &o.config,
                &o.system,
                &o.messages,
                &o.tools,
                o.max_tokens,
                &cb,
                o.base_url.as_deref(),
                o.body_extras.as_ref(),
            )
            .await
        }),
        "anthropic.chatAnthropic" => in_world(args, cx, |rt, signal, _sink, o| async move {
            let fx = fetch_state();
            let wd = create_stream_watchdog(&rt, Some(&signal), None, None);
            let answer = wd
                .guard(chat_anthropic(
                    &rt,
                    &fx,
                    &wd,
                    &o.config,
                    &o.system,
                    &o.user,
                    o.base_url.as_deref(),
                    o.body_extras.as_ref(),
                ))
                .await?;
            Ok(json_value_to_serde(&answer.to_json()))
        }),
        "gemini.GEMINI_BASE_URL" => Ok(Some(Value::String(GEMINI_BASE_URL.to_owned()))),
        "gemini.streamGemini" => in_world_unit(args, cx, |rt, signal, sink, o| async move {
            let fx = fetch_state();
            let cb = callbacks(&o, &sink, signal);
            stream_gemini(
                &rt,
                &fx,
                &o.config,
                &o.system,
                &o.messages,
                &o.tools,
                o.max_tokens,
                &cb,
                o.base_url.as_deref(),
                &o.options,
            )
            .await
        }),
        "gemini.chatGemini" => in_world(args, cx, |rt, signal, _sink, o| async move {
            let fx = fetch_state();
            let wd = create_stream_watchdog(&rt, Some(&signal), None, None);
            let answer = wd
                .guard(chat_gemini(
                    &rt,
                    &fx,
                    &wd,
                    &o.config,
                    &o.system,
                    &o.user,
                    o.base_url.as_deref(),
                    &o.options,
                ))
                .await?;
            Ok(json_value_to_serde(&answer.to_json()))
        }),
        "gemini-schema.toGeminiSchema" => {
            let schema = arg(args, 0).map_or(JsonValue::Null, json_value_from_serde);
            to_gemini_schema(Some(&schema))
                .map(|converted| Some(json_value_to_serde(&JsonValue::Object(converted))))
                .map_err(|e| call_error(&e))
        }
        _ => return None,
    })
}
