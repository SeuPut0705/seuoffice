import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createI18n, htmlDir, htmlLang, type Lang, type Params } from '@genoffice/i18n'
import { strings } from './strings'

const translate = createI18n(strings)

export type StringKey = keyof typeof strings.en
export type TFunc = (key: StringKey, params?: Params) => string

/** Appended to the AI system prompt: reply in the user's message language, falling back to the UI language (same wording as docs/slides/pdf) */
const AI_LANG_DIRECTIVES: Record<Lang, string> = {
  en: "\n\nReply in the same language as the user's message; if it cannot be determined, reply in English.",
  ko: '\n\n사용자 메시지와 같은 언어로 답변하세요. 언어를 판단할 수 없으면 한국어로 답변하세요.',
}

export function aiLangDirective(lang: Lang): string {
  return AI_LANG_DIRECTIVES[lang]
}

const LocaleContext = createContext<Lang>('en')

/** Module-level current language: for code outliving render closures, kept in sync with the Provider */
let moduleLang: Lang = 'en'

export function t(key: StringKey, params?: Params): string {
  return translate(moduleLang, key, params)
}

export function LocaleProvider({ initial, children }: { initial: Lang; children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(initial)
  moduleLang = lang
  useEffect(
    () =>
      window.htmlApi.onLanguageChanged((next) => {
        document.documentElement.lang = htmlLang(next)
        document.documentElement.dir = htmlDir(next)
        setLang(next)
      }),
    [],
  )
  return <LocaleContext.Provider value={lang}>{children}</LocaleContext.Provider>
}

export function useI18n(): { lang: Lang; t: TFunc } {
  const lang = useContext(LocaleContext)
  return { lang, t: (key, params) => translate(lang, key, params) }
}
