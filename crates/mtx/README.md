# mtx

The MicroType Express (MTX) decoder: the Rust port of
`packages/pptx-engine/src/vendor/mtx`, itself a TypeScript port of the
decompression half of [libeot](https://github.com/umanwizard/libeot) (Brennan
T. Vincent, MPL-2.0; see `LICENSE`). libeot relicensed Monotype's original MTX
reference code under the MPL and relies on the royalty-free patent grants
Microsoft and Monotype attached to the
[W3C EOT submission](http://www.w3.org/Submission/2008/01/). `PATENTS`, which libeot's `LICENSE` asks the reader to read,
is copied verbatim from libeot's repository root at commit
`4e52d8b4a05f63d8c2059b0a4a3f11a44fbc6c5e` (git blob `6fafe00d3a3c`).

This crate is under the Mozilla Public License 2.0, file by file, and is a
crate of its own so that the boundary shows: the rest of the workspace is
Apache-2.0 and only links to it. A change to a file here is published under
the MPL.

What it does: an EOT payload with `TTEMBED_TTCOMPRESSED` (flag 0x4) holds
three LZ-compressed streams (the CTF table container, glyph push data, glyph
instructions). `lzcomp.rs` inflates them (adaptive Huffman over an LZ77
stream, optional run-length layer), `ctf.rs` rebuilds `glyf`/`loca`/`cvt `
from the compact table format and writes a plain sfnt with fresh checksums.

Ported files: `lzcomp.ts` to `lzcomp.rs`, `ctf.ts` to `ctf.rs`, `index.ts`
to `lib.rs`. Compression, hdmx/VDMX reconstruction and the size-limited copy
window are not ported, as in the TypeScript. Parity with the TypeScript is
compared by `tools/pptx-diff` (group `mtx`).
