//! The pieces of `packages/*` that the ported main-process modules call, each
//! under the name of its package and file.

pub mod agent_core;
pub mod ai_provider;
pub mod ai_search;
pub mod cli;
pub mod cli_agent_skills;
pub mod cli_install;
pub mod compound_file;
pub mod drawio_model;
pub mod electron_utils;
pub mod file_parse;
pub mod font_metrics;
pub mod google_drive;
pub mod i18n;
pub mod mcp_sdk;
pub mod pdf_structure;
pub mod pipelines;
pub mod project_store;
pub mod ui;
pub mod xlsx_gateway;
pub mod zod;
