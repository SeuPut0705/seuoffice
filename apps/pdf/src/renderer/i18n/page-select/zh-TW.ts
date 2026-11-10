import type { zh } from './zh'

export const zhTW = {
  pageSelDelete: '刪除 {n} 個頁面',
  pageSelExtract: '擷取 {n} 個頁面',
  pageCut: '剪下',
  pageCopy: '複製',
  pagePaste: '貼上',
  pagesCopied: '已複製 {n} 個頁面',
  pagesCut: '已剪下 {n} 個頁面',
  pagesPasted: '已貼上 {n} 個頁面',
  pageClipEmpty: '沒有已複製的頁面。請先在縮圖中選取頁面並複製，然後再貼上。',
  pageClipProtected: '受密碼保護的 PDF 無法複製或貼上頁面。',
} satisfies Record<keyof typeof zh, string>
