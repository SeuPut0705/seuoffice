import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as fontStore from '../src/font-store'
import { installLocalFontFiles, type FontStoreEnv } from '../src/font-store'

let dir = ''
let env: FontStoreEnv

function fakeEnv(overrides: Partial<FontStoreEnv> = {}): FontStoreEnv {
  return {
    dir,
    // deliberately unlike the filename, so a store guessing from it is caught
    fontFileFamilies: (path) => (path.includes('brand') ? ['Brand Sans'] : ['Some Other Family']),
    ...overrides,
  }
}

/** Bytes that pass the sfnt gate, tagged so a copy can be told from its neighbours. */
function sfnt(tag: string): Buffer {
  return Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.from(tag.padEnd(64, 'x'))])
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'font-store-'))
  env = fakeEnv()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('installLocalFontFiles', () => {
  it('accepts sfnt files, copies them in, and skips non-fonts', () => {
    // Picked files live outside the store, which is why they are copied in — a source already at the destination is skipped by design.
    const picked = mkdtempSync(join(tmpdir(), 'font-pick-'))
    try {
      const good = join(picked, 'brand_v2.ttf')
      writeFileSync(good, Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.from('x'.repeat(64))]))
      const junk = join(picked, 'notes.txt')
      writeFileSync(junk, 'not a font at all, definitely not sfnt bytes here')
      const families = installLocalFontFiles(env, [good, junk, join(picked, 'missing.ttf')])
      // the family comes from the file's own name table, not from its filename
      expect(families).toEqual(['Brand Sans'])
      expect(existsSync(join(dir, 'Brand Sans.ttf'))).toBe(true)
      // a text file is not a font, so no store entry appears under a name derived from it
      expect(families).not.toContain('Some Other Family')
    } finally {
      rmSync(picked, { recursive: true, force: true })
    }
  })

  it('installs nothing for a host that offers no local install', () => {
    const picked = mkdtempSync(join(tmpdir(), 'font-pick-'))
    try {
      const good = join(picked, 'brand_v2.ttf')
      writeFileSync(good, Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.from('x'.repeat(64))]))
      // a host with no local-install affordance simply omits the reader
      const { fontFileFamilies: _unused, ...host } = fakeEnv()
      expect(installLocalFontFiles(host, [good])).toEqual([])
    } finally {
      rmSync(picked, { recursive: true, force: true })
    }
  })

  it('creates the store folder on the first install', () => {
    const picked = mkdtempSync(join(tmpdir(), 'font-pick-'))
    try {
      const good = join(picked, 'brand.ttf')
      writeFileSync(good, sfnt('regular'))
      const fresh = join(dir, 'not-yet', 'fonts')
      expect(installLocalFontFiles(fakeEnv({ dir: fresh }), [good])).toEqual(['Brand Sans'])
      expect(readdirSync(fresh)).toEqual(['Brand Sans.ttf'])
    } finally {
      rmSync(picked, { recursive: true, force: true })
    }
  })

  it('keeps the style files of one family apart and copies the bytes unchanged', () => {
    const picked = mkdtempSync(join(tmpdir(), 'font-pick-'))
    try {
      const cuts: Array<[source: string, stored: string]> = [
        ['brand.ttf', 'Brand Sans.ttf'],
        ['brand-Bold.ttf', 'Brand Sans-Bold.ttf'],
        ['brand Italic.ttf', 'Brand Sans-Italic.ttf'],
        ['brand_bold italic.ttf', 'Brand Sans-BoldItalic.ttf'],
        ['brand-display.OTF', 'Brand Sans.otf'],
      ]
      for (const [source] of cuts) writeFileSync(join(picked, source), sfnt(source))
      const families = installLocalFontFiles(
        env,
        cuts.map(([source]) => join(picked, source)),
      )
      // one family, however many of its files were picked
      expect(families).toEqual(['Brand Sans'])
      expect(readdirSync(dir).sort()).toEqual(cuts.map(([, stored]) => stored).sort())
      for (const [source, stored] of cuts) {
        expect(readFileSync(join(dir, stored)).equals(sfnt(source)), stored).toBe(true)
      }
    } finally {
      rmSync(picked, { recursive: true, force: true })
    }
  })

  it('reports every family a collection declares', () => {
    const picked = mkdtempSync(join(tmpdir(), 'font-pick-'))
    try {
      const collection = join(picked, 'pair.ttc')
      // 'ttcf': a collection carries several families in one file
      writeFileSync(collection, Buffer.concat([Buffer.from('ttcf'), Buffer.from('x'.repeat(64))]))
      const families = installLocalFontFiles(
        fakeEnv({ fontFileFamilies: () => ['Pair Gothic', 'Pair Gothic UI', 'Pair Gothic'] }),
        [collection],
      )
      expect(families).toEqual(['Pair Gothic', 'Pair Gothic UI'])
      // stored once, under the first family, keeping the collection extension
      expect(readdirSync(dir)).toEqual(['Pair Gothic.ttc'])
    } finally {
      rmSync(picked, { recursive: true, force: true })
    }
  })

  it('leaves what is already in the store alone', () => {
    // Files an earlier version downloaded sit beside user installs, in the same flat folder.
    const earlier = join(dir, 'OpenSans-regular.ttf')
    writeFileSync(earlier, sfnt('downloaded-by-an-earlier-version'))
    const picked = mkdtempSync(join(tmpdir(), 'font-pick-'))
    try {
      const good = join(picked, 'brand.ttf')
      writeFileSync(good, sfnt('regular'))
      installLocalFontFiles(env, [good])
      expect(readdirSync(dir).sort()).toEqual(['Brand Sans.ttf', 'OpenSans-regular.ttf'])
      expect(readFileSync(earlier).equals(sfnt('downloaded-by-an-earlier-version'))).toBe(true)
    } finally {
      rmSync(picked, { recursive: true, force: true })
    }
  })
})

describe('what the store no longer does', () => {
  it('exports the local install and nothing that fetches', () => {
    expect(Object.keys(fontStore)).toEqual(['installLocalFontFiles'])
  })

  it('ships no catalog of downloadable families', () => {
    expect(existsSync(join(__dirname, '../src/font-catalog.ts'))).toBe(false)
  })

  it('reaches no network and reads no mirror address', () => {
    const source = readFileSync(join(__dirname, '../src/font-store.ts'), 'utf8')
    expect(source).not.toMatch(/fetch|https?:|cdn|sha256|process\.env/i)
  })
})
