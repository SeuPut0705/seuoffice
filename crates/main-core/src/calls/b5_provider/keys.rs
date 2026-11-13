//! Part `keys` of group `b5-provider` (tools/main-diff/groups/b5-provider/keys.ts):
//! `packages/ai-provider/src/{key-effort, key-models, key-model-refresh,
//! custom-models, local-models, local-ipc, local-test}.ts`.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::{Value, json};

use super::super::{Answer, Context, arg};
use super::world::{Sink, call_error, drive, note};
use crate::packages::ai_provider::custom_models::{list_custom_models, list_custom_models_for_ipc};
use crate::packages::ai_provider::effort::ai_model_effort_of;
use crate::packages::ai_provider::fetch::{AiFetch, AiFetchState, KeyedFetchBase};
use crate::packages::ai_provider::jsval::{Obj, object, prop, text};
use crate::packages::ai_provider::key_effort::{
    key_effort_body, key_model_effort, key_provider_effort, takes_key_effort,
};
use crate::packages::ai_provider::key_model_refresh::{
    KeyModelRefresherDeps, ListAnswer, ListFuture, create_key_model_refresher,
    with_key_provider_models,
};
use crate::packages::ai_provider::key_models::{
    KeyListConfig, KeyModelListing, Listed, MAX_KEY_PROVIDER_MODELS, key_model_ids_of,
    key_model_listing_of, list_key_provider_model_listing, list_key_provider_models,
    lists_key_provider_models,
};
use crate::packages::ai_provider::local_ipc::{
    AiLocalTestIpcOptions, LocalIpcState, cancel_local_test_for_ipc, inspect_local_model_for_ipc,
    list_local_models_for_ipc, parse_local_discovery_input, parse_local_inspection_input,
    parse_local_test_input, test_local_model_for_ipc,
};
use crate::packages::ai_provider::local_models::{
    AiLocalDiscoveryRequest, AiLocalInspectionRequest, AiLocalRequestOptions, AiLocalServerKind,
    inspect_local_model, list_local_models,
};
use crate::packages::ai_provider::local_test::{AiLocalTestOptions, test_local_model};
use crate::packages::ai_provider::protocols_openai_compatible::OpenAiCompatibleState;
use crate::packages::ai_provider::stored_settings::{
    with_stored_key_models, with_stored_main_fields,
};
use crate::packages::ai_provider::task::{Fetcher, JsError, LocalBoxFuture, Rt, Signal};

fn jv(args: &[Value], i: usize) -> JsonValue {
    arg(args, i).map_or(JsonValue::Null, json_value_from_serde)
}

fn s(args: &[Value], i: usize) -> String {
    arg(args, i)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn ok(value: &JsonValue) -> Answer {
    Ok(Some(json_value_to_serde(value)))
}

fn ok_option(value: Option<JsonValue>) -> Answer {
    Ok(value.map(|v| json_value_to_serde(&v)))
}

fn thrown<T>(result: Result<T, JsError>) -> Result<T, super::super::CallError> {
    result.map_err(|e| call_error(&e))
}

/// The module state every call starts from (`setUp()` of the spec).
fn fetch_state() -> AiFetch {
    let mut state = AiFetchState::default();
    state.set_ai_user_agent("");
    Rc::new(RefCell::new(state))
}

fn openai_state() -> Rc<RefCell<OpenAiCompatibleState>> {
    Rc::new(RefCell::new(OpenAiCompatibleState::default()))
}

/// The entries of a list a case gives `keyModelIdsOf`.
fn listed_of(value: &JsonValue) -> Vec<Listed> {
    let JsonValue::Array(items) = value else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| Listed {
            id: match prop(item, "id") {
                Some(JsonValue::String(id)) => id.clone(),
                _ => String::new(),
            },
            created: match prop(item, "created") {
                Some(JsonValue::Number(x)) => Some(*x),
                _ => None,
            },
            effort: prop(item, "effort").and_then(|e| ai_model_effort_of(Some(e))),
        })
        .collect()
}

/// Runs `body` in the case's world; its value or what it threw.
fn in_world<F>(
    args: &[Value],
    cx: &mut Context,
    body: impl FnOnce(Rt, Signal, Sink, Value) -> F,
) -> Answer
where
    F: Future<Output = Result<Value, JsError>> + 'static,
{
    let world = arg(args, 0).cloned();
    let o = arg(args, 1).cloned().unwrap_or(Value::Null);
    match drive(world.as_ref(), cx, move |rt, signal, sink| {
        body(rt, signal, sink, o)
    })? {
        Ok(v) => Ok(Some(v)),
        Err(e) => Err(call_error(&e)),
    }
}

fn str_of<'a>(o: &'a Value, key: &str) -> Option<&'a str> {
    o.get(key).and_then(Value::as_str)
}

// ---------------------------------------------------------------------------
// key-models.ts, the listing of a vendor
// ---------------------------------------------------------------------------

/// `listConfig(o)` and the fetch of the case
fn list_args(o: &Value) -> (String, KeyListConfig, KeyedFetchBase) {
    let provider = str_of(o, "provider").unwrap_or_default().to_owned();
    let config = KeyListConfig {
        api_key: str_of(o, "apiKey").unwrap_or("sk-test").to_owned(),
        base_url: str_of(o, "baseUrl").map(str::to_owned),
    };
    let base = if str_of(o, "fetch") == Some("net") {
        KeyedFetchBase::Plain(Fetcher::Net)
    } else {
        KeyedFetchBase::Plain(Fetcher::Node)
    };
    (provider, config, base)
}

// ---------------------------------------------------------------------------
// key-model-refresh.ts
// ---------------------------------------------------------------------------

/// The answer a scripted listing gives: an array, `{ models, efforts }`, or
/// nothing.
fn list_answer_of(answer: Option<&Value>) -> Option<ListAnswer> {
    let strings = |value: Option<&Value>| -> Vec<String> {
        value
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|i| i.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    match answer? {
        Value::Array(_) => Some(ListAnswer::Models(strings(answer))),
        Value::Object(o) => match o.get("efforts") {
            None => Some(ListAnswer::Models(strings(o.get("models")))),
            Some(efforts) => {
                let efforts = match json_value_from_serde(efforts) {
                    JsonValue::Object(table) => table,
                    _ => Obj::new(),
                };
                Some(ListAnswer::Listing(KeyModelListing {
                    models: strings(o.get("models")),
                    efforts,
                }))
            }
        },
        _ => None,
    }
}

/// The scripted listing of a case: the n-th call answers its n-th spec.
fn scripted_list(
    rt: &Rt,
    sink: &Sink,
    lists: Vec<Value>,
) -> Rc<dyn Fn(&str, &KeyListConfig) -> ListFuture> {
    let rt = rt.clone();
    let sink = sink.clone();
    let calls = Rc::new(Cell::new(0usize));
    Rc::new(move |provider: &str, config: &KeyListConfig| {
        let n = calls.get();
        calls.set(n + 1);
        let spec = lists.get(n).cloned().unwrap_or(Value::Null);
        note(
            &sink,
            json!(["list", provider, config.api_key, config.base_url]),
        );
        let rt = rt.clone();
        Box::pin(async move {
            let after = spec.get("after").and_then(Value::as_f64).unwrap_or(0.0);
            if after != 0.0 {
                rt.sleep(after).await;
            }
            if let Some(message) = str_of(&spec, "reject") {
                return Err(JsError::error(message));
            }
            Ok(list_answer_of(spec.get("answer")))
        }) as LocalBoxFuture<Result<Option<ListAnswer>, JsError>>
    })
}

/// `file.providers[provider][field] = value`
fn set_field(file: &RefCell<JsonValue>, provider: &str, field: &str, value: JsonValue) {
    if let JsonValue::Object(root) = &mut *file.borrow_mut()
        && let Some(JsonValue::Object(providers)) = root.get_mut("providers")
        && let Some(JsonValue::Object(config)) = providers.get_mut(provider)
    {
        config.set(field, value);
    }
}

async fn refresher_case(rt: Rt, sink: Sink, o: Value) -> Result<Value, JsError> {
    let fx = fetch_state();
    let file = Rc::new(RefCell::new(json_value_from_serde(
        o.get("settings").unwrap_or(&Value::Null),
    )));
    let flag = |key: &str| o.get(key).and_then(Value::as_bool) == Some(true);
    let (read_fails, write_fails) = (flag("readFails"), flag("writeFails"));
    let read_file = file.clone();
    let write_file = file.clone();
    let write_sink = sink.clone();
    let deps = KeyModelRefresherDeps {
        read: Rc::new(move || {
            if read_fails {
                return Err(JsError::error("read failed"));
            }
            Ok(read_file.borrow().clone())
        }),
        write: Rc::new(
            move |update: &dyn Fn(&JsonValue) -> Result<Option<JsonValue>, JsError>| {
                if write_fails {
                    return Err(JsError::error("write failed"));
                }
                let latest = write_file.borrow().clone();
                let next = update(&latest)?;
                note(
                    &write_sink,
                    json!(["write", if next.is_none() { "same" } else { "changed" }]),
                );
                if let Some(next) = next {
                    *write_file.borrow_mut() = next;
                }
                Ok(())
            },
        ),
        list: o
            .get("lists")
            .and_then(Value::as_array)
            .map(|lists| scripted_list(&rt, &sink, lists.clone())),
    };
    let refresher = create_key_model_refresher(&rt, &fx, deps);
    let steps = o
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for step in &steps {
        let step = step.as_array().cloned().unwrap_or_default();
        match step.first().and_then(Value::as_str) {
            Some("refresh") => refresher.refresh_changed()?,
            Some("idle") => refresher.idle().await,
            Some("sleep") => {
                rt.sleep(step.get(1).and_then(Value::as_f64).unwrap_or(0.0))
                    .await
            }
            Some("set") => set_field(
                &file,
                step.get(1).and_then(Value::as_str).unwrap_or_default(),
                step.get(2).and_then(Value::as_str).unwrap_or_default(),
                json_value_from_serde(step.get(3).unwrap_or(&Value::Null)),
            ),
            _ => {}
        }
    }
    refresher.idle().await;
    let settings = file.borrow().clone();
    Ok(json_value_to_serde(&settings))
}

// ---------------------------------------------------------------------------
// local-models.ts, local-test.ts, local-ipc.ts
// ---------------------------------------------------------------------------

fn discovery_request(request: &JsonValue) -> AiLocalDiscoveryRequest {
    AiLocalDiscoveryRequest {
        base_url: match prop(request, "baseUrl") {
            Some(JsonValue::String(url)) => url.clone(),
            _ => String::new(),
        },
        api_key: match prop(request, "apiKey") {
            Some(JsonValue::String(key)) => Some(key.clone()),
            _ => None,
        },
    }
}

fn owner_of(o: Option<&Value>) -> Option<JsonValue> {
    o.and_then(|o| o.get("owner")).map(json_value_from_serde)
}

/// `ipcScenario(signal, opts)`: the tests and the cancel of a case, side by
/// side in the world.
async fn ipc_scenario(rt: Rt, signal: Signal, o: Value) -> Result<Value, JsError> {
    let fx = fetch_state();
    let openai = openai_state();
    let ipc = Rc::new(RefCell::new(LocalIpcState::default()));
    let mut jobs: Vec<LocalBoxFuture<Value>> = Vec::new();

    let start = {
        let (rt, fx, openai, ipc) = (rt.clone(), fx.clone(), openai.clone(), ipc.clone());
        move |input: JsonValue, owner: Option<JsonValue>, signal: Option<Signal>| {
            let (rt, fx, openai, ipc) = (rt.clone(), fx.clone(), openai.clone(), ipc.clone());
            async move {
                let options = AiLocalTestIpcOptions { owner, signal };
                json_value_to_serde(
                    &test_local_model_for_ipc(&rt, &fx, &openai, &ipc, &input, Some(&options))
                        .await
                        .to_json(),
                )
            }
        }
    };

    if let Some(input) = o.get("input") {
        let aborts = o.get("abort").and_then(Value::as_bool) == Some(true);
        jobs.push(Box::pin(start(
            json_value_from_serde(input),
            owner_of(Some(&o)),
            aborts.then(|| signal.clone()),
        )));
    }
    if let Some(second) = o.get("second") {
        let at = second.get("at").and_then(Value::as_f64).unwrap_or(0.0);
        let input = json_value_from_serde(second.get("input").unwrap_or(&Value::Null));
        let owner = owner_of(Some(second));
        let rt = rt.clone();
        let run = start.clone();
        jobs.push(Box::pin(async move {
            if at != 0.0 {
                rt.sleep(at).await;
            }
            run(input, owner, None).await
        }));
    }
    if let Some(cancel) = o.get("cancel") {
        let at = cancel.get("at").and_then(Value::as_f64).unwrap_or(0.0);
        let input = json_value_from_serde(cancel.get("input").unwrap_or(&Value::Null));
        let owner = owner_of(Some(cancel));
        let rt = rt.clone();
        let ipc = ipc.clone();
        jobs.push(Box::pin(async move {
            if at != 0.0 {
                rt.sleep(at).await;
            }
            Value::Bool(cancel_local_test_for_ipc(&ipc, &input, owner.as_ref()))
        }));
    }
    Ok(Value::Array(rt.join_all(jobs).await))
}

fn parsed_discovery(raw: &JsonValue) -> Option<JsonValue> {
    let parsed = parse_local_discovery_input(raw)?;
    let mut entries = vec![("baseUrl", text(parsed.base_url))];
    if let Some(key) = parsed.api_key {
        entries.push(("apiKey", text(key)));
    }
    Some(object(entries))
}

fn parsed_inspection(raw: &JsonValue) -> Option<JsonValue> {
    let parsed = parse_local_inspection_input(raw)?;
    let mut entries = vec![("baseUrl", text(parsed.base_url))];
    if let Some(key) = parsed.api_key {
        entries.push(("apiKey", text(key)));
    }
    entries.push(("model", text(parsed.model)));
    if let Some(server) = parsed.server {
        entries.push(("server", text(server.as_str())));
    }
    Some(object(entries))
}

fn parsed_test(raw: &JsonValue) -> Option<JsonValue> {
    let parsed = parse_local_test_input(raw)?;
    let mut entries = vec![("baseUrl", text(parsed.base_url))];
    if let Some(key) = parsed.api_key {
        entries.push(("apiKey", text(key)));
    }
    entries.push(("model", text(parsed.model)));
    if parsed.typed {
        entries.push(("typed", JsonValue::Bool(true)));
    }
    entries.push(("timeoutMs", JsonValue::Number(parsed.timeout_ms)));
    if let Some(id) = parsed.test_id {
        entries.push(("testId", text(id)));
    }
    Some(object(entries))
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- key-effort.ts ----
        "key-effort.takesKeyEffort" => Ok(Some(Value::Bool(takes_key_effort(
            arg(args, 0).and_then(Value::as_str),
        )))),
        "key-effort.keyModelEffort" => {
            let config = jv(args, 0);
            let config = (!matches!(config, JsonValue::Null)).then_some(config);
            let model = arg(args, 1).map(json_value_from_serde);
            thrown(key_model_effort(config.as_ref(), model.as_ref()))
                .map(|effort| effort.map(|e| json_value_to_serde(&e.to_json())))
        }
        "key-effort.keyProviderEffort" => thrown(key_provider_effort(&s(args, 0), &jv(args, 1)))
            .map(|effort| effort.map(|e| Value::String(e.to_owned()))),
        "key-effort.keyEffortBody" => {
            thrown(key_effort_body(&s(args, 0), &jv(args, 1), &s(args, 2)))
                .map(|body| body.map(|b| json_value_to_serde(&b)))
        }

        // ---- key-models.ts, the pure part ----
        "key-models.MAX_KEY_PROVIDER_MODELS" => Ok(Some(json!(MAX_KEY_PROVIDER_MODELS))),
        "key-models.keyModelIdsOf" => {
            let ids = key_model_ids_of(&s(args, 0), &listed_of(&jv(args, 1)));
            Ok(Some(Value::Array(
                ids.into_iter().map(Value::String).collect(),
            )))
        }
        "key-models.keyModelListingOf" => {
            let listing = key_model_listing_of(&s(args, 0), &listed_of(&jv(args, 1)));
            ok(&listing.to_json())
        }
        "key-models.listsKeyProviderModels" => {
            thrown(lists_key_provider_models(&s(args, 0))).map(|b| Some(Value::Bool(b)))
        }

        // ---- key-models.ts, the listing of a vendor ----
        "key-models.listKeyProviderModelListing" => in_world(args, cx, |rt, _, _, o| async move {
            let fx = fetch_state();
            let (provider, config, base) = list_args(&o);
            let listing =
                list_key_provider_model_listing(&rt, &fx, &provider, &config, &base).await?;
            Ok(listing.map_or(Value::Null, |l| json_value_to_serde(&l.to_json())))
        }),
        "key-models.listKeyProviderModels" => in_world(args, cx, |rt, _, _, o| async move {
            let fx = fetch_state();
            let (provider, config, base) = list_args(&o);
            let models = list_key_provider_models(&rt, &fx, &provider, &config, &base).await?;
            Ok(models.map_or(Value::Null, |m| {
                Value::Array(m.into_iter().map(Value::String).collect())
            }))
        }),

        // ---- key-model-refresh.ts ----
        "key-model-refresh.createKeyModelRefresher" => {
            in_world(args, cx, |rt, _, sink, o| refresher_case(rt, sink, o))
        }
        "key-model-refresh.withKeyProviderModels" => {
            let settings = jv(args, 0);
            let models: Vec<String> = match jv(args, 2) {
                JsonValue::Array(items) => items
                    .into_iter()
                    .filter_map(|i| match i {
                        JsonValue::String(s) => Some(s),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            };
            let efforts = arg(args, 3).map(json_value_from_serde);
            thrown(with_key_provider_models(
                &settings,
                &s(args, 1),
                &models,
                efforts.as_ref(),
            ))
            .map(|updated| {
                let unchanged = updated.is_none();
                Some(json!({
                    "unchanged": unchanged,
                    "settings": json_value_to_serde(&updated.unwrap_or(settings)),
                }))
            })
        }
        "key-model-refresh.withStoredKeyModels" => {
            ok(&with_stored_key_models(&jv(args, 0), &jv(args, 1)))
        }
        "key-model-refresh.withStoredMainFields" => {
            ok(&with_stored_main_fields(&jv(args, 0), &jv(args, 1)))
        }

        // ---- custom-models.ts ----
        "custom-models.listCustomModels" => in_world(args, cx, |rt, _, _, o| async move {
            let fx = fetch_state();
            let catalog = list_custom_models(
                &rt,
                &fx,
                str_of(&o, "baseUrl").unwrap_or_default(),
                str_of(&o, "apiKey"),
            )
            .await;
            Ok(json_value_to_serde(&catalog.to_json()))
        }),
        "custom-models.listCustomModelsForIpc" => in_world(args, cx, |rt, _, _, o| async move {
            let fx = fetch_state();
            let catalog = list_custom_models_for_ipc(&rt, &fx, &json_value_from_serde(&o)).await;
            Ok(json_value_to_serde(&catalog.to_json()))
        }),

        // ---- local-models.ts ----
        "local-models.listLocalModels" => in_world(args, cx, |rt, signal, _, o| async move {
            let fx = fetch_state();
            let request = discovery_request(&json_value_from_serde(
                o.get("request").unwrap_or(&Value::Null),
            ));
            let options = (o.get("signal").and_then(Value::as_bool) == Some(true)).then(|| {
                AiLocalRequestOptions {
                    signal: Some(signal),
                }
            });
            let result = list_local_models(&rt, &fx, &request, options.as_ref()).await;
            Ok(json_value_to_serde(&result.to_json()))
        }),
        "local-models.inspectLocalModel" => in_world(args, cx, |rt, _, _, o| async move {
            let fx = fetch_state();
            let given = json_value_from_serde(&o);
            let discovery = discovery_request(&given);
            let request = AiLocalInspectionRequest {
                base_url: discovery.base_url,
                api_key: discovery.api_key,
                model: match prop(&given, "model") {
                    Some(JsonValue::String(m)) => m.clone(),
                    _ => String::new(),
                },
                server: AiLocalServerKind::of(prop(&given, "server")),
            };
            let result = inspect_local_model(&rt, &fx, &request).await;
            Ok(json_value_to_serde(&result.to_json()))
        }),

        // ---- local-test.ts ----
        "local-test.testLocalModel" => in_world(args, cx, |rt, signal, _, o| async move {
            let fx = fetch_state();
            let openai = openai_state();
            let given = match str_of(&o, "signal") {
                Some("world") => Some(signal),
                Some("aborted") => {
                    let controller = rt.controller();
                    controller.abort(None);
                    Some(controller)
                }
                _ => None,
            };
            let input = json_value_from_serde(o.get("input").unwrap_or(&Value::Null));
            let options = given.map(|signal| AiLocalTestOptions {
                signal: Some(signal),
            });
            let result = test_local_model(&rt, &fx, &openai, &input, options.as_ref()).await;
            Ok(json_value_to_serde(&result.to_json()))
        }),

        // ---- local-ipc.ts ----
        "local-ipc.parseLocalDiscoveryInput" => ok_option(parsed_discovery(&jv(args, 0))),
        "local-ipc.parseLocalInspectionInput" => ok_option(parsed_inspection(&jv(args, 0))),
        "local-ipc.parseLocalTestInput" => ok_option(parsed_test(&jv(args, 0))),
        "local-ipc.listLocalModelsForIpc" => in_world(args, cx, |rt, _, _, o| async move {
            let fx = fetch_state();
            let result = list_local_models_for_ipc(&rt, &fx, &json_value_from_serde(&o)).await;
            Ok(json_value_to_serde(&result.to_json()))
        }),
        "local-ipc.inspectLocalModelForIpc" => in_world(args, cx, |rt, _, _, o| async move {
            let fx = fetch_state();
            let result = inspect_local_model_for_ipc(&rt, &fx, &json_value_from_serde(&o)).await;
            Ok(json_value_to_serde(&result.to_json()))
        }),
        "local-ipc.testLocalModelForIpc" | "local-ipc.cancelLocalTestForIpc" => {
            in_world(args, cx, |rt, signal, _, o| ipc_scenario(rt, signal, o))
        }
        _ => return None,
    })
}
