import type { zh } from './zh'

export const de = {
  actWebSearch: 'Websuche',
  actWebFetch: 'Webseite lesen',
  permWebSearch: 'Im Web suchen',
  permWebFetch: 'Diese Webseite lesen',
  permAllowSearchSession: 'Suchen für diese Sitzung erlauben',
  permAllowSiteSession: 'Diese Website für diese Sitzung erlauben',
  codexWebLabel: 'Websuche',
  codexWebCached: 'Gespeicherte Ergebnisse',
  codexWebLive: 'Live',
  codexWebDisabled: 'Aus',
  codexWebNote:
    'Gespeicherte Ergebnisse stammen aus vorab gesammelten Webinhalten; „Live“ durchsucht das Web, wie es jetzt ist.',
  codexNetworkLabel: 'Internetzugang für Befehle',
  codexNetworkOff: 'Aus',
  codexNetworkOn: 'Ein',
  codexNetworkWarning:
    'Wenn eingeschaltet, können Befehle, die Codex ausführt, das Internet erreichen. Mit „Diesem Projekt vertrauen“ geschieht das ohne Rückfrage. Versteckte Anweisungen in einem erhaltenen Dokument könnten sie dazu bringen, Ihre Daten nach außen zu senden.',
  codexFolderNote: 'Diese beiden Einstellungen werden für jeden Projektordner gespeichert.',
  providerCodexNoteWeb:
    'Befehle laufen im abgeschotteten Bereich von Codex: Nur in den Projektordner kann geschrieben werden, und Internet gibt es nur, wenn Sie es einschalten.',
} satisfies Record<keyof typeof zh, string>
