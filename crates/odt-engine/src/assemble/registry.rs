//! `assemble/registry.ts`: the converter registry every public entry point
//! uses, in the one order the layers were built for: text, tables, objects,
//! pages.
//!
//! Newer registrations win, so tables and objects take their nodes before the
//! text converter; the page layer's decorator of the text converter (same id
//! `text`) only takes what the text converter itself would take.

use crate::core::ConversionRegistry;
use crate::objects::register_object_converters;
use crate::page::register_page_converters;
use crate::table::register_table_converters;
use crate::text::register_text_converters;

/// `odtRegistry`
pub fn odt_registry() -> ConversionRegistry {
    let mut registry = ConversionRegistry::default();
    register_text_converters(&mut registry);
    register_table_converters(&mut registry);
    register_object_converters(&mut registry);
    register_page_converters(&mut registry);
    registry
}
