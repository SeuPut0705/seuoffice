import { createI18n, defineStrings, type Lang, type Params } from '@seuoffice/i18n'
import { en } from './drive/en'
import { ko } from './drive/ko'

/**
 * Google Drive on the home screen and in Settings (decision 0033). Sharded per language; `en` defines the key set.
 */
export const driveUiStrings = defineStrings({
  en,
  ko,
})

export type DriveStringKey = keyof typeof en

const translate = createI18n(driveUiStrings)

export function driveUiText(lang: Lang, key: DriveStringKey, params?: Params): string {
  return translate(lang, key, params)
}
