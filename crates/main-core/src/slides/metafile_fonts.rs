//! `apps/slides/src/main/metafile-fonts.ts`.
//!
//! A `DataView` read past the end throws a `RangeError` in the TypeScript and
//! the scan keeps what it collected; here such a read is `Err(Truncated)`,
//! which `scan_metafile_fonts` drops the same way.

use std::io::Read;

use jscompat::{js_regex, trim};
use serde::Serialize;

/// `MetafileFontRequest`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MetafileFontRequest {
    pub family: String,
    pub bold: bool,
    pub italic: bool,
}

const EMR_COMMENT: u64 = 70;
const EMR_EXTCREATEFONTINDIRECTW: u64 = 82;
const EMFPLUS_SIGNATURE: u64 = 0x2b46_4d45; // 'EMF+'
const EMFPLUS_OBJECT: u64 = 0x4008;
const EMFPLUS_OBJECT_FONT: u64 = 6;
const META_CREATEFONTINDIRECT: u64 = 0x02fb;
const FONTSTYLE_BOLD: i64 = 1;
const FONTSTYLE_ITALIC: i64 = 2;
/// Decompression bombs must not exhaust main-process memory during font scans
pub const MAX_METAFILE_GUNZIP_BYTES: u64 = 64 * 1024 * 1024;

/// the `RangeError` of a `DataView` read past the end
struct Truncated;

struct View<'a>(&'a [u8]);

impl View<'_> {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    fn slice<const N: usize>(&self, off: u64) -> Result<[u8; N], Truncated> {
        let end = off.checked_add(N as u64).ok_or(Truncated)?;
        if end > self.len() {
            return Err(Truncated);
        }
        let mut out = [0u8; N];
        out.copy_from_slice(&self.0[off as usize..end as usize]);
        Ok(out)
    }
    fn u8(&self, off: u64) -> Result<u64, Truncated> {
        Ok(u64::from(self.slice::<1>(off)?[0]))
    }
    fn u16(&self, off: u64) -> Result<u64, Truncated> {
        Ok(u64::from(u16::from_le_bytes(self.slice(off)?)))
    }
    fn i16(&self, off: u64) -> Result<i64, Truncated> {
        Ok(i64::from(i16::from_le_bytes(self.slice(off)?)))
    }
    fn u32(&self, off: u64) -> Result<u64, Truncated> {
        Ok(u64::from(u32::from_le_bytes(self.slice(off)?)))
    }
    fn i32(&self, off: u64) -> Result<i64, Truncated> {
        Ok(i64::from(i32::from_le_bytes(self.slice(off)?)))
    }
}

/// `utf16(view, off, maxChars)`: `String.fromCharCode` of each unit; a lone
/// surrogate has no Rust form and becomes U+FFFD
fn utf16(view: &View, off: u64, max_chars: u64) -> Result<String, Truncated> {
    let mut units: Vec<u16> = Vec::new();
    let mut i: u64 = 0;
    while i < max_chars && off + i * 2 + 1 < view.len() {
        let c = view.u16(off + i * 2)?;
        if c == 0 {
            break;
        }
        units.push(c as u16);
        i += 1;
    }
    Ok(String::from_utf16_lossy(&units))
}

type Requests = Vec<(String, MetafileFontRequest)>;

fn key_of(family: &str, bold: bool, italic: bool) -> String {
    format!(
        "{}|{}{}",
        family.to_lowercase(),
        u8::from(bold),
        u8::from(italic)
    )
}

fn add(out: &mut Requests, family: &str, bold: bool, italic: bool) {
    // eslint-disable-next-line no-control-regex
    let control = js_regex!(r"[\u0000-\u001f\u007f]", "g");
    let stripped = control.replace_all(family, |_| String::new());
    let clean = trim(&stripped);
    if clean.is_empty() {
        return;
    }
    let key = key_of(clean, bold, italic);
    if !out.iter().any(|(k, _)| *k == key) {
        out.push((
            key,
            MetafileFontRequest {
                family: clean.to_owned(),
                bold,
                italic,
            },
        ));
    }
}

fn scan_emf_plus(
    view: &View,
    start: u64,
    length: u64,
    out: &mut Requests,
) -> Result<(), Truncated> {
    let end = (start + length).min(view.len());
    let mut off = start;
    while off + 12 <= end {
        let kind = view.u16(off)?;
        let flags = view.u16(off + 2)?;
        let size = view.u32(off + 4)?;
        if size < 12 || off + size > end {
            break;
        }
        if kind == EMFPLUS_OBJECT && ((flags >> 8) & 0x7f) == EMFPLUS_OBJECT_FONT && size >= 40 {
            // EmfPlusFont: Version(4) EmSize(4) SizeUnit(4) FontStyleFlags(4) Reserved(4) Length(4) FamilyName
            let data = off + 12;
            let style = view.i32(data + 12)?;
            let name_len = view.u32(data + 20)?;
            if name_len > 0 && data + 24 + name_len * 2 <= off + size {
                let family = utf16(view, data + 24, name_len)?;
                add(
                    out,
                    &family,
                    (style & FONTSTYLE_BOLD) != 0,
                    (style & FONTSTYLE_ITALIC) != 0,
                );
            }
        }
        off += size;
    }
    Ok(())
}

fn scan_emf(view: &View, out: &mut Requests) -> Result<(), Truncated> {
    let mut off: u64 = 0;
    while off + 8 <= view.len() {
        let kind = view.u32(off)?;
        let size = view.u32(off + 4)?;
        if size < 8 || off + size > view.len() {
            break;
        }
        if kind == EMR_EXTCREATEFONTINDIRECTW && size >= 12 + 92 {
            // ihFont(4), then LOGFONTW: Height Width Escapement Orientation Weight (5×4), Italic(1) …, FaceName[32] at +28
            let lf = off + 12;
            let weight = view.i32(lf + 16)?;
            let italic = view.u8(lf + 20)? != 0;
            let family = utf16(view, lf + 28, 32)?;
            add(out, &family, weight >= 600, italic);
        } else if kind == EMR_COMMENT && size >= 16 {
            let data_size = view.u32(off + 8)?;
            if data_size >= 4 && view.u32(off + 12)? == EMFPLUS_SIGNATURE {
                scan_emf_plus(view, off + 16, (data_size - 4).min(size - 16), out)?;
            }
        }
        off += size;
    }
    Ok(())
}

fn scan_wmf(view: &View, out: &mut Requests) -> Result<(), Truncated> {
    // Optional placeable header (22 bytes), then META_HEADER (18 bytes)
    let mut off: u64 = (if view.u32(0)? == 0x9ac6_cdd7 { 22 } else { 0 }) + 18;
    while off + 6 <= view.len() {
        let size = view.u32(off)? * 2;
        let function = view.u16(off + 4)?;
        if size < 6 || off + size > view.len() {
            break;
        }
        if function == META_CREATEFONTINDIRECT && size >= 6 + 18 {
            // LOGFONT16: Height Width Escapement Orientation Weight (5×2), Italic(1) …, FaceName at +18
            let lf = off + 6;
            let weight = view.i16(lf + 8)?;
            let italic = view.u8(lf + 10)? != 0;
            let mut name = String::new();
            let mut i: u64 = 0;
            while i < 32 && lf + 18 + i < off + size {
                let c = view.u8(lf + 18 + i)?;
                if c == 0 {
                    break;
                }
                name.push(char::from(c as u8));
                i += 1;
            }
            add(out, &name, weight >= 600, italic);
        }
        off += size;
    }
    Ok(())
}

/// `gunzipSync(bytes, { maxOutputLength })` as Node's zlib reads it: members
/// one after another, zero bytes after a member are padding, any other byte
/// starts another member; `None` where it throws.
fn gunzip(data: &[u8], max_output: u64) -> Option<Vec<u8>> {
    let mut rest: &[u8] = data;
    let mut out: Vec<u8> = Vec::new();
    loop {
        // zlib's header checks: the magic, the method, no reserved flag
        if rest.len() < 4
            || rest[0] != 0x1f
            || rest[1] != 0x8b
            || rest[2] != 8
            || rest[3] & 0xe0 != 0
        {
            return None;
        }
        let mut member = flate2::bufread::GzDecoder::new(&mut rest);
        let room = max_output - out.len() as u64;
        let before = out.len();
        // one byte more than the room tells that the output is over the limit
        (&mut member).take(room + 1).read_to_end(&mut out).ok()?;
        if (out.len() - before) as u64 > room {
            return None;
        }
        drop(member);
        match rest.first() {
            None | Some(0) => return Some(out),
            Some(_) => {}
        }
    }
}

/// `scanMetafileFonts(bytes)`
pub fn scan_metafile_fonts(bytes: &[u8]) -> Vec<MetafileFontRequest> {
    let inflated;
    let mut u8s = bytes;
    if bytes.len() > 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        // maxOutputLength turns a gzip bomb into a throw (caught here)
        match gunzip(bytes, MAX_METAFILE_GUNZIP_BYTES) {
            Some(out) => {
                inflated = out;
                u8s = &inflated;
            }
            None => return Vec::new(),
        }
    }
    if u8s.len() < 18 {
        return Vec::new();
    }
    let view = View(u8s);
    let mut out: Requests = Vec::new();
    let _ = (|| -> Result<(), Truncated> {
        let is_emf = view.u32(0)? == 1 && u8s.len() >= 44 && view.u32(40)? == 0x464d_4520;
        if is_emf {
            scan_emf(&view, &mut out)
        } else {
            scan_wmf(&view, &mut out)
        }
        // truncated record tail: keep whatever was collected
    })();
    out.into_iter().map(|(_, request)| request).collect()
}

/// `listMetafileFonts(archive)`: `entries` is `archive.entries` in its order
pub fn list_metafile_fonts(entries: &[(String, Vec<u8>)]) -> Vec<MetafileFontRequest> {
    let media = js_regex!(r"^ppt\/media\/[^/]+\.(emf|wmf|emz|wmz)$", "i");
    let mut out: Requests = Vec::new();
    for (path, bytes) in entries {
        if !media.test(path) {
            continue;
        }
        for font in scan_metafile_fonts(bytes) {
            let key = key_of(&font.family, font.bold, font.italic);
            match out.iter_mut().find(|(k, _)| *k == key) {
                // Map.set keeps the place of a key that is there
                Some(slot) => slot.1 = font,
                None => out.push((key, font)),
            }
        }
    }
    out.into_iter().map(|(_, request)| request).collect()
}
