import { describe, expect, it } from 'vitest'
import {
  addElement,
  addPicture,
  copyElementData,
  createBlankPptx,
  ensureRunLinkRels,
  getElementLink,
  getRunLinks,
  getSlideLinks,
  openPptx,
  pasteElements,
  savePptx,
  setElementLink,
  type OpenedPptx,
} from '../src/index'
import { relsPathFor } from '../src/zip'
import type { PictureElement } from '../src/types'

/**
 * A relationship id is whatever name the producer chose: PowerPoint writes `rId7`, others write
 * `R7a3f`, `id5` or `rIdImg`. Two readers recognised an id only in the `rId<number>` form: on a
 * deck written another way a copied element left its relationships behind (a pasted picture had
 * no image) and the link on a shape was not read at all.
 */

const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)
const OFF = { x: 914400, y: 914400, cx: 1828800, cy: 914400 }
const SHAPE_URL = 'https://example.com/report'
const RUN_URL = 'https://example.com/notes'
const ID_ATTRS = ['Id', 'r:id', 'r:embed', 'r:link']
const OTHER_FORMS = [
  (n: number) => `R7a3f${n}`,
  (n: number) => `id${n}`,
  (n: number) => `rIdImg${n}`,
]

/** One slide: a picture that is a link, and a text box whose run is a link. */
async function deck(): Promise<Uint8Array> {
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

/** `xml` with ids renamed wherever an id attribute holds them; all at once, so no id is renamed twice. */
function renameIds(xml: string, rename: Map<string, string>): string {
  const pairs = [...rename]
  const swap = (s: string, from: string, to: string) =>
    ID_ATTRS.reduce((acc, a) => acc.split(`${a}="${from}"`).join(`${a}="${to}"`), s)
  const held = pairs.reduce((acc, [from], i) => swap(acc, from, `\u0001${i}\u0001`), xml)
  return pairs.reduce((acc, [, to], i) => swap(acc, `\u0001${i}\u0001`, to), held)
}

/** The deck with every relationship id under ppt/ given another form, in the rels part and in the part that refers to it. */
async function withOtherIdForms(bytes: Uint8Array): Promise<Uint8Array> {
  const opened = await openPptx(bytes)
  const { archive } = opened
  const put = (path: string, xml: string) => archive.entries.set(path, Buffer.from(xml, 'utf8'))
  for (const part of [...archive.entries.keys()]) {
    const relsPath = relsPathFor(part)
    const rels = part.startsWith('ppt/') ? archive.readText(relsPath) : null
    if (!rels) continue
    const rename = new Map(
      [...rels.matchAll(/\bId="([^"]*)"/g)].map((m, n) => [
        m[1]!,
        OTHER_FORMS[n % OTHER_FORMS.length]!(n),
      ]),
    )
    put(relsPath, renameIds(rels, rename))
    put(part, renameIds(archive.readText(part)!, rename))
  }
  return savePptx(opened)
}

const pictureOf = (opened: OpenedPptx): PictureElement =>
  opened.deck.slides[0]!.elements.find((e) => e.type === 'picture') as PictureElement

function imageOf(opened: OpenedPptx, pic: PictureElement | undefined): Buffer | null {
  const bytes = pic?.mediaRef ? opened.archive.readBytes(pic.mediaRef) : null
  return bytes ? Buffer.from(bytes) : null
}

describe.each([
  ['written as rId<number> (control)', false],
  ['written in other forms', true],
])('a deck whose relationship ids are %s', (_label, otherForms) => {
  const open = async () => {
    const plain = await deck()
    return openPptx(otherForms ? await withOtherIdForms(plain) : plain)
  }

  it('opens with its picture', async () => {
    const opened = await open()
    const ids = [...opened.archive.readRels(opened.deck.slides[0]!.path).keys()]
    expect(ids.every((id) => /^rId\d+$/.test(id))).toBe(!otherForms)
    expect(ids.some((id) => /^rId\d+$/.test(id))).toBe(!otherForms)
    expect(imageOf(opened, pictureOf(opened))).toEqual(Buffer.from(PNG))
  })

  it('the link on a shape is read with its target', async () => {
    const opened = await open()
    const pic = pictureOf(opened)
    expect(getElementLink(opened, 0, pic.id)).toEqual({ kind: 'url', url: SHAPE_URL })
    expect(getSlideLinks(opened, 0)).toContainEqual({
      elementId: pic.id,
      target: { kind: 'url', url: SHAPE_URL },
    })
  })

  it('the link on a run is read with its target', async () => {
    const opened = await open()
    expect(getRunLinks(opened, 0).map((l) => l.target)).toEqual([{ kind: 'url', url: RUN_URL }])
  })

  it('a copied picture takes its image and its link to another deck', async () => {
    const opened = await open()
    const clip = copyElementData(opened, opened.deck.slides[0]!, pictureOf(opened))
    expect(clip.rels.map((rel) => rel.type.split('/').pop()).sort()).toEqual(['hyperlink', 'image'])

    const target = await openPptx(await createBlankPptx())
    expect(pasteElements(target, 0, [clip], { dx: 152400, dy: 152400 })).not.toBeNull()
    const reopened = await openPptx(await savePptx(target))
    const pasted = pictureOf(reopened)
    expect(imageOf(reopened, pasted)).toEqual(Buffer.from(PNG))
    expect(getElementLink(reopened, 0, pasted.id)).toEqual({ kind: 'url', url: SHAPE_URL })
  })

  it('a copied picture pasted on its own slide keeps its image and its link', async () => {
    const opened = await open()
    const clip = copyElementData(opened, opened.deck.slides[0]!, pictureOf(opened))
    expect(pasteElements(opened, 0, [clip], { dx: 152400, dy: 152400 })).not.toBeNull()
    const reopened = await openPptx(await savePptx(opened))
    const pictures = reopened.deck.slides[0]!.elements.filter((e) => e.type === 'picture')
    expect(pictures).toHaveLength(2)
    for (const pic of pictures) {
      expect(imageOf(reopened, pic as PictureElement)).toEqual(Buffer.from(PNG))
      expect(getElementLink(reopened, 0, pic.id)).toEqual({ kind: 'url', url: SHAPE_URL })
    }
  })
})
