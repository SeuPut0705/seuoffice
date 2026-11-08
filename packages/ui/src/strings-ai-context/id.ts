import type { zh } from './zh'

export const id = {
  contextConfirm:
    'Permintaan ini mendekati batas konteks model: sekitar {estimated} dari {limit} token ({percent}%). Tetap kirim?',
  contextUnknown: 'Ukuran konteks model tidak dapat dipastikan; diasumsikan {limit} token.',
  toolsUnsupported:
    'Model ini tidak mendukung pemanggilan alat. Model hanya akan menyarankan teks dan tidak akan menyunting dokumen.',
  errContextLimit:
    'Tidak ada yang dikirim: permintaan mendekati batas konteks model. Bagi menjadi permintaan yang lebih kecil lalu coba lagi.',
} satisfies Record<keyof typeof zh, string>
