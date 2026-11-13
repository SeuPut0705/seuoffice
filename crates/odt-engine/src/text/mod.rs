//! `text/index.ts`: the text layer of the ODT bridge: paragraphs, headings,
//! spans, lists, hyperlinks, form-field bookmarks and the common/default
//! styles, both directions.

pub mod align;
pub mod blocks;
pub mod lists;
pub mod markers;
pub mod paragraph_model;
pub mod paragraph_odf;
pub mod paragraph_ooxml;
pub mod props;
pub mod style_xml;
pub mod styles;
pub mod units;

pub use align::{TextAlignment, align_texts};
pub use blocks::{
    TEXT_OWNER, register_text_converters, text_block_converter, text_free_writer, write_text_items,
};
pub use lists::{list_instance, list_style_from_numbering, num_fmt_from_odf, num_fmt_to_odf};
pub use paragraph_model::{
    Frame, FrameSet, ParagraphModel, is_form_field_name, read_paragraph, runs_xml,
};
pub use paragraph_odf::{
    ParagraphWriteOptions, edited_paragraph_from_block, edited_paragraph_from_table_paragraph,
    original_model, paragraph_to_odf,
};
pub use paragraph_ooxml::{
    ParagraphOoxml, ParagraphOoxmlOptions, ParagraphStyleInfo, paragraph_style_info,
    paragraph_to_ooxml,
};
pub use props::*;
pub use style_xml::{StyleXmlEdit, edit_style_xml, new_style_xml, patch_start_tag};
pub use styles::{
    convert_odt_styles, docx_styles_by_id, ooxml_p_pr, ooxml_r_pr, read_ooxml_p_pr,
    read_ooxml_r_pr, style_entry_by_id, style_entry_for_odf, update_odt_styles,
};
pub use units::*;
