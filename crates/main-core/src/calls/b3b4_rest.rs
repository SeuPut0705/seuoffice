//! The functions of group `b3b4-rest` (tools/main-diff/groups/b3b4-rest.ts):
//! the last modules of batches B3 and B4 of decision 0030. The shell's file
//! index and folder tree, the shell's document links, drops and headless
//! export, the editors' recovery modules and the slides transaction core.
//! One part per spec part of `groups/b3b4-rest/`.

mod index_core;
mod index_store;
mod recovery;
mod shell_rest;

use serde_json::Value;

use super::{Answer, Context};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    index_core::call(name, args, cx)
        .or_else(|| index_store::call(name, args, cx))
        .or_else(|| shell_rest::call(name, args, cx))
        .or_else(|| recovery::call(name, args, cx))
}
