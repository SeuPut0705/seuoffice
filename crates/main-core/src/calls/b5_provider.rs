//! The functions of group `b5-provider` (tools/main-diff/groups/b5-provider.ts):
//! the AI runtime of `packages/ai-provider/src` and `packages/google-drive/src`.
//! One submodule per part, as the spec has one file per part; `world` is the
//! scripted host the async functions run on.

mod fetch;
mod world;

use serde_json::Value;

use super::{Answer, Context};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    const PARTS: &[fn(&str, &[Value], &mut Context) -> Option<Answer>] = &[fetch::call];
    PARTS.iter().find_map(|part| part(name, args, cx))
}
