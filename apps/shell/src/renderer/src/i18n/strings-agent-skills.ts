import { createI18n, defineStrings, type Lang, type Params } from '@genoffice/i18n'
import { en } from './agent-skills/en'
import { ko } from './agent-skills/ko'

/**
 * The agent window's skill screens: the one-time notice, the "next session"
 * line, the template choice of a skill card and the install proposal (spec
 * 6.2 to 6.5, 9.4), kept apart from the window's other strings. Sharded per
 * language; `en` defines the key set.
 */
export const agentSkillsStrings = defineStrings({
  en,
  ko,
})

export type AgentSkillsStringKey = keyof typeof en

const translate = createI18n(agentSkillsStrings)

export function agentSkillsText(lang: Lang, key: AgentSkillsStringKey, params?: Params): string {
  return translate(lang, key, params)
}
