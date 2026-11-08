import type { zh } from './zh'

export const id = {
  ntOpen: 'Buka catatan',
  ntOpenTip: 'Buka catatan Markdown yang terhubung dengan PDF ini',
  ntInsert: 'Tambahkan ke catatan',
  ntInsertTip: 'Menambahkan ini ke akhir catatan. Simpan di tab catatan',
  ntSaveFirst: 'Simpan PDF terlebih dahulu',
  ntUnavailable: 'Catatan hanya bisa dibuka di dalam aplikasi GenOffice',
  ntFailed: 'Catatan tidak dapat dibuka. {reason}',
  ntInserted: 'Ditambahkan ke catatan',
} satisfies Record<keyof typeof zh, string>
