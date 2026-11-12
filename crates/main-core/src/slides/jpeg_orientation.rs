//! `apps/slides/src/main/jpeg-orientation.ts`.

/// `bytes[i]` where a read past the end is `undefined`, which every operator
/// of the TypeScript turns into 0 (`|`, `<<`) and no comparison matches.
fn at(bytes: &[u8], i: u64) -> Option<u8> {
    usize::try_from(i).ok().and_then(|i| bytes.get(i)).copied()
}

fn num(bytes: &[u8], i: u64) -> u64 {
    u64::from(at(bytes, i).unwrap_or(0))
}

/// `neutralizeJpegOrientation(bytes)`: the bytes with the EXIF Orientation
/// set to 1, or the same bytes.
pub fn neutralize_jpeg_orientation(bytes: &[u8]) -> Vec<u8> {
    let len = bytes.len() as u64;
    if len < 4 || bytes[0] != 0xff || bytes[1] != 0xd8 {
        return bytes.to_vec();
    }
    let mut off: u64 = 2;
    while off + 4 <= len {
        if num(bytes, off) != 0xff {
            return bytes.to_vec();
        }
        let marker = num(bytes, off + 1);
        // Start of scan / end: no APP1 past this point
        if marker == 0xda || marker == 0xd9 {
            return bytes.to_vec();
        }
        let seg_len = (num(bytes, off + 2) << 8) | num(bytes, off + 3);
        if seg_len < 2 || off + 2 + seg_len > len {
            return bytes.to_vec();
        }
        if marker == 0xe1 {
            let p = off + 4;
            // "Exif\0\0"
            if at(bytes, p) == Some(0x45)
                && at(bytes, p + 1) == Some(0x78)
                && at(bytes, p + 2) == Some(0x69)
                && at(bytes, p + 3) == Some(0x66)
                && at(bytes, p + 4) == Some(0x00)
                && at(bytes, p + 5) == Some(0x00)
            {
                let tiff = p + 6;
                let le = at(bytes, tiff) == Some(0x49) && at(bytes, tiff + 1) == Some(0x49);
                let be = at(bytes, tiff) == Some(0x4d) && at(bytes, tiff + 1) == Some(0x4d);
                if !le && !be {
                    return bytes.to_vec();
                }
                let u16_at = |o: u64| -> u64 {
                    if le {
                        num(bytes, o) | (num(bytes, o + 1) << 8)
                    } else {
                        (num(bytes, o) << 8) | num(bytes, o + 1)
                    }
                };
                let u32_at = |o: u64| -> u64 {
                    if le {
                        num(bytes, o)
                            | (num(bytes, o + 1) << 8)
                            | (num(bytes, o + 2) << 16)
                            | (num(bytes, o + 3) << 24)
                    } else {
                        (num(bytes, o) << 24)
                            | (num(bytes, o + 1) << 16)
                            | (num(bytes, o + 2) << 8)
                            | num(bytes, o + 3)
                    }
                };
                let seg_end = off + 2 + seg_len;
                let ifd0 = tiff + u32_at(tiff + 4);
                if ifd0 + 2 > seg_end {
                    return bytes.to_vec();
                }
                let count = u16_at(ifd0);
                for i in 0..count {
                    let e = ifd0 + 2 + i * 12;
                    if e + 12 > seg_end {
                        return bytes.to_vec();
                    }
                    if u16_at(e) != 0x0112 {
                        continue;
                    }
                    let cur = u16_at(e + 8);
                    if cur == 1 || cur == 0 {
                        return bytes.to_vec();
                    }
                    let mut out = bytes.to_vec();
                    if le {
                        out[(e + 8) as usize] = 1;
                        out[(e + 9) as usize] = 0;
                    } else {
                        out[(e + 8) as usize] = 0;
                        out[(e + 9) as usize] = 1;
                    }
                    return out;
                }
                return bytes.to_vec();
            }
        }
        off += 2 + seg_len;
    }
    bytes.to_vec()
}
