import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { strings } from '../src/renderer/i18n/strings'
import { PASTE_SPECIAL_OPEN_SHELL_COMMAND } from '../src/renderer/paste-special'
import {
  DEFAULT_QUICK_ACCESS,
  QUICK_ACCESS_CATALOG,
  QUICK_ACCESS_MAX_ITEMS,
  QUICK_ACCESS_STORAGE_KEY,
  moveQuickAccess,
  parseQuickAccess,
  quickAccessDigit,
  quickAccessItem,
  quickAccessSlotForKey,
  readQuickAccess,
  toggleQuickAccess,
  writeQuickAccess,
  type QuickAccessKeyEvent,
} from '../src/renderer/quick-access'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => readFileSync(join(here, '..', rel), 'utf8')

function key(code: string, held: Partial<QuickAccessKeyEvent> = {}): QuickAccessKeyEvent {
  return {
    code,
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    ...held,
  }
}

function memoryStorage(initial?: string): {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
} {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(QUICK_ACCESS_STORAGE_KEY, initial)
  return {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => void values.set(name, value),
  }
}

describe('quick-access catalog', () => {
  it('has unique ids and one way to run each item', () => {
    const ids = QUICK_ACCESS_CATALOG.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const item of QUICK_ACCESS_CATALOG) {
      expect(Boolean(item.builtin) !== Boolean(item.command), item.id).toBe(true)
    }
  })

  it('labels every item in every UI language', () => {
    for (const [lang, table] of Object.entries(strings)) {
      for (const item of QUICK_ACCESS_CATALOG) {
        expect((table as Record<string, string>)[item.labelKey], `${lang}/${item.id}`).toBeTruthy()
      }
    }
  })

  it('draws every command with an icon the ribbon already has', () => {
    const icons = read('src/renderer/ribbon-icons.tsx')
    // letterforms the ribbon shows as typography rather than a drawn icon
    const typography = new Set(['ƒx'])
    for (const item of QUICK_ACCESS_CATALOG) {
      if (item.builtin) continue
      const symbol = item.symbol ?? ''
      expect(symbol, item.id).not.toBe('')
      if (typography.has(symbol)) continue
      expect(icons.includes(`'${symbol}': `), `${item.id} uses ${symbol}`).toBe(true)
    }
  })

  it('sends only commands the shell or the ribbon handles', () => {
    const handlers = read('src/renderer/ExcelShell.tsx') + read('src/renderer/ribbon-actions.ts')
    for (const item of QUICK_ACCESS_CATALOG) {
      if (!item.command) continue
      // `sort:asc` and `autofn:SUM` reach the ribbon's `name:argument` switch
      const name = item.command.split(':')[0]!
      // the shell compares paste special against its exported constant
      const byConstant =
        item.command === PASTE_SPECIAL_OPEN_SHELL_COMMAND &&
        handlers.includes('command === PASTE_SPECIAL_OPEN_SHELL_COMMAND')
      expect(
        byConstant ||
          handlers.includes(`'${item.command}'`) ||
          handlers.includes(`case '${name}':`),
        item.command,
      ).toBe(true)
    }
  })

  it('starts with the four buttons the row always had', () => {
    expect(DEFAULT_QUICK_ACCESS).toEqual(['save', 'save-as', 'undo', 'redo'])
    for (const id of DEFAULT_QUICK_ACCESS) expect(quickAccessItem(id)?.builtin).toBeTruthy()
  })
})

describe('stored quick-access row', () => {
  it('falls back to the default when nothing usable is stored', () => {
    expect(parseQuickAccess(null)).toEqual(DEFAULT_QUICK_ACCESS)
    expect(parseQuickAccess('not json')).toEqual(DEFAULT_QUICK_ACCESS)
    expect(parseQuickAccess('{"a":1}')).toEqual(DEFAULT_QUICK_ACCESS)
  })

  it('keeps an emptied row empty', () => {
    expect(parseQuickAccess('[]')).toEqual([])
  })

  it('drops unknown ids and repeats, and stops at ten', () => {
    expect(parseQuickAccess('["filter","nope",3,"filter","save"]')).toEqual(['filter', 'save'])
    const all = JSON.stringify(QUICK_ACCESS_CATALOG.map((item) => item.id))
    expect(parseQuickAccess(all)).toHaveLength(QUICK_ACCESS_MAX_ITEMS)
  })

  it('round-trips through storage and survives storage that throws', () => {
    const storage = memoryStorage()
    writeQuickAccess(storage, ['autosum', 'save'])
    expect(readQuickAccess(storage)).toEqual(['autosum', 'save'])
    const broken = {
      getItem: (): string | null => {
        throw new Error('blocked')
      },
      setItem: (): void => {
        throw new Error('full')
      },
    }
    expect(readQuickAccess(broken)).toEqual(DEFAULT_QUICK_ACCESS)
    expect(() => writeQuickAccess(broken, ['save'])).not.toThrow()
    expect(readQuickAccess(null)).toEqual(DEFAULT_QUICK_ACCESS)
  })
})

describe('editing the quick-access row', () => {
  it('appends a new item and removes one already there', () => {
    expect(toggleQuickAccess(['save'], 'filter')).toEqual(['save', 'filter'])
    expect(toggleQuickAccess(['save', 'filter'], 'save')).toEqual(['filter'])
    expect(toggleQuickAccess(['save'], 'nope')).toEqual(['save'])
  })

  it('refuses an eleventh item but still removes from a full row', () => {
    const full = QUICK_ACCESS_CATALOG.slice(0, QUICK_ACCESS_MAX_ITEMS).map((item) => item.id)
    const extra = QUICK_ACCESS_CATALOG[QUICK_ACCESS_MAX_ITEMS]!.id
    expect(toggleQuickAccess(full, extra)).toEqual(full)
    expect(toggleQuickAccess(full, full[0]!)).toEqual(full.slice(1))
  })

  it('moves an item one slot and stops at the ends', () => {
    const row = ['save', 'undo', 'filter']
    expect(moveQuickAccess(row, 'filter', -1)).toEqual(['save', 'filter', 'undo'])
    expect(moveQuickAccess(row, 'save', 1)).toEqual(['undo', 'save', 'filter'])
    expect(moveQuickAccess(row, 'save', -1)).toEqual(row)
    expect(moveQuickAccess(row, 'filter', 1)).toEqual(row)
    expect(moveQuickAccess(row, 'nope', 1)).toEqual(row)
  })
})

describe('Alt+digit', () => {
  it('names the slots 1..9 and then 0', () => {
    expect(quickAccessDigit(0)).toBe('1')
    expect(quickAccessDigit(8)).toBe('9')
    expect(quickAccessDigit(9)).toBe('0')
    expect(quickAccessDigit(10)).toBeNull()
    expect(quickAccessDigit(-1)).toBeNull()
  })

  it('maps Alt plus a top-row digit to its slot', () => {
    expect(quickAccessSlotForKey(key('Digit1'), false)).toBe(0)
    expect(quickAccessSlotForKey(key('Digit9'), false)).toBe(8)
    expect(quickAccessSlotForKey(key('Digit0'), false)).toBe(9)
  })

  it('leaves every other chord alone', () => {
    // Option+digit types a character on a Mac
    expect(quickAccessSlotForKey(key('Digit1'), true)).toBeNull()
    // AltGr arrives as Ctrl+Alt
    expect(quickAccessSlotForKey(key('Digit1', { ctrlKey: true }), false)).toBeNull()
    expect(quickAccessSlotForKey(key('Digit1', { shiftKey: true }), false)).toBeNull()
    expect(quickAccessSlotForKey(key('Digit1', { metaKey: true }), false)).toBeNull()
    expect(quickAccessSlotForKey(key('Digit1', { altKey: false }), false)).toBeNull()
    // Alt+numpad enters a character code
    expect(quickAccessSlotForKey(key('Numpad1'), false)).toBeNull()
    expect(quickAccessSlotForKey(key('KeyA'), false)).toBeNull()
    expect(quickAccessSlotForKey(key('Digit1', { defaultPrevented: true }), false)).toBeNull()
  })
})

describe('quick-access row in the shell', () => {
  const shell = read('src/renderer/ExcelShell.tsx')

  it('runs a slot only from the grid, outside a dialog and outside cell editing', () => {
    expect(shell).toMatch(
      /quickAccessSlotForKey\(event, IS_MAC\)[\s\S]*?isModalOpen\(\) \|\| onIsCellEditingRef\.current\(\) \|\| !isGridKeyTarget\(event\.target\)[\s\S]*?runQuickAccessRef\.current\(slot\)/,
    )
  })

  it('marks a row longer than the default so a narrow window keeps every tab', () => {
    // at the 720px minimum width ten buttons pushed the last tab past the
    // edge; the crowded row drops the auto-save label and tightens the tabs
    expect(shell).toContain("quickAccess.length > DEFAULT_QUICK_ACCESS.length ? ' qa-crowded' : ''")
    const css = read('src/renderer/styles.css')
    expect(css).toMatch(
      /@media \(max-width: 840px\) \{\s*\.ribbon-tabs\.qa-crowded \.autosave-text \{\s*display: none;[\s\S]*?\.ribbon-tabs\.qa-crowded > button:not\(\.qa-btn\) \{\s*padding-left: 6px;\s*padding-right: 6px;/,
    )
  })

  it('does not run a built-in button that is disabled', () => {
    expect(shell).toContain('if (!builtin.disabled) builtin.run()')
  })
})
