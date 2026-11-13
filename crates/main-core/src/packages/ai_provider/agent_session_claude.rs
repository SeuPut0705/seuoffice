//! `packages/ai-provider/src/agent-session/claude.ts`: the app's MCP server
//! as an agent session sees it. Only what the MCP modules call is here: the
//! server's name and the tools of it a session gets.

/// `APP_MCP_SERVER_NAME`: the name of the app's MCP server for open
/// documents, as the programs see it. `agent-core/user-mcp/names.ts` holds
/// the same literal; there is one definition on this side.
pub use crate::packages::agent_core::user_mcp_names::APP_MCP_SERVER_NAME;

/// `AGENT_APP_MCP_TOOLS`: the tools of the app's MCP server an agent session
/// gets (spec 6.6): the open-document tools, the two file readers and the two
/// skill proposals.
pub const AGENT_APP_MCP_TOOLS: [&str; 13] = [
    "open_documents",
    "read_document",
    "insert_content",
    "replace_blocks",
    "apply_ops",
    "read_sheet",
    "apply_sheet_ops",
    "read_deck",
    "apply_slide_ops",
    "read_hwp",
    "read_pdf",
    "propose_skill",
    "propose_skill_install",
];

use std::collections::HashSet;

use jscompat::js_regex;

use super::agent_session_types::AgentMcpRelay;

/// `isAgentAppMcpTool(name)`: a tool name of the app's server, bare or as a
/// program prefixes it, is one the session gets
pub fn is_agent_app_mcp_tool(name: &str) -> bool {
    let prefix = format!("mcp__{APP_MCP_SERVER_NAME}__");
    let bare = name.strip_prefix(prefix.as_str()).unwrap_or(name);
    AGENT_APP_MCP_TOOLS.contains(&bare)
}

/// `RELAY_NAME.test(name)`: a relay name both programs can carry in a tool
/// name: the user MCP server-name shape (letters, digits, `-`, `_`; no `__`,
/// no `_` at an edge)
fn is_relay_name(name: &str) -> bool {
    js_regex!(r"^(?!_)(?!.*__)[A-Za-z0-9_-]+(?<!_)$").test(name)
}

/// `agentUsableRelays(relays)`: the relays a session can use (user MCP spec
/// 9): each with a name of the server-name shape that is not the app's own
/// server, once (names compared without case). The start checks, the MCP
/// configuration and the permission rules all read this one list.
pub fn agent_usable_relays(relays: Option<&[AgentMcpRelay]>) -> Vec<AgentMcpRelay> {
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(APP_MCP_SERVER_NAME.to_lowercase());
    let mut out: Vec<AgentMcpRelay> = Vec::new();
    for relay in relays.unwrap_or(&[]) {
        let key = relay.name.to_lowercase();
        if !is_relay_name(&relay.name) || seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        out.push(relay.clone());
    }
    out
}
