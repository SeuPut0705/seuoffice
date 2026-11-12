import { createContext, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { createI18n, htmlDir, htmlLang, productName, type Lang, type Params } from '@seuoffice/i18n'
import { strings } from './strings'

const translate = createI18n(strings)

export type StringKey = keyof typeof strings.en
export type TFunc = (key: StringKey, params?: Params) => string

interface LocaleValue {
  lang: Lang
  setLang: (lang: Lang) => void
}

const LocaleContext = createContext<LocaleValue>({ lang: 'en', setLang: () => {} })

export function LocaleProvider({ initial, children }: { initial: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial)
  const value = useMemo<LocaleValue>(
    () => ({
      lang,
      setLang: (next) => {
        // the main process rejects when app-settings.json is unwritable; a language
        // committed here first would survive only until the next launch
        window.aiOffice.setLanguage(next).then(
          () => {
            setLangState(next)
            document.documentElement.lang = htmlLang(next)
            document.documentElement.dir = htmlDir(next)
            document.title = productName(next)
          },
          (err: unknown) => console.warn('language not saved', err),
        )
      },
    }),
    [lang],
  )
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export interface I18n {
  lang: Lang
  setLang: (lang: Lang) => void
  t: TFunc
  /** BCP-47 locale for date/number formatting */
  dateLocale: string
}

/** BCP-47 locale per UI language, for date/number formatting */
const DATE_LOCALES: Record<Lang, string> = {
  en: 'en-US',
  ko: 'ko-KR',
}

export function useI18n(): I18n {
  const { lang, setLang } = useContext(LocaleContext)
  return {
    lang,
    setLang,
    t: (key, params) => translate(lang, key, params),
    dateLocale: DATE_LOCALES[lang],
  }
}
