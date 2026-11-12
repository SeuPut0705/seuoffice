import type { Lang } from '@genoffice/i18n'

/** Labels for the queued-messages strip above the AI composer (all editors share them). */
export interface AiQueueStripLabels {
  /** collapsed strip title, e.g. "3 queued" */
  queuedCount: (n: number) => string
  clearTitle: string
  editTitle: string
  removeTitle: string
  /** hold the queue: the run in flight finishes, nothing after it starts */
  pauseTitle: string
  /** let the queue run again */
  resumeTitle: string
  /** strip hint while the gate is closed */
  pausedHint: string
  /** row tooltip: press and drag to change the order (Alt+arrows for keyboards) */
  moveTitle: string
  /** composer placeholder while a reply runs and Enter queues instead of sending */
  queuePlaceholder: string
}

export const AI_QUEUE_LABELS: Record<Lang, AiQueueStripLabels> = {
  en: {
    queuedCount: (n) => `${n} queued`,
    clearTitle: 'Clear queued messages',
    editTitle: 'Edit queued message',
    removeTitle: 'Remove queued message',
    pauseTitle: 'Pause the queue',
    resumeTitle: 'Resume the queue',
    pausedHint: 'Paused',
    moveTitle: 'Drag to reorder (or Alt+↑/↓)',
    queuePlaceholder: 'Enter to queue · Esc to stop',
  },
  ko: {
    queuedCount: (n) => `${n}개 대기 중`,
    clearTitle: '대기 중인 메시지 비우기',
    editTitle: '대기 중인 메시지 편집',
    removeTitle: '대기 중인 메시지 제거',
    pauseTitle: '대기 일시 정지',
    resumeTitle: '대기 재개',
    pausedHint: '일시 정지됨',
    moveTitle: '끌어서 순서 변경 (또는 Alt+↑/↓)',
    queuePlaceholder: 'Enter 대기 · Esc 중지',
  },
}
