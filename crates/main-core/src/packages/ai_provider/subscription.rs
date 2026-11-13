//! `packages/ai-provider/src/subscription.ts`: the entry point of the shared
//! plumbing for the subscription CLIs (Claude Code, Codex): locating the
//! program, reading its connection status, building its environment, starting
//! and stopping it.
//!
//! The TypeScript file is `export * from './subscription/<name>'` for each of
//! its parts. A glob re-export of Rust modules would make equal names of two
//! parts ambiguous, so each part is re-exported as the module it is, under
//! the name the TypeScript path gives it.

pub use super::{
    subscription_contract as contract, subscription_env as env, subscription_ipc as ipc,
    subscription_launch as launch, subscription_leftovers as leftovers,
    subscription_locate as locate, subscription_metered as metered, subscription_models as models,
    subscription_process as process, subscription_service as service,
    subscription_status as status,
};
