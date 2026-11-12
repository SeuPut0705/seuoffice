import { describe, expect, it } from 'vitest'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import {
  addElement,
  addModel3d,
  addPicture,
  copyElementData,
  copySlide,
  createBlankPptx,
  deleteSlide,
  insertBlankSlide,
  mergeSlideFromPptx,
  openPptx,
  pasteElements,
  pasteSlide,
  replacePictureBytes,
  savePptx,
  setElementLink,
  type ElementClipboardItem,
  type OpenedPptx,
} from '../src/index'
import { hasDefaultFor, maxRelationshipIdNumber } from '../src/xml-utils'
import { relsPathFor, resolveTarget } from '../src/zip'
import type { PictureElement, TextElement } from '../src/types'

/**
 * A relationship id, a part's extension and the like are whatever the deck says. They used to be
 * pasted into a RegExp as they stood: an id holding `(` threw, `.` matched any character (so the
 * relationship beside it was taken instead) and `$` anchored and matched nothing. Rewriting the
 * ids one pattern after another also let a new id that equalled a later old one be renamed twice.
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
const ID_ATTRS = ['Id', 'r:id', 'r:embed', 'r:link']

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })

const read = (opened: OpenedPptx, path: string): string => opened.archive.readText(path)!

function put(opened: OpenedPptx, path: string, xml: string): void {
  opened.archive.entries.set(path, Buffer.from(xml, 'utf8'))
}

/** `xml` with ids renamed wherever an id attribute holds them; all at once, so no id is renamed twice. */
function renameIds(xml: string, rename: Record<string, string>): string {
  const pairs = Object.entries(rename)
  const swap = (s: string, from: string, to: string) =>
    ID_ATTRS.reduce((acc, a) => acc.split(`${a}="${from}"`).join(`${a}="${to}"`), s)
  const held = pairs.reduce((acc, [from], i) => swap(acc, from, `\u0001${i}\u0001`), xml)
  return pairs.reduce((acc, [, to], i) => swap(acc, `\u0001${i}\u0001`, to), held)
}

/** The deck with relationship ids of one part renamed, in its rels part and in the part itself. */
async function withRelIds(
  bytes: Uint8Array,
  partPath: string,
  rename: Record<string, string>,
): Promise<Uint8Array> {
  const opened = await openPptx(bytes)
  put(opened, relsPathFor(partPath), renameIds(read(opened, relsPathFor(partPath)), rename))
  put(opened, partPath, renameIds(read(opened, partPath), rename))
  return savePptx(opened)
}

/** The id of the relationship from `partPath` to the part `target`. */
function relIdTo(opened: OpenedPptx, partPath: string, target: string): string {
  const rel = [...opened.archive.readRels(partPath).values()].find(
    (r) => r.targetMode !== 'External' && resolveTarget(partPath, r.target) === target,
  )
  return rel!.id
}

/** Every relationship of `partPath` must point at a part that exists. */
function expectRelsResolve(opened: OpenedPptx, partPath: string): void {
  expect(XMLValidator.validate(read(opened, relsPathFor(partPath)))).toBe(true)
  for (const rel of opened.archive.readRels(partPath).values()) {
    if (rel.targetMode === 'External') continue
    const target = resolveTarget(partPath, rel.target)
    expect(opened.archive.has(target), `${rel.id} of ${partPath}`).toBe(true)
  }
}

/** The bytes behind each picture of a slide, in order; null for one whose image is not reachable. */
function pictureBytes(opened: OpenedPptx, slideIndex: number): (Buffer | null)[] {
  return opened.deck.slides[slideIndex]!.elements.filter((e) => e.type === 'picture').map((e) => {
    const ref = (e as PictureElement).mediaRef
    const bytes = ref ? opened.archive.readBytes(ref) : null
    return bytes ? Buffer.from(bytes) : null
  })
}

/** The deck with one media part given another extension, declared in [Content_Types].xml. */
async function withMediaExtension(
  bytes: Uint8Array,
  mediaPath: string,
  ext: string,
  contentType: string,
): Promise<Uint8Array> {
  const opened = await openPptx(bytes)
  const { entries } = opened.archive
  const renamed = `${mediaPath.slice(0, mediaPath.lastIndexOf('.'))}.${ext}`
  const tail = (path: string) => path.split('/').slice(-2).join('/')
  for (const [path, content] of [...entries]) {
    const next = /\.(?:xml|rels)$/.test(path)
      ? Buffer.from(
          Buffer.from(content).toString('utf8').split(tail(mediaPath)).join(tail(renamed)),
          'utf8',
        )
      : content
    entries.delete(path)
    entries.set(path === mediaPath ? renamed : path, next)
  }
  put(
    opened,
    CONTENT_TYPES,
    read(opened, CONTENT_TYPES)
      .split('</Types>')
      .join(`<Default Extension="${ext}" ContentType="${contentType}"/></Types>`),
  )
  return savePptx(opened)
}

/** What [Content_Types].xml declares for an extension, compared as text. */
function defaultsFor(opened: OpenedPptx, ext: string): string[] {
  const xml = read(opened, CONTENT_TYPES)
  expect(XMLValidator.validate(xml)).toBe(true)
  const defaults: { '@_Extension': string; '@_ContentType': string }[] = [
    parser.parse(xml).Types.Default,
  ].flat()
  return defaults.filter((d) => d['@_Extension'] === ext).map((d) => d['@_ContentType'])
}

async function blankWithPng(): Promise<{ opened: OpenedPptx; mediaPath: string }> {
  const opened = await openPptx(await createBlankPptx())
  const pic = addPicture(opened, opened.deck.slides[0]!, { bytes: PNG, ext: 'png', offset: OFF })!
  return { opened, mediaPath: pic.mediaRef! }
}

describe('deleteSlide finds the slide by its relationship id as text', () => {
  const WORDS = ['ONE', 'TWO', 'THREE']

  function words(opened: OpenedPptx): string[] {
    return opened.deck.slides.map((s) =>
      s.elements
        .flatMap((e) => (e as TextElement).text?.paragraphs ?? [])
        .flatMap((p) => p.runs.map((r) => r.text))
        .join(''),
    )
  }

  /** Three slides, their relationship ids renamed by `rename`; delete one, save, reopen. */
  async function afterDelete(
    rename: (ids: string[]) => Record<string, string>,
    index: number,
  ): Promise<string[]> {
    const built = await openPptx(await createBlankPptx())
    insertBlankSlide(built, 0)
    insertBlankSlide(built, 1)
    WORDS.forEach((text, i) =>
      addElement(built.deck.slides[i]!, {
        kind: 'textbox',
        offset: OFF,
        paragraphs: [{ runs: [{ text }] }],
      }),
    )
    const plain = await openPptx(await savePptx(built))
    const ids = plain.deck.slides.map((s) => relIdTo(plain, PRES, s.path))

    const opened = await openPptx(await withRelIds(await savePptx(plain), PRES, rename(ids)))
    expect(words(opened)).toEqual(WORDS)
    expect(deleteSlide(opened, index)).toBe(true)

    const reopened = await openPptx(await savePptx(opened))
    expectRelsResolve(reopened, PRES)
    return words(reopened)
  }

  it('an id holding "(" does not throw', async () => {
    expect(await afterDelete((ids) => ({ [ids[1]!]: 'rId(1' }), 1)).toEqual(['ONE', 'THREE'])
  })

  it('"r.d1" does not take the slide whose id is "rXd1"', async () => {
    const rename = (ids: string[]) => ({ [ids[1]!]: 'rXd1', [ids[2]!]: 'r.d1' })
    expect(await afterDelete(rename, 2)).toEqual(['ONE', 'TWO'])
  })

  it('an id ending in "$" is found', async () => {
    expect(await afterDelete((ids) => ({ [ids[1]!]: 'rId1$' }), 1)).toEqual(['ONE', 'THREE'])
  })
})

describe('mergeSlideFromPptx re-points picture references by id as text', () => {
  /** A one-slide deck holding a PNG picture then a GIF picture, with their relationship ids. */
  async function twoPictures(): Promise<{ bytes: Uint8Array; path: string; a: string; b: string }> {
    const built = await openPptx(await createBlankPptx())
    const slide = built.deck.slides[0]!
    const a = addPicture(built, slide, { bytes: PNG, ext: 'png', offset: OFF })!
    const b = addPicture(built, slide, { bytes: GIF, ext: 'gif', offset: OFF })!
    const bytes = await savePptx(built)
    const opened = await openPptx(bytes)
    const path = opened.deck.slides[0]!.path
    return {
      bytes,
      path,
      a: relIdTo(opened, path, a.mediaRef!),
      b: relIdTo(opened, path, b.mediaRef!),
    }
  }

  /** Merge `source` into a blank deck, save, reopen: the bytes behind the merged slide's pictures. */
  async function merged(source: Uint8Array): Promise<(Buffer | null)[]> {
    const target = await openPptx(await createBlankPptx())
    expect(await mergeSlideFromPptx(target, source)).not.toBeNull()
    const reopened = await openPptx(await savePptx(target))
    const last = reopened.deck.slides.length - 1
    expectRelsResolve(reopened, reopened.deck.slides[last]!.path)
    return pictureBytes(reopened, last)
  }

  const BOTH = [Buffer.from(PNG), Buffer.from(GIF)]

  it('an id holding "(" does not throw', async () => {
    const src = await twoPictures()
    expect(await merged(await withRelIds(src.bytes, src.path, { [src.a]: 'rId(1' }))).toEqual(BOTH)
  })

  it('"r.d1" does not re-point the picture whose id is "rXd1"', async () => {
    const src = await twoPictures()
    const renamed = await withRelIds(src.bytes, src.path, { [src.a]: 'r.d1', [src.b]: 'rXd1' })
    expect(await merged(renamed)).toEqual(BOTH)
  })

  it('an id ending in "$" is re-pointed', async () => {
    const src = await twoPictures()
    expect(await merged(await withRelIds(src.bytes, src.path, { [src.a]: 'rId1$' }))).toEqual(BOTH)
  })

  it('a new id that equals a later old id is not re-pointed a second time', async () => {
    const src = await twoPictures()
    // the first picture is handed the id the second one comes in with
    const renamed = await withRelIds(src.bytes, src.path, { [src.a]: 'rId9', [src.b]: src.a })
    expect(await merged(renamed)).toEqual(BOTH)
  })

  for (const ext of ['pn+g', 'p(ng']) {
    it(`a media part ending in ".${ext}" gets its own content type`, async () => {
      const src = await blankWithPng()
      const source = await withMediaExtension(
        await savePptx(src.opened),
        src.mediaPath,
        ext,
        'image/png',
      )
      // the target already declares "png", which the pattern "pn+g" matched
      const { opened: target } = await blankWithPng()
      expect(await mergeSlideFromPptx(target, source)).not.toBeNull()

      expect(defaultsFor(target, ext)).toHaveLength(1)
      const reopened = await openPptx(await savePptx(target))
      expect(pictureBytes(reopened, reopened.deck.slides.length - 1)).toEqual([Buffer.from(PNG)])
    })
  }
})

describe('pasteElements re-points the references of a clipboard item by id as text', () => {
  const URL = 'https://example.com/report'
  const SHIFT = { dx: 152400, dy: 152400 }

  /** A picture that is also a link, copied: two relationships referenced from one element. */
  async function linkedPictureClip(): Promise<ElementClipboardItem> {
    const { opened } = await blankWithPng()
    const pic = opened.deck.slides[0]!.elements.at(-1)!
    const linked = setElementLink(opened, 0, pic.id, { kind: 'url', url: URL })!
    const clip = copyElementData(opened, linked, linked.elements.at(-1)!)
    expect(clip.rels).toHaveLength(2)
    return clip
  }

  /** The item as another process may hand it over: the same content under other ids. */
  function withIds(clip: ElementClipboardItem, rename: Record<string, string>) {
    return {
      ...clip,
      xml: renameIds(clip.xml, rename),
      rels: clip.rels.map((rel) => ({ ...rel, rid: rename[rel.rid] ?? rel.rid })),
    }
  }

  /** Paste into a blank deck, save, reopen: what the pasted picture shows and where it links. */
  async function pasted(clip: ElementClipboardItem) {
    const target = await openPptx(await createBlankPptx())
    expect(pasteElements(target, 0, [clip], SHIFT)).not.toBeNull()
    const reopened = await openPptx(await savePptx(target))
    const slide = reopened.deck.slides[0]!
    expectRelsResolve(reopened, slide.path)
    const xml = slide.elements.at(-1)!.anchor.originalXml
    const rels = reopened.archive.readRels(slide.path)
    const linkId = /<a:hlinkClick\b[^>]*\br:id="([^"]*)"/.exec(xml)?.[1] ?? ''
    return { image: pictureBytes(reopened, 0).at(-1), link: rels.get(linkId)?.target }
  }

  const RIGHT = { image: Buffer.from(PNG), link: URL }
  const idOf = (clip: ElementClipboardItem, kind: string) =>
    clip.rels.find((rel) => rel.type.endsWith(kind))!.rid

  it('an id holding "(" does not throw', async () => {
    const clip = await linkedPictureClip()
    expect(await pasted(withIds(clip, { [idOf(clip, '/image')]: 'rId(1' }))).toEqual(RIGHT)
  })

  it('"r.d1" does not re-point the reference whose id is "rXd1"', async () => {
    const clip = await linkedPictureClip()
    const [first, second] = clip.rels
    const renamed = withIds(clip, { [first!.rid]: 'r.d1', [second!.rid]: 'rXd1' })
    expect(await pasted(renamed)).toEqual(RIGHT)
  })

  it('an id ending in "$" is re-pointed', async () => {
    const clip = await linkedPictureClip()
    expect(await pasted(withIds(clip, { [idOf(clip, '/image')]: 'rId1$' }))).toEqual(RIGHT)
  })

  it('a new id that equals a later old id is not re-pointed a second time', async () => {
    const clip = await linkedPictureClip()
    const blank = await openPptx(await createBlankPptx())
    const taken = maxRelationshipIdNumber(read(blank, relsPathFor(blank.deck.slides[0]!.path)))
    const [first, second] = clip.rels
    // the first reference is handed the id the second one comes in with
    const renamed = withIds(clip, { [first!.rid]: 'rId70', [second!.rid]: `rId${taken + 1}` })
    expect(await pasted(renamed)).toEqual(RIGHT)
  })
})

describe('replacePictureBytes re-points the cached rendering of a 3D model by id as text', () => {
  /** Replace the poster of a 3D model whose poster relationship is `id`; save and reopen. */
  async function afterReplace(id: string) {
    const built = await openPptx(await createBlankPptx())
    expect(
      addModel3d(built, 0, {
        bytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
        ext: 'glb',
        offset: OFF,
      }),
    ).not.toBeNull()
    const bytes = await savePptx(built)
    const plain = await openPptx(bytes)
    const path = plain.deck.slides[0]!.path
    const poster = [...plain.archive.readRels(path).values()].find((r) =>
      r.type.endsWith('/image'),
    )!

    const opened = await openPptx(await withRelIds(bytes, path, { [poster.id]: id }))
    const slide = opened.deck.slides[0]!
    const model = slide.elements.filter((e) => e.type === 'picture').at(-1)!
    expect(replacePictureBytes(opened, slide, model.id, GIF, 'gif')).toBe(true)

    const reopened = await openPptx(await savePptx(opened))
    expectRelsResolve(reopened, path)
    const xml = read(reopened, path)
    const cached = /<am3d:blip\b[^>]*\br:embed="([^"]*)"/.exec(xml)?.[1] ?? ''
    const fallback = /<a:blip\b[^>]*\br:embed="([^"]*)"/.exec(xml)?.[1]
    const rel = reopened.archive.readRels(path).get(cached)
    const shown = rel ? reopened.archive.readBytes(resolveTarget(path, rel.target)) : null
    return { sameAsFallback: cached === fallback, shown: shown ? Buffer.from(shown) : null }
  }

  for (const id of ['rId77', 'rId(1', 'rId1$']) {
    it(`a poster relationship named "${id}"`, async () => {
      expect(await afterReplace(id)).toEqual({ sameAsFallback: true, shown: Buffer.from(GIF) })
    })
  }
})

describe('copying a slide to another deck reads an extension as text', () => {
  for (const ext of ['pn+g', 'p(ng']) {
    it(`the content type declared for ".${ext}" travels with the part`, async () => {
      const src = await blankWithPng()
      const source = await openPptx(
        await withMediaExtension(await savePptx(src.opened), src.mediaPath, ext, 'image/x-test'),
      )
      // the target already declares "png", which the pattern "pn+g" matched
      const { opened: target } = await blankWithPng()

      const pastedSlide = pasteSlide(target, 0, copySlide(source, 0)!)
      expect(pastedSlide).not.toBeNull()

      expect(defaultsFor(target, ext)).toEqual(['image/x-test'])
      expectRelsResolve(target, pastedSlide!.path)
      const reopened = await openPptx(await savePptx(target))
      expect(pictureBytes(reopened, 1)).toEqual([Buffer.from(PNG)])
    })
  }
})

describe('hasDefaultFor compares the extension as text', () => {
  const types = (ext: string) =>
    `<Types><Default Extension="${ext}" ContentType="image/png"/><Default ContentType='image/gif' Extension = 'gif'/></Types>`

  it('a pattern character in the extension is not a pattern', () => {
    expect(hasDefaultFor(types('png'), 'p.g')).toBe(false)
    expect(hasDefaultFor(types('png'), 'pn+g')).toBe(false)
    expect(hasDefaultFor(types('png'), 'p(ng')).toBe(false)
    expect(hasDefaultFor(types('p(ng'), 'p(ng')).toBe(true)
  })

  it('finds an extension in either quote form and, as OPC compares them, in either case', () => {
    expect(hasDefaultFor(types('png'), 'gif')).toBe(true)
    expect(hasDefaultFor(types('PNG'), 'png')).toBe(true)
    expect(hasDefaultFor(types('png'), 'jpeg')).toBe(false)
  })
})
