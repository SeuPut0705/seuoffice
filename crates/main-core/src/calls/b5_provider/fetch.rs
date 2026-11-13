//! Part `fetch` of group `b5-provider` (tools/main-diff/groups/b5-provider/fetch.ts):
//! `packages/ai-provider/src/fetch.ts` and `protocols/shared.ts`.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Value, json};

use super::super::{Answer, CallError, Context, arg};
use super::world::{Sink, call_error, drive, note};
use crate::packages::ai_provider::fetch::{
    AiFetch, AiFetchState, AiFetchWatch, Init, KeyedDownloadOptions, KeyedFetchBase, ai_fetch,
    fetch_seeing_redirects, keyed_download, keyed_fetch, with_user_agent,
};
use crate::packages::ai_provider::jsval::Obj;
use crate::packages::ai_provider::protocols_shared::{
    CappedReadOptions, SseDataEvents, SseLines, endpoint_url, json_body_instead_of_sse,
    open_ai_content_text, parse_tool_input, read_capped_response_text, sse_error_text,
    throw_if_credits_notice, throw_if_tool_count_over_budget, throw_if_tool_json_over_budget,
    usage_count,
};
use crate::packages::ai_provider::task::{
    Fetcher, JsError, LocalBoxFuture, Request, RequestBody, Response, Rt, Signal,
};

const URL_A: &str = "https://api.example.com/v1/chat";

fn jv(args: &[Value], i: usize) -> JsonValue {
    arg(args, i).map_or(JsonValue::Null, json_value_from_serde)
}

fn s(args: &[Value], i: usize) -> String {
    arg(args, i)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn n(args: &[Value], i: usize) -> f64 {
    arg(args, i).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

fn thrown(e: JsError) -> CallError {
    call_error(&e)
}

fn unit(r: Result<(), JsError>) -> Answer {
    r.map(|()| None).map_err(thrown)
}

/// The options of a case (`Opts` of the spec).
struct Opts {
    url: String,
    request: Request,
    rescue: bool,
    embed: bool,
    ua: String,
    delays: Option<Vec<f64>>,
    watch: bool,
    base: String,
    key_outside_headers: Option<bool>,
    max_bytes: Option<f64>,
    truncate: bool,
    on_bytes: bool,
}

fn opts(v: Option<&Value>) -> Opts {
    let get = |k: &str| v.and_then(|v| v.get(k));
    let flag = |k: &str| get(k).and_then(Value::as_bool) == Some(true);
    let init = get("init");
    let field = |k: &str| init.and_then(|i| i.get(k));
    let body = match (field("body"), field("bodyHex")) {
        (_, Some(Value::String(h))) => Some(RequestBody::Bytes(
            (0..h.len() / 2)
                .filter_map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).ok())
                .collect(),
        )),
        (Some(Value::String(b)), _) => Some(RequestBody::Text(b.clone())),
        _ => None,
    };
    Opts {
        url: get("url")
            .and_then(Value::as_str)
            .unwrap_or(URL_A)
            .to_owned(),
        request: Request {
            method: field("method").and_then(Value::as_str).map(str::to_owned),
            headers: field("headers")
                .and_then(Value::as_object)
                .map(|o| {
                    o.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
                        .collect()
                })
                .unwrap_or_default(),
            body,
            redirect: field("redirect").and_then(Value::as_str).map(str::to_owned),
        },
        rescue: flag("rescue"),
        embed: flag("embed"),
        ua: get("ua")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        delays: get("delays")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_f64).collect()),
        watch: flag("watch"),
        base: get("base")
            .and_then(Value::as_str)
            .unwrap_or("ai")
            .to_owned(),
        key_outside_headers: get("keyOutsideHeaders").and_then(Value::as_bool),
        max_bytes: get("maxBytes").and_then(Value::as_f64),
        truncate: flag("truncate"),
        on_bytes: flag("onBytes"),
    }
}

/// `setUp(run, o)`: the module state of the case
fn state(o: &Opts) -> AiFetch {
    let mut state = AiFetchState::default();
    state.set_rescue_fetch(o.rescue.then_some(Fetcher::Net));
    state.set_ai_fetch(o.embed.then_some(Fetcher::Embed));
    state.set_ai_user_agent(&o.ua);
    state.set_ai_transient_retry_delays(o.delays.clone());
    Rc::new(RefCell::new(state))
}

fn base_of(base: &str) -> KeyedFetchBase {
    match base {
        "node" => KeyedFetchBase::Plain(Fetcher::Node),
        "net" => KeyedFetchBase::Plain(Fetcher::Net),
        "seeing" => fetch_seeing_redirects(
            KeyedFetchBase::Plain(Fetcher::Net),
            KeyedFetchBase::Plain(Fetcher::Node),
        ),
        _ => KeyedFetchBase::Ai,
    }
}

fn watch_of(o: &Opts, sink: &Sink) -> Option<AiFetchWatch> {
    o.watch.then(|| {
        let sink = sink.clone();
        AiFetchWatch {
            on_resend: Some(Rc::new(move |why| note(&sink, json!(["resend", why])))),
        }
    })
}

fn on_bytes(o: &Opts, sink: &Sink) -> Option<Rc<dyn Fn()>> {
    o.on_bytes.then(|| {
        let sink = sink.clone();
        Rc::new(move || note(&sink, json!(["bytes"]))) as Rc<dyn Fn()>
    })
}

/// `answer(r)`: `{ status, type, text }`
async fn answer(r: Response) -> Result<Value, JsError> {
    let text = r.text().await?;
    Ok(json!({ "status": r.status(), "type": r.kind(), "text": text }))
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
        Err(e) => Err(thrown(e)),
    }
}

/// A fetch over Node's fetch in the world, then `read` of its response.
fn with_response<F>(
    args: &[Value],
    cx: &mut Context,
    read: impl FnOnce(Response, Opts, Sink) -> F + 'static,
) -> Answer
where
    F: Future<Output = Result<Value, JsError>> + 'static,
{
    in_world(args, cx, move |rt, signal, sink, o| async move {
        let r = rt
            .fetch(Fetcher::Node, URL_A, Request::default(), Some(&signal))
            .await?;
        read(r, o, sink).await
    })
}

/// `readOne(n)`: a fetch of the n-th answer, read to its end, logged when done
async fn read_one(rt: Rt, n: u64, sink: Sink, signal: Signal) -> Result<String, JsError> {
    let r = rt
        .fetch(
            Fetcher::Node,
            &format!("{URL_A}/{n}"),
            Request::default(),
            Some(&signal),
        )
        .await?;
    let text = r.text().await?;
    note(&sink, json!(["done", n, text]));
    if text.starts_with("fail") {
        return Err(JsError::error(format!("failed {n}")));
    }
    Ok(text)
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- protocols/shared.ts, the pure part ----
        "shared.endpointUrl" => {
            let search = arg(args, 2).and_then(Value::as_str);
            endpoint_url(&s(args, 0), &s(args, 1), search)
                .map(|u| Some(Value::String(u)))
                .map_err(thrown)
        }
        "shared.openAiContentText" => Ok(Some(Value::String(open_ai_content_text(Some(&jv(
            args, 0,
        )))))),
        "shared.sseErrorText" => Ok(Some(Value::String(sse_error_text(
            Some(&jv(args, 0)),
            &s(args, 1),
        )))),
        "shared.usageCount" => Ok(Some(
            usage_count(Some(&jv(args, 0))).map_or(Value::Null, |x| json!(x)),
        )),
        "shared.parseToolInput" => {
            let (input, error) = parse_tool_input(&s(args, 0));
            let mut out = Obj::new();
            out.set("input", JsonValue::Object(input));
            if let Some(error) = error {
                out.set("error", JsonValue::String(error));
            }
            Ok(Some(json_value_to_serde(&JsonValue::Object(out))))
        }
        "shared.throwIfCreditsNotice" => unit(throw_if_credits_notice(&s(args, 0))),
        "shared.throwIfToolJsonOverBudget" => {
            unit(throw_if_tool_json_over_budget(n(args, 0), &s(args, 1)))
        }
        "shared.throwIfToolCountOverBudget" => {
            unit(throw_if_tool_count_over_budget(n(args, 0), &s(args, 1)))
        }

        // ---- protocols/shared.ts, the body readers ----
        "shared.readCappedResponseText" => with_response(args, cx, |r, o, sink| async move {
            let opts = CappedReadOptions {
                max_bytes: o.max_bytes,
                on_bytes: on_bytes(&o, &sink),
                truncate: o.truncate,
            };
            Ok(Value::String(read_capped_response_text(&r, &opts).await?))
        }),
        "shared.sseLines" => with_response(args, cx, |r, o, sink| async move {
            let mut lines = SseLines::new(&r, on_bytes(&o, &sink));
            let mut out = Vec::new();
            while let Some(line) = lines.next().await? {
                out.push(Value::String(line));
            }
            Ok(Value::Array(out))
        }),
        "shared.sseDataEvents" => with_response(args, cx, |r, o, sink| async move {
            let mut events = SseDataEvents::new(&r, on_bytes(&o, &sink));
            let mut out = Vec::new();
            while let Some(e) = events.next().await? {
                let json = e
                    .json
                    .as_ref()
                    .map_or(Value::String("<undefined>".into()), json_value_to_serde);
                out.push(json!([e.raw, json]));
            }
            Ok(Value::Array(out))
        }),
        "shared.jsonBodyInsteadOfSse" => with_response(args, cx, |r, _, _| async move {
            Ok(json_body_instead_of_sse(&r, None)
                .await?
                .map_or(Value::Null, Value::String))
        }),

        // ---- fetch.ts ----
        "fetch.withUserAgent" => {
            let mut state = AiFetchState::default();
            state.set_ai_user_agent(&s(args, 1));
            let fx = Rc::new(RefCell::new(state));
            let headers = arg(args, 0)
                .and_then(Value::as_object)
                .map(|o| {
                    o.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
                        .collect()
                })
                .unwrap_or_default();
            let init = Init {
                request: Request {
                    method: Some("POST".into()),
                    headers,
                    ..Request::default()
                },
                signal: None,
            };
            let out = with_user_agent(&fx, &init);
            Ok(Some(Value::Array(
                out.request
                    .headers
                    .iter()
                    .map(|(k, v)| json!([k, v]))
                    .collect(),
            )))
        }
        "fetch.aiFetch" => in_world(args, cx, |rt, signal, sink, o| async move {
            let fx = state(&o);
            let init = Init {
                request: o.request.clone(),
                signal: Some(signal),
            };
            let watch = watch_of(&o, &sink);
            answer(ai_fetch(&rt, &fx, &o.url, &init, watch.as_ref()).await?).await
        }),
        "fetch.keyedFetch" => in_world(args, cx, |rt, signal, sink, o| async move {
            let fx = state(&o);
            let init = Init {
                request: o.request.clone(),
                signal: Some(signal),
            };
            let watch = watch_of(&o, &sink);
            let base = base_of(&o.base);
            answer(keyed_fetch(&rt, &fx, &o.url, &init, watch.as_ref(), &base).await?).await
        }),
        "fetch.keyedDownload" => in_world(args, cx, |rt, signal, _sink, o| async move {
            let fx = state(&o);
            let init = Init {
                request: o.request.clone(),
                signal: Some(signal),
            };
            let options = KeyedDownloadOptions {
                base: (o.base != "ai").then(|| base_of(&o.base)),
                key_outside_headers: o.key_outside_headers.unwrap_or(false),
            };
            answer(keyed_download(&rt, &fx, &o.url, &init, &options).await?).await
        }),

        // ---- the runtime's combinators ----
        "task.race" | "task.all" => {
            let world = arg(args, 0).cloned();
            let n = arg(args, 1).and_then(Value::as_u64).unwrap_or(0);
            let all = name == "task.all";
            let outcome = drive(world.as_ref(), cx, move |rt, signal, sink| async move {
                let futures: Vec<LocalBoxFuture<Result<String, JsError>>> = (0..n)
                    .map(|k| {
                        Box::pin(read_one(rt.clone(), k, sink.clone(), signal.clone()))
                            as LocalBoxFuture<Result<String, JsError>>
                    })
                    .collect();
                if all {
                    rt.try_join_all(futures)
                        .await
                        .map(|v| Value::Array(v.into_iter().map(Value::String).collect()))
                } else {
                    rt.race(futures).await.1.map(Value::String)
                }
            });
            match outcome {
                Ok(outcome) => outcome.map(Some).map_err(thrown),
                Err(e) => Err(e),
            }
        }
        _ => return None,
    })
}
