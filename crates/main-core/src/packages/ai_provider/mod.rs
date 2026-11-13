//! `packages/ai-provider/src`: what the main process uses of it, one file per
//! TypeScript file.
//!
//! The settings are JSON values ([`jscompat::JsonValue`]): the TypeScript
//! reads them as `unknown` from a file or from a renderer and builds new
//! objects from them, and the order of their keys shows in what the
//! comparison writes.

pub mod agent_policy;
pub mod agent_session_claude;
pub mod agent_session_policy;
pub mod agent_session_program_problem;
pub mod agent_session_skills;
pub mod ai_settings_guard;
pub mod custom_endpoints;
pub mod effort;
pub mod free_ai;
pub mod free_ai_browser;
pub mod free_connect;
pub mod image_backend;
pub mod jsval;
pub mod legacy_settings;
pub mod local_profile;
pub mod media;
pub mod media_active;
pub mod network_error;
pub mod overload_error;
pub mod protocols_shared;
pub mod provider_selection;
pub mod providers;
pub mod registry;
pub mod registry_vision;
pub mod run_error;
pub mod search_settings;
pub mod settings_secrets;
pub mod stored_settings;
pub mod subscription_contract;
pub mod subscription_locate;
pub mod subscription_process;
pub mod user_skill_md;
pub mod user_skills_folder;
pub mod user_skills_import;
pub mod user_skills_states;
pub mod watchdog;
