import { defineStrings } from '@genoffice/i18n'
import { en } from './ai/en'
import { ko } from './ai/ko'

/** User-visible copy for the ai/ panel and tool feedback (LLM prompts excluded) */
export const aiStrings = defineStrings({
  en,
  ko,
})
