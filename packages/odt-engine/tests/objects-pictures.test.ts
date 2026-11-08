/**
 * Pictures: `draw:frame > draw:image` ⇄ OOXML pictures, written back by
 * narrow patching. A new picture adds a `Pictures/` entry and a manifest
 * entry with a fresh name; a replaced one keeps its frame and changes only
 * the image reference; a deleted one drops its entry when nothing else
 * references it.
 */
import { patchImageParagraphXml } from '@genoffice/docx-engine'
import { FULL_REGISTRY } from './helpers/full'
import { describe, expect, it } from 'vitest'
import {
  OdfToOoxmlContext,
  OoxmlToOdfContext,
  buildBridgeDocx,
  convertOdtBody,
  nodesOfKind,
  openOdt,
} from '../src/core'
import { ODT_PICTURE_PREFIX } from '../src/objects'
import {
  convertOdtStyles,
  editedParagraphFromBlock,
  paragraphToOdf,
  paragraphToOoxml,
} from '../src/text'
import { bodyOf, editOnly, editorSave, replaceText } from './helpers/bridge'
import { hCell, hImageFrame, hPara, hParaWith, hRow, hTable } from './helpers/hancom-fragments'
import { PNG_1X1 } from './helpers/hancom-sample'
import {
  PNG_GREY,
  drawingOf,
  keepAllBut,
  objectsBridge,
  objectsRegistry,
  resizeDrawing,
  saveBlocks,
  toBase64,
  visibleBlocks,
  writeBackObjects,
} from './helpers/objects-fixtures'

const HREF = 'Pictures/EMB0000a7a0be95.png'
const picture = hImageFrame(HREF)
const anchored = hImageFrame('Pictures/EMB0000a7a0be96.png', { anchor: 'paragraph', z: 7 })

const pictures = { 'EMB0000a7a0be95.png': PNG_1X1, 'EMB0000a7a0be96.png': PNG_GREY }

/** 4.547cm × 1.342cm in EMU */
const W = 1636920
const H = 483120

describe('pictures: ODF → OOXML', () => {
  it('an as-char picture in a text paragraph becomes an inline picture run', async () => {
    const fx = await objectsBridge({ body: hParaWith(`앞${picture.frame}뒤`), pictures })
    const { blocks } = await visibleBlocks(fx.bridge.docx)
    expect(blocks).toHaveLength(1)
    const runs = blocks[0].runs ?? []
    expect(runs.map((r) => r.text)).toEqual(['앞', '', '뒤'])
    const image = runs[1].image
    expect(image?.xml).toContain('<wp:inline')
    expect(image?.xml).toContain(`<wp:extent cx="${W}" cy="${H}"/>`)
    expect(image?.xml).toMatch(new RegExp(`name="${ODT_PICTURE_PREFIX}\\d+"`))
    expect(image?.dataUrl).toBe(`data:image/png;base64,${Buffer.from(PNG_1X1).toString('base64')}`)
    expect(fx.ext.pictures).toEqual([
      expect.objectContaining({
        entry: HREF,
        href: HREF,
        widthEmu: W,
        heightEmu: H,
        anchored: false,
        paragraph: 0,
      }),
    ])
    expect(fx.bridge.map.paragraphs[0].text).toBe('앞뒤')
  })

  it('a paragraph-anchored picture alone in its paragraph floats', async () => {
    const fx = await objectsBridge({ body: hParaWith(anchored.frame), pictures })
    const { blocks } = await visibleBlocks(fx.bridge.docx)
    expect(blocks[0].type).toBe('image')
    expect(blocks[0].originalXml).toContain('<wp:anchor')
    expect(blocks[0].originalXml).toContain('<wp:posOffset>206280</wp:posOffset>')
    expect(fx.ext.pictures[0]).toMatchObject({ anchored: true, xEmu: 206280, yEmu: 30960 })
  })

  // builds its own partial registry state (tables converted only when the table layer is absent)
  it.skipIf(FULL_REGISTRY)(
    'pictures inside table cells go through the same inline handler',
    async () => {
      const cellPara = hParaWith(`셀${picture.frame}`)
      const body = hTable('Table2', 1, [hRow([hCell(cellPara)])])
      const fx = await objectsBridge({ body, pictures })
      const doc = await openOdt(fx.built.bytes)
      const ctx = new OdfToOoxmlContext(doc, objectsRegistry())
      convertOdtStyles(ctx)
      convertOdtBody(ctx)
      // without a table converter the table carries no OOXML; convert its cell paragraph directly
      const node = nodesOfKind(doc.body.blocks, 'paragraph')[0]
      const { xml, paragraph } = paragraphToOoxml(ctx, node, {
        part: 'content.xml',
        owner: 'table',
      })
      expect(xml).toContain('<w:drawing>')
      expect(paragraph.markers).toEqual([
        expect.objectContaining({ kind: 'handler', owner: 'objects', name: 'draw:frame' }),
      ])
      // the cell paragraph, edited and written back from runs, keeps the frame bytes
      ctx.addElement(ctx.addBlock(node, null, 'table').id, xml, 'paragraph', paragraph.id)
      const bridgeDocx = await buildBridgeDocx(ctx)
      const parsed = await visibleBlocks(bridgeDocx)
      const map = JSON.parse(JSON.stringify(ctx.map)) as typeof ctx.map
      const rctx = new OoxmlToOdfContext(doc, map, parsed.parsed, ctx.registry)
      const edited = editedParagraphFromBlock(parsed.blocks[0])
      edited.runs[0] = { ...edited.runs[0], text: '칸' }
      const odf = paragraphToOdf(rctx, edited, map.paragraphs[paragraph.id], {
        part: 'content.xml',
      })
      expect(odf).toBe(hParaWith(`칸${picture.frame}`))
    },
  )
})

describe('pictures: OOXML → ODF', () => {
  it('an unedited save writes nothing and changes no package entry', async () => {
    const body = hPara('a') + hParaWith(`앞${picture.frame}뒤`) + hParaWith(anchored.frame)
    const fx = await objectsBridge({ body, pictures })
    const { bytes } = await editorSave(fx.bridge.docx, (blocks) =>
      blocks.map((_, i) => ({ keep: i })),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(wb.content).toBe(fx.bridge.doc.contentXml)
    expect(wb.changes).toEqual({ add: [], remove: [] })
    expect(wb.manifest).toBe(fx.built.manifestXml)
  })

  it('text edited around a picture keeps the frame byte for byte', async () => {
    const fx = await objectsBridge({ body: hParaWith(`앞${picture.frame}뒤`), pictures })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({ 0: (g) => replaceText(g, 0, 1, '맨 앞') }),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(hParaWith(`맨 앞${picture.frame}뒤`))
    expect(wb.changes).toEqual({ add: [], remove: [] })
  })

  it('a picture resized in a text paragraph changes only svg:width/svg:height', async () => {
    const fx = await objectsBridge({ body: hParaWith(`앞${picture.frame}뒤`), pictures })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({
        0: (g) => {
          const image = g.runs[1].image
          if (image) image.xml = resizeDrawing(image.xml, 720000, 360000)
        },
      }),
    )
    const wb = await writeBackObjects(fx, bytes)
    const resized = picture.frame
      .replace('svg:width="4.547cm"', 'svg:width="2cm"')
      .replace('svg:height="1.342cm"', 'svg:height="1cm"')
    expect(bodyOf(wb.content)).toBe(hParaWith(`앞${resized}뒤`))
  })

  it('a picture alone in its paragraph, resized by the editor, keeps the paragraph', async () => {
    const fx = await objectsBridge({ body: hPara('a') + hParaWith(picture.frame), pictures })
    const edited = await saveBlocks(fx.bridge.docx, (blocks) =>
      keepAllBut(blocks, {
        1: {
          kind: 'xml',
          xml: patchImageParagraphXml(blocks[1].originalXml as string, {
            widthPx: 180,
            heightPx: 90,
          }),
          docxIndex: blocks[1].docxIndex as number,
        },
      }),
    )
    const wb = await writeBackObjects(fx, edited)
    const resized = picture.frame
      .replace('svg:width="4.547cm"', 'svg:width="4.763cm"')
      .replace('svg:height="1.342cm"', 'svg:height="2.381cm"')
    expect(bodyOf(wb.content)).toBe(hPara('a') + hParaWith(resized))
  })

  it('a replaced picture keeps its frame and points at a new entry', async () => {
    const fx = await objectsBridge({ body: hParaWith(picture.frame), pictures })
    const edited = await saveBlocks(fx.bridge.docx, (blocks) =>
      keepAllBut(blocks, {
        0: {
          kind: 'xml',
          xml: blocks[0].originalXml as string,
          docxIndex: blocks[0].docxIndex as number,
          replaceImage: { base64: toBase64(PNG_GREY), mime: 'image/png' },
        },
      }),
    )
    const wb = await writeBackObjects(fx, edited)
    expect(bodyOf(wb.content)).toBe(hParaWith(picture.frame.replace(HREF, 'Pictures/io_1.png')))
    expect(wb.changes.add).toEqual([
      { path: 'Pictures/io_1.png', data: PNG_GREY, mediaType: 'image/png' },
    ])
    // nothing references the old picture any more
    expect(wb.changes.remove).toEqual([HREF])
    expect(wb.manifest).not.toContain(`manifest:full-path="${HREF}"`)
    expect(wb.manifest).toContain(
      '<manifest:file-entry manifest:full-path="Pictures/io_1.png" manifest:media-type="image/png"/>',
    )
  })

  it('a deleted picture drops its entry only when nothing else references it', async () => {
    const body =
      hParaWith(picture.frame) + hParaWith(`둘째${picture.frame}`) + hParaWith(anchored.frame)
    const fx = await objectsBridge({ body, pictures })
    const edited = await saveBlocks(fx.bridge.docx, (blocks) =>
      keepAllBut(blocks, { 0: null, 2: null }),
    )
    const wb = await writeBackObjects(fx, edited)
    expect(bodyOf(wb.content)).toBe(hParaWith(`둘째${picture.frame}`))
    expect(wb.changes).toEqual({ add: [], remove: ['Pictures/EMB0000a7a0be96.png'] })
    expect(wb.manifest).not.toContain('EMB0000a7a0be96.png')
    expect(wb.manifest).toContain(HREF)
  })

  it('a picture deleted from a text paragraph disappears with its entry', async () => {
    const fx = await objectsBridge({ body: hParaWith(`앞${picture.frame}뒤`), pictures })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({ 0: (g) => (g.runs = g.runs.filter((r) => !r.image)) }),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(hParaWith('앞뒤'))
    expect(wb.changes.remove).toEqual([HREF])
  })

  it('a new picture adds a Pictures entry and a manifest entry with a fresh name', async () => {
    const fx = await objectsBridge({
      body: hPara('a'),
      pictures: { 'io_1.png': PNG_1X1 },
    })
    const edited = await saveBlocks(fx.bridge.docx, (blocks) => [
      { kind: 'original', docxIndex: blocks[0].docxIndex as number },
      {
        kind: 'image',
        image: { base64: toBase64(PNG_GREY), mime: 'image/png', widthPx: 180, heightPx: 90 },
      },
    ])
    const wb = await writeBackObjects(fx, edited)
    const body = bodyOf(wb.content)
    expect(body.startsWith(hPara('a'))).toBe(true)
    expect(body).toMatch(
      /^.*<text:p text:style-name="[^"]+"><draw:frame draw:style-name="([^"]+)" text:anchor-type="as-char" svg:width="4\.763cm" svg:height="2\.381cm" draw:z-index="\d+"><draw:image xlink:href="Pictures\/io_2\.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"\/><\/draw:frame><\/text:p>$/,
    )
    expect(wb.changes.add).toEqual([
      { path: 'Pictures/io_2.png', data: PNG_GREY, mediaType: 'image/png' },
    ])
    expect(wb.changes.remove).toEqual([])
    expect(wb.manifest).toContain('manifest:full-path="Pictures/io_2.png"')
    // the frame's graphic style is a new automatic style
    const style = /draw:style-name="([^"]+)"/.exec(body)?.[1] as string
    expect(wb.content).toContain(`<style:style style:name="${style}" style:family="graphic">`)
  })

  it('a paragraph left with only its picture keeps the picture and its paragraph style', async () => {
    const fx = await objectsBridge({ body: hParaWith(`앞${picture.frame}`), pictures })
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({ 0: (g) => replaceText(g, 0, 1, '') }),
    )
    const { blocks } = await visibleBlocks(bytes)
    expect(blocks[0].type).toBe('image')
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(`<text:p text:style-name="P1_0">${picture.frame}</text:p>`)
    expect(wb.changes).toEqual({ add: [], remove: [] })
  })

  it('a picture the engine cannot read is still written back when its paragraph is edited', async () => {
    // a placeable WMF the converter cannot draw here: the engine drops its run
    const wmf = new Uint8Array(64)
    wmf.set([0xd7, 0xcd, 0xc6, 0x9a])
    const frame = hImageFrame('Pictures/logo.wmf').frame
    const fx = await objectsBridge({
      body: hParaWith(`앞${frame}뒤`),
      pictures: { 'logo.wmf': wmf },
    })
    expect(fx.ext.pictures).toHaveLength(1)
    const { blocks } = await visibleBlocks(fx.bridge.docx)
    expect(blocks[0].runs?.some((r) => r.image)).toBe(false)
    // the paragraph as a renderer that could draw the picture saves it: text edited, drawing kept
    const xml = (blocks[0].originalXml as string).replace('>앞</w:t>', '>맨 앞</w:t>')
    const edited = await saveBlocks(fx.bridge.docx, (bs) =>
      keepAllBut(bs, { 0: { kind: 'xml', xml, docxIndex: bs[0].docxIndex as number } }),
    )
    const wb = await writeBackObjects(fx, edited)
    expect(bodyOf(wb.content)).toBe(hParaWith(`맨 앞${frame}뒤`))
    expect(wb.changes).toEqual({ add: [], remove: [] })
  })

  it('a picture copied in the editor keeps its picture and adds no entry', async () => {
    const fx = await objectsBridge({ body: hParaWith(`앞${picture.frame}뒤`), pictures })
    const { blocks } = await visibleBlocks(fx.bridge.docx)
    const drawing = drawingOf(blocks[0].originalXml as string)
    const { bytes } = await editorSave(
      fx.bridge.docx,
      editOnly({
        0: (g) => {
          g.runs.push({ text: '', image: { dataUrl: '', xml: drawing } })
        },
      }),
    )
    const wb = await writeBackObjects(fx, bytes)
    expect(bodyOf(wb.content)).toBe(hParaWith(`앞${picture.frame}뒤${picture.frame}`))
    expect(wb.changes).toEqual({ add: [], remove: [] })
  })
})
