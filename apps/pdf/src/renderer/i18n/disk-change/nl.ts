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
} satisfies Record<keyof typeof zh, string>
