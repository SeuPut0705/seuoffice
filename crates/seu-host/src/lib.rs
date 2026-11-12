//! Steps an engine leaves to the host that loads it, by name, with JSON in and
//! out: what parse5 gives, the draw.io readers, and the readers of the engines
//! not ported yet. In the wasm build a step goes through the callback slot 0 of
//! `seu_host.host_callback(slot, ptr, len)`, the import the loader
//! (`@seuoffice/engine-wasm`) supplies for every engine: the input is
//! `{"name": ..., "input": ...}`, the answer `{"ok": value}` or
//! `{"error": {"name": ..., "message": ...}}`, the error the host's step threw.
//! The host writes the answer into memory it got from `seu_alloc` and this
//! crate frees it. A call that registered no slot 0 is refused: [`HostError`]
//! with the name `HostUnavailable`.
//!
//! A native build has no such host: every step answers `HostUnavailable`.

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

/// The callback slot the loader reserves for host steps.
#[cfg(target_arch = "wasm32")]
const HOST_STEP_SLOT: u32 = 0;

#[cfg(target_arch = "wasm32")]
fn raw_call(name: &str, input: &str) -> Result<String, HostError> {
    #[link(wasm_import_module = "seu_host")]
    unsafe extern "C" {
        /// The callback registered under `slot` for the running call gets the
        /// UTF-8 text at `ptr`, `len` and answers text, written into memory
        /// the host got from `seu_alloc`, packed `(ptr << 32) | len`.
        /// `u64::MAX`: no such callback, or it threw.
        fn host_callback(slot: u32, ptr: *const u8, len: u32) -> u64;
    }
    let request = format!(
        "{{\"name\":{},\"input\":{input}}}",
        serde_json::Value::String(name.to_owned())
    );
    // SAFETY: the host only reads `request` during the call; a length fits u32 on wasm32
    let packed =
        unsafe { host_callback(HOST_STEP_SLOT, request.as_ptr(), request.len() as u32) };
    if packed == u64::MAX {
        return Err(HostError {
            name: "HostUnavailable".to_owned(),
            message: format!("{name} is a step of the host, and this call has no host steps"),
        });
    }
    let (pointer, length) = ((packed >> 32) as usize, packed as u32 as usize);
    // SAFETY: the host wrote `length` bytes at `pointer`, a buffer `seu_alloc`
    // made as a boxed slice of exactly that length; it is freed here, once
    let answer = unsafe {
        Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            pointer as *mut u8,
            length,
        ))
    };
    String::from_utf8(answer.into_vec()).map_err(|error| HostError {
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
