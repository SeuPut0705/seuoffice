import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createI18n, htmlDir, htmlLang, type Lang, type Params } from '@genoffice/i18n'
import { strings } from './strings'

const translate = createI18n(strings)

export type StringKey = keyof typeof strings.en
export type TFunc = (key: StringKey, params?: Params) => string

/**
 * Explicit-language translator, for callers that must not follow `moduleLang`:
 * a Univer locale pack is built for one language at a time and has to stay on
 * that language even while the app-level module language is elsewhere — the
 * runtime boots with the English pack whatever the app language is.
 */
export const translateFor =
  (lang: Lang): TFunc =>
  (key, params) =>
    translate(lang, key, params)

// mirror for non-React modules (edit-journal, lazy-plan, AI tools …);
// set before first render and on every language switch
let moduleLang: Lang = 'en'
export const getLang = (): Lang => moduleLang
export const setModuleLang = (lang: Lang): void => {
  moduleLang = lang
}
/** module-level translator — components should prefer useI18n().t so they re-render on switch */
export const t: TFunc = (key, params) => translate(moduleLang, key, params)
export const tFor = (lang: Lang, key: StringKey, params?: Params): string =>
  translate(lang, key, params)

const AI_LANG_DIRECTIVES: Record<Lang, string> = {
  en: "\n\nReply in the same language as the user's message; if it cannot be determined, reply in English.",
  ko: '\n\n사용자 메시지와 같은 언어로 답변하세요. 언어를 판단할 수 없으면 한국어로 답변하세요.',
}

/** appended to the agent system prompt: replies follow the user's message language, falling back to the UI language */
export function aiLangDirective(): string {
  return AI_LANG_DIRECTIVES[moduleLang]
}

/** BCP-47 locale per UI language, for date/number formatting */
export const DATE_LOCALES: Record<Lang, string> = {
  en: 'en-US',
  ko: 'ko-KR',
}

const LocaleContext = createContext<Lang>('en')

export function LocaleProvider({ initial, children }: { initial: Lang; children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(initial)
  useEffect(
    () =>
      window.desktopApi.onLanguageChanged((next) => {
        setModuleLang(next)
        document.documentElement.lang = htmlLang(next)
        document.documentElement.dir = htmlDir(next)
        setLang(next)
      }),
    [],
  )
  return <LocaleContext.Provider value={lang}>{children}</LocaleContext.Provider>
}

export interface I18n {
  lang: Lang
  t: TFunc
  /** BCP-47 locale for date/number formatting */
  dateLocale: string
}

export function useI18n(): I18n {
  const lang = useContext(LocaleContext)
  return {
    lang,
    t: (key, params) => translate(lang, key, params),
    dateLocale: DATE_LOCALES[lang],
  }
}
