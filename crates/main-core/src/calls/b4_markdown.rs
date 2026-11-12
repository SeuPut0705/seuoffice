//! The functions of group `b4-markdown` (tools/main-diff/groups/b4-markdown.ts).

use super::{Answer, Context};
use serde_json::Value;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let _ = (name, args, cx);
    None
}
