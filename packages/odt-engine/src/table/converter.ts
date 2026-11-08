/**
 * The table owner: the block converter for body-level tables and paragraphs
 * holding framed tables, and the free writer for tables the editor created.
 */
import type { Block } from '@genoffice/docx-engine'
import type { OdtNode } from '../core/body'
import type {
  BlockConverter,
  BridgeElement,
  EditedItem,
  FreeWriter,
  OdfToOoxmlContext,
  OoxmlToOdfContext,
} from '../core/convert'
import { blockSource, paragraphBlockOf } from '../core/flow'
import { editedParagraphFromBlock, paragraphToOdf } from '../text/paragraph-odf'
import { convertFrameHost, convertTable, type ConvertedTable } from './forward'
import { type TableBlockData, type TableExt, TABLE_OWNER, asJson, emptyTableExt } from './model'
import { frameHostOf } from './odf-read'
import { editedGrid, paraText, segmentTable } from './ooxml-read'
import { newTableOdf, tableExt, writeFrameHost, writeTable, type TableResult } from './reverse'

const extOf = (ctx: OdfToOoxmlContext): TableExt =>
  ctx.ext('table', () => asJson(emptyTableExt())) as unknown as TableExt

/** Publishes a converted top-level table: its element id, its locked cells. */
function publish(ext: TableExt, converted: ConvertedTable, element: BridgeElement): void {
  converted.record.element = element.id
  ext.elements[String(element.id)] = converted.record.id
  for (const p of converted.protectedCells) ext.protectedCells.push({ table: element.id, ...p })
}

const tableBlockOf = (item: EditedItem): Block | null =>
  item.blocks.length === 1 && item.blocks[0].type === 'table' && item.blocks[0].table
    ? item.blocks[0]
    : null

/**
 * A paragraph holding only pictures comes back from the editor as a picture
 * block that no bookmark ties to its paragraph. When its pictures (`odt-pic:`
 * / `odt-keep:` names) come from the text paragraph of a frame host, it is
 * that paragraph: the host writes it, with the pictures as the objects layer
 * writes them, instead of the paragraph coming out twice (once from the host,
 * once as a new picture paragraph holding the frames again).
 */
function isHostPictureParagraph(
  rctx: OoxmlToOdfContext,
  paragraph: number,
  item: EditedItem,
): boolean {
  if (paragraphBlockOf(item) || !item.xml.startsWith('<w:p') || !item.xml.includes('<w:drawing>'))
    return false
  const objects = rctx.map.ext.objects as
    | {
        pictures?: Array<{ name: string; paragraph: number | null }>
        placeholders?: Array<{ name: string; paragraph: number | null }>
      }
    | undefined
  const owners = new Map<string, number | null>()
  for (const o of [...(objects?.pictures ?? []), ...(objects?.placeholders ?? [])])
    owners.set(o.name, o.paragraph)
  const names = [...item.xml.matchAll(/\bname="(odt-(?:pic|keep):[^"]+)"/g)].map((m) => m[1])
  return names.length > 0 && names.every((n) => owners.get(n) === paragraph)
}

export const tableBlockConverter: BlockConverter = {
  id: TABLE_OWNER,
  match(node: OdtNode, ctx: OdfToOoxmlContext) {
    if (node.kind === 'table') return !node.selfClosing
    return frameHostOf(node, ctx.part('content.xml').xml) !== null
  },
  toOoxml(ctx, node, env) {
    const ext = extOf(ctx)
    if (node.kind === 'table') {
      const converted = convertTable(ctx, node, {
        blockId: env.blockId,
        ext,
        host: null,
        frame: null,
      })
      publish(ext, converted, ctx.addElement(env.blockId, converted.xml, 'table'))
      const data: TableBlockData = {
        kind: 'table',
        paragraph: null,
        paragraphFirst: false,
        tables: [converted.record.id],
      }
      return { elements: [], data: asJson(data) }
    }
    const host = frameHostOf(node, ctx.part('content.xml').xml)!
    const converted = new Map<number, ConvertedTable>()
    const res = convertFrameHost(ctx, host, env.blockId, (table, frame, align) => {
      const t = convertTable(ctx, table, {
        blockId: env.blockId,
        ext,
        host: null,
        frame,
        align,
      })
      converted.set(t.record.id, t)
      return { id: t.record.id, xml: t.xml }
    })
    let next = 0
    for (const part of res.parts) {
      const element = ctx.addElement(env.blockId, part.xml, part.kind, part.paragraph)
      if (part.kind === 'table') publish(ext, converted.get(res.unit.tables[next++])!, element)
    }
    const data: TableBlockData = {
      kind: 'frames',
      paragraph: res.unit.paragraph,
      paragraphFirst: res.unit.paragraphFirst,
      tables: res.unit.tables,
    }
    return { elements: [], data: asJson(data) }
  },
  toOdf(rctx, block, items, env) {
    const ext = tableExt(rctx)
    const data = block.data as unknown as TableBlockData
    const tables = new Map<number, TableResult | 'deleted' | 'unchanged'>()
    for (const id of data.tables) tables.set(id, 'deleted')
    type Para = { state: 'unchanged' } | { state: 'deleted' } | { state: 'changed'; xml: string }
    let para: Para = data.paragraph === null ? { state: 'unchanged' } : { state: 'deleted' }
    const extra: EditedItem[] = []
    for (const a of items) {
      if (
        !a.element &&
        data.kind === 'frames' &&
        data.paragraph !== null &&
        para.state === 'deleted' &&
        isHostPictureParagraph(rctx, data.paragraph, a.item)
      ) {
        const writer = rctx.registry.freeWriterFor(a.item)
        if (writer) {
          para = { state: 'changed', xml: writer.toOdf(rctx, [a.item], env) }
          continue
        }
      }
      if (!a.element || a.element.block !== block.id) {
        extra.push(a.item)
        continue
      }
      if (a.element.kind === 'table') {
        const id = ext.elements[String(a.element.id)]
        const rec = id === undefined ? undefined : ext.tables[id]
        if (!rec) continue
        const edited = tableBlockOf(a.item)
        if (a.unchanged) tables.set(id, 'unchanged')
        else if (!edited?.table) {
          rctx.warn('a table came back as something else; the original table was kept')
          tables.set(id, 'unchanged')
        } else {
          const res = writeTable(
            rctx,
            ext,
            rec,
            { model: edited.table, ox: segmentTable(a.item.xml) },
            segmentTable(a.element.xml),
          )
          tables.set(id, res.changed ? res : 'unchanged')
        }
      } else if (data.paragraph !== null && a.element.paragraph === data.paragraph) {
        const origin = rctx.map.paragraphs[data.paragraph]
        const p = paragraphBlockOf(a.item)
        if (a.unchanged || !p || !origin) para = { state: 'unchanged' }
        else {
          const xml = paragraphToOdf(rctx, editedParagraphFromBlock(p), origin, {
            part: 'content.xml',
          })
          para =
            xml === rctx.part('content.xml').xml.slice(origin.start, origin.end)
              ? { state: 'unchanged' }
              : { state: 'changed', xml }
        }
      }
    }
    let out: string
    if (data.kind === 'table') {
      const r = tables.get(data.tables[0])
      out = r === 'deleted' ? '' : !r || r === 'unchanged' ? blockSource(rctx, block) : r.xml
    } else {
      out = writeFrameHost(
        rctx,
        ext,
        { start: block.start, end: block.end, paragraph: data.paragraph, tables: data.tables },
        para,
        tables,
      ).xml
    }
    if (extra.length) {
      if (data.kind === 'frames')
        rctx.warn('content inserted among the tables of one frame paragraph was placed after them')
      let k = 0
      while (k < extra.length) {
        const writer = rctx.registry.freeWriterFor(extra[k])
        let m = k + 1
        while (m < extra.length && rctx.registry.freeWriterFor(extra[m]) === writer) m++
        if (writer) out += writer.toOdf(rctx, extra.slice(k, m), env)
        else rctx.warn(`dropped a new ${extra[k].blocks[0]?.type ?? 'element'} with no writer`)
        k = m
      }
    }
    return out
  },
  absorbs(rctx, block, item) {
    const data = block.data as unknown as TableBlockData | undefined
    return (
      data?.kind === 'frames' &&
      data.paragraph !== null &&
      isHostPictureParagraph(rctx, data.paragraph, item)
    )
  },
  identify(rctx, item, candidates) {
    const edited = tableBlockOf(item)
    if (!edited?.table) return null
    const tables = candidates.filter((c) => c.kind === 'table')
    if (tables.length <= 1) return tables[0]?.id ?? null
    const ext = tableExt(rctx)
    const grid = editedGrid(edited.table, segmentTable(item.xml))
    let best = tables[0].id
    let bestScore = -1
    for (const c of tables) {
      const rec = ext.tables[ext.elements[String(c.id)]]
      if (!rec) continue
      let score = grid.rows === rec.rows.length ? 1 : 0
      for (const a of grid.anchors) {
        const cell = rec.cells[a.row]?.[a.col]
        if (!cell || cell.kind !== 'cell') continue
        const text = cell.units
          .map((u) => (u.kind === 'p' ? (rctx.map.paragraphs[u.paragraph]?.text ?? '') : ''))
          .join('\n')
        const mine = (a.cell.richParas ?? []).map((p) => paraText(p)).join('\n')
        if (text && text === mine) score += 2
      }
      if (score > bestScore) {
        bestScore = score
        best = c.id
      }
    }
    return best
  },
}

/** Tables the editor created (no original): body-level ODF tables with new styles. */
export const tableFreeWriter: FreeWriter = {
  id: TABLE_OWNER,
  match(item) {
    return tableBlockOf(item) !== null
  },
  toOdf(rctx, items) {
    return items
      .map((item) => {
        const block = tableBlockOf(item)
        return block?.table
          ? newTableOdf(rctx, { model: block.table, ox: segmentTable(item.xml) })
          : ''
      })
      .join('')
  },
}
