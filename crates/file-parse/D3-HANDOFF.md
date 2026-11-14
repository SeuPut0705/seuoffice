# D3: the switch of @seuoffice/file-parse to the Rust readers

Handed over on 2026-11-13 from the MacBook session (dispatches d1-d4 of main)
to a Mac mini session. Branch `feat/rust-fileparse-d3`, pushed; it builds on
D1's `feat/rust-fileparse-u1` (the readers, the gate) and B4's
`feat/rust-docx-b4` (the loader codec), and is merged with `origin/main`
8a63a954a.

## Goal

`@seuoffice/file-parse` keeps every exported name and type; its readers are
`crates/file-parse` in `office_wasm.wasm`; callers change only by an engine
start-up; the TypeScript readers are deleted (decisions 0025 rule 5, 0026).

## State

Done and pushed:

- Binding: `packages/file-parse/src/*.ts` are thin calls through
  `src/engine.ts` (`callEngine` → `@seuoffice/engine-wasm` `engineInvoke`,
  `fnPrefix: 'fileParse.'`, host steps on callback slot 0). Engine refusals
  come back as the TS classes (`RedactionMarkError`, `DamagedFileError`,
  `RangeError`, `TypeError`; a plain `Error` crosses as its message alone).
- Rust routes: `crates/office-wasm/src/invoke/file_parse.rs` (`js_error_name`,
  every export, `constants` for the parity test, `xlsxWithheldOpen/Marker`:
  the `xlsxWithheldCells` closure asks by handle, the engine keeps four
  records, the closure reopens on `WithheldEvictedError`). Dispatch arm in
  `lib.rs invoke_command`.
- Host side kept, and why (also in `packages/file-parse/AGENTS.md`): the file
  system (reading, the large-zip text-part copy), the three readers that
  await (PDF/pdfjs, xmind-engine, odt-engine; run before the call and passed
  as `hosted`), and the host steps of `src/host-steps.ts` (parse5 for HTML
  redaction and EPUB, draw.io, `fileparse.localOffsetSeconds`).
- `crates/seu-host` goes over `seu_host.host_callback(0, …)` (D's
  `host_call/host_take` imports are gone); `tools/docx-diff/engine.ts` answers
  slot 0 from the same steps map.
- Start-up: `node` export condition (`src/node/*.ts` → `@seuoffice/engine-wasm/node`);
  `apps/{sheets,hwp,diagram,epub,mindmap}/src/main/engine-init.ts` start from
  the `?asset` wasm and set `SEUOFFICE_WASM` for worker threads; the shell's
  index worker starts from that env; vitest configs use
  `packages/engine-wasm/src/vitest.ts` (asset plugin, env, setup file).
- `crates/office-wasm/build.mjs` prepares `crates/.rhwp-source` when missing.
- Gate: `tools/fileparse-diff/reference/` is `packages/file-parse/src` frozen
  at origin/main 8a63a954a (`node tools/fileparse-diff/freeze-reference.mjs
--base <rev> --force`, after `rm -rf tools/fileparse-diff/reference`; run it
  without flags after a case file gains an import of `packages/file-parse/src`).
  HWP memo cases across a DST change; the fileparse gate step runs with
  `TZ=America/New_York`.
- Licences (main's decision, d3): `crates/deny.toml` allows IJG; per-crate
  exceptions for ring, rustls-webpki, untrusted, webpki-roots (rhwp's
  native-only ureq stack, not shipped). No `[graph] targets`.
- Memo dates (main approved): D1's rhwp patch 0045 (`set_local_offset`)
  plus the host step. `vendor/rhwp-core/rhwp_bg.wasm` is not rebuilt (no
  wasm-pack on the MacBook); the desktop build never sets the hook.

Last runner results on 736befd19:

| run                        | result                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| seuoffice 43335965734      | ✅                                                                                                                                                                                                                                                |
| CI 43335961189             | ❌ only others': `@seuoffice/docx-engine` and `@seuoffice/docs` (comments-save-tags, ai-hidden-pictures: B4's port of main's docx redaction batch, in progress), lint in `tools/pptx-diff` (C2). `@seuoffice/file-parse` and all e2e shards pass. |
| seuoffice rust 43335956915 | running at hand-over                                                                                                                                                                                                                              |

Local, earlier: file-parse tests 514/516 at 919b4e946 (the two were a Rust
fail-open fixed by D1 in 940a039fc), xlsx-gateway 678/678, three seeded
faults in `invoke/file_parse.rs` caught by the package tests.

## Waiting on others

- D1 (`feat/rust-fileparse-u1`, session 01a1cd7c): merges 88757c9ea (DST
  cases; raises the hwpMemosOf floor) after its fault round, then reports.
  Merge its next head; there is nothing of D3's in its files.
- B4 (`feat/rust-docx-b4`, session 01a1d002, head 197759de0 at hand-over,
  not merged here yet): the docx-engine part of main's redaction batch
  (`withheld.ts`, notes/parse/parse-package/patch), docx-engine CI. Merge its
  head; take B4's side for `packages/docx-engine/src/**` and ours for
  `packages/file-parse/**`.
- C2 (`feat/rust-pptx-c2`): lint of `tools/pptx-diff`, the pptx gate jobs.

## Not done

- One full green round of the three workflows on one head (blocked only by
  the items above).
- The final report to main (dispatch d1): head, run ids, comparison numbers
  (from the fileparse gate artifact `fileparse-diff-out`), what TS is deleted
  (every reader of `packages/file-parse/src`: docx, pptx, xlsx, the
  redactions, doc, ppt, hwp, epub, parse dispatch, zip-text-parts' `isTextPart`,
  attachable/xlsx-dates functions), what stays on the host and why (above).
- Third-party notices for the crates of `office_wasm.wasm`
  (`tools/gen-third-party-notices.mjs` lists only rhwp_bg.wasm's and the
  sidecar's crates). Reported to main; not D3's scope.

## How to run

```
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
node crates/office-wasm/build.mjs                  # also fetches the rhwp source once
npm run test -w @seuoffice/file-parse
npm run test -w @seuoffice/xlsx-gateway
gh workflow run "seuoffice rust" --ref feat/rust-fileparse-d3   # gates, clippy, cargo test, faults
gh workflow run CI --ref feat/rust-fileparse-d3
gh workflow run seuoffice --ref feat/rust-fileparse-d3
```
