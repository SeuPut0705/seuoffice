import type { Lang } from '@genoffice/i18n'
import type { AiTargetKind } from './generate-api'

/**
 * The request a generate run starts with when the user leaves the box empty.
 *
 * Localized, not English: the receiving editor puts this text in its composer
 * as the user's own message (it is what the user sees in the conversation, and
 * what stays in the box when the run is blocked), so it is written in the UI
 * language like anything else the user would have typed. The window shows the
 * same text as the box's placeholder, so what is sent is what was shown.
 * None of them names the product, so no brand substitution applies.
 */
export const DEFAULT_GENERATE_PROMPTS: Record<Lang, Record<AiTargetKind, string>> = {
  en: {
    slides:
      'Make a presentation from the attached material. Organize the main points into slides with clear titles.',
    html: 'Make a web page (HTML) from the attached material. Lay out the main points so they are easy to read.',
    mindmap:
      'Make a mind map from the attached material. Put the main topic in the center and organize the key points as branches.',
  },
  ko: {
    slides:
      '첨부한 자료로 발표 자료를 만들어 주세요. 핵심 내용을 정리해 제목이 분명한 슬라이드로 구성해 주세요.',
    html: '첨부한 자료로 웹 페이지(HTML)를 만들어 주세요. 핵심 내용을 읽기 쉽게 배치해 주세요.',
    mindmap:
      '첨부한 자료로 마인드맵을 만들어 주세요. 중심 주제를 가운데에 두고 핵심 내용을 가지로 정리해 주세요.',
  },
}

export function defaultGeneratePrompt(lang: Lang, kind: AiTargetKind): string {
  return (DEFAULT_GENERATE_PROMPTS[lang] ?? DEFAULT_GENERATE_PROMPTS.en)[kind]
}
