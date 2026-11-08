import type { zh } from './zh'

export const id = {
  windowTitle: 'Pratinjau Cepat',
  openInEditor: 'Buka di GenOffice',
  revealInFolder: 'Tampilkan di Folder',
  close: 'Tutup',
  prevFile: 'File sebelumnya (↑)',
  nextFile: 'File berikutnya (↓)',
  shortcutHint: 'Spasi / Esc tutup · ↑↓ pindah · Enter buka',
  loading: 'Memuat pratinjau…',
  empty: 'Dokumen ini tidak memiliki teks yang dapat dipratinjau.',
  encrypted: 'Dokumen dilindungi kata sandi. Buka di GenOffice untuk membuka kunci.',
  unsupported: 'Format file ini tidak dapat dipratinjau secara langsung.',
  failed: 'Tidak dapat membaca pratinjau file.',
  truncated: 'Menampilkan bagian awal dokumen. Buka di GenOffice untuk melihat semuanya.',
  slideLabel: 'Slide {n}',
  sheetCount: '{n} lembar',
  slideCount: '{n} slide',
  lineCount: '{n} baris',
  charCount: '{n} karakter',
  tabThumbnail: 'Gambar Pratinjau',
  tabContent: 'Isi Dokumen',
  setQuickLookTitle: 'Pratinjau Cepat (Spasi)',
  setQuickLookHint:
    'Tekan Spasi pada file di daftar GenOffice untuk melihat isinya tanpa membuka tab.',
  setExplorerSpace: 'Pratinjau file dengan Spasi di File Explorer & Desktop Windows',
  setExplorerSpaceDesc:
    'Tekan Spasi pada file yang dipilih di File Explorer atau Desktop untuk menampilkan jendela Pratinjau Cepat.',
  setKeepInTray: 'Tetap berjalan di baki sistem saat jendela ditutup',
  setKeepInTrayDesc:
    'Menjaga GenOffice tetap siap di latar belakang agar pratinjau Spasi di File Explorer tetap berfungsi.',
  trayOpen: 'Buka GenOffice',
  trayQuit: 'Keluar dari GenOffice',
} satisfies Record<keyof typeof zh, string>
