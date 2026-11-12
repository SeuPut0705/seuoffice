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

| JavaScript                      | Use                                         | Not                      | Differs on                                                        |
| ------------------------------- | ------------------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| `parseInt(s, 10)`               | `parse_int(s, Radix::Ten)`                  | `s.parse()`              | `"12.9pt"` is 12, `" 7"` is 7, `""` is NaN                        |
| `Number(s)`                     | `to_number`                                 | `s.parse::<f64>()`       | `""` is 0, `"0x10"` is 16, `"1e2"` is 100                         |
| `parseFloat(s)`                 | `parse_float`                               | `s.parse::<f64>()`       | `"2.5cm"` is 2.5                                                  |
| `Math.round(x)`                 | `math_round`                                | `f64::round`             | -2.5 rounds to -2                                                 |
| `String(x)`                     | `number_to_string`                          | `format!("{x}")`         | `1e21`, and ties in the last digit                                |
| `x \| 0`, `x & m`               | `to_int32`                                  | `as i32`                 | wraps, does not saturate                                          |
| `n.toString(16)`                | `to_string_radix16`                         | `format!("{:x}")`        | integers past 64 bits                                             |
| a number in a model             | `JsNum(f64)`                                | an integer type          | the TypeScript holds NaN and fractions there                      |
| `/pattern/flags`                | `js_regex!(r"pattern", "flags")`            | the `regex` crate        | lookahead, backreferences, `\s` holds U+FEFF, `\d` is ASCII       |
| `new RegExp(text)`              | `JsRegex::new(text, flags)?`                | assuming it compiles     | a tag name like `w:(` throws                                      |
| `s.split(/re/)`                 | `JsRegex::split`                            | `str::split`             | empty matches, the trailing piece                                 |
| `s.trim()`                      | `trim`, `trim_start`                        | `str::trim`              | U+FEFF is white space, U+0085 is not                              |
| `if (s)`, `a \|\| b` on strings | `truthy(Option<&str>)`                      | `Option::is_some`        | `""` is false                                                     |
| `a ?? b`                        | `Option::or`, `unwrap_or`                   | `truthy`                 | `""` and `0` are kept                                             |
| `new Map()`                     | `JsMap<V>`                                  | `HashMap`, `BTreeMap`    | order of entries; a key set again keeps its place                 |
| `Record<string, V>`             | `JsObject<V>`                               | `BTreeMap`, a `Vec`      | integer keys first in numeric order, the rest as set: "2", "10"   |
| `{ a, b }`, always in one order | a struct with its fields in that order      | any other field order    | JSON.stringify writes the keys as the literal has them            |
| `o.k = v` on a path, a spread   | `js_object!` and the methods of `Slot`      | a plain struct           | a key set later comes later; `{...a, ...b}` keeps the order of a  |
| `delete o.k` on a JSON map      | `shift_remove`                              | `remove`, `swap_remove`  | those move the last key into the place of the one removed         |
| `ownValue(table, key)`          | a `match` on own keys                       |                          | `table["constructor"]` answers in JavaScript, `ownValue` does not |
| `setOwn(record, key, value)`    | an entry like any other, `"__proto__"` too  | skipping `"__proto__"`   | a plain `obj[key] = value` would set the prototype there          |
| `decodeURIComponent`            | `decode_uri_component`                      | a percent-decoding crate | malformed escapes throw                                           |
| `JSON.stringify`                | `serde` with `skip_serializing_if`, `JsNum` |                          | NaN is `null`, -0 is `0`, `undefined` is no key                   |

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

### Model comparison wire form

The model comparison sends UTF-8 JSON in request blob 0 and receives the
typed Rust model's JSON in reply blob 0. A JSON header would reprint the
model before comparison, concealing number printing and key order.

`Map<K, V>` crosses as `[[key, value], ...]`. This retains entries,
insertion order and the key's JavaScript type. `JSON.stringify` alone writes
a Map as `{}`. An object changes numeric keys into strings and reorders
integer-looking keys. Each pair costs an array and punctuation in JSON.

`Uint8Array` crosses as `{ "$bytes": "<padded standard base64>" }`.
This is smaller than a JSON object with a property per byte. The marker
distinguishes bytes from model records, but encoding still allocates and
copies. A 20 MiB picture has 20,971,520 binary bytes and becomes 27,962,028
ASCII base64 bytes plus 13 JSON bytes. Rust decodes a 20 MiB `Vec<u8>` and
encodes it again for the reply. The host copies the reply out of wasm
memory. JavaScript strings may use one or two bytes per character, so that
encoded string alone can occupy roughly 26.7 or 53.3 MiB. These are
representation sizes, not measured peak memory.

This is a gate format, not a product API decision. At the product boundary,
binary blobs with JSON references would avoid base64 expansion and repeated
encoding for media and `internal.originalBytes`. Keep Map entries unless a
replacement preserves key type, entries and order. The wire version must
identify whichever product representation is chosen.

The model reads `EffectivePPr`, `EffectiveRPr` and the types they name from
`resolve-props.ts` and types them like the rest; only fields declared
`unknown` are held as JSON values. Their key orders come from the parse
results and equal the field orders of the structs in `resolve.rs`.

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

The order of the keys of an object is part of every comparison of (a), (d),
(e) and (f): a result equal as JSON whose keys are in another order is a
difference, counted apart on its line (`key order only`) and listed per place
under the `key order:` line. `key-order.ts` parses the reply keeping the
order Rust wrote, which `JSON.parse` loses for integer keys.
`npm --prefix tools/docx-diff run gate -- --key-orders` also lists, per
place, the one order the TypeScript writes its keys in, or says that it has
none: then the order follows the path the code took, and the type is a
`js_object!`.

A lone surrogate in a TypeScript result shows as a difference: a Rust string
cannot hold one. None is left in what (f) compares since the TypeScript
turns a surrogate reference into U+FFFD and reads an astral LaTeX argument
whole. The two XML cases that remain are in `divergences.json`.

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

An entry pins one input. Where main decided that the Rust is right and the
TypeScript is to be fixed (a missing paragraph style, single-quoted revision
attributes), or where the answer is the host's (legacy charsets on Node),
corpus documents and mutations fall in the same class. A spec names the
class of an input with `CallSpec.listed` (the predicates are in
`tools/docx-diff/listed.ts`, each over the input alone). Such an input is
still called on both sides: equal, it is a check like any other; different,
it is counted on the line `(f) listed class <id>` and not as a difference.
**A second defect inside a listed input is invisible**: whatever else
differs in an input that differs under its class is not seen until the
TypeScript fix lands and the class goes. That is the price, so a class
stays narrow, the gate prints for each how many inputs were set aside and
how many of them differed, and it fails on a class without an entry and on
a class none of whose inputs differs any more. The classes are short-lived:
main fixes the TypeScript, the fix is merged here, the entry and its class
are deleted in that commit. The gate runs in UTC (`host.ts`); an entry with
`zone` runs its TypeScript side in that zone.

## Known debt

- `encoding_rs` ((Apache-2.0 OR MIT) AND BSD-3-Clause) decodes the legacy
  charsets of `alt_chunk.rs`. It has to appear in the third-party notices
  when the crates are wired into the product. `crates/deny.toml` holds the
  licences the workspace may depend on, and the runner checks it.
- `JsRegex::new` refuses a pattern under `i` without `u` that names a cased
  character outside ASCII. One site puts a caller's text into such a
  pattern: `xml_text::on_off_tag_in(xml, name)`, whose callers pass the
  constant `w:bidi`; a name like `w:é` is an `Err` there and an answer in
  TypeScript. `settings.rs` puts the document's namespace prefixes into one,
  and they are ASCII by the pattern that reads them (`[A-Za-z_][\w.-]*`).
- `Package` holds every entry inflated; JSZip inflates on read. Fine for the
  gate, to be revisited when a caller flips.
- The zip gate refuses every archive JSZip would read as ZIP64, so the ZIP64
  branch of `ooxml-pkg/src/jszip.rs` is no longer reached through
  `load_docx_package`. The gate compares nothing of it; its unit tests do.
- `docx-engine/src/styles/mod.rs` has a private `JsMap` from before
  `jscompat::JsMap` existed.
- `Slot` numbers the keys from one counter of the process, so two objects
  built at the same time never share a number; the counter is 64 bits wide.
  A `js_object!` costs eight bytes a key more than a plain struct.
- The key order of a JSON value an argument crosses the wire with is kept
  (`preserve_order`), so `resolveCharIndents` sees its `format` as the
  TypeScript does. A typed argument (`CharIndents`) is read with
  `deserialize;`, which sets the keys in the order of the input.
- `cargo-deny` is configured (`deny.toml`) but was not installed on the
  machine these crates were written on, so it has not run.
- Helpers written more than once, to move down: `Math.max`/`Math.min` with
  JavaScript's NaN and zero rules (`list_markers.rs`, `vml.rs`), text escapes
  (`eq_field.rs`, `blank.rs`, `omml/src/xml.rs`, and private in `ooxml-xml`),
  `String.prototype.slice` (`sdt.rs`, `eq_field.rs`, `field_balance.rs`), the
  array-index test (`jscompat::array_index`; `ooxml-pkg` and `ooxml-xml` have
  copies of their own), `atob` (`protection.rs`),
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

State on 2026-11-12, 14:45 KST. The branch is on origin and is pushed at
every unit boundary (never forced, never to main).

- `feat/rust-docx-u1`: everything below, on main at 5f03509fd (merged, not
  rebased). The gate is green on a runner (run 43158707050 on f6071c0f5):
  1,733,886 checks, 0 differences, 14 ledger entries, none stale, six listed
  classes (136 inputs set aside as differing), clippy, the tests and
  cargo-deny pass, wasm 2,483,425 bytes.
- Case folding under `i` without `u` was a defect of `jscompat` that 679
  checks over inputs with U+0131, U+017F and U+212A showed; stream D fixed it
  in `regex.rs` (two commits cherry-picked with `-x`), and those inputs stay
  in the gate.
- Other streams start from this branch on origin, on another machine, and
  merge it at unit boundaries: `feat/rust-docx-model` (B: the Word model
  types generated from `types.ts` into `docx-engine/src/model/`, then the
  save side, and the leaves over model types: `ink.ts`,
  `parse-block-passes.ts`, `lineBoxOf`, `vmlWordArtBox`, the read side of
  `chart.ts`), `feat/rust-pptx-u1` (C), `feat/rust-fileparse-u1` (D). They
  add to `ooxml-xml`, `ooxml-pkg`, `jscompat` and the harness behind new
  functions and options; the Word gate has to stay as it is. The model is
  not ported here a second time.
- `EffectivePPr`, `EffectiveRPr`, `ResolveCtx` and the direct and effective
  formats are in `docx-engine/src/resolve.rs` now: stream B can type them.
  Structs written here for want of the model, each under the doc line
  "model type, to be replaced by the generated model": `FieldDisplay`
  (`fields/display.rs`), `TextGlow` (`drawing_geometry/fill.rs`).

### What was done last

**Unit 2: the resolver and the leaves without model types.** About 3,200
TypeScript lines in 6,600 of Rust, eight groups of (f):

| group | TypeScript | functions | first comparison |
|---|---|---|---|
| `resolve` | `resolve-props.ts`, whole | 13 | 24,840 checks, 0 differences |
| `fielddisplay` | `fieldDisplayOf` of `parse-fields.ts` | 1 | 2,122, 0 |
| `drawing` | `parse-drawing-geometry.ts` without `lineBoxOf` | 11 | 6,987, 0 |
| `vml` | `parse-vml.ts` without `vmlWordArtBox` | 9 | 3,414, 0 |
| `revision` | `revision-xml.ts`, whole | 6 | 6,348, 0 |
| `altchunk` | `alt-chunk.ts` without the converter | 5 | 5,458, 12 |
| `checkbox` | `checkbox-control.ts`, whole | 5 | 2,907, 0 |
| `images` | the predicates of `tiff.ts` and `metafile.ts` | 4 | 1,505, 0 |

The first comparisons are runner artifacts (runs 43149479120 for `resolve`,
43151626477 for the rest), taken before anything was fixed; no porter
compared privately. The 12 differences were one class: `TextDecoder` is ICU
on Node and the Encoding Standard in Chromium and in `encoding_rs`.

A first run without a difference says little until faults are seeded. Of 29
faults in the resolver 22 were caught at once; four of the seven misses
named inputs that are now there (a `w:specVanish` that is present but off,
`shadowCompare` over inherited names, a negative half in
`effectiveLineFormat`, default styles of other kinds before the paragraph
default) and three cannot be seen by any input, because the TypeScript
readers never produce the value (`eaSlotEmpty: false`, an empty conditional
colour, a level with `hanging` 0). Of 43 faults in the leaves (the porters'
35 and eight of the integrator's, all eight caught) 34 were caught at once
(run 43153584303). Four of the nine misses named inputs that are now there
and are caught (run 43157250362): text outside ASCII before a rewritten
`w:delText`, a property change that is the first child of its holder, two
range starts sharing an id under a filter, a tab stop at a negative
position. Five are the same code for every value that can arrive: `open <=
close` in `top_level_drawings`, the zone of a date-only form, the order of
two alternative capture groups, `Math.max` over sizes (a NaN never reaches
the direct layer) and an empty font name (dropped by the resolver).

One of those inputs showed a TypeScript defect, the seventh below: rejecting
a `w:pPrChange` that stands right after the open tag of its `w:pPr` drops
the old properties instead of restoring them.

**Where the Rust is right and the TypeScript is to be fixed.** main decided
seven findings of this unit (items 11 to 16 and 24 of its TypeScript list). The Rust
falls back to the default paragraph style for the runs of a paragraph whose
style is missing, reads the wrap of the outer anchor only, reads revision
attributes in either quote, reads a `v:fill` opacity in percent, stays on
the Encoding Standard, reads a `w:date` without a zone as UTC, and restores
the old properties on that reject. Each is
an entry of `divergences.json` with its class (see "Divergences"). When
main's fix is merged the entry and its class go stale, and both go.

**The machine.** Nothing heavier than `cargo check -p` runs here any more
(see "Standing rules"); first comparisons and faults are runner jobs, and
`tools/docx-diff/faults.py` with the `faults` input of the workflow is the
tool for the latter. A dispatch right after a push can take the previous
head: read `headSha` of a run before using its result.

**Held locally until `jscompat` has them** (each marked `// to jscompat:`):
`encodeURIComponent` (`vml/shape.rs`), a port of V8's `Date.parse`
(`revision_xml.rs`, about 800 lines), and `utf16_shaped`
(`fields/display.rs`): a counted quantifier (`\S{1,15}`) counts an astral
character once in `regress` and twice in JavaScript without `/u`. That last
one is a property of every `js_regex!` with a counted quantifier or a `.`
over text outside the BMP and belongs with the case folding in `regex.rs`.


**Before unit 2**

**The Rust and the ledger in line with main.** main fixed the TypeScript
defects this port found, and this branch follows: table lookups answer for
own keys only (the Rust tables already did; `listed` is gone from the specs,
which build the inherited names as inputs instead), an unknown paper size
gives A4, a record keeps an entry named `__proto__`, a character outside the
BMP is one LaTeX argument, a surrogate character reference reads as U+FFFD.
`parseTagAttrs` of `parse-vml.ts` writes a record with `setOwn` too and is
not ported yet: keep the `__proto__` entry there.

**The ledger holds six entries.** DOCTYPE and the CDATA opener (what
fast-xml-parser reads and Rust refuses), the LaTeX depth limit, and three
that belong to the host: `zip-text-in-hosts-without-buffer`,
`inflate-failure-text-is-the-hosts`, and bytes after the end of a deflate
stream, which Chromium refuses and Node 22 reads past. There the Rust
follows the product's host, not the gate's, by the owner's decision, and
`tools/docx-diff/host.ts` gives the TypeScript side a `DecompressionStream`
that refuses them too, so that containers with such bytes (14 of 3,000
mutated ones had them) are compared like any other; the ledger entry runs
the TypeScript on Node as it is. Both go when main's zip gate answers alike
on every host. The gate runs on Node 22 only (`host.ts` stops on another
major): a fixture made on another one holds another host's answers.

**Key order is part of parity.** The measurement, before anything was
fixed, of 1,668,203 checks:

- As the wasm stood (`serde_json::Value` sorted every object by name on its
  way out): 96,794 checks, 41,404 distinct results in 210 places, differed
  by key order only.
- With `preserve_order` alone, which is the order the Rust was written in:
  7,235 checks, 6,699 distinct results in 26 places. No result differed in
  more than order.

Of the 26 places, by cause:

- A struct declared in another order than the TypeScript literal: section
  settings (2,566 results in four functions), theme fonts (331), the word
  art of a watermark (167), embedded fonts (123), the sides of a paragraph
  border (34), a ptab stop (11).
- An order that follows the path the TypeScript took: the document defaults
  (2,630: `sizeHalfPoints` and `eastAsiaFont` are each set at two places),
  numbering levels (293, and 67 from the list dialogs, which write another
  order), the float anchor (335) and the watermark shape that calls it
  (185), the display of a style (208: spreads over the parent), character
  indents merged (51) and resolved (44), table style formats (38), cell
  margins (8: `w:start` after `w:right`).
- A record keyed by data held in a sorted map: theme script fonts (87), the
  levels of a numbering definition (9).

What the corpus and the built inputs lacked, and now have: a numbering
definition with levels 10 and 2 (the `BTreeMap` case this task was written
for showed only through negative levels), levels spread from a linked
abstractNum, and a styles part that takes every spread, `Object.assign` and
`delete` of `parseStyles` (five of them were reached by no input).

How an order is written down is in "jscompat rules": a struct in the order
of the literal, `js_object!` where the order follows the path, `JsObject`
for a record keyed by data. No order is in the ledger.

### What to do, in order

1. **Take stream D's next commit to `regex.rs`** when main names it: a
   counted quantifier (`\S{1,15}`) counts an astral character once in
   `regress` and twice in JavaScript without `/u`. Remove `utf16_shaped` of
   `fields/display.rs` in the commit that takes it. One input still waits
   for a comparison that can see it: a part named `x.rel\u017f` for
   `ooxml-pkg/src/load.rs:104` (the package comparison reads no part by such
   a name, so today it would compare nothing).
2. **The package comparison reports the first differing path of a value
   only**, so `styles/headings.rs:31` and `styles/display.rs:350` were never
   shown apart from the heading difference beside them. Their inputs are in
   the package "…letters that fold to ASCII only in Unicode"; a fault in
   each would say whether they are compared.
3. **Merge main when it has fixed items 11 to 16 and 24**, drop the entries and
   classes that go stale, and take the model from stream B when it lands:
   the local structs go, and `lineBoxOf`, `vmlWordArtBox`, `ink.ts`,
   `parse-block-passes.ts` and the chart reader come with it.
   `lazy-media.ts` (55) is about when the host reads media: decide what of
   it the engine owns before porting it. The decoders of `tiff.ts` and
   `metafile.ts` stay with the host.
4. **The model**, `types.ts` (2,719 lines), is stream B's: Rust types that
   serialize to the same JSON, each a struct or a `js_object!` by the rule
   above. Fetch `origin/feat/rust-docx-model` and read it before wiring.
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
  (`apps/`, `packages/*/src`), no root `package.json`, no `AGENTS.md`. The
  workflow `.github/workflows/seuoffice-rust.yml` may be fixed on this
  branch, and main is told what changed. Push this branch and throwaway
  `rust-faults/*` branches only; never force, never main, no `git stash`, no
  rewriting history.
- English Conventional Commits, one change each, each building and passing
  its tests. Comments in English, no CJK ideographs (escape them in
  literals).
- The whole gate, clippy, the tests of the whole workspace and the wasm
  release build run on a GitHub runner, not on this machine, which is shared
  and slow (a suite waited ten times its run time in the queue here):
  `gh workflow run "seuoffice rust" --ref <branch>`, then
  `gh run watch <id> --exit-status` in the background. The job runs every
  check even after one failed and uploads `tools/docx-diff/out`, with the
  whole gate output in `gate.txt` (`gh run download <id> -n docx-diff-out`).
- Faults go to a runner too: a file of faults for `tools/docx-diff/faults.py`
  on a branch `rust-faults/<name>`, pushed, started with
  `gh workflow run "seuoffice rust" --ref rust-faults/<name> -f faults=<file>`
  and deleted afterwards by whoever made it. The result is the artifact
  `docx-diff-faults`. One ref runs one job at a time: a second start on the
  same branch cancels the first.
- Locally only `cargo check -p <crate>` and `cargo test -p <crate>` for the
  crate being ported, through `tools/docx-diff/heavy.sh <command>`, which
  hands the command to the machine's queue (`/tmp/heavy.sh`): one heavy
  command at a time, none between 03:30 and 05:00 KST, and a refusal (exit
  75) when three already wait. No clippy, no gate, no `calls --group` and no
  wasm build here. Never remove `/tmp/heavy.lock` by hand and never kill by
  name. `tsc`, eslint, prettier and a single `tsx` script need no lock, on
  Node 22. At most two subagents at a time on this machine, each by the
  same rules; more hands are asked of main, who opens streams elsewhere.
- The first comparison run of a newly ported module is saved untouched
  before anything is fixed: it is the measure of the port. It is a runner's
  run: the artifact, with its summary committed in the unit's report. A
  comparison a subagent made privately does not count; the gate does.
- An input of (f) holds no lone surrogate: JSON cannot carry one to Rust and
  the runner names the input that does. Say so in a brief that asks for
  inputs over UTF-16.
- Every case-insensitive or Unicode-sensitive primitive of `jscompat` (a
  pattern with `i`, a case mapping, a trim, a word boundary) gets inputs
  outside ASCII in each gate that uses it: U+0131, U+017F and U+212A fold to
  `i`, `s` and `k` under Unicode case folding and not under a JavaScript
  `/i` without `/u`. The corpus is ASCII in the places these patterns read,
  so only built inputs see it.
- A function counts as compared when it gave at least two distinct results
  and a seeded fault in it is caught. The one who integrates seeds a fault
  of their own per group, chosen without looking at the porter's list. A
  fault that passes names an input to add.
- Floors are committed with the unit: exact where they follow the corpus,
  rounded down where they follow a seeded generator.
- A difference is listed in `divergences.json` with both answers and the
  reason, and the gate checks it still reproduces. It is never coded around,
  in the Rust or in the harness. A TypeScript defect is reported to main at
  once with its input and ported as it is until main decides: where the
  TypeScript result is wrong by the format's rules or loses content a user
  can reach, main has the Rust right from the start, and the difference is
  an entry with its class. The DOCTYPE refusal is final.
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
