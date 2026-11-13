//! The editors' AI modules that register `ipcMain` handlers, as scenarios
//! (see the spec `tools/main-diff/groups/b5-agent-apps-modules.ts`): the
//! scenario plays the part of the caller that drives the Rust handler bodies
//! on the fakes the spec describes; each call of a fake is one `logs` line.

use std::collections::HashMap;

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Value};

use super::search::FakeSearch;
use super::{Answer, CallError, Context, arg};
use crate::docs::free_ai_ipc::{
    AttemptId, ConnectPlan, FreeAiIpc, FreeAiIpcHost, WindowCommand, WindowState, disconnect,
    open_in_browser, open_key_page, open_router_options, quota_key,
};
use crate::html::ai_search_ipc::{HtmlAiSearchHost, HtmlAiSearchIpc, image_search, web_search};
use crate::hwp::ai_image::{
    AnalyzeMediaRequest, AnalyzeMediaStep, HwpImageHost, begin_analyze_media, begin_generate_image,
    finish_analyze_media, finish_generate_image,
};
use crate::mindmap::ai_image::{
    MindmapImageHost, begin_generate_image as mindmap_begin_generate_image,
    finish_generate_image as mindmap_finish_generate_image,
};
use crate::packages::ai_provider::free_connect::{
    FreeConnectFailure, FreeConnectPage, FreeConnectResult,
};
use crate::packages::ai_search::media_call_abort::{MediaCallId, MediaCalls};
use crate::packages::ai_search::search_tools::{SearchAnswer, SearchBackend, SearchOptions};
use crate::packages::i18n::Lang;
use crate::shell::ai_naming_service::{
    AI_NAMING_SUGGEST_CHANNEL, ChatOutcome, NamingHost, suggest_file_name,
};

/// a value as a log argument
fn js(value: &JsonValue) -> Value {
    json_value_to_serde(value)
}

fn strings(items: &[&str]) -> Value {
    Value::Array(items.iter().map(|s| Value::from(*s)).collect())
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key)
}

fn steps_of(spec: &Value) -> Vec<Value> {
    spec.get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn text_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

// ---------------------------------------------------------------------------
// shell/ai-naming-service
// ---------------------------------------------------------------------------

struct NamingFake {
    user_data: String,
    lang: String,
    statuses: JsonValue,
    step: Value,
    timed: bool,
    log: Vec<Vec<Value>>,
}

impl NamingHost for NamingFake {
    fn settings_file(&mut self) -> Option<String> {
        let path = jscompat::node_path::host::join(&[&self.user_data, "ai-settings.json"]);
        std::fs::read_to_string(path).ok()
    }

    fn subscription_statuses(&mut self) -> JsonValue {
        self.log.push(vec![Value::from("statuses")]);
        self.statuses.clone()
    }

    fn ui_lang(&mut self) -> String {
        self.log.push(vec![Value::from("lang")]);
        self.lang.clone()
    }

    fn chat(&mut self, provider: &str, config: &JsonValue, instruction: &str) -> ChatOutcome {
        self.log.push(vec![
            Value::from("chat"),
            Value::from(provider),
            js(config),
            Value::from(""),
            Value::from(instruction),
        ]);
        if field(&self.step, "timer")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            self.timed = true;
        }
        let default = serde_json::json!({ "ok": true, "content": "" });
        let chat = field(&self.step, "chat").unwrap_or(&default);
        if let Some(thrown) = chat.get("throw") {
            return ChatOutcome::Threw(json_value_from_serde(thrown));
        }
        if chat.get("ok").and_then(Value::as_bool) == Some(false) {
            return ChatOutcome::Failed {
                error: chat
                    .get("error")
                    .map_or(JsonValue::Null, json_value_from_serde),
            };
        }
        ChatOutcome::Reply {
            content: chat
                .get("content")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }
    }

    fn timed_out(&self) -> bool {
        self.timed
    }

    fn warn(&mut self, detail: &JsonValue) {
        self.log.push(vec![
            Value::from("warn"),
            Value::from("[shell] file naming failed:"),
            js(detail),
        ]);
    }
}

fn naming_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("spec"))?;
    let mut host = NamingFake {
        user_data: text_of(spec, "userData"),
        lang: text_of(spec, "lang"),
        statuses: spec.get("statuses").map_or_else(
            || JsonValue::Object(jscompat::JsObject::new()),
            json_value_from_serde,
        ),
        step: Value::Null,
        timed: false,
        log: Vec::new(),
    };
    let mut results = Vec::new();
    for step in steps_of(spec) {
        host.timed = false;
        let input = step.get("input").map(json_value_from_serde);
        host.step = step;
        results.push(js(&suggest_file_name(&mut host, input.as_ref())));
    }
    cx.logs.extend(host.log);
    let mut answer = Map::new();
    answer.insert("channels".into(), strings(&[AI_NAMING_SUGGEST_CHANNEL]));
    answer.insert("results".into(), Value::Array(results));
    Ok(Some(Value::Object(answer)))
}

// ---------------------------------------------------------------------------
// docs/free-ai-ipc
// ---------------------------------------------------------------------------

struct FreeFake {
    settings: JsonValue,
    write_ok: bool,
    window: Option<WindowState>,
    open_throws: bool,
    log: Vec<Vec<Value>>,
}

impl FreeAiIpcHost for FreeFake {
    fn read_settings(&mut self) -> JsonValue {
        self.settings.clone()
    }

    fn write_settings(&mut self, settings: &JsonValue) -> bool {
        self.log.push(vec![Value::from("write"), js(settings)]);
        if !self.write_ok {
            return false;
        }
        self.settings = settings.clone();
        true
    }

    fn open_external(&mut self, url: &str) -> Result<(), String> {
        self.log
            .push(vec![Value::from("openExternal"), Value::from(url)]);
        if self.open_throws {
            Err("no browser".to_owned())
        } else {
            Ok(())
        }
    }

    fn window_state(&mut self) -> Option<WindowState> {
        self.log.push(vec![Value::from("windowFor")]);
        self.window
    }

    fn window_command(&mut self, command: WindowCommand) {
        let name = match command {
            WindowCommand::Restore => "restore",
            WindowCommand::Show => "show",
            WindowCommand::Focus => "focus",
        };
        self.log.push(vec![Value::from(name)]);
    }
}

/// `{ ok: true, apiKey, model }` or `{ ok: false, reason }` of a spec
fn connect_result(value: Option<&Value>) -> FreeConnectResult {
    let Some(value) = value else {
        return FreeConnectResult::Failed(FreeConnectFailure::Network);
    };
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        return FreeConnectResult::Ok {
            api_key: text_of(value, "apiKey"),
            model: text_of(value, "model"),
        };
    }
    FreeConnectResult::Failed(match value.get("reason").and_then(Value::as_str) {
        Some("cancelled") => FreeConnectFailure::Cancelled,
        Some("timeout") => FreeConnectFailure::Timeout,
        Some("denied") => FreeConnectFailure::Denied,
        Some("invalid") => FreeConnectFailure::Invalid,
        _ => FreeConnectFailure::Network,
    })
}

fn page_json(page: &FreeConnectPage) -> Value {
    let mut map = Map::new();
    map.insert("lang".into(), Value::from(page.lang.as_str()));
    map.insert("title".into(), Value::from(page.title.as_str()));
    map.insert("body".into(), Value::from(page.body.as_str()));
    Value::Object(map)
}

/// one browser sign-in of the scenario: its name, attempt and whether its
/// promise settled
struct Attempt {
    name: String,
    id: AttemptId,
    settled: bool,
}

fn free_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("spec"))?;
    let lang = if spec.get("lang").and_then(Value::as_str) == Some("ko") {
        Lang::Ko
    } else {
        Lang::En
    };
    let window = match spec.get("window") {
        Some(w) if !w.is_null() => Some(WindowState {
            destroyed: w.get("destroyed").and_then(Value::as_bool).unwrap_or(false),
            minimized: w.get("minimized").and_then(Value::as_bool).unwrap_or(false),
        }),
        _ => None,
    };
    let mut host = FreeFake {
        settings: spec
            .get("settings")
            .map_or(JsonValue::Null, json_value_from_serde),
        write_ok: spec.get("writeOk").and_then(Value::as_bool) != Some(false),
        window,
        open_throws: spec
            .get("openThrows")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        log: Vec::new(),
    };
    let mut ipc = FreeAiIpc::new();
    let mut attempts: Vec<Attempt> = Vec::new();
    let mut results: Vec<Value> = Vec::new();
    let mut direct: Vec<Value> = Vec::new();

    // the sign-in of `id` ends with `result`: its handler goes on
    fn settle(
        ipc: &mut FreeAiIpc,
        host: &mut FreeFake,
        attempts: &mut [Attempt],
        results: &mut Vec<Value>,
        id: AttemptId,
        result: &FreeConnectResult,
    ) {
        let Some(entry) = attempts.iter_mut().find(|a| a.id == id && !a.settled) else {
            return;
        };
        entry.settled = true;
        let answer = ipc.finish_open_router(host, id, result);
        results.push(Value::Array(vec![
            Value::from(entry.name.as_str()),
            js(&answer),
        ]));
    }

    let cancelled = FreeConnectResult::Failed(FreeConnectFailure::Cancelled);
    for step in steps_of(spec) {
        if let Some(name) = step.get("connect").and_then(Value::as_str) {
            let input = step
                .get("input")
                .filter(|v| !v.is_null())
                .map(json_value_from_serde);
            match ipc.plan_connect(input.as_ref()) {
                ConnectPlan::Invalid => {
                    let invalid = FreeConnectResult::Failed(FreeConnectFailure::Invalid);
                    results.push(Value::Array(vec![
                        Value::from(name),
                        js(&invalid.to_json()),
                    ]));
                }
                ConnectPlan::Gemini { api_key } => {
                    host.log.push(vec![
                        Value::from("connectGemini"),
                        api_key.as_ref().map_or(Value::Null, js),
                    ]);
                    if step
                        .get("geminiThrows")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        let mut error = Map::new();
                        error.insert("error".into(), Value::from("gemini failed"));
                        results.push(Value::Array(vec![Value::from(name), Value::Object(error)]));
                    } else {
                        let result = connect_result(step.get("gemini"));
                        let answer = FreeAiIpc::finish_gemini(&mut host, &result);
                        results.push(Value::Array(vec![Value::from(name), js(&answer)]));
                    }
                }
                ConnectPlan::OpenRouter { attempt, replaced } => {
                    let options = open_router_options(lang);
                    let mut pages = Map::new();
                    pages.insert("done".into(), page_json(&options.done));
                    pages.insert("failed".into(), page_json(&options.failed));
                    host.log
                        .push(vec![Value::from("connectOpenRouter"), Value::Object(pages)]);
                    attempts.push(Attempt {
                        name: name.to_owned(),
                        id: attempt,
                        settled: false,
                    });
                    let open = step.get("open").and_then(Value::as_str);
                    let opened = open.map(|url| open_in_browser(&mut host, url));
                    // the sign-in that was replaced goes on once this one yields
                    if let Some(old) = replaced
                        && ipc.attempt_aborted(old)
                    {
                        settle(
                            &mut ipc,
                            &mut host,
                            &mut attempts,
                            &mut results,
                            old,
                            &cancelled,
                        );
                    }
                    if let (Some(url), Some(opened)) = (open, opened) {
                        host.log.push(vec![
                            Value::from("opened"),
                            Value::from(url),
                            Value::Bool(opened),
                        ]);
                    }
                }
            }
        } else if let Some(name) = step.get("finish").and_then(Value::as_str) {
            let id = attempts.iter().find(|a| a.name == name).map(|a| a.id);
            if let Some(id) = id {
                let result = connect_result(step.get("result"));
                settle(
                    &mut ipc,
                    &mut host,
                    &mut attempts,
                    &mut results,
                    id,
                    &result,
                );
            }
        } else if step.get("cancel").and_then(Value::as_bool) == Some(true) {
            if let Some(id) = ipc.cancel()
                && ipc.attempt_aborted(id)
            {
                settle(
                    &mut ipc,
                    &mut host,
                    &mut attempts,
                    &mut results,
                    id,
                    &cancelled,
                );
            }
        } else if let Some(input) = step.get("disconnect") {
            let input = (!input.is_null()).then(|| json_value_from_serde(input));
            disconnect(&mut host, input.as_ref());
            direct.push(Value::Null);
        } else if let Some(input) = step.get("quota") {
            let input = (!input.is_null()).then(|| json_value_from_serde(input));
            let answer = match quota_key(&mut host, input.as_ref()) {
                Some(key) => {
                    host.log
                        .push(vec![Value::from("openRouterFreeQuota"), Value::from(key)]);
                    step.get("quotaAnswer").cloned().unwrap_or(Value::Null)
                }
                None => Value::Null,
            };
            direct.push(answer);
        } else if let Some(input) = step.get("openKeyPage") {
            let input = (!input.is_null()).then(|| json_value_from_serde(input));
            open_key_page(&mut host, input.as_ref());
            direct.push(Value::Null);
        }
    }
    cx.logs.extend(host.log.clone());
    let mut answer = Map::new();
    answer.insert(
        "channels".into(),
        strings(&[
            "ai:free-connect",
            "ai:free-connect-cancel",
            "ai:free-disconnect",
            "ai:free-quota",
            "ai:free-open-key-page",
        ]),
    );
    answer.insert("results".into(), Value::Array(results));
    answer.insert("direct".into(), Value::Array(direct));
    answer.insert("settings".into(), js(&host.settings));
    Ok(Some(Value::Object(answer)))
}

// ---------------------------------------------------------------------------
// html/ai-search-ipc
// ---------------------------------------------------------------------------

struct HtmlFake {
    user_data: String,
    search: FakeSearch,
}

impl SearchBackend for HtmlFake {
    fn web_search(
        &mut self,
        query: &str,
        max_results: f64,
        options: &SearchOptions,
    ) -> SearchAnswer {
        self.search.web_search(query, max_results, options)
    }

    fn image_search(
        &mut self,
        query: &str,
        max_results: f64,
        options: &SearchOptions,
    ) -> SearchAnswer {
        self.search.image_search(query, max_results, options)
    }
}

impl HtmlAiSearchHost for HtmlFake {
    fn settings_file(&mut self) -> Option<String> {
        let path = jscompat::node_path::host::join(&[&self.user_data, "ai-settings.json"]);
        std::fs::read_to_string(path).ok()
    }
}

fn html_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("spec"))?;
    let mut host = HtmlFake {
        user_data: text_of(spec, "userData"),
        search: FakeSearch::of(spec.get("answers")),
    };
    let env: HashMap<String, String> = spec
        .get("env")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    let lookup = |name: &str| env.get(name).cloned();
    let mut ipc = HtmlAiSearchIpc::new();
    let mut answers = Vec::new();
    for step in steps_of(spec) {
        if step.get("register").and_then(Value::as_bool) == Some(true) {
            answers.push(strings(&ipc.register()));
            continue;
        }
        let (call, is_web) = match step.get("web") {
            Some(call) => (call, true),
            None => (step.get("image").unwrap_or(&Value::Null), false),
        };
        let query = call.get("query").map(json_value_from_serde);
        let max = call.get("max").map(json_value_from_serde);
        let answer = if is_web {
            web_search(&mut host, &lookup, query.as_ref(), max.as_ref())
        } else {
            image_search(&mut host, &lookup, query.as_ref(), max.as_ref())
        };
        let answer = answer.map_err(|error| CallError::plain(error.to_string()))?;
        answers.push(js(&answer));
    }
    cx.logs.extend(host.search.log);
    Ok(Some(Value::Array(answers)))
}

// ---------------------------------------------------------------------------
// hwp/ai-image and mindmap/ai-image
// ---------------------------------------------------------------------------

struct MediaFake {
    user_data: String,
    temp: String,
    statuses: JsonValue,
    files: HashMap<String, String>,
    step: Value,
    log: Vec<Vec<Value>>,
}

impl MediaFake {
    fn user_data_dir(&mut self) -> String {
        self.log
            .push(vec![Value::from("getPath"), Value::from("userData")]);
        self.user_data.clone()
    }

    fn file_path_of(&mut self, id: f64) -> Option<String> {
        self.log.push(vec![
            Value::from("filePathOf"),
            serde_json::Number::from_f64(id).map_or(Value::Null, Value::Number),
        ]);
        self.files.get(&jscompat::number_to_string(id)).cloned()
    }

    fn subscription_statuses(&mut self) -> JsonValue {
        self.log.push(vec![Value::from("statuses")]);
        self.statuses.clone()
    }

    fn answer_of(&self, key: &str) -> JsonValue {
        self.step
            .get(key)
            .and_then(|s| s.get("answer"))
            .map_or(JsonValue::Null, json_value_from_serde)
    }

    fn context(statuses: &JsonValue) -> Value {
        let mut context = Map::new();
        context.insert("path".into(), Value::from("screen"));
        context.insert("statuses".into(), js(statuses));
        Value::Object(context)
    }

    #[allow(clippy::too_many_arguments)]
    fn log_generate(
        &mut self,
        calls: &MediaCalls,
        call: MediaCallId,
        settings_path: &str,
        prompt: &str,
        aspect_ratio: Option<&str>,
        media_roots: &[String],
        statuses: &JsonValue,
    ) -> JsonValue {
        let mut op = Map::new();
        op.insert("prompt".into(), Value::from(prompt));
        if let Some(ratio) = aspect_ratio {
            op.insert("aspectRatio".into(), Value::from(ratio));
        }
        let mut options = Map::new();
        options.insert(
            "mediaRoots".into(),
            Value::Array(
                media_roots
                    .iter()
                    .map(|r| Value::from(r.as_str()))
                    .collect(),
            ),
        );
        options.insert("context".into(), Self::context(statuses));
        options.insert("aborted".into(), Value::Bool(calls.aborted(call)));
        self.log.push(vec![
            Value::from("generateImageTool"),
            Value::from(settings_path),
            Value::Object(op),
            Value::Object(options),
        ]);
        self.answer_of("generate")
    }

    /// `analyzeMediaTool(settingsPath, op, { context, signal })`, run by
    /// the caller between `begin_analyze_media` and its finish
    fn log_analyze(
        &mut self,
        calls: &MediaCalls,
        call: MediaCallId,
        request: &AnalyzeMediaRequest,
    ) -> JsonValue {
        let op = &request.op;
        let mut payload = Map::new();
        payload.insert(
            "mediaUrls".into(),
            Value::Array(
                op.media_urls
                    .iter()
                    .map(|u| Value::from(u.as_str()))
                    .collect(),
            ),
        );
        payload.insert("requirements".into(), Value::from(op.requirements.as_str()));
        let mut options = Map::new();
        options.insert("context".into(), Self::context(&request.statuses));
        options.insert("aborted".into(), Value::Bool(calls.aborted(call)));
        self.log.push(vec![
            Value::from("analyzeMediaTool"),
            Value::from(request.settings_path.as_str()),
            Value::Object(payload),
            Value::Object(options),
        ]);
        self.answer_of("analyze")
    }
}

impl HwpImageHost for MediaFake {
    fn user_data_dir(&mut self) -> String {
        MediaFake::user_data_dir(self)
    }

    fn temp_dir(&mut self) -> String {
        self.log
            .push(vec![Value::from("getPath"), Value::from("temp")]);
        self.temp.clone()
    }

    fn file_path_of(&mut self, web_contents_id: f64) -> Option<String> {
        MediaFake::file_path_of(self, web_contents_id)
    }

    fn subscription_statuses(&mut self) -> JsonValue {
        MediaFake::subscription_statuses(self)
    }
}

/// a mind map host: the same fake without the temp folder (the folder is
/// the option of the module)
struct MindmapFake(MediaFake);

impl MindmapImageHost for MindmapFake {
    fn user_data_dir(&mut self) -> String {
        self.0.user_data_dir()
    }

    fn file_path_of(&mut self, web_contents_id: f64) -> Option<String> {
        self.0.file_path_of(web_contents_id)
    }

    fn subscription_statuses(&mut self) -> JsonValue {
        self.0.subscription_statuses()
    }
}

fn media_fake(spec: &Value) -> MediaFake {
    MediaFake {
        user_data: text_of(spec, "userData"),
        temp: text_of(spec, "temp"),
        statuses: spec.get("statuses").map_or_else(
            || JsonValue::Object(jscompat::JsObject::new()),
            json_value_from_serde,
        ),
        files: spec
            .get("files")
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
                    .collect()
            })
            .unwrap_or_default(),
        step: Value::Null,
        log: Vec::new(),
    }
}

/// the window of a step: its id and whether it is destroyed
fn sender_of(call: &Value) -> (f64, bool) {
    let sender = call.get("sender");
    (
        sender
            .and_then(|s| s.get("id"))
            .and_then(Value::as_f64)
            .unwrap_or(1.0),
        sender
            .and_then(|s| s.get("destroyed"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}

fn media_call(is_hwp: bool, args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("spec"))?;
    let mut host = media_fake(spec);
    let pasted = text_of(spec, "pastedImageDir");
    let mut calls = MediaCalls::new();
    let mut answers = Vec::new();
    let mut mindmap = MindmapFake(media_fake(spec));
    for step in steps_of(spec) {
        let (call, generating) = match step.get("generate") {
            Some(call) => (call, true),
            None => (step.get("analyze").unwrap_or(&Value::Null), false),
        };
        let (id, destroyed) = sender_of(call);
        let op = call.get("op").map(json_value_from_serde);
        let answer = if is_hwp {
            host.step = step.clone();
            if generating {
                let start = begin_generate_image(&mut host, &mut calls, id, destroyed, op.as_ref());
                let request = &start.request;
                let answer = host.log_generate(
                    &calls,
                    start.run.call,
                    &request.settings_path,
                    &request.op.prompt,
                    request.op.aspect_ratio.as_deref(),
                    &request.media_roots,
                    &request.statuses,
                );
                finish_generate_image(&mut calls, start.run, answer)
            } else {
                match begin_analyze_media(&mut host, &mut calls, id, destroyed, op.as_ref()) {
                    AnalyzeMediaStep::Done(answer) => answer,
                    AnalyzeMediaStep::Tool { run, request } => {
                        let answer = host.log_analyze(&calls, run.call, &request);
                        finish_analyze_media(&mut calls, run, answer)
                    }
                }
            }
        } else {
            mindmap.0.step = step.clone();
            let start = mindmap_begin_generate_image(
                &mut mindmap,
                &mut calls,
                &pasted,
                id,
                destroyed,
                op.as_ref(),
            );
            let request = &start.request;
            let answer = mindmap.0.log_generate(
                &calls,
                start.run.call,
                &request.settings_path,
                &request.op.prompt,
                request.op.aspect_ratio.as_deref(),
                &request.media_roots,
                &request.statuses,
            );
            mindmap_finish_generate_image(&mut calls, start.run, answer)
        };
        // `undefined` of a tool that answered nothing reads as `null`
        answers.push(js(&answer));
    }
    cx.logs
        .extend(if is_hwp { host.log } else { mindmap.0.log });
    Ok(Some(Value::Array(answers)))
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let answer = match name {
        "ai-naming-service.AI_NAMING_SUGGEST_CHANNEL" => {
            Ok(Some(Value::from(AI_NAMING_SUGGEST_CHANNEL)))
        }
        "ai-naming-service.registerAiNamingIpc" => naming_call(args, cx),
        "docs/free-ai-ipc.registerFreeAiIpc" => free_call(args, cx),
        "html/ai-search-ipc.registerHtmlAiSearchIpc" => html_call(args, cx),
        "hwp/ai-image.registerHwpImageIpc" => media_call(true, args, cx),
        "mindmap/ai-image.registerMindmapImageIpc" => media_call(false, args, cx),
        _ => return None,
    };
    Some(answer)
}
