//! The functions of group `node-fs` (tools/main-diff/groups/node-fs.ts).

use super::{Answer, Context};
use serde_json::Value;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let _ = (args, cx);
    match name {
        _ => None,
    }
}
