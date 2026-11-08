import type { zh } from './zh'

export const fr = {
  ntOpen: 'Ouvrir la note',
  ntOpenTip: 'Ouvrir la note Markdown liée à ce PDF',
  ntInsert: 'Ajouter à la note',
  ntInsertTip: 'Ajoute ce contenu à la fin de la note. Enregistrez-la dans son onglet',
  ntSaveFirst: 'Enregistrez d’abord le PDF',
  ntUnavailable: 'Les notes ne s’ouvrent que dans l’application GenOffice',
  ntFailed: 'Impossible d’ouvrir la note. {reason}',
  ntInserted: 'Ajouté à la note',
} satisfies Record<keyof typeof zh, string>
