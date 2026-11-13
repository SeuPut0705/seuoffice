//! Part `openai` of group `b5-provider` (tools/main-diff/groups/b5-provider/openai.ts):
//! `packages/ai-provider/src/{protocols/openai-compatible.ts,
//! protocols/openai-responses.ts, protocols/gateway-complete.ts,
//! http-error.ts, output-cap.ts}`. The names are `<file>.<export>`; the
//! arguments are described at the head of the TypeScript spec.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsObject, JsonValue, json_value_from_serde, json_value_to_serde, number_to_string};
use serde_json::{Value, json};

use super::super::{Answer, CallError, Context, arg};
use super::world::{Sink, call_error, drive, note};
use crate::packages::ai_provider::fetch::{AiFetch, AiFetchState};
use crate::packages::ai_provider::http_error::http_body_detail;
use crate::packages::ai_provider::jsval::{Obj, as_record, js_string};
use crate::packages::ai_provider::output_cap::{
    OutputCaps, parse_output_cap_rejection, with_output_cap_fallback,
};
use crate::packages::ai_provider::protocols_gateway_complete::{
    GATEWAY_TOKEN_ENV, GatewayState, GatewayTokenProvider, chat_gateway_complete,
    stream_gateway_complete,
};
use crate::packages::ai_provider::protocols_openai_compatible::{
    OpenAiCompatibleState, OpenAiRequestOptions, chat_open_ai_compatible, stream_open_ai_compatible,
};
use crate::packages::ai_provider::protocols_openai_responses::{
    OpenAiResponsesOptions, chat_open_ai_responses, stream_open_ai_responses,
};
use crate::packages::ai_provider::protocols_shared::StreamCallbacks;
use crate::packages::ai_provider::task::{JsError, LocalBoxFuture, Rt, Signal};
use crate::packages::ai_provider::watchdog::create_stream_watchdog;

const BASE: &str = "https://api.example.com/v1";
const GW: &str = "https://gateway.example.com/v1";

/// A number as JSON writes it: an integer where it is one.
fn jnum(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9e15 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

fn thrown(e: JsError) -> CallError {
    call_error(&e)
}

fn from_serde(v: &Value) -> JsonValue {
    json_value_from_serde(v)
}

fn field<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    v.and_then(|v| v.get(key))
}

fn flag(v: Option<&Value>, key: &str) -> bool {
    field(v, key).and_then(Value::as_bool) == Some(true)
}

fn text_of(v: Option<&Value>, key: &str) -> Option<String> {
    field(v, key).and_then(Value::as_str).map(str::to_owned)
}

fn number_of(v: Option<&Value>, key: &str) -> Option<f64> {
    field(v, key).and_then(Value::as_f64)
}

fn object_of(v: Option<&Value>, key: &str) -> Option<Obj> {
    field(v, key)
        .map(from_serde)
        .and_then(|v| as_record(&v).cloned())
}

/// The options of a case (`Opts` of the spec).
struct Opts {
    base_url: String,
    config: JsonValue,
    system: String,
    messages: JsonValue,
    tools: JsonValue,
    max_tokens: f64,
    user: String,
    compat: OpenAiRequestOptions,
    responses: OpenAiResponsesOptions,
    gateway_timeout_ms: Option<f64>,
    session_id: Option<String>,
    activity: bool,
    bare: bool,
    delays: Option<Vec<f64>>,
    provider: bool,
}

fn opts(v: Option<&Value>) -> Opts {
    let options = field(v, "options");
    let headers = field(options, "headers")
        .and_then(Value::as_object)
        .map(|o| {
            let mut headers: JsObject<String> = JsObject::new();
            for (k, v) in o {
                headers.set(k.clone(), v.as_str().unwrap_or_default().to_owned());
            }
            headers
        });
    Opts {
        base_url: text_of(v, "baseUrl").unwrap_or_else(|| BASE.to_owned()),
        config: field(v, "config")
            .map(from_serde)
            .unwrap_or_else(|| from_serde(&json!({ "model": "gpt-4o", "apiKey": "sk-test" }))),
        system: text_of(v, "system").unwrap_or_else(|| "sys".to_owned()),
        messages: field(v, "messages")
            .map(from_serde)
            .unwrap_or_else(|| from_serde(&json!([{ "role": "user", "text": "hi" }]))),
        tools: field(v, "tools")
            .map(from_serde)
            .unwrap_or_else(|| JsonValue::Array(Vec::new())),
        max_tokens: number_of(v, "maxTokens").unwrap_or(4096.0),
        user: text_of(v, "user").unwrap_or_else(|| "question".to_owned()),
        compat: OpenAiRequestOptions {
            omit_temperature: flag(options, "omitTemperature"),
            use_max_completion_tokens: flag(options, "useMaxCompletionTokens"),
            body_extras: object_of(options, "bodyExtras"),
            timeout_ms: number_of(options, "timeoutMs"),
            max_tokens: number_of(options, "maxTokens"),
            temperature: number_of(options, "temperature"),
        },
        responses: OpenAiResponsesOptions {
            reasoning_effort: text_of(options, "reasoningEffort"),
            body_extras: object_of(options, "bodyExtras"),
            headers,
            idle_timeout_ms: number_of(options, "idleTimeoutMs"),
        },
        gateway_timeout_ms: number_of(options, "timeoutMs"),
        session_id: text_of(v, "sessionId"),
        activity: flag(v, "activity"),
        bare: flag(v, "bare"),
        delays: field(v, "delays")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_f64).collect()),
        provider: flag(v, "provider"),
    }
}

/// `setUp(o)`: the fetch state of the case (nothing but the retry delays)
fn fetch_state(o: &Opts) -> AiFetch {
    let mut state = AiFetchState::default();
    state.set_ai_transient_retry_delays(o.delays.clone());
    Rc::new(RefCell::new(state))
}

/// `callbacksOf(o, cx, signal)`
fn callbacks(o: &Opts, sink: &Sink, signal: Signal) -> StreamCallbacks {
    let on_delta = {
        let sink = sink.clone();
        Rc::new(move |t: JsonValue| note(&sink, json!(["delta", json_value_to_serde(&t)])))
            as Rc<dyn Fn(JsonValue)>
    };
    let on_tool_call = {
        let sink = sink.clone();
        Rc::new(move |c: JsonValue| note(&sink, json!(["toolCall", json_value_to_serde(&c)])))
            as Rc<dyn Fn(JsonValue)>
    };
    let mut cb = StreamCallbacks {
        on_delta,
        on_tool_call,
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
        let s = sink.clone();
        cb.on_reasoning_delta = Some(Rc::new(move |t: JsonValue| {
            note(&s, json!(["reasoning", json_value_to_serde(&t)]))
        }) as Rc<dyn Fn(JsonValue)>);
        let s = sink.clone();
        cb.on_stop_reason =
            Some(
                Rc::new(move |r: JsonValue| note(&s, json!(["stop", json_value_to_serde(&r)])))
                    as Rc<dyn Fn(JsonValue)>,
            );
        let s = sink.clone();
        cb.on_usage =
            Some(
                Rc::new(move |u: JsonValue| note(&s, json!(["usage", json_value_to_serde(&u)])))
                    as Rc<dyn Fn(JsonValue)>,
            );
    }
    if o.activity {
        let s = sink.clone();
        cb.on_activity = Some(Rc::new(move || note(&s, json!(["activity"]))) as Rc<dyn Fn()>);
    }
    cb
}

/// Runs `body` in the case's world; its value (`None` is `undefined`) or what
/// it threw.
fn in_world<F>(
    args: &[Value],
    cx: &mut Context,
    body: impl FnOnce(Rt, Signal, Sink, Opts) -> F,
) -> Answer
where
    F: Future<Output = Result<Option<Value>, JsError>> + 'static,
{
    let world = arg(args, 0).cloned();
    let o = opts(arg(args, 1));
    match drive(world.as_ref(), cx, move |rt, signal, sink| {
        body(rt, signal, sink, o)
    })? {
        Ok(v) => Ok(v),
        Err(e) => Err(thrown(e)),
    }
}

/// `chatSpec`: a one-shot chat under a watchdog as the callers hold one.
fn chat_in_world<F, Fut>(args: &[Value], cx: &mut Context, call: F) -> Answer
where
    F: FnOnce(Rt, crate::packages::ai_provider::watchdog::StreamWatchdog, Opts) -> Fut + 'static,
    Fut: Future<Output = Result<JsonValue, JsError>> + 'static,
{
    in_world(args, cx, move |rt, signal, _sink, o| async move {
        let wd = create_stream_watchdog(&rt, Some(&signal), None, None);
        let answer = wd.guard(call(rt.clone(), wd.clone(), o)).await?;
        Ok(Some(json_value_to_serde(&answer)))
    })
}

/// The token provider of the case: the world's `token` call.
fn token_provider() -> GatewayTokenProvider {
    Rc::new(
        |rt: Rt, _signal: Option<Signal>| -> LocalBoxFuture<Result<String, JsError>> {
            Box::pin(async move {
                let token = rt.call("token", JsonValue::Array(Vec::new())).await?;
                Ok(match token {
                    JsonValue::String(s) => s,
                    other => js_string(&other),
                })
            })
        },
    )
}

/// The steps of a scenario.
fn steps_of(args: &[Value]) -> Vec<Value> {
    field(arg(args, 1), "steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn error_entry(e: &JsError) -> Value {
    json!({ "error": e.message_or_string() })
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- http-error.ts ----
        "http-error.httpBodyDetail" => {
            let body = arg(args, 0).and_then(Value::as_str).unwrap_or_default();
            http_body_detail(body)
                .map(|t| Some(Value::String(t)))
                .map_err(thrown)
        }

        // ---- output-cap.ts ----
        "output-cap.parseOutputCapRejection" => {
            let message = arg(args, 0).and_then(Value::as_str).unwrap_or_default();
            let requested = arg(args, 1).and_then(Value::as_f64).unwrap_or(f64::NAN);
            Ok(Some(
                parse_output_cap_rejection(message, requested).map_or(Value::Null, jnum),
            ))
        }
        "output-cap.withOutputCapFallback" | "output-cap.resetOutputCaps" => {
            let steps: Vec<Value> = arg(args, 0)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            drive(None, cx, move |rt, _signal, _sink| async move {
                let caps = Rc::new(RefCell::new(OutputCaps::default()));
                let mut out: Vec<Value> = Vec::new();
                for step in steps {
                    if flag(Some(&step), "reset") {
                        caps.borrow_mut().reset_output_caps();
                        out.push(json!("reset"));
                        continue;
                    }
                    let base_url = text_of(Some(&step), "baseUrl").unwrap_or_else(|| BASE.into());
                    let model = text_of(Some(&step), "model").unwrap_or_else(|| "gpt-4o".into());
                    let requested = number_of(Some(&step), "requested").unwrap_or(32768.0);
                    let fails: Vec<Value> = field(Some(&step), "fail")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    let calls: Rc<RefCell<Vec<f64>>> = Rc::new(RefCell::new(Vec::new()));
                    let seen = calls.clone();
                    let result = with_output_cap_fallback(
                        &rt,
                        &caps,
                        &base_url,
                        &model,
                        requested,
                        move |max| {
                            let k = seen.borrow().len();
                            seen.borrow_mut().push(max);
                            let outcome = match fails.get(k) {
                                None | Some(Value::Null) => {
                                    Ok(format!("ok:{}", number_to_string(max)))
                                }
                                Some(Value::String(message)) => {
                                    Err(JsError::error(message.clone()))
                                }
                                Some(other) => Err(JsError::value(JsonValue::String(
                                    other
                                        .get("value")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_owned(),
                                ))),
                            };
                            std::future::ready(outcome)
                        },
                    )
                    .await;
                    let calls: Vec<Value> = calls.borrow().iter().map(|m| jnum(*m)).collect();
                    out.push(match result {
                        Ok(result) => json!({ "calls": calls, "result": result }),
                        Err(e) => json!({ "calls": calls, "error": e.message_or_string() }),
                    });
                }
                Some(Value::Array(out))
            })
        }

        // ---- protocols/openai-compatible.ts ----
        "openai-compatible.streamOpenAiCompatible" => {
            in_world(args, cx, |rt, signal, sink, o| async move {
                let fx = fetch_state(&o);
                let st = Rc::new(RefCell::new(OpenAiCompatibleState::default()));
                let cb = callbacks(&o, &sink, signal);
                stream_open_ai_compatible(
                    &rt,
                    &fx,
                    &st,
                    &o.base_url,
                    &o.config,
                    &o.system,
                    &o.messages,
                    &o.tools,
                    o.max_tokens,
                    &cb,
                    &o.compat,
                )
                .await?;
                Ok(None)
            })
        }
        "openai-compatible.resetUsageRejectedGateways" => {
            let steps = steps_of(args);
            in_world(args, cx, move |rt, signal, sink, _o| async move {
                let fx = fetch_state(&opts(None));
                let st = Rc::new(RefCell::new(OpenAiCompatibleState::default()));
                let mut out: Vec<Value> = Vec::new();
                for step in &steps {
                    if flag(Some(step), "reset") {
                        st.borrow_mut().reset_usage_rejected_gateways();
                        out.push(json!("reset"));
                        continue;
                    }
                    let o = opts(Some(step));
                    let cb = callbacks(&o, &sink, signal.clone());
                    match stream_open_ai_compatible(
                        &rt,
                        &fx,
                        &st,
                        &o.base_url,
                        &o.config,
                        &o.system,
                        &o.messages,
                        &o.tools,
                        o.max_tokens,
                        &cb,
                        &o.compat,
                    )
                    .await
                    {
                        Ok(()) => out.push(json!("ok")),
                        Err(e) => out.push(error_entry(&e)),
                    }
                }
                Ok(Some(Value::Array(out)))
            })
        }
        "openai-compatible.chatOpenAiCompatible" => {
            chat_in_world(args, cx, |rt, wd, o| async move {
                let fx = fetch_state(&o);
                let st = Rc::new(RefCell::new(OpenAiCompatibleState::default()));
                chat_open_ai_compatible(
                    &rt,
                    &fx,
                    &st,
                    &wd,
                    &o.base_url,
                    &o.config,
                    &o.system,
                    &o.user,
                    &o.compat,
                )
                .await
                .map(|r| r.to_json())
            })
        }

        // ---- protocols/openai-responses.ts ----
        "openai-responses.streamOpenAiResponses" => {
            in_world(args, cx, |rt, signal, sink, o| async move {
                let fx = fetch_state(&o);
                let cb = callbacks(&o, &sink, signal);
                stream_open_ai_responses(
                    &rt,
                    &fx,
                    &o.base_url,
                    &o.config,
                    &o.system,
                    &o.messages,
                    &o.tools,
                    o.max_tokens,
                    &cb,
                    &o.responses,
                )
                .await?;
                Ok(None)
            })
        }
        "openai-responses.chatOpenAiResponses" => chat_in_world(args, cx, |rt, wd, o| async move {
            let fx = fetch_state(&o);
            chat_open_ai_responses(
                &rt,
                &fx,
                &wd,
                &o.base_url,
                &o.config,
                &o.system,
                &o.user,
                &o.responses,
            )
            .await
            .map(|r| r.to_json())
        }),

        // ---- protocols/gateway-complete.ts ----
        "gateway-complete.GATEWAY_TOKEN_ENV" => Ok(Some(Value::String(GATEWAY_TOKEN_ENV.into()))),
        "gateway-complete.streamGatewayComplete" => {
            in_world(args, cx, |rt, signal, sink, o| async move {
                let fx = fetch_state(&o);
                let st = Rc::new(RefCell::new(OpenAiCompatibleState::default()));
                let gw = Rc::new(RefCell::new(GatewayState::default()));
                if o.provider {
                    gw.borrow_mut()
                        .set_gateway_token_provider(Some(token_provider()));
                }
                let cb = callbacks(&o, &sink, signal);
                stream_gateway_complete(
                    &rt,
                    &fx,
                    &gw,
                    &st,
                    &o.base_url,
                    &o.config,
                    &o.system,
                    &o.messages,
                    &o.tools,
                    o.max_tokens,
                    &cb,
                    o.gateway_timeout_ms,
                )
                .await?;
                Ok(None)
            })
        }
        "gateway-complete.chatGatewayComplete" => chat_in_world(args, cx, |rt, wd, o| async move {
            let fx = fetch_state(&o);
            let st = Rc::new(RefCell::new(OpenAiCompatibleState::default()));
            let gw = Rc::new(RefCell::new(GatewayState::default()));
            if o.provider {
                gw.borrow_mut()
                    .set_gateway_token_provider(Some(token_provider()));
            }
            chat_gateway_complete(
                &rt,
                &fx,
                &gw,
                &st,
                &wd,
                &o.base_url,
                &o.config,
                &o.system,
                &o.user,
            )
            .await
            .map(|r| r.to_json())
        }),
        "gateway-complete.setGatewayTokenProvider" => {
            let steps = steps_of(args);
            in_world(args, cx, move |rt, _signal, _sink, _o| async move {
                let fx = fetch_state(&opts(None));
                let st = Rc::new(RefCell::new(OpenAiCompatibleState::default()));
                let gw = Rc::new(RefCell::new(GatewayState::default()));
                let mut out: Vec<Value> = Vec::new();
                for step in &steps {
                    match field(Some(step), "provider") {
                        Some(Value::Bool(true)) => {
                            gw.borrow_mut()
                                .set_gateway_token_provider(Some(token_provider()));
                            out.push(json!("provider set"));
                        }
                        Some(Value::String(s)) if s == "clear" => {
                            gw.borrow_mut().set_gateway_token_provider(None);
                            out.push(json!("provider cleared"));
                        }
                        _ => {}
                    }
                    if flag(Some(step), "request") {
                        let wd = create_stream_watchdog(&rt, None, None, None);
                        let base_url = text_of(Some(step), "baseUrl").unwrap_or_else(|| GW.into());
                        let config =
                            field(Some(step), "config")
                                .map(from_serde)
                                .unwrap_or_else(|| {
                                    from_serde(&json!({ "model": "gpt-4o", "apiKey": "sk-test" }))
                                });
                        let answer = wd
                            .guard(chat_gateway_complete(
                                &rt, &fx, &gw, &st, &wd, &base_url, &config, "sys", "question",
                            ))
                            .await?;
                        out.push(json_value_to_serde(&answer.to_json()));
                    }
                }
                Ok(Some(Value::Array(out)))
            })
        }
        _ => return None,
    })
}
