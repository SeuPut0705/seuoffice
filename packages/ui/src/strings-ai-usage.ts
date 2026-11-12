import type { Lang } from '@seuoffice/i18n'

/** Tooltips for the token-usage chips under assistant replies and on the composer
 * (all editors and the kb-ask panel share them; the chips themselves are numeric). */
export interface AiUsageLabels {
  /** per-reply chip tooltip */
  runTitle: string
  /** session-total chip tooltip */
  sessionTitle: string
}

export const AI_USAGE_LABELS: Record<Lang, AiUsageLabels> = {
  en: {
    runTitle: 'Token usage for this reply',
    sessionTitle: 'Session token usage',
  },
  ko: {
    runTitle: '이 답변의 토큰 사용량',
    sessionTitle: '세션 누적 사용량',
  },
}
