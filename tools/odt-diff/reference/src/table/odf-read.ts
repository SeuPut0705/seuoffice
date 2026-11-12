/**
 * Reading ODF tables from the core position map: the cell grid (spans,
 * covered cells, header rows, column definitions), the content units of a
 * cell, the "framed table" paragraphs Hancom writes, and the style
 * properties the bridge maps.
 *
 * Hancom places most tables in `text:p > draw:frame > draw:text-box >
 * table:table`; the paragraph usually holds nothing else. Covered cells are
 * explicit elements, one per grid column, so a cell's grid column is simply
 * its index in the row.
 */
import type { OdtNode } from '../core/body'
import { cellSpan } from '../core/body'
import type { OdtDocument } from '../core/open'
import { decodeXmlEntities } from '../core/xml'
import { lengthToTwips } from '../text/units'

// ---------------------------------------------------------------------------
// Framed tables

export interface TableFrame {
  frame: OdtNode
  textBox: OdtNode
  table: OdtNode
}

/**
 * The table of a `draw:frame` whose text box holds exactly one table and
 * nothing else, or null. Other layers (objects) must leave such frames to the
 * table layer.
 */
export function tableFrameOf(frame: OdtNode): TableFrame | null {
  if (frame.kind !== 'frame' || frame.children.length !== 1) return null
  const textBox = frame.children[0]
  if (textBox.kind !== 'text-box' || textBox.children.length !== 1) return null
  const table = textBox.children[0]
  if (table.kind !== 'table' || table.selfClosing) return null
  return { frame, textBox, table }
}

export interface FrameHost {
  /** the paragraph */
  node: OdtNode
  frames: TableFrame[]
  /** the paragraph holds nothing visible besides the framed tables */
  pure: boolean
  /** the paragraph's own text starts before its first framed table */
  paragraphFirst: boolean
}

const BOOKMARK_KINDS = new Set(['bookmark', 'bookmark-start', 'bookmark-end'])

/** Visible text of a markup slice (tags dropped, entities decoded), trimmed. */
function visible(xml: string): string {
  return decodeXmlEntities(xml.replace(/<[^>]*>/g, '')).trim()
}

/** A paragraph that holds framed tables, or null. */
export function frameHostOf(node: OdtNode, xml: string): FrameHost | null {
  if ((node.kind !== 'paragraph' && node.kind !== 'heading') || node.selfClosing) return null
  const frames: TableFrame[] = []
  let others = false
  for (const child of node.children) {
    const found = tableFrameOf(child)
    if (found) frames.push(found)
    else if (!BOOKMARK_KINDS.has(child.kind)) others = true
  }
  if (!frames.length) return null
  let rest = ''
  let at = node.openEnd
  for (const f of frames) {
    rest += xml.slice(at, f.frame.start)
    at = f.frame.end
  }
  rest += xml.slice(at, node.closeStart)
  const pure = !others && visible(rest) === ''
  const paragraphFirst = visible(xml.slice(node.openEnd, frames[0].frame.start)) !== ''
  return { node, frames, pure, paragraphFirst }
}

// ---------------------------------------------------------------------------
// The grid

export interface OdfGridCell {
  node: OdtNode | null
  kind: 'cell' | 'covered' | 'filler'
  anchor: [number, number]
  colSpan: number
  rowSpan: number
}

export interface OdfGrid {
  table: OdtNode
  headerRows: OdtNode | null
  rows: Array<{ node: OdtNode; header: boolean }>
  /** one per grid column (the element, possibly repeated); null when the ODT defines fewer */
  columns: Array<{ node: OdtNode | null; repeated: boolean }>
  cells: OdfGridCell[][]
  structureLocked: string | null
}

const repeatOf = (node: OdtNode, attr: string): number => {
  const n = parseInt(node.attr(attr) ?? '1', 10)
  return Number.isFinite(n) && n > 1 ? Math.min(n, 1024) : 1
}

/** Reads the grid of a `table:table` node. */
export function readGrid(table: OdtNode): OdfGrid {
  const rows: OdfGrid['rows'] = []
  const columns: OdfGrid['columns'] = []
  let headerRows: OdtNode | null = null
  let locked: string | null = null
  const lock = (why: string) => {
    if (!locked) locked = why
  }

  const addColumn = (node: OdtNode) => {
    const n = repeatOf(node, 'table:number-columns-repeated')
    for (let i = 0; i < n; i++) columns.push({ node, repeated: n > 1 })
  }
  const walkRows = (container: OdtNode, header: boolean) => {
    for (const child of container.children) {
      if (child.kind === 'table-row') {
        if (repeatOf(child, 'table:number-rows-repeated') > 1) lock('repeated rows')
        rows.push({ node: child, header })
      } else if (child.kind === 'row-group') {
        const isHeader = child.name === 'table:table-header-rows'
        if (isHeader && !headerRows && container === table) headerRows = child
        else lock(`row group ${child.name}`)
        walkRows(child, header || isHeader)
      }
    }
  }
  for (const child of table.children) {
    if (child.kind === 'table-column') addColumn(child)
    else if (child.kind === 'column-group') {
      lock(`column group ${child.name}`)
      for (const c of child.children) if (c.kind === 'table-column') addColumn(c)
    }
  }
  walkRows(table, false)

  // elements per row, repeated cells expanded
  const elements: OdtNode[][] = rows.map(({ node }) => {
    const out: OdtNode[] = []
    for (const c of node.children) {
      if (c.kind !== 'table-cell' && c.kind !== 'covered-cell') continue
      const n = repeatOf(c, 'table:number-columns-repeated')
      if (n > 1) lock('repeated cells')
      for (let i = 0; i < n; i++) out.push(c)
    }
    return out
  })
  const width = Math.max(1, columns.length, ...elements.map((e) => e.length))
  while (columns.length < width) columns.push({ node: null, repeated: false })

  const cells: OdfGridCell[][] = elements.map((row, r) =>
    Array.from({ length: width }, (_, c): OdfGridCell => {
      const node = row[c] ?? null
      if (!node) return { node: null, kind: 'filler', anchor: [r, c], colSpan: 1, rowSpan: 1 }
      return {
        node,
        kind: node.kind === 'table-cell' ? 'cell' : 'covered',
        anchor: [r, c],
        colSpan: 1,
        rowSpan: 1,
      }
    }),
  )
  // spans: a merge covers the explicit covered cells to its right and below
  const owned: Array<Array<boolean>> = cells.map((row) => row.map(() => false))
  cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell.kind !== 'cell' || !cell.node || owned[r][c]) return
      const span = cellSpan(cell.node)
      let cs = Math.min(span.columns, width - c)
      let rs = Math.min(span.rows, cells.length - r)
      // stop at a real cell or a position another merge already took
      for (let k = 1; k < cs; k++) {
        const x = cells[r][c + k]
        if (x.kind !== 'covered' || owned[r][c + k]) {
          cs = k
          break
        }
      }
      for (let k = 1; k < rs; k++) {
        let ok = true
        for (let j = 0; j < cs; j++) {
          const x = cells[r + k][c + j]
          if (x.kind !== 'covered' || owned[r + k][c + j]) ok = false
        }
        if (!ok) {
          rs = k
          break
        }
      }
      cell.colSpan = cs
      cell.rowSpan = rs
      for (let i = 0; i < rs; i++)
        for (let j = 0; j < cs; j++) {
          if (i === 0 && j === 0) continue
          owned[r + i][c + j] = true
          cells[r + i][c + j].anchor = [r, c]
        }
    }),
  )
  return {
    table,
    headerRows,
    rows,
    columns,
    cells,
    structureLocked: locked,
  }
}

/**
 * Index of the `w:tc` that starts at each grid position (null where none
 * does): an anchor cell, the continuation of a vertical merge, a covered cell
 * no merge explains, or a filler.
 */
export function tcIndexes(cells: OdfGridCell[][]): Array<Array<number | null>> {
  return cells.map((row, r) => {
    let k = 0
    return row.map((cell, c) => {
      const [ar, ac] = cell.anchor
      if (ac !== c) return null
      if (ar === r || ar < r) return k++
      return null
    })
  })
}

// ---------------------------------------------------------------------------
// Cell content

export type UnitDraft =
  | {
      kind: 'p'
      node: OdtNode
      /** list membership inside the cell */
      list: { root: OdtNode; depth: number; header: boolean; continuation: boolean } | null
    }
  | { kind: 't'; node: OdtNode }
  | { kind: 'f'; node: OdtNode; host: FrameHost }

/** The content units of a cell (paragraphs anywhere outside nested tables, tables, framed tables). */
export function contentUnits(container: OdtNode, xml: string): UnitDraft[] {
  const out: UnitDraft[] = []
  const paragraph = (node: OdtNode, list: Extract<UnitDraft, { kind: 'p' }>['list']) => {
    const host = frameHostOf(node, xml)
    if (host) out.push({ kind: 'f', node, host })
    else out.push({ kind: 'p', node, list })
  }
  const walkList = (root: OdtNode, list: OdtNode, depth: number) => {
    for (const item of list.children) {
      if (item.kind !== 'list-item') {
        walk(item)
        continue
      }
      const header = item.name === 'text:list-header'
      let first = true
      for (const child of item.children) {
        if (child.kind === 'paragraph' || child.kind === 'heading') {
          paragraph(child, { root, depth, header, continuation: !first })
          first = false
        } else if (child.kind === 'list') walkList(root, child, depth + 1)
        else walk(child)
      }
    }
  }
  const walk = (node: OdtNode) => {
    switch (node.kind) {
      case 'paragraph':
      case 'heading':
        paragraph(node, null)
        break
      case 'table':
        out.push({ kind: 't', node })
        break
      case 'list':
        walkList(node, node, 0)
        break
      case 'section':
        for (const c of node.children) walk(c)
        break
      default:
        // bookmarks and anything else stay in the cell's bytes
        break
    }
  }
  for (const child of container.children) walk(child)
  return out
}

// ---------------------------------------------------------------------------
// Style properties

/** Effective properties of an automatic or common style of `family` (content.xml scope). */
export function styleProps(
  doc: OdtDocument,
  name: string | null | undefined,
  family: string,
  path: string,
): Record<string, string> {
  if (!name) return {}
  return { ...(doc.styles.resolve(name, family, 'content')?.properties[path] ?? {}) }
}

/** A length in cm (unrounded), or null. */
export function lengthCm(value: string | undefined): number | null {
  const t = lengthToTwips(value)
  return t === undefined ? null : (t * 2.54) / 1440
}

/** Whether a cell's own attribute or its style locks it. */
export function cellIsProtected(doc: OdtDocument, cell: OdtNode, tableLocked: boolean): boolean {
  if (tableLocked) return true
  if (cell.attr('table:protected') === 'true') return true
  const props = styleProps(
    doc,
    cell.attr('table:style-name'),
    'table-cell',
    'style:table-cell-properties',
  )
  const protect = props['style:cell-protect']
  return !!protect && /\bprotected\b/.test(protect)
}

/** Row height (cm) from the row style: fixed height, else the minimum. */
export function rowHeightCm(
  doc: OdtDocument,
  styleName: string | null | undefined,
): { cm: number; exact: boolean } | null {
  const p = styleProps(doc, styleName, 'table-row', 'style:table-row-properties')
  const exact = lengthCm(p['style:row-height'])
  if (exact !== null) return { cm: exact, exact: true }
  const min = lengthCm(p['style:min-row-height'])
  return min !== null ? { cm: min, exact: false } : null
}
