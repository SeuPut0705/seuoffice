import { defineStrings } from '@seuoffice/i18n'
import { en } from './ai/en'
import { ko } from './ai/ko'

/** The AI panel: its texts, the activity lines of the tools and the turn undo (prompts to the model are not here) */
export const aiStrings = defineStrings({
  en,
  ko,
})
