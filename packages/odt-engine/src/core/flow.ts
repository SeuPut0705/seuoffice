/**
 * The flow walkers: the generic part of both directions that only dispatches.
 *
 * Forward (`convertOdtBody` / `convertFlow`): every child of `office:text`
 * (and of a container block such as `text:section`) becomes a `BridgeBlock`;
 * the newest registered `BlockConverter` that matches converts it to OOXML
 * body elements. Without a converter, sections are converted as containers
 * and everything else is kept verbatim with no OOXML (`keep`).
 *
 * Reverse (`rebuildOdtBody` / `rebuildFlow`): the edited docx's body elements
 * are aligned with the bridge elements (exact XML, then the paragraph identity
 * bookmark, then the owners' `identify`, then a 1:1 fallback inside a gap).
 * Edited elements are grouped by the ODF block they continue; a block whose
 * elements all come back unchanged, complete and in order is copied byte for
 * byte, any other block goes to its owner's `toOdf`. New elements between
 * blocks go to the registered `FreeWriter`s. Blocks that never had OOXML are
 * re-emitted at their original place among the surviving blocks.
 */
import type { Block, ParsedDoc } from '@genoffice/docx-engine'
import type { OdtNode } from './body'
import {
  type AlignedItem,
  type BlockConverter,
  type BridgeBlock,
  type BridgeElement,
  type EditedItem,
  type FlowEnv,
  type OdfToOoxmlContext,
  type OoxmlToOdfContext,
  paragraphIdFromBookmarks,
} from './convert'

// ---------------------------------------------------------------------------
// Forward

const CONTAINER_KINDS = new Set(['section'])

/** Converts the whole body (`office:text`). */
export function convertOdtBody(ctx: OdfToOoxmlContext): void {
  convertFlow(ctx, ctx.doc.body.blocks, null)
}

/** Converts a sequence of sibling flow nodes, recording them under `parent`. */
export function convertFlow(
  ctx: OdfToOoxmlContext,
  nodes: readonly OdtNode[],
  parent: number | null,
): void {
  for (const node of nodes) convertNode(ctx, node, parent)
}

/** Converts one flow node into a bridge block and its elements. */
export function convertNode(
  ctx: OdfToOoxmlContext,
  node: OdtNode,
  parent: number | null,
): BridgeBlock {
  const converter = node.kind === 'opaque' ? null : ctx.registry.blockFor(node, ctx)
  if (converter) {
    const block = ctx.addBlock(node, parent, converter.id)
    const out = converter.toOoxml(ctx, node, { blockId: block.id, parent })
    for (const e of out.elements)
      ctx.addElement(block.id, e.xml, e.kind ?? 'other', e.paragraph ?? null)
    if (out.data !== undefined) block.data = out.data
    return block
  }
  if (CONTAINER_KINDS.has(node.kind) && !node.selfClosing)
    return convertContainer(ctx, node, parent)
  const block = ctx.addBlock(node, parent, 'keep')
  if (node.kind !== 'other' && node.kind !== 'opaque')
    ctx.warn(`kept without conversion: ${node.name}`)
  return block
}

/**
 * Default container conversion: the node's flow children become nested
 * blocks. Its own markup around them is copied on save.
 */
export function convertContainer(
  ctx: OdfToOoxmlContext,
  node: OdtNode,
  parent: number | null,
  owner = 'container',
): BridgeBlock {
  const block = ctx.addBlock(node, parent, owner)
  convertFlow(ctx, flowChildren(node), block.id)
  return block
}

/** Children of a container that are flow content (direct recorded children). */
export function flowChildren(node: OdtNode): OdtNode[] {
  return node.children.filter((c) => c.kind !== 'bookmark' && c.kind !== 'annotation-end')
}

// ---------------------------------------------------------------------------
// Reverse: alignment

/** The body elements of an edited docx, from its parse. */
export function editedItems(edited: Pick<ParsedDoc, 'blocks'>): EditedItem[] {
  const out: EditedItem[] = []
  let last: EditedItem | null = null
  for (const b of edited.blocks) {
    if (b.hidden) continue
    const index = b.docxIndex ?? -1
    if (last && index >= 0 && last.index === index) {
      last.blocks.push(b)
      continue
    }
    last = { index, xml: b.originalXml ?? '', blocks: [b] }
    out.push(last)
  }
  return out
}

/** The paragraph-like engine block of an item, or null. */
export function paragraphBlockOf(item: EditedItem): Block | null {
  if (item.blocks.length !== 1) return null
  const b = item.blocks[0]
  return b.type === 'paragraph' || b.type === 'heading' || b.type === 'listItem' ? b : null
}

const itemKind = (item: EditedItem): BridgeElement['kind'] =>
  paragraphBlockOf(item) ? 'paragraph' : item.blocks[0]?.type === 'table' ? 'table' : 'other'

/** Aligns edited elements with bridge elements. */
export function alignItems(rctx: OoxmlToOdfContext, items: readonly EditedItem[]): AlignedItem[] {
  const elements = rctx.map.elements
  const used = new Set<number>()
  const match: Array<number | null> = items.map(() => null)

  // 1. exact XML
  const byXml = new Map<string, number[]>()
  for (const e of elements) {
    const list = byXml.get(e.xml)
    if (list) list.push(e.id)
    else byXml.set(e.xml, [e.id])
  }
  let lastExact = -1
  items.forEach((item, i) => {
    const ids = byXml.get(item.xml)
    if (!ids) return
    const id = ids.find((x) => !used.has(x) && x > lastExact) ?? ids.find((x) => !used.has(x))
    if (id === undefined) return
    used.add(id)
    match[i] = id
    lastExact = id
  })

  // 2. paragraph identity bookmark
  const byParagraph = new Map<number, number>()
  for (const e of elements) if (e.paragraph !== null) byParagraph.set(e.paragraph, e.id)
  items.forEach((item, i) => {
    if (match[i] !== null) return
    const block = paragraphBlockOf(item)
    const pid = block ? paragraphIdFromBookmarks(block.hiddenBookmarks) : null
    const id = pid === null ? undefined : byParagraph.get(pid)
    if (id === undefined || used.has(id)) return
    used.add(id)
    match[i] = id
  })

  // 3/4. owner identify, then a 1:1 fallback, within each gap between matches
  const gapCandidates = (i: number) => {
    let lo = -1
    for (let k = i - 1; k >= 0; k--)
      if (match[k] !== null) {
        lo = match[k] as number
        break
      }
    let hi = elements.length
    for (let k = i + 1; k < items.length; k++)
      if (match[k] !== null) {
        hi = match[k] as number
        break
      }
    return elements.filter((e) => e.id > lo && e.id < hi && !used.has(e.id))
  }
  items.forEach((item, i) => {
    if (match[i] !== null) return
    const candidates = gapCandidates(i)
    for (const converter of rctx.registry.blocks) {
      if (!converter.identify) continue
      // the element's own block or any block around it (a table inside a section or a list)
      const own = candidates.filter((e) => ownedBy(rctx, e.block, converter.id))
      if (!own.length) continue
      const id = converter.identify(rctx, item, own)
      if (id !== null && !used.has(id)) {
        used.add(id)
        match[i] = id
        return
      }
    }
  })
  items.forEach((item, i) => {
    if (match[i] !== null) return
    const candidates = gapCandidates(i)
    if (candidates.length !== 1 || candidates[0].kind !== itemKind(item)) return
    // only a lone unmatched edited element in the same gap
    let others = 0
    for (let k = i - 1; k >= 0 && match[k] === null; k--) others++
    for (let k = i + 1; k < items.length && match[k] === null; k++) others++
    if (others) return
    used.add(candidates[0].id)
    match[i] = candidates[0].id
  })

  for (const id of used) rctx.matched.add(id)
  return items.map((item, i) => {
    const element = match[i] === null ? null : elements[match[i] as number]
    return { item, element, unchanged: element !== null && element.xml === item.xml }
  })
}

/** Whether a block or one of its enclosing blocks belongs to `owner`. */
function ownedBy(rctx: OoxmlToOdfContext, id: number, owner: string): boolean {
  let b: BridgeBlock | undefined = rctx.map.blocks[id]
  while (b) {
    if (b.owner === owner) return true
    b = b.parent === null ? undefined : rctx.map.blocks[b.parent]
  }
  return false
}

/** The ancestor of `blockId` (or itself) whose parent is `parent`, or null. */
function ancestorIn(
  rctx: OoxmlToOdfContext,
  blockId: number,
  parent: number | null,
): number | null {
  let b: BridgeBlock | undefined = rctx.map.blocks[blockId]
  while (b) {
    if (b.parent === parent) return b.id
    if (b.parent === null) return null
    b = rctx.map.blocks[b.parent]
  }
  return null
}

/** Every bridge element of a block and its descendants, in order. */
export function blockElements(rctx: OoxmlToOdfContext, block: BridgeBlock): number[] {
  const out: number[] = [...block.elements]
  for (const c of block.children) out.push(...blockElements(rctx, rctx.map.blocks[c]))
  return out.sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Reverse: rebuilding

/** Source text of a bridge block. */
export function blockSource(rctx: OoxmlToOdfContext, block: BridgeBlock): string {
  return rctx.part(block.part).xml.slice(block.start, block.end)
}

/**
 * Rewrites `office:text` from the edited docx and queues the patch (none when
 * the result equals the original). Returns the aligned items.
 */
export function rebuildOdtBody(rctx: OoxmlToOdfContext, items?: EditedItem[]): AlignedItem[] {
  const aligned = alignItems(rctx, items ?? editedItems(rctx.edited))
  const text = rctx.doc.body.text
  const xml = rctx.doc.contentXml
  const inner = rebuildFlow(rctx, withoutTrailingFiller(rctx, aligned), { parent: null })
  const original = xml.slice(text.openEnd, text.closeStart)
  if (inner === original) return aligned
  if (text.selfClosing) {
    const open = xml.slice(text.start, text.end).replace(/\s*\/>$/, '>')
    const name = /^<([^\s/>]+)/.exec(open)?.[1] ?? 'office:text'
    rctx.patch('content.xml', text.start, text.end, `${open}${inner}</${name}>`)
  } else rctx.patch('content.xml', text.openEnd, text.closeStart, inner)
  return aligned
}

/**
 * The editor cannot end a document with a table: it keeps an empty paragraph
 * after it and saves that as a bare `<w:p></w:p>` the bridge never had. When
 * the bridge docx ends with something other than a paragraph (a table, a
 * framed table), such a last new element is that filler, not content, and is
 * not written (it would add an empty paragraph and a new style to the file).
 */
function withoutTrailingFiller(rctx: OoxmlToOdfContext, aligned: AlignedItem[]): AlignedItem[] {
  const last = aligned[aligned.length - 1]
  if (!last || last.element) return aligned
  const bridgeLast = rctx.map.elements[rctx.map.elements.length - 1]
  if (!bridgeLast || bridgeLast.kind === 'paragraph') return aligned
  const bare = last.item.xml
    .replace(/<w:bookmark(?:Start|End)\b[^>]*\/>/g, '')
    .replace(/<w:pPr>\s*<\/w:pPr>|<w:pPr\/>/g, '')
    .trim()
  if (!/^(?:<w:p(?:\s[^>]*)?>\s*<\/w:p>|<w:p(?:\s[^>]*)?\/>)$/.test(bare)) return aligned
  return aligned.slice(0, -1)
}

/** Rebuilds the flow whose blocks have parent `env.parent` from the aligned items belonging to it. */
export function rebuildFlow(
  rctx: OoxmlToOdfContext,
  aligned: readonly AlignedItem[],
  env: FlowEnv,
): string {
  const blocks = rctx.map.blocks.filter((b) => b.parent === env.parent)
  const xml = rctx.part('content.xml').xml
  const owners = aligned.map((a) =>
    a.element ? ancestorIn(rctx, a.element.block, env.parent) : null,
  )
  // new items sandwiched between items of the same block belong to it
  const assigned = owners.map((o, i) => {
    if (o !== null) return o
    let before: number | null = null
    for (let k = i - 1; k >= 0; k--)
      if (owners[k] !== null) {
        before = owners[k]
        break
      }
    let after: number | null = null
    for (let k = i + 1; k < owners.length; k++)
      if (owners[k] !== null) {
        after = owners[k]
        break
      }
    return before !== null && before === after ? before : null
  })
  // new items next to a block that absorbs them (a list item typed after a list)
  const absorbs = (owner: number, item: EditedItem) => {
    const block = rctx.map.blocks[owner]
    return !!rctx.registry.blockById(block.owner)?.absorbs?.(rctx, block, item)
  }
  for (let k = 1; k < assigned.length; k++) {
    const prev = assigned[k - 1]
    if (assigned[k] === null && prev !== null && absorbs(prev, aligned[k].item)) assigned[k] = prev
  }
  for (let k = assigned.length - 2; k >= 0; k--) {
    const next = assigned[k + 1]
    if (assigned[k] === null && next !== null && absorbs(next, aligned[k].item)) assigned[k] = next
  }

  const carried = blocks.filter((b) => blockElements(rctx, b).length === 0).map((b) => b.id)
  let carry = 0
  let out = ''
  let lastVerbatim: number | null = -1 // -1: the flow start
  const prevSibling = (b: BridgeBlock): number | null => {
    const i = blocks.indexOf(b)
    return i > 0 ? blocks[i - 1].id : -1
  }
  const leadFrom = (b: BridgeBlock): number | null => {
    const i = blocks.indexOf(b)
    if (i > 0) return blocks[i - 1].end
    if (env.parent === null) return rctx.doc.body.text.openEnd
    return null
  }
  const emitVerbatim = (b: BridgeBlock) => {
    if (lastVerbatim === prevSibling(b)) {
      const from = leadFrom(b)
      if (from !== null && from <= b.start) out += xml.slice(from, b.start)
    }
    out += blockSource(rctx, b)
    lastVerbatim = b.id
  }
  const flushCarried = (beforeId: number | null) => {
    while (carry < carried.length && (beforeId === null || carried[carry] < beforeId)) {
      emitVerbatim(rctx.map.blocks[carried[carry++]])
    }
  }

  let i = 0
  while (i < aligned.length) {
    const owner = assigned[i]
    let j = i + 1
    while (j < aligned.length && assigned[j] === owner) j++
    const group = aligned.slice(i, j)
    if (owner === null) {
      let before: BridgeElement | null = null
      for (let k = i - 1; k >= 0 && !before; k--) before = aligned[k].element
      let after: BridgeElement | null = null
      for (let k = j; k < aligned.length && !after; k++) after = aligned[k].element
      out += writeFree(rctx, group, { ...env, neighbours: { before, after } })
      lastVerbatim = null
    } else {
      const block = rctx.map.blocks[owner]
      flushCarried(block.id)
      const expected = blockElements(rctx, block)
      const verbatim =
        group.length === expected.length &&
        group.every((a, k) => a.unchanged && a.element?.id === expected[k])
      if (verbatim) emitVerbatim(block)
      else {
        out += writeBlock(rctx, block, group, env)
        lastVerbatim = null
      }
    }
    i = j
  }
  flushCarried(null)
  if (env.parent === null && blocks.length && lastVerbatim === blocks[blocks.length - 1].id) {
    out += xml.slice(blocks[blocks.length - 1].end, rctx.doc.body.text.closeStart)
  } else if (env.parent === null && !blocks.length && !aligned.length) {
    out += xml.slice(rctx.doc.body.text.openEnd, rctx.doc.body.text.closeStart)
  }
  return out
}

function writeBlock(
  rctx: OoxmlToOdfContext,
  block: BridgeBlock,
  items: AlignedItem[],
  env: FlowEnv,
): string {
  if (block.owner === 'container') return rebuildContainer(rctx, block, items)
  const converter: BlockConverter | null = rctx.registry.blockById(block.owner)
  if (!converter) {
    rctx.warn(`no converter "${block.owner}" for ${block.name}; kept the original`)
    return blockSource(rctx, block)
  }
  return converter.toOdf(rctx, block, items, env)
}

/** Default container write-back: the original markup around freshly rebuilt children. */
export function rebuildContainer(
  rctx: OoxmlToOdfContext,
  block: BridgeBlock,
  items: AlignedItem[],
): string {
  const xml = rctx.part(block.part).xml
  const children = block.children.map((c) => rctx.map.blocks[c])
  const inner = rebuildFlow(rctx, items, { parent: block.id })
  if (!children.length) {
    const open = xml.slice(block.start, block.end).match(/^<[^>]*>/)?.[0] ?? ''
    const name = /^<([^\s/>]+)/.exec(open)?.[1] ?? block.name
    return `${open.replace(/\s*\/>$/, '>')}${inner}</${name}>`
  }
  return (
    xml.slice(block.start, children[0].start) +
    inner +
    xml.slice(children[children.length - 1].end, block.end)
  )
}

function writeFree(rctx: OoxmlToOdfContext, group: AlignedItem[], env: FlowEnv): string {
  let out = ''
  let k = 0
  while (k < group.length) {
    const writer = rctx.registry.freeWriterFor(group[k].item)
    let m = k + 1
    while (m < group.length && rctx.registry.freeWriterFor(group[m].item) === writer) m++
    if (writer) {
      out += writer.toOdf(
        rctx,
        group.slice(k, m).map((a) => a.item),
        env,
      )
    } else rctx.warn(`dropped a new ${group[k].item.blocks[0]?.type ?? 'element'} with no writer`)
    k = m
  }
  return out
}
