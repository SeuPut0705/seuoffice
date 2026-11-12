import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The main-process locale table (src/main/index.ts) is an inline object handed
 * to createI18n, so it cannot be imported to assert on it — the values are read
 * out of the source instead, the same way home-duplicate-atomic.test.ts does.
 */
const source = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')

/** One locale's slice of the table, from its `xx: {` header to the next one. */
function localeBlock(locale: string): string {
  const start = source.search(new RegExp(`\\n {2}${locale}: \\{`))
  if (start < 0) throw new Error(`no ${locale} block in the main-process locale table`)
  const rest = source.slice(start + 1)
  const end = rest.search(/\n {2}\S+: \{/)
  return end < 0 ? rest : rest.slice(0, end)
}

/**
 * The mind map editor is registered in the main-process table like every other
 * kind: a missing `untitledMindmap` makes a new map's tab fall back to the
 * spreadsheet name, silently. The format's own product name appears only where
 * the text says which files are opened (the dialog filter), never as the name
 * of a menu item or of a document.
 */
describe('the mind map strings', () => {
  const LOCALES = ['en', 'ko']
  const KEYS = [
    'untitledMindmap',
    'menuNewMindmap',
    'menuExportMapImage',
    'menuExportMapOutline',
    'filterMindmap',
  ]
  const valueIn = (locale: string, key: string): string => {
    const value = localeBlock(locale).match(new RegExp(`\\n {4}${key}: '([^']*)'`))?.[1]
    if (value === undefined) throw new Error(`no ${key} in the ${locale} block`)
    return value
  }

  it.each(LOCALES)('are all present in the %s block', (locale) => {
    for (const key of KEYS) expect(valueIn(locale, key).length, key).toBeGreaterThan(0)
  })

  it('are translated: no locale but English carries the English text', () => {
    for (const key of KEYS) {
      const english = valueIn('en', key)
      for (const locale of LOCALES) {
        if (locale === 'en') continue
        expect(valueIn(locale, key), `${key} in ${locale}`).not.toBe(english)
      }
    }
  })

  it('name the editor in Korean and English as written', () => {
    expect(valueIn('ko', 'menuNewMindmap')).toBe('마인드맵')
    expect(valueIn('en', 'menuNewMindmap')).toBe('Mind Map')
    expect(valueIn('ko', 'untitledMindmap')).toBe('제목 없는 마인드맵')
  })

  it('say XMind only in the dialog filter, as the kind of file that is opened', () => {
    for (const locale of LOCALES) {
      for (const key of KEYS) {
        const value = valueIn(locale, key)
        if (key === 'filterMindmap') expect(value, locale).toMatch(/\(.*XMind.*\)$/)
        else expect(value, `${key} in ${locale}`).not.toMatch(/xmind/i)
      }
    }
  })

  it('give the untitled name its own branch, so it never falls through to the spreadsheet name', () => {
    expect(source).toMatch(/kind === 'mindmap'\s*\?\s*tm\('untitledMindmap'\)/)
  })
})

/**
 * The app is still called AI Markdown. A rename of the app's name was started in
 * this branch and then dropped — the name is the maintainers' call, and README
 * and the docs still say Markdown — so no locale of the File > New menu may say
 * otherwise.
 */
describe('the File > New menu label', () => {
  it('reads AI Markdown in every locale', () => {
    const labels = [...source.matchAll(/menuNewMarkdown: '([^']*)'/g)].map((match) => match[1])
    expect(labels.length).toBeGreaterThanOrEqual(2)
    expect(new Set(labels)).toEqual(new Set(['AI Markdown']))
  })
})
