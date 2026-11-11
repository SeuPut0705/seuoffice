# crates

The Rust document engines of SeuOffice. Today this is the docx engine, ported
from `packages/docx-engine` one module at a time. Nothing in the product calls
it yet: every ported module is compared against the TypeScript it came from by
`tools/docx-diff`, and the TypeScript stays the engine until a unit flips a
caller.

## Layout

| Crate         | What it holds                                                                                                                             | Ported from                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `jscompat`    | JavaScript operations, bit for bit: `parseInt`, `Number`, `Math.round`, number printing, regular expressions, `Map`, `decodeURIComponent` | the language                                                                                                                              |
| `ooxml-xml`   | The tag scanner, the ordered parser and its serializer, `XNode` readers, UTF-16 offsets                                                   | `scan.ts`, `xml-utils.ts`, fast-xml-parser                                                                                                |
| `ooxml-pkg`   | A docx as `loadDocxZip` opens it: the zip gate, the JSZip reader, Strict normalization, `Package`                                         | `zip-load.ts`, `packages/zip-gate`, JSZip 3.10.1, `ooxml-normalize.ts`                                                                    |
| `docx-engine` | Body scan, property readers, relationships, content types, theme, font table, styles, numbering, comments, protection                     | `scan.ts`, `parse-props.ts`, `parse-xml-text.ts`, `parse-package.ts`, `theme.ts`, `font-table.ts`, `parse-styles.ts`, parts of `parse.ts` |
| `office-wasm` | The one entry point JavaScript calls, built for `wasm32-wasip1`                                                                           | new                                                                                                                                       |

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

|     | Compares                                                                              | Module                                                    |
| --- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| (a) | `scanBody`                                                                            | `compare-scan.ts`                                         |
| (b) | parse and serialize of XML fragments                                                  | `compare-xml.ts`                                          |
| (c) | text of zip entries                                                                   | `compare-zip.ts`                                          |
| (d) | the 69 property readers                                                               | `compare-props.ts`, `props-registry.ts`, `props-run.ts`   |
| (e) | the package layer: loading, refusals, normalization, every value read before the body | `compare-package.ts`, `package-zips.ts`, `package-run.ts` |

A `+` marks seeded mutations of the same inputs. The rule for them: where the
TypeScript throws, Rust must refuse; where it answers, Rust must answer the
same.

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
- `docx-engine/src/styles/mod.rs` has a private `JsMap` from before
  `jscompat::JsMap` existed.
- `cargo-deny` is configured (`deny.toml`) but was not installed on the
  machine these crates were written on, so it has not run.
