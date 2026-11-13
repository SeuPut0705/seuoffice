//! `packages/ai-provider/src/stream.ts`: a streaming, tool-calling turn
//! routed by provider id. The protocols' module states are [`Providers`],
//! which the caller owns (one per app) and hands to every turn.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::JsonValue;

use super::chatgpt_responses::{ChatGptBridgeDeps, stream_chatgpt};
use super::claude_code_cli::{ClaudeCodeCliDeps, stream_claude_code_cli};
use super::codex_app_server::{CodexApp, stream_codex_app_server};
use super::fetch::AiFetch;
use super::jsval::{Obj, prop, spread, text, value_key};
use super::key_effort::key_effort_body;
use super::output_cap::{OutputCaps, with_output_cap_fallback};
use super::protocols_anthropic::stream_anthropic;
use super::protocols_gateway_complete::{GatewayState, stream_gateway_complete};
use super::protocols_gemini::{GeminiRequestOptions, stream_gemini};
use super::protocols_openai_compatible::{
    OpenAiCompatibleState, OpenAiRequestOptions, stream_open_ai_compatible,
};
use super::protocols_openai_responses::{OpenAiResponsesOptions, stream_open_ai_responses};
use super::protocols_shared::StreamCallbacks;
use super::registry::{ResolvedEndpoint, resolve_endpoint};
use super::task::{JsError, Rt};

/// What the routed protocols keep between turns: the module variables of
/// fetch.ts, openai-compatible.ts, gateway-complete.ts and output-cap.ts, the
/// Codex pool, and the seams of the two subscription bridges.
#[derive(Clone)]
pub struct Providers {
    pub fx: AiFetch,
    pub openai: Rc<RefCell<OpenAiCompatibleState>>,
    pub gateway: Rc<RefCell<GatewayState>>,
    pub caps: Rc<RefCell<OutputCaps>>,
    pub codex: CodexApp,
    pub claude: ClaudeCodeCliDeps,
    pub chatgpt: ChatGptBridgeDeps,
}

/// `StreamForProviderOptions`: a first-response limit for this request, in
/// milliseconds (`None`: not given).
#[derive(Debug, Clone, Copy, Default)]
pub struct StreamForProviderOptions {
    pub timeout_ms: Option<f64>,
}

/// `{ ...config, model: endpoint.model }` when the endpoint names a wire id;
/// the config as it is otherwise.
pub(crate) fn with_wire_model(config: &JsonValue, endpoint: &ResolvedEndpoint) -> JsonValue {
    match endpoint.model.as_deref().filter(|m| !m.is_empty()) {
        Some(model) => {
            let mut next = spread(Some(config));
            next.set("model", text(model));
            JsonValue::Object(next)
        }
        None => config.clone(),
    }
}

/// `effortBody ? { ...endpoint.bodyExtras, ...effortBody } : endpoint.bodyExtras`
pub(crate) fn merged_extras(
    endpoint: &ResolvedEndpoint,
    effort: &Option<JsonValue>,
) -> Option<Obj> {
    match effort.as_ref().filter(|e| e.truthy()) {
        Some(effort) => {
            let mut out = spread(endpoint.body_extras.clone().map(JsonValue::Object).as_ref());
            out.assign(&spread(Some(effort)));
            Some(out)
        }
        None => endpoint.body_extras.clone(),
    }
}

/// `effortBody` as the extras the Anthropic route takes
pub(crate) fn effort_object(effort: &Option<JsonValue>) -> Option<Obj> {
    match effort {
        Some(JsonValue::Object(o)) => Some(o.clone()),
        _ => None,
    }
}

/// `streamForProvider(provider, config, system, messages, tools, maxTokens, cb, options)`
#[allow(clippy::too_many_arguments)]
pub async fn stream_for_provider(
    rt: &Rt,
    providers: &Providers,
    provider: &str,
    config: &JsonValue,
    system: &str,
    messages: &[JsonValue],
    tools: &[JsonValue],
    max_tokens: f64,
    cb: &StreamCallbacks,
    options: &StreamForProviderOptions,
) -> Result<(), JsError> {
    let endpoint = resolve_endpoint(provider, config)?;
    let base_url = endpoint.base_url.clone();
    // read before the wire id replaces the model: the table is by the listed id
    let effort_body = key_effort_body(provider, config, endpoint.protocol)?;
    let config = with_wire_model(config, &endpoint);
    let config = &config;
    if endpoint.protocol == "codex-app-server" {
        return stream_codex_app_server(
            rt,
            &providers.codex,
            config,
            system,
            messages,
            tools,
            max_tokens,
            cb,
        )
        .await;
    }
    if endpoint.protocol == "claude-code-cli" {
        return stream_claude_code_cli(
            rt,
            config,
            system,
            messages,
            tools,
            max_tokens,
            cb,
            &providers.claude,
        )
        .await;
    }
    if endpoint.protocol == "chatgpt-responses" {
        return stream_chatgpt(
            rt,
            config,
            system,
            messages,
            tools,
            max_tokens,
            cb,
            &providers.chatgpt,
        )
        .await;
    }
    let messages = &JsonValue::Array(messages.to_vec());
    let tools = &JsonValue::Array(tools.to_vec());
    let model = value_key(prop(config, "model"));
    let base_url = base_url.as_str();
    let endpoint = &endpoint;
    let effort_body = &effort_body;
    with_output_cap_fallback(
        rt,
        &providers.caps,
        base_url,
        &model,
        max_tokens,
        move |cap| async move {
            match endpoint.protocol {
                "anthropic" => {
                    stream_anthropic(
                        rt,
                        &providers.fx,
                        config,
                        system,
                        messages,
                        tools,
                        cap,
                        cb,
                        Some(base_url),
                        effort_object(effort_body).as_ref(),
                    )
                    .await
                }
                "gemini" => {
                    stream_gemini(
                        rt,
                        &providers.fx,
                        config,
                        system,
                        messages,
                        tools,
                        cap,
                        cb,
                        Some(base_url),
                        &GeminiRequestOptions {
                            omit_temperature: endpoint.omit_temperature,
                        },
                    )
                    .await
                }
                "openai-compatible" => {
                    stream_open_ai_compatible(
                        rt,
                        &providers.fx,
                        &providers.openai,
                        base_url,
                        config,
                        system,
                        messages,
                        tools,
                        cap,
                        cb,
                        &OpenAiRequestOptions {
                            omit_temperature: endpoint.omit_temperature == Some(true),
                            use_max_completion_tokens: endpoint.use_max_completion_tokens
                                == Some(true),
                            body_extras: merged_extras(endpoint, effort_body),
                            timeout_ms: options.timeout_ms,
                            ..OpenAiRequestOptions::default()
                        },
                    )
                    .await
                }
                "openai-responses" => {
                    stream_open_ai_responses(
                        rt,
                        &providers.fx,
                        base_url,
                        config,
                        system,
                        messages,
                        tools,
                        cap,
                        cb,
                        &OpenAiResponsesOptions {
                            body_extras: endpoint.body_extras.clone(),
                            ..OpenAiResponsesOptions::default()
                        },
                    )
                    .await
                }
                // gateway-complete: the registry names no other protocol
                _ => {
                    stream_gateway_complete(
                        rt,
                        &providers.fx,
                        &providers.gateway,
                        &providers.openai,
                        base_url,
                        config,
                        system,
                        messages,
                        tools,
                        cap,
                        cb,
                        options.timeout_ms,
                    )
                    .await
                }
            }
        },
    )
    .await
}
