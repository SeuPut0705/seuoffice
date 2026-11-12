//! Drawings, VML, media and the settings parts.

pub mod diagram;
pub mod hf_textbox;
pub mod host;
pub mod image;
pub mod media;
pub mod picture;
pub mod settings;
pub mod textbox;
pub mod vml;

/// `EMU_PER_TWIP`
pub use crate::drawing_geometry::anchor::EMU_PER_TWIP;
/// `EMU_PER_PX`, `EMU_PER_PT`
pub use crate::xml_text::{EMU_PER_PT, EMU_PER_PX};
