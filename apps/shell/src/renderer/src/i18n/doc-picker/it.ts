import type { zh } from './zh'

export const it = {
  docPickTitle: 'Allega da documenti GenOffice',
  docPickPane: 'Altro riquadro',
  docPickOpen: 'Documenti aperti',
  docPickRecent: 'Documenti recenti',
  docPickEmpty: 'Non ci sono documenti da allegare.',
  docPickMissing: 'File non trovato.',
  docPickUnsaved: 'Salvalo prima.',
  docPickModified: 'Salvalo per allegarlo.',
  docPickUnavailable: 'Impossibile leggere l’elenco dei documenti.',
  docPickLimit: 'Puoi scegliere fino a 20 documenti.',
  docPickSelected: '{n} selezionati',
  docPickAttach: 'Allega',
  docPickCancel: 'Annulla',
  docPickWorking: 'Allegando…',
} satisfies Record<keyof typeof zh, string>
