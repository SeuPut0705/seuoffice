//! `packages/pipelines/src/slides/cover-crop.ts`: center-crop fractions that
//! make an image fill a target frame without distortion (CSS object-fit:
//! cover).

use jscompat::math_max;

/// `{ l, t, r, b }`: the fractions of the image cut off at each side.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CoverCrop {
    pub l: f64,
    pub t: f64,
    pub r: f64,
    pub b: f64,
}

/// `!(x > 0)`: zero, negative or NaN.
fn unusable(x: f64) -> bool {
    x.is_nan() || x <= 0.0
}

/// `coverCropFractions(imageW, imageH, frameW, frameH)`: the image is scaled
/// uniformly until it covers the frame and the overflow on the long axis is
/// cropped symmetrically. `None` (`null`) when no crop is needed (aspect
/// ratios already match within 1%) or when any dimension is unusable.
pub fn cover_crop_fractions(
    image_w: f64,
    image_h: f64,
    frame_w: f64,
    frame_h: f64,
) -> Option<CoverCrop> {
    if unusable(image_w) || unusable(image_h) || unusable(frame_w) || unusable(frame_h) {
        return None;
    }
    let image_aspect = image_w / image_h;
    let frame_aspect = frame_w / frame_h;
    // compare relative to the larger aspect ratio so the "already matches" tolerance
    // is symmetric for wide vs. tall frames
    if (image_aspect - frame_aspect).abs() / math_max(image_aspect, frame_aspect) < 0.01 {
        return None;
    }
    if image_aspect > frame_aspect {
        let crop = (1.0 - frame_aspect / image_aspect) / 2.0;
        return Some(CoverCrop {
            l: crop,
            t: 0.0,
            r: crop,
            b: 0.0,
        });
    }
    let crop = (1.0 - image_aspect / frame_aspect) / 2.0;
    Some(CoverCrop {
        l: 0.0,
        t: crop,
        r: 0.0,
        b: crop,
    })
}
