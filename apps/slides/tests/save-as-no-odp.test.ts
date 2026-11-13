/**
 * The Slides app writes no ODP: the formats a deck can be saved or copied to
 * are PowerPoint, PDF and PNG. A deck whose runs or pictures are hidden from
 * the AI records the marks in the PPTX package, which ODP has no place for, so
 * the app must not grow an ODP writer without refusing marked decks first.
 * A typed `.odp` name is a PowerPoint file under that name, marks included,
 * never an ODP conversion.
 */
import { describe, expect, it } from 'vitest'

import { resolveSlidesSaveAsPick, slidesSaveAsFilters } from '../src/main/save-as-formats'
import { OPENABLE_DECK_EXTENSIONS } from '../src/shared/deck-open-formats'

describe('Save As in the Slides app', () => {
  it('offers no ODP or OTP type', () => {
    const extensions = slidesSaveAsFilters((key) => key).flatMap((filter) => filter.extensions)
    expect(extensions).toEqual(['pptx', 'pdf', 'png'])
  })

  it('writes a typed .odp name as the PowerPoint deck, which carries the marks', () => {
    expect(resolveSlidesSaveAsPick('/docs/deck.odp')).toEqual({
      kind: 'pptx',
      path: '/docs/deck.odp',
    })
    expect(resolveSlidesSaveAsPick('/docs/deck.otp').kind).toBe('pptx')
  })

  it('opens ODP only through the import filter, which converts a copy', () => {
    expect(OPENABLE_DECK_EXTENSIONS).toContain('odp')
  })
})
