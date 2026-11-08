/**
 * ODF → OOXML for tables.
 *
 * A table becomes one `w:tbl` with a fixed grid (column widths from the
 * column styles), row heights, header rows (`w:tblHeader`), merges
 * (`w:gridSpan` / `w:vMerge`), and per cell its borders, fill, vertical
 * alignment and padding. Cell paragraphs are converted by the text layer's
 * `paragraphToOoxml`; tables in cells (bare or framed) become nested tables.
 *
 * The cell properties are written exactly as the docx engine regenerates them
 * from its own model (`tcW`, `gridSpan`, `vMerge`, `tcBorders`, `shd`,
 * `tcMar`, `vAlign`, in schema order), so an editor that rewrites the table
 * reproduces the same `w:tcPr` for an untouched cell. The save side relies on
 * that to tell untouched cells from edited ones.
 */
import type { CellBorder, CellBorders } from '@genoffice/docx-engine'
import type { OdtNode } from '../core/body'
import type { OdfToOoxmlContext } from '../core/convert'
import { escapeXmlAttr } from '../core/xml'
import { listInstance } from '../text/lists'
import { paragraphToOoxml } from '../text/paragraph-ooxml'
import { lengthToTwips } from '../text/units'
import {
  type AnchorCellRecord,
  type CellRecord,
  type ColumnRecord,
  type ElementRecord,
  type FrameRecord,
  type NestedStep,
  type RowRecord,
  type TableExt,
  type TableRecord,
  type UnitRecord,
  TABLE_OWNER,
} from './model'
import {
  type FrameHost,
  type TableFrame,
  cellIsProtected,
  contentUnits,
  readGrid,
  rowHeightCm,
  styleProps,
  tcIndexes,
} from './odf-read'

/** Default width of a table whose styles give none: A4 text width with 2 cm margins (twips). */
const DEFAULT_TABLE_TWIPS = 9638

export const elementRecord = (n: {
  start: number
  end: number
  openEnd: number
  closeStart: number
  selfClosing: boolean
}): ElementRecord => ({
  start: n.start,
  end: n.end,
  openEnd: n.openEnd,
  closeStart: n.closeStart,
  selfClosing: n.selfClosing,
})

// ---------------------------------------------------------------------------
// Cell properties

/** The cell look the bridge maps, in the docx engine's model shape (what it writes into `w:tcPr`). */
export interface CellProps {
  fill?: string
  vAlign?: 'center' | 'bottom'
  borders?: CellBorders
}

const ODF_TO_OOXML_BORDER: Record<string, string> = {
  solid: 'single',
  double: 'double',
  dotted: 'dotted',
  dashed: 'dashed',
  'dash-dot': 'dotDash',
  'dash-dot-dot': 'dotDotDash',
  'double-thin': 'double',
  groove: 'threeDEngrave',
  ridge: 'threeDEmboss',
  inset: 'inset',
  outset: 'outset',
  'fine-dashed': 'dashSmallGap',
  wave: 'wave',
}

/** An ODF border (`0.012cm solid #000000`, `none`) as an engine border, or null when unset. */
export function borderFromOdf(value: string | undefined): CellBorder | null {
  if (value === undefined) return null
  const tokens = value.trim().split(/\s+/)
  let width: number | undefined
  let style = 'solid'
  let color: string | undefined
  for (const t of tokens) {
    const tw = lengthToTwips(t)
    if (tw !== undefined) width = tw
    else if (/^#[0-9a-fA-F]{6}$/.test(t)) color = t.slice(1).toUpperCase()
    else if (/^#[0-9a-fA-F]{3}$/.test(t))
      color = t
        .slice(1)
        .split('')
        .map((c) => c + c)
        .join('')
        .toUpperCase()
    else style = t.toLowerCase()
  }
  if (style === 'none' || style === 'hidden' || width === 0) return { style: 'nil' }
  const ooxml = ODF_TO_OOXML_BORDER[style] ?? 'single'
  // w:sz is in eighths of a point; a double line's width covers both lines and the gap
  const pt = (width ?? 20) / 20
  const sz = Math.max(2, Math.min(96, Math.round((pt * 8) / (ooxml === 'double' ? 3 : 1))))
  return { style: ooxml, szEighths: sz, color: color ?? '000000' }
}

/** The cell properties the bridge maps from a cell style. */
export function cellPropsFromOdf(props: Record<string, string>): {
  props: CellProps
  margins: { top?: number; left?: number; bottom?: number; right?: number }
} {
  const out: CellProps = {}
  const bg = props['fo:background-color']
  if (bg && /^#[0-9a-fA-F]{6}$/.test(bg)) out.fill = bg.slice(1).toUpperCase()
  const va = props['style:vertical-align']
  if (va === 'middle') out.vAlign = 'center'
  else if (va === 'bottom') out.vAlign = 'bottom'
  const all = props['fo:border']
  const borders: CellBorders = {}
  for (const side of ['top', 'left', 'bottom', 'right'] as const) {
    const b = borderFromOdf(props[`fo:border-${side}`] ?? all)
    if (b) borders[side] = b
  }
  const tl = borderFromOdf(props['style:diagonal-tl-br'])
  if (tl && tl.style !== 'nil') borders.tl2br = tl
  const bl = borderFromOdf(props['style:diagonal-bl-tr'])
  if (bl && bl.style !== 'nil') borders.tr2bl = bl
  if (Object.keys(borders).length) out.borders = borders
  const margins: { top?: number; left?: number; bottom?: number; right?: number } = {}
  for (const side of ['top', 'left', 'bottom', 'right'] as const) {
    const t = lengthToTwips(props[`fo:padding-${side}`] ?? props['fo:padding'])
    if (t !== undefined) margins[side] = Math.max(0, Math.round(t))
  }
  return { props: out, margins }
}

/** `w:tcBorders` exactly as the docx engine writes it. */
export function cellBordersXml(borders: CellBorders): string {
  const side = (name: keyof CellBorders) => {
    const b = borders[name]
    if (!b) return ''
    if (b.style === 'none' || b.style === 'nil') return `<w:${name} w:val="${b.style}"/>`
    return `<w:${name} w:val="${escapeXmlAttr(b.style)}" w:sz="${b.szEighths ?? 4}" w:space="0" w:color="${escapeXmlAttr(b.color ?? 'auto')}"/>`
  }
  return `<w:tcBorders>${side('top')}${side('left')}${side('bottom')}${side('right')}${side('tl2br')}${side('tr2bl')}</w:tcBorders>`
}

function tcPrXml(
  width: number,
  span: number,
  vMerge: 'restart' | 'continue' | null,
  props: CellProps,
  margins: { top?: number; left?: number; bottom?: number; right?: number },
): string {
  let x = `<w:tcW w:w="${width}" w:type="dxa"/>`
  if (span > 1) x += `<w:gridSpan w:val="${span}"/>`
  if (vMerge === 'restart') x += '<w:vMerge w:val="restart"/>'
  else if (vMerge === 'continue') x += '<w:vMerge/>'
  if (props.borders) x += cellBordersXml(props.borders)
  if (props.fill) x += `<w:shd w:val="clear" w:color="auto" w:fill="${props.fill}"/>`
  const mar = (['top', 'left', 'bottom', 'right'] as const)
    .filter((s) => margins[s] !== undefined)
    .map((s) => `<w:${s} w:w="${margins[s]}" w:type="dxa"/>`)
    .join('')
  if (mar) x += `<w:tcMar>${mar}</w:tcMar>`
  if (props.vAlign) x += `<w:vAlign w:val="${props.vAlign}"/>`
  return `<w:tcPr>${x}</w:tcPr>`
}

// ---------------------------------------------------------------------------
// Tables

export interface ConvertedTable {
  xml: string
  record: TableRecord
  /** locked cells of this table and its nested tables (`table` is filled in by the caller) */
  protectedCells: Array<{ path: NestedStep[]; row: number; col: number; tc: number }>
}

export interface TableEnv {
  blockId: number
  ext: TableExt
  host: TableRecord['host']
  frame: FrameRecord | null
  /** the frame paragraph's alignment for as-char framed tables (`center`, `right`) */
  align?: 'center' | 'right' | null
  /** the table sits in a locked cell: all its cells are locked too */
  locked?: boolean
}

function columnWidths(ctx: OdfToOoxmlContext, grid: ReturnType<typeof readGrid>): number[] {
  const doc = ctx.doc
  const tableProps = styleProps(
    doc,
    grid.table.attr('table:style-name'),
    'table',
    'style:table-properties',
  )
  const tableWidth = lengthToTwips(tableProps['style:width'])
  const abs: Array<number | undefined> = []
  const rel: Array<number | undefined> = []
  for (const col of grid.columns) {
    const p = styleProps(
      doc,
      col.node?.attr('table:style-name'),
      'table-column',
      'style:table-column-properties',
    )
    abs.push(lengthToTwips(p['style:column-width']))
    const r = /^\s*(\d+(?:\.\d+)?)\*\s*$/.exec(p['style:rel-column-width'] ?? '')
    rel.push(r ? parseFloat(r[1]) : undefined)
  }
  if (abs.every((w) => w !== undefined && w > 0))
    return abs.map((w) => Math.max(1, Math.round(w as number)))
  const total = tableWidth ?? DEFAULT_TABLE_TWIPS
  if (rel.every((w) => w !== undefined && w > 0)) {
    const sum = rel.reduce((a, b) => (a as number) + (b as number), 0) as number
    return rel.map((w) => Math.max(1, Math.round(((w as number) / sum) * total)))
  }
  const known = abs.filter((w): w is number => w !== undefined && w > 0)
  const rest = Math.max(0, total - known.reduce((a, b) => a + b, 0))
  const missing = abs.length - known.length
  return abs.map((w) =>
    Math.max(1, Math.round(w !== undefined && w > 0 ? w : rest / Math.max(1, missing))),
  )
}

/** Converts a `table:table` node (and the tables nested in its cells) to a `w:tbl`. */
export function convertTable(ctx: OdfToOoxmlContext, node: OdtNode, env: TableEnv): ConvertedTable {
  const doc = ctx.doc
  const xml = ctx.part('content.xml').xml
  const grid = readGrid(node)
  const widths = columnWidths(ctx, grid)
  const total = widths.reduce((a, b) => a + b, 0)
  const tcs = tcIndexes(grid.cells)
  const record: TableRecord = {
    ...elementRecord(node),
    id: env.ext.tables.length,
    block: env.blockId,
    element: null,
    host: env.host,
    frame: env.frame,
    headerRows: grid.headerRows ? elementRecord(grid.headerRows) : null,
    rows: [],
    columns: [],
    cells: [],
    widthTwips: total,
    structureLocked: grid.structureLocked,
  }
  env.ext.tables.push(record)
  const protectedCells: ConvertedTable['protectedCells'] = []
  const tableLocked = !!env.locked || node.attr('table:protected') === 'true'

  record.columns = grid.columns.map((col, i): ColumnRecord =>
    col.node
      ? {
          ...elementRecord(col.node),
          style: col.node.attr('table:style-name') ?? null,
          repeated: col.repeated,
          widthTwips: widths[i],
        }
      : {
          start: -1,
          end: -1,
          openEnd: -1,
          closeStart: -1,
          selfClosing: true,
          style: null,
          repeated: false,
          widthTwips: widths[i],
        },
  )

  // cell properties per anchor (also used by vertical-merge continuations)
  const propsOf = new Map<string, ReturnType<typeof cellPropsFromOdf>>()
  const cellProps = (r: number, c: number) => {
    const key = `${r},${c}`
    let p = propsOf.get(key)
    if (!p) {
      const n = grid.cells[r][c].node
      p = cellPropsFromOdf(
        styleProps(doc, n?.attr('table:style-name'), 'table-cell', 'style:table-cell-properties'),
      )
      propsOf.set(key, p)
    }
    return p
  }
  const widthOf = (c: number, span: number) => widths.slice(c, c + span).reduce((a, b) => a + b, 0)

  let rowsXml = ''
  grid.rows.forEach((row, r) => {
    const height = rowHeightCm(doc, row.node.attr('table:style-name'))
    record.rows.push({
      ...elementRecord(row.node),
      header: row.header,
      style: row.node.attr('table:style-name') ?? null,
      heightCm: height ? height.cm : null,
    } satisfies RowRecord)
    const cellRecords: CellRecord[] = []
    let tcXml = ''
    grid.cells[r].forEach((cell, c) => {
      const [ar, ac] = cell.anchor
      const range = cell.node
        ? { start: cell.node.start, end: cell.node.end }
        : { start: -1, end: -1 }
      if (ar !== r || ac !== c) {
        const tc = tcs[r][c]
        cellRecords.push({ kind: 'covered', ...range, anchor: [ar, ac], tc })
        if (tc === null) return
        // continuation of a vertical merge: same look as its anchor
        const anchor = grid.cells[ar][ac]
        const p = cellProps(ar, ac)
        tcXml += `<w:tc>${tcPrXml(widthOf(c, anchor.colSpan), anchor.colSpan, 'continue', p.props, p.margins)}<w:p/></w:tc>`
        return
      }
      if (cell.kind !== 'cell' || !cell.node) {
        // a covered cell no merge explains, or a gap the ODT left: an empty cell
        cellRecords.push({
          kind: cell.node ? 'orphan' : 'filler',
          ...range,
          tc: tcs[r][c] as number,
        })
        tcXml += `<w:tc>${tcPrXml(widthOf(c, 1), 1, null, {}, {})}<w:p/></w:tc>`
        return
      }
      const rec: AnchorCellRecord = {
        kind: 'cell',
        ...elementRecord(cell.node),
        tc: tcs[r][c] as number,
        style: cell.node.attr('table:style-name') ?? null,
        units: [],
      }
      if (cell.colSpan > 1) rec.colSpan = cell.colSpan
      if (cell.rowSpan > 1) rec.rowSpan = cell.rowSpan
      cellRecords.push(rec)
      const p = cellProps(r, c)
      if (cellIsProtected(doc, cell.node, tableLocked)) {
        rec.protected = true
        protectedCells.push({ path: [], row: r, col: c, tc: rec.tc })
      }
      const content = convertCellContent(ctx, cell.node, xml, env, record, r, c, rec)
      for (const nested of content.protectedCells) protectedCells.push(nested)
      tcXml += `<w:tc>${tcPrXml(
        widthOf(c, cell.colSpan),
        cell.colSpan,
        cell.rowSpan > 1 ? 'restart' : null,
        p.props,
        p.margins,
      )}${content.xml}</w:tc>`
    })
    record.cells.push(cellRecords)
    let trPr = ''
    if (height) {
      const tw = Math.round((height.cm * 1440) / 2.54)
      if (tw > 0)
        trPr += `<w:trHeight w:val="${tw}" w:hRule="${height.exact ? 'exact' : 'atLeast'}"/>`
    }
    if (row.header) trPr += '<w:tblHeader/>'
    rowsXml += `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}${tcXml}</w:tr>`
  })

  const tableProps = styleProps(
    doc,
    node.attr('table:style-name'),
    'table',
    'style:table-properties',
  )
  const align = tableProps['table:align']
  const jc =
    align === 'center' || align === 'right'
      ? align
      : (align === undefined || align === 'left' || align === 'margins') && env.align
        ? env.align
        : null
  const indent = jc ? undefined : lengthToTwips(tableProps['fo:margin-left'])
  const nil = (s: string) => `<w:${s} w:val="nil"/>`
  const tblPr =
    `<w:tblPr><w:tblW w:w="${total}" w:type="dxa"/>` +
    (jc ? `<w:jc w:val="${jc}"/>` : '') +
    (indent && Math.round(indent) !== 0
      ? `<w:tblInd w:w="${Math.round(indent)}" w:type="dxa"/>`
      : '') +
    `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(nil).join('')}</w:tblBorders>` +
    '<w:tblLayout w:type="fixed"/>' +
    '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>' +
    '</w:tblPr>'
  const tblGrid = `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`
  if (grid.structureLocked)
    ctx.warn(
      `table structure kept as written (${grid.structureLocked}): only cell text is editable`,
    )
  return { xml: `<w:tbl>${tblPr}${tblGrid}${rowsXml}</w:tbl>`, record, protectedCells }
}

/** Converts the content of an anchor cell; fills `rec.units` and `rec.synthetic`. */
function convertCellContent(
  ctx: OdfToOoxmlContext,
  cell: OdtNode,
  xml: string,
  env: TableEnv,
  table: TableRecord,
  row: number,
  col: number,
  rec: AnchorCellRecord,
): { xml: string; protectedCells: ConvertedTable['protectedCells'] } {
  const units = contentUnits(cell, xml)
  const lists = new Map<OdtNode, ReturnType<typeof listInstance>>()
  let out = ''
  let lastWasTable = false
  let tableIndex = 0
  const protectedCells: ConvertedTable['protectedCells'] = []
  const nested: NestedTable = (node, frame, align) => {
    const step: NestedStep = { row, col, index: tableIndex }
    const converted = convertTable(ctx, node, {
      blockId: env.blockId,
      ext: env.ext,
      host: { table: table.id, row, col, index: tableIndex },
      frame,
      align,
      locked: rec.protected,
    })
    tableIndex++
    for (const p of converted.protectedCells) protectedCells.push({ ...p, path: [step, ...p.path] })
    return { id: converted.record.id, xml: converted.xml }
  }
  for (const u of units) {
    if (u.kind === 'p') {
      let list: Parameters<typeof paragraphToOoxml>[2]['list'] = null
      if (u.list) {
        let inst = lists.get(u.list.root)
        if (!inst) {
          inst = listInstance(ctx, env.blockId, {
            styleName: u.list.root.attr('text:style-name') ?? null,
            xmlId: u.list.root.attr('xml:id') ?? null,
            continueList: u.list.root.attr('text:continue-list') ?? null,
            continueNumbering: u.list.root.attr('text:continue-numbering') === 'true',
          })
          lists.set(u.list.root, inst)
        }
        list = {
          numId: inst.numId,
          level: u.list.depth,
          kind: inst.kinds[Math.min(8, u.list.depth)] ?? 'ordered',
          header: u.list.header,
          continuation: u.list.continuation,
        }
      }
      const p = paragraphToOoxml(ctx, u.node, {
        part: 'content.xml',
        owner: TABLE_OWNER,
        block: env.blockId,
        list,
      })
      out += p.xml
      lastWasTable = false
      rec.units.push({ kind: 'p', paragraph: p.paragraph.id, start: u.node.start, end: u.node.end })
    } else if (u.kind === 't') {
      const t = nested(u.node, null, null)
      out += t.xml
      lastWasTable = true
      rec.units.push({ kind: 't', table: t.id, start: u.node.start, end: u.node.end })
    } else {
      const host = convertFrameHost(ctx, u.host, env.blockId, nested)
      for (const part of host.parts) out += part.xml
      lastWasTable = host.parts[host.parts.length - 1]?.kind === 'table'
      rec.units.push(host.unit)
    }
  }
  if (!units.length) {
    rec.synthetic = 'empty'
    out += '<w:p/>'
  } else if (lastWasTable) {
    rec.synthetic = 'trailing'
    out += '<w:p/>'
  }
  return { xml: out, protectedCells }
}

export function frameRecord(host: FrameHost, f: TableFrame): FrameRecord {
  return {
    paragraph: { start: host.node.start, end: host.node.end },
    frame: elementRecord(f.frame),
    style: f.frame.attr('draw:style-name') ?? null,
    anchor: f.frame.attr('text:anchor-type') ?? null,
  }
}

/** The alignment an as-char framed table takes from its paragraph. */
export function hostAlignment(
  ctx: OdfToOoxmlContext,
  host: FrameHost,
  f: TableFrame,
): 'center' | 'right' | null {
  if ((f.frame.attr('text:anchor-type') ?? 'paragraph') !== 'as-char') return null
  const p = styleProps(
    ctx.doc,
    host.node.attr('text:style-name'),
    'paragraph',
    'style:paragraph-properties',
  )
  const a = p['fo:text-align']
  return a === 'center' ? 'center' : a === 'end' || a === 'right' ? 'right' : null
}

/** Converts one table found in a frame (or a cell) and returns its record id and `w:tbl`. */
export type NestedTable = (
  node: OdtNode,
  frame: FrameRecord | null,
  align: TableEnv['align'],
) => { id: number; xml: string }

/**
 * A paragraph holding framed tables. A pure one shows only its tables; a
 * mixed one also shows its own text as a paragraph (before the tables when
 * its text starts before the first frame, else after them). The framed
 * tables of a mixed paragraph stay in its text as kept markers.
 */
export function convertFrameHost(
  ctx: OdfToOoxmlContext,
  host: FrameHost,
  blockId: number,
  table: NestedTable,
): {
  parts: Array<{ kind: 'paragraph' | 'table'; xml: string; paragraph: number | null }>
  unit: Extract<UnitRecord, { kind: 'f' }>
} {
  const parts: Array<{ kind: 'paragraph' | 'table'; xml: string; paragraph: number | null }> = []
  let paragraph: number | null = null
  const text = () => {
    const p = paragraphToOoxml(ctx, host.node, {
      part: 'content.xml',
      owner: TABLE_OWNER,
      block: blockId,
    })
    paragraph = p.paragraph.id
    parts.push({ kind: 'paragraph', xml: p.xml, paragraph: p.paragraph.id })
  }
  if (!host.pure && host.paragraphFirst) text()
  const ids: number[] = []
  for (const f of host.frames) {
    const t = table(f.table, frameRecord(host, f), hostAlignment(ctx, host, f))
    ids.push(t.id)
    parts.push({ kind: 'table', xml: t.xml, paragraph: null })
  }
  if (!host.pure && !host.paragraphFirst) text()
  return {
    parts,
    unit: {
      kind: 'f',
      start: host.node.start,
      end: host.node.end,
      paragraph,
      paragraphFirst: !host.pure && host.paragraphFirst,
      tables: ids,
    },
  }
}
