import type { zh } from './zh'

export const es = {
  ntOpen: 'Abrir nota',
  ntOpenTip: 'Abrir la nota Markdown vinculada a este PDF',
  ntInsert: 'Añadir a la nota',
  ntInsertTip: 'Añade esto al final de la nota. Guárdala en su pestaña',
  ntSaveFirst: 'Guarda primero el PDF',
  ntUnavailable: 'Las notas solo se abren dentro de la aplicación GenOffice',
  ntFailed: 'No se pudo abrir la nota. {reason}',
  ntInserted: 'Añadido a la nota',
} satisfies Record<keyof typeof zh, string>
