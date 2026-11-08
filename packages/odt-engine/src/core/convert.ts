/**
 * The shared conversion skeleton of the ODT bridge.
 *
 * Opening an ODT turns it into a "bridge docx" for the Word editor plus a
 * serialisable bridge map. Saving takes the edited docx, aligns its body
 * elements with the bridge docx's elements and writes back into the ORIGINAL
 * ODT strings: unchanged elements copy their ODF source range, changed ones are
 * converted OOXML → ODF. Every feature module (text, tables, objects, pages)
 * plugs into the two contexts defined here through a `ConversionRegistry`.
 *
 * Invariants:
 * - `BridgeMap` is plain JSON (no functions, classes, Maps or typed arrays):
 *   it crosses IPC and process boundaries between open and save.
 * - Offsets in the map index the decoded part strings of the ORIGINAL ODT
 *   (`OdtDocument.contentXml` / `stylesXml`), exactly like the core position map.
 * - Nothing here touches `@genoffice/docx-engine` behaviour; it only imports
 *   its public types.
 */
import type { Block, GenerateContext, ParsedDoc, Run } from '@genoffice/docx-engine'
import type { OdtNode, OdtNodeKind } from './body'
import type { OdtDocument } from './open'
import type { OdtStylePart, OdtStyleScope } from './styles'
import { type ElementRange, PrefixMap, decodeXmlEntities, readRoot, walkElements } from './xml'

// ---------------------------------------------------------------------------
// JSON

/** A JSON value. Everything stored in the bridge map has this shape. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

// ---------------------------------------------------------------------------
// The bridge map

export const BRIDGE_MAP_VERSION = 1

/** Which feature module converted a block or paragraph (the `id` of its converter). */
export type BridgeOwner = string

/** One ODF block of a flow (a child of `office:text`, or of a container block such as a section). */
export interface BridgeBlock {
  /** index in `BridgeMap.blocks` */
  id: number
  /** enclosing container block, or null for a direct child of `office:text` */
  parent: number | null
  /** part whose string `start`/`end` index (the body is always content.xml) */
  part: OdtStylePart
  /** canonical element name (`text:p`, `table:table`) or `#comment`/`#text`/… for opaque items */
  name: string
  kind: OdtNodeKind
  /** source range of the whole block in the part string */
  start: number
  end: number
  /** converter id that produced the block's OOXML; `keep` = no OOXML, copied verbatim on save */
  owner: BridgeOwner
  /** bridge elements produced directly by this block, in order */
  elements: number[]
  /** nested blocks of a container (section …), in order */
  children: number[]
  /** owner-specific data (JSON) */
  data: JsonValue
}

export type BridgeElementKind = 'paragraph' | 'table' | 'other'

/** One top-level body element (`w:p`, `w:tbl` …) of the bridge docx. */
export interface BridgeElement {
  /** index in `BridgeMap.elements` = position among the bridge docx's body elements */
  id: number
  /** the innermost bridge block that produced it */
  block: number
  /** exact OOXML of the element as written into the bridge docx's document.xml */
  xml: string
  kind: BridgeElementKind
  /** paragraph record (`BridgeMap.paragraphs`) when the element is a converted paragraph */
  paragraph: number | null
}

export type BridgeMarkerKind =
  /** `text:bookmark-start`, `text:bookmark-end`, `text:bookmark` */
  | 'bookmark-start'
  | 'bookmark-end'
  | 'bookmark'
  /** an inline element with no OOXML form (safe default): re-emitted at its mapped offset */
  | 'keep'
  /** an inline element whose text is shown as plain text; re-emitted verbatim while that text is intact */
  | 'text'
  /** an inline element converted by a registered inline converter (`owner`) */
  | 'handler'

/**
 * Something inside a paragraph that is not plain formatted text, anchored at a
 * character offset of the paragraph's text (`BridgeParagraph.text`).
 */
export interface BridgeMarker {
  kind: BridgeMarkerKind
  /** decoded bookmark name, or the canonical element name for other kinds */
  name: string
  /** character offset in `BridgeParagraph.text` where the element sits */
  offset: number
  /** characters of `BridgeParagraph.text` the element produced (`text`/`handler`; 0 otherwise) */
  length: number
  /** source range of the element in the paragraph's part string */
  start: number
  end: number
  /** index (in this paragraph's `markers`) of the matching start/end bookmark, or null */
  pair: number | null
  /** a Hancom form field ("누름틀"): a `NormalField…` bookmark */
  field: boolean
  /** hidden (`_`-prefixed) OOXML bookmark that marks the position in the bridge docx, or null */
  ooxmlName: string | null
  /** converter id for `handler` markers, else null */
  owner: string | null
}

/** A converted paragraph (`text:p` / `text:h`), wherever it lives (body, list, cell, header). */
export interface BridgeParagraph {
  /** index in `BridgeMap.paragraphs`; also the identity bookmark `_odtp<id>` in the bridge docx */
  id: number
  part: OdtStylePart
  /** source range of the `text:p` / `text:h` element */
  start: number
  end: number
  element: 'text:p' | 'text:h'
  /** decoded `text:style-name`, or null */
  styleName: string | null
  /** the paragraph's text as the docx engine reads it back from the bridge docx (Run texts joined) */
  text: string
  markers: BridgeMarker[]
  /** exact `<w:pPr>…</w:pPr>` written for the paragraph ('' when none): equal → formatting untouched */
  pPr: string
  /** list membership (body lists) or null */
  list: BridgeListItem | null
  /** converter id that recorded the paragraph (`text`, or e.g. `table` for cell paragraphs) */
  owner: BridgeOwner
  /** the bridge block that contains the paragraph, or null (headers, notes …) */
  block: number | null
}

export interface BridgeListItem {
  /** `w:numId` of the list instance */
  numId: string
  /** 0-based level (`w:ilvl`) */
  level: number
  /** a `text:list-header` paragraph (no number) */
  header: boolean
  /** not the first paragraph of its `text:list-item` */
  continuation: boolean
}

/** A docx paragraph style written into the bridge docx's styles.xml. */
export interface BridgeStyleEntry {
  styleId: string
  /** the ODF common paragraph style it mirrors, or null for synthetic styles */
  odfName: string | null
  /** synthetic heading style (Hancom documents have none), with its level */
  headingLevel: number | null
  /** exact `<w:style>…</w:style>` written */
  xml: string
}

export interface BridgeStyles {
  paragraph: BridgeStyleEntry[]
  /** exact `<w:docDefaults>…</w:docDefaults>` written */
  docDefaults: string
  /** family of the ODF `style:default-style` mirrored by docDefaults, or null */
  defaultFamily: string | null
  /** ODF common paragraph style used as parent of brand-new paragraphs, or null */
  baseParagraphStyle: string | null
}

/** One list instance (`w:num`) of the bridge docx. */
export interface BridgeList {
  numId: string
  abstractNumId: string
  /** ODF list style name (`text:list-style`), or null */
  styleName: string | null
  /** top-level list blocks that use this instance (continued lists share one) */
  blocks: number[]
}

export interface BridgeMap {
  version: typeof BRIDGE_MAP_VERSION
  /** `meta:generator` of the ODT */
  generator: string | null
  blocks: BridgeBlock[]
  elements: BridgeElement[]
  paragraphs: BridgeParagraph[]
  styles: BridgeStyles
  lists: BridgeList[]
  /** human-readable notes about what was approximated or kept opaque */
  warnings: string[]
  /** per-feature data; each feature module owns one key (`table`, `objects`, `page` …) */
  ext: Record<string, JsonValue>
}

export function createBridgeMap(doc: Pick<OdtDocument, 'generator'>): BridgeMap {
  return {
    version: BRIDGE_MAP_VERSION,
    generator: doc.generator.name,
    blocks: [],
    elements: [],
    paragraphs: [],
    styles: { paragraph: [], docDefaults: '', defaultFamily: null, baseParagraphStyle: null },
    lists: [],
    warnings: [],
    ext: {},
  }
}

/** Hidden OOXML bookmark name carrying a paragraph's identity through the editor. */
export const paragraphIdentityName = (id: number): string => `_odtp${id}`
/** Hidden OOXML bookmark name marking marker `index` of paragraph `id`. */
export const markerBookmarkName = (id: number, index: number): string => `_odtm${id}_${index}`

/** The paragraph id carried by a hidden identity bookmark name, or null. */
export function paragraphIdFromBookmarks(names: readonly string[] | undefined): number | null {
  for (const name of names ?? []) {
    const m = /^_odtp(\d+)$/.exec(name)
    if (m) return Number(m[1])
  }
  return null
}

// ---------------------------------------------------------------------------
// Part helpers shared by both directions

export interface OdtPartInfo {
  part: OdtStylePart
  /** the decoded part string every offset indexes */
  xml: string
  prefixes: PrefixMap
  /** `style:font-face` name → font family (quotes removed) */
  fontFaces: Map<string, string>
  /** automatic styles of this part are visible from this scope */
  scope: OdtStyleScope
}

function readFontFaces(xml: string, prefixes: PrefixMap): Map<string, string> {
  const out = new Map<string, string>()
  walkElements(xml, prefixes, {
    open(el) {
      if (el.name === 'office:body' || el.name === 'office:master-styles') return 'stop'
      if (el.name !== 'style:font-face') return
      let name: string | null = null
      let family: string | null = null
      const attrs = xml.slice(el.nameEnd, el.openEnd)
      for (const m of attrs.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
        const key = prefixes.canonical(m[1])
        const value = decodeXmlEntities(m[3] ?? m[4] ?? '')
        if (key === 'style:name') name = value
        else if (key === 'svg:font-family') family = value
      }
      if (name !== null) out.set(name, unquoteFamily(family ?? name))
    },
  })
  return out
}

/** `'Malgun Gothic'` → `Malgun Gothic`. */
export function unquoteFamily(family: string): string {
  const t = family.trim()
  if (t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0])
    return t.slice(1, -1)
  return t
}

class PartCache {
  private readonly cache = new Map<OdtStylePart, OdtPartInfo>()
  constructor(private readonly doc: OdtDocument) {}

  get(part: OdtStylePart): OdtPartInfo {
    let info = this.cache.get(part)
    if (!info) {
      const xml = part === 'content.xml' ? this.doc.contentXml : (this.doc.stylesXml ?? '')
      const prefixes =
        part === 'content.xml'
          ? this.doc.body.prefixes
          : (readRoot(xml)?.prefixes ?? new PrefixMap())
      info = {
        part,
        xml,
        prefixes,
        fontFaces: readFontFaces(xml, prefixes),
        scope: part === 'content.xml' ? 'content' : 'styles',
      }
      this.cache.set(part, info)
    }
    return info
  }
}

// ---------------------------------------------------------------------------
// The registry

/** Where a block is being converted (forward). */
export interface BlockEnv {
  /** id of the bridge block created for the node (already in `ctx.map.blocks`) */
  blockId: number
  /** enclosing container block, or null */
  parent: number | null
}

export interface BlockOoxml {
  /** top-level OOXML body elements, in order (may be empty: then the block is carried verbatim) */
  elements: Array<{ xml: string; kind?: BridgeElementKind; paragraph?: number | null }>
  /** owner-specific data stored in `BridgeBlock.data` */
  data?: JsonValue
}

/** One body element of the EDITED docx. */
export interface EditedItem {
  /** index of the element among the edited docx's body elements */
  index: number
  /** exact OOXML of the element in the edited docx (`Block.originalXml`) */
  xml: string
  /** engine blocks parsed from the element (usually exactly one) */
  blocks: Block[]
}

/** An edited element aligned with the bridge. */
export interface AlignedItem {
  item: EditedItem
  /** the bridge element this edited element continues, or null for a new element */
  element: BridgeElement | null
  /** the edited XML is identical to the bridge element's XML */
  unchanged: boolean
}

/** Where blocks are being written back (reverse). */
export interface FlowEnv {
  /** container block whose children are rebuilt, or null for `office:text` */
  parent: number | null
  /**
   * For free writers: the nearest edited elements before and after the new
   * ones that continue bridge elements (style templates for new content).
   */
  neighbours?: { before: BridgeElement | null; after: BridgeElement | null }
}

/**
 * Converts one kind of ODF block both ways. The flow walkers
 * (`convertFlow` / `rebuildFlow`) pick the newest registered converter whose
 * `match` accepts the node, so later registrations override earlier ones.
 */
export interface BlockConverter {
  /** stable owner id recorded in the map (`text`, `table`, `objects`, `page` …) */
  id: string
  match(node: OdtNode, ctx: OdfToOoxmlContext): boolean
  toOoxml(ctx: OdfToOoxmlContext, node: OdtNode, env: BlockEnv): BlockOoxml
  /**
   * Writes the ODF for a block whose edited elements are not an unchanged,
   * complete, in-order copy of its bridge elements. `items` are the edited
   * elements continuing this block plus new elements inserted between them,
   * in edited order (deleted elements are simply absent). Returns ODF XML
   * that replaces the block's source range.
   */
  toOdf(rctx: OoxmlToOdfContext, block: BridgeBlock, items: AlignedItem[], env: FlowEnv): string
  /**
   * Optional: whether a NEW edited element directly after (or before) this
   * block's elements continues the block (e.g. a list item typed at the end of
   * a list). Absorbed elements are passed to `toOdf` with the block's items.
   */
  absorbs?(rctx: OoxmlToOdfContext, block: BridgeBlock, item: EditedItem): boolean
  /**
   * Optional: claim a changed edited element that has no exact XML match as
   * one of this owner's bridge elements (`candidates` are the unclaimed bridge
   * elements of this owner between the neighbouring matched elements). Return
   * a bridge element id or null.
   */
  identify?(rctx: OoxmlToOdfContext, item: EditedItem, candidates: BridgeElement[]): number | null
}

/** An inline element met while walking a paragraph (forward). */
export interface InlineElement extends ElementRange {
  /** canonical name */
  name: string
  /** name as written */
  tag: string
  /** one past the name inside the start tag */
  nameEnd: number
  part: OdtStylePart
  /** the part string the offsets index */
  xml: string
}

export interface InlineEnv {
  /** paragraph record being built (its id; the record is pushed when the paragraph finishes) */
  paragraphId: number
  /** character offset in the paragraph text where the element sits */
  offset: number
}

export type InlineOoxml =
  /**
   * Raw OOXML spliced into the paragraph at the element's position (runs,
   * comment range marks …). `text` is exactly what the docx engine reads back
   * from it as run text ('' for marks; a picture run reads as '').
   */
  | { kind: 'xml'; xml: string; text: string }
  /** Engine runs inserted at the position (formatted by the generator). */
  | { kind: 'runs'; runs: Run[] }
  /** The safe default: no OOXML; the element is re-emitted at its mapped offset on save. */
  | { kind: 'keep' }

export interface InlineConverter {
  id: string
  /** canonical element names taken (`draw:frame`, `text:note`, `office:annotation` …) */
  names: readonly string[]
  /** null → the safe default for the element */
  toOoxml(ctx: OdfToOoxmlContext, el: InlineElement, env: InlineEnv): InlineOoxml | null
}

/** A paragraph of the edited docx, as the reverse paragraph writer takes it. */
export interface EditedParagraph {
  type: 'paragraph' | 'heading' | 'listItem'
  runs: Run[]
  format?: Block['format']
  styleId?: string
  level?: number
  outlineOnly?: boolean
  list?: Block['list']
  /** exact `<w:pPr>` of the edited paragraph when known (equal to the bridge's → format untouched) */
  rawPPr?: string
  hiddenBookmarks?: string[]
}

export interface ParagraphWriteEnv {
  /** the original paragraph this one continues, or null */
  origin: BridgeParagraph | null
  part: OdtStylePart
  /** the edited paragraph's text (Run texts joined) */
  text: string
  /**
   * Maps a character offset of the ORIGINAL paragraph text onto the edited
   * text (common prefix/suffix). `bias` decides offsets inside the changed
   * region: `start` → start of the change, `end` → end of the change.
   */
  mapOffset(offset: number, bias: 'start' | 'end'): number
}

/** Writes an atomic edited run (picture, note reference …) as ODF; its text is not emitted. */
export interface RunWriter {
  id: string
  match(run: Run): boolean
  toOdf(rctx: OoxmlToOdfContext, run: Run, env: ParagraphWriteEnv): string
}

/** Injects raw ODF at offsets of an edited paragraph (comment anchors …). */
export interface ParagraphInjector {
  id: string
  inject(
    rctx: OoxmlToOdfContext,
    para: EditedParagraph,
    env: ParagraphWriteEnv,
  ): Array<{ offset: number; xml: string; attach?: 'prev' | 'next' }>
}

/** Writes consecutive NEW edited elements (no bridge origin) that this writer matches. */
export interface FreeWriter {
  id: string
  match(item: EditedItem): boolean
  toOdf(rctx: OoxmlToOdfContext, items: EditedItem[], env: FlowEnv): string
}

export class ConversionRegistry {
  readonly blocks: BlockConverter[] = []
  readonly inline: InlineConverter[] = []
  readonly runWriters: RunWriter[] = []
  readonly injectors: ParagraphInjector[] = []
  readonly freeWriters: FreeWriter[] = []

  addBlock(converter: BlockConverter): this {
    this.blocks.push(converter)
    return this
  }
  addInline(converter: InlineConverter): this {
    this.inline.push(converter)
    return this
  }
  addRunWriter(writer: RunWriter): this {
    this.runWriters.push(writer)
    return this
  }
  addInjector(injector: ParagraphInjector): this {
    this.injectors.push(injector)
    return this
  }
  addFreeWriter(writer: FreeWriter): this {
    this.freeWriters.push(writer)
    return this
  }

  /** Newest block converter accepting the node. */
  blockFor(node: OdtNode, ctx: OdfToOoxmlContext): BlockConverter | null {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      if (this.blocks[i].match(node, ctx)) return this.blocks[i]
    }
    return null
  }
  blockById(id: string): BlockConverter | null {
    for (let i = this.blocks.length - 1; i >= 0; i--)
      if (this.blocks[i].id === id) return this.blocks[i]
    return null
  }
  inlineFor(name: string): InlineConverter[] {
    return this.inline.filter((c) => c.names.includes(name)).reverse()
  }
  runWriterFor(run: Run): RunWriter | null {
    for (let i = this.runWriters.length - 1; i >= 0; i--) {
      if (this.runWriters[i].match(run)) return this.runWriters[i]
    }
    return null
  }
  freeWriterFor(item: EditedItem): FreeWriter | null {
    for (let i = this.freeWriters.length - 1; i >= 0; i--) {
      if (this.freeWriters[i].match(item)) return this.freeWriters[i]
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// ODF → OOXML

export interface DocxRelationship {
  id: string
  type: string
  target: string
  external: boolean
}

/** A part added to the bridge docx besides document/styles/numbering (headers, comments …). */
export interface DocxExtraPart {
  /** zip path, e.g. `word/header1.xml` */
  path: string
  data: string | Uint8Array
  /** content type override (omit for media covered by a Default extension) */
  contentType?: string
}

/** Everything the bridge docx is assembled from (see `buildBridgeDocx`). */
export interface DocxAccumulator {
  /** `<w:style>` elements, in order */
  styles: string[]
  /** `<w:docDefaults>…</w:docDefaults>` ('' → an empty one) */
  docDefaults: string
  /** `<w:abstractNum>` elements */
  abstractNums: string[]
  /** `<w:num>` elements */
  nums: string[]
  /** relationships of word/document.xml (styles/numbering are added automatically) */
  relationships: DocxRelationship[]
  /** other parts (media, headers, footers, notes, comments) */
  parts: DocxExtraPart[]
  /** the body's final `<w:sectPr>`; null → derived from the default page layout */
  sectPr: string | null
  /** extra namespace declarations for the `w:document` root (`xmlns:x="…"`) */
  namespaces: string[]
}

const HYPERLINK_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink'

/**
 * State of one ODF → OOXML conversion. Feature modules write their output
 * into `docx` and their records into `map`; nothing here is serialised except
 * `map`.
 */
export class OdfToOoxmlContext {
  readonly map: BridgeMap
  readonly docx: DocxAccumulator = {
    styles: [],
    docDefaults: '',
    abstractNums: [],
    nums: [],
    relationships: [],
    parts: [],
    sectPr: null,
    namespaces: [],
  }
  private readonly parts: PartCache
  private bookmarkSeq = 0
  /** relationship ids 1 and 2 are reserved for styles and numbering */
  private relSeq = 2
  /** generator context for `generateParagraphXml` */
  readonly generate: GenerateContext

  constructor(
    readonly doc: OdtDocument,
    readonly registry: ConversionRegistry,
  ) {
    this.map = createBridgeMap(doc)
    this.parts = new PartCache(doc)
    this.generate = {
      headingStyleIds: new Map(),
      allocateHyperlinkRel: (href) => this.addHyperlink(href),
      allocateBookmarkId: () => this.allocateBookmarkId(),
    }
  }

  part(part: OdtStylePart): OdtPartInfo {
    return this.parts.get(part)
  }

  allocateBookmarkId(): number {
    return ++this.bookmarkSeq
  }

  /** Adds a relationship of word/document.xml and returns its id. */
  addRelationship(type: string, target: string, external = false): string {
    const id = `rId${++this.relSeq}`
    this.docx.relationships.push({ id, type, target, external })
    return id
  }

  /** Relationship id for an external hyperlink target (one per target). */
  addHyperlink(href: string): string {
    const found = this.docx.relationships.find(
      (r) => r.external && r.type === HYPERLINK_REL && r.target === href,
    )
    return found ? found.id : this.addRelationship(HYPERLINK_REL, href, true)
  }

  /** Records a bridge block (before its converter runs, so nested blocks can point at it). */
  addBlock(node: OdtNode, parent: number | null, owner: string): BridgeBlock {
    const block: BridgeBlock = {
      id: this.map.blocks.length,
      parent,
      part: 'content.xml',
      name: node.name,
      kind: node.kind,
      start: node.start,
      end: node.end,
      owner,
      elements: [],
      children: [],
      data: null,
    }
    this.map.blocks.push(block)
    if (parent !== null) this.map.blocks[parent].children.push(block.id)
    return block
  }

  /** Records a top-level body element of the bridge docx. */
  addElement(
    blockId: number,
    xml: string,
    kind: BridgeElementKind = 'other',
    paragraph: number | null = null,
  ): BridgeElement {
    const element: BridgeElement = {
      id: this.map.elements.length,
      block: blockId,
      xml,
      kind,
      paragraph,
    }
    this.map.elements.push(element)
    this.map.blocks[blockId].elements.push(element.id)
    return element
  }

  private paragraphSeq = 0
  /**
   * Reserves a paragraph id. Ids are reserved when a paragraph starts (nested
   * paragraphs, e.g. note bodies, may finish first) and every reserved id must
   * be filled with `addParagraph`.
   */
  reserveParagraphId(): number {
    return this.paragraphSeq++
  }
  /** Stores a paragraph record under its reserved id. */
  addParagraph(record: BridgeParagraph): void {
    this.map.paragraphs[record.id] = record
  }

  warn(message: string): void {
    if (!this.map.warnings.includes(message)) this.map.warnings.push(message)
  }

  /** The JSON slot of a feature module, created on first use. */
  ext<T extends JsonValue>(key: string, init: () => T): T {
    if (!(key in this.map.ext)) this.map.ext[key] = init()
    return this.map.ext[key] as T
  }
}

// ---------------------------------------------------------------------------
// OOXML → ODF

/** A replacement of `[start, end)` of a part string (an insertion when start === end). */
export interface TextPatch {
  part: OdtStylePart
  start: number
  end: number
  xml: string
}

/**
 * Applies non-overlapping patches to `text`. Insertions at the same offset
 * keep their order. Throws on overlapping replacements.
 */
export function applyTextPatches(text: string, patches: readonly TextPatch[]): string {
  if (patches.length === 0) return text
  const sorted = patches
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.start - b.p.start || a.p.end - b.p.end || a.i - b.i)
    .map((x) => x.p)
  let out = ''
  let at = 0
  for (const p of sorted) {
    if (p.start < at) throw new Error(`odt: overlapping patches at ${p.start}`)
    out += text.slice(at, p.start) + p.xml
    at = p.end
  }
  return out + text.slice(at)
}

/** The standard namespace URIs for the prefixes written into new ODF markup. */
const OUTPUT_NAMESPACES: Readonly<Record<string, string>> = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
}

export interface OoxmlToOdfOptions {
  /** raw word/styles.xml of the edited docx (style and default-font edits) */
  editedStylesXml?: string | null
}

/**
 * State of one OOXML → ODF write-back into the original ODT. Converters add
 * narrow patches (`patch`) and new automatic styles (`addAutomaticStyle`);
 * `finish()` returns all patches per part, ready for `applyTextPatches`.
 */
export class OoxmlToOdfContext {
  readonly patches: TextPatch[] = []
  /** bridge elements some edited element continues (filled by `alignItems`); the rest were deleted */
  readonly matched = new Set<number>()
  readonly warnings: string[] = []
  private readonly parts: PartCache
  private readonly usedNames = new Set<string>()
  private readonly newStyles: Record<OdtStylePart, string[]> = {
    'content.xml': [],
    'styles.xml': [],
  }
  private readonly newFonts: Record<OdtStylePart, Map<string, string>> = {
    'content.xml': new Map(),
    'styles.xml': new Map(),
  }
  /** dedup cache for derived styles: key → name */
  private readonly derived = new Map<string, string>()
  private readonly usedPrefixes: Record<OdtStylePart, Set<string>> = {
    'content.xml': new Set(),
    'styles.xml': new Set(),
  }

  constructor(
    readonly doc: OdtDocument,
    readonly map: BridgeMap,
    readonly edited: ParsedDoc,
    readonly registry: ConversionRegistry,
    readonly options: OoxmlToOdfOptions = {},
  ) {
    this.parts = new PartCache(doc)
    for (const s of doc.styles.all) if (s.name) this.usedNames.add(s.name)
    for (const m of doc.styles.masterPages) if (m.name) this.usedNames.add(m.name)
  }

  part(part: OdtStylePart): OdtPartInfo {
    return this.parts.get(part)
  }

  /** A style name not used by any existing or new style of either part. */
  allocateStyleName(base: string): string {
    // a new name is a valid NCName even when the original is not (Hancom
    // writes `Table2.[` for the 27th column and spaces in style names)
    const stem = base
      .replace(/_io\d+$/, '')
      .replace(/[^\w.\-·À-￿]/g, '_')
      .replace(/^(?=[\d.\-·])/, '_')
    for (let n = 1; ; n++) {
      const name = `${stem}_io${n}`
      if (!this.usedNames.has(name)) {
        this.usedNames.add(name)
        return name
      }
    }
  }

  /**
   * A style name for derived style XML: the same `key` (e.g. base + overrides)
   * returns the same name, so identical edits share one new style. `build`
   * receives the allocated name and returns the complete style element.
   */
  derivedStyle(
    part: OdtStylePart,
    key: string,
    base: string,
    build: (name: string) => string,
  ): string {
    const cacheKey = `${part}\u0000${key}`
    const found = this.derived.get(cacheKey)
    if (found) return found
    const name = this.allocateStyleName(base)
    this.derived.set(cacheKey, name)
    this.addAutomaticStyle(part, build(name))
    return name
  }

  /** The new automatic style elements queued for `part` so far. */
  newAutomaticStyles(part: OdtStylePart): readonly string[] {
    return this.newStyles[part]
  }

  /** Queues a new automatic style (or list style) element for `part`. */
  addAutomaticStyle(part: OdtStylePart, xml: string): void {
    this.newStyles[part].push(xml)
    this.notePrefixes(part, xml)
  }

  /**
   * Declares a font face for `family` in `part` when none maps to it, and
   * returns the `style:name` to use in `style:font-name*`.
   */
  fontFace(part: OdtStylePart, family: string): string {
    const info = this.part(part)
    for (const [name, fam] of info.fontFaces) if (fam === family) return name
    const added = this.newFonts[part].get(family)
    if (added) return added
    let name = family
    for (
      let n = 2;
      info.fontFaces.has(name) || [...this.newFonts[part].values()].includes(name);
      n++
    )
      name = `${family} ${n}`
    this.newFonts[part].set(family, name)
    return name
  }

  /** Queues a narrow replacement of a part's source range. */
  patch(part: OdtStylePart, start: number, end: number, xml: string): void {
    this.patches.push({ part, start, end, xml })
    this.notePrefixes(part, xml)
  }

  /** Records which namespace prefixes new markup uses, so `finish` can declare missing ones. */
  notePrefixes(part: OdtStylePart, xml: string): void {
    for (const m of xml.matchAll(/<\/?([a-z]+):/g)) this.usedPrefixes[part].add(m[1])
    for (const m of xml.matchAll(/\s([a-z]+):[\w-]+="/g)) this.usedPrefixes[part].add(m[1])
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message)
  }

  ext<T extends JsonValue>(key: string): T | undefined {
    return this.map.ext[key] as T | undefined
  }

  /**
   * All patches per part: the converters' patches plus the insertion of new
   * automatic styles and font faces, plus namespace declarations the original
   * root lacks.
   */
  finish(): Record<OdtStylePart, TextPatch[]> {
    const out: Record<OdtStylePart, TextPatch[]> = { 'content.xml': [], 'styles.xml': [] }
    for (const p of this.patches) out[p.part].push(p)
    for (const part of ['content.xml', 'styles.xml'] as const) {
      const xml = this.part(part).xml
      if (!xml) continue
      const containers =
        part === 'content.xml'
          ? this.doc.styles.containers.content
          : this.doc.styles.containers.styles
      const fonts = [...this.newFonts[part]].map(
        ([family, name]) =>
          `<style:font-face style:name="${escAttr(name)}" svg:font-family="${escAttr(
            /\s/.test(family) ? `'${family}'` : family,
          )}"/>`,
      )
      if (fonts.length) {
        this.notePrefixes(part, fonts.join(''))
        out[part].push(
          containerInsert(
            part,
            xml,
            containers.fontFaceDecls,
            'office:font-face-decls',
            fonts.join(''),
            ['office:styles', 'office:automatic-styles', 'office:master-styles', 'office:body'],
          ),
        )
      }
      const styles = this.newStyles[part]
      if (styles.length) {
        out[part].push(
          containerInsert(
            part,
            xml,
            containers.automaticStyles,
            'office:automatic-styles',
            styles.join(''),
            ['office:master-styles', 'office:body'],
          ),
        )
      }
      const decl = namespaceDeclarations(xml, this.usedPrefixes[part])
      if (decl) out[part].push(decl.patch(part))
    }
    return out
  }
}

function escAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Inserts `inner` at the end of a container, creating it before the first of `before` when missing. */
function containerInsert(
  part: OdtStylePart,
  xml: string,
  range: ElementRange | undefined,
  name: string,
  inner: string,
  before: string[],
): TextPatch {
  if (range && !range.selfClosing)
    return { part, start: range.closeStart, end: range.closeStart, xml: inner }
  if (range) return { part, start: range.start, end: range.end, xml: `<${name}>${inner}</${name}>` }
  const root = readRoot(xml)
  let at = -1
  if (root) {
    walkElements(xml, root.prefixes, {
      open(el, parent) {
        if (parent === null) return
        if (before.includes(el.name)) {
          at = el.start
          return 'stop'
        }
        return 'skip'
      },
    })
  }
  if (at < 0) at = root ? root.end : xml.length
  return { part, start: at, end: at, xml: `<${name}>${inner}</${name}>` }
}

function namespaceDeclarations(
  xml: string,
  used: Set<string>,
): { patch(part: OdtStylePart): TextPatch } | null {
  const root = readRoot(xml)
  if (!root) return null
  const declared = new Map<string, string>()
  for (const a of root.attributes) {
    if (a.name.startsWith('xmlns:')) declared.set(a.name.slice(6), decodeXmlEntities(a.raw))
  }
  const missing = [...used].filter((p) => OUTPUT_NAMESPACES[p] && !declared.has(p))
  if (!missing.length) return null
  const gt = root.end - (xml.charCodeAt(root.end - 2) === 47 ? 2 : 1)
  const text = missing.map((p) => ` xmlns:${p}="${OUTPUT_NAMESPACES[p]}"`).join('')
  return { patch: (part) => ({ part, start: gt, end: gt, xml: text }) }
}
