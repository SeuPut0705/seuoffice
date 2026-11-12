//! The functions of group `b5-ai` (tools/main-diff/groups/b5-ai.ts).

use super::{Answer, Context};
use serde_json::Value;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let _ = (name, args, cx);
    None
}
