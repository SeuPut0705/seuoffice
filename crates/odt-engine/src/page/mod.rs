//! `page/index.ts`: the page layer of the ODT bridge: page layouts, master
//! pages (headers and footers), page runs and sections, both directions.
//!
//! Order:
//!   open: `register_text_converters`, `register_page_converters`, then
//!   `convert_odt_styles`, `convert_odt_body`, `convert_odt_page`,
//!   `build_bridge_docx`;
//!   save: `prepare_page_write_back`, `rebuild_odt_body`, `update_odt_styles`,
//!   `rctx.finish()`.

pub mod forward;
pub mod geometry;
pub mod hf;
pub mod model;
pub mod odf;
pub mod register;
pub mod reverse;
pub mod sectpr;

pub use forward::{convert_odt_page, default_master_page};
pub use geometry::{
    LayoutOverrides, PageGeometry, columns_of, layout_geometry, layout_overrides, odf_lengths,
};
pub use hf::{PageFieldRunWriter, pair_paragraphs};
pub use model::{
    DocxSection, HF_REGIONS, HfRegion, PAGE_EXT_KEY, PAGE_OWNER, PageExt, PageHfPart, PageRun,
    read_page_ext,
};
pub use odf::{edit_layout_xml, edit_master_xml};
pub use register::register_page_converters;
pub use reverse::prepare_page_write_back;
pub use sectpr::{
    build_sect_pr, inject_paragraph_sect_pr, paragraph_sect_pr, strip_paragraph_sect_pr,
};
