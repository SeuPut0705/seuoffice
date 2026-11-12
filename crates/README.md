# crates

The Rust document engines of SeuOffice, ported from `packages/docx-engine`
and `packages/pptx-engine` one module at a time. Nothing in the product calls
them yet. `tools/docx-diff` and `tools/pptx-diff` compare each ported module
against its TypeScript before a unit flips a caller.

A session that picks this work up starts at
[Next session starts here](#next-session-starts-here).

## Layout

| Crate                | What it holds                                                                                                                                                                                                                                                          | Ported from                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jscompat`           | JavaScript operations, bit for bit: `parseInt`, `Number`, `Math.round`, number printing, regular expressions, `Map`, `decodeURIComponent`                                                                                                                              | the language                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ooxml-xml`          | The tag scanner, the ordered parser and its serializer, `XNode` readers, UTF-16 offsets                                                                                                                                                                                | `scan.ts`, `xml-utils.ts`, fast-xml-parser                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ooxml-pkg`          | A docx as `loadDocxZip` opens it: the zip gate, the JSZip reader, Strict normalization, `Package`; the zip as JSZip writes it (`write`)                                                                                                                                | `zip-load.ts`, `packages/zip-gate`, JSZip 3.10.1, `ooxml-normalize.ts`                                                                                                                                                                                                                                                                                                                                                                        |
| `docx-engine`        | Body scan, property readers, relationships, content types, theme, font table, styles, numbering, comments, protection and its hash, document properties, sources, sections, watermarks, notes, fields, EQ fields, SDTs, list markers, symbol fonts, the blank document | `scan.ts`, `parse-props.ts`, `parse-xml-text.ts`, `parse-package.ts`, `theme.ts`, `font-table.ts`, `parse-styles.ts`, parts of `parse.ts`; the read side of `doc-properties.ts`, `zotero-doc-props.ts`, `sources.ts`, `protection.ts`, `section.ts`, `watermark.ts`, `notes.ts`; `parse-fields.ts` without what needs `resolve-props.ts`, `eq-field.ts`, `parse-sdt.ts`, `field-balance.ts`, `list-markers.ts`, `symbol-fonts.ts`, `blank.ts` |
| `pptx-engine`        | Slide scan, XML helpers, slide ids, named actions, table-grid accounting, CRC-32 and the package reader. [Survey, unit order and evidence](pptx-engine/README.md).                                                                                                     | `packages/pptx-engine/src/{scan,xml-utils,slide-ids,named-action,table-grid,crc32,zip}.ts`                                                                                                                                                                                                                                                                                                                                                    |
| `mtx`                | The MicroType Express font decoder of embedded fonts, a derived work of libeot and the one crate under MPL-2.0.                                                                                                                                                        | `packages/pptx-engine/src/vendor/mtx/{index,lzcomp,ctf}.ts`                                                                                                                                                                                                                                                                                                                                                                                   |
| `omml`               | Office Math: OMML to LaTeX and to MathML, LaTeX to OMML. Depends on no engine                                                                                                                                                                                          | `math.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `file-parse`         | Attachment readers: docx, pptx and xlsx as text, the Markdown and slide redactors, the zip text copy, a bounded compound file reader, relationship targets, attachable extensions, spreadsheet date formats                                                            | `packages/file-parse`: `docx.ts`, `pptx.ts`, `xlsx.ts`, `markdown-redaction.ts`, `pptx-redaction.ts`, `zip-text-parts.ts`, `opc.ts`, `attachable.ts`, `xlsx-dates.ts`; the reading of `cfb`                                                                                                                                                                                                                                                   |
| `epub-engine`        | The EPUB functions that take values and typed trees: paths, font obfuscation, SHA-1, entry encodings, replacement ranges, the vertical writing test, container, encryption, package, nav and NCX readers                                                               | `packages/epub-engine`: `paths.ts`, `fonts.ts`, `sha1.ts`, `encoding.ts`, `ranges.ts`, `writing-mode.ts`; the tree readers of `open.ts`, `package.ts` and `toc.ts`                                                                                                                                                                                                                                                                            |
| `office-wasm`        | The one entry point JavaScript calls, built for `wasm32-wasip1`                                                                                                                                                                                                        | new                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `spike-one-run-save` | An experiment, not part of the engine: see its README                                                                                                                                                                                                                  | new                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Both document crates are pure: bytes and values in, values out. No I/O,
clock or randomness. UUIDs come from the caller. Two modules of
`docx-engine` are not readers: `model/` holds the Word model of `types.ts`
(generated, see "The model"), and `generate/` the pure builders of
`generate.ts`, the save side, over that model.

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

Engines are ported in whole-engine batches (decision 0025, rule 5): every
module left in an engine is ported in one go, its gate cases written beside
it, and the gate runs once at the end of the batch, as the batch's first
comparison, then once on a runner. Runner jobs are started and not waited
for. Fault injection, tidying the ledger and the review run once, before
the batch is merged to main. A unit's gate is no longer run per module.

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

JavaScript without the `u` flag walks UTF-16 code units: a character outside
the BMP is two of them to `.`, a class, a count (`^\S{1,15}$`), `\B` and a
lookbehind. `JsRegex` searches a text that holds such a character as its
units, so a pattern is still copied as it is. Three things follow:

- A pattern without `u` that names a character outside the BMP does not build
  (`JsRegex::new` returns an error): JavaScript reads two units there.
- Where JavaScript matches half a pair, `replace_all` writes U+FFFD for a half
  left alone, as JavaScript does when it writes the string as UTF-8; a match,
  a capture or a piece of `split` that would begin or end inside a pair ends
  after the character instead.
- A call costs one pass over the bytes from where the search starts, unless
  the pattern cannot tell a pair from a character (no `.`, negated class,
  `\S`, `\W`, `\D`, `\B` or lookbehind, and every alternative begins with a
  character it must consume). Do not call `find_from(text, at).next()` once
  per match of a large text with any other pattern: use `find_iter`. Measured
  over 2 MB, 2,000 such calls took 0.5 s, and 31 s where the text held one
  character outside the BMP. `tests/sites.rs` fails on a new `find_from` call
  whose regex reads ahead (`JsRegex::reads_ahead`) or is not written at the
  call. When such a loop is truly needed, the fix is a handle that prepares
  the text once (its units and its shadow) and is searched many times; it is
  not built.

`jscompat/tests/astral.rs` holds Node 22's answers; `tests/sites.rs` reads
every `js_regex!`, `JsRegex::new`, `try_js_regex!` and `TryJsRegex::new` of
the workspace and fails on a pattern `JsRegex::new` refuses.

A search keeps at most `BACKTRACK_LIMIT` (2^22) entries on the backtrack
stack of the vendored `regress` (`crates/vendor/regress/VENDORED.md`); an
entry is 40 bytes on a 64-bit target, so one search holds 209 MB at most,
and up to twice the bound while a lookaround runs on its own stack (263 MB
measured), by `jscompat/tests/limit.rs`; on wasm32 an entry is 20 bytes, the
linear memory grew to about 135 MB, and a wasm memory never shrinks
(`limit_wasm.rs`). A loop whose body is more than
one character matcher keeps entries for each turn, so
`<\/?(?:[^<>"']|"[^"]*"|'[^']*')*>` answers over 1.39M characters and passes
the bound at 1.40M; V8 answers up to about 8M and throws `RangeError` past
it. A search past the bound stops with `RegexLimit`:

- A pattern with such a loop (its loops may turn more than 4,096 times
  together) is built as a `TryJsRegex` (`try_js_regex!`), which has only
  `try_*` methods. The caller turns `RegexLimit` into the error the reader
  already gives for a file it cannot read, never into a default answer.
- Every other pattern is a `JsRegex`, whose methods panic on `RegexLimit`.
  `tests/sites.rs` fails on a `JsRegex` with such a loop, and on one whose
  pattern it cannot read, so that panic is not reached. It reads a literal
  of the call, a `const` of the file, and a macro that writes its pattern as
  `concat!` of literals and one literal parameter, at each use of the macro.
  A `format!` template is not read: what goes into it can come from the
  document (`settings.rs` puts an `r:embed` there), so a pattern built at run
  time is a `TryJsRegex`, and a function that builds one returns
  `RegexError`, the `SyntaxError` of the constructor or the limit.
- `jscompat/examples/limit_wasm.rs` runs the same pattern over 25M characters
  on wasm32 in CI: it refuses where 0.12.0 trapped at 22.4M.

Under `i` without `u` JavaScript never matches a character outside ASCII as an
ASCII letter; `regress` does for U+0131 (`i`), U+017F (`s`) and U+212A (`k` in
a class, and `\w`). `JsRegex` searches a copy of the text without those three,
so a pattern that names only ASCII is copied as it is. A pattern that names a
cased character outside ASCII under `i` without `u` does not build
(`/\u0131/i` matches `I` in `regress`): `JsRegex::new` returns an error, and
`jscompat/tests/icase.rs` reads every site of the workspace so that no literal
one reaches that error at run time. Its 161 expected answers are Node 22's.

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

## The model

`docx-engine/src/model/generated.rs` is written by
`tools/docx-diff/model-gen.ts` from the declarations of
`packages/docx-engine/src/types.ts` (and those of `resolve-props.ts` it
imports), read with the TypeScript compiler: 293 types, 158 of them objects.
The declarations are read from main at the commit `MODEL_SOURCE` pins in
`model-schema.ts` (`ca8f1414b`), because the model is what ships; this
branch's parser and save side are older until main is merged.
Do not edit it; `npm --prefix tools/docx-diff run model-gen` writes it and
`-- --check` (part of `typecheck` and of `gate`) fails when it is stale for
that commit.

- **Key order.** `tools/docx-diff/model-orders.json` commits, per object
  type, the order its keys are written in. A fixed order is a struct that
  declares and writes its fields in that order. A type marked `"input"`
  (Run, ParaFormat, HfParagraph, HfTextBox, HfImage, CellBorders,
  CellMargins, TableCell, TextboxDisplay, Block, StyleDisplay,
  TableStyleDisplay, DocDefaults, ChartDisplay, NoteProps) follows the path
  the TypeScript took (NoteProps by a built input of `parseNoteProps`, whose
  `{ ...base, ...own }` writes the settings' keys first): it
  is a `js_object!`, every field a `Slot` (HfParagraph, composed over
  ParaFormat, is a struct of slots ordered across both), and reading it sets
  the slots in the order of the input. `model-gen.ts --observe-orders
  FILE.ndjson` derives the table from captured parse results. **Only parse
  results vote**: values built from the schema set their keys in whatever
  order the builder chose, and 32 types were once marked `"input"` by them
  alone. 82 orders are fixed by evidence, 62 are the declaration order of a
  type no parse result holds with two keys in question. Fixed by evidence
  means no parse result contradicts it: the four documents of
  `model-bodies.ts`, built to reach producers the corpus does not, corrected
  17 such orders and 5 declaration orders and made 7 types path-ordered.
  `model-producers.ts` reads the producers in the TypeScript source for the
  orders no document shows, and exits 1 on a producer that contradicts a
  committed fixed order. It follows a spread of a call into the function's
  returned literals, keeps the branches of a conditional apart, and counts
  `x[k] = v` with `k` from the data (`axesOf` of a chart) as writing those
  keys in either order.
- **Strict reading.** An unknown key, a key twice, a missing required key,
  null where the type has none, a value of another JSON kind, a string no
  enum holds, an enum written as an object, a `Record<number>` key that is
  no number and base64 with padding bits set are refused; `model-invalid.ts`
  builds one value per case from the schema (13,976) and comparison (h)
  demands a refusal for each. `model/mod.rs` lists the three limits that
  remain.
- **Evidence per field.** `model-field-floors.json` holds, for each of the
  1,680 fields, how many values the parse results held and how many the
  schema-built values did, apart: in the capture `model-gen.ts
  --observe-orders` read last, 983 fields are seen in parse results and 697
  only in built values. The 24 fields of main that this branch's parser does
  not write (`Run.wrap` and the 5 of `InlineWrap` among them) are among the
  697. A built value proves that the Rust reads and
  writes what the schema says, not that the parser ever produces it.
  `model-full.ts --write-field-floors` rewrites the file from the gate's own
  run.
- **A reader that is wired** takes the model type as its return type and its
  local struct goes in the same unit (`FieldDisplay`, `TextGlow`, and every
  reader-local struct of the same shape as a model type).

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
| (h) | the typed model: what `parseDocx` returns, written as JSON, read as the Rust model and written again, byte for byte; values the model must refuse                          | `compare-model.ts`, `model-run.ts`                        |

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

A function whose input is a model value and no text sets `argMutation` in
its spec: the runner then mutates its arguments too
(`calls-arg-mutation.ts`), exchanging values, keys and array elements among
what the corpus and the built inputs showed under the same key, so a
mutated value has the types of the seeds in a combination none had. A
mutation the typed reader of the Rust side refuses is counted and compares
nothing. A spec takes the model of a corpus document through `fromModel`.

The functions parse.ts does not export are compared the same way, as group
`parse` (`calls-parse.ts`, `crates/docx-engine/src/parse/`).
`parse-internals.ts` writes a copy of parse.ts to `out/parse-internals.ts`,
which adds two things to every top-level function: an `export`, and a first
statement that reports the function's arguments to a hook. A spec's
`fromParse` names the function and turns the arguments of one of its calls
into an input at the moment of the call, so the corpus inputs are exactly
what `parseDocx` passes, through the copy, over each document. On the first
40 corpus documents the copy returned the same model as the module.
`parse-graph.ts` prints the functions of parse.ts in leaf-first waves (154
functions, 16 waves) and marks those a `/// \`name\`` comment in `crates/`
has ported.

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
TypeScript is to be fixed (a custom geometry guide named after an
Object.prototype member), corpus documents and mutations fall in the same class. A spec names the
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

## The other gates: tools/fileparse-diff and tools/epub-diff

`file-parse` and `epub-engine` have a gate each, built on one runner
(`tools/fileparse-diff/runner.ts`) that imports the engine, the comparison and
the key-order check of `tools/docx-diff`. Nothing in the product calls either
crate.

```
npm --prefix tools/fileparse-diff run gate      # build the wasm, compare, exit 1 on any failure
npm --prefix tools/fileparse-diff run compare -- --group xlsx --save out/x.json
npm --prefix tools/fileparse-diff run faults    # every fault of faults.json, in a scratch copy of crates/
npm --prefix tools/epub-diff run gate
npm --prefix tools/epub-diff run faults
```

A function is one `Spec` in a `*-cases.ts` file: the TypeScript reference, the
inputs built for it, and how its inputs are mutated. The runner compares three
populations per function, each with a floor in `floors.json`:

- **corpus**: every tracked file with one of the spec's extensions.
- **built**: the inputs the spec builds, hostile ones included.
- **mutated**: 100 seeded mutants of the corpus and built inputs, one seed per
  function. An input the ledger lists seeds none.

It fails on a difference that is not listed, a key order that differs, a
missing or unknown floor, a function with fewer than two distinct TypeScript
results, a ledger entry that no longer reproduces, and any input where a
reader did not answer (a trap, a host error, a child that died or timed out).
An error is compared as its name and message; the message is compared up to
`cannot be inflated:`, as in `tools/docx-diff`.

What is particular to these gates:

- **Every reader of bytes goes through the zip gate before it opens the
  archive** (`ooxml_pkg::load_zip_package`, or `assert_zip_inflates_within_limits`
  for the copy). The TypeScript `readZipTextParts` has no gate, so it is
  compared twice: the bare export over built inputs, each difference listed,
  and the TypeScript gate followed by the copy (`gatedReadZipTextParts`) over
  corpus, built and mutated inputs, with no difference.
- **A compound file is read with bounds.** `file_parse::compound` follows what
  `cfb` reads, and refuses a FAT, MiniFAT or DIFAT chain that returns to a
  sector, links that do not end, and streams that hold more than the file.
  Every compound input, and every hostile zip, runs in a child process with a
  30 second limit: `cfb` never returns from some cycles. The cycles `cfb`
  never leaves are built only by the tests of `compound.rs` and never reach
  `CFB.read`.
- **`faults.json`** names one replacement in one source file per fault. The
  fault runner applies each in a copy of `crates/` under `out/`, rebuilds, and
  runs the fault's group: DETECTED when the gate fails with a difference or a
  stale ledger entry, otherwise MISSED, INVALID, CRASHED or TIMEOUT. A source
  line that `cargo fmt` rewraps makes its fault INVALID, so check the file
  after formatting.
- **First runs** are kept in `evidence/`, untouched; those above 200 KB are
  gzip-compressed. `decisions.tsv` is the trail.
- **CSV decoding** (`file_parse::csv`, `decodeCsvBuffer` of xlsx-gateway)
  decodes with `encoding_rs`, the WHATWG Encoding Standard, as the
  TypeScript does through `@exodus/bytes` since main's cb4a067b5. Before
  that it decoded with Node's `TextDecoder`, which differs from the standard
  for `euc-kr` (KS X 1001, not windows-949), `big5` (no HKSCS), `shift_jis`
  (0x1A, 0x1C, 0x7F moved, 0x80 rejected) and `x-user-defined` (unknown):
  49 inputs of the gate showed it, and went from the ledger with the fix. The
  TypeScript function is async; the Rust one decodes in place.

Left to the host (`crates/seu-host`). In stage 1 the engines run as wasm
inside the React screens (decision 0026), where pdfjs, parse5 and the
TypeScript engines not ported yet already run. A step the engine cannot take
itself is the import `seu_host.host_call(name, input)`, with JSON in and out.
Each step is one call at the place where the TypeScript calls the library, and
the host answers what the TypeScript computes there. The gates supply the
steps in `tools/fileparse-diff/host-steps*.ts`, and each gate case sends the
same inputs through both sides. A host step that copies TypeScript code (the
`sourceElements` walk of html-redaction) is checked against the original by
its gate, which fails once the original changes. The steps:

- `fileparse.htmlSourceElements`: parse5's elements with source locations, for
  `redactHtmlSource` (`file_parse::html`).
- `fileparse.diagramFormatOf`, `fileparse.readDiagramText`: the draw.io reader
  (drawio-model), for `parseFileToText`.
- PDF (pdfjs), mind maps (xmind-engine) and OpenDocument text (odt-engine)
  await in the TypeScript, which an import of the wasm cannot. The host runs
  the reader the extension names before `parseFileToText` and passes what it
  read (`hosted`); every check the TypeScript makes before that reader is made
  in Rust first, in the same order.
- epub-engine: the three parse5 calls: `epub.parseHtml` (`parseHtml`),
  `epub.parseFragmentText` (the lookup of `resolveHtmlEntity`, whose cache and
  decision stay in Rust) and `epub.chapterTextRoots` (the HTML fallback of
  `extractChapterText`). `tools/fileparse-diff/host-steps-epub.ts` has them;
  the two that copy TypeScript are checked against its source text by
  `tools/epub-diff/xml-cases.ts`.

A native build has no host: those steps answer `HostUnavailable`.

All of file-parse and epub-engine is ported (batch D1), with these
exceptions. pdf, xmind, odt and draw.io go through the host as above. The
job functions of epub translation hand over to pdf-structure's job engine,
which is not ported. `hwp` compiles rhwp v0.9.0 with the 32 patches of
`vendor/rhwp-core`, from the tree `node tools/build-rhwp-core.mjs
--source-only` prepares in `crates/.rhwp-source` (gitignored, outside the
workspace). Cargo reads that path dependency on every call, so the tree must
exist before any cargo command; CI prepares it first in every job.

### Notes for the odt port (stream C)

- **Entry points** (`packages/odt-engine/src/index.ts`): `odtToText` (the text
  file-parse attaches; `packages/file-parse/src/odt.ts` wraps it and maps
  `OdtNotTextError`/`isOdtOpenError` in `parse.ts`), `odtToDocx` (the bridge
  docx, the `BridgeMap` and the conversion report), `saveOdt` (narrow patches
  back into the received ODT; untouched parts keep their bytes, no edit gives
  the original bytes), `docxToOdt`, `protectedCellsOf`, `parseKeepName`. The
  errors are `OdtOpenError` with an `OdtOpenErrorCode`, `OdtEncryptedError`
  and `OdtNotTextError`.
- **Corpus**: no `.odt` is tracked. The package's own tests build ODTs in
  `tests/helpers/*-fixtures.ts`, and `tests/assemble-corpus.test.ts` reads a
  folder named by `ODT_CORPUS`. A gate needs built ODTs from those helpers,
  mutated content.xml/styles.xml through the `zip-xml` mutation of
  `tools/fileparse-diff/runner.ts`, and container mutations.
- **What to compare**: `odtToText` as a string. `odtToDocx` as the bridge
  docx's parts (unzip both and compare part names, then each XML part as text
  and the rest as bytes; JSZip writes entries in order) plus the BridgeMap
  and the report as JSON, with their key order. `saveOdt` as bytes when there
  is no edit (it must give back the original) and as parts otherwise. The odt
  engine reads XML with saxes, which `crates/saxes` is.
- **Shared with docx**: `odtToDocx` writes through the docx engine, so the
  comparison follows stream B's docx-diff conventions for generated parts
  (`tools/docx-diff/package-zips.ts`).

Open on these crates:

- The record of withheld cells in an xlsx is JSON. `serde_json` refuses three
  things `JSON.parse` reads (a number past the range of a double, a lone
  surrogate escape, nesting past 128 levels); Rust then refuses the workbook
  where the TypeScript withholds and answers. Listed; a JSON reader that
  follows `JSON.parse` would close it.
- The compound reader is compared with `cfb` read directly. The TypeScript now
  has a gate of its own (`@seuoffice/compound-file`, `assertCompoundFile`):
  the refusals of `compound.rs` should be compared with it.
- `xlsx.rs` holds a copy of the fast-xml-parser dialect of `pptx.rs` (`mod
fxp`); the two should share one module.
- `office-wasm` maps an error to its JavaScript name by the start of its
  message (`file_parse.rs`). A typed error from the readers would replace it.

## Known debt

- `encoding_rs` ((Apache-2.0 OR MIT) AND BSD-3-Clause) decodes the legacy
  charsets of `alt_chunk.rs`. It has to appear in the third-party notices
  when the crates are wired into the product. `crates/deny.toml` holds the
  licences the workspace may depend on, and the runner checks it.
- `crates/mtx` (MPL-2.0) is a derived work of libeot (Brennan T. Vincent),
  after Monotype's MTX reference code, as `packages/pptx-engine/src/vendor/mtx`
  is. The repository's notices do not name libeot today, for the TypeScript
  either: the third-party notices of a release have to name it, with the MPL's
  pointer to the source of the covered files, before or when the crate is
  wired into the product.
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
- `crates/vendor/regress` is a patched copy of a third-party crate
  (MIT OR Apache-2.0). Its licence files are in the directory; a shipped
  build needs it in the third-party notices like any other dependency, and
  the notices are not written yet.
- Third-party code ported into the crates, each needing its notice in a
  shipped build: saxes 6.0.0 (ISC, `crates/saxes`), ppt-to-text 1.0.1 and
  cfb 1.2.2 (Apache-2.0, `file-parse` `ppt` and `compound`), word-extractor
  (MIT, `file-parse` `doc`).
- parse5 port needed when the central process becomes Rust (stage 2), unless
  that process keeps a JS host for it. Until then html-redaction and the
  three parse5 calls of epub-engine are host steps, and a native build
  answers `HostUnavailable` there.
- `cargo-deny` runs on the runner against `deny.toml` (licences only); it
  is not installed on the machine these crates were written on.
  Run by hand with 0.20.2 on the commit that vendored `regress`:
  advisories, bans, licences and sources ok.
- Helpers written more than once, to move down: `Math.max`/`Math.min` with
  JavaScript's NaN and zero rules (`list_markers.rs`, `vml.rs`), text escapes
  (`eq_field.rs`, `blank.rs`, `omml/src/xml.rs`, and private in `ooxml-xml`),
  `String.prototype.slice` (`sdt.rs`, `eq_field.rs`, `field_balance.rs`), the
  array-index test (`jscompat::array_index`; `ooxml-pkg` and `ooxml-xml` have
  copies of their own), `atob` (`protection.rs`),
  the `Date` readers (`ooxml-pkg/src/write.rs`, `blank.rs`), the new document
  properties (`blank.rs`; `doc_properties.rs` holds the read side only).
- `applyTocEntryNumbers` of `parse-fields.ts` works on the block model and
  waits for `parse.ts`.
- A listed class is counted by its id over every spec that names it, and
  the gate fails when no input of the id differs. A spec whose inputs of the
  class never differ is not told apart, so a class can stay on a function
  that has no such defect. `legacyCharsetOfMht` is wider than its defect by
  design; the others read the input as their function does.
- `tools/docx-diff/out/` is ignored by git. What must outlive a machine and
  the retention of GitHub artifacts is in `crates/docs/trail/`: the decision
  trail of unit 2, its first comparisons and its fault results, unedited,
  with their checksums. A unit adds its own there.
- `parseNotesXml` is ported without its paragraph reader callback, which
  `parse.ts` supplies.
- `blank/locale.rs` answers `paperSizeForLocale` from a table of likely
  subtags taken from one ICU (`tools/docx-diff/blank-locale-table.mjs` says
  which and regenerates it). The TypeScript asks the host's `Intl.Locale`, so
  another ICU can answer differently for rare tags.
- `generateIndexFieldXml(terms, locale = 'zh-CN')` sorts as
  `a.localeCompare(b, locale)`, which asks the host's ICU. The wasm build
  asks the host too: `office-wasm` imports
  `seu_host.host_collate(a_ptr, a_len, b_ptr, b_len, locale_ptr, locale_len) -> i32`,
  three UTF-8 strings of its memory, answered by an `Intl.Collator(locale)`
  of the host (`tools/docx-diff/engine.ts`), or `i32::MIN` where Intl
  refuses the locale (the call then throws, as `localeCompare` does once two
  terms compare). A host that instantiates the wasm must supply it.
  A native build sorts with ICU4X instead (feature
  `icu-collation` of `docx-engine`, CLDR 49 where Node 22 has CLDR 48), so
  a native and a wasm sort can differ where the two CLDRs do. Each member
  names the feature: the workspace dependency has it off, and `office-wasm`
  turns it on for native targets only. A native build without it does not
  compile.
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

State on 2026-11-12. The docx work is on `feat/rust-docx-model` from here
on: the stream that wrote `feat/rust-docx-u1` handed over at bebd7550f,
which is merged here (merged, never rebased). The branch is on origin and is
pushed at every unit boundary (never forced, never to main).

- What is on it: everything of `feat/rust-docx-u1` up to its last head
  bebd7550f (the gate was green there on a runner, run 43163832961:
  1,734,153 checks, 0 differences, 14 ledger entries in six classes; its
  decision trail and first comparisons are in `crates/docs/trail/`), the
  model, the builders of `generate.ts`, and
  stream D's fix of counted quantifiers over text outside the BMP. The
  runner result for this head is in the unit report to main.
- main is ahead (e743228a9 when this was written). Do not merge it until
  main says its TypeScript fixes are in: the six listed classes go in that
  merge.
- Other streams, on other machines: `feat/rust-pptx-u1` (C),
  `feat/rust-fileparse-u1` (D). They add to `ooxml-xml`, `ooxml-pkg`,
  `jscompat` and the harness behind new functions and options; the Word gate
  has to stay as it is. A commit of theirs is taken with `cherry-pick -x`.
- `jscompat/tests/sites.rs` reads the pattern of every `js_regex!` and
  `JsRegex::new` of the workspace and fails on a call whose pattern or flags
  it cannot read: write the literal (or the `format!`) inside the call. A
  pattern without `u` that can tell a surrogate pair from a character (`.`,
  a negated class, `\S`, `\W`, `\D`, `\B`, lookbehind) costs a scan of the
  rest of the text per call on a text holding an astral character: keep new
  code to single passes, no restart loop over `find_from`.
- Structs written for want of the model, each under the doc line "model
  type, to be replaced by the generated model": `FieldDisplay`
  (`fields/display.rs`), `TextGlow` (`drawing_geometry/fill.rs`). The model
  has both now.

### What was done last

**Unit 3: the model and the builders of `generate.ts`** (stream B, on
`feat/rust-docx-model`, which carries the trunk from here on).

The model (comparison (h)): the first round trip of 9,834 checks had 2,940
equal (29.9%); 5,579 of the 6,894 differences were key order alone, the rest
numbers (`null` for NaN refused, `.0` on integers past 2^53, exponent
spelling). It is at 0 differences over 183 corpus documents, 220 built
documents, 40 results captured from engine tests, 5,081 schema-built values,
13,835 values to refuse and 4,757 blocks compared one by one (the block
checks repeat what the document checks hold). Ten faults (eight by an author
who saw no input, two of the porter's): eight showed at once; an integer
past 2^53 and swapped base64 padding masks named values that are now there.
A fault a round trip cannot see by construction: an enum variant that names
the wrong string on the way in and on the way out alike. The generator
writes both from one string, and a consumer shows it (a swapped
`RevisionXmlMode` would change the builders).

The builders, nine groups of (f), 43 functions (every export of
`generate.ts` that is a function):

| group | functions | first comparison |
|---|---|---|
| `genRpr` | `mergeRPrModel` | 17,144 checks, 0 differences |
| `genProps` | 11 (pPr merges, paragraph mark, pPrChange, `splitXmlChildren`) | 48,959, 0 |
| `genDrawing` | 12 picture and shape patches | 7,791, 297 |
| `genDrawingBuild` | 6 builders and `LINE_KINDS` | 600, 0 |
| `genText` | 5 (`xmlSegments`, field, formula, cell and text box patches) | 5,383, 0 |
| `genTable` | `generateTableModelXml`, `generateTableXml` | 1,318, 0 |
| `genFields` | TOC, caption, index | 1,447, 0 |
| `genRuns` | `inlineRunsXml` | 4,955, 0 |
| `genParagraph` | `generateParagraphXml` | 5,959, 0 |

Those first runs were local, on Node 22, before anything was fixed, and are
in `crates/fixtures/generate-first/`; the porting agents compared nothing
before them. All 297 differences are one class: a NaN or an infinity among
the arguments, which the TypeScript then wrote into an integer attribute.
Main has since fixed that in `xml-number.ts` (`xmlInt` rounds to a safe
integer, `xmlId` takes a safe integer only, `xmlDecimal` a finite number
without an exponent, `nonFinite` throws `RangeError("a non-finite number:
<option>")`), and the Rust follows it in one place,
`crates/docx-engine/src/xml_number.rs` (`xml_int`, `xml_id`, `xml_decimal`,
`non_finite`): a patch keeps what the XML held, a builder refuses the call.
Nothing is set aside or masked for it any more.

27 faults, each switched on alone in one build: 20 showed at once. Five of
the seven misses named inputs that are now there (an `rFonts` with
`eastAsiaTheme` beside a literal face, an empty `w:left` beside `w:start`,
revisions that differ in their move name only, a fractional rotation, a
field title of exactly 15 units). Two change nothing a caller can observe:
every pPr child the builder pushes is in `PPR_CHILD_ORDER`, and the table
path never resolves a `w:tblGridChange`. The switch was an environment
variable read by the wasm (`fault(n)` in `jscompat`, the host passing
`SEU_FAULT`), never committed: one build for all faults, one comparison per
fault. The first loop of it passed no variable and reported 27 misses; a
positive control (a fault known to show) is now the first run of such a
loop.

Not verified, and not ported:

- The order of 61 object types and 729 fields rests on schema-built values
  alone.
- A model number that is NaN on the save side: a number crosses the wire as
  `null`, which the TypeScript side reads as `null` and the Rust as NaN, so
  no spec sends one outside the drawing functions, where numbers cross as
  text.
- The native build's `generateIndexFieldXml` sorts with ICU4X
  (`icu_collator` 2.4, CLDR 49) where Node 22.23.5 has ICU 78 (CLDR 48):
  equal over the corpus lists, 33 built ones (13 of them Korean and
  Japanese: syllables against jamo, hiragana against katakana, half-width
  kana, voiced marks combined and precomposed, kana against kanji,
  Japanese-only kanji) and 4,500 mutated ones; evidence, not proof. The
  wasm asks the host's collator and carries no collation data.
- The generated model is 1.49 MB of the wasm's code section (3.84 MB,
  unstripped build of 115028dce). No action taken.
- `floatTableColumnSpan` reads a missing `w:horzAnchor` of `w:tblpPr` as
  page-relative, as the TypeScript does. The schema
  (`ISO-IEC29500-4_2016/wml.xsd`, `CT_TblPPr`) declares the attribute
  without a default, so that reading is not verified by the schema.
- The `fix/inline-wrappers` changes of `generate.ts` (`Run.wrap` on the save
  side) are not on this branch's TypeScript; the model has the field.
- `generateParagraphXml` without a bookmark id allocator reads a counter of
  the process: the inputs always pass one.
- `generate/table.rs` holds a private copy of `resolvePropChangeXml` written
  before the trunk's `revision_xml.rs` was merged, and the builders hold
  private `Math.max`, number formatting and truthiness helpers: both are to
  move to the one implementation.
- `patch.ts` is not started.

**Unit 2: the resolver and the leaves without model types.** About 3,200
TypeScript lines in 6,600 of Rust, eight groups of (f):

| group          | TypeScript                                      | functions | first comparison             |
| -------------- | ----------------------------------------------- | --------- | ---------------------------- |
| `resolve`      | `resolve-props.ts`, whole                       | 13        | 24,840 checks, 0 differences |
| `fielddisplay` | `fieldDisplayOf` of `parse-fields.ts`           | 1         | 2,122, 0                     |
| `drawing`      | `parse-drawing-geometry.ts` without `lineBoxOf` | 11        | 6,987, 0                     |
| `vml`          | `parse-vml.ts` without `vmlWordArtBox`          | 9         | 3,414, 0                     |
| `revision`     | `revision-xml.ts`, whole                        | 6         | 6,348, 0                     |
| `altchunk`     | `alt-chunk.ts` without the converter            | 5         | 5,458, 12                    |
| `checkbox`     | `checkbox-control.ts`, whole                    | 5         | 2,907, 0                     |
| `images`       | the predicates of `tiff.ts` and `metafile.ts`   | 4         | 1,505, 0                     |

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
35 and eight of the integrator's, all eight caught) 33 were caught at once
(run 43153584303) and one was only set aside: the fault that drops the 4096
byte cap of `decodeHtmlBytes` moved its inputs into the legacy charset
class, whose predicate was wider than the function reads, and the first
verdict of `faults.py` took any changed line for a catch. Both are narrowed
since (a report that changed in nothing but counts and class lines is SET
ASIDE, a miss), and the 22 faults of the groups with classes were run again
by that rule (run 43161902762): 18 caught, two equivalent, and two that the
classes cost. `tblGrid exclusion dropped` had only ever been caught by one
mutated text; it has built inputs of its own now (a grid change whose old
grid is empty, in tables without another change). `edits sort drops end
tiebreak` is NOT compared: the one input that showed it is the paragraph
change that opens its `w:pPr`, which the Rust now answers with a single edit
and which sits in a class. Look there first: a zero-length insertion at the
start of a `w:pPr` can also meet the removal of a paragraph-mark `w:rPr` that
stands first (`<w:pPr><w:rPr><w:ins/></w:rPr><w:pPrChange>`), which was not
measured and may lose the old properties in the TypeScript the same way.
Four of the nine first misses named inputs that are now there
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
the old properties on that reject. Each is an entry of `divergences.json`;
all but the date without a zone, which one pinned entry covers, have a
class (see "Divergences"). When main's fix is merged the entry and its class
go stale, and both go.

**The machine.** Nothing heavier than `cargo check -p` runs here any more
(see "Standing rules"); first comparisons and faults are runner jobs, and
`tools/docx-diff/faults.py` with the `faults` input of the workflow is the
tool for the latter. A dispatch right after a push can take the previous
head: read `headSha` of a run before using its result.

**Held locally until `jscompat` has them** (each marked `// to jscompat:`):
`encodeURIComponent` (`vml/shape.rs`) and a port of V8's `Date.parse`
(`revision_xml.rs`, about 800 lines). `utf16_shaped` is gone: stream D made
a regex without `u` read a text outside the BMP by UTF-16 units (see
"jscompat rules").

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

1. **The debt of the builders** listed under unit 3: one `resolvePropChangeXml`
   (`revision_xml.rs`), the helpers into `jscompat`, and the civil date of
   `chart.rs` (`Date.UTC`, `getUTC*`) into `jscompat`.
2. **Done: the package comparison reports every differing path of a value.**
   The report line keeps the first path with both values and adds the count
   and the first `--show N` paths; `out/package-paths.json` holds every
   differing value with all its paths. `package-only.ts` runs (e) over the
   built containers alone (`--only TEXT`, `SEUOFFICE_WASM` for a wasm built
   elsewhere). Faults, each alone in a HEAD copy (`"i"` to `"iu"`), against
   0 differences unfaulted: `styles/headings.rs:31` shows at
   `headingStyles/value/listParagraphStyleId`, `styles/display.rs:350` at
   three `display` paths of `styles`, and `ooxml-pkg/src/load.rs:105` at the
   length and hash of `word/x.rel\u017f`, the part of "a Strict package"
   that stays Strict because `/i` without `/u` does not fold U+017F to `s`.
3. **Merge main when main says so** (items 11 to 16 and 24 of its list are
   fixed there), and drop the entries and classes that go stale.
   `lazy-media.ts` (55) is about when the host reads media: decide what of
   it the engine owns before porting it. The decoders of `tiff.ts` and
   `metafile.ts` stay with the host.
4. **`parse.ts`** (9,171 lines, 152 functions, 12 exports), leaf first, with
   the model as its types. Its functions are not exported, so (f) cannot
   call them. Compare `parseDocx` as a whole: comparison (h) already holds
   the model of every corpus document as JSON, block by block, with a count
   per block type and per field, so a partial port shows what is equal
   already. Port by pass: runs, paragraphs, tables, drawings and text boxes,
   the block passes. Then finish `parseNotesXml`'s paragraph reader and
   `applyTocEntryNumbers`, which need it.
5. The rest of the save side (`patch.ts`, `text-patch.ts`,
   `style-upsert.ts`, `remove-parts.ts`, `zip-splice.ts`,
   `resource-cleanup.ts`, the writers left out of the modules above) and
   the features on top (`compare.ts`, `mail-merge.ts`).

One finding is not a port matter and is with main: a run-level content
control is dropped when its paragraph is saved as a generated block
(`spike-one-run-save/README.md`). A faithful port reproduces it.

### Batches (decision 0025 rule 5, from 2026-11-12)

The owner wants the engine done, not checked unit by unit. The docx port
runs in four whole-engine batches, each checked once:

1. **B1**: the merge of main c673f0f71, finished as it stands.
2. **B2**: the whole read side, everything `parseDocx` needs (`parse.ts`
   and every `parse-*` module and helper not yet ported). Porters work in
   parallel on independent files. No comparison runs until the batch
   compiles end to end; then ONE first comparison, stored unedited, then
   the fixes, then one runner gate.
3. **B3**: the whole write side, everything `saveDocx` needs (`patch.ts`,
   the rest of `generate.ts`, `compare.ts`, `mail-merge.ts`, the part
   writers), the same way.
4. **B4**: the switch. The app's docx-engine calls go to the Rust engine
   through the wasm binding and the TypeScript modules are deleted. It is
   the merge to main.

Fault injection, the ledger tidy and the independent review happen once,
before B4. The final gate before main keeps every comparison, the faults,
the existing tests and the review. A runner job is started and the next
batch begins without waiting for it; its result is read when it arrives.
The rules below hold within a batch; where they speak of a unit, read
batch.

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
  command at a time, none between 03:30 and 05:00 KST, and a refusal (exit 75) when three already wait. No clippy, no gate, no `calls --group` and no
  wasm build here. Never remove `/tmp/heavy.lock` by hand and never kill by
  name. `tsc`, eslint, prettier and a single `tsx` script need no lock, on
  Node 22. At most two subagents at a time on this machine, each by the
  same rules; more hands are asked of main, who opens streams elsewhere.
- The first comparison run of a batch is saved untouched before anything
  is fixed: it is the measure of the port. It is a runner's run: the
  artifact, with its summary committed in the batch's report. A comparison
  a subagent made privately does not count; the gate does.
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
  and, in the fault round before B4, a seeded fault in it is caught. The
  one who integrates seeds a fault of their own per group, chosen without
  looking at the porter's list. A fault that passes names an input to add.
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
- Decision 0026 on main replaces 0025's screens in Rust: the screens stay
  the React editors on desktop and web. The stages are this engine, then a
  central process in Rust, then Electron removed for a Rust shell (Tauri 2
  system webview or a CEF shell, chosen by measurement at stage 3) that
  shows the React screens. So the wasm build is the one the screens use in
  every host, desktop included, and the native build serves the central
  process: both stay first-class. The wasm's host imports (`seu_host`) are
  supplied by every such host.
- Each batch ends with a report to main: equality before fixing, the
  classes of difference, what cannot be reproduced, the rate, and what was
  not checked.
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
