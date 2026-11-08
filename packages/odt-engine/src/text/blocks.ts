/**
 * The text owner: the block converter for paragraphs, headings and lists,
 * and the free writer for new paragraphs.
 */
import type { Block } from '@genoffice/docx-engine'
import type { OdtNode } from '../core/body'
import { walkNodes } from '../core/body'
import {
  type AlignedItem,
  type BlockConverter,
  type BlockOoxml,
  type BridgeElement,
  type BridgeParagraph,
  type ConversionRegistry,
  type EditedItem,
  type FlowEnv,
  type FreeWriter,
  type OdfToOoxmlContext,
  type OoxmlToOdfContext,
} from '../core/convert'
import { blockSource, convertNode, paragraphBlockOf } from '../core/flow'
import { listInstance, listStyleFromNumbering } from './lists'
import { type Placement, keptCharacters, placeMarkers } from './markers'
import { editedParagraphFromBlock, paragraphToOdf } from './paragraph-odf'
import { paragraphToOoxml } from './paragraph-ooxml'

export const TEXT_OWNER = 'text'

// ---------------------------------------------------------------------------
// Forward

function listToOoxml(ctx: OdfToOoxmlContext, node: OdtNode, blockId: number): BlockOoxml {
  const inst = listInstance(ctx, blockId, {
    styleName: node.attr('text:style-name') ?? null,
    xmlId: node.attr('xml:id') ?? null,
    continueList: node.attr('text:continue-list') ?? null,
    continueNumbering: node.attr('text:continue-numbering') === 'true',
  })
  const walk = (list: OdtNode, depth: number) => {
    for (const item of list.children) {
      if (item.kind !== 'list-item') {
        convertNode(ctx, item, blockId)
        continue
      }
      const header = item.name === 'text:list-header'
      let first = true
      for (const child of item.children) {
        if (child.kind === 'paragraph' || child.kind === 'heading') {
          const level = Math.min(8, depth)
          const { xml, paragraph } = paragraphToOoxml(ctx, child, {
            part: 'content.xml',
            block: blockId,
            list: {
              numId: inst.numId,
              level: depth,
              kind: inst.kinds[level] ?? 'ordered',
              header,
              continuation: !first,
            },
          })
          ctx.addElement(blockId, xml, 'paragraph', paragraph.id)
          first = false
        } else if (child.kind === 'list') {
          walk(child, depth + 1)
        } else if (
          child.kind !== 'bookmark' &&
          child.kind !== 'bookmark-start' &&
          child.kind !== 'bookmark-end'
        ) {
          convertNode(ctx, child, blockId)
        }
      }
    }
  }
  walk(node, 0)
  return { elements: [], data: { numId: inst.numId } }
}

// ---------------------------------------------------------------------------
// Reverse

interface TextState {
  usedListTags: Set<number>
  nodes: Map<number, OdtNode> | null
}
const states = new WeakMap<OoxmlToOdfContext, TextState>()
const stateOf = (rctx: OoxmlToOdfContext): TextState => {
  let s = states.get(rctx)
  if (!s) states.set(rctx, (s = { usedListTags: new Set(), nodes: null }))
  return s
}

/** The body node starting at `start` (content.xml). */
function nodeAt(rctx: OoxmlToOdfContext, start: number): OdtNode | undefined {
  const state = stateOf(rctx)
  if (!state.nodes) {
    state.nodes = new Map()
    const nodes = state.nodes
    walkNodes(rctx.doc.body.blocks, (n) => {
      nodes.set(n.start, n)
    })
  }
  return state.nodes.get(start)
}

const startTag = (xml: string, start: number) => xml.slice(start, xml.indexOf('>', start) + 1)
const tagName = (tag: string) => /^<([^\s/>]+)/.exec(tag)?.[1] ?? 'text:list'

interface ListEntry {
  level: number
  xml: string
  continuation: boolean
  header: boolean
  origin: BridgeParagraph | null
}

function writeList(rctx: OoxmlToOdfContext, numId: string, entries: ListEntry[]): string {
  const xml = rctx.part('content.xml').xml
  const state = stateOf(rctx)
  const bridgeList = rctx.map.lists.find((l) => l.numId === numId)
  let open: string | null = null
  const candidates = [
    ...entries.filter((e) => e.origin?.list?.numId === numId).map((e) => e.origin?.block ?? null),
    ...(bridgeList?.blocks ?? []),
  ]
  for (const blockId of candidates) {
    if (blockId === null || state.usedListTags.has(blockId)) continue
    const block = rctx.map.blocks[blockId]
    if (block.name !== 'text:list') continue
    state.usedListTags.add(blockId)
    open = startTag(xml, block.start)
    break
  }
  if (open === null && bridgeList?.styleName) {
    open = `<text:list text:style-name="${bridgeList.styleName.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}" text:continue-numbering="true">`
  }
  if (open === null) {
    const name = listStyleFromNumbering(rctx, rctx.edited.numbering.get(numId))
    open = `<text:list text:style-name="${name}">`
  }
  if (open.endsWith('/>')) open = open.replace(/\s*\/>$/, '>')
  const rootClose = `</${tagName(open)}>`

  let out = open
  const closeItem: Array<string | null> = [null]
  let depth = 0
  const closeLevel = () => {
    if (closeItem[depth]) out += closeItem[depth]
    closeItem[depth] = null
  }
  for (const e of entries) {
    const level = Math.max(0, Math.min(9, e.level))
    if (e.continuation && closeItem[depth] && depth === level) {
      out += e.xml
      continue
    }
    while (depth > level) {
      closeLevel()
      out += '</text:list>'
      depth--
    }
    if (depth === level) closeLevel()
    while (depth < level) {
      if (!closeItem[depth]) {
        out += '<text:list-item>'
        closeItem[depth] = '</text:list-item>'
      }
      out += '<text:list>'
      depth++
      closeItem[depth] = null
    }
    let itemOpen = e.header ? '<text:list-header>' : '<text:list-item>'
    if (e.origin && !e.continuation) {
      const parent = nodeAt(rctx, e.origin.start)?.parent
      if (parent && parent.kind === 'list-item' && !parent.selfClosing)
        itemOpen = startTag(xml, parent.start)
    }
    out += itemOpen
    closeItem[depth] = `</${tagName(itemOpen)}>`
    out += e.xml
  }
  while (depth > 0) {
    closeLevel()
    out += '</text:list>'
    depth--
  }
  closeLevel()
  return out + rootClose
}

/**
 * Writes a run of aligned edited elements that the text owner handles:
 * paragraphs (unchanged ones byte for byte), lists regrouped by `w:numId`,
 * and — for non-paragraph elements met inside — their owners.
 */
export function writeTextItems(
  rctx: OoxmlToOdfContext,
  items: readonly AlignedItem[],
  env: FlowEnv,
): string {
  let out = ''
  let group: { numId: string; entries: ListEntry[] } | null = null
  const flush = () => {
    if (group) out += writeList(rctx, group.numId, group.entries)
    group = null
  }
  const paragraphOf = (e: { paragraph: number | null } | null | undefined) =>
    e && e.paragraph !== null ? (rctx.map.paragraphs[e.paragraph] ?? null) : null
  let neighbour: BridgeParagraph | null = paragraphOf(env.neighbours?.before)
  // the original paragraph directly before (through consecutive new paragraphs)
  let follows: BridgeParagraph | null = neighbour
  const xml = rctx.part('content.xml').xml
  const placements = sequencePlacements(rctx, items)
  items.forEach((a, index) => {
    const block = paragraphBlockOf(a.item)
    const origin =
      a.element && a.element.paragraph !== null
        ? (rctx.map.paragraphs[a.element.paragraph] ?? null)
        : null
    if (!block || (a.element && a.element.kind !== 'paragraph') || (a.element && !origin)) {
      flush()
      follows = null
      if (a.element) {
        const owned = rctx.map.blocks[a.element.block]
        if (a.unchanged) out += blockSource(rctx, owned)
        else {
          const converter = rctx.registry.blockById(owned.owner)
          out += converter ? converter.toOdf(rctx, owned, [a], env) : blockSource(rctx, owned)
        }
      } else {
        const writer = rctx.registry.freeWriterFor(a.item)
        if (writer && writer.id !== TEXT_OWNER) out += writer.toOdf(rctx, [a.item], env)
        else rctx.warn(`dropped a new ${a.item.blocks[0]?.type ?? 'element'} with no writer`)
      }
      return
    }
    if (origin) neighbour = origin
    else if (!neighbour) {
      const next = items.slice(index + 1).find((x) => x.element?.paragraph != null)
      neighbour = next ? paragraphOf(next.element) : paragraphOf(env.neighbours?.after)
    }
    const odf =
      a.unchanged && origin
        ? xml.slice(origin.start, origin.end)
        : paragraphToOdf(rctx, editedParagraphFromBlock(block as Block), origin, {
            part: 'content.xml',
            neighbour: origin ? null : neighbour,
            follows: origin ? null : follows,
            placements: placements.get(index),
          })
    if (origin) follows = origin
    let list: { numId: string; level: number; continuation: boolean; header: boolean } | null = null
    if (block.type === 'listItem' && block.list) {
      list = { numId: block.list.numId, level: block.list.ilvl, continuation: false, header: false }
    } else if (
      block.type === 'paragraph' &&
      origin?.list &&
      (origin.list.header || origin.list.continuation)
    ) {
      list = { ...origin.list }
    }
    if (!list) {
      flush()
      out += odf
      return
    }
    const g = group as { numId: string; entries: ListEntry[] } | null
    if (g && g.numId !== list.numId) flush()
    if (!group) group = { numId: list.numId, entries: [] }
    ;(group as { numId: string; entries: ListEntry[] }).entries.push({
      level: list.level,
      xml: odf,
      continuation: list.continuation,
      header: list.header,
      origin,
    })
  })
  flush()
  return out
}

/**
 * Marker placements for changed original paragraphs that were split (followed
 * by new paragraphs) or joined (followed in the original by deleted paragraphs
 * whose text survives in them), keyed by item index.
 */
function sequencePlacements(
  rctx: OoxmlToOdfContext,
  items: readonly AlignedItem[],
): Map<number, Placement[]> {
  const out = new Map<number, Placement[]>()
  items.forEach((a, i) => {
    const origin = a.element?.paragraph != null ? rctx.map.paragraphs[a.element.paragraph] : null
    if (!origin || a.unchanged || !paragraphBlockOf(a.item)) return
    const pieces = [i]
    for (
      let k = i + 1;
      k < items.length && !items[k].element && paragraphBlockOf(items[k].item);
      k++
    )
      pieces.push(k)
    // originals deleted right after this one: joined into it when their text survives
    const joined: BridgeParagraph[] = []
    for (let e = (a.element as BridgeElement).id + 1; e < rctx.map.elements.length; e++) {
      const element = rctx.map.elements[e]
      if (rctx.matched.has(e) || element.paragraph === null) break
      const record = rctx.map.paragraphs[element.paragraph]
      if (!record || record.part !== origin.part) break
      joined.push(record)
    }
    if (pieces.length === 1 && !joined.length) return
    const texts = pieces.map((k) =>
      (paragraphBlockOf(items[k].item)?.runs ?? []).map((r) => r.text).join(''),
    )
    // a deleted paragraph whose text did not survive was deleted, not joined
    const kept = keptCharacters([origin, ...joined], texts)
    const originals = [origin]
    joined.forEach((p, n) => {
      if (p.text.length > 0 && kept[n + 1] * 2 >= p.text.length) originals.push(p)
      else if (kept[n + 1] > 0 && p.markers.some((m) => m.kind.startsWith('bookmark')))
        rctx.warn(
          `bookmarks of a deleted paragraph were dropped although part of its text survives`,
        )
    })
    const placed = placeMarkers(rctx, originals, texts)
    pieces.forEach((k, n) => out.set(k, placed.placements[n]))
  })
  return out
}

export const textBlockConverter: BlockConverter = {
  id: TEXT_OWNER,
  match(node) {
    return node.kind === 'paragraph' || node.kind === 'heading' || node.kind === 'list'
  },
  toOoxml(ctx, node, env) {
    if (node.kind === 'list') return listToOoxml(ctx, node, env.blockId)
    const { xml, paragraph } = paragraphToOoxml(ctx, node, {
      part: 'content.xml',
      block: env.blockId,
    })
    return { elements: [{ xml, kind: 'paragraph', paragraph: paragraph.id }] }
  },
  toOdf(rctx, _block, items, env) {
    return writeTextItems(rctx, items, env)
  },
  absorbs(_rctx, block, item) {
    const p = paragraphBlockOf(item)
    if (!p) return false
    // a new paragraph next to a paragraph may hold its text (an Enter split):
    // written together so markers can follow the text
    if (block.name !== 'text:list') return block.kind === 'paragraph' || block.kind === 'heading'
    const numId = (block.data as { numId?: string } | null)?.numId
    return p.type === 'listItem' && p.list?.numId === numId
  },
}

/** New paragraphs (no original) between blocks. */
export const textFreeWriter: FreeWriter = {
  id: TEXT_OWNER,
  match(item: EditedItem) {
    return paragraphBlockOf(item) !== null
  },
  toOdf(rctx, items, env) {
    return writeTextItems(
      rctx,
      items.map((item) => ({ item, element: null, unchanged: false })),
      env,
    )
  },
}

/** Registers the text owner (paragraphs, headings, lists, new paragraphs). */
export function registerTextConverters(registry: ConversionRegistry): ConversionRegistry {
  return registry.addBlock(textBlockConverter).addFreeWriter(textFreeWriter)
}
