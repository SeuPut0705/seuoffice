/**
 * What a person is told about a file whose structure could not be checked depends on what
 * the page can do with it. The desktop can save a copy under another name, and says so; the
 * web page has one save target, the opened file, and may not point at a Save As it lacks.
 */
import { describe, expect, it } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import { strings } from '../src/renderer/i18n/strings'
import { openedUnverifiedKey, saveFailureKey } from '../src/renderer/save-flow'

/** The host of the page, as its bridge describes it. */
const DESKTOP = {}
const WEB = { noSaveAs: true as const }

/** The name of the Save As command as a language's menu shows it, without the ellipsis. */
const saveAsOf = (lang: (typeof LANGS)[number]): string =>
  strings[lang].fileSaveAs.replace(/…$/, '').toLowerCase()

describe('the notice for a file opened without its structure checked', () => {
  it('names the Save As command on the desktop, in every language', () => {
    for (const lang of LANGS) {
      const text = strings[lang][openedUnverifiedKey(DESKTOP)].toLowerCase()
      expect(text, lang).toContain(saveAsOf(lang))
    }
  })

  it('does not name it on a page without one, in any language', () => {
    for (const lang of LANGS) {
      const text = strings[lang][openedUnverifiedKey(WEB)].toLowerCase()
      expect(text, lang).not.toContain(saveAsOf(lang))
    }
  })

  it('is translated on such a page too', () => {
    for (const lang of LANGS) {
      if (lang === 'en') continue
      const key = openedUnverifiedKey(WEB)
      expect(strings[lang][key], lang).not.toBe(strings.en[key])
    }
  })
})

describe('the notice for a save refused over such a file', () => {
  it('names the Save As command on the desktop, in every language', () => {
    for (const lang of LANGS) {
      const text = strings[lang][saveFailureKey('unverified', DESKTOP)].toLowerCase()
      expect(text, lang).toContain(saveAsOf(lang))
    }
  })

  it('does not name it on a page without one, in any language', () => {
    for (const lang of LANGS) {
      const text = strings[lang][saveFailureKey('unverified', WEB)].toLowerCase()
      expect(text, lang).not.toContain(saveAsOf(lang))
    }
  })

  it('is translated on such a page too', () => {
    for (const lang of LANGS) {
      if (lang === 'en') continue
      const key = saveFailureKey('unverified', WEB)
      expect(strings[lang][key], lang).not.toBe(strings.en[key])
    }
  })
})

describe('every other refused save', () => {
  it('is told the same on the desktop and on the web', () => {
    for (const reason of ['protected', 'tracked', 'verify', 'export', 'write'] as const) {
      expect(saveFailureKey(reason, WEB), reason).toBe(saveFailureKey(reason, DESKTOP))
    }
  })

  it('has a message of its own where the cause is the document, a general one otherwise', () => {
    const own = new Set(
      (['protected', 'tracked', 'unverified', 'verify'] as const).map((reason) =>
        saveFailureKey(reason, DESKTOP),
      ),
    )
    expect(own.size).toBe(4)
    expect(saveFailureKey('write', DESKTOP)).toBe(saveFailureKey('export', DESKTOP))
    expect(own.has(saveFailureKey('write', DESKTOP))).toBe(false)
  })
})
