/**
 * OOXML → ODF for tables the editor changed.
 *
 * Same grid (rows, columns and merges as in the original): every cell is
 * compared with the bridge; an untouched cell keeps its original bytes, an
 * edited cell is rewritten in place — only its changed paragraphs are
 * replaced, everything else (row and table tags, other cells, styles) is
 * copied. Cell paragraphs carry no identity bookmark, so they are matched by
 * position and text (common prefix/suffix, then in order); form-field
 * bookmarks follow their text through `placeMarkers`, also across paragraphs
 * split or joined inside a cell.
 *
 * Changed grid (rows/columns added or deleted, cells merged or split): the
 * table is rebuilt from the original pieces. Rows and columns are matched to
 * the original ones by content; matched cells keep their bytes when
 * unchanged, new rows copy a neighbour row's row style and per-cell styles,
 * new columns copy a neighbour column, and the frame around a framed table is
 * kept with its size updated.
 *
 * Cells Hancom locked never change: an edit there is dropped with a warning,
 * and a structural change that would move, merge or delete a locked cell
 * leaves the whole table as it was.
 */
import type { CellBorder, CellBorders, TableCell, TableModel } from '@genoffice/docx-engine'
import {
  type BridgeParagraph,
  type OoxmlToOdfContext,
  type TextPatch,
  applyTextPatches,
} from '../core/convert'
import { decodeXmlEntities, walkElements } from '../core/xml'
import { paragraphNeedsRewrite } from '../objects/package'
import { keptCharacters, type Placement, placeMarkers } from '../text/markers'
import { readParagraph } from '../text/paragraph-model'
import {
  editedParagraphFromTableParagraph,
  originalModel,
  paragraphToOdf,
} from '../text/paragraph-odf'
import { editStyleXml, newStyleXml, patchStartTag } from '../text/style-xml'
import { lengthToTwips, twipsToCm } from '../text/units'
import type { AttrOverrides } from '../text/props'
import { type CellProps, cellPropsFromOdf } from './forward'
import {
  type AnchorCellRecord,
  type CellRecord,
  anchorOf,
  spanOf,
  type TableExt,
  type TableRecord,
  type UnitRecord,
  emptyTableExt,
} from './model'
import {
  type EditedAnchor,
  type EditedGrid,
  type EditedItem,
  type OxCell,
  type OxTable,
  editedGrid,
  editedItems as cellItems,
  normalizedTcPr,
  paraText,
  segmentTable,
  withoutBridgeBookmarks,
} from './ooxml-read'
import { lengthCm, styleProps } from './odf-read'

const PART = 'content.xml' as const

export interface TableResult {
  /** ODF of the `table:table` element */
  xml: string
  changed: boolean
  /** change of the summed row heights (cm), for the frame around the table */
  heightDeltaCm: number
  /** change of the table width (twips) */
  widthDeltaTwips: number
}

export interface EditedTable {
  model: TableModel
  ox: OxTable
}

export function tableExt(rctx: OoxmlToOdfContext): TableExt {
  return (rctx.ext('table') as unknown as TableExt | undefined) ?? emptyTableExt()
}

const xmlOf = (rctx: OoxmlToOdfContext) => rctx.part(PART).xml
const sourceOf = (rctx: OoxmlToOdfContext, r: { start: number; end: number }) =>
  xmlOf(rctx).slice(r.start, r.end)

/** Applies patches whose offsets index the part string to `source`, which starts at `base`. */
function patchSlice(
  source: string,
  base: number,
  patches: Array<{ start: number; end: number; xml: string }>,
): string {
  return applyTextPatches(
    source,
    patches.map((p): TextPatch => ({
      part: PART,
      start: p.start - base,
      end: p.end - base,
      xml: p.xml,
    })),
  )
}

const closeTagOf = (rctx: OoxmlToOdfContext, r: { closeStart: number; end: number }) =>
  xmlOf(rctx).slice(r.closeStart, r.end)

const tagName = (startTag: string) => /^<([^\s/>]+)/.exec(startTag)?.[1] ?? 'table:table-cell'

/** A start tag that can take content (self-closing ones are opened). */
const openTag = (tag: string) => tag.replace(/\s*\/>$/, '>')

// ---------------------------------------------------------------------------
// Paragraphs

/** The original paragraph's semantics equal those of `candidate` (same tags around the same text). */
function sameParagraph(
  rctx: OoxmlToOdfContext,
  origin: BridgeParagraph,
  candidate: string,
): boolean {
  // atoms with text (notes) cannot be compared; zero-length ones (pictures,
  // placeholders) read back as kept markers and are compared by their bytes
  if (origin.markers.some((m) => m.kind === 'handler' && m.length > 0)) return false
  const a = originalModel(rctx, origin)
  if (!a) return false
  const tops: Array<{
    start: number
    openEnd: number
    closeStart: number
    end: number
    selfClosing: boolean
  }> = []
  walkElements(candidate, rctx.part(PART).prefixes, {
    open(_el, parent) {
      if (parent !== null) return 'skip'
    },
    close(el, parent) {
      if (parent === null) tops.push({ ...el })
    },
  })
  if (tops.length !== 1 || tops[0].start !== 0 || tops[0].end !== candidate.length) return false
  const info = { ...rctx.part(PART), xml: candidate }
  const b = readParagraph({ info, styles: rctx.doc.styles }, tops[0])
  if (a.openTag !== b.openTag) return false
  const text = a.text.endsWith('\f') && !b.text.endsWith('\f') ? a.text.slice(0, -1) : a.text
  if (text !== b.text) return false
  for (let i = 0; i < b.text.length; i++) {
    const sa = a.charSets[i]
    const sb = b.charSets[i]
    if (sa < 0 || sb < 0) return false
    if (a.sets[sa].key !== b.sets[sb].key) return false
  }
  if (a.markers.length !== b.markers.length) return false
  const xml = xmlOf(rctx)
  return a.markers.every((m, i) => {
    const n = b.markers[i]
    return (
      (m.kind === n.kind || (m.kind === 'handler' && n.kind === 'keep')) &&
      m.offset === n.offset &&
      xml.slice(m.start, m.end) === candidate.slice(n.start, n.end)
    )
  })
}

/** The docx style id the bridge wrote for a paragraph (its `w:pStyle`), if any. */
function styleIdOf(p: BridgeParagraph | null): string | undefined {
  const m = p ? /<w:pStyle w:val="([^"]*)"\/>/.exec(p.pPr) : null
  return m ? decodeXmlEntities(m[1]) : undefined
}

interface WriteParaOptions {
  follows: BridgeParagraph | null
  placements?: Placement[]
  /** the bridge `w:p` of the origin (null when not comparable) */
  bridgeXml: string | null
}

/** Writes an edited cell paragraph; an unchanged one returns its original bytes. */
function writeParagraph(
  rctx: OoxmlToOdfContext,
  item: EditedItem,
  origin: BridgeParagraph | null,
  opts: WriteParaOptions,
): { xml: string; changed: boolean } {
  const para = editedParagraphFromTableParagraph(item.para ?? { runs: [] })
  // the docx engine regenerates a table's cell paragraphs without `w:pStyle`
  // (`generateTableModelXml`): a missing style id there means "not changed"
  if (para.styleId === undefined) para.styleId = styleIdOf(origin ?? opts.follows)
  if (!origin) {
    return {
      xml: paragraphToOdf(rctx, para, null, {
        part: PART,
        neighbour: opts.follows,
        follows: opts.follows,
        ...(opts.placements ? { placements: opts.placements } : {}),
      }),
      changed: true,
    }
  }
  const src = sourceOf(rctx, origin)
  // a note in it changed although the paragraph's OOXML did not (objects layer)
  const dirty = paragraphNeedsRewrite(rctx, origin.id)
  if (!dirty && !opts.placements && opts.bridgeXml !== null && item.xml) {
    if (
      item.xml === opts.bridgeXml ||
      withoutBridgeBookmarks(item.xml) === withoutBridgeBookmarks(opts.bridgeXml)
    )
      return { xml: src, changed: false }
  }
  const candidate = paragraphToOdf(rctx, para, origin, {
    part: PART,
    ...(opts.placements ? { placements: opts.placements } : {}),
  })
  if (candidate === src) return { xml: src, changed: false }
  if (
    !dirty &&
    !opts.placements &&
    paraText(item.para) === origin.text &&
    sameParagraph(rctx, origin, candidate)
  )
    return { xml: src, changed: false }
  return { xml: candidate, changed: true }
}

// ---------------------------------------------------------------------------
// Cell content

type OrigItem =
  | { kind: 'p'; para: BridgeParagraph; unit: number; foreign: boolean }
  | { kind: 't'; table: TableRecord; unit: number; foreign: boolean }
  | { kind: 's' }

/** A cell's content as the bridge showed it, in order (matches the bridge `w:tc` items). */
function originalItems(
  rctx: OoxmlToOdfContext,
  ext: TableExt,
  cell: AnchorCellRecord,
  foreign: boolean,
): OrigItem[] {
  const out: OrigItem[] = []
  const para = (id: number, unit: number) => {
    const p = rctx.map.paragraphs[id]
    if (p) out.push({ kind: 'p', para: p, unit, foreign })
  }
  cell.units.forEach((u, i) => {
    if (u.kind === 'p') para(u.paragraph, i)
    else if (u.kind === 't') out.push({ kind: 't', table: ext.tables[u.table], unit: i, foreign })
    else {
      if (u.paragraph !== null && u.paragraphFirst) para(u.paragraph, i)
      for (const t of u.tables) out.push({ kind: 't', table: ext.tables[t], unit: i, foreign })
      if (u.paragraph !== null && !u.paragraphFirst) para(u.paragraph, i)
    }
  })
  if (!foreign && cell.synthetic) out.push({ kind: 's' })
  return out
}

type TableOutcome = TableResult | 'deleted' | 'unchanged'
type ParaOutcome = { state: 'unchanged' } | { state: 'deleted' } | { state: 'changed'; xml: string }

export interface ContentResult {
  /** new inner XML of the cell (between its tags) */
  inner: string
  changed: boolean
}

/**
 * Rewrites the content of `primary` from the edited cell items. `others` are
 * original cells merged into it (their paragraphs follow the primary's and
 * lend their markers). Untouched paragraphs and tables keep their bytes.
 */
export function writeCellContent(
  rctx: OoxmlToOdfContext,
  ext: TableExt,
  primary: AnchorCellRecord,
  others: AnchorCellRecord[],
  edited: EditedItem[],
  bridge: OxCell | null,
  neighbour: BridgeParagraph | null,
): ContentResult {
  const xml = xmlOf(rctx)
  const own = originalItems(rctx, ext, primary, false)
  // bridge items line up with the primary's own items
  const bridgeXmlOf = new Map<OrigItem, string>()
  if (bridge && bridge.items.length === own.length)
    own.forEach((o, i) => bridgeXmlOf.set(o, bridge.items[i].xml))
  const origs = [
    ...own.filter((o) => o.kind !== 's'),
    ...others.flatMap((c) => originalItems(rctx, ext, c, true)),
  ]

  let items = [...edited]
  if (primary.synthetic === 'trailing') {
    const last = items[items.length - 1]
    if (last?.kind === 'p' && paraText(last.para) === '' && items[items.length - 2]?.kind === 'tbl')
      items = items.slice(0, -1)
  } else if (primary.synthetic === 'empty' && !others.length) {
    if (items.length === 1 && items[0].kind === 'p' && paraText(items[0].para) === '') items = []
  }

  const oParas = origs.filter((o): o is Extract<OrigItem, { kind: 'p' }> => o.kind === 'p')
  const oTables = origs.filter(
    (o): o is Extract<OrigItem, { kind: 't' }> => o.kind === 't' && !o.foreign,
  )
  const eParas = items.filter((e) => e.kind === 'p')
  const eTables = items.filter((e) => e.kind === 'tbl')

  // paragraphs: common prefix and suffix by text, then in order
  const origin = new Map<EditedItem, Extract<OrigItem, { kind: 'p' }>>()
  const placements = new Map<EditedItem, Placement[]>()
  let pre = 0
  while (
    pre < oParas.length &&
    pre < eParas.length &&
    paraText(eParas[pre].para) === oParas[pre].para.text
  ) {
    origin.set(eParas[pre], oParas[pre])
    pre++
  }
  let suf = 0
  while (
    suf < oParas.length - pre &&
    suf < eParas.length - pre &&
    paraText(eParas[eParas.length - 1 - suf].para) === oParas[oParas.length - 1 - suf].para.text
  ) {
    origin.set(eParas[eParas.length - 1 - suf], oParas[oParas.length - 1 - suf])
    suf++
  }
  const om = oParas.slice(pre, oParas.length - suf)
  const em = eParas.slice(pre, eParas.length - suf)
  for (let k = 0; k < Math.min(om.length, em.length); k++) origin.set(em[k], om[k])
  if (om.length && em.length && om.length !== em.length) {
    // split or joined paragraphs: markers follow the text across them
    const texts = em.map((e) => paraText(e.para))
    const recs = om.map((o) => o.para)
    const kept = keptCharacters(recs, texts)
    const sources = [recs[0]]
    recs.slice(1).forEach((p, n) => {
      if (p.text.length > 0 && kept[n + 1] * 2 >= p.text.length) sources.push(p)
      else if (kept[n + 1] > 0 && p.markers.some((m) => m.kind.startsWith('bookmark')))
        rctx.warn(
          'bookmarks of a deleted cell paragraph were dropped although part of its text survives',
        )
    })
    const placed = placeMarkers(rctx, sources, texts)
    em.forEach((e, k) => placements.set(e, placed.placements[k]))
  }

  // tables: in order
  const tableOrigin = new Map<EditedItem, Extract<OrigItem, { kind: 't' }>>()
  eTables.forEach((e, k) => {
    if (oTables[k]) tableOrigin.set(e, oTables[k])
  })

  // outcomes per original unit item
  const paraOutcome = new Map<number, ParaOutcome>() // by paragraph id
  const tableOutcome = new Map<number, TableOutcome>() // by table id
  for (const o of oParas) paraOutcome.set(o.para.id, { state: 'deleted' })
  for (const o of oTables) tableOutcome.set(o.table.id, 'deleted')

  const unitEnd = (unit: number) => primary.units[unit].end
  const inserts: Array<{ at: number; xml: string }> = []
  const firstStart = primary.units.length ? primary.units[0].start : primary.openEnd
  let insertAt = firstStart
  // a paragraph typed before the first original one takes that one's style
  let follows: BridgeParagraph | null = neighbour ?? oParas.find((o) => !o.foreign)?.para ?? null
  let changed = false
  for (const e of items) {
    if (e.kind === 'p') {
      const o = origin.get(e)
      const res = writeParagraph(rctx, e, o ? o.para : null, {
        follows,
        placements: placements.get(e),
        bridgeXml: o ? (bridgeXmlOf.get(o) ?? null) : null,
      })
      if (o && !o.foreign) {
        paraOutcome.set(
          o.para.id,
          res.changed ? { state: 'changed', xml: res.xml } : { state: 'unchanged' },
        )
        insertAt = unitEnd(o.unit)
      } else {
        inserts.push({ at: insertAt, xml: res.xml })
        changed = true
      }
      if (o) follows = o.para
      continue
    }
    const o = tableOrigin.get(e)
    if (o && e.table) {
      const bridgeTbl = bridgeXmlOf.get(o)
      const res = writeTable(
        rctx,
        ext,
        o.table,
        e.table,
        bridgeTbl !== undefined ? segmentTable(bridgeTbl) : null,
      )
      tableOutcome.set(o.table.id, res.changed ? res : 'unchanged')
      insertAt = unitEnd(o.unit)
    } else if (o) {
      tableOutcome.set(o.table.id, 'unchanged')
      insertAt = unitEnd(o.unit)
    } else if (e.table) {
      inserts.push({ at: insertAt, xml: newTableOdf(rctx, e.table) })
      changed = true
    }
  }

  // replacements per original unit
  const patches: Array<{ start: number; end: number; xml: string }> = []
  primary.units.forEach((u) => {
    const r = unitReplacement(rctx, ext, u, paraOutcome, tableOutcome)
    if (r !== null) patches.push({ start: u.start, end: u.end, xml: r })
  })
  for (const ins of inserts) patches.push({ start: ins.at, end: ins.at, xml: ins.xml })
  if (!patches.length && !changed) {
    return {
      inner: primary.selfClosing ? '' : xml.slice(primary.openEnd, primary.closeStart),
      changed: false,
    }
  }
  const innerSource = primary.selfClosing ? '' : xml.slice(primary.openEnd, primary.closeStart)
  const inner = patchSlice(innerSource, primary.openEnd, patches)
  return { inner, changed: inner !== innerSource }
}

/** The new XML of one original content unit, or null when it is unchanged. */
function unitReplacement(
  rctx: OoxmlToOdfContext,
  ext: TableExt,
  u: UnitRecord,
  paras: Map<number, ParaOutcome>,
  tables: Map<number, TableOutcome>,
): string | null {
  if (u.kind === 'p') {
    const o = paras.get(u.paragraph)
    if (!o || o.state === 'unchanged') return null
    return o.state === 'deleted' ? '' : o.xml
  }
  if (u.kind === 't') {
    const o = tables.get(u.table)
    if (!o || o === 'unchanged') return null
    return o === 'deleted' ? '' : o.changed ? o.xml : null
  }
  const para = u.paragraph === null ? { state: 'unchanged' as const } : paras.get(u.paragraph)
  const res = writeFrameHost(
    rctx,
    ext,
    { start: u.start, end: u.end, paragraph: u.paragraph, tables: u.tables },
    para ?? { state: 'unchanged' },
    tables,
  )
  return res.changed ? res.xml : null
}

// ---------------------------------------------------------------------------
// Frames

/**
 * The paragraph holding framed tables, with each frame's table replaced (or
 * the frame removed when its table was deleted). A changed paragraph text is
 * written by the text layer, which keeps the frames as markers; they are then
 * swapped for the new frames.
 */
export function writeFrameHost(
  rctx: OoxmlToOdfContext,
  ext: TableExt,
  host: { start: number; end: number; paragraph: number | null; tables: number[] },
  para: ParaOutcome,
  tables: Map<number, TableOutcome>,
): { xml: string; changed: boolean } {
  const xml = xmlOf(rctx)
  const src = xml.slice(host.start, host.end)
  const frames = host.tables.map((id) => {
    const rec = ext.tables[id]
    const outcome = tables.get(id) ?? 'unchanged'
    const frame = rec.frame
    let replacement: string | null = null
    if (frame && outcome === 'deleted') replacement = ''
    else if (frame && outcome !== 'unchanged' && outcome !== 'deleted' && outcome.changed)
      replacement = frameXml(rctx, rec, outcome)
    return { rec, outcome, replacement }
  })
  if (host.paragraph === null && frames.every((f) => f.outcome === 'deleted'))
    return { xml: '', changed: true }
  const byOffsets = () =>
    patchSlice(
      src,
      host.start,
      frames
        .filter((f) => f.replacement !== null && f.rec.frame)
        .map((f) => ({
          start: f.rec.frame!.frame.start,
          end: f.rec.frame!.frame.end,
          xml: f.replacement as string,
        })),
    )
  let out: string
  if (para.state === 'changed') {
    out = para.xml
    let cursor = 0
    let lost = false
    for (const f of frames) {
      if (!f.rec.frame) continue
      const original = xml.slice(f.rec.frame.frame.start, f.rec.frame.frame.end)
      const at = out.indexOf(original, cursor)
      if (at < 0) {
        lost = true
        break
      }
      const replacement = f.replacement ?? original
      out = out.slice(0, at) + replacement + out.slice(at + original.length)
      cursor = at + replacement.length
    }
    if (lost) {
      rctx.warn('a paragraph holding a table could not keep its text edit; its text was kept')
      out = byOffsets()
    }
  } else {
    if (para.state === 'deleted')
      rctx.warn('the text beside a framed table cannot be deleted on its own; it was kept')
    out = byOffsets()
  }
  return { xml: out, changed: out !== src }
}

const cm = (value: number) => `${Math.max(0, value).toFixed(3)}cm`

/** The frame element around a rewritten table, its size following the table. */
function frameXml(rctx: OoxmlToOdfContext, rec: TableRecord, res: TableResult): string {
  const xml = xmlOf(rctx)
  const frame = rec.frame!.frame
  let tag = xml.slice(frame.start, frame.openEnd)
  const dh = res.heightDeltaCm
  const dw = (res.widthDeltaTwips * 2.54) / 1440
  if (Math.abs(dh) > 0.0005 || Math.abs(dw) > 0.0005) {
    const prefixes = rctx.part(PART).prefixes
    const attrs = (name: string) => {
      const m = new RegExp(`\\s${name.replace(':', '\\:')}="([^"]*)"`).exec(tag)
      return m ? m[1] : undefined
    }
    const over: AttrOverrides = {}
    const grow = (name: string, delta: number) => {
      const v = lengthCm(attrs(name))
      if (v !== null && Math.abs(delta) > 0.0005) over[name] = cm(v + delta)
    }
    grow('svg:height', dh)
    grow('fo:min-height', dh)
    grow('svg:width', dw)
    grow('fo:min-width', dw)
    const styleName = rec.frame!.style
    const style = styleName ? rctx.doc.styles.find(styleName, 'graphic', 'content') : undefined
    if (style && style.automatic && style.part === PART) {
      const gp = style.properties['style:graphic-properties'] ?? {}
      const props: AttrOverrides = {}
      const h = lengthCm(gp['fo:min-height'])
      const w = lengthCm(gp['fo:min-width'])
      if (h !== null && Math.abs(dh) > 0.0005) props['fo:min-height'] = cm(h + dh)
      if (w !== null && Math.abs(dw) > 0.0005) props['fo:min-width'] = cm(w + dw)
      const sh = lengthCm(gp['svg:height'])
      if (sh !== null && Math.abs(dh) > 0.0005) props['svg:height'] = cm(sh + dh)
      if (Object.keys(props).length) {
        const name = rctx.derivedStyle(
          PART,
          JSON.stringify(['frame', style.name, props]),
          style.name,
          (n) =>
            editStyleXml(xml.slice(style.start, style.end), prefixes, {
              name: n,
              attrs: { 'style:display-name': null },
              props: { 'style:graphic-properties': props },
            }),
        )
        over['draw:style-name'] = name
      }
    }
    if (Object.keys(over).length) tag = patchStartTag(tag, prefixes, over)
  }
  return tag + xml.slice(frame.openEnd, rec.start) + res.xml + xml.slice(rec.end, frame.end)
}

// ---------------------------------------------------------------------------
// Cell formatting

const normStyle = (b: CellBorder | undefined) =>
  !b || b.style === 'none' || b.style === 'nil'
    ? 'none'
    : `${b.style}|${b.szEighths ?? 4}|${(b.color ?? 'auto').toUpperCase()}`

const OOXML_TO_ODF_BORDER: Record<string, string> = {
  single: 'solid',
  thick: 'solid',
  double: 'double',
  dotted: 'dotted',
  dashed: 'dashed',
  dotDash: 'dash-dot',
  dotDotDash: 'dash-dot-dot',
  threeDEngrave: 'groove',
  threeDEmboss: 'ridge',
  inset: 'inset',
  outset: 'outset',
  dashSmallGap: 'fine-dashed',
  wave: 'wave',
}

/** An engine border as an ODF border value. */
export function borderToOdf(b: CellBorder | undefined): string {
  if (!b || b.style === 'none' || b.style === 'nil') return 'none'
  const style = OOXML_TO_ODF_BORDER[b.style] ?? 'solid'
  const pt = ((b.szEighths ?? 4) / 8) * (style === 'double' ? 3 : 1)
  const color =
    b.color && /^[0-9a-fA-F]{6}$/.test(b.color) ? `#${b.color.toLowerCase()}` : '#000000'
  return `${((pt * 2.54) / 72).toFixed(3)}cm ${style} ${color}`
}

/** ODF cell-style overrides for what the editor changed against the bridge's mapped props. */
function cellOverrides(
  original: CellProps,
  cell: TableCell,
  styleAttrs: Record<string, string>,
): AttrOverrides {
  const over: AttrOverrides = {}
  const fill = cell.fill?.toUpperCase()
  if ((fill ?? '') !== (original.fill ?? ''))
    over['fo:background-color'] = fill ? `#${fill.toLowerCase()}` : 'transparent'
  const va = cell.vAlign === 'center' || cell.vAlign === 'bottom' ? cell.vAlign : undefined
  if (va !== original.vAlign)
    over['style:vertical-align'] = va === 'center' ? 'middle' : va === 'bottom' ? 'bottom' : 'top'
  const ob = original.borders ?? {}
  const eb: CellBorders = cell.borders ?? {}
  // undefined borders on the edited side: the editor did not model them (kept as they were)
  if (cell.borders) {
    const sides = ['top', 'left', 'bottom', 'right'] as const
    if (sides.some((s) => normStyle(eb[s]) !== normStyle(ob[s]))) {
      const all = styleAttrs['fo:border']
      for (const s of sides) {
        const value = eb[s] ? borderToOdf(eb[s]) : (styleAttrs[`fo:border-${s}`] ?? all ?? 'none')
        over[`fo:border-${s}`] = value
      }
      if (all !== undefined) over['fo:border'] = null
    }
    if (normStyle(eb.tl2br) !== normStyle(ob.tl2br))
      over['style:diagonal-tl-br'] = borderToOdf(eb.tl2br)
    if (normStyle(eb.tr2bl) !== normStyle(ob.tr2bl))
      over['style:diagonal-bl-tr'] = borderToOdf(eb.tr2bl)
  }
  return over
}

/** A cell style deriving from `base` with `over` applied (a new automatic style). */
function derivedCellStyle(
  rctx: OoxmlToOdfContext,
  base: string | null,
  over: AttrOverrides,
): string {
  const xml = xmlOf(rctx)
  const prefixes = rctx.part(PART).prefixes
  const style = base ? rctx.doc.styles.find(base, 'table-cell', 'content') : undefined
  const auto = style && style.automatic && style.part === PART ? style : undefined
  return rctx.derivedStyle(PART, JSON.stringify(['cell', base, over]), base ?? 'Cell', (name) =>
    auto
      ? editStyleXml(xml.slice(auto.start, auto.end), prefixes, {
          name,
          attrs: { 'style:display-name': null },
          props: { 'style:table-cell-properties': over },
        })
      : editStyleXml(newStyleXml(name, 'table-cell', style ? style.name : null), prefixes, {
          props: { 'style:table-cell-properties': over },
        }),
  )
}

// ---------------------------------------------------------------------------
// Cells

interface CellOutcome {
  xml: string
  changed: boolean
  contentChanged: boolean
}

/** Writes one anchor cell: original bytes when untouched, else the patched tag and content. */
function writeCellElement(
  rctx: OoxmlToOdfContext,
  ext: TableExt,
  src: AnchorCellRecord,
  others: AnchorCellRecord[],
  a: EditedAnchor,
  bridge: OxCell | null,
  spans: { colSpan: number; rowSpan: number } | null,
  neighbour: BridgeParagraph | null,
): CellOutcome {
  const xml = xmlOf(rctx)
  const original = xml.slice(src.start, src.end)
  const content = writeCellContent(rctx, ext, src, others, cellItems(a), bridge, neighbour)
  const over: AttrOverrides = {}
  const sameTcPr =
    bridge !== null && a.ox !== null && normalizedTcPr(a.ox.tcPr) === normalizedTcPr(bridge.tcPr)
  if (!sameTcPr) {
    const attrs = styleProps(rctx.doc, src.style, 'table-cell', 'style:table-cell-properties')
    const props = cellOverrides(propsOf(rctx, src), a.cell, attrs)
    if (Object.keys(props).length)
      over['table:style-name'] = derivedCellStyle(rctx, src.style, props)
  }
  if (spans) {
    const own = spanOf(src)
    if (spans.colSpan !== own.colSpan)
      over['table:number-columns-spanned'] = spans.colSpan > 1 ? String(spans.colSpan) : null
    if (spans.rowSpan !== own.rowSpan)
      over['table:number-rows-spanned'] = spans.rowSpan > 1 ? String(spans.rowSpan) : null
  }
  if (!content.changed && !Object.keys(over).length)
    return { xml: original, changed: false, contentChanged: false }
  let tag = xml.slice(src.start, src.openEnd)
  if (Object.keys(over).length) tag = patchStartTag(tag, rctx.part(PART).prefixes, over)
  let out: string
  if (src.selfClosing) {
    out = content.inner === '' ? tag : `${openTag(tag)}${content.inner}</${tagName(tag)}>`
  } else out = tag + content.inner + closeTagOf(rctx, src)
  return { xml: out, changed: out !== original, contentChanged: content.changed }
}

/** The first paragraph record of a cell, or null. */
function firstParagraph(
  rctx: OoxmlToOdfContext,
  cell: AnchorCellRecord | null,
): BridgeParagraph | null {
  for (const u of cell?.units ?? []) {
    const id = u.kind === 'p' ? u.paragraph : u.kind === 'f' ? u.paragraph : null
    if (id !== null && rctx.map.paragraphs[id]) return rctx.map.paragraphs[id]
  }
  return null
}

/** A new cell copying `template`'s tag (style, value type) without its lock and spans. */
function newCellFromTemplate(
  rctx: OoxmlToOdfContext,
  template: AnchorCellRecord | null,
  a: EditedAnchor,
): string {
  const xml = xmlOf(rctx)
  const prefixes = rctx.part(PART).prefixes
  let tag =
    template && template.start >= 0
      ? openTag(xml.slice(template.start, template.openEnd))
      : '<table:table-cell office:value-type="string">'
  const over: AttrOverrides = {
    'table:number-columns-spanned': a.colSpan > 1 ? String(a.colSpan) : null,
    'table:number-rows-spanned': a.rowSpan > 1 ? String(a.rowSpan) : null,
    'table:protected': null,
  }
  if (template) {
    const attrs = styleProps(rctx.doc, template.style, 'table-cell', 'style:table-cell-properties')
    const props = cellOverrides(propsOf(rctx, template), a.cell, attrs)
    if (Object.keys(props).length)
      over['table:style-name'] = derivedCellStyle(rctx, template.style, props)
  }
  tag = patchStartTag(tag, prefixes, over)
  const follows = firstParagraph(rctx, template)
  let inner = ''
  for (const item of cellItems(a)) {
    if (item.kind === 'p')
      inner += writeParagraph(rctx, item, null, { follows, bridgeXml: null }).xml
    else if (item.table) inner += newTableOdf(rctx, item.table)
  }
  return `${tag}${inner}</${tagName(tag)}>`
}

// ---------------------------------------------------------------------------
// Tables

/** Cell records whose anchor is their own position (cells, unexplained covered cells, gaps). */
const isAnchor = (cell: CellRecord): boolean => cell.kind !== 'covered'

/** The cell look the bridge mapped for a cell (recomputed from its ODF style). */
function propsOf(rctx: OoxmlToOdfContext, cell: AnchorCellRecord): CellProps {
  return cellPropsFromOdf(
    styleProps(rctx.doc, cell.style, 'table-cell', 'style:table-cell-properties'),
  ).props
}

function sameGrid(rec: TableRecord, g: EditedGrid): boolean {
  if (g.rows !== rec.rows.length || g.cols !== rec.columns.length) return false
  for (let r = 0; r < g.rows; r++)
    for (let c = 0; c < g.cols; c++) {
      const cell = rec.cells[r]?.[c]
      const a = g.at[r][c]
      if (!cell || !a) return false
      const [ar, ac] = anchorOf(cell, r, c)
      if (a.row !== ar || a.col !== ac) return false
      const span = spanOf(cell)
      if (isAnchor(cell) && (a.colSpan !== span.colSpan || a.rowSpan !== span.rowSpan)) return false
    }
  return true
}

const unchangedResult = (rctx: OoxmlToOdfContext, rec: TableRecord): TableResult => ({
  xml: sourceOf(rctx, rec),
  changed: false,
  heightDeltaCm: 0,
  widthDeltaTwips: 0,
})

/**
 * Writes an edited table over its original. `bridge` is the bridge `w:tbl`
 * of this table (segmented), or null when it cannot be located.
 */
export function writeTable(
  rctx: OoxmlToOdfContext,
  ext: TableExt,
  rec: TableRecord,
  edited: EditedTable,
  bridge: OxTable | null,
): TableResult {
  if (bridge && edited.ox.xml && edited.ox.xml === bridge.xml && !tableNeedsRewrite(rctx, ext, rec))
    return unchangedResult(rctx, rec)
  const grid = editedGrid(edited.model, edited.ox)
  if (sameGrid(rec, grid)) return patchTable(rctx, ext, rec, grid, bridge)
  if (rec.structureLocked) {
    rctx.warn(`a table whose structure cannot be rewritten (${rec.structureLocked}) was kept`)
    return unchangedResult(rctx, rec)
  }
  return rebuildTable(rctx, ext, rec, grid, edited, bridge)
}

/** A note in one of the cell's paragraphs (or nested tables) changed: the cell must be rewritten. */
function cellNeedsRewrite(rctx: OoxmlToOdfContext, ext: TableExt, cell: AnchorCellRecord): boolean {
  return originalItems(rctx, ext, cell, false).some((o) =>
    o.kind === 'p'
      ? paragraphNeedsRewrite(rctx, o.para.id)
      : o.kind === 't'
        ? tableNeedsRewrite(rctx, ext, o.table)
        : false,
  )
}

function tableNeedsRewrite(rctx: OoxmlToOdfContext, ext: TableExt, rec: TableRecord): boolean {
  return rec.cells.some((row) =>
    row.some((cell) => cell.kind === 'cell' && cellNeedsRewrite(rctx, ext, cell)),
  )
}

const LOCKED_WARNING = 'a locked table cell (Hancom cell protection) was not changed'

/** Paragraph texts of a table model in reading order (empty ones skipped). */
function modelTexts(model: TableModel): string[] {
  const out: string[] = []
  for (const row of model.rows)
    for (const cell of row) {
      if (cell.vMerge === 'continue' || cell.gridGap) continue
      for (const p of cell.richParas ?? []) if (paraText(p)) out.push(paraText(p))
      for (const t of cell.nestedTables ?? []) out.push(...modelTexts(t))
    }
  return out
}

/** Paragraph texts of an original table in reading order (empty ones skipped). */
function recordTexts(rctx: OoxmlToOdfContext, ext: TableExt, rec: TableRecord): string[] {
  const out: string[] = []
  for (const row of rec.cells)
    for (const cell of row) if (cell.kind === 'cell') out.push(...cellTexts(rctx, ext, cell))
  return out
}

function cellTexts(rctx: OoxmlToOdfContext, ext: TableExt, cell: AnchorCellRecord): string[] {
  const out: string[] = []
  for (const o of originalItems(rctx, ext, cell, false)) {
    if (o.kind === 'p' && o.para.text) out.push(o.para.text)
    else if (o.kind === 't') out.push(...recordTexts(rctx, ext, o.table))
  }
  return out
}

/**
 * Whether the editor changed a locked cell (its text, its tables or its
 * look) — only to report it; a locked cell is never written.
 */
function lockedCellTouched(
  rctx: OoxmlToOdfContext,
  ext: TableExt,
  cell: AnchorCellRecord,
  a: EditedAnchor,
): boolean {
  const edited: string[] = []
  for (const item of cellItems(a)) {
    if (item.kind === 'p') {
      if (paraText(item.para)) edited.push(paraText(item.para))
    } else if (item.table) edited.push(...modelTexts(item.table.model))
  }
  if (edited.join('\u0001') !== cellTexts(rctx, ext, cell).join('\u0001')) return true
  const attrs = styleProps(rctx.doc, cell.style, 'table-cell', 'style:table-cell-properties')
  return Object.keys(cellOverrides(propsOf(rctx, cell), a.cell, attrs)).length > 0
}

/** The bridge `w:tc` of an original anchor cell. */
const bridgeCell = (bridge: OxTable | null, r: number, cell: CellRecord): OxCell | null =>
  bridge && cell.tc !== null ? (bridge.rows[r]?.cells[cell.tc] ?? null) : null

/** Same grid: only edited cells (and changed column widths) are patched in place. */
function patchTable(
  rctx: OoxmlToOdfContext,
  ext: TableExt,
  rec: TableRecord,
  grid: EditedGrid,
  bridge: OxTable | null,
): TableResult {
  const patches: Array<{ start: number; end: number; xml: string }> = []
  rec.cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (!isAnchor(cell)) return
      const a = grid.at[r][c]
      if (!a) return
      const b = bridgeCell(bridge, r, cell)
      if (
        a.ox &&
        b &&
        a.ox.xml === b.xml &&
        !(cell.kind === 'cell' && cellNeedsRewrite(rctx, ext, cell))
      )
        return
      if (cell.kind !== 'cell') {
        if (cellItems(a).some((i) => i.kind === 'tbl' || paraText(i.para) !== ''))
          rctx.warn('text typed into a merged-away or missing table cell was not saved')
        return
      }
      if (cell.protected) {
        // never written (the writers would already register new styles)
        if (lockedCellTouched(rctx, ext, cell, a)) rctx.warn(LOCKED_WARNING)
        return
      }
      const res = writeCellElement(rctx, ext, cell, [], a, b, null, null)
      if (res.changed) patches.push({ start: cell.start, end: cell.end, xml: res.xml })
    }),
  )
  const widths = columnPatches(rctx, rec, grid.widths)
  patches.push(...widths.patches)
  const original = sourceOf(rctx, rec)
  const xml = patches.length ? patchSlice(original, rec.start, patches) : original
  return {
    xml,
    changed: xml !== original,
    heightDeltaCm: 0,
    widthDeltaTwips: widths.deltaTwips,
  }
}

/** Width changes of columns that keep their place: their start tags and the table's. */
function columnPatches(
  rctx: OoxmlToOdfContext,
  rec: TableRecord,
  widths: number[],
): { patches: Array<{ start: number; end: number; xml: string }>; deltaTwips: number } {
  const patches: Array<{ start: number; end: number; xml: string }> = []
  if (widths.length !== rec.columns.length) return { patches, deltaTwips: 0 }
  let delta = 0
  const changedAt = new Set<number>()
  rec.columns.forEach((col, i) => {
    if (Math.abs(widths[i] - col.widthTwips) > 2) changedAt.add(i)
  })
  if (!changedAt.size) return { patches, deltaTwips: 0 }
  const xml = xmlOf(rctx)
  const prefixes = rctx.part(PART).prefixes
  const done = new Set<number>()
  rec.columns.forEach((col, i) => {
    if (!changedAt.has(i) || col.start < 0 || done.has(col.start)) return
    if (col.repeated) {
      rctx.warn('a width change of a repeated table column was not saved')
      return
    }
    done.add(col.start)
    const name = derivedColumnStyle(rctx, col.style, widths[i])
    patches.push({
      start: col.start,
      end: col.openEnd,
      xml: patchStartTag(xml.slice(col.start, col.openEnd), prefixes, { 'table:style-name': name }),
    })
    delta += widths[i] - col.widthTwips
  })
  if (delta) {
    const tableTag = tableStartTag(rctx, rec, delta)
    if (tableTag !== null) patches.push({ start: rec.start, end: rec.openEnd, xml: tableTag })
  }
  return { patches, deltaTwips: delta }
}

function derivedColumnStyle(rctx: OoxmlToOdfContext, base: string | null, width: number): string {
  const xml = xmlOf(rctx)
  const prefixes = rctx.part(PART).prefixes
  const style = base ? rctx.doc.styles.find(base, 'table-column', 'content') : undefined
  const auto = style && style.automatic && style.part === PART ? style : undefined
  const props = { 'style:column-width': twipsToCm(width) }
  return rctx.derivedStyle(
    PART,
    JSON.stringify(['column', base, width]),
    base ?? 'Column',
    (name) =>
      auto
        ? editStyleXml(xml.slice(auto.start, auto.end), prefixes, {
            name,
            attrs: { 'style:display-name': null },
            props: { 'style:table-column-properties': props },
          })
        : editStyleXml(newStyleXml(name, 'table-column', style ? style.name : null), prefixes, {
            props: { 'style:table-column-properties': props },
          }),
  )
}

/**
 * The table's start tag with a derived style whose width grew by
 * `deltaTwips`, or null when the table style sets no width.
 */
function tableStartTag(
  rctx: OoxmlToOdfContext,
  rec: TableRecord,
  deltaTwips: number,
): string | null {
  const xml = xmlOf(rctx)
  const prefixes = rctx.part(PART).prefixes
  const tag = xml.slice(rec.start, rec.openEnd)
  const name = /\btable:style-name="([^"]*)"/.exec(tag)?.[1]
  const style = name ? rctx.doc.styles.find(decodeXmlEntities(name), 'table', 'content') : undefined
  if (!style || !style.automatic || style.part !== PART) return null
  const current = lengthToTwips(style.properties['style:table-properties']?.['style:width'])
  if (current === undefined) return null
  const width = Math.max(1, Math.round(current + deltaTwips))
  const derived = rctx.derivedStyle(
    PART,
    JSON.stringify(['table', style.name, width]),
    style.name,
    (n) =>
      editStyleXml(xml.slice(style.start, style.end), prefixes, {
        name: n,
        attrs: { 'style:display-name': null },
        props: { 'style:table-properties': { 'style:width': twipsToCm(width) } },
      }),
  )
  return patchStartTag(tag, prefixes, { 'table:style-name': derived })
}

/** The original index nearest to edited position `at` that maps somewhere (earlier first), or -1. */
function nearest(map: number[], at: number): number {
  for (let k = at; k >= 0; k--) if (map[k] >= 0) return map[k]
  for (let k = at + 1; k < map.length; k++) if (map[k] >= 0) return map[k]
  return -1
}

// ---------------------------------------------------------------------------
// Rebuilding a table whose grid changed

/** Maps edited positions to original ones: equal signatures in order (LCS), then gaps in order. */
export function mapSequence(original: string[], edited: string[]): number[] {
  const n = original.length
  const m = edited.length
  const out = Array<number>(m).fill(-1)
  if (n * m > 4_000_000) {
    for (let k = 0; k < Math.min(n, m); k++) out[k] = k
    return out
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] =
        original[i] === edited[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (original[i] === edited[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  // gaps between matches pair up in order
  let pi = 0
  let pj = 0
  for (const [a, b] of [...pairs, [n, m] as [number, number]]) {
    for (let k = 0; k < Math.min(a - pi, b - pj); k++) out[pj + k] = pi + k
    if (a < n) out[b] = a
    pi = a + 1
    pj = b + 1
  }
  return out
}

function originalCellText(rctx: OoxmlToOdfContext, cell: CellRecord): string {
  if (cell.kind !== 'cell') return ''
  const texts: string[] = []
  for (const u of cell.units) {
    const id = u.kind === 'p' ? u.paragraph : u.kind === 'f' ? u.paragraph : null
    if (id !== null) texts.push(rctx.map.paragraphs[id]?.text ?? '')
  }
  return texts.join('\u0002')
}

const editedCellText = (a: EditedAnchor) =>
  cellItems(a)
    .filter((i) => i.kind === 'p')
    .map((i) => paraText(i.para))
    .join('\u0002')

function rebuildTable(
  rctx: OoxmlToOdfContext,
  ext: TableExt,
  rec: TableRecord,
  grid: EditedGrid,
  edited: EditedTable,
  bridge: OxTable | null,
): TableResult {
  const xml = xmlOf(rctx)
  const R = rec.rows.length
  const C = rec.columns.length
  // Blank columns must not break row matching when rows also changed. Column
  // alignment below still uses the complete grid over those matched rows.
  const bothAxesChanged = grid.rows !== R && grid.cols !== C
  const rowSignature = (texts: string[]) =>
    (bothAxesChanged ? texts.filter((text) => text !== '') : texts).join('\u0001')
  // rows by content
  const origRowSig = rec.cells.map((row) =>
    rowSignature(row.map((cell) => originalCellText(rctx, cell))),
  )
  const editRowSig = grid.at.map((row, r) =>
    rowSignature(row.map((a, c) => (a && a.row === r && a.col === c ? editedCellText(a) : ''))),
  )
  const rowMap =
    grid.rows === R ? Array.from({ length: R }, (_, k) => k) : mapSequence(origRowSig, editRowSig)
  // columns by content over the matched rows
  let colMap: number[]
  if (grid.cols === C) colMap = Array.from({ length: C }, (_, k) => k)
  else {
    const pairs = rowMap.map((o, e) => [o, e]).filter(([o]) => o >= 0)
    const origColSig = Array.from({ length: C }, (_, c) =>
      pairs.map(([o]) => originalCellText(rctx, rec.cells[o][c])).join('\u0001'),
    )
    const editColSig = Array.from({ length: grid.cols }, (_, c) =>
      pairs
        .map(([, e]) => {
          const a = grid.at[e][c]
          return a && a.row === e && a.col === c ? editedCellText(a) : ''
        })
        .join('\u0001'),
    )
    colMap = mapSequence(origColSig, editColSig)
  }
  const rowBack = new Map<number, number>()
  rowMap.forEach((o, e) => o >= 0 && rowBack.set(o, e))
  const colBack = new Map<number, number>()
  colMap.forEach((o, e) => o >= 0 && colBack.set(o, e))

  // locked cells must stay where they are, with the same merge
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const cell = rec.cells[r][c]
      if (cell.kind !== 'cell' || !cell.protected) continue
      const er = rowBack.get(r)
      const ec = colBack.get(c)
      const a = er === undefined || ec === undefined ? null : grid.at[er][ec]
      const span = spanOf(cell)
      if (
        !a ||
        a.row !== er ||
        a.col !== ec ||
        a.colSpan !== span.colSpan ||
        a.rowSpan !== span.rowSpan
      ) {
        rctx.warn(
          'a table with locked cells (Hancom cell protection) kept its structure: rows, columns or merges touching them were not changed',
        )
        return unchangedResult(rctx, rec)
      }
    }

  const prefixes = rctx.part(PART).prefixes
  // columns
  const identityCols = grid.cols === C && colMap.every((o, e) => o === e)

  const widths = grid.widths
  let columnsXml = ''
  let widthDelta = 0
  const colElements = rec.columns.filter((c) => c.start >= 0)
  const widthsSame =
    identityCols && rec.columns.every((col, i) => Math.abs(widths[i] - col.widthTwips) <= 2)
  if (widthsSame && colElements.length === C) {
    columnsXml = xml.slice(colElements[0].start, colElements[colElements.length - 1].end)
    // anything between the column elements is part of that slice already
  } else {
    for (let e = 0; e < grid.cols; e++) {
      const o = colMap[e] >= 0 ? colMap[e] : nearest(colMap, e)
      const col = o >= 0 ? rec.columns[o] : null
      const width = widths[e]
      const base = col?.style ?? null
      let tag = col && col.start >= 0 ? xml.slice(col.start, col.end) : '<table:table-column/>'
      if (col?.repeated)
        tag = patchStartTag(tag, prefixes, { 'table:number-columns-repeated': null })
      // a new column as wide as its neighbour simply copies the neighbour's column
      if (!col || Math.abs(width - col.widthTwips) > 2)
        tag = patchStartTag(tag, prefixes, {
          'table:style-name': derivedColumnStyle(rctx, base, width),
        })
      columnsXml += tag
    }
    widthDelta = widths.reduce((a, b) => a + b, 0) - rec.widthTwips
  }

  // rows
  const headerOf = (e: number) => {
    const flag = edited.model.repeatHeaderRows?.[e]
    if (flag !== null && flag !== undefined) return flag
    return rowMap[e] >= 0 ? rec.rows[rowMap[e]].header : false
  }
  let heightDelta = 0
  const rowsOut: Array<{ xml: string; header: boolean }> = []
  for (let e = 0; e < grid.rows; e++) {
    const o = rowMap[e]
    const tmplIndex = o >= 0 ? o : nearest(rowMap, e)
    const tmpl = tmplIndex >= 0 ? rec.rows[tmplIndex] : null
    heightDelta += tmpl?.heightCm ?? 0
    let cells = ''
    let same = o >= 0 && identityCols
    for (let c = 0; c < grid.cols; c++) {
      const a = grid.at[e][c]
      const oc = colMap[c]
      const origCell = o >= 0 && oc >= 0 ? rec.cells[o][oc] : null
      let cellXml: string
      if (!a) {
        // a row the editor left short: an empty cell keeps the grid whole
        cellXml = '<table:table-cell office:value-type="string"><text:p/></table:table-cell>'
      } else if (a.row === e && a.col === c) {
        cellXml = rebuildAnchor(rctx, ext, rec, a, rowMap, colMap, bridge)
      } else {
        cellXml =
          origCell && origCell.kind === 'covered' && origCell.start >= 0
            ? xml.slice(origCell.start, origCell.end)
            : '<table:covered-table-cell/>'
      }
      if (
        same &&
        (!origCell || origCell.start < 0 || cellXml !== xml.slice(origCell.start, origCell.end))
      )
        same = false
      cells += cellXml
    }
    let rowXml: string
    if (same && o >= 0) rowXml = xml.slice(rec.rows[o].start, rec.rows[o].end)
    else if (tmpl) {
      const tag = xml.slice(tmpl.start, tmpl.openEnd)
      rowXml = tmpl.selfClosing
        ? `${openTag(tag)}${cells}</${tagName(tag)}>`
        : `${tag}${cells}${closeTagOf(rctx, tmpl)}`
    } else rowXml = `<table:table-row>${cells}</table:table-row>`
    rowsOut.push({ xml: rowXml, header: headerOf(e) })
  }
  for (const r of rec.rows) heightDelta -= r.heightCm ?? 0

  // header rows lead the table
  let rowsXml = ''
  let k = 0
  if (rowsOut.length && rowsOut[0].header) {
    const group = rec.headerRows
    rowsXml += group ? xml.slice(group.start, group.openEnd) : '<table:table-header-rows>'
    while (k < rowsOut.length && rowsOut[k].header) rowsXml += rowsOut[k++].xml
    rowsXml += group && !group.selfClosing ? closeTagOf(rctx, group) : '</table:table-header-rows>'
  }
  if (rowsOut.slice(k).some((r) => r.header))
    rctx.warn('header rows after the first body row became body rows')
  for (; k < rowsOut.length; k++) rowsXml += rowsOut[k].xml

  // the table element: its start tag, anything before the columns, then the rebuilt grid
  let tag = xml.slice(rec.start, rec.openEnd)
  if (widthDelta) tag = tableStartTag(rctx, rec, widthDelta) ?? tag
  const firstChild = Math.min(
    ...[
      ...colElements.map((c) => c.start),
      rec.headerRows ? rec.headerRows.start : Infinity,
      ...rec.rows.map((r) => r.start),
    ].filter((n) => n >= 0),
    rec.closeStart,
  )
  const lead = xml.slice(rec.openEnd, firstChild)
  const out = `${tag}${lead}${columnsXml}${rowsXml}${closeTagOf(rctx, rec)}`
  return {
    xml: out,
    changed: out !== sourceOf(rctx, rec),
    heightDeltaCm: heightDelta,
    widthDeltaTwips: widthDelta,
  }
}

/** One anchor cell of a rebuilt table. */
function rebuildAnchor(
  rctx: OoxmlToOdfContext,
  ext: TableExt,
  rec: TableRecord,
  a: EditedAnchor,
  rowMap: number[],
  colMap: number[],
  bridge: OxTable | null,
): string {
  const xml = xmlOf(rctx)
  const o = rowMap[a.row]
  const oc = colMap[a.col]
  const at = o >= 0 && oc >= 0 ? rec.cells[o][oc] : null
  const owner = (cell: CellRecord, r: number, c: number) => {
    const [ar, ac] = anchorOf(cell, r, c)
    const anchor = rec.cells[ar][ac]
    return anchor.kind === 'cell' ? { cell: anchor, row: ar } : null
  }
  let src: { cell: AnchorCellRecord; row: number } | null =
    at && at.kind === 'cell' ? { cell: at, row: o } : null
  // original cells the edited span now covers (a merge)
  const others: Array<{ cell: AnchorCellRecord; row: number }> = []
  for (let i = 0; i < a.rowSpan; i++)
    for (let j = 0; j < a.colSpan; j++) {
      const r = rowMap[a.row + i]
      const c = colMap[a.col + j]
      if (r === undefined || c === undefined || r < 0 || c < 0) continue
      const cell = rec.cells[r][c]
      if (cell.kind !== 'cell' || cell === src?.cell) continue
      if (!others.some((x) => x.cell === cell)) others.push({ cell, row: r })
    }
  if (!src && others.length) src = others.shift() ?? null
  if (src) {
    if (src.cell.protected) {
      // its place and merge were checked to be the same; it is never written
      if (lockedCellTouched(rctx, ext, src.cell, a)) rctx.warn(LOCKED_WARNING)
      return xml.slice(src.cell.start, src.cell.end)
    }
    return writeCellElement(
      rctx,
      ext,
      src.cell,
      others.map((x) => x.cell),
      a,
      bridgeCell(bridge, src.row, src.cell),
      { colSpan: a.colSpan, rowSpan: a.rowSpan },
      null,
    ).xml
  }
  // a new cell: its style comes from the cell it was split from, else from the
  // neighbour row's (new row) or neighbour column's (new column) cell
  let template = at ? (owner(at, o, oc)?.cell ?? null) : null
  if (!template) {
    const r = o >= 0 ? o : nearest(rowMap, a.row)
    const c = oc >= 0 ? oc : nearest(colMap, a.col)
    template = r >= 0 && c >= 0 ? (owner(rec.cells[r][c], r, c)?.cell ?? null) : null
  }
  if (!template)
    template =
      rec.cells.flat().find((cell): cell is AnchorCellRecord => cell.kind === 'cell') ?? null
  return newCellFromTemplate(rctx, template, a)
}

// ---------------------------------------------------------------------------
// New tables (no original)

/** An ODF border from a table-level border model side. */
const sideBorder = (b: CellBorder | undefined, fallback: string): string =>
  b ? borderToOdf(b) : fallback

/** A body-level ODF table for a table the editor created, with new automatic styles. */
export function newTableOdf(rctx: OoxmlToOdfContext, table: EditedTable): string {
  const { model, ox } = table
  const grid = editedGrid(model, ox)
  const widths = grid.widths
  const total = widths.reduce((a, b) => a + b, 0)
  const DEFAULT_BORDER = '0.018cm solid #000000'
  const tb = model.borders
  const tableStyle = rctx.derivedStyle(
    PART,
    JSON.stringify(['new-table', total, model.align ?? 'left']),
    'Table',
    (name) =>
      `<style:style style:name="${name}" style:family="table"><style:table-properties style:width="${twipsToCm(total)}" table:align="${model.align === 'center' || model.align === 'right' ? model.align : 'left'}" table:border-model="collapsing"/></style:style>`,
  )
  let out = `<table:table table:style-name="${tableStyle}">`
  for (const w of widths) {
    const name = rctx.derivedStyle(
      PART,
      JSON.stringify(['new-column', w]),
      'TableColumn',
      (n) =>
        `<style:style style:name="${n}" style:family="table-column"><style:table-column-properties style:column-width="${twipsToCm(w)}"/></style:style>`,
    )
    out += `<table:table-column table:style-name="${name}"/>`
  }
  const rows: Array<{ xml: string; header: boolean }> = []
  for (let r = 0; r < grid.rows; r++) {
    const h = model.rowHeightsTwips?.[r]
    let rowStyle: string | null = null
    if (h != null && h > 0) {
      const exact = model.rowHeightRules?.[r] === 'exact'
      rowStyle = rctx.derivedStyle(
        PART,
        JSON.stringify(['new-row', h, exact]),
        'TableRow',
        (n) =>
          `<style:style style:name="${n}" style:family="table-row"><style:table-row-properties ${exact ? 'style:row-height' : 'style:min-row-height'}="${twipsToCm(h)}"/></style:style>`,
      )
    }
    let cells = ''
    for (let c = 0; c < grid.cols; c++) {
      const a = grid.at[r][c]
      if (a && (a.row !== r || a.col !== c)) {
        cells += '<table:covered-table-cell/>'
        continue
      }
      const cell: TableCell | null = a ? a.cell : null
      const lastRow = a ? a.row + a.rowSpan >= grid.rows : r === grid.rows - 1
      const lastCol = a ? a.col + a.colSpan >= grid.cols : c === grid.cols - 1
      const fallback = tb ? 'none' : DEFAULT_BORDER
      const b = cell?.borders ?? {}
      const props: Record<string, string> = {
        'fo:border-top': b.top
          ? borderToOdf(b.top)
          : sideBorder(r === 0 ? tb?.top : tb?.insideH, fallback),
        'fo:border-bottom': b.bottom
          ? borderToOdf(b.bottom)
          : sideBorder(lastRow ? tb?.bottom : tb?.insideH, fallback),
        'fo:border-left': b.left
          ? borderToOdf(b.left)
          : sideBorder(c === 0 ? tb?.left : tb?.insideV, fallback),
        'fo:border-right': b.right
          ? borderToOdf(b.right)
          : sideBorder(lastCol ? tb?.right : tb?.insideV, fallback),
      }
      if (cell?.fill) props['fo:background-color'] = `#${cell.fill.toLowerCase()}`
      if (cell?.vAlign === 'center') props['style:vertical-align'] = 'middle'
      else if (cell?.vAlign === 'bottom') props['style:vertical-align'] = 'bottom'
      const mar = {
        ...(model.cellMarTwips ?? { left: 108, right: 108 }),
        ...(cell?.cellMarTwips ?? {}),
      }
      for (const side of ['top', 'left', 'bottom', 'right'] as const)
        if (mar[side] != null) props[`fo:padding-${side}`] = twipsToCm(mar[side] as number)
      const attrs = Object.entries(props)
        .map(([k, v]) => ` ${k}="${v}"`)
        .join('')
      const cellStyle = rctx.derivedStyle(
        PART,
        JSON.stringify(['new-cell', props]),
        'TableCell',
        (n) =>
          `<style:style style:name="${n}" style:family="table-cell"><style:table-cell-properties${attrs}/></style:style>`,
      )
      let tag = `<table:table-cell table:style-name="${cellStyle}" office:value-type="string"`
      if (a && a.colSpan > 1) tag += ` table:number-columns-spanned="${a.colSpan}"`
      if (a && a.rowSpan > 1) tag += ` table:number-rows-spanned="${a.rowSpan}"`
      tag += '>'
      let inner = ''
      const items = a ? cellItems(a) : []
      for (const item of items) {
        if (item.kind === 'p')
          inner += writeParagraph(rctx, item, null, { follows: null, bridgeXml: null }).xml
        else if (item.table) inner += newTableOdf(rctx, item.table)
      }
      if (!inner)
        inner = writeParagraph(rctx, { kind: 'p', xml: '', para: { runs: [] } }, null, {
          follows: null,
          bridgeXml: null,
        }).xml
      cells += `${tag}${inner}</table:table-cell>`
    }
    const rowTag = rowStyle
      ? `<table:table-row table:style-name="${rowStyle}">`
      : '<table:table-row>'
    rows.push({ xml: `${rowTag}${cells}</table:table-row>`, header: !!model.repeatHeaderRows?.[r] })
  }
  let k = 0
  if (rows.length && rows[0].header) {
    out += '<table:table-header-rows>'
    while (k < rows.length && rows[k].header) out += rows[k++].xml
    out += '</table:table-header-rows>'
  }
  for (; k < rows.length; k++) out += rows[k].xml
  return `${out}</table:table>`
}
