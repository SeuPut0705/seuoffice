import { createI18n, defineStrings, type Lang, type Params } from '@genoffice/i18n'
import { zh } from './agent-web/zh'
import { en } from './agent-web/en'
import { ja } from './agent-web/ja'
import { ko } from './agent-web/ko'
import { fr } from './agent-web/fr'
import { de } from './agent-web/de'
import { es } from './agent-web/es'
import { th } from './agent-web/th'
import { id } from './agent-web/id'
import { ru } from './agent-web/ru'
import { ar } from './agent-web/ar'
import { pt } from './agent-web/pt'
import { it } from './agent-web/it'
import { pl } from './agent-web/pl'
import { cs } from './agent-web/cs'
import { nl } from './agent-web/nl'
import { ms } from './agent-web/ms'
import { he } from './agent-web/he'
import { hi } from './agent-web/hi'
import { zhTW } from './agent-web/zh-TW'
import { vi } from './agent-web/vi'

/**
 * The agent window's web choices and web permission prompts (spec 7), kept apart
 * from the window's other strings. Sharded per language; `zh` defines the key set.
 */
export const agentWebStrings = defineStrings({
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

export type AgentWebStringKey = keyof typeof zh

const translate = createI18n(agentWebStrings)

export function agentWebText(lang: Lang, key: AgentWebStringKey, params?: Params): string {
  return translate(lang, key, params)
}
