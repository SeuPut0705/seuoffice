//! The one batch-only host of the MCP hub: what a connection reaches outside
//! `main-core` and the shared hosts. The shell implements it (`reqwest`
//! blocking for the network, a JSON Schema validator for Ajv).
//!
//! Every method is called from a thread that may block (a connection's
//! actor or a worker), never from the core thread.

use std::sync::Arc;

use jscompat::JsonValue;
use main_core::packages::mcp_sdk::client::OutputCheck;
use main_core::packages::mcp_sdk::client::net::{FetchError, FetchInit, Headers};

/// The body of a response, read chunk by chunk (`response.body`)
pub trait NetBody: Send {
    /// the next chunk, waiting for it; `None` at the end of the body
    fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, FetchError>;
}

/// A `Response` whose headers are in
pub struct NetResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Headers,
    /// `response.url`, `""` when there is none
    pub url: String,
    pub redirected: bool,
    /// `response.type === 'opaqueredirect'`
    pub opaque_redirect: bool,
    /// `null` for a response without a body
    pub body: Option<Box<dyn NetBody>>,
}

pub trait McpNet: Send + Sync {
    /// `net.fetch(url, init)` (Electron's `net.fetch`, so the system proxy
    /// applies), answering once the headers are in. `init.redirect` is honoured
    /// as `fetch` does: `Manual` never follows a redirect (the answer is the
    /// 3xx itself, or an opaque redirect), `Follow` follows. `limit_ms` is
    /// `AbortSignal.timeout(limit_ms)`: the request fails with a `TimeoutError`
    /// when it passes before the headers are in. A refusal to connect is a
    /// `TypeError` (`FetchError::type_error`).
    fn fetch(
        &self,
        url: &str,
        init: &FetchInit,
        limit_ms: Option<f64>,
    ) -> Result<NetResponse, FetchError>;
    /// `ajv.compile(schema)` of a tool's `outputSchema`: the validator's
    /// number, or the message of the error compiling threw
    fn compile_output_schema(&self, schema: &JsonValue) -> Result<u64, String>;
    /// `validator(structuredContent)`
    fn validate_output(&self, validator: u64, structured_content: &JsonValue) -> OutputCheck;
}

pub type McpNetHost = Arc<dyn McpNet>;

/// What the shell entry knows that the hub is told: the language the person
/// uses and the app's version
pub trait McpShell: Send + Sync {
    /// `currentLang()`
    fn lang(&self) -> main_core::packages::i18n::Lang;
    /// `app.getVersion()`: what servers are told of this client (5.6)
    fn app_version(&self) -> String;
}

pub type McpShellHost = Arc<dyn McpShell>;
