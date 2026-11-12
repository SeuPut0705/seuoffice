//! The functions of group `b4-slides` (tools/main-diff/groups/b4-slides.ts).

use super::{Answer, Context};
use serde_json::Value;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let _ = (name, args, cx);
    None
}
