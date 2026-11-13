//! `apps/shell/src/main/ai-naming-service.ts`: the channel the renderer's
//! "Name with AI..." button calls. The handler body is
//! [`suggest_file_name`]; `ipcMain.handle` stays in TypeScript.
//!
//! The AI settings file, the subscription statuses, the UI language and the
//! one-shot chat are [`NamingHost`]. The 30 second timer of `askModel` is the
//! caller's: it answers [`NamingHost::timed_out`] (the
//! `controller.signal.aborted` the TypeScript reads once the chat ended).
//!
//! Engine-waiting: `chatForProvider` (the provider transports).

use super::ai_naming::{build_naming_instruction, excerpt_for_naming, sanitize_file_stem};
use super::ai_naming_provider::{NamingTarget, resolve_naming_provider};
use crate::packages::ai_provider::jsval::{object, prop, text};
use crate::packages::ai_provider::settings_secrets::AiSecretCodec;
use jscompat::{JsObject, JsonValue, json_parse, trim};

/// `AI_NAMING_SUGGEST_CHANNEL`: the channel the renderer's "Name with AI..."
/// button calls.
pub const AI_NAMING_SUGGEST_CHANNEL: &str = "ai:suggest-file-name";

/// `NAMING_TIMEOUT_MS`: a naming call that has not answered by then is not
/// going to.
pub const NAMING_TIMEOUT_MS: f64 = 30_000.0;

/// `readAiSettingsFile()`: the file as it is on disk. `file` is what
/// `readFileSync` of `userData/ai-settings.json` gave, `None` where it threw.
/// No file yet, or one that is not JSON: the default settings, as for every
/// other reader.
pub fn read_ai_settings_file(file: Option<&str>) -> JsonValue {
    file.and_then(|text| json_parse(text).ok())
        .unwrap_or_else(|| JsonValue::Object(JsObject::new()))
}

/// What `chatForProvider` ended in.
#[derive(Debug, Clone, PartialEq)]
pub enum ChatOutcome {
    /// `{ ok: true, content }`; `content` is `undefined` for `None`
    Reply { content: Option<String> },
    /// `{ ok: false, error }`
    Failed { error: JsonValue },
    /// the promise rejected with this value
    Threw(JsonValue),
}

/// What the naming handler reaches outside this module.
pub trait NamingHost {
    /// `readFileSync(join(app.getPath('userData'), 'ai-settings.json'), 'utf8')`;
    /// `None` where it throws
    fn settings_file(&mut self) -> Option<String>;
    /// `sharedSubscriptionStatuses()`
    fn subscription_statuses(&mut self) -> JsonValue;
    /// `lang()` of `registerAiNamingIpc(lang)`
    fn ui_lang(&mut self) -> String;
    /// the codec of `settings-secrets`, when one is registered
    fn secret_codec(&self) -> Option<&dyn AiSecretCodec> {
        None
    }
    /// `chatForProvider(provider, config, '', instruction, signal)`
    fn chat(&mut self, provider: &str, config: &JsonValue, instruction: &str) -> ChatOutcome;
    /// `controller.signal.aborted`: the 30 second timer fired
    fn timed_out(&self) -> bool;
    /// `console.warn('[shell] file naming failed:', detail)`
    fn warn(&mut self, detail: &JsonValue);
}

/// `{ ok: false, reason }`
fn refusal(reason: &str) -> JsonValue {
    object(vec![
        ("ok", JsonValue::Bool(false)),
        ("reason", text(reason)),
    ])
}

/// `askModel(target, content, lang)`: ask the model for a name: a bare file
/// stem, or why it gave none.
fn ask_model(
    host: &mut dyn NamingHost,
    provider: &str,
    config: &JsonValue,
    content: &str,
    lang: &str,
) -> JsonValue {
    let instruction = build_naming_instruction(&excerpt_for_naming(content, None), lang);
    // a provider cut off by the timer rejects or reports a failed reply,
    // depending on the provider: either way the reason is the timer, not the
    // provider
    let out = match host.chat(provider, config, &instruction) {
        ChatOutcome::Failed { error } => {
            host.warn(&error);
            return refusal(if host.timed_out() {
                "timeout"
            } else {
                "failed"
            });
        }
        ChatOutcome::Threw(err) => {
            host.warn(&err);
            return refusal(if host.timed_out() {
                "timeout"
            } else {
                "failed"
            });
        }
        ChatOutcome::Reply { content } => content.unwrap_or_default(),
    };
    // a model that wrapped the name in a sentence still gets one usable line
    let first_line = out
        .split('\n')
        .find(|line| !trim(line).is_empty())
        .unwrap_or("");
    let name = sanitize_file_stem(first_line);
    // A stem that sanitised away to empty is a *failed* naming, not a
    // successful one handing back "".
    if name.is_empty() {
        refusal("empty-name")
    } else {
        object(vec![("ok", JsonValue::Bool(true)), ("name", text(name))])
    }
}

/// The handler of [`AI_NAMING_SUGGEST_CHANNEL`]: what the channel answers: a
/// name, or why there is none. `input` is the renderer's payload.
pub fn suggest_file_name(host: &mut dyn NamingHost, input: Option<&JsonValue>) -> JsonValue {
    let content = match input.and_then(|i| prop(i, "content")) {
        Some(JsonValue::String(content)) => content.as_str(),
        _ => "",
    };
    if trim(content).is_empty() {
        return refusal("empty-content");
    }
    // decided before anything is built for the model: a refusal sends nothing
    let stored = read_ai_settings_file(host.settings_file().as_deref());
    let statuses = host.subscription_statuses();
    let target = resolve_naming_provider(host.secret_codec(), Some(&stored), &statuses);
    match target {
        NamingTarget::Ok { provider, config } => {
            let lang = host.ui_lang();
            ask_model(host, &provider, &config, content, &lang)
        }
        refused => refused.to_json(),
    }
}
