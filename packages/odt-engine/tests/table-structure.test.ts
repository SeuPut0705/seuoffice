/**
 * Structural edits ("표 모양 바꾸기"): rows and columns added and deleted,
 * cells merged and split. The table is rebuilt from its original pieces:
 * untouched cells and rows keep their bytes, new rows/columns copy their
 * neighbours' styles, the frame wrapper stays and its size follows the table,
 * and locked cells keep the table as it was.
 */
import { type Block, type TableCell, type TableModel, parseDocx } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { type TableExt, mapSequence } from '../src/table'
import { editorSave, odtToBridge, writeBack } from './helpers/bridge'
import { buildOdt } from './helpers/build-odt'
import { COVERED_CELL, hCell, hPara, hRow } from './helpers/hancom-fragments'
import { firstDiff, regenerate, tableRegistry, tableTexts } from './helpers/table-editor'
import { type TableDoc, gridDoc, tablesDoc } from './helpers/table-fixtures'

async function open(doc: TableDoc) {
  const bridge = await odtToBridge(await buildOdt(doc.options), tableRegistry())
  const parsed = await parseDocx(bridge.docx)
  const visible = parsed.blocks.filter((b) => !b.hidden)
  const ext = bridge.map.ext.table as unknown as TableExt
  return { bridge, visible, doc, ext, xml: bridge.doc.contentXml }
}
type Opened = Awaited<ReturnType<typeof open>>

async function restructure(o: Opened, index: number, change: (m: TableModel) => void) {
  const { bytes } = await editorSave(o.bridge.docx, (blocks) =>
    blocks.map((b: Block, i) => (i === index ? regenerate(b, change) : { keep: i })),
  )
  const wb = await writeBack(o.bridge, bytes)
  let stripped = wb.content
  for (const x of wb.rctx.newAutomaticStyles('content.xml')) stripped = stripped.replace(x, '')
  return { wb, stripped, styles: wb.rctx.newAutomaticStyles('content.xml') }
}

const expectSame = (actual: string, expected: string) =>
  expect(firstDiff(actual, expected)).toBeNull()

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

/** A copy of `cell` holding one paragraph `text` in the cell's first-run formatting. */
function withText(cell: TableCell, text: string): TableCell {
  const c = clone(cell)
  const p = c.richParas?.[0] ?? { runs: [] }
  const run = p.runs[0] ?? { text: '' }
  c.richParas = [{ ...p, runs: text ? [{ ...run, text }] : [] }]
  c.paras = [text]
  delete c.vMerge
  delete c.colSpan
  return c
}

const ROW_ARRAYS = ['rowHeightsTwips', 'rowHeightRules', 'repeatHeaderRows', 'rawTrPrs'] as const

function insertRow(m: TableModel, at: number, texts: string[]) {
  const like = m.rows[Math.max(0, at - 1)]
  m.rows.splice(
    at,
    0,
    like.map((cell, i) => withText(cell, texts[i] ?? '')),
  )
  for (const key of ROW_ARRAYS) {
    const arr = m[key] as unknown[] | undefined
    if (arr) arr.splice(at, 0, key === 'repeatHeaderRows' ? false : arr[Math.max(0, at - 1)])
  }
}

function deleteRow(m: TableModel, at: number) {
  m.rows.splice(at, 1)
  for (const key of ROW_ARRAYS) (m[key] as unknown[] | undefined)?.splice(at, 1)
}

function insertColumn(m: TableModel, at: number, texts: string[]) {
  m.rows.forEach((row, r) => row.splice(at, 0, withText(row[Math.max(0, at - 1)], texts[r] ?? '')))
  m.colWidthsTwips?.splice(at, 0, m.colWidthsTwips[Math.max(0, at - 1)])
  m.colWidthsPct?.splice(at, 0, m.colWidthsPct[Math.max(0, at - 1)])
}

function deleteColumn(m: TableModel, at: number) {
  for (const row of m.rows) row.splice(at, 1)
  m.colWidthsTwips?.splice(at, 1)
  m.colWidthsPct?.splice(at, 1)
}

const cell6 = (text: string) => hCell(hPara(text), { style: 'Table6.A1' })
const row6 = (...texts: string[]) => hRow(texts.map(cell6), 'Table6.1')
const frameStyleOf = (styles: readonly string[]) =>
  styles.find((s) => s.includes('style:family="graphic"'))

describe('rows', () => {
  it('an added row copies its neighbour row and the frame grows by its height', async () => {
    const o = await open(gridDoc(3, 2))
    const { wb, stripped, styles } = await restructure(o, 1, (m) => insertRow(m, 2, ['n0', 'n1']))
    const table =
      '<table:table table:style-name="Table6"><table:table-column table:style-name="Table6.A"/><table:table-column table:style-name="Table6.B"/>' +
      row6('r0c0', 'r0c1') +
      row6('r1c0', 'r1c1') +
      row6('n0', 'n1') +
      row6('r2c0', 'r2c1') +
      '</table:table>'
    const frame = o.doc.pieces.framedParagraph
      .replace(o.doc.pieces.table, table)
      .replace(
        'draw:style-name="tableinfakeframe_gr6"',
        'draw:style-name="tableinfakeframe_gr6_io1"',
      )
    expectSame(stripped, o.xml.replace(o.doc.pieces.framedParagraph, frame))
    // rows are 24.34pt (0.859cm): 2.576cm → 3.435cm
    expect(frameStyleOf(styles)).toContain('fo:min-height="3.435cm"')
    expect(styles).toHaveLength(1)
    expect(wb.rctx.warnings).toEqual([])
  })

  it('a deleted row is dropped and the frame shrinks', async () => {
    const o = await open(gridDoc(3, 2))
    const { stripped, styles } = await restructure(o, 1, (m) => deleteRow(m, 1))
    const table =
      '<table:table table:style-name="Table6"><table:table-column table:style-name="Table6.A"/><table:table-column table:style-name="Table6.B"/>' +
      row6('r0c0', 'r0c1') +
      row6('r2c0', 'r2c1') +
      '</table:table>'
    expect(stripped).toContain(table)
    expect(frameStyleOf(styles)).toContain('fo:min-height="1.717cm"')
  })

  it('header rows stay in the header group when a body row is added', async () => {
    const o = await open(tablesDoc())
    const { stripped } = await restructure(o, 4, (m) => insertRow(m, 2, ['값 3', '값 4']))
    const cell4 = (t: string) => hCell(hPara(t), { style: 'Table4.A1' })
    expect(stripped).toContain(
      `<table:table-header-rows>${hRow([cell4('머리 1'), cell4('머리 2')], 'Table4.1')}</table:table-header-rows>` +
        hRow([cell4('값 1'), cell4('값 2')], 'Table4.1') +
        hRow([cell4('값 3'), cell4('값 4')], 'Table4.1') +
        '</table:table>',
    )
  })
})

describe('columns', () => {
  it('an added column copies its neighbour column; table and frame widths grow', async () => {
    const o = await open(gridDoc(2, 2))
    const { stripped, styles } = await restructure(o, 1, (m) => insertColumn(m, 1, ['x0', 'x1']))
    expect(stripped).toContain(
      '<table:table table:style-name="Table6_io1"><table:table-column table:style-name="Table6.A"/><table:table-column table:style-name="Table6.A"/><table:table-column table:style-name="Table6.B"/>' +
        hRow([cell6('r0c0'), cell6('x0'), cell6('r0c1')], 'Table6.1') +
        hRow([cell6('r1c0'), cell6('x1'), cell6('r1c1')], 'Table6.1') +
        '</table:table>',
    )
    // 16.697cm + 2.302cm; the frame: 4.604cm + 2.302cm
    expect(styles.find((s) => s.includes('style:family="table"'))).toContain(
      'style:width="18.999cm"',
    )
    expect(frameStyleOf(styles)).toContain('fo:min-width="6.906cm"')
  })

  it('a deleted column takes its cells with it', async () => {
    const o = await open(gridDoc(2, 3))
    const { stripped, styles } = await restructure(o, 1, (m) => deleteColumn(m, 1))
    expect(stripped).toContain(
      '<table:table-column table:style-name="Table6.A"/><table:table-column table:style-name="Table6.C"/>' +
        hRow([cell6('r0c0'), cell6('r0c2')], 'Table6.1') +
        hRow([cell6('r1c0'), cell6('r1c2')], 'Table6.1') +
        '</table:table>',
    )
    expect(frameStyleOf(styles)).toContain('fo:min-width="4.604cm"')
  })
})

describe('blank rows and columns inserted together', () => {
  for (const row of [0, 1, 3]) {
    for (const col of [0, 1, 3]) {
      for (const locked of [false, true]) {
        it(`keeps the grid with a new row ${row}, column ${col}, locked=${locked}`, async () => {
          const doc = gridDoc(3, 3)
          if (locked) {
            const cell = hCell(hPara('r0c0'), { style: 'Table6.A1' })
            doc.options.body = doc.body.replace(
              cell,
              cell.replace('<table:table-cell ', '<table:table-cell table:protected="true" '),
            )
          }
          const o = await open(doc)
          const { wb } = await restructure(o, 1, (model) => {
            insertRow(model, row, ['', '', ''])
            insertColumn(model, col, ['', '', '', ''])
          })
          const zip = await JSZip.loadAsync(await buildOdt(doc.options))
          zip.file('content.xml', wb.content)
          zip.file('styles.xml', wb.styles)
          const reopened = await odtToBridge(
            await zip.generateAsync({ type: 'uint8array' }),
            tableRegistry(),
          )
          const parsed = await parseDocx(reopened.docx)
          const table = parsed.blocks.find((block) => block.table)!
          const expected = Array.from({ length: 3 }, (_, r) =>
            Array.from({ length: 3 }, (_, c) => `r${r}c${c}`),
          )
          expected.splice(row, 0, ['', '', ''])
          expected.forEach((cells) => cells.splice(col, 0, ''))
          expect(tableTexts(table)).toEqual(expected)
          if (locked) {
            const ext = reopened.map.ext.table as unknown as TableExt
            expect(ext.protectedCells).toEqual([
              expect.objectContaining({ row: row === 0 ? 1 : 0, col: col === 0 ? 1 : 0 }),
            ])
          }
        })
      }
    }
  }
})

describe('merging and splitting', () => {
  it('merged cells: the left cell spans, the right one is covered, both texts stay', async () => {
    const o = await open(tablesDoc())
    const { stripped, wb } = await restructure(o, 1, (m) => {
      const [, a, b] = m.rows[1]
      a.colSpan = 2
      a.richParas = [...(a.richParas ?? []), ...(b.richParas ?? [])]
      a.paras = [...a.paras, ...b.paras]
      m.rows[1].splice(2, 1)
    })
    const p = o.doc.pieces
    const merged = p.cellA
      .replace(
        'office:value-type="string">',
        'office:value-type="string" table:number-columns-spanned="2">',
      )
      .replace(hPara('a'), hPara('a') + hPara('b'))
    const table = p.table1.replace(p.row1, hRow([p.lockedCell, merged, COVERED_CELL]))
    expectSame(stripped, o.xml.replace(p.table1, table))
    expect(wb.rctx.newAutomaticStyles('content.xml')).toEqual([])
  })

  it('a split cell: the first part keeps the cell, the new ones copy its style', async () => {
    const o = await open(tablesDoc())
    const { stripped } = await restructure(o, 1, (m) => {
      const first = m.rows[0][0]
      first.colSpan = 1
      m.rows[0].push(withText(first, ''), withText(first, ''))
    })
    const p = o.doc.pieces
    const kept = p.mergedCell.replace(' table:number-columns-spanned="3"', '')
    const start = stripped.indexOf(kept)
    expect(start).toBeGreaterThan(0)
    const after = stripped.slice(start + kept.length, stripped.indexOf('</table:table-row>', start))
    expect(after).toMatch(
      /^<table:table-cell table:style-name="Table1\.A1" office:value-type="string"><text:p text:style-name="P2_0">.*<\/text:p><\/table:table-cell><table:table-cell table:style-name="Table1\.A1" office:value-type="string"><text:p text:style-name="P2_0">.*<\/text:p><\/table:table-cell>$/,
    )
    // the other rows are untouched
    expect(stripped).toContain(p.row1 + p.row2)
  })
})

describe('locked cells in structural edits', () => {
  it('a structure change that touches a locked cell leaves the table as it was', async () => {
    const o = await open(tablesDoc())
    const { wb } = await restructure(o, 1, (m) => {
      deleteRow(m, 2)
      delete m.rows[1][0].vMerge
    })
    expect(wb.content).toBe(o.xml)
    expect(wb.rctx.warnings.join('\n')).toMatch(/locked cells/)
  })

  it('a structure change elsewhere keeps the locked cell byte for byte', async () => {
    const o = await open(tablesDoc())
    const { stripped } = await restructure(o, 1, (m) => insertRow(m, 3, ['', '끝 1', '끝 2']))
    expect(stripped).toContain(o.doc.pieces.row0 + o.doc.pieces.row1 + o.doc.pieces.row2)
    const parsed = await parseDocx(
      (
        await odtToBridge(
          await buildOdt({
            ...o.doc.options,
            overrideParts: {
              'content.xml': (await restructure(o, 1, (m) => insertRow(m, 3, ['', '끝 1', '끝 2'])))
                .wb.content,
            },
          }),
          tableRegistry(),
        )
      ).docx,
    )
    const t = parsed.blocks.filter((b) => !b.hidden)[1]
    expect(tableTexts(t)[3]).toEqual(['', '끝 1', '끝 2'])
  })
})

describe('row and column matching', () => {
  it('maps equal rows in order and pairs the rest positionally', () => {
    expect(mapSequence(['a', 'b', 'c'], ['a', 'x', 'b', 'c'])).toEqual([0, -1, 1, 2])
    expect(mapSequence(['a', 'b', 'c'], ['a', 'c'])).toEqual([0, 2])
    expect(mapSequence(['a', 'b', 'c'], ['a', "b'", 'x', 'c'])).toEqual([0, 1, -1, 2])
  })
})
