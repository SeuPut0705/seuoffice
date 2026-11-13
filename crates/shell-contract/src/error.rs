//! A failed `invoke`. Electron hands the renderer only the text of what the
//! handler threw, inside a fixed sentence; the bridge rebuilds that sentence
//! from this, so renderer code that matches error text keeps working.

use std::fmt;

/// What a handler threw: `throw new Error(message)` is `name: "Error"`. A
/// thrown non-Error value has no name and its `String(value)` as the message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IpcError {
    pub name: Option<String>,
    pub message: String,
}

impl IpcError {
    /// The renderer's rejection text: Electron's
    /// `Error invoking remote method '<channel>': <String(err)>`
    pub fn remote_message(&self, channel: &str) -> String {
        format!("Error invoking remote method '{channel}': {self}")
    }

    /// What Electron answers for a channel nobody registered
    pub fn no_handler(channel: &str) -> Self {
        IpcError {
            name: Some("Error".into()),
            message: format!("No handler registered for '{channel}'"),
        }
    }
}

/// `String(err)`: `name: message`, or the message alone
impl fmt::Display for IpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.name {
            Some(name) => write!(f, "{name}: {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}
