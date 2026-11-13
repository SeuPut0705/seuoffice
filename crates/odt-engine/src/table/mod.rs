//! `table/index.ts`: the table layer of the ODT bridge: body tables, Hancom's
//! framed tables (`text:p > draw:frame > draw:text-box > table:table`) and
//! nested tables, both directions, with cell-level write-back and Hancom's
//! locked cells.

pub mod converter;
pub mod forward;
pub mod model;
pub mod odf_read;
pub mod ooxml_read;
pub mod protected;
pub mod reverse;

use crate::core::convert::ConversionRegistry;

pub use converter::{
    TableBlockConverter, TableFreeWriter, table_block_converter, table_free_writer,
};
pub use forward::*;
pub use model::*;
pub use odf_read::*;
pub use ooxml_read::*;
pub use protected::*;
pub use reverse::*;

/// `registerTableConverters`: registers the table owner: body tables and
/// framed-table paragraphs (both directions) and new tables. Register after
/// the text layer.
pub fn register_table_converters(registry: &mut ConversionRegistry) -> &mut ConversionRegistry {
    registry
        .add_block(table_block_converter())
        .add_free_writer(table_free_writer())
}
