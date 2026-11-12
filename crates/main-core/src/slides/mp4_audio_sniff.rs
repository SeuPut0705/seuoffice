//! `apps/slides/src/main/mp4-audio-sniff.ts`.
//!
//! A read past the end of the array is `undefined` in the TypeScript, which
//! every operator there turns into 0; [`byte`] does the same.

use jscompat::trim;

const CONTAINER_BOXES: [&str; 5] = ["moov", "trak", "mdia", "minf", "stbl"];

/// Audio codecs Chromium's mp4 demuxer knows but cannot decode
const CHROMIUM_UNPLAYABLE_AUDIO: [&str; 12] = [
    "ac-3", "ec-3", "ac-4", "dtsc", "dtse", "dtsh", "dtsl", "dtsx", "alac", "mlpa", "samr", "sawb",
];

/// `{ width, height }` of a frame
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VideoSize {
    pub width: f64,
    pub height: f64,
}

fn byte(bytes: &[u8], off: u64) -> u64 {
    usize::try_from(off)
        .ok()
        .and_then(|i| bytes.get(i))
        .map_or(0, |b| u64::from(*b))
}

/// `String.fromCharCode` of four bytes: each is one character U+0000..U+00FF
fn fourcc(bytes: &[u8], off: u64) -> String {
    (0..4)
        .map(|i| char::from(byte(bytes, off + i) as u8))
        .collect()
}

fn read_u32(bytes: &[u8], off: u64) -> u64 {
    (byte(bytes, off) << 24)
        | (byte(bytes, off + 1) << 16)
        | (byte(bytes, off + 2) << 8)
        | byte(bytes, off + 3)
}

#[derive(Default)]
struct TrackState {
    handler: Option<String>,
    formats: Vec<String>,
    size: Option<VideoSize>,
}

/// tkhd: width/height are 16.16 fixed; a 90°/270° matrix means the displayed frame is transposed.
fn read_tkhd(bytes: &[u8], payload: u64, end: u64) -> Option<VideoSize> {
    let version = byte(bytes, payload);
    let width_off = payload + if version == 1 { 88 } else { 76 };
    if width_off + 8 > end {
        return None;
    }
    let width = read_u32(bytes, width_off) as f64 / 65536.0;
    let height = read_u32(bytes, width_off + 4) as f64 / 65536.0;
    if !(width > 0.0 && height > 0.0) {
        return None;
    }
    let m = width_off - 36;
    let a = read_u32(bytes, m);
    let b = read_u32(bytes, m + 4);
    let c = read_u32(bytes, m + 12);
    let d = read_u32(bytes, m + 16);
    let rotated = a == 0 && d == 0 && b != 0 && c != 0;
    Some(if rotated {
        VideoSize {
            width: height,
            height: width,
        }
    } else {
        VideoSize { width, height }
    })
}

fn walk(
    bytes: &[u8],
    start: u64,
    end: u64,
    mut track: Option<&mut TrackState>,
    out: &mut Vec<TrackState>,
    parent: &str,
) {
    let mut off = start;
    while off + 8 <= end {
        let mut size = read_u32(bytes, off);
        let kind = fourcc(bytes, off + 4);
        let mut payload = off + 8;
        if size == 1 {
            if off + 16 > end {
                return;
            }
            // 64-bit largesize: high word must be 0 for anything we can index
            if read_u32(bytes, off + 8) != 0 {
                return;
            }
            size = read_u32(bytes, off + 12);
            payload = off + 16;
        } else if size == 0 {
            size = end - off;
        }
        if size < 8 || off + size > end {
            return;
        }
        let box_end = off + size;

        if kind == "trak" {
            let mut t = TrackState::default();
            walk(bytes, payload, box_end, Some(&mut t), out, "");
            out.push(t);
        } else if CONTAINER_BOXES.contains(&kind.as_str()) {
            walk(bytes, payload, box_end, track.as_deref_mut(), out, &kind);
        } else if kind == "tkhd" && track.is_some() {
            if let Some(t) = track.as_deref_mut() {
                t.size = read_tkhd(bytes, payload, box_end);
            }
        } else if kind == "hdlr" && track.is_some() && parent == "mdia" {
            // FullBox: version/flags(4) + pre_defined(4) + handler_type(4).
            // minf carries a second hdlr (data handler, e.g. `url `) that must not win.
            if payload + 12 <= box_end
                && let Some(t) = track.as_deref_mut()
            {
                t.handler = Some(fourcc(bytes, payload + 8));
            }
        } else if kind == "stsd" && track.is_some() {
            // FullBox: version/flags(4) + entry_count(4), then sample entries (size + format)
            let mut p = payload + 8;
            let count = if payload + 8 <= box_end {
                read_u32(bytes, payload + 4)
            } else {
                0
            };
            let mut i = 0;
            while i < count && p + 8 <= box_end {
                let esize = read_u32(bytes, p);
                if esize < 8 || p + esize > box_end {
                    break;
                }
                if let Some(t) = track.as_deref_mut() {
                    t.formats.push(fourcc(bytes, p + 4));
                }
                p += esize;
                i += 1;
            }
        }
        off = box_end;
    }
}

fn tracks(bytes: &[u8]) -> Vec<TrackState> {
    let mut out = Vec::new();
    walk(bytes, 0, bytes.len() as u64, None, &mut out, "");
    out
}

/// `audioSampleFormats(bytes)`: sample-entry fourccs of every audio (`hdlr` = `soun`) track
pub fn audio_sample_formats(bytes: &[u8]) -> Vec<String> {
    tracks(bytes)
        .into_iter()
        .filter(|t| t.handler.as_deref() == Some("soun"))
        .flat_map(|t| t.formats)
        .collect()
}

/// `mp4VideoSize(bytes)`: displayed frame size of the first video (`hdlr` = `vide`) track
pub fn mp4_video_size(bytes: &[u8]) -> Option<VideoSize> {
    tracks(bytes)
        .into_iter()
        .find(|t| t.handler.as_deref() == Some("vide") && t.size.is_some())
        .and_then(|t| t.size)
}

/// `unplayableAudioCodec(bytes)`: the offending fourcc, normalized
pub fn unplayable_audio_codec(bytes: &[u8]) -> Option<String> {
    for f in audio_sample_formats(bytes) {
        let norm = trim(&f).to_lowercase();
        if CHROMIUM_UNPLAYABLE_AUDIO.contains(&norm.as_str()) {
            return Some(norm);
        }
    }
    None
}
