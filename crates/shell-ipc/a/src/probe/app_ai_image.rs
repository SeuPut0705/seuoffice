//! The probe fakes of the `app_ai_image` port: the shell entry's Codex image
//! generator and subscription statuses, scripted by the case's
//! `hosts.a.appAiImage` (the TypeScript half is
//! tools/ipc-diff/groups/a/app-ai-image.ts, which reads the same value and
//! logs the same line). The key providers' HTTP is the case's `hosts.a.net`
//! (`runtime::testing::FakeNet`), the settings the case's
//! `userData/ai-settings.json`.
//!
//! - `statuses`: what `sharedSubscriptionStatuses()` answers (`{}`)
//! - `codex`: `{available, registered, results}`: `available` is
//!   `codexImageGenerationAvailable()`, `registered` whether a generator is
//!   registered, `results` one answer per call of it, in order: `{url}` or
//!   `{throw: message}`
//!
//! The host log gets one line per generator call: `["codexImageGenerator",
//! {prompt, aspectRatio?}]`.

use std::sync::{Arc, Mutex};

use jscompat::{JsonValue, json_value_from_serde};
use main_core::packages::ai_provider::task::JsError;
use serde_json::{Value, json};
use shell_contract::runtime::CancelToken;

use super::{Log, push};
use crate::app_ai_image::{
    AppAiImageHost, AppAiImageHostHandle, CodexImage, CodexImageRequest, CodexImageRoute,
};

struct FakeHost {
    case: Value,
    log: Option<Log>,
    results: Mutex<Vec<Value>>,
}

impl AppAiImageHost for FakeHost {
    fn shared_subscription_statuses(&self) -> JsonValue {
        match &self.case["statuses"] {
            Value::Null => JsonValue::Object(Default::default()),
            statuses => json_value_from_serde(statuses),
        }
    }

    fn codex_image_route(&self) -> CodexImageRoute {
        let codex = &self.case["codex"];
        CodexImageRoute {
            available: codex["available"].as_bool().unwrap_or(false),
            registered: codex["registered"].as_bool().unwrap_or(false),
        }
    }

    fn codex_generate_image(
        &self,
        request: &CodexImageRequest,
        _signal: &CancelToken,
    ) -> Result<CodexImage, JsError> {
        let mut line = json!({ "prompt": request.prompt });
        if let Some(ratio) = &request.aspect_ratio {
            line["aspectRatio"] = json!(ratio);
        }
        push(&self.log, json!(["codexImageGenerator", line]));
        let mut results = self.results.lock().unwrap();
        let answer = if results.is_empty() {
            json!({ "throw": "no scripted codex image" })
        } else {
            results.remove(0)
        };
        match answer["throw"].as_str() {
            Some(message) => Err(JsError::error(message)),
            None => Ok(CodexImage::Url(
                answer["url"].as_str().unwrap_or_default().to_owned(),
            )),
        }
    }
}

pub fn insert(hosts: &mut shell_contract::Hosts, case: &Value, log: Option<Log>) {
    let scripted = case["appAiImage"].clone();
    let host: AppAiImageHostHandle = Arc::new(FakeHost {
        results: Mutex::new(
            scripted["codex"]["results"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
        ),
        case: scripted,
        log,
    });
    hosts.insert(host);
    hosts.insert(crate::app_ai_image::factory());
}
