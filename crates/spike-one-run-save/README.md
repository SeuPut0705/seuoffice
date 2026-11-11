# spike-one-run-save

An experiment, not a product crate. It tests assumption 1 of the port
decision: that the editor's own edit model can sit on design A's reader and
writer (a mirror of the parsed model; save = original slices plus regenerated
blocks), so that design B's model (nodes with source spans and provenance)
does not have to become the core.

The edit is the same for both ways. In `word/document.xml`, one run of one
body paragraph gets a new text in its `w:t`, and the package is saved.

- `container.rs` is shared and counts for neither way. It reads the zip and
  writes it back with every other local record copied byte for byte, the
  central directory patched only in offsets and in the replaced entry. It
  refuses ZIP64, multi-disk and encrypted archives, and archives whose
  central directory offset does not match its position. It keeps a prefix
  before the first record. The replaced entry loses its data descriptor.
- `way_a.rs` follows candidate A. The paragraph is read with the ordered
  parser as parse.ts reads it: runs with `rawRPr` (`serializeXNode` of
  `w:rPr`) and text with tabs and breaks as control characters, the
  paragraph with `rawPPr` as an exact slice. The save is a `SaveBlock` list:
  `Original` slices, and the edited paragraph `Generated` the way
  generate.ts writes one with `rawPPr`. `step` adds the missing classes one
  at a time.
- `way_b.rs` follows candidate B. Every element is a `Node` with its `Src`
  span and a `State`. The edit marks the run's `w:t` dirty and its ancestors
  touched. Clean nodes are copied, touched nodes copy their own tags and the
  bytes between children, the dirty `w:t` keeps its source start tag and is
  written from its value.
- `probe.rs` and `classify.rs` are the measurement's own tag walk. Neither
  way checks itself.

## Running

From the repository root:

```
cargo run --release --manifest-path crates/Cargo.toml -p spike-one-run-save --bin measure [out.txt] [file.docx ...]
cargo run --release --manifest-path crates/Cargo.toml -p spike-one-run-save --bin loc
```

`measure` takes every `git ls-files '*.docx'` unless files are given, and
writes its report to `out.txt` (default `/tmp/u1g-result.txt`). Per document,
it edits up to 20 top-level paragraphs with at least two text runs (a text
run has exactly one non-empty `w:t`), spaced evenly, and in each the first,
the middle and the last text run. The new text is `Edit & <x>` and U+1D11E.

## Result on the tracked corpus

183 of 185 documents open (the other two are encrypted, not zips). 163 have
no eligible paragraph. 120 paragraphs in 20 documents give 325 edits.

| way                                                               | other entries raw   | sibling paragraphs | sibling runs | text read back |
| ----------------------------------------------------------------- | ------------------- | ------------------ | ------------ | -------------- |
| B                                                                 | 100% (1906 of 1906) | 100%               | 100%         | 100%           |
| A0: minimal mirror                                                | 100% (1906 of 1906) | 100%               | 88.9%        | 100%           |
| A1: each `w:t` with its attributes                                | XML only            | 100%               | 93.2%        | 100%           |
| A2: unknown run children as XML                                   | XML only            | 100%               | 97.5%        | 100%           |
| A3: inline wrappers                                               | XML only            | 100%               | 99.4%        | 100%           |
| A4: tabs and breaks as written                                    | XML only            | 100%               | 100%         | 100%           |
| A5 to A8: rsid attributes, `w:proofErr`, other marks, white space | XML only            | 100%               | 100%         | 100%           |

"Sibling runs" means every byte of the main part outside the edited `w:t`
content is the original's. The 36 A0 misses, by the first differing
construct: 16 `w:t` start tags (generate.ts writes `xml:space="preserve"` on
every `w:t`), 14 `w:drawing` run children dropped, 6 `w:hyperlink` wrappers
dropped. After A3, 2 `w:cr` remain, written back as `w:br`.

The corpus is mostly engine-made. 5 of 183 documents carry `w:rsid`
attributes, and none of the 120 edited paragraphs has rsid attributes,
`w:proofErr`, bookmarks, fields, revisions or character references. Steps A5
to A8 therefore move nothing here. `tests/one_run.rs` pins them on a
Word-shaped paragraph instead: A reaches identity there only with every step
through the paragraph marks (A7).

## Result on Word-saved documents

The tracked corpus says little about Word. The same binary was run on the
test documents of Apache POI (`test-data/document/*.docx`, apache/poi at
77df76b, Apache-2.0, 130 files). That corpus is external: it is not in this
repository and nothing here depends on it.

```
git clone https://github.com/apache/poi /tmp/docx-public/poi
cd /tmp/docx-public/poi && git checkout 77df76b
<repository>/crates/target/release/measure /tmp/u1g-poi-result.txt test-data/document/*.docx
```

115 of 130 open (9 are not zips: encrypted or OLE; 6 are fuzzer cases whose
central directory offset is wrong, which the container refuses). 98 carry
`w:rsid` attributes. 210 paragraphs give 582 edits, none failing.

| way                                | other entries raw     | sibling paragraphs | sibling runs | text read back |
| ---------------------------------- | --------------------- | ------------------ | ------------ | -------------- |
| B                                  | 100% (10338 of 10338) | 100%               | 100%         | 100%           |
| A0: minimal mirror                 | 100% (10338 of 10338) | 100%               | 0.0%         | 99.5%          |
| A1: each `w:t` with its attributes | XML only              | 100%               | 0.5%         | 99.5%          |
| A2: unknown run children as XML    | XML only              | 100%               | 0.5%         | 100%           |
| A3: inline wrappers                | XML only              | 100%               | 1.5%         | 100%           |
| A4: tabs and breaks as written     | XML only              | 100%               | 1.5%         | 100%           |
| A5: attributes of `w:p` and `w:r`  | XML only              | 100%               | 46.0%        | 100%           |
| A6: `w:proofErr`                   | XML only              | 100%               | 83.7%        | 100%           |
| A7: other paragraph marks          | XML only              | 100%               | 95.9%        | 100%           |
| A8: white space between elements   | 100% (10338 of 10338) | 100%               | 95.9%        | 100%           |

On Word's own output the minimal mirror keeps no paragraph byte-identical:
552 of the 582 edits first differ at the `w:rsid*` attributes of `w:p`. The
steps that moved nothing on the tracked corpus carry the result here.

What is left after every step, 24 edits:

- 12 are white space the model has no place for. A8 keeps a white-space text
  node where there is a list to hold it: among the children of the paragraph
  and of an inline wrapper. Before `w:pPr` there is none, because `rawPPr` is
  written first and the white space then comes after it (9 edits, rtl.docx).
  Between the children of a `w:r` there is none either (3 edits,
  Bug66263-paragraph.docx, in the edited run and in its siblings alike).
- 12 are an `xml:space="preserve"` the writer adds to a sibling `w:t` that
  had none and whose text begins or ends in white space. 6 of them are edits
  A8 fixed, which then differ at this next place: that is why A7 and A8 show
  the same share.

Both are spelling, with one exception that belongs to this experiment and
not to the engine it mirrors. Word drops an unpreserved space at the edge of
a `w:t`, and parse.ts reads it the same way (`wtText`). Way A here keeps the
space and then marks it preserved, so it would become visible.

The three edits whose text did not read back at A0 and A1 are one paragraph
of WordWithAttachments.docx. One of its runs holds a `w:pict` with a VML
text box. The minimal mirror keeps the text and the `rawRPr` of a run and
nothing else, so the text box goes with the `w:pict`; from A2 on it is kept
as raw XML. The TypeScript engine does not regenerate that paragraph at all:
it reads a paragraph with such a text box as a passthrough block.

One class in the table is not spelling in the TypeScript engine either. A
run-level content control (`w:sdt` around runs) is not part of its run
model: the parser reports it and leaves it in the paragraph's original XML.
A paragraph saved as a generated block comes out without the control, its
text as plain runs. That is the `w:sdtPr` class here, which way A only keeps
from A7 on, and which way B never touches.

## Code amounts

Counted by `src/bin/loc.rs`: non-blank lines that are not `//` comments.

| part               | model | reader | writer | edit | total |
| ------------------ | ----- | ------ | ------ | ---- | ----- |
| container (shared) |       |        |        |      | 214   |
| B                  | 34    | 96     | 65     | 48   | 249   |
| A0                 | 36    | 149    | 95     | 46   | 353   |
| A steps 1 to 8     |       |        |        |      | 76    |

The totals include imports (B 6, A 7). A's total also holds 20 lines of step
switches that exist only for the cost curve. The steps cost: `w:t`
attributes 17, run children 4, wrappers 34, tabs and breaks 2, rsid
attributes 6, `w:proofErr` 5, other marks 2, white space 6.

## Reading

- B keeps sibling runs byte-identical by construction. Its writer copies
  every byte it did not change, so a construct it does not model costs it
  nothing.
- A keeps sibling paragraphs and other entries identical by construction,
  through `SaveBlock::Original` and the shared container. Inside the edited
  paragraph it keeps only what its model holds. Each class Word writes
  costs a step. Two classes cannot be reached without source positions: a
  character reference or `&quot;` in a sibling run's text, and quoting or
  entity forms inside `w:rPr` (the last test pins both). Holding those
  means holding spans, which is B's model.
- On this corpus B is 249 lines and A is 353 (A0) to 429 (every step).
  A's reader carries the parse.ts mirror (control characters, `rawPPrOf`,
  numeric references) that its JSON parity gate needs anyway.

Design choices that decide numbers:

- A0 follows generate.ts in writing `xml:space="preserve"` on every `w:t`.
  That is 16 of its 36 misses.
- A keeps the original bytes between body elements. A save that dropped
  them would lose sibling-paragraph identity in pretty-printed documents.
- A0 does not trim `w:t` text without `xml:space` the way `wtText` does,
  which favors A.
- B's dirty `w:t` keeps its source start tag and adds `xml:space` only when
  the new text needs it. Writing it from the value alone would cost B the
  edited run's own tag where the source differs from the generated form.
- B types only paragraphs, runs and run text. B's sketch also types
  paragraph and run properties with a `Rest` of untyped children; this edit
  did not need them, so they are not counted.

## What this does not show

It edits run text only. These edits would change the picture:

- A run property change. A merges into its `rawRPr` string (mergeRPrModel)
  and regenerates the paragraph. B needs a typed `RunProps` with `Rest` to
  keep the children it does not type, which is model B has not paid for here.
- A run split or merge. Both write new runs from values. B has to give a
  new node no span, or share the source `w:rPr` between two nodes.
- A paragraph property change. A has `rawPPr` and mergePPrFormat. B needs a
  typed `ParaProps` with `Rest`.
- Insertion and deletion. Block-level is cheap for both (`SaveBlock` list,
  B's `reorder`). Inside a paragraph, B inserts nodes without spans next to
  clean ones; A regenerates the paragraph anyway.

The Word-saved reading rests on one external corpus of test documents, many
of them written to exercise one feature. It is not a sample of what people
write.
