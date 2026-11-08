/**
 * App-owned asset manifest (`assets/.genoffice-assets.json`): the converter's
 * entries merge in the format apps/markdown/src/main/asset-lifecycle.ts reads.
 */
import { describe, expect, it } from 'vitest'
import { ASSET_MANIFEST_FILENAME, mergeAssetManifest } from '../src/markdown'

const h = (c: string) => c.repeat(64)
const rec = (c: string, ext = 'png') => ({ name: `${h(c)}.${ext}`, sha256: h(c) })

describe('mergeAssetManifest', () => {
  it('uses the editor manifest file name', () => {
    expect(ASSET_MANIFEST_FILENAME).toBe('.genoffice-assets.json')
  })

  it('creates a manifest when there is none', () => {
    const out = mergeAssetManifest(null, 'book.md', [rec('b'), rec('a')])
    expect(out.endsWith('}\n')).toBe(true)
    expect(JSON.parse(out)).toEqual({
      version: 1,
      files: [rec('a'), rec('b')],
      documents: { 'book.md': [rec('a').name, rec('b').name] },
      pending: {},
    })
    // same layout the editor writes: two-space JSON with a final newline
    expect(out).toBe(`${JSON.stringify(JSON.parse(out), null, 2)}\n`)
  })

  it('keeps foreign files, documents and pending entries', () => {
    const existing = JSON.stringify({
      version: 1,
      files: [{ name: 'pasted.png', sha256: h('c') }, rec('a')],
      documents: { 'notes.md': ['pasted.png'], 'book.md': ['old.png'] },
      pending: { 'draft.md': ['pasted.png'], 'book.md': ['typing.png'] },
    })
    const out = JSON.parse(mergeAssetManifest(existing, 'book.md', [rec('a'), rec('d', 'jpg')]))
    expect(out.files).toEqual([rec('a'), rec('d', 'jpg'), { name: 'pasted.png', sha256: h('c') }])
    expect(out.documents).toEqual({
      'notes.md': ['pasted.png'],
      // the converted file replaces what this document referenced before
      'book.md': [rec('a').name, rec('d', 'jpg').name],
    })
    expect(out.pending).toEqual({ 'draft.md': ['pasted.png'], 'book.md': ['typing.png'] })
  })

  it('drops the document reference when the new file has no pictures', () => {
    const existing = JSON.stringify({
      version: 1,
      files: [rec('a')],
      documents: { 'book.md': [rec('a').name] },
      pending: {},
    })
    const out = JSON.parse(mergeAssetManifest(existing, 'book.md', []))
    expect(out.files).toEqual([rec('a')])
    expect(out.documents).toEqual({})
  })

  it('refuses a name the manifest already owns with different content', () => {
    const existing = JSON.stringify({
      version: 1,
      files: [{ name: rec('a').name, sha256: h('f') }],
    })
    expect(() => mergeAssetManifest(existing, 'book.md', [rec('a')])).toThrow(/different file/)
  })

  it('refuses a manifest it does not understand instead of overwriting it', () => {
    expect(() => mergeAssetManifest('{nope', 'book.md', [])).toThrow(/invalid JSON/)
    expect(() => mergeAssetManifest('{"version":2,"files":[]}', 'book.md', [])).toThrow(
      /unsupported/,
    )
    expect(() =>
      mergeAssetManifest('{"version":1,"files":[{"name":"../x","sha256":"0"}]}', 'b.md', []),
    ).toThrow(/unsafe/)
  })

  it('refuses unsafe document names and records', () => {
    expect(() => mergeAssetManifest(null, 'dir/book.md', [])).toThrow(/unsafe/)
    expect(() =>
      mergeAssetManifest(null, 'book.md', [{ name: 'a/b.png', sha256: h('a') }]),
    ).toThrow(/unsafe/)
  })

  it('accepts an empty string as no manifest', () => {
    expect(JSON.parse(mergeAssetManifest('', 'b.md', [])).files).toEqual([])
  })
})
