//! The fake every port is under `probe`: it answers a channel from the
//! case's `hosts.a` value.
//!
//! `hosts.a.<channel>` is the answer as plain JSON; `{"$throw": message}`
//! rejects with `Error: message`; a channel the case does not name answers
//! `undefined`.

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
