import type { zh } from './zh'

export const he = {
  pageSelDelete: 'מחיקת {n} עמודים',
  pageSelExtract: 'חילוץ {n} עמודים',
  pageCut: 'גזירה',
  pageCopy: 'העתקה',
  pagePaste: 'הדבקה',
  pagesCopied: 'עמודים שהועתקו: {n}',
  pagesCut: 'עמודים שנגזרו: {n}',
  pagesPasted: 'עמודים שהודבקו: {n}',
  pageClipEmpty: 'אין עמודים שהועתקו. בחרו עמודים בתמונות הממוזערות, העתיקו אותם ואז הדביקו.',
  pageClipProtected: 'לא ניתן להעתיק או להדביק עמודים בקובץ PDF המוגן בסיסמה.',
} satisfies Record<keyof typeof zh, string>
