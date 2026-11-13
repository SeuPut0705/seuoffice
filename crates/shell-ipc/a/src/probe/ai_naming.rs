//! The probe fakes of the `ai_naming` port's hosts, scripted by the case's
//! `hosts.a.aiNaming` (the TypeScript half is tools/ipc-diff/groups/a/ai-naming.ts,
//! which reads the same value and logs the same lines):
//!
//! - `statuses`: `sharedSubscriptionStatuses()` (`{}` by default)
//! - `chats`: one answer per `chatForProvider` call, in order: `{content}`
//!   (`{noContent: true}` for none), `{ok: false, error}`, or `{throws: message}`; a
//!   call after the list ran out answers `{ok: false, error: "no scripted chat"}`
//!
//! `hosts.a.lang` is the UI language (`ko` by default). The host log gets
//! `["chatForProvider", provider, model, instruction]` per chat. The 30 second
//! timer of the naming call is not scripted: the diff cannot wait for it, the
//! port's own tests cover it.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use jscompat::{JsonValue, json_value_from_serde};
use main_core::shell::ai_naming_service::ChatOutcome;
use serde_json::{Value, json};

use super::{Log, push};
use crate::ai_naming::{
    ChatJob, ChatResult, NamingChat, NamingChatHost, NamingContext, NamingContextHost,
};
use crate::secrets::{KeyPlace, OsSafeStorage, SecretCodecHost, ShellSecretCodec};

struct FakeContext {
    statuses: JsonValue,
    lang: String,
}

impl NamingContext for FakeContext {
    fn subscription_statuses(&self) -> JsonValue {
        self.statuses.clone()
    }

    fn ui_lang(&self) -> String {
        self.lang.clone()
    }
}

struct FakeChat {
    script: Mutex<std::collections::VecDeque<Value>>,
    log: Option<Log>,
}

impl NamingChat for FakeChat {
    fn chat(&self, job: ChatJob, done: Box<dyn FnOnce(ChatResult) + Send>) {
        let model = match &job.config {
            JsonValue::Object(config) => match config.get("model") {
                Some(JsonValue::String(model)) => json!(model),
                _ => Value::Null,
            },
            _ => Value::Null,
        };
        push(
            &self.log,
            json!(["chatForProvider", job.provider, model, job.instruction]),
        );
        let answer = self
            .script
            .lock()
            .expect("the script")
            .pop_front()
            .unwrap_or_else(|| json!({ "ok": false, "error": "no scripted chat" }));
        let outcome = if let Some(message) = answer["throws"].as_str() {
            ChatOutcome::Threw(JsonValue::String(message.to_owned()))
        } else if answer["ok"] == json!(false) {
            ChatOutcome::Failed {
                error: json_value_from_serde(&answer["error"]),
            }
        } else if answer["noContent"] == json!(true) {
            ChatOutcome::Reply { content: None }
        } else {
            ChatOutcome::Reply {
                content: answer["content"].as_str().map(str::to_owned),
            }
        };
        done(ChatResult {
            outcome,
            timed_out: false,
        });
    }
}

/// Inserts this port's factory and the fakes of its hosts, answering from
/// the case's `hosts.a` value; `log` is the case's host log
pub fn insert(hosts: &mut shell_contract::Hosts, case: &Value, log: Option<Log>) {
    let world = &case["aiNaming"];
    hosts.insert(crate::ai_naming::factory());
    hosts.insert::<NamingContextHost>(Arc::new(FakeContext {
        statuses: if world["statuses"].is_null() {
            json_value_from_serde(&json!({}))
        } else {
            json_value_from_serde(&world["statuses"])
        },
        lang: case["lang"].as_str().unwrap_or("ko").to_owned(),
    }));
    hosts.insert::<NamingChatHost>(Arc::new(FakeChat {
        script: Mutex::new(
            world["chats"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into(),
        ),
        log,
    }));
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
