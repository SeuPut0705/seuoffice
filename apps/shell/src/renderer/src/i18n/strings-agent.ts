import { createI18n, defineStrings, type Lang, type Params } from '@genoffice/i18n'
import { en } from './agent/en'
import { ko } from './agent/ko'

/**
 * The agent window (decision 0032). Sharded per language; `en` defines the key set.
 */
export const agentStrings = defineStrings({
  en,
  ko,
})

export type AgentStringKey = keyof typeof en

const translate = createI18n(agentStrings)

export function agentText(lang: Lang, key: AgentStringKey, params?: Params): string {
  return translate(lang, key, params)
}
