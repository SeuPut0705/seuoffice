//! What the engine asks of its host during one call: the callbacks of
//! `host_callback`, and the media converters the host answers two-pass.

use std::cell::RefCell;
use std::collections::HashMap;

use docx_engine::parse::drawings::host::MediaHost;
use serde::Serialize;
use serde_json::Value;

#[cfg(target_arch = "wasm32")]
mod import {
    #[link(wasm_import_module = "seu_host")]
    unsafe extern "C" {
        /// The callback registered under `slot` for the running call gets the
        /// UTF-8 text at `ptr`, `len` and answers text: written into memory
        /// the host allocates with `seu_alloc`, packed `(ptr << 32) | len`,
        /// and freed by the engine with `seu_free`. `u64::MAX`: no such
        /// callback, or it threw; the engine refuses the call.
        pub fn host_callback(slot: u32, ptr: *const u8, len: u32) -> u64;
    }
}

/// Calls the host callback `slot` with `args` as JSON; its JSON answer.
#[cfg(target_arch = "wasm32")]
pub fn call_host(slot: u32, args: &Value) -> Result<Value, String> {
    let input = serde_json::to_vec(args).map_err(|error| error.to_string())?;
    // SAFETY: `input` is live for the call and the host only reads it; a length
    // fits u32 (usize is 32 bits on wasm32).
    let packed = unsafe { import::host_callback(slot, input.as_ptr(), input.len() as u32) };
    if packed == u64::MAX {
        return Err("the host refused the callback".to_owned());
    }
    let (pointer, length) = ((packed >> 32) as u32, packed as u32);
    // SAFETY: the host wrote `length` bytes at `pointer`, memory it got from
    // `seu_alloc`; it is ours until `seu_free`.
    let answer =
        unsafe { std::slice::from_raw_parts(pointer as *const u8, length as usize) }.to_vec();
    // SAFETY: `pointer` and `length` are what `seu_alloc` handed out, freed once.
    unsafe { crate::seu_free(pointer as *mut u8, length) };
    serde_json::from_slice(&answer).map_err(|error| error.to_string())
}

/// There is no host outside the wasm build.
#[cfg(not(target_arch = "wasm32"))]
pub fn call_host(_slot: u32, _args: &Value) -> Result<Value, String> {
    Err("the host refused the callback".to_owned())
}

/// What the host answered for a conversion of an earlier pass.
#[derive(Debug, Clone)]
pub enum Resolved {
    /// the `null` of a failed or empty conversion
    Null,
    /// a data URL (EMF, WMF, TIFF)
    Text(String),
    /// the docx bytes of an alt-chunk's HTML
    Bytes(Vec<u8>),
}

/// A conversion the host owes: `id` names it for `resolved` on the next pass.
#[derive(Debug, Clone, Serialize)]
pub struct Pending {
    pub id: String,
    /// `metafile`, `tiff` or `altchunk`
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    /// the reply blob holding the input (the picture bytes, the HTML as UTF-8)
    pub blob: usize,
}

/// A conversion's input as recorded, before it has a reply blob.
pub struct Recorded {
    pub id: String,
    pub kind: &'static str,
    pub mime: Option<String>,
    pub input: Vec<u8>,
}

/// The wasm [`MediaHost`]: it converts nothing. What the host resolved on an
/// earlier pass answers; a miss answers `None` and is recorded, and the
/// parse that asked is run again once the host has converted.
#[derive(Default)]
pub struct RecordingHost {
    resolved: HashMap<String, Resolved>,
    alt_chunk_converter: bool,
    recorded: RefCell<Vec<Recorded>>,
}

/// FNV-1a over the parts of a conversion's input, as 16 hex digits and its length.
fn content_id(kind: &str, mime: &str, input: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in kind
        .bytes()
        .chain([0])
        .chain(mime.bytes())
        .chain([0])
        .chain(input.iter().copied())
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}{:x}", input.len())
}

impl RecordingHost {
    pub fn new(resolved: HashMap<String, Resolved>, alt_chunk_converter: bool) -> Self {
        Self {
            resolved,
            alt_chunk_converter,
            recorded: RefCell::new(Vec::new()),
        }
    }

    fn answer(&self, kind: &'static str, mime: &str, input: &[u8]) -> Option<&Resolved> {
        let id = content_id(kind, mime, input);
        if let Some(resolved) = self.resolved.get(&id) {
            return Some(resolved);
        }
        let mut recorded = self.recorded.borrow_mut();
        if !recorded.iter().any(|known| known.id == id) {
            recorded.push(Recorded {
                id,
                kind,
                mime: (!mime.is_empty()).then(|| mime.to_owned()),
                input: input.to_vec(),
            });
        }
        None
    }

    /// The conversions recorded and not resolved, in the order they were asked.
    pub fn take_recorded(&self) -> Vec<Recorded> {
        std::mem::take(&mut *self.recorded.borrow_mut())
    }
}

impl MediaHost for RecordingHost {
    fn metafile_to_data_url(&self, bytes: &[u8], mime: &str) -> Option<String> {
        match self.answer("metafile", mime, bytes)? {
            Resolved::Text(url) => Some(url.clone()),
            _ => None,
        }
    }

    fn tiff_to_data_url(&self, bytes: &[u8]) -> Option<String> {
        match self.answer("tiff", "", bytes)? {
            Resolved::Text(url) => Some(url.clone()),
            _ => None,
        }
    }

    fn has_alt_chunk_html_converter(&self) -> bool {
        self.alt_chunk_converter
    }

    fn alt_chunk_html_to_docx(&self, html: &str) -> Option<Vec<u8>> {
        match self.answer("altchunk", "", html.as_bytes())? {
            Resolved::Bytes(bytes) => Some(bytes.clone()),
            _ => None,
        }
    }
}
