import { documentLocaleFor } from './document-locale'

export { documentLocaleFor } from './document-locale'
import { brandText } from './product'

export type Lang = 'en' | 'ko'

export const LANGS: readonly Lang[] = ['en', 'ko']

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value)
}

/**
 * The one place a language value from outside becomes a Lang: a stored choice,
 * the system locale, an environment override, a host's `?lang=`. Every reader
 * of such a value goes through here. Korean ('ko', 'ko-KR', 'ko_KR') is Korean;
 * every other value, and none, is English.
 */
export function normalizeLang(raw: string | null | undefined): Lang {
  const value = raw?.trim().toLowerCase()
  return value === 'ko' || value?.startsWith('ko-') || value?.startsWith('ko_') ? 'ko' : 'en'
}

/**
 * The language an install asks for, as it was written: the choice it stored,
 * else the system's. Only its normalized form is a UI language; what a document
 * is formatted for follows this value, which names more languages than the UI has.
 */
export function requestedLanguage(stored: unknown, system: string | null | undefined): string {
  return typeof stored === 'string' && stored.trim() ? stored : (system ?? '')
}

/**
 * The language an install shows: the choice it stored, else the system's. A
 * stored choice is read through normalizeLang like any other value, so one
 * that is not a UI language shows English instead of the system's language.
 */
export function installLang(stored: unknown, system: string | null | undefined): Lang {
  return normalizeLang(requestedLanguage(stored, system))
}

const HTML_LANGS: Record<Lang, string> = {
  en: 'en-US',
  ko: 'ko-KR',
}

/** BCP-47 tag for document.documentElement.lang (drives CSS :lang() and Chromium's per-language font fallback) */
export function htmlLang(lang: Lang): string {
  return HTML_LANGS[lang]
}

/**
 * Languages whose script reads right-to-left: UI chrome flips direction for
 * them. None of them is a UI language any more, so nothing reaches the
 * right-to-left layout through here; the list stays until it is decided what
 * becomes of that layout.
 */
const RTL_LANGS: readonly string[] = ['ar', 'he']

/** Whether this UI language lays out right-to-left (drives the renderers' html dir) */
export function isRtlLang(lang: string | undefined | null): boolean {
  return RTL_LANGS.includes(lang ?? '')
}

/** The `dir` attribute value for a UI language: every bootstrap and every locale
 *  setter writes the same expression, so the ternary lives here once. */
export function htmlDir(lang: string | undefined | null): 'rtl' | 'ltr' {
  return isRtlLang(lang) ? 'rtl' : 'ltr'
}

// ---- platform-native shortcut hints ----
// Dictionaries write shortcut hints in Mac notation (⌘S, ⇧⌘Z, ⌘+Click); on
// Windows/Linux every translated string is rewritten to Ctrl/Alt/Shift form.

const MAC_KEY_NAMES: Record<string, string> = {
  '⌫': 'Backspace',
  '⌦': 'Delete',
  '⏎': 'Enter',
  '↩': 'Enter',
  '␣': 'Space',
}

const HAS_MAC_SYMBOL = /[⌘⌃⌥⇧⌫⌦⏎↩␣]/
const CHORD = /([⌘⌃⌥⇧]+)(F\d{1,2}|[A-Za-z0-9±=`'\\,./;[\]\-←↑→↓⌫⌦⏎↩␣]|\+)?/g

function chordToWin(mods: string, key: string | undefined): string {
  const parts: string[] = []
  if (mods.includes('⌘') || mods.includes('⌃')) parts.push('Ctrl')
  if (mods.includes('⌥')) parts.push('Alt')
  if (mods.includes('⇧')) parts.push('Shift')
  if (key) parts.push(MAC_KEY_NAMES[key] ?? key)
  return parts.join('+')
}

/** rewrite Mac shortcut notation in a UI string to Windows/Linux form (pure) */
export function macShortcutsToWin(text: string): string {
  if (!HAS_MAC_SYMBOL.test(text)) return text
  return text
    .replace(/⌘\/(?=\p{L}{2})/gu, '') // "⌘/Ctrl+Enter" dual-platform listings: keep the Ctrl side
    .replace(CHORD, (_m, mods: string, key: string | undefined) =>
      key === '+' ? `${chordToWin(mods, undefined)}+` : chordToWin(mods, key),
    )
    .replace(/[⌫⌦⏎↩␣]/g, (glyph) => MAC_KEY_NAMES[glyph] ?? glyph)
}

const IS_MAC = (() => {
  const g = globalThis as {
    navigator?: { platform?: string }
    process?: { platform?: string }
  }
  if (g.navigator?.platform) return /mac/i.test(g.navigator.platform)
  return g.process?.platform === 'darwin'
})()

/** platform-aware shortcut display: identity on macOS */
export const platformShortcuts: (text: string) => string = IS_MAC
  ? (text) => text
  : macShortcutsToWin

export type Params = Record<string, string | number>

/** fill {name} placeholders; unknown or nullish ones are left as-is */
export function format(template: string, params?: Params): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    // hasOwn guards inherited properties; the nullish check keeps an explicitly
    // undefined param from rendering as the literal text "undefined"
    Object.hasOwn(params, name) && params[name] != null ? String(params[name]) : match,
  )
}

/** per-language dictionaries; en defines the key set, all others must match it */
export type LangDicts<D extends Record<string, string>> = { en: D } & {
  [L in Exclude<Lang, 'en'>]: Record<keyof D, string>
}

/**
 * Identity helper for dictionary shards: keeps literal key inference while
 * type-checking that every other language covers exactly the en key set.
 */
export function defineStrings<D extends Record<string, string>>(dicts: LangDicts<D>): LangDicts<D> {
  return dicts
}

// ---- process-wide current language ----
// Used by Electron main-process code (shell + editor main modules share one
// bundle, so one holder). Renderers get the language over IPC instead.

let uiLang: Lang = 'en'
let requestedLocale: string = uiLang
const langListeners = new Set<(lang: Lang) => void>()

export function getUiLang(): Lang {
  return uiLang
}

/**
 * The language value the UI language was narrowed from (a stored 'ja', a system
 * 'de-DE'), or the UI language when that is all that was given. Read by what
 * follows the user's language beyond the UI languages, never by the UI.
 */
export function getRequestedLocale(): string {
  return requestedLocale
}

/** The language documents are read and drawn for in this process (a documentLocaleFor code) */
export function documentLocale(): string {
  return documentLocaleFor(requestedLocale)
}

export function setUiLang(lang: Lang, requested: string = lang): void {
  requestedLocale = requested
  if (lang === uiLang) return
  uiLang = lang
  for (const listener of langListeners) listener(lang)
}

export function onUiLangChange(listener: (lang: Lang) => void): () => void {
  langListeners.add(listener)
  return () => langListeners.delete(listener)
}

/**
 * Build a translator over per-language dictionaries. The en dictionary defines
 * the key set; every other language must cover exactly the same keys
 * (compile-time checked), so a missing translation is a type error, not a
 * runtime fallback.
 *
 * Dictionaries spell the product name as upstream does ("GenOffice"); every
 * string leaves here with the product name of its language instead (see
 * ./product). Write `{{GenOffice}}` where the upstream name itself is meant.
 */
export function createI18n<D extends Record<string, string>>(dicts: LangDicts<D>) {
  return (lang: Lang, key: keyof D, params?: Params): string => {
    // A shard that predates a key must degrade (en, then the key) instead of
    // throwing inside format()
    const text = dicts[lang]?.[key] ?? dicts.en[key] ?? String(key)
    // the product name is swapped into the template, never into a param value
    return format(brandText(platformShortcuts(text), lang), params)
  }
}

export * from './font-names'
export * from './product'
export * from './common-ribbon'
