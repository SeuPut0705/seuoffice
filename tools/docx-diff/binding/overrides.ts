// What the manifest cannot read from the two signatures: the hand decisions of
// the binding. Every entry names its reason; an export that is in none of
// these tables and whose Rust port matches its TypeScript signature one to
// one gets a generated row without a word here.

export interface Override {
  /** the export stays TypeScript, for this reason */
  reject?: string
  /** a dedicated blob command answers it: the wrapper is in engine-hand.ts */
  command?: true
  /** a hand wrapper in engine-hand.ts answers it (several calls, a zip, a loop) */
  hand?: true
  /**
   * The TypeScript expressions of the wire arguments, where they are not the
   * parameters one to one. `$now` is the clock in ms, `$nowIso` its ISO text.
   */
  args?: string[]
  /** The statements that are the TypeScript body of the function, where the call is not one line (a mutated argument, a Set written back) */
  body?: string
  /** The body of the row, where the Rust function is not called with the arguments one to one. `args` is `Args` (the positional `&[Value]` with long texts read in place by `rstr`/`opt`), `env` the InvokeEnv. */
  rust?: string
  /** a parameter is a function the engine calls back, under a type name that does not say so */
  callbacks?: true
}

/** The 21 exports whose hand routes PortParseText wrote in crates/office-wasm/src/invoke/routes.rs. */
export const ROUTES_HAND: Readonly<Record<string, true>> = {
  deobfuscateOdttf: true,
  isSfnt: true,
  sfntLineMetrics: true,
  parseFontTable: true,
  readEmbeddedFonts: true,
  paraCsFormat: true,
  styleRunFormat: true,
  assertZipInflatesWithinLimits: true,
  isLazyMediaPart: true,
  lazyMediaUrl: true,
  newDocumentAppPropertiesXml: true,
  newDocumentCorePropertiesXml: true,
  w3cdtfStamp: true,
  findChartWorkbookPath: true,
  readDocxPartBase64: true,
  readThemeColors: true,
  readThemeFonts: true,
  computeListMarkers: true,
  previewFontSettings: true,
  revisionDateMs: true,
  keepsHangulKanaSingle: true,
}

/** A callback of the host as a Rust closure: an error is kept, the first one, and thrown once the call returns. */
const CALL_BACK = `let host = &*env;
        let failed: std::cell::RefCell<Option<String>> = std::cell::RefCell::new(None);
        let ask = |name: &str, arguments: Value| -> Value {
            host.callback(name, &arguments).unwrap_or_else(|error| {
                failed.borrow_mut().get_or_insert(error);
                Value::Null
            })
        };`

const FAILED = `if let Some(error) = failed.into_inner() {
            return Err(error);
        }`

export const OVERRIDES: Record<string, Override> = {
  // ---- the three whole-document commands: model JSON and blobs, not positional JSON
  parseDocx: { command: true },
  saveDocx: { command: true },
  compareDocuments: { command: true },
  scanBody: { command: true },

  // ---- the clock and entropy the engine has not: the host supplies them as arguments
  buildBlankDocx: { args: ['options ?? {}', '$now'] },
  buildChartWorkbookXlsxBase64: { args: ['categories', 'series', '$now'] },
  patchChartWorkbookXlsxBase64: { args: ['base64', 'categories', 'series', '$now'] },
  // ---- a whole document where the Rust reads the part of it that it needs
  readSections: {
    args: [
      'parsed.blocks.map((b) => ({ hidden: b.hidden, originalXml: b.originalXml, docxIndex: b.docxIndex }))',
      'parsed.gutterAtTop',
    ],
  },
  readSectionSettings: {
    args: [
      'parsed.blocks.map((b) => ({ hidden: b.hidden, originalXml: b.originalXml, docxIndex: b.docxIndex }))',
      'parsed.gutterAtTop',
    ],
  },
  readPageColor: { args: ['parsed.internal.documentXml'] },
  compareBlocks: {
    args: [
      'original.blocks',
      'revised.blocks',
      'revised.internal.documentXml',
      'options ?? {}',
      '$nowIso',
    ],
    rust: `let original: Vec<docx_engine::model::Block> = req(args, 0)?;
        let revised: Vec<docx_engine::model::Block> = req(args, 1)?;
        let xml: String = req(args, 2)?;
        let options = docx_engine::save::features::compare::CompareOptions::from_json(args.get(3));
        let now: String = req(args, 4)?;
        put(docx_engine::save::features::compare::compare_block_lists(&original, &revised, &xml, &options, &now))`,
  },
  parsePropertyChanges: {
    rust: `let input: Value = req(args, 0)?;
        put(docx_engine::save::features::doc_properties_write::parse_property_changes(&input)?.to_json())`,
  },
  loadDocxZip: { reject: 'returns a JSZip (a host object)' },
  assertZipWithinLimits: {
    reject:
      'stays TypeScript and engine-free: it reads the sizes of the entries of a JSZip (file-parse and the shell call it without an engine)',
  },
  xmlSegments: {
    reject:
      'the Rust port counts UTF-8 bytes, this export UTF-16 units: offsets of a text with non-ASCII characters differ',
  },
  // ---- protection: a spin count is any JSON value, as `unknown` in the TypeScript
  hashProtectionPassword: {
    args: ['password', 'spinCount', 'globalThis.crypto.getRandomValues(new Uint8Array(16))'],
    rust: `let password: String = req(args, 0)?;
        let spin = spin_count(args.get(1));
        let salt = env.blob(args.get(2).unwrap_or(&Value::Null))?;
        put(docx_engine::protection::hash_protection_password(&password, &spin, salt).map_err(|error| error.to_string())?)`,
  },
  verifyProtectionPassword: {
    rust: `let password: String = req(args, 0)?;
        let record = args.get(1).ok_or("TypeError: protection is missing")?;
        let record = docx_engine::protection::ProtectionRecord {
            hash: field(record, "hash")?,
            salt: field(record, "salt")?,
            spin_count: spin_count(record.get("spinCount")),
            algorithm_sid: field(record, "algorithmSid")?,
        };
        put(docx_engine::protection::verify_protection_password(&password, &record).map_err(|error| error.to_string())?)`,
  },
  resolveSpinCount: {
    rust: `put(jscompat::JsNum(docx_engine::protection::resolve_spin_count(&spin_count(args.first())).map_err(|error| error.to_string())?))`,
  },
  // the zip and the converter callback are the engine's own: the parts cross, the converter is the host's registry
  altChunkToDocx: { args: ['zip', 'rels', 'rId', 'sourcePath'] },
  rawElements: { reject: 'returns a RawTree (a borrowed tree of the engine) that is no JSON' },
  // ---- parameters the engine owns: a ContentControlPart is made and finished in Rust, a paragraph reader is the standalone one
  patchTableCellTexts: { args: ['tableXml', 'texts'] },
  generateTableModelXml: {
    args: ['model', 'originalTableXml'],
    rust: `let model: docx_engine::model::TableModel = req(args, 0)?;
        let original: Option<String> = opt(args, 1)?;
        put(docx_engine::generate::table::generate_table_model_xml(&model, original.as_deref(), None).map_err(|error| error.to_string())?)`,
  },
  // the reader: none (plain text), the standalone one (read in the engine, no
  // call back), or the caller's own (called back for each paragraph)
  parseNotesXml: {
    args: [
      'xml',
      'kind',
      "read === undefined ? null : Symbol.for('seuoffice.standaloneNoteReader') in read ? 'standalone' : read",
    ],
    callbacks: true,
    rust: `let xml: String = req(args, 0)?;
        let kind: docx_engine::notes::NoteKind = req(args, 1)?;
        match args.get(2) {
            None | Some(Value::Null) => put(docx_engine::notes::parse_notes_xml(&xml, kind)),
            Some(Value::String(standalone)) if standalone == "standalone" => {
                put(docx_engine::parse::text::notes_part::parse_notes_standalone(&xml, kind).map_err(|error| error.to_string())?)
            }
            Some(_) => {
                let host = &*env;
                let mut read = |p_xml: &str| -> Result<docx_engine::notes::NoteParagraph, String> {
                    let answer = host.callback("read", &json!([p_xml]))?;
                    serde_json::from_value(answer).map_err(|error| format!("TypeError: read: {error}"))
                };
                put(docx_engine::notes::parse_notes_xml_with(&xml, kind, &mut read)?)
            }
        }`,
  },
  resolveRunProps: { args: ['xnodeArg(rPr)', 'para.styleId', '!!para.bidi', 'ctx', 'mark'] },
  // ---- an optional TypeScript parameter the Rust port takes as a plain value, or an options object it takes field by field
  buildChartPartXml: { args: ['chart', "externalDataRId ?? ''"] },
  decodeSymbolText: { args: ['font', 'text', '!!opts?.textGlyphsOnly'] },
  patchParagraphTexts: { args: ['entryXml', 'newText', '!!opts.stripFirstParaLeadingSpace'] },
  sectionSettingsFromXml: { args: ['xml', 'opts.gutterAtTop'] },
  rootAttributes: { args: ['originalXml', 'rootTag', 'fallback', 'Object.entries(required)'] },
  resolveParagraphProps: { args: ['xnodeArg(pPr)', 'ctx', 'opts ?? {}'] },
  resolveParagraphPropsXml: { args: ['xml', 'ctx', 'opts ?? {}'] },
  removeElements: { args: ['xml', 'name', 'Number.isFinite(limit) ? limit : null'] },
  // `unknown` in the TypeScript, which answers undefined for anything not a number: so does NaN in the port
  usableNumber: { args: ["typeof value === 'number' ? value : NaN", 'emuPerUnit'] },
  usablePositionOffset: { args: ["typeof value === 'number' ? value : NaN", 'emuPerUnit'] },
  // a Pick<> of a model type: the fields the builder does not read cross as placeholders
  anchoredInkRunXml: { args: ["{ blockIndex: 0, base64: '', ...ink }", 'rId', 'docPrId'] },
  // ---- a Rust tuple where the TypeScript answers an object
  mergeRecords: {
    body: `const [merged, cursor] = invoke('mergeRecords', [blocks, data, startIndex]) as [Block[], MergeCursorState]
  return { blocks: merged, cursor }`,
  },
  usablePictureSize: {
    body: `const [w, h] = invoke('usablePictureSize', [
    typeof widthPx === 'number' ? widthPx : NaN,
    typeof heightPx === 'number' ? heightPx : NaN,
  ]) as [number, number]
  return { widthPx: w, heightPx: h }`,
  },
  splitXmlChildren: {
    body: `return (invoke('splitXmlChildren', [xml]) as Array<[string, string]>).map(([name, child]) => ({ name, xml: child }))`,
  },
  // the route reads three fields of the document, not the whole model
  previewFontSettings: {
    args: [
      '{ originalBytes: parsed.internal.originalBytes, themeColors: parsed.themeColors, themeFonts: parsed.themeFonts }',
      'upserts',
      'defaults',
    ],
  },
  // ---- functions of the caller the engine calls back (synchronous, for the length of the call)
  generateParagraphXml: {
    args: ['block', '{ ...ctx, part: undefined }'],
    rust: `let block: docx_engine::model::GeneratedBlock = req(args, 0)?;
        let ctx = args.get(1).ok_or("TypeError: ctx is missing")?;
        let heading: docx_engine::model::MapEntries<jscompat::JsNum, String> = field(ctx, "headingStyleIds")?.ok_or("TypeError: ctx.headingStyleIds is missing")?;
        let list_style: Option<String> = field(ctx, "listParagraphStyleId")?;
        let has = |key: &str| ctx.get(key).is_some_and(|value| !value.is_null());
        ${CALL_BACK}
        let mut hyperlink = |href: &str| -> String {
            match ask("allocateHyperlinkRel", json!([href])) {
                Value::String(rel) => rel,
                other => other.to_string(),
            }
        };
        let mut bookmark = |name: &str| -> f64 { ask("allocateBookmarkId", json!([name])).as_f64().unwrap_or(f64::NAN) };
        let mut revision = || -> String {
            match ask("allocateRevisionId", json!([])) {
                Value::String(id) => id,
                other => other.to_string(),
            }
        };
        let xml = {
            let mut context = docx_engine::generate::paragraph::GenerateContext {
                heading_style_ids: &heading,
                list_paragraph_style_id: list_style.as_deref(),
                allocate_hyperlink_rel: &mut hyperlink,
                allocate_bookmark_id: if has("allocateBookmarkId") { Some(&mut bookmark) } else { None },
                allocate_revision_id: if has("allocateRevisionId") { Some(&mut revision) } else { None },
                part: None,
            };
            docx_engine::generate::paragraph::generate_paragraph_xml(&block, &mut context)?
        };
        ${FAILED}
        put(xml)`,
  },
  paraMarkRevisionXml: {
    rust: `let kind: String = req(args, 0)?;
        let record: Option<String> = opt(args, 1)?;
        ${CALL_BACK}
        let mut mint = || -> String {
            match ask("mintId", json!([])) {
                Value::String(id) => id,
                other => other.to_string(),
            }
        };
        let xml = docx_engine::generate::props::para_mark_revision_xml(&kind, record.as_deref(), &mut mint);
        ${FAILED}
        put(xml)`,
  },
  pendingHeadingLevel: {
    rust: `let id: String = req(args, 0)?;
        let seen_in: Vec<String> = opt(args, 3)?.unwrap_or_default();
        let mut seen: std::collections::HashSet<String> = seen_in.into_iter().collect();
        ${CALL_BACK}
        let pending = |style: &str| -> Option<docx_engine::save::parts::style_upsert::StyleUpsert> {
            serde_json::from_value(ask("pending", json!([style]))).unwrap_or(None)
        };
        let existing = |style: &str| -> Option<docx_engine::save::parts::style_upsert::StyleHeadingInfo> {
            serde_json::from_value(ask("existing", json!([style]))).unwrap_or(None)
        };
        let level = docx_engine::save::parts::style_upsert::pending_heading_level(&id, &pending, &existing, &mut seen);
        ${FAILED}
        put(level)`,
  },
  // ---- node file and zip I/O over objects (ZipFile, ByteSource, Buffer): it is the host side of the package
  slimDocx: { reject: 'takes a ZipFile object (a file handle of the host)' },
  writeZip: { reject: 'returns a Node Buffer, which callers use as one' },
  readZipEntries: { reject: 'reads through a ByteSource object (a file handle of the host)' },
  materializeDocx: { reject: 'calls back for a ZipFile object' },
  // ---- functions that write into an argument: the engine answers the argument again, the wrapper writes it back
  // the engine reads and writes the cells' colSpan alone: only the spans cross (a TableCell is large in the engine)
  reconcileGridColumns: {
    args: ['rows.map((row) => row.map((cell) => cell.colSpan))', 'rowTcws', 'gridCols'],
    rust: `let spans: Vec<Vec<Option<jscompat::JsNum>>> = req(args, 0)?;
        let row_tcws: Vec<Vec<Option<jscompat::JsNum>>> = req(args, 1)?;
        let grid_cols: Option<Vec<jscompat::JsNum>> = opt(args, 2)?;
        match docx_engine::parse::tables::reconcile_grid_spans(&spans, &row_tcws, grid_cols.as_deref())? {
            None => Ok(None),
            Some((spans, widths)) => Ok(Some(json!({ "widths": to_json(&widths)?, "spans": spans }))),
        }`,
    body: `const r = invoke('reconcileGridColumns', [rows.map((row) => row.map((cell) => cell.colSpan)), rowTcws, gridCols]) as { widths: number[]; spans: number[][] } | null
  if (!r) return undefined
  rows.forEach((row, i) =>
    row.forEach((cell, c) => {
      const span = r.spans[i]![c]!
      if (span > 1) cell.colSpan = span
      else delete cell.colSpan
    }),
  )
  return r.widths`,
  },
  // the blocks are written back key by key: a caller keeps its references to them
  applyProtectedLeadingBreaks: {
    rust: `let mut blocks: Vec<docx_engine::model::Block> = req(args, 0)?;
        {{path}}(&mut blocks).map_err(|error| error.to_string())?;
        put(blocks)`,
    body: `const done = invoke('applyProtectedLeadingBreaks', [blocks]) as typeof blocks
  blocks.forEach((block, i) => {
    const next = done[i]! as unknown as Record<string, unknown>
    const held = block as unknown as Record<string, unknown>
    for (const key of Object.keys(held)) if (!(key in next)) delete held[key]
    Object.assign(held, next)
  })`,
  },
  // a reader that works on its own, and that parseNotesXml recognizes to read in the engine without calling back
  standaloneNoteParagraphReader: {
    rust: `let p_xml: String = req(args, 0)?;
        put(docx_engine::parse::text::notes_part::read_note_paragraph_standalone(&p_xml).map_err(|error| error.to_string())?)`,
    body: `const read = ((pXml: string) => invoke('standaloneNoteParagraphReader', [pXml])) as NoteParagraphReader
  return Object.assign(read, { [Symbol.for('seuoffice.standaloneNoteReader')]: true })`,
  },
  inlineRunsXml: {
    args: ['runs', 'options'],
    rust: `let runs: Vec<docx_engine::model::Run> = req(args, 0)?;
        let written: Vec<String> = opt(args, 1)?.unwrap_or_default();
        let fragments: Vec<(usize, String)> = opt(args, 2)?.unwrap_or_default();
        let mut options = docx_engine::generate::runs::RunsXmlOptions {
            written: written.into_iter().collect(),
            fragments: fragments.into_iter().collect(),
            part: None,
        };
        let xml = docx_engine::generate::runs::inline_runs_xml_with(&runs, &mut options).map_err(|error| error.to_string())?;
        let mut written: Vec<String> = options.written.into_iter().collect();
        written.sort();
        Ok(Some(json!({ "xml": xml, "written": written })))`,
    body: `const written = options?.written
  const fragments = options?.fragments ? [...options.fragments].map(([run, xml]) => [runs.indexOf(run), xml]) : undefined
  const done = invoke('inlineRunsXml', [runs, written ? [...written] : undefined, fragments]) as { xml: string; written: string[] }
  for (const id of done.written) written?.add(id)
  return done.xml`,
  },
}

/** Text added to the end of a module: what the binding's host side reads from it. */
export const APPEND: Readonly<Record<string, string>> = {
  'alt-chunk': `/** the converter the host installed, for the engine's alt-chunk pass (engine-hand.ts) */
export function altChunkHtmlConverter(): AltChunkHtmlConverter | null {
  return htmlConverter
}`,
}

/** The modules that are the host side of the package: they stay TypeScript, engine-free, whatever a port exists for. */
export const HOST_MODULES: Readonly<Record<string, true>> = {
  'xml-utils': true,
  metafile: true,
  tiff: true,
  'zip-splice': true,
}

/** The override of an export: a name like `valueOf` is no key of the table. */
export function overrideOf(name: string): Override | undefined {
  return Object.hasOwn(OVERRIDES, name) ? OVERRIDES[name] : undefined
}

export function isHandRoute(name: string): boolean {
  return Object.hasOwn(ROUTES_HAND, name)
}

/** Modules of the reference that the binding does not carry: nothing in the product or the tests imports them. */
export const UNUSED_MODULES: Readonly<Record<string, string>> = {
  'own-value': 'its one user was the codec, which @seuoffice/engine-wasm holds now',
  'hf-root': 'a type no module imports',
}
