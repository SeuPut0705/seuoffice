//! `apps/shell/src/main/agent`: the agent window, its sessions and skills,
//! and the MCP side of an agent session. `agent_api` is the runtime part of
//! `apps/shell/src/shared/agent-api.ts`.

pub mod agent_api;
pub mod agent_mcp;
pub mod agent_mcp_relay;
pub mod agent_session_folders;
pub mod agent_sessions;
pub mod agent_skills;
pub mod agent_window;
pub mod project_skills;
