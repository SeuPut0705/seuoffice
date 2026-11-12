import { createI18n, defineStrings, type Lang, type Params } from '@seuoffice/i18n'
import { en } from './strings-project-panel/en'
import { ko } from './strings-project-panel/ko'

/**
 * Project-folder wording of the AI panel (decision 0088): the project chip
 * and its list under the input, the [chat ▾] menu in the panel header, and
 * the notice and event lines. `en` defines the key set.
 */
export const PROJECT_PANEL_STRINGS = defineStrings({
  en,
  ko,
})

export type ProjectPanelStringKey = keyof typeof en

/** `projectPanelText(lang, key, params)`: the string in that language with its `{name}` placeholders filled */
export const projectPanelText: (lang: Lang, key: ProjectPanelStringKey, params?: Params) => string =
  createI18n(PROJECT_PANEL_STRINGS)
