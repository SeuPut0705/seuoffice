/** Cross-page and cross-column paragraph joining, with hyphen repair (spec §1). */
import { describe, expect, it } from 'vitest'
import { extractDocumentTree } from '../src/tree'
import { buildPdf, loadPdfium, para, wordLines, type PageItem } from './helpers/fixtures'
import { paragraphsContaining } from './helpers/tree'

async function treeOf(pages: PageItem[][]) {
  const pdf = await buildPdf(pages)
  return (await extractDocumentTree(pdf, { pdfium: await loadPdfium() })).tree
}

/** a near-full single-column page whose last paragraph ends with `lastLine` */
const fullPage = (lastLine: string): PageItem[] => [
  ...para(wordLines(0, 20), 72, 740),
  ...para([...wordLines(3, 24), lastLine], 72, 460),
]

describe('single-column page boundary', () => {
  it('joins a paragraph cut by the page break and drops the hyphen', async () => {
    const tree = await treeOf([
      fullPage('alpha bravo delta gamma omega sigma tango lemon infor-'),
      para(['mation river stone cloud grass light night alpha bravo', 'ends here.'], 72, 740),
    ])
    const joined = paragraphsContaining(tree, 'lemon information river')
    expect(joined).toHaveLength(1)
    expect(joined[0]!.page).toBe(1)
    expect(joined[0]!.regions?.map((r) => r.page)).toEqual([1, 2])
    expect(paragraphsContaining(tree, 'infor-')).toHaveLength(0)
  })

  it('keeps the hyphen when the continuation is capitalized', async () => {
    const tree = await treeOf([
      fullPage('alpha bravo delta gamma omega sigma tango lemon x-'),
      para(['Ray stone cloud grass light night alpha bravo delta', 'ends here.'], 72, 740),
    ])
    expect(paragraphsContaining(tree, 'lemon x-Ray stone')).toHaveLength(1)
  })

  it('does not join when the last line of the page is short', async () => {
    const tree = await treeOf([
      fullPage('the end.'),
      para(['river stone cloud grass light night alpha bravo delta', 'ends here.'], 72, 740),
    ])
    expect(paragraphsContaining(tree, 'the end. river')).toHaveLength(0)
    const head = paragraphsContaining(tree, 'river stone cloud grass light night alpha')
    expect(head.map((b) => b.page)).toContain(2)
  })
})

describe('multi-column page boundary', () => {
  /** two columns of two 4-word-line paragraphs; the right column ends with `last` */
  const twoColumnPage = (seed: number, lines: number, first?: string, last?: string) => {
    const leftA = wordLines(seed, lines, 4)
    if (first) leftA[0] = first
    const rightB = wordLines(seed + 3, lines, 4)
    if (last) rightB[rightB.length - 1] = last
    const second = 740 - (lines + 1) * 13
    return [
      ...para(leftA, 72, 740),
      ...para(wordLines(seed + 1, lines, 4), 72, second),
      ...para(wordLines(seed + 2, lines, 4), 320, 740),
      ...para(rightB, 320, second),
    ]
  }

  it('joins the last column of a page to the first column of the next', async () => {
    const tree = await treeOf([
      twoColumnPage(0, 23, undefined, 'final words cross pages'),
      twoColumnPage(5, 23, 'after break flows ahead'),
    ])
    const joined = paragraphsContaining(tree, 'final words cross pages after break flows ahead')
    expect(joined).toHaveLength(1)
    expect(joined[0]!.regions?.map((r) => r.page)).toEqual([1, 2])
  })

  it('does not join when the page is far from full', async () => {
    const tree = await treeOf([
      twoColumnPage(0, 8, undefined, 'final words cross pages'),
      twoColumnPage(5, 8, 'after break flows ahead'),
    ])
    expect(paragraphsContaining(tree, 'cross pages after')).toHaveLength(0)
    expect(paragraphsContaining(tree, 'after break flows ahead')).toHaveLength(1)
  })
})
