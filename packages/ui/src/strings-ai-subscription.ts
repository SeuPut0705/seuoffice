import { createI18n, defineStrings, type Lang, type Params } from '@genoffice/i18n'
import { zh } from './strings-ai-subscription/zh'
import { en } from './strings-ai-subscription/en'
import { ja } from './strings-ai-subscription/ja'
import { ko } from './strings-ai-subscription/ko'
import { fr } from './strings-ai-subscription/fr'
import { de } from './strings-ai-subscription/de'
import { es } from './strings-ai-subscription/es'
import { th } from './strings-ai-subscription/th'
import { id } from './strings-ai-subscription/id'
import { ru } from './strings-ai-subscription/ru'
import { ar } from './strings-ai-subscription/ar'
import { pt } from './strings-ai-subscription/pt'
import { it } from './strings-ai-subscription/it'
import { pl } from './strings-ai-subscription/pl'
import { cs } from './strings-ai-subscription/cs'
import { nl } from './strings-ai-subscription/nl'
import { ms } from './strings-ai-subscription/ms'
import { he } from './strings-ai-subscription/he'
import { hi } from './strings-ai-subscription/hi'
import { zhTW } from './strings-ai-subscription/zh-TW'
import { vi } from './strings-ai-subscription/vi'

/**
 * Every string of the subscription-connection parts (connect card, not-connected
 * prompt, blocked-run notice, usage line, notices, model-picker additions), so
 * the six editors and the shell show identical wording. One shard per language
 * under ./strings-ai-subscription; `zh` defines the key set.
 */
export const AI_SUBSCRIPTION_STRINGS = defineStrings({
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

export type AiSubscriptionStringKey = keyof typeof zh

/** `aiSubscriptionText(lang, key, params)`: the string in that language with its `{name}` placeholders filled */
export const aiSubscriptionText: (
  lang: Lang,
  key: AiSubscriptionStringKey,
  params?: Params,
) => string = createI18n(AI_SUBSCRIPTION_STRINGS)
