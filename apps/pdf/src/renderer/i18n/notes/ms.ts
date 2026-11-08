import type { zh } from './zh'

export const ms = {
  ntOpen: 'Buka nota',
  ntOpenTip: 'Buka nota Markdown yang dipautkan dengan PDF ini',
  ntInsert: 'Tambah ke nota',
  ntInsertTip: 'Menambah ini di hujung nota. Simpan dalam tab nota',
  ntSaveFirst: 'Simpan PDF dahulu',
  ntUnavailable: 'Nota hanya boleh dibuka dalam aplikasi GenOffice',
  ntFailed: 'Nota tidak dapat dibuka. {reason}',
  ntInserted: 'Ditambah ke nota',
} satisfies Record<keyof typeof zh, string>
