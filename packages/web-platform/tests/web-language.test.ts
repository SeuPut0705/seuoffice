import { afterEach, describe, expect, it } from 'vitest'
import { webLanguage } from '../src/document-store'

const at = (search: string): void => history.replaceState(null, '', `/docs/index.html${search}`)

afterEach(() => at(''))

describe('webLanguage', () => {
  it('is Korean when the host passes no language', () => {
    at('?mode=view')
    expect(webLanguage()).toBe('ko')
  })

  it('reads a locale tag the host passes as a UI language', () => {
    at('?lang=ko-KR')
    expect(webLanguage()).toBe('ko')
    at('?lang=en-GB')
    expect(webLanguage()).toBe('en')
  })

  it('is English for a language the app has no UI in', () => {
    for (const lang of ['zh', 'ja', 'zh-TW', 'fr-FR', 'xx']) {
      at(`?lang=${lang}`)
      expect(webLanguage()).toBe('en')
    }
  })
})
