import { defineStrings } from '@seuoffice/i18n'
import { en } from './ai/en'
import { ko } from './ai/ko'

/** User-visible strings for the ai/ panel and tool feedback (LLM prompts are not here) */
export const aiStrings = defineStrings({
  en,
  ko,
})
