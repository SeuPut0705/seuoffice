import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { countTrackedChangesXml, parseDocx, saveDocx, type SaveBlock } from '../src/index'
import { applyTrackedChangesXml, readPropChangeXml } from '../src/revision-xml'
import { buildDocx } from './helpers/build-docx'

/**
 * XML allows an attribute value in either quote and white space around `=`.
 * Word writes `name="value"`; other producers do not, and their revisions
 * must still be selectable by author, id and date.
 */

const r = (t: string) => `<w:r><w:t>${t}</w:t></w:r>`
const dr = (t: string) => `<w:r><w:delText>${t}</w:delText></w:r>`
const hdr = (body: string) => `<w:hdr xmlns:w="w">${body}</w:hdr>`
const ANN = `w:id='7' w:author='Ann' w:date='2026-01-01T00:00:00Z'`
const BOB = `w:id='8' w:author='Bob' w:date='2026-02-01T00:00:00Z'`
const TWO = `<w:p><w:ins ${ANN}>${r('ann')}</w:ins><w:ins ${BOB}>${r('bob')}</w:ins></w:p>`

describe('revision attributes in single quotes', () => {
  it('a header from another producer: one change accepted by id, the other left pending', async () => {
    const parsed = await parseDocx(
      await buildDocx({ bodyXml: '<w:p><w:r><w:t>Body</w:t></w:r></w:p>', headerXml: TWO }),
    )
    const blocks: SaveBlock[] = [{ kind: 'original', docxIndex: parsed.blocks[0].docxIndex! }]
    const saved = await saveDocx(parsed, blocks, {
      header: {
        text: 'annbob',
        paras: parsed.headerParas!,
        keepContent: true,
        revisionsResolved: [{ mode: 'accept', filter: { ids: ['8'] } }],
      },
    })
    const xml = await (await JSZip.loadAsync(saved)).file('word/header1.xml')!.async('string')
    expect(xml).toContain(`<w:ins ${ANN}>${r('ann')}</w:ins>${r('bob')}`)
    expect(countTrackedChangesXml(xml)).toBe(1)
  })

  it.each([
    ['author', { author: 'bob' }],
    ['id', { ids: ['8'] }],
    ['exact date', { date: '2026-02-01T00:00:00Z' }],
  ])('a filter by %s picks the one change it names', (_name, filter) => {
    const out = applyTrackedChangesXml(hdr(TWO), 'reject', filter)
    expect(out).toEqual({
      xml: hdr(`<w:p><w:ins ${ANN}>${r('ann')}</w:ins></w:p>`),
      applied: 1,
      remaining: 1,
    })
  })

  it('a before filter reads the date', () => {
    const out = applyTrackedChangesXml(hdr(TWO), 'reject', { before: '2026-01-15' })
    expect(out.xml).toBe(hdr(`<w:p><w:ins ${BOB}>${r('bob')}</w:ins></w:p>`))
  })

  it('an author filter takes only its own move, range ends included', () => {
    const move = (who: string, base: number) =>
      `<w:p><w:moveFromRangeStart w:id='${base}' w:author='${who}' w:name='m${base}'/><w:moveFrom w:id='${base + 1}' w:author='${who}'>${dr(who)}</w:moveFrom><w:moveFromRangeEnd w:id='${base}'/></w:p>` +
      `<w:p><w:moveToRangeStart w:id='${base + 2}' w:author='${who}' w:name='m${base}'/><w:moveTo w:id='${base + 3}' w:author='${who}'>${r(who)}</w:moveTo><w:moveToRangeEnd w:id='${base + 2}'/></w:p>`
    const out = applyTrackedChangesXml(hdr(move('A', 10) + move('B', 20)), 'accept', {
      author: 'a',
    })
    expect(out.xml).toBe(hdr(`<w:p></w:p><w:p>${r('A')}</w:p>` + move('B', 20)))
    expect(out).toMatchObject({ applied: 2, remaining: 2 })
  })

  it('a property-change record is read with its author, id and date', () => {
    const tcPr = `<w:tcPr><w:tcW w:w="1" w:type="dxa"/><w:tcPrChange ${ANN}><w:tcPr><w:tcW w:w="2" w:type="dxa"/></w:tcPr></w:tcPrChange></w:tcPr>`
    expect(readPropChangeXml(tcPr, 'w:tcPrChange')).toEqual({
      author: 'Ann',
      date: '2026-01-01T00:00:00Z',
      id: '7',
      oldXml: '<w:tcW w:w="2" w:type="dxa"/>',
    })
  })
})

describe('revision attribute syntax', () => {
  const one = (attrs: string) => hdr(`<w:p><w:ins ${attrs}>${r('x')}</w:ins></w:p>`)
  const accepted = hdr(`<w:p>${r('x')}</w:p>`)

  it('a value holds the other kind of quote', () => {
    const single = one(`w:id="1" w:author='Ann "the editor" Lee'`)
    expect(applyTrackedChangesXml(single, 'accept', { author: 'ann "the editor" lee' }).xml).toBe(
      accepted,
    )
    const double = one(`w:id='1' w:author="O'Neil"`)
    expect(applyTrackedChangesXml(double, 'accept', { author: "o'neil" }).xml).toBe(accepted)
  })

  it('white space around the equals sign', () => {
    const xml = one(`w:id = "1" w:author\n=\n'Ann'`)
    expect(applyTrackedChangesXml(xml, 'accept', { ids: ['1'], author: 'ann' }).xml).toBe(accepted)
  })

  it('text that looks like an attribute inside another value is not the attribute', () => {
    const xml = one(`w:author="x w:id='9'" w:id="1"`)
    expect(applyTrackedChangesXml(xml, 'accept', { ids: ['9'] }).applied).toBe(0)
    expect(applyTrackedChangesXml(xml, 'accept', { ids: ['1'] }).xml).toBe(accepted)
  })
})
