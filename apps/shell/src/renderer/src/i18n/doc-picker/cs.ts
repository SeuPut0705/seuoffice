import type { zh } from './zh'

export const cs = {
  docPickTitle: 'Připojit z dokumentů GenOffice',
  docPickPane: 'Druhý panel',
  docPickOpen: 'Otevřené dokumenty',
  docPickRecent: 'Nedávné dokumenty',
  docPickEmpty: 'Nejsou žádné dokumenty k připojení.',
  docPickMissing: 'Soubor nebyl nalezen.',
  docPickUnsaved: 'Nejprve jej uložte.',
  docPickModified: 'Po uložení jej lze připojit.',
  docPickUnavailable: 'Seznam dokumentů se nepodařilo načíst.',
  docPickLimit: 'Vybrat lze nejvýše 20 dokumentů.',
  docPickSelected: 'Vybráno: {n}',
  docPickAttach: 'Připojit',
  docPickCancel: 'Zrušit',
  docPickWorking: 'Připojování…',
} satisfies Record<keyof typeof zh, string>
