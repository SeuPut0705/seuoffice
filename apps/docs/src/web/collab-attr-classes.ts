/**
 * What every attribute of the editor's schema may hold while co-editing: the
 * table `collab-safety.ts` walks. An attribute is judged by the class written
 * here for its node or mark type, never by what its name looks like, and an
 * attribute with no entry is refused. `tests/collab-attr-classes.test.ts`
 * walks the real schema and fails, naming the attribute, when one has no
 * entry here or an entry names an attribute the schema lacks: a new attribute
 * cannot ship without a class.
 *
 * To add an attribute: find every place the renderer reads it
 * (`renderHTML`, node views, decorations, `innerHTML`, `setAttribute`, style
 * strings) and pick the strictest class that still holds its real values.
 *
 * - `token`: a number, a boolean, an id, a keyword, a colour, a font face, a
 *   size. The renderer may write it into a style or an attribute, so a string
 *   must not be able to end a CSS declaration, open a string, a block or a
 *   comment, or load anything. An object or array here is a structure of
 *   tokens.
 * - `text`: words a person wrote. The renderer shows them only through text
 *   nodes, `title` and `data-*` attributes, never as markup, style or a URL.
 * - `kept`: OOXML or JSON the save writes back. The renderer only tests it,
 *   copies it or stores it in a `data-*` attribute; nothing of it is drawn.
 * - `link`: a hyperlink target, kept when its scheme is one a document uses.
 * - `picture`: a picture source, kept when it is a data URL the app makes.
 * - `cssString`: text drawn inside a CSS string whose quotes and backslashes
 *   the renderer escapes: only a line break would end that string.
 * - `mathml` / `inlineMathml`: MathML markup, rebuilt from the `omml` beside
 *   it (the display or the inline form), so it never comes from a peer.
 * - `marks`: a list of marks, each judged by its own type in `MARK_ATTRS`.
 * - `struct({...})`: an object, or an array of them, as it is or as JSON text
 *   (several attributes store their structure as a JSON string). Its fields
 *   are judged by name, at any depth, through the given table; a name the
 *   table lacks is a `token`. A field whose own class is a `struct` switches
 *   to that table below it.
 */
import type {
  Block,
  ChartDisplay,
  DiagramDisplay,
  FieldDisplay,
  FormulaDisplay,
  InlineWrap,
  NewChart,
  NewImage,
  PropChangeInfo,
  RevisionInfo,
  Run,
  SdtShell,
  TableModel,
  TextboxDisplay,
} from '@seuoffice/docx-engine'

export type Leaf =
  'kept' | 'text' | 'token' | 'link' | 'picture' | 'cssString' | 'mathml' | 'inlineMathml' | 'marks'

export interface Struct {
  readonly fields: Fields
}

export type AttrClass = Leaf | Struct

export interface Fields {
  readonly [name: string]: AttrClass
}

type Scalar = string | number | boolean | null | undefined
type Depth = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8]

/**
 * The names, at any depth of `T`, of the fields typed to hold any string: the
 * ones a table must class, since a keyword, a number or a flag is a token
 * whatever it is called. Nine levels reach every field of the engine's
 * models (tables nest in cells, text boxes in tables).
 */
type FreeStrings<T, D extends number = 8> = [D] extends [never]
  ? never
  : T extends Scalar
    ? never
    : T extends readonly (infer Item)[]
      ? FreeStrings<Item, D>
      : {
          [K in keyof T]-?:
            | (K extends string ? (string extends Leaves<T[K]> ? K : never) : never)
            | FreeStrings<T[K], Depth[D]>
        }[keyof T]

/** `V` with its arrays opened */
type Leaves<V> = V extends readonly (infer Item)[] ? Leaves<Item> : V

/**
 * A table for the engine model `T`: it must class every field of `T`, at any
 * depth, that can hold any string. An engine field added later fails the type
 * check here until it has a class.
 */
function struct<T = never>() {
  return <F extends Fields & Record<FreeStrings<T> & string, AttrClass>>(fields: F): Struct => ({
    fields,
  })
}

/** the listed names, each a token */
function tokens<const N extends string>(...names: N[]): Record<N, 'token'> {
  const out = {} as Record<N, 'token'>
  for (const name of names) out[name] = 'token'
  return out
}

/** a structure of tokens: tab stops, border sides, margins, as an object or as JSON text */
const TOKENS = struct()({})

/** a numbering level, as a resolved paragraph carries it (`effective.list.level`) */
const NUMBERING_LEVEL = {
  numFmt: 'text',
  customFormat: 'text',
  lvlText: 'cssString',
  picBulletSrc: 'picture',
  ...tokens('font', 'color', 'pStyle'),
} as const

/** what a paragraph's formatting holds besides numbers and keywords (`ParaFormat` and its resolved twin) */
const PARA_FORMAT = {
  ...NUMBERING_LEVEL,
  ...tokens(
    'styleId',
    'numId',
    'eastAsiaLang',
    'shadingFill',
    'shadingDisplay',
    'shading',
    'borders',
    'borderReset',
    'emptyRunFontFamily',
    // the resolved paragraph mark: its faces and its border
    'ascii',
    'eastAsia',
    'cs',
    'val',
  ),
} as const

/** who made a tracked change and what stood before it (`oldXml`: the previous properties) */
const REVISION = struct<
  | PropChangeInfo
  | RevisionInfo
  | NonNullable<Block['pPrChangeInfo']>
  | NonNullable<Block['blockRevision']>
>()({
  author: 'text',
  oldXml: 'kept',
  ...tokens('date', 'dateUtc', 'id', 'move', 'vMerge', 'vMergeOrig'),
  // the paragraph formatting before a tracked paragraph change (`old`)
  ...PARA_FORMAT,
})

/** a content control's wrapper: its label and tag, and the bytes around its content */
const SDT = struct<SdtShell>()({
  alias: 'text',
  tag: 'text',
  openXml: 'kept',
  closeXml: 'kept',
  ...tokens('lock', 'id'),
})

/**
 * A run-level wrapper (an inline content control, a smart tag) carried around the runs it
 * holds: structure of the document, written back by the save. `open` and `close` are the
 * bytes before and after the runs; the renderer never draws them (the mark shows a token of
 * its own making, editor/inline-wrap.ts). `text` is the text a control's properties were
 * recorded for.
 */
const WRAPPER = struct<InlineWrap>()({ open: 'kept', close: 'kept', text: 'text' })

/**
 * The engine's content models as attributes carry them: a nested table
 * (`model`, `table`), the merged-away cells of a table (`continuationCells`),
 * text boxes and the runs inside all of them.
 */
const CONTENT = struct<TableModel | TextboxDisplay | Run>()({
  ...PARA_FORMAT,
  // a run
  text: 'text',
  rawRPr: 'kept',
  // The run-level wrappers around a run: below `wrap` the wrapper's own table is in force,
  // so its bytes are kept there and nowhere else. (A picture's and a frame's `wrap` is a
  // keyword: a token under any table.) Outside a wrapper nothing is named `open` or `close`.
  wrap: WRAPPER,
  ...tokens('open', 'close'),
  href: 'link',
  tooltip: 'text',
  omml: 'kept',
  rt: 'text',
  xml: 'kept',
  dataUrl: 'picture',
  fldBeginXml: 'kept',
  sdtCheckboxXml: 'kept',
  ...tokens(
    'fontAscii',
    'eastAsiaFont',
    'fontCs',
    'csFont',
    'themeColor',
    'highlight',
    'commentIds',
    'rId',
    'char',
    'colorHex',
    'xeTerm',
    'refField',
    'refInstr',
    'instrField',
  ),
  // a tracked change on a run, a cell, a row or the table
  author: 'text',
  // the previous run properties of a tracked format change: only the save reads them
  oldRPr: 'kept',
  oldXml: 'kept',
  ...tokens('date', 'dateUtc', 'id', 'move', 'vMerge', 'vMergeOrig'),
  // a table and its cells
  caption: 'text',
  description: 'text',
  rawTcPr: 'kept',
  rawTrPrs: 'kept',
  rawTblPrExs: 'kept',
  // a cell's paragraphs as plain text: drawn as text nodes, like a run's `text`
  paras: 'text',
  ...tokens('fill', 'styleColor', 'style', 'tblStyleId'),
  // a text box
  fillImageDataUrl: 'picture',
  ...tokens(
    'borderColor',
    'textColor',
    'prst',
    'path',
    'fillPath',
    'strokePath',
    'wordArtId',
    'shapeId',
  ),
})

/** a field's shown result (a TOC line, a date) */
const FIELD = struct<FieldDisplay>()({
  left: 'text',
  right: 'text',
  num: 'text',
  // its formatted runs
  text: 'text',
  tooltip: 'text',
  omml: 'kept',
  href: 'link',
  ...tokens(
    'anchor',
    'fontFamily',
    'eaFontFamily',
    'runStyleId',
    'styleId',
    'color',
    'font',
    'fontAscii',
    'csFont',
    'rId',
  ),
})

/** a display equation: its markup is the display form of its OMML */
const FORMULA = struct<FormulaDisplay>()({
  tokens: 'text',
  latex: 'text',
  omml: 'kept',
  mathml: 'mathml',
})

/** a chart's cached texts and colours */
const CHART = struct<ChartDisplay | NewChart>()({
  title: 'text',
  name: 'text',
  categories: 'text',
  numFmt: 'text',
  // never set in the editor: the block carries the label (escaped) as its own `redact`
  ...tokens(
    'partPath',
    'color',
    'pointColors',
    'palette',
    'frameLine',
    'line',
    'gridLine',
    'redact',
  ),
})

/** a SmartArt's resolved shapes */
const DIAGRAM = struct<DiagramDisplay>()({
  texts: 'text',
  imageDataUrl: 'picture',
  ...tokens('prst', 'fillHex', 'lnHex', 'textColorHex'),
})

/** a picture made in this session, written into the file at the save */
const NEW_IMAGE = struct<NewImage>()({
  altText: 'text',
  ...tokens('base64', 'sourcePart'),
})

/** the pictures of a picture-only group, bottom first */
const PICTURE_LAYERS = struct()({ dataUrl: 'picture' })

/** what docParagraph, docHeading and docListItem share */
const PARAGRAPH: Fields = {
  ...tokens(
    'docxIndex',
    'styleId',
    'aiChanged',
    'bookmarks',
    'hiddenBookmarks',
    'commentStarts',
    'commentEnds',
    'align',
    'lineSpacing',
    'lineRule',
    'lineRawTwips',
    'snapToGrid',
    'indentLeft',
    'indentRight',
    'indentFirstLine',
    'indentFirstLineChars',
    'spaceBefore',
    'spaceAfter',
    'spaceBeforeAuto',
    'spaceAfterAuto',
    'contextualSpacing',
    'ruleOverlays',
    'keepNext',
    'keepLines',
    'widowControl',
    'suppressLineNumbers',
    'pageBreakBefore',
    'bidi',
    'bidiInherited',
    'bidiInferred',
    'autoSpace',
    'wordWrap',
    'overflowPunct',
    'eaLang',
    'shadingFill',
    'shadingDisplay',
    'shadingClear',
    'borderReset',
    'emptyRunSize',
    'emptyRunFont',
    'markSize',
    'borders',
    'textDirection',
    'moveRevision',
  ),
  tblPara: TOKENS,
  frameBox: TOKENS,
  borderLines: TOKENS,
  borderPad: TOKENS,
  tabStops: TOKENS,
  dropCap: TOKENS,
  frame: TOKENS,
  sdtShell: SDT,
  pPrChange: REVISION,
  numberingChange: REVISION,
  sectPrChange: REVISION,
  paraMarkDel: REVISION,
  paraMarkIns: REVISION,
  paraMarkRPrChange: REVISION,
  blockRevision: REVISION,
  // the marks a new paragraph starts typing with
  caretMarks: 'marks',
}

/** what docTableCell and docTableHeader share */
const CELL: Fields = {
  ...tokens(
    'vAlign',
    'borders',
    'cellMar',
    'collapsedBw',
    'textDirection',
    'noWrap',
    'tcPrEdited',
    'hideMark',
    'clipHeightTwips',
    'gridGap',
    'mergeGap',
    'colspan',
    'rowspan',
    'colwidth',
    'fill',
    'color',
    'bold',
    'align',
  ),
  rawTcPr: 'kept',
  cellRevision: REVISION,
  tcPrChange: REVISION,
  cellMerge: REVISION,
}

/** Every node type of the schema, and the class of each of its attributes */
export const NODE_ATTRS: { readonly [type: string]: Fields } = {
  doc: {},
  text: {},
  hardBreak: tokens('pageBreak', 'colBreak', 'wrapBreak', 'mathBreak'),
  docNoteRef: {
    ...tokens('kind', 'id'),
    // a number the renderer formats itself
    num: 'text',
    rawRPr: 'kept',
  },
  docXeMark: { term: 'text' },
  docRuby: { base: 'text', rt: 'text', xml: 'kept' },
  docInlineImage: {
    ...tokens(
      'widthPx',
      'heightPx',
      'wrap',
      'offsetXEmu',
      'offsetYEmu',
      'relV',
      'relH',
      'posH',
      'posV',
      'wrapDistTopEmu',
      'wrapDistBottomEmu',
      'wrapDistLeftEmu',
      'wrapDistRightEmu',
      'border',
      'lineCenterV',
      'rotDeg',
      'flipH',
      'flipV',
      'rule',
      'leadRule',
      'leadRuleFull',
    ),
    dataUrl: 'picture',
    xml: 'kept',
    layers: PICTURE_LAYERS,
    rawRPr: 'kept',
  },
  docInlineMath: {
    ...tokens('sizeHalfPoints', 'display'),
    omml: 'kept',
    mathml: 'inlineMathml',
    latex: 'text',
    text: 'text',
  },
  docParagraph: PARAGRAPH,
  docHeading: { ...PARAGRAPH, ...tokens('level', 'outlineOnly') },
  docListItem: { ...PARAGRAPH, ...tokens('kind', 'numId', 'ilvl') },
  docTable: {
    ...tokens(
      'docxIndex',
      'colWidthsPct',
      'widthPx',
      'widthPct',
      'cellMar',
      'cellSpacingTwips',
      'tblFill',
      'cellMarEdited',
      'borders',
      'tblAlign',
      'tblFloat',
      'tblFloatSource',
      'tblFloatSuppressed',
      'tblFloatXTwips',
      'tblFloatYTwips',
      'tblFloatHorzAnchor',
      'tblFloatVertAnchor',
      'tblFloatXSpec',
      'tblFloatYSpec',
      'tblFloatDistance',
      'tblFloatWidthPx',
      'tblFloatEdited',
      'tblAutoFit',
      'tblAutoFitEdited',
      'tblFixedLayout',
      'tblDxaWidth',
      'tblOverWide',
      'indentTwips',
      'tblStyleId',
      'tblLook',
      'tblLookEdited',
      'bidiVisual',
      'tblAltEdited',
    ),
    sdtShell: SDT,
    tblCaption: 'text',
    tblDescription: 'text',
    tblPrChange: REVISION,
    tblGridChange: REVISION,
    // the opened table's signatures: the save compares the table against them
    originalStructure: 'kept',
    originalFormatting: 'kept',
    originalWraps: 'kept',
    // the merged-away cells, each `{row, column, cell}`: read back at the save only
    continuationCells: CONTENT,
    blockRevision: REVISION,
  },
  docTableRow: {
    ...tokens(
      'heightTwips',
      'heightRule',
      'repeatHeader',
      'repeatHeaderEdited',
      'cantSplit',
      'cantSplitEdited',
    ),
    rawTrPr: 'kept',
    rowRevision: REVISION,
    trPrChange: REVISION,
    rawTblPrEx: 'kept',
    tblPrExChange: REVISION,
  },
  docTableCell: CELL,
  docTableHeader: CELL,
  docNestedTable: { model: CONTENT },
  docCellBoxes: { boxes: CONTENT },
  docProtected: {
    ...tokens(
      'docxIndex',
      'blockType',
      'styleId',
      'pageBreakBefore',
      'oleProgId',
      'imageWidthPx',
      'imageHeightPx',
      'imageCrop',
      'imageEffects',
      'imageFillRect',
      'imageLeadingFont',
      'imageLeadingExplicitSpaceWidthPx',
      'imageLeadingImplicitSpaceCount',
      'imageParagraphIndentLeft',
      'imageParagraphIndentRight',
      'imageParagraphIndentFirstLine',
      'imageParagraphSpaceBefore',
      'imageParagraphSpaceAfter',
      'imageParagraphSpaceBeforeAuto',
      'imageParagraphSpaceAfterAuto',
      'imageParagraphAdditiveSpacing',
      'imageParagraphLineTwips',
      'imageParagraphLineRule',
      'imageMarkFont',
      'imageMarkFontEastAsia',
      'imageMarkSizeHalfPoints',
      'imageEffectExtentTopPx',
      'imageEffectExtentBottomPx',
      'imageAlign',
      'imageIndentLeftTwips',
      'imageWrap',
      'imageBand',
      'imageWrapDistTopEmu',
      'imageWrapDistBottomEmu',
      'imageWrapDistLeftEmu',
      'imageWrapDistRightEmu',
      'imageZOrder',
      'imageOffsetXEmu',
      'imageAnchorLocked',
      'imagePosH',
      'imagePosV',
      'imageOffsetYEmu',
      'imageRelV',
      'imageRelH',
      'decorative',
      'ruleColorHex',
      'ruleThicknessPx',
      'ruleWidthPx',
      'brokenImage',
      'invisibleMarker',
      'anchorSnapToGrid',
      'strayStyleId',
      'strayIndent',
      'strayAlign',
      'strayList',
      'imageRotDeg',
      'imageFlipH',
      'imageFlipV',
      'imageBorder',
      'imageReplace',
      // the label of the mark hiding the block from AI; the model reads it, no page shows it
      'redact',
    ),
    blockRevision: REVISION,
    sectPrChange: REVISION,
    label: 'text',
    previewText: 'text',
    imageDataUrl: 'picture',
    imageLeadingText: 'text',
    table: CONTENT,
    fieldDisplay: FIELD,
    // the paragraph attributes of the line a floating object is anchored to
    anchorLine: struct()(PARAGRAPH),
    textboxes: CONTENT,
    strayRuns: CONTENT,
    formulaDisplay: FORMULA,
    chartDisplay: CHART,
    diagramDisplay: DIAGRAM,
    // the block's own XML, for a block made in this session
    genXml: 'kept',
    genImage: NEW_IMAGE,
    genChart: CHART,
  },
}

const REVISION_MARK: Fields = { author: 'text', ...tokens('date', 'dateUtc', 'id', 'move') }

/** Every mark type of the schema, and the class of each of its attributes */
export const MARK_ATTRS: { readonly [type: string]: Fields } = {
  bold: {},
  italic: {},
  underline: {},
  strike: {},
  link: { href: 'link', tooltip: 'text', ...tokens('rId', 'plain') },
  refField: { name: 'text', instr: 'text', ...tokens('dirty') },
  instrField: {
    instr: 'text',
    beginXml: 'kept',
    ...tokens('dirty', 'fieldId', 'fieldPart'),
  },
  ctrlCheckbox: { sdtPr: 'kept' },
  rprChange: {
    author: 'text',
    // the previous w:rPr, as XML: a reject copies it into the run's `rawRPr`, the save writes it
    oldRPr: 'kept',
    ...tokens('date', 'dateUtc', 'id', 'old'),
  },
  docTextStyle: {
    ...tokens(
      'color',
      'sizeHalfPoints',
      'font',
      'eaSlotEmpty',
      'fontAscii',
      'eastAsiaFont',
      'csFont',
      'charSpacingTwips',
      'charScaleEm',
      'charScalePct',
      'kern',
      'kernHalfPoints',
      'highlight',
      'shading',
      'shadingDisplay',
      'textEffect',
      'dstrike',
      'positionHalfPoints',
      'vertAlign',
      'em',
      'boldOff',
      'italicOff',
      'caps',
      'vanish',
      'vanishOwn',
      'eaLang',
      'cs',
      'rtl',
      'styleId',
      'themeColor',
      'csSize',
      'csBold',
      'csItalic',
    ),
    charScaleX: TOKENS,
    textOutline: TOKENS,
    glow: TOKENS,
    bdr: TOKENS,
    themeRFonts: TOKENS,
    tblRun: TOKENS,
    rawRPr: 'kept',
  },
  redaction: { label: 'text', rawRPr: 'kept' },
  comment: tokens('ids'),
  ins: REVISION_MARK,
  del: REVISION_MARK,
  docSym: tokens('font', 'char'),
  // the chain of wrappers around the text, as JSON text
  inlineWrap: { chain: WRAPPER },
}
