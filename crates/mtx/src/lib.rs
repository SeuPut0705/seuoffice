//! The MicroType Express decoder: `vendor/mtx/index.ts` of
//! `packages/pptx-engine`, which turns the MTX payload of an embedded EOT font
//! into a plain sfnt.
//!
//! A derived work of libeot by Brennan T. Vincent, licensed under the Mozilla
//! Public License 2.0 like the TypeScript it is ported from: see
//! `LICENSE` and `README.md` of this crate.

pub mod ctf;
pub mod lzcomp;

pub use lzcomp::MtxError;

/// Inflate a MicroType-Express-compressed EOT payload (TTEMBED_TTCOMPRESSED, already
/// XOR-decrypted by the caller) into a plain sfnt, or `None` when the data is not decodable.
pub fn mtx_to_sfnt(payload: &[u8]) -> Option<Vec<u8>> {
    let [a, b, c] = lzcomp::unpack_mtx(payload).ok()?;
    ctf::ctf_to_sfnt([&a, &b, &c]).ok()
}
