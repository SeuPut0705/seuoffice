/**
 * Cross-layer fixes found while assembling the layers, checked through the
 * public API with the full registry:
 * 1. a table inside a section (or list) is claimed by the table layer's
 *    `identify` even when another new element shares its gap;
 * 2. a note edited inside a table cell is written back (the cell paragraph is
 *    rewritten although its OOXML came back unchanged);
 * 3. a space right after an inline picture stays after it.
 */
import { type SaveBlock, parseDocx, saveDocx } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import { odtToDocx, saveOdt } from '../src'
import { readOdtPackage } from '../src/core'
import { diffPackages, roundTrip, textOf } from './helpers/api'
import { replaceText } from './helpers/bridge'
import { pageDoc } from './helpers/page-fixtures'
import { buildOdt } from './helpers/build-odt'
import {
  hCell,
  hFootnote,
  hFramedTable,
  hImageFrame,
  hPara,
  hParaWith,
  hRow,
  hTable,
} from './helpers/hancom-fragments'
import { PNG_1X1 } from './helpers/hancom-sample'
import { PNG_GREY } from './helpers/objects-fixtures'
import { cellRuns, editRuns, patchCells, regenerate } from './helpers/table-editor'

const contentOf = async (odt: Uint8Array) => textOf(await readOdtPackage(odt), 'content.xml')

describe('a table inside a section', () => {
  it('is matched by the table layer when a new paragraph shares its gap', async () => {
    const cellB = hCell(hPara('b'))
    const table = hTable('Table1', 2, [hRow([hCell(hPara('a')), cellB])])
    const section = `<text:section text:style-name="Sect1" text:name="S1">${table}</text:section>`
    const odt = await buildOdt({ body: hPara('앞') + section + hPara('뒤') })
    const before = await contentOf(odt)
    const { saved } = await roundTrip(odt, (blocks) =>
      blocks.flatMap((b, i) =>
        b.type === 'table'
          ? [
              patchCells(b, [
                { row: 0, tc: 1, paras: [{ runs: editRuns(cellRuns(b, 0, 1), 1, 1, '1') }] },
              ]),
              { insert: { type: 'paragraph' as const, runs: [{ text: '새 문단' }] } },
            ]
          : [{ keep: i }],
      ),
    )
    const after = await contentOf(saved)
    // the edited cell is patched in place inside the section; the table is not duplicated
    expect(after.split('<table:table ').length).toBe(2)
    expect(after).toMatch(
      /<\/text:section><text:p text:style-name="P_io\d+"><text:span[^>]*>새 문단<\/text:span><\/text:p>/,
    )
    const stripped = after
      .replace(/<style:style style:name="[^"]*_io\d+"[\s\S]*?<\/style:style>/g, '')
      .replace(/<text:p text:style-name="P_io\d+">[\s\S]*?<\/text:p>/, '')
    expect(stripped).toBe(before.replace(cellB, hCell(hPara('b1'))))
  })
})

describe('a note inside a table cell', () => {
  it('is written back when only the note text changed', async () => {
    const note = hFootnote('셀 각주')
    const cell = hCell(hParaWith(`칸${note}`))
    const odt = await buildOdt({
      body: hPara('앞') + hTable('Table1', 2, [hRow([cell, hCell(hPara('b'))])]),
    })
    const before = await contentOf(odt)
    const { saved } = await roundTrip(odt, (blocks) => blocks.map((_, i) => ({ keep: i })), {
      footnotes: [{ id: '1', text: '고친 셀 각주' }],
    })
    const after = await contentOf(saved)
    expect(after).not.toBe(before)
    expect(after).toContain('고친 셀 각주')
    expect(after).not.toContain('>셀 각주<')
    // everything outside that cell keeps its bytes
    const start = before.indexOf(cell)
    expect(after.slice(0, start)).toBe(before.slice(0, start))
    const tail = before.slice(start + cell.length)
    expect(after.endsWith(tail)).toBe(true)
  })
})

describe('a space after an inline picture', () => {
  const image = hImageFrame('Pictures/a.png', { anchor: 'as-char' })
  const paragraph = hParaWith(`a ${image.frame} b`)

  it('is shown after the picture', async () => {
    const odt = await buildOdt({ body: paragraph, pictures: { 'a.png': PNG_1X1 } })
    const { docxBytes } = await odtToDocx(odt)
    const parsed = await parseDocx(docxBytes)
    const runs = parsed.blocks.filter((b) => !b.hidden)[0].runs ?? []
    expect(runs.map((r) => (r.image ? '[img]' : r.text)).join('')).toBe('a [img] b')
  })

  it('stays after the picture when the paragraph is edited', async () => {
    const odt = await buildOdt({ body: paragraph, pictures: { 'a.png': PNG_1X1 } })
    const before = await contentOf(odt)
    const { saved } = await roundTrip(odt, (blocks) =>
      blocks.map((_, i) =>
        i === 0
          ? {
              edit: i,
              change: (g) => {
                g.runs[0] = { ...g.runs[0], text: g.runs[0].text.replace('a', 'c') }
              },
            }
          : { keep: i },
      ),
    )
    const after = await contentOf(saved)
    const written = paragraph.replace('>a <', '>c <')
    expect(after).toBe(before.replace(paragraph, written))
  })
})

describe('a picture inside a table cell', () => {
  it('keeps its frame when the cell text is edited', async () => {
    const image = hImageFrame('Pictures/a.png', { anchor: 'as-char' })
    const cellPara = hParaWith(`셀${image.frame}`)
    const odt = await buildOdt({
      body: hTable('Table2', 1, [hRow([hCell(cellPara)])]),
      pictures: { 'a.png': PNG_1X1 },
    })
    const before = await contentOf(odt)
    const { saved } = await roundTrip(odt, (blocks) =>
      blocks.map((b, i) =>
        b.type === 'table'
          ? patchCells(b, [
              { row: 0, tc: 0, paras: [{ runs: editRuns(cellRuns(b, 0, 0), 0, 1, '칸') }] },
            ])
          : { keep: i },
      ),
    )
    const after = await contentOf(saved)
    expect(after).toBe(before.replace(cellPara, hParaWith(`칸${image.frame}`)))
  })
})

describe('a page run ending with a framed table', () => {
  it('saves unedited byte for byte and keeps the run when a paragraph is edited', async () => {
    const framed = hFramedTable(hTable('Table1', 1, [hRow([hCell(hPara('표'))])]))
    const body =
      hPara('one a', { style: 'PS1' }) +
      framed.paragraph +
      hPara('two a', { style: 'PS2' }) +
      hPara('two b')
    const odt = await buildOdt(pageDoc({ body }))
    const { saved } = await roundTrip(odt, (blocks) => blocks.map((_, i) => ({ keep: i })))
    expect(saved).toBe(odt)
    const edited = await roundTrip(odt, (blocks) =>
      blocks.map((b, i) =>
        (b.runs ?? []).map((r) => r.text).join('') === 'two b'
          ? { edit: i, change: (g) => replaceText(g, 0, 0, '>') }
          : { keep: i },
      ),
    )
    const diff = await diffPackages(odt, edited.saved)
    expect(diff.changed).toEqual(['content.xml'])
    const before = await contentOf(odt)
    expect(await contentOf(edited.saved)).toBe(before.replace('>two b<', '>&gt;two b<'))
  })
})

describe('a regenerated table with a picture cell', () => {
  it('keeps the cell paragraph bytes (span around the frame, bookmark after it)', async () => {
    const image = hImageFrame('Pictures/a.png', { anchor: 'as-char' })
    const cellPara = `<text:p text:style-name="P1_0"><text:span text:style-name="T1">${image.frame}</text:span><text:bookmark text:name="CellField1"/></text:p>`
    const odt = await buildOdt({
      body: hTable('Table1', 2, [hRow([hCell(cellPara), hCell(hPara('b'))])]),
      pictures: { 'a.png': PNG_1X1 },
    })
    const { saved } = await roundTrip(odt, (blocks) =>
      blocks.map((b, i) => (b.type === 'table' ? regenerate(b, () => {}) : { keep: i })),
    )
    expect(saved).toBe(odt)
  })
})

describe('a picture in the text paragraph of a framed table', () => {
  // Hancom puts a floating picture and a framed table in one paragraph; the editor shows the
  // table, and the picture as a picture block of its own
  it('is replaced in place, the paragraph and its table written once', async () => {
    const table = hTable('Table1', 1, [hRow([hCell(hPara('표'))])])
    const framed = hFramedTable(table)
    const image = hImageFrame('Pictures/a.png', { anchor: 'paragraph' })
    // the picture after the frame, in the host paragraph's own span
    const close = '</text:span></text:p>'
    const host = framed.paragraph.slice(0, -close.length) + image.frame + close
    const odt = await buildOdt({
      body: hPara('앞') + host + hPara('뒤'),
      pictures: { 'a.png': PNG_1X1 },
    })
    const before = await contentOf(odt)
    const { docxBytes, bridge } = await odtToDocx(odt)
    const parsed = await parseDocx(docxBytes)
    const blocks = parsed.blocks.filter((b) => !b.hidden)
    const pic = blocks.findIndex((b) => b.type === 'image')
    expect(pic).toBeGreaterThan(0)
    const save: SaveBlock[] = blocks.map((b, i) =>
      i === pic
        ? {
            kind: 'xml',
            xml: b.originalXml as string,
            docxIndex: b.docxIndex as number,
            replaceImage: { base64: Buffer.from(PNG_GREY).toString('base64'), mime: 'image/png' },
          }
        : { kind: 'original', docxIndex: b.docxIndex as number },
    )
    const saved = await saveOdt({
      originalOdt: odt,
      bridge,
      editedDocx: await saveDocx(parsed, save),
    })
    const after = await contentOf(saved)
    expect(after).toBe(before.replace('Pictures/a.png', 'Pictures/io_1.png'))
  })
})
