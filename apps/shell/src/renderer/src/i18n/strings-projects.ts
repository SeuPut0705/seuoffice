import { createI18n, defineStrings, type Lang, type Params } from '@seuoffice/i18n'
import { en } from './projects/en'
import { ko } from './projects/ko'

/**
 * The home project screen (decision 0088). Words the AI panel already has
 * (pin, new project, tidy up, undo, …) come from `@seuoffice/ui`'s project
 * panel strings. Sharded per language; `en` defines the key set.
 */
export const projectsUiStrings = defineStrings({
  en,
  ko,
})

export type ProjectsStringKey = keyof typeof en

const translate = createI18n(projectsUiStrings)

export function projectsText(lang: Lang, key: ProjectsStringKey, params?: Params): string {
  return translate(lang, key, params)
}
