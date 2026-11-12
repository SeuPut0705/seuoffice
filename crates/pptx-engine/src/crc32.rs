//! The CRC-32 that PNG chunks and zip entries carry
//! (packages/pptx-engine/src/crc32.ts).

const CRC_TABLE: [u32; 256] = {
    let mut t = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        t[n] = c;
        n += 1;
    }
    t
};

pub fn crc32(buf: &[u8]) -> u32 {
    let mut c = u32::MAX;
    for &byte in buf {
        c = CRC_TABLE[((c ^ u32::from(byte)) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ u32::MAX
}
