import type { zh } from './zh'

export const ms = {
  pageSelDelete: 'Padam {n} halaman',
  pageSelExtract: 'Ekstrak {n} halaman',
  pageCut: 'Potong',
  pageCopy: 'Salin',
  pagePaste: 'Tampal',
  pagesCopied: 'Halaman disalin: {n}',
  pagesCut: 'Halaman dipotong: {n}',
  pagesPasted: 'Halaman ditampal: {n}',
  pageClipEmpty:
    'Tiada halaman yang disalin. Pilih halaman dalam imej kecil, salin, kemudian tampal.',
  pageClipProtected:
    'Halaman tidak boleh disalin atau ditampal dalam PDF yang dilindungi kata laluan.',
} satisfies Record<keyof typeof zh, string>
