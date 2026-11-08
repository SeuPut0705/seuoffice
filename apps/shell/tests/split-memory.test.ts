import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAppSettings } from '../src/main/app-settings'
import {
  clearSplitMemory,
  readSplitMemory,
  writeSplitMemory,
  type SplitMemoryOptions,
} from '../src/main/split-memory'

let dir: string
let settingsPath: string

function options(): SplitMemoryOptions {
  return { settingsPath }
}

function seed(value: unknown): void {
  writeFileSync(settingsPath, JSON.stringify({ splitView: value }))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'split-memory-'))
  settingsPath = join(dir, 'app-settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('split memory round trip', () => {
  it('stores both documents with orientation, ratio, and focus', () => {
    writeSplitMemory(
      {
        aTabIdPath: 'C:\\docs\\left.docx',
        bTabIdPath: 'C:\\docs\\right.docx',
        orientation: 'side',
        ratio: 0.65,
        focus: 'b',
      },
      options(),
    )

    expect(readSplitMemory(options())).toEqual({
      version: 1,
      a: 'C:\\docs\\left.docx',
      b: 'C:\\docs\\right.docx',
      orientation: 'side',
      ratio: 0.65,
      focus: 'b',
    })
  })

  it('stores a single document in the a slot', () => {
    writeSplitMemory({ aTabIdPath: 'C:\\docs\\only.docx' }, options())
    expect(readSplitMemory(options())).toEqual({ version: 1, a: 'C:\\docs\\only.docx' })
  })

  it('stores a single document from the b pane as a', () => {
    writeSplitMemory({ bTabIdPath: 'C:\\docs\\only.docx' }, options())
    expect(readSplitMemory(options())).toEqual({ version: 1, a: 'C:\\docs\\only.docx' })
  })

  it('keeps both slots when the same document is open twice', () => {
    writeSplitMemory(
      { aTabIdPath: 'C:\\docs\\same.docx', bTabIdPath: 'C:\\docs\\same.docx' },
      options(),
    )
    expect(readSplitMemory(options())).toEqual({
      version: 1,
      a: 'C:\\docs\\same.docx',
      b: 'C:\\docs\\same.docx',
    })
  })

  it('preserves unrelated app settings', () => {
    writeFileSync(settingsPath, JSON.stringify({ language: 'en' }))
    writeSplitMemory({ aTabIdPath: 'C:\\docs\\a.docx' }, options())
    expect(readAppSettings(settingsPath)).toEqual({
      language: 'en',
      splitView: { version: 1, a: 'C:\\docs\\a.docx' },
    })
  })
})

describe('clearing split memory', () => {
  it('removes the stored value when given null', () => {
    writeSplitMemory({ aTabIdPath: 'C:\\docs\\a.docx' }, options())
    writeSplitMemory(null, options())
    expect(readSplitMemory(options())).toBeNull()
    expect(readAppSettings(settingsPath)).not.toHaveProperty('splitView')
  })

  it('removes the stored value when there are no document paths', () => {
    writeSplitMemory({ aTabIdPath: 'C:\\docs\\a.docx' }, options())
    writeSplitMemory({}, options())
    expect(readSplitMemory(options())).toBeNull()
    expect(readAppSettings(settingsPath)).not.toHaveProperty('splitView')
  })

  it('clears explicitly', () => {
    writeSplitMemory({ aTabIdPath: 'C:\\docs\\a.docx' }, options())
    clearSplitMemory(options())
    expect(readSplitMemory(options())).toBeNull()
    expect(readAppSettings(settingsPath)).not.toHaveProperty('splitView')
  })

  it('returns null when no memory was ever stored', () => {
    expect(readSplitMemory(options())).toBeNull()
  })
})

describe('rejecting unusable stored values', () => {
  it('ignores an unknown version', () => {
    seed({ version: 2, a: 'a.docx' })
    expect(readSplitMemory(options())).toBeNull()
    seed({ version: '1', a: 'a.docx' })
    expect(readSplitMemory(options())).toBeNull()
    seed({ a: 'a.docx' })
    expect(readSplitMemory(options())).toBeNull()
  })

  it('ignores a missing or non-string a', () => {
    seed({ version: 1 })
    expect(readSplitMemory(options())).toBeNull()
    seed({ version: 1, a: 42 })
    expect(readSplitMemory(options())).toBeNull()
  })

  it('ignores a b of the wrong type instead of dropping only b', () => {
    seed({ version: 1, a: 'a.docx', b: 42 })
    expect(readSplitMemory(options())).toBeNull()
    seed({ version: 1, a: 'a.docx', b: null })
    expect(readSplitMemory(options())).toBeNull()
  })

  it('ignores an unknown orientation', () => {
    seed({ version: 1, a: 'a.docx', orientation: 'diagonal' })
    expect(readSplitMemory(options())).toBeNull()
  })

  it('ignores an unknown focus', () => {
    seed({ version: 1, a: 'a.docx', focus: 'c' })
    expect(readSplitMemory(options())).toBeNull()
  })

  it('ignores a non-numeric ratio', () => {
    seed({ version: 1, a: 'a.docx', ratio: '0.5' })
    expect(readSplitMemory(options())).toBeNull()
    seed({ version: 1, a: 'a.docx', ratio: null })
    expect(readSplitMemory(options())).toBeNull()
  })

  it('ignores non-object stored values', () => {
    for (const value of ['a.docx', 1, [], null, true]) {
      seed(value)
      expect(readSplitMemory(options())).toBeNull()
    }
  })

  it('returns null for a corrupt settings file', () => {
    writeFileSync(settingsPath, 'not json')
    expect(readSplitMemory(options())).toBeNull()
  })

  it('clamps the ratio to the usable range', () => {
    seed({ version: 1, a: 'a.docx', ratio: 0.05 })
    expect(readSplitMemory(options())?.ratio).toBe(0.2)
    seed({ version: 1, a: 'a.docx', ratio: 0.95 })
    expect(readSplitMemory(options())?.ratio).toBe(0.8)
    seed({ version: 1, a: 'a.docx', ratio: 0.5 })
    expect(readSplitMemory(options())?.ratio).toBe(0.5)
  })
})

describe('injected settings access', () => {
  it('runs without touching the real settings file', () => {
    const stored: Record<string, unknown> = {}
    const injected: SplitMemoryOptions = {
      settingsPath: join(dir, 'not-used.json'),
      readSettings: () => stored,
      writeSetting: (_path, key, value) => {
        if (value === undefined) delete stored[key]
        else stored[key] = value
      },
    }

    writeSplitMemory({ aTabIdPath: 'C:\\docs\\a.docx', focus: 'a' }, injected)
    expect(readSplitMemory(injected)).toEqual({ version: 1, a: 'C:\\docs\\a.docx', focus: 'a' })
    expect(stored.splitView).toEqual({ version: 1, a: 'C:\\docs\\a.docx', focus: 'a' })

    clearSplitMemory(injected)
    expect(stored).toEqual({})
    expect(readSplitMemory(injected)).toBeNull()
  })
})
