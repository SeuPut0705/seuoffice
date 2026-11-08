import type { zh } from './zh'

export const ru = {
  ntOpen: 'Открыть заметку',
  ntOpenTip: 'Открыть заметку Markdown, связанную с этим PDF',
  ntInsert: 'Добавить в заметку',
  ntInsertTip: 'Добавляет это в конец заметки. Сохраните её во вкладке заметки',
  ntSaveFirst: 'Сначала сохраните PDF',
  ntUnavailable: 'Заметки открываются только в приложении GenOffice',
  ntFailed: 'Не удалось открыть заметку. {reason}',
  ntInserted: 'Добавлено в заметку',
} satisfies Record<keyof typeof zh, string>
