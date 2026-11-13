//! The feature writers of the write side (slice `features`): the redline of
//! two documents, the mail merge, content controls, the docProps and Zotero
//! parts, the chart, bibliography, theme and watermark writers.

pub mod chart_write;
pub mod compare;
pub mod content_control;
pub mod doc_properties_write;
pub mod index_exports;
pub mod mail_merge;
pub mod sources_write;
pub mod theme_write;
pub mod watermark_write;
pub mod zotero_doc_props;
