import type { zh } from './zh'

export const cs = {
  diskChanged: 'Tento soubor byl změněn. Načíst ho znovu?',
  diskChangedUnsaved: 'Tento soubor byl změněn. Opětovným načtením přijdete o neuložené úpravy.',
  diskMissing:
    'Tento soubor byl odstraněn nebo přejmenován. Obsah na obrazovce zůstává beze změny.',
  diskReload: 'Načíst znovu',
  diskIgnore: 'Ignorovat',
  diskDismiss: 'OK',
  diskReloadFailed: 'Soubor se nepodařilo znovu načíst: {detail}',
  diskChangedNoUndo:
    'Jiný program tento soubor změnil nebo odstranil, proto se u této změny neprovedlo Zpět ani Znovu.',
} satisfies Record<keyof typeof zh, string>
