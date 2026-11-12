import { afterEach, describe, expect, it } from 'vitest'
import {
  createI18n,
  format,
  getRequestedLocale,
  getUiLang,
  htmlDir,
  htmlLang,
  installLang,
  isLang,
  isRtlLang,
  LANGS,
  macShortcutsToWin,
  normalizeLang,
  onUiLangChange,
  requestedLanguage,
  setUiLang,
  type Params,
} from '../src/index'

describe('normalizeLang', () => {
  it('reads Korean in any spelling of the locale', () => {
    expect(normalizeLang('ko')).toBe('ko')
    expect(normalizeLang('ko-KR')).toBe('ko')
    expect(normalizeLang('KO-KR')).toBe('ko')
    expect(normalizeLang('ko_KR')).toBe('ko')
    expect(normalizeLang(' ko ')).toBe('ko')
  })

  it('reads every language the app has no UI in as English', () => {
    // a choice stored by an earlier version, a system locale, a host's ?lang=
    expect(normalizeLang('ja')).toBe('en')
    expect(normalizeLang('fr-FR')).toBe('en')
    expect(normalizeLang('zh')).toBe('en')
    expect(normalizeLang('zh-TW')).toBe('en')
    expect(normalizeLang('zh-Hant-TW')).toBe('en')
    expect(normalizeLang('ar-SA')).toBe('en')
    expect(normalizeLang('sv-SE')).toBe('en')
  })

  it('reads English and a missing value as English', () => {
    expect(normalizeLang('en-US')).toBe('en')
    expect(normalizeLang('en_US')).toBe('en')
    expect(normalizeLang('')).toBe('en')
    expect(normalizeLang(undefined)).toBe('en')
    expect(normalizeLang(null)).toBe('en')
  })

  it('requires a locale boundary after the language code', () => {
    expect(normalizeLang('korean')).toBe('en')
    expect(normalizeLang('kok-IN')).toBe('en')
  })
})

describe('installLang', () => {
  it('shows the stored choice, read like any other language value', () => {
    expect(installLang('ko', 'en-US')).toBe('ko')
    expect(installLang('en', 'ko-KR')).toBe('en')
    expect(installLang('ko-KR', 'en-US')).toBe('ko')
  })

  it('shows English for a stored choice that is no UI language, whatever the system is', () => {
    // an install that chose Japanese before the app had two languages
    expect(installLang('ja', 'ko-KR')).toBe('en')
    expect(installLang('zh-TW', 'ko-KR')).toBe('en')
    expect(installLang('xx', 'ko-KR')).toBe('en')
  })

  it('follows the system on a first run, when nothing usable is stored', () => {
    expect(installLang(undefined, 'ko-KR')).toBe('ko')
    expect(installLang('', 'ko')).toBe('ko')
    expect(installLang(42, 'ko_KR')).toBe('ko')
    expect(installLang(undefined, 'fr-FR')).toBe('en')
    expect(installLang(undefined, undefined)).toBe('en')
  })
})

describe('requestedLanguage', () => {
  it('is the stored choice as it was written, else the system value', () => {
    expect(requestedLanguage('ja', 'ko-KR')).toBe('ja')
    expect(requestedLanguage('', 'de-DE')).toBe('de-DE')
    expect(requestedLanguage(42, 'zh-TW')).toBe('zh-TW')
    expect(requestedLanguage(undefined, undefined)).toBe('')
  })
})

describe('the requested locale beside the UI language', () => {
  afterEach(() => setUiLang('en'))

  it('keeps the language an install asked for when the UI narrows it to English', () => {
    setUiLang(normalizeLang('ja-JP'), 'ja-JP')
    expect(getUiLang()).toBe('en')
    expect(getRequestedLocale()).toBe('ja-JP')
  })

  it('follows a UI language chosen afterwards', () => {
    setUiLang(normalizeLang('ja-JP'), 'ja-JP')
    setUiLang('ko')
    expect(getRequestedLocale()).toBe('ko')
  })

  it('takes a new request that narrows to the UI language already shown', () => {
    setUiLang('en', 'ja')
    setUiLang('en', 'de-DE')
    expect(getRequestedLocale()).toBe('de-DE')
  })

  it('tells no listener when only the request changed', () => {
    const seen: string[] = []
    const stop = onUiLangChange((lang) => seen.push(lang))
    setUiLang('en', 'ja')
    stop()
    expect(seen).toEqual([])
  })
})

describe('isLang', () => {
  it('accepts only the UI languages', () => {
    expect(isLang('en')).toBe(true)
    expect(isLang('ko')).toBe(true)
    expect(isLang('ja')).toBe(false)
    expect(isLang('ko-KR')).toBe(false)
    expect(isLang(42)).toBe(false)
  })
})

describe('htmlLang', () => {
  it('maps every UI language to a BCP-47 tag', () => {
    expect(htmlLang('en')).toBe('en-US')
    expect(htmlLang('ko')).toBe('ko-KR')
  })
})

describe('format', () => {
  it('fills placeholders and keeps unknown ones', () => {
    expect(format('已选 {n} 项', { n: 3 })).toBe('已选 3 项')
    expect(format('{a} and {b}', { a: 'x' })).toBe('x and {b}')
    expect(format('no params')).toBe('no params')
  })

  it('leaves the placeholder in place for a nullish param value', () => {
    // hasOwn is true for a key explicitly set to undefined/null, and
    // String(undefined) is the literal text "undefined"
    expect(format('Deleted {n} files', { n: undefined } as unknown as Params)).toBe(
      'Deleted {n} files',
    )
    expect(format('Deleted {n} files', { n: null } as unknown as Params)).toBe('Deleted {n} files')
  })

  it('does not leak prototype properties into placeholders', () => {
    expect(format('{toString}', {})).toBe('{toString}')
    expect(format('{constructor} and {valueOf}', {})).toBe('{constructor} and {valueOf}')
    expect(format('{n}', { n: 1 })).toBe('1')
  })
})

describe('macShortcutsToWin', () => {
  it('rewrites single-modifier chords', () => {
    expect(macShortcutsToWin('剪切 (⌘X)')).toBe('剪切 (Ctrl+X)')
    expect(macShortcutsToWin('Save (⌘S).')).toBe('Save (Ctrl+S).')
    expect(macShortcutsToWin('⌘1')).toBe('Ctrl+1')
  })

  it('rewrites multi-modifier chords in Ctrl, Alt, Shift order', () => {
    expect(macShortcutsToWin('⇧⌘G')).toBe('Ctrl+Shift+G')
    expect(macShortcutsToWin('⌘⇧V')).toBe('Ctrl+Shift+V')
    expect(macShortcutsToWin('⌥⌘I')).toBe('Ctrl+Alt+I')
    expect(macShortcutsToWin('⌥⇧⌘Z')).toBe('Ctrl+Alt+Shift+Z')
  })

  it('dedupes command and control into one Ctrl', () => {
    expect(macShortcutsToWin('⌃⌘F')).toBe('Ctrl+F')
  })

  it('handles function keys, arrows and named keys', () => {
    expect(macShortcutsToWin('⇧F5')).toBe('Shift+F5')
    expect(macShortcutsToWin('⌘⇧↑')).toBe('Ctrl+Shift+↑')
    expect(macShortcutsToWin('⌘⇧⌫')).toBe('Ctrl+Shift+Backspace')
    expect(macShortcutsToWin('⌫')).toBe('Backspace')
    expect(macShortcutsToWin('⌦')).toBe('Delete')
    expect(macShortcutsToWin('⏎')).toBe('Enter')
    expect(macShortcutsToWin('↩')).toBe('Enter')
    expect(macShortcutsToWin('␣')).toBe('Space')
  })

  it('keeps the Ctrl side of dual-platform listings', () => {
    expect(macShortcutsToWin('⌘/Ctrl+Enter 发送')).toBe('Ctrl+Enter 发送')
    expect(macShortcutsToWin('⌘/Strg+Eingabetaste')).toBe('Strg+Eingabetaste')
  })

  it('rewrites modifier+word combos and bare modifiers', () => {
    expect(macShortcutsToWin('⌘+Click to follow')).toBe('Ctrl+Click to follow')
    expect(macShortcutsToWin('按住 ⌘ 并单击')).toBe('按住 Ctrl 并单击')
  })

  it('keeps a chord embedded before non-Latin text intact', () => {
    expect(macShortcutsToWin('⌘S로 저장')).toBe('Ctrl+S로 저장')
  })

  it('leaves strings without Mac symbols untouched', () => {
    const plain = 'Ctrl+S saves the file'
    expect(macShortcutsToWin(plain)).toBe(plain)
    expect(macShortcutsToWin('文件')).toBe('文件')
  })
})

describe('shortcut rewrite order', () => {
  it('rewrites the template before interpolation so values keep their glyphs', () => {
    const template = 'Saved {name} (⌘S)'
    const params = { name: 'Plan ⇧Final.xlsx' }
    expect(format(macShortcutsToWin(template), params)).toBe('Saved Plan ⇧Final.xlsx (Ctrl+S)')
    expect(macShortcutsToWin(format(template, params))).toBe('Saved Plan Shift+Final.xlsx (Ctrl+S)')
  })
})

describe('createI18n', () => {
  const t = createI18n({
    en: { hello: 'Hello {name}', plain: 'Files' },
    ko: { hello: '안녕하세요 {name}', plain: '파일' },
  })

  it('translates per language with interpolation', () => {
    expect(t('en', 'hello', { name: 'world' })).toBe('Hello world')
    expect(t('ko', 'hello', { name: '세계' })).toBe('안녕하세요 세계')
    expect(t('ko', 'plain')).toBe('파일')
    expect(t('en', 'plain')).toBe('Files')
  })

  it('falls back to English, then to the key, for a missing entry', () => {
    const partial = createI18n({
      en: { a: 'en-a', b: 'en-b' },
      ko: { a: 'ko-a' },
    } as unknown as Parameters<typeof createI18n>[0])
    expect(partial('ko', 'a')).toBe('ko-a')
    expect(partial('ko', 'b')).toBe('en-b')
    expect(partial('ko', 'd' as 'a')).toBe('d')
  })
})

describe('isRtlLang', () => {
  it('flags the right-to-left languages', () => {
    expect(isRtlLang('ar')).toBe(true)
    expect(isRtlLang('he')).toBe(true)
  })

  it('leaves the UI languages and junk alone', () => {
    expect(isRtlLang('en')).toBe(false)
    expect(isRtlLang('ko')).toBe(false)
    expect(isRtlLang('fa')).toBe(false)
    expect(isRtlLang(undefined)).toBe(false)
    expect(isRtlLang('')).toBe(false)
  })
})

describe('htmlDir', () => {
  it('lays every UI language out left to right', () => {
    for (const lang of LANGS) expect(htmlDir(lang)).toBe('ltr')
    expect(htmlDir(undefined)).toBe('ltr')
    expect(htmlDir(null)).toBe('ltr')
    expect(htmlDir('')).toBe('ltr')
  })

  it('agrees with isRtlLang', () => {
    expect(htmlDir('ar')).toBe('rtl')
    expect(htmlDir('he')).toBe('rtl')
    expect(htmlDir('HE')).toBe('ltr')
  })
})
