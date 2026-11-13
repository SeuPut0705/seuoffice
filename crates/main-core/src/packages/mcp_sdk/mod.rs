//! `@modelcontextprotocol/sdk` 1.32.1 (MIT, Anthropic PBC): the parts the
//! central process uses, ported without I/O. The TypeScript SDK owns sockets,
//! processes, timers and promises; here the protocol is a state machine on
//! [`jscompat::JsonValue`] and the caller carries out what it asks for, so the
//! JSON it writes is the JSON the TypeScript writes, key for key.
//!
//! What a peer sends is read as `JsonValue` and checked as the SDK's zod
//! schemas check it (`types::schema`), so a refusal carries the SDK's own
//! message.

pub mod auth;
pub mod client;
pub mod server;
pub mod sse_client;
pub mod sse_server;
pub mod stdio;
pub mod streamable_http_client;
pub mod streamable_http_server;
pub mod types;
