//! Batch 5's agent, skill, generate and editor AI modules (group `b5-agent`),
//! one table per part.

mod apps;
mod generate;
mod sessions;
mod skills;
mod slides_ai;
mod user_skills;

use serde_json::Value;

use super::{Answer, Context, Group};

const PARTS: &[Group] = &[
    sessions::call,
    skills::call,
    user_skills::call,
    generate::call,
    slides_ai::call,
    apps::call,
];

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    PARTS.iter().find_map(|part| part(name, args, cx))
}
