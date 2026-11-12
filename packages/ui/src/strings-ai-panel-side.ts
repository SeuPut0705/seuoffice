import type { Lang } from '@genoffice/i18n'
import type { AiPanelSide } from './ai-panel-prefs'

// Shared by every editor's AI header; each label names the destination side.
export const AI_PANEL_SIDE_LABELS: Record<Lang, Record<AiPanelSide, string>> = {
  en: { left: 'Move AI panel to the left', right: 'Move AI panel to the right' },
  ko: { left: 'AI 창을 왼쪽으로 이동', right: 'AI 창을 오른쪽으로 이동' },
}
