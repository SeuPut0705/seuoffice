import type { zh } from './zh'

export const nl = {
  ntOpen: 'Notitie openen',
  ntOpenTip: 'De Markdown-notitie openen die bij deze pdf hoort',
  ntInsert: 'Toevoegen aan notitie',
  ntInsertTip: 'Voegt dit toe aan het einde van de notitie. Sla op in het notitietabblad',
  ntSaveFirst: 'Sla eerst de pdf op',
  ntUnavailable: 'Notities openen alleen in de GenOffice-app',
  ntFailed: 'De notitie kon niet worden geopend. {reason}',
  ntInserted: 'Toegevoegd aan de notitie',
} satisfies Record<keyof typeof zh, string>
