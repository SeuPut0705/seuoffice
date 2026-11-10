import type { zh } from './zh'

export const es = {
  pageSelDelete: 'Eliminar {n} páginas',
  pageSelExtract: 'Extraer {n} páginas',
  pageCut: 'Cortar',
  pageCopy: 'Copiar',
  pagePaste: 'Pegar',
  pagesCopied: 'Páginas copiadas: {n}',
  pagesCut: 'Páginas cortadas: {n}',
  pagesPasted: 'Páginas pegadas: {n}',
  pageClipEmpty:
    'No hay páginas copiadas. Seleccione páginas en las miniaturas, cópielas y luego pegue.',
  pageClipProtected: 'No se pueden copiar ni pegar páginas en un PDF protegido con contraseña.',
} satisfies Record<keyof typeof zh, string>
