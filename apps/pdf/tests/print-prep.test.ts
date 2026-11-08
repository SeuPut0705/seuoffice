// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { PDFDocument, degrees } from 'pdf-lib'
import { blankPagesToAdd, duplexMergeBytes } from '../src/main/print-prep'

/** pages whose widths base, base + 1, … tell them apart; each has a drawn square */
async function pdf(pageCount: number, base: number, rotate = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([base + i, 300])
    page.setRotation(degrees(rotate))
    // something drawn, so a padded blank page tells itself apart by having no content
    page.drawRectangle({ x: 10, y: 10, width: 20, height: 20 })
  }
  return doc.save({ useObjectStreams: false })
}

const pages = async (bytes: Uint8Array) =>
  (await PDFDocument.load(bytes))
    .getPages()
    .map((p) => [Math.round(p.getWidth()), p.getRotation().angle, p.node.Contents() ? 1 : 0])

describe('blankPagesToAdd', () => {
  it('pads up to the next multiple and adds nothing to a full one', () => {
    expect([1, 2, 3, 4, 5].map((n) => blankPagesToAdd(n, 2))).toEqual([1, 0, 1, 0, 1])
    expect([1, 3, 4, 5, 8].map((n) => blankPagesToAdd(n, 4))).toEqual([3, 1, 0, 3, 0])
    expect(blankPagesToAdd(3, 0)).toBe(0)
  })
})

describe('duplexMergeBytes', () => {
  it('starts every file on a new sheet when printed on both sides', async () => {
    const out = await duplexMergeBytes([await pdf(3, 100), await pdf(2, 200), await pdf(1, 300)], 2)
    expect(await pages(out)).toEqual([
      [100, 0, 1],
      [101, 0, 1],
      [102, 0, 1],
      [102, 0, 0], // blank, sized like the page before it
      [200, 0, 1],
      [201, 0, 1],
      [300, 0, 1],
      [300, 0, 0],
    ])
  })

  it('pads to whole sheets for two-up printing on both sides', async () => {
    const out = await duplexMergeBytes([await pdf(5, 100), await pdf(4, 200)], 4)
    expect((await PDFDocument.load(out)).getPageCount()).toBe(12)
  })

  it('turns a blank page like the last page of its file', async () => {
    const out = await duplexMergeBytes([await pdf(1, 100, 90)], 2)
    expect((await pages(out)).map((p) => p[1])).toEqual([90, 90])
  })

  it('leaves the inputs untouched', async () => {
    const input = await pdf(3, 100)
    const before = Buffer.from(input)
    await duplexMergeBytes([input], 2)
    expect(Buffer.from(input).equals(before)).toBe(true)
  })
})
