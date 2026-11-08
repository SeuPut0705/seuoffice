/** Caption binding for images and tables (spec §1). */
import { describe, expect, it } from 'vitest'
import { extractDocumentTree, isCaptionText } from '../src/tree'
import { buildPdf, loadPdfium, type PageItem, type TextItem } from './helpers/fixtures'
import { textOf } from './helpers/tree'

const line = (text: string, y: number, x = 72, size = 12): TextItem => ({
  kind: 'text',
  text,
  x,
  y,
  size,
})

const bodyLines = (yTop: number): PageItem[] => [
  line('Opening paragraph text that sits well above the picture.', yTop),
  line('It carries on for a second line before the figure.', yTop - 14),
]

async function treeOf(items: PageItem[]) {
  const pdf = await buildPdf([items])
  return (await extractDocumentTree(pdf, { pdfium: await loadPdfium() })).tree
}

describe('caption binding', () => {
  it('binds a numbered caption directly below an image', async () => {
    const tree = await treeOf([
      ...bodyLines(740),
      { kind: 'image', x: 236, y: 500, width: 140, height: 140 },
      line('Figure 1. A small red square.', 484, 236, 10),
      line('Closing paragraph text far below the figure and its caption.', 380),
    ])
    const image = tree.blocks.find((b) => b.kind === 'image')
    expect(image?.kind).toBe('image')
    if (image?.kind !== 'image') return
    expect(image.caption?.position).toBe('below')
    expect(textOf(image.caption!.runs)).toBe('Figure 1. A small red square.')
    expect(image.caption!.page).toBe(1)
    const paras = tree.blocks.filter((b) => b.kind === 'paragraph').map((b) => textOf(b.runs))
    expect(paras.some((t) => t.includes('Figure 1'))).toBe(false)
    expect(paras.some((t) => t.includes('Closing paragraph'))).toBe(true)
  })

  it('leaves an unnumbered or distant "Figure" line in the body', async () => {
    const tree = await treeOf([
      ...bodyLines(740),
      { kind: 'image', x: 236, y: 500, width: 140, height: 140 },
      line('Figure out what the square means.', 484, 236, 10),
      line('Figure 2. This caption sits far below.', 300, 72, 10),
    ])
    const image = tree.blocks.find((b) => b.kind === 'image')
    expect(image?.kind === 'image' && image.caption).toBeFalsy()
    const paras = tree.blocks.filter((b) => b.kind === 'paragraph').map((b) => textOf(b.runs))
    expect(paras.some((t) => t.includes('Figure out'))).toBe(true)
    expect(paras.some((t) => t.includes('Figure 2.'))).toBe(true)
  })

  it('binds a table caption directly above a table', async () => {
    const tree = await treeOf([
      line('Before the table comes a normal paragraph.', 760),
      line('Table 1: Unit prices', 708, 72, 10),
      { kind: 'rule', x1: 72, y1: 700, x2: 456, y2: 700, thickness: 1 },
      { kind: 'rule', x1: 72, y1: 660, x2: 456, y2: 660, thickness: 1 },
      { kind: 'rule', x1: 72, y1: 620, x2: 456, y2: 620, thickness: 1 },
      { kind: 'rule', x1: 72, y1: 620, x2: 72, y2: 700, thickness: 1 },
      { kind: 'rule', x1: 264, y1: 620, x2: 264, y2: 700, thickness: 1 },
      { kind: 'rule', x1: 456, y1: 620, x2: 456, y2: 700, thickness: 1 },
      line('Name', 80, 674),
      line('Price', 272, 674),
      line('Apple', 80, 634),
      line('3', 272, 634),
    ])
    const table = tree.blocks.find((b) => b.kind === 'table')
    expect(table?.kind).toBe('table')
    if (table?.kind !== 'table') return
    expect(table.caption?.position).toBe('above')
    expect(textOf(table.caption!.runs)).toBe('Table 1: Unit prices')
  })

  it('recognizes caption words across scripts', () => {
    for (const t of [
      '그림 3 실험 장치',
      '표 2. 결과',
      '图1 结构',
      '表 4 数据',
      '図2 概要',
      'Fig. 5 Setup',
      'Table IV Summary',
    ]) {
      expect(isCaptionText(t), t).toBe(true)
    }
    for (const t of ['Figure out the rest', '표준 절차', 'Tables are useful', '图书馆']) {
      expect(isCaptionText(t), t).toBe(false)
    }
  })
})
