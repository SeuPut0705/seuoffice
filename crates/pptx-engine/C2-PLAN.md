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

| Argument kind | Request                                                         | Written back                                                       |
| ------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `json`        | JSON                                                            | nothing                                                            |
| `slide`       | the `Slide` as JSON (Rust `&mut Slide`)                         | `out[i]`: the slide's JSON; `adopt` into the caller's object       |
| `deck`        | the `SlideDeck` as JSON (Rust `&mut SlideDeck`)                 | the same                                                           |
| `archive`     | `{ entries: [[path, {$blob:n}]...], originalHash }`             | `out[i]: { changed: [[path, {$blob}\|null]...], paths }`           |
| `opened`      | `{ deck, archive }` as the two rows above                       | `{ deck, archive }` as above                                       |
| `slideOf`     | a `Slide` of the opened deck, sent as its index (Rust `usize`)  | through the `opened` argument                                      |

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
