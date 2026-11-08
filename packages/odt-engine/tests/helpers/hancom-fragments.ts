/**
 * XML fragment builders that mirror what Hancom (desktop Hangul and the Hancom
 * server converter) writes into an ODT. Every builder returns the exact string
 * it emits, so a test can assert that a recorded source range slices back to
 * precisely that string.
 *
 * Modelled on real Hancom files: every paragraph wraps its text in a
 * `text:span`, runs of spaces become `text:s`, paragraph styles are per
 * paragraph automatic styles (`P73_0`, `P73_0_MS1_b3`), text styles are `T<n>`,
 * tables usually sit in an as-char frame's text box, cells carry
 * `office:value-type="string"`, form fields are `NormalField…` bookmark pairs.
 */

/** Escapes text content for XML. */
export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Escapes an attribute value for a double-quoted XML attribute. */
export function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

/** Hancom writes runs of two or more spaces as one space plus `text:s`. */
export function hancomRunText(text: string): string {
  return escapeText(text).replace(/ {2,}/g, (spaces) => {
    const extra = spaces.length - 1
    return extra === 1 ? ' <text:s/>' : ` <text:s text:c="${extra}"/>`
  })
}

export interface ParagraphOptions {
  /** paragraph (automatic) style name, Hancom-like default `P1_0` */
  style?: string
  /** text style of the wrapping span, default `T1` */
  span?: string
}

/** One Hancom paragraph: text inside a single styled span. */
export function hPara(text: string, opts: ParagraphOptions = {}): string {
  const style = opts.style ?? 'P1_0'
  const span = opts.span ?? 'T1'
  if (text === '') {
    return `<text:p text:style-name="${escapeAttr(style)}"><text:span text:style-name="${escapeAttr(span)}"/></text:p>`
  }
  return `<text:p text:style-name="${escapeAttr(style)}"><text:span text:style-name="${escapeAttr(span)}">${hancomRunText(text)}</text:span></text:p>`
}

/** A paragraph whose span holds arbitrary inline XML (frames, bookmarks, notes …). */
export function hParaWith(inner: string, opts: ParagraphOptions = {}): string {
  const style = opts.style ?? 'P1_0'
  const span = opts.span ?? 'T1'
  return `<text:p text:style-name="${escapeAttr(style)}"><text:span text:style-name="${escapeAttr(span)}">${inner}</text:span></text:p>`
}

export interface CellOptions {
  style?: string
  colSpan?: number
  rowSpan?: number
  protected?: boolean
}

/** A table cell; `content` is the cell's paragraphs (or a nested table). */
export function hCell(content: string, opts: CellOptions = {}): string {
  let attrs = `table:style-name="${escapeAttr(opts.style ?? 'Table1.A1')}" office:value-type="string"`
  if (opts.protected) attrs += ' table:protected="true"'
  if (opts.colSpan && opts.colSpan > 1) attrs += ` table:number-columns-spanned="${opts.colSpan}"`
  if (opts.rowSpan && opts.rowSpan > 1) attrs += ` table:number-rows-spanned="${opts.rowSpan}"`
  return `<table:table-cell ${attrs}>${content}</table:table-cell>`
}

/** A cell hidden by a merge, written self-closing as Hancom does. */
export const COVERED_CELL = '<table:covered-table-cell/>'

export function hRow(cells: string[], style = 'Table1.1'): string {
  return `<table:table-row table:style-name="${escapeAttr(style)}">${cells.join('')}</table:table-row>`
}

/** A table: `name` doubles as the style prefix (`Table1`, `Table1.A` …). */
export function hTable(name: string, columns: number, rows: string[]): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const cols = Array.from(
    { length: columns },
    (_, i) => `<table:table-column table:style-name="${name}.${letters[i]}"/>`,
  ).join('')
  return `<table:table table:style-name="${name}">${cols}${rows.join('')}</table:table>`
}

export type AnchorType = 'as-char' | 'paragraph' | 'char' | 'page' | 'frame'

export interface FramedTable {
  /** the whole top-level paragraph */
  paragraph: string
  /** the `draw:frame` element */
  frame: string
  /** the `draw:text-box` element */
  textBox: string
  /** the table itself */
  table: string
}

/**
 * Hancom's most common table placement (60% of tables):
 * `text:p > text:span > draw:frame[anchor] > draw:text-box > table:table`.
 */
export function hFramedTable(
  table: string,
  opts: { anchor?: AnchorType; frameStyle?: string; z?: number } & ParagraphOptions = {},
): FramedTable {
  const anchor = opts.anchor ?? 'as-char'
  const frameStyle = opts.frameStyle ?? 'tableinfakeframe_gr1'
  const z = opts.z ?? 1
  const textBox = `<draw:text-box>${table}</draw:text-box>`
  const frame = `<draw:frame draw:style-name="${frameStyle}" svg:x="0cm" svg:y="0cm" draw:z-index="${z}" text:anchor-type="${anchor}">${textBox}</draw:frame>`
  return {
    paragraph: hParaWith(frame, { style: opts.style ?? 'P73_0', span: opts.span ?? 'T33' }),
    frame,
    textBox,
    table,
  }
}

/** An image frame with the size and position attributes Hancom writes. */
export function hImageFrame(
  href: string,
  opts: { anchor?: AnchorType; style?: string; z?: number } = {},
): { frame: string; image: string } {
  const image = `<draw:image xlink:href="${escapeAttr(href)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>`
  const frame = `<draw:frame draw:style-name="${opts.style ?? 'gr1'}" svg:width="4.547cm" svg:height="1.342cm" svg:x="0.573cm" svg:y="0.086cm" draw:z-index="${opts.z ?? 4}" text:anchor-type="${opts.anchor ?? 'as-char'}">${image}</draw:frame>`
  return { frame, image }
}

/** A Hancom form field ("click-here" field): a `NormalField…` bookmark pair around the value. */
export function hFieldBookmark(
  name: string,
  value: string,
): { start: string; end: string; xml: string } {
  const start = `<text:bookmark-start text:name="${escapeAttr(name)}"/>`
  const end = `<text:bookmark-end text:name="${escapeAttr(name)}"/>`
  return { start, end, xml: `${start}${hancomRunText(value)}${end}` }
}

/** A footnote as Hancom writes it inside a span. */
export function hFootnote(text: string, citation = '1)'): string {
  return `<text:note text:note-class="footnote"><text:note-body>${hPara(text, { style: 'P425_11', span: 'T270' })}</text:note-body><text:note-citation>${escapeText(citation)}</text:note-citation></text:note>`
}

/** A memo: `office:annotation` … `office:annotation-end`, Hancom shape. */
export function hAnnotation(
  name: string,
  memo: string,
  anchored: string,
): { annotation: string; end: string; xml: string } {
  const annotation = `<office:annotation office:name="${escapeAttr(name)}"><dc:creator>user</dc:creator><dc:date>2024-01-02T03:04:05.000000000</dc:date>${hPara(memo, { style: 'P426_13', span: 'T9' })}</office:annotation>`
  const end = `<office:annotation-end office:name="${escapeAttr(name)}"/>`
  return { annotation, end, xml: `${annotation}${hancomRunText(anchored)}${end}` }
}

/**
 * A Hancom custom shape: its `draw:enhanced-geometry` holds `draw:equation`
 * formula elements, which are geometry, not document equations.
 */
export function hCustomShape(text: string): { shape: string; paragraph: string } {
  const paragraph = hPara(text, { style: 'P383_0', span: 'T23' })
  const shape =
    `<draw:custom-shape svg:x="0cm" svg:y="0cm" svg:width="15.946cm" svg:height="0.953cm" draw:z-index="4" draw:style-name="gr6" text:anchor-type="as-char">${paragraph}` +
    '<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="mso-spt100" draw:enhanced-path="M 0 0 L 21600 0 21600 21600 0 21600 Z N" draw:modifiers="2160">' +
    '<draw:equation draw:name="f0" draw:formula="45"/><draw:equation draw:name="f1" draw:formula="$0 *sin(?f0 *(pi/180))"/>' +
    '<draw:handle draw:handle-switched="true" draw:handle-position="$0 top" draw:handle-range-x-minimum="0" draw:handle-range-x-maximum="10800"/>' +
    '</draw:enhanced-geometry></draw:custom-shape>'
  return { shape, paragraph }
}

/** A rectangle shape with a (empty) paragraph inside, as in Hancom groups. */
export function hRect(): string {
  return '<draw:rect svg:x="7.863cm" svg:y="0cm" svg:width="9.066cm" svg:height="1.318cm" draw:z-index="21" draw:style-name="gr10" text:anchor-type="paragraph"><text:p/></draw:rect>'
}

/** An embedded formula object (`draw:object` in a frame). */
export function hFormulaObject(
  href = './Object 1',
  anchor: AnchorType = 'as-char',
): { frame: string; object: string } {
  const object = `<draw:object xlink:href="${escapeAttr(href)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>`
  const frame = `<draw:frame draw:style-name="gr20" svg:width="2.000cm" svg:height="0.600cm" draw:z-index="30" text:anchor-type="${anchor}">${object}</draw:frame>`
  return { frame, object }
}

/** MathML content for an embedded formula object part. */
export const FORMULA_CONTENT_XML =
  '<?xml version="1.0" encoding="UTF-8"?><math:math xmlns:math="http://www.w3.org/1998/Math/MathML"><math:semantics><math:mrow><math:mi>x</math:mi><math:mo>=</math:mo><math:mn>1</math:mn></math:mrow></math:semantics></math:math>'

// ---------------------------------------------------------------------------
// Styles

/** A Hancom paragraph automatic style with its usual attribute set and tab stops. */
export function hParagraphAutoStyle(
  name: string,
  opts: {
    parent?: string
    masterPage?: string
    align?: string
    tabStops?: Array<{ position: string; type?: string; leader?: string }>
  } = {},
): string {
  const parent = opts.parent ?? 'Standard'
  const master = opts.masterPage ? ` style:master-page-name="${escapeAttr(opts.masterPage)}"` : ''
  const props =
    `fo:line-height="160%" fo:text-align="${opts.align ?? 'justify'}" fo:margin-left="0cm" fo:margin-right="0cm" ` +
    'fo:text-indent="0cm" fo:margin-top="0cm" fo:margin-bottom="0cm" fo:background-color="transparent" ' +
    'fo:border="none" style:shadow="none" style:text-autospace="none" style:vertical-align="auto" ' +
    'style:snap-to-layout-grid="true"'
  const tabs = opts.tabStops
    ? `<style:tab-stops>${opts.tabStops
        .map(
          (t) =>
            `<style:tab-stop style:position="${t.position}" style:type="${t.type ?? 'left'}" style:leader-style="${t.leader ?? 'none'}"/>`,
        )
        .join('')}</style:tab-stops>`
    : ''
  const pp = tabs
    ? `<style:paragraph-properties ${props}>${tabs}</style:paragraph-properties>`
    : `<style:paragraph-properties ${props}/>`
  return `<style:style style:name="${escapeAttr(name)}" style:parent-style-name="${escapeAttr(parent)}"${master} style:family="paragraph">${pp}</style:style>`
}

/** A Hancom text automatic style (`T<n>`). */
export function hTextAutoStyle(name: string, size = '10.00pt', weight = 'normal'): string {
  return (
    `<style:style style:name="${escapeAttr(name)}" style:family="text"><style:text-properties fo:color="#000000" ` +
    'style:text-outline="false" style:text-line-through-style="none" style:text-position="0% 100%" ' +
    'style:font-name="함초롬바탕" style:font-name-asian="함초롬바탕" style:font-name-complex="함초롬바탕" ' +
    `fo:font-family="함초롬바탕" fo:font-size="${size}" style:font-size-asian="${size}" ` +
    `fo:letter-spacing="0.00pt" fo:language="en" style:language-asian="ko" fo:font-weight="${weight}" ` +
    'style:letter-kerning="false" style:text-scale="100%"/></style:style>'
  )
}

/** Table, column, row and cell automatic styles for a Hancom table named `name`. */
export function hTableAutoStyles(name: string, columns: number): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let out = `<style:style style:name="${name}" style:family="table"><style:table-properties style:width="16.697cm" table:align="left" fo:margin="0cm" style:shadow="none" style:may-break-between-rows="true" table:border-model="collapsing"/></style:style>`
  for (let i = 0; i < columns; i++) {
    out += `<style:style style:name="${name}.${letters[i]}" style:family="table-column"><style:table-column-properties style:column-width="2.302cm"/></style:style>`
  }
  out += `<style:style style:name="${name}.1" style:family="table-row"><style:table-row-properties style:min-row-height="24.34pt" fo:keep-together="auto"/></style:style>`
  out += `<style:style style:name="${name}.A1" style:family="table-cell"><style:table-cell-properties style:vertical-align="middle" style:shadow="none" fo:border="0.012cm solid #000000"/></style:style>`
  return out
}

/** The graphic style Hancom gives a table-holding frame (parent `Frame` is never defined). */
export function hFrameGraphicStyle(name: string): string {
  return `<style:style style:name="${name}" style:parent-style-name="Frame" style:family="graphic"><style:graphic-properties fo:min-width="16.697cm" fo:min-height="5.847cm" style:horizontal-pos="from-left" style:horizontal-rel="paragraph" style:vertical-pos="top" style:vertical-rel="paragraph" fo:border="none" fo:padding="0cm" style:wrap="none" style:run-through="foreground" draw:fill="none"/></style:style>`
}
