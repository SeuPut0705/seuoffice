import { createI18n, defineStrings, type Lang, type Params } from '@seuoffice/i18n'
import { en } from './agent-mcp/en'
import { ko } from './agent-mcp/ko'

/**
 * The agent window's strings for the relays of the person's MCP servers (user
 * MCP spec 9), kept apart from the window's other strings. Sharded per
 * language; `en` defines the key set.
 */
export const agentMcpStrings = defineStrings({
  en,
  ko,
})

export type AgentMcpStringKey = keyof typeof en

const translate = createI18n(agentMcpStrings)

export function agentMcpText(lang: Lang, key: AgentMcpStringKey, params?: Params): string {
  return translate(lang, key, params)
}
