//! `apps/slides/src/main/picture-frame.ts`.
//!
//! `process.platform === 'darwin'` of `DEFAULT_PICTURE_DPI` is the target
//! the code is built for.

use jscompat::{math_min, math_round};

use super::video_size::{Frame, Point, Size};

/// PowerPoint for Mac lays untagged bitmaps out at 2 px per point; Windows at 96 dpi.
pub const DEFAULT_PICTURE_DPI: f64 = if cfg!(target_os = "macos") {
    144.0
} else {
    96.0
};

const EMU_PER_PT: f64 = 12700.0;
/// Measured cap: every oversize landscape picture came in exactly 8.5 in wide.
const OVERSIZE_FIT_WIDTH_EMU: f64 = 612.0 * EMU_PER_PT;

/// `ImageDpi`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageDpi {
    pub x: f64,
    pub y: f64,
}

/// `PictureFrameOptions`
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct PictureFrameOptions {
    /// Anchor to center on instead of the slide center (drop point).
    pub center: Option<Point>,
    /// Smaller side is grown towards this, aspect preserved, never past the fit box.
    pub min_emu: Option<f64>,
}

/// `pictureFrame(slide, naturalPx, dpi, fallbackDpi, options)`
pub fn picture_frame(
    slide: Size,
    natural_px: Option<Size>,
    dpi: Option<ImageDpi>,
    fallback_dpi: f64,
    options: PictureFrameOptions,
) -> Frame {
    let min_emu = options.min_emu.unwrap_or(0.0);
    let box_w = math_min(slide.width, OVERSIZE_FIT_WIDTH_EMU);
    let known = natural_px.filter(|n| n.width > 0.0 && n.height > 0.0);
    let w = known.map_or(box_w, |n| {
        (n.width / dpi.map_or(fallback_dpi, |d| d.x)) * 72.0 * EMU_PER_PT
    });
    let h = known.map_or((box_w * 3.0) / 4.0, |n| {
        (n.height / dpi.map_or(fallback_dpi, |d| d.y)) * 72.0 * EMU_PER_PT
    });
    let fit = math_min(box_w / w, slide.height / h);
    let mut scale = math_min(1.0, fit);
    let smaller = math_min(w, h) * scale;
    if smaller < min_emu {
        scale = math_min(fit, (scale * min_emu) / smaller);
    }
    let cx = math_round(w * scale);
    let cy = math_round(h * scale);
    let c = options.center.unwrap_or(Point {
        x: slide.width / 2.0,
        y: slide.height / 2.0,
    });
    Frame {
        x: math_round(c.x - cx / 2.0),
        y: math_round(c.y - cy / 2.0),
        cx,
        cy,
    }
}
