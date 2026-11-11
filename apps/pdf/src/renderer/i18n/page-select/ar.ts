import type { zh } from './zh'

export const ar = {
  pageSelDelete: 'حذف {n} صفحات',
  pageSelExtract: 'استخراج {n} صفحات',
  pageCut: 'قص',
  pageCopy: 'نسخ',
  pagePaste: 'لصق',
  pagesCopied: 'الصفحات المنسوخة: {n}',
  pagesCut: 'الصفحات المقصوصة: {n}',
  pagesPasted: 'الصفحات الملصوقة: {n}',
  pageClipEmpty: 'لا توجد صفحات منسوخة. حدّد صفحات في المصغرات وانسخها ثم الصقها.',
  pageClipProtected: 'لا يمكن نسخ الصفحات أو لصقها في ملف PDF محمي بكلمة مرور.',
} satisfies Record<keyof typeof zh, string>
