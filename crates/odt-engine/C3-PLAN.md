# C3: the odt engine in Rust

Batch C3 of decision 0025 (rule 5, batch porting): `packages/odt-engine`
(66 files, 18,370 TypeScript lines) ported to this crate, compared against the
TypeScript by `tools/odt-diff`, then switched behind the same exports of
`@seuoffice/odt-engine` through `@seuoffice/engine-wasm`. Branch
`feat/rust-odt-c3`, from `feat/rust-pptx-u1` with `feat/rust-docx-model` merged
up to 50407c9f7 (the Rust `parseDocx` and the write side).

This file is the contract the porters write to. `crates/README.md` ("How a
module is ported", "jscompat rules") holds everywhere; this adds what is
particular to the odt engine.

## Procedure

- One batch. Porters write in parallel, each in the files of their slice. No
  tests, no comparisons, no clippy during the batch. `cargo check -p
odt-engine` once at the end of a slice, or when a compile error blocks you,
  and only inside a heavy slot of the machine:

  ```sh
  slot=; trap '[ -n "$slot" ] && rmdir "$slot"' EXIT
  until mkdir /tmp/heavy-slot-1 2>/dev/null && slot=/tmp/heavy-slot-1 || { mkdir /tmp/heavy-slot-2 2>/dev/null && slot=/tmp/heavy-slot-2; }; do sleep 30; done
  cargo check -p odt-engine --manifest-path crates/Cargo.toml --message-format short 2>&1 | grep -E '^crates/odt-engine/src/<your layer>' | head -80
  ```

  Other slices are unfinished while you work: read the errors of your files
  only. An error caused by a missing item of another slice is not yours.

- The integrator (the session that wrote this file) owns `lib.rs`, this file,
  `crates/Cargo.toml`, `crates/office-wasm/src/lib.rs` and
  `crates/office-wasm/src/calls/mod.rs`, and joins the slices.
- Nothing is committed by a porter. The integrator commits the batch.
- A TypeScript defect you find (a result wrong by the ODF or OOXML rules, or
  content a user can reach that is lost) is ported as it is and written down in
  your final answer with the input that shows it. It is not fixed.

## Layout

One Rust module per TypeScript file, same layer folder, file name in snake
case: `src/core/docx-package.ts` is `src/core/docx_package.rs`, a layer's
`index.ts` is its `mod.rs` and re-exports what the `index.ts` exports. Every
ported function, type and constant carries a doc line naming the TypeScript it
ports (`/// \`readOdtStyles\``), so a reader can go between the two. Port in the
order of the TypeScript file, line by line; do not improve the logic.

| Slice    | TypeScript (`packages/odt-engine/src/`)                                  | Lines |
| -------- | ------------------------------------------------------------------------ | ----- |
| core     | `core/*`, `assemble/zip.ts`                                              | 3,600 |
| text     | `text/*`                                                                 | 3,400 |
| table    | `table/*`                                                                | 3,200 |
| objects  | `objects/*`                                                              | 2,500 |
| page     | `page/*`                                                                 | 2,400 |
| assemble | `assemble/*` but `zip.ts`, `index.ts` (the public API as Rust functions) | 2,800 |
| harness  | `tools/odt-diff` (TypeScript only)                                       |       |

`assemble/zip.ts` is in core's slice because `core/package.ts` and the zip
writer share the record layout.

## Names and types

- `camelCase` functions and fields become `snake_case`; types keep their
  names. A struct that crosses JSON has `#[serde(rename_all = "camelCase")]`
  and declares its fields in the order the TypeScript literal writes them: key
  order is compared. A TypeScript `undefined` field is
  `#[serde(skip_serializing_if = "Option::is_none")] Option<T>`; `null` is
  `Option<T>` serialized as `null`. A string union is an enum with
  `#[serde(rename = "...")]` per variant.
- Where you need an item of another slice before it exists, write the name the
  rule above gives it and the signature the TypeScript gives it. The
  integrator reconciles.
- A number that is an index, an id or a count is `usize`; one that may be `-1`
  or another sentinel is `i64` or an `Option`; a measurement (cm, twips, pt,
  percent) is `f64`, printed with `jscompat::number_to_string`, rounded with
  `math_round`, parsed with `parse_float`/`to_number`/`parse_int`, as the
  README's table says.
- `JsonValue` of `core/convert.ts` is `serde_json::Value` (the workspace has
  `preserve_order`, so key order is kept).
- `Map` is `jscompat::JsMap`, `Record<string, V>` is `jscompat::JsObject<V>`,
  `Set<string>` is an insertion-ordered set (`JsMap<()>` or a `Vec` with a
  membership test, as the use needs).

## Offsets

Every offset into a string is a **UTF-8 byte offset** inside the engine, as in
every other engine of the workspace. Every offset that a JSON value holds (the
bridge map, an `ext` record, a result of a compared function) is a
**`crate::offset::U16`**, a count of UTF-16 code units, because the TypeScript
wrote it and reads it back. Converting is explicit:

- a part string (`content.xml`, `styles.xml`) is held as
  `crate::offset::IndexedText` (`to_u16(byte)`, `to_byte(U16)`), built once per
  part;
- a short string (a paragraph text, a name) uses `offset::to_u16(text, byte)`,
  `offset::to_byte(text, at)`, `offset::u16_len(text)`.

The XML scanner of `core/xml.ts` reads code units; every delimiter it tests is
ASCII, so the same loop over bytes stops at the same places. Where the
TypeScript compares or stores `string.length`, use `u16_len`; where it only
slices with it, bytes are the same place. A JavaScript index between the two
halves of a surrogate pair has no byte offset: `to_byte` moves it to the end
of the character. If the TypeScript can split a pair (an alignment of texts
by code unit, for example), port it over `encode_utf16()` units and say so in
the doc line.

## The registry and the contexts (core slice decides the detail)

- The five handler kinds of `core/convert.ts` are traits of the same names
  (`BlockConverter`, `InlineConverter`, `RunWriter`, `ParagraphInjector`,
  `FreeWriter`), methods in snake case taking `&self` and the context as
  `&mut OdfToOoxmlContext` / `&mut OoxmlToOdfContext`. An optional TypeScript
  method (`absorbs?`, `identify?`) is a trait method with a default that
  answers as its absence does (`false`, `None`). A handler that throws returns
  `Result<_, OdtError>`.
- `ConversionRegistry` holds `Vec<Rc<dyn BlockConverter>>` and the like. Each
  context holds `registry: Rc<ConversionRegistry>`; a caller clones the `Rc`
  out of the context before calling a handler with the context. A decorator
  (the page layer wraps the text converter) is a struct holding the
  `Rc<dyn BlockConverter>` it wraps.
- The contexts hold `doc: Rc<OdtDocument>` (and `edited: Rc<ParsedDoc>` on the
  save side), so no lifetime parameter spreads through the layers.
- `ctx.ext(key, init)`: a layer keeps its `ext` slot as its own typed struct
  (serde, fields in the TypeScript's key order). The context stores slots as
  `Box<dyn Any>` in the order keys were first used, and writes them into
  `map.ext` (a `serde_json::Map`) when the map leaves the context. On the save
  side `rctx.ext::<T>(key)` reads the slot from the bridge it was given, once.
  A function that takes a whole `BridgeMap` (the report, `readPageExt`) reads
  `map.ext[key]` with `serde_json::from_value`.
- Errors: `core/errors.ts` is `OdtError`, with the open errors as a variant
  carrying the `OdtOpenErrorCode` and the message, and a variant for any other
  thrown `Error` (its message). The wire answers `{ error: { code, message } }`.

## What the engine does not do itself

- **docx.** Use the Rust docx engine, never a second port:
  `docx_engine::parse::parse_docx` (with `drawings::host::NoHost`),
  `docx_engine::generate::paragraph::generate_paragraph_xml` and its
  `GenerateContext`, `docx_engine::notes::parse_notes_xml`,
  `docx_engine::section::{read_sections, read_page_color,
section_from_sect_pr, section_settings_from_xml}`,
  `docx_engine::blank::custom_level_xml`, `PAGE_MARK` and `TOTAL_PAGES_MARK`
  of `docx_engine::parse::tables::hf_fields`, and the model types of
  `docx_engine::model` (`Block`, `Run`, `ParaFormat`, `TableModel`, ...).
  Where the TypeScript calls a docx function with no `pub` Rust route, name
  it in your final answer: the integrator makes it `pub`.
- **zip.** Reading: port `core/package.ts` as written, over the zip gate of
  `ooxml_pkg::gate` (`zip-gate` is ported there). JSZip uses (the bridge
  docx, the export, `page/hf.ts` reading parts of a docx): `ooxml_pkg`
  (`Package`, `ooxml_pkg::write::generate`, `read_entries`). Writing an ODT:
  port `assemble/zip.ts`; `CompressionStream('deflate-raw')` is
  `flate2` raw deflate at the default level. Compressed bytes may differ from
  the host's; what is compared is everything else (inflated bytes, every
  header field the writer sets but the compressed size and CRC of a stream
  it deflated itself).
- **The clock.** `new Date()` of `assemble/zip.ts` becomes an argument
  `now: HostNow { ms: f64, offset_minutes: f64 }` (`Date.now()` and
  `getTimezoneOffset()` of the host), passed down from the public functions.
  The DOS date is computed from `ms - offset_minutes * 60000` as UTC parts
  (`jscompat::utc_date_parts`).
- **`Date.parse`** of `assemble/meta.ts`: `docx_engine::revision_xml::date_parse`
  (the integrator makes it `pub`), `toISOString` from `utc_date_parts`.
- **`TextDecoder('utf-8', { ignoreBOM: true })`**: `String::from_utf8_lossy`
  keeps a BOM as U+FEFF, as `ignoreBOM` does; `new TextDecoder('utf-8')`
  strips one leading BOM.
- No I/O, no randomness. Everything is synchronous: the TypeScript is async
  only for zip streams.

## The public functions (assemble slice)

`crate::assemble` exposes, as Rust:

```rust
pub fn odt_to_docx(odt: &[u8], now: HostNow) -> Result<OdtToDocxResult, OdtError> // docx_bytes, bridge: BridgeMap, report
pub fn save_odt(original_odt: &[u8], bridge: &BridgeMap, edited_docx: &[u8], now: HostNow)
    -> Result<SavedOdt, OdtError>                                         // Unchanged | Bytes(Vec<u8>)
pub fn docx_to_odt(docx: &[u8], rendered: &JsMap<RenderedObject>, now: HostNow)
    -> Result<DocxToOdtResult, OdtError>                                  // odt_bytes, report
pub fn odt_to_text(odt: &[u8]) -> Result<String, OdtError>
```

`SavedOdt::Unchanged` is the TypeScript returning the very object it was given.

## The wire (integrator)

`crates/office-wasm` gets four commands; the binding and the gate both use
them:

| `cmd`       | In                                                                                           | Out                                                   |
| ----------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `odtToDocx` | blob 0: the ODT; `now` (JSZip dates the bridge docx's entries)                               | `{ report }`; blob 0 the docx, blob 1 the bridge JSON |
| `saveOdt`   | blobs: the ODT, the bridge JSON, the edited docx; `now`                                      | `{ unchanged }`; blob 0 the ODT unless unchanged      |
| `docxToOdt` | blob 0: the docx; `rendered: [[key, { widthEmu, heightEmu, blob }]]`, blobs 1..: PNGs; `now` | `{ report }`; blob 0 the ODT                          |
| `odtToText` | blob 0: the ODT                                                                              | `{ text }`                                            |

The bridge crosses as a blob of UTF-8 JSON so that its key order and number
printing are Rust's own, compared as written.

## Comparison (f): the pure functions of each layer

Each layer porter also writes `crates/office-wasm/src/calls/odt_<layer>.rs`
(groups `odtCore`, `odtText`, `odtTable`, `odtObjects`, `odtPage`,
`odtAssemble`), in the form of the other groups there
(`pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned`),
answering to the TypeScript export name. It covers **every exported function
of the slice whose arguments are plain data** (strings, numbers, booleans,
arrays and objects of them, docx model values): not those taking a context, a
registry, an `OdtDocument` or a function. The convention, which the harness
uses too:

- `text` is the first string parameter the function reads (`xml`, `text`,
  `raw`, ...); empty when there is none;
- every other parameter is `args.<its TypeScript name>`;
- a result is what the TypeScript returns, as JSON; offsets in it are `U16`;
  a `Map` crosses as its entries `[[k, v], ...]`, a `Set` as its values,
  `Uint8Array` as `{ "$bytes": base64 }`, `undefined` as no value
  (`Ok(None)`), a throw as `Err(message)`;
- a function that takes a visitor (`walkElements`) is answered with the list
  of the visitor's calls in order, `[{ "call": "open" | "close" | ..., ... }]`,
  the same list the harness records on the TypeScript side; the porter and
  the harness both document the shape at the top of their files.

## The harness: `tools/odt-diff`

The method of `tools/pptx-diff` and `tools/docx-diff`, reusing their modules
(`../docx-diff/harness`, `calls-runner`, `key-order`, `known-differences`,
`package-zips`, `synthetic`): `run.mjs` (Node 22, builds the wasm, runs
`main.ts`, keeps the untouched output, `--record-first <unit>`), `main.ts`,
`floors.json`, `divergences.json` with `divergences.ts`, `faults.mjs`, and
one `calls-odt<layer>.ts` per group. The TypeScript side is imported through
one module, `tools/odt-diff/ts.ts`, which re-exports
`packages/odt-engine/src` and its test helpers; at the switch it is
repointed to the frozen copy `tools/odt-diff/reference/`.

The corpus: no `.odt` is tracked (real files stay outside the repository), so
the documents are built: the test helpers of `packages/odt-engine/tests/helpers`
(`buildOdt` options, `hancom-sample`, the fragments, the text, page and docx
fixtures), every `.docx` tracked in the repository (for `docxToOdt`, and their
`docxToOdt` results as ODTs to open), and seeded mutations of both (XML text
of `content.xml`/`styles.xml`/`meta.xml`/`manifest.xml`, and containers with
`mutateContainer`). The edits for `saveOdt` are the editor's edits the tests
make (`tests/helpers/bridge.ts` `editorSave`: keep, edit, insert, xml), run
once on the TypeScript side to make each edited docx; both engines then save
the same edited docx.

| Line | Compares                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| (a)  | `odtToDocx`: the docx (entries, order, inflated bytes, header fields), the bridge JSON as written, the report; open errors by code |
| (b)  | `saveOdt` over the edits: unchanged or not, then the ODT as in (a)                                                                 |
| (c)  | `docxToOdt`, with and without rendered objects                                                                                     |
| (d)  | `odtToText`                                                                                                                        |
| (f)  | the groups `odt*`, per function, with the count of distinct results (at least two each)                                            |

Faults: `faults.mjs`, the form of `tools/pptx-diff/faults.mjs`: each fault is
one source replacement (`[name, compared function, file, original, faulty]`)
applied to a scratch copy of `crates/`, one wasm build and one comparison per
fault, a positive control first. The integrator chooses faults without
reading the porters' lists.

## Handoff (2026-11-13, from the Mac mini session to the MacBook)

State at the push of this section, branch `feat/rust-odt-c3`:

- Port and switch are done: `@seuoffice/odt-engine` calls the wasm binding; the
  TypeScript engine is frozen in `tools/odt-diff/reference/`. Local gate run 14:
  exit 0, 0 differences, 0 panics, both ledger classes reproduce. App odt tests on
  the binding: docs 48/48, html 14/14, markdown 20/20, cli odt 59/59, odt-engine
  266 passed / 9 skipped.
- B4 merged at `308f88e16`. CI `test (1, 2, 4)` fails on the same 33 tests as
  B4's own CI (the docx engine's Rust port of the hidden-from-AI batch, B4's
  work), none of them odt.
- `dropped`/`hidden_from_ai` (dispatch d5) is in the reference and in Rust,
  identical; `saveOdt` returns `{ odtBytes, report }`; gate (b) compares the
  save report; built case `hidden-from-ai` and the edit "a paragraph hidden from
  AI before the first" exercise it.
- Faults: round 3 (runner 43318251285) ran 21 of 26 and caught 20. The miss
  `rows-floor-cmp` now has (f) inputs (`withRowFloors` with every row at its
  floor, no rule). Five were never run (150-minute shard limit):
  `table-row-height-twips`, `text-cell-join`, `report-count-sum`,
  `table-colspan-gt`, `objects-note-key`. The job now runs 13 shards; round 4
  is runner 43342464157 on `91f1794bf` (in progress at the handoff). Read
  `odt-faults-out-*/report.json` of its artifacts; target 26/26.

Open work (dispatch d6, main's request): every caller that writes an ODT refuses
a report holding `hidden_from_ai` and writes nothing, with tests.

- CLI: done in `packages/cli/src/formats/odt.ts` (`refuseDroppedMarks` in
  `saveOdtBytes` and `docxBytesToOdt`), test `packages/cli/tests/odt-hidden.test.ts`
  committed WIP and not yet run.
- docs: `apps/docs/src/renderer/file-actions.ts` `odtBytesFor` (save, recovery
  copy, template) and `saveWithFormatChange` (`docxToOdt` for Save As .odt).
  Throw with a localized message; main uses the key `appMarkedOdtRefused`
  (en: "This document has content hidden from AI, which an ODT file cannot
  keep. Save it as .docx, or clear the marks first."; ko on main), reuse that
  key and text so the merge with main lines up. Test in
  `apps/docs/tests/odt-open-save.test.ts`: mark editor text with
  `schema.marks.redaction.create({ label })`, save as .odt and Save As .odt,
  expect nothing in `written`.
- html and markdown: `apps/*/src/main/odt-export.ts` `exportOdt`: after
  `convert`, a report with `hidden_from_ai` returns `{ ok: false, error }`
  without `write`; main names the message key `markedRefused` in `tOdt`. Test
  in `apps/*/tests/odt-export.test.ts` with a docx holding a `go:redact` run.
- Main's own upstream refusal (`fix/redact-followups`: `marked-odt.ts`,
  `planOdtWrite`, CLI `guardHiddenContent`) is not on this branch; when it
  lands both apply, the engine report is the second check.

How to run (Node 22, rustup with `wasm32-wasip1`):

- Gate: `node tools/odt-diff/run.mjs --by-function` (builds the wasm first,
  about 6 minutes); the report is `tools/odt-diff/out/<time>.stdout.log`; the
  populations for `floors.json` are in `out/populations.json` (corpus lines
  exact, seeded `*Mutated` lines rounded down to hundreds).
- Faults: `node tools/odt-diff/faults.mjs --inventory` checks every anchor;
  `node tools/odt-diff/faults.mjs --no-control --only a,b` runs single faults
  (about 30 minutes each); the runner runs them with
  `gh workflow run "seuoffice rust" --ref feat/rust-odt-c3`.
- Never `cargo fmt --all` (it reformats B4's generated files); use
  `cargo fmt -p odt-engine`.
- Trail: `crates/odt-engine/C3-TRAIL.md` rows 1 to 26.
