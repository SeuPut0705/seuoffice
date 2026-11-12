import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildBlankDocx, parseDocx, saveDocx, type ParsedDocFull } from '@genoffice/docx-engine'
import { insertTableAt } from '../src/renderer/components/ribbon-tabs'
import { insertPictureAtSelection } from '../src/renderer/editor/insert-picture'
import { blocksToPmDoc, pmDocToSavePlan, type PmNode } from '../src/renderer/editor/convert'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { annotationsFromParsed, buildInkImages } from '../src/renderer/editor/ink'
import { TINY_PNG_BASE64, buildDocx } from '../../../packages/docx-engine/tests/helpers/build-docx'

/**
 * A number in the document (a corrupt extent or offset in the file, a node
 * attribute a peer sent) must never stop a save. A picture whose size is no
 * usable number saves at the default 96 px square, a rotation or an offset
 * that is none is left out, and the document reopens with the picture.
 */

const picture = {
  dataUrl: `data:image/png;base64,${TINY_PNG_BASE64}`,
  base64: TINY_PNG_BASE64,
  mime: 'image/png',
  widthPx: 120,
  heightPx: 80,
  label: 'Picture',
}
const HUGE = '99999999999999999999'

const live: Editor[] = []
afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy()
})

async function open(bytes: Uint8Array) {
  const parsed = await parseDocx(bytes)
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: blocksToPmDoc(parsed.blocks) as never,
  })
  live.push(editor)
  return { editor, parsed }
}

async function save(parsed: ParsedDocFull, json: PmNode) {
  const plan = pmDocToSavePlan(json, parsed.blocks)
  return parseDocx(await saveDocx(parsed, plan.saveBlocks, { newPictures: plan.newPictures }))
}

function setAttrs(json: PmNode, pick: (n: PmNode) => boolean, attrs: Record<string, unknown>) {
  const walk = (n: PmNode) => {
    if (pick(n)) Object.assign(n.attrs!, attrs)
    for (const c of (n.content ?? []) as PmNode[]) walk(c)
  }
  walk(json)
}

const imagePara = (cx: string) =>
  `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="476250"/><wp:docPr id="1" name="Picture 1"/>` +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
  `<pic:pic><pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill><pic:spPr><a:xfrm><a:ext cx="${cx}" cy="476250"/></a:xfrm></pic:spPr></pic:pic>` +
  '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'

const sizes = (parsed: ParsedDocFull) =>
  parsed.blocks
    .filter((b) => b.type === 'image')
    .map((b) => [b.imageWidthPx, b.imageHeightPx, b.imageRotDeg ?? 0])

describe('numbers from the document on the save path', () => {
  it('a copy of a picture whose file extent is out of range saves at the default size', async () => {
    const { editor, parsed } = await open(
      await buildDocx({ bodyXml: imagePara(HUGE), withImage: true }),
    )
    const json = editor.getJSON() as PmNode
    const original = (json.content as PmNode[])[0]!
    json.content = [original, structuredClone(original)]
    const reopened = await save(parsed, json)
    expect(sizes(reopened)).toHaveLength(2)
    expect(sizes(reopened)[1]).toEqual([96, 96, 0])
  })

  it.each([
    ['an infinite rotation', { imageRotDeg: Infinity }, [120, 80, 0]],
    ['an out-of-range width', { imageWidthPx: 1e20 }, [120, 80, 0]],
    [
      'a width that is not a number',
      { imageWidthPx: Number.NaN, imageHeightPx: 'x' },
      [120, 80, 0],
    ],
  ] as const)('an inserted picture with %s saves', async (_name, attrs, expected) => {
    const { editor, parsed } = await open(await buildBlankDocx())
    insertPictureAtSelection(editor, picture)
    const json = editor.getJSON() as PmNode
    setAttrs(json, (n) => !!n.attrs?.genImage, attrs)
    expect(sizes(await save(parsed, json))).toEqual([expected])
  })

  it.each([
    ['an infinite width', { widthPx: Infinity }],
    ['an out-of-range width', { widthPx: 1e20 }],
    ['a width that is not a number', { widthPx: Number.NaN }],
    ['an infinite rotation', { rotDeg: Infinity }],
  ] as const)('a picture in a table cell with %s saves', async (_name, attrs) => {
    const { editor, parsed } = await open(await buildBlankDocx())
    insertTableAt(editor, 1, 1)
    let target = -1
    editor.state.doc.descendants((node, pos) => {
      if (target < 0 && node.type.name === 'docTableCell') target = pos + 2
      return target < 0
    })
    editor.commands.setTextSelection(target)
    expect(insertPictureAtSelection(editor, picture)).toBe(true)
    const json = editor.getJSON() as PmNode
    setAttrs(json, (n) => n.type === 'docInlineImage', attrs)
    const reopened = await save(parsed, json)
    const cellImage = reopened.blocks
      .flatMap((b) => b.table?.rows.flat() ?? [])
      .flatMap((c) => c.richParas ?? [])
      .flatMap((p) => p.runs)
      .find((r) => r.image)?.image
    expect(cellImage).toBeDefined()
    expect(cellImage!.widthPx).toBeGreaterThan(0)
    expect(cellImage!.widthPx).toBeLessThanOrEqual(120)
    expect(cellImage!.xml).not.toMatch(/="[^"]*(?:NaN|Infinity|e\+)/)
  })

  it('an ink annotation whose file offset is out of range saves at the column edge', async () => {
    const ink =
      '<w:p><w:r><w:t>x</w:t></w:r><w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251667241" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">' +
      `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>${HUGE}</wp:posOffset></wp:positionH>` +
      '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="952500" cy="476250"/>' +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="9001" name="aidocs-ink 9001"/>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rId10"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>'
    const parsed = await parseDocx(await buildDocx({ bodyXml: ink, withImage: true }))
    const blocks = parsed.blocks
      .filter((b) => !b.hidden && b.docxIndex !== null)
      .map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex! }))
    const inks = buildInkImages(
      annotationsFromParsed(parsed.inks ?? []),
      new Map(blocks.map((b, i) => [b.docxIndex, i])),
    )
    const reopened = await parseDocx(await saveDocx(parsed, blocks, { inks }))
    expect(reopened.inks?.map((i) => [i.offsetXPx, i.widthPx])).toEqual([[0, 100]])
  })
})
