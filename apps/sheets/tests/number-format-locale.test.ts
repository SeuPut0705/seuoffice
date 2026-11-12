import { numfmt } from '@univerjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { documentLocale, normalizeLang, requestedLanguage, setUiLang } from '@genoffice/i18n'
import { directCopyField } from '../src/renderer/copy-materialize'
import { setDocumentLocale } from '../src/renderer/document-locale'
import { getLang, setModuleLang } from '../src/renderer/i18n/locale'
import { numfmtPreview } from '../src/renderer/numfmt-dialog'
import { applyNumfmtLocale } from '../src/renderer/univer-locales'
import { formatAxisValue } from '../src/renderer/WorkbookVisuals'

vi.mock('@univerjs/preset-sheets-core', () => ({
  SheetsNumfmtCellContentController: class SheetsNumfmtCellContentController {},
}))
vi.mock('../src/renderer/univer-sync', () => ({
  ensureLazyRangeLoaded: vi.fn(),
  readCopySourceDirect: vi.fn(),
}))

// One workbook, one date (2024-12-25, a Wednesday) in a format that spells the
// month and the weekday. The grid draws the cell, a chart draws a label of it,
// Copy puts its text on the clipboard, Format Cells previews it. All four must
// show the same text, in the language the install asks for: the UI has two
// languages, the installs have more.

const DATE = 45651
const FORMAT = 'mmmm d, yyyy (dddd)'

/** start the way the app does, and hand the window what the main process answers at boot */
function openWindowOn(stored: string | undefined, system: string): void {
  const requested = requestedLanguage(stored, system)
  const ui = normalizeLang(requested)
  setUiLang(ui, requested)
  setModuleLang(ui)
  setDocumentLocale(documentLocale())
}

/** the cell as the grid draws it: Univer formats with the locale its controller was given */
function cellText(): string {
  let locale = ''
  applyNumfmtLocale({
    univer: {
      __getInjector: () => ({
        get: () => ({ setNumfmtLocal: (given: string) => (locale = given) }),
      }),
    },
  } as never)
  return numfmt.format(FORMAT, DATE, { locale })
}

const chartLabel = (): string => formatAxisValue(DATE, FORMAT)
const clipboardText = (): string =>
  directCopyField({ v: DATE, t: null, s: { n: { pattern: FORMAT } }, f: null } as never)
const formatCellsPreview = (): string => numfmtPreview(FORMAT, DATE)

/** the date as a given numfmt locale spells it */
const spelledIn = (locale: string): string => numfmt.format(FORMAT, DATE, { locale })

afterEach(() => {
  setUiLang('en')
  setModuleLang('en')
  setDocumentLocale('en')
})

describe('a date cell and the things drawn from it', () => {
  it.each([
    ['ja-JP', 'ja-JP'],
    ['de-DE', 'de-DE'],
    ['zh-CN', 'zh-CN'],
    ['fr-FR', 'fr-FR'],
  ])('are all in the language of a %s system, with the UI in English', (system, locale) => {
    openWindowOn(undefined, system)
    expect(getLang()).toBe('en')

    const cell = cellText()

    expect(cell).toBe(spelledIn(locale))
    expect(cell).not.toBe(spelledIn('en'))
    expect(chartLabel()).toBe(cell)
    expect(clipboardText()).toBe(cell)
    expect(formatCellsPreview()).toBe(cell)
  })

  it('are in English on an English system, as before', () => {
    openWindowOn(undefined, 'en-US')

    const cell = cellText()

    expect(cell).toBe(spelledIn('en'))
    expect(chartLabel()).toBe(cell)
    expect(clipboardText()).toBe(cell)
    expect(formatCellsPreview()).toBe(cell)
  })

  it('are in Korean on a Korean system, as before', () => {
    openWindowOn(undefined, 'ko-KR')
    expect(getLang()).toBe('ko')

    const cell = cellText()

    expect(cell).toBe(spelledIn('ko-KR'))
    expect(cell).not.toBe(spelledIn('en'))
    expect(chartLabel()).toBe(cell)
    expect(clipboardText()).toBe(cell)
    expect(formatCellsPreview()).toBe(cell)
  })

  it('follow an English choice on a Japanese system', () => {
    openWindowOn('en', 'ja-JP')

    expect(cellText()).toBe(spelledIn('en'))
    expect(chartLabel()).toBe(spelledIn('en'))
  })
})
