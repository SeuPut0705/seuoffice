/**
 * presentation.xml may bind the PresentationML namespace as the default one instead of to
 * the `p` prefix: `<presentation xmlns="..."><sldIdLst><sldId .../></sldIdLst>`. It is the
 * same document, and its slides are the same slides: the deck opens with them. The engine
 * writes the slide list only in its `p:` form, so in such a deck a new slide cannot be
 * listed; adding one is refused before anything is written, never half done.
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  copySlide,
  createBlankPptx,
  duplicateSlide,
  insertBlankSlide,
  insertSlideWithLayout,
  openPptx,
  pasteSlide,
  savePptx,
  type OpenedPptx,
} from '../src/index'

/** A two-slide deck, and the same deck with presentation.xml written in the default namespace. */
async function decks(): Promise<{ prefixed: Uint8Array; unprefixed: Uint8Array }> {
  const opened = await openPptx(await createBlankPptx())
  duplicateSlide(opened, 0)
  const prefixed = await savePptx(opened)
  const zip = await JSZip.loadAsync(prefixed)
  const pres = await zip.file('ppt/presentation.xml')!.async('string')
  expect(pres).toContain('<p:sldId ')
  zip.file('ppt/presentation.xml', pres.replace(/<(\/?)p:/g, '<$1').replace('xmlns:p=', 'xmlns='))
  return { prefixed, unprefixed: await zip.generateAsync({ type: 'uint8array' }) }
}

/** Every part of a saved deck by name, as text. */
async function partsOf(bytes: Uint8Array): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(bytes)
  const parts: Record<string, string> = {}
  for (const [name, entry] of Object.entries(zip.files).sort(([a], [b]) => a.localeCompare(b))) {
    if (!entry.dir) parts[name] = await entry.async('string')
  }
  return parts
}

describe('a presentation.xml in the default namespace', () => {
  it('opens with the slides, the order and the slide size of the prefixed one', async () => {
    const { prefixed, unprefixed } = await decks()
    const expected = await openPptx(prefixed)
    const opened = await openPptx(unprefixed)
    expect(expected.deck.slides).toHaveLength(2)
    expect(opened.deck.slides.map((slide) => slide.path)).toEqual(
      expected.deck.slides.map((slide) => slide.path),
    )
    expect(opened.deck.size).toEqual(expected.deck.size)
  })

  const ADDERS: Array<[string, (opened: OpenedPptx, bundle: OpenedPptx) => unknown]> = [
    ['duplicateSlide', (opened) => duplicateSlide(opened, 0)],
    ['insertBlankSlide', (opened) => insertBlankSlide(opened, 0)],
    [
      'insertSlideWithLayout',
      (opened) => insertSlideWithLayout(opened, 0, opened.deck.slides[0]!.layoutPath!),
    ],
    ['pasteSlide', (opened, source) => pasteSlide(opened, 0, copySlide(source, 0)!)],
  ]

  it.each(ADDERS)('%s is refused, and the deck is saved as it was opened', async (_name, add) => {
    const { prefixed, unprefixed } = await decks()
    const untouched = await partsOf(await savePptx(await openPptx(unprefixed)))
    const opened = await openPptx(unprefixed)
    expect(add(opened, await openPptx(prefixed))).toBeNull()
    // the model shows what the file will hold
    expect(opened.deck.slides).toHaveLength(2)
    expect(await partsOf(await savePptx(opened))).toEqual(untouched)
  })

  it.each(ADDERS)('%s still adds a slide to a deck written with the prefix', async (_name, add) => {
    const { prefixed } = await decks()
    const opened = await openPptx(prefixed)
    expect(add(opened, await openPptx(prefixed))).not.toBeNull()
    expect(opened.deck.slides).toHaveLength(3)
    const reopened = await openPptx(await savePptx(opened))
    expect(reopened.deck.slides.map((slide) => slide.path)).toEqual(
      opened.deck.slides.map((slide) => slide.path),
    )
  })
})
