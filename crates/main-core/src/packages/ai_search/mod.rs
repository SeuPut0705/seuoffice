//! `packages/ai-search/src`: the pure judgment of the shared web and image
//! search and the media tools, one file per TypeScript file. The network (the
//! search backends, the image and analysis providers, the Codex image
//! generator, the headless ledger) is engine-waiting and sits behind traits
//! the caller implements.

pub mod index;
pub mod media_call_abort;
pub mod media_tools;
pub mod search_tools;
pub mod tool_capabilities;
pub mod tool_routing;
