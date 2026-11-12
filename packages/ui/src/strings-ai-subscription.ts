import { createI18n, defineStrings, type Lang, type Params } from '@seuoffice/i18n'
import { en } from './strings-ai-subscription/en'
import { ko } from './strings-ai-subscription/ko'

/**
 * Every string of the subscription-connection parts (connect card, not-connected
 * prompt, blocked-run notice, usage line, notices, model-picker additions), so
 * the six editors and the shell show identical wording. One shard per language
 * under ./strings-ai-subscription; `en` defines the key set.
 */
export const AI_SUBSCRIPTION_STRINGS = defineStrings({
  en,
  ko,
})

export type AiSubscriptionStringKey = keyof typeof en

/** `aiSubscriptionText(lang, key, params)`: the string in that language with its `{name}` placeholders filled */
export const aiSubscriptionText: (
  lang: Lang,
  key: AiSubscriptionStringKey,
  params?: Params,
) => string = createI18n(AI_SUBSCRIPTION_STRINGS)
