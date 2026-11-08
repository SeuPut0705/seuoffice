import { createI18n, defineStrings, type Lang, type Params } from '@genoffice/i18n'
import { zh } from './agent/zh'
import { en } from './agent/en'
import { ja } from './agent/ja'
import { ko } from './agent/ko'
import { fr } from './agent/fr'
import { de } from './agent/de'
import { es } from './agent/es'
import { th } from './agent/th'
import { id } from './agent/id'
import { ru } from './agent/ru'
import { ar } from './agent/ar'
import { pt } from './agent/pt'
import { it } from './agent/it'
import { pl } from './agent/pl'
import { cs } from './agent/cs'
import { nl } from './agent/nl'
import { ms } from './agent/ms'
import { he } from './agent/he'
import { hi } from './agent/hi'
import { zhTW } from './agent/zh-TW'
import { vi } from './agent/vi'

/**
 * The agent window (decision 0032). Sharded per language; `zh` defines the key set.
 */
export const agentStrings = defineStrings({
  zh,
  en,
  ja,
  ko,
  fr,
  de,
  es,
  th,
  id,
  ru,
  ar,
  pt,
  it,
  pl,
  cs,
  nl,
  ms,
  he,
  hi,
  'zh-TW': zhTW,
  vi,
})

export type AgentStringKey = keyof typeof zh

const translate = createI18n(agentStrings)

export function agentText(lang: Lang, key: AgentStringKey, params?: Params): string {
  return translate(lang, key, params)
}
