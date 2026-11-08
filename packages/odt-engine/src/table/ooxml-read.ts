/**
 * Reading `w:tbl` fragments on save: the bridge table (from the bridge map)
 * and the edited one (from the edited docx) are split into rows, cells and
 * cell items by source position, so cells can be compared byte for byte; the
 * docx engine's `TableModel` of the edited table supplies the parsed content
 * (rich paragraphs, merges, widths) in the same `w:tr`/`w:tc` order.
 */
import type { TableCell, TableModel, TableParagraph } from '@genoffice/docx-engine'
import { PrefixMap, walkElements } from '../core/xml'

export interface OxItem {
  kind: 'p' | 'tbl'
  /** exact source of the `w:p` / `w:tbl` */
  xml: string
}

export interface OxCell {
  /** exact source of the `w:tc` */
  xml: string
  /** exact `w:tcPr` ('' when none) */
  tcPr: string
  /** `w:p` and `w:tbl` children in order */
  items: OxItem[]
}

export interface OxTable {
  xml: string
  rows: Array<{ xml: string; cells: OxCell[] }>
}

interface Seg {
  name: string
  start: number
  end: number
  children: Seg[]
}

const IDENTITY = new PrefixMap()
const CONTAINER = new Set(['w:tbl', 'w:tr', 'w:tc', 'w:sdt', 'w:sdtContent'])

/** Splits a `w:tbl` source into rows, cells and cell items. */
export function segmentTable(xml: string): OxTable {
  const roots: Seg[] = []
  walkElements(xml, IDENTITY, {
    open(el, parent) {
      const seg: Seg = { name: el.name, start: el.start, end: el.start, children: [] }
      el.data = seg
      const owner = parent?.data as Seg | undefined
      if (owner) owner.children.push(seg)
      else roots.push(seg)
      // only the table skeleton is walked; paragraphs and nested tables are leaves
      if (!CONTAINER.has(el.name) || (el.name === 'w:tbl' && parent !== null)) return 'skip'
    },
    close(el) {
      ;(el.data as Seg).end = el.end
    },
  })
  const tbl = roots.find((r) => r.name === 'w:tbl')
  const out: OxTable = { xml, rows: [] }
  if (!tbl) return out
  const slice = (s: Seg) => xml.slice(s.start, s.end)
  // content controls around rows or cells are looked through
  const through = (segs: Seg[], name: string): Seg[] =>
    segs.flatMap((s) =>
      s.name === name
        ? [s]
        : s.name === 'w:sdt' || s.name === 'w:sdtContent'
          ? through(s.children, name)
          : [],
    )
  for (const tr of through(tbl.children, 'w:tr')) {
    const cells: OxCell[] = []
    for (const tc of through(tr.children, 'w:tc')) {
      const tcPr = tc.children.find((c) => c.name === 'w:tcPr')
      const items: OxItem[] = []
      const collect = (segs: Seg[]) => {
        for (const c of segs) {
          if (c.name === 'w:p') items.push({ kind: 'p', xml: slice(c) })
          else if (c.name === 'w:tbl') items.push({ kind: 'tbl', xml: slice(c) })
          else if (c.name === 'w:sdt' || c.name === 'w:sdtContent') collect(c.children)
        }
      }
      collect(tc.children)
      cells.push({ xml: slice(tc), tcPr: tcPr ? slice(tcPr) : '', items })
    }
    out.rows.push({ xml: slice(tr), cells })
  }
  return out
}

/** `w:tcPr` without the parts the grid decides (width, spans), for comparing cell formatting. */
export function normalizedTcPr(tcPr: string): string {
  return tcPr
    .replace(/<w:tcW\b[^>]*\/>/g, '')
    .replace(/<w:gridSpan\b[^>]*\/>/g, '')
    .replace(/<w:vMerge\b[^>]*\/>/g, '')
    .replace(/^<w:tcPr\/>$/, '<w:tcPr></w:tcPr>')
}

/** A `w:p` without the bridge's hidden `_odt…` bookmarks (they never survive an editor rewrite). */
export function withoutBridgeBookmarks(p: string): string {
  const ids = new Set<string>()
  let out = p.replace(/<w:bookmarkStart\b[^>]*\/>/g, (tag) => {
    const name = /\bw:name="([^"]*)"/.exec(tag)?.[1] ?? ''
    if (!name.startsWith('_odt')) return tag
    const id = /\bw:id="([^"]*)"/.exec(tag)?.[1]
    if (id !== undefined) ids.add(id)
    return ''
  })
  out = out.replace(/<w:bookmarkEnd\b[^>]*\/>/g, (tag) => {
    const id = /\bw:id="([^"]*)"/.exec(tag)?.[1]
    return id !== undefined && ids.has(id) ? '' : tag
  })
  return out
}

// ---------------------------------------------------------------------------
// The edited grid

export interface EditedAnchor {
  row: number
  col: number
  colSpan: number
  rowSpan: number
  /** index of the anchor's `w:tc` in its `w:tr` */
  tc: number
  cell: TableCell
  ox: OxCell | null
}

export interface EditedItem {
  kind: 'p' | 'tbl'
  /** source of the item in the edited docx */
  xml: string
  para?: TableParagraph
  table?: { model: TableModel; ox: OxTable }
}

export interface EditedGrid {
  rows: number
  cols: number
  anchors: EditedAnchor[]
  /** grid position → covering anchor (null: the row is shorter) */
  at: Array<Array<EditedAnchor | null>>
  widths: number[]
}

/** The merges of an edited table model as grid anchors. */
export function editedGrid(model: TableModel, ox: OxTable): EditedGrid {
  const at: Array<Array<EditedAnchor | null>> = []
  const anchors: EditedAnchor[] = []
  let cols = 0
  model.rows.forEach((row, r) => {
    const line: Array<EditedAnchor | null> = []
    at.push(line)
    let c = 0
    let tc = 0
    for (const cell of row) {
      const span = Math.max(1, Math.min(1000, Math.floor(Number(cell.colSpan ?? 1)) || 1))
      if (cell.gridGap) {
        c += span
        continue
      }
      const above = r > 0 ? at[r - 1][c] : null
      if (
        cell.vMerge === 'continue' &&
        above &&
        above.col === c &&
        above.row + above.rowSpan === r
      ) {
        above.rowSpan++
        for (let k = 0; k < above.colSpan; k++) line[c + k] = above
        c += above.colSpan
      } else {
        const anchor: EditedAnchor = {
          row: r,
          col: c,
          colSpan: span,
          rowSpan: 1,
          tc,
          cell,
          ox: ox.rows[r]?.cells[tc] ?? null,
        }
        anchors.push(anchor)
        for (let k = 0; k < span; k++) line[c + k] = anchor
        c += span
      }
      tc++
    }
    cols = Math.max(cols, c)
  })
  cols = Math.max(cols, model.colWidthsTwips?.length ?? 0, 1)
  for (const line of at) while (line.length < cols) line.push(null)
  let widths: number[]
  if (model.colWidthsTwips?.length === cols) widths = model.colWidthsTwips.map((w) => Math.round(w))
  else if (model.colWidthsPct?.length === cols) {
    const sum = model.colWidthsPct.reduce((a, b) => a + b, 0) || 100
    widths = model.colWidthsPct.map((p) => Math.round((p / sum) * 9638))
  } else widths = Array.from({ length: cols }, () => Math.round(9638 / cols))
  return { rows: model.rows.length, cols, anchors, at, widths }
}

/** The edited cell's visible items with their parsed content. */
export function editedItems(anchor: { cell: TableCell; ox: OxCell | null }): EditedItem[] {
  const paras = anchor.cell.richParas ?? []
  const tables = anchor.cell.nestedTables ?? []
  if (anchor.ox) {
    let p = 0
    let t = 0
    return anchor.ox.items.map((item): EditedItem => {
      if (item.kind === 'p') return { kind: 'p', xml: item.xml, para: paras[p++] ?? { runs: [] } }
      const model = tables[t++]
      return {
        kind: 'tbl',
        xml: item.xml,
        ...(model ? { table: { model, ox: segmentTable(item.xml) } } : {}),
      }
    })
  }
  // no source (should not happen for parsed tables): rebuild the order from anchors
  const out: EditedItem[] = paras.map((para) => ({ kind: 'p', xml: '', para }))
  const anchors = anchor.cell.nestedTableAnchors ?? []
  for (let i = tables.length - 1; i >= 0; i--) {
    const at = Math.min(anchors[i] ?? out.length, out.length)
    out.splice(at, 0, {
      kind: 'tbl',
      xml: '',
      table: { model: tables[i], ox: { xml: '', rows: [] } },
    })
  }
  return out
}

/** Text of a cell paragraph as the bridge compares it (run texts joined). */
export const paraText = (p: { runs: Array<{ text: string }> } | undefined): string =>
  (p?.runs ?? []).map((r) => r.text).join('')
