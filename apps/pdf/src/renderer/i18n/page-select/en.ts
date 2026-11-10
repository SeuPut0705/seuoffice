import type { zh } from './zh'

export const en = {
  pageSelDelete: 'Delete {n} pages',
  pageSelExtract: 'Extract {n} pages',
  pageCut: 'Cut',
  pageCopy: 'Copy',
  pagePaste: 'Paste',
  pagesCopied: 'Pages copied: {n}',
  pagesCut: 'Pages cut: {n}',
  pagesPasted: 'Pages pasted: {n}',
  pageClipEmpty: 'No copied pages. Select pages in the thumbnails and copy them, then paste.',
  pageClipProtected: 'Pages cannot be copied from or pasted into a password-protected PDF.',
} satisfies Record<keyof typeof zh, string>
