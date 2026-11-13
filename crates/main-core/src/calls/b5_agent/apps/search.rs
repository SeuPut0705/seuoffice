//! The `packages/ai-search/src` pieces of the `b5-agent-apps` part (see the
//! spec `tools/main-diff/groups/b5-agent-apps-search.ts`). The environment a
//! case sets is the object `env` (every other variable is unset); the state
//! of the routing is `state: { available, generator }`; the search backends
//! answer from `answers` and log `[kind, query, max, options]`.

use std::collections::{HashMap, HashSet};

use jscompat::{JsonValue, json_value_from_serde};
use serde_json::Value;

use super::{
    Answer, CallError, Context, arg, jv, jv_exact, out, out_bool, out_opt, out_str, text_arg,
};
use crate::packages::ai_provider::jsval::{number, object, text};
use crate::packages::ai_search::index::{
    MIN_USABLE_IMAGE_PX, filter_usable_images, search_env_key,
};
use crate::packages::ai_search::media_call_abort::{MediaCallId, MediaCalls};
use crate::packages::ai_search::media_tools::{
    MEDIA_BUDGET, RealPath, document_media_roots, is_local_media_path_allowed, local_media_roots,
    read_ai_settings_file,
};
use crate::packages::ai_search::search_tools::{
    SearchBackend, SearchOptions, image_search_tool, keyless_search_backend,
    search_options_from_settings, selected_search_key, test_search_provider, web_search_tool,
};
use crate::packages::ai_search::tool_capabilities::ai_tool_capabilities;
use crate::packages::ai_search::tool_routing::{
    AiToolCallContext, AiToolCallPath, ToolRoutingState, codex_image_route_offered,
    headless_subscription_blocked, image_generation_unavailable_message,
    resolve_image_analysis_route, resolve_image_route, resolve_video_analysis_route,
};

/// the environment of a case: `process.env[name]`
fn env_of(spec: Option<&Value>) -> HashMap<String, String> {
    spec.and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

/// `state: { available, generator }`
fn routing_state(spec: Option<&Value>) -> ToolRoutingState {
    let mut state = ToolRoutingState::default();
    let flag = |key: &str| {
        spec.and_then(|s| s.get(key))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    state
        .image_backend
        .set_codex_image_generation_available(flag("available"));
    state.codex_generator_registered = flag("generator");
    state
}

/// `{ path, statuses?, dataDir? }`; `null` is the default context of the
/// TypeScript (the screen path with no status)
fn context_of(spec: Option<&Value>) -> AiToolCallContext {
    let Some(spec) = spec.filter(|s| !s.is_null()) else {
        return AiToolCallContext::screen();
    };
    AiToolCallContext {
        path: if spec.get("path").and_then(Value::as_str) == Some("headless") {
            AiToolCallPath::Headless
        } else {
            AiToolCallPath::Screen
        },
        statuses: spec.get("statuses").map(json_value_from_serde),
        data_dir: spec
            .get("dataDir")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

/// `realpathSync` of the file system of the case
struct DiskPaths;

impl RealPath for DiskPaths {
    fn realpath(&mut self, path: &str) -> Option<String> {
        std::fs::canonicalize(path)
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    }
}

/// the fake search backends: `answers` one per call, `{ ok }` or `{ throw }`
pub(super) struct FakeSearch {
    answers: std::collections::VecDeque<Value>,
    pub(super) log: Vec<Vec<Value>>,
}

impl FakeSearch {
    pub(super) fn of(answers: Option<&Value>) -> FakeSearch {
        FakeSearch {
            answers: answers
                .and_then(Value::as_array)
                .map(|list| list.iter().cloned().collect())
                .unwrap_or_default(),
            log: Vec::new(),
        }
    }

    fn call(
        &mut self,
        kind: &str,
        query: &str,
        max_results: f64,
        options: &SearchOptions,
    ) -> Result<JsonValue, String> {
        self.log.push(vec![
            Value::from(kind),
            Value::from(query),
            serde_json::Number::from_f64(max_results).map_or(Value::Null, Value::Number),
            jscompat::json_value_to_serde(&options.to_json()),
        ]);
        let answer = self
            .answers
            .pop_front()
            .unwrap_or_else(|| serde_json::json!({ "ok": { "results": [], "method": "none" } }));
        if let Some(message) = answer.get("throw").and_then(Value::as_str) {
            return Err(message.to_owned());
        }
        Ok(answer
            .get("ok")
            .map_or(JsonValue::Null, json_value_from_serde))
    }
}

impl SearchBackend for FakeSearch {
    fn web_search(
        &mut self,
        query: &str,
        max_results: f64,
        options: &SearchOptions,
    ) -> Result<JsonValue, String> {
        self.call("web", query, max_results, options)
    }

    fn image_search(
        &mut self,
        query: &str,
        max_results: f64,
        options: &SearchOptions,
    ) -> Result<JsonValue, String> {
        self.call("image", query, max_results, options)
    }
}

/// `readFileSync(path)` of the case, or `None`
fn read_file(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

fn media_abort_scenario(args: &[Value]) -> Answer {
    let steps = arg(args, 0)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut calls = MediaCalls::new();
    // per name: (sender, id, whether the window's `destroyed` listener is registered)
    let mut live: Vec<(String, f64, MediaCallId, bool)> = Vec::new();
    // what the signal of a call that settled said
    let mut ended: Vec<(String, bool)> = Vec::new();
    let mut destroyed_senders: HashSet<i64> = HashSet::new();
    let mut names: Vec<String> = Vec::new();
    let mut answers = Vec::new();
    for step in &steps {
        let num = |key: &str| step.get(key).and_then(Value::as_f64);
        if let Some(name) = step.get("begin").and_then(Value::as_str) {
            let sender = num("sender").unwrap_or(1.0);
            if step
                .get("destroyed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                destroyed_senders.insert(sender as i64);
            }
            let already = destroyed_senders.contains(&(sender as i64));
            let id = calls.begin(sender, already);
            live.push((name.to_owned(), sender, id, !already));
            if !names.iter().any(|n| n == name) {
                names.push(name.to_owned());
            }
        } else if let Some(sender) = num("destroy") {
            destroyed_senders.insert(sender as i64);
            for (_, s, id, listening) in &live {
                if *s == sender && *listening {
                    calls.destroyed(*id);
                }
            }
        } else if let Some(sender) = num("abort") {
            calls.abort_media_calls(sender);
        } else if let Some(name) = step.get("end").and_then(Value::as_str)
            && let Some(at) = live.iter().position(|(n, ..)| n == name)
        {
            let (n, sender, id, _) = live.remove(at);
            ended.push((n, calls.aborted(id)));
            calls.end(sender, id);
        }
        let mut snapshot = serde_json::Map::new();
        for name in &names {
            let aborted = match live.iter().find(|(n, ..)| n == name) {
                Some((_, _, id, _)) => calls.aborted(*id),
                None => ended
                    .iter()
                    .rev()
                    .find(|(n, _)| n == name)
                    .is_some_and(|(_, a)| *a),
            };
            snapshot.insert(name.clone(), Value::Bool(aborted));
        }
        answers.push(Value::Object(snapshot));
    }
    Ok(Some(Value::Array(answers)))
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let answer = match name {
        // ai-search/index
        "ai-search/index.MIN_USABLE_IMAGE_PX" => out(number(MIN_USABLE_IMAGE_PX)),
        "ai-search/index.searchEnvKey" => {
            let env = env_of(arg(args, 1));
            search_env_key(text_arg(args, 0), &|name| env.get(name).cloned())
                .map(|key| Some(Value::String(key)))
                .map_err(CallError::plain)
        }
        "ai-search/index.filterUsableImages" => {
            let images = match jv(args, 0) {
                Some(JsonValue::Array(items)) => items,
                _ => Vec::new(),
            };
            out(JsonValue::Array(filter_usable_images(&images)))
        }

        // ai-search/media-call-abort
        "ai-search/media-call-abort.withMediaCallSignal"
        | "ai-search/media-call-abort.abortMediaCalls" => media_abort_scenario(args),

        // ai-search/media-tools
        "ai-search/media-tools.MEDIA_BUDGET" => out(object(vec![
            ("maxItems", number(MEDIA_BUDGET.max_items)),
            ("maxItemBytes", number(MEDIA_BUDGET.max_item_bytes)),
            ("maxTotalBytes", number(MEDIA_BUDGET.max_total_bytes)),
            ("concurrency", number(MEDIA_BUDGET.concurrency)),
        ])),
        "ai-search/media-tools.readAiSettingsFile" => out(read_ai_settings_file(
            read_file(text_arg(args, 0)).as_deref(),
        )),
        "ai-search/media-tools.localMediaRoots" => {
            let roots: Vec<Option<&str>> = args.iter().map(Value::as_str).collect();
            out(JsonValue::Array(
                local_media_roots(&roots).into_iter().map(text).collect(),
            ))
        }
        "ai-search/media-tools.documentMediaRoots" => {
            let roots = document_media_roots(
                arg(args, 0).and_then(Value::as_str),
                arg(args, 1).and_then(Value::as_str),
            );
            out(JsonValue::Array(roots.into_iter().map(text).collect()))
        }
        "ai-search/media-tools.isLocalMediaPathAllowed" => {
            let roots: Vec<String> = arg(args, 1)
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            out_bool(is_local_media_path_allowed(
                &mut DiskPaths,
                text_arg(args, 0),
                &roots,
                std::path::MAIN_SEPARATOR_STR,
            ))
        }

        // ai-search/search-tools
        "ai-search/search-tools.keylessSearchBackend" => {
            out_str(keyless_search_backend(&jv_exact(args, 0)))
        }
        "ai-search/search-tools.selectedSearchKey" => {
            let env = env_of(arg(args, 1));
            let selected = selected_search_key(&jv_exact(args, 0), &|name| env.get(name).cloned());
            out_opt(selected.map(|(provider, key)| {
                object(vec![("provider", text(provider)), ("key", text(key))])
            }))
        }
        "ai-search/search-tools.searchOptionsFromSettings" => {
            let env = env_of(arg(args, 1));
            out(
                search_options_from_settings(&jv_exact(args, 0), &|name| env.get(name).cloned())
                    .to_json(),
            )
        }
        "ai-search/search-tools.webSearchTool" | "ai-search/search-tools.imageSearchTool" => {
            let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
            let mut backend = FakeSearch::of(spec.get("answers"));
            let env = env_of(spec.get("env"));
            let file = read_file(text_arg(args, 1));
            let max = spec.get("max").and_then(Value::as_f64);
            let query = spec.get("query").and_then(Value::as_str).unwrap_or("");
            let lookup = |name: &str| env.get(name).cloned();
            let result = if name.ends_with("webSearchTool") {
                web_search_tool(&mut backend, file.as_deref(), query, max, &lookup)
            } else {
                image_search_tool(&mut backend, file.as_deref(), query, max, &lookup)
            };
            cx.logs.extend(backend.log);
            result
                .map(|v| Some(jscompat::json_value_to_serde(&v)))
                .map_err(CallError::plain)
        }
        "ai-search/search-tools.testSearchProvider" => {
            let mut backend = FakeSearch::of(arg(args, 2));
            let result = test_search_provider(&mut backend, text_arg(args, 0), text_arg(args, 1));
            cx.logs.extend(backend.log);
            result
                .map(|v| Some(jscompat::json_value_to_serde(&v)))
                .map_err(CallError::plain)
        }

        // ai-search/tool-routing
        "ai-search/tool-routing.headlessSubscriptionBlocked" => out_bool(
            headless_subscription_blocked(&jv_exact(args, 0), &context_of(arg(args, 1))),
        ),
        "ai-search/tool-routing.codexImageRouteOffered" => {
            out_bool(codex_image_route_offered(&routing_state(arg(args, 0))))
        }
        "ai-search/tool-routing.resolveImageRoute" => out(resolve_image_route(
            &routing_state(arg(args, 2)),
            &jv_exact(args, 0),
            &context_of(arg(args, 1)),
        )
        .to_json()),
        "ai-search/tool-routing.imageGenerationUnavailableMessage" => {
            out_str(image_generation_unavailable_message(
                &routing_state(arg(args, 2)),
                &jv_exact(args, 0),
                &context_of(arg(args, 1)),
            ))
        }
        "ai-search/tool-routing.resolveImageAnalysisRoute" => {
            resolve_image_analysis_route(&jv_exact(args, 0), &context_of(arg(args, 1)))
                .map(|route| Some(jscompat::json_value_to_serde(&route.to_json())))
                .map_err(CallError::plain)
        }
        "ai-search/tool-routing.resolveVideoAnalysisRoute" => {
            out(resolve_video_analysis_route(&jv_exact(args, 0)).to_json())
        }

        // ai-search/tool-capabilities
        "ai-search/tool-capabilities.aiToolCapabilities" => {
            let env = env_of(arg(args, 3));
            ai_tool_capabilities(
                &routing_state(arg(args, 2)),
                jv(args, 0).as_ref(),
                &context_of(arg(args, 1)),
                &|name| env.get(name).cloned(),
            )
            .map(|v| Some(jscompat::json_value_to_serde(&v)))
            .map_err(CallError::plain)
        }
        _ => return None,
    };
    Some(answer)
}
