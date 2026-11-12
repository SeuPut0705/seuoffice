import type { zh } from './zh'

export const id = {
  diskChanged: 'File ini telah diubah. Muat ulang?',
  diskChangedUnsaved:
    'File ini telah diubah. Memuat ulang akan membuang editan yang belum disimpan.',
  diskMissing:
    'File ini telah dihapus atau diganti namanya. Isi di layar tetap seperti apa adanya.',
  diskReload: 'Muat ulang',
  diskIgnore: 'Abaikan',
  diskDismiss: 'OK',
  diskReloadFailed: 'Tidak dapat memuat ulang file: {detail}',
  diskChangedNoUndo:
    'Program lain mengubah atau menghapus file ini, sehingga Urungkan dan Ulangi untuk perubahan ini tidak dijalankan.',
  pageOpNoUndoConfirm:
    'File ini ({size}) lebih besar dari ukuran yang disimpan untuk Urungkan ({limit}), sehingga operasi halaman ini tidak dapat diurungkan. Lanjutkan?',
} satisfies Record<keyof typeof zh, string>
