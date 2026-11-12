// The types and constants of the public API: the shapes of what the engine
// returns and takes. The engine is the Rust crate crates/odt-engine (through
// the wasm, engine.ts); these declarations are the ones the TypeScript engine
// had, unchanged, so every importer keeps its types.

export type OdtStylePart = 'styles.xml' | 'content.xml'

export type OdtNodeKind =
  | 'paragraph' // text:p
  | 'heading' // text:h
  | 'list' // text:list
  | 'list-item' // text:list-item, text:list-header
  | 'section' // text:section
  | 'index' // text:table-of-content and the other text:*-index elements
  | 'table' // table:table
  | 'column-group' // table:table-columns, table:table-header-columns, table:table-column-group
  | 'table-column' // table:table-column
  | 'row-group' // table:table-header-rows, table:table-rows, table:table-row-group
  | 'table-row' // table:table-row
  | 'table-cell' // table:table-cell
  | 'covered-cell' // table:covered-table-cell (hidden by a merge)
  | 'frame' // draw:frame
  | 'text-box' // draw:text-box
  | 'image' // draw:image
  | 'object' // draw:object, draw:object-ole
  | 'shape' // draw:rect, draw:custom-shape, draw:g … and dr3d:scene
  | 'bookmark' // text:bookmark (a point)
  | 'bookmark-start' // text:bookmark-start
  | 'bookmark-end' // text:bookmark-end
  | 'annotation' // office:annotation
  | 'annotation-end' // office:annotation-end
  | 'note' // text:note (footnote / endnote)
  | 'other' // any other element directly under office:text
  | 'opaque' // a comment, CDATA, processing instruction or stray text directly under office:text

/** A JSON value. Everything stored in the bridge map has this shape. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

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

/** One step from a table into a table nested in one of its cells. */
export interface NestedStep {
  /** grid row of the host cell */
  row: number
  /** grid column of the host cell */
  col: number
  /** which table of the host cell (0-based, in reading order) */
  index: number
}

/**
 * A cell Hancom locked (`table:protected="true"` on the cell, a cell style
 * whose `style:cell-protect` protects it, or `table:protected="true"` on the
 * whole table). Nothing may change its content or its place in the grid.
 */
export interface ProtectedCellRef {
  /** bridge element id (`BridgeMap.elements` index) of the top-level `w:tbl` */
  table: number
  /** host cells leading into nested tables, outermost first; `[]` for the top-level table */
  path: NestedStep[]
  /** grid row in the innermost table (0-based, header rows included) */
  row: number
  /** grid column of the cell's first column (0-based) */
  col: number
  /** index of the cell's `w:tc` in its `w:tr` (`TableModel.rows[row][tc]` of the docx engine) */
  tc: number
}

/** `wp:docPr` name prefix of a locked placeholder: `odt-keep:<id>:<kind>`. */
export const ODT_KEEP_PREFIX = 'odt-keep:'

/** The fixed feature ids of placeholders. */
export const OBJECT_KINDS = [
  'equation',
  'shape',
  'textbox',
  'toc',
  'chart',
  'revision',
  'object',
] as const

export type ObjectKind = (typeof OBJECT_KINDS)[number]

/** A locked placeholder: one uneditable object shown as one picture. */
export interface ObjectPlaceholder {
  /** the `<id>` of `odt-keep:<id>:<kind>` */
  id: string
  kind: ObjectKind
  /** the exact `wp:docPr` name */
  name: string
  part: OdtStylePart
  /** source range of the object: the inline element, or the whole block */
  start: number
  end: number
  /** paragraph record that holds an inline object; null for a block placeholder */
  paragraph: number | null
  /** bridge block of a block placeholder (table of contents, tracked-change paragraph …); else null */
  block: number | null
  /** bridge element of a block placeholder; else null */
  element: number | null
  /** size of the object (and of the placeholder picture) */
  widthEmu: number
  heightEmu: number
  /** the picture is a preview stored in the file; false = the neutral picture */
  preview: boolean
  /** package entries the object references (`Object 1/`, `ObjectReplacements/Object 1` …) */
  entries: string[]
  /** tracked-change placeholder: the text as shown with every change applied; else null */
  finalText: string | null
}

/** An editable picture (`draw:frame` whose content is one `draw:image`). */
export interface ObjectPicture {
  /** the `<id>` of `odt-pic:<id>` */
  id: string
  name: string
  part: OdtStylePart
  /** source range of the `draw:frame` */
  start: number
  end: number
  /** one past the frame's start tag */
  openEnd: number
  /** source range of the `draw:image` start tag (its `xlink:href` changes when the picture is replaced) */
  imageStart: number
  imageOpenEnd: number
  /** `xlink:href` as written (decoded) */
  href: string
  /** the package entry it names */
  entry: string
  /** relationship id of the picture's media in the bridge docx */
  rId: string
  widthEmu: number
  heightEmu: number
  /** floating (`wp:anchor`) rather than inline */
  anchored: boolean
  /** `wp:posOffset` values written for a floating picture (null when aligned) */
  xEmu: number | null
  yEmu: number | null
  /** paragraph record that holds the picture */
  paragraph: number | null
  /** package entries it references */
  entries: string[]
}

/** An existing comment (`office:annotation`), shown as a docx comment. */
export interface ObjectComment {
  /** docx `w:id` */
  id: string
  /** `office:name`, or null */
  name: string | null
  /** source range of the `office:annotation` element (kept byte for byte on save) */
  start: number
  end: number
  /** source range of the matching `office:annotation-end`, or null */
  endStart: number | null
  endEnd: number | null
  /** paragraph record holding the annotation, and its character offset there */
  paragraph: number
  offset: number
  /** paragraph record holding the end, and its offset; null for a point comment */
  endParagraph: number | null
  endOffset: number | null
  /** the comment covers text (deleting all of it deletes the comment) */
  ranged: boolean
  /** the comment's text (paragraphs joined with a line feed), as shown in the editor */
  text: string
}

export type NoteKind = 'footnote' | 'endnote'

/** A footnote or endnote (`text:note`). */
export interface ObjectNote {
  /** docx `w:id` (unique per kind) */
  id: string
  kind: NoteKind
  /** source range of the `text:note` */
  start: number
  end: number
  /** inner range of `text:note-body` (between its tags) */
  bodyStart: number
  bodyEnd: number
  /** `text:note-citation` text as written */
  citation: string
  /** the body comes before the citation (Hancom's order) */
  bodyFirst: boolean
  /** paragraph record holding the citation */
  paragraph: number
  /** paragraph records of the note body, in order */
  paragraphs: number[]
  /** the note text as the docx engine reads it (`NoteInfo.text`) */
  text: string
  /** the body holds only paragraphs; otherwise edits of its text are not saved */
  editable: boolean
}

export interface ObjectsExt {
  version: 1
  /** locked placeholders, in conversion order (the list the editor and CLI read) */
  placeholders: ObjectPlaceholder[]
  pictures: ObjectPicture[]
  comments: ObjectComment[]
  notes: ObjectNote[]
}

export const REPORT_FEATURES = [
  'toc',
  'chart',
  'equation',
  'shape',
  'textbox',
  'columns',
  'citation',
  'cross_reference',
  'page_color',
  'mirror_margins',
  'theme',
  'comment',
  'revision',
  'ink',
  'watermark',
  'password',
  'protection',
  'form_field',
  'object',
  'hidden_from_ai',
] as const

export type ReportFeature = (typeof REPORT_FEATURES)[number]

export interface ReportItem {
  kind: 'converted' | 'dropped'
  feature: ReportFeature
  count: number
}

export type ConversionReport = ReportItem[]

/** A picture of an object as the editor shows it. */
export interface RenderedObject {
  /** PNG bytes */
  png: Uint8Array
  /** display size in EMU (914400 per inch) */
  widthEmu: number
  heightEmu: number
}

export interface DocxToOdtOptions {
  /**
   * Pictures the editor rendered for objects an ODT cannot hold (charts,
   * equations, shapes, text boxes), keyed by body position:
   * `"<docxIndex>:<n>"` is the n-th such object (0-based, document order,
   * table cells included) inside the body element with that `Block.docxIndex`;
   * `"<docxIndex>"` alone stands for its first object.
   */
  renderedObjects?: Record<string, RenderedObject> | ReadonlyMap<string, RenderedObject>
}

export interface DocxToOdtResult {
  odtBytes: Uint8Array
  /** what the ODT does not keep as it was */
  report: ConversionReport
}

export interface OdtToDocxResult {
  /** the bridge docx the Word editor opens */
  docxBytes: Uint8Array
  /** the bridge map (plain JSON): pass it back to `saveOdt` */
  bridge: BridgeMap
  /** what changes if this ODT is saved as docx */
  report: ConversionReport
}

export interface SaveOdtInput {
  /** the ODT as received (and opened with `odtToDocx`) */
  originalOdt: Uint8Array
  /** the bridge map `odtToDocx` returned (it is not modified) */
  bridge: BridgeMap
  /** the docx the editor saved */
  editedDocx: Uint8Array
}

export interface SaveOdtResult {
  /** the saved ODT: the original bytes when nothing changed */
  odtBytes: Uint8Array
  /** what the saved ODT does not keep of the edited docx */
  report: ConversionReport
}
