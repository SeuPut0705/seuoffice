/**
 * Where the bridge map says every ODF element sits in the original
 * content.xml: blocks, paragraphs, inline markers, tables and their cells,
 * pictures, notes, comments and placeholders. A range cut from the original
 * string is the element's exact source.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { type ObjectsExt, OdtOpenError, odtToDocx } from '../src'
import { type Bridge, odtToBridge } from './helpers/bridge'
import type { TableExt } from './helpers/bridge-ext'
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
let bridge: Bridge
let tables: TableExt
let objects: ObjectsExt

beforeAll(async () => {
  sample = hancomSample()
  bridge = await odtToBridge(await buildOdt(sample.options))
  tables = bridge.map.ext.table as unknown as TableExt
  objects = bridge.map.ext.objects as unknown as ObjectsExt
})

const slice = (range: { start: number; end: number }) =>
  bridge.content.slice(range.start, range.end)
const top = () => bridge.map.blocks.filter((b) => b.parent === null)

describe('blocks', () => {
  it('records every top-level child of office:text, in order, sliced exactly', () => {
    expect(top().map(slice)).toEqual(sample.blocks)
  })

  it('classifies top-level blocks, keeping unknown elements and comments', () => {
    expect(top().map((b) => [b.kind, b.name])).toEqual([
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

  it('records a self-closing top-level paragraph', () => {
    expect(slice(top()[11])).toBe(sample.pieces.emptyParagraph)
  })

  it('records lists, sections and indexes with their content', () => {
    expect(slice(top()[8])).toBe(sample.pieces.list)
    expect(slice(top()[9])).toBe(sample.pieces.section)
    expect(slice(top()[10])).toBe(sample.pieces.toc)
    // a section is a container: its paragraph is a child block
    const section = top()[9]
    expect(section.children.map((id) => slice(bridge.map.blocks[id]))).toEqual([
      hPara('in section'),
    ])
  })

  it('slices every block and paragraph to a complete element of the same name', () => {
    expect(bridge.map.blocks.length).toBeGreaterThan(15)
    for (const block of bridge.map.blocks) {
      const text = slice(block)
      if (block.kind === 'opaque') continue
      expect(text.startsWith(`<${block.name}`), block.name).toBe(true)
      expect(text.endsWith('/>') || text.endsWith(`</${block.name}>`), block.name).toBe(true)
    }
    expect(bridge.map.paragraphs.length).toBeGreaterThan(20)
    for (const p of bridge.map.paragraphs) {
      const text = (p.part === 'content.xml' ? bridge.content : (bridge.styles as string)).slice(
        p.start,
        p.end,
      )
      expect(text.startsWith(`<${p.element}`)).toBe(true)
      expect(text.endsWith('/>') || text.endsWith(`</${p.element}>`)).toBe(true)
    }
  })
})

describe('tables', () => {
  const byId = (id: number) => tables.tables[id]

  it('finds a table inside an as-char frame text box', () => {
    const { framedTable } = sample.pieces
    const record = tables.tables.find((t) => slice(t) === framedTable.table)!
    expect(record.host).toBeNull()
    expect(record.frame).not.toBeNull()
    expect(bridge.content.slice(record.frame!.paragraph.start, record.frame!.paragraph.end)).toBe(
      framedTable.paragraph,
    )
    expect(slice(record.frame!.frame)).toBe(framedTable.frame)
    expect(record.frame!.anchor).toBe('as-char')
  })

  it('records rows, cells, merged spans and covered cells', () => {
    const table = tables.tables.find((t) => slice(t) === sample.pieces.framedTable.table)!
    expect(table.columns).toHaveLength(3)
    expect(table.rows).toHaveLength(3)
    expect(slice(table.rows[0])).toBe(sample.pieces.framedMergedRow)
    const [merged, covered1, covered2] = table.cells[0]
    if (merged.kind !== 'cell') throw new Error('expected a cell')
    expect(slice(merged)).toBe(sample.pieces.framedMergedCell)
    expect([merged.colSpan, merged.rowSpan ?? 1]).toEqual([3, 1])
    for (const covered of [covered1, covered2]) {
      expect(covered.kind).toBe('covered')
      expect(slice(covered)).toBe(COVERED_CELL)
    }
    const protectedCell = table.cells[1][0]
    if (protectedCell.kind !== 'cell') throw new Error('expected a cell')
    expect(slice(protectedCell)).toBe(sample.pieces.protectedCell)
    expect(protectedCell.protected).toBe(true)
    expect([protectedCell.colSpan ?? 1, protectedCell.rowSpan]).toEqual([1, 2])
    expect(table.cells[2][0].kind).toBe('covered')
    // paragraphs inside cells are recorded too
    expect(merged.units.map((u) => u.kind)).toEqual(['p'])
  })

  it('finds a table nested inside a body-level table cell', () => {
    const body = tables.tables.find((t) => slice(t) === sample.pieces.bodyTable)!
    const host = body.cells[0][0]
    if (host.kind !== 'cell') throw new Error('expected a cell')
    expect(slice(host)).toBe(sample.pieces.nestedHostCell)
    const nested = tables.tables.find((t) => slice(t) === sample.pieces.nestedTable)!
    expect(nested.host).toMatchObject({ table: body.id, row: 0, col: 0, index: 0 })
    expect(byId(nested.id)).toBe(nested)
    expect(tables.tables).toHaveLength(4)
  })

  it('finds a paragraph-anchored framed table', () => {
    const { paragraphFramedTable } = sample.pieces
    const record = tables.tables.find((t) => slice(t) === paragraphFramedTable.table)!
    expect(record.frame?.anchor).toBe('paragraph')
  })
})

describe('inline objects', () => {
  it('records pictures, notes, comments, embedded objects and shapes', () => {
    const { image, footnote, annotation, formula, customShape, rect } = sample.pieces
    expect(objects.pictures.map(slice)).toEqual([image.frame])
    expect(
      bridge.content.slice(objects.pictures[0].imageStart, objects.pictures[0].imageOpenEnd),
    ).toBe(image.image)
    expect(objects.pictures[0].href).toBe('Pictures/EMB0000a7a0be95.png')
    expect(objects.notes.map(slice)).toEqual([footnote])
    expect(objects.comments.map(slice)).toEqual([annotation.annotation])
    expect(bridge.content.slice(objects.comments[0].endStart!, objects.comments[0].endEnd!)).toBe(
      annotation.end,
    )
    expect(objects.comments[0].name).toBe('memo1')
    const placeholders = objects.placeholders.map(slice)
    expect(placeholders).toEqual(
      expect.arrayContaining([formula.frame, customShape.shape, rect, sample.pieces.toc]),
    )
    // a shape's text is not a paragraph of the document: the shape is one locked object
    expect(placeholders).not.toContain(hPara('shape text'))
  })

  it('pairs NormalField bookmarks and keeps names verbatim', () => {
    const markers = bridge.map.paragraphs.flatMap((p) => p.markers)
    const marker = (name: string, kind: string) =>
      markers.find((m) => m.name === name && m.kind === kind)!
    const start = marker(FIELD_NAME, 'bookmark-start')
    const paired = markers.find((m) => m.kind === 'bookmark-end' && m.name === FIELD_NAME)!
    expect(slice(start)).toBe(sample.pieces.field.start)
    expect(slice(paired)).toBe(sample.pieces.field.end)
    expect(bridge.content.slice(start.end, paired.start)).toBe('안건 <text:s/>내용')

    const escaped = marker(FIELD_NAME_ESCAPED, 'bookmark-start')
    expect(slice(escaped)).toBe(sample.pieces.escapedField.start)
    expect(markers.some((m) => m.kind === 'bookmark-end' && m.name === FIELD_NAME_ESCAPED)).toBe(
      true,
    )

    const unpaired = marker(UNPAIRED_FIELD, 'bookmark-start')
    expect(unpaired.pair).toBeNull()
    expect(slice(unpaired)).toBe(sample.pieces.unpairedStart)

    expect(slice(marker('_Toc1', 'bookmark'))).toBe(sample.pieces.singleBookmark)
  })
})

describe('leniency', () => {
  const open = async (content: string) =>
    (await odtToDocx(await buildOdt({ overrideParts: { 'content.xml': content } }))).bridge

  it('reads non-standard namespace prefixes as the canonical names', async () => {
    const xml =
      '<?xml version="1.0"?><o:document-content xmlns:o="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:t="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:tb="urn:oasis:names:tc:opendocument:xmlns:table:1.0">' +
      '<o:body><o:text><t:p t:style-name="P1">a</t:p><tb:table><tb:table-row><tb:table-cell tb:number-columns-spanned="2"><t:p/></tb:table-cell><tb:covered-table-cell/></tb:table-row></tb:table></o:text></o:body></o:document-content>'
    const map = await open(xml)
    expect(map.blocks.map((b) => [b.kind, b.name])).toEqual([
      ['paragraph', 'text:p'],
      ['table', 'table:table'],
    ])
    expect(map.paragraphs[0].styleName).toBe('P1')
    const table = (map.ext.table as unknown as TableExt).tables[0]
    const cell = table.cells[0][0]
    expect(cell.kind === 'cell' && cell.colSpan).toBe(2)
  })

  it('survives unclosed and stray tags and still ranges the rest', async () => {
    const inner = `<text:p text:style-name="P1"><text:span>unclosed</text:p></text:span>${hPara('next')}`
    const xml = buildContentXml({ body: inner })
    const map = await open(xml)
    expect(map.blocks).toHaveLength(2)
    expect(xml.slice(map.blocks[1].start, map.blocks[1].end)).toBe(hPara('next'))
  })

  it('handles `>` inside attribute values and an empty office:text', async () => {
    const p = '<text:p text:style-name="a>b">x</text:p>'
    const xml = buildContentXml({ body: p })
    const map = await open(xml)
    expect(xml.slice(map.blocks[0].start, map.blocks[0].end)).toBe(p)
    expect(map.paragraphs[0].styleName).toBe('a>b')

    const empty = buildContentXml({ body: '' }).replace(
      '<office:text></office:text>',
      '<office:text/>',
    )
    expect((await open(empty)).blocks).toEqual([])
  })

  it('rejects a content.xml without office:text as corrupt', async () => {
    const err = await open(
      '<office:document-content><office:body/></office:document-content>',
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OdtOpenError)
    expect((err as OdtOpenError).code).toBe('corrupt')
  })
})
