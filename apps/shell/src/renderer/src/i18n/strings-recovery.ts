import { createI18n, defineStrings, type Lang, type Params } from '@genoffice/i18n'
import { en } from './recovery/en'
import { ko } from './recovery/ko'

/**
 * The Home screen's launch recovery list (documents with unsaved content
 * left). Sharded per language; `en` defines the key set.
 */
export const recoveryListStrings = defineStrings({
  en,
  ko,
})

export type RecoveryListStringKey = keyof typeof en

const translate = createI18n(recoveryListStrings)

export function recoveryListText(lang: Lang, key: RecoveryListStringKey, params?: Params): string {
  return translate(lang, key, params)
}
