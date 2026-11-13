//! Group `b5-mcp`, slice `client_files`: see tools/main-diff/groups/b5-mcp/client-files.ts.

use serde_json::Value;

use super::super::{Answer, Context};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let _ = (name, args, cx);
    None
}
