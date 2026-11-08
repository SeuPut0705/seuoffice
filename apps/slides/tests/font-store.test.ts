import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The adapter, not the store: install discipline lives in @genoffice/electron-utils and is tested there, while where the store sits on disk and which registry reads it are only knowable here.

const storeDir = mkdtempSync(join(tmpdir(), 'slides-font-store-'))

vi.mock('electron', () => ({
  app: { getPath: () => storeDir, getAppPath: () => storeDir, isPackaged: false },
  net: { fetch: vi.fn() },
}))

vi.mock('../src/main/fonts', () => ({
  fontFileFamilies: (p: string) => {
    // The magic gate runs before this; tests hand-label families per path
    return p.includes('brand') ? ['Brand Sans'] : ['Test Family']
  },
  setUserFontDir: vi.fn(),
}))

import * as fontStore from '../src/main/font-store'
import { fontStoreDir, initFontStore, installLocalFontFiles } from '../src/main/font-store'
import { setUserFontDir } from '../src/main/fonts'
import { net } from 'electron'

beforeEach(() => {
  vi.mocked(net.fetch).mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(join(storeDir, 'fonts'), { recursive: true, force: true })
})
afterAll(() => {
  rmSync(storeDir, { recursive: true, force: true })
})

describe('where the store lives', () => {
  it('stays in the fonts folder under the user data dir', () => {
    // Earlier versions wrote here; moving it would orphan every font already installed.
    expect(fontStoreDir()).toBe(join(storeDir, 'fonts'))
  })

  it('hands that folder to the font registry at startup', () => {
    initFontStore()
    expect(setUserFontDir).toHaveBeenCalledWith(join(storeDir, 'fonts'))
  })
})

describe('installLocalFontFiles', () => {
  it('accepts sfnt files, renames to the family, and skips non-fonts', () => {
    const src = join(storeDir, 'brand_v2_final.ttf')
    writeFileSync(src, Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.from('x'.repeat(64))]))
    const junk = join(storeDir, 'junk.ttf')
    writeFileSync(junk, Buffer.from('MZ not a font'))
    const families = installLocalFontFiles([src, junk])
    expect(families).toEqual(['Brand Sans'])
    expect(existsSync(join(storeDir, 'fonts', 'Brand Sans.ttf'))).toBe(true)
  })

  it('installs without a font mirror, and without touching the network', () => {
    vi.stubEnv('GENOFFICE_FONT_CDN_URL', '')
    const src = join(storeDir, 'brand.otf')
    writeFileSync(src, Buffer.concat([Buffer.from('OTTO'), Buffer.from('x'.repeat(64))]))
    expect(installLocalFontFiles([src])).toEqual(['Brand Sans'])
    expect(existsSync(join(storeDir, 'fonts', 'Brand Sans.otf'))).toBe(true)
    expect(net.fetch).not.toHaveBeenCalled()
  })
})

describe('no download entry point remains', () => {
  const read = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8')

  it('the adapter exports the store folder and the local install only', () => {
    expect(Object.keys(fontStore).sort()).toEqual([
      'fontStoreDir',
      'initFontStore',
      'installLocalFontFiles',
    ])
  })

  it('the adapter reads no mirror address and holds no network handle', () => {
    // A mirror URL used to arrive through an environment variable or the packaged metadata.
    expect(read('src/main/font-store.ts')).not.toMatch(/process\.env|genofficeFontCdn|\bnet\b/)
  })

  it('main, preload and the shared contract carry the install channel alone', () => {
    const main = read('src/main/slides-main.ts')
    const preload = read('src/preload/index.ts')
    const contract = read('src/shared/ipc.ts')
    for (const source of [main, preload]) {
      expect(source).toContain("'slides:font-install-local'")
      expect(source).not.toMatch(/slides:font-(catalog|download|missing)/)
    }
    expect(contract).toMatch(/fontInstallLocal: \(\) => Promise<\{ families: string\[\] \}>/)
    expect(contract).not.toMatch(/fontCatalog|fontDownload|fontMissing/)
  })
})
