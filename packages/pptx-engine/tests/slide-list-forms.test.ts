/**
 * The slide list of presentation.xml as another producer may write it: single quotes, white
 * space around `=`, an extension list inside an entry. A slide added after another one is
 * listed right after it, so the saved file has the order the screen shows.
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { createBlankPptx, duplicateSlide, openPptx, savePptx, type OpenedPptx } from '../src/index'

/** A two-slide deck with each slide entry of presentation.xml rewritten by `rewrite`. */
async function deckWith(rewrite: (entry: string) => string): Promise<OpenedPptx> {
  const made = await openPptx(await createBlankPptx())
  duplicateSlide(made, 0)
  const zip = await JSZip.loadAsync(await savePptx(made))
  const pres = await zip.file('ppt/presentation.xml')!.async('string')
  const next = pres.replace(/<p:sldId\s[^>]*\/>/g, rewrite)
  expect(next).not.toBe(pres)
  zip.file('ppt/presentation.xml', next)
  return openPptx(await zip.generateAsync({ type: 'uint8array' }))
}

describe('a slide list another producer wrote', () => {
  it.each([
    ['single quotes', (entry: string) => entry.replace(/"/g, "'")],
    ['spaces around the equals signs', (entry: string) => entry.replace(/=/g, ' = ')],
    [
      'an extension list inside each entry',
      (entry: string) =>
        entry.replace(
          '/>',
          '><p:extLst><p:ext uri="{00000000-0000-0000-0000-000000000000}"/></p:extLst></p:sldId>',
        ),
    ],
  ])(
    'with %s: a duplicate lands right after its source, in the file as on screen',
    async (_what, rewrite) => {
      const opened = await deckWith(rewrite)
      expect(opened.deck.slides).toHaveLength(2)
      const added = duplicateSlide(opened, 0)
      expect(added).not.toBeNull()
      expect(opened.deck.slides.indexOf(added!)).toBe(1)
      const reopened = await openPptx(await savePptx(opened))
      expect(reopened.deck.slides.map((slide) => slide.path)).toEqual(
        opened.deck.slides.map((slide) => slide.path),
      )
    },
  )
})
