//! `apps/shell/src/main/generate`: the generate window, its sessions and
//! conversions. `handoff.ts` re-exports
//! [`crate::packages::electron_utils::generate_handoff`].

pub mod convert;
pub mod converted_tab;
pub mod generate_api;
pub mod generate_window;
pub mod limits;
pub mod materials;
pub mod open_materials;
pub mod request;
pub mod session;
pub mod title_bar;
