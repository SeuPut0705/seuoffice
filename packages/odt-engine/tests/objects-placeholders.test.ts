/**
 * Objects the editor cannot change (formula objects, shapes, text boxes,
 * tables of contents, tracked-change paragraphs): each becomes ONE locked
 * placeholder picture named `odt-keep:<id>:<kind>`. A placeholder still
 * present writes the original bytes; one that disappeared deletes the object
 * and the package entries only it referenced.
 */
import { patchImageParagraphXml } from '@genoffice/docx-engine'
import { FULL_REGISTRY } from './helpers/full'
import { describe, expect, it } from 'vitest'
import { NEUTRAL_PLACEHOLDER_PNG, ODT_KEEP_PREFIX, parseKeepName } from '../src/objects'
import { bodyOf, editOnly, editorSave, replaceText } from './helpers/bridge'
import type { OdtFixtureEntry } from './helpers/build-odt'
import {
  FORMULA_CONTENT_XML,
  hCustomShape,
  hFramedTable,
  hPara,
  hParaWith,
  hRow,
  hCell,
  hTable,
} from './helpers/hancom-fragments'
import { PNG_1X1 } from './helpers/hancom-sample'
import {
  keepAllBut,
  objectsBridge,
  resizeDrawing,
  saveBlocks,
  visibleBlocks,
  writeBackObjects,
} from './helpers/objects-fixtures'

/** A formula object with its replacement picture, as LibreOffice-style packages store it. */
const formula =
  '<draw:frame draw:style-name="gr20" svg:width="2.000cm" svg:height="0.600cm" draw:z-index="30" text:anchor-type="as-char">' +
  '<draw:object xlink:href="./Object 1" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>' +
  '<draw:image xlink:href="./ObjectReplacements/Object 1" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>' +
  '</draw:frame>'
const formulaEntries: OdtFixtureEntry[] = [
  { name: 'Object 1/content.xml', data: FORMULA_CONTENT_XML, mediaType: 'text/xml' },
  { name: 'Object 1/', data: '', mediaType: 'application/vnd.oasis.opendocument.formula' },
  { name: 'ObjectReplacements/Object 1', data: PNG_1X1, mediaType: '' },
]
const shape = hCustomShape('도형 글')
const textBox =
  '<draw:frame draw:style-name="gr3" svg:width="5.000cm" svg:height="2.000cm" draw:z-index="2" text:anchor-type="as-char"><draw:text-box>' +
  hPara('글상자 글') +
  '</draw:text-box></draw:frame>'
const toc =
  '<text:table-of-content text:style-name="Sect2" text:protected="true" text:name="Table of Contents1"><text:table-of-content-source text:outline-level="3"/>' +
  `<text:index-body>${hPara('차례 하나')}${hPara('차례 둘')}</text:index-body></text:table-of-content>`
const revision =
  '<text:p text:style-name="P1_0"><text:span text:style-name="T1">바뀐 <text:change-start text:change-id="ct1"/>새 글<text:change-end text:change-id="ct1"/> 끝</text:span></text:p>'
const trackedChanges =
  '<text:tracked-changes><text:changed-region text:id="ct1"><text:insertion><office:change-info><dc:creator>user</dc:creator><dc:date>2024-01-02T03:04:05</dc:date></office:change-info></text:insertion></text:changed-region></text:tracked-changes>'

function kinds(names: string[]): string[] {
  return names.map((n) => parseKeepName(n)?.kind ?? 'none')
}

const docPrNames = (xml: string): string[] =>
  [...xml.matchAll(/<wp:docPr [^>]*name="([^"]*)"/g)].map((m) => m[1])

describe('placeholders: ODF → OOXML', () => {
  it('each uneditable object becomes one named placeholder picture', async () => {
    const body =
      trackedChanges +
      hParaWith(`식 ${formula}`) +
      hParaWith(shape.shape) +
      hParaWith(`상자 ${textBox}`) +
      toc +
      revision
    const fx = await objectsBridge({ body, extraEntries: formulaEntries })
    const { blocks } = await visibleBlocks(fx.bridge.docx)
    const names = blocks.flatMap((b) => docPrNames(b.originalXml ?? ''))
    expect(names.every((n) => n.startsWith(ODT_KEEP_PREFIX))).toBe(true)
    expect(kinds(names)).toEqual(['equation', 'shape', 'textbox', 'toc', 'revision'])
    // the list the editor and CLI read
    expect(fx.ext.placeholders.map((p) => [p.kind, p.name, p.preview])).toEqual(
      names.map((n) => [parseKeepName(n)?.kind, n, n.endsWith(':equation')]),
    )
    // the formula shows its replacement picture, the others the neutral picture
    expect(blocks[0].runs?.[1].image?.dataUrl).toBe(
      `data:image/png;base64,${Buffer.from(PNG_1X1).toString('base64')}`,
    )
    expect(blocks[1].imageDataUrl).toBe(
      `data:image/png;base64,${Buffer.from(NEUTRAL_PLACEHOLDER_PNG).toString('base64')}`,
    )
    // sizes follow the objects
    const eq = fx.ext.placeholders[0]
    expect([eq.widthEmu, eq.heightEmu]).toEqual([720000, 216000])
    expect(eq.entries).toEqual(['Object 1/', 'Object 1/content.xml', 'ObjectReplacements/Object 1'])
    const sh = fx.ext.placeholders[1]
    expect([sh.widthEmu, sh.heightEmu]).toEqual([5740560, 343080])
    // the revision placeholder records the final text
    expect(fx.ext.placeholders[4]).toMatchObject({ kind: 'revision', finalText: '바뀐 새 글 끝' })
    expect(fx.ext.placeholders[3]).toMatchObject({ kind: 'toc', paragraph: null })
    // the text around an inline placeholder stays text
    expect(blocks[0].runs?.[0].text).toBe('식 ')
  })

  // without the table layer the frame stays a kept marker
  it.skipIf(FULL_REGISTRY)('a text box holding a table is left to the table owner', async () => {
    const framed = hFramedTable(hTable('Table1', 1, [hRow([hCell(hPara('칸'))])]))
    const fx = await objectsBridge({ body: framed.paragraph })
    expect(fx.ext.placeholders).toEqual([])
    expect(fx.bridge.map.paragraphs[0].markers).toEqual([
      expect.objectContaining({ kind: 'keep', name: 'draw:frame' }),
    ])
  })

  it('the objects slot survives a JSON round trip unchanged', async () => {
    const fx = await objectsBridge({
      body: hParaWith(`식 ${formula}`) + toc,
      extraEntries: formulaEntries,
    })
    const ext = fx.bridge.ctx.map.ext.objects
    expect(JSON.parse(JSON.stringify(ext))).toEqual(ext)
    expect(fx.bridge.map.ext.objects).toEqual(ext)
  })
})

describe('placeholders: OOXML → ODF', () => {
  const body =
    hPara('위') + hParaWith(`식 ${formula}끝`) + hParaWith(shape.shape) + toc + hPara('아래')

  it('an unedited save keeps everything and every entry', async () => {
    const fx = await objectsBridge({ body, extraEntries: formulaEntries })
    const { bytes } = await editorSave(fx.bridge.docx, (blocks) =>
      blocks.map((_, i) => ({ keep: i })),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(wb.content).toBe(fx.bridge.doc.contentXml)
    expect(wb.changes).toEqual({ add: [], remove: [] })
  })

  it('text edited around a placeholder keeps the object bytes', async () => {
    const fx = await objectsBridge({ body, extraEntries: formulaEntries })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({ 1: (g) => replaceText(g, 0, 1, '수') }),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(
      hPara('위') + hParaWith(`수 ${formula}끝`) + hParaWith(shape.shape) + toc + hPara('아래'),
    )
  })

  it('a resized placeholder is written back unchanged', async () => {
    const fx = await objectsBridge({ body, extraEntries: formulaEntries })
    const edited = await saveBlocks(fx.bridge.docx, (blocks) =>
      keepAllBut(blocks, {
        2: {
          kind: 'xml',
          xml: patchImageParagraphXml(blocks[2].originalXml as string, {
            widthPx: 50,
            heightPx: 20,
          }),
          docxIndex: blocks[2].docxIndex as number,
        },
        3: {
          kind: 'xml',
          xml: resizeDrawing(blocks[3].originalXml as string, 100000, 100000),
          docxIndex: blocks[3].docxIndex as number,
        },
      }),
    )
    const { bytes } = await editorSave(
      edited,
      editOnly({
        1: (g) => {
          const image = g.runs.find((r) => r.image)?.image
          if (image) image.xml = resizeDrawing(image.xml, 100000, 100000)
          replaceText(g, 0, 0, '새 ')
        },
      }),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(
      hPara('위') + hParaWith(`새 식 ${formula}끝`) + hParaWith(shape.shape) + toc + hPara('아래'),
    )
  })

  it('a deleted placeholder deletes the object and the entries only it used', async () => {
    const fx = await objectsBridge({ body, extraEntries: formulaEntries })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({ 1: (g) => (g.runs = g.runs.filter((r) => !r.image)) }),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(
      hPara('위') + hParaWith('식 끝') + hParaWith(shape.shape) + toc + hPara('아래'),
    )
    expect(wb.changes.remove).toEqual([
      'Object 1/',
      'Object 1/content.xml',
      'ObjectReplacements/Object 1',
    ])
    expect(wb.manifest).not.toContain('Object 1')
  })

  it('deleted block placeholders and shape paragraphs disappear', async () => {
    const fx = await objectsBridge({ body, extraEntries: formulaEntries })
    const edited = await saveBlocks(fx.bridge.docx, (blocks) =>
      keepAllBut(blocks, { 2: null, 3: null }),
    )
    const wb = await writeBackObjects(fx, edited)
    expect(bodyOf(wb.content)).toBe(hPara('위') + hParaWith(`식 ${formula}끝`) + hPara('아래'))
    expect(wb.changes).toEqual({ add: [], remove: [] })
  })

  it('a tracked-change paragraph is locked and kept as written', async () => {
    const fx = await objectsBridge({ body: trackedChanges + hPara('앞') + revision })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({ 0: (g) => replaceText(g, 0, 0, '맨 ') }),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(trackedChanges + hPara('맨 앞') + revision)
  })
})
