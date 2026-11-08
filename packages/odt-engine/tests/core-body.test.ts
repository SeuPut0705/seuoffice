import { beforeAll, describe, expect, it } from 'vitest'
import {
  type OdtBody,
  type OdtNode,
  anchorType,
  bookmarkName,
  cellSpan,
  nodesOfKind,
  openOdt,
  pairAnnotations,
  pairBookmarks,
  scanOdtBody,
  sliceNode,
  walkNodes,
} from '../src/core'
import { buildContentXml, buildOdt } from './helpers/build-odt'
import { COVERED_CELL, hPara } from './helpers/hancom-fragments'
import {
  FIELD_NAME,
  FIELD_NAME_ESCAPED,
  type HancomSample,
  UNPAIRED_FIELD,
  hancomSample,
} from './helpers/hancom-sample'

let sample: HancomSample
let body: OdtBody

beforeAll(async () => {
  sample = hancomSample()
  const doc = await openOdt(await buildOdt(sample.options))
  body = doc.body
})

const slice = (node: OdtNode) => sliceNode(body, node)

/** Every recorded node, depth first. */
function allNodes(b: OdtBody): OdtNode[] {
  const out: OdtNode[] = []
  walkNodes(b.blocks, (n) => {
    out.push(n)
  })
  return out
}

describe('scanOdtBody: top-level blocks', () => {
  it('records every top-level child of office:text, in order, sliced exactly', () => {
    expect(body.blocks.map(slice)).toEqual(sample.blocks)
  })

  it('classifies top-level blocks, keeping unknown elements and comments', () => {
    expect(body.blocks.map((b) => [b.kind, b.name])).toEqual([
      ['other', 'text:sequence-decls'],
      ['paragraph', 'text:p'],
      ['paragraph', 'text:p'],
      ['table', 'table:table'],
      ['paragraph', 'text:p'],
      ['paragraph', 'text:p'],
      ['paragraph', 'text:p'],
      ['paragraph', 'text:p'],
      ['list', 'text:list'],
      ['section', 'text:section'],
      ['index', 'text:table-of-content'],
      ['paragraph', 'text:p'],
      ['opaque', '#comment'],
      ['paragraph', 'text:p'],
      ['paragraph', 'text:p'],
      ['paragraph', 'text:p'],
    ])
  })

  it('handles a self-closing top-level paragraph', () => {
    const empty = body.blocks[11]
    expect(empty.selfClosing).toBe(true)
    expect(slice(empty)).toBe(sample.pieces.emptyParagraph)
    expect(empty.openEnd).toBe(empty.end)
    expect(empty.closeStart).toBe(empty.end)
  })

  it('locates office:text itself, with open and close tags', () => {
    const xml = body.xml
    expect(xml.slice(body.text.start, body.text.openEnd)).toBe('<office:text>')
    expect(xml.slice(body.text.closeStart, body.text.end)).toBe('</office:text>')
    expect(xml.slice(body.text.openEnd, body.text.closeStart)).toBe(sample.blocks.join(''))
  })

  it('exposes decoded attributes with canonical names', () => {
    const p = body.blocks[1]
    expect(p.attr('text:style-name')).toBe('P73_0_MS1_b3')
    expect(p.attrs).toEqual({ 'text:style-name': 'P73_0_MS1_b3' })
  })
})

describe('scanOdtBody: nested ranges', () => {
  it('finds a table inside an as-char frame text box', () => {
    const { framedTable } = sample.pieces
    const para = body.blocks[1]
    const [frame] = para.children
    expect(frame.kind).toBe('frame')
    expect(anchorType(frame)).toBe('as-char')
    expect(slice(frame)).toBe(framedTable.frame)
    const [textBox] = frame.children
    expect(textBox.kind).toBe('text-box')
    expect(slice(textBox)).toBe(framedTable.textBox)
    const [table] = textBox.children
    expect(table.kind).toBe('table')
    expect(slice(table)).toBe(framedTable.table)
    expect(table.parent).toBe(textBox)
  })

  it('records rows, cells, merged spans and covered cells', () => {
    const table = body.blocks[1].children[0].children[0].children[0]
    const columns = table.children.filter((c) => c.kind === 'table-column')
    expect(columns).toHaveLength(3)
    const rows = table.children.filter((c) => c.kind === 'table-row')
    expect(rows).toHaveLength(3)
    expect(slice(rows[0])).toBe(sample.pieces.framedMergedRow)
    const [merged, covered1, covered2] = rows[0].children
    expect(slice(merged)).toBe(sample.pieces.framedMergedCell)
    expect(cellSpan(merged)).toEqual({ columns: 3, rows: 1 })
    for (const covered of [covered1, covered2]) {
      expect(covered.kind).toBe('covered-cell')
      expect(covered.selfClosing).toBe(true)
      expect(slice(covered)).toBe(COVERED_CELL)
    }
    const protectedCell = rows[1].children[0]
    expect(slice(protectedCell)).toBe(sample.pieces.protectedCell)
    expect(protectedCell.attr('table:protected')).toBe('true')
    expect(cellSpan(protectedCell)).toEqual({ columns: 1, rows: 2 })
    expect(rows[2].children[0].kind).toBe('covered-cell')
    // paragraphs inside cells are nodes too
    expect(merged.children.map((c) => c.kind)).toEqual(['paragraph'])
  })

  it('finds a table nested inside a body-level table cell', () => {
    const bodyTable = body.blocks[3]
    expect(slice(bodyTable)).toBe(sample.pieces.bodyTable)
    const hostCell = bodyTable.children.find((c) => c.kind === 'table-row')!.children[0]
    expect(slice(hostCell)).toBe(sample.pieces.nestedHostCell)
    const nested = hostCell.children.find((c) => c.kind === 'table')!
    expect(slice(nested)).toBe(sample.pieces.nestedTable)
    expect(nodesOfKind(body.blocks, 'table')).toHaveLength(4)
  })

  it('finds a paragraph-anchored framed table', () => {
    const frame = body.blocks[4].children[0]
    expect(anchorType(frame)).toBe('paragraph')
    expect(slice(frame.children[0].children[0])).toBe(sample.pieces.paragraphFramedTable.table)
  })

  it('records images, notes, annotations, embedded objects and shapes', () => {
    const imgPara = body.blocks[5]
    const [imageFrame, note] = imgPara.children
    expect(slice(imageFrame)).toBe(sample.pieces.image.frame)
    expect(imageFrame.children[0].kind).toBe('image')
    expect(slice(imageFrame.children[0])).toBe(sample.pieces.image.image)
    expect(imageFrame.children[0].attr('xlink:href')).toBe('Pictures/EMB0000a7a0be95.png')
    expect(note.kind).toBe('note')
    expect(slice(note)).toBe(sample.pieces.footnote)
    expect(note.children.map((c) => c.kind)).toEqual(['paragraph'])

    const [annotation, annotationEnd] = body.blocks[6].children
    expect(annotation.kind).toBe('annotation')
    expect(slice(annotation)).toBe(sample.pieces.annotation.annotation)
    expect(annotationEnd.kind).toBe('annotation-end')
    expect(slice(annotationEnd)).toBe(sample.pieces.annotation.end)

    const [formulaFrame, customShape, rect] = body.blocks[7].children
    expect(slice(formulaFrame)).toBe(sample.pieces.formula.frame)
    expect(formulaFrame.children[0].kind).toBe('object')
    expect(slice(formulaFrame.children[0])).toBe(sample.pieces.formula.object)
    expect(customShape.kind).toBe('shape')
    expect(slice(customShape)).toBe(sample.pieces.customShape.shape)
    // the shape's text is a node; its geometry (draw:equation formulas) is not
    expect(customShape.children.map((c) => c.name)).toEqual(['text:p'])
    expect(rect.kind).toBe('shape')
    expect(slice(rect)).toBe(sample.pieces.rect)
    expect(rect.children[0].selfClosing).toBe(true)
  })

  it('records list items, section and index content', () => {
    const list = body.blocks[8]
    expect(slice(list)).toBe(sample.pieces.list)
    expect(list.children.map((c) => c.kind)).toEqual(['list-item', 'list-item'])
    expect(list.children[0].children[0].kind).toBe('paragraph')
    expect(slice(body.blocks[9])).toBe(sample.pieces.section)
    expect(body.blocks[9].children[0].kind).toBe('paragraph')
    expect(slice(body.blocks[10])).toBe(sample.pieces.toc)
    expect(body.blocks[10].children.map((c) => c.kind)).toEqual(['paragraph'])
  })

  it('slices every recorded node to a complete element of the same name', () => {
    const nodes = allNodes(body)
    expect(nodes.length).toBeGreaterThan(60)
    for (const node of nodes) {
      const text = slice(node)
      if (node.kind === 'opaque') continue
      expect(text.startsWith(`<${node.tag}`)).toBe(true)
      expect(text.endsWith(node.selfClosing ? '/>' : `</${node.tag}>`)).toBe(true)
      expect(body.xml.slice(node.start, node.openEnd).endsWith('>')).toBe(true)
      if (node.parent) {
        expect(node.start).toBeGreaterThanOrEqual(node.parent.openEnd)
        expect(node.end).toBeLessThanOrEqual(node.parent.closeStart)
      }
    }
  })
})

describe('bookmarks and annotations', () => {
  it('pairs NormalField bookmarks and keeps names verbatim', () => {
    const pairs = pairBookmarks(body)
    const field = pairs.find((p) => p.name === FIELD_NAME)!
    expect(field.start && slice(field.start)).toBe(sample.pieces.field.start)
    expect(field.end && slice(field.end)).toBe(sample.pieces.field.end)
    expect(body.xml.slice(field.start!.end, field.end!.start)).toBe('안건 <text:s/>내용')

    const escaped = pairs.find((p) => p.name === FIELD_NAME_ESCAPED)!
    expect(escaped.end).not.toBeNull()
    expect(bookmarkName(escaped.start!)).toBe(FIELD_NAME_ESCAPED)
    expect(slice(escaped.start!)).toBe(sample.pieces.escapedField.start)

    const unpaired = pairs.find((p) => p.name === UNPAIRED_FIELD)!
    expect(unpaired.end).toBeNull()
    expect(slice(unpaired.start!)).toBe(sample.pieces.unpairedStart)

    const single = pairs.find((p) => p.name === '_Toc1')!
    expect(single.point && slice(single.point)).toBe(sample.pieces.singleBookmark)
  })

  it('pairs annotations with their end markers', () => {
    const [pair] = pairAnnotations(body)
    expect(pair.name).toBe('memo1')
    expect(slice(pair.annotation)).toBe(sample.pieces.annotation.annotation)
    expect(pair.end && slice(pair.end)).toBe(sample.pieces.annotation.end)
  })
})

describe('scanOdtBody: leniency', () => {
  it('maps non-standard namespace prefixes to canonical names', () => {
    const xml =
      '<?xml version="1.0"?><o:document-content xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:t="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:tb="urn:oasis:names:tc:opendocument:xmlns:table:1.0">' +
      '<o:body><o:text><t:p t:style-name="P1">a</t:p><tb:table><tb:table-row><tb:table-cell tb:number-columns-spanned="2"><t:p/></tb:table-cell><tb:covered-table-cell/></tb:table-row></tb:table></o:text></o:body></o:document-content>'
    const b = scanOdtBody(xml)
    expect(b.blocks.map((n) => [n.kind, n.name, n.tag])).toEqual([
      ['paragraph', 'text:p', 't:p'],
      ['table', 'table:table', 'tb:table'],
    ])
    expect(b.blocks[0].attr('text:style-name')).toBe('P1')
    const cell = b.blocks[1].children[0].children[0]
    expect(cellSpan(cell)).toEqual({ columns: 2, rows: 1 })
  })

  it('survives unclosed and stray tags without throwing and still ranges the rest', () => {
    const inner = `<text:p text:style-name="P1"><text:span>unclosed</text:p></text:span>${hPara('next')}`
    const xml = buildContentXml({ body: inner })
    const b = scanOdtBody(xml)
    expect(b.blocks).toHaveLength(2)
    expect(sliceNode(b, b.blocks[1])).toBe(hPara('next'))
    expect(b.warnings.length).toBeGreaterThan(0)
  })

  it('handles `>` inside attribute values and an empty office:text', () => {
    const p = '<text:p text:style-name="a>b">x</text:p>'
    const b = scanOdtBody(buildContentXml({ body: p }))
    expect(sliceNode(b, b.blocks[0])).toBe(p)
    expect(b.blocks[0].attr('text:style-name')).toBe('a>b')

    const empty = buildContentXml({ body: '' }).replace(
      '<office:text></office:text>',
      '<office:text/>',
    )
    const e = scanOdtBody(empty)
    expect(e.blocks).toEqual([])
    expect(e.text.openEnd).toBe(e.text.end)
  })

  it('throws a typed corrupt error when there is no office:text', () => {
    expect(() =>
      scanOdtBody('<office:document-content><office:body/></office:document-content>'),
    ).toThrowError(/office:text/)
  })
})
