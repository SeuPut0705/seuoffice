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

/// `String(err)`, as `Error.prototype.toString`: `name: message`, or the
/// one of the two that is not empty. A thrown non-Error value (no name) is
/// its message.
impl fmt::Display for IpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.name.as_deref() {
            Some(name) if !name.is_empty() && !self.message.is_empty() => {
                write!(f, "{name}: {}", self.message)
            }
            Some(name) if !name.is_empty() => f.write_str(name),
            _ => f.write_str(&self.message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::IpcError;

    fn err(name: Option<&str>, message: &str) -> String {
        IpcError {
            name: name.map(Into::into),
            message: message.into(),
        }
        .to_string()
    }

    #[test]
    fn reads_like_error_to_string() {
        assert_eq!(err(Some("Error"), "boom"), "Error: boom");
        assert_eq!(err(Some("Error"), ""), "Error");
        assert_eq!(err(Some(""), "boom"), "boom");
        assert_eq!(err(Some(""), ""), "");
        assert_eq!(err(None, "a string was thrown"), "a string was thrown");
    }
}
