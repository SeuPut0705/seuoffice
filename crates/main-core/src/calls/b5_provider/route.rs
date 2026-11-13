//! Part `route` of group `b5-provider` (tools/main-diff/groups/b5-provider/route.ts):
//! stream.ts, chat.ts and the endpoint resolution of registry.ts.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Value, json};

use super::super::{Answer, CallError, Context, arg};
use super::world::{Sink, call_error, drive, note};
use crate::packages::ai_provider::chat::chat_for_provider;
use crate::packages::ai_provider::chatgpt_connection::ChatGptConnectionModuleState;
use crate::packages::ai_provider::chatgpt_responses::ChatGptBridgeDeps;
use crate::packages::ai_provider::claude_code_cli::ClaudeCodeCliDeps;
use crate::packages::ai_provider::codex_app_server::CodexAppServerState;
use crate::packages::ai_provider::fetch::{AiFetchState, KeyedFetchBase};
use crate::packages::ai_provider::protocols_shared::StreamCallbacks;
use crate::packages::ai_provider::registry::{
    model_echoes_reasoning, model_has_fixed_sampling, model_uses_responses_api, resolve_endpoint,
};
use crate::packages::ai_provider::stream::{
    Providers, StreamForProviderOptions, stream_for_provider,
};
use crate::packages::ai_provider::subscription_locate::SubscriptionLocateState;
use crate::packages::ai_provider::subscription_process::SharedChildRegistry;
use crate::packages::ai_provider::subscription_temp_dirs::SubscriptionTempState;
use crate::packages::ai_provider::task::{JsError, Rt, Signal};

fn s(args: &[Value], i: usize) -> String {
    arg(args, i)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// `setUp()` of the spec: the module states as a fresh app has them, with
/// no waits between retries
fn providers(rt: &Rt) -> Providers {
    let mut fetch = AiFetchState::default();
    fetch.set_ai_transient_retry_delays(Some(Vec::new()));
    let fx = Rc::new(RefCell::new(fetch));
    let shared = SharedChildRegistry::new(rt.now());
    let temp_dirs = Rc::new(RefCell::new(SubscriptionTempState::default()));
    let locate = Rc::new(RefCell::new(SubscriptionLocateState::new(shared.clone())));
    Providers {
        fx: fx.clone(),
        openai: Rc::default(),
        gateway: Rc::default(),
        caps: Rc::default(),
        codex: Rc::new(RefCell::new(CodexAppServerState::default())),
        claude: ClaudeCodeCliDeps::new(shared, temp_dirs, locate),
        chatgpt: ChatGptBridgeDeps {
            fx,
            fetch: KeyedFetchBase::Ai,
            connection: None,
            module: Rc::new(RefCell::new(ChatGptConnectionModuleState::default())),
        },
    }
}

fn logger(sink: &Sink, tag: &'static str) -> Rc<dyn Fn(JsonValue)> {
    let sink = sink.clone();
    Rc::new(move |v: JsonValue| note(&sink, json!([tag, json_value_to_serde(&v)])))
}

fn callbacks(sink: &Sink, signal: Signal) -> StreamCallbacks {
    StreamCallbacks {
        on_delta: logger(sink, "delta"),
        on_tool_call: logger(sink, "toolCall"),
        on_reasoning_delta: None,
        on_stop_reason: Some(logger(sink, "stop")),
        on_usage: Some(logger(sink, "usage")),
        on_subscription_usage: None,
        on_input_truncated: None,
        on_activity: None,
        session_id: None,
        signal,
    }
}

/// `toolDefs(names)` of the spec
fn tool_defs(o: &Value) -> Vec<JsonValue> {
    o.get("tools")
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .map(|name| {
                    json_value_from_serde(&json!({
                        "name": name,
                        "description": format!("the {name} tool"),
                        "inputSchema": { "type": "object" },
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn config_of(o: &Value) -> JsonValue {
    o.get("config")
        .map_or_else(|| json_value_from_serde(&json!({})), json_value_from_serde)
}

fn text_of(o: &Value, key: &str, default: &str) -> String {
    o.get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_owned()
}

fn thrown(e: JsError) -> CallError {
    call_error(&e)
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "stream.streamForProvider" => {
            let world = arg(args, 0).cloned();
            let o = arg(args, 1).cloned().unwrap_or(Value::Null);
            drive(world.as_ref(), cx, move |rt, signal, sink| async move {
                let p = providers(&rt);
                let messages = vec![json_value_from_serde(&json!({
                    "role": "user", "content": "hello"
                }))];
                let options = StreamForProviderOptions {
                    timeout_ms: o.get("timeoutMs").and_then(Value::as_f64),
                };
                stream_for_provider(
                    &rt,
                    &p,
                    &text_of(&o, "provider", ""),
                    &config_of(&o),
                    &text_of(&o, "system", "sys"),
                    &messages,
                    &tool_defs(&o),
                    o.get("maxTokens").and_then(Value::as_f64).unwrap_or(1000.0),
                    &callbacks(&sink, signal),
                    &options,
                )
                .await
            })
            .and_then(|r| r.map(|()| None).map_err(thrown))
        }
        "chat.chatForProvider" => {
            let world = arg(args, 0).cloned();
            let o = arg(args, 1).cloned().unwrap_or(Value::Null);
            drive(world.as_ref(), cx, move |rt, signal, _sink| async move {
                let p = providers(&rt);
                chat_for_provider(
                    &rt,
                    &p,
                    &text_of(&o, "provider", ""),
                    &config_of(&o),
                    &text_of(&o, "system", "sys"),
                    &text_of(&o, "user", "hello"),
                    Some(&signal),
                )
                .await
            })
            .and_then(|r| {
                r.map(|answer| Some(json_value_to_serde(&answer.to_json())))
                    .map_err(thrown)
            })
        }
        "registry.resolveEndpoint" => {
            let config = arg(args, 1).map_or(JsonValue::Null, json_value_from_serde);
            resolve_endpoint(&s(args, 0), &config)
                .map(|e| Some(json_value_to_serde(&e.to_json())))
                .map_err(thrown)
        }
        "registry.modelHasFixedSampling" => {
            Ok(Some(Value::Bool(model_has_fixed_sampling(&s(args, 0)))))
        }
        "registry.modelEchoesReasoning" => {
            Ok(Some(Value::Bool(model_echoes_reasoning(&s(args, 0)))))
        }
        "registry.modelUsesResponsesApi" => {
            Ok(Some(Value::Bool(model_uses_responses_api(&s(args, 0)))))
        }
        _ => return None,
    })
}
