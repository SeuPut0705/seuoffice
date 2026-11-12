//! Drawings, VML, media and the settings parts.

pub mod media;
pub mod picture;
pub mod settings;
pub mod vml;

/// `EMU_PER_TWIP`
pub use crate::drawing_geometry::anchor::EMU_PER_TWIP;
/// `EMU_PER_PX`, `EMU_PER_PT`
pub use crate::xml_text::{EMU_PER_PT, EMU_PER_PX};
