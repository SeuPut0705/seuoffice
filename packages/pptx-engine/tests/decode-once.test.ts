import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import {
  BUILTIN_LAYOUTS,
  addChart,
  addElement,
  addPicture,
  createBlankPptx,
  deleteSlide,
  editChartElement,
  ensureRunLinkRels,
  getChartElementData,
  getRunLinks,
  getSlideNotes,
  insertBlankSlide,
  listMasterParts,
  listSlideLayouts,
  openPptx,
  parseSlide,
  patchGroupChildText,
  patchTextElementXml,
  savePptx,
  setSlideNotes,
  copySlide,
  ensureBuiltinLayout,
  pasteSlide,
  setSlideBackgroundImage,
  type OpenedPptx,
} from '../src/index'
import { stripEmbeddedFonts } from '../src/embedded-fonts'
import { listLayouts } from '../src/slide-transfer'
import { notesPathForSlide, unescapeXml } from '../src/notes'
import { attributeOf, hasContentTypeOverride } from '../src/xml-utils'
import { PackageArchive, relsPathFor, resolveTarget } from '../src/zip'
import type { GroupElement, PassthroughElement, PictureElement, TextElement } from '../src/types'

/**
 * A value in XML is decoded once. `X&amp;#38;1` is the seven characters `X&#38;1`: the `&amp;`
 * is the ampersand, and what follows it is text. A value the parser had already decoded was put
 * through a second decoder, which read that text as a reference and made `X&1` of it, so two
 * different ids met, and an id written back was not the id that had been read.
 */

const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)
const GIF = Uint8Array.from(
  Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
)
const OFF = { x: 914400, y: 914400, cx: 1828800, cy: 914400 }
const PRES = 'ppt/presentation.xml'
const CONTENT_TYPES = '[Content_Types].xml'
const RUN_URL = 'https://example.com/notes'
const ID_ATTRS = ['Id', 'r:id', 'r:embed', 'r:link']

const read = (opened: OpenedPptx, path: string): string => opened.archive.readText(path)!

function put(opened: OpenedPptx, path: string, xml: string): void {
  opened.archive.entries.set(path, Buffer.from(xml, 'utf8'))
}

/** The deck with ids of one part rewritten to the given text, in its rels part and in the part. */
async function withIdsWritten(
  bytes: Uint8Array,
  partPath: string,
  rename: Record<string, string>,
): Promise<Uint8Array> {
  const opened = await openPptx(bytes)
  const write = (xml: string) =>
    Object.entries(rename).reduce(
      (acc, [from, to]) =>
        ID_ATTRS.reduce((s, a) => s.split(`${a}="${from}"`).join(`${a}="${to}"`), acc),
      xml,
    )
  put(opened, relsPathFor(partPath), write(read(opened, relsPathFor(partPath))))
  put(opened, partPath, write(read(opened, partPath)))
  return savePptx(opened)
}

/** The id of the relationship of `partPath` that `pick` chooses. */
function relId(
  opened: OpenedPptx,
  partPath: string,
  pick: (rel: { type: string; target: string }) => boolean,
): string {
  return [...opened.archive.readRels(partPath).values()].find(pick)!.id
}

/** Well-formed, and no `&` that begins no reference: the validator lets that one through. */
function expectWellFormed(xml: string): void {
  expect(XMLValidator.validate(xml)).toBe(true)
  expect(xml).not.toMatch(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/)
}

/** The ids a rels part declares, each decoded once from its own tag. */
function declaredIds(opened: OpenedPptx, partPath: string): (string | undefined)[] {
  return [...read(opened, relsPathFor(partPath)).matchAll(/<Relationship\b[^>]*>/g)].map((m) =>
    attributeOf(m[0], 'Id'),
  )
}

/** The part names [Content_Types].xml overrides, each decoded once from its own tag. */
function overriddenParts(opened: OpenedPptx): (string | undefined)[] {
  const types = read(opened, CONTENT_TYPES)
  expectWellFormed(types)
  return [...types.matchAll(/<Override\b[^>]*>/g)].map((m) => attributeOf(m[0], 'PartName'))
}

/** The part a relationship of `partPath` points at, chosen by the end of its type or target. */
function partOf(opened: OpenedPptx, partPath: string, end: string): string {
  const rel = [...opened.archive.readRels(partPath).values()].find(
    (r) => r.type.endsWith(end) || r.target.endsWith(end),
  )!
  return resolveTarget(partPath, rel.target)
}

function imagesOf(opened: OpenedPptx, slideIndex: number): (Buffer | null)[] {
  return opened.deck.slides[slideIndex]!.elements.filter((e) => e.type === 'picture').map((e) => {
    const ref = (e as PictureElement).mediaRef
    const bytes = ref ? opened.archive.readBytes(ref) : null
    return bytes ? Buffer.from(bytes) : null
  })
}

/** A deck with one part renamed everywhere it is mentioned; the mentions are XML, so escaped. */
async function withPartRenamed(bytes: Uint8Array, from: string, to: string): Promise<Uint8Array> {
  const opened = await openPptx(bytes)
  const { entries } = opened.archive
  const tail = (path: string) => path.split('/').slice(-2).join('/')
  const mention = tail(to).replace(/&/g, '&amp;')
  for (const [path, content] of [...entries]) {
    const next = path === from ? to : path === relsPathFor(from) ? relsPathFor(to) : path
    const text = /\.(?:xml|rels)$/.test(path)
      ? Buffer.from(Buffer.from(content).toString('utf8').split(tail(from)).join(mention), 'utf8')
      : content
    entries.delete(path)
    entries.set(next, text)
  }
  return savePptx(opened)
}

describe('the three inputs of the review', () => {
  it('pictures at X&amp;#38;1 and X&amp;1 are two pictures', async () => {
    const built = await openPptx(await createBlankPptx())
    const slide = built.deck.slides[0]!
    const a = addPicture(built, slide, { bytes: PNG, ext: 'png', offset: OFF })!
    const b = addPicture(built, slide, { bytes: GIF, ext: 'gif', offset: OFF })!
    const bytes = await savePptx(built)
    const plain = await openPptx(bytes)
    const path = plain.deck.slides[0]!.path
    const first = relId(plain, path, (r) => resolveTarget(path, r.target) === a.mediaRef)
    const second = relId(plain, path, (r) => resolveTarget(path, r.target) === b.mediaRef)

    const opened = await openPptx(
      await withIdsWritten(bytes, path, { [first]: 'X&amp;#38;1', [second]: 'X&amp;1' }),
    )
    expect([...opened.archive.readRels(path).keys()]).toEqual(
      expect.arrayContaining(['X&#38;1', 'X&1']),
    )
    expect(imagesOf(opened, 0)).toEqual([Buffer.from(PNG), Buffer.from(GIF)])
  })

  describe('a run whose link id is written rId&amp;#38;4', () => {
    async function linked(): Promise<OpenedPptx> {
      const built = await openPptx(await createBlankPptx())
      const box = addElement(built.deck.slides[0]!, {
        kind: 'textbox',
        offset: OFF,
        paragraphs: [{ runs: [{ text: 'notes' }] }],
      })
      box.text!.paragraphs[0]!.runs[0]!.hyperlink = RUN_URL
      box.dirty = true
      expect(ensureRunLinkRels(built, 0, box.text!.paragraphs)).toBe(true)
      const bytes = await savePptx(built)
      const plain = await openPptx(bytes)
      const path = plain.deck.slides[0]!.path
      const link = relId(plain, path, (r) => r.target === RUN_URL)
      return openPptx(await withIdsWritten(bytes, path, { [link]: 'rId&amp;#38;4' }))
    }

    const textBoxOf = (opened: OpenedPptx): TextElement =>
      opened.deck.slides[0]!.elements.find((e) => e.type === 'text') as TextElement

    /** After a save: every link the slide carries names a relationship its rels part declares. */
    async function expectLinkKept(opened: OpenedPptx, links: number): Promise<void> {
      const reopened = await openPptx(await savePptx(opened))
      const path = reopened.deck.slides[0]!.path
      const xml = read(reopened, path)
      expect(XMLValidator.validate(xml)).toBe(true)
      const referred = [...xml.matchAll(/<a:hlinkClick\b[^>]*>/g)].map((m) =>
        attributeOf(m[0], 'r:id'),
      )
      expect(referred).toEqual(Array.from({ length: links }, () => 'rId&#38;4'))
      expectWellFormed(read(reopened, relsPathFor(path)))
      expect(declaredIds(reopened, path)).toContain('rId&#38;4')
      expect(getRunLinks(reopened, 0).map((l) => l.target)).toEqual(
        Array.from({ length: links }, () => ({ kind: 'url', url: RUN_URL })),
      )
    }

    it('is read as the id it is', async () => {
      const opened = await linked()
      expect(textBoxOf(opened).text!.paragraphs[0]!.runs[0]!.hyperlinkRId).toBe('rId&#38;4')
      expect(getRunLinks(opened, 0).map((l) => l.target)).toEqual([{ kind: 'url', url: RUN_URL }])
    })

    it('keeps its link when its words are edited', async () => {
      const opened = await linked()
      const box = textBoxOf(opened)
      box.text!.paragraphs[0]!.runs[0]!.text = 'notes, edited'
      box.dirty = true
      await expectLinkKept(opened, 1)
    })

    it('keeps its link when the text body is written again from the model', async () => {
      const opened = await linked()
      const box = textBoxOf(opened)
      const runs = box.text!.paragraphs[0]!.runs
      runs.push({ ...runs[0]!, text: ' and more' })
      box.dirty = true
      await expectLinkKept(opened, 2)
    })
  })

  it('a chart whose relationship id is written c&amp;#38;1 can be edited', async () => {
    const built = await openPptx(await createBlankPptx())
    addChart(built, 0, {
      kind: 'bar',
      categories: ['A', 'B'],
      series: [{ name: 'S', values: [1, 2] }],
      offset: OFF,
    })
    const bytes = await savePptx(built)
    const plain = await openPptx(bytes)
    const path = plain.deck.slides[0]!.path
    const chart = relId(plain, path, (r) => r.type.endsWith('/chart'))

    const opened = await openPptx(await withIdsWritten(bytes, path, { [chart]: 'c&amp;#38;1' }))
    const el = opened.deck.slides[0]!.elements.find((e) => e.type === 'chart')!
    expect(
      editChartElement(opened, 0, el.id, {
        categories: ['Jan', 'Feb'],
        series: [{ name: 'Total', values: [7, 8] }],
      }),
    ).toBe(true)

    const reopened = await openPptx(await savePptx(opened))
    const slide = reopened.deck.slides[0]!
    const edited = slide.elements.find((e) => e.type === 'chart')!
    expect(getChartElementData(slide, edited.id)).toMatchObject({
      categories: ['Jan', 'Feb'],
      series: [{ name: 'Total', values: [7, 8] }],
    })
  })
})

describe('the parser and the attribute reader give one value for one spelling', () => {
  const SPELLINGS: [written: string, value: string][] = [
    ['r&amp;1', 'r&1'],
    ['r&#38;1', 'r&1'],
    ['r&#x26;1', 'r&1'],
    ['rId&#49;', 'rId1'],
    ['X&amp;#38;1', 'X&#38;1'],
    ['X&#38;amp;1', 'X&amp;1'],
    ['X&#38;#38;1', 'X&#38;1'],
    ['a&quot;b&apos;c&lt;d&gt;e', 'a"b\'c<d>e'],
    ['&#44536;&#47548;1', '그림1'],
    ['z&#x110000;z&nbsp;z&;z&#;z', 'z&#x110000;z&nbsp;z&;z&#;z'],
  ]

  it.each(SPELLINGS)('%s', async (written, value) => {
    const opened = await openPptx(await createBlankPptx())
    const path = opened.deck.slides[0]!.path
    const rels = read(opened, relsPathFor(path))
    put(
      opened,
      relsPathFor(path),
      rels.replace(/\bId="[^"]*"/, () => `Id="${written}"`),
    )

    // the parser's reading of the rels part, and the attribute reader's of the same tag
    expect([...opened.archive.readRels(path).keys()]).toEqual([value])
    expect(declaredIds(opened, path)).toEqual([value])
  })

  it('a part with a DTD is refused: a package part has no DTD', async () => {
    const opened = await openPptx(await createBlankPptx())
    const path = opened.deck.slides[0]!.path
    const rels = read(opened, relsPathFor(path))
    put(
      opened,
      relsPathFor(path),
      rels
        .replace(
          /<Relationships\b/,
          () => '<!DOCTYPE Relationships [<!ENTITY e "x">]><Relationships',
        )
        .replace(/\bId="[^"]*"/, () => 'Id="r&e;1"'),
    )
    // the Rust engine refuses DOCTYPE outright (crates/pptx-engine/README.md, unit 1: final policy)
    expect(() => opened.archive.readRels(path)).toThrow('document type declarations are not supported')
  })
})

describe('text is decoded once', () => {
  const slideOf = (paragraph: string): string =>
    '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>' +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraph}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
  const shapeOf = (paragraph: string): TextElement =>
    parseSlide({ path: 'ppt/slides/slide1.xml', slideXml: slideOf(paragraph), ctx: {} })
      .elements[0] as TextElement

  it('the words "&#38;" typed on a slide are those five characters', () => {
    const shape = shapeOf('<a:p><a:r><a:t>write &amp;#38; for &#38; &#x1F600;</a:t></a:r></a:p>')
    const run = shape.text!.paragraphs[0]!.runs[0]!
    expect(run.text).toBe('write &#38; for & \u{1F600}')
    // and an edit beside them writes them back as they were
    run.text = `${run.text}!`
    expect(patchTextElementXml(shape, shape.anchor.originalXml)).toContain(
      '<a:t>write &amp;#38; for &amp; \u{1F600}!</a:t>',
    )
  })

  it('a bullet character written &amp;#8226; is not the bullet &#8226; is', () => {
    const bullet = (char: string) =>
      shapeOf(`<a:p><a:pPr><a:buChar char="${char}"/></a:pPr><a:r><a:t>x</a:t></a:r></a:p>`).text!
        .paragraphs[0]!.bullet
    expect(bullet('&#8226;')).toMatchObject({ type: 'char', char: '\u2022' })
    expect(bullet('&amp;#8226;')).toMatchObject({ type: 'char', char: '&#8226;' })
  })

  it('notes and comments text: "&#38;lt;" is the four characters "&lt;"', async () => {
    expect(unescapeXml('&#38;lt; &amp;#38; &amp;lt; &#60; &lt;')).toBe('&lt; &#38; &lt; < <')

    const opened = await openPptx(await createBlankPptx())
    const slidePath = opened.deck.slides[0]!.path
    expect(setSlideNotes(opened, 0, 'PLACEHOLDER')).toBe(true)
    const notesPath = notesPathForSlide(opened.archive, slidePath)!
    put(opened, notesPath, read(opened, notesPath).split('PLACEHOLDER').join('use &#38;lt; here'))
    expect(getSlideNotes(opened.archive, slidePath)).toBe('use &lt; here')
  })
})

describe('a value read by a pattern is decoded like the one the parser reads beside it', () => {
  it.each([
    '<a:hlinkClick r:id="rId9" action="ppaction://hlinkpres?slideindex=2&amp;slidetitle=Plan" highlightClick="1"/>',
    '<a:hlinkClick r:id="" action="ppaction://hlinkshowjump?jump=nextslide" highlightClick="1"/>',
  ])('editing a run keeps the bytes of its link: %s', (hlink) => {
    const slideXml =
      '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
      '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm></p:spPr>' +
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US">${hlink}</a:rPr><a:t>go</a:t></a:r></a:p></p:txBody></p:sp>` +
      '</p:spTree></p:cSld></p:sld>'
    const shape = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml, ctx: {} })
      .elements[0] as TextElement
    shape.text!.paragraphs[0]!.runs[0]!.text = 'go there'

    const out = patchTextElementXml(shape, shape.anchor.originalXml)
    expect(out).toContain(hlink)
    expect(out).toContain('<a:t>go there</a:t>')
  })

  it('a layout or master named with &amp; is listed under its name', async () => {
    const opened = await openPptx(await createBlankPptx())
    for (const path of [...opened.archive.entries.keys()]) {
      if (!/^ppt\/slide(?:Layouts|Masters)\/slide(?:Layout|Master)\d+\.xml$/.test(path)) continue
      const xml = read(opened, path)
      put(
        opened,
        path,
        /<p:cSld\b[^>]*\bname="/.test(xml)
          ? xml.replace(/(<p:cSld\b[^>]*\bname=")[^"]*(")/, (_all, head: string, tail: string) => {
              return `${head}Text &amp; Bild${tail}`
            })
          : xml.replace(/<p:cSld\b/, () => '<p:cSld name="Text &amp; Bild"'),
      )
    }
    expect(listSlideLayouts(opened.archive).map((l) => l.name)).toContain('Text & Bild')
    expect(listLayouts(opened.archive).map((l) => l.name)).toContain('Text & Bild')
    expect(listMasterParts(opened.archive).map((p) => p.name)).toEqual(
      expect.arrayContaining(['Text & Bild']),
    )
    expect(listMasterParts(opened.archive).some((p) => p.name.includes('&amp;'))).toBe(false)
  })

  it('an Override is found by the part name it decodes to', () => {
    const types =
      '<Types><Override PartName="/ppt/charts/a&amp;b.xml" ContentType="x"/>' +
      "<Override ContentType='y' PartName = '/ppt/charts/c&#38;d.xml'/></Types>"
    expect(hasContentTypeOverride(types, 'ppt/charts/a&b.xml')).toBe(true)
    expect(hasContentTypeOverride(types, 'ppt/charts/c&d.xml')).toBe(true)
    expect(hasContentTypeOverride(types, 'ppt/charts/a&amp;b.xml')).toBe(false)
  })

  // `&#50;1` is 21: the parser and the slice reader must both say so. `a&amp;b` is no id the
  // schema allows, but it is the spelling the two readers disagreed on before.
  it.each(['&#50;1', 'a&amp;b'])(
    'a shape in a group whose id is written %s takes an edit',
    (id) => {
      const xfrm = '<a:off x="0" y="0"/><a:ext cx="100" cy="100"/>'
      const slideXml =
        '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>' +
        '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="20" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
        `<p:grpSpPr><a:xfrm>${xfrm}<a:chOff x="0" y="0"/><a:chExt cx="100" cy="100"/></a:xfrm></p:grpSpPr>` +
        `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm>${xfrm}</a:xfrm></p:spPr>` +
        '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>in</a:t></a:r></a:p></p:txBody></p:sp>' +
        '</p:grpSp></p:spTree></p:cSld></p:sld>'
      const slide = parseSlide({ path: 'ppt/slides/slide1.xml', slideXml, ctx: {} })
      const group = slide.elements[0] as GroupElement
      const child = group.children[0] as TextElement
      child.text!.paragraphs[0]!.runs[0]!.text = 'inside'

      expect(patchGroupChildText(slide, group.id, child)).toBe(true)
      expect(group.anchor.originalXml).toContain('<a:t>inside</a:t>')
    },
  )

  it('a SmartArt shape takes its text colour from a point whose modelId is written &#123;X}', () => {
    const frame =
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Diagram 1"/></p:nvGraphicFramePr>' +
      '<p:xfrm><a:off x="100" y="200"/><a:ext cx="4000" cy="3000"/></p:xfrm>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">' +
      '<dgm:relIds xmlns:dgm="dgm" r:dm="rId1" r:lo="rId2" r:qs="rId3" r:cs="rId4"/>' +
      '</a:graphicData></a:graphic></p:graphicFrame>'
    const drawing =
      '<dsp:drawing xmlns:dsp="dsp" xmlns:a="a"><dsp:spTree><dsp:nvGrpSpPr/><dsp:grpSpPr/>' +
      '<dsp:sp modelId="{X}"><dsp:nvSpPr><dsp:cNvPr id="1" name=""/><dsp:cNvSpPr/></dsp:nvSpPr>' +
      '<dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000" cy="1000"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr>' +
      '<dsp:txBody><a:bodyPr/><a:p><a:r><a:t>One</a:t></a:r></a:p></dsp:txBody></dsp:sp>' +
      '</dsp:spTree></dsp:drawing>'
    const data =
      '<dgm:dataModel xmlns:dgm="dgm"><dgm:ptLst>' +
      '<dgm:pt modelId="&#123;X}" type="pres"><dgm:prSet presStyleLbl="node1"/></dgm:pt>' +
      '</dgm:ptLst></dgm:dataModel>'
    const colors =
      '<dgm:colorsDef xmlns:dgm="dgm" xmlns:a="a"><dgm:styleLbl name="node1">' +
      '<dgm:txFillClrLst meth="repeat"><a:srgbClr val="ff0000"/></dgm:txFillClrLst>' +
      '</dgm:styleLbl></dgm:colorsDef>'
    const slideXml =
      '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld>' +
      `<p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${frame}</p:spTree></p:cSld></p:sld>`
    const slide = parseSlide({
      path: 'ppt/slides/slide1.xml',
      slideXml,
      ctx: {
        diagramDrawings: new Map([['rId1', drawing]]),
        diagramDatas: new Map([['rId1', data]]),
        diagramColors: new Map([['rId4', colors]]),
      },
    })
    const shape = (slide.elements[0] as PassthroughElement).previewShapes![0] as TextElement
    expect(shape.text!.paragraphs[0]!.runs[0]!.color).toBe('#FF0000')
  })

  it('an embedded object finds its preview in a VML shape whose id is written _x0000_s10&#50;6', async () => {
    const built = await openPptx(await createBlankPptx())
    const path = built.deck.slides[0]!.path
    const frame =
      '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="90" name="Object"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
      '<p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></p:xfrm>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole">' +
      '<p:oleObj spid="_x0000_s1026" name="Document" r:id="rId91" imgW="914400" imgH="914400" progId="Word.Document.12"><p:embed/></p:oleObj>' +
      '</a:graphicData></a:graphic></p:graphicFrame>'
    put(
      built,
      path,
      read(built, path).replace('</p:spTree>', () => `${frame}</p:spTree>`),
    )
    put(
      built,
      relsPathFor(path),
      read(built, relsPathFor(path)).replace(
        '</Relationships>',
        () =>
          '<Relationship Id="rId92" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/></Relationships>',
      ),
    )
    const VML = 'ppt/drawings/vmlDrawing1.vml'
    put(
      built,
      VML,
      '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">' +
        '<v:shape id="_x0000_s10&#50;6" o:spid="_x0000_s10&#50;6"><v:imagedata o:relid="rId1"/></v:shape></xml>',
    )
    put(
      built,
      relsPathFor(VML),
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/preview1.png"/></Relationships>',
    )
    built.archive.entries.set('ppt/media/preview1.png', Buffer.from(PNG))

    const opened = await openPptx(await savePptx(built))
    const object = opened.deck.slides[0]!.elements.find(
      (e) => e.type === 'passthrough',
    ) as PassthroughElement
    expect(object.previewPicture?.mediaRef).toBe('ppt/media/preview1.png')
  })
})

describe('a slide part whose name holds &', () => {
  const ODD = 'ppt/slides/q&a2.xml'

  /** Two slides; the second one's part is named `q&a2.xml`. */
  async function deck(): Promise<OpenedPptx> {
    const built = await openPptx(await createBlankPptx())
    const second = insertBlankSlide(built, 0)!
    const opened = await openPptx(await withPartRenamed(await savePptx(built), second.path, ODD))
    expect(opened.deck.slides.map((s) => s.path)).toContain(ODD)
    return opened
  }

  it('gets notes whose rels part is well-formed and points back at it', async () => {
    const opened = await deck()
    const index = opened.deck.slides.findIndex((s) => s.path === ODD)
    expect(setSlideNotes(opened, index, 'note')).toBe(true)

    const reopened = await openPptx(await savePptx(opened))
    const notesPath = notesPathForSlide(reopened.archive, ODD)!
    expectWellFormed(read(reopened, relsPathFor(notesPath)))
    const targets = [...reopened.archive.readRels(notesPath).values()].map((r) =>
      resolveTarget(notesPath, r.target),
    )
    expect(targets).toContain(ODD)
    expect(getSlideNotes(reopened.archive, ODD)).toBe('note')
  })

  it('leaves no Override behind when it is deleted', async () => {
    const opened = await deck()
    expect(overriddenParts(opened)).toContain(`/${ODD}`)
    expect(
      deleteSlide(
        opened,
        opened.deck.slides.findIndex((s) => s.path === ODD),
      ),
    ).toBe(true)

    const reopened = await openPptx(await savePptx(opened))
    expect(reopened.archive.has(ODD)).toBe(false)
    expect(overriddenParts(reopened)).not.toContain(`/${ODD}`)
    expect(reopened.deck.slides).toHaveLength(1)
    expect(XMLValidator.validate(read(reopened, PRES))).toBe(true)
  })
})

describe('a part name the deck chose is read decoded and written escaped', () => {
  it("a picture part named p&q1.png becomes another slide's background", async () => {
    const MEDIA = 'ppt/media/p&q1.png'
    const built = await openPptx(await createBlankPptx())
    const picture = addPicture(built, built.deck.slides[0]!, {
      bytes: PNG,
      ext: 'png',
      offset: OFF,
    })!
    insertBlankSlide(built, 0)
    const opened = await openPptx(
      await withPartRenamed(await savePptx(built), picture.mediaRef!, MEDIA),
    )
    expect(setSlideBackgroundImage(opened, opened.deck.slides[1]!, { mediaPath: MEDIA })).toBe(
      MEDIA,
    )

    const reopened = await openPptx(await savePptx(opened))
    const second = reopened.deck.slides[1]!
    expectWellFormed(read(reopened, relsPathFor(second.path)))
    expect(second.background).toMatchObject({ type: 'image', mediaRef: MEDIA })
  })

  it('a built-in layout is added under a master part named m&m1.xml', async () => {
    const MASTER = 'ppt/slideMasters/m&m1.xml'
    const built = await openPptx(await createBlankPptx())
    const master = built.archive.resolveSlideChain(built.deck.slides[0]!.path).masterPath!
    const opened = await openPptx(await withPartRenamed(await savePptx(built), master, MASTER))
    const names = new Set(listSlideLayouts(opened.archive).map((l) => l.name))
    const missing = BUILTIN_LAYOUTS.find((layout) => !names.has(layout.name))!

    const layoutPath = ensureBuiltinLayout(opened.archive, opened.deck.size, missing.key)!
    expectWellFormed(read(opened, relsPathFor(layoutPath)))
    expect(partOf(opened, layoutPath, '/slideMaster')).toBe(MASTER)
  })

  it('a pasted slide brings its own chart and workbook, named c&d1.xml and w&b1.xlsx', async () => {
    const CHART = 'ppt/charts/c&d1.xml'
    const BOOK = 'ppt/embeddings/w&b1.xlsx'
    const built = await openPptx(await createBlankPptx())
    addChart(built, 0, {
      kind: 'bar',
      categories: ['A', 'B'],
      series: [{ name: 'S', values: [1, 2] }],
      offset: OFF,
    })
    const plain = await openPptx(await savePptx(built))
    const chart = partOf(plain, plain.deck.slides[0]!.path, '/chart')
    const book = partOf(plain, chart, '.xlsx')
    const renamed = await withPartRenamed(await savePptx(plain), chart, CHART)
    const opened = await openPptx(await withPartRenamed(renamed, book, BOOK))
    expect(partOf(opened, partOf(opened, opened.deck.slides[0]!.path, '/chart'), '.xlsx')).toBe(
      BOOK,
    )

    expect(pasteSlide(opened, 0, copySlide(opened, 0)!)).not.toBeNull()
    const reopened = await openPptx(await savePptx(opened))
    const charts = reopened.deck.slides.map((s) => partOf(reopened, s.path, '/chart'))
    const books = charts.map((c) => partOf(reopened, c, '.xlsx'))
    expect(charts[0]).toBe(CHART)
    expect(new Set(charts).size).toBe(2)
    expect(books[0]).toBe(BOOK)
    expect(new Set(books).size).toBe(2)
    for (const part of [...charts, ...books]) expect(reopened.archive.has(part)).toBe(true)
    expect(overriddenParts(reopened)).toEqual(expect.arrayContaining(charts.map((c) => `/${c}`)))
  })

  it('an embedded font named R&D Sans, in a part named r&d.fntdata, is removed whole', async () => {
    const FONT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font'
    const zip = new JSZip()
    zip.file(
      PRES,
      '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<p:embeddedFontLst>' +
        '<p:embeddedFont><p:font typeface="R&amp;D Sans"/><p:regular r:id="rId7"/></p:embeddedFont>' +
        '<p:embeddedFont><p:font typeface="Plain"/><p:regular r:id="rId8"/></p:embeddedFont>' +
        '</p:embeddedFontLst></p:presentation>',
    )
    zip.file(
      relsPathFor(PRES),
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId7" Type="${FONT_REL}" Target="fonts/r&amp;d.fntdata"/>` +
        `<Relationship Id="rId8" Type="${FONT_REL}" Target="fonts/plain.fntdata"/>` +
        '</Relationships>',
    )
    zip.file(
      CONTENT_TYPES,
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Override PartName="/ppt/fonts/r&amp;d.fntdata" ContentType="application/x-fontdata"/>' +
        '<Override PartName="/ppt/fonts/plain.fntdata" ContentType="application/x-fontdata"/>' +
        '</Types>',
    )
    zip.file('ppt/fonts/r&d.fntdata', new Uint8Array([1, 2, 3]))
    zip.file('ppt/fonts/plain.fntdata', new Uint8Array([4, 5, 6]))
    const archive = await PackageArchive.open(await zip.generateAsync({ type: 'uint8array' }))

    expect(stripEmbeddedFonts(archive, new Set(['R&D Sans']))).toBe(true)
    expect(archive.has('ppt/fonts/r&d.fntdata')).toBe(false)
    expect(archive.has('ppt/fonts/plain.fntdata')).toBe(true)
    expect([...archive.readRels(PRES).keys()]).toEqual(['rId8'])
    const types = archive.readText(CONTENT_TYPES)!
    expect(hasContentTypeOverride(types, 'ppt/fonts/r&d.fntdata')).toBe(false)
    expect(hasContentTypeOverride(types, 'ppt/fonts/plain.fntdata')).toBe(true)
    expect(archive.readText(PRES)).not.toContain('R&amp;D Sans')
  })
})
