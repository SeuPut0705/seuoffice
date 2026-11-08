import type { zh } from './zh'

export const de = {
  windowTitle: 'Schnellvorschau',
  openInEditor: 'In GenOffice öffnen',
  revealInFolder: 'Im Ordner anzeigen',
  close: 'Schließen',
  prevFile: 'Vorherige Datei (↑)',
  nextFile: 'Nächste Datei (↓)',
  shortcutHint: 'Leertaste / Esc schließen · ↑↓ wechseln · Eingabe öffnen',
  loading: 'Vorschau wird geladen…',
  empty: 'Dieses Dokument enthält keinen vorschaubaren Text.',
  encrypted: 'Passwortgeschütztes Dokument. In GenOffice öffnen, um es zu entsperren.',
  unsupported: 'Dieses Dateiformat kann nicht direkt als Vorschau angezeigt werden.',
  failed: 'Dateivorschau konnte nicht gelesen werden.',
  truncated: 'Zeigt den Anfang des Dokuments. In GenOffice öffnen, um alles zu sehen.',
  slideLabel: 'Folie {n}',
  sheetCount: '{n} Tabellenblätter',
  slideCount: '{n} Folien',
  lineCount: '{n} Zeilen',
  charCount: '{n} Zeichen',
  tabThumbnail: 'Vorschaubild',
  tabContent: 'Dokumenttext',
  setQuickLookTitle: 'Schnellvorschau (Leertaste)',
  setQuickLookHint:
    'Drücken Sie in den GenOffice-Dateilisten die Leertaste, um den Inhalt ohne neuen Tab vorab anzusehen.',
  setExplorerSpace: 'Dateien im Windows-Explorer und auf dem Desktop mit der Leertaste anzeigen',
  setExplorerSpaceDesc:
    'Drücken Sie bei einer ausgewählten Datei im Explorer oder auf dem Desktop die Leertaste für die Schnellvorschau.',
  setKeepInTray: 'Beim Schließen des Fensters im Infobereich (System Tray) weiterlaufen lassen',
  setKeepInTrayDesc:
    'Hält GenOffice im Hintergrund bereit, damit die Leertasten-Vorschau im Explorer jederzeit sofort funktioniert.',
  trayOpen: 'GenOffice öffnen',
  trayQuit: 'GenOffice beenden',
} satisfies Record<keyof typeof zh, string>
