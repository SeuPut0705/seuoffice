import { afterEach, describe, expect, it } from 'vitest'

import { documentLocale, normalizeLang, requestedLanguage, setUiLang } from '@seuoffice/i18n'
import { generateIndexFieldXml } from '@seuoffice/docx-engine'
import { indexTerms } from '../src/renderer/index-terms'

// A new index lists its entries in the alphabetical order of the document's
// language: the language the install asks for, not a fixed one.

/** start the way the app does: the UI gets the narrowed language, the request goes along */
function startInstall(system: string): string {
  const requested = requestedLanguage(undefined, system)
  setUiLang(normalizeLang(requested), requested)
  return documentLocale()
}

afterEach(() => setUiLang('en'))

describe('the entries of a new index', () => {
  it('are in Korean order on a Korean install', () => {
    const locale = startInstall('ko-KR')

    expect(indexTerms(['하늘', '가방', '나무', '다리', '가방'], locale)).toEqual([
      '가방',
      '나무',
      '다리',
      '하늘',
    ])
  })

  it('file a Hanja entry under its Korean reading, not first by its Chinese one', () => {
    const terms = ['大韓', '국가', '가나', '國家', '대한']
    const korean = indexTerms(terms, startInstall('ko-KR'))

    expect(korean).toEqual(['가나', '국가', '國家', '대한', '大韓'])
    expect(korean).not.toEqual([...terms].sort((a, b) => a.localeCompare(b, 'zh-CN')))
  })

  it('match the field lines written for them, line for line', () => {
    const locale = startInstall('ko-KR')
    const entries = indexTerms(['大韓', '국가', '가나', '國家', 'Alpha'], locale)
    const lines = generateIndexFieldXml(entries, locale)

    expect(lines).toHaveLength(entries.length)
    entries.forEach((entry, i) => expect(lines[i]).toContain(entry))
  })

  it('keep Latin entries in alphabetical order on every install', () => {
    const terms = ['delta', 'Alpha', 'charlie', 'Bravo']
    for (const system of ['ko-KR', 'en-US', 'ja-JP']) {
      expect(indexTerms(terms, startInstall(system))).toEqual([
        'Alpha',
        'Bravo',
        'charlie',
        'delta',
      ])
    }
  })

  it('drop blanks and repeats', () => {
    expect(indexTerms(['  term ', 'term', '', '   '], 'en')).toEqual(['term'])
  })
})
