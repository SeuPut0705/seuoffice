import type { zh } from './zh'

export const id = {
  pageSelDelete: 'Hapus {n} halaman',
  pageSelExtract: 'Ekstrak {n} halaman',
  pageCut: 'Potong',
  pageCopy: 'Salin',
  pagePaste: 'Tempel',
  pagesCopied: 'Halaman disalin: {n}',
  pagesCut: 'Halaman dipotong: {n}',
  pagesPasted: 'Halaman ditempel: {n}',
  pageClipEmpty:
    'Belum ada halaman yang disalin. Pilih halaman di gambar mini, salin, lalu tempel.',
  pageClipProtected:
    'Halaman tidak dapat disalin atau ditempel pada PDF yang dilindungi kata sandi.',
} satisfies Record<keyof typeof zh, string>
