import type { zh } from './zh'

export const nl = {
  diskChanged: 'Dit bestand is gewijzigd. Opnieuw laden?',
  diskChangedUnsaved:
    'Dit bestand is gewijzigd. Opnieuw laden verwijdert uw niet-opgeslagen bewerkingen.',
  diskMissing:
    'Dit bestand is verwijderd of hernoemd. Wat op het scherm staat, blijft zoals het is.',
  diskReload: 'Opnieuw laden',
  diskIgnore: 'Negeren',
  diskDismiss: 'OK',
  diskReloadFailed: 'Het bestand kon niet opnieuw worden geladen: {detail}',
  diskChangedNoUndo:
    'Een ander programma heeft dit bestand gewijzigd of verwijderd. Ongedaan maken en Opnieuw zijn daarom niet uitgevoerd voor deze wijziging.',
  pageOpNoUndoConfirm:
    'Dit bestand ({size}) is groter dan wat voor Ongedaan maken wordt bewaard ({limit}). Deze paginabewerking kan daarom niet ongedaan worden gemaakt. Doorgaan?',
  undoNoRedoConfirm:
    'Het bestand zoals het nu is ({size}) is groter dan wat voor Opnieuw wordt bewaard ({limit}). Deze Ongedaan maken kan daarom niet opnieuw worden uitgevoerd. Doorgaan?',
} satisfies Record<keyof typeof zh, string>
