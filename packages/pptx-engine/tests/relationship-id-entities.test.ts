import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import {
  addElement,
  addModel3d,
  addPicture,
  copyElementData,
  copySlide,
  createBlankPptx,
  deleteSlide,
  ensureRunLinkRels,
  getElementLink,
  getRunLinks,
  insertBlankSlide,
  mergeSlideFromPptx,
  openPptx,
  pasteElements,
  pasteSlide,
  replacePictureBytes,
  savePptx,
  setElementLink,
  type OpenedPptx,
} from '../src/index'
import { attributeOf } from '../src/xml-utils'
import { relsPathFor, resolveTarget } from '../src/zip'
import type { PictureElement, TextElement } from '../src/types'

/**
 * XML lets one value be written several ways: `&amp;`, `&#38;` and `&#x26;` are the same `&`, and
 * `&#49;` is `1`. A relationship id read by the parser came out decoded (the named entities only)
 * and one read by a pattern came out as written, so an id written one way in the rels part and
 * another way in the part that refers to it was two different ids: the slide was not listed, the
 * picture had no image, the link went nowhere.
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
const SHAPE_URL = 'https://example.com/report'
const RUN_URL = 'https://example.com/notes'
const ID_ATTRS = ['Id', 'r:id', 'r:embed', 'r:link']

/** The id `r&1`, and the id `l&2`, each as the rels part and as the referring part write it. */
const WRITINGS = [
  { rels: ['r&amp;1', 'l&amp;2'], part: ['r&#38;1', 'l&#38;2'] },
  { rels: ['r&#x26;1', 'l&#38;2'], part: ['r&amp;1', 'l&#x26;2'] },
] as const

const read = (opened: OpenedPptx, path: string): string => opened.archive.readText(path)!

/** `xml` with the id attributes holding `from` rewritten to hold the text `to`, as written. */
function writeIds(xml: string, rename: Record<string, string>): string {
  return Object.entries(rename).reduce(
    (acc, [from, to]) =>
      ID_ATTRS.reduce((s, a) => s.split(`${a}="${from}"`).join(`${a}="${to}"`), acc),
    xml,
  )
}

/** The deck with ids of one part rewritten: one text in its rels part, another in the part itself. */
async function withIdsWritten(
  bytes: Uint8Array,
  partPath: string,
  inRels: Record<string, string>,
  inPart: Record<string, string>,
): Promise<Uint8Array> {
  const opened = await openPptx(bytes)
  const put = (path: string, xml: string) =>
    opened.archive.entries.set(path, Buffer.from(xml, 'utf8'))
  put(relsPathFor(partPath), writeIds(read(opened, relsPathFor(partPath)), inRels))
  put(partPath, writeIds(read(opened, partPath), inPart))
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

/** Every relationship of `partPath` must point at a part that exists, from a well-formed rels part. */
function expectRelsResolve(opened: OpenedPptx, partPath: string): void {
  expect(XMLValidator.validate(read(opened, relsPathFor(partPath)))).toBe(true)
  expect(XMLValidator.validate(read(opened, partPath))).toBe(true)
  for (const rel of opened.archive.readRels(partPath).values()) {
    if (rel.targetMode === 'External') continue
    const target = resolveTarget(partPath, rel.target)
    expect(opened.archive.has(target), `${rel.id} of ${partPath}`).toBe(true)
  }
}

const picturesOf = (opened: OpenedPptx, slideIndex: number): PictureElement[] =>
  opened.deck.slides[slideIndex]!.elements.filter((e) => e.type === 'picture') as PictureElement[]

function imageOf(opened: OpenedPptx, pic: PictureElement | undefined): Buffer | null {
  const bytes = pic?.mediaRef ? opened.archive.readBytes(pic.mediaRef) : null
  return bytes ? Buffer.from(bytes) : null
}

const imagesOf = (opened: OpenedPptx, slideIndex: number): (Buffer | null)[] =>
  picturesOf(opened, slideIndex).map((pic) => imageOf(opened, pic))

const textBoxOf = (opened: OpenedPptx): TextElement =>
  opened.deck.slides[0]!.elements.find((e) => e.type === 'text') as TextElement

/** One slide: a picture that is a link, and a text box whose run is a link. */
async function linkedDeck(): Promise<Uint8Array> {
  const opened = await openPptx(await createBlankPptx())
  const pic = addPicture(opened, opened.deck.slides[0]!, { bytes: PNG, ext: 'png', offset: OFF })!
  expect(setElementLink(opened, 0, pic.id, { kind: 'url', url: SHAPE_URL })).not.toBeNull()
  const box = addElement(opened.deck.slides[0]!, {
    kind: 'textbox',
    offset: OFF,
    paragraphs: [{ runs: [{ text: 'notes' }] }],
  })
  box.text!.paragraphs[0]!.runs[0]!.hyperlink = RUN_URL
  box.dirty = true
  expect(ensureRunLinkRels(opened, 0, box.text!.paragraphs)).toBe(true)
  return savePptx(opened)
}

describe.each(WRITINGS)('an id written $rels in the rels part and $part beside it', (w) => {
  /** The linked deck with the image as `r&1`, the shape link as `l&2` and the run link as `l&2x`. */
  async function linked(): Promise<OpenedPptx> {
    const bytes = await linkedDeck()
    const plain = await openPptx(bytes)
    const path = plain.deck.slides[0]!.path
    const image = relId(plain, path, (r) => r.type.endsWith('/image'))
    const shapeLink = relId(plain, path, (r) => r.target === SHAPE_URL)
    const runLink = relId(plain, path, (r) => r.target === RUN_URL)
    return openPptx(
      await withIdsWritten(
        bytes,
        path,
        { [image]: w.rels[0], [shapeLink]: w.rels[1], [runLink]: `${w.rels[1]}x` },
        { [image]: w.part[0], [shapeLink]: w.part[1], [runLink]: `${w.part[1]}x` },
      ),
    )
  }

  it('deleting a slide finds it', async () => {
    const words = (opened: OpenedPptx) =>
      opened.deck.slides.map((s) =>
        s.elements
          .flatMap((e) => (e as TextElement).text?.paragraphs ?? [])
          .flatMap((p) => p.runs.map((r) => r.text))
          .join(''),
      )
    const built = await openPptx(await createBlankPptx())
    insertBlankSlide(built, 0)
    insertBlankSlide(built, 1)
    ;['ONE', 'TWO', 'THREE'].forEach((text, i) =>
      addElement(built.deck.slides[i]!, {
        kind: 'textbox',
        offset: OFF,
        paragraphs: [{ runs: [{ text }] }],
      }),
    )
    const bytes = await savePptx(built)
    const plain = await openPptx(bytes)
    const second = relId(
      plain,
      PRES,
      (r) => resolveTarget(PRES, r.target) === plain.deck.slides[1]!.path,
    )

    const opened = await openPptx(
      await withIdsWritten(bytes, PRES, { [second]: w.rels[0] }, { [second]: w.part[0] }),
    )
    expect(words(opened)).toEqual(['ONE', 'TWO', 'THREE'])
    expect(deleteSlide(opened, 1)).toBe(true)

    const reopened = await openPptx(await savePptx(opened))
    expectRelsResolve(reopened, PRES)
    expect(words(reopened)).toEqual(['ONE', 'THREE'])
  })

  it('merging a slide brings its picture', async () => {
    const built = await openPptx(await createBlankPptx())
    const slide = built.deck.slides[0]!
    const a = addPicture(built, slide, { bytes: PNG, ext: 'png', offset: OFF })!
    addPicture(built, slide, { bytes: GIF, ext: 'gif', offset: OFF })
    const bytes = await savePptx(built)
    const plain = await openPptx(bytes)
    const path = plain.deck.slides[0]!.path
    const first = relId(plain, path, (r) => resolveTarget(path, r.target) === a.mediaRef)
    const source = await withIdsWritten(bytes, path, { [first]: w.rels[0] }, { [first]: w.part[0] })

    const target = await openPptx(await createBlankPptx())
    expect(await mergeSlideFromPptx(target, source)).not.toBeNull()
    const reopened = await openPptx(await savePptx(target))
    const last = reopened.deck.slides.length - 1
    expectRelsResolve(reopened, reopened.deck.slides[last]!.path)
    expect(imagesOf(reopened, last)).toEqual([Buffer.from(PNG), Buffer.from(GIF)])
  })

  it('replacing a picture re-points it and drops the old image', async () => {
    const opened = await linked()
    const slide = opened.deck.slides[0]!
    const pic = picturesOf(opened, 0)[0]!
    const oldMedia = pic.mediaRef!
    expect(imageOf(opened, pic)).toEqual(Buffer.from(PNG))
    expect(replacePictureBytes(opened, slide, pic.id, GIF, 'gif')).toBe(true)

    const reopened = await openPptx(await savePptx(opened))
    expectRelsResolve(reopened, slide.path)
    expect(imagesOf(reopened, 0)).toEqual([Buffer.from(GIF)])
    expect(reopened.archive.has(oldMedia)).toBe(false)
    const targets = [...reopened.archive.readRels(slide.path).values()].map((r) => r.target)
    expect(targets.filter((t) => t.includes('/media/'))).toHaveLength(1)
  })

  it('replacing the poster of a 3D model re-points its cached rendering too', async () => {
    const built = await openPptx(await createBlankPptx())
    addModel3d(built, 0, {
      bytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
      ext: 'glb',
      offset: OFF,
    })
    const bytes = await savePptx(built)
    const plain = await openPptx(bytes)
    const path = plain.deck.slides[0]!.path
    const poster = relId(plain, path, (r) => r.type.endsWith('/image'))
    // the fallback picture writes the id one way, the cached rendering the other
    const written = await openPptx(
      await withIdsWritten(bytes, path, { [poster]: w.rels[0] }, { [poster]: w.part[0] }),
    )
    written.archive.entries.set(
      path,
      Buffer.from(
        read(written, path).replace(
          /(<am3d:blip\b[^>]*\br:embed=")[^"]*(")/,
          (_all, head: string, tail: string) => `${head}${w.rels[0]}${tail}`,
        ),
        'utf8',
      ),
    )

    const opened = await openPptx(await savePptx(written))
    const slide = opened.deck.slides[0]!
    expect(replacePictureBytes(opened, slide, picturesOf(opened, 0).at(-1)!.id, GIF, 'gif')).toBe(
      true,
    )

    const reopened = await openPptx(await savePptx(opened))
    expectRelsResolve(reopened, path)
    const xml = read(reopened, path)
    const cached = attributeOf(/<am3d:blip\b[^>]*>/.exec(xml)![0], 'r:embed')!
    expect(cached).toBe(attributeOf(/<a:blip\b[^>]*>/.exec(xml)![0], 'r:embed'))
    const rel = reopened.archive.readRels(path).get(cached)!
    expect(Buffer.from(reopened.archive.readBytes(resolveTarget(path, rel.target))!)).toEqual(
      Buffer.from(GIF),
    )
  })

  it('a pasted element takes its image and its link along', async () => {
    const opened = await linked()
    const clip = copyElementData(opened, opened.deck.slides[0]!, picturesOf(opened, 0)[0]!)
    expect(clip.rels.map((rel) => rel.type.split('/').pop()).sort()).toEqual(['hyperlink', 'image'])

    const target = await openPptx(await createBlankPptx())
    expect(pasteElements(target, 0, [clip], { dx: 152400, dy: 152400 })).not.toBeNull()
    const reopened = await openPptx(await savePptx(target))
    expectRelsResolve(reopened, reopened.deck.slides[0]!.path)
    const pasted = picturesOf(reopened, 0)[0]!
    expect(imageOf(reopened, pasted)).toEqual(Buffer.from(PNG))
    expect(getElementLink(reopened, 0, pasted.id)).toEqual({ kind: 'url', url: SHAPE_URL })
  })

  it('the links on a shape and on a run are read', async () => {
    const opened = await linked()
    expect(getElementLink(opened, 0, picturesOf(opened, 0)[0]!.id)).toEqual({
      kind: 'url',
      url: SHAPE_URL,
    })
    expect(getRunLinks(opened, 0).map((l) => l.target)).toEqual([{ kind: 'url', url: RUN_URL }])
    expect(textBoxOf(opened).text!.paragraphs[0]!.runs[0]!.hyperlink).toBe(RUN_URL)
  })

  it('editing the words of a linked run keeps the link', async () => {
    const opened = await linked()
    const box = textBoxOf(opened)
    box.text!.paragraphs[0]!.runs[0]!.text = 'notes, edited'
    box.dirty = true

    const reopened = await openPptx(await savePptx(opened))
    expectRelsResolve(reopened, reopened.deck.slides[0]!.path)
    expect(textBoxOf(reopened).text!.paragraphs[0]!.runs[0]!.text).toBe('notes, edited')
    expect(getRunLinks(reopened, 0).map((l) => l.target)).toEqual([{ kind: 'url', url: RUN_URL }])
  })

  it('a linked run written again from the model carries a well-formed id', async () => {
    const opened = await linked()
    const box = textBoxOf(opened)
    const runs = box.text!.paragraphs[0]!.runs
    // a second run makes the text body be rebuilt from the model
    runs.push({ ...runs[0]!, text: ' and more' })
    box.dirty = true

    const reopened = await openPptx(await savePptx(opened))
    expectRelsResolve(reopened, reopened.deck.slides[0]!.path)
    expect(getRunLinks(reopened, 0).map((l) => l.target)).toEqual([
      { kind: 'url', url: RUN_URL },
      { kind: 'url', url: RUN_URL },
    ])
  })

  it('a slide pasted into another deck keeps its ids in a well-formed rels part', async () => {
    const source = await linked()
    const target = await openPptx(await createBlankPptx())
    const pasted = pasteSlide(target, 0, copySlide(source, 0)!)
    expect(pasted).not.toBeNull()

    const reopened = await openPptx(await savePptx(target))
    expectRelsResolve(reopened, pasted!.path)
    expect(imagesOf(reopened, 1)).toEqual([Buffer.from(PNG)])
    expect(getElementLink(reopened, 1, picturesOf(reopened, 1)[0]!.id)).toEqual({
      kind: 'url',
      url: SHAPE_URL,
    })
    expect(getRunLinks(reopened, 1).map((l) => l.target)).toEqual([{ kind: 'url', url: RUN_URL }])
  })
})

describe('an id written with a numeric reference for an ordinary character', () => {
  it('a new relationship is not given the id "rId&#49;" already names', async () => {
    const bytes = await createBlankPptx()
    const plain = await openPptx(bytes)
    const path = plain.deck.slides[0]!.path
    const layout = relId(plain, path, (r) => r.type.endsWith('/slideLayout'))
    expect(layout).toBe('rId1')
    const opened = await openPptx(await withIdsWritten(bytes, path, { rId1: 'rId&#49;' }, {}))

    const pic = addPicture(opened, opened.deck.slides[0]!, { bytes: PNG, ext: 'png', offset: OFF })
    expect(pic).not.toBeNull()

    const reopened = await openPptx(await savePptx(opened))
    expectRelsResolve(reopened, path)
    const ids = [...read(reopened, relsPathFor(path)).matchAll(/<Relationship\b[^>]*>/g)].map((m) =>
      attributeOf(m[0], 'Id'),
    )
    expect(ids).toContain('rId1')
    expect(new Set(ids).size).toBe(ids.length)
    expect(reopened.archive.resolveSlideChain(path).layoutPath).toBe(
      plain.archive.resolveSlideChain(path).layoutPath,
    )
    expect(imagesOf(reopened, 0)).toEqual([Buffer.from(PNG)])
  })

  it('attributeOf hands back the value, not its spelling', () => {
    const tag = `<a:blip r:embed="r&#38;1" r:link='a&quot;b&apos;c&lt;d&gt;e&#x41;' alt="&amp;#38;"/>`
    expect(attributeOf(tag, 'r:embed')).toBe('r&1')
    expect(attributeOf(tag, 'r:link')).toBe('a"b\'c<d>eA')
    // decoded once: an escaped ampersand followed by "#38;" is those five characters
    expect(attributeOf(tag, 'alt')).toBe('&#38;')
  })
})
