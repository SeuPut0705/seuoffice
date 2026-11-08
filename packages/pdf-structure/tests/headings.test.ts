/** Heading levels: bookmarks > printed-TOC targets > font statistics (spec §1). */
import { describe, expect, it } from 'vitest'
import { extractDocumentTree } from '../src/tree'
import { buildPdf, loadPdfium, type PageItem, type TextItem } from './helpers/fixtures'
import { blockText, findBlock } from './helpers/tree'

const line = (text: string, y: number, size = 12, bold = false, x = 72): TextItem => ({
  kind: 'text',
  text,
  x,
  y,
  size,
  bold,
})

/** a few body lines (12pt Helvetica) from `yTop` down */
const body = (tag: string, yTop: number, count = 4): PageItem[] =>
  Array.from({ length: count }, (_, i) =>
    line(`Body text ${tag} line ${i + 1} keeps the reader moving along here.`, yTop - i * 14),
  )

describe('heading levels from bookmarks', () => {
  async function bookmarkTree() {
    const pdf = await buildPdf(
      [
        [line('Chapter One', 740), ...body('a', 700)],
        [line('Getting Started', 740), ...body('b', 700)],
        [
          line('Deep Dive', 740, 20, true),
          ...body('c', 690),
          line('Getting Started', 560),
          ...body('d', 520),
        ],
      ],
      {
        outline: [
          {
            title: 'Chapter One',
            page: 0,
            children: [
              { title: 'Getting Started', page: 1 },
              { title: 'Deep Dive', page: 2 },
            ],
          },
        ],
      },
    )
    return (await extractDocumentTree(pdf, { pdfium: await loadPdfium() })).tree
  }

  it('levels a line matching a bookmark by the bookmark depth', async () => {
    const tree = await bookmarkTree()
    const ch = findBlock(tree, 'Chapter One')
    expect(ch).toMatchObject({ kind: 'heading', level: 1, levelSource: 'bookmark', page: 1 })
    const gs = tree.blocks.find((b) => b.kind === 'heading' && blockText(b) === 'Getting Started')
    expect(gs).toMatchObject({ level: 2, levelSource: 'bookmark', page: 2 })
    expect(tree.outline.map((o) => [o.title, o.level, o.page])).toEqual([
      ['Chapter One', 1, 1],
      ['Getting Started', 2, 2],
      ['Deep Dive', 2, 3],
    ])
  })

  it('keeps the same words on a page the bookmark does not target as a paragraph', async () => {
    const tree = await bookmarkTree()
    const onPage3 = tree.blocks.filter((b) => b.page === 3 && blockText(b) === 'Getting Started')
    expect(onPage3).toHaveLength(1)
    expect(onPage3[0]!.kind).toBe('paragraph')
  })

  it('a bookmark outranks font statistics', async () => {
    const tree = await bookmarkTree()
    // 20pt bold would be the top font tier; the bookmark says depth 2
    expect(findBlock(tree, 'Deep Dive')).toMatchObject({
      kind: 'heading',
      level: 2,
      levelSource: 'bookmark',
    })
  })
})

describe('heading levels from printed TOC entries', () => {
  async function tocTree() {
    const pdf = await buildPdf([
      [
        line('Contents', 740),
        line('Introduction ............................ 2', 700),
        line('Methods ................................. 3', 680),
        line('Results ................................. 3', 660),
      ],
      [line('Introduction', 740), ...body('a', 700)],
      [
        line('Methods', 740),
        ...body('b', 700),
        line('Results', 600),
        ...body('c', 570),
        line('Discussion', 480),
        ...body('d', 450),
      ],
    ])
    return (await extractDocumentTree(pdf, { pdfium: await loadPdfium() })).tree
  }

  it('levels the lines a TOC entry points at', async () => {
    const tree = await tocTree()
    for (const [title, page] of [
      ['Introduction', 2],
      ['Methods', 3],
      ['Results', 3],
    ] as const) {
      const h = tree.blocks.find((b) => blockText(b) === title)
      expect(h, title).toMatchObject({ kind: 'heading', level: 1, levelSource: 'toc', page })
    }
    expect(tree.toc.map((e) => [e.title, e.pageLabel, e.targetPage])).toEqual([
      ['Introduction', '2', 2],
      ['Methods', '3', 3],
      ['Results', '3', 3],
    ])
  })

  it('leaves a same-styled line without a TOC entry as a paragraph', async () => {
    const tree = await tocTree()
    expect(tree.blocks.find((b) => blockText(b) === 'Discussion')?.kind).toBe('paragraph')
  })
})

describe('heading levels from font statistics', () => {
  it('ranks lines clearly larger than body text by size', async () => {
    const pdf = await buildPdf([
      [
        line('Annual Report', 740, 20, true),
        line('Overview', 700, 15, true),
        ...body('a', 670),
        line('Slightly larger remark here.', 600, 12.5),
        ...body('b', 570),
        line('A long lead paragraph set in a larger type face runs', 480, 15),
        line('across several lines so it reads as prose and not as', 462, 15),
        line('a title, even though its size is above the body text', 444, 15),
        line('size used by the rest of this page for paragraphs.', 426, 15),
      ],
      [line('Details', 740, 15, true), ...body('c', 700), ...body('d', 620)],
    ])
    const { tree } = await extractDocumentTree(pdf, { pdfium: await loadPdfium() })
    expect(findBlock(tree, 'Annual Report')).toMatchObject({
      kind: 'heading',
      level: 1,
      levelSource: 'font',
    })
    expect(findBlock(tree, 'Overview')).toMatchObject({ kind: 'heading', level: 2 })
    expect(findBlock(tree, 'Details')).toMatchObject({ kind: 'heading', level: 2, page: 2 })
    // adjacent negatives: barely larger, and a long larger-type paragraph
    expect(findBlock(tree, 'Slightly larger remark')?.kind).toBe('paragraph')
    expect(findBlock(tree, 'A long lead paragraph')?.kind).toBe('paragraph')
  })

  it('caps the level at 6', async () => {
    const sizes = [32, 29, 26, 23, 20, 18, 16, 14.5]
    const pdf = await buildPdf([
      [
        ...sizes.map((s, i) => line(`Tier ${i + 1} title`, 760 - i * 60, s, true)),
        ...body('a', 260),
        ...body('b', 190),
        ...body('c', 120),
      ],
    ])
    const { tree } = await extractDocumentTree(pdf, { pdfium: await loadPdfium() })
    const levels = sizes.map((_, i) => {
      const b = findBlock(tree, `Tier ${i + 1} title`)
      return b?.kind === 'heading' ? b.level : null
    })
    expect(levels).toEqual([1, 2, 3, 4, 5, 6, 6, 6])
  })
})
