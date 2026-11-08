/**
 * Cell-level write-back: a cell edit rewrites only that cell's paragraphs,
 * form fields stay with their text inside cells, locked cells never change,
 * nested tables and frame paragraphs keep their wrappers.
 */
import {
  type Block,
  type GeneratedBlock,
  generateTableXml,
  parseDocx,
  patchTableCellTexts,
} from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import type { TableExt } from '../src/table'
import { type EditorOp, editorSave, odtToBridge, replaceText, writeBack } from './helpers/bridge'
import { buildOdt } from './helpers/build-odt'
import { hFieldBookmark, hPara, hParaWith } from './helpers/hancom-fragments'
import {
  cellRuns,
  editRuns,
  firstDiff,
  patchCells,
  regenerate,
  tableRegistry,
  tableTexts,
} from './helpers/table-editor'
import { CELL_FIELD, tablesDoc } from './helpers/table-fixtures'

async function open() {
  const doc = tablesDoc()
  const bridge = await odtToBridge(await buildOdt(doc.options), tableRegistry())
  const parsed = await parseDocx(bridge.docx)
  const visible = parsed.blocks.filter((b) => !b.hidden)
  const ext = bridge.map.ext.table as unknown as TableExt
  return { bridge, visible, doc, ext, xml: bridge.doc.contentXml }
}

type Opened = Awaited<ReturnType<typeof open>>

/** Saves with `ops` for the blocks it names, keeping every other block. */
async function save(o: Opened, ops: Record<number, (b: Block) => EditorOp>) {
  const { bytes } = await editorSave(o.bridge.docx, (blocks) =>
    blocks.map((b, i) => (ops[i] ? ops[i](b) : { keep: i })),
  )
  return writeBack(o.bridge, bytes)
}

/** Content minus the new automatic styles. */
const withoutNewStyles = (wb: Awaited<ReturnType<typeof writeBack>>) => {
  let out = wb.content
  for (const x of wb.rctx.newAutomaticStyles('content.xml')) out = out.replace(x, '')
  return out
}

const expectSame = (actual: string, expected: string) =>
  expect(firstDiff(actual, expected)).toBeNull()

const range = (o: Opened, r: { start: number; end: number }) => o.xml.slice(r.start, r.end)

describe('editing one cell', () => {
  it('rewrites only that cell; other cells, rows, the table and its frame keep their bytes', async () => {
    const o = await open()
    const wb = await save(o, {
      1: (b) =>
        patchCells(b, [
          { row: 1, tc: 1, paras: [{ runs: editRuns(cellRuns(b, 1, 1), 1, 1, '바뀜') }] },
        ]),
    })
    const cell = o.ext.tables[o.ext.elements['1']].cells[1][1]
    expect(range(o, cell)).toBe(o.doc.pieces.cellA)
    expectSame(
      wb.content,
      o.xml.slice(0, cell.start) +
        o.doc.pieces.cellA.replace('>a<', '>a바뀜<') +
        o.xml.slice(cell.end),
    )
    expect(wb.rctx.warnings).toEqual([])
  })

  it('keeps a form field (누름틀) with its text when the cell is edited', async () => {
    const o = await open()
    const wb = await save(o, {
      1: (b) => {
        let runs = cellRuns(b, 2, 2)
        runs = editRuns(runs, 6, 7, '순') // 이름: 홍길동 → 이름: 홍길순, typed inside the field
        runs = editRuns(runs, 0, 0, '성명 ')
        return patchCells(b, [{ row: 2, tc: 2, paras: [{ runs }] }])
      },
    })
    const cell = o.ext.tables[o.ext.elements['1']].cells[2][2]
    const expected = o.doc.pieces.fieldCell.replace(
      hParaWith('이름: ' + hFieldBookmark(CELL_FIELD, '홍길동').xml),
      hParaWith('성명 이름: ' + hFieldBookmark(CELL_FIELD, '홍길순').xml),
    )
    expectSame(wb.content, o.xml.slice(0, cell.start) + expected + o.xml.slice(cell.end))
  })

  it('a paragraph split inside a cell keeps the field pair with most of its text', async () => {
    const o = await open()
    const wb = await save(o, {
      1: (b) => {
        const runs = cellRuns(b, 2, 2)
        return patchCells(b, [
          {
            row: 2,
            tc: 2,
            paras: [{ runs: editRuns(runs, 5, 7, '') }, { runs: [{ ...runs[0], text: '길동' }] }],
          },
        ])
      },
    })
    const cell = o.ext.tables[o.ext.elements['1']].cells[2][2]
    const field = hFieldBookmark(CELL_FIELD, '')
    const inner = withoutNewStyles(wb).slice(cell.start, cell.start + 400)
    // the pair moved to the second paragraph, which holds two of its three characters
    expect(inner).toContain(
      `${hPara('이름: 홍')}<text:p text:style-name="P1_0"><text:span text:style-name="T1">${field.start}길동${field.end}</text:span></text:p>`,
    )
    expect(wb.rctx.warnings.join('\n')).toMatch(/split by a new paragraph/)
  })

  it('an added paragraph in a cell takes the style of the paragraph it follows', async () => {
    const o = await open()
    const wb = await save(o, {
      1: (b) =>
        patchCells(b, [
          {
            row: 1,
            tc: 1,
            paras: [
              { runs: cellRuns(b, 1, 1) },
              { runs: [{ ...cellRuns(b, 1, 1)[0], text: '둘째' }] },
            ],
          },
        ]),
    })
    const cell = o.ext.tables[o.ext.elements['1']].cells[1][1]
    expectSame(
      wb.content,
      o.xml.slice(0, cell.start) +
        o.doc.pieces.cellA.replace(hPara('a'), hPara('a') + hPara('둘째')) +
        o.xml.slice(cell.end),
    )
  })

  it('a deleted cell paragraph is removed with its bookmarks', async () => {
    const o = await open()
    // the host cell of the nested table: "host" paragraph, the nested table, the empty OOXML tail
    const wb = await save(o, {
      1: (b) => patchCells(b, [{ row: 1, tc: 2, paras: [{ runs: [] }] }]),
    })
    const cell = o.ext.tables[o.ext.elements['1']].cells[1][2]
    expectSame(
      wb.content,
      o.xml.slice(0, cell.start) +
        o.doc.pieces.cellB.replace('<text:span text:style-name="T1">b</text:span>', '') +
        o.xml.slice(cell.end),
    )
  })
})

describe('locked cells (Hancom cell protection)', () => {
  it('an edit of a locked cell is not written and is reported', async () => {
    const o = await open()
    const wb = await save(o, {
      1: (b) =>
        patchCells(b, [
          { row: 1, tc: 0, paras: [{ runs: editRuns(cellRuns(b, 1, 0), 0, 2, '풀림') }] },
          { row: 1, tc: 1, paras: [{ runs: editRuns(cellRuns(b, 1, 1), 0, 1, 'A') }] },
        ]),
    })
    const t1 = o.ext.tables[o.ext.elements['1']]
    expect(range({ ...o, xml: wb.content }, t1.cells[1][0])).toBe(o.doc.pieces.lockedCell)
    expect(wb.content).toContain(o.doc.pieces.cellA.replace('>a<', '>A<'))
    expect(wb.rctx.warnings.join('\n')).toMatch(/locked table cell/)
  })

  it('a formatting change of a locked cell is not written either', async () => {
    const o = await open()
    const wb = await save(o, {
      1: (b) =>
        regenerate(b, (m) => {
          m.rows[1][0].fill = 'FF0000'
        }),
    })
    expectSame(wb.content, o.xml)
    expect(wb.rctx.warnings.join('\n')).toMatch(/locked table cell/)
  })
})

describe('several tables in one save', () => {
  it('two neighbouring tables edited together are each written over their own original', async () => {
    const o = await open()
    const wb = await save(o, {
      1: (b) =>
        regenerate(b, (m) => {
          m.rows[1][1].richParas![0].runs = [{ ...m.rows[1][1].richParas![0].runs[0], text: 'A' }]
        }),
      2: (b) =>
        regenerate(b, (m) => {
          m.rows[0][0].richParas![0].runs = [
            { ...m.rows[0][0].richParas![0].runs[0], text: 'HOST' },
          ]
        }),
    })
    const p = o.doc.pieces
    expectSame(
      wb.content,
      o.xml
        .replace(p.cellA, p.cellA.replace('>a<', '>A<'))
        .replace(p.host, p.host.replace('>host<', '>HOST<')),
    )
  })
})

describe('nested tables and frame paragraphs', () => {
  it('edits a cell of a nested table; the host cell and outer table keep their bytes', async () => {
    const o = await open()
    const wb = await save(o, {
      2: (b) =>
        patchCells(b, [
          {
            row: 0,
            tc: 0,
            nested: [[[[{ runs: [{ ...cellRuns(b, 0, 0)[0], text: 'x2' }] }], null]]],
          },
        ]),
    })
    const nested = o.ext.tables.find((t) => t.host !== null)!
    const x = nested.cells[0][0]
    expect(range(o, x)).toBe(o.doc.pieces.nestedX)
    expectSame(
      wb.content,
      o.xml.slice(0, x.start) + o.doc.pieces.nestedX.replace('>x<', '>x2<') + o.xml.slice(x.end),
    )
  })

  it('a mixed frame paragraph: its text and its table are written into the original wrapper', async () => {
    const o = await open()
    const wb = await save(o, {
      5: () => ({ edit: 5, change: (g: GeneratedBlock) => replaceText(g, 5, 6, '명') }),
      6: (b) =>
        patchCells(b, [
          { row: 0, tc: 0, paras: [{ runs: editRuns(cellRuns(b, 0, 0), 0, 2, '인원') }] },
        ]),
    })
    const t5 = o.ext.tables[o.ext.elements['6']]
    const frame = t5.frame!
    const paragraph = range(o, frame.paragraph)
    expect(paragraph).toBe(o.doc.pieces.mixed)
    const expected = o.doc.pieces.mixed
      .replace('(단위: %)', '(단위: 명)')
      .replace('>단위 표<', '>인원 표<')
    expectSame(
      wb.content,
      o.xml.slice(0, frame.paragraph.start) + expected + o.xml.slice(frame.paragraph.end),
    )
  })

  it('deleting a framed table removes its frame paragraph', async () => {
    const o = await open()
    const { bytes } = await editorSave(o.bridge.docx, (blocks) =>
      blocks.map((_, i) => ({ keep: i })).filter((_, i) => i !== 1),
    )
    const wb = await writeBack(o.bridge, bytes)
    expectSame(wb.content, o.xml.replace(o.doc.pieces.framedParagraph, ''))
  })
})

describe('formatting and new tables', () => {
  it('a cell fill change derives a new cell style; other cells keep theirs', async () => {
    const o = await open()
    const wb = await save(o, {
      1: (b) =>
        regenerate(b, (m) => {
          m.rows[1][1].fill = 'FFFF00'
        }),
    })
    const styles = wb.rctx.newAutomaticStyles('content.xml')
    expect(styles).toHaveLength(1)
    expect(styles[0]).toMatch(
      /^<style:style style:name="Table1\.A1_io1" style:family="table-cell"><style:table-cell-properties [^>]*fo:background-color="#ffff00"/,
    )
    const cell = o.ext.tables[o.ext.elements['1']].cells[1][1]
    expectSame(
      withoutNewStyles(wb),
      o.xml.slice(0, cell.start) +
        o.doc.pieces.cellA.replace(
          'table:style-name="Table1.A1"',
          'table:style-name="Table1.A1_io1"',
        ) +
        o.xml.slice(cell.end),
    )
  })

  it('a table created in the editor becomes an ODF table with new styles', async () => {
    const o = await open()
    const tbl = generateTableXml(2, 2)
    const filled = patchTableCellTexts(tbl.slice(0, tbl.lastIndexOf('<w:p/>')), [
      [['가'], ['나']],
      [['다'], ['라']],
    ])
    const { bytes } = await editorSave(o.bridge.docx, (blocks) => [
      { keep: 0 },
      { xml: filled },
      ...blocks.slice(1).map((_, i) => ({ keep: i + 1 })),
    ])
    const wb = await writeBack(o.bridge, bytes)
    expect(wb.content.startsWith(o.xml.slice(0, o.xml.indexOf(o.doc.pieces.framedParagraph)))).toBe(
      false,
    )
    const reopened = await odtToBridge(
      await buildOdt({
        ...o.doc.options,
        overrideParts: { 'content.xml': wb.content, 'styles.xml': wb.styles },
      }),
      tableRegistry(),
    )
    const parsed = await parseDocx(reopened.docx)
    const t = parsed.blocks.filter((b) => !b.hidden)[1]
    expect(t.type).toBe('table')
    expect(tableTexts(t)).toEqual([
      ['가', '나'],
      ['다', '라'],
    ])
    expect(t.table?.rows[0][0].borders?.top?.style).toBe('single')
    // everything else is untouched
    expect(withoutNewStyles(wb)).toContain(
      o.doc.body.slice(o.doc.body.indexOf(o.doc.pieces.framedParagraph)),
    )
  })
})
