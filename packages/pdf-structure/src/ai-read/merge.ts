/**
 * AI-read pages in the document tree (spec §7): an AI reading replaces its
 * page's blocks (page image or text) so Markdown / EPUB, `read_pages` and
 * translation all use it. Page boundaries stay, the page's footnotes are
 * replaced in page order (writers number footnotes in that order), every new
 * block carries the page's fingerprint, and the page's status becomes 'ai'.
 *
 * Merge into the original tree, then derive translated / bilingual trees.
 */
import type {
  BlockBase,
  DocumentTree,
  FootnoteDef,
  InlineRun,
  PageBreakBlock,
  TreeBlock,
} from '../tree/types'
import type { AiPageReading } from './content'
import { aiReadingFromPayload } from './payload'

const blockPages = (b: BlockBase): number[] =>
  b.regions && b.regions.length > 0 ? b.regions.map((r) => r.page) : [b.page]

function collectRefs(runs: readonly InlineRun[], into: Set<string>): void {
  for (const r of runs) if (r.kind === 'footnoteRef') into.add(r.id)
}

function refsOf(b: TreeBlock, into: Set<string>): void {
  if ('runs' in b) collectRefs(b.runs, into)
  if (b.kind === 'table')
    for (const c of b.table.cells) for (const p of c.paragraphs) collectRefs(p, into)
  if ((b.kind === 'table' || b.kind === 'image') && b.caption) collectRefs(b.caption.runs, into)
}

/**
 * The tree with these readings in place of their pages. A reading whose page
 * is not in the tree, or whose fingerprint differs from the page's (a stale
 * reading), is ignored. A block that crosses into a replaced page from a page
 * that is not replaced is kept and reported in `warnings`. The input tree is
 * not changed.
 */
export function mergeAiReadPages(
  tree: DocumentTree,
  readings: Iterable<AiPageReading>,
): DocumentTree {
  if (tree.variant !== 'original') {
    throw new TypeError('AI readings merge into the original tree; derive translations after')
  }
  const order = new Map(tree.pages.map((p, i) => [p.page, i]))
  const byPage = new Map<number, AiPageReading>()
  for (const r of readings) {
    const info = tree.pages.find((p) => p.page === r.page)
    if (info && info.fingerprint === r.pageFingerprint) byPage.set(r.page, r)
  }
  if (byPage.size === 0) return tree

  const warnings = [...tree.warnings]
  const blocks: TreeBlock[] = []
  const placed = new Set<number>()
  for (const b of tree.blocks) {
    if (b.kind === 'pageBreak') {
      blocks.push(b)
      const reading = byPage.get(b.page)
      if (reading && !placed.has(b.page)) {
        placed.add(b.page)
        blocks.push(...reading.blocks)
      }
      continue
    }
    const pages = blockPages(b)
    const replaced = pages.filter((p) => byPage.has(p))
    if (replaced.length > 0 && replaced.length === pages.length) continue
    if (replaced.length > 0) {
      const others = pages.filter((p) => !byPage.has(p))
      for (const p of replaced) {
        warnings.push(
          `page ${p}: a block crossing to page ${others.join(', ')} was kept beside the AI reading`,
        )
      }
    }
    blocks.push(b)
  }

  // pages without a boundary in the flow (printed TOC pages) get one back
  for (const [page, reading] of byPage) {
    if (placed.has(page)) continue
    const at = order.get(page)!
    const next = blocks.findIndex((b) => b.kind === 'pageBreak' && (order.get(b.page) ?? -1) > at)
    const boundary: PageBreakBlock = {
      id: `p${page}.ai0`,
      page,
      pageFingerprint: reading.pageFingerprint,
      source: 'ai',
      kind: 'pageBreak',
    }
    blocks.splice(next === -1 ? blocks.length : next, 0, boundary, ...reading.blocks)
  }

  // a replaced page's notes go unless a kept block still points at them
  const stillReferenced = new Set<string>()
  for (const b of blocks) if (b.source !== 'ai') refsOf(b, stillReferenced)
  const footnotes: FootnoteDef[] = tree.footnotes.filter(
    (f) => !byPage.has(f.page) || stillReferenced.has(f.id),
  )
  for (const r of byPage.values()) footnotes.push(...r.footnotes)
  const rank = (f: FootnoteDef) => order.get(f.page) ?? Number.MAX_SAFE_INTEGER
  footnotes.sort((a, b) => rank(a) - rank(b))

  const failed = new Set(tree.footnoteLinkFailedPages.filter((p) => !byPage.has(p)))
  for (const r of byPage.values()) if (r.footnoteLinkFailed) failed.add(r.page)

  return {
    ...tree,
    pages: tree.pages.map((p) => (byPage.has(p.page) ? { ...p, status: 'ai' } : p)),
    blocks,
    footnotes,
    footnoteLinkFailedPages: [...failed].sort((a, b) => a - b),
    warnings,
  }
}

/**
 * The tree with the store's AI-read pages in place: every page whose
 * fingerprint has a readable stored payload (`ResultStore.readAiReadPages`).
 */
export function applyStoredAiReadings(
  tree: DocumentTree,
  entries: ReadonlyMap<string, { payload: unknown }>,
): DocumentTree {
  const readings: AiPageReading[] = []
  for (const p of tree.pages) {
    const entry = entries.get(p.fingerprint)
    const reading = entry && aiReadingFromPayload(entry.payload, p.page, p.fingerprint)
    if (reading) readings.push(reading)
  }
  return mergeAiReadPages(tree, readings)
}
