//! The central process of SeuOffice, ported from the Electron main process
//! (`apps/*/src/main`) one batch at a time (decision 0030). Each module sits
//! under the folder of the TypeScript it comes from and keeps its file name:
//! `shell/update_attempt.rs` is `apps/shell/src/main/update-attempt.ts`.
//!
//! The Electron main process loads it through `main-node` while Electron
//! stays; the Rust shell of stage 3 links it directly. Nothing here knows
//! about either: paths, clocks and loggers come from the caller.

pub mod calls;
pub mod diagram;
pub mod docs;
pub mod epub;
pub mod html;
pub mod html_parse;
pub mod hwp;
pub mod markdown;
pub mod mindmap;
pub mod node_fs;
pub mod packages;
pub mod pdf;
pub mod sheets;
pub mod shell;
pub mod slides;
