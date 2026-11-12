# pptx-engine

The Rust slides engine, ported from `packages/pptx-engine` the way
`crates/docx-engine` was ported from the Word engine: one module at a time,
each compared against the TypeScript it came from by `tools/pptx-diff` before
anything in the product calls it. `crates/README.md` holds the porting rules,
the `jscompat` table and the standing rules; they apply here unchanged. This
file holds what is particular to the slides engine.

## Survey of packages/pptx-engine/src (2026-11-12, at df02c5700)

52 files, 26,682 lines without tests. Level 0 imports no other module of the
package; a level is one more than the highest level imported. Type-only
imports are left out.

| Level | Lines | Module                  | Imports (value)                                                                                                                                | Outside the package                             |
| ----- | ----- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 0     | 1,258 | `animation.ts`          |                                                                                                                                                |                                                 |
| 0     | 786   | `types.ts`              |                                                                                                                                                |                                                 |
| 0     | 490   | `custgeom.ts`           |                                                                                                                                                |                                                 |
| 0     | 369   | `vendor/mtx/lzcomp.ts`  |                                                                                                                                                |                                                 |
| 0     | 305   | `dgm-hier.ts`           |                                                                                                                                                |                                                 |
| 0     | 195   | `preset-shape-types.ts` |                                                                                                                                                |                                                 |
| 0     | 160   | `blank.ts`              |                                                                                                                                                | jszip                                           |
| 0     | 158   | `glb-bounds.ts`         |                                                                                                                                                |                                                 |
| 0     | 141   | `align.ts`              |                                                                                                                                                |                                                 |
| 0     | 126   | `format-brush.ts`       |                                                                                                                                                |                                                 |
| 0     | 112   | `scan.ts`               |                                                                                                                                                |                                                 |
| 0     | 111   | `xml-utils.ts`          |                                                                                                                                                | `crypto.randomUUID`                             |
| 0     | 27    | `slide-ids.ts`          |                                                                                                                                                |                                                 |
| 0     | 23    | `named-action.ts`       |                                                                                                                                                |                                                 |
| 0     | 23    | `table-grid.ts`         |                                                                                                                                                |                                                 |
| 0     | 16    | `crc32.ts`              |                                                                                                                                                |                                                 |
| 1     | 627   | `vendor/mtx/ctf.ts`     | lzcomp                                                                                                                                         |                                                 |
| 1     | 447   | `table-edit.ts`         | xml-utils                                                                                                                                      |                                                 |
| 1     | 301   | `theme.ts`              | xml-utils                                                                                                                                      | fast-xml-parser                                 |
| 1     | 287   | `zip.ts`                | xml-utils                                                                                                                                      | zip-gate, jszip, fast-xml-parser, `node:crypto` |
| 1     | 245   | `theme-apply.ts`        | xml-utils                                                                                                                                      |                                                 |
| 1     | 195   | `redaction-xml.ts`      | xml-utils                                                                                                                                      | `@genoffice/agent-core/redact-range`            |
| 0     | 181   | `smartart-layout.ts`    |                                                                                                                                                |                                                 |
| 1     | 174   | `model3d.ts`            | xml-utils                                                                                                                                      |                                                 |
| 1     | 167   | `chart-workbook.ts`     | crc32, xml-utils                                                                                                                               |                                                 |
| 1     | 132   | `identity.ts`           | xml-utils                                                                                                                                      |                                                 |
| 2     | 1,779 | `generate.ts`           | redaction-xml, xml-utils                                                                                                                       |                                                 |
| 2     | 491   | `slide-transfer.ts`     | xml-utils, zip                                                                                                                                 |                                                 |
| 2     | 388   | `color.ts`              | theme, xml-utils                                                                                                                               |                                                 |
| 2     | 369   | `resource-cleanup.ts`   | zip                                                                                                                                            |                                                 |
| 2     | 287   | `layout.ts`             | slide-ids, xml-utils, zip                                                                                                                      |                                                 |
| 2     | 262   | `notes.ts`              | xml-utils, zip                                                                                                                                 |                                                 |
| 2     | 16    | `vendor/mtx/index.ts`   | ctf, lzcomp                                                                                                                                    |                                                 |
| 3     | 1,501 | `chart.ts`              | color, theme                                                                                                                                   | fast-xml-parser                                 |
| 3     | 831   | `placeholder.ts`        | color, theme, xml-utils                                                                                                                        | fast-xml-parser                                 |
| 3     | 691   | `insert.ts`             | animation, generate, resource-cleanup, xml-utils, zip                                                                                          |                                                 |
| 3     | 686   | `table-style.ts`        | color, theme, xml-utils                                                                                                                        | fast-xml-parser                                 |
| 3     | 375   | `sections.ts`           | notes, xml-utils, zip                                                                                                                          | `node:crypto`                                   |
| 3     | 368   | `embedded-fonts.ts`     | vendor/mtx, xml-utils, zip                                                                                                                     | fast-xml-parser                                 |
| 3     | 247   | `comments.ts`           | notes, resource-cleanup, xml-utils, zip                                                                                                        |                                                 |
| 3     | 238   | `builtin-layouts.ts`    | layout, xml-utils, zip                                                                                                                         |                                                 |
| 3     | 133   | `background-promote.ts` | animation, generate                                                                                                                            |                                                 |
| 3     | 127   | `chartex.ts`            | color                                                                                                                                          | fast-xml-parser                                 |
| 4     | 4,401 | `parse.ts`              | chart, chartex, color, custgeom, dgm-hier, generate, named-action, placeholder, redaction-xml, scan, table-grid, table-style, theme, xml-utils | fast-xml-parser                                 |
| 4     | 292   | `media-insert.ts`       | crc32, glb-bounds, **index**, insert, model3d, xml-utils, zip                                                                                  | `node:zlib`                                     |
| 4     | 179   | `headerfooter.ts`       | animation, generate, **index**, insert                                                                                                         |                                                 |
| 4     | 70    | `smartart.ts`           | **index**, insert, smartart-layout, xml-utils                                                                                                  |                                                 |
| 5     | 322   | `hyperlink.ts`          | **index**, named-action, notes, parse, resource-cleanup, xml-utils, zip                                                                        |                                                 |
| 5     | 158   | `narration.ts`          | animation, insert, media-insert, notes, zip                                                                                                    |                                                 |
| 5     | 123   | `master-edit.ts`        | parse, placeholder, theme, zip                                                                                                                 |                                                 |
| 6     | 4,841 | `index.ts`              | 45 modules                                                                                                                                     | jszip                                           |
| 7     | 451   | `chart-insert.ts`       | chart-workbook, **index**, insert, media-insert, notes, resource-cleanup, xml-utils, zip                                                       |                                                 |

One import cycle: `index.ts` with `chart-insert.ts`, `headerfooter.ts`,
`hyperlink.ts`, `media-insert.ts`, `narration.ts` and `smartart.ts` (6,313
lines). They go as one unit, last.

`node tools/pptx-diff/module-graph.mjs` uses the TypeScript AST to print every
import and export-from edge, including all 45 of `index.ts`, as JSON. The
table abbreviates only that row. Levels inside the cycle are traversal
depths rather than a topological order.

## What the slides engine shares with the Word engine

| Need                                 | Reuse                                                                                                                                                              | What has to be added, and where                                                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The zip gate                         | `ooxml-pkg::assert_zip_inflates_within_limits`, `ZipLimits`                                                                                                        | Nothing: `PPTX_ZIP_LIMITS` is a second `ZipLimits` value                                                                                                                                                                                        |
| Opening the zip as JSZip does        | `ooxml-pkg`'s JSZip reader and `Package`                                                                                                                           | `load_docx_package` also blanks Unicode Path fields and normalizes Strict parts, which `PackageArchive.open` does not. `ooxml-pkg` gets a second entry that is only gate, JSZip load and the declared-size check, taking the limits as argument |
| SHA-256 of the file                  | `sha2`, already a workspace dependency                                                                                                                             |                                                                                                                                                                                                                                                 |
| XML reading                          | `ooxml-xml`: the fast-xml-parser port                                                                                                                              | The Word engine reads with `preserveOrder: true`; all nine parsers of the slides engine read the plain object tree (one child is an object, several an array, `#text`, `@_` attributes). That tree is added to `ooxml-xml`                      |
| Parser options                       |                                                                                                                                                                    | Three option sets are in use: default (`trimValues` and `parseTagValue` on: a text of digits becomes a number through `strnum` 2.4.1), the same with `isArray`, and `trimValues: false, parseTagValue: false` (`parse.ts`, charts)              |
| JavaScript numbers, strings, regexes | `jscompat`                                                                                                                                                         | Reuse its number, string and regex functions. Check the parser's `strnum` conversion and Unicode-scalar handling separately; add missing language operations here, not a second implementation in the engine.                                   |
| Theme and colour                     | Not `docx-engine::theme`: see below                                                                                                                                |                                                                                                                                                                                                                                                 |
| The wasm entry and the wire frame    | `office-wasm`, the `props` command and `calls::dispatch`                                                                                                           | Groups named `pptx<Name>` beside the Word groups                                                                                                                                                                                                |
| The gate harness                     | `tools/docx-diff`: `harness`, `engine`, `key-order`, `calls-spec`, `compare-props` (`checkOutcome`, `flush`), `compare-xml` (`mutate`), `synthetic` (`mulberry32`) | The runner of (f) is written around the six Word groups. It is split so that the same runner takes a table of groups, and `harness` can read another `floors.json`. The Word gate must print the same report before and after                   |

Theme and colour: the TypeScript of the two engines does not share code
(`theme.ts` of the two packages: 11% of the lines in common, `color.ts` has
no Word counterpart). The Word engine finds theme fonts and colours with
regular expressions over the text and applies Word's `themeTint`/`themeShade`;
the slides engine parses the theme into an object tree, keeps the format
scheme lists, applies `a:clrMap` and the DrawingML colour transforms
(`lumMod`, `satMod`, `tint`, `shade`, `alpha`, ...). The one candidate for a
shared function is the RGB/HSL conversion (`rgb_to_hsl`, `hsl_to_rgb` of
`docx-engine/src/theme.rs`); unit 3 compares the arithmetic and extracts it
only if it is the same to the bit. Nothing else is copied.

## Unit order

Leaves first, the read side before the save side, as in the Word port.
Lines are TypeScript lines of the modules of the unit.

| Unit | Modules                                                                                                                                                                                                                                                                                      | Lines | Compared as                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------- |
| 1    | The crate, the gate, the object tree of fast-xml-parser, `PackageArchive` (`zip.ts`), `xml-utils.ts`, `scan.ts`, `slide-ids.ts`, `named-action.ts`, `table-grid.ts`, `crc32.ts`                                                                                                              | 599   | package comparison, `scanSlide` on every slide, groups of (f)       |
| 2    | Leaves without the theme: `custgeom.ts`, `dgm-hier.ts`, `align.ts`, `format-brush.ts`, `preset-shape-types.ts`, `glb-bounds.ts`, `smartart-layout.ts`, `identity.ts`, `redaction-xml.ts`, `model3d.ts`, `chart-workbook.ts`, `table-edit.ts`, `theme-apply.ts`, `animation.ts`, `vendor/mtx` | 5,226 | groups of (f), in parallel behind cargo features                    |
| 3    | The theme chain: `theme.ts`, `color.ts`, `placeholder.ts`, `table-style.ts`, `chart.ts`, `chartex.ts`                                                                                                                                                                                        | 3,834 | groups of (f)                                                       |
| 4    | The model and the slide reader: `types.ts`, `parse.ts`, `master-edit.ts`                                                                                                                                                                                                                     | 5,310 | `parseSlide` as a whole: the model of every slide, per element type |
| 5    | Package readers and small writers: `notes.ts`, `layout.ts`, `sections.ts`, `comments.ts`, `embedded-fonts.ts`, `resource-cleanup.ts`, `builtin-layouts.ts`, `blank.ts`, `slide-transfer.ts`                                                                                                  | 2,797 | groups of (f) over packages; written zips for `blank.ts`            |
| 6    | The patch writers: `generate.ts`, `insert.ts`, `background-promote.ts`                                                                                                                                                                                                                       | 2,603 | groups of (f): fragment in, fragment out                            |
| 7    | The cycle: `index.ts`, `media-insert.ts`, `headerfooter.ts`, `smartart.ts`, `hyperlink.ts`, `narration.ts`, `chart-insert.ts`                                                                                                                                                                | 6,313 | `openPptx` model of every deck; saved zips part by part             |

## The corpus

Three `.pptx` files are tracked: two fixtures of the package's tests and the
blank deck of the shell. They cover almost nothing of an engine of 26,000
lines, so built inputs carry the comparison: decks made by `createBlankPptx`
and `pptxgenjs` (what the package's own 130 test files do), and parts written
by hand for what those lack. Each unit says what the corpus lacked.

## Unit 1 local proof

The first completed comparison is kept unchanged in
`evidence/u1-comparison-first.stdout.log`, with every differing input and both
answers in `evidence/u1-comparison-first.differences.json`. At `df02c5700`,
before any parity fix, it made 11,854 checks: 11,791 equal, 63 different
(99.4685% equal). The package-open and entry-byte checks all agreed. None of
the differences was key order alone.

| First difference | Checks | Decision |
| --- | --- | --- |
| `<#text/>` projected as an ordinary empty element | 13 | Fixed the parser's text-node projection. Seven more built forms cover attributes, nesting, concatenation and repeated names. |
| DOCTYPE accepted by TypeScript | 13 | Rust refuses it. Final policy, listed. |
| A malformed CDATA opener splits a surrogate pair | 14 | Rust refuses it. Listed. |
| XML whitespace around `id =` hides the existing slide id | 19 | TypeScript defect, reported 2026-11-12. Rust reads it correctly. Fix pending on main. |
| A default-namespace presentation loses its slide list | 4 | TypeScript defect, reported 2026-11-12. Rust reads the prefix-less list. Fix pending on main. |

`evidence/u1-first.stderr.log` is an earlier fixture-loader failure, before
any comparison: `pptxgenjs` needed its CommonJS constructor under `tsx`. It is
kept too, not presented as the first completed comparison.

After the parser fix, `evidence/u1-local-verified.stdout.log` records 11,945
checks, no unlisted difference, no key-order difference, and at least two
distinct TypeScript results for each of the 27 functions. The ledger has
four classes with 51 exact inputs, all still reproducing. Adding the
`#text` forms changed one seeded CDATA input's parser options; both exact
variants stay listed and checked. This is not a full slide model or a save
comparison: those are units 4 and 7.

The three tracked decks have seven slides. They did not exercise a refusal
at the zip gate, either reported document defect, DOCTYPE, or the split
surrogate. Built inputs add blank and `pptxgenjs` decks, lost layout chains,
invalid and over-limit containers, duplicate names, UTF-8 decoding edges,
every parser option set used by the engine, XML lexical edge cases and
JavaScript number/string boundaries.

The gate imports the Word harness, call runner, ordered-key comparison,
mutator, seeded generator and zip builder. It does not copy them.

```sh
# Node 22 is required. These commands belong on the GitHub runner.
npm --prefix tools/pptx-diff run gate
npm --prefix tools/pptx-diff run faults

# One group while porting; this does not accept the full unit.
CARGO_BUILD_JOBS=4 npm --prefix tools/pptx-diff run calls -- --group leaves --by-function
```

`run.mjs` writes each run to a new timestamped log under `tools/pptx-diff/out`
without overwriting. `--record-first <unit>` also keeps the first output and
complete differences under this crate's `evidence/`.

`faults.mjs` builds a debug wasm for each single Rust fault, runs the same
comparisons, requires differences in the target function's own tally, and
restores the source in `finally`. It also has three probes selected by an
independent reviewer without the porters' lists: a byte offset instead of a
UTF-16 offset, ignored URI decoding, and reversed repeated XML children.
Their execution is not yet verified locally; the workflow runs them on the
runner. Whole-workspace tests and clippy, including the unchanged Word gate,
also belong on that runner.

Local runtime: Node 22.23.5, npm 11.19.1, Rust 1.99.1, `wasm32-wasip1`.
The release wasm after the parser fix is 2,070,552 bytes, including the Word
engine. The changed crates' native tests passed 93 tests. Neither that test
count nor compilation is the parity proof; the recorded comparison is.
