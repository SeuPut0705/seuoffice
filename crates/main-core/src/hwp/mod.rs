//! `apps/hwp/src/main`: the modules that hold no Electron object (decision 0029),
//! one file per TypeScript file.
//!
//! `hwp5_file` (with `cfb`, the part of the SheetJS container library it uses,
//! and `zlib`) is `hwp5-file.ts`, which `field_kinds`, `section_tails` and
//! `tab_widths` stand on; `ipc` is the part of `src/shared/ipc.ts` they use.

pub mod ai_image;
pub mod atomic_write;
pub mod cfb;
pub mod dialog_strings;
pub mod field_kinds;
pub mod hwp5_file;
pub mod ipc;
pub mod print_document;
pub mod recovery;
pub mod save_as_formats;
pub mod save_fixes;
pub mod save_plan;
pub mod section_tails;
pub mod tab_widths;
pub mod zlib;
