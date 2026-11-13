//! The functions of group `b5-provider` (tools/main-diff/groups/b5-provider.ts):
//! the AI runtime of `packages/ai-provider/src` and `packages/google-drive/src`.
//! One submodule per part, as the spec has one file per part; `world` is the
//! scripted host the async functions run on.

mod agent;
mod anthropic;
mod chatgpt;
mod claude;
mod codex;
mod drive;
mod fetch;
mod keys;
mod launch;
mod media;
mod openai;
mod route;
mod subscription;
mod world;

use serde_json::Value;

use super::{Answer, Context};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    type Part = fn(&str, &[Value], &mut Context) -> Option<Answer>;
    const PARTS: &[Part] = &[
        fetch::call,
        openai::call,
        anthropic::call,
        keys::call,
        media::call,
        chatgpt::call,
        subscription::call,
        launch::call,
        codex::call,
        claude::call,
        agent::call,
        drive::call,
        route::call,
    ];
    PARTS.iter().find_map(|part| part(name, args, cx))
}
