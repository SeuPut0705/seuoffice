//! `apps/shell/src/main/mcp-client/limits.ts`: limits both kinds of user MCP
//! server share (user MCP spec 5.5): a remote connection and a "my PC" one
//! time a call the same way.

/// Each tool call and each tools/list page; a tunable default
pub const MCP_CALL_TIMEOUT_MS: f64 = 60_000.0;
