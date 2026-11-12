import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import {
  copySlide,
  createBlankPptx,
  getSlideNotes,
  openPptx,
  pasteSlide,
  savePptx,
  setShowNarration,
  setSlideLayout,
  setSlideNotes,
  type OpenedPptx,
} from '../src/index'
import { notesPathForSlide } from '../src/notes'
import { relsPathFor, resolveTarget } from '../src/zip'

/**
 * String.prototype.replace reads `$&`, `$$`, `$1`, `` $` `` and `$'` in a replacement STRING as
 * patterns. The writers below wire package parts together, and used to put text the deck carries
 * (a part name another producer chose, a content type, the attributes of <p:showPr>) through one.
 */
const DOLLAR = "A$&B$$C$1D$`E$'F"
const DOLLAR_IN_XML = DOLLAR.replace(/&/g, '&amp;')
/** `$` sequences a part name can hold without needing XML or URI escaping. */
const NAME_DOLLAR = '$$x$1y'

const PRES = 'ppt/presentation.xml'
const CONTENT_TYPES = '[Content_Types].xml'
const FIXTURE = new URL('./fixtures/01_standard_business.pptx', import.meta.url)

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })

function put(opened: OpenedPptx, path: string, xml: string): void {
  opened.archive.entries.set(path, Buffer.from(xml, 'utf8'))
}

/** A deck with one part renamed everywhere it is mentioned, as another producer may name it. */
async function deckWithPartRenamed(
  base: Uint8Array,
  from: string,
  to: string,
): Promise<Uint8Array> {
  const opened = await openPptx(base)
  const { entries } = opened.archive
  const tail = (path: string) => path.split('/').slice(-2).join('/')
  for (const [path, bytes] of [...entries]) {
    const next = path === from ? to : path === relsPathFor(from) ? relsPathFor(to) : path
    const text = /\.(?:xml|rels)$/.test(path)
      ? Buffer.from(Buffer.from(bytes).toString('utf8').split(tail(from)).join(tail(to)), 'utf8')
      : bytes
    entries.delete(path)
    entries.set(next, text)
  }
  return savePptx(opened)
}

/** Every relationship of `partPath` must point at a part that exists. */
function expectRelsResolve(opened: OpenedPptx, partPath: string): void {
  const relsXml = opened.archive.readText(relsPathFor(partPath))!
  expect(XMLValidator.validate(relsXml)).toBe(true)
  for (const rel of opened.archive.readRels(partPath).values()) {
    if (rel.targetMode === 'External') continue
    const target = resolveTarget(partPath, rel.target)
    expect(opened.archive.has(target), `${rel.target} of ${partPath}`).toBe(true)
  }
}

describe('setShowNarration keeps the $ sequences of the <p:showPr> it rewrites', () => {
  it('an attribute it does not know comes back exactly', async () => {
    const opened = await openPptx(await createBlankPptx())
    setShowNarration(opened)
    const path = 'ppt/presProps.xml'
    const showPr = `<p:showPr loop="1" showNarration="0" note="${DOLLAR_IN_XML}"><p:present/></p:showPr>`
    put(
      opened,
      path,
      opened.archive
        .readText(path)!
        .split(/<p:showPr\b[^>]*\/>/)
        .join(showPr),
    )

    setShowNarration(opened)

    const xml = opened.archive.readText(path)!
    expect(XMLValidator.validate(xml)).toBe(true)
    const read = parser.parse(xml)['p:presentationPr']['p:showPr']
    expect(read['@_note']).toBe(DOLLAR)
    expect(read['@_showNarration']).toBe('1')
    expect(read['@_useTimings']).toBe('1')
    expect(read['@_loop']).toBe('1')
    expect(xml.match(/<p:showPr\b/g)).toHaveLength(1)
  })
})

describe('setSlideLayout keeps the $ sequences of a layout part name', () => {
  async function deckWithOddLayout(): Promise<{ opened: OpenedPptx; layoutPath: string }> {
    const base = readFileSync(FIXTURE)
    const stock = await openPptx(base)
    const current = stock.archive.resolveSlideChain(stock.deck.slides[0]!.path).layoutPath
    const from = [...stock.archive.entries.keys()].find(
      (p) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(p) && p !== current,
    )!
    const layoutPath = `ppt/slideLayouts/slide${NAME_DOLLAR}Layout.xml`
    return { opened: await openPptx(await deckWithPartRenamed(base, from, layoutPath)), layoutPath }
  }

  it('re-points the existing layout relationship at it', async () => {
    const { opened, layoutPath } = await deckWithOddLayout()
    const slide = setSlideLayout(opened, 0, layoutPath)
    expect(slide).not.toBeNull()
    expectRelsResolve(opened, slide!.path)
    expect(opened.archive.resolveSlideChain(slide!.path).layoutPath).toBe(layoutPath)
  })

  it('adds the relationship a slide lost', async () => {
    const { opened, layoutPath } = await deckWithOddLayout()
    const relsPath = relsPathFor(opened.deck.slides[0]!.path)
    put(
      opened,
      relsPath,
      opened.archive
        .readText(relsPath)!
        .split(/<Relationship\b[^>]*slideLayout[^>]*\/>/)
        .join(''),
    )
    const slide = setSlideLayout(opened, 0, layoutPath)
    expect(slide).not.toBeNull()
    expectRelsResolve(opened, slide!.path)
    expect(opened.archive.resolveSlideChain(slide!.path).layoutPath).toBe(layoutPath)
  })
})

describe('setSlideNotes keeps the $ sequences of a slide part name', () => {
  it('the new notes slide points back at its slide', async () => {
    const slidePath = `ppt/slides/slide${NAME_DOLLAR}.xml`
    const opened = await openPptx(
      await deckWithPartRenamed(await createBlankPptx(), 'ppt/slides/slide1.xml', slidePath),
    )
    expect(opened.deck.slides[0]!.path).toBe(slidePath)

    expect(setSlideNotes(opened, 0, 'note')).toBe(true)

    const notesPath = notesPathForSlide(opened.archive, slidePath)!
    expectRelsResolve(opened, notesPath)
    expectRelsResolve(opened, slidePath)
    const reopened = await openPptx(await savePptx(opened))
    expect(getSlideNotes(reopened.archive, slidePath)).toBe('note')
  })
})

describe('pasteSlide keeps the $ sequences of what the source deck carries', () => {
  it('the content type of a part it brings along comes back exactly', async () => {
    const source = await openPptx(await createBlankPptx())
    const slidePath = source.deck.slides[0]!.path
    const contentType = `application/x-${DOLLAR_IN_XML}`
    source.archive.entries.set('ppt/media/blob1.dat', new Uint8Array([1, 2, 3]))
    put(
      source,
      CONTENT_TYPES,
      source.archive
        .readText(CONTENT_TYPES)!
        .split('</Types>')
        .join(`<Default Extension="dat" ContentType="${contentType}"/></Types>`),
    )
    put(
      source,
      relsPathFor(slidePath),
      source.archive
        .readText(relsPathFor(slidePath))!
        .split('</Relationships>')
        .join(
          '<Relationship Id="rId77" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/blob1.dat"/></Relationships>',
        ),
    )

    const target = await openPptx(await createBlankPptx())
    const pasted = pasteSlide(target, 0, copySlide(source, 0)!)
    expect(pasted).not.toBeNull()

    const types = target.archive.readText(CONTENT_TYPES)!
    expect(XMLValidator.validate(types)).toBe(true)
    const defaults: { '@_Extension': string; '@_ContentType': string }[] =
      parser.parse(types).Types.Default
    expect(defaults.filter((d) => d['@_Extension'] === 'dat')).toEqual([
      { '@_Extension': 'dat', '@_ContentType': `application/x-${DOLLAR}` },
    ])
    expectRelsResolve(target, pasted!.path)
  })

  it('a source master with $ in its part name is registered where it landed', async () => {
    const masterPath = `ppt/slideMasters/slide${NAME_DOLLAR}Master.xml`
    const source = await openPptx(
      await deckWithPartRenamed(
        await createBlankPptx(),
        'ppt/slideMasters/slideMaster1.xml',
        masterPath,
      ),
    )
    const target = await openPptx(readFileSync(FIXTURE))

    const pasted = pasteSlide(target, 0, copySlide(source, 0)!, { keepSourceFormatting: true })
    expect(pasted).not.toBeNull()

    expect(target.archive.has(masterPath)).toBe(true)
    expectRelsResolve(target, PRES)
    const masterOfPasted = target.archive.resolveSlideChain(pasted!.path).masterPath
    expect(masterOfPasted).toBe(masterPath)
  })
})
