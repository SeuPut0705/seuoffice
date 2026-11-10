import type { zh } from './zh'

export const nl = {
  pageSelDelete: '{n} pagina’s verwijderen',
  pageSelExtract: '{n} pagina’s extraheren',
  pageCut: 'Knippen',
  pageCopy: 'Kopiëren',
  pagePaste: 'Plakken',
  pagesCopied: 'Gekopieerde pagina’s: {n}',
  pagesCut: 'Geknipte pagina’s: {n}',
  pagesPasted: 'Geplakte pagina’s: {n}',
  pageClipEmpty:
    'Geen gekopieerde pagina’s. Selecteer pagina’s in de miniaturen, kopieer ze en plak daarna.',
  pageClipProtected:
    'In een pdf met wachtwoordbeveiliging kunnen geen pagina’s worden gekopieerd of geplakt.',
} satisfies Record<keyof typeof zh, string>
