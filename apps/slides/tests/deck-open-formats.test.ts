import { describe, expect, it } from 'vitest'
import {
  OPENABLE_DECK_EXTENSIONS,
  deckExtension,
  isOpenableDeckPath,
} from '../src/shared/deck-open-formats'

/**
 * The open guard and the open dialog's picker filter read this one list. An
 * `.otp` template missing from it is unreachable from the standalone app even
 * though the shell offers it.
 */
describe('OPENABLE_DECK_EXTENSIONS', () => {
  it('covers every extension the guard accepts', () => {
    expect(OPENABLE_DECK_EXTENSIONS).toEqual(['pptx', 'ppt', 'odp', 'otp'])
    for (const extension of OPENABLE_DECK_EXTENSIONS) {
      expect(isOpenableDeckPath(`/tmp/Quarterly Review.${extension.toUpperCase()}`)).toBe(true)
    }
  })

  it('rejects the neighbouring formats Slides does not open', () => {
    for (const path of ['/tmp/notes.txt', '/tmp/keynote.key', '/tmp/book.ods']) {
      expect(isOpenableDeckPath(path)).toBe(false)
    }
  })
})

describe('deckExtension', () => {
  it('lowercases the trailing extension and reports none when absent', () => {
    expect(deckExtension('/tmp/Quarterly Review.OTP')).toBe('otp')
    expect(deckExtension('/tmp/no-extension')).toBe('')
  })

  it('never turns a dotfile into an import', () => {
    // the trailing segment of a dotfile is not a format, so the import route
    // leaves such a path alone whatever the helper makes of it
    expect(isOpenableDeckPath('/tmp/.hidden')).toBe(false)
  })
})
