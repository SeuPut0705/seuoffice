//! `Command::Invoke`: a TypeScript export called by name with its arguments
//! positionally, as the `@seuoffice/docx-engine` binding makes it. The table
//! that answers it is generated (`table.rs`, from the export manifest); the
//! exports that have no row there are the hand routes of `routes.rs`. The
//! `pptx.` prefix is the pptx engine's table (`pptx_table.rs`, with the hand
//! routes of `pptx_routes.rs` and the argument kinds of `pptx.rs`).
//!
//! Crossings JSON cannot carry:
//! - A `Uint8Array` argument is `{"$blob": n}`, the request blob `n`; one that
//!   is returned is `{"$blob": n}` too, the reply blob `n`.
//! - A function argument is a callback: the header names it, `callbacks:
//!   { name: slot }`, and the engine calls it through `seu_host.host_callback`
//!   ([`host::call_host`]) with JSON in and JSON out, for the length of the call.
//! - The media converters that only the host has are answered two-pass
//!   ([`host::RecordingHost`]): a miss is recorded and the reply is
//!   `{ pending: [...] }`; the host converts and calls again with `resolved`.

use std::collections::HashMap;

use serde_json::{Map, Value};

pub mod host;
pub mod pptx;
pub mod pptx_routes;
pub mod pptx_table;
pub mod routes;
pub mod table;

/// What one `invoke` call has: its blobs, the host's callbacks and clock.
pub struct InvokeEnv<'a> {
    blobs: &'a [&'a [u8]],
    reply_blobs: Vec<Vec<u8>>,
    callbacks: HashMap<String, u32>,
    /// the host's clock (`Date.now()`) for the functions that stamp a time
    pub now_ms: f64,
    /// the converters the host answers, and the conversions it still owes
    pub media: host::RecordingHost,
}

impl<'a> InvokeEnv<'a> {
    pub fn new(
        blobs: &'a [&'a [u8]],
        callbacks: HashMap<String, u32>,
        now_ms: f64,
        media: host::RecordingHost,
    ) -> Self {
        Self {
            blobs,
            reply_blobs: Vec::new(),
            callbacks,
            now_ms,
            media,
        }
    }

    /// The request blob a `{"$blob": n}` names.
    pub fn blob(&self, value: &Value) -> Result<&'a [u8], String> {
        let index = value
            .get("$blob")
            .and_then(Value::as_u64)
            .ok_or("TypeError: expected a Uint8Array")?;
        self.blobs
            .get(index as usize)
            .copied()
            .ok_or_else(|| format!("blob {index} is missing"))
    }

    /// `bytes` as a reply blob; the `{"$blob": n}` that names it.
    pub fn put_blob(&mut self, bytes: Vec<u8>) -> Value {
        let index = self.reply_blobs.len();
        self.reply_blobs.push(bytes);
        let mut object = Map::new();
        object.insert("$blob".to_owned(), Value::from(index));
        Value::Object(object)
    }

    /// The reply blobs, in the order of their indexes.
    pub fn into_reply_blobs(self) -> (Vec<Vec<u8>>, host::RecordingHost) {
        (self.reply_blobs, self.media)
    }

    /// Calls the host function registered under `name` with `args`.
    pub fn callback(&self, name: &str, args: &Value) -> Result<Value, String> {
        let slot = self
            .callbacks
            .get(name)
            .ok_or_else(|| format!("no callback {name}"))?;
        host::call_host(*slot, args)
    }
}

/// `value` with every `{"$bytes": base64}` replaced by `{"$blob": n}`, the
/// bytes pushed on `blobs` at index `n`.
pub fn blobify(value: &mut Value, blobs: &mut Vec<Vec<u8>>) {
    match value {
        Value::Object(map) => {
            if map.len() == 1
                && let Some(text) = map.get("$bytes")
                && let Ok(bytes) = serde_json::from_value::<docx_engine::model::Bytes>(
                    Value::Object(Map::from_iter([("$bytes".to_owned(), text.clone())])),
                )
            {
                let index = blobs.len();
                blobs.push(bytes.0);
                *value = Value::Object(Map::from_iter([("$blob".to_owned(), Value::from(index))]));
                return;
            }
            for inner in map.values_mut() {
                blobify(inner, blobs);
            }
        }
        Value::Array(items) => {
            for inner in items {
                blobify(inner, blobs);
            }
        }
        _ => {}
    }
}
