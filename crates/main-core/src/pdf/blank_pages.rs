//! `apps/pdf/src/main/blank-pages.ts`: blank-page candidates of an open
//! document (the PDF tools window, decision 0030). Runs on the [`Pdfium`]
//! surface the caller owns; the TypeScript's `BlankPagesPdfium` is the part of
//! it these calls need.

use super::pdfium::{Pdfium, subarray};
use jscompat::{math_max, math_min, math_round};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlankReason {
    Empty,
    NearlyWhite,
}

impl BlankReason {
    pub fn as_str(self) -> &'static str {
        match self {
            BlankReason::Empty => "empty",
            BlankReason::NearlyWhite => "nearly-white",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PageThumb {
    pub width: f64,
    pub height: f64,
    /// BGRA, 4 bytes a pixel, no row padding
    pub bgra: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BlankPageCandidate {
    /// 1-based
    pub page: i32,
    pub reason: BlankReason,
    /// `None` (null) once MAX_THUMBS candidates have one
    pub thumb: Option<PageThumb>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BlankPagesResult {
    pub page_count: i32,
    pub candidates: Vec<BlankPageCandidate>,
}

/// pixels on the long side of the page render the judgement looks at
pub const RENDER_LONG_SIDE: f64 = 600.0;
/// pixels on the long side of a candidate's thumbnail
pub const THUMB_LONG_SIDE: f64 = 240.0;
/// candidates past this many come without a thumbnail (they travel between processes)
pub const MAX_THUMBS: usize = 120;

/// luminance (0-255) below which a pixel counts as ink
const INK_LUMA: f64 = 160.0;
/// share of each side left out: scanner shadows and punched holes sit there
const BORDER: f64 = 0.04;
/// square cells ink is gathered in, in render pixels
const CELL: f64 = 12.0;
/// a cell this full of ink holds a stroke, not a speck
const DENSE_CELL: f64 = 0.15;
/// most ink a nearly white page may have, as a share of the area inside the margins
const MAX_INK: f64 = 0.005;

/// FPDF_ANNOT: draw annotation appearances too, so a stamped page is not blank
const RENDER_FLAGS: i32 = 0x01;

/// whether a page's own text has a character that shows
fn has_visible_text<M: Pdfium + ?Sized>(m: &mut M, page: u32) -> bool {
    let text = m.fpdf_text_load_page(page);
    if text == 0 {
        return false;
    }
    let count = m.fpdf_text_count_chars(text);
    let mut found = false;
    for i in 0..count {
        let code = m.fpdf_text_get_unicode(text, i);
        // spaces, controls, no-break space and pdfium's generated hyphen/line markers
        if code > 0x20 && code != 0xa0 && code != 0xfffe && code != 0xfeff {
            found = true;
            break;
        }
    }
    m.fpdf_text_close_page(text);
    found
}

/// `bgra[at]`: `undefined` (NaN once used) past the end
fn px(bgra: &[u8], at: f64) -> f64 {
    if at < 0.0 {
        return f64::NAN;
    }
    bgra.get(at as usize).map_or(f64::NAN, |&b| f64::from(b))
}

/// Whether a rendered page (BGRA) is white but for scattered specks.
/// `stride` is `width * 4` when the caller left it out.
pub fn is_nearly_white(bgra: &[u8], width: f64, height: f64, stride: f64) -> bool {
    let x0 = (width * BORDER).floor();
    let y0 = (height * BORDER).floor();
    let x1 = width - x0;
    let y1 = height - y0;
    let cols = ((x1 - x0) / CELL).ceil();
    let rows = ((y1 - y0) / CELL).ceil();
    let mut cells = vec![0u32; (cols * rows).max(0.0) as usize];
    let mut ink = 0.0;
    let mut y = y0;
    while y < y1 {
        let row = y * stride;
        let cell_row = ((y - y0) / CELL).floor() * cols;
        let mut x = x0;
        while x < x1 {
            let at = row + x * 4.0;
            // BGRA; Rec. 601 luma
            let luma =
                0.114 * px(bgra, at) + 0.587 * px(bgra, at + 1.0) + 0.299 * px(bgra, at + 2.0);
            if luma < INK_LUMA {
                ink += 1.0;
                // a Uint32Array ignores a write past its end
                let cell = (cell_row + ((x - x0) / CELL).floor()) as usize;
                if let Some(count) = cells.get_mut(cell) {
                    *count += 1;
                }
            }
            x += 1.0;
        }
        y += 1.0;
    }
    let area = (x1 - x0) * (y1 - y0);
    if area <= 0.0 {
        return true;
    }
    if ink / area > MAX_INK {
        return false;
    }
    let dense = CELL * CELL * DENSE_CELL;
    for count in cells {
        if f64::from(count) >= dense {
            return false;
        }
    }
    true
}

/// a box-filtered copy of a BGRA bitmap scaled to `long_side`
pub fn shrink_bitmap(
    bgra: &[u8],
    width: f64,
    height: f64,
    stride: f64,
    long_side: f64,
) -> PageThumb {
    let scale = math_min(1.0, long_side / math_max(width, height));
    let w = math_max(1.0, math_round(width * scale));
    let h = math_max(1.0, math_round(height * scale));
    let mut out = vec![0u8; (w * h * 4.0) as usize];
    let mut ty = 0.0;
    while ty < h {
        let sy0 = ((ty * height) / h).floor();
        let sy1 = math_max(sy0 + 1.0, (((ty + 1.0) * height) / h).floor());
        let mut tx = 0.0;
        while tx < w {
            let sx0 = ((tx * width) / w).floor();
            let sx1 = math_max(sx0 + 1.0, (((tx + 1.0) * width) / w).floor());
            let mut b = 0.0;
            let mut g = 0.0;
            let mut r = 0.0;
            let mut n = 0.0;
            let mut y = sy0;
            while y < sy1 {
                let mut x = sx0;
                while x < sx1 {
                    let at = y * stride + x * 4.0;
                    b += px(bgra, at);
                    g += px(bgra, at + 1.0);
                    r += px(bgra, at + 2.0);
                    n += 1.0;
                    x += 1.0;
                }
                y += 1.0;
            }
            let to = ((ty * w + tx) * 4.0) as usize;
            // a Uint8Array element takes the double truncated, NaN as 0
            out[to] = (b / n) as u8;
            out[to + 1] = (g / n) as u8;
            out[to + 2] = (r / n) as u8;
            out[to + 3] = 255;
            tx += 1.0;
        }
        ty += 1.0;
    }
    PageThumb {
        width: w,
        height: h,
        bgra: out,
    }
}

/// a white thumbnail the shape of a page, for a page that draws nothing
fn white_thumb(page_w: f64, page_h: f64) -> PageThumb {
    let scale = THUMB_LONG_SIDE / math_max(math_max(page_w, page_h), 1.0);
    let width = math_max(1.0, math_round(page_w * scale));
    let height = math_max(1.0, math_round(page_h * scale));
    PageThumb {
        width,
        height,
        bgra: vec![255; (width * height * 4.0) as usize],
    }
}

/// The blank-page candidates of an open document, in page order
pub fn find_blank_pages<M: Pdfium + ?Sized>(
    m: &mut M,
    doc: u32,
    mut on_progress: Option<&mut dyn FnMut(i32, i32)>,
) -> BlankPagesResult {
    let page_count = m.fpdf_get_page_count(doc);
    let mut candidates: Vec<BlankPageCandidate> = Vec::new();
    let mut thumbs = 0usize;
    for index in 0..page_count {
        let page = m.fpdf_load_page(doc, index);
        if page == 0 {
            if let Some(progress) = on_progress.as_mut() {
                progress(index + 1, page_count);
            }
            continue;
        }
        judge_page(m, page, index, &mut candidates, &mut thumbs);
        m.fpdf_close_page(page);
        if let Some(progress) = on_progress.as_mut() {
            progress(index + 1, page_count);
        }
    }
    BlankPagesResult {
        page_count,
        candidates,
    }
}

fn judge_page<M: Pdfium + ?Sized>(
    m: &mut M,
    page: u32,
    index: i32,
    candidates: &mut Vec<BlankPageCandidate>,
    thumbs: &mut usize,
) {
    if has_visible_text(m, page) {
        return;
    }
    let page_w = m.fpdf_get_page_width_f(page);
    let page_h = m.fpdf_get_page_height_f(page);
    let want_thumb = *thumbs < MAX_THUMBS;
    if m.fpdf_page_count_objects(page) == 0 {
        candidates.push(BlankPageCandidate {
            page: index + 1,
            reason: BlankReason::Empty,
            thumb: want_thumb.then(|| white_thumb(page_w, page_h)),
        });
        if want_thumb {
            *thumbs += 1;
        }
        return;
    }
    let scale = RENDER_LONG_SIDE / math_max(math_max(page_w, page_h), 1.0);
    let width = math_max(1.0, math_round(page_w * scale));
    let height = math_max(1.0, math_round(page_h * scale));
    let bitmap = m.fpdf_bitmap_create(width as i32, height as i32, 0);
    if bitmap == 0 {
        return;
    }
    m.fpdf_bitmap_fill_rect(bitmap, 0, 0, width as i32, height as i32, 0xffff_ffff);
    m.fpdf_render_page_bitmap(
        bitmap,
        page,
        0,
        0,
        width as i32,
        height as i32,
        0,
        RENDER_FLAGS,
    );
    let stride = f64::from(m.fpdf_bitmap_get_stride(bitmap));
    let ptr = m.fpdf_bitmap_get_buffer(bitmap);
    // a view, not a copy: read before the bitmap is destroyed
    let start = u64::from(ptr);
    let end = start + (stride * height) as u64;
    let verdict = {
        let pixels = subarray(m.heap(), start, end);
        if is_nearly_white(pixels, width, height, stride) {
            Some(BlankPageCandidate {
                page: index + 1,
                reason: BlankReason::NearlyWhite,
                thumb: want_thumb
                    .then(|| shrink_bitmap(pixels, width, height, stride, THUMB_LONG_SIDE)),
            })
        } else {
            None
        }
    };
    m.fpdf_bitmap_destroy(bitmap);
    if let Some(candidate) = verdict {
        if want_thumb {
            *thumbs += 1;
        }
        candidates.push(candidate);
    }
}
