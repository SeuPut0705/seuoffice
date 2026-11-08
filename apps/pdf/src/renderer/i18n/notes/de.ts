import type { zh } from './zh'

export const de = {
  ntOpen: 'Notiz öffnen',
  ntOpenTip: 'Die mit diesem PDF verknüpfte Markdown-Notiz öffnen',
  ntInsert: 'Zur Notiz hinzufügen',
  ntInsertTip: 'Fügt dies am Ende der Notiz ein. Gespeichert wird im Notiz-Tab',
  ntSaveFirst: 'Speichern Sie zuerst das PDF',
  ntUnavailable: 'Notizen lassen sich nur in der GenOffice-App öffnen',
  ntFailed: 'Die Notiz konnte nicht geöffnet werden. {reason}',
  ntInserted: 'Zur Notiz hinzugefügt',
} satisfies Record<keyof typeof zh, string>
