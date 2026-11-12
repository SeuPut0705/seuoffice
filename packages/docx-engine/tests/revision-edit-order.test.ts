import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseDocx, resolvePropChangeXml, saveDocx, type SaveBlock } from '../src/index'
import { applyTrackedChangesXml } from '../src/revision-xml'
import { buildDocx } from './helpers/build-docx'

/**
 * Rejecting a tracked format change puts the recorded properties back in front
 * of what the holder keeps. The restore is an insertion at one point; the
 * record (or a paragraph-mark rPr emptied in the same pass) is a removal that
 * starts at that same point when nothing stands between them.
 */

const AT = 'w:author="X" w:date="2026-01-01T00:00:00Z"'
const CENTERED = '<w:jc w:val="center"/>'
const PPR_CHANGE = `<w:pPrChange w:id="2" ${AT}><w:pPr>${CENTERED}</w:pPr></w:pPrChange>`
const run = (t: string) => `<w:r><w:t>${t}</w:t></w:r>`
const hdr = (body: string) => `<w:hdr xmlns:w="w">${body}</w:hdr>`
const reject = (body: string) => applyTrackedChangesXml(hdr(body), 'reject')

describe('rejecting a paragraph format change that opens its w:pPr', () => {
  it('a header whose centering was removed with tracking on is centered again after reject', async () => {
    const bytes = await buildDocx({
      bodyXml: '<w:p><w:r><w:t>Body</w:t></w:r></w:p>',
      headerXml: `<w:p><w:pPr>${PPR_CHANGE}</w:pPr>${run('Title')}</w:p>`,
    })
    const parsed = await parseDocx(bytes)
    expect(parsed.headerParas![0].align).not.toBe('center')
    const blocks: SaveBlock[] = [{ kind: 'original', docxIndex: parsed.blocks[0].docxIndex! }]
    const saved = await saveDocx(parsed, blocks, {
      header: {
        text: 'Title',
        paras: parsed.headerParas!,
        keepContent: true,
        revisionsResolved: [{ mode: 'reject' }],
      },
    })
    const xml = await (await JSZip.loadAsync(saved)).file('word/header1.xml')!.async('string')
    expect(xml).toContain(`<w:p><w:pPr>${CENTERED}</w:pPr>${run('Title')}</w:p>`)
    expect((await parseDocx(saved)).headerParas![0].align).toBe('center')
  })

  it.each([
    ['nothing before the record', `<w:pPr>${PPR_CHANGE}</w:pPr>`, `<w:pPr>${CENTERED}</w:pPr>`],
    [
      'white space before the record',
      `<w:pPr> ${PPR_CHANGE}</w:pPr>`,
      `<w:pPr>${CENTERED}</w:pPr>`,
    ],
    [
      'the mark rPr after the record',
      `<w:pPr>${PPR_CHANGE}<w:rPr><w:b/></w:rPr></w:pPr>`,
      `<w:pPr>${CENTERED}<w:rPr><w:b/></w:rPr></w:pPr>`,
    ],
    [
      'a current property before the record',
      `<w:pPr><w:jc w:val="right"/>${PPR_CHANGE}</w:pPr>`,
      `<w:pPr>${CENTERED}</w:pPr>`,
    ],
  ])('%s: the old properties come back', (_name, pPr, restored) => {
    const out = reject(`<w:p>${pPr}${run('x')}</w:p>`)
    expect(out).toEqual({ xml: hdr(`<w:p>${restored}${run('x')}</w:p>`), applied: 1, remaining: 0 })
    expect(resolvePropChangeXml(pPr, 'w:pPrChange', 'reject')).toBe(restored)
  })

  it('accept drops the record and restores nothing', () => {
    const out = applyTrackedChangesXml(
      hdr(`<w:p><w:pPr>${PPR_CHANGE}</w:pPr>${run('x')}</w:p>`),
      'accept',
    )
    expect(out.xml).toBe(hdr(`<w:p><w:pPr></w:pPr>${run('x')}</w:p>`))
    expect(resolvePropChangeXml(`<w:pPr>${PPR_CHANGE}</w:pPr>`, 'w:pPrChange', 'accept')).toBe(
      '<w:pPr></w:pPr>',
    )
  })
})

describe('a paragraph-mark rPr removed in the same pass as the format change is reverted', () => {
  const next = `<w:p>${run('y')}</w:p>`

  it('an inserted mark: the paragraphs join and the first keeps its restored properties', () => {
    const out = reject(
      `<w:p><w:pPr><w:rPr><w:ins w:id="1" ${AT}/></w:rPr>${PPR_CHANGE}</w:pPr>${run('x')}</w:p>${next}`,
    )
    expect(out.xml).toBe(hdr(`<w:p><w:pPr>${CENTERED}</w:pPr>${run('x')}${run('y')}</w:p>`))
    expect(out).toMatchObject({ applied: 2, remaining: 0 })
  })

  it('a deleted mark: the mark stays and the old properties come back', () => {
    const out = reject(
      `<w:p><w:pPr><w:rPr><w:del w:id="1" ${AT}/></w:rPr>${PPR_CHANGE}</w:pPr>${run('x')}</w:p>${next}`,
    )
    expect(out.xml).toBe(hdr(`<w:p><w:pPr>${CENTERED}</w:pPr>${run('x')}</w:p>${next}`))
  })

  it('a mark rPr emptied by its own reverted format change', () => {
    const out = reject(
      `<w:p><w:pPr><w:rPr><w:rPrChange w:id="1" ${AT}><w:rPr/></w:rPrChange></w:rPr>${PPR_CHANGE}</w:pPr>${run('x')}</w:p>`,
    )
    expect(out.xml).toBe(hdr(`<w:p><w:pPr>${CENTERED}</w:pPr>${run('x')}</w:p>`))
  })

  it('a mark rPr that keeps another property stays behind the restored ones', () => {
    const out = reject(
      `<w:p><w:pPr><w:rPr><w:ins w:id="1" ${AT}/><w:b/></w:rPr>${PPR_CHANGE}</w:pPr>${run('x')}</w:p>`,
    )
    expect(out.xml).toBe(
      hdr(`<w:p><w:pPr>${CENTERED}<w:rPr><w:b/></w:rPr></w:pPr>${run('x')}</w:p>`),
    )
  })

  it('only the format change rejected: the pending mark keeps its place after the old properties', () => {
    const mark = `<w:rPr><w:ins w:id="1" ${AT}/></w:rPr>`
    const out = applyTrackedChangesXml(
      hdr(`<w:p><w:pPr>${mark}${PPR_CHANGE}</w:pPr>${run('x')}</w:p>${next}`),
      'reject',
      { type: 'formatting' },
    )
    expect(out.xml).toBe(hdr(`<w:p><w:pPr>${CENTERED}${mark}</w:pPr>${run('x')}</w:p>${next}`))
    expect(out).toMatchObject({ applied: 1, remaining: 1 })
  })
})

describe('two edits that start at one point and end at different ones', () => {
  // a marker written with a close tag is not the empty-element marker the
  // holder edits around: its removal starts where the holder's replacement does
  it('a run rPr: the whole-holder restore wins over the removal of its first child', () => {
    const out = reject(
      `<w:p><w:r><w:rPr><w:ins w:id="1" ${AT}></w:ins><w:rPrChange w:id="2" ${AT}><w:rPr><w:b/></w:rPr></w:rPrChange></w:rPr><w:t>x</w:t></w:r></w:p>`,
    )
    expect(out.xml).toBe(hdr('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>x</w:t></w:r></w:p>'))
    expect(out).toMatchObject({ applied: 2, remaining: 0 })
  })

  it('a cell tcPr: the same with w:cellIns', () => {
    const cell = (tcPr: string) => `<w:tbl><w:tr><w:tc>${tcPr}<w:p/></w:tc></w:tr></w:tbl>`
    const old = '<w:tcW w:w="4000" w:type="dxa"/>'
    const out = reject(
      cell(
        `<w:tcPr><w:cellIns w:id="1" ${AT}></w:cellIns><w:tcPrChange w:id="2" ${AT}><w:tcPr>${old}</w:tcPr></w:tcPrChange></w:tcPr>`,
      ),
    )
    expect(out.xml).toBe(hdr(cell(`<w:tcPr>${old}</w:tcPr>`)))
  })
})
