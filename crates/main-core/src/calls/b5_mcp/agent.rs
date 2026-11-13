//! Group `b5-mcp`, slice `agent`: see tools/main-diff/groups/b5-mcp/agent.ts.

use serde_json::Value;

use super::super::{Answer, Context};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let _ = (name, args, cx);
    None
}
