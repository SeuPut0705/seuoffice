//! The functions of group `b2-remote` (tools/main-diff/groups/b2-remote.ts).

use super::{Answer, Context};
use serde_json::Value;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let _ = (args, cx);
    match name {
        _ => None,
    }
}
