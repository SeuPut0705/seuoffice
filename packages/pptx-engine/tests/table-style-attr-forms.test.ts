import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import {
  addTable,
  createBlankPptx,
  editTableStyle,
  openPptx,
  savePptx,
  TABLE_STYLE_PRESETS,
  type TableStyleEdit,
} from '../src/index'
import type { TableElement } from '../src/types'

/**
 * XML lets an attribute be quoted with ' or ", with spaces around the '='. PowerPoint writes
 * key="value", other producers do not always. The Table Design toggles used to look for the
 * key="..." form only: on a table written the other way they added a second attribute of the same
 * name (a part that is not well-formed) and could not take one away.
 */

const STYLE_ID = '<a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId>'

/** Apply `edit` to a table whose <a:tblPr> carries `attrs` as written, then save and reopen. */
async function edited(attrs: string, edit: TableStyleEdit) {
  const opened = await openPptx(await createBlankPptx())
  const added = addTable(opened, 0, {
    rows: 2,
    cols: 2,
    offset: { x: 914400, y: 914400, cx: 3657600, cy: 1828800 },
  })!
  const el = added.slide.elements.find((e) => e.id === added.elementId)!
  el.anchor.originalXml = el.anchor.originalXml.replace(
    /<a:tblPr\b[^>]*\/>|<a:tblPr\b[^>]*>[\s\S]*?<\/a:tblPr>/,
    () => `<a:tblPr${attrs}>${STYLE_ID}</a:tblPr>`,
  )
  expect(editTableStyle(added.slide, el.id, edit)).toBe(true)

  const reopened = await openPptx(await savePptx(opened))
  const slide = reopened.deck.slides[0]!
  const xml = reopened.archive.readText(slide.path)!
  return {
    wellFormed: XMLValidator.validate(xml),
    tag: /<a:tblPr\b[^>]*>/.exec(xml)![0],
    table: slide.elements.find((e) => e.type === 'table') as TableElement,
  }
}

const count = (tag: string, name: string): number =>
  [...tag.matchAll(/\s([^\s=/>]+)\s*=/g)].filter((m) => m[1] === name).length

describe('Table Design toggles on a tblPr another producer wrote', () => {
  const forms: [label: string, attrs: string][] = [
    ["single quotes: firstRow='1'", " firstRow='1' bandRow='1'"],
    ['spaces around =: firstRow = "1"', ' firstRow = "1" bandRow="1"'],
    ["both: firstRow  =  '1'", " bandRow = '1' firstRow  =  '1'"],
    ['PowerPoint form: firstRow="1"', ' firstRow="1" bandRow="1"'],
    ['absent', ' bandRow="1"'],
  ]

  for (const [label, attrs] of forms) {
    it(`turning the header row on leaves one firstRow (${label})`, async () => {
      const r = await edited(attrs, { firstRow: true })
      expect(r.wellFormed).toBe(true)
      expect(count(r.tag, 'firstRow')).toBe(1)
      expect(count(r.tag, 'bandRow')).toBe(1)
      expect(r.table.styleFlags).toMatchObject({ firstRow: true, bandRow: true })
    })

    it(`turning the header row off removes it (${label})`, async () => {
      const r = await edited(attrs, { firstRow: false })
      expect(r.wellFormed).toBe(true)
      expect(count(r.tag, 'firstRow')).toBe(0)
      expect(count(r.tag, 'bandRow')).toBe(1)
      expect(r.table.styleFlags).toMatchObject({ firstRow: false, bandRow: true })
    })
  }

  it('an attribute it does not touch keeps its bytes', async () => {
    const r = await edited(" firstRow='1' bandRow = '1'", { firstRow: false })
    expect(r.tag).toBe("<a:tblPr bandRow = '1'>")
  })

  it('a longer name that ends with the key is another attribute', async () => {
    const on = await edited(' xfirstRow="1" x:firstRow="1"', { firstRow: true })
    expect(on.tag).toBe('<a:tblPr xfirstRow="1" x:firstRow="1" firstRow="1">')
    const off = await edited(" xfirstRow='1' firstRow='1'", { firstRow: false })
    expect(off.tag).toBe("<a:tblPr xfirstRow='1'>")
  })

  it('a value that merely contains the key is not the attribute', async () => {
    const r = await edited(` title=" firstRow='1' " firstRow='1'`, { firstRow: false })
    expect(r.wellFormed).toBe(true)
    expect(r.tag).toBe(`<a:tblPr title=" firstRow='1' ">`)
  })

  it("right-to-left written as rtl = '1' can be turned off and on", async () => {
    const off = await edited(" rtl = '1' firstRow='1'", { rtl: false })
    expect(off.wellFormed).toBe(true)
    expect(count(off.tag, 'rtl')).toBe(0)
    expect(off.table.rtl).toBeFalsy()

    const on = await edited(" rtl = '1' firstRow='1'", { rtl: true })
    expect(on.wellFormed).toBe(true)
    expect(count(on.tag, 'rtl')).toBe(1)
    expect(on.table.rtl).toBe(true)
  })

  it("a style preset keeps a direction written as rtl='1'", async () => {
    const preset = TABLE_STYLE_PRESETS['zebraBlue']!
    const r = await edited(" rtl='1' firstRow='1'", { tblPrXml: preset.tblPrXml })
    expect(r.wellFormed).toBe(true)
    expect(count(r.tag, 'rtl')).toBe(1)
    expect(r.table.rtl).toBe(true)
  })
})
