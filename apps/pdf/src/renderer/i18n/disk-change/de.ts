import type { zh } from './zh'

export const de = {
  diskChanged: 'Diese Datei wurde geändert. Neu laden?',
  diskChangedUnsaved:
    'Diese Datei wurde geändert. Beim Neuladen gehen Ihre nicht gespeicherten Änderungen verloren.',
  diskMissing: 'Diese Datei wurde gelöscht oder umbenannt. Der angezeigte Inhalt bleibt erhalten.',
  diskReload: 'Neu laden',
  diskIgnore: 'Ignorieren',
  diskDismiss: 'OK',
  diskReloadFailed: 'Die Datei konnte nicht neu geladen werden: {detail}',
  diskChangedNoUndo:
    'Ein anderes Programm hat diese Datei geändert oder entfernt. „Rückgängig“ und „Wiederholen“ wurden für diese Änderung daher nicht ausgeführt.',
} satisfies Record<keyof typeof zh, string>
