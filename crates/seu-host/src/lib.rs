//! Steps an engine leaves to the host that loads it, by name, with JSON in and
//! out: PDF text (pdfjs), what parse5 gives, and the readers of the engines not
//! ported yet. In the wasm build each step is the import
//! `seu_host.host_call(name_ptr, name_len, input_ptr, input_len) -> u32`, which
//! runs the step on the host, keeps its answer and returns the answer's length
//! in bytes, then `seu_host.host_take(out_ptr)`, which copies that answer into
//! this module's memory. The answer is `{"ok": value}` or
//! `{"error": {"name": ..., "message": ...}}`, the error the host's step threw.
//! A host that instantiates the module must supply both imports.
//!
//! A native build has no such host: every step answers [`HostError`] with the
//! name `HostUnavailable`, until the central process supplies its own.

use serde_json::Value;

/// What a step of the host threw, or that no host can take the step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostError {
    pub name: String,
    pub message: String,
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.name, self.message)
    }
}

impl std::error::Error for HostError {}

/// Runs the host's step `name` on `input`.
pub fn call(name: &str, input: &Value) -> Result<Value, HostError> {
    let answer = raw_call(name, &input.to_string())?;
    let mut answer: Value = serde_json::from_str(&answer).map_err(|error| HostError {
        name: "HostProtocolError".to_owned(),
        message: format!("the answer of {name} is not JSON: {error}"),
    })?;
    if let Some(value) = answer.get_mut("ok") {
        return Ok(value.take());
    }
    let error = answer.get("error");
    let field = |key: &str| {
        error
            .and_then(|error| error.get(key))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    Err(HostError {
        name: field("name"),
        message: field("message"),
    })
}

#[cfg(target_arch = "wasm32")]
fn raw_call(name: &str, input: &str) -> Result<String, HostError> {
    #[link(wasm_import_module = "seu_host")]
    unsafe extern "C" {
        fn host_call(
            name_ptr: *const u8,
            name_len: u32,
            input_ptr: *const u8,
            input_len: u32,
        ) -> u32;
        fn host_take(out_ptr: *mut u8);
    }
    // SAFETY: the host reads the two strings in place and writes exactly the
    // number of bytes it returned into the buffer of that length
    let length = unsafe {
        host_call(
            name.as_ptr(),
            name.len() as u32,
            input.as_ptr(),
            input.len() as u32,
        )
    };
    let mut answer = vec![0u8; length as usize];
    unsafe { host_take(answer.as_mut_ptr()) };
    String::from_utf8(answer).map_err(|error| HostError {
        name: "HostProtocolError".to_owned(),
        message: format!("the answer of {name} is not UTF-8: {error}"),
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn raw_call(name: &str, _input: &str) -> Result<String, HostError> {
    Err(HostError {
        name: "HostUnavailable".to_owned(),
        message: format!("{name} is a step of the host, and a native build has none"),
    })
}
