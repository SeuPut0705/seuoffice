# C2: the switch of @seuoffice/pptx-engine to the Rust engine

Batch C2 of the slides port (README.md, "Procedure: whole-engine batches").
Started 2026-11-12 on `feat/rust-pptx-c2`, on top of C1 (`feat/rust-pptx-u1`)
and B4 (`feat/rust-docx-b4`), whose binding conventions it reuses.

## Goal

`@seuoffice/pptx-engine` keeps every exported name and type. Its
implementation modules become thin synchronous functions over the WASM engine
(the TS-async exports stay `async`). The model (`SlideDeck`, `Slide`,
`SlideElement`, `PackageArchive`) stays a JS object. Importers are unchanged
apart from an init call. The package's tests are the regression suite. The
TypeScript engine is frozen under `tools/pptx-diff/reference/` and the gate
compares against that copy. One implementation per function.

## Conventions taken from B4 (not forked)

- Wire: `{cmd:'invoke', fn:'pptx.<export>', args, callbacks?, nowMs}`. The
  prefix routes to `crates/office-wasm/src/invoke/pptx_table.rs` (generated)
  inside `jscompat::reading_leniently`, as `fileParse.` does for D3.
- TS codec: `engineInvoke` / `revive` / `Shape` of `@seuoffice/engine-wasm`
  with `fnPrefix: 'pptx.'`. Blobs are `{"$blob": n}`, Maps entries, Sets values,
  functions callback slots of `seu_host.host_callback`.
- Generator: B4's `tools/docx-diff/binding/{manifest,gen,rust-table}.ts`,
  parametrized by an engine config; the pptx config and overrides live in
  `tools/pptx-diff/binding/`. Docx output stays byte-equal.
- Init: auto-init sync under the `node` export condition; renderer and web call
  the async init once (`apps/slides/src/{main,web}/engine-init.ts` of B4). The
  wasm build step and the CSP are B4's.
- Hot tiny exports: one render benchmark at the batch end; a function whose wasm
  route makes it more than 5% slower stays TypeScript only, its Rust copy is
  deleted, and the ledger gets a row with the numbers.

## What pptx adds: arguments the engine changes

TS exports change their arguments in place: 64 take an `OpenedPptx`, 23 a
`PackageArchive`, 72 a `Slide`, 2 a `SlideDeck`. Callers hold references into
these objects (an element they found, the slide they render, the entries map
an undo snapshot copied), so the binding writes the engine's answer back into
the same objects.

The data shape, one table both sides read:

| Argument kind | Request                                                        | Written back                                                 |
| ------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| `json`        | JSON                                                           | nothing                                                      |
| `slide`       | the `Slide` as JSON (Rust `&mut Slide`)                        | `out[i]`: the slide's JSON; `adopt` into the caller's object |
| `deck`        | the `SlideDeck` as JSON (Rust `&mut SlideDeck`)                | the same                                                     |
| `archive`     | `{ entries: [[path, {$blob:n}]...], originalHash }`            | `out[i]: { changed: [[path, {$blob}\|null]...], paths }`     |
| `opened`      | `{ deck, archive }` as the two rows above                      | `{ deck, archive }` as above                                 |
| `slideOf`     | a `Slide` of the opened deck, sent as its index (Rust `usize`) | through the `opened` argument                                |

- The kind comes from the Rust signature: a `&mut` parameter is written back;
  `OpenedPptx`/`PackageArchive` are the structured kinds. The generator emits
  the row and the TS wrapper from the same manifest entry.
- A pptx row answers `{ value, out }`; the pptx binding unpacks it. The B4
  reply frame is unchanged.
- `adopt(target, next)`: own keys of `target` set from `next`, keys `next`
  lacks deleted; nested plain objects adopted recursively; an array of objects
  with a string `id` matched by `id` (an element keeps its object across a
  reorder), other arrays by index; anything else assigned.
- The archive: Rust compares its entries after the call with the request blobs
  and answers only what changed; the JS map gets a new `Uint8Array` per changed
  entry (never mutated in place, AGENTS.md) and is reordered to `paths` only
  where the order differs.
- Process state of the TypeScript kept per instance: the id counter of
  `parse.ts` (`Uids`, one global in office-wasm, `Uids::next`), `insertCounter`
  (a Rust static), `crypto.randomUUID` (WASI random through the loader),
  `Date.now()` (`nowMs`). `saveSnapshot` (a WeakMap keyed by `OpenedPptx`)
  stays a WeakMap of the binding: `savePptx` answers the snapshot, the binding
  keeps it, `commitSaved` sends it.

## Exports that stay TypeScript or are hand-written

- `savePptxToFile`: no file system in the engine. The binding calls the
  engine's `savePptx` and streams the bytes to the file (host code).
- `PackageArchive`: stays a JS class holding `entries` and `originalHash`
  (callers read `entries`, `readBytes`, `readText`). Its methods that parse
  (`readRels`, `readPresentation`, `resolveSlideChain`) call the engine with
  the parts they read.
- Functions taking functions (`parseChartXml`'s `parseFill`,
  `patchGroupChildXml`'s patch): callback slots.
- Types, consts of plain data: copied as TypeScript; a parity test reads the
  Rust value where Rust has one.

## Slices (after the blocking steps)

Blocking: B4's push (generator, `engineInvoke` in engine-wasm, prefix
dispatch), C's push (`Deserialize` for the model and the deck-op option types,
`Uids::next`). Then:

1. Rust (`crates/office-wasm/src/invoke/pptx_*.rs`, the prefix line of
   `lib.rs`): the argument kinds above, hand routes, the global `Uids`.
2. Binding (`tools/pptx-diff/binding/**`, the generator's engine config,
   `packages/pptx-engine/src/engine*.ts`): the generated modules and table.
3. Plumbing: freeze `packages/pptx-engine/src` into
   `tools/pptx-diff/reference/` and repoint `tools/pptx-diff`; package.json
   exports with the `node` auto-init; vitest `setupFiles` of every package
   whose tests reach the engine; the slides renderer's init.
4. Gate additions: the model round trip (TS JSON -> Rust -> JSON, byte-equal,
   every deck of `DECKS` and every slide after each deck op); the render
   benchmark (`tools/pptx-diff/bench-render.ts`).

## Checks, once at the end

The pptx-diff comparison and faults, clippy, `npm run test -w
@seuoffice/pptx-engine` and the packages that import it, the render benchmark,
then `CI`, `seuoffice` and `seuoffice rust` on runners.

## Handoff (2026-11-13, MacBook to Mac mini)

The batch moves to the Mac mini (main's load move, dispatch d3). State at the
pushed head of `feat/rust-pptx-c2`.

### What is done

- The TypeScript engine is frozen in `tools/pptx-diff/reference/` (main's
  redaction changes b55ef3684 and 288118079 applied to it by hand: index,
  parse, xml-utils, redaction-xml). The gate imports only the reference.
- The generator is B4's (`tools/docx-diff/binding/gen.ts`) with an engine
  config: `--engine pptx` reads `tools/pptx-diff/binding/{config,kinds,wrapper,rows,overrides}.ts`
  and writes `packages/pptx-engine/src/*` (47 modules, 3 copied, `crc32`
  dropped), `crates/office-wasm/src/invoke/pptx_table.rs` (289 rows) and
  `tools/pptx-diff/binding/manifest.json`. Without a flag it writes the docx
  binding unchanged. TS-only: `savePptxToFile`, `ownValue`, `setOwn`,
  `xmlParser`, `xmlArray`, `sfntCmapLookup`, plain-data consts, and the
  `PackageArchive` accessors.
- Hand-written: `packages/pptx-engine/src/{engine,engine-adopt,engine-init,engine-url}.ts`,
  `src/node/*`, `crates/office-wasm/src/invoke/{pptx,pptx_routes}.rs`,
  `crates/office-wasm/src/calls/pptx_roundtrip.rs` (gate group
  `pptxRoundtrip`, `tools/pptx-diff/calls-roundtrip.ts`).
- Init: `node` export condition, slides main/renderer/web `engine-init.ts`,
  vitest `setupFiles` (pptx-engine, pptx-render, pipelines, shell; slides and
  pptx-ops had B4's).
- Render benchmark: crates/pptx-engine/README.md ("C2 is on"); no export stays
  TypeScript.
- Redaction (main's d2): `read_redact_label` ported (60ce84173) with 12 gate
  inputs and 2 fault probes; C took both into u1 (e70ddfb01, ee9a20614).
- The independent review's two findings are fixed: a slide part listed twice
  keeps two slide objects (`tests/slide-listed-twice.test.ts`, failed before
  the fix), and archive parts are copied out of the reply frame.

### Taken from the other streams

- Stream C (`feat/rust-pptx-u1`), up to 64221b7ec: model `Deserialize`
  (strict), `Uids::next`, `open_pptx_with`/`open_archive_with`, option-struct
  bytes as `{"$bytes"}`, `GroupChildSlice`/`HierLayout` `Serialize`,
  stored media in `save_pptx`, `canonical_xml` in `parse_slide` (747604879),
  `skip_withheld`, `image_rel_for` returning `Option` (64221b7ec).
- B4 (`feat/rust-docx-b4`), up to 197759de0: `engineInvoke`/`revive` in
  `@seuoffice/engine-wasm`, `Args` rows and `{"$text"}` blobs, request depth
  1024, `toWellFormed`, `{"$num"}` for non-finite numbers, the node.ts path,
  `formatted()` rustfmt of the tables, the eslint ignore of
  `tools/*-diff/reference/**`.
- origin/main up to 8a63a954a.

### What waits

- B4 d332386da (pushed after 197759de0) is not merged yet; merge it, then
  regenerate both engines and check the docx no-diff. B4 owes main's docx
  redaction batch (cli `docs` hidden-* tests: 123 failures here; CI tests of
  `@seuoffice/docs` and `@seuoffice/docx-engine`; seuoffice web ai-relay docs
  specs). Those are B4's.
- CI lint, 8 errors, all in stream C's gate files (tools/pptx-diff
  calls-deckcore, calls-deckshape, calls-decktables, calls-generate,
  calls-media): ask C or fix them in a commit C can take.
- Runners at 6b61b29bd: CI 43347118154 (lint above; docs and docx-engine
  tests: B4), seuoffice 43347121284 (web: 8 ai-relay docs specs: B4; the two
  collab-slides specs of the earlier run passed), seuoffice rust 43347124639
  (running at hand-over). No runner has seen 859e51275/93c33c17c yet.
- Local results at e044a3c7e (BindingFixes): pptx-engine 1795 passed;
  pptx-render 427; pptx-ops 120; pipelines 225; slides 2551 passed with 1
  machine-font failure (`system-fonts`); shell: 3 macOS-only failures
  (`tab-shortcuts` Cmd+W, two `mcp-client/local`); cli: only the B4 docs
  failures.
- Not run yet: the full pptx-diff gate and the 316 fault probes on this head
  (run them on the runner: `gh workflow run "seuoffice rust" --ref feat/rust-pptx-c2`).
- Open choice for main: the slide-index Rust signatures make the binding lend a
  master or layout slide to the deck for one call (`slideIndex` in
  engine.ts); a Rust API taking a slide beside the opened deck would remove it.

### How to run

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
npm ci
node crates/office-wasm/build.mjs                      # release wasm, needed by every test
npx tsx tools/docx-diff/binding/gen.ts                 # docx: must leave no diff
npx tsx tools/docx-diff/binding/gen.ts --engine pptx   # pptx binding
npm run test -w @seuoffice/pptx-engine                 # and pptx-render, pptx-ops, pipelines, slides, shell, cli
node tools/pptx-diff/faults.mjs --inventory            # 0 STALE
npx tsx tools/pptx-diff/bench-render.ts --rounds 100   # render benchmark
gh workflow run CI --ref feat/rust-pptx-c2             # and seuoffice, "seuoffice rust" (gate and faults)
```

### Mac mini (2026-11-13)

- Merged B4 d332386da (main 07a251652); u1 had nothing past 64221b7ec.
- Main's 81e0daf00 (a chart whose text holds the hidden-from-AI mark is a
  hidden element) ported to the reference and to Rust, with chart and parse
  gate inputs; the roundtrip group got its floors (its missing floors failed
  the gate before); the eight lint errors of C's gate files fixed.
- The web page lost `setImmediate` with JSZip (slides' session defers its
  history notice with it): `@seuoffice/web-platform/globals` gives it.
  `engine-wasm` references the DOM lib for the Node-only packages that
  type-check it.
- Runner render benchmark: crates/pptx-engine/README.md, under 5% for every
  export. Gate 0 differences, 317/317 faults caught (seuoffice rust
  43360226152, pptx jobs).
- Left to B4: the docx-diff differences of the `crates` job, the docx-engine
  and docs test failures of CI (the same counts on B4's own d332386da runs).
