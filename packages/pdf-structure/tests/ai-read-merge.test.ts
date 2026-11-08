/**
 * AI page reading in the document tree (spec §7): merged pages replace their
 * page-image or text blocks with page boundaries, footnote order and
 * fingerprints kept consistent; the page picker's preselected pages.
 */
import { describe, expect, it } from 'vitest'
import {
  AI_READ_CLOSE_TAG,
  AI_READ_FOOTNOTES_LINE,
  AI_READ_OPEN_TAG,
  aiReadPayload,
  aiReadPreselectPages,
  applyStoredAiReadings,
  mergeAiReadPages,
  parseAiPageResponse,
  type AiPageReading,
} from '../src/ai-read'
import { treeToMarkdown } from '../src/markdown'
import {
  runsText,
  sha256Hex,
  type DocumentTree,
  type FootnoteDef,
  type InlineRun,
  type PageInfo,
  type PageStatus,
  type TreeBlock,
} from '../src/tree'

// ── a hand-built tree ──
//
// 1 text with a linked footnote (101)
// 2 scanned (page image)
// 3 text, footnote link failed (302 has no marker); its last paragraph continues onto 4
// 4 degraded (page image)
// 5 printed TOC (no blocks)
// 6 text with a linked footnote (601)
// 7 scanned, same content (fingerprint) as page 2

const FP: Record<number, string> = {
  1: sha256Hex('fp1'),
  2: sha256Hex('fp2'),
  3: sha256Hex('fp3'),
  4: sha256Hex('fp4'),
  5: sha256Hex('fp5'),
  6: sha256Hex('fp6'),
  7: sha256Hex('fp2'),
}
const STATUS: Record<number, PageStatus> = {
  1: 'text',
  2: 'scanned',
  3: 'text',
  4: 'degraded',
  5: 'toc',
  6: 'text',
  7: 'scanned',
}
const box = { x0: 0, y0: 0, x1: 100, y1: 100 }
const t = (text: string): InlineRun[] => [{ kind: 'text', text }]
const ref = (id: string): InlineRun => ({ kind: 'footnoteRef', id, marker: id.slice(-1) })
const head = (page: number, n: number) => ({
  id: `p${page}.${n}`,
  page,
  pageFingerprint: FP[page]!,
  source: 'pdf' as const,
  regions: [{ page, box }],
})
const pageBreak = (page: number): TreeBlock => ({ ...head(page, 1), kind: 'pageBreak' })
const pageImage = (page: number, reason: 'scanned' | 'degraded'): TreeBlock => ({
  ...head(page, 2),
  kind: 'pageImage',
  reason,
  data: new Uint8Array([1, 2, 3]),
  mime: 'image/png',
  pixelWidth: 10,
  pixelHeight: 10,
  widthPt: 100,
  heightPt: 100,
})
const note = (id: string, page: number, text: string): FootnoteDef => ({
  id,
  marker: id.slice(-1),
  page,
  pageFingerprint: FP[page]!,
  blocks: [{ ...head(page, 90), id: `fn${id}.1`, kind: 'paragraph', runs: t(text) }],
})

function sampleTree(): DocumentTree {
  const blocks: TreeBlock[] = [
    pageBreak(1),
    { ...head(1, 2), kind: 'heading', level: 1, levelSource: 'font', runs: t('Intro') },
    { ...head(1, 3), kind: 'paragraph', runs: [...t('One'), ref('101')] },
    pageBreak(2),
    pageImage(2, 'scanned'),
    pageBreak(3),
    { ...head(3, 2), kind: 'paragraph', runs: [...t('Three'), ref('301')] },
    {
      ...head(3, 3),
      regions: [
        { page: 3, box },
        { page: 4, box },
      ],
      kind: 'paragraph',
      runs: t('Crosses into four'),
    },
    pageBreak(4),
    pageImage(4, 'degraded'),
    pageBreak(6),
    { ...head(6, 2), kind: 'paragraph', runs: [...t('Six'), ref('601')] },
    pageBreak(7),
    pageImage(7, 'scanned'),
  ]
  const pages: PageInfo[] = [1, 2, 3, 4, 5, 6, 7].map((page) => ({
    page,
    fingerprint: FP[page]!,
    status: STATUS[page]!,
    ...(page === 4 ? { reason: 'bad-tounicode' } : {}),
    widthPt: 100,
    heightPt: 100,
  }))
  return {
    version: 1,
    variant: 'original',
    info: {},
    sourcePageCount: 7,
    pages,
    blocks,
    footnotes: [
      note('101', 1, 'Note one'),
      note('301', 3, 'Note three'),
      note('302', 3, 'Lost note'),
      note('601', 6, 'Note six'),
    ],
    outline: [],
    toc: [],
    footnoteLinkFailedPages: [3],
    warnings: ['page 4: degraded'],
  }
}

const wrap = (body: string) => `${AI_READ_OPEN_TAG}\n${body}\n${AI_READ_CLOSE_TAG}`

function reading(page: number, body: string, fingerprint = FP[page]!): AiPageReading {
  const r = parseAiPageResponse(wrap(body), { page, pageFingerprint: fingerprint })
  if (!r.ok) throw new Error(r.problems.join(', '))
  return r.reading
}

const ids = (tree: DocumentTree) => tree.blocks.map((b) => b.id)
const pageBlocks = (tree: DocumentTree, page: number) => tree.blocks.filter((b) => b.page === page)
const status = (tree: DocumentTree, page: number) => tree.pages.find((p) => p.page === page)!.status

// ── preselect ──

describe('page picker preselection', () => {
  it('scanned, degraded and footnote-link-failed pages, in page order', () => {
    expect(aiReadPreselectPages(sampleTree())).toEqual([
      { page: 2, pageFingerprint: FP[2], reasons: ['scanned'] },
      { page: 3, pageFingerprint: FP[3], reasons: ['footnote-link-failed'] },
      { page: 4, pageFingerprint: FP[4], reasons: ['degraded'] },
      { page: 7, pageFingerprint: FP[7], reasons: ['scanned'] },
    ])
  })

  it('a scanned page whose footnotes also failed lists both reasons', () => {
    const tree = { ...sampleTree(), footnoteLinkFailedPages: [2, 3] }
    expect(aiReadPreselectPages(tree)[0]).toEqual({
      page: 2,
      pageFingerprint: FP[2],
      reasons: ['scanned', 'footnote-link-failed'],
    })
  })

  it('text and TOC pages are not preselected; already AI-read pages drop out', () => {
    const merged = mergeAiReadPages(sampleTree(), [reading(2, 'Read.')])
    expect(aiReadPreselectPages(merged).map((p) => p.page)).toEqual([3, 4, 7])
  })
})

// ── merging ──

describe('merging AI readings into the tree', () => {
  it('a scanned page: its page image is replaced, the page boundary kept', () => {
    const tree = sampleTree()
    const merged = mergeAiReadPages(tree, [reading(2, '# Scanned title\n\nScanned body.')])
    expect(ids(merged)).toEqual([
      'p1.1',
      'p1.2',
      'p1.3',
      'p2.1',
      'p2.ai1',
      'p2.ai2',
      'p3.1',
      'p3.2',
      'p3.3',
      'p4.1',
      'p4.2',
      'p6.1',
      'p6.2',
      'p7.1',
      'p7.2',
    ])
    expect(pageBlocks(merged, 2).map((b) => b.kind)).toEqual(['pageBreak', 'heading', 'paragraph'])
    for (const b of pageBlocks(merged, 2)) expect(b.pageFingerprint).toBe(FP[2])
    expect(status(merged, 2)).toBe('ai')
    expect(status(merged, 7)).toBe('scanned')
  })

  it('does not change the input tree', () => {
    const tree = sampleTree()
    const before = structuredClone(tree)
    mergeAiReadPages(tree, [reading(2, 'Text[^1].\n\n' + `${AI_READ_FOOTNOTES_LINE}\n[^1]: n`)])
    expect(tree).toEqual(before)
  })

  it('AI footnotes join in page order, so footnote numbering follows the pages', () => {
    const merged = mergeAiReadPages(sampleTree(), [
      reading(2, `Scanned[^1] text.\n\n${AI_READ_FOOTNOTES_LINE}\n[^1]: Scanned note.`),
    ])
    expect(merged.footnotes.map((f) => [f.id, f.page])).toEqual([
      ['101', 1],
      ['p2.fn1', 2],
      ['301', 3],
      ['302', 3],
      ['601', 6],
    ])
    const ai = merged.footnotes[1]!
    expect(ai.pageFingerprint).toBe(FP[2])
    expect(ai.blocks.every((b) => b.pageFingerprint === FP[2] && b.source === 'ai')).toBe(true)
    const md = treeToMarkdown(merged).markdown
    expect(md).toMatch(/One\[\^1\]/)
    expect(md).toMatch(/Scanned\[\^2\] text\./)
    expect(md).toContain('[^2]: Scanned note.')
    expect(md.indexOf('Scanned note.')).toBeLessThan(md.indexOf('Note six'))
  })

  it('a footnote-link-failed page: old notes and blocks go, the failure clears', () => {
    const merged = mergeAiReadPages(sampleTree(), [
      reading(
        3,
        `Three[^1] and[^2].\n\n${AI_READ_FOOTNOTES_LINE}\n[^1]: Note three.\n[^2]: Found note.`,
      ),
    ])
    expect(merged.footnotes.map((f) => f.id)).toEqual(['101', 'p3.fn1', 'p3.fn2', '601'])
    expect(merged.footnoteLinkFailedPages).toEqual([])
    expect(pageBlocks(merged, 3).map((b) => b.id)).toEqual(['p3.1', 'p3.ai1', 'p3.3'])
    // the paragraph that continues onto page 4 is kept and reported
    expect(merged.warnings).toContain('page 4: degraded')
    expect(merged.warnings.some((w) => w.startsWith('page 3:') && w.includes('page 4'))).toBe(true)
  })

  it('reading both pages of a crossing paragraph removes it without a warning', () => {
    const merged = mergeAiReadPages(sampleTree(), [reading(3, 'Three.'), reading(4, 'Four.')])
    expect(ids(merged)).not.toContain('p3.3')
    expect(ids(merged)).not.toContain('p4.2')
    expect(merged.warnings).toEqual(['page 4: degraded'])
    expect(status(merged, 4)).toBe('ai')
    expect(merged.pages.find((p) => p.page === 4)!.fingerprint).toBe(FP[4])
  })

  it('a reading with unlinked footnotes marks its page, kept sorted', () => {
    const merged = mergeAiReadPages(sampleTree(), [reading(6, 'Six[^1].'), reading(2, 'Two[^7].')])
    expect(merged.footnoteLinkFailedPages).toEqual([2, 3, 6])
    expect(merged.footnotes.map((f) => f.id)).toEqual(['101', '301', '302'])
  })

  it('a TOC page gets its page boundary back, before the next page', () => {
    const merged = mergeAiReadPages(sampleTree(), [reading(5, '# Contents')])
    const k = merged.blocks.findIndex((b) => b.kind === 'pageBreak' && b.page === 5)
    expect(k).toBeGreaterThan(0)
    expect(merged.blocks[k - 1]!.page).toBe(4)
    expect(merged.blocks[k + 1]!.kind).toBe('heading')
    expect(merged.blocks[k + 2]).toMatchObject({ kind: 'pageBreak', page: 6 })
    expect(merged.blocks[k]!.pageFingerprint).toBe(FP[5])
    expect(new Set(ids(merged)).size).toBe(merged.blocks.length)
  })

  it('a stale reading (another fingerprint) or an unknown page is ignored', () => {
    const tree = sampleTree()
    const merged = mergeAiReadPages(tree, [
      reading(2, 'Old.', sha256Hex('old content')),
      reading(42, 'Nowhere.'),
    ])
    expect(merged.blocks).toEqual(tree.blocks)
    expect(merged.pages).toEqual(tree.pages)
  })

  it('translated and bilingual trees are refused (merge before deriving)', () => {
    const tree = { ...sampleTree(), variant: 'translated' as const, targetLanguage: 'ko' }
    expect(() => mergeAiReadPages(tree, [reading(2, 'x')])).toThrow(/original/)
  })

  it('stored payloads apply to every page with that fingerprint', () => {
    const payload = JSON.parse(
      JSON.stringify(aiReadPayload(reading(2, `Same[^1].\n\n${AI_READ_FOOTNOTES_LINE}\n[^1]: n.`))),
    ) as unknown
    const entries = new Map([
      [FP[2]!, { payload: payload as { version: number } }],
      [FP[4]!, { payload: { version: 99 } }],
    ])
    const merged = applyStoredAiReadings(sampleTree(), entries)
    expect(status(merged, 2)).toBe('ai')
    expect(status(merged, 7)).toBe('ai')
    expect(status(merged, 4)).toBe('degraded')
    expect(pageBlocks(merged, 7).map((b) => b.id)).toEqual(['p7.1', 'p7.ai1'])
    expect(merged.footnotes.map((f) => f.id)).toEqual([
      '101',
      'p2.fn1',
      '301',
      '302',
      '601',
      'p7.fn1',
    ])
    expect(new Set(ids(merged)).size).toBe(merged.blocks.length)
    const p7 = pageBlocks(merged, 7)[1]!
    expect(p7.kind === 'paragraph' && runsText(p7.runs)).toBe('Same.')
  })
})
