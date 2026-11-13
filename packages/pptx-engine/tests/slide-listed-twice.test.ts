/**
 * presentation.xml may list one slide part twice. The deck then holds two slides with the same
 * path, two objects the editor shows and edits apart; an edit of one leaves the other its own
 * object with its own state.
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { addElement, createBlankPptx, openPptx, savePptx, setElementFill } from '../src/index'

async function slideListedTwice(): Promise<Uint8Array> {
  const opened = await openPptx(await createBlankPptx())
  addElement(opened.deck.slides[0]!, {
    kind: 'rect',
    offset: { x: 0, y: 0, cx: 914400, cy: 914400 },
  })
  const zip = await JSZip.loadAsync(await savePptx(opened))
  const pres = await zip.file('ppt/presentation.xml')!.async('string')
  const sldId = /<p:sldId\b[^>]*\/>/.exec(pres)![0]
  zip.file(
    'ppt/presentation.xml',
    pres.replace(sldId, sldId + sldId.replace(/id="\d+"/, 'id="999"')),
  )
  return zip.generateAsync({ type: 'uint8array' })
}

describe('a slide part listed twice', () => {
  it('keeps two slide objects, and the edit of the first on the first only', async () => {
    const opened = await openPptx(await slideListedTwice())
    const [first, second] = opened.deck.slides
    expect(first!.path).toBe(second!.path)
    expect(first).not.toBe(second)

    expect(setElementFill(opened, first!, first!.elements[0]!.id, '#FF0000', {})).toBe(true)

    expect(opened.deck.slides[0]).toBe(first)
    expect(opened.deck.slides[1]).toBe(second)
    expect(first!.elements[0]!.fill).toEqual({ type: 'solid', color: '#FF0000' })
    expect(second!.elements[0]!.fill).toBeUndefined()
  })
})
