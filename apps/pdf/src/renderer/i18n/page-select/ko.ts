import type { zh } from './zh'

export const ko = {
  pageSelDelete: '페이지 {n}개 삭제',
  pageSelExtract: '페이지 {n}개 추출',
  pageCut: '잘라내기',
  pageCopy: '복사',
  pagePaste: '붙여넣기',
  pagesCopied: '페이지 {n}개를 복사했습니다',
  pagesCut: '페이지 {n}개를 잘라냈습니다',
  pagesPasted: '페이지 {n}개를 붙여 넣었습니다',
  pageClipEmpty: '복사한 페이지가 없습니다. 미리보기에서 페이지를 고르고 복사한 뒤 붙여 넣으세요.',
  pageClipProtected: '암호가 걸린 PDF에서는 페이지를 복사하거나 붙여 넣을 수 없습니다.',
} satisfies Record<keyof typeof zh, string>
