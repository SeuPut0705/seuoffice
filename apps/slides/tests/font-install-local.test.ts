import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import * as opentype from 'opentype.js'

// Install-from-file end to end at the module level: a real font file, the real name-table reader and the real registry — only Electron's user data dir is redirected to a temp folder.

const userData = mkdtempSync(join(tmpdir(), 'slides-font-install-'))
const picked = mkdtempSync(join(tmpdir(), 'slides-font-pick-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData, getAppPath: () => userData, isPackaged: false },
}))

vi.mock('../src/main/shaped-metrics', () => ({
  initShapedMetrics: () => {},
  shapedMeasure: () => null,
  shapedFamily: () => null,
  gtMeasure: () => null,
  complexScriptOf: () => null,
}))

import { fontStoreDir, initFontStore, installLocalFontFiles } from '../src/main/font-store'
import { familyAvailable, resetFontRegistry } from '../src/main/fonts'

/** A real sfnt under a family name no machine has, so availability can only come from the store. */
function fontBytes(familyName: string, styleName = 'Regular'): Buffer {
  const box = new opentype.Path()
  box.moveTo(100, 0)
  box.lineTo(100, 700)
  box.lineTo(500, 700)
  box.lineTo(500, 0)
  box.close()
  const font = new opentype.Font({
    familyName,
    styleName,
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs: [
      new opentype.Glyph({
        name: '.notdef',
        unicode: 0,
        advanceWidth: 600,
        path: new opentype.Path(),
      }),
      new opentype.Glyph({ name: 'A', unicode: 65, advanceWidth: 600, path: box }),
    ],
  })
  return Buffer.from(font.toArrayBuffer())
}

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
  rmSync(picked, { recursive: true, force: true })
})

describe('installing a font file the user already has', () => {
  it('copies it into the store and the registry resolves the family afterwards', () => {
    initFontStore()
    expect(familyAvailable('Ieum Probe Sans')).toBe(false)

    // named the way a download folder names things, nothing like the family
    const regular = join(picked, 'font (3).ttf')
    const bold = join(picked, 'font (3) bold.ttf')
    writeFileSync(regular, fontBytes('Ieum Probe Sans'))
    writeFileSync(bold, fontBytes('Ieum Probe Sans', 'Bold'))
    const notAFont = join(picked, 'readme.ttf')
    writeFileSync(notAFont, 'this is a text file with a font extension')

    expect(installLocalFontFiles([regular, bold, notAFont])).toEqual(['Ieum Probe Sans'])
    expect(
      readFileSync(join(fontStoreDir(), 'Ieum Probe Sans.ttf')).equals(readFileSync(regular)),
    ).toBe(true)
    expect(existsSync(join(fontStoreDir(), 'Ieum Probe Sans-Bold.ttf'))).toBe(true)

    // what the fonts-changed path does before it relays every open deck
    resetFontRegistry()
    expect(familyAvailable('Ieum Probe Sans')).toBe(true)
    expect(familyAvailable('Ieum Probe Serif')).toBe(false)
  })

  it('a family an earlier version downloaded into the store keeps resolving', () => {
    // The removed downloader named its files <Family>-<style>.ttf in this same flat folder.
    mkdirSync(fontStoreDir(), { recursive: true })
    writeFileSync(join(fontStoreDir(), 'IeumLegacySans-regular.ttf'), fontBytes('Ieum Legacy Sans'))
    writeFileSync(
      join(fontStoreDir(), 'IeumLegacySans-bold.ttf'),
      fontBytes('Ieum Legacy Sans', 'Bold'),
    )
    initFontStore()
    resetFontRegistry()
    expect(familyAvailable('Ieum Legacy Sans')).toBe(true)
  })
})
