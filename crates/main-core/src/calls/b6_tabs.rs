//! The functions of group `b6-tabs` (tools/main-diff/groups/b6-tabs.ts).

use serde_json::Value;

use super::{Answer, Context};

pub(super) fn call(_name: &str, _args: &[Value], _cx: &mut Context) -> Option<Answer> {
    None
}
