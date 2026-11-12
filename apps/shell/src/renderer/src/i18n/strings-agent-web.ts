import { createI18n, defineStrings, type Lang, type Params } from '@genoffice/i18n'
import { en } from './agent-web/en'
import { ko } from './agent-web/ko'

/**
 * The agent window's web choices and web permission prompts (spec 7), kept apart
 * from the window's other strings. Sharded per language; `en` defines the key set.
 */
export const agentWebStrings = defineStrings({
  en,
  ko,
})

export type AgentWebStringKey = keyof typeof en

const translate = createI18n(agentWebStrings)

export function agentWebText(lang: Lang, key: AgentWebStringKey, params?: Params): string {
  return translate(lang, key, params)
}
