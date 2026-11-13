//! The probe fakes of the `subscription` port's hosts, scripted by the case's
//! `hosts.a.subscription` (the TypeScript half is
//! tools/ipc-diff/groups/a/subscription.ts, which reads the same value and
//! logs the same lines):
//!
//! - `windowText`: `{ provider: { title?, guide?, closing? } }` for
//!   `aiSubscriptionLoginWindowText` (`{}` by default)
//! - `pages`: `{ done, failed }` for `aiChatGptSignInPages`, each `{ lang,
//!   title, body }` (`done` and `failed` named after the outcome by default)
//! - `detections`: `{ provider: { state, version?, loginMethod?, planName?,
//!   error?, programPath?, loginKind?, account? } }`: what `setup.detect`
//!   answers (`not-installed` for a provider not named); `{ throws }` rejects
//! - `models`: `{ provider: [..] }`: what `setup.listModels` answers (none)
//! - `programs`: `{ provider: { command, prefixArgs?, entry?, source?, env? } }`:
//!   what `setup.locate` answers (`null` for a provider not named)
//! - `signatureValid`: what `signatureValid` answers (`true`)
//!
//! `hosts.a.lang` is the UI language (`ko` by default). The host log gets one
//! line per call: `["getUiLang"]`, `["aiSubscriptionLoginWindowText", lang,
//! provider]`, `["aiChatGptSignInPages", lang]`, `["detect", provider,
//! configuredPath]`, `["listModels", provider, configuredPath]`,
//! `["locate", provider, configuredPath]`, `["signatureValid", alg]`.

use std::path::PathBuf;
use std::sync::Arc;

use jscompat::{JsonValue, json_value_from_serde};
use main_core::packages::ai_provider::subscription_locate::SubscriptionProgram;
use main_core::packages::ai_provider::subscription_status::SubscriptionDetection;
use serde_json::{Value, json};

use super::{Log, push};
use crate::secrets::{KeyPlace, OsSafeStorage, SecretCodecHost, ShellSecretCodec};
use crate::subscription::{
    SubscriptionShell, SubscriptionShellHost, SubscriptionStandIns, SubscriptionStandInsHost,
};

struct FakeShell {
    world: Value,
    lang: String,
    log: Option<Log>,
}

impl SubscriptionShell for FakeShell {
    fn ui_lang(&self) -> String {
        push(&self.log, json!(["getUiLang"]));
        self.lang.clone()
    }

    fn login_window_text(&self, lang: &str, provider: &str) -> JsonValue {
        push(
            &self.log,
            json!(["aiSubscriptionLoginWindowText", lang, provider]),
        );
        json_value_from_serde(&self.world["windowText"][provider])
    }

    fn chat_gpt_sign_in_pages(&self, lang: &str) -> JsonValue {
        push(&self.log, json!(["aiChatGptSignInPages", lang]));
        let page = |what: &str| json!({ "lang": lang, "title": what, "body": what });
        json_value_from_serde(&match &self.world["pages"] {
            Value::Null => json!({ "done": page("done"), "failed": page("failed") }),
            pages => pages.clone(),
        })
    }

    fn signature_valid(
        &self,
        alg: &str,
        _data: &[u8],
        _signature: &[u8],
        _jwk: &JsonValue,
    ) -> Result<bool, String> {
        push(&self.log, json!(["signatureValid", alg]));
        Ok(self.world["signatureValid"].as_bool().unwrap_or(true))
    }
}

struct FakeStandIns {
    world: Value,
    log: Option<Log>,
}

fn text_of(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

impl SubscriptionStandIns for FakeStandIns {
    fn detect(
        &self,
        provider: &str,
        configured_path: Option<&str>,
    ) -> Result<SubscriptionDetection, String> {
        push(&self.log, json!(["detect", provider, configured_path]));
        let given = &self.world["detections"][provider];
        if let Some(message) = given["throws"].as_str() {
            return Err(message.to_owned());
        }
        let mut detection = SubscriptionDetection::new(
            provider,
            given["state"].as_str().unwrap_or("not-installed"),
        );
        detection.version = text_of(&given["version"]);
        detection.login_method = text_of(&given["loginMethod"]);
        detection.plan_name = text_of(&given["planName"]);
        detection.error = text_of(&given["error"]);
        detection.program_path = text_of(&given["programPath"]);
        detection.login_kind = text_of(&given["loginKind"]);
        detection.account = text_of(&given["account"]);
        Ok(detection)
    }

    fn list_models(
        &self,
        provider: &str,
        configured_path: Option<&str>,
    ) -> Result<Vec<JsonValue>, String> {
        push(&self.log, json!(["listModels", provider, configured_path]));
        Ok(self.world["models"][provider]
            .as_array()
            .map(|list| list.iter().map(json_value_from_serde).collect())
            .unwrap_or_default())
    }

    fn locate(
        &self,
        provider: &str,
        configured_path: Option<&str>,
    ) -> Result<Option<SubscriptionProgram>, String> {
        push(&self.log, json!(["locate", provider, configured_path]));
        let given = &self.world["programs"][provider];
        let Some(command) = given["command"].as_str() else {
            return Ok(None);
        };
        Ok(Some(SubscriptionProgram {
            provider: provider.to_owned(),
            command: command.to_owned(),
            prefix_args: given["prefixArgs"]
                .as_array()
                .map(|list| list.iter().filter_map(text_of).collect())
                .unwrap_or_default(),
            env: given["env"]
                .as_object()
                .map(|env| {
                    env.iter()
                        .filter_map(|(k, v)| Some((k.clone(), text_of(v)?)))
                        .collect()
                })
                .unwrap_or_default(),
            entry: text_of(&given["entry"]).unwrap_or_else(|| command.to_owned()),
            source: text_of(&given["source"]).unwrap_or_else(|| "path".to_owned()),
        }))
    }
}

/// Inserts this port's factory and the fakes of its hosts, answering from
/// the case's `hosts.a` value; `log` is the case's host log
pub fn insert(hosts: &mut shell_contract::Hosts, case: &Value, log: Option<Log>) {
    let world = case["subscription"].clone();
    hosts.insert(crate::subscription::factory());
    hosts.insert::<SubscriptionShellHost>(Arc::new(FakeShell {
        world: world.clone(),
        lang: case["lang"].as_str().unwrap_or("ko").to_owned(),
        log: log.clone(),
    }));
    hosts.insert::<SubscriptionStandInsHost>(Arc::new(FakeStandIns { world, log }));
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
