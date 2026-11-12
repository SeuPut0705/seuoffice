//! parse.ts, ported leaf first: each module holds the functions of one part
//! of the reader, compared one by one as group `parse` of comparison (f) with
//! the arguments `parseDocx` calls them with over the corpus.

pub mod drawings;
mod entry;
pub mod tables;
pub mod text;

pub use entry::{ParseOptions, parse_docx, parse_docx_full};
