//! The functions of group `b5-mcp` (tools/main-diff/groups/b5-mcp.ts): the MCP
//! server, its tools, the MCP client and the agent session's MCP side, with
//! the ports of `@modelcontextprotocol/sdk` and zod they stand on. One
//! submodule per slice, as the spec has one file per slice.

mod agent;
mod client_files;
mod client_net;
mod client_proc;
mod client_pure;
mod client_sdk;
mod deps;
mod hub;
mod mcp_pure;
mod server;
mod tools_apps;
mod tools_docs;
mod zod;

use serde_json::Value;

use super::{Answer, Context};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    const SLICES: &[fn(&str, &[Value], &mut Context) -> Option<Answer>] = &[
        zod::call,
        deps::call,
        client_pure::call,
        client_files::call,
        mcp_pure::call,
        server::call,
        client_sdk::call,
        tools_docs::call,
        tools_apps::call,
        client_proc::call,
        client_net::call,
        hub::call,
        agent::call,
    ];
    SLICES.iter().find_map(|slice| slice(name, args, cx))
}
