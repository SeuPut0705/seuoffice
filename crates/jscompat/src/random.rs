//! `Math.random()` and `crypto.randomUUID()`, from the platform's random
//! source: the operating system natively, WASI `random_get` on wasm32 (the
//! host's `crypto.getRandomValues`).

/// Fill `bytes` from the platform's random source.
///
/// Neither JavaScript call can fail. Where the source refuses (no host ever
/// does: `random_get` of the engine loader always succeeds), the bytes are
/// those of a process counter run through splitmix64, so ids stay distinct
/// within the process.
fn fill(bytes: &mut [u8]) {
    if getrandom::fill(bytes).is_ok() {
        return;
    }
    use std::sync::atomic::{AtomicU64, Ordering};
    static STATE: AtomicU64 = AtomicU64::new(0x9E37_79B9_7F4A_7C15);
    for chunk in bytes.chunks_mut(8) {
        let mut z = STATE.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        let word = z.to_le_bytes();
        chunk.copy_from_slice(word.get(..chunk.len()).unwrap_or_default());
    }
}

/// `Math.random()`: a number in [0, 1) with 53 random bits.
pub fn math_random() -> f64 {
    let mut bytes = [0u8; 8];
    fill(&mut bytes);
    (u64::from_le_bytes(bytes) >> 11) as f64 / (1u64 << 53) as f64
}

/// `crypto.randomUUID()`: a version 4 UUID, hyphenated, lower case.
pub fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let part = |from: usize, to: usize| hex.get(from..to).unwrap_or_default();
    format!(
        "{}-{}-{}-{}-{}",
        part(0, 8),
        part(8, 12),
        part(12, 16),
        part(16, 20),
        part(20, 32)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_are_version_4_and_distinct() {
        let (a, b) = (random_uuid(), random_uuid());
        assert_ne!(a, b);
        assert!(js_regex_uuid(&a), "{a}");
        let x = math_random();
        assert!((0.0..1.0).contains(&x));
    }

    fn js_regex_uuid(text: &str) -> bool {
        crate::js_regex!(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
            .test(text)
    }
}
