//! `apps/pdf/src/main`: the modules that hold no Electron object (decision 0029),
//! one file per TypeScript file.

pub mod annot_delete;
pub mod annot_flatten;
pub mod atomic_write;
pub mod blank_pages;
pub mod child;
pub mod disk_watch;
pub mod edit_fonts;
pub mod export_images;
pub mod font_classes;
pub mod font_cmap;
pub mod font_locate;
pub mod font_similar;
pub mod font_subset;
pub mod generated_output;
pub mod image_edit;
pub mod node_io;
pub mod note_link;
pub mod ocr;
pub mod pdfium;
pub mod read_text;
pub mod redaction;
pub mod signature_store;
pub mod system_certificates;
pub mod wasm_path;
