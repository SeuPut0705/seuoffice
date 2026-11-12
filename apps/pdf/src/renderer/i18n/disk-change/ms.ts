import type { zh } from './zh'

export const ms = {
  diskChanged: 'Fail ini telah diubah. Muat semula?',
  diskChangedUnsaved:
    'Fail ini telah diubah. Memuat semula akan membuang suntingan yang belum disimpan.',
  diskMissing:
    'Fail ini telah dipadam atau dinamakan semula. Kandungan pada skrin kekal seperti sedia ada.',
  diskReload: 'Muat semula',
  diskIgnore: 'Abaikan',
  diskDismiss: 'OK',
  diskReloadFailed: 'Tidak dapat memuat semula fail: {detail}',
  diskChangedNoUndo:
    'Program lain telah mengubah atau memadam fail ini, jadi Buat asal dan Buat semula tidak dijalankan untuk perubahan ini.',
} satisfies Record<keyof typeof zh, string>
