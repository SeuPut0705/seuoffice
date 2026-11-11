# crates

The Rust document engines of SeuOffice. Today this is the docx engine, ported
from `packages/docx-engine` one module at a time. Nothing in the product calls
it yet: every ported module is compared against the TypeScript it came from by
`tools/docx-diff`, and the TypeScript stays the engine until a unit flips a
caller.

A session that picks this work up starts at
[Next session starts here](#next-session-starts-here).

## Layout

| Crate                | What it holds                                                                                                                                                                                                                                                          | Ported from                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jscompat`           | JavaScript operations, bit for bit: `parseInt`, `Number`, `Math.round`, number printing, regular expressions, `Map`, `decodeURIComponent`                                                                                                                              | the language                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ooxml-xml`          | The tag scanner, the ordered parser and its serializer, `XNode` readers, UTF-16 offsets                                                                                                                                                                                | `scan.ts`, `xml-utils.ts`, fast-xml-parser                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ooxml-pkg`          | A docx as `loadDocxZip` opens it: the zip gate, the JSZip reader, Strict normalization, `Package`; the zip as JSZip writes it (`write`)                                                                                                                                | `zip-load.ts`, `packages/zip-gate`, JSZip 3.10.1, `ooxml-normalize.ts`                                                                                                                                                                                                                                                                                                                                                                        |
| `docx-engine`        | Body scan, property readers, relationships, content types, theme, font table, styles, numbering, comments, protection and its hash, document properties, sources, sections, watermarks, notes, fields, EQ fields, SDTs, list markers, symbol fonts, the blank document | `scan.ts`, `parse-props.ts`, `parse-xml-text.ts`, `parse-package.ts`, `theme.ts`, `font-table.ts`, `parse-styles.ts`, parts of `parse.ts`; the read side of `doc-properties.ts`, `zotero-doc-props.ts`, `sources.ts`, `protection.ts`, `section.ts`, `watermark.ts`, `notes.ts`; `parse-fields.ts` without what needs `resolve-props.ts`, `eq-field.ts`, `parse-sdt.ts`, `field-balance.ts`, `list-markers.ts`, `symbol-fonts.ts`, `blank.ts` |
| `omml`               | Office Math: OMML to LaTeX and to MathML, LaTeX to OMML. Depends on no engine                                                                                                                                                                                          | `math.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `office-wasm`        | The one entry point JavaScript calls, built for `wasm32-wasip1`                                                                                                                                                                                                        | new                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `spike-one-run-save` | An experiment, not part of the engine: see its README                                                                                                                                                                                                                  | new                                                                                                                                                                                                                                                                                                                                                                                                                                           |

`docx-engine` is pure: bytes and values in, values out. No I/O, no clock, no
randomness.

## How a module is ported

1. Port line by line, in the order of the TypeScript, so the two read side by
   side. Do not improve the logic. A quirk of the original is part of the
   contract until the TypeScript is gone.
2. Name every JavaScript operation by its `jscompat` function (rules below).
3. Where the TypeScript throws, return `Err`. Where it returns `undefined`,
   return `None` and leave the key out of the JSON. Where it returns `null`,
   serialize `null`.
4. Add the module to `tools/docx-diff` (below) before believing it.
5. Write the Rust tests from answers the TypeScript gave, not from what the
   code should do. `tests/readers.rs` and `tests/styles.rs` say how each was
   generated.

## jscompat rules

A port that uses the nearest Rust function differs on real documents. These
are the ones that bit, each with an input where the two disagree:

| JavaScript                      | Use                                                      | Not                      | Differs on                                                        |
| ------------------------------- | -------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| `parseInt(s, 10)`               | `parse_int(s, Radix::Ten)`                               | `s.parse()`              | `"12.9pt"` is 12, `" 7"` is 7, `""` is NaN                        |
| `Number(s)`                     | `to_number`                                              | `s.parse::<f64>()`       | `""` is 0, `"0x10"` is 16, `"1e2"` is 100                         |
| `parseFloat(s)`                 | `parse_float`                                            | `s.parse::<f64>()`       | `"2.5cm"` is 2.5                                                  |
| `Math.round(x)`                 | `math_round`                                             | `f64::round`             | -2.5 rounds to -2                                                 |
| `String(x)`                     | `number_to_string`                                       | `format!("{x}")`         | `1e21`, and ties in the last digit                                |
| `x \| 0`, `x & m`               | `to_int32`                                               | `as i32`                 | wraps, does not saturate                                          |
| `n.toString(16)`                | `to_string_radix16`                                      | `format!("{:x}")`        | integers past 64 bits                                             |
| a number in a model             | `JsNum(f64)`                                             | an integer type          | the TypeScript holds NaN and fractions there                      |
| `/pattern/flags`                | `js_regex!(r"pattern", "flags")`                         | the `regex` crate        | lookahead, backreferences, `\s` holds U+FEFF, `\d` is ASCII       |
| `new RegExp(text)`              | `JsRegex::new(text, flags)?`                             | assuming it compiles     | a tag name like `w:(` throws                                      |
| `s.split(/re/)`                 | `JsRegex::split`                                         | `str::split`             | empty matches, the trailing piece                                 |
| `s.trim()`                      | `trim`, `trim_start`                                     | `str::trim`              | U+FEFF is white space, U+0085 is not                              |
| `if (s)`, `a \|\| b` on strings | `truthy(Option<&str>)`                                   | `Option::is_some`        | `""` is false                                                     |
| `a ?? b`                        | `Option::or`, `unwrap_or`                                | `truthy`                 | `""` and `0` are kept                                             |
| `new Map()`                     | `JsMap<V>`                                               | `HashMap`, `BTreeMap`    | order of entries; a key set again keeps its place                 |
| `{}` used as a table            | a `match` on own keys                                    |                          | `table["constructor"]` answers in JavaScript: a listed divergence |
| `obj[key] = value`              | skip `"__proto__"` where the key comes from the document |                          | that assignment sets the prototype and leaves no entry            |
| `decodeURIComponent`            | `decode_uri_component`                                   | a percent-decoding crate | malformed escapes throw                                           |
| `JSON.stringify`                | `serde` with `skip_serializing_if`, `JsNum`              |                          | NaN is `null`, -0 is `0`, `undefined` is no key                   |

`regress` walks UTF-8 characters where JavaScript without the `u` flag walks
UTF-16 code units. It shows only in a pattern that counts characters outside
the BMP (`.{2}`); no ported pattern does.

Sizes and offsets read from a file are `u64` or `i64`, never `usize`: the wasm
target is 32-bit and sums of 32-bit fields wrap.

## The wire frame

`office-wasm` exports `seu_alloc`, `seu_free` and `seu_call`. One buffer goes
in and one comes out, the same frame both ways, little endian:

```
u32 header length | header JSON | u32 blob count | (u32 length | bytes)*
```

The header is `{ "version": 1, "cmd": "...", ... }`. Blobs carry document bytes
and long texts; JSON carries everything else. Offsets in a reply count UTF-16
code units. A request that cannot be served is a reply
`{ "error": { "code", "message" } }`, never a panic: the release profile
aborts on panic, which poisons the instance.

| `cmd`            | In                                         | Out                                                                  |
| ---------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `scanBody`       | blob 0: the main part, UTF-8               | `{ scan }`                                                           |
| `roundTripXml`   | `fragments`, `maxNestedTags`               | `{ results }`: the XML again, or an error, per fragment              |
| `zipEntries`     | blob 0: a zip                              | `{ entries }`, blob `i`: the text of entry `i`, UTF-16LE             |
| `props`          | `inputs: [{ xml, calls: [{ fn, args }] }]` | `{ results }`: per call `{ value }`, `{}` for undefined, `{ error }` |
| `package`        | blob 0: a docx                             | `{ package: { refused } }` or `{ package: { entries, model } }`      |
| `packageParts`   | `parts: [{ name, text }]`                  | `{ package: { entries, model } }` for a package made of those texts  |
| `normalizeOoxml` | every blob: a part, UTF-8                  | `{ needed }`, blob `i`: the part normalized                          |

The commands exist for the gate. They are not the interface the product will
call: that is designed when a caller flips.

Build: `node crates/office-wasm/build.mjs` (it uses rustup's toolchain; the
Homebrew one has no wasm target).

## The gate: tools/docx-diff

`npm --prefix tools/docx-diff run gate` builds the wasm and runs every
comparison over the 185 `.docx` files tracked in the repository. It exits 1 on
any difference, any population below `floors.json`, or a `divergences.json`
entry that no longer reproduces.

|     | Compares                                                                                                                                                                   | Module                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| (a) | `scanBody`                                                                                                                                                                 | `compare-scan.ts`                                         |
| (b) | parse and serialize of XML fragments                                                                                                                                       | `compare-xml.ts`                                          |
| (c) | text of zip entries                                                                                                                                                        | `compare-zip.ts`                                          |
| (d) | the 69 property readers                                                                                                                                                    | `compare-props.ts`, `props-registry.ts`, `props-run.ts`   |
| (e) | the package layer: loading, refusals, normalization, every value read before the body                                                                                      | `compare-package.ts`, `package-zips.ts`, `package-run.ts` |
| (f) | exported functions of the modules ported since, called by name, one group per module family                                                                                | `calls-spec.ts`, `calls-run.ts`, `calls-<group>.ts`       |
| (g) | the zips the writer produces, for every blank document option set and for built packages: entries, order and inflated content as JSZip reads them, and every raw zip field | `compare-blank.ts`                                        |

A `+` marks seeded mutations of the same inputs. The rule for them: where the
TypeScript throws, Rust must refuse; where it answers, Rust must answer the
same.

What the comparisons do not see:

- **The order of the keys of an object.** JSON objects are compared as sets
  of keys. Where the order can be observed (a record keyed by data from the
  document), (f) sends the result as its entries. (d) and (e) do not: the
  numbering levels of `numbering.rs` sit in a `BTreeMap`, which puts `"10"`
  before `"2"` where JavaScript puts integer keys in numeric order.
- **A lone surrogate in a result.** A Rust string cannot hold one, so where
  the TypeScript result has one, (f) compares against that result with each
  lone surrogate written as U+FFFD, on a line of its own per group. The raw
  difference is in `divergences.json`, one entry per cause.
- **Inputs a spec names as `listed`.** They are the inherited-key lookups of
  `divergences.json`, counted in the report.

### Adding a comparison

1. `compare-<name>.ts`: the TypeScript reference, the call into the wasm, and
   a function that records one check per compared value on a `Comparison`.
   Normalize both sides to what `JSON.stringify` would write, but make a `Map`
   (as its entries) and a function (as a marker) visible first: JSON hides
   both, and both have hidden real differences.
2. `<name>-run.ts` when the comparison has populations of its own: what it
   takes from each corpus document, what it builds, what it mutates, and the
   lines it adds to the report. Construct each `Comparison` at module level;
   that registers the line.
3. `main.ts`: call the run module from the corpus loop, after it, and in the
   report. Nothing else goes there.
4. Run once with the floor keys missing, read the populations, and commit
   them to `floors.json`: exact where they follow the corpus, rounded down
   where they follow a seeded generator.

### Adding functions to (f)

A module whose exports can be called one by one needs no comparison of its
own. It joins a group:

1. `tools/docx-diff/calls-<group>.ts`: one `CallSpec` per exported function,
   named `<group>.<TypeScript name>`: the TypeScript call, the inputs a corpus
   document gives (`fromDocument`), and the inputs built for what the corpus
   lacks. The runner adds seeded mutations of the text of both.
2. `crates/office-wasm/src/calls/<group>.rs`: `dispatch(function, text, args)`
   answering to the same names. A function over a parsed node takes the XML
   text and both sides parse it; a function over a zip takes `args.parts`.
3. `npm --prefix tools/docx-diff run calls -- --group <group> --by-function`
   runs that group alone in seconds. It accepts nothing: the gate does.

A group reports its own line: how many functions, and how many of them only
ever gave one result. The second number has to be 0.

### What makes a comparison worth its line

- **Count what was compared, and floor it.** A comparison that silently
  compares nothing passes.
- **Count distinct results per function.** With the corpus alone, 12 of the
  property readers only ever returned one value. The gate fails on a function
  with fewer than two distinct results.
- **Count the refusals.** "TypeScript threw N times" says nothing until it is
  known which function threw and why. The gate fails when a reader over a
  parsed element never met a text the parser refuses.
- **Build what the corpus lacks.** No tracked document has a field, a ruby, a
  zip64 archive or a Strict package. `props-synthetic.ts` and
  `package-zips.ts` hold what was written to fill that.
- **Inject faults.** Change one line of the Rust to the naive form (`f64::round`,
  a dropped regex flag, `>` for `>=`) and see that the gate goes red. A fault
  the gate misses names an input to add.

### Divergences

`divergences.json` lists every input where the two engines are known to
differ, with the answer of each side and the reason. The gate checks each
entry still reproduces as listed, so the ledger cannot go stale. A divergence
is listed, never coded around in the harness.

## Known debt

- `Package` holds every entry inflated; JSZip inflates on read. Fine for the
  gate, to be revisited when a caller flips.
- The zip gate refuses every archive JSZip would read as ZIP64, so the ZIP64
  branch of `ooxml-pkg/src/jszip.rs` is no longer reached through
  `load_docx_package`. The gate compares nothing of it; its unit tests do.
- `docx-engine/src/styles/mod.rs` has a private `JsMap` from before
  `jscompat::JsMap` existed.
- `cargo-deny` is configured (`deny.toml`) but was not installed on the
  machine these crates were written on, so it has not run.
- Helpers written more than once, to move down: `Math.max`/`Math.min` with
  JavaScript's NaN and zero rules (`list_markers.rs`, `vml.rs`), text escapes
  (`eq_field.rs`, `blank.rs`, `omml/src/xml.rs`, and private in `ooxml-xml`),
  `String.prototype.slice` (`sdt.rs`, `eq_field.rs`, `field_balance.rs`), the
  record that keeps JavaScript's key order (`doc_properties.rs`, and the
  array-index test in `ooxml-pkg` and `ooxml-xml`), `atob` (`protection.rs`),
  the `Date` readers (`ooxml-pkg/src/write.rs`, `blank.rs`), the new document
  properties (`blank.rs`; `doc_properties.rs` holds the read side only).
- `fields.rs` takes what `resolve-props.ts` computes as arguments
  (`EffectivePPr`, `ResolveCtx`, `ResolveCompat` hold only the fields read
  here). `fieldDisplayOf` waits for that port; `applyTocEntryNumbers` works
  on the block model and waits for `parse.ts`.
- `parseNotesXml` is ported without its paragraph reader callback, which
  `parse.ts` supplies.
- `blank/locale.rs` answers `paperSizeForLocale` from a table of likely
  subtags taken from one ICU (`tools/docx-diff/blank-locale-table.mjs` says
  which and regenerates it). The TypeScript asks the host's `Intl.Locale`, so
  another ICU can answer differently for rare tags.
- `omml` refuses LaTeX nested deeper than 256 levels; the TypeScript runs
  until the JavaScript stack overflows.
- The zip writer re-deflates every entry and rebuilds every header, as JSZip
  does, so parity with today's save does not need more. A save that keeps an
  untouched entry byte for byte needs its raw record copied instead, and that
  belongs to the save unit, not before it and not mixed with the first
  switch of a caller. What it takes: the reader keeps each original record
  (local header, extra fields, compressed bytes, data descriptor), which
  `Package` does not do today. `spike-one-run-save/src/container.rs` is a
  working sketch of 214 lines. It refuses ZIP64, multi-disk and encrypted
  archives and a central directory whose offset does not match its position;
  it keeps bytes before the first record; an entry it replaces loses its data
  descriptor. 1 tracked document and 11 of Apache POI's 115 have data
  descriptors; none has a prefix.

## Next session starts here

State on 2026-11-12. Nothing is pushed.

- `feat/rust-docx-u1`: everything below. The gate passes on this baseline.
- `fix/rust-zip64-six-fields`: this branch and two commits more. They make
  the Rust zip gate refuse the six end-record fields main's zip gate refuses
  since d49361a3f, and they are green only on a baseline that holds that
  commit. main merges this one, so the two arrive together.

### What to do, in order

0. **Bring the Rust and the ledger in line with main.** main fixed the
   TypeScript defects this port found. Once this work sits on a tree that
   holds those commits, run the gate first and save that run untouched: it
   is expected to fail, with stale ledger entries and with differences
   where the TypeScript changed. Then, class by class:
   - **Table lookups answer for own keys only** (cf22e1fe4, 18 modules).
     The Rust tables already do. The 13 `table-lookup-inherited-key-*`
     entries go stale: remove them, the `listed` predicates of
     `calls-markers.ts`, `calls-section.ts`, `calls-blank.ts` and
     `props-registry.ts`, and `listed` itself from `CallSpec` and `Reader`
     if nothing uses it any more. Those inputs are then compared again. One
     place where the TypeScript changed its answer: an unknown
     `paperSize` now gives A4, where `blank.rs` refuses any value but `A4`
     and `Letter`.
   - **A record keeps an entry named `__proto__`** (f11df68ef). The Rust
     drops it in two places to mirror the old assignment and must keep it
     now: `doc_properties.rs` (the `Record`) and `theme.rs` (the script
     fonts). `vml.rs` reads tag attributes into such a record too. The
     entry sits where it was inserted, like any other string key.
   - **A character outside the BMP is one LaTeX argument** (37c8fcdaa).
     `omml/src/latex_to_omml.rs` takes one UTF-16 unit there, as the old
     TypeScript did, and has to take the pair. The entry
     `lone-surrogate-from-half-a-latex-argument` goes, and with it most or
     all of the lossy line of math: lower or drop `callsMathLossy`.
   - **A character reference in the surrogate range reads as U+FFFD**
     (6f0fdab07), a pair written as two references still joining. The Rust
     already does both. The two `lone-surrogate-*` entries of document
     properties go, and `callsDocpropsLossy` with the line.
   - **A LaTeX name every object inherits is refused as unknown**
     (488d6d432). Both sides refused before; nothing should move.
   - **The zip gate** (d49361a3f): done by the branch above.

   What holds answers of the old TypeScript and has to be made again:
   `crates/fixtures/package-layer.json`
   (`npm --prefix tools/docx-diff run fixtures`), and the expected values of
   `docx-engine/tests/docprops.rs`, `tests/package.rs` and `tests/blank.rs`
   where they name `__proto__` or a paper size. The four readers
   `compare-package.ts` copies from `parse.ts` still match main at
   488d6d432.

   These entries stay: the LaTeX depth limit, the two host-dependent ones
   (`zip-text-in-hosts-without-buffer`, `inflate-failure-text-is-the-hosts`),
   DOCTYPE and the CDATA opener.

1. **Key order becomes part of parity everywhere.** Turn on `preserve_order`
   of `serde_json` and compare (d), (e) and (f) with a deep comparison that
   looks at key order, struct fields included. The CLI prints engine results
   as JSON, and 87 places in the TypeScript engine iterate objects. Where the
   TypeScript order depends on the path taken (a key assigned under a
   condition), mirror the path. A ledger entry for an order is allowed only
   with its reason written. Expect the first run to light up many structs:
   a Rust struct serializes in declaration order, a TypeScript literal in
   the order it was written. `numbering.rs` keeps levels in a `BTreeMap`
   (`"10"` before `"2"`); that is one known case. The specs of (f) that send
   dictionaries as entries can go back to plain objects afterwards.
2. **`resolve-props.ts`** (1,141 lines, 25 exports; imports only modules
   already ported). It unblocks `fieldDisplayOf` and replaces the partial
   `EffectivePPr`, `ResolveCtx` and `ResolveCompat` of `fields.rs`.
3. **The leaves `parse.ts` still imports**, in parallel, each as a group of
   (f): the rest of `parse-drawing-geometry.ts` (651; one function is
   ported) and of `parse-vml.ts` (568; nine are), `chart.ts` read side
   (1,077), `revision-xml.ts` (511, shared with the save side),
   `alt-chunk.ts` (289), `parse-block-passes.ts` (240), `ink.ts` (153),
   `checkbox-control.ts` (77). `tiff.ts` (145) and `metafile.ts` (122) read
   bytes: their inputs cross as blobs of the wire frame, not as text.
   `lazy-media.ts` (55) is about when the host reads media, so decide what
   of it the engine owns before porting it.
4. **The model**, `types.ts` (2,719 lines), as Rust types that serialize to
   the same JSON. Task 1 decides how their field order is written down.
5. **`parse.ts`** (9,171 lines, 152 functions, 12 exports). Its functions
   are not exported, so (f) cannot call them. Compare `parseDocx` as a
   whole: the model of every corpus document as JSON, block by block, with a
   count per block type and per field so a partial port shows what is equal
   already. Port by pass: runs, paragraphs, tables, drawings and text boxes,
   the block passes. Then finish `parseNotesXml`'s paragraph reader and
   `applyTocEntryNumbers`, which need it.
6. The save side (`generate.ts`, `patch.ts`, `text-patch.ts`,
   `style-upsert.ts`, `remove-parts.ts`, `zip-splice.ts`,
   `resource-cleanup.ts`, the writers left out of the modules above) and
   the features on top (`compare.ts`, `mail-merge.ts`) come after the read
   side is whole.

One finding is not a port matter and is with main: a run-level content
control is dropped when its paragraph is saved as a generated block
(`spike-one-run-save/README.md`). A faithful port reproduces it.

### Standing rules

From the owner, for every unit:

- Change files only under `crates/` and `tools/docx-diff/`. No product code
  (`apps/`, `packages/*/src`), no workflow, no root `package.json`, no
  `AGENTS.md`. No push, no `git stash`, no rewriting history.
- English Conventional Commits, one change each, each building and passing
  its tests. Comments in English, no CJK ideographs (escape them in
  literals).
- Between 03:30 and 05:00 KST nothing heavy runs: no `cargo`, no wasm build,
  no gate, no whole test suite. `tsc`, eslint, prettier and a single `tsx`
  script are fine. Outside the window one heavy command at a time on the
  machine. `tools/docx-diff/heavy.sh <command>` does both: it waits for the
  window to end and for the lock. Every subagent goes through it too.
- The first comparison run of a newly ported module is saved untouched
  before anything is fixed: it is the measure of the port. A comparison a
  subagent made privately does not count; the gate does.
- A function counts as compared when it gave at least two distinct results
  and a seeded fault in it is caught. The one who integrates seeds a fault
  of their own per group, chosen without looking at the porter's list. A
  fault that passes names an input to add.
- Floors are committed with the unit: exact where they follow the corpus,
  rounded down where they follow a seeded generator.
- A difference is listed in `divergences.json` with both answers and the
  reason, and the gate checks it still reproduces. It is never coded around,
  in the Rust or in the harness. A TypeScript defect is reported to main,
  not reproduced and not silently avoided. The DOCTYPE refusal is final.
- A JavaScript operation gets one implementation, in `jscompat`.
- `ooxml-xml` keeps yielding positions: the edit model of stage 4 starts
  from byte ranges (decision 0025 on main), for which `spike-one-run-save`
  is the evidence. That crate stays.
- Each unit ends with a report to main: equality before fixing, the classes
  of difference, what cannot be reproduced, the rate, and what was not
  checked. `cargo-deny` is not installed here: say it did not run.
- `packages/docx-engine` moves underneath: another session merges upstream
  commits. `compare-package.ts` holds four readers copied from `parse.ts`
  and the gate fails when `parse.ts` no longer holds that text.

### How the last units were run

- Leaf modules went to subagents in parallel, one group of modules each,
  with files no other one touched and the contract of "Adding functions to
  (f)" as the brief. While they wrote, each group sat behind a cargo feature
  of its own so that one group that did not compile yet stopped no other;
  the features went once every group built. Shared files (manifests,
  `lib.rs`, `calls/mod.rs`, the runner) stayed with the integrator.
- Commits were checked as staged: the index of `crates/` checked out to a
  scratch directory, then `cargo test`, the wasm release build and clippy
  with `-D warnings` there.
- Rates, in TypeScript lines per hour: 1,433 for the package layer (one
  agent, wall clock); about 875 per agent for the readers of unit 1d (four
  agents, about 1,500 an hour together); about 790 for the math converters;
  about 510 for the blank document with the zip writer, where a model of
  `Intl.Locale` had to be found first. Integrating six groups, the gate,
  floors and commits took another 70 minutes, most of it waiting for the
  lock.
- The gate takes about two and a half minutes with its wasm build; one group
  of (f) alone about 40 seconds.
