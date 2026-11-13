//! `apps/shell/src/main/mcp-client`: the person's own MCP servers (local
//! programs and remote addresses), their store, sign-in and the hub that
//! offers their tools (group `b5-mcp`).

pub mod address;
pub mod fingerprint;
pub mod hub;
pub mod hub_app;
pub mod hub_input;
pub mod hub_ipc;
pub mod hub_strings;
pub mod limits;
pub mod listing;
pub mod local;
pub mod local_launch;
pub mod oauth;
pub mod oauth_loopback;
pub mod paste;
pub mod remote;
pub mod runtime_archive;
pub mod runtime_pins;
pub mod runtimes;
pub mod secrets;
pub mod store;
pub mod toml;
