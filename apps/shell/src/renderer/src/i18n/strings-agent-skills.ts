import { createI18n, defineStrings, type Lang, type Params } from '@genoffice/i18n'
import { zh } from './agent-skills/zh'
import { en } from './agent-skills/en'
import { ja } from './agent-skills/ja'
import { ko } from './agent-skills/ko'
import { fr } from './agent-skills/fr'
import { de } from './agent-skills/de'
import { es } from './agent-skills/es'
import { th } from './agent-skills/th'
import { id } from './agent-skills/id'
import { ru } from './agent-skills/ru'
import { ar } from './agent-skills/ar'
import { pt } from './agent-skills/pt'
import { it } from './agent-skills/it'
import { pl } from './agent-skills/pl'
import { cs } from './agent-skills/cs'
import { nl } from './agent-skills/nl'
import { ms } from './agent-skills/ms'
import { he } from './agent-skills/he'
import { hi } from './agent-skills/hi'
import { zhTW } from './agent-skills/zh-TW'
import { vi } from './agent-skills/vi'

/**
 * The agent window's skill screens: the one-time notice, the "next session"
 * line, the template choice of a skill card and the install proposal (spec
 * 6.2 to 6.5, 9.4), kept apart from the window's other strings. Sharded per
 * language; `zh` defines the key set.
 */
export const agentSkillsStrings = defineStrings({
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

export type AgentSkillsStringKey = keyof typeof zh

const translate = createI18n(agentSkillsStrings)

export function agentSkillsText(lang: Lang, key: AgentSkillsStringKey, params?: Params): string {
  return translate(lang, key, params)
}
