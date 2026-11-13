//! `packages/ai-provider/src/chat.ts`: a one-shot (non-streaming,
//! non-tool-calling) chat call routed by provider id.

use jscompat::JsonValue;

use super::chatgpt_responses::chat_chatgpt;
use super::claude_code_cli::chat_claude_code_cli;
use super::codex_app_server::chat_codex_app_server;
use super::key_effort::key_effort_body;
use super::protocols_anthropic::chat_anthropic;
use super::protocols_gateway_complete::chat_gateway_complete;
use super::protocols_gemini::{GeminiRequestOptions, chat_gemini};
use super::protocols_openai_compatible::{OpenAiRequestOptions, chat_open_ai_compatible};
use super::protocols_openai_responses::{OpenAiResponsesOptions, chat_open_ai_responses};
use super::registry::resolve_endpoint;
use super::stream::{Providers, effort_object, merged_extras, with_wire_model};
use super::task::{JsError, Rt, Signal};
use super::types::AiChatResponse;
use super::watchdog::{AI_CHAT_RESPONSE_TIMEOUT_MS, create_stream_watchdog};

/// `chatForProvider(provider, config, system, user, signal)`
pub async fn chat_for_provider(
    rt: &Rt,
    providers: &Providers,
    provider: &str,
    config: &JsonValue,
    system: &str,
    user: &str,
    signal: Option<&Signal>,
) -> Result<AiChatResponse, JsError> {
    // non-streaming: the server generates the full answer before the headers arrive,
    // so the connect phase gets the long budget; the body read then gets the idle budget
    let wd = create_stream_watchdog(rt, signal, Some(AI_CHAT_RESPONSE_TIMEOUT_MS), None);
    let result = wd
        .guard(async {
            let endpoint = match resolve_endpoint(provider, config) {
                Ok(endpoint) => endpoint,
                // config errors (unknown provider, missing base URL) report as a failed reply, not a rejection
                Err(e) => return Ok(AiChatResponse::failed(e.message_or_string())),
            };
            // read before the wire id replaces the model: the table is by the listed id
            let effort_body = key_effort_body(provider, config, endpoint.protocol)?;
            let config = &with_wire_model(config, &endpoint);
            match endpoint.protocol {
                "codex-app-server" => {
                    chat_codex_app_server(rt, &providers.codex, config, system, user, &wd.signal)
                        .await
                }
                "claude-code-cli" => {
                    chat_claude_code_cli(rt, &wd, config, system, user, &providers.claude).await
                }
                "chatgpt-responses" => {
                    chat_chatgpt(rt, config, system, user, &wd.signal, &providers.chatgpt).await
                }
                "anthropic" => {
                    chat_anthropic(
                        rt,
                        &providers.fx,
                        &wd,
                        config,
                        system,
                        user,
                        Some(endpoint.base_url.as_str()),
                        effort_object(&effort_body).as_ref(),
                    )
                    .await
                }
                "gemini" => {
                    chat_gemini(
                        rt,
                        &providers.fx,
                        &wd,
                        config,
                        system,
                        user,
                        Some(endpoint.base_url.as_str()),
                        &GeminiRequestOptions {
                            omit_temperature: endpoint.omit_temperature,
                        },
                    )
                    .await
                }
                "openai-compatible" => {
                    chat_open_ai_compatible(
                        rt,
                        &providers.fx,
                        &providers.openai,
                        &wd,
                        &endpoint.base_url,
                        config,
                        system,
                        user,
                        &OpenAiRequestOptions {
                            omit_temperature: endpoint.omit_temperature == Some(true),
                            body_extras: merged_extras(&endpoint, &effort_body),
                            ..OpenAiRequestOptions::default()
                        },
                    )
                    .await
                }
                "openai-responses" => {
                    chat_open_ai_responses(
                        rt,
                        &providers.fx,
                        &wd,
                        &endpoint.base_url,
                        config,
                        system,
                        user,
                        &OpenAiResponsesOptions {
                            body_extras: endpoint.body_extras.clone(),
                            ..OpenAiResponsesOptions::default()
                        },
                    )
                    .await
                }
                // gateway-complete: the registry names no other protocol
                _ => {
                    chat_gateway_complete(
                        rt,
                        &providers.fx,
                        &providers.gateway,
                        &providers.openai,
                        &wd,
                        &endpoint.base_url,
                        config,
                        system,
                        user,
                    )
                    .await
                }
            }
        })
        .await;
    match result {
        Err(e) if e.is("ResponseBodyTooLargeError") => Ok(AiChatResponse::failed(e.message)),
        other => other,
    }
}
