import { createI18n, defineStrings, type Lang, type Params } from '@genoffice/i18n'

/**
 * What "Name with AI" says while it runs and when it gives no name, so the
 * five editors that have the command word it the same way. A provider that is
 * not connected is worded by the subscription strings (`aiRunErrorText`).
 */
export const AI_NAMING_STRINGS = defineStrings({
  en: {
    running: 'Asking AI for a file name…',
    noticeFirst:
      'Before AI names a file on your subscription, open the AI panel and confirm the notice there. Then try again.',
    timeout: 'AI did not answer in time, so no name was suggested. Try again in a moment.',
    failed: 'AI could not suggest a file name. Try again in a moment.',
    noText: 'There is no text in this file for AI to name it from.',
    unavailable: 'Naming with AI is not available here.',
  },
  ko: {
    running: 'AI에게 파일 이름을 물어보는 중…',
    noticeFirst:
      '구독으로 AI에게 이름을 맡기려면 먼저 AI 창을 열어 안내를 확인하세요. 그런 다음 다시 시도하세요.',
    timeout: 'AI가 제때 응답하지 않아 이름을 받지 못했습니다. 잠시 뒤 다시 시도하세요.',
    failed: 'AI가 파일 이름을 내놓지 못했습니다. 잠시 뒤 다시 시도하세요.',
    noText: '이 파일에는 AI가 이름을 지을 글이 없습니다.',
    unavailable: '여기서는 AI로 이름을 지을 수 없습니다.',
  },
})

export type AiNamingStringKey = keyof typeof AI_NAMING_STRINGS.en

/** `aiNamingText(lang, key)`: the string in that language */
export const aiNamingText: (lang: Lang, key: AiNamingStringKey, params?: Params) => string =
  createI18n(AI_NAMING_STRINGS)
