//! `packages/ai-provider/src/agent-session/messages.ts`: what a program is
//! told when the app or the person turns an action down. These go to the
//! model, not to the screen, so they are English and say what to do instead.

use super::agent_session_policy::AgentDenyReason;

/// `DECLINED_BY_PERSON`
pub const DECLINED_BY_PERSON: &str = "The person declined this action. Do not try it again in another way; ask them what to do instead.";

/// `denyMessage(reason)`
pub fn deny_message(reason: AgentDenyReason) -> &'static str {
    match reason {
        AgentDenyReason::OpenDocument => {
            "This file is open in the office app, which holds its current state. Do not write the file; change it with the seuoffice-editor tools instead."
        }
        AgentDenyReason::OutsideProject => {
            "Files outside the project folder cannot be written in this session. Write inside the project folder instead."
        }
        AgentDenyReason::ProtectedPath => {
            "This location is protected (sign-in data or app data) and cannot be used in this session."
        }
    }
}
