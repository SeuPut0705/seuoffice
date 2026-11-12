//! `apps/slides/src/main/video-size.ts`.

use jscompat::{math_min, math_round};

pub use super::mp4_audio_sniff::VideoSize as Size;
use super::mp4_audio_sniff::mp4_video_size;

/// `videoSize(bytes, ext)`: frame size of a video container we know how to embed
pub fn video_size(bytes: &[u8], ext: &str) -> Option<Size> {
    match ext.to_lowercase().as_str() {
        "mp4" | "m4v" | "mov" => mp4_video_size(bytes),
        "webm" | "mkv" => webm_video_size(bytes),
        "avi" => avi_video_size(bytes),
        _ => None,
    }
}

const EMU_PER_PX: f64 = 12700.0;

/// `Point`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// `{ x, y, cx, cy }`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub cx: f64,
    pub cy: f64,
}

/// `videoFrame(slide, natural, center)`
pub fn video_frame(slide: Size, natural: Option<Size>, center: Option<Point>) -> Frame {
    let known = natural.filter(|n| n.width > 0.0 && n.height > 0.0);
    let w = known.map_or(slide.width, |n| n.width * EMU_PER_PX);
    let h = known.map_or((slide.width * 9.0) / 16.0, |n| n.height * EMU_PER_PX);
    // Math.min(1, slide.width / w, slide.height / h)
    let scale = math_min(math_min(1.0, slide.width / w), slide.height / h);
    centered_frame(slide, math_round(w * scale), math_round(h * scale), center)
}

const AUDIO_ICON_EMU: f64 = 64.0 * EMU_PER_PX;

/// `audioFrame(slide, center)`
pub fn audio_frame(slide: Size, center: Option<Point>) -> Frame {
    centered_frame(slide, AUDIO_ICON_EMU, AUDIO_ICON_EMU, center)
}

fn centered_frame(slide: Size, cx: f64, cy: f64, center: Option<Point>) -> Frame {
    let c = center.unwrap_or(Point {
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

// ── EBML (webm/mkv) ──────────────────────────────────────────────────────

const EBML_CLUSTER: f64 = 0x1f43_b675_u32 as f64;
const EBML_SEGMENT: f64 = 0x1853_8067_u32 as f64;
const EBML_TRACKS: f64 = 0x1654_ae6b_u32 as f64;
const EBML_TRACK_ENTRY: f64 = 0xae as f64;
const EBML_VIDEO: f64 = 0xe0 as f64;
const EBML_PIXEL_WIDTH: f64 = 0xb0 as f64;
const EBML_PIXEL_HEIGHT: f64 = 0xba as f64;
const EBML_DISPLAY_WIDTH: f64 = 0x54b0 as f64;
const EBML_DISPLAY_HEIGHT: f64 = 0x54ba as f64;

fn is_container(id: f64) -> bool {
    id == EBML_SEGMENT || id == EBML_TRACKS || id == EBML_TRACK_ENTRY || id == EBML_VIDEO
}

/// A read past the end is `undefined` in the TypeScript
fn byte(bytes: &[u8], off: u64) -> Option<u8> {
    usize::try_from(off)
        .ok()
        .and_then(|i| bytes.get(i))
        .copied()
}

struct Vint {
    value: f64,
    len: u64,
}

/// Reads a vint; ids keep the length marker, sizes strip it. All-ones size = unknown (-1).
fn vint(bytes: &[u8], off: u64, end: u64, keep_marker: bool) -> Option<Vint> {
    if off >= end {
        return None;
    }
    let first = u32::from(byte(bytes, off).unwrap_or(0));
    let mut len: u32 = 1;
    while len <= 8 && (first & (0x80 >> (len - 1))) == 0 {
        len += 1;
    }
    if len > 8 || off + u64::from(len) > end {
        return None;
    }
    let mut value = if keep_marker {
        f64::from(first)
    } else {
        f64::from(first & (0xffu32 >> len))
    };
    let mut all_ones = !keep_marker && value == f64::from(0xffu32 >> len);
    for i in 1..u64::from(len) {
        let b = byte(bytes, off + i).unwrap_or(0);
        value = value * 256.0 + f64::from(b);
        if b != 0xff {
            all_ones = false;
        }
    }
    Some(Vint {
        value: if all_ones { -1.0 } else { value },
        len: u64::from(len),
    })
}

/// `readUint`: a byte past the end is `undefined`, which makes the sum NaN
fn read_uint(bytes: &[u8], off: u64, len: u64) -> f64 {
    let mut v = 0.0;
    for i in 0..len {
        v = v * 256.0
            + match byte(bytes, off + i) {
                Some(b) => f64::from(b),
                None => f64::NAN,
            };
    }
    v
}

#[derive(Default)]
struct Found {
    pw: Option<f64>,
    ph: Option<f64>,
    dw: Option<f64>,
    dh: Option<f64>,
}

/// `if (x)` of a `number | undefined`
fn truthy(x: Option<f64>) -> bool {
    x.is_some_and(|v| v != 0.0 && !v.is_nan())
}

fn scan(bytes: &[u8], found: &mut Found, start: u64, end: u64) -> bool {
    let mut off = start;
    while off < end {
        let Some(id) = vint(bytes, off, end, true) else {
            return false;
        };
        let Some(size) = vint(bytes, off + id.len, end, false) else {
            return false;
        };
        let payload = off + id.len + size.len;
        let box_end = if size.value < 0.0 {
            end
        } else {
            (end as f64).min(payload as f64 + size.value) as u64
        };
        if id.value == EBML_CLUSTER {
            return false;
        }
        if is_container(id.value) {
            if scan(bytes, found, payload, box_end) {
                return true;
            }
            if id.value == EBML_VIDEO && truthy(found.pw) && truthy(found.ph) {
                return true;
            }
        } else if size.value >= 0.0 && size.value <= 8.0 {
            let v = read_uint(bytes, payload, size.value as u64);
            if id.value == EBML_PIXEL_WIDTH {
                found.pw = Some(v);
            } else if id.value == EBML_PIXEL_HEIGHT {
                found.ph = Some(v);
            } else if id.value == EBML_DISPLAY_WIDTH {
                found.dw = Some(v);
            } else if id.value == EBML_DISPLAY_HEIGHT {
                found.dh = Some(v);
            }
        }
        if size.value < 0.0 {
            return false;
        }
        off = box_end;
    }
    false
}

fn webm_video_size(bytes: &[u8]) -> Option<Size> {
    let mut found = Found::default();
    scan(bytes, &mut found, 0, bytes.len() as u64);
    // DisplayWidth/Height carry the intended aspect (anamorphic sources); both must be present
    let both = truthy(found.dw) && truthy(found.dh);
    let width = if both { found.dw } else { found.pw };
    let height = if both { found.dh } else { found.ph };
    if truthy(width) && truthy(height) {
        Some(Size {
            width: width.unwrap_or(0.0),
            height: height.unwrap_or(0.0),
        })
    } else {
        None
    }
}

// ── RIFF (avi) ───────────────────────────────────────────────────────────

fn read_u32le(bytes: &[u8], off: u64) -> u64 {
    let b = |i: u64| u64::from(byte(bytes, off + i).unwrap_or(0));
    b(0) | (b(1) << 8) | (b(2) << 16) | (b(3) << 24)
}

fn tag(bytes: &[u8], off: u64) -> String {
    (0..4)
        .map(|i| char::from(byte(bytes, off + i).unwrap_or(0)))
        .collect()
}

fn avi_video_size(bytes: &[u8]) -> Option<Size> {
    let len = bytes.len() as u64;
    if len < 12 || tag(bytes, 0) != "RIFF" || tag(bytes, 8) != "AVI " {
        return None;
    }
    let mut off: u64 = 12;
    let end = len.min(8 + read_u32le(bytes, 4));
    while off + 8 <= end {
        let size = read_u32le(bytes, off + 4);
        let kind = tag(bytes, off);
        if kind == "LIST" && off + 12 <= end && tag(bytes, off + 8) == "hdrl" {
            let p = off + 12;
            // avih payload: dwWidth at +32, dwHeight at +36
            if p + 48 <= end && tag(bytes, p) == "avih" {
                let width = read_u32le(bytes, p + 40);
                let height = read_u32le(bytes, p + 44);
                return if width != 0 && height != 0 {
                    Some(Size {
                        width: width as f64,
                        height: height as f64,
                    })
                } else {
                    None
                };
            }
            return None;
        }
        off += 8 + size + (size & 1);
    }
    None
}
