//! `apps/docs/src/main`: the modules that hold no Electron object (decision 0029),
//! one file per TypeScript file.

pub mod ai_keepalive;
pub mod ai_run;
pub mod atomic_write;
pub mod byte_handoff;
pub mod copy_image_guard;
pub mod doc_format;
pub mod docs_recovery;
pub mod external_change;
pub mod free_ai_strings;
pub mod hwp_export;
pub mod hwp_export_strings;
pub mod lazy_media;
pub mod lazy_media_inline;
pub mod merge_output;
pub mod print_args;
pub mod read_url_ipc;
pub mod save_as_formats;
pub mod starred_files;
pub mod stream_coalesce;
pub mod updater;
pub mod zotero_wire;
