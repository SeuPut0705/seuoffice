/**
 * A Hancom-like document that exercises every structure the core layer must
 * locate, with each piece kept as the exact string written so tests can check
 * that recorded ranges slice back to it.
 */
import type { BuildOdtOptions } from './build-odt'
import {
  COVERED_CELL,
  FORMULA_CONTENT_XML,
  hAnnotation,
  hCell,
  hCustomShape,
  hFieldBookmark,
  hFootnote,
  hFormulaObject,
  hFramedTable,
  hImageFrame,
  hPara,
  hParaWith,
  hRect,
  hRow,
  hTable,
} from './hancom-fragments'

/** A tiny valid PNG (1x1). */
export const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

export const FIELD_NAME = 'NormalField1¡안건명¡안건명¡F¡T'
/** A field name with characters that must be escaped in XML. */
export const FIELD_NAME_ESCAPED = 'NormalField2¡<성명> & "직위"¡¡F¡T'
export const UNPAIRED_FIELD = 'NormalField3¡unfinished¡¡F¡T'

export interface HancomSample {
  options: BuildOdtOptions
  /** top-level children of office:text, in order */
  blocks: string[]
  pieces: {
    framedTable: ReturnType<typeof hFramedTable>
    framedMergedRow: string
    framedMergedCell: string
    protectedCell: string
    bodyTable: string
    nestedTable: string
    nestedHostCell: string
    paragraphFramedTable: ReturnType<typeof hFramedTable>
    field: ReturnType<typeof hFieldBookmark>
    escapedField: ReturnType<typeof hFieldBookmark>
    unpairedStart: string
    singleBookmark: string
    image: ReturnType<typeof hImageFrame>
    footnote: string
    annotation: ReturnType<typeof hAnnotation>
    formula: ReturnType<typeof hFormulaObject>
    customShape: ReturnType<typeof hCustomShape>
    rect: string
    list: string
    section: string
    toc: string
    emptyParagraph: string
    sequenceDecls: string
    comment: string
    sectionBreakParagraph: string
  }
}

export function hancomSample(): HancomSample {
  // 1. an as-char framed table with merges (row 1: 3-wide merge; row 2: rows-spanned + protected)
  const framedMergedCell = hCell(hPara('보도일시', { style: 'P2_0', span: 'T1' }), {
    style: 'Table1.A1',
    colSpan: 3,
  })
  const framedMergedRow = hRow([framedMergedCell, COVERED_CELL, COVERED_CELL], 'Table1.1')
  const protectedCell = hCell(hPara(''), { style: 'Table1.A1', protected: true, rowSpan: 2 })
  const framedTable = hFramedTable(
    hTable('Table1', 3, [
      framedMergedRow,
      hRow([protectedCell, hCell(hPara('a')), hCell(hPara('b'))]),
      hRow([COVERED_CELL, hCell(hPara('c')), hCell(hPara('d'))]),
    ]),
    { style: 'P73_0_MS1_b3', span: 'T33' },
  )

  // 2. a body-level table whose cell holds a nested table
  const nestedTable = hTable('Table3', 2, [hRow([hCell(hPara('x')), hCell(hPara('y'))])])
  const nestedHostCell = hCell(hPara('host') + nestedTable)
  const bodyTable = hTable('Table2', 1, [hRow([nestedHostCell])])

  // 3. a table framed with paragraph anchoring
  const paragraphFramedTable = hFramedTable(hTable('Table2', 1, [hRow([hCell(hPara('p'))])]), {
    anchor: 'paragraph',
    z: 2,
  })

  // 4. inline objects
  const field = hFieldBookmark(FIELD_NAME, '안건  내용')
  const escapedField = hFieldBookmark(FIELD_NAME_ESCAPED, 'value')
  const unpairedStart = `<text:bookmark-start text:name="${UNPAIRED_FIELD}"/>`
  const singleBookmark = '<text:bookmark text:name="_Toc1"/>'
  const image = hImageFrame('Pictures/EMB0000a7a0be95.png', { anchor: 'paragraph' })
  const footnote = hFootnote('note text')
  const annotation = hAnnotation('memo1', 'memo text', 'anchored')
  const formula = hFormulaObject()
  const customShape = hCustomShape('shape text')
  const rect = hRect()

  const list =
    '<text:list text:style-name="NL2" xml:id="list000010000000002"><text:list-item>' +
    hPara('item one', { style: 'P1_0' }) +
    '</text:list-item><text:list-item>' +
    hPara('item two', { style: 'P1_0' }) +
    '</text:list-item></text:list>'
  const section = `<text:section text:style-name="Sect1" text:name="Section1">${hPara('in section')}</text:section>`
  const toc =
    '<text:table-of-content text:style-name="Sect2" text:protected="true" text:name="Table of Contents1"><text:table-of-content-source text:outline-level="3"/>' +
    `<text:index-body>${hPara('toc entry')}</text:index-body></text:table-of-content>`
  const emptyParagraph = '<text:p text:style-name="P1_0"/>'
  const sequenceDecls =
    '<text:sequence-decls><text:sequence-decl text:display-outline-level="0" text:name="Table"/></text:sequence-decls>'
  const comment = '<!-- kept as an opaque block -->'
  const sectionBreakParagraph = hPara('landscape section', { style: 'P270_172_MS2_b7' })

  const blocks = [
    sequenceDecls,
    framedTable.paragraph,
    hParaWith(field.xml + ' and ' + escapedField.xml + unpairedStart + singleBookmark),
    bodyTable,
    paragraphFramedTable.paragraph,
    hParaWith(image.frame + 'caption' + footnote),
    hParaWith(annotation.xml),
    hParaWith(formula.frame + customShape.shape + rect),
    list,
    section,
    toc,
    emptyParagraph,
    comment,
    sectionBreakParagraph,
    hPara('after  section'),
    hPara('back to portrait', { style: 'P5_0_MS3_b3' }),
  ]

  return {
    options: {
      body: blocks.join(''),
      pictures: { 'EMB0000a7a0be95.png': PNG_1X1 },
      extraEntries: [
        {
          name: 'Object 1/content.xml',
          data: FORMULA_CONTENT_XML,
          mediaType: 'text/xml',
        },
        {
          name: 'Object 1/',
          data: '',
          mediaType: 'application/vnd.oasis.opendocument.formula',
        },
      ],
    },
    blocks,
    pieces: {
      framedTable,
      framedMergedRow,
      framedMergedCell,
      protectedCell,
      bodyTable,
      nestedTable,
      nestedHostCell,
      paragraphFramedTable,
      field,
      escapedField,
      unpairedStart,
      singleBookmark,
      image,
      footnote,
      annotation,
      formula,
      customShape,
      rect,
      list,
      section,
      toc,
      emptyParagraph,
      sequenceDecls,
      comment,
      sectionBreakParagraph,
    },
  }
}
