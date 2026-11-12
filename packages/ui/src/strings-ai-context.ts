import { createI18n, defineStrings, htmlLang, type Lang, type Params } from '@genoffice/i18n'
import { en } from './strings-ai-context/en'
import { ko } from './strings-ai-context/ko'

/**
 * The context-budget wording every editor shares: the confirmation before a
 * prompt close to the model's window, the tools-unsupported notice, and the
 * run error of a request the person declined. `en` defines the key set.
 */
export const AI_CONTEXT_STRINGS = defineStrings({
  en,
  ko,
})

export type AiContextStringKey = keyof typeof en

/**
 * The warning a transport asks about before sending a large prompt.
 * agent-core's `ContextWarning` satisfies it; declared here so this package
 * keeps its own copy of the shape, like `AiRunErrorCause` does.
 */
export interface AiContextWarning {
  readonly estimatedTokens: number
  readonly contextTokens: number
  readonly ratio: number
  readonly known: boolean
}

/** `aiContextText(lang, key, params)`: the string in that language with its `{name}` placeholders filled */
export const aiContextText: (lang: Lang, key: AiContextStringKey, params?: Params) => string =
  createI18n(AI_CONTEXT_STRINGS)

/** 4096 ??"4,096" in the reader's language (never a bare rounded "4k" for an exact figure) */
function contextCount(lang: Lang, value: number): string {
  return new Intl.NumberFormat(htmlLang(lang)).format(Math.max(0, Math.round(value)))
}

/**
 * The confirmation dialog's sentence for one warning. A window nobody reported
 * adds the sentence that the figure is an assumption; without it the reader
 * would take 4096 for a fact the model reported.
 */
export function aiContextConfirmText(lang: Lang, warning: AiContextWarning): string {
  const limit = contextCount(lang, warning.contextTokens)
  const confirm = aiContextText(lang, 'contextConfirm', {
    estimated: contextCount(lang, warning.estimatedTokens),
    limit,
    percent: String(Math.round(warning.ratio * 100)),
  })
  if (warning.known) return confirm
  return `${confirm} ${aiContextText(lang, 'contextUnknown', { limit })}`
}
