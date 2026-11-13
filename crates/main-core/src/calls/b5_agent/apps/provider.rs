//! The `packages/ai-provider/src` pieces of the `b5-agent-apps` part (see the
//! spec `tools/main-diff/groups/b5-agent-apps-provider.ts`). A free-connect
//! `fetch` is a list of answers, one per call, the last repeating; each call
//! logs `["fetch", url, init]`.

use std::collections::VecDeque;

use jscompat::{JsonValue, json_value_from_serde};
use serde_json::{Map, Value};

use super::{
    Answer, CallError, Context, arg, bool_arg, f64_arg, hex_bytes, jv, jv_exact, out, out_bool,
    out_list, out_opt, out_str, text_arg,
};
use crate::packages::ai_provider::free_ai_browser::{
    FREE_AI_CANCEL_CHANNEL, FREE_AI_CONNECT_CHANNEL, FREE_AI_DISCONNECT_CHANNEL,
    FREE_AI_OPEN_KEY_PAGE_CHANNEL, FREE_AI_PROVIDERS, FREE_AI_QUOTA_CHANNEL, GEMINI_FREE_MODEL,
    OPENROUTER_FREE_MODELS, free_ai_connect_result_of, free_ai_connected, free_ai_key_page,
    free_ai_quota_of, is_free_ai_provider, is_open_router_free_model, key_provider_models,
    with_free_ai_connection, without_free_ai_connection,
};
use crate::packages::ai_provider::free_connect::{
    CallbackReply, CodeWait, FetchRequest, FetchResponse, FreeConnectFailure, FreeConnectNet,
    FreeConnectPage, FreeConnectResult, GEMINI_MODELS_URL, OPENROUTER_AUTH_URL,
    OPENROUTER_KEY_INFO_URL, OPENROUTER_KEYS_URL, OPENROUTER_MODELS_URL,
    OPENROUTER_SIGN_IN_TIMEOUT_MS, OpenRouterConnectOptions, OpenRouterHost, connect_gemini,
    connect_open_router, exchange_open_router_code, free_connect_page_html, open_router_auth_url,
    open_router_free_quota, pick_open_router_free_model, pkce_pair, plausible_api_key,
};
use crate::packages::ai_provider::image_backend::{
    ImageBackendState, configured_image_key_providers, image_provider_selection,
    resolve_image_backend,
};
use crate::packages::ai_provider::jsval::{object, prop, text};
use crate::packages::ai_provider::media::{AI_MEDIA_PROVIDERS, MediaCapability};
use crate::packages::ai_provider::media_active::{
    active_media_config, active_media_provider, media_config_usable,
};
use crate::packages::ai_provider::registry_vision::{model_lacks_vision, provider_vision};
use crate::packages::ai_provider::subscription_contract::off_subscription_status;
use crate::packages::file_parse::diagram::{
    DiagramPictures, detect_diagram_format, diagram_format_of, diagram_picture_ext_of,
    diagram_picture_ext_of_name,
};

/// `capability` of the spec
fn capability(name: &str) -> MediaCapability {
    match name {
        "image" => MediaCapability::Image,
        "video" => MediaCapability::Video,
        _ => MediaCapability::Analysis,
    }
}

/// the `free-connect` fetch of a case: the steps taken one per call (the
/// last repeats), and the signal of the case
pub(super) struct FakeNet {
    steps: VecDeque<Value>,
    last: Value,
    aborted: bool,
    pub log: Vec<Vec<Value>>,
}

impl FakeNet {
    /// `{ fetch: [...], aborted?: bool }`
    pub(super) fn of(spec: &Value) -> FakeNet {
        let steps = spec
            .get("fetch")
            .and_then(Value::as_array)
            .map(|list| list.iter().cloned().collect())
            .unwrap_or_default();
        FakeNet {
            steps,
            last: serde_json::json!({ "status": 200 }),
            aborted: spec
                .get("aborted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            log: Vec::new(),
        }
    }
}

impl FreeConnectNet for FakeNet {
    fn fetch(&mut self, request: &FetchRequest) -> Result<FetchResponse, String> {
        let mut shown = Map::new();
        if let Some(method) = request.method {
            shown.insert("method".into(), Value::from(method));
        }
        if !request.headers.is_empty() {
            let mut headers = Map::new();
            for (k, v) in &request.headers {
                headers.insert(k.clone(), Value::from(v.as_str()));
            }
            shown.insert("headers".into(), Value::Object(headers));
        }
        if let Some(body) = &request.body {
            shown.insert("body".into(), Value::from(body.as_str()));
        }
        if request.redirect_manual {
            shown.insert("redirect".into(), Value::from("manual"));
        }
        self.log.push(vec![
            Value::from("fetch"),
            Value::from(request.url.as_str()),
            Value::Object(shown),
        ]);
        let step = self.steps.pop_front().unwrap_or_else(|| self.last.clone());
        self.last = step.clone();
        if let Some(message) = step.get("throws").and_then(Value::as_str) {
            return Err(message.to_owned());
        }
        let json = if step
            .get("jsonThrows")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            Err("bad json".to_owned())
        } else {
            Ok(step
                .get("json")
                .map_or(JsonValue::Null, json_value_from_serde))
        };
        Ok(FetchResponse {
            status: step.get("status").and_then(Value::as_u64).unwrap_or(200) as u16,
            opaque_redirect: step.get("opaque").and_then(Value::as_bool).unwrap_or(false),
            location: step
                .get("location")
                .and_then(Value::as_str)
                .map(str::to_owned),
            json,
        })
    }

    fn signal_aborted(&self) -> bool {
        self.aborted
    }
}

fn reason_of(failure: FreeConnectFailure) -> JsonValue {
    object(vec![
        ("ok", JsonValue::Bool(false)),
        ("reason", text(failure.as_str())),
    ])
}

fn page_of(value: Option<&Value>) -> FreeConnectPage {
    let field = |key: &str| {
        value
            .and_then(|v| v.get(key))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    FreeConnectPage {
        lang: field("lang"),
        title: field("title"),
        body: field("body"),
    }
}

/// the host of `connectOpenRouter`: the fetch, the browser of the case that
/// asks the callback requests, and a server that answers on a port of its own
struct OrHost {
    net: FakeNet,
    random: [u8; 32],
    browser: String,
    requests: Vec<(String, String)>,
    after: String,
    timeout_ms: Option<f64>,
    cancelled: bool,
}

const PORT: f64 = 4242.0;

impl FreeConnectNet for OrHost {
    fn fetch(&mut self, request: &FetchRequest) -> Result<FetchResponse, String> {
        self.net.fetch(request)
    }

    fn signal_aborted(&self) -> bool {
        self.net.aborted || self.cancelled
    }
}

impl OpenRouterHost for OrHost {
    fn random_bytes(&mut self) -> [u8; 32] {
        self.random
    }

    fn listen(&mut self) -> Result<f64, String> {
        Ok(PORT)
    }

    fn open_browser(&mut self, url: &str) -> Result<bool, String> {
        self.net.log.push(vec![
            Value::from("openBrowser"),
            Value::from(url.replace("localhost%3A4242", "localhost%3APORT")),
        ]);
        match self.browser.as_str() {
            "throw" => Err("no browser".to_owned()),
            "refuse" => Ok(false),
            _ => Ok(true),
        }
    }

    fn start_timer(&mut self, timeout_ms: f64) {
        self.net.log.push(vec![
            Value::from("timer"),
            serde_json::Number::from_f64(timeout_ms).map_or(Value::Null, Value::Number),
        ]);
    }

    fn await_outcome(&mut self, wait: &mut CodeWait) {
        if self.after == "abort" {
            self.cancelled = true;
            wait.abort();
            return;
        }
        for (method, path) in std::mem::take(&mut self.requests) {
            let reply = wait.handle(&method, Some(&path)).expect("a path parses");
            let (status, content_type, csp, cache, body) = match reply {
                CallbackReply::NotFound => (
                    404,
                    Value::from("text/plain; charset=utf-8"),
                    Value::Null,
                    Value::Null,
                    String::new(),
                ),
                CallbackReply::Page { headers, html } => {
                    let header = |name: &str| {
                        headers
                            .iter()
                            .find(|(k, _)| k.eq_ignore_ascii_case(name))
                            .map_or(Value::Null, |(_, v)| Value::from(*v))
                    };
                    (
                        200,
                        header("content-type"),
                        header("content-security-policy"),
                        header("cache-control"),
                        html,
                    )
                }
            };
            self.net.log.push(vec![
                Value::from("response"),
                Value::from(status),
                content_type,
                csp,
                cache,
                Value::from(body),
            ]);
        }
        if self.after == "abort-late" {
            self.cancelled = true;
            wait.abort();
        }
        if self.after == "timeout" {
            wait.timeout();
        }
        // a wait nothing settles would hang: the case's TypeScript never does
        if wait.outcome().is_none() {
            self.net.log.push(vec![Value::from("hang")]);
        }
    }

    fn close_servers(&mut self) {}
}

fn connect_open_router_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("spec"))?;
    let random = hex_bytes(
        spec.get("random")
            .and_then(Value::as_str)
            .unwrap_or(&"00".repeat(32)),
    );
    let requests = spec
        .get("requests")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|r| {
                    (
                        r.get("method")
                            .and_then(Value::as_str)
                            .unwrap_or("GET")
                            .to_owned(),
                        r.get("path")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let mut host = OrHost {
        net: FakeNet::of(spec),
        random: random.try_into().unwrap_or([0; 32]),
        browser: spec
            .get("browser")
            .and_then(Value::as_str)
            .unwrap_or("ok")
            .to_owned(),
        requests,
        after: spec
            .get("after")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        timeout_ms: spec.get("timeoutMs").and_then(Value::as_f64),
        cancelled: false,
    };
    let options = OpenRouterConnectOptions {
        done: FreeConnectPage {
            lang: "en".to_owned(),
            title: "Done <1>".to_owned(),
            body: "Back to the app.".to_owned(),
        },
        failed: FreeConnectPage {
            lang: "ko".to_owned(),
            title: "Failed".to_owned(),
            body: "It's \"bad\" & sad".to_owned(),
        },
        timeout_ms: host.timeout_ms,
    };
    let result = connect_open_router(&mut host, &options);
    cx.logs.extend(host.net.log);
    out(result.to_json())
}

/// `{ ok: true, apiKey }` / `{ ok: false, reason }` of `exchangeOpenRouterCode`
fn exchange_json(result: Result<String, FreeConnectFailure>) -> JsonValue {
    match result {
        Ok(key) => object(vec![("ok", JsonValue::Bool(true)), ("apiKey", text(key))]),
        Err(reason) => reason_of(reason),
    }
}

/// the diagram reads of a case: the size of the file, and a first word that
/// stands for what the diagram engine answers (`NOORIG`: no diagram inside,
/// `THROW`: it throws)
struct DiskDiagram;

impl DiagramPictures for DiskDiagram {
    fn file_size(&mut self, file_path: &str) -> Result<f64, String> {
        std::fs::metadata(file_path)
            .map(|meta| meta.len() as f64)
            .map_err(|e| e.to_string())
    }

    fn lacks_original(&mut self, file_path: &str) -> Result<bool, String> {
        let bytes = std::fs::read(file_path).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&bytes);
        if text.starts_with("THROW") {
            return Err("unreadable".to_owned());
        }
        Ok(text.starts_with("NOORIG"))
    }
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let answer = match name {
        // drawio-model/format and file-parse
        "drawio-model/format.detectDiagramFormat" => {
            out_opt(detect_diagram_format(text_arg(args, 0)).map(text))
        }
        "file-parse/attachable.diagramPictureExtOfName" => {
            out_opt(diagram_picture_ext_of_name(text_arg(args, 0)).map(text))
        }
        "file-parse/diagram.diagramFormatOf" => {
            out_opt(diagram_format_of(text_arg(args, 0)).map(text))
        }
        "file-parse/diagram.diagramPictureExtOf" => {
            out_opt(diagram_picture_ext_of(&mut DiskDiagram, text_arg(args, 0)).map(text))
        }

        // ai-provider/subscription/contract
        "ai-provider/subscription/contract.offSubscriptionStatus" => {
            out(off_subscription_status(text_arg(args, 0)))
        }

        // ai-provider/media
        "ai-provider/media.mediaConfigUsable" => {
            let id = text_arg(args, 0);
            match AI_MEDIA_PROVIDERS.iter().find(|m| m.id == id) {
                Some(meta) => out_bool(media_config_usable(meta, jv(args, 1).as_ref())),
                None => Err(CallError::plain("meta is undefined")),
            }
        }
        "ai-provider/media.activeMediaProvider" => {
            let settings = jv_exact(args, 0);
            let found = active_media_provider(&settings, capability(text_arg(args, 1)));
            out_opt(found.map(text))
        }
        "ai-provider/media.activeMediaConfig" => {
            let settings = jv_exact(args, 0);
            let found = active_media_config(&settings, capability(text_arg(args, 1)));
            out_opt(found.map(|(provider, config)| {
                object(vec![("provider", text(provider)), ("config", config)])
            }))
        }

        // ai-provider/image-backend
        "ai-provider/image-backend.configuredImageKeyProviders" => {
            out_list(&configured_image_key_providers(jv(args, 0).as_ref()))
        }
        "ai-provider/image-backend.imageProviderSelection" => {
            let available = arg(args, 1)
                .and_then(Value::as_bool)
                .unwrap_or_else(|| bool_arg(args, 2));
            out_str(image_provider_selection(jv(args, 0).as_ref(), available))
        }
        "ai-provider/image-backend.resolveImageBackend" => {
            let mut state = ImageBackendState::new();
            state.set_codex_image_generation_available(bool_arg(args, 2));
            let context = jv(args, 1);
            let codex = context.as_ref().and_then(|c| prop(c, "codex"));
            let offered = match context
                .as_ref()
                .and_then(|c| prop(c, "codexImageAvailable"))
            {
                Some(JsonValue::Bool(flag)) => Some(*flag),
                _ => None,
            };
            out(resolve_image_backend(&state, jv(args, 0).as_ref(), codex, offered).to_json())
        }
        "ai-provider/image-backend.setCodexImageGenerationAvailable"
        | "ai-provider/image-backend.codexImageGenerationAvailable" => {
            let mut state = ImageBackendState::new();
            let steps = arg(args, 0)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let answers = steps
                .iter()
                .map(|step| match step.as_bool() {
                    Some(flag) => {
                        state.set_codex_image_generation_available(flag);
                        Value::Null
                    }
                    None => Value::Bool(state.codex_image_generation_available()),
                })
                .collect();
            Ok(Some(Value::Array(answers)))
        }

        // ai-provider/registry
        "ai-provider/registry.modelLacksVision" => out_bool(model_lacks_vision(text_arg(args, 0))),
        "ai-provider/registry.getProviderAdapter" => provider_vision(text_arg(args, 0))
            .map(|vision| Some(Value::Bool(vision)))
            .map_err(CallError::plain),

        // ai-provider/free-ai
        "ai-provider/free-ai.FREE_AI_PROVIDERS" => out_list(&FREE_AI_PROVIDERS),
        "ai-provider/free-ai.OPENROUTER_FREE_MODELS" => out_list(&OPENROUTER_FREE_MODELS),
        "ai-provider/free-ai.GEMINI_FREE_MODEL" => out_str(GEMINI_FREE_MODEL),
        "ai-provider/free-ai.FREE_AI_KEY_PAGES" => out(object(
            FREE_AI_PROVIDERS
                .iter()
                .map(|p| (*p, text(free_ai_key_page(p).unwrap_or(""))))
                .collect(),
        )),
        "ai-provider/free-ai.FREE_AI_IPC_CHANNELS" => out(object(vec![
            ("connect", text(FREE_AI_CONNECT_CHANNEL)),
            ("cancel", text(FREE_AI_CANCEL_CHANNEL)),
            ("disconnect", text(FREE_AI_DISCONNECT_CHANNEL)),
            ("quota", text(FREE_AI_QUOTA_CHANNEL)),
            ("openKeyPage", text(FREE_AI_OPEN_KEY_PAGE_CHANNEL)),
        ])),
        "ai-provider/free-ai.isFreeAiProvider" => {
            out_bool(is_free_ai_provider(jv(args, 0).as_ref()))
        }
        "ai-provider/free-ai.isOpenRouterFreeModel" => {
            out_bool(is_open_router_free_model(jv(args, 0).as_ref()))
        }
        "ai-provider/free-ai.freeAiConnected" => {
            out_bool(free_ai_connected(&jv_exact(args, 0), text_arg(args, 1)))
        }
        "ai-provider/free-ai.keyProviderModels" => {
            let models =
                key_provider_models(text_arg(args, 0), text_arg(args, 1), jv(args, 2).as_ref());
            out(JsonValue::Array(models.into_iter().map(text).collect()))
        }
        "ai-provider/free-ai.withFreeAiConnection" => {
            let connection = jv_exact(args, 2);
            let field = |key: &str| match prop(&connection, key) {
                Some(JsonValue::String(s)) => s.clone(),
                _ => String::new(),
            };
            out(with_free_ai_connection(
                &jv_exact(args, 0),
                text_arg(args, 1),
                &field("apiKey"),
                &field("model"),
            ))
        }
        "ai-provider/free-ai.withoutFreeAiConnection" => out(without_free_ai_connection(
            &jv_exact(args, 0),
            text_arg(args, 1),
        )),
        "ai-provider/free-ai.freeAiConnectResultOf" => {
            out(free_ai_connect_result_of(jv(args, 0).as_ref()))
        }
        "ai-provider/free-ai.freeAiQuotaOf" => out_opt(free_ai_quota_of(jv(args, 0).as_ref())),

        // ai-provider/free-connect
        "ai-provider/free-connect.OPENROUTER_AUTH_URL" => out_str(OPENROUTER_AUTH_URL),
        "ai-provider/free-connect.OPENROUTER_KEYS_URL" => out_str(OPENROUTER_KEYS_URL),
        "ai-provider/free-connect.OPENROUTER_MODELS_URL" => out_str(OPENROUTER_MODELS_URL),
        "ai-provider/free-connect.OPENROUTER_KEY_INFO_URL" => out_str(OPENROUTER_KEY_INFO_URL),
        "ai-provider/free-connect.GEMINI_MODELS_URL" => out_str(GEMINI_MODELS_URL),
        "ai-provider/free-connect.OPENROUTER_SIGN_IN_TIMEOUT_MS" => {
            Ok(Some(Value::from(OPENROUTER_SIGN_IN_TIMEOUT_MS)))
        }
        "ai-provider/free-connect.pkcePair" => {
            let bytes: [u8; 32] = hex_bytes(text_arg(args, 0)).try_into().unwrap_or([0; 32]);
            let (verifier, challenge) = pkce_pair(&bytes);
            out(object(vec![
                ("verifier", text(verifier)),
                ("challenge", text(challenge)),
            ]))
        }
        "ai-provider/free-connect.openRouterAuthUrl" => {
            out_str(open_router_auth_url(f64_arg(args, 0), text_arg(args, 1)))
        }
        "ai-provider/free-connect.freeConnectPageHtml" => {
            out_str(free_connect_page_html(&page_of(arg(args, 0))))
        }
        "ai-provider/free-connect.plausibleApiKey" => {
            out_opt(plausible_api_key(jv(args, 0).as_ref()).map(text))
        }
        "ai-provider/free-connect.exchangeOpenRouterCode" => {
            let mut net = FakeNet::of(arg(args, 2).unwrap_or(&Value::Null));
            let result = exchange_open_router_code(&mut net, text_arg(args, 0), text_arg(args, 1));
            cx.logs.extend(net.log);
            out(exchange_json(result))
        }
        "ai-provider/free-connect.pickOpenRouterFreeModel" => {
            let mut net = FakeNet::of(arg(args, 0).unwrap_or(&Value::Null));
            let model = pick_open_router_free_model(&mut net);
            cx.logs.extend(net.log);
            out_str(model)
        }
        "ai-provider/free-connect.connectOpenRouter" => connect_open_router_call(args, cx),
        "ai-provider/free-connect.connectGemini" => {
            let mut net = FakeNet::of(arg(args, 1).unwrap_or(&Value::Null));
            let result: FreeConnectResult = connect_gemini(&mut net, jv(args, 0).as_ref());
            cx.logs.extend(net.log);
            out(result.to_json())
        }
        "ai-provider/free-connect.openRouterFreeQuota" => {
            let mut net = FakeNet::of(arg(args, 1).unwrap_or(&Value::Null));
            let quota = open_router_free_quota(&mut net, text_arg(args, 0));
            cx.logs.extend(net.log);
            out_opt(quota)
        }
        _ => return None,
    };
    Some(answer)
}
