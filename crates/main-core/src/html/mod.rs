//! `apps/html/src/main`: the modules that hold no Electron object (decision 0029),
//! one file per TypeScript file.

pub mod asset_lifecycle;
pub mod asset_mime;
pub mod atomic_write;
pub mod generate_handoff_ipc;
pub mod marked_html;
pub mod old_names;
pub mod preview_document;
pub mod preview_protocol;
pub mod single_file_html;
