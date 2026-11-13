# seuoffice — code dependency / vendor licence audit (FSL-1.1-ALv2 prep)

Scope: what ships in the Electron app (apps/shell) and the web build (apps/web, `private:false`, `files: dist`). Read-only; no legal conclusions.
Base: worktree `gui-fsl-prep` (= origin/main 07a251652 per assignment).

## 0. Method and limits (read first)

- This session had **no shell**: only file read / grep / glob / jq-on-JSON / web fetch. So `node tools/check-licenses.mjs`, `npm ls`, `cargo metadata/tree` and `git show/ls-files/ls-tree` were **not run**. Substitutes:
  - npm: jq over `package-lock.json` using exactly the rule of `tools/check-licenses.mjs` (skip `dev`/`link`/workspace roots). `node_modules` is **not installed** in this worktree.
  - Rust: `Cargo.lock` + licence fields read from `~/.cargo/registry/src/index.crates.io-*/<crate>/Cargo.toml` (94 of ~104 crates of the xlsx locks resolved; the rest are target-specific and absent from the registry cache, see §2.3).
  - Branches: `origin/feat/rust-*` could not be read with `git show`. The two sibling worktrees that hold the Rust workspace were read instead: `/Users/choejinseo/.omp/wt/gui-rust-fileparse-d3-mm-0304012/crates` (members incl. file-parse, epub-engine, saxes, seu-host) and `/Users/choejinseo/.omp/wt/gui-rust-pptx-c2-mm-0304012/crates`. [INFERENCE] these are the branches that will land the "stage 2 / office-wasm" work; they may hold uncommitted state, and **no napi crate was seen**. The branch list (`git branch -r`) was not enumerable.
- `main` has **no** `crates/` directory.
- Fonts, brand art, template fonts, drawio shape art and OCR helpers are only touched where they intersect code trees; a separate audit presumably covers fonts.

## 1. Summary counts

| Area | fine | needs legal review | blocked |
| --- | --- | --- | --- |
| npm prod lock set (549 pkgs by check-licenses rule) | 543 packages (all permissive; incl. 3 BlueOak, 2 0BSD, 2 MIT-0, 1 CC0, 1 Unlicense, 1 Python-2.0, 1 MIT AND Zlib, 1 MIT OR Apache-2.0) | 4 packages (jszip, dompurify, @univerjs/telemetry, khroma) + 2 dev-flagged-but-shipped (node-forge, electron/Chromium) + 1 (canvaskit-wasm embeds) | 0 |
| Rust xlsx-sidecar / xlsx-wasm (main) | ~100 crates | 1 (r-efi, not compiled), 1 note (encoding_rs notice) | 0 |
| Rust on feature branches (d3/c2 worktrees) | ~220 crates + vendor/regress | `mtx` (MPL-2.0), rhwp path-dep (IJG, GUST-derived outlines, Nimbus metrics, DejaVu), ported-code declarations | 0 |
| Vendored trees | rhwp-core crates (52 direct) mostly permissive, draw.io Apache parts | see §4 | 0 |
| Prebuilt binaries tracked in git | 0 | 1 (rhwp_bg.wasm) | 0 |

No item meets the `blocked` bar (no non-commercial / proprietary / relicense-forbidding licence was found). Everything non-fine below is `needs legal review`.

## 2. npm production dependencies

### 2.1 What the project already counts as "shipped"
- `tools/check-licenses.mjs`: reads `package-lock.json`, skips `dev:true` and `link:true` and workspace roots, requires every other package's `license` to satisfy `isAllowed()` in `tools/license-allowlist.mjs`. Gate of `npm run licenses` (CI: `.github/workflows/ci.yml` "Check dependency licenses"; the same script also runs `tools/check-drawio-bundle.mjs` per vendor/drawio/README).
- Allowlist (`tools/license-allowlist.mjs`): MIT, MIT-0, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0, CC0-1.0, **CC-BY-4.0**, Zlib, Unlicense, Python-2.0, Unicode-3.0, **OFL-1.1**. SPDX handling: OR passes if any branch allowed, AND needs all, WITH falls back to base, legacy `A/B` any. (So dual "X OR GPL" packages pass by election; the gate records no election.)
- Recorded exceptions (`EXCEPTIONS` in check-licenses.mjs; package.json lacks a licence field, "verified manually against the LICENSE file shipped in the package"): `@univerjs/telemetry` → Apache-2.0; `khroma` → MIT (mermaid dep, ships an MIT `license` file, no package.json field).
- `tools/gen-third-party-notices.mjs` states that dependencies/devDependencies **do not** tell what ships: electron-vite bundles renderer/main into `out/` and no node_modules is packaged. The shipped set = imports under `*/src` closed over the dependency graph, plus `IMPLICIT = [electron, @rhwp/core, canvaskit-wasm, @noble/hashes]` plus electron-builder `extraResources` seeds. Consequence: the **lockfile `dev` flag is an incomplete proxy**; devDependencies that ship (electron, canvaskit-wasm, @neslinesli93/qpdf-wasm, @rhwp/editor, node-forge via apps/pdf, pptxgenjs, harfbuzzjs in apps/pdf, @embedpdf/pdfium in apps/pdf) are *not* gated by `check-licenses`. I checked these by hand (below).
- Its own SPDX notes: `dompurify` "Apache-2.0 (dual MPL-2.0/Apache-2.0, used under Apache-2.0)"; `jszip` "MIT (dual MIT/GPL-3.0-or-later, used under MIT)"; `r-efi` "MIT (tri-licensed MIT/Apache-2.0/LGPL-2.1-or-later, used under MIT)". Embedded C libs in wasm blobs (EMBEDDED table): pdfium.wasm (FreeType FTL, OpenJPEG BSD-2, libpng, zlib, lcms2 MIT, AGG 2.3 custom permissive), qpdf.wasm (libjpeg-turbo IJG+BSD+zlib), pdfjs-dist wasm/ + standard_fonts/ licence files. Hand-written notice entries: `@fluentui/react-icons` (MIT), `@neslinesli93/qpdf-wasm` (qpdf Apache-2.0, wrapper ISC), `@rhwp/editor` (MIT).
- Checks CI runs: `npm run licenses` (npm + drawio bundle) and cargo-deny only on `xlsx-engine` (see §3). electron-builder `beforePack` rejects a notice that has a gap and requires `RUST_COMPONENTS = 2` ("N crates, all under permissive terms:" lines: xlsx-sidecar, rhwp_bg.wasm).

### 2.2 Licence histogram (lock, `dev` excluded; matches the check-licenses rule)
MIT 391, Apache-2.0 62, ISC 54, BSD-3-Clause 22, BSD-2-Clause 4, BlueOak-1.0.0 3 (lru-cache 11.5.2, sax 1.6.0, …), 0BSD 2 (tslib 1.14.1 & 2.8.1), MIT-0 2 (@csstools/color-helpers 6.1.0, @csstools/css-syntax-patches-for-csstree 1.1.6), NONE 2, (MIT AND Zlib) 1 (pako 1.0.11), (MIT OR GPL-3.0-or-later) 1 (jszip 3.10.1), (MPL-2.0 OR Apache-2.0) 1 (dompurify 3.4.17), CC0-1.0 1 (mdn-data 2.27.1), MIT OR Apache-2.0 1 (@bjorn3/browser_wasi_shim 0.4.2), Python-2.0 1 (argparse 2.0.1), Unlicense 1 (robust-predicates 3.0.3). Total 549.
dev-flagged (not gated), 628 packages: MIT 513, ISC 44, Apache-2.0 25, BSD-2 11, BSD-3 11, BlueOak 7, (BSD-3-Clause OR GPL-2.0) 1 node-forge 1.4.1, (MIT OR CC0-1.0) 1 type-fest 0.13.1, (WTFPL OR MIT) 1 utf8-byte-length 1.0.5, CC-BY-4.0 1 caniuse-lite 1.0.30001810, WTFPL 1 truncate-utf8-bytes 1.0.2, WTFPL OR ISC 1 sanitize-filename 1.6.4.
No LGPL, EPL, GPL-only, AGPL, CC-BY-SA, SSPL, UNLICENSED, or custom licence appears in either set.

### 2.3 Non-fine / noteworthy rows (npm)

| Package | Version | SPDX (lock) | Category | Notice duty | Pulled in by (lock reverse deps; `npm ls` not runnable) | Status |
| --- | --- | --- | --- | --- | --- | --- |
| jszip | 3.10.1 | (MIT OR GPL-3.0-or-later) | permissive with GPL alternative (copyleft option) | MIT text + copyright; project elects MIT (SPDX_NOTE) | apps/sheets, packages/{ai-provider, cli, doc2docx, docx-engine, epub-engine, file-parse, hwp2docx, odf2ooxml, odt-engine, pdf-pdf-structure, pdf2docx, ppt2pptx, pptx-engine, xlsx-gateway, xmind-engine}, pptxgenjs(dev) | needs legal review (low; MIT election is the project's own, not recorded in the gate) |
| dompurify | 3.4.17 | (MPL-2.0 OR Apache-2.0) | weak-copyleft-file option (MPL) | Apache-2.0 text + NOTICE; project elects Apache | mermaid (→ apps/markdown); draw.io bundle also carries its own DOMPurify (Apache-2.0) | needs legal review (low) |
| @univerjs/telemetry | 0.25.1 | none in lock | unknown (field missing) | project says Apache-2.0 from shipped licence file | @univerjs/sheets-ui (→ apps/sheets; Univer presets) | needs legal review (EXCEPTIONS entry in check-licenses.mjs is the only evidence; licence file is in node_modules which is not installed here) |
| khroma | 2.1.0 | none in lock | unknown (field missing) | project says MIT from shipped `license` file | mermaid (→ apps/markdown) | needs legal review (same) |
| node-forge | 1.4.1 | (BSD-3-Clause OR GPL-2.0) | permissive with GPL alternative | BSD-3 text | apps/pdf (devDependency, bundled by electron-vite → shipped). Not covered by `check-licenses` because `dev:true` | needs legal review (low) |
| electron (+Chromium) | 43.8.3 | MIT; `LICENSES.chromium.html` shipped | permissive, but bundle contains LGPL/MPL/etc. third-party parts of Chromium (e.g. FFmpeg) | ship `LICENSES.chromium.html` (done via extraResources) + MIT | apps/shell (devDependency, binary is the runtime) | needs legal review (aggregate/binary bundle, not enumerated by the project) |
| canvaskit-wasm | 0.42.0 | BSD-3-Clause | permissive wrapper; wasm embeds Skia and typically FreeType/HarfBuzz/ICU/etc. | BSD-3; **no EMBEDDED entry** in gen-third-party-notices (only qpdf, pdfium, pdfjs have one) | apps/hwp (devDependency, in IMPLICIT) | needs legal review (embedded-library notices unverified) |
| @embedpdf/pdfium | 2.15.1 | MIT wrapper; pdfium.wasm embeds Apache-2.0 PDFium, FreeType (FTL), OpenJPEG, libpng, zlib, lcms2, AGG 2.3 | permissive (FTL / AGG custom permissive texts) | all listed texts + FreeType credit line; present in EMBEDDED table | apps/pdf, packages/pdf-structure, packages/pdf2docx; wasm copied to resources/wasm | needs legal review (low; custom permissive licences, FTL credit) |
| @neslinesli93/qpdf-wasm | 0.3.0 | ISC wrapper; qpdf Apache-2.0; libjpeg-turbo (IJG + BSD-3 + zlib) | permissive | EMBEDDED entry exists | apps/pdf (dev) | fine (notice duty only; IJG advertising/credit sentence) |
| pdfjs-dist | 6.2.108 | Apache-2.0; wasm/ (jbig2, openjpeg BSD-2, qcms, quickjs MIT) and standard_fonts/ carry their own LICENSE_* files | permissive + font licences | copy of each LICENSE_* (generator does this) | apps/pdf | needs legal review (standard_fonts/ licence files not read here; fonts audit) |
| harfbuzzjs | 1.5.0 (root, prod) / 0.10.3 (apps/pdf, dev) | MIT; hb-subset.wasm shipped | permissive | MIT (+ HarfBuzz "old MIT") | apps/pdf; wasm copied to resources/wasm | fine |
| argparse | 2.0.1 | Python-2.0 | permissive (PSF-style) | PSF licence text + copyright | js-yaml | fine |
| pako | 1.0.11 | (MIT AND Zlib) | permissive | MIT + zlib texts (generator emits both) | @pdf-lib/standard-fonts, @pdf-lib/upng, jszip, pdf-lib, utif2 | fine |
| caniuse-lite | 1.0.30001810 | CC-BY-4.0 | CC-BY | attribution | browserslist tooling (dev, **not shipped**) | fine (not shipped; allowlist permits CC-BY-4.0 anyway) |
| sanitize-filename / truncate-utf8-bytes / utf8-byte-length | 1.6.4 / 1.0.2 / 1.0.5 | WTFPL (OR ISC / OR MIT) | permissive-ish (WTFPL not on allowlist) | none | electron-builder toolchain (dev, not shipped) | fine (not shipped) |
| BlueOak (lru-cache, sax, …), 0BSD (tslib), MIT-0, CC0 (mdn-data), Unlicense (robust-predicates), MIT OR Apache-2.0 (@bjorn3/browser_wasi_shim 0.4.2 → packages/web-platform) | — | — | permissive / public-domain-like | licence text + copyright | various | fine |

Web package note: `apps/web` (`private:false`, publishes `dist/`, README, LICENSE) bundles the same npm closure plus the wasm blobs of §5. All workspace packages declare `Apache-2.0` and none of `packages/*` is `private:true`, but only `apps/web` declares `files`/publish metadata (root and `packages/cli`, `apps/shell` are `private:true`). [INFERENCE] other `packages/*` are not actually published.

### 2.4 Evidence paths (npm)
`tools/check-licenses.mjs`, `tools/license-allowlist.mjs`, `tools/gen-third-party-notices.mjs` (lines 93-99 IMPLICIT, ~123-126 SPDX_NOTE, EMBEDDED table), `package-lock.json`, `.github/workflows/ci.yml:79-83`, `apps/shell/electron-builder.cjs` (extraResources 715-871, `RUST_COMPONENTS`), `NOTICE`, `LICENSE-UNICODE.txt`.

## 3. Rust crates in shipped binaries on main

Manifests: `apps/sheets/native/xlsx-engine/Cargo.toml` (bin `xlsx-sidecar`, crate licence `Apache-2.0`, shipped as `native/xlsx-sidecar[.exe]` via electron-builder extraResources, mac/win/linux) and `apps/sheets/native/xlsx-wasm/Cargo.toml` (cdylib, wasm32-wasip1, depends on xlsx-sidecar by path; built by `apps/sheets/native/xlsx-wasm/build.mjs` into `apps/sheets/src/web/generated/xlsx-wasm.wasm`, not tracked in git).
Direct normal deps (engine): base64 0.22.1, calamine 0.38.0, cfb 0.15, ironcalc 0.9.1, quick-xml 0.38, roxmltree 0.21.1, serde 1, serde_json 1, uuid 1 (v4), zip 9 (deflate). Dev: tempfile only (not shipped). xlsx-wasm adds: serde, serde_json. No build-script crates that embed code (cc 1.4.0, find-msvc-tools, shlex appear in the lock as ironcalc/others' build deps; they do not embed third-party code in the output).

### 3.1 deny.toml coverage
- `apps/sheets/native/xlsx-engine/deny.toml`: `[licenses] version = 2`, allow = MIT, Apache-2.0, Apache-2.0 WITH LLVM-exception, BSD-2-Clause, BSD-3-Clause, 0BSD, Zlib, Unicode-3.0, Unlicense, CC0-1.0, BSL-1.0. No exceptions, no `[bans]`, `[advisories]`, `[sources]` sections.
- CI: only one step, `.github/workflows/ci.yml` lines 79-83: `EmbarkStudios/cargo-deny-action@v2.1.1`, `command: check licenses`, `manifest-path: apps/sheets/native/xlsx-engine/Cargo.toml`. **`xlsx-wasm` has no deny step of its own and no deny.toml**; it is only covered indirectly because its dependency tree is `xlsx-sidecar` (same lock content, the lock shows the same crate set plus xlsx-wasm) + serde/serde_json. cargo-deny on the engine uses the engine's Cargo.lock; the wasm crate has its own separate Cargo.lock (own `[workspace]`).
- `tools/gen-third-party-notices.mjs` (`rustCrates()`) lists the sidecar's crates through `cargo metadata` and **gaps/throws in CI/release builds** if cargo fails; there is no equivalent for xlsx-wasm in the notice generator, though the web build ships it.

### 3.2 Crate table (licences read from registry Cargo.toml; same lock for engine and wasm)
All rows: category permissive; notice duty = licence text + copyright (+ NOTICE where Apache crate ships one); status `fine` unless listed in §3.3.

| SPDX (as declared) | Crates (version) |
| --- | --- |
| MIT | calamine 0.38.0, cfb 0.15.0, zip 9.1.0, quick-xml 0.38.4 / 0.42.0, statrs 0.19.1, slab 0.4.12, nix 0.31.3, libm 0.2.16, simd-adler32 0.3.10, cfg_aliases 0.2.2, zmij 1.0.23, phf 0.12.1, phf_shared 0.12.1 |
| MIT OR Apache-2.0 (or Apache-2.0 OR MIT) | ironcalc 0.9.1, ironcalc_base 0.9.1, serde / serde_core / serde_derive 1.0.228, serde_json 1.0.150, base64 0.22.1, uuid 1.24.0, roxmltree 0.21.1, chrono 0.4.45, chrono-tz 0.10.4, indexmap 2.14.0, hashbrown 0.17.1, either, itertools 0.15, itoa, log, once_cell, rand 0.10.3, rand_core, getrandom 0.4.3, chacha20 0.10.2, cpufeatures 0.3.1, flate2 1.1.9, crc32fast, fast-float2, glam 0.33.2, bumpalo, bitflags 2.13.1, bitcode / bitcode_derive 0.6.9, arrayvec, atoi_simd, debug_unsafe, typed-path, regex 1.13.1 / regex-automata / regex-syntax, thiserror 2.0.21, proc-macro2, quote, syn 2.0.119 / 3.0.9, cfg-if, libc 0.2.186, web-time, errno, find-msvc-tools, shlex, core-foundation-sys, codepage 0.1.2, fastrand, futures-core/-task/-util 0.3.32, pin-project-lite, windows-link, windows-sys 0.61.2, equivalent, num-traits, autocfg, rustversion |
| Unlicense OR MIT | aho-corasick 1.1.4, byteorder 1.5.0, memchr 2.8.3, csv / csv-core ("Unlicense/MIT") |
| Apache-2.0 only | approx 0.5.1, zopfli 0.8.3 (Apache-2.0 requires licence copy; NOTICE if any) |
| Apache-2.0 OR BSL-1.0 | ryu 1.0.23 |
| Zlib | zlib-rs 0.6.6 |
| MIT OR Zlib OR Apache-2.0 / 0BSD OR MIT OR Apache-2.0 / Zlib OR Apache-2.0 OR MIT | miniz_oxide 0.8.9, adler2 2.0.1, bytemuck 1.25.2 |
| BSD-3-Clause (+ dual) | encoding_rs 0.8.35 = (Apache-2.0 OR MIT) AND BSD-3-Clause |
| (MIT OR Apache-2.0) AND Unicode-3.0 | unicode-ident 1.0.24 |
| Apache-2.0 / MIT | fnv 1.0.7 ("Apache-2.0 / MIT") |
| MIT/Apache-2.0 | siphasher 1.0.3 |

Resolved from registry: 94 of the lock's crates. Not found in the registry cache (target-specific or wasm-only; same authors/licences by name but **not verified here**): android_system_properties 0.1.5, iana-time-zone-haiku 0.1.2, js-sys 0.3.103, wasm-bindgen / -macro / -macro-support / -shared 0.2.126, windows-core / -implement / -interface / -result / -strings, r-efi 6.0.0, cc 1.4.0. All of them are `cargo-deny`-gated in CI by the engine manifest (cargo-deny checks all targets by default) unless an exception were added.

### 3.3 Non-fine / notes (Rust, main)

| Crate | Licence | Category | Notice duty | Status |
| --- | --- | --- | --- | --- |
| r-efi 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later (per `tools/gen-third-party-notices.mjs` SPDX_NOTE; Cargo.toml not in registry cache) | permissive with LGPL option | MIT/Apache text; project elects MIT. UEFI-only crate, not compiled into the macOS/Windows/Linux/wasi targets [INFERENCE] | needs legal review (low) |
| encoding_rs 0.8.35 | (Apache-2.0 OR MIT) AND BSD-3-Clause | permissive | BSD-3 clause text must be in notices (also noted in crates/deny.toml comment on the branches) | fine (notice duty) |
| ironcalc 0.9.1 / ironcalc_base 0.9.1 | MIT OR Apache-2.0 | permissive; the largest engine dependency (spreadsheet formula engine in the sidecar and wasm) | licence + copyright; [INFERENCE] no embedded data tables beyond code | fine |
| chrono-tz 0.10.4 | MIT OR Apache-2.0 | permissive; embeds the IANA tz database (public-domain data) | none for tzdata beyond crate licence | fine |

## 4. Rust crates on branches not yet on main (will ship: office-wasm)

Source: `/Users/choejinseo/.omp/wt/gui-rust-fileparse-d3-mm-0304012/crates` (superset) and `.../gui-rust-pptx-c2-mm-0304012/crates` (subset). Not read through `git show origin/feat/rust-stage2-plan` (no shell).

- **Workspace (d3)**: `jscompat, ooxml-xml, ooxml-pkg, docx-engine, pptx-engine, mtx, omml, file-parse, epub-engine, office-wasm, saxes, seu-host, spike-one-run-save`; `exclude = ["vendor", ".rhwp-source"]`; edition 2024; `[workspace.package] license = "Apache-2.0"`. c2 has the same minus `file-parse, epub-engine, saxes, seu-host`. `office-wasm` builds `wasm32-wasip1` (`node crates/office-wasm/build.mjs`) and is described in `crates/README.md` as the one entry point JS calls; `gen-third-party-notices.mjs` of d3 already has an `office_wasm.wasm` section (crates list, vendored/ported list, MPL §3.2 source pointer, `PATENTS`/`NOTICE`).
- **`crates/deny.toml`** (d3, 1 file): allow MIT, Apache-2.0, Apache-2.0 WITH LLVM-exception, BSD-2-Clause, **MPL-2.0**, BSD-3-Clause, 0BSD, Zlib, Unicode-3.0, Unlicense, CC0-1.0, BSL-1.0, **IJG**. Per-crate exceptions: `ring` (ISC), `rustls-webpki` (ISC), `untrusted` (ISC) and `webpki-roots` (CDLA-Permissive-2.0), commented as rhwp native-only test deps (ureq), `cfg(not(wasm32))`, "not shipped". CI workflow `seuoffice-rust.yml` (on main) runs fmt/clippy/test for `crates/` only when it exists; it has **no cargo-deny step** [INFERENCE from grep: only `cargo fmt/clippy/test`].
- **No `crates/vendor/*` other than `vendor/regress`** (d3 and c2): regress 0.12.0 (crates.io archive, MIT OR Apache-2.0, `LICENSE-MIT` + `LICENSE-APACHE` kept, `VENDORED.md`), patched: bounded backtrack stack and lazy-loop change (patches are SeuOffice's own, "carry no code of this project", prepared for upstreaming); wired by `[patch.crates-io]`.
- **`.rhwp-source/v0.9.0`** (git-ignored, `/.rhwp-source/` in `crates/.gitignore`): `file-parse` has `rhwp = { path = "../.rhwp-source/v0.9.0", optional, features = ["wasm-api"] }` (feature `hwp`, enabled by `office-wasm` features `... "hwp" ...`). So rhwp's full Rust tree (MIT, Edward Kim) and all its transitive crates (aes, argon2, blake3, ring, rustls*, resvg 0.45.1/0.47.0, usvg, tiny-skia, rustybuzz, skrifa, read-fonts, write-fonts, icu_collator + icu_*_data, moxcms, zune-jpeg, fax, png, gif, tiff, image, pdf-writer, subsetter, ml-kem, ml-dsa, curve25519-dalek, …) enter the d3 `Cargo.lock` (~3,000-line lock; ~225 `[[package]]` entries). The build must fetch the tree with `node tools/build-rhwp-core.mjs --source-only` at the tag in `vendor/rhwp-core/package.json`.
- **External crate licences (read from registry for the d3 lock, 57 resolved)**: nearly all `MIT OR Apache-2.0` or `Apache-2.0 OR MIT`; others: icu_collator / icu_collator_data / icu_locale_fallback_data / icu_normalizer_data / icu_properties_data / icu_provider 2.4.0 = **Unicode-3.0**; moxcms 0.8.1 and pxfm 0.1.30 = BSD-3-Clause OR Apache-2.0; tiny-skia 0.11.4 / 0.12.0 = BSD-3-Clause; curve25519-dalek 5.0.0 = BSD-3-Clause; brotli-decompressor 6.3.1 = BSD-3-Clause/MIT; zerocopy 0.8.63 = BSD-2-Clause OR Apache-2.0 OR MIT; zune-jpeg 0.4.21 / 0.5.15 = MIT OR Apache-2.0 OR Zlib; blake3 1.8.7 = CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception; pcx 0.2.5 = MIT OR Apache-2.0 OR WTFPL; fax, wuff, tiff, rustybuzz, fontdb, libm = MIT; ring 0.17.14 = Apache-2.0 AND ISC; rustls-webpki 0.103.16 / untrusted 0.9.0 = ISC; webpki-roots 1.0.12 = CDLA-Permissive-2.0 (these four only via native-only ureq, not wasm).
  Crates in the lock **not resolved here**: rhwp internal forks (`rhwp`, `rhwp-contracts`, `rhwp-jpeg-encoder`, `rhwp-svg2pdf`, `rhwp-zune-jpeg` — rhwp's list says `(MIT OR Apache-2.0 OR Zlib) AND IJG` for the zune fork and `(MIT OR Apache-2.0) AND IJG` for the jpeg-encoder fork) and a few others; the feature set that `office-wasm` links is unconfirmed [INFERENCE] (`cargo tree --features` not run).
- **`[package.metadata.notices.ported]`** appears only in `crates/file-parse/Cargo.toml`: `word-extractor 1.0.4` (MIT, npm), `ppt-to-text 1.0.1` (Apache-2.0), `cfb 1.2.2` (Apache-2.0), `yauzl 2.10.0` (MIT), `fast-xml-parser 5.10.1` (MIT). Other ports declared in prose (README/`description`): `jscompat` (JS semantics), `ooxml-xml` (scan.ts, xml-utils.ts, **fast-xml-parser**), `ooxml-pkg` (**JSZip 3.10.1** read/write, `packages/zip-gate`), `saxes` (**saxes 6.0.0**, ISC), `epub-engine` (`packages/epub-engine`), `docx-engine`/`pptx-engine`/`omml` (translations of `packages/docx-engine`, `packages/pptx-engine` — i.e. of GenOffice/IeumOffice-derived TS, Apache-2.0 under Mainfunc NOTICE), `mtx` (libeot), `file-parse`, `seu-host`, `office-wasm`. `NOTICE` (main, lines near end) already says a Rust file that translates the original works is a derivative and the GenOffice/IeumOffice notices keep applying.

### 4.1 Non-fine rows (branches)

| Component | Licence | Category | Notice duty | Status |
| --- | --- | --- | --- | --- |
| `crates/mtx` (Rust port of libeot's MTX decoder; derived from Monotype reference code "MTX License" relicensed by Brennan T. Vincent to MPL-2.0) | MPL-2.0 (crate-level `license = "MPL-2.0"`; `LICENSE` 383 lines with the Monotype note) + `PATENTS` (Microsoft/Monotype EOT patent grants, "good-faith effort") | weak-copyleft-file | MPL-2.0 file-level: keep MPL text, source of covered files available (§3.2; generator carries the repo URL), modifications to these files stay MPL; `PATENTS` file must travel; rest of workspace Apache-2.0 only "links" to it (README: "a crate of its own so that the boundary shows") | needs legal review (copyleft file boundary inside a statically linked wasm that would be FSL-licensed) |
| `crates/file-parse` `ported` list (word-extractor MIT, ppt-to-text Apache-2.0, cfb Apache-2.0, yauzl MIT, fast-xml-parser MIT) | as listed | permissive (translations) | each original's licence + copyright; Apache ones: NOTICE/licence text | needs legal review (ported-code attribution is declared only for file-parse; ooxml-xml / ooxml-pkg / saxes / epub-engine port code from fast-xml-parser, JSZip (MIT OR GPL-3.0-or-later), saxes (ISC) with no `notices.ported` metadata) |
| `.rhwp-source/v0.9.0` (rhwp as source dep, with `--features wasm-api`) | MIT (+ the crate list below) | permissive core; mixed extras | MIT text + `THIRD_PARTY_LICENSES.md` contents | needs legal review (see §5 for rhwp specifics; same issues now compiled into `office_wasm.wasm`) |
| rhwp-zune-jpeg / rhwp-jpeg-encoder | `… AND IJG` | permissive with IJG credit clause ("This software is based in part on the work of the Independent JPEG Group") | credit sentence in docs; `deny.toml` allows `IJG` explicitly | needs legal review (low) |
| `crates/vendor/regress` 0.12.0 | MIT OR Apache-2.0 | permissive | keep both LICENSE files + change notice (VENDORED.md lists patches) | fine |
| webpki-roots / ring / rustls-webpki / untrusted | CDLA-Permissive-2.0 / Apache-2.0 AND ISC / ISC / ISC | permissive (data licence for webpki-roots) | only if shipped; recorded as native-only test deps | fine if truly not compiled for wasm; confirm with `cargo tree -p office-wasm` |
| icu_* data crates | Unicode-3.0 | permissive | Unicode licence text must ship (`LICENSE-UNICODE.txt` already travels) | fine |
| napi / any other `crates/*` | **not found** | — | — | needs legal review: no napi crate and no other `feat/rust-*` branch could be inspected without git |

## 5. Vendored trees and copied third-party code

### 5.1 `vendor/rhwp-core` (prebuilt wasm; built from rhwp v0.9.0 + 32 patches)
- Files: `LICENSE` (MIT, Copyright (c) 2025-2026 Edward Kim), `THIRD_PARTY_LICENSES.md` (rhwp's own), `README.md` (Korean; decisions 0050/0116), `package.json` (`@rhwp/core` 0.9.0-ieum.26, `private:true`, `license: MIT`, `rhwp.tag v0.9.0`, `rhwp.commit c9095c5f…`, `wasmSha256 70372a6d…`, 32 patches listed), `rhwp.js`, `rhwp.d.ts`, `rhwp_bg.wasm`, `rhwp_bg.wasm.d.ts`, `patches/*.patch` (SeuOffice/IeumOffice changes, 32 files).
- Shipped: `rhwp_bg.wasm` copied to `resources/wasm/rhwp_bg.wasm` and into `apps/hwp` (HWP editor) and web builds.
- `THIRD_PARTY_LICENSES.md` crate list (direct dependencies table, 52 rows + 4 internal codec forks):
  - permissive: ~46 rows are `MIT OR Apache-2.0` / `Apache-2.0 OR MIT` / `MIT` / `BSD-3-Clause` (ed25519-dalek 2.2.0) / CC0-1.0 OR Apache-2.0 (blake3) / Unicode; `encoding_rs` (Apache OR MIT) AND BSD-3; `pcx` MIT OR Apache-2.0 OR WTFPL; `skia-safe` MIT (optional native); `subsecond` (optional dev hot-patch, MIT OR Apache-2.0).
  - flagged: `rhwp-zune-jpeg 0.5.15-rhwp.1` = (MIT OR Apache-2.0 OR Zlib) AND **IJG**; `rhwp-jpeg-encoder 0.7.1-rhwp.1` = (MIT OR Apache-2.0) AND **IJG**; `rhwp-svg2pdf`, `rhwp-hayro-jbig2/-ccitt/-jpeg2000` (Apache-2.0 OR MIT forks of hayro by Laurenz Stampfl; "not official releases"), `rhwp-qcms` (qcms 0.3.0 fork, MIT; Mozilla/Marti Maria notices), `office_oxide` 0.1.9 (MIT OR Apache-2.0, `pdf-import`), `rhwp-pdf-import-backend` (pdf_oxide 0.3.78 derived, MIT OR Apache-2.0; its **DejaVu Sans fonts (`include_bytes!`) under the Bitstream Vera/DejaVu font licence**, "whether they reach the final WASM is not asserted").
  - ported / non-crate code in the wasm: Intel MediaSDK integer IDCT (MIT, `print_jpeg_idct.rs`), PDFium CStretchEngine arithmetic (BSD-3-Clause, `licenses/pdfium/LICENSE`), Volexity hwp-extract (BSD-3-Clause), Hancom hwpx-owpml-model / dvc (Apache-2.0, spec reference only, no code copy), outlines derived from **Latin Modern Math 1.959 under the GUST Font License** (rhwp `src/renderer/equation/*_outline.rs`, compiled into the wasm; a 13,488-byte derived OTF with renamed family is shipped as `assets/fonts/LatinModernMath-VariableOutline-subset.otf`), **Nimbus Roman (URW Base35) metrics data** (names/Unicode/advance widths only, `URW-FONT-NOTICE.txt`; the URW fonts themselves are distributed under licences the project does not state here).
  - web-font list in that file (Pretendard, Noto Serif/Sans KR, Nanum, Gowun, D2 Coding, Spoqa Han Sans — all OFL 1.1; RHWP Old Hangul subset — OFL 1.1; Latin Modern Math — GUST; **Cafe24 써라운드 / 슈퍼매직 — "카페24 무료 배포" (free-distribution custom licence)**; 해피니스 산스 — OFL 1.1) is rhwp's repo asset list, i.e. the studio (`rhwp-studio`) build. A grep for Cafe24 / 카페24 in `apps`, `packages`, `tools`, `docs`, `scripts` and NOTICE returned no hit, so [INFERENCE] those two fonts are **not** shipped by seuoffice; the Old Hangul face (`RHWPOldHangul-Regular.woff2`, OFL 1.1) **is** (NOTICE says the web build ships it with `hwp/studio/fonts/SourceHanSerifK-OFL.txt`).
  - rhwp's own statement: all Rust deps are permissive or carry a permissive option; flags in its list: IJG, WTFPL option, GUST, Cafe24, OFL.
- Status:

| Item | Licence | Category | Notice duty | Status |
| --- | --- | --- | --- | --- |
| rhwp core (v0.9.0) | MIT | permissive | MIT text + copyright 2025-2026 Edward Kim (ships as `vendor/rhwp-core/LICENSE`; NOTICE also carries Hancom's required reference sentence for HWP format) | fine |
| IeumOffice patches (`patches/*.patch`, ieum.1-.26) | Apache-2.0 (project) over MIT base | permissive | change notice per file (patch headers) | fine |
| IJG-covered code (rhwp-zune-jpeg, rhwp-jpeg-encoder) | IJG | permissive with credit clause | "based in part on the work of the Independent JPEG Group" in docs | needs legal review (low) |
| Latin Modern Math derived outlines in the wasm | GUST Font License (LPPL-based) | OFL-like font licence on embedded outline data | keep copyright and licence; renaming condition for modified font files | needs legal review |
| DejaVu Sans fonts inside pdf_oxide backend (if linked) | Bitstream Vera / DejaVu licence | OFL-like font licence | licence + copyright; rename if modified | needs legal review (linkage not established) |
| Nimbus Roman (URW) metrics data | URW Base35 licence (not stated in the file; font programs not included) | unknown | `URW-FONT-NOTICE.txt` | needs legal review |
| Old Hangul subset woff2 (web only) | OFL 1.1 (Source Han Serif K, Adobe, subset renamed "RHWP Old Hangul") | OFL-font | licence text beside it (done) | needs legal review (OFL bundle inside non-OFL app; subset renamed per NOTICE) |

### 5.2 `vendor/drawio` (no draw.io files tracked; bundle fetched at build)
- Tracked: `LICENSE` (Apache-2.0 of the draw.io repo, tag v32.6.9), `README.md`, `drawio.json` (pin v32.6.9, `draw.war` sha256 31afc82b…, remove list, one `cut`), `inventory.json`, `bundle.mjs`, `prepare.mjs`. The war (~49.7 MB) is downloaded, hash-verified and unpacked to `apps/diagram/out/drawio/` → shipped as `resources/modules/diagram/drawio` (+ web if built).
- Removed from the shipped bundle because outside the allowlist: PlantUML converter, libavoid-js (**LGPL-2.1**), ELK (**EPL-2.0**), Glyphicons (**CC BY 3.0**). `js/extensions.min.js` embeds ELK and libavoid byte-for-byte, so the project **cuts those byte ranges out** of that one file (owner-approved exception 2026-11-03; the cut result hash is pinned in `drawio.json`). Consequence: ELK-based Mermaid layout falls back to dagre.
- `inventory.json` components of what ships (22): Apache-2.0 ×6 (draw.io, shape and icon libraries, DOMPurify, Bridge.NET runtime, MathJax + fonts, mhchemParser), MIT ×12 (spin.js, CryptoJS, regenerator-runtime, Rough.js, perfect-freehand, jQuery, JSZip, simple-peer, OrgChart.Layout, dagre+graphlib, lodash parts, cose-base+layout-base), BSD-3-Clause ×1 (ieee754), CC-BY-4.0 ×1 (templates), MIT AND Zlib ×1 (pako), OFL-1.1 ×1 (Architects Daughter font).

| Item | Licence | Category | Notice duty | Status |
| --- | --- | --- | --- | --- |
| draw.io core + shape/icon libraries | Apache-2.0 plus **Atlassian-related usage-restriction text** (copied verbatim into the notice per README) | permissive with an extra use restriction on shapes/icons | Apache text + NOTICE + restriction text | needs legal review (the restriction wording is not in the allowlist model; README says it does not reach this app / user drawings) |
| ELK / libavoid byte-cut from `extensions.min.js` | EPL-2.0 / LGPL-2.1 | weak-copyleft-file / LGPL | removed; "which ranges were cut" stated in notice | needs legal review (modified third-party file; the removal is an owner-approved exception) |
| templates/ | CC-BY-4.0 | CC-BY | attribution + licence text (`templates/LICENSE` copied) | fine (allowlist permits) — attribution required |
| Architects Daughter font | OFL-1.1 | OFL-font | licence text; Reserved Font Name rule | needs legal review (OFL font in non-OFL bundle) |
| MathJax fonts, others | Apache-2.0 / MIT | permissive | texts | fine |

### 5.3 Vendored source inside packages (`src/vendor/<name>/`, found by `gen-third-party-notices.mjs` `vendoredSources()`)

| Path | Upstream | Licence | Category | Notice duty | Status |
| --- | --- | --- | --- | --- | --- |
| `packages/pptx-engine/src/vendor/mtx/` (`LICENSE`, `PATENTS`, `README.md`, `ctf.ts`, `index.ts`, `lzcomp.ts`) | TypeScript port of libeot decoder (Brennan T. Vincent, MPL-2.0) from Monotype MTX reference code; libeot commit `4e52d8b4…` (port source commit not recorded) | **MPL-2.0** + `PATENTS` | weak-copyleft-file | keep MPL text + `PATENTS` verbatim (generator does, `apps/shell/tests/third-party-notices.test.ts`), source for covered files available (§3.2), changes to those files stay MPL; bundled into the app via `embedded-fonts.ts` (`mtxToSfnt`) | needs legal review |
| `packages/docx-engine/src/vendor/emf-converter/` (`index.mjs` ~5,900 lines, `index.d.mts`, `LICENSE`, `README.md`) | emf-converter 2.0.2 (ChristopherVR), published npm dist + many local GenOffice/SeuOffice fixes | Apache-2.0 | permissive | licence text; **change notice on modified files** (README lists local modifications; `index.mjs` header must carry "changed" marker); NOTICE of upstream if any | needs legal review (Apache §4(b) modified-file notice inside minified-dist-derived file) |
| `packages/pptx-engine/tests/fixtures/LICENSE-python-pptx.txt` | python-pptx fixtures | MIT, Copyright (c) 2013 Steve Canny | permissive | tests only, not shipped | fine |
| `apps/docs/tests/encrypted-fixtures/LICENSE-msoffcrypto-tool.txt` | msoffcrypto-tool fixtures (upstream rev 6d9e72c5…) | (see file; upstream is MIT) | permissive [INFERENCE] | tests only, not shipped | fine |
| `tools/ooxml-validate/schemas/*.xsd` | ISO/IEC 29500-4 / ECMA-376 Transitional XSDs via python-docx `ref/xsd`; `am3d.xsd` from [MS-ODRAWXML]; one marked local amendment | standard text, redistribution terms by ECMA/ISO and Microsoft (not an SPDX licence) | unknown | stated in NOTICE; "tests and dev only, not shipped" | needs legal review (provenance of XSD redistribution terms; claimed not shipped) |
| `apps/shell/resources/builtin-skills/` (shipped as `resources/builtin-skills`) | `meeting-minutes` (github/awesome-copilot, MIT), `internal-comms`, `docx`, `pptx`, `xlsx`, `pdf` (anthropics/skills commit 2c5958e “Move Office skills to the Apache 2.0 license”, Apache-2.0, Anthropic PBC, “upstream left the copyright line of its appendix unfilled”), `humanizer` (blader, MIT), `copy-editing` (coreyhaines31, MIT), `find-skills` (vercel-labs, MIT, **modified**: appended IeumOffice section), plus project-authored `administration-report*`, `hwp-document`, `mindmap`, `diagram`, `html-document` (Apache-2.0). `docx/pptx/xlsx/scripts/office/schemas` holds the ECMA-376 XSDs, OPC schemas and Microsoft Office extension schemas “exactly as upstream ships them”; they ship in the installer. | per `builtin-skills.json` | permissive (MIT / Apache-2.0); schemas not an SPDX licence | licence file beside each (present: LICENSE / LICENSE.txt in 7 of 9 external skills; `humanizer` and `meeting-minutes`/`copy-editing`/`find-skills` have `LICENSE`); Apache-2.0 modified-file notice for find-skills | Anthropic docx/pptx/xlsx/pdf: **needs legal review** — those upstream skills were source-available/proprietary until commit 2c5958e moved them to Apache-2.0 [from the upstream commit text found by web search]; the pinned commit is the Apache one; I fetched upstream `main` `skills/docx/LICENSE.txt` and it is still Apache-2.0 text. Other skills: fine. ECMA/MS schemas in skills: needs legal review |
| `packages/pipelines/src/slides/templates` (12 design templates) | re-authored from frontend-slides (zarazhangrui, MIT, commit 9906a34d…) | MIT | permissive | MIT text (in NOTICE) | fine |
| `apps/pdf/src/shared/radicals.ts` | generated from Unicode UCD 17.0.0 EquivalentUnifiedIdeograph.txt | Unicode License v3 | permissive | `LICENSE-UNICODE.txt` ships beside NOTICE | fine |
| HWP Hanja dictionary (`libhangul data/hanja/hanja.txt`, cut at build) | libhangul (Choe Hwanjin) | BSD-3-Clause | permissive | full text in NOTICE (present) | fine |
| Lucide / Feather icon geometry (AiMark) | Lucide ISC; circle from Feather MIT | permissive | texts at lucide-icons URL; NOTICE states them | fine |
| Fluent UI icons | `@fluentui/react-icons` MIT | permissive | hand-written notice | fine |

### 5.4 LICENSE/NOTICE/COPYING files found with a glob (no `git ls-files`)
`LICENSE`, `NOTICE`, `LICENSE-UNICODE.txt` (root); `vendor/rhwp-core/LICENSE`; `vendor/drawio/LICENSE`; `packages/pptx-engine/src/vendor/mtx/LICENSE`; `packages/pptx-engine/tests/fixtures/LICENSE-python-pptx.txt`; `packages/docx-engine/src/vendor/emf-converter/LICENSE`; `apps/shell/resources/builtin-skills/{xlsx,pptx,pdf,internal-comms,docx}/LICENSE.txt`, `{meeting-minutes,humanizer,find-skills,copy-editing}/LICENSE`; `apps/docs/tests/encrypted-fixtures/LICENSE-msoffcrypto-tool.txt`; `apps/docs/src/renderer/fonts/LICENSE-OFL.txt`. Other font licence files (packages/ui/template-fonts etc.) were not enumerated because the glob pattern covers only the names above; the fonts audit should list them.

## 6. Prebuilt binaries tracked in git

Glob `**/*.{wasm,node,dylib,dll,so,exe,a,bin}` (gitignore respected, so untracked builds are excluded): **one hit**.

| File | Origin | Licence | Category | Notice duty | Status |
| --- | --- | --- | --- | --- | --- |
| `vendor/rhwp-core/rhwp_bg.wasm` | built from rhwp v0.9.0 (+patches) with `wasm-pack 0.15.0` per `tools/build-rhwp-core.mjs`; sha256 pinned in `vendor/rhwp-core/package.json` | MIT (rhwp) with embedded crates/outline data of §5.1 | mixed (permissive + IJG + GUST font data) | MIT + `THIRD_PARTY_LICENSES.md`; generator emits the crate list as "N crates, all under permissive terms" (`RUST_COMPONENTS = 2`) | needs legal review (§5.1) |

Untracked-but-shipped blobs (built or copied at package time, evidence: `apps/shell/electron-builder.cjs` extraResources): `native/xlsx-sidecar[.exe]` (§3); `wasm/pdfium.wasm`, `wasm/hb-subset.wasm`, `wasm/qpdf.wasm`, `wasm/rhwp_bg.wasm` (copies of the npm/vendor blobs above); `ocr/vision-ocr` (macOS helper from `packages/pdf2docx/ocr-helper`, source not audited), `ocr/win-ocr.exe`, `quicklook/win-quicklook.exe` (built from tracked sources, not audited); `LICENSES.chromium.html`; `apps/sheets/src/web/generated/xlsx-wasm.wasm` (web, generated, git-ignored). No tracked `.node/.dylib/.dll/.so/.exe`.

## 7. Items that need legal review (flat list, evidence paths)

1. jszip 3.10.1 (MIT OR GPL-3.0-or-later) — `package-lock.json`, `tools/gen-third-party-notices.mjs` SPDX_NOTE.
2. dompurify 3.4.17 (MPL-2.0 OR Apache-2.0) — same; also draw.io's own copy `vendor/drawio/inventory.json`.
3. @univerjs/telemetry 0.25.1 and khroma 2.1.0 (no licence field; manual exceptions) — `tools/check-licenses.mjs` EXCEPTIONS.
4. node-forge 1.4.1 (BSD-3-Clause OR GPL-2.0), shipped though `dev:true` — `package-lock.json`, `apps/pdf/package.json`.
5. electron 43.8.3 + Chromium (`LICENSES.chromium.html`), canvaskit-wasm 0.42.0 (embedded Skia/etc. not in EMBEDDED), @embedpdf/pdfium (FTL/AGG customs), pdfjs-dist standard_fonts — `apps/shell/electron-builder.cjs`, `tools/gen-third-party-notices.mjs`.
6. r-efi 6.0.0 (LGPL-2.1-or-later option, not compiled) — `apps/sheets/native/xlsx-wasm/Cargo.lock`, generator SPDX_NOTE.
7. `packages/pptx-engine/src/vendor/mtx` and (branches) `crates/mtx` — MPL-2.0 + PATENTS; `NOTICE`; `crates/README.md` (“the one crate under MPL-2.0”).
8. `packages/docx-engine/src/vendor/emf-converter` — Apache-2.0 with local modifications; `README.md` of the dir.
9. vendor/rhwp-core: IJG forks, GUST-derived outlines, DejaVu (if linked), Nimbus Roman metrics, Old Hangul OFL subset — `vendor/rhwp-core/THIRD_PARTY_LICENSES.md`, `NOTICE`.
10. vendor/drawio: Atlassian use-restriction text on shapes, ELK (EPL-2.0) / libavoid (LGPL-2.1) byte-cut from `extensions.min.js`, Architects Daughter (OFL-1.1) — `vendor/drawio/README.md`, `drawio.json`, `inventory.json`.
11. `apps/shell/resources/builtin-skills/{docx,pptx,xlsx,pdf}` (anthropics/skills, pinned to the commit that re-licensed them to Apache-2.0) and their embedded ECMA-376/MS XSDs; `tools/ooxml-validate/schemas` (dev only) — `builtin-skills.json`, `NOTICE`.
12. Branch workspace (not on main): `crates/file-parse` ported-code list, un-declared ports in ooxml-xml / ooxml-pkg / saxes / epub-engine, rhwp path-dep feature set linked into `office_wasm.wasm`, no `cargo-deny` step for `crates/` in `.github/workflows/seuoffice-rust.yml` — `crates/Cargo.toml`, `crates/deny.toml`, `crates/file-parse/Cargo.toml`.
13. No cargo-deny coverage of `xlsx-wasm` itself (only engine manifest) and no notice section for the web-shipped `xlsx-wasm.wasm` — `.github/workflows/ci.yml:79-83`, `tools/gen-third-party-notices.mjs` (`rustCrates()`).

## 8. Provenance / derivation items for FSL review (not licences of dependencies)
- First commit d2fe8ddaa (GenOffice, Apache-2.0); `NOTICE` carries "GenOffice Copyright 2026 Mainfunc, Inc.", IeumOffice modifications (imported at aea1414), seuoffice modifications ("Copyright 2026 SeuPut"), and states that Rust translations of the original code remain derivatives; `docs/seuoffice/upstream-edits.md` records changed upstream files (closed 2026-11-12). Apache-2.0 §4 duties (licence copy, NOTICE, change notices) already ship via electron-builder extraResources `LICENSE.txt`, `NOTICE.txt`, `LICENSE-UNICODE.txt`, `THIRD-PARTY-NOTICES.txt`.
- The `crates/` translations (docx-engine, pptx-engine, omml, jscompat, epub-engine, file-parse) translate GenOffice/IeumOffice TS (Apache-2.0) and third-party libraries named above.
