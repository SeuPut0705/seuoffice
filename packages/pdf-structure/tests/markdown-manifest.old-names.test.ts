/** The asset list's name, current or old, is never taken for a picture's name. */
import { describe, expect, it } from 'vitest'
import { mergeAssetManifest } from '../src/markdown'

const h = (c: string) => c.repeat(64)

describe.each(['.genoffice-assets.json', '.seuoffice-assets.json'])('the list name %s', (name) => {
  it('is refused as a converted picture', () => {
    expect(() => mergeAssetManifest(null, 'book.md', [{ name, sha256: h('a') }])).toThrow()
  })

  it('is refused in a list found on disk', () => {
    const existing = JSON.stringify({
      version: 1,
      files: [{ name, sha256: h('a') }],
      documents: {},
      pending: {},
    })
    expect(() => mergeAssetManifest(existing, 'book.md', [])).toThrow()
  })

  it('is refused as the document name', () => {
    expect(() => mergeAssetManifest(null, name, [])).toThrow()
  })
})
