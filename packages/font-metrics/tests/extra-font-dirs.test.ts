// Fonts the app ships (the design templates' folder) are not in a system font folder,
// so the Word editor names their folder. Only its lookups see them (vertical metrics,
// the pickers' family info): every editor shares the shell's process, and the PDF
// editor's lookups (findSystemFont, findFontCovering) must still answer from the
// installed fonts alone. Without a named folder every index is the system scan alone.
import * as fs from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEMPLATE_FONTS } from '@genoffice/ui/template-fonts'

// every file a lookup opens or reads, to tell whether it ever touched the folder
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, openSync: vi.fn(actual.openSync), readFileSync: vi.fn(actual.readFileSync) }
})

import {
  configureExtraFontDirs,
  familyInfoFor,
  familyVerticalMetrics,
  findFontCovering,
  findSystemFont,
  isFamilyInstalled,
} from '../src/index'
import { getAppFontIndex, getFontIndex, readTable, readTableDir } from '../src/sfnt'

const FOLDER = resolve(import.meta.dirname, '../../ui/template-fonts')

afterEach(() => configureExtraFontDirs([]))

/** hhea ascender/descender/lineGap and unitsPerEm read straight from the file */
function hheaOf(file: string) {
  const fd = fs.openSync(join(FOLDER, file), 'r')
  try {
    const tables = readTableDir(fd, 0)!
    const head = readTable(fd, tables, 'head', 512)!
    const hhea = readTable(fd, tables, 'hhea', 512)!
    return {
      unitsPerEm: head.readUInt16BE(18),
      hheaAscender: hhea.readInt16BE(4),
      hheaDescender: hhea.readInt16BE(6),
      hheaLineGap: hhea.readInt16BE(8),
    }
  } finally {
    fs.closeSync(fd)
  }
}

const inFolder = (path: unknown) => typeof path === 'string' && resolve(path).startsWith(FOLDER)

/** whether any file in the folder was opened or read since the mocks were cleared */
const touchedFolder = () =>
  [...vi.mocked(fs.openSync).mock.calls, ...vi.mocked(fs.readFileSync).mock.calls].some(([path]) =>
    inFolder(path),
  )

const facesOf = (index: ReturnType<typeof getFontIndex>) => [
  ...index.byPs.values(),
  ...[...index.byFamily.values()].flat(),
]

const sameAnswer = (a: Buffer | null, b: Buffer | null) =>
  a === null || b === null ? a === b : a.equals(b)

// the first lookup scans the system font folders, slow on a busy machine
describe('configureExtraFontDirs', { timeout: 60_000 }, () => {
  it('finds the vertical metrics of every bundled family once the folder is named', () => {
    const names = TEMPLATE_FONTS.map((f) => f.family)
    // an installed copy answers first (the folder only fills gaps), and its version's
    // metrics may differ from the shipped file's
    const installed = new Set(names.filter((name) => isFamilyInstalled(name)))
    configureExtraFontDirs([FOLDER])
    for (const family of TEMPLATE_FONTS) {
      // the face a lookup settles on: the regular one, else the only one
      const face = family.faces.find((f) => f.weight === 400) ?? family.faces[0]!
      const m = familyVerticalMetrics(family.family)
      expect(m, family.family).not.toBeNull()
      if (!installed.has(family.family)) expect(m).toMatchObject(hheaOf(face.file))
    }
  })

  it('gives the pickers the Hangul coverage of the bundled Korean families', async () => {
    configureExtraFontDirs([FOLDER])
    const korean = TEMPLATE_FONTS.filter((f) => f.script === 'korean').map((f) => f.family)
    const info = new Map(await familyInfoFor(korean))
    for (const family of korean) expect(info.get(family)?.hangul, family).toBe(true)
  })

  it('indexes the folder for the Word editor, a bracketed variable file included', () => {
    configureExtraFontDirs([FOLDER])
    const app = getAppFontIndex()
    expect(facesOf(app).some((f) => inFolder(f.path))).toBe(true)
    expect(app.byPs.get('playfairdisplayregular')?.path).toBe(
      join(FOLDER, 'PlayfairDisplay[wght].ttf'),
    )
  })

  it('keeps the folder out of the installed-font lookups the PDF editor uses', () => {
    // what the installed fonts answer, before the Word editor names its folder
    const asked = TEMPLATE_FONTS.flatMap((f) => [
      ['', f.family],
      [`${f.family.replace(/\s+/g, '')}-Regular`, f.family],
      [`${f.family.replace(/\s+/g, '')}-Bold`, f.family],
    ])
    const before = asked.map(([ps, family]) => findSystemFont(ps!, family!))
    const installedBefore = TEMPLATE_FONTS.map((f) => isFamilyInstalled(f.family))

    configureExtraFontDirs([FOLDER])
    // the Word editor's lookups do see it
    expect(familyVerticalMetrics('Bebas Neue')).not.toBeNull()
    expect(facesOf(getAppFontIndex()).some((f) => inFolder(f.path))).toBe(true)

    vi.mocked(fs.openSync).mockClear()
    vi.mocked(fs.readFileSync).mockClear()
    expect(facesOf(getFontIndex()).some((f) => inFolder(f.path))).toBe(false)
    asked.forEach(([ps, family], i) => {
      expect(sameAnswer(findSystemFont(ps!, family!), before[i]!), `${ps} ${family}`).toBe(true)
    })
    expect(TEMPLATE_FONTS.map((f) => isFamilyInstalled(f.family))).toEqual(installedBefore)
    // a character no font maps: the coverage scan tries every indexed face, none in the folder
    expect(findFontCovering('\u{10FFFD}')).toBeNull()
    // and text the bundled faces cover is answered from the installed fonts, if at all
    findFontCovering('가A')
    expect(touchedFolder()).toBe(false)
  })

  it('indexes only the system folders when no folder is named', () => {
    configureExtraFontDirs([FOLDER])
    expect(facesOf(getAppFontIndex()).some((f) => inFolder(f.path))).toBe(true)
    configureExtraFontDirs([])
    expect(facesOf(getAppFontIndex()).some((f) => inFolder(f.path))).toBe(false)
    expect(getAppFontIndex()).toBe(getFontIndex())
  })
})
