import type { zh } from './zh'

export const pl = {
  pageSelDelete: 'Usuń strony ({n})',
  pageSelExtract: 'Wyodrębnij strony ({n})',
  pageCut: 'Wytnij',
  pageCopy: 'Kopiuj',
  pagePaste: 'Wklej',
  pagesCopied: 'Skopiowane strony: {n}',
  pagesCut: 'Wycięte strony: {n}',
  pagesPasted: 'Wklejone strony: {n}',
  pageClipEmpty:
    'Brak skopiowanych stron. Zaznacz strony w miniaturach, skopiuj je, a potem wklej.',
  pageClipProtected: 'W pliku PDF chronionym hasłem nie można kopiować ani wklejać stron.',
} satisfies Record<keyof typeof zh, string>
