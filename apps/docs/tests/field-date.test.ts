import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { documentLocale, normalizeLang, requestedLanguage, setUiLang } from '@genoffice/i18n'
import { dateTimeFieldText } from '../src/renderer/field-date'

// A date or time field shows the date the way the document's language writes it:
// the language the install asks for, which names more languages than the UI has.

const NOW = new Date(2026, 10, 12, 9, 5)

/** start the way the app does: the UI gets the narrowed language, the request goes along */
function startInstall(stored: string | undefined, system: string): string {
  const requested = requestedLanguage(stored, system)
  setUiLang(normalizeLang(requested), requested)
  return documentLocale()
}

beforeEach(() => vi.stubEnv('TZ', 'Asia/Seoul'))
afterEach(() => {
  setUiLang('en')
  vi.unstubAllEnvs()
})

describe('date and time fields', () => {
  it.each([
    ['ko-KR', 'ko-KR'],
    ['en-US', 'en-US'],
    ['ja-JP', 'ja-JP'],
    ['de-DE', 'de-DE'],
  ])('are written the %s way on such a system', (system, tag) => {
    const locale = startInstall(undefined, system)

    expect(dateTimeFieldText('DATE', NOW, locale)).toBe(NOW.toLocaleDateString(tag))
    expect(dateTimeFieldText('SAVEDATE', NOW, locale)).toBe(NOW.toLocaleDateString(tag))
    expect(dateTimeFieldText('TIME', NOW, locale)).toBe(
      NOW.toLocaleTimeString(tag, { hour: '2-digit', minute: '2-digit' }),
    )
  })

  it('stay Japanese on a Japanese system while the UI is English', () => {
    const locale = startInstall(undefined, 'ja-JP')

    expect(dateTimeFieldText('DATE', NOW, locale)).toBe('2026/11/12')
    expect(dateTimeFieldText('DATE', NOW, locale)).not.toBe(NOW.toLocaleDateString('en-US'))
  })

  it('are no longer written the Chinese way on a Korean or English install', () => {
    for (const system of ['ko-KR', 'en-US']) {
      const locale = startInstall(undefined, system)
      expect(dateTimeFieldText('DATE', NOW, locale)).not.toBe(NOW.toLocaleDateString('zh-CN'))
    }
  })

  it('leave every other field alone', () => {
    expect(dateTimeFieldText('PAGE', NOW, 'ko')).toBeNull()
    expect(dateTimeFieldText('FILENAME', NOW, 'ko')).toBeNull()
  })
})
