//! `Buffer.from(text, 'base64')` of Node 22: the lenient decoder of
//! `src/base64-inl.h`. Both alphabets are read (`+` or `-` is 62, `/` or `_`
//! is 63), characters outside them are skipped, and the decoding stops at the
//! first `=` that is met where a character of the alphabet was due.
//!
//! The decoder is fed the UTF-16 units of the string, each taken as its low
//! byte, as Node does for a string it cannot read as one-byte text.

/// The 6-bit value of a base64 character, or 255 for any other byte.
fn unbase64(c: u8) -> u8 {
    match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' | b'-' => 62,
        b'/' | b'_' => 63,
        _ => 255,
    }
}

/// `base64_decoded_size`: the size `Buffer.from` allocates before it decodes.
fn decoded_size(src: &[u16]) -> usize {
    let mut size = src.len();
    // 1-byte input cannot be decoded
    if size < 2 {
        return 0;
    }
    if src[size - 1] == u16::from(b'=') {
        size -= 1;
        if src[size - 1] == u16::from(b'=') {
            size -= 1;
        }
    }
    let remainder = size % 4;
    let mut out = size / 4 * 3;
    if remainder != 0 {
        if out == 0 && remainder == 1 {
            out = 0;
        } else {
            out += 1 + usize::from(remainder == 3);
        }
    }
    out
}

/// `base64_decode_group_slow`: one group of four, skipping what is no
/// base64; false where the decoding stops.
fn group_slow(dst: &mut [u8], src: &[u16], i: &mut usize, k: &mut usize) -> bool {
    let srclen = src.len();
    let dstlen = dst.len();
    // reads the next character of the alphabet into `lo`; false at a stop
    let next = |i: &mut usize| -> Result<u8, ()> {
        loop {
            let c = src[*i] as u8;
            let lo = unbase64(c);
            *i += 1;
            if lo < 64 {
                return Ok(lo);
            }
            if c == b'=' || *i >= srclen {
                return Err(());
            }
        }
    };
    let Ok(mut hi) = next(i) else {
        return false;
    };
    if *i >= srclen || *k >= dstlen {
        return false;
    }
    for step in 0..3 {
        let Ok(lo) = next(i) else {
            return false;
        };
        dst[*k] = match step {
            0 => ((hi & 0x3F) << 2) | ((lo & 0x30) >> 4),
            1 => ((hi & 0x0F) << 4) | ((lo & 0x3C) >> 2),
            _ => ((hi & 0x03) << 6) | (lo & 0x3F),
        };
        *k += 1;
        if *i >= srclen || *k >= dstlen {
            return false;
        }
        hi = lo;
    }
    true
}

/// `Buffer.from(text, 'base64')`
pub fn buffer_from_base64(text: &str) -> Vec<u8> {
    let src: Vec<u16> = text.encode_utf16().collect();
    let srclen = src.len();
    let size = decoded_size(&src);
    let mut dst = vec![0u8; size];
    let max_k = size / 3 * 3;
    let mut max_i = srclen / 4 * 4;
    let mut i = 0usize;
    let mut k = 0usize;
    let mut stopped = false;
    while i < max_i && k < max_k {
        let v: [u8; 4] = [
            unbase64(src[i] as u8),
            unbase64(src[i + 1] as u8),
            unbase64(src[i + 2] as u8),
            unbase64(src[i + 3] as u8),
        ];
        if v.iter().any(|b| b & 0x80 != 0) {
            if !group_slow(&mut dst, &src, &mut i, &mut k) {
                stopped = true;
                break;
            }
            // align max_i again
            max_i = i + (srclen - i) / 4 * 4;
        } else {
            dst[k] = (v[0] << 2) | (v[1] >> 4);
            dst[k + 1] = (v[1] << 4) | (v[2] >> 2);
            dst[k + 2] = (v[2] << 6) | v[3];
            i += 4;
            k += 3;
        }
    }
    if !stopped && i < srclen && k < size {
        group_slow(&mut dst, &src, &mut i, &mut k);
    }
    dst.truncate(k);
    dst
}

#[cfg(test)]
mod tests {
    use super::*;

    // Node 22.22.0 Buffer.from(text, "base64"), as hex, one per case
    const NODE: &[(&str, &str)] = &[
        ("", ""),
        ("QQ==", "41"),
        ("QQ", "41"),
        ("QUI=", "4142"),
        ("QUJD", "414243"),
        ("QUJDRA==", "41424344"),
        ("QUJD\nRA==", "41424344"),
        ("QU JD", "414243"),
        ("QUJD====", "414243"),
        ("QUJDRA=", "41424344"),
        ("QUJDRA===x", "41424344"),
        ("Q", ""),
        ("QUJDR", "414243"),
        ("-_-_", "fbffbf"),
        ("+/+/", "fbffbf"),
        ("QU=JD", "41"),
        ("QU#JD", "414243"),
        ("4pyTIMOgIGxhIG1vZGU=", "e29c9320c3a0206c61206d6f6465"),
        ("4pyTIMOgIGxhIG1vZGU", "e29c9320c3a0206c61206d6f6465"),
        ("éQUJD", "414243"),
        ("QUJD\0RA==", "41424344"),
        ("==QUJD", ""),
        ("QUJD=RA==", "414243"),
        ("Zg", "66"),
        ("Zm8", "666f"),
        ("Zm9v", "666f6f"),
        ("Zm9vYg", "666f6f62"),
        ("Zm9vYmE", "666f6f6261"),
        ("Zm9vYmFy", "666f6f626172"),
        ("Zm9vYmFy\r\n", "666f6f626172"),
        ("  Zm9v  ", "666f6f"),
        ("Z\tm9v", "666f6f"),
        ("Zm9v.YmFy", "666f6f626172"),
        ("Zm9v=YmFy", "666f6f"),
        ("QU\u{141}JD", "414009"),
        ("\u{151}QUJD", "410509"),
        ("QUJD\u{100}RA==", "41424344"),
        ("Q\u{4e00}UJD", "414243"),
        ("QUJ\u{1F600}D", "4142"),
        ("QUJD=", "414243"),
        ("QUJD=x", "414243"),
        ("QUJDRA=x", "41424344"),
        ("A=", ""),
        ("AB=CD", "00"),
        ("ABC=D", "0010"),
        ("ABCD=EFGH", "001083"),
        ("Zm9vYmFy==Zm9v", "666f6f626172"),
    ];

    #[test]
    fn decodes_what_node_decodes() {
        for (text, hex) in NODE {
            let got: String = buffer_from_base64(text)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            assert_eq!(&got, hex, "Buffer.from({text:?}, 'base64')");
        }
    }
}
