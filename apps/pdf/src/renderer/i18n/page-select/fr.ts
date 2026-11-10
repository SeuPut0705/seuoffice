import type { zh } from './zh'

export const fr = {
  pageSelDelete: 'Supprimer {n} pages',
  pageSelExtract: 'Extraire {n} pages',
  pageCut: 'Couper',
  pageCopy: 'Copier',
  pagePaste: 'Coller',
  pagesCopied: 'Pages copiées : {n}',
  pagesCut: 'Pages coupées : {n}',
  pagesPasted: 'Pages collées : {n}',
  pageClipEmpty:
    'Aucune page copiée. Sélectionnez des pages dans les vignettes, copiez-les, puis collez.',
  pageClipProtected:
    'Impossible de copier ou de coller des pages dans un PDF protégé par mot de passe.',
} satisfies Record<keyof typeof zh, string>
