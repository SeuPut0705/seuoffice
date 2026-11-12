// What the manifest cannot read from the two signatures of a pptx export: the
// hand decisions of the pptx binding (crates/pptx-engine/C2-PLAN.md). The
// shape of an entry is B4's `Override` (tools/docx-diff/binding/overrides.ts).
// An export in none of these tables whose Rust port takes its arguments one to
// one gets a generated wrapper and row without a word here; where the Rust
// signature differs, tools/pptx-diff/binding/inventory/mismatch.md says how.
//
// In `body`, `$call(a, b, ...)` is the engine call of this export with those
// wire arguments, and a bare `$call` the call with the TypeScript parameters; the generator writes the arguments the engine changes
// (from the Rust `&mut` parameters) and the reply shape into it. Helpers of
// packages/pptx-engine/src/engine.ts: `slideIndex(opened, slide)` is the index
// of a slide of the opened deck.
//
// Rust parameters the TypeScript has not are filled by the row by name, not
// here: `uuid: &str` is `jscompat::random_uuid()`, a `&mut dyn FnMut() ->
// String` uuid source draws the same, `now_ms`/`now: f64` is the host's clock,
// `uids: &Uids` the instance's id counter.
//
// Where a Rust parameter is not one a row reads from JSON (a borrowed struct, a
// closure), the override says how the row passes it (`pass`, with the `lines`
// that make it) and how the row ends (`ret`); `rust` writes the whole row.
// The Rust helpers they call are in crates/office-wasm/src/invoke/pptx_routes.rs.
import type { Override as DocxOverride } from '../../docx-diff/binding/overrides'

export interface PptxOverride extends DocxOverride {
  /** Rust expressions that pass a parameter the row cannot read, by position among the Rust parameters */
  pass?: Readonly<Record<number, string>>
  /** Rust statements between reading the parameters and the call */
  lines?: string
  /** Rust that ends the row: `r` is what the port returned, `p0`.. the arguments, `{{out}}` the list of arguments it changed */
  ret?: string
}

export type Override = PptxOverride

/** The exports that stay TypeScript: no engine call, the module keeps them as they are. */
export const PPTX_TS_ONLY: Readonly<Record<string, string>> = {
  savePptxToFile:
    'the engine has no file system: savePptx gives the bytes and the host streams them to the file (written in APPEND)',
  ownValue: 'a JavaScript-object helper the host code of pptx-ops calls on its own tables; Rust has its own over JsMap',
  setOwn: 'the same, writing a key of a JavaScript object',
  xmlParser: 'answers a fast-xml-parser instance the host parses with; the engine parses inside each call',
  sfntCmapLookup: 'answers a function (cp) => boolean, which cannot cross; only tests call it',
}

const slideOf = (opened: string): string => `const i = $call as number | null\n  return i === null ? null : ${opened}.deck.slides[i]!`
const withSlide = (index: string, key: string): string =>
  `const v = $call; return v === null ? null : { slide: opened.deck.slides[${index}]!, ${key}: v }`

export const PPTX_OVERRIDES: Record<string, PptxOverride> = {
  // ---- the deck as a whole: async in TypeScript, sync in Rust
  openPptx: {
    body: `const o = $call(bytes) as { deck: SlideDeck; archive: Parameters<typeof PackageArchive.fromWire>[0] }
  return { deck: o.deck, archive: PackageArchive.fromWire(o.archive) }`,
    rust: `let bytes = env.blob(at(args, 0))?;
    let opened = {{path}}(bytes)?;
    let value = pptx::answer_new_opened(env, &opened)?;
    Ok(Some(pptx::answer(Some(value), Vec::new())))`,
  },
  savePptx: { body: 'return $call(opened)' },
  reparseDeck: { body: '$call(opened)\n  return opened' },

  // ---- a Slide of the opened deck: the engine takes its index
  setSlideBackground: { body: '$call(opened, slideIndex(opened, slide), fill)' },
  resetSlideBackground: { body: '$call(opened, slideIndex(opened, slide))' },
  setSlideBgGraphicsHidden: { body: '$call(opened, slideIndex(opened, slide), hidden)' },
  setElementFill: { body: 'return $call(opened, slideIndex(opened, slide), elementId, fill, opts)' },
  replacePictureBytes: {
    body: 'return $call(opened, slideIndex(opened, slide), sourceId, bytes, ext, opts?.keepSrcRect ?? false)',
  },
  copyElementData: {
    body: 'const at = slideIndex(opened, slide)\n  return $call(opened, at, opened.deck.slides[at]!.elements.indexOf(el))',
  },
  addImageMediaAndRel: { body: 'return $call(opened, slideIndex(opened, slide), bytes, extRaw)' },
  deleteElement: { body: 'return $call(opened, slideIndex(opened, slide), elementId)' },
  setModel3dView: { body: 'return $call(opened, slideIndex(opened, slide), elementId, view)' },
  cleanupSupersededSlideResources: {
    body: 'return $call(opened, slideIndex(opened as never, slide), previousXml, currentXml)',
  },

  // ---- the engine answers an index or an id; the TypeScript answered the object in the deck
  duplicateSlide: { body: slideOf('opened') },
  pasteSlide: { body: slideOf('opened') },
  insertBlankSlide: { body: slideOf('opened') },
  insertSlideWithLayout: { body: slideOf('opened') },
  setSlideLayout: { body: slideOf('opened') },
  resetSlideLayout: { body: slideOf('opened') },
  mergeSlideFromSource: { body: slideOf('target') },
  mergeSlideFromPptx: { body: slideOf('target') },
  materializeSlide: { body: 'return $call(opened, slideIndex) ? opened.deck.slides[slideIndex]! : null' },
  ungroupElement: { body: 'return $call(opened, slideIndex, sourceId) ? opened.deck.slides[slideIndex]! : null' },
  setElementLink: {
    body: 'return $call(opened, slideIndex, elementId, target) ? opened.deck.slides[slideIndex]! : null',
  },
  appendRawElements: { body: withSlide('slideIndex', 'elementIds') },
  addTable: { body: withSlide('slideIndex', 'elementId') },
  editTableStructure: { body: withSlide('slideIndex', 'elementId') },
  mergeTableCells: { body: withSlide('slideIndex', 'elementId') },
  pasteElements: { body: withSlide('slideIndex', 'elementIds') },
  groupElements: { body: withSlide('slideIndex', 'groupId') },
  addChart: { body: withSlide('slideIndex', 'elementId') },
  addMedia: { body: withSlide('slideIndex', 'elementId') },
  addModel3d: { body: withSlide('slideIndex', 'elementId') },
  addNarration: { body: withSlide('slideIndex', 'elementId') },
  addSmartArt: {
    body: 'const v = $call as { elementId?: string } | null\n  return v === null || v.elementId === undefined ? null : { slide: opened.deck.slides[slideIndex]!, elementId: v.elementId }',
  },
  addElement: { body: '$call(slide, opts)\n  return slide.elements.at(-1) as TextElement' },
  findGroupChild: {
    body: 'const at = $call as [number, number] | null\n  if (at === null) return null\n  const grp = slide.elements[at[0]] as GroupElement\n  return { grp, child: grp.children[at[1]]! }',
  },

  // ---- the clock the engine has not
  addSlideComment: { body: 'return $call(opened, slideIndex, opts, $nowIso)' },

  // ---- the TypeScript takes the opened deck, the Rust the parts it needs
  applyThemeToArchive: { body: 'return $call(opened.archive, spec)' },
  remapDeckColors: { body: 'return $call(opened.archive, opened.deck, spec)' },

  // ---- the deck where the Rust takes its slides
  editedGlyphDemand: { args: ['deck.slides'] },
  stripStaleEmbeddedFonts: { args: ['deck.slides', 'archive'] },

  // ---- the media bytes of these arguments are number lists in the Rust model, text in the binding
  setSlideBackgroundImage: { body: 'return $call(opened, slideIndex(opened, slide), source, tile)', pass: { 2: '&p2' }, lines: 'let p2 = pptx_routes::byte_list(at(args, 2))?;' },
  setElementImageFill: { body: 'return $call(opened, slideIndex(opened, slide), elementId, source, opts)', pass: { 3: '&p3' }, lines: 'let p3 = pptx_routes::byte_list(at(args, 3))?;' },
  addPicture: {
    body: 'const at = slideIndex(opened, slide)\n  return $call(opened, at, opts) === null ? null : (opened.deck.slides[at]!.elements.at(-1) as PictureElement)',
    pass: { 2: '&p2' },
    lines: 'let p2 = pptx_routes::byte_list(at(args, 2))?;',
  },

  // ---- a struct the model does not read from JSON
  chartWorkbookParts: { pass: { 0: '&data' }, lines: 'let data = pptx_routes::workbook_data(at(args, 0))?;' },
  chartWorkbookXlsx: { pass: { 0: '&data' }, lines: 'let data = pptx_routes::workbook_data(at(args, 0))?;' },
  groupChildSlices: {
    ret: `let slices: Vec<Value> = r?
        .iter()
        .map(|slice| {
            let mut out = json!({ "start": slice.start, "end": slice.end, "xml": slice.xml });
            if let Some(id) = &slice.nv_id {
                out["nvId"] = json!(id);
            }
            out
        })
        .collect();
    reply(slices)`,
  },

  // ---- a Rust value that is a function of two layers, an option or an iterator
  patchSlideTimingIncrementalXml: {
    ret: `match r {
        None => Ok(Some(pptx::answer(Some(Value::Null), Vec::new()))),
        Some(done) => reply(done?),
    }`,
  },
  tagHangulParagraphs: { body: 'return ($call as Paragraph[] | null) ?? paragraphs' },
  calcBoundingBox: {
    rust: `let elements: Vec<pptx_engine::types::SlideElement> = req(args, 0)?;
    reply({{path}}(elements.iter()))`,
  },
  collectExplicitColors: {
    rust: `let xmls: Vec<String> = req(args, 0)?;
    reply({{path}}(&xmls))`,
  },
  solidPng: {
    rust: `let w: u32 = req(args, 0)?;
    let h: u32 = req(args, 1)?;
    let rgb: [u8; 3] = req(args, 2)?;
    let png = {{path}}(w, h, rgb)?;
    Ok(Some(pptx::answer(Some(env.put_blob(png)), Vec::new())))`,
  },
  model3dPartOf: { args: ['el.descr'] },
  model3dXml: {
    pass: { 0: '&options' },
    lines: `let model: pptx_routes::Model3dArg = req(args, 0)?;
    let options = model.options();`,
  },
  assertZipWithinLimits: {
    body: `$call(
    Object.values(zip.files)
      .filter((f) => !f.dir)
      .map((f) => ({
        name: f.name,
        usize: (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
      })),
  )`,
    pass: { 0: '&files' },
    lines: `let declared = pptx_routes::declared_parts(at(args, 0))?;
    let files: Vec<ooxml_pkg::DeclaredPart<'_>> = declared.iter().map(|(name, size)| ooxml_pkg::DeclaredPart { name, usize: *size }).collect();`,
  },
  staleEmbeddedTypefaces: {
    pass: { 1: '&demand' },
    lines: 'let demand = pptx_routes::glyph_demand(at(args, 1))?;',
  },
  listEmbeddedFonts: {
    ret: `let faces = r?;
    let mut value = to_json(&faces)?;
    for (i, face) in faces.iter().enumerate() {
        value[i]["sfnt"] = env.put_blob(face.sfnt.clone());
    }
    Ok(Some(pptx::answer(Some(value), Vec::new())))`,
  },
  findTableElementInSlide: {
    body: 'const i = $call as number | null\n  return i === null ? null : (slide.elements[i] as never)',
    ret: `let found = r.and_then(|found| p0.elements.iter().position(|element| std::ptr::eq(element, found)));
    reply(found)`,
  },
  layoutHierTree: {
    body: `const r = $call as {
    boxes: Array<{ node: number; x: number; y: number; w: number; h: number }>
    lines: Array<{ x: number; y: number; cx: number; cy: number; to?: number }>
    boxW: number
  } | null
  if (r === null) return null
  const nodes: HierTreeNode[] = []
  const walk = (list: HierTreeNode[]): void => {
    for (const node of list) {
      nodes.push(node)
      walk(node.children)
    }
  }
  walk(roots)
  return {
    boxes: r.boxes.map((b) => ({ ...b, node: nodes[b.node]! })),
    lines: r.lines.map((l) => (l.to === undefined ? { x: l.x, y: l.y, cx: l.cx, cy: l.cy } : { ...l, to: nodes[l.to]! })),
    boxW: r.boxW,
  }`,
    ret: `fn walk<'n>(list: &'n [pptx_engine::dgm_hier::HierTreeNode], into: &mut Vec<&'n pptx_engine::dgm_hier::HierTreeNode>) {
        for node in list {
            into.push(node);
            walk(&node.children, into);
        }
    }
    let Some(layout) = r else {
        return Ok(Some(pptx::answer(Some(Value::Null), Vec::new())));
    };
    let mut nodes = Vec::new();
    walk(&p0, &mut nodes);
    let place = |node: &pptx_engine::dgm_hier::HierTreeNode| nodes.iter().position(|other| std::ptr::eq(*other, node));
    let boxes: Vec<Value> = layout
        .boxes
        .iter()
        .map(|b| json!({ "node": place(b.node), "x": to_json(&b.x).unwrap_or(Value::Null), "y": to_json(&b.y).unwrap_or(Value::Null), "w": to_json(&b.w).unwrap_or(Value::Null), "h": to_json(&b.h).unwrap_or(Value::Null) }))
        .collect();
    let lines: Vec<Value> = layout
        .lines
        .iter()
        .map(|l| {
            let mut line = json!({ "x": to_json(&l.x).unwrap_or(Value::Null), "y": to_json(&l.y).unwrap_or(Value::Null), "cx": to_json(&l.cx).unwrap_or(Value::Null), "cy": to_json(&l.cy).unwrap_or(Value::Null) });
            if let Some(index) = l.to.and_then(&place) {
                line["to"] = json!(index);
            }
            line
        })
        .collect();
    reply(json!({ "boxes": boxes, "lines": lines, "boxW": to_json(&layout.box_w)? }))`,
  },

  // ---- a parse context the row builds from the ParseContext the TypeScript passes
  parseSlide: {
    pass: { 0: 'pptx_engine::parse::SlideParseInput { path: &path, slide_xml: &slide_xml, layout_path: layout_path.as_deref(), master_path: master_path.as_deref(), ctx: data.context(&uids) }' },
    lines: `let input = at(args, 0);
    let path: String = field(input, "path")?.ok_or("TypeError: input.path is missing")?;
    let slide_xml: String = field(input, "slideXml")?.ok_or("TypeError: input.slideXml is missing")?;
    let layout_path: Option<String> = field(input, "layoutPath")?;
    let master_path: Option<String> = field(input, "masterPath")?;
    let data: pptx_engine::parse::ParseContextData = field(input, "ctx")?.unwrap_or_default();
    let uids = pptx::uids();`,
    ret: `pptx::keep_uids(&uids);
    reply(r?)`,
  },
  parseBackground: {
    pass: { 1: '&data.context(&uids)' },
    lines: `let data: pptx_engine::parse::ParseContextData = opt(args, 1)?.unwrap_or_default();
    let uids = pptx::uids();`,
    ret: `pptx::keep_uids(&uids);
    reply(r)`,
  },
  parseDecorations: {
    pass: { 1: '&data.context(&uids)' },
    lines: `let data: pptx_engine::parse::ParseContextData = opt(args, 1)?.unwrap_or_default();
    let uids = pptx::uids();`,
    ret: `pptx::keep_uids(&uids);
    reply(r?)`,
  },
  layoutDiagramFallback: {
    pass: { 1: '&data.context(&uids)' },
    lines: `let data: pptx_engine::parse::ParseContextData = opt(args, 1)?.unwrap_or_default();
    let uids = pptx::uids();`,
    ret: `pptx::keep_uids(&uids);
    reply(r?)`,
  },
  parseLstStyleLevels: {
    pass: { 2: 'source.as_ref()' },
    lines: `let source_arg = at(args, 2);
    let media_rels: Option<jscompat::JsMap<String>> = field(source_arg, "mediaRels")?;
    let foreign_part: Option<bool> = field(source_arg, "foreignPart")?;
    let source = (!source_arg.is_null()).then(|| pptx_engine::placeholder::LstStyleSource { media_rels: media_rels.as_ref(), foreign_part: foreign_part.unwrap_or(false) });`,
  },

  // ---- the placeholder tables are read the way a ParseContext reads them
  resolvePlaceholderInsets: { pass: { 0: 'tables.layout_placeholders.as_ref()', 1: 'tables.master_placeholders.as_ref()' }, lines: 'let tables = pptx_routes::tables(at(args, 0), at(args, 1), None)?;' },
  resolvePlaceholderAnchor: { pass: { 0: 'tables.layout_placeholders.as_ref()', 1: 'tables.master_placeholders.as_ref()' }, lines: 'let tables = pptx_routes::tables(at(args, 0), at(args, 1), None)?;' },
  resolvePlaceholderAnchorCtr: { pass: { 0: 'tables.layout_placeholders.as_ref()', 1: 'tables.master_placeholders.as_ref()' }, lines: 'let tables = pptx_routes::tables(at(args, 0), at(args, 1), None)?;' },
  resolvePlaceholderTransform: { pass: { 0: 'tables.layout_placeholders.as_ref()', 1: 'tables.master_placeholders.as_ref()' }, lines: 'let tables = pptx_routes::tables(at(args, 0), at(args, 1), None)?;' },
  resolvePlaceholderPresetGeom: { pass: { 0: 'tables.layout_placeholders.as_ref()', 1: 'tables.master_placeholders.as_ref()' }, lines: 'let tables = pptx_routes::tables(at(args, 0), at(args, 1), None)?;' },
  resolvePlaceholderFillSpPr: { pass: { 0: 'tables.layout_placeholders.as_ref()', 1: 'tables.master_placeholders.as_ref()' }, lines: 'let tables = pptx_routes::tables(at(args, 0), at(args, 1), None)?;' },
  placeholderStyleChain: {
    pass: { 0: 'tables.layout_placeholders.as_ref()', 1: 'tables.master_placeholders.as_ref()', 2: 'tables.master_text_styles.as_ref()' },
    lines: 'let tables = pptx_routes::tables(at(args, 0), at(args, 1), Some(at(args, 2)))?;',
  },

  // ---- merging a slide: the options and the source the row builds
  mergeSlideFromPptx: {
    args: ['target', 'sourceBytes', '{ layoutFrom: opts?.layoutFrom?.path }'],
    body: slideOf('target'),
    pass: { 2: '&options' },
    lines: `let layout_from: Option<String> = field(at(args, 2), "layoutFrom")?;
    let options = pptx_engine::deck::MergeSlideOptions { layout_from: layout_from.as_deref() };`,
  },
  mergeSlideFromSource: {
    args: ['target', 'source', '{ layoutFrom: opts?.layoutFrom?.path }'],
    body: slideOf('target'),
    pass: { 1: '&source', 2: '&options' },
    lines: `let source = pptx_routes::merge_source(at(args, 1))?;
    let layout_from: Option<String> = field(at(args, 2), "layoutFrom")?;
    let options = pptx_engine::deck::MergeSlideOptions { layout_from: layout_from.as_deref() };`,
  },
  extractMergeSlideSource: {
    ret: `let Some(source) = r? else {
        return Ok(Some(pptx::answer(Some(Value::Null), Vec::new())));
    };
    let mut value = to_json(&source)?;
    for (i, media) in source.media.iter().enumerate() {
        value["media"][i]["bytes"] = env.put_blob(media.bytes.clone());
    }
    for (i, part) in source.layout_chain.iter().enumerate() {
        value["layoutChain"][i]["bytes"] = env.put_blob(part.bytes.clone());
        if let Some(rels) = &part.rels {
            value["layoutChain"][i]["rels"] = env.put_blob(rels.clone());
        }
    }
    Ok(Some(pptx::answer(Some(value), Vec::new())))`,
  },

  // ---- functions of the caller the engine calls back (synchronous, for the length of the call)
  parseChartXml: {
    pass: { 2: 'resolve_fill' },
    lines: `let ask = pptx_routes::Ask::new(env);
    let resolve = |node: Option<&Value>| -> Option<pptx_engine::types::Fill> { serde_json::from_value(ask.ask("resolveFill", json!([node]))).unwrap_or(None) };
    let resolve_fill: Option<&dyn Fn(Option<&Value>) -> Option<pptx_engine::types::Fill>> = if matches!(at(args, 2), Value::Object(_)) { Some(&resolve) } else { None };`,
    ret: `ask.finish()?;
    reply(r?)`,
  },
  setElementFont: {
    pass: { 3: 'size_map' },
    lines: `let ask = pptx_routes::Ask::new(env);
    let sizes = |size: Option<f64>| -> f64 { ask.ask("sizeMap", json!([size])).as_f64().unwrap_or(f64::NAN) };
    let size_map: Option<&dyn Fn(Option<f64>) -> f64> = if matches!(at(args, 3), Value::Object(_)) { Some(&sizes) } else { None };`,
    ret: `ask.finish()?;
    let value = to_json(&r?)?;
    Ok(Some(pptx::answer(Some(value), {{out}})))`,
  },
  setGroupChildFont: {
    pass: { 4: 'size_map' },
    lines: `let ask = pptx_routes::Ask::new(env);
    let sizes = |size: Option<f64>| -> f64 { ask.ask("sizeMap", json!([size])).as_f64().unwrap_or(f64::NAN) };
    let size_map: Option<&dyn Fn(Option<f64>) -> f64> = if matches!(at(args, 4), Value::Object(_)) { Some(&sizes) } else { None };`,
    ret: `ask.finish()?;
    let value = to_json(&r?)?;
    Ok(Some(pptx::answer(Some(value), {{out}})))`,
  },
  patchGroupChildXml: {
    args: ['grp', 'child.nvId', 'patch'],
    pass: { 2: 'patch' },
    lines: `let ask = pptx_routes::Ask::new(env);
    let patch = |xml: &str| -> Result<String, String> {
        match ask.ask("patch", json!([xml])) {
            Value::String(text) => Ok(text),
            _ => Err("the patch did not answer a string".to_owned()),
        }
    };`,
    ret: `ask.finish()?;
    let value = to_json(&r?)?;
    Ok(Some(pptx::answer(Some(value), {{out}})))`,
  },
}

/** The routes of the table that are no export: the methods of `PackageArchive`, which stays a JavaScript class. */
export const PPTX_HAND_ROUTES: Readonly<Record<string, string>> = {
  'PackageArchive.open': 'pptx_routes::package_archive_open',
  'PackageArchive.readRels': 'pptx_routes::package_archive_read_rels',
  'PackageArchive.readPresentation': 'pptx_routes::package_archive_read_presentation',
  'PackageArchive.resolveSlideChain': 'pptx_routes::package_archive_resolve_slide_chain',
}

/** Text added to the end of a module. */
export const PPTX_APPEND: Readonly<Record<string, string>> = {}

/** Pieces of a module whose text is written by hand: the class keeps its place and its exports. */
export const PPTX_REPLACE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  zip: {
    PackageArchive: `export class PackageArchive {
  private constructor(
    /** Original bytes of every entry, keyed by path inside the zip */
    readonly entries: Map<string, Uint8Array>,
    readonly originalHash: string,
  ) {}

  /** An archive from what the engine answers: its entries in order, and the hash of the original. */
  static fromWire(wire: { entries: Array<[string, Uint8Array]>; originalHash: string }): PackageArchive {
    return new PackageArchive(new Map(wire.entries), wire.originalHash)
  }

  static async open(bytes: Uint8Array): Promise<PackageArchive> {
    return PackageArchive.fromWire(call('PackageArchive.open', [bytes]) as never)
  }

  has(path: string): boolean {
    return this.entries.has(path)
  }

  /** Read a part as a UTF-8 string (for XML parts). */
  readText(path: string): string | null {
    const bytes = this.entries.get(path)
    if (!bytes) return null
    return Buffer.from(bytes).toString('utf8')
  }

  readBytes(path: string): Uint8Array | null {
    return this.entries.get(path) ?? null
  }

  /** The archive of the parts \`keep\` names: the engine reads these and not the media of the deck. */
  private parts(keep: (path: string) => boolean): PackageArchive {
    const entries = new Map([...this.entries].filter(([path]) => keep(path)))
    return new PackageArchive(entries, this.originalHash)
  }

  /**
   * Read a part's relationships file. partPath e.g. 'ppt/slides/slide1.xml' →
   * 'ppt/slides/_rels/slide1.xml.rels'.
   */
  readRels(partPath: string): Map<string, Relationship> {
    const relsPath = relsPathFor(partPath)
    return call('PackageArchive.readRels', [this.parts((path) => path === relsPath), partPath], {
      shape: { k: 'map' },
    }) as never
  }

  /**
   * Read the presentation's slide size and the slide part paths in order.
   */
  readPresentation(): { size: SlideSize; slidePaths: string[] } {
    return call('PackageArchive.readPresentation', [
      this.parts((path) => path === 'ppt/presentation.xml' || path === 'ppt/_rels/presentation.xml.rels'),
    ]) as never
  }

  /**
   * Resolve a slide's layout / master part paths (via the rels chain). The engine
   * reads the relationship parts, the presentation, the slide and the masters and
   * layouts (the layout a slide that lost its relationship falls back to).
   */
  resolveSlideChain(slidePath: string): {
    layoutPath?: string
    masterPath?: string
    themePath?: string
  } {
    const read = (path: string): boolean =>
      path.endsWith('.rels') ||
      path === 'ppt/presentation.xml' ||
      path === slidePath ||
      /\\/(?:slideMasters|slideLayouts)\\/[^/]+\\.xml$/.test(path)
    return call('PackageArchive.resolveSlideChain', [this.parts(read), slidePath]) as never
  }
}`,
  },
  index: {
    savePptxToFile: `export async function savePptxToFile(opened: OpenedPptx, filePath: string): Promise<void> {
  // The engine builds the zip whole (savePptx); the file is written from that buffer through
  // the same stream, so a stream error still reaches the promise and still drops the snapshot.
  const bytes = await savePptx(opened)
  const { createWriteStream } = await import('node:fs')
  const { Readable } = await import('node:stream')
  const { pipeline } = await import('node:stream/promises')
  try {
    await pipeline(Readable.from([bytes]), createWriteStream(filePath))
  } catch (err) {
    forgetSnapshot(opened)
    throw err
  }
}`,
  },
}

export function overrideOf(name: string): Override | undefined {
  if (Object.hasOwn(PPTX_OVERRIDES, name)) return PPTX_OVERRIDES[name]
  if (Object.hasOwn(PPTX_TS_ONLY, name)) return { reject: PPTX_TS_ONLY[name] }
  return undefined
}

export function isHandRoute(_name: string): boolean {
  return false
}
