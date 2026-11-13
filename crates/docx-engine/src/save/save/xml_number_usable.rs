//! The "usable number" half of xml-number.ts: a number from the document, a
//! node attribute or a peer, as drawing code may take it.

use crate::xml_number::{MAX_COORDINATE_EMU, xml_position_offset};

/// `EMU_PER_PX`
pub const EMU_PER_PX: f64 = 9525.0;

/// `DEFAULT_PICTURE_PX`: the side of a new picture whose own size is no
/// usable number, in px (one inch).
pub const DEFAULT_PICTURE_PX: f64 = 96.0;

/// `usableNumber`: `None` when `value` is no finite number or, times
/// `emu_per_unit`, lies beyond the widest drawing coordinate.
pub fn usable_number(value: f64, emu_per_unit: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }
    (f64::abs(value * emu_per_unit) <= MAX_COORDINATE_EMU).then_some(value)
}

/// `usablePictureSize`: both sides when both are usable and positive, else
/// the default square. Returns `(widthPx, heightPx)`.
pub fn usable_picture_size(width_px: f64, height_px: f64) -> (f64, f64) {
    match (
        usable_number(width_px, EMU_PER_PX),
        usable_number(height_px, EMU_PER_PX),
    ) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => (w, h),
        _ => (DEFAULT_PICTURE_PX, DEFAULT_PICTURE_PX),
    }
}

/// `usablePositionOffset`: `None` when `value * emu_per_unit` is no wp:posOffset.
pub fn usable_position_offset(value: f64, emu_per_unit: f64) -> Option<f64> {
    xml_position_offset(value * emu_per_unit).map(|_| value)
}
