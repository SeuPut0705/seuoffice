//! `apps/shell/src/main/file-index`: the full-text index of the files under
//! the home folders, one file per TypeScript file.

pub mod extract;
pub mod extract_worker;
pub mod scan;
pub mod snippet;
pub mod tokenize;
