//! The probe fakes of the `ai_core` ports' hosts, scripted by the case's
//! `hosts.a.aiCore` (the TypeScript half is tools/ipc-diff/groups/a/ai-core.ts,
//! which reads the same value and logs the same lines). The providers' HTTP is
//! `hosts.a.net` (the table of [`crate::runtime::testing::FakeNet`]), answered
//! by the runtime's fetches, not by this host.
//!
//! - `statuses`: what `sharedSubscriptionStatuses()` answers (`{}`)
//! - `headless`: `isHeadlessMode()` (false)
//! - `capabilities`: what `aiToolCapabilities(settings, context)` answers
//!   (`{}`); logs `["aiToolCapabilities", settings, context]`
//! - `webSearch`, `imageSearch`: the answer of the backend, or
//!   `{"$throw": message}`; logs `["webSearch", query, maxResults, options]`
//!   (`["imageSearch", ...]`); `options` as `SearchOptions` spells them
//! - `readUrl`: the answer of `readUrlTool`, or `{"$throw": message}`; logs
//!   `["readUrlTool", url, offset]`
//! - `fetchImage`: `{contentType, hex}` for a download that worked, `null`
//!   (the default) for one that did not; logs `["fetchRemoteImage", url]`
//! - `pendingDocs`: `{"<view>": content}` queued before the case, as
//!   `queueDocsAiContent(view, content)` would
//!
//! `hosts.a.lang` is the UI language (`ko` by default).

use std::path::PathBuf;
use std::sync::Arc;

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use main_core::packages::ai_search::search_tools::{SearchAnswer, SearchOptions};
use main_core::packages::i18n::Lang;
use serde_json::{Value, json};
use shell_contract::runtime::CancelToken;

use super::{Log, push};
use crate::ai_core::{AiCoreHost, AiCoreHostHandle, PendingAiDocs, PendingAiDocsHost, RemoteImage};
use crate::secrets::{KeyPlace, OsSafeStorage, SecretCodecHost, ShellSecretCodec};

struct FakeHost {
    world: Value,
    lang: Lang,
    log: Option<Log>,
}

impl FakeHost {
    /// A scripted answer: the value, or the `$throw` of it as a rejection
    fn scripted(&self, key: &str) -> Result<JsonValue, JsonValue> {
        match &self.world[key] {
            Value::Object(o) if o.len() == 1 && o.contains_key("$throw") => {
                Err(json_value_from_serde(&json!({
                    "$class": "Error",
                    "message": o["$throw"].as_str().unwrap_or_default(),
                })))
            }
            Value::Null => Ok(JsonValue::Null),
            value => Ok(json_value_from_serde(value)),
        }
    }
}

impl AiCoreHost for FakeHost {
    fn ui_lang(&self) -> Lang {
        self.lang
    }

    fn subscription_statuses(&self) -> JsonValue {
        match &self.world["statuses"] {
            Value::Null => json_value_from_serde(&json!({})),
            statuses => json_value_from_serde(statuses),
        }
    }

    fn is_headless_mode(&self) -> bool {
        self.world["headless"] == json!(true)
    }

    fn ai_tool_capabilities(&self, settings: &JsonValue, context: &JsonValue) -> JsonValue {
        push(
            &self.log,
            json!([
                "aiToolCapabilities",
                json_value_to_serde(settings),
                json_value_to_serde(context)
            ]),
        );
        match &self.world["capabilities"] {
            Value::Null => json_value_from_serde(&json!({})),
            capabilities => json_value_from_serde(capabilities),
        }
    }

    fn web_search(&self, query: &str, max_results: f64, options: &SearchOptions) -> SearchAnswer {
        push(
            &self.log,
            json!([
                "webSearch",
                query,
                max_results,
                json_value_to_serde(&options.to_json())
            ]),
        );
        self.scripted("webSearch")
    }

    fn image_search(&self, query: &str, max_results: f64, options: &SearchOptions) -> SearchAnswer {
        push(
            &self.log,
            json!([
                "imageSearch",
                query,
                max_results,
                json_value_to_serde(&options.to_json())
            ]),
        );
        self.scripted("imageSearch")
    }

    fn read_url(
        &self,
        _settings_path: &str,
        url: &str,
        offset: f64,
        _signal: &CancelToken,
    ) -> Result<JsonValue, JsonValue> {
        push(&self.log, json!(["readUrlTool", url, offset]));
        self.scripted("readUrl")
    }

    fn fetch_remote_image(&self, url: &str) -> Option<RemoteImage> {
        push(&self.log, json!(["fetchRemoteImage", url]));
        let image = self.world["fetchImage"].as_object()?;
        let hex = image.get("hex")?.as_str()?;
        Some(RemoteImage {
            bytes: (0..hex.len() / 2)
                .filter_map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).ok())
                .collect(),
            content_type: image
                .get("contentType")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        })
    }
}

/// Inserts these ports' factories and the fakes of their hosts, answering
/// from the case's `hosts.a` value; `log` is the case's host log
pub fn insert(hosts: &mut shell_contract::Hosts, case: &Value, log: Option<Log>) {
    let world = &case["aiCore"];
    hosts.insert(crate::ai_core::factory());
    hosts.insert(crate::ai_core::app_ai_factory());
    hosts.insert::<AiCoreHostHandle>(Arc::new(FakeHost {
        world: world.clone(),
        lang: main_core::packages::i18n::normalize_lang(Some(
            case["lang"].as_str().unwrap_or("ko"),
        )),
        log,
    }));
    let pending = Arc::new(PendingAiDocs::default());
    for (view, content) in world["pendingDocs"].as_object().into_iter().flatten() {
        if let Ok(view) = view.parse::<i64>() {
            pending.queue(view, content);
        }
    }
    hosts.insert::<PendingAiDocsHost>(pending);
    // the settings keys of a case are plain: the codec only opens sealed ones
    if hosts.get::<SecretCodecHost>().is_none() {
        let dir = PathBuf::from(case["dir"].as_str().unwrap_or("."));
        hosts.insert::<SecretCodecHost>(Arc::new(ShellSecretCodec::new(Arc::new(
            OsSafeStorage::new(KeyPlace {
                app_name: "seuoffice".into(),
                user_data: dir,
            }),
        ))));
    }
}
