import type { Lang } from '@seuoffice/i18n'

/** Appended to the AI system prompt: reply in the user's message language, falling back to the UI language (same wording as docs/slides/pdf) */
const AI_LANG_DIRECTIVES: Record<Lang, string> = {
  en: "\n\nReply in the same language as the user's message; if it cannot be determined, reply in English.",
  ko: '\n\n사용자 메시지와 같은 언어로 답변하세요. 언어를 판단할 수 없으면 한국어로 답변하세요.',
}

/** The reply-language line appended to the system prompt, in the user's language. */
export function aiLangDirective(lang: Lang): string {
  return AI_LANG_DIRECTIVES[lang]
}
