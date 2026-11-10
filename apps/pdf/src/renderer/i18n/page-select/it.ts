import type { zh } from './zh'

export const it = {
  pageSelDelete: 'Elimina {n} pagine',
  pageSelExtract: 'Estrai {n} pagine',
  pageCut: 'Taglia',
  pageCopy: 'Copia',
  pagePaste: 'Incolla',
  pagesCopied: 'Pagine copiate: {n}',
  pagesCut: 'Pagine tagliate: {n}',
  pagesPasted: 'Pagine incollate: {n}',
  pageClipEmpty:
    'Nessuna pagina copiata. Seleziona le pagine nelle miniature, copiale e poi incolla.',
  pageClipProtected: 'Non è possibile copiare o incollare pagine in un PDF protetto da password.',
} satisfies Record<keyof typeof zh, string>
