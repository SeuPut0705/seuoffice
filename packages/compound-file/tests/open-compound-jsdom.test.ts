// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { openOle2Container } from '../src/index'

/**
 * The renderer-side suites (slides, docs) run under jsdom, where a Node Buffer is not an
 * instance of the page's Uint8Array. The opener's streams must come back whole there too.
 */
describe('opening an OLE2 container under jsdom', () => {
  const deck = readFileSync(
    join(import.meta.dirname, '../../file-parse/tests/fixtures/legacy-sample.ppt'),
  )

  it.each([
    ['a Node Buffer', (): Uint8Array => deck],
    ['a Uint8Array of the page', (): Uint8Array => Uint8Array.from(deck)],
  ])('hands back the bytes of every stream of %s', (_what, bytes) => {
    const opened = openOle2Container(bytes(), { maxBytes: 1 << 26, maxStreamBytes: 1 << 26 })
    if (!opened.ok) throw new Error(opened.detail)
    const document = opened.container.stream('PowerPoint Document')
    // the stream is most of this small deck, and found in it byte for byte
    expect(document?.length).toBeGreaterThan(4096)
    expect(deck.includes(Buffer.from(document!.subarray(0, 512)))).toBe(true)
  })
})
