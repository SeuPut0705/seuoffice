import type { zh } from './zh'

export const ms = {
  actWebSearch: 'Carian web',
  actWebFetch: 'Baca halaman web',
  permWebSearch: 'Cari di web',
  permWebFetch: 'Baca halaman web ini',
  permAllowSearchSession: 'Benarkan carian sepanjang sesi ini',
  permAllowSiteSession: 'Benarkan laman ini sepanjang sesi ini',
  codexWebLabel: 'Carian web',
  codexWebCached: 'Hasil tersimpan',
  codexWebLive: 'Langsung',
  codexWebDisabled: 'Mati',
  codexWebNote:
    'Hasil tersimpan datang daripada kandungan web yang dikumpul lebih awal; Langsung mencari web seperti keadaannya sekarang.',
  codexNetworkLabel: 'Akses internet untuk arahan',
  codexNetworkOff: 'Mati',
  codexNetworkOn: 'Hidup',
  codexNetworkWarning:
    'Apabila dihidupkan, arahan yang dijalankan oleh Codex boleh mencapai internet. Dengan “Percayai projek ini”, arahan mencapainya tanpa bertanya. Arahan tersembunyi dalam dokumen yang anda terima boleh menyebabkan data anda dihantar keluar.',
  codexFolderNote: 'Kedua-dua tetapan ini diingat bagi setiap folder projek.',
  providerCodexNoteWeb:
    'Arahan berjalan dalam ruang terasing Codex: hanya folder projek yang boleh ditulis, dan tiada internet melainkan anda menghidupkannya.',
} satisfies Record<keyof typeof zh, string>
