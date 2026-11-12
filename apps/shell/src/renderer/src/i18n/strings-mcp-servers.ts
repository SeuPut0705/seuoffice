import { createI18n, defineStrings, type Lang, type Params } from '@seuoffice/i18n'
import { en } from './mcp-servers/en'
import { ko } from './mcp-servers/ko'

/**
 * Settings → Integrations: the MCP server card (user MCP spec 4). Sharded per
 * language; `en` defines the key set.
 */
export const mcpServersUiStrings = defineStrings({
  en,
  ko,
})

export type McpServersStringKey = keyof typeof en

const translate = createI18n(mcpServersUiStrings)

export function mcpServersText(lang: Lang, key: McpServersStringKey, params?: Params): string {
  return translate(lang, key, params)
}
