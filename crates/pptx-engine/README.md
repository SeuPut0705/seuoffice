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
| 1     | 195   | `redaction-xml.ts`      | xml-utils                                                                                                                                      | `@seuoffice/agent-core/redact-range`            |
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

## Procedure: whole-engine batches

From 2026-11-12 (decision 0025 rule 5 on main) the rest of the engine is
ported in batches, not unit by unit:

1. C1, the port: every TypeScript file not yet in Rust (11,713 lines in 19
   files) at once. The parent writes the contract first (module plan, the
   signatures of index.ts's `OpenedPptx` and the helpers every module calls,
   signature conventions, the gate harness `tools/pptx-diff/deck-ops.ts` and
   `crates/office-wasm/src/calls/pptx_deck.rs`); porters then write their
   files and their comparisons in parallel, with no build. The parent
   compiles end to end, runs ONE first comparison and keeps it unedited in
   `evidence/`, classifies and fixes, and runs ONE runner gate.
2. C2, the switch: the slides app's calls to `@seuoffice/pptx-engine` go to
   the Rust engine through WASM, and the TypeScript modules are deleted.
   Fault injection, the ledger tidy and an independent review run once,
   before the merge to main.

Units 1 to 4 below were ported and proven one unit at a time before this
change; their faults are run with C2.

## Unit order

Leaves first, the read side before the save side, as in the Word port.
Lines are TypeScript lines of the modules of the unit. Units 5 to 7 are C1.

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
answers in `evidence/u1-comparison-first.differences.json`. The TypeScript
base was `df02c5700`; the first Rust port was an uncommitted working tree.
Before any parity fix it made 11,854 checks: 11,791 equal, 63 different
(99.4685% equal). The package-open and entry-byte checks all agreed. None of
the differences was key order alone. The pre-fix Rust tree was not committed;
the preserved artifacts are the actual run's output and complete differences.

| First difference                                         | Checks | Decision                                                                                                                     |
| -------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `<#text/>` projected as an ordinary empty element        | 13     | Fixed the parser's text-node projection. Seven more built forms cover attributes, nesting, concatenation and repeated names. |
| DOCTYPE accepted by TypeScript                           | 13     | Rust refuses it. Final policy, listed.                                                                                       |
| A malformed CDATA opener splits a surrogate pair         | 14     | Rust refuses it. Listed.                                                                                                     |
| XML whitespace around `id =` hides the existing slide id | 19     | TypeScript defect, reported 2026-11-12. Rust reads it correctly. Fix pending on main.                                        |
| A default-namespace presentation loses its slide list    | 4      | TypeScript defect, reported 2026-11-12. Rust reads the prefix-less list. Fix pending on main.                                |

`evidence/u1-first.stderr.log` is an earlier fixture-loader failure, before
any comparison: `pptxgenjs` needed its CommonJS constructor under `tsx`. It is
kept too, not presented as the first completed comparison.

After the parser fix and the merges of `origin/feat/rust-docx-u1` (to
`6e28d6fdd`), `evidence/u1-local-verified.stdout.log` records 12,902 checks, no
unlisted difference, no key-order difference, and at least two distinct
TypeScript results for each of the 27 functions. The ledger has four classes
with 28 exact inputs, all still reproducing. The first run listed 50: the
other 22 were seeded mutations of the listed inputs, and a listed input is no
longer a seed of mutations (`seed: false` of an `Input`), so the ledger does
not move when a built input is added. This is not a full slide model or a
save comparison: those are units 4 and 7.

The lines named "on the corpus" take their inputs from the parts of every
package that opens: the three tracked decks, the four built decks and the
built containers that are valid. 300 seeded mutations of those containers go
through the package comparison too: 208 are refused by both sides, the rest
open to the same entries and bytes. Where both sides refuse, the comparison
is that both refuse, not that the messages are equal.

The three tracked decks have seven slides. They did not exercise a refusal
at the zip gate, either reported document defect, DOCTYPE, or the split
surrogate. Built inputs add blank and `pptxgenjs` decks, lost layout chains,
invalid and over-limit containers, bytes after a deflate stream, an Info-ZIP
Unicode Path field (JSZip renames the entry by it; the Word loader blanks
such fields, `PackageArchive.open` does not), duplicate names, UTF-8 decoding
edges, every parser option set used by the engine, XML lexical edge cases
and JavaScript number and string boundaries.

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

`faults.mjs` copies the crate sources into a scratch directory of the system
and builds a debug wasm for each single Rust fault, so an interrupted probe
leaves no fault in the working tree. It runs the comparisons of (f) and
requires differences in the tally of the function the fault is in. Three of
its probes were selected by an independent reviewer without the porters'
lists: a byte offset instead of a UTF-16 offset, ignored URI decoding, and
reversed repeated XML children. `--only <id,...>` runs some of them.

On the runner (run 43149681436, at `927027607`) the slides gate passed and 29
of the 30 faults were caught. One passed: `>=` for `>` at the part-count limit
of `assertZipWithinLimits`, because no input had exactly 10,000 parts. Inputs
with 10,000 parts, 10,001 parts and 10,000 parts beside a folder close it (2
differences under that fault now). The independent URI-decoding fault was
caught by a single input, so three more encoded targets were added (17
differences now). The Word gate of that run had no difference on any line and
failed on one floor that `origin/feat/rust-docx-u1` had at `b471da31d` and
lowered in `3bf9fa6fe`, merged since.

Local runtime: Node 22.23.5, npm 11.19.1, Rust 1.99.1, `wasm32-wasip1`.
The release wasm, the Word engine included, was 2,070,717 bytes before the
merge that brought the Word engine's `resolve-props` port and is 2,175,276
after it; the size before this unit was not measured here. The changed
crates' native tests passed 93 tests. Neither that test count nor compilation
is the parity proof; the recorded comparison is.

## Unit 2 local proof

Twenty source files that need no theme (5,226 lines, 75 exports), ported in
seven groups. Each group's first comparison is kept unchanged in
`evidence/u2-<group>-first.{stdout.log,stderr.log,differences.json}`, taken
before any change to the port other than what it needed to compile.

| Group    | Source files                                                       | Functions | First checks | Different | Equal    |
| -------- | ------------------------------------------------------------------ | --------- | ------------ | --------- | -------- |
| `geom`   | `custgeom.ts`, `preset-shape-types.ts`                             | 7         | 1,298        | 11        | 99.153%  |
| `layout` | `align.ts`, `dgm-hier.ts`, `smartart-layout.ts`, `format-brush.ts` | 8         | 2,688        | 0         | 100%     |
| `tables` | `table-edit.ts`, `theme-apply.ts`                                  | 10        | 4,334        | 11        | 99.746%  |
| `anim`   | `animation.ts`                                                     | 15        | 5,441        | 3         | 99.945%  |
| `bytes`  | `glb-bounds.ts`, `chart-workbook.ts`                               | 7         | 1,117        | 0         | 100%     |
| `ident`  | `identity.ts`, `redaction-xml.ts`, `model3d.ts`                    | 19        | 6,271        | 95        | 98.485%  |
| `mtx`    | `vendor/mtx/index.ts`, `lzcomp.ts`, `ctf.ts`                       | 9         | 2,268        | 0         | 100%     |
| Unit     |                                                                    | 75        | 23,417       | 120       | 99.4876% |

None of the 120 was an error of the port. Each is a place where the
TypeScript is wrong by the format's rules or loses content, the Rust was
written right, and the difference is one ledger class with its exact inputs
and both answers (`tools/pptx-diff/divergences.json`), all reported to main on
2026-11-12:

| Class                           | First differences | What the TypeScript does                                                                              |
| ------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| `custgeom-inherited-guide`      | 11                | A guide named `constructor`, `toString`, `__proto__` reads an inherited property: `NaN` in the path   |
| `tblpr-attr-quote`              | 5                 | `firstRow='1'` or `bandRow = "1"` is not found, so the attribute is written a second time             |
| `tblstylelst-dollar`            | 2                 | `$&` in tableStyles.xml or in the style definition expands into markup                                |
| `theme-name-dollar`             | 4                 | `$&`, `$1`, `$'` in a theme or font name expand into markup                                           |
| `anim-nth-par-skips-untargeted` | 2                 | An ink-target effect is counted by the writer and skipped by the reader: the wrong effect is replaced |
| `anim-prune-dollar-patterns`    | 1                 | `$&` inside the timing expands when a shape's effects are pruned                                      |
| `redact-label-dollar`           | 92                | `$$`, `$&`, `$'` in a redaction label are lost or expand (4 labels on 23 texts; 24 inputs are kept)   |
| `cnvpr-own-extlst-forms`        | 3                 | A self-closing or spaced `a:extLst` of `p:cNvPr` gets a second `a:extLst` beside it                   |

Main then asked for three behaviours the port had mirrored to be written
right, and for every replacement string that is not a literal to be treated
as suspect. Three more such sites were found by reading every `replace` of
the ported files; their inputs had been mirrored and compared equal. The
first comparison after those six corrections is
`evidence/u2-corrections-first.*`: 36 new differences, 31 in the six classes
below and 5 on seeded mutations, where an inserted `<w:x/>` or `=` made text
that is not a tag look like one. The corrections were then narrowed to
well-formed tags, text that is not a tag is read as the TypeScript reads it,
and the 5 are gone.

| Class                                   | Inputs | What the TypeScript does                                                                       |
| --------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `redact-strip-drops-extlst-attributes`  | 5      | Removing a mark rewrites a list that keeps content without its attributes: a namespace is lost |
| `redact-self-closing-ext-swallows-next` | 7      | A self-closing extension of ours takes the next extension with it                              |
| `group-child-nvid-pattern`              | 5      | The `id` of a group child goes into a pattern unescaped: `(` throws, `+21` finds another shape |
| `tcpr-color-dollar`                     | 7      | `$&` in a cell shading or border color expands into markup                                     |
| `theme-color-dollar`                    | 2      | `$$` in a theme color loses a character                                                        |
| `recolor-map-dollar`                    | 5      | `$&` in a color the recolor map gives expands into markup                                      |

The local gate now makes 36,177 checks over (a) and (f) with no unlisted
difference, no key-order difference, and at least two distinct TypeScript
results for each of the 102 functions. The ledger has 18 classes with 111
exact inputs, all reproducing. `evidence/u2-local-verified.stdout.log` is
that run.

### Replacement strings that are not literals

`String.prototype.replace` reads `$$`, `$&`, `` $` ``, `$'` and `$1` in a
replacement string. Every `replace` of the files ported so far was read; a
site is listed when its replacement holds text from the document or from the
caller. The Rust writes the value as given at each, and each has `$` inputs.

| Site (at `df02c5700`)          | Replacement holds                    | Reached by                                                                  | Ledger class                 |
| ------------------------------ | ------------------------------------ | --------------------------------------------------------------------------- | ---------------------------- |
| `table-edit.ts:186`            | attributes of `a:tblStyleLst`, style | Table Design on a deck whose tableStyles.xml root is self-closing           | `tblstylelst-dollar`         |
| `table-edit.ts:429`            | shading and border colors            | A cell shading or border edit whose color is not a color, cell without tcPr | `tcpr-color-dollar`          |
| `theme-apply.ts:52`            | theme colors                         | Applying a theme whose color is not a color                                 | `theme-color-dollar`         |
| `theme-apply.ts:57`            | theme name                           | Applying a theme with a typed name                                          | `theme-name-dollar`          |
| `theme-apply.ts:60`, `:66`     | major and minor font names           | Applying a theme with typed font names                                      | `theme-name-dollar`          |
| `theme-apply.ts:222`           | the color a map gives                | Recoloring a deck after a theme whose color is not a color                  | `recolor-map-dollar`         |
| `animation.ts:1247`            | the whole pruned `p:timing`          | Deleting a shape on a slide whose timing holds a `$` pattern                | `anim-prune-dollar-patterns` |
| `redaction-xml.ts:192`, `:193` | the redaction label                  | Marking a run or picture that already has an `a:extLst`, with a typed label | `redact-label-dollar`        |

Colors reach the three color sites only from a caller that passes text that
is not a color (an agent tool call, a pasted value); the color picker cannot.
Read and not listed, because the replacement is a literal, a function, or
digits made from numbers: `zip.ts:277`; `xml-utils.ts:24`, `:43`, `:47`,
`:51`; `table-edit.ts:187`, `:205`, `:220`, `:254`, `:286`, `:310`-`:313`,
`:331`-`:333`, `:338`, `:344`, `:345`, `:347`; `theme-apply.ts:43`, `:115`,
`:220`; `animation.ts:551`, `:555`-`:557`, `:560`, `:695`, `:782`, `:889`,
`:1230`, `:1235`, `:1239`, `:1248`; `identity.ts:45`; `redaction-xml.ts:126`,
`:129`, `:141`, `:144`, `:189`; `model3d.ts:145`, `:147`, `:151`, `:155`,
`:171`, `:173`.

### What the corpus lacked, and what is not verified

The three tracked decks gave 3 checks to `geom`, 15 to `bytes` and none to
`mtx`: they have no `a:custGeom`, no guide list, no preset but `rect`, no
3D model, no embedded font, no `a16:creationId`, no group, no redaction
mark and no `a:extLst` inside `a:rPr` or `p:cNvPr`. Those functions are
compared on built inputs and seeded mutations only. Byte inputs (`bytes`,
`mtx`) carry their own seeded truncations and byte flips, since the runner
mutates text.

Not verified: `Math.sin`, `Math.cos` and `Math.hypot` agree to the last bit
only on the inputs tried. NaN, infinities, `-0` and lone surrogates cannot
cross JSON as arguments. `new AHuff(null, 257)` is left out because the
TypeScript never returns for it (its constructor reads symbol 257 past its
table); the decoder makes ranges 8 and 267 to 323 only. That PowerPoint
repairs or refuses the slides the listed defects produce was not tried.

The MTX decoder is a derived work of libeot (MPL-2.0), as the TypeScript it
is ported from. It is the crate `crates/mtx`, alone under `license =
"MPL-2.0"` so that the file-level boundary shows; its `LICENSE` and `README.md`
carry the attribution of `vendor/mtx`, and `crates/deny.toml` allows the
licence. The rest of the workspace is Apache-2.0 and links to it.

### Input that must not abort the engine

A reviewer read every slice, index, allocation, recursion and loop of the
unit for an input that panics or aborts (release wasm aborts on either).
Fixed:

- `glb_bounds`: the port kept every child of every visited node on one
  stack. A 40 KB model whose node lists itself ten thousand times as
  `[0]` asked for gigabytes; the TypeScript recurses and needs one frame a
  level. The port now walks a frame a level too, over the array in place,
  and refuses a nesting deeper than 4,096 as the TypeScript's stack does
  some thousands deeper. A model with 300 such children is a built input.
- `mtx::ctf`: the flag and coordinate arrays of a glyph were sized without
  a failure path, while a few dozen bytes of LZCOMP run-length data can ask
  for a gigabyte of points. They fail as the other buffers of the decoder
  do.
- `AHuff::new(257)` indexed past its table. Only the gate can ask for it.

Known and left, each only reachable from the gate's own arguments today: a
`tag` of `syncRedactExt` that is a pattern with a hundred thousand
alternatives (callers pass `a:rPr` or `p:spPr`), `BitWriter.writeValue` with
a bit count past 2^53 and `colLetter(Infinity)` (neither returns in
TypeScript either). `dgm_hier` recurses once a tree level; JSON arguments
stop at 128 levels, and the model port of unit 4 has to bound it when it
builds the tree from a document.

### Debt: the backtracking stack of the regular expression engine

Not fixed here and not of this unit alone; it blocks switching any Rust
engine into the app. regress 0.12 keeps its backtracking positions in a
private `Vec` with no bound, three entries of 32 bytes a character for a
pattern that loops over an alternation, like the tag scanner of
`custgeom.rs`, `<\/?(?:[^<>"']|"[^"]*"|'[^']*')*>` (the tag scanner of
`animation/prune.rs` is of the same kind). Measured on 2026-11-12 with one
unclosed `<` followed by N characters `a` inside an `a:custGeom`, through
`parseCustGeom`, one process per N:

| N     | Release wasm32 of the gate (Node 22) | TypeScript (Node 22)                           |
| ----- | ------------------------------------ | ---------------------------------------------- |
| 1M    | answers, 157 ms, memory 172 MB       | answers, 9 ms                                  |
| 5M    | answers, 688 ms, 683 MB              | answers, 41 ms                                 |
| 6M    | answers, 982 ms, 1.36 GB             | answers, 46 ms                                 |
| 8M    | answers, 1.14 s, 1.36 GB             | answers, 69 ms                                 |
| 9M    | not run                              | `RangeError: Maximum call stack size exceeded` |
| 10M   | answers, 1.42 s, 1.36 GB             | RangeError, 39 ms                              |
| 20M   | answers, 2.95 s, 2.73 GB             | RangeError, 104 ms                             |
| 22.0M | answers, 2.33 s, 2.73 GB             | not run                                        |
| 22.4M | aborts (`RuntimeError: unreachable`) | not run                                        |
| 50M   | aborts                               | RangeError, 48 ms                              |

The Rust passes one second near 6 million characters and aborts the module
at 22.4 million, where the next buffer would be 4.29 GB; wasm memory is not
returned, so a call that answers still leaves it grown. The TypeScript never
hangs or grows: V8 bounds its own regexp stack and throws from 9 million
on. So between 9 and 22.4 million the TypeScript throws and the Rust
answers `undefined`; no gate input is that large, and there is no ledger
class for it. The zip gate admits such a part (10,000 parts and 1.5 GB in
all, no limit on one part). Main's decision: no size cap on a part; the
bound belongs in `jscompat` and the stream that owns `jscompat`'s pattern
sites does it (another executor measured against V8's answers, else a
budget or hand-written scanners).

### Unit 2 on the runner

Run 43161973043 at `0ad2a994c`: the Word gate, clippy and tests passed after
the merge of `origin/feat/rust-docx-u1` (its runner additions ported into the
shared `calls-runner.ts`), the slides gate passed, and 114 of the 119 fault
probes were caught in four shards of about ten minutes. The five that passed,
and what closed each:

| Fault                                   | Why it passed                                                                 | Closed by                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `geom-r5-round`                         | No coordinate was a negative half of a hundred-thousandth                     | A path 64 wide with points at -1, -3 and -5 (3 differences)           |
| `ident-set-first-close`                 | With one `a:extLst`, the first and the last closing tag give the same result  | Two `a:rPr` without a list (1 difference)                             |
| `independent-anim-eq-ignores-direction` | No new list differed from the slide's only in a direction                     | The second effect's direction changed (1 difference)                  |
| `independent-own-cnvpr-last-close`      | No group had a paired `p:cNvPr` without a creationId over a child with one    | Such a group (8 differences)                                          |
| `mtx-huffman-range-boundary`            | Not a miss: the fault underflowed and the debug module aborted before a tally | The fault is `<= 512` now (11 differences); an abort is named ABORTED |

Two of the five were chosen by the reviewers who had not seen the porters'
lists. A probe whose comparison ends without its tally is reported as
ABORTED and fails the run, so a fault has to show as a difference of its
function.

## Unit 3 local proof

The theme chain: `theme.ts`, `color.ts`, `placeholder.ts`, `table-style.ts`,
`chart.ts`, `chartex.ts` (3,834 lines), with the subset of `types.ts` they
need in `types.rs`. Each group's first comparison is kept unchanged in
`evidence/u3-<group>-first.*`; the theme group's spec did not load the first
time (a name declared twice) and that run is kept as
`evidence/u3-theme-load-failure.*`.

| Group         | Source files             | Functions | First checks | Different | Equal    |
| ------------- | ------------------------ | --------- | ------------ | --------- | -------- |
| `theme`       | `theme.ts`, `color.ts`   | 11        | 7,232        | 29        | 99.599%  |
| `placeholder` | `placeholder.ts`         | 14        | 11,309       | 46        | 99.593%  |
| `tablestyle`  | `table-style.ts`         | 8         | 16,749       | 14        | 99.916%  |
| `chart`       | `chart.ts`, `chartex.ts` | 2         | 1,433        | 47        | 96.720%  |
| Unit          |                          | 35        | 36,723       | 136       | 99.6297% |

The commit of the placeholder group says 12,309 checks; the log says 11,309.

Two of the 136 were errors of the port: two theme colors of the tracked decks
one step off after the gamma curve of a tint, because `f64::powf` is not V8's
`Math.pow` in the last bit. `jscompat::math_pow` uses the `libm` crate
(fdlibm) now, and a seeded sweep of 600 colors through tint and shade was
added. The other 134 are TypeScript defects written right in Rust, one ledger
class each, reported to main:

| Class                              | First differences | What the TypeScript does                                                                    |
| ---------------------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `inherited-key-color-prst`         | 14                | `prstClr val="constructor"` (and the other inherited names) throws                          |
| `inherited-key-theme-clrmap`       | 12                | A master clrMap value like `constructor` answers a function; the color node then throws     |
| `theme-script-font-proto`          | 1                 | `a:font script="__proto__"` sets the prototype and the font is lost                         |
| `inherited-key-placeholder-anchor` | 26                | `bodyPr anchor="constructor"` gives a function as the anchor                                |
| `inherited-key-placeholder-align`  | 20                | `algn="constructor"` gives a function as the alignment                                      |
| `inherited-key-table-style-id`     | 14                | A `tableStyleId` of an inherited name throws                                                |
| `chart-xsd-boolean`                | 47                | CT_Boolean `val="true"`, `val="false"` and no `val` read against ECMA-376 at about 45 sites |

`chart-xsd-boolean` is named by a test of the text (`CallSpec.listed` in
`calls-chart.ts`), since a mutation that leaves an attribute without a value
makes the same tree as `<c:delete/>`; the ledger check requires every class
a spec names to have its entry and an input that still differs. Every site
reads through `chart::node::xsd_bool` with the TypeScript's reading as a
parameter (`TsBoolRead::EqOne` or `NotZero`):
`rg -n "xsd_bool\(" crates/pptx-engine/src/chart` lists them.

No replacement string of these files holds document or caller text, and none
builds a pattern from such text. Read and found safe: `color.ts:335`,
`theme.ts:68`, `:280`, `table-style.ts:220`, `:247`, `:256`, `:257`,
`chart.ts:1295` to `:1302`.

The tracked decks have no chart part, no `p:ph` in the new fixture, and one
custom and one built-in table style: charts and most of the placeholder and
table-style branches rest on built inputs and seeded mutations.
`chart.ts`'s fill resolution (`parseFill`) is a function argument and cannot
cross JSON: both sides are given the same stand-in, and the real one comes
with unit 4.

### Unit 3 faults and aborts

69 fault probes for the unit's new groups (the porters' one or two per
function, nine chosen for placeholder, table-style and theme and eight for
charts by reviewers who had not seen those lists), plus the eight theme probes
committed with that group. Locally 67 of the 69 were caught. The two that
passed and what closed them: `ts-color-srgb-case` and
`chart-chartex-negative-idx` (no chartEx level had a point with a negative
`idx`; one was added after `idx` 0). For `ts-color-srgb-case` a style with
the color `a0b1c2` was added first, and the runner (43177316406) still missed
the probe: `applyColorMods` cuts the hex pairs and parses them without regard
to case, so upper-casing changes an answer only where it changes the length.
The input that closes it is `srgbClr val="ß0a0b0"`: `ß` upper-cases to `SS`
and shifts every pair after it.

A read-only audit found three ways a forged chart part exhausts wasm memory,
none a panic: point arrays sized by one large `idx` in each of 256 series,
an unbounded number of chartEx levels of up to 10,000 cells each, and a
chartEx point color at index 4,294,967,294 serialised hole by hole. The first
two allocate fallibly now and return `RangeError: Array buffer allocation
failed`; the third refuses past (2^29 - 24) / 5 entries with `RangeError:
Invalid string length`, where V8's own serialisation fails, so both sides
refuse. No cap that changes an answer was added.

## Unit 4 local proof

The slide reader: `parse.ts` and `master-edit.ts` (4,524 lines) with the
rest of `types.ts` (786), ported as `src/parse/` (one module per section of
`parse.ts`, `diagram/` holding the SmartArt families) and `src/master_edit.rs`:
7,889 lines of Rust. The group `parse` compares the seven exports, and
`parseSlide` compares whole slide models, so every internal function is
observed through the model it builds. Both sides draw ids from one module
counter; the spec renumbers them from a probe slide per call
(`parse/context.rs`, `Uids`). The first comparison is kept unchanged in
`evidence/u4-parse-first.*`.

| Checks        | First | Different | Equal   |
| ------------- | ----- | --------- | ------- |
| Corpus        | 219   | 0         |         |
| Built inputs  | 1,867 | 34        |         |
| Mutated texts | 2,100 | 3         |         |
| Unit          | 4,186 | 37        | 99.116% |

None of the 37 was an error of the port. Each is a TypeScript defect written
right in Rust, one ledger class each (two classes of unit 3 gained cases):

| Class                          | First | What the TypeScript does                                                        |
| ------------------------------ | ----- | ------------------------------------------------------------------------------- |
| `inherited-key-theme-clrmap`   | 8     | bg1 mapped to an inherited name: `toUpperCase` of a function throws, slide lost |
| `inherited-key-table-style-id` | 3     | `tableStyleId` `constructor` reaches `wholeTbl` of undefined, slide lost        |
| `grpsppr-string-in`            | 4     | `'a:grpFill' in ''` on `<p:grpSp/>`'s empty `grpSpPr` throws, slide lost        |
| `dgm-style-idx-negative`       | 4     | `presStyleIdx="-1"` reads slot -1, then `.spPr` of undefined throws             |
| `dgm-style-idx-infinite`       | 4     | a 400-digit `presStyleIdx` is Infinity, `% n` is NaN, the same throw            |
| `inherited-key-parse-678`      | 2     | `a:ln cap` of an inherited name: a function or `{}` as the cap                  |
| `inherited-key-parse-686`      | 2     | `a:ln cmpd` the same                                                            |
| `inherited-key-parse-713`      | 2     | arrow `w`/`len` the same, instead of `med`                                      |
| `avlst-proto`                  | 2     | a guide named `__proto__` is lost to the prototype setter                       |
| `inherited-key-parse-3319`     | 2     | cell `anchor` of an inherited name                                              |
| `inherited-key-parse-3762`     | 2     | body `anchor` of an inherited name                                              |
| `inherited-key-parse-3985`     | 2     | paragraph `algn` of an inherited name                                           |

The mutated texts of a whole run differ from those of a run of one group
(the seeded stream is shared), so a full run found one more mutation of
`dgm-style-idx-negative`; it is in the ledger too.

Kept as the TypeScript reads them, not ledgered: `atob` of our own `gxRaw`
attribute throws on text that is not base64 and the slide is lost
(`jscompat::atob` follows the forgiving-base64 rules of Node);
`diagramTextColors` finds `styleLbl` and `pt` elements by regular expressions
that miss single quotes and other attribute orders; `cSldName` does not
decode entities. Replacement strings: `shape.rs` rewrites the math blocks
through a function, the others are literals or the group reference `$1` of a
constant; none holds document text.

The tracked decks have no SmartArt, no connector, no `p:bg` on a slide or
layout, no `p:hf`, no deep groups and no media: those branches rest on built
inputs (about 600) and the mutations.

### Unit 4 stack, memory and faults

A group nested 64 deep, the TypeScript's bound, overflowed the 1 MiB wasm
stack of a debug build between depth 32 and 48 (about 25 KiB a level), and
a release build linked with a 256 KiB stack the same. Each recursive frame
held the temporaries of every element kind `parseGroupChild` builds; the
arms that do not recurse are `parse_leaf_child` now (`#[inline(never)]`),
and depth 64 passes on release at 256 KiB and on debug at 1 MiB.

A read-only audit found no reachable panic. Fixed: every element built from
one fragment copied the fragment's whole text (`ByteAnchor.original_xml` is
an `Arc<str>` now, as the TypeScript shares one string), the SmartArt split
cloned a run with its whole text per hard return, and one `lProcess` test
was recomputed per root. Left, and the same in the TypeScript: lazy patterns
that rescan to the end from every start with no terminator (`<p:bg`, `<a:br`,
`<mc:AlternateContent>`), quadratic in such starts.

110 fault probes: 96 from the porters' lists, at least one per function, and
14 by a reviewer who had not seen them. Seven ran locally and all were caught before the run was
moved to the runner (a debug rebuild per probe made the local run about four
minutes a probe).

## The regular expression bound in this crate

Stream D bounded `regress` (`TryJsRegex`, `BACKTRACK_LIMIT`); `cargo test -p
jscompat --test sites` names every site that must use it. In this crate:

- A loop that keeps backtrack entries per turn is a `TryJsRegex`, and a
  search that passes the bound is an error, never a default: the tag pattern
  `<\/?(?:[^<>"']|"[^"]*"|'[^']*')*>` of `custgeom.rs` (`parse_cust_geom`
  returns `Result`), `scan.rs` (`ScanError::RegexLimit`), the group slicing of
  `parse/shape.rs` and `theme.rs`, and the timing collapse of
  `animation/prune.rs` (`prune_timing_for_spids` returns `Result`).
  `parse_picture` returns `Result` for the custom geometry it reads.
- A search restarted once per match with a regex that reads the rest of the
  text first (`[^>]` without `u` does) is gone: the balanced scans of
  `<p:cTn>`, `<p:par>`, `<p:childTnLst>`, `<p:seq>` and `<p:bldLst>` are written
  out (`animation::incremental::tag_matches`), and the effects of the main
  sequence come from one search (`animation::read::EffectCtns`) that starts
  again only where a match runs past the TypeScript's `lastIndex`. The rows
  and cells of `table_edit.rs` and the targets of `prune.rs` are searched with
  literals the test reads (they read nothing ahead). `scanSlide` makes one
  pass per part and is listed in the test.
- Patterns built from `format!` are written at the call so the test reads
  them (`theme.rs` clrMap names, `identity.rs`, `redaction_xml.rs`).
