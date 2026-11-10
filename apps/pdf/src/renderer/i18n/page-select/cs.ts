import type { zh } from './zh'

export const cs = {
  pageSelDelete: 'Odstranit stránky ({n})',
  pageSelExtract: 'Extrahovat stránky ({n})',
  pageCut: 'Vyjmout',
  pageCopy: 'Kopírovat',
  pagePaste: 'Vložit',
  pagesCopied: 'Zkopírované stránky: {n}',
  pagesCut: 'Vyjmuté stránky: {n}',
  pagesPasted: 'Vložené stránky: {n}',
  pageClipEmpty:
    'Žádné zkopírované stránky. Vyberte stránky v miniaturách, zkopírujte je a pak vložte.',
  pageClipProtected: 'V PDF chráněném heslem nelze stránky kopírovat ani vkládat.',
} satisfies Record<keyof typeof zh, string>
