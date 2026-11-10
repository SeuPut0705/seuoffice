import type { zh } from './zh'

export const ru = {
  pageSelDelete: 'Удалить страницы ({n})',
  pageSelExtract: 'Извлечь страницы ({n})',
  pageCut: 'Вырезать',
  pageCopy: 'Копировать',
  pagePaste: 'Вставить',
  pagesCopied: 'Скопировано страниц: {n}',
  pagesCut: 'Вырезано страниц: {n}',
  pagesPasted: 'Вставлено страниц: {n}',
  pageClipEmpty:
    'Нет скопированных страниц. Выберите страницы в миниатюрах, скопируйте их, затем вставьте.',
  pageClipProtected: 'В PDF, защищённом паролем, нельзя копировать и вставлять страницы.',
} satisfies Record<keyof typeof zh, string>
