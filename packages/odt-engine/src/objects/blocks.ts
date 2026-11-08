/**
 * Block-level objects and picture paragraphs.
 *
 * - Block converter (`objects`): tables of contents and other indexes, frames
 *   and shapes standing directly in the flow, and paragraphs holding a
 *   tracked-change range each become ONE locked placeholder paragraph. Save:
 *   while the placeholder is present the block is written back as it was
 *   (resizes ignored); a deleted placeholder deletes the block.
 * - Free writer (`objects`): a paragraph holding only pictures comes back from
 *   the editor as a picture block rather than a paragraph, so a changed one
 *   (resized, replaced) no longer pairs with its bridge paragraph. It is
 *   written here: the original paragraph with the picture re-written when it
 *   held nothing else, else through the text layer with the original
 *   paragraph (found by the picture's name) as origin. New picture paragraphs
 *   are written the same way without an origin.
 */
import type { Run } from '@genoffice/docx-engine'
import { nodesOfKind, walkNodes, type OdtNode } from '../core/body'
import type {
  BlockConverter,
  BridgeParagraph,
  EditedItem,
  EditedParagraph,
  FlowEnv,
  FreeWriter,
  OdfToOoxmlContext,
  OoxmlToOdfContext,
} from '../core/convert'
import { blockSource, paragraphBlockOf } from '../core/flow'
import { walkElements } from '../core/xml'
import { paragraphToOdf } from '../text/paragraph-odf'
import { readParagraph } from '../text/paragraph-model'
import { readOoxmlPPr } from '../text/styles'
import { analyzeObject, anchorOf, textWidthEmu } from './analyze'
import { EMU_PER_CM, drawingsOf, readDrawing } from './geometry'
import {
  OBJECTS_OWNER,
  type ObjectKind,
  type ObjectPlaceholder,
  keepName,
  parseKeepName,
  parsePictureName,
} from './model'
import { placeholderDrawing, writeDrawing } from './pictures'
import { forwardState, saveState } from './state'

const LINE = Math.round(0.6 * EMU_PER_CM)

function hasTable(node: OdtNode): boolean {
  let found = false
  walkNodes(node.children, (n) => {
    if (n.kind === 'table') found = true
    return !found
  })
  return found
}

/** A paragraph holding a tracked-change range (`text:change-start`). */
function hasTrackedRange(ctx: OdfToOoxmlContext, node: OdtNode): boolean {
  const st = forwardState(ctx)
  if (!st.changeStarts) {
    st.changeStarts = [...ctx.doc.contentXml.matchAll(/:change-start\b/g)].map((m) => m.index ?? 0)
  }
  const starts = st.changeStarts
  if (!starts.length) return false
  let lo = 0
  let hi = starts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] < node.start) lo = mid + 1
    else hi = mid
  }
  if (lo >= starts.length || starts[lo] >= node.end || hasTable(node)) return false
  let found = false
  walkElements(
    ctx.doc.contentXml,
    ctx.doc.body.prefixes,
    {
      open(el) {
        if (el.name === 'text:change-start') {
          found = true
          return 'stop'
        }
      },
    },
    node.openEnd,
    node.closeStart,
  )
  return found
}

export const objectsBlockConverter: BlockConverter = {
  id: OBJECTS_OWNER,
  match(node, ctx) {
    if (node.kind === 'index') return true
    if (node.kind === 'frame' || node.kind === 'shape') return !hasTable(node)
    if (node.kind === 'paragraph' || node.kind === 'heading')
      return !node.selfClosing && hasTrackedRange(ctx, node)
    return false
  },
  toOoxml(ctx, node, env) {
    const st = forwardState(ctx)
    const id = String(++st.seq)
    const info = ctx.part('content.xml')
    let kind: ObjectKind
    let width = textWidthEmu(ctx.doc)
    let height: number
    let preview: Parameters<typeof placeholderDrawing>[2] = null
    let entries: string[] = []
    let finalText: string | null = null
    let anchor: Parameters<typeof placeholderDrawing>[3] = null
    if (node.kind === 'index') {
      kind = node.name === 'text:table-of-content' ? 'toc' : 'object'
      height = Math.max(EMU_PER_CM, nodesOfKind(node.children, 'paragraph').length * LINE)
    } else if (node.kind === 'paragraph' || node.kind === 'heading') {
      kind = 'revision'
      finalText = readParagraph({ info, styles: ctx.doc.styles }, node).text
      height = Math.max(1, Math.ceil(finalText.length / 40)) * LINE
    } else {
      const a = analyzeObject(ctx.doc, 'content.xml', info.xml, info.prefixes, node)
      kind = a.type === 'picture' ? 'object' : a.kind
      width = a.widthEmu
      height = a.heightEmu
      preview = a.preview ?? (a.image ? { bytes: a.image.bytes, format: a.image.format } : null)
      entries = a.entries
      anchor = anchorOf(ctx.doc, 'content.xml', a.anchor)
    }
    const placeholder: ObjectPlaceholder = {
      id,
      kind,
      name: keepName(id, kind),
      part: 'content.xml',
      start: node.start,
      end: node.end,
      paragraph: null,
      block: env.blockId,
      element: null,
      widthEmu: width,
      heightEmu: height,
      preview: preview !== null,
      entries,
      finalText,
    }
    const xml = `<w:p><w:r>${placeholderDrawing(ctx, placeholder, preview, anchor)}</w:r></w:p>`
    placeholder.element = ctx.addElement(env.blockId, xml, 'other').id
    st.ext.placeholders.push(placeholder)
    if (kind === 'revision')
      ctx.warn('a paragraph with tracked changes is shown locked (its final text is in the map)')
    return { elements: [] }
  },
  toOdf(rctx, block) {
    // only reached while the placeholder is present (resized or moved): kept as it was
    saveState(rctx).emittedBlocks.add(block.id)
    return blockSource(rctx, block)
  },
  identify(rctx, item, candidates) {
    for (const d of drawingsOf(item.xml)) {
      const name = readDrawing(d).name
      const keep = name !== null ? parseKeepName(name) : null
      const p = keep ? saveState(rctx).placeholders.get(keep.id) : undefined
      if (p?.element != null && candidates.some((c) => c.id === p.element)) return p.element
    }
    return null
  },
}

// ---------------------------------------------------------------------------
// Picture paragraphs

const PPR_RE = /^<w:p\b[^>]*>\s*(<w:pPr>[\s\S]*?<\/w:pPr>)/

/** The original paragraph and object a picture item continues, when it is free to continue it. */
function hostOf(
  rctx: OoxmlToOdfContext,
  drawing: string,
): { paragraph: BridgeParagraph; start: number; end: number } | null {
  const st = saveState(rctx)
  const name = readDrawing(drawing).name ?? ''
  const keep = parseKeepName(name)
  const picId = parsePictureName(name)
  const object = keep
    ? st.placeholders.get(keep.id)
    : picId !== null
      ? st.pictures.get(picId)
      : undefined
  if (!object || object.paragraph === null) return null
  const paragraph = rctx.map.paragraphs[object.paragraph]
  if (!paragraph || st.claimedHosts.has(paragraph.id)) return null
  const element = rctx.map.elements.find((e) => e.paragraph === paragraph.id)
  // the host paragraph lives on as another edited element: this picture moved out of it
  if (!element || rctx.matched.has(element.id)) return null
  return { paragraph, start: object.start, end: object.end }
}

function writeImageItem(rctx: OoxmlToOdfContext, item: EditedItem, env: FlowEnv): string {
  const st = saveState(rctx)
  const drawings = drawingsOf(item.xml)
  if (!drawings.length) return ''
  // a block placeholder (table of contents …) that did not pair by itself
  if (drawings.length === 1) {
    const name = readDrawing(drawings[0]).name
    const keep = name !== null ? parseKeepName(name) : null
    const p = keep ? st.placeholders.get(keep.id) : undefined
    if (p && p.block !== null) {
      if (st.emittedBlocks.has(p.block)) return ''
      st.emittedBlocks.add(p.block)
      return blockSource(rctx, rctx.map.blocks[p.block])
    }
  }
  const pPr = PPR_RE.exec(item.xml)?.[1] ?? ''
  const host = hostOf(rctx, drawings[0])
  const dataUrl = item.blocks[0]?.imageDataUrl
  if (host) st.claimedHosts.add(host.paragraph.id)
  const origin = host?.paragraph ?? null
  const xml = rctx.part('content.xml').xml
  // the paragraph held only this object and keeps its format: everything else as it was
  if (
    host &&
    origin &&
    drawings.length === 1 &&
    origin.text === '' &&
    pPr === origin.pPr &&
    origin.markers.filter((m) => m.kind === 'handler').length === 1
  ) {
    return (
      xml.slice(origin.start, host.start) +
      writeDrawing(rctx, drawings[0], dataUrl, { part: origin.part }) +
      xml.slice(host.end, origin.end)
    )
  }
  const runs: Run[] = drawings.map((d, i) => ({
    text: '',
    image: { dataUrl: i === 0 ? (dataUrl ?? '') : '', xml: d },
  }))
  const styleId = /<w:pStyle w:val="([^"]*)"/.exec(pPr)?.[1]
  const para: EditedParagraph = {
    type: 'paragraph',
    runs,
    rawPPr: pPr,
    format: readOoxmlPPr(pPr),
    ...(styleId ? { styleId } : {}),
  }
  const before = env.neighbours?.before?.paragraph
  const after = env.neighbours?.after?.paragraph
  const neighbour =
    before != null
      ? (rctx.map.paragraphs[before] ?? null)
      : after != null
        ? (rctx.map.paragraphs[after] ?? null)
        : null
  return paragraphToOdf(rctx, para, origin, {
    part: 'content.xml',
    neighbour: origin ? null : neighbour,
    follows: origin ? null : before != null ? (rctx.map.paragraphs[before] ?? null) : null,
  })
}

export const objectsFreeWriter: FreeWriter = {
  id: OBJECTS_OWNER,
  match(item) {
    if (paragraphBlockOf(item) || !item.xml.startsWith('<w:p') || !item.xml.includes('<w:drawing>'))
      return false
    return item.blocks[0]?.type === 'image' || /\bname="odt-(?:keep|pic):/.test(item.xml)
  },
  toOdf(rctx, items, env) {
    return items.map((item) => writeImageItem(rctx, item, env)).join('')
  },
}
