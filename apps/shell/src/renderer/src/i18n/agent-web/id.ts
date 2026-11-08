import type { zh } from './zh'

export const id = {
  actWebSearch: 'Pencarian web',
  actWebFetch: 'Baca halaman web',
  permWebSearch: 'Cari di web',
  permWebFetch: 'Baca halaman web ini',
  permAllowSearchSession: 'Izinkan pencarian selama sesi ini',
  permAllowSiteSession: 'Izinkan situs ini selama sesi ini',
  codexWebLabel: 'Pencarian web',
  codexWebCached: 'Hasil tersimpan',
  codexWebLive: 'Langsung',
  codexWebDisabled: 'Nonaktif',
  codexWebNote:
    'Hasil tersimpan berasal dari konten web yang dikumpulkan sebelumnya; Langsung mencari web sebagaimana adanya sekarang.',
  codexNetworkLabel: 'Akses internet untuk perintah',
  codexNetworkOff: 'Nonaktif',
  codexNetworkOn: 'Aktif',
  codexNetworkWarning:
    'Jika diaktifkan, perintah yang dijalankan Codex dapat menjangkau internet. Dengan “Percayai proyek ini”, perintah menjangkaunya tanpa bertanya. Instruksi tersembunyi dalam dokumen yang Anda terima dapat membuatnya mengirim data Anda keluar.',
  codexFolderNote: 'Kedua pengaturan ini diingat untuk setiap folder proyek.',
  providerCodexNoteWeb:
    'Perintah berjalan di ruang terisolasi Codex: hanya folder proyek yang dapat ditulisi, dan tidak ada internet kecuali Anda mengaktifkannya.',
} satisfies Record<keyof typeof zh, string>
