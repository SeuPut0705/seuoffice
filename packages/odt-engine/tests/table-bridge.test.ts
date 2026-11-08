/**
 * ODF → OOXML for tables: the three Hancom placements open as editor tables,
 * merges/widths/heights/cell look are mapped, an unedited round trip writes
 * nothing, and the locked cells are published in `ext.table`.
 */
import { type Block, parseDocx } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import { type TableExt, isProtectedCell, protectedCellsOf } from '../src/table'
import { editorSave, odtToBridge, writeBack } from './helpers/bridge'
import { buildOdt } from './helpers/build-odt'
import { hancomSample } from './helpers/hancom-sample'
import { regenerate, tableRegistry, tableTexts } from './helpers/table-editor'
import { tablesDoc } from './helpers/table-fixtures'

async function open(body = tablesDoc()) {
  const bridge = await odtToBridge(await buildOdt(body.options), tableRegistry())
  const parsed = await parseDocx(bridge.docx)
  const visible = parsed.blocks.filter((b) => !b.hidden)
  return { bridge, parsed, visible, doc: body }
}

const tables = (blocks: Block[]) => blocks.filter((b) => b.type === 'table')

describe('tables open in the editor', () => {
  it('shows framed, body-level, nested and mixed-paragraph tables as tables', async () => {
    const { bridge, visible } = await open()
    expect(visible.map((b) => b.type)).toEqual([
      'paragraph', // 앞
      'table', // framed Table1
      'table', // body Table2 (nested Table3 inside)
      'paragraph', // 중간
      'table', // paragraph-anchored Table4
      'paragraph', // "(단위: %)" of the mixed paragraph
      'table', // Table5 framed in it
      'paragraph', // 뒤
    ])
    const owners = bridge.map.blocks.filter((b) => b.parent === null).map((b) => b.owner)
    expect(owners).toEqual(['text', 'table', 'table', 'text', 'table', 'table', 'text'])
    const [t1, t2, t4, t5] = tables(visible)
    expect(tableTexts(t1)).toEqual([['보도일시'], ['잠금', 'a', 'b'], ['', 'c', '이름: 홍길동']])
    expect(t1.table?.rows[0][0].colSpan).toBe(3)
    expect(t1.table?.rows[1][0].vMerge).toBe('restart')
    expect(t1.table?.rows[2][0].vMerge).toBe('continue')
    expect(t1.table?.colWidthsTwips).toEqual([1305, 1305, 1305])
    expect(t1.table?.rowHeightsTwips).toEqual([487, 487, 487])
    expect(t1.table?.rows[1][1].vAlign).toBe('center')
    expect(t1.table?.rows[1][1].borders?.top).toMatchObject({ style: 'single', color: '000000' })
    // the as-char frame sits in a centred paragraph
    expect(t1.table?.align).toBe('center')
    // a cell ending with a table gets the empty paragraph OOXML requires
    expect(tableTexts(t2)).toEqual([['host\n']])
    expect(t2.table?.rows[0][0].nestedTables?.[0].rows[0].map((c) => c.paras.join(''))).toEqual([
      'x',
      'y',
    ])
    expect(tableTexts(t4)).toEqual([
      ['머리 1', '머리 2'],
      ['값 1', '값 2'],
    ])
    expect(t4.table?.repeatHeaderRows).toEqual([true, false])
    expect(tableTexts(t5)).toEqual([['단위 표']])
    expect(visible[5].runs?.map((r) => r.text).join('')).toBe('(단위: %)')
  })

  it('records cell ranges, the frame wrapper and units in ext.table', async () => {
    const { bridge, doc } = await open()
    const ext = bridge.map.ext.table as unknown as TableExt
    const xml = bridge.doc.contentXml
    const t1 = ext.tables[ext.elements[String(1)]]
    expect(xml.slice(t1.start, t1.end)).toBe(doc.pieces.table1)
    expect(t1.frame && xml.slice(t1.frame.frame.start, t1.frame.frame.end)).toBe(doc.pieces.frame)
    expect(t1.frame && xml.slice(t1.frame.paragraph.start, t1.frame.paragraph.end)).toBe(
      doc.pieces.framedParagraph,
    )
    expect(xml.slice(t1.cells[1][0].start, t1.cells[1][0].end)).toBe(doc.pieces.lockedCell)
    expect(t1.cells[2][0]).toMatchObject({ kind: 'covered', anchor: [1, 0], tc: 0 })
    expect(t1.cells[0][1]).toMatchObject({ kind: 'covered', anchor: [0, 0], tc: null })
    expect(xml.slice(t1.cells[2][2].start, t1.cells[2][2].end)).toBe(doc.pieces.fieldCell)
    const nested = ext.tables.find((t) => t.host !== null)
    expect(nested?.host).toEqual({ table: ext.elements['2'], row: 0, col: 0, index: 0 })
    expect(nested && xml.slice(nested.start, nested.end)).toBe(doc.pieces.nested)
    // cell paragraphs are recorded by the table owner
    const a = t1.cells[1][1]
    const unit = a.kind === 'cell' ? a.units[0] : null
    const p = unit?.kind === 'p' ? bridge.map.paragraphs[unit.paragraph] : null
    expect(p).toMatchObject({ owner: 'table', text: 'a' })
    // covered cells keep only their range, anchor and w:tc index
    expect(Object.keys(t1.cells[0][1]).sort()).toEqual(['anchor', 'end', 'kind', 'start', 'tc'])
  })

  it('publishes locked cells; the list survives the JSON round trip', async () => {
    const { bridge } = await open()
    // odtToBridge already round-trips the map through JSON
    expect(protectedCellsOf(bridge.map)).toEqual([{ table: 1, path: [], row: 1, col: 0, tc: 0 }])
    expect(isProtectedCell(bridge.map, { table: 1, row: 1, col: 0 })).toBe(true)
    expect(isProtectedCell(bridge.map, { table: 1, row: 1, tc: 0 })).toBe(true)
    expect(isProtectedCell(bridge.map, { table: 1, row: 1, col: 1 })).toBe(false)
    const again = JSON.parse(JSON.stringify(bridge.map))
    expect(protectedCellsOf(again)).toEqual(protectedCellsOf(bridge.map))
  })

  it('a locked cell in a nested table is addressed through its host cell', async () => {
    const { hCell, hPara, hRow, hTable } = await import('./helpers/hancom-fragments')
    const inner = hTable('Table3', 2, [
      hRow(
        [hCell(hPara('x'), { style: 'Table3.A1', protected: true }), hCell(hPara('y'))],
        'Table3.1',
      ),
    ])
    const outer = hTable('Table2', 1, [hRow([hCell(hPara('host') + inner)], 'Table2.1')])
    const bridge = await odtToBridge(await buildOdt({ body: outer }), tableRegistry())
    expect(protectedCellsOf(bridge.map)).toEqual([
      { table: 0, path: [{ row: 0, col: 0, index: 0 }], row: 0, col: 0, tc: 0 },
    ])
  })
})

describe('unedited round trips', () => {
  it('writes nothing back for an unchanged document', async () => {
    const { bridge } = await open()
    const wb = await writeBack(bridge, bridge.docx)
    expect(wb.content).toBe(bridge.doc.contentXml)
    expect(wb.styles).toBe(bridge.doc.stylesXml)
    const kept = await editorSave(bridge.docx, (blocks) => blocks.map((_, i) => ({ keep: i })))
    expect((await writeBack(bridge, kept.bytes)).content).toBe(bridge.doc.contentXml)
  })

  it('a table the editor regenerates without changes writes nothing back', async () => {
    const { bridge, visible } = await open()
    const { bytes } = await editorSave(bridge.docx, (blocks) =>
      blocks.map((b, i) => (b.type === 'table' ? regenerate(visible[i], () => {}) : { keep: i })),
    )
    const wb = await writeBack(bridge, bytes)
    expect(wb.rctx.newAutomaticStyles('content.xml')).toEqual([])
    expect(wb.content).toBe(bridge.doc.contentXml)
  })

  it('the Hancom sample round-trips byte for byte with the table layer', async () => {
    const sample = hancomSample()
    const bridge = await odtToBridge(await buildOdt(sample.options), tableRegistry())
    const parsed = await parseDocx(bridge.docx)
    expect(parsed.blocks.filter((b) => !b.hidden && b.type === 'table').length).toBe(3)
    const wb = await writeBack(bridge, bridge.docx)
    expect(wb.content).toBe(bridge.doc.contentXml)
    expect(protectedCellsOf(bridge.map)).toHaveLength(1)
  })
})
