import type { zh } from './zh'

export const ms = {
  windowTitle: 'Pratonton Pantas',
  openInEditor: 'Buka dalam GenOffice',
  revealInFolder: 'Tunjukkan dalam Folder',
  close: 'Tutup',
  prevFile: 'Fail sebelumnya (↑)',
  nextFile: 'Fail seterusnya (↓)',
  shortcutHint: 'Space / Esc tutup · ↑↓ tukar · Enter buka',
  loading: 'Memuatkan pratonton…',
  empty: 'Dokumen ini tiada teks yang boleh dipratonton.',
  encrypted: 'Dokumen dilindungi kata laluan. Buka dalam GenOffice untuk membuka kunci.',
  unsupported: 'Format fail ini tidak boleh dipratonton secara terus.',
  failed: 'Tidak dapat membaca pratonton fail.',
  truncated: 'Menunjukkan bahagian awal dokumen. Buka dalam GenOffice untuk melihat semuanya.',
  slideLabel: 'Slaid {n}',
  sheetCount: '{n} helaian',
  slideCount: '{n} slaid',
  lineCount: '{n} baris',
  charCount: '{n} aksara',
  tabThumbnail: 'Imej Pratonton',
  tabContent: 'Kandungan Dokumen',
  setQuickLookTitle: 'Pratonton Pantas (Bar Ruang)',
  setQuickLookHint:
    'Tekan Space pada mana-mana fail dalam senarai GenOffice untuk pratonton kandungan tanpa membuka tab.',
  setExplorerSpace: 'Pratonton fail dengan Bar Ruang dalam Penjelajah Fail & Desktop Windows',
  setExplorerSpaceDesc:
    'Tekan Space pada fail terpilih dalam Penjelajah Fail atau Desktop untuk memaparkan Pratonton Pantas.',
  setKeepInTray: 'Kekalkan berjalan dalam dulang sistem apabila tetingkap ditutup',
  setKeepInTrayDesc:
    'Memastikan GenOffice sedia di latar belakang supaya pratonton Space berfungsi dalam Penjelajah Fail.',
  trayOpen: 'Buka GenOffice',
  trayQuit: 'Keluar GenOffice',
} satisfies Record<keyof typeof zh, string>
