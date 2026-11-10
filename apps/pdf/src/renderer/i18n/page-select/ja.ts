import type { zh } from './zh'

export const ja = {
  pageSelDelete: '{n} ページを削除',
  pageSelExtract: '{n} ページを抽出',
  pageCut: '切り取り',
  pageCopy: 'コピー',
  pagePaste: '貼り付け',
  pagesCopied: '{n} ページをコピーしました',
  pagesCut: '{n} ページを切り取りました',
  pagesPasted: '{n} ページを貼り付けました',
  pageClipEmpty:
    'コピーしたページがありません。サムネイルでページを選んでコピーしてから貼り付けてください。',
  pageClipProtected: 'パスワードで保護された PDF では、ページのコピーや貼り付けはできません。',
} satisfies Record<keyof typeof zh, string>
