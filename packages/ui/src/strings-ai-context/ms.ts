import type { zh } from './zh'

export const ms = {
  contextConfirm:
    'Permintaan ini hampir mencapai had konteks model: kira-kira {estimated} daripada {limit} token ({percent}%). Tetap hantar?',
  contextUnknown: 'Saiz konteks model tidak dapat dipastikan; {limit} token diandaikan.',
  toolsUnsupported:
    'Model ini tidak menyokong panggilan alat. Ia hanya akan mencadangkan teks dan tidak akan menyunting dokumen.',
  errContextLimit:
    'Tiada apa-apa dihantar: permintaan hampir mencapai had konteks model. Bahagikan kepada permintaan yang lebih kecil dan cuba lagi.',
} satisfies Record<keyof typeof zh, string>
