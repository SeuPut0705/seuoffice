import type { zh } from './zh'

export const pt = {
  ntOpen: 'Abrir nota',
  ntOpenTip: 'Abrir a nota Markdown ligada a este PDF',
  ntInsert: 'Adicionar à nota',
  ntInsertTip: 'Adiciona isto ao final da nota. Salve-a na aba da nota',
  ntSaveFirst: 'Salve o PDF primeiro',
  ntUnavailable: 'As notas só abrem dentro do aplicativo GenOffice',
  ntFailed: 'Não foi possível abrir a nota. {reason}',
  ntInserted: 'Adicionado à nota',
} satisfies Record<keyof typeof zh, string>
