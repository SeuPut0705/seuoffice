import { aiStrings } from './strings-ai'
import { appStrings } from './strings-app'

/**
 * Every dictionary of the editor, merged per language. A new domain (the AI
 * panel's `i18n/ai/`) gets its own aggregator and is spread in here beside
 * `appStrings`; the per-language shards are never merged into one object.
 */
export const strings = {
  en: { ...appStrings.en, ...aiStrings.en },
  ko: { ...appStrings.ko, ...aiStrings.ko },
}
