//! The functions of group `b3-projects` (tools/main-diff/groups/b3-projects.ts):
//! `apps/shell/src/main/projects/` and the pieces of `packages/project-store`
//! it calls. Each part dispatches the modules of one spec part
//! (`groups/b3-projects-<part>.ts`).

mod cloud;
mod foundation;

use serde_json::Value;

use super::{Answer, Context};

type Part = fn(&str, &[Value], &mut Context) -> Option<Answer>;

const PARTS: &[Part] = &[foundation::call, cloud::call];

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    PARTS.iter().find_map(|part| part(name, args, cx))
}
