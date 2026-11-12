//! The central process of SeuOffice, ported from the Electron main process
//! (`apps/*/src/main`) one batch at a time (decision 0029). Each module sits
//! under the folder of the TypeScript it comes from and keeps its file name:
//! `shell/update_attempt.rs` is `apps/shell/src/main/update-attempt.ts`.
//!
//! The Electron main process loads it through `main-node` while Electron
//! stays; the Rust shell of stage 3 links it directly. Nothing here knows
//! about either: paths, clocks and loggers come from the caller.

pub mod calls;
pub mod html;
pub mod node_fs;
pub mod packages;
pub mod shell;
