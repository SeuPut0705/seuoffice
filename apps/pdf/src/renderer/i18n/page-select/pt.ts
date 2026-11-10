import type { zh } from './zh'

export const pt = {
  pageSelDelete: 'Excluir {n} páginas',
  pageSelExtract: 'Extrair {n} páginas',
  pageCut: 'Cortar',
  pageCopy: 'Copiar',
  pagePaste: 'Colar',
  pagesCopied: 'Páginas copiadas: {n}',
  pagesCut: 'Páginas cortadas: {n}',
  pagesPasted: 'Páginas coladas: {n}',
  pageClipEmpty:
    'Nenhuma página copiada. Selecione páginas nas miniaturas, copie-as e depois cole.',
  pageClipProtected: 'Não é possível copiar nem colar páginas em um PDF protegido por senha.',
} satisfies Record<keyof typeof zh, string>
