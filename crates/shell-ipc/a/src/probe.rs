//! The fake every port is under `probe`: it answers a channel from the
//! case's `hosts.a` value.
//!
//! `hosts.a.<channel>` is the answer as plain JSON; `{"$throw": message}`
//! rejects with `Error: message`; a channel the case does not name answers
//! `undefined`.

pub mod drive;
pub mod integrations;
pub mod knowledge_base;
pub mod zotero;

use shell_contract::ipc::Responder;
use shell_contract::{IpcError, IpcValue};

pub struct Fake {
    answers: serde_json::Value,
}

impl Fake {
    pub fn new(case: &serde_json::Value) -> Self {
        Fake {
            answers: case.clone(),
        }
    }

    pub fn answer(&self, channel: &str, reply: Responder) {
        let answer = match self.answers.get(channel) {
            None => Ok(IpcValue::Undefined),
            Some(serde_json::Value::Object(o)) if o.len() == 1 && o.contains_key("$throw") => {
                Err(IpcError {
                    name: Some("Error".into()),
                    message: o["$throw"].as_str().unwrap_or_default().to_owned(),
                })
            }
            Some(value) => Ok(from_json(value)),
        };
        reply.reply(answer)
    }
}

fn from_json(value: &serde_json::Value) -> IpcValue {
    match value {
        serde_json::Value::Null => IpcValue::Null,
        serde_json::Value::Bool(b) => IpcValue::Bool(*b),
        serde_json::Value::Number(n) => IpcValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        serde_json::Value::String(s) => IpcValue::String(s.clone()),
        serde_json::Value::Array(a) => IpcValue::Array(a.iter().map(from_json).collect()),
        serde_json::Value::Object(o) => {
            IpcValue::Object(o.iter().map(|(k, v)| (k.clone(), from_json(v))).collect())
        }
    }
}

/// The case's host log (tools/ipc-diff/README.md)
pub type Log = std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>;

fn push(log: &Option<Log>, line: serde_json::Value) {
    if let Some(log) = log {
        log.lock().expect("the log").push(line);
    }
}

/// `ShellUi` of the shell entry: `hosts.a.documentLocale` (`ko` by default);
/// bringing the shell window forward logs one line
pub struct FakeShellUi {
    locale: String,
    log: Option<Log>,
}

impl FakeShellUi {
    pub fn new(case: &serde_json::Value, log: Option<Log>) -> Self {
        FakeShellUi {
            locale: case["documentLocale"].as_str().unwrap_or("ko").to_owned(),
            log,
        }
    }
}

impl crate::shell_ai_prefs::ShellUi for FakeShellUi {
    fn document_locale(&self) -> String {
        self.locale.clone()
    }

    fn show_home_tab(&self) {
        push(&self.log, serde_json::json!(["shellWindow.showHomeTab"]));
    }
}

/// `currentLang()`: `hosts.a.lang` (`ko` by default)
fn case_lang(case: &serde_json::Value) -> main_core::packages::i18n::Lang {
    main_core::packages::i18n::normalize_lang(Some(case["lang"].as_str().unwrap_or("ko")))
}

/// The shell entry's values for outbound-confirm
pub struct FakeOutboundShell(main_core::packages::i18n::Lang);

impl FakeOutboundShell {
    pub fn new(case: &serde_json::Value) -> Self {
        FakeOutboundShell(case_lang(case))
    }
}

impl crate::outbound::OutboundShell for FakeOutboundShell {
    fn lang(&self) -> main_core::packages::i18n::Lang {
        self.0
    }
}
