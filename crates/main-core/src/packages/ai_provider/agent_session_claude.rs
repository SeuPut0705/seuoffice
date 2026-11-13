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
