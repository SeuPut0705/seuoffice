/**
 * Hancom-like table documents for the table layer's tests. Every piece is
 * kept as the exact string written, so tests can check byte preservation.
 */
import type { BuildOdtOptions } from './build-odt'
import {
  COVERED_CELL,
  hCell,
  hFieldBookmark,
  hFramedTable,
  hPara,
  hParaWith,
  hRow,
  hTable,
  hTableAutoStyles,
} from './hancom-fragments'

export const CELL_FIELD = 'NormalField7¡성명¡¡F¡T'

export interface TableDoc {
  options: BuildOdtOptions
  body: string
  pieces: Record<string, string>
}

/**
 * The three placements and the usual Hancom features:
 * 1. an as-char framed table (Table1, 3 columns): a 3-wide merged first row,
 *    a locked 2-row merged cell, a cell with a form field;
 * 2. a body-level table (Table2) whose cell holds a nested table (Table3);
 * 3. a paragraph-anchored framed table (Table4, 2 columns) under a header row;
 * 4. a framed table in a paragraph that also has text (Table5).
 */
export function tablesDoc(): TableDoc {
  const mergedCell = hCell(hPara('보도일시', { style: 'P2_0' }), { colSpan: 3 })
  const lockedCell = hCell(hPara('잠금'), { protected: true, rowSpan: 2 })
  const fieldCell = hCell(hParaWith('이름: ' + hFieldBookmark(CELL_FIELD, '홍길동').xml))
  const cellA = hCell(hPara('a'))
  const cellB = hCell(hPara('b'))
  const cellC = hCell(hPara('c'))
  const row0 = hRow([mergedCell, COVERED_CELL, COVERED_CELL])
  const row1 = hRow([lockedCell, cellA, cellB])
  const row2 = hRow([COVERED_CELL, cellC, fieldCell])
  const table1 = hTable('Table1', 3, [row0, row1, row2])
  const framed = hFramedTable(table1, { style: 'P73_0', span: 'T33' })

  const nestedX = hCell(hPara('x'), { style: 'Table3.A1' })
  const nestedY = hCell(hPara('y'), { style: 'Table3.A1' })
  const nested = hTable('Table3', 2, [hRow([nestedX, nestedY], 'Table3.1')])
  const host = hCell(hPara('host') + nested, { style: 'Table2.A1' })
  const bodyTable = hTable('Table2', 1, [hRow([host], 'Table2.1')])

  const t4cell = (text: string) => hCell(hPara(text), { style: 'Table4.A1' })
  const table4 =
    '<table:table table:style-name="Table4"><table:table-column table:style-name="Table4.A"/><table:table-column table:style-name="Table4.B"/>' +
    `<table:table-header-rows>${hRow([t4cell('머리 1'), t4cell('머리 2')], 'Table4.1')}</table:table-header-rows>` +
    hRow([t4cell('값 1'), t4cell('값 2')], 'Table4.1') +
    '</table:table>'
  const paraFramed = hFramedTable(table4, {
    anchor: 'paragraph',
    frameStyle: 'tableinfakeframe_gr2',
    z: 2,
  })

  const table5 = hTable('Table5', 1, [
    hRow([hCell(hPara('단위 표'), { style: 'Table5.A1' })], 'Table5.1'),
  ])
  const mixedFrame = hFramedTable(table5, { frameStyle: 'tableinfakeframe_gr3', z: 3 })
  const mixed = hParaWith(`(단위: %)${mixedFrame.frame}`, { style: 'P1_0', span: 'T1' })

  const body =
    hPara('앞') +
    framed.paragraph +
    bodyTable +
    hPara('중간') +
    paraFramed.paragraph +
    mixed +
    hPara('뒤')
  return {
    body,
    options: {
      body,
      extraContentAutomaticStyles:
        hTableAutoStyles('Table4', 2) +
        hTableAutoStyles('Table5', 1) +
        frameStyle('tableinfakeframe_gr2', '4.000cm') +
        frameStyle('tableinfakeframe_gr3', '1.000cm'),
    },
    pieces: {
      framedParagraph: framed.paragraph,
      frame: framed.frame,
      table1,
      row0,
      row1,
      row2,
      mergedCell,
      lockedCell,
      fieldCell,
      cellA,
      cellB,
      cellC,
      bodyTable,
      host,
      nested,
      nestedX,
      nestedY,
      table4,
      paraFramedParagraph: paraFramed.paragraph,
      mixed,
      mixedFrame: mixedFrame.frame,
      table5,
    },
  }
}

/** A table-holding frame's graphic style with the given minimum height. */
export function frameStyle(name: string, minHeight: string): string {
  return `<style:style style:name="${name}" style:parent-style-name="Frame" style:family="graphic"><style:graphic-properties fo:min-width="6.906cm" fo:min-height="${minHeight}" style:horizontal-pos="from-left" style:horizontal-rel="paragraph" style:vertical-pos="top" style:vertical-rel="paragraph" fo:border="none" fo:padding="0cm" style:wrap="none" style:run-through="foreground" draw:fill="none"/></style:style>`
}

/** A plain framed grid (`rows` × `cols`, cell texts `r<row>c<col>`) for structural edits. */
export function gridDoc(rows: number, cols: number): TableDoc {
  const name = 'Table6'
  const cells = (r: number) =>
    Array.from({ length: cols }, (_, c) => hCell(hPara(`r${r}c${c}`), { style: `${name}.A1` }))
  const table = hTable(
    name,
    cols,
    Array.from({ length: rows }, (_, r) => hRow(cells(r), `${name}.1`)),
  )
  const framed = hFramedTable(table, { frameStyle: 'tableinfakeframe_gr6' })
  // the frame's minimum size is the table's: rows × 24.34pt, cols × 2.302cm
  const height = `${((rows * 24.34 * 2.54) / 72).toFixed(3)}cm`
  const body = hPara('앞') + framed.paragraph + hPara('뒤')
  return {
    body,
    options: {
      body,
      extraContentAutomaticStyles:
        hTableAutoStyles(name, cols) +
        frameStyle('tableinfakeframe_gr6', height).replace(
          '6.906cm',
          `${(cols * 2.302).toFixed(3)}cm`,
        ),
    },
    pieces: { table, framedParagraph: framed.paragraph, frame: framed.frame },
  }
}
