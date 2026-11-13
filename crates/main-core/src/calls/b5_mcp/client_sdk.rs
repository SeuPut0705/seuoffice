//! Group `b5-mcp`, slice `client_sdk`: see tools/main-diff/groups/b5-mcp/client-sdk.ts.

use serde_json::Value;

use super::super::{Answer, Context};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let _ = (args, cx);
    match name {
        _ => None,
    }
}
