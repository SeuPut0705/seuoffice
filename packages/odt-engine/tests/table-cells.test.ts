/**
 * Cell content beyond plain paragraphs: lists inside cells keep their list
 * markup, tables inside sections are written inside the section, an empty
 * self-closing cell can be filled.
 */
import { type Block, parseDocx } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import type { TableExt } from '../src/table'
import { editorSave, odtToBridge, writeBack } from './helpers/bridge'
import { buildOdt } from './helpers/build-odt'
import { hCell, hPara, hRow, hTable } from './helpers/hancom-fragments'
import {
  cellRuns,
  editRuns,
  firstDiff,
  patchCells,
  tableRegistry,
  tableTexts,
} from './helpers/table-editor'

async function open(body: string) {
  const bridge = await odtToBridge(await buildOdt({ body }), tableRegistry())
  const parsed = await parseDocx(bridge.docx)
  const visible = parsed.blocks.filter((b) => !b.hidden)
  const ext = bridge.map.ext.table as unknown as TableExt
  return { bridge, visible, ext, xml: bridge.doc.contentXml }
}

async function editTable(
  o: Awaited<ReturnType<typeof open>>,
  index: number,
  op: (b: Block) => ReturnType<typeof patchCells>,
) {
  const { bytes } = await editorSave(o.bridge.docx, (blocks) =>
    blocks.map((b, i) => (i === index ? op(b) : { keep: i })),
  )
  return writeBack(o.bridge, bytes)
}

const expectSame = (actual: string, expected: string) =>
  expect(firstDiff(actual, expected)).toBeNull()

describe('lists inside cells', () => {
  const list =
    '<text:list text:style-name="NL2"><text:list-item>' +
    hPara('하나') +
    '</text:list-item><text:list-item>' +
    hPara('둘') +
    '</text:list-item></text:list>'
  const table = hTable('Table1', 1, [hRow([hCell(list)])])

  it('shows the list items as numbered cell paragraphs', async () => {
    const o = await open(table)
    const t = o.visible[0]
    expect(tableTexts(t)).toEqual([['하나\n둘']])
    expect(t.table?.rows[0][0].richParas?.map((p) => p.list?.ilvl)).toEqual([0, 0])
  })

  it('an edited list paragraph is replaced inside its list item', async () => {
    const o = await open(table)
    const wb = await editTable(o, 0, (b) =>
      patchCells(b, [
        { row: 0, tc: 0, paras: [null, { runs: editRuns(cellRuns(b, 0, 0, 1), 1, 1, '째') }] },
      ]),
    )
    expectSame(wb.content, o.xml.replace(hPara('둘'), hPara('둘째')))
  })

  it('a paragraph added after a list item stays in that item', async () => {
    const o = await open(table)
    const wb = await editTable(o, 0, (b) =>
      patchCells(b, [
        {
          row: 0,
          tc: 0,
          paras: [
            { runs: cellRuns(b, 0, 0, 0) },
            { runs: cellRuns(b, 0, 0, 1) },
            { runs: [{ ...cellRuns(b, 0, 0, 1)[0], text: '셋' }] },
          ],
        },
      ]),
    )
    expectSame(wb.content, o.xml.replace(hPara('둘'), hPara('둘') + hPara('셋')))
  })
})

describe('tables in sections and empty cells', () => {
  it('a table inside a section is written inside the section', async () => {
    const table = hTable('Table1', 2, [hRow([hCell(hPara('가')), hCell(hPara('나'))])])
    const section = `<text:section text:style-name="Sect1" text:name="S1">${table}</text:section>`
    const o = await open(hPara('앞') + section)
    expect(o.bridge.map.blocks.map((b) => [b.name, b.owner])).toEqual([
      ['text:p', 'text'],
      ['text:section', 'container'],
      ['table:table', 'table'],
    ])
    const wb = await editTable(o, 1, (b) =>
      patchCells(b, [
        { row: 0, tc: 1, paras: [{ runs: editRuns(cellRuns(b, 0, 1), 1, 1, '다') }] },
      ]),
    )
    expectSame(wb.content, o.xml.replace(hPara('나'), hPara('나다')))
  })

  it('an empty self-closing cell can be filled', async () => {
    const empty = '<table:table-cell table:style-name="Table1.A1" office:value-type="string"/>'
    const table = hTable('Table1', 2, [hRow([hCell(hPara('가')), empty])])
    const o = await open(table)
    expect(tableTexts(o.visible[0])).toEqual([['가', '']])
    const rec = o.ext.tables[0]
    expect(rec.cells[0][1]).toMatchObject({ kind: 'cell', synthetic: 'empty' })
    const wb = await editTable(o, 0, (b) =>
      patchCells(b, [{ row: 0, tc: 1, paras: [{ runs: [{ text: '새' }] }] }]),
    )
    let stripped = wb.content
    for (const x of wb.rctx.newAutomaticStyles('content.xml')) stripped = stripped.replace(x, '')
    const at = o.xml.indexOf(empty)
    expect(stripped.slice(0, at)).toBe(o.xml.slice(0, at))
    expect(stripped.slice(at)).toMatch(
      /^<table:table-cell [^>]*><text:p text:style-name="[^"]+">(<text:span[^>]*>)?새(<\/text:span>)?<\/text:p><\/table:table-cell><\/table:table-row>/,
    )
    // an untouched empty cell stays self-closing
    const same = await writeBack(o.bridge, o.bridge.docx)
    expect(same.content).toBe(o.xml)
  })
})
