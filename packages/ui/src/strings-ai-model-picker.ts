import type { AiEffort } from '@genoffice/ai-provider/browser'
import type { Lang } from '@genoffice/i18n'

export interface AiModelPickerStrings {
  /** chip tooltip / list heading */
  title: string
  /** chip text while no provider is usable yet */
  choose: string
  /** last row: jump to Settings › AI Model */
  manage: string
}

export interface AiEffortStrings {
  /** heading of the row that picks how hard the model thinks */
  title: string
  /** tooltip of that heading */
  hint: string
  /** the entry that leaves the level to the program */
  auto: string
  /** the same, when the program tells which level that is; `{level}` is its name */
  autoNamed: string
  levels: Record<AiEffort, string>
}

export const AI_MODEL_PICKER_STRINGS: Record<Lang, AiModelPickerStrings> = {
  en: { title: 'Model', choose: 'Choose model', manage: 'Manage models…' },
  ko: { title: '모델', choose: '모델 선택', manage: '모델 관리…' },
}

export const AI_EFFORT_STRINGS: Record<Lang, AiEffortStrings> = {
  en: {
    title: 'Effort',
    hint: 'How hard the model thinks before it answers. Higher is slower and uses more of your subscription or API credit.',
    auto: 'Default',
    autoNamed: 'Default ({level})',
    levels: {
      none: 'None',
      minimal: 'Minimal',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'Extra high',
      max: 'Max',
    },
  },
  ko: {
    title: '생각 깊이',
    hint: '답하기 전에 모델이 얼마나 깊이 생각할지 정합니다. 깊을수록 느리고, 구독 사용량이나 API 요금을 더 씁니다.',
    auto: '기본',
    autoNamed: '기본({level})',
    levels: {
      none: '생각 안 함',
      minimal: '최소',
      low: '낮음',
      medium: '보통',
      high: '높음',
      xhigh: '매우 높음',
      max: '최대',
    },
  },
}
