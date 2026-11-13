# B4: the switch of @seuoffice/docx-engine to the Rust engine

Batch B4 of the docx port (crates/README.md, "Batches"). This file is the plan
it was started from, main's decisions on it, and its state when it was handed
to another session on 2026-11-12.

## Main's decisions (2026-11-12)

1. Tiny hot exports (isEastAsianChar, formatNumber, ...) cross to Rust too,
   measured once at the batch end: one render benchmark (open and layout of
   the five largest docx of the repository, renderer path), TypeScript
   against the wasm binding. A function whose wasm route makes the benchmark
   more than 5% slower stays TypeScript only and its Rust copy is deleted (one
   implementation per function either way), recorded in the ledger with the
   numbers. No dual implementations, no caching layer.
2. Asynchronous host converters (EMF/WMF, TIFF, the altChunk HTML converter):
   a two-pass call. Rust replies { pending: [...] }, the binding converts and
   calls again with the results.
3. Synchronous callbacks: one reentrant import seu_host.host_callback(slot,
   ptr, len), supplied by stream C's loader @seuoffice/engine-wasm.
4. The engine starts by itself under the node export condition; renderer and
   web entries call the async init once.

## State at hand-over

- Done and committed: the engine side (Command::Invoke and its generated
  table in crates/office-wasm/src/invoke, host_callback, the pending
  protocol, ParseDocx v2 with options, extras and warnings); the binding
  generator (tools/docx-diff/binding/gen.ts, manifest, overrides) and its
  output in packages/docx-engine/src; the frozen engine in
  tools/docx-diff/reference/ with every tools/docx-diff import repointed
  there (tools/docx-diff/freeze-reference.mjs); the init wiring of the apps,
  the CLI and the vitest setups; the internal rename applied.
- Not run yet: the package's type check and tests, the comparison, the render
  benchmark, faults, the review.
- Open type errors of tsc -p packages/docx-engine when the generator's fixer
  was stopped (some may be fixed in the committed state): BufferSource and
  WebAssembly unknown in the package's lib; the ?url import of the wasm
  without a declaration in scope; ParseOptions not assignable to
  Record<string, unknown> in parse.ts; previewFontSettings typed as returning
  never; tests/helpers/inline-wrap.ts importing mergeRuns from
  src/parse-props, which the binding dropped (every name a test imports from a
  src module must stay exported: 41 test files, 66 names).
- Decisions the plumbing made that need a look: the Electron renderers of
  docs, markdown and sheets allow 'wasm-unsafe-eval' in their CSP; the apps
  import the wasm through ?asset / ?url from
  crates/target/wasm32-wasip1/release/office_wasm.wasm, which must be built
  before an app build.

## The procedure the batch was run under

Same procedure as B2/B3: no comparisons, no tests, no clippy, no tsc during the batch; one `cargo check` when a compile error blocks you, and once at the end of your slice. I run everything once at the batch end.

## Goal (decision 0025 item 4, main's answers m-53a11204)
`@seuoffice/docx-engine` keeps every exported name and type. Its implementation modules become thin synchronous functions over the WASM engine (the TS-async exports stay `async` and resolve). The model stays a plain JS object. Every importer is unchanged except an init call. The package's existing tests run unchanged against the binding. The TypeScript engine is frozen at the B4 base under `tools/docx-diff/reference/` and the gate compares against that copy.
- Loader: `@seuoffice/engine-wasm` (stream C, not on origin yet; write against this API and adjust when it lands): `initEngineSync(bytes)`, `await initEngine(url | Response | bytes)`, `engineReady()`, `engineCall<Header>(command, blobs?) -> { header, blobs }`, throws `EngineError(code, message)`. It supplies `seu_host.host_collate(a,alen,b,blen,locale,llen)` and (agreed tonight) a reentrant `seu_host.host_callback(slot, ptr, len)`.
- Init: auto-init synchronously under the `node` export condition (package.json exports); the renderer and web entries call `await initEngine(...)` once before the editor mounts.
- Async host converters (EMF/WMF metafileToDataUrl, TIFF tiffToDataUrlAsync, the alt-chunk htmlConverter): two-pass. Rust replies `{ pending: [...] }`, the async binding converts and calls again with `resolved`, until nothing is pending. `setAltChunkHtmlConverter` stays a TS registry in the binding.
- Sync callbacks (generateParagraphXml's allocateHyperlinkRel / allocateBookmarkId / allocateRevisionId, paraMarkRevisionXml, pendingHeadingLevel): the header names `callbacks: { name: slot }`, Rust calls `seu_host.host_callback(slot, ptr, len)` with the JSON arguments and reads the JSON answer the host writes back (define the reply protocol: e.g. the host returns a pointer to a length-prefixed UTF-8 buffer it allocates with `seu_alloc`).
- Hot tiny exports cross to Rust too; a render benchmark at the batch end decides (>5% slower → that function stays TS-only and its Rust copy is deleted).
- One implementation per function. No dual paths, no caching layer, no fallback to TS.

The design inventory is the last section of this file (raw data in tools/docx-diff/binding/inventory/). Note from it: an (f) call today is `{cmd:'props', inputs:[{xml, calls:[{fn:'group.tsName', args}]}]}` with gate-specific arg keys. The binding gets its own command: `{cmd:'invoke', fn:'<TS export name>', args:[...positional JSON args...]}` answered by a generated Rust table, so the binding passes the TS arguments positionally and the gate keeps its (f) adapters unchanged.

## Slices and files
- `PortParseDrawings` (binding): the manifest `tools/docx-diff/binding/manifest.json` (written by a script from the export list of the reference copy), the generator `tools/docx-diff/binding/gen.ts` that writes (a) the TS binding modules in `packages/docx-engine/src/` (replacing each implementation module's body by its thin wrappers, keeping exported names, types and the subpath modules the importers and the 41 test files use) and (b) `crates/office-wasm/src/invoke/table.rs` (the generated `fn invoke(name, args) -> Result<Value,String>` table); the ~25 hand wrappers; the codecs (blobs as `{"$blob":n}`, Map/Set entries, Date as ms). Run the generator (it is a tool, not a check) and commit nothing.
- `PortParseText` (engine side): `Command::Invoke` in crates/office-wasm/src/lib.rs dispatching to the generated table; the 21 exports that have no route yet (ports exist; add `pub` and an entry the generator can name); `seu_host.host_callback` and the callback argument decoding; the two-pass pending protocol in ParseDocx/SaveDocx and the converters' call sites (MediaHost implementation for the wasm: records misses); ParseDocx options/extras/warnings; console.warn sites returned as `warnings[]`. Files: crates/** except `crates/office-wasm/src/invoke/table.rs`.
- `PortParseTables` (switch plumbing): freeze `packages/docx-engine/src` (all .ts at HEAD, plus vendor/) into `tools/docx-diff/reference/` and repoint every import of `packages/docx-engine/src` in tools/docx-diff to it (a codemod script, run once); package.json `exports` with the `node` condition auto-init; the init call in the renderer/web/electron entries and the 9 vitest configs' setupFiles (tests/setup-equality.ts etc.); the alias configs (apps/docs, apps/slides, pptx-ops vite/vitest) and the relative importers (hwp2docx, odf2ooxml, pdf2docx rebuild, tools/gen-*): keep them working with the binding; list every file you touched. Files: those, plus `tools/docx-diff/**` except binding/.
Shared: `packages/docx-engine/src/**` is the generator's output; PortParseTables touches only package.json and the init wiring there.

## The inventory


Written by PortParseDrawings, read-only study of the tree at `feat/rust-docx-model`. No product file was edited.
Scratch data: `tools/docx-diff/binding/inventory/index-exports.json` (all 405 exports, from the TS checker), `home.json`, `table.md` (the table of section 1, regenerated by `exports.cjs` + `home.py`).

**Caveat.** `packages/engine-wasm` is on no ref I can reach (`origin/feat/rust-pptx-u1`, FETCH_HEAD, every remote branch: no such path; ls-remote shows no stream-C branch). Section 3's loader calls are taken from the brief; the ABI itself is read from `crates/office-wasm/src/lib.rs` and `tools/docx-diff/engine.ts`, the node host the loader replaces.

## 0. What the wire is today (not what the brief assumed)
- ABI: `seu_alloc/seu_free/seu_call`; frame `u32 hlen | header JSON | u32 nblobs | (u32 len | bytes)*`, header `{version:1, cmd, ...}`, failure reply `{error:{code,message}}` (this is `EngineError(code,message)`).
- There is no `{command:'call', group, fn}`. An (f) call is `{cmd:'props', inputs:[{xml: text, calls:[{fn:'group.tsName', args}]}]}`; reply `{results:[[{value}|{}|{error}]]}` (`{}` = undefined, `{error}` = the TS function throws). `calls::dispatch` splits `group.fn`; 44 groups (docx + pptx). Blob commands: `scanBody roundTripXml zipEntries package packageParts normalizeOoxml pptxPackage modelRoundTrip parseDocx saveDocx compareDocuments`.
- `args` keys are the gate's, per function (`record`, `documentXml`, `parts`, `saltBytes`...), chosen by each spec's `fromX`; they are not TS parameter names. Generating the binding needs one of: re-key the adapters to parameter names (mechanical but 581 `arg/required(args,"k")` sites in `calls/`), or emit the key table from the specs (section 6).
- Model wire: JSON, Map as `[[k,v]..]`, bytes as `{"$bytes":base64}` (gate form; README says the product form is blobs). `undefined` = key absent, `null` = null, NaN/-inf = `null`, -0 = `0` (`JsNum`).
- Engine has no clock, no entropy, no console: the host supplies `nowMs`/`now` (saveDocx, compareDocuments, chart workbooks, blank docx), `saltBytes` (hashProtectionPassword draws `crypto.getRandomValues` in TS), and the TS `console.warn` sites (`parse-styles.ts:161`, `alt-chunk.ts:98` and the metafile ones) have to come back as `warnings[]` in the reply for the binding to replay.
- Process statics in Rust (`STANDALONE_BOOKMARK_SEQ`, `HF_TEXT_BOX_SEQ`) mirror TS module counters (`generate.ts:2387`, `parse.ts:8116`): one long-lived instance keeps the TS behaviour; re-instantiating resets them.

## 2. Crossings JSON cannot carry
| TS value | exports | proposed crossing |
|---|---|---|
| `Uint8Array`/`ArrayBuffer` in | parseDocx, saveDocx, planRemoveParts, buildBlankDocx(out), findChartWorkbookPath, readDocxPartBase64, sfnt*/deobfuscateOdttf, assertZipInflatesWithinLimits | request blob (no copy through JSON). Out: reply blob; model-embedded bytes (`internal.originalBytes`, picture bytes) become `{"$blob":n}` refs revived to `subarray`s of ONE reply buffer. `parseDocx` need not echo `originalBytes`: the binding sets it to its own input. |
| `Map`/`Set` | ParsedDoc.styles/numbering/headingStyleIds; args of computeListMarkers*, pendingHeadingLevel, resolveCtxOf, tocLevelOf, missingHeadingLevels, previewFontSettings; `LINE_BORDER_VALS` | entries wire already used by the gate; the codec is generated from the TS type (`Map<string,X>` -> entries). Key type (number keys of headingStyleIds) is kept by entries. |
| `JSZip` argument | readEmbeddedFonts, assertZipWithinLimits, applyPropertyChanges (mutates), readDocumentProperties, applyRemoveParts (mutates) | not carryable. Hand wrapper: read the named parts (`await zip.file(p).async('string')` into `parts:[[name,text]]`, the `args.parts` convention of `calls::package`), call, write `changedParts` back with `zip.file(name, text)` / `zip.remove`. Only 5 exports, none used outside the package except through saveDocx. |
| function arguments | `GenerateContext.allocateHyperlinkRel` (required), `.allocateBookmarkId`, `.allocateRevisionId`, `paraMarkRevisionXml(mintId)`, `pendingHeadingLevel(pending, existing)` | all SYNCHRONOUS. Propose one reentrant import `seu_host.host_callback(slot:u32, ptr, len) -> packed(ptr,len)` plus header `callbacks:{name:slot}`; the binding keeps a slot table and runs the JS function. Rule: `engineCall` inside a callback throws (no nested `seu_call`). Gate today fakes them with canned allocators (`rIdH{n}`), so the Rust side already takes closures. |
| async converters | `metafileToDataUrl`, `tiffToDataUrlAsync` (utif2+canvas), alt-chunk `htmlConverter`; used inside parseDocx, only async because of canvas | cannot be a sync import. Two-pass: Rust runs with a recording `MediaHost`, a miss returns a placeholder and is recorded; the reply is `{pending:[{id, kind:'metafile'|'tiff'|'altchunk', mime, blob}]}`; the async TS binding converts them, re-calls with `resolved:{id:value}`, loops until `pending` is empty (alt-chunk output is itself parsed -> nested pending is the same loop). Parse is a pure function of (bytes, options, resolved), so replays are safe; `id` = hash of the input bytes. JSPI is not an option (Node 22 needs a flag, Electron-version dependent). `setAltChunkHtmlConverter(fn)` stays a TS registry in the binding; the engine only learns `hasConverter:true` in the header. |
| `Date` | newDocumentCorePropertiesXml(created), w3cdtfStamp | `created.getTime()` as number; engine takes ms. |
| class instance | `ContentControlPart` (param `part` of generateTableModelXml, patchTableCellTexts; `GenerateContext.part`) | not in index.ts; only saveDocx internals pass it. Binding drops the parameter (Rust makes and finishes its own when `None`, as today). |
| `XNode` | resolveParagraphProps, resolveRunProps | `serializeXNode` to XML text (as the gate does) or keep an `xnode` field; `XNode` helpers stay TS (`xml-utils`). |
| whole `ParsedDoc`/`Block[]` args | readSections, readSectionSettings, readPageColor, compareBlocks, mergeBlockTree, mergeRecords, missingHeadingLevels, saveDocx, previewFontSettings | serializing the model per call is the cost (readSections has 19 call sites in apps/docs). Generator gets a `reads:[...]` annotation (readPageColor -> `internal.documentXml`; readSectionSettings/readSections -> `blocks[].{hidden,originalXml,docxIndex}` + `gutterAtTop`) and sends only those fields; or those three stay TS loops over Rust `sectionFromSectPr`. |
| `RegExp`/`Set` consts | `SEGOE_UI_SYMBOL_RE`, `LINE_BORDER_VALS`, `TEXT_EFFECTS` | stay TS data (no Rust route); parity checked by a generated test. |

## 3. Async to sync
17 exports are `async` in TS: readEmbeddedFonts, parseDocx, assertZipInflatesWithinLimits, applyPropertyChanges, readDocumentProperties, saveDocx, findChartWorkbookPath, readDocxPartBase64, applyRemoveParts, planRemoveParts, buildChartWorkbookXlsxBase64, patchChartWorkbookXlsxBase64, buildBlankDocx, hashProtectionPassword, verifyProtectionPassword, previewFontSettings, compareDocuments. Every one has a synchronous Rust port. Keep them `async` returning a resolved Promise (importers `await` them; 25 call sites of buildBlankDocx, 18 of parseDocx), except that parseDocx genuinely awaits in the pending loop above. Everything else is synchronous in TS and stays so. The loader's surface (`initEngineSync(bytes)`, `await initEngine(...)`, `engineReady()`, `engineCall`) fits; two gaps to ask stream C for: a host-import table (`seu_host.host_collate` exists; add `host_callback`, plus `clock`/`random` if WASI's `clock_time_get`/`random_get` are not wired in the browser) and blobs as `Uint8Array` views over one copied reply (no per-blob copy).

## 4. Importers of `@seuoffice/docx-engine`
Package-name imports, product `src` only: apps/docs 131 files (main + renderer), packages/odt-engine 28, packages/cli 7, apps/sheets 5, packages/file-parse 4, apps/markdown 3, apps/shell 2, one each apps/slides, packages/{doc2docx,docx2hwp,pdf2docx,pptx-ops,ui}. Counting tests: apps/docs 403 files, odt-engine 54, cli 25, doc2docx 12, pdf2docx 7, apps/markdown 7, others <6. 137 of the 240 value exports are imported outside the package; 103 have no outside importer (kept for the public surface/tests).
Does anyone reach a non-exported path? Yes:
- subpaths of package.json `exports` (`./math ./metafile ./zip-splice ./lazy-media`): product use in apps/docs main (`lazy-media`, `zip-splice`: slimDocx, materializeDocx, openZipFile, readZipEntries, bufferSource, lazyMediaHashesIn), apps/slides + apps/sheets (`metafile`: isMetafileMime, metafileToDataUrl; `math`), packages/pptx-ops (`math`). `metafile`/`isMetafileMime` are not index exports and stay TS (canvas host converter).
- alias configs pointing at `src/*.ts` files: apps/docs electron.vite/vite.web/vitest (`lazy-media.ts`, `zip-splice.ts`, `index.ts`), apps/slides (`metafile.ts`, `math.ts`), packages/pptx-ops vitest.
- relative imports that bypass the package name: packages/hwp2docx, odf2ooxml, pdf2docx/src/rebuild and cli tests (`../../docx-engine/src/index`; their package.json do declare the dependency); tools/gen-help-*.ts + gen-shell-new-templates (`src/blank`); apps/docs tests/tools/inline-snapshot.test.ts (`src/parse-block-passes`); apps/shell tests read `src/vendor/emf-converter`; ~170 test files import `packages/docx-engine/tests/helpers/build-docx` and `tests/fixtures/truths`.
Init points: 9 vitest configs alias the package (apps/docs, apps/slides, pptx-ops, doc2docx, docx2hwp, hwp2docx, odf2ooxml, odt-engine, pdf2docx) -> a `setupFiles` entry each; electron main + renderer main.tsx + web entry + cli entry for runtime. Option that keeps importers untouched: the package entry does `initEngineSync(readFileSync(wasmUrl))` under the `node` export condition and exposes `await initDocxEngine(url)` for browser/renderer entry only.

## 5. The package's own tests
245 `tests/*.test.ts`; 190 import `../src/index`; 162 have no value import from any other `../src/<module>`; 83 do (45 modules). 41 files import 66 names that `index.ts` does not export (zip-splice 7 names, parse-vml 7, xml-utils 6, smartart 4, ooxml-normalize 4, parse-package 3, metafile 3, lazy-media 3, alt-chunk 3, eq-field 2, tiff 2, parse-props 2, text-patch, field-balance, parse-drawing-geometry...). These modules must keep their exported names too (the brief says implementation modules become thin), otherwise those 41 files fail; modules that are pure host code (`xml-utils` xmlParser/XNode helpers, `metafile`, `tiff`, vendor emf) stay TS. Mock-based tests that replace TS internals stop exercising anything once the logic is in Rust: `vi.mock('../src/vendor/emf-converter/index.mjs')` (emf-image, metafile-gunzip), `vi.mock('@exodus/bytes/encoding.js')` (alt-chunk-charset-tables-missing), canvas fakes (`helpers/fake-canvas.ts`: metafile-render, ole-embed-preview, tiff-dims, media-data-url-shared) and the `setAltChunkHtmlConverter` tests (alt-chunk*, 3 files). They bind to the host converter seam (stay valid) except the charset-tables test, which tests a TS fallback and needs a Rust-side equivalent or retirement. `tests/setup-equality.ts` is the only `setupFiles` entry: add `initEngineSync` there.

## 6. Generator ("Build the Lever")
Input: the export list itself, read with the TS checker (`tools/docx-diff/binding/inventory/exports.cjs`: 405 exports in ~17 s: 205 functions, 35 consts, 165 types). Output per module `src/<module>.ts` keeps every exported name and the verbatim parameter/return types; bodies are generated:
1. Manifest (`engine-manifest.json`): `{name, module, async, params:[{name, typeText, optional, codec}], returns:{codec}}`, codec chosen from the checker type: text/number/boolean/object -> json; `Uint8Array` -> blob; `Map/Set` -> entries (recursive, covers `Map<number,..>` and `Map<string,Map<..>>`); `XNode` -> xml text; `Date` -> ms; function params -> callback slot; `JSZip` -> parts; `ParsedDoc*` -> model codec with `reads`. 163 of 205 functions have no special flag: they are generated with no human input.
2. Rust side: a table generated from the same manifest, `calls/invoke.rs`, one row `("tsName", rust_path, [codecs])`, with the existing group adapters reused where the arg keys already exist; a coverage gate fails when an export has no row (today 22 of 205 have none: section 1 marks them).
3. Hand-written special cases (about 25, all named in section 1's flags): parseDocx (pending loop), saveDocx/compareDocuments/scanBody (blob commands, exist), previewFontSettings, the 5 JSZip wrappers, hashProtectionPassword/verifyProtectionPassword (salt, `crypto.subtle` kept or Rust), buildBlankDocx (clock), setAltChunkHtmlConverter (registry), generateParagraphXml/paraMarkRevisionXml/pendingHeadingLevel (callbacks).
4. Consts: copied as TS literals; the generator emits a parity test that reads each Rust const through one `consts` call. Types: `export * from './types'` and every type declaration stay TS, untouched.
5. Reference copy: the generator must read from `tools/docx-diff/reference/` (frozen TS), never from the files it overwrites; the gate then compares `reference/<fn>` against the binding over the same specs, so (f) is the binding's test and the harness `internals` calls keep working for parse.ts's private functions (not exported: stay Rust-only, no binding row).

## Gaps found (action list)
- No wasm route yet for 21 exports whose Rust port exists: deobfuscateOdttf, isSfnt, sfntLineMetrics, parseFontTable, readEmbeddedFonts, paraCsFormat, styleRunFormat, assertZipInflatesWithinLimits, isLazyMediaPart, lazyMediaUrl, newDocumentAppPropertiesXml, newDocumentCorePropertiesXml, w3cdtfStamp (private in blank.rs), findChartWorkbookPath, readDocxPartBase64, readThemeColors, readThemeFonts, computeListMarkers, previewFontSettings (adapter not written), revisionDateMs, keepsHangulKanaSingle.
- No Rust function: `emptyDocumentProperties` (trivial), `setAltChunkHtmlConverter` (host hook by design).
- `ParseDocx` needs `options` (`expandAltChunks`, `shadowResolve`), `extras` in the reply, the pending protocol and warnings; it now reads "with no media converter installed".
- Consts with no Rust counterpart: DOCX_ZIP_LIMITS (is `DEFAULT_ZIP_LIMITS` in ooxml_pkg), APP/CORE_PROPERTY_KEYS (are `app/core_property_keys()`), LINE_KINDS, EMPHASIS_MARKS.
- Per-call cost: char-class/list-marker/formatNumber exports are called per character or per paragraph in editor code (isEastAsianChar 6 sites, formatNumber 9); decide per function whether they cross at all (a table lookup in TS is cheaper than a frame) before generating all of them.

## 1. Exports: name, sync/async, Rust home, wasm route, crossing
(`call group.fn` = existing (f) route; `NEW` = Rust port exists, route to add; types are the 165 `export type/interface` of `types.ts` and the modules: no wasm side, they stay TS declarations.)

#### font-table

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| deobfuscateOdttf | sync | docx-engine/src/font_table.rs | **NEW call route** (Rust port exists) | bytes |
| isSfnt | sync | docx-engine/src/font_table.rs | **NEW call route** (Rust port exists) | bytes |
| parseFontTable | sync | docx-engine/src/font_table.rs | **NEW call route** (Rust port exists) | json |
| readEmbeddedFonts | async | docx-engine/src/font_table.rs | **NEW call route** (Rust port exists) | JSZip |
| sfntLineMetrics | sync | docx-engine/src/font_table.rs | **NEW call route** (Rust port exists) | bytes |

#### parse-xml-text

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| decodeEntities | sync | docx-engine/src/sources.rs | call props.decodeEntities | json |

#### checkbox-control

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| sdtCheckboxGlyphs | sync | docx-engine/src/checkbox_control.rs | call checkbox.sdtCheckboxGlyphs | json |
| sdtCheckboxIsChecked | sync | docx-engine/src/checkbox_control.rs | call checkbox.sdtCheckboxIsChecked | json |

#### inline-opaque

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| inlineWrapContentLocked | sync | docx-engine/src/inline_opaque.rs | call parse.inlineWrapContentLocked | json |
| runCopiedElsewhere | sync | docx-engine/src/inline_opaque.rs | call parse.runCopiedElsewhere | json |
| sameInlineWrap | sync | docx-engine/src/inline_opaque.rs | call parse.sameInlineWrap | json |
| sameInlineWrapChain | sync | docx-engine/src/inline_opaque.rs | call parse.sameInlineWrapChain | json |

#### content-control

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| buildContentControlXml | sync | docx-engine/src/save/features/content_control.rs | call save.buildContentControlXml | json |
| isContentControlLock | sync | docx-engine/src/save/features/content_control.rs | call save.isContentControlLock | json |
| nextContentControlId | sync | docx-engine/src/save/features/content_control.rs | call save.nextContentControlId | json |

#### parse

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| parseDocx | async | docx-engine/src/parse/entry.rs | blob ParseDocx (+options, pending, extras: extend) | bytes, whole-model |
| reconcileGridColumns | sync | docx-engine/src/parse/tables.rs | call parse.reconcileGridColumns | json |

#### parse-styles

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| paraCsFormat | sync | docx-engine/src/styles/mod.rs | **NEW call route** (Rust port exists) | json |
| styleRunFormat | sync | docx-engine/src/styles/mod.rs | **NEW call route** (Rust port exists) | json |

#### mail-merge

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| compareOperands | sync | docx-engine/src/save/features/mail_merge.rs | call save.compareOperands | json |
| conditionHolds | sync | docx-engine/src/save/features/mail_merge.rs | call save.conditionHolds | json |
| controlEffect | sync | docx-engine/src/save/features/mail_merge.rs | call save.controlEffect | json |
| ifBranch | sync | docx-engine/src/save/features/mail_merge.rs | call save.ifBranch | json |
| mergeBlockTree | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeBlockTree | Block[] |
| mergeDataFromRows | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeDataFromRows | json |
| mergeFieldInstruction | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeFieldInstruction | json |
| mergeFieldName | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeFieldName | json |
| mergeFieldSwitches | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeFieldSwitches | json |
| mergeFieldText | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeFieldText | json |
| mergeOutputFileName | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeOutputFileName | json |
| mergeRecords | sync | docx-engine/src/save/features/mail_merge.rs | call save.mergeRecords | Block[] |
| placeholderText | sync | docx-engine/src/save/features/mail_merge.rs | call save.placeholderText | json |
| splitInstruction | sync | docx-engine/src/save/features/mail_merge.rs | call save.splitInstruction | json |
| valueOf | sync | docx-engine/src/save/features/mail_merge.rs | call save.valueOf | json |

#### zip-gate/src/index

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| assertZipInflatesWithinLimits | async | ooxml-pkg/src/gate.rs | **NEW call route** (Rust port exists) | bytes |

#### zip-load

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| assertZipWithinLimits | sync | pptx-engine/src/zip.rs | call pptxPackage.assertZipWithinLimits | JSZip |

#### lazy-media

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| isLazyMediaPart | sync | docx-engine/src/lazy_media.rs | **NEW call route** (Rust port exists) | json |
| lazyMediaUrl | sync | docx-engine/src/lazy_media.rs | **NEW call route** (Rust port exists) | json |
| parseLazyMediaUrl | sync | docx-engine/src/lazy_media.rs | call save.parseLazyMediaUrl | json |

#### alt-chunk

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| setAltChunkHtmlConverter | sync | (host hook; no Rust fn) | host hook | json |

#### parse-fields

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| tocLevelOf | sync | docx-engine/src/fields.rs | call fields.tocLevelOf | Map |

#### parse-props

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| mergeStyleBorders | sync | docx-engine/src/props/borders.rs | call props.mergeStyleBorders | json |
| themeLangEaSlotFont | sync | docx-engine/src/props/fonts.rs | call props.themeLangEaSlotFont | json |

#### doc-properties

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| applyPropertyChanges | async | docx-engine/src/save/features/doc_properties_write.rs | call save.applyPropertyChanges | JSZip |
| emptyDocumentProperties | sync | NONE (build in TS: all-empty record) | call docprops.emptyDocumentProperties | json |
| newDocumentAppPropertiesXml | sync | docx-engine/src/blank.rs | **NEW call route** (Rust port exists) | json |
| newDocumentCorePropertiesXml | sync | docx-engine/src/blank.rs | **NEW call route** (Rust port exists) | Date |
| parseAppPropertiesXml | sync | docx-engine/src/doc_properties.rs | call docprops.parseAppPropertiesXml | json |
| parseCorePropertiesXml | sync | docx-engine/src/doc_properties.rs | call docprops.parseCorePropertiesXml | json |
| parseCustomPropertiesXml | sync | docx-engine/src/doc_properties.rs | call docprops.parseCustomPropertiesXml | json |
| parseCustomPropertyTypesXml | sync | docx-engine/src/doc_properties.rs | call docprops.parseCustomPropertyTypesXml | json |
| parsePropertyChanges | sync | docx-engine/src/save/features/doc_properties_write.rs | call save.parsePropertyChanges | json |
| patchAppPropertiesXml | sync | docx-engine/src/save/features/doc_properties_write.rs | call save.patchAppPropertiesXml | json |
| patchCorePropertiesXml | sync | docx-engine/src/save/features/doc_properties_write.rs | call save.patchCorePropertiesXml | json |
| patchCustomPropertiesXml | sync | docx-engine/src/save/features/doc_properties_write.rs | call save.patchCustomPropertiesXml | json |
| readDocumentProperties | async | docx-engine/src/doc_properties.rs | call docprops.readDocumentProperties | JSZip |
| w3cdtfStamp | sync | docx-engine/src/blank.rs | **NEW call route** (Rust port exists) | Date |

#### patch

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| saveDocx | async | docx-engine/src/save/save.rs | blob SaveDocx | bytes, whole-model, Block[] |
| findChartWorkbookPath | async | docx-engine/src/save/save/helpers.rs | **NEW call route** (Rust port exists) | bytes |
| missingHeadingLevels | sync | docx-engine/src/save/save/helpers.rs | call save.missingHeadingLevels | Map, Block[] |
| readDocxPartBase64 | async | docx-engine/src/save/save/helpers.rs | **NEW call route** (Rust port exists) | bytes |

#### remove-parts

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| applyRemoveParts | async | docx-engine/src/save/parts/remove_parts.rs | call save.applyRemoveParts | JSZip |
| planRemoveParts | async | docx-engine/src/save/parts/remove_parts.rs | call save.planRemoveParts | bytes |
| removePartsRefusalMessage | sync | docx-engine/src/save/parts/remove_parts.rs | call save.removePartsRefusalMessage | json |
| removePartsRefusalMessageFor | sync | docx-engine/src/save/parts/remove_parts.rs | call save.removePartsRefusalMessageFor | json |

#### generate

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| applyImageWrap | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.applyImageWrap | json |
| applyImageZOrder | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.applyImageZOrder | json |
| applyShapeWrapAt | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.applyShapeWrapAt | json |
| applyShapeZOrderAt | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.applyShapeZOrderAt | json |
| buildAnchoredTextboxParagraphXml | sync | docx-engine/src/generate/drawing_build.rs | call genDrawingBuild.buildAnchoredTextboxParagraphXml | json |
| buildShapeParagraphXml | sync | docx-engine/src/generate/drawing_build.rs | call genDrawingBuild.buildShapeParagraphXml | json |
| buildTextboxParagraphXml | sync | docx-engine/src/generate/drawing_build.rs | call genDrawingBuild.buildTextboxParagraphXml | json |
| buildWordArtParagraphXml | sync | docx-engine/src/generate/drawing_build.rs | call genDrawingBuild.buildWordArtParagraphXml | json |
| generateCaptionXml | sync | docx-engine/src/generate/fields.rs | call genFields.generateCaptionXml | json |
| generateIndexFieldXml | sync | docx-engine/src/generate/fields.rs | call genFields.generateIndexFieldXml | json |
| generateParagraphXml | sync | docx-engine/src/generate/paragraph.rs | call genParagraph.generateParagraphXml | callback |
| mergeRPrModel | sync | docx-engine/src/generate/rpr.rs | call genRpr.mergeRPrModel | json |
| generateTableModelXml | sync | docx-engine/src/generate/table.rs | call genTable.generateTableModelXml | class |
| generateTableXml | sync | docx-engine/src/generate/table.rs | call genTable.generateTableXml | json |
| generateTocFieldXml | sync | docx-engine/src/generate/fields.rs | call genFields.generateTocFieldXml | json |
| mergePPrFormat | sync | docx-engine/src/generate/props.rs | call genProps.mergePPrFormat | json |
| setPPrChange | sync | docx-engine/src/generate/props.rs | call genProps.setPPrChange | json |
| stripPPrChange | sync | docx-engine/src/generate/props.rs | call genProps.stripPPrChange | json |
| paraMarkRevisionXml | sync | docx-engine/src/generate/props.rs | call genProps.paraMarkRevisionXml | callback |
| setParaMarkRevision | sync | docx-engine/src/generate/props.rs | call genProps.setParaMarkRevision | json |
| stripParaMarkRevision | sync | docx-engine/src/generate/props.rs | call genProps.stripParaMarkRevision | json |
| resolveParaMarkRPrChange | sync | docx-engine/src/generate/props.rs | call genProps.resolveParaMarkRPrChange | json |
| paraMarkColor | sync | docx-engine/src/generate/props.rs | call genProps.paraMarkColor | json |
| stripParaMarkColor | sync | docx-engine/src/generate/props.rs | call genProps.stripParaMarkColor | json |
| patchFieldParagraphXml | sync | docx-engine/src/generate/text_patch.rs | call genText.patchFieldParagraphXml | json |
| patchImageParagraphXml | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.patchImageParagraphXml | json |
| patchMathTokens | sync | docx-engine/src/generate/text_patch.rs | call genText.patchMathTokens | json |
| patchTableCellTexts | sync | docx-engine/src/generate/text_patch.rs | call genText.patchTableCellTexts | class |
| patchTextboxHeights | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.patchTextboxHeights | json |
| patchTextboxParas | sync | docx-engine/src/generate/text_patch.rs | call genText.patchTextboxParas | json |
| patchTextboxSizes | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.patchTextboxSizes | json |
| patchShapeStyles | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.patchShapeStyles | json |
| patchDrawingExtent | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.patchDrawingExtent | json |
| buildLineParagraphXml | sync | docx-engine/src/generate/drawing_build.rs | call genDrawingBuild.buildLineParagraphXml | json |
| inlinePictureDrawingXml | sync | docx-engine/src/generate/drawing_build.rs | call genDrawingBuild.inlinePictureDrawingXml | json |
| resizeInlinePictureXml | sync | docx-engine/src/generate/drawing_patch.rs | call genDrawing.resizeInlinePictureXml | json |

#### chart

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| buildChartPartXml | sync | docx-engine/src/save/features/chart_write.rs | call save.buildChartPartXml | json |
| buildChartWorkbookXlsxBase64 | async | docx-engine/src/save/features/chart_write.rs | call save.buildChartWorkbookXlsxBase64 | json |
| patchChartWorkbookXlsxBase64 | async | docx-engine/src/save/features/chart_write.rs | call save.patchChartWorkbookXlsxBase64 | json |
| parseChartPartXml | sync | docx-engine/src/chart.rs | call chart.parseChartPartXml | json |
| patchChartPartXml | sync | docx-engine/src/save/features/chart_write.rs | call save.patchChartPartXml | json |
| lumHex | sync | docx-engine/src/chart.rs | call chart.lumHex | json |

#### math

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| latexToOmml | sync | omml/src/latex_to_omml.rs | call math.latexToOmml | json |
| mathParagraphXml | sync | omml/src/latex_to_omml.rs | call math.mathParagraphXml | json |
| mathTokensOf | sync | omml/src/fragments.rs | call math.mathTokensOf | json |
| ommlFragmentsOf | sync | omml/src/fragments.rs | call math.ommlFragmentsOf | json |
| ommlToLatex | sync | omml/src/omml_to_latex.rs | call math.ommlToLatex | json |
| ommlToMathML | sync | omml/omml_to_mathml | call math.ommlToMathML | json |

#### run-picture

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| patchHfPicturesXml | sync | docx-engine/src/save/save/run_picture.rs | call save.patchHfPicturesXml | json |
| patchRunPictureXml | sync | docx-engine/src/save/save/run_picture.rs | call save.patchRunPictureXml | json |

#### scan

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| scanBody | sync | docx-engine/src/scan.rs | blob ScanBody | json |

#### blank

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| buildBlankDocx | async | docx-engine/src/blank.rs | call blank.buildBlankDocx | bytes |
| customLevelFromNumberingLevel | sync | docx-engine/src/blank.rs | call blank.customLevelFromNumberingLevel | json |
| customLevelXml | sync | docx-engine/src/blank.rs | call blank.customLevelXml | json |
| mergeLevelXml | sync | docx-engine/src/blank.rs | call blank.mergeLevelXml | json |
| numberingLevelFromCustom | sync | docx-engine/src/blank.rs | call blank.numberingLevelFromCustom | json |
| paperSizeForLocale | sync | docx-engine/src/blank.rs | call blank.paperSizeForLocale | json |
| paperSizeForRegion | sync | docx-engine/src/blank.rs | call blank.paperSizeForRegion | json |

#### section

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| applySectionSettings | sync | docx-engine/src/save/save/section_write.rs | call save.applySectionSettings | json |
| applyPageNumType | sync | docx-engine/src/save/save/section_write.rs | call save.applyPageNumType | json |
| applySectionStartType | sync | docx-engine/src/save/save/section_write.rs | call save.applySectionStartType | json |
| applyTitlePg | sync | docx-engine/src/save/save/section_write.rs | call save.applyTitlePg | json |
| sectionFromSectPr | sync | docx-engine/src/section/read.rs | call section.sectionFromSectPr | json |
| readPageColor | sync | docx-engine/src/section/read.rs | call section.readPageColor | whole-model |
| readSections | sync | docx-engine/src/section/read.rs | call section.readSections | whole-model |
| readSectionSettings | sync | docx-engine/src/section/read.rs | call section.readSectionSettings | whole-model |
| sectionSettingsFromXml | sync | docx-engine/src/section/read.rs | call section.sectionSettingsFromXml | json |
| pageBordersXml | sync | docx-engine/src/save/save/section_write.rs | call save.pageBordersXml | json |
| notePropsFromXml | sync | docx-engine/src/section/read.rs | call section.notePropsFromXml | json |
| xmlFlagOn | sync | docx-engine/src/section.rs | call section.xmlFlagOn | json |

#### notes

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| nextNoteId | sync | docx-engine/src/notes.rs | call section.nextNoteId | json |
| parseNotesXml | sync | docx-engine/src/notes.rs | call section.parseNotesXml | json |

#### watermark

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| isPictureWatermark | sync | docx-engine/src/watermark.rs | call section.isPictureWatermark | json |
| pictureWatermarkPreviewImage | sync | docx-engine/src/watermark.rs | call section.pictureWatermarkPreviewImage | json |
| textWatermarkPreviewImage | sync | docx-engine/src/watermark.rs | call section.textWatermarkPreviewImage | json |
| textWatermarkBoxPt | sync | docx-engine/src/watermark.rs | call section.textWatermarkBoxPt | json |
| readPictureWatermark | sync | docx-engine/src/watermark.rs | call section.readPictureWatermark | json |
| readWatermarkText | sync | docx-engine/src/watermark.rs | call section.readWatermarkText | json |

#### style-upsert

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| builtInHeadingStyleUpsert | sync | docx-engine/src/save/parts/style_upsert.rs | call save.builtInHeadingStyleUpsert | json |
| mergeStyleXml | sync | docx-engine/src/save/parts/style_upsert.rs | call save.mergeStyleXml | json |
| mergeDefaultFontsXml | sync | docx-engine/src/save/parts/style_upsert.rs | call save.mergeDefaultFontsXml | json |
| pendingHeadingLevel | sync | docx-engine/src/save/parts/style_upsert.rs | call save.pendingHeadingLevel | Map, callback |

#### ink

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| anchoredInkRunXml | sync | docx-engine/src/ink.rs | call ink.anchoredInkRunXml | json |
| findInkRuns | sync | docx-engine/src/ink.rs | call ink.findInkRuns | json |
| injectInkRunsIntoParagraph | sync | docx-engine/src/ink.rs | call ink.injectInkRunsIntoParagraph | json |
| stripInkRuns | sync | docx-engine/src/ink.rs | call ink.stripInkRuns | json |

#### xml-number

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| usableNumber | sync | docx-engine/src/save/save/xml_number_usable.rs | call save.usableNumber | json |
| usablePictureSize | sync | docx-engine/src/save/save/xml_number_usable.rs | call save.usablePictureSize | json |
| usablePositionOffset | sync | docx-engine/src/save/save/xml_number_usable.rs | call save.usablePositionOffset | json |

#### xml-tag

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| removeElements | sync | docx-engine/src/xml_tag.rs | call xmltag.removeElements | json |

#### sources

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| bibliographyLine | sync | docx-engine/src/sources.rs | call docprops.bibliographyLine | json |
| citationText | sync | docx-engine/src/sources.rs | call docprops.citationText | json |
| parseSourcesXml | sync | docx-engine/src/sources.rs | call docprops.parseSourcesXml | json |

#### zotero-doc-props

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| parseZoteroDocumentDataXml | sync | docx-engine/src/doc_properties/zotero.rs | call docprops.parseZoteroDocumentDataXml | json |
| patchZoteroDocumentDataXml | sync | docx-engine/src/save/features/zotero_doc_props.rs | call save.patchZoteroDocumentDataXml | json |

#### theme

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| readThemeColors | sync | docx-engine/src/theme.rs | **NEW call route** (Rust port exists) | json |
| readThemeFonts | sync | docx-engine/src/theme.rs | **NEW call route** (Rust port exists) | json |

#### protection

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| hashProtectionPassword | async | docx-engine/src/protection.rs | call docprops.hashProtectionPassword | json |
| resolveSpinCount | sync | docx-engine/src/protection.rs | call docprops.resolveSpinCount | json |
| verifyProtectionPassword | async | docx-engine/src/protection.rs | call docprops.verifyProtectionPassword | json |

#### symbol-fonts

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| decodeSymbolChar | sync | docx-engine/src/symbol_fonts.rs | call markers.decodeSymbolChar | json |
| decodeSymbolText | sync | docx-engine/src/symbol_fonts.rs | call markers.decodeSymbolText | json |
| isSymbolFont | sync | docx-engine/src/symbol_fonts.rs | call markers.isSymbolFont | json |
| symbolGlyph | sync | docx-engine/src/symbol_fonts.rs | call markers.symbolGlyph | json |
| symbolPuaChar | sync | docx-engine/src/symbol_fonts.rs | call markers.symbolPuaChar | json |
| toSymbolPua | sync | docx-engine/src/symbol_fonts.rs | call markers.toSymbolPua | json |

#### list-markers

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| substituteBullet | sync | docx-engine/src/list_markers.rs | call markers.substituteBullet | json |
| markerFallbackFace | sync | docx-engine/src/list_markers.rs | call markers.markerFallbackFace | json |
| computeListMarkerInfos | sync | docx-engine/src/list_markers.rs | call markers.computeListMarkerInfos | Map |
| computeListMarkers | sync | docx-engine/src/list_markers.rs | **NEW call route** (Rust port exists) | Map |
| computeListValues | sync | docx-engine/src/list_markers.rs | call markers.computeListValues | Map |
| customEnumItems | sync | docx-engine/src/list_markers.rs | call markers.customEnumItems | json |
| formatNumber | sync | docx-engine/src/list_markers.rs | call markers.formatNumber | json |
| markerTabAdvance | sync | docx-engine/src/list_markers.rs | call markers.markerTabAdvance | json |

#### font-settings

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| previewFontSettings | async | docx-engine/src/save/features/index_exports.rs | **NEW call route** (Rust port exists) | Map, whole-model |

#### revision-xml

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| applyRevisionResolutions | sync | docx-engine/src/revision_xml.rs | call revision.applyRevisionResolutions | json |
| applyTrackedChangesXml | sync | docx-engine/src/revision_xml.rs | call revision.applyTrackedChangesXml | json |
| cleanMoveRangeMarkers | sync | docx-engine/src/revision_xml.rs | call revision.cleanMoveRangeMarkers | json |
| countTrackedChangesXml | sync | docx-engine/src/revision_xml.rs | call revision.countTrackedChangesXml | json |
| readPropChangeXml | sync | docx-engine/src/revision_xml.rs | call revision.readPropChangeXml | json |
| revisionDateBefore | sync | docx-engine/src/save/features/index_exports.rs | call save.revisionDateBefore | json |
| revisionDateMs | sync | docx-engine/src/revision_xml.rs | **NEW call route** (Rust port exists) | json |
| resolvePropChangeXml | sync | docx-engine/src/generate/table.rs | call revision.resolvePropChangeXml | json |

#### resolve-props

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| resolveParagraphProps | sync | docx-engine/src/resolve.rs | call resolve.resolveParagraphProps | XNode |
| resolveCtxOf | sync | docx-engine/src/resolve.rs | call resolve.resolveCtxOf | Map |
| resolveParagraphPropsXml | sync | docx-engine/src/resolve.rs | call resolve.resolveParagraphPropsXml | json |
| resolveRunProps | sync | docx-engine/src/resolve.rs | call resolve.resolveRunProps | XNode |
| shadowCompare | sync | docx-engine/src/resolve.rs | call resolve.shadowCompare | json |

#### compare

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| compareBlocks | sync | docx-engine/src/save/features/compare.rs | call save.compareBlocks | whole-model, Block[] |
| compareDocuments | async | docx-engine/src/save/features/compare.rs | blob CompareDocuments | whole-model |

#### parse-block-passes

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| keepsHangulKanaSingle | sync | docx-engine/src/block_passes.rs | **NEW call route** (Rust port exists) | json |

#### char-class

| export | TS | Rust home | wasm route | crossing |
|---|---|---|---|---|
| charClass | sync | docx-engine/src/char_class.rs | call charclass.charClass | json |
| isCjkLetterChar | sync | docx-engine/src/char_class.rs | call charclass.isCjkLetterChar | json |
| isDoubleByteChar | sync | docx-engine/src/char_class.rs | call charclass.isDoubleByteChar | json |
| isEastAsianChar | sync | docx-engine/src/char_class.rs | call charclass.isEastAsianChar | json |
| isEastAsianLangTag | sync | docx-engine/src/char_class.rs | call charclass.isEastAsianLangTag | json |
| isHangulChar | sync | docx-engine/src/char_class.rs | call charclass.isHangulChar | json |
| isLatinAlnumChar | sync | docx-engine/src/char_class.rs | call charclass.isLatinAlnumChar | json |
| textHasEastAsian | sync | docx-engine/src/char_class.rs | call charclass.textHasEastAsian | json |
| textHasHangulChars | sync | docx-engine/src/char_class.rs | call charclass.textHasHangulChars | json |

#### consts (35)

| const | Rust | binding |
|---|---|---|
| REDACT_EL | docx-engine/src/withheld.rs | TS literal kept; generated parity check |
| REDACT_NS | docx-engine/src/withheld.rs | TS literal kept; generated parity check |
| REDACT_PREFIX | docx-engine/src/withheld.rs | TS literal kept; generated parity check |
| CONTENT_CONTROL_LOCKS | docx-engine/src/save/features/content_control.rs | TS literal kept; generated parity check |
| DOCX_ZIP_LIMITS | NONE | TS literal kept; generated parity check |
| LAZY_MEDIA_SCHEME | docx-engine/src/lazy_media.rs | TS literal kept; generated parity check |
| EMPTY_EA_THEME_FONT | docx-engine/src/props/fonts.rs | TS literal kept; generated parity check |
| APP_PROPERTIES_PATH | docx-engine/src/blank.rs | TS literal kept; generated parity check |
| APP_PROPERTY_KEYS | NONE | TS literal kept; generated parity check |
| CORE_PROPERTIES_PATH | docx-engine/src/blank.rs | TS literal kept; generated parity check |
| CORE_PROPERTY_KEYS | NONE | TS literal kept; generated parity check |
| NEW_DOCUMENT_APPLICATION | docx-engine/src/blank.rs | TS literal kept; generated parity check |
| NEW_DOCUMENT_APP_VERSION | docx-engine/src/blank.rs | TS literal kept; generated parity check |
| NEW_DOCUMENT_TEMPLATE | docx-engine/src/blank.rs | TS literal kept; generated parity check |
| REMOVE_PARTS_KINDS | docx-engine/src/save/parts/remove_parts.rs | TS literal kept; generated parity check |
| TABLE_HEADER_FILL | docx-engine/src/generate/table.rs | TS literal kept; generated parity check |
| LINE_KINDS | NONE | TS literal kept; generated parity check |
| NEW_PICTURE_TOKEN_PREFIX | docx-engine/src/generate/drawing_build.rs | TS literal kept; generated parity check |
| colLetter | pptx-engine/src/chart_workbook.rs | TS literal kept; generated parity check |
| CHART_WORKBOOK_REL_TYPE | pptx-engine/src/chart_workbook.rs | TS literal kept; generated parity check |
| BLANK_BULLET_NUM_ID | docx-engine/src/blank.rs | TS literal kept; generated parity check |
| BLANK_ORDERED_NUM_ID | docx-engine/src/blank.rs | TS literal kept; generated parity check |
| DEFAULT_SECTION | docx-engine/src/section/read.rs | TS literal kept; generated parity check |
| LINE_BORDER_VALS | docx-engine/src/section/read.rs | TS literal kept; generated parity check |
| INK_NAME_PREFIX | docx-engine/src/ink.rs | TS literal kept; generated parity check |
| DEFAULT_PICTURE_PX | docx-engine/src/save/save/xml_number_usable.rs | TS literal kept; generated parity check |
| DEFAULT_SPIN_COUNT | docx-engine/src/protection.rs | TS literal kept; generated parity check |
| MAX_SPIN_COUNT | docx-engine/src/protection.rs | TS literal kept; generated parity check |
| SEGOE_UI_SYMBOL_RE | docx-engine/src/list_markers.rs | TS literal kept; generated parity check |
| DEFAULT_COMPARE_AUTHOR | docx-engine/src/save/features/compare.rs | TS literal kept; generated parity check |
| TEXT_EFFECTS | docx-engine/src/parse/text/build_run.rs | TS literal kept; generated parity check |
| EMPHASIS_MARKS | NONE | TS literal kept; generated parity check |
| TOTAL_PAGES_MARK | docx-engine/src/parse/tables/hf_fields.rs | TS literal kept; generated parity check |
| PAGE_MARK | docx-engine/src/parse/tables/hf_fields.rs | TS literal kept; generated parity check |
| SECTION_PAGES_MARK | docx-engine/src/parse/tables/hf_fields.rs | TS literal kept; generated parity check |
## Result of the render benchmark (main's decision 1)

`.github/workflows/seuoffice-bench.yml`: the web Docs app opens and lays out
the five largest tracked .docx in Chromium, built once with the wasm binding
and once with the frozen TypeScript engine (`SEUOFFICE_DOCX_ENGINE=ts`),
three alternating runs of five timed opens each; `compare.mjs` fails over 5%.

| head | binding | total change | run |
|---|---|---:|---|
| 811947eba | every export through wasm | +13.2% | 43271681210 |
| 308f88e16 | char-class predicates TypeScript only | +7.4% | 43326457815 |
| 197759de0 | and `tocLevelOf` sends only the style it names | +3.0% | 43333168620 |

Per document at 197759de0 (medians of 15 opens, ms):

| document | TypeScript | wasm | change |
|---|---:|---:|---:|
| e2e/assets/cover-photo-with-textboxes.docx | 977 | 975 | -0.2% |
| packages/docx2hwp/tests/fixtures/notice.docx | 947 | 994 | +5.0% |
| packages/docx2hwp/tests/fixtures/nested.docx | 930 | 992 | +6.7% |
| packages/docx2hwp/tests/fixtures/deep.docx | 991 | 976 | -1.5% |
| packages/docx2hwp/tests/fixtures/tabs.docx | 930 | 980 | +5.4% |
| total | 4775 | 4917 | +3.0% |

What the profile found (per-function call counts and time in the page, run
43330322662, and a 256 KiB collab edit in apps/docs tests):

- `isEastAsianChar`, `isHangulChar`, `isCjkLetterChar` and the other
  char-class predicates are called per character by the layout (12.6
  million `isEastAsianChar` calls in one test, about 4 us each through the
  binding). They stay TypeScript only (`HOT_PER_CHARACTER` in
  `tools/docx-diff/binding/overrides.ts`): charClass, isHangulChar,
  isEastAsianChar, isDoubleByteChar, isCjkLetterChar, isLatinAlnumChar,
  textHasEastAsian, textHasHangulChars, isEastAsianLangTag. The Rust
  copies without a Rust caller are deleted with their gate specs
  (is_hangul_char, is_cjk_letter_char, is_latin_alnum_char,
  text_has_east_asian, text_has_hangul_chars; is_east_asian_char is private
  now). `char_class`, `is_double_byte_char` and `is_east_asian_lang_tag`
  stay in Rust because the engine itself calls them (block_passes.rs,
  hf_paras.rs); their exports are TypeScript, so each is implemented once
  per side of the boundary, and the gate keeps comparing the two.
- `tocLevelOf` took 560-600 ms per document: docStyleCss asks once per
  paragraph style and each call carried the whole style map. The binding
  now sends only the style it names; the export stays in Rust.
