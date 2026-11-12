//! Attachment readers. No filesystem, UI or engine dispatch belongs here.

pub mod attachable;
pub mod compound;
#[cfg(feature = "docx")]
pub mod docx;
#[cfg(feature = "redaction")]
pub mod markdown;
pub mod opc;
#[cfg(feature = "redaction")]
pub mod pptx_redaction;
#[cfg(feature = "redaction")]
pub mod redaction;
pub mod xlsx_dates;
pub mod zip_text_parts;
