import type { zh } from './zh'

export const de = {
  pageSelDelete: '{n} Seiten löschen',
  pageSelExtract: '{n} Seiten extrahieren',
  pageCut: 'Ausschneiden',
  pageCopy: 'Kopieren',
  pagePaste: 'Einfügen',
  pagesCopied: 'Kopierte Seiten: {n}',
  pagesCut: 'Ausgeschnittene Seiten: {n}',
  pagesPasted: 'Eingefügte Seiten: {n}',
  pageClipEmpty:
    'Keine kopierten Seiten. Wählen Sie Seiten in den Miniaturen aus, kopieren Sie sie und fügen Sie sie dann ein.',
  pageClipProtected:
    'In einer kennwortgeschützten PDF können keine Seiten kopiert oder eingefügt werden.',
} satisfies Record<keyof typeof zh, string>
